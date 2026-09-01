/**
 * scenario-runner/scripts/game-economy-pets — the Companion Pets domain proof.
 *
 * Binds the pets domain's 12 declarative catalog scenarios to concrete, real-stack
 * proof scripts driven against LOCAL Supabase. Every DB-observable / RLS / owner-alert
 * assertion runs NOW against the SAME production primitives the bot's PetsManager uses;
 * the live Discord surfaces are GATED — the exact honesty boundary the harness requires.
 *
 * ── Reply/embed surfaces are now DRIVEN LIVE (PR #331) ──
 * EVERY member entrypoint is a slash SUBCOMMAND of `/pet` (view/buy/feed/play/train/
 * rename/battle/prestige) and `handlePetCommand`'s first line is
 * `interaction.options.getSubcommand()`. Since PR #331 `ScenarioContext.runSlash` (see
 * `RunSlashParams`) carries a `subcommand` field and the injector builds a
 * subcommand-bearing interaction, so `getSubcommand()` resolves and the REAL handler runs
 * in-process. The branded adoption embed (`/pet buy`) and the battles/prestige
 * disabled-piece refusals are now asserted against the captured reply, and a guild-scoped
 * `/pet view` proves the member surface stays per-guild. What REMAINS gated is genuinely
 * outside the in-process dispatcher: the decay cycle is a process timer whose needs-attention
 * DM needs a live Discord client, the /pet play cooldown is a Valkey `SET PX NX` (no Redis
 * in CI), the white-label brand-kit pixel/voice match needs a live-guild readback, and the
 * outage / mid-buy / mid-battle-payout fault branches need a fault-injection lane — never faked.
 *
 * ── What IS proven NOW, non-vacuously ──
 * PetsManager is a thin orchestration over primitives that ARE drivable directly against
 * local Supabase at the EXACT RPCs/tables the bot calls:
 *   - adoption debits the play-coin price via `economy_subtract_balance` (atomic, rejects
 *     insufficient balance) and inserts one `economy_pets` row;
 *   - one pet per member per guild is enforced by `UNIQUE (guild_id, user_id)` (a second
 *     insert is rejected with SQLSTATE 23505 — the exact error the buy refund branch catches);
 *   - care mutates through `economy_pet_feed` / `economy_pet_play` / `economy_pet_train`
 *     (row-locked, TOCTOU-safe) and each resolves the pet by the invoking member's own id;
 *   - prestige is `economy_pet_atomic_prestige` (applies ONLY while level ≥ max — a real
 *     concurrent-prestige race resolves to exactly one apply);
 *   - dashboard config (feed/train cost, decay rate, threshold, enabled toggles) lands in
 *     `guild_config`, the exact row `getConfig()` reads live;
 *   - the purchase-insert-failure refund uses `economy_add_balance` — proven by the
 *     debit→refund pair restoring the wallet exactly with no orphan pet;
 *   - pet stats/level/prestige live in Supabase and survive a reboot;
 *   - `economy_pets` is guild-scoped under RLS (service role sees the row an anon /
 *     second-guild client must not).
 *
 * Two-economies wall: pets move ONLY play-money coins (`economy_subtract_balance` /
 * `economy_add_balance` on `economy_wallets`) — no real-commerce table is ever touched.
 *
 * Behavior-bug discovery: where the REAL bot diverges from the catalog's contracted
 * intent, the script records a FAIL (promise / observation / impact). It never forces
 * green and never weakens the catalog.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row / result shapes ─────────────────────────────────────────────────────

interface PetConfigRow {
  economy_pets_enabled: boolean;
  economy_pet_decay_rate: number;
  economy_pet_decay_interval_hours: number;
  economy_pet_low_stat_threshold: number;
  economy_pet_notify_owner: boolean;
  economy_pet_feed_cost: number;
  economy_pet_train_cost: number;
  economy_pet_battle_enabled: boolean;
  economy_pet_prestige_enabled: boolean;
}

interface PetRow {
  id: string;
  guild_id: string;
  user_id: string;
  name: string;
  pet_type: string;
  level: number;
  xp: number;
  hunger: number;
  happiness: number;
  energy: number;
  attack: number;
  defense: number;
  speed: number;
  health: number;
  prestige: number;
  status: string;
}

interface WalletRow {
  wallet: number;
  user_id: string;
  guild_id: string;
}

type FeedResult = { success: boolean; old_hunger?: number; new_hunger?: number; status?: string } | null;
type PlayResult = { success: boolean; old_happiness?: number; new_happiness?: number; new_energy?: number } | null;
type TrainResult = { success: boolean; new_xp?: number; new_level?: number; new_energy?: number } | null;
interface PrestigeRow {
  success: boolean;
  new_prestige: number;
}

/** A minimal PostgREST error surface (code + message) for insert/RPC results. */
type PgErr = { code?: string; message?: string } | null;

/** Overridable columns for seeding a pet row. */
type PetSeed = Partial<
  Pick<
    PetRow,
    'pet_type' | 'name' | 'level' | 'xp' | 'hunger' | 'happiness' | 'energy' | 'attack' | 'defense' | 'speed' | 'health' | 'prestige' | 'status'
  >
>;

/**
 * The bot's hardcoded adoption price for a hunting pet (PetsManager.PET_PRICES). This
 * is a code constant, NOT a `guild_config` column, so it is exercised as the debit
 * amount the buy path passes to `economy_subtract_balance`, not asserted from the DB.
 */
const ADOPTION_PRICE = 5000;

// ── Small live-stack helpers ────────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

async function readConfig(handle: LiveClientHandle): Promise<PetConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select(
      'economy_pets_enabled, economy_pet_decay_rate, economy_pet_decay_interval_hours, economy_pet_low_stat_threshold, economy_pet_notify_owner, economy_pet_feed_cost, economy_pet_train_cost, economy_pet_battle_enabled, economy_pet_prestige_enabled',
    )
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as PetConfigRow | null) ?? null;
}

async function readWallet(handle: LiveClientHandle, userId: string): Promise<WalletRow | null> {
  const { data } = await handle.supabase
    .from('economy_wallets')
    .select('wallet, user_id, guild_id')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as WalletRow | null) ?? null;
}

/** Arrange an exact wallet via the REAL wallet initializer, then a precise set. */
async function seedWallet(handle: LiveClientHandle, userId: string, wallet: number): Promise<void> {
  await handle.supabase.rpc('economy_get_or_create_wallet', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
  });
  await handle.supabase
    .from('economy_wallets')
    .update({ wallet })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
}

/** Insert an `economy_pets` row exactly as buyPet does; surface the id + any 23505. */
async function insertPet(
  handle: LiveClientHandle,
  userId: string,
  seed: PetSeed = {},
): Promise<{ id: string | null; error: PgErr }> {
  const { data, error } = await handle.supabase
    .from('economy_pets')
    .insert({ guild_id: handle.guildId, user_id: userId, pet_type: 'hunting', name: 'e2e-pet', ...seed })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: (error as PgErr) ?? null };
}

async function readPet(handle: LiveClientHandle, userId: string): Promise<PetRow | null> {
  const { data } = await handle.supabase
    .from('economy_pets')
    .select(
      'id, guild_id, user_id, name, pet_type, level, xp, hunger, happiness, energy, attack, defense, speed, health, prestige, status',
    )
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as PetRow | null) ?? null;
}

async function petCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_pets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

async function walletCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_wallets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

async function battleCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_pet_battles')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/** The EXACT RPC PetsManager debits an adoption / feed / train with. */
async function debit(handle: LiveClientHandle, userId: string, amount: number): Promise<PgErr> {
  const { error } = await handle.supabase.rpc('economy_subtract_balance', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
  return (error as PgErr) ?? null;
}

/** The EXACT RPC the buy/train refund branch credits with. */
async function credit(handle: LiveClientHandle, userId: string, amount: number): Promise<PgErr> {
  const { error } = await handle.supabase.rpc('economy_add_balance', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
  return (error as PgErr) ?? null;
}

/** The EXACT atomic care RPCs feedPet / playWithPet / trainPet call. */
async function feedRpc(handle: LiveClientHandle, userId: string, amount = 30): Promise<FeedResult> {
  const { data } = await handle.supabase.rpc('economy_pet_feed', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
  return (data as FeedResult) ?? null;
}

async function playRpc(
  handle: LiveClientHandle,
  userId: string,
  happinessGain = 25,
  energyCost = 10,
): Promise<PlayResult> {
  const { data } = await handle.supabase.rpc('economy_pet_play', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_happiness_gain: happinessGain,
    p_energy_cost: energyCost,
  });
  return (data as PlayResult) ?? null;
}

async function trainRpc(
  handle: LiveClientHandle,
  userId: string,
  xpGain: number,
  energyCost = 20,
): Promise<TrainResult> {
  const { data } = await handle.supabase.rpc('economy_pet_train', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_xp_gain: xpGain,
    p_energy_cost: energyCost,
  });
  return (data as TrainResult) ?? null;
}

/** The EXACT atomic prestige RPC prestigePet calls (applies only while level ≥ max). */
async function prestigeRpc(handle: LiveClientHandle, userId: string, maxLevel = 50): Promise<PrestigeRow[]> {
  const { data } = await handle.supabase.rpc('economy_pet_atomic_prestige', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_max_level: maxLevel,
  });
  return Array.isArray(data) ? (data as PrestigeRow[]) : [];
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query itself
 * errors, so a failed read can never masquerade as "no alert raised".
 */
async function alertCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of rows an
 * anon key can read (RLS/GRANT deny → 0), or null when inconclusive (→ GATE). PostgREST
 * surfaces a genuine authorization denial as SQLSTATE 42501 / "permission denied"
 * (HTTP 401/403) which we treat as the deny we want; a rejected key or other error is
 * inconclusive.
 */
async function anonReadCount(anonKey: string, table: string, guildId: string): Promise<number | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const url =
    `${base.replace(/\/$/, '')}/rest/v1/${table}` +
    `?select=guild_id&guild_id=eq.${encodeURIComponent(guildId)}`;
  try {
    const res = await fetch(url, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (res.ok) {
      const rows = (await res.json()) as unknown;
      return Array.isArray(rows) ? rows.length : 0;
    }
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null; // non-JSON error body — inconclusive
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return 0; // the anon role is denied the table — RLS/GRANT working
    }
    return null; // rejected/invalid key or other error → inconclusive (GATE)
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ───────────────────────────────────────────────

async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      "This scenario's happy path raises no owner alert.",
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
  } else {
    ctx.expect(alerts === 0, {
      assertionClass: 'owner-notification',
      channel: 'db-observable',
      promise: "This scenario's happy path raises no owner alert.",
      observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
      impact: 'An owner alert was raised on a happy path — a false alarm / notification noise.',
    });
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Failure-branch alerts (e.g. a repeatedly-failing battle payout) carry a human-readable reason + remediation hint in the owner alert channel.',
    'the battle-payout-failed alert is a DB-observable alerts row, but it only fires when economy_add_balance fails mid-battle — requires a mid-battle payout fault-injection lane (plus live owner alert channel readback for the reason/remediation text)',
  );
}

/**
 * Prove `economy_pets` is guild-scoped under RLS, made non-vacuous by a positive
 * control: the scenario has already created this member's pet under the guild (the
 * service role sees it), so an anon client reading ZERO of those rows is a real deny.
 * GATEs (never fakes) when there is no pet to isolate, no anon key, or the probe is
 * inconclusive.
 */
async function proveRlsIsolation(ctx: ScenarioContext, handle: LiveClientHandle, userId: string): Promise<void> {
  const svc = await readPet(handle, userId);
  if (svc === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_pets rows (guild-scoped RLS economy_pets_guild + no anon table GRANT).',
      'this scenario has no pet row to serve as the positive control for the anon-denial probe; guild-scoped RLS is proven in scenarios that seed a pet',
    );
    return;
  }
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_pets rows (guild-scoped RLS economy_pets_guild + no anon table GRANT).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'economy_pets', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_pets rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s pet row while an anon client reads zero of them (RLS economy_pets_guild + no anon table GRANT).',
    observation:
      `service-role sees the member's pet under guild "${handle.guildId}" (id=${svc.id}); ` +
      `an anon-key REST read returned ${anonRows} economy_pets row(s) for that guild.`,
    impact:
      'A pet row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).',
  });
}

/** Content + embed title/description of the last reply/editReply a /pet subcommand produced. */
function petReplyText(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  const replies = captured.allOf('reply');
  const payload = (edits[edits.length - 1] ?? replies[replies.length - 1])?.payload as
    | { content?: string; embeds?: Array<{ data?: { title?: string; description?: string } }> }
    | undefined;
  const content = payload?.content ?? '';
  const embed = payload?.embeds?.[0]?.data;
  return `${content} ${embed?.title ?? ''} ${embed?.description ?? ''}`.trim();
}

/**
 * The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution)
 * pixel/voice match against the live owner brand kit stays a live-guild readback residual.
 */
function gateBrandKit(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on pet embeds.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

/**
 * Drive the REAL `/pet buy` subcommand (through the #331 in-process injector) for a fresh
 * funded member and assert BOTH the DB effect (the debit + the inserted economy_pets row
 * the real buyPet handler writes) AND the member-facing adoption embed. Live via the
 * subcommand injector — no longer gated. The exact brand-kit pixel/voice match stays a
 * live-guild readback residual (gateBrandKit).
 */
async function proveBranding(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const u = ctx.userId('brand');
  await seedWallet(handle, u, ADOPTION_PRICE);
  const captured = await ctx.runSlash(handle, {
    commandName: 'pet',
    userId: u,
    subcommand: 'buy',
    options: { type: 'hunting' },
  });

  // DB effect: the real buyPet handler debited the adoption price and inserted one pet row.
  const boughtPet = await readPet(handle, u);
  const boughtWallet = await readWallet(handle, u);
  ctx.expect(boughtPet?.id != null && boughtPet?.pet_type === 'hunting' && boughtWallet?.wallet === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `Driving the REAL /pet buy handler debits the ${ADOPTION_PRICE}-coin adoption price and inserts exactly one economy_pets row for the member.`,
    observation: `after /pet buy: pet id=${boughtPet?.id ?? '(null)'} type=${boughtPet?.pet_type}, wallet=${boughtWallet?.wallet} (expected a hunting pet + wallet 0).`,
    impact: 'The /pet buy handler did not perform the real adoption debit + pet insert in-process.',
  });

  // Member surface: the branded adoption embed rendered on the captured reply.
  const text = petReplyText(captured);
  ctx.expect(/new pet/i.test(text), {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise:
      'The member-facing /pet buy adoption reply renders as the owner-branded "New Pet!" embed (with the powered-by-SomniBot attribution and zero stock-bot wording).',
    observation: `/pet buy replied with: ${JSON.stringify(text.slice(0, 140))} (expected the branded adoption embed).`,
    impact: 'The /pet buy member surface did not render the branded adoption embed.',
  });
  gateBrandKit(ctx);
}

function gateAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'audit-row',
    'Every pets state change lands exactly one append-only audit row with actor, guild, and correlation id; anonymization, never deletion, is the only mutation.',
    'pet buy/feed/train/play/rename, battle, and prestige now use transaction-local or idempotent audited RPC paths; proving every action requires driving the real pet commands and reading their durable audit_logs rows',
  );
}

function gateLivePet(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) for the DM/channel readback and/or the pet-decay process timer — surfaces outside the in-process slash dispatcher',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggers yields no duplicate play-money debits, pet mutations, or battle payouts.',
    `replay/idempotency is exercised directly in the ${where} scenario`,
  );
}

// ── The 12 scenario scripts ─────────────────────────────────────────────────

/** DEF — out-of-the-box defaults: adopt 5000, feed 50, train 100, decay rate 5 / threshold 20. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const feedDefault = Number(declaredDefault(ctx.domain, 'pet-feed-cost')); // 50
  const trainDefault = Number(declaredDefault(ctx.domain, 'pet-train-cost')); // 100
  const decayDefault = Number(declaredDefault(ctx.domain, 'pet-decay-rate')); // 5
  const intervalDefault = Number(declaredDefault(ctx.domain, 'pet-decay-interval-hours')); // 1
  const thresholdDefault = Number(declaredDefault(ctx.domain, 'pet-low-stat-threshold')); // 20
  const battlesDefault = declaredDefault(ctx.domain, 'pet-battles-enabled') === true; // true
  const prestigeDefault = declaredDefault(ctx.domain, 'pet-prestige-enabled') === true; // true
  const notifyDefault = declaredDefault(ctx.domain, 'pet-notify-member') === true; // true

  // Enable pets but DO NOT override the numeric/toggle columns, so they take their DB
  // defaults — proving the live defaults equal the catalog-declared defaults.
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_pets_enabled: true },
  });
  const userA = ctx.userId('a');

  const cfg = await readConfig(handle);
  ctx.expect(
    cfg?.economy_pet_feed_cost === feedDefault &&
      cfg?.economy_pet_train_cost === trainDefault &&
      cfg?.economy_pet_decay_rate === decayDefault &&
      cfg?.economy_pet_decay_interval_hours === intervalDefault &&
      cfg?.economy_pet_low_stat_threshold === thresholdDefault &&
      cfg?.economy_pet_battle_enabled === battlesDefault &&
      cfg?.economy_pet_prestige_enabled === prestigeDefault &&
      cfg?.economy_pet_notify_owner === notifyDefault,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: `Out of the box the live guild_config holds the catalog defaults: feed ${feedDefault}, train ${trainDefault}, decay rate ${decayDefault}, interval ${intervalDefault}h, threshold ${thresholdDefault}, battles+prestige+notify on.`,
      observation:
        `guild_config holds feed=${cfg?.economy_pet_feed_cost}, train=${cfg?.economy_pet_train_cost}, ` +
        `decay_rate=${cfg?.economy_pet_decay_rate}, interval=${cfg?.economy_pet_decay_interval_hours}, ` +
        `threshold=${cfg?.economy_pet_low_stat_threshold}, battle=${cfg?.economy_pet_battle_enabled}, ` +
        `prestige=${cfg?.economy_pet_prestige_enabled}, notify=${cfg?.economy_pet_notify_owner}.`,
      impact: 'The live pet defaults diverged from the catalog-declared defaults.',
    },
  );

  // Adoption — the EXACT debit RPC buyPet calls (5000 → 0), then the pet insert; a
  // second (now-insufficient) debit is refused and moves nothing (atomic, guarded).
  await seedWallet(handle, userA, ADOPTION_PRICE);
  const buyErr = await debit(handle, userA, ADOPTION_PRICE);
  const afterBuy = await readWallet(handle, userA);
  const pet = await insertPet(handle, userA, { hunger: 40, energy: 100, xp: 0, level: 1 });
  const created = await petCount(handle, userA);
  const insufficientErr = await debit(handle, userA, ADOPTION_PRICE); // wallet is 0 now
  const afterInsufficient = await readWallet(handle, userA);
  ctx.expect(
    buyErr === null && afterBuy?.wallet === 0 && pet.id !== null && created === 1 && insufficientErr !== null && afterInsufficient?.wallet === 0,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `/pet buy debits exactly ${ADOPTION_PRICE} play coins via economy_subtract_balance and creates exactly one economy_pets row; a buy with insufficient balance is refused with no debit.`,
      observation:
        `after the ${ADOPTION_PRICE}-coin debit wallet=${afterBuy?.wallet} (expected 0, err=${buyErr ? buyErr.message : 'none'}); ` +
        `pet rows=${created}; an insufficient second debit err=${insufficientErr ? insufficientErr.message : 'none'}, wallet=${afterInsufficient?.wallet} (expected still 0).`,
      impact: 'The adoption debit was not atomic / did not guard insufficient balance, or did not create exactly one pet.',
    },
  );

  // Feed — the configured cost (50) debits, and economy_pet_feed raises hunger atomically.
  await seedWallet(handle, userA, 500);
  const feedDebitErr = await debit(handle, userA, feedDefault);
  const feedRes = await feedRpc(handle, userA, 30);
  const afterFeed = await readPet(handle, userA);
  const walletAfterFeed = await readWallet(handle, userA);
  ctx.expect(
    feedDebitErr === null && walletAfterFeed?.wallet === 500 - feedDefault && feedRes?.success === true && afterFeed?.hunger === 70,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `/pet feed debits the configured ${feedDefault} coins and economy_pet_feed raises hunger (40 → 70).`,
      observation:
        `after feed wallet=${walletAfterFeed?.wallet} (expected ${500 - feedDefault}); ` +
        `feed rpc success=${feedRes?.success}, hunger ${feedRes?.old_hunger}→${feedRes?.new_hunger} (pet.hunger=${afterFeed?.hunger}, expected 70).`,
      impact: 'The feed cost / hunger mutation diverged from the configured default.',
    },
  );

  // Train — the configured cost (100) debits, and economy_pet_train raises xp + spends energy.
  const trainDebitErr = await debit(handle, userA, trainDefault);
  const trainRes = await trainRpc(handle, userA, 30, 20);
  const afterTrain = await readPet(handle, userA);
  const walletAfterTrain = await readWallet(handle, userA);
  ctx.expect(
    trainDebitErr === null &&
      walletAfterTrain?.wallet === 500 - feedDefault - trainDefault &&
      trainRes?.success === true &&
      afterTrain?.xp === 30 &&
      afterTrain?.energy === 80,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `/pet train debits the configured ${trainDefault} coins and economy_pet_train raises xp (+30) and spends energy (−20).`,
      observation:
        `after train wallet=${walletAfterTrain?.wallet} (expected ${500 - feedDefault - trainDefault}); ` +
        `train rpc success=${trainRes?.success}, new_xp=${trainRes?.new_xp} (pet.xp=${afterTrain?.xp}, expected 30), pet.energy=${afterTrain?.energy} (expected 80).`,
      impact: 'The train cost / xp+energy mutation diverged from the configured default.',
    },
  );

  // Decay → sad + the branded DM nudge is a process-timer + live-Discord path.
  gateLivePet(
    ctx,
    `An accelerated decay cycle at rate ${decayDefault} pushes an unattended pet toward sad at threshold ${thresholdDefault}, and (with pet-notify-member on) exactly one branded needs-attention DM reaches the owner.`,
  );
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx, handle);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — dashboard save (feed 10 / train 25 / decay 40 / threshold 60) takes live effect. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_pets_enabled: true,
      economy_pet_feed_cost: 10,
      economy_pet_train_cost: 25,
      economy_pet_decay_rate: 40,
      economy_pet_low_stat_threshold: 60,
    },
  });
  const userA = ctx.userId('a');

  // The saved values land in guild_config — the exact row getConfig() reads live.
  const cfg = await readConfig(handle);
  ctx.expect(
    cfg?.economy_pet_feed_cost === 10 &&
      cfg?.economy_pet_train_cost === 25 &&
      cfg?.economy_pet_decay_rate === 40 &&
      cfg?.economy_pet_low_stat_threshold === 60,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'A dashboard save of feed 10 / train 25 / decay 40 / threshold 60 persists to guild_config and is what the bot reads live (no restart).',
      observation:
        `guild_config holds feed=${cfg?.economy_pet_feed_cost} (10), train=${cfg?.economy_pet_train_cost} (25), ` +
        `decay_rate=${cfg?.economy_pet_decay_rate} (40), threshold=${cfg?.economy_pet_low_stat_threshold} (60).`,
      impact: 'A saved pet configuration did not persist / would not take live effect.',
    },
  );

  // The configured feed cost (10) and train cost (25) debit exactly, via the RPC the bot uses.
  await insertPet(handle, userA, { hunger: 40, energy: 100, xp: 0, level: 1 });
  await seedWallet(handle, userA, 100);
  const feedErr = await debit(handle, userA, 10);
  await feedRpc(handle, userA, 30);
  const afterFeed = await readWallet(handle, userA);
  const trainErr = await debit(handle, userA, 25);
  await trainRpc(handle, userA, 30, 20);
  const afterTrain = await readWallet(handle, userA);
  ctx.expect(feedErr === null && afterFeed?.wallet === 90 && trainErr === null && afterTrain?.wallet === 65, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'With feed cost 10 and train cost 25 saved, /pet feed debits exactly 10 and /pet train exactly 25 — no restart.',
    observation:
      `after feed wallet=${afterFeed?.wallet} (expected 90, err=${feedErr ? feedErr.message : 'none'}); ` +
      `after train wallet=${afterTrain?.wallet} (expected 65, err=${trainErr ? trainErr.message : 'none'}).`,
    impact: 'A saved feed/train cost was not applied on the next care command.',
  });

  // The raised decay rate 40 crossing the raised threshold 60 into sad is the decay
  // timer path (process timer + status recompute) — gated.
  gateLivePet(
    ctx,
    'After the save the next decay cycle applies rate 40 so the pet crosses the raised threshold 60 into sad with its single DM nudge.',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx, handle);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — battles, prestige, and the member DM nudge OFF while core care keeps working. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_pets_enabled: true,
      economy_pet_battle_enabled: false,
      economy_pet_prestige_enabled: false,
      economy_pet_notify_owner: false,
    },
  });
  const userA = ctx.userId('a');

  // The gating flags land in guild_config — the exact fields battlePet / prestigePet /
  // the decay notifier read to refuse or suppress.
  const cfg = await readConfig(handle);
  ctx.expect(
    cfg?.economy_pet_battle_enabled === false &&
      cfg?.economy_pet_prestige_enabled === false &&
      cfg?.economy_pet_notify_owner === false &&
      cfg?.economy_pets_enabled === true,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'Battles, prestige, and the member DM nudge are switched off independently while pets stay enabled (the exact config gates the bot reads).',
      observation:
        `guild_config holds battle=${cfg?.economy_pet_battle_enabled} (false), prestige=${cfg?.economy_pet_prestige_enabled} (false), ` +
        `notify=${cfg?.economy_pet_notify_owner} (false), pets_enabled=${cfg?.economy_pets_enabled} (true).`,
      impact: 'A per-piece toggle did not persist — an owner could not switch battles/prestige/nudge off independently.',
    },
  );

  // Core care KEEPS WORKING under the switched-off pieces: feed + play still mutate the pet.
  await insertPet(handle, userA, { hunger: 40, happiness: 40, energy: 100 });
  const feedRes = await feedRpc(handle, userA, 30);
  const playRes = await playRpc(handle, userA, 25, 10);
  const afterCare = await readPet(handle, userA);
  ctx.expect(
    feedRes?.success === true && playRes?.success === true && afterCare?.hunger === 70 && afterCare?.happiness === 65 && afterCare?.energy === 90,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'With battles/prestige/nudge off, core /pet feed and /pet play still mutate the pet normally.',
      observation:
        `feed success=${feedRes?.success} (hunger→${afterCare?.hunger}, expected 70); ` +
        `play success=${playRes?.success} (happiness→${afterCare?.happiness}, expected 65; energy→${afterCare?.energy}, expected 90).`,
      impact: 'Switching off battles/prestige/nudge broke core pet care.',
    },
  );

  // Battles + prestige are switched OFF: drive the REAL /pet battle and /pet prestige
  // subcommands and assert each returns its branded piece-disabled refusal (the exact
  // guard battlePet / prestigePet read economy_pet_battle_enabled / _prestige_enabled for),
  // live via the #331 subcommand injector.
  const battleCap = await ctx.runSlash(handle, {
    commandName: 'pet',
    userId: userA,
    subcommand: 'battle',
    options: { user: { id: ctx.userId('b'), username: 'b' } },
  });
  const battleReply = petReplyText(battleCap);
  ctx.expect(/not enabled/i.test(battleReply), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'With battles switched off, /pet battle returns a branded "battles are not enabled" refusal (no battle is fought, no battle row written).',
    observation: `/pet battle replied ${JSON.stringify(battleReply)} (expected a "not enabled" refusal).`,
    impact: 'The battles-disabled toggle did not refuse /pet battle — a switched-off piece stayed reachable.',
  });

  const prestigeCap = await ctx.runSlash(handle, {
    commandName: 'pet',
    userId: userA,
    subcommand: 'prestige',
  });
  const prestigeReply = petReplyText(prestigeCap);
  ctx.expect(/not enabled/i.test(prestigeReply), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'With prestige switched off, /pet prestige returns a branded "prestige is not enabled" refusal (no prestige applied).',
    observation: `/pet prestige replied ${JSON.stringify(prestigeReply)} (expected a "not enabled" refusal).`,
    impact: 'The prestige-disabled toggle did not refuse /pet prestige — a switched-off piece stayed reachable.',
  });

  // The suppressed decay-cycle DM (no nudge when notify off) is a process-timer + live
  // Discord DM surface — gated honestly.
  gateLivePet(
    ctx,
    'No needs-attention DM arrives when a decay cycle drops the pet to sad (notify off).',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx, handle);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** INVALID — a rejected invalid config never persists; valid values retained live. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_pets_enabled: true,
      economy_pet_feed_cost: 50,
      economy_pet_decay_interval_hours: 1,
    },
  });
  const userA = ctx.userId('a');

  // guild_config keeps its prior valid values byte-for-byte (nothing invalid persisted).
  const cfg = await readConfig(handle);
  ctx.expect(cfg?.economy_pet_feed_cost === 50 && cfg?.economy_pet_decay_interval_hours === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid values byte-for-byte (a rejected negative feed cost / zero decay interval never persists).',
    observation: `guild_config holds feed=${cfg?.economy_pet_feed_cost} (expected 50), decay_interval=${cfg?.economy_pet_decay_interval_hours} (expected 1).`,
    impact: 'A valid pet configuration was not retained after a rejected save.',
  });

  // Live behavior unchanged on the very next command: the previous valid feed cost (50)
  // still debits via the RPC the bot uses.
  await insertPet(handle, userA, { hunger: 40 });
  await seedWallet(handle, userA, 50);
  const err = await debit(handle, userA, 50);
  const after = await readWallet(handle, userA);
  ctx.expect(err === null && after?.wallet === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A /pet feed right after the rejected save still debits the previous valid cost (50), proving no partial write reached the bot.',
    observation: `a 50-coin feed debit err=${err ? err.message : 'none'}, wallet=${after?.wallet} (expected 0).`,
    impact: 'A rejected config attempt disturbed the live feed cost the bot applies.',
  });

  // The actual REJECTION + its audit row are enforced in the dashboard's Zod layer;
  // guild_config carries NO CHECK constraint (a negative feed cost / zero interval would
  // persist at the DB level), so the reject path is unreachable in this bot-only harness.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard pets page surfaces a clear validation error for a negative feed cost / a zero decay interval.',
    'config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'One audit row records the rejected pets configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx, handle);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** UNAUTH — a member's care commands only ever touch their OWN pet row. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_pets_enabled: true },
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Two members, two DISTINCT pets under the same guild.
  await insertPet(handle, userA, { name: 'a-pet', hunger: 100, happiness: 100, energy: 100 });
  await insertPet(handle, userB, { name: 'b-pet', hunger: 30, happiness: 30, energy: 100 });
  const snapA = await readPet(handle, userA);

  // run-member-b runs feed + play + train: every care RPC resolves the pet by the
  // INVOKING member's own id (WHERE user_id = p_user_id), so ONLY b's pet is mutated.
  await seedWallet(handle, userB, 1000);
  await debit(handle, userB, 50);
  await feedRpc(handle, userB, 30);
  await debit(handle, userB, 100);
  await trainRpc(handle, userB, 30, 20);
  await playRpc(handle, userB, 25, 10);
  const afterB = await readPet(handle, userB);
  const afterA = await readPet(handle, userA);

  ctx.expect(
    afterA?.hunger === snapA?.hunger &&
      afterA?.happiness === snapA?.happiness &&
      afterA?.energy === snapA?.energy &&
      afterA?.xp === snapA?.xp &&
      afterA?.name === snapA?.name &&
      afterB?.hunger !== undefined &&
      afterB?.xp === 30,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'run-member-b’s feed/play/train only ever mutate run-member-b’s own pet (care RPCs key on the invoking member’s id); run-member-a’s pet row is byte-identical afterward.',
      observation:
        `A pet before/after: hunger ${snapA?.hunger}→${afterA?.hunger}, happiness ${snapA?.happiness}→${afterA?.happiness}, ` +
        `energy ${snapA?.energy}→${afterA?.energy}, xp ${snapA?.xp}→${afterA?.xp} (must be unchanged); ` +
        `B pet after care: hunger=${afterB?.hunger}, xp=${afterB?.xp} (expected mutated, xp 30).`,
      impact: 'A member’s care command mutated another member’s pet — the mutate-others-pet deny was breached.',
    },
  );

  // The non-admin dashboard save refusal + its permission-denied audit row live on the
  // dashboard session-auth lane (RLS + session role), not reachable in a bot-only harness.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save pets settings (returns an authorization error).',
    'requires the dashboard session-auth lane (RLS + session role) — not reachable in this bot-only harness',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'An audit row records the denied pets configuration attempt with actor and reason permission-denied.',
    'the denied-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx, handle);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** DEPFAIL — Supabase-unreachable fail-safe, driven through the REAL fault
 *  proxy (ctx.faults severs the actual network path run-one-domain routed the
 *  stack through). Falls back to honest gates when no proxy is registered
 *  (e.g. the CI vitest lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const supabaseFault = ctx.faults?.supabase;
  if (supabaseFault) {
    const handle = await ctx.bootGuild({
      label: 'a',
      economyStartingBalance: 0,
      guildConfigOverrides: { economy_pets_enabled: true },
    });
    const userA = ctx.userId('a');
    await seedWallet(handle, userA, 500);
    await insertPet(handle, userA, { hunger: 40, happiness: 80, energy: 90, level: 3, xp: 120 });

    // Pre-outage: one truthful /pet view baseline. This also warms the manager's
    // guild-config cache the way a long-running bot holds it, so the outage
    // window exercises the pet/wallet READ paths, not a cold config fetch.
    await ctx.runSlash(handle, { commandName: 'pet', userId: userA, subcommand: 'view' });

    // ── Outage window: a REAL severed network path (ECONNREFUSED). ──
    await supabaseFault.sever();
    let threw: string | null = null;
    let viewReply = '';
    let feedReply = '';
    try {
      viewReply = petReplyText(
        await ctx.runSlash(handle, { commandName: 'pet', userId: userA, subcommand: 'view' }),
      );
      feedReply = petReplyText(
        await ctx.runSlash(handle, { commandName: 'pet', userId: userA, subcommand: 'feed' }),
      );
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await supabaseFault.restore();

    // (1) Fail-SAFE: both pet commands must reply, never crash the pipeline.
    ctx.expect(threw === null && viewReply.length > 0 && feedReply.length > 0, {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise:
        'With database access blocked, /pet view and /pet feed still reply (fail-safe) instead of crashing the interaction pipeline.',
      observation:
        threw === null
          ? `during the outage window /pet view replied ${JSON.stringify(viewReply.slice(0, 140))}; /pet feed replied ${JSON.stringify(feedReply.slice(0, 140))}.`
          : `an outage-window drive THREW ${threw.slice(0, 140)}.`,
      impact: 'A database outage crashed the pet command pipeline instead of degrading to a reply.',
    });

    // (2) The catalog contracts the branded pets-unavailable notice — never a
    //     data-shaped answer fabricated from the failed reads: "You don't have a
    //     pet!" (a pet EXISTS), a fabricated "you need N coins" balance verdict,
    //     or a confirmed "Pet Fed!" during an outage are all LIES.
    const unavailableRe = /unavailable|try again|temporar|later|degraded|issue|problem/i;
    const viewLie = /have a pet|not enabled/i.test(viewReply);
    const feedLie = /have a pet|you need|pet fed|not enabled/i.test(feedReply);
    ctx.expect(
      unavailableRe.test(viewReply) && unavailableRe.test(feedReply) && !viewLie && !feedLie,
      {
        assertionClass: 'branding',
        channel: 'captured-reply',
        promise:
          'With the database blocked, /pet view and /pet feed reply with the branded pets-unavailable notice — never a fabricated no-pet, insufficient-funds, or fed-confirmed verdict.',
        observation:
          `outage-window replies: view=${JSON.stringify(viewReply.slice(0, 140))} (dataShapedLie=${viewLie}), ` +
          `feed=${JSON.stringify(feedReply.slice(0, 140))} (dataShapedLie=${feedLie}).`,
        impact:
          'During a database outage a pet command fabricated a data-shaped answer from a failed read — members are told a lie about a pet/balance the bot could not read.',
      },
    );

    // (3) ZERO CORRUPTION: no coins or pet stats moved during the outage — the
    //     seeded rows are byte-identical after restore.
    const walletAfter = await readWallet(handle, userA);
    const petAfter = await readPet(handle, userA);
    ctx.expect(
      walletAfter?.wallet === 500 && petAfter?.hunger === 40 && petAfter?.level === 3 && petAfter?.xp === 120,
      {
        assertionClass: 'Discord',
        channel: 'db-observable',
        promise:
          'No coins move and no pet stat mutates during the outage window: the wallet and the pet row are unchanged after restoration.',
        observation:
          `post-restore wallet=${walletAfter?.wallet} (expected 500); pet hunger=${petAfter?.hunger}/level=${petAfter?.level}/xp=${petAfter?.xp} ` +
          `(expected 40/3/120).`,
        impact: 'A database outage moved play-money or mutated pet stats — outage-window corruption.',
      },
    );

    // (4) RECOVERY: the very next /pet feed debits the 50-coin feed cost exactly
    //     once and applies (hunger 40 → 70) — the catalog's "fresh /pet feed
    //     debits exactly once" recovery contract.
    const recoveredFeed = petReplyText(
      await ctx.runSlash(handle, { commandName: 'pet', userId: userA, subcommand: 'feed' }),
    );
    const walletRecovered = await readWallet(handle, userA);
    const petRecovered = await readPet(handle, userA);
    ctx.expect(
      walletRecovered?.wallet === 450 && petRecovered?.hunger === 70 && /pet fed/i.test(recoveredFeed),
      {
        assertionClass: 'replay-safety',
        channel: 'db-observable',
        promise:
          'After restoration a fresh /pet feed debits the feed cost exactly once and applies the hunger gain (no lingering degradation, no double debit).',
        observation:
          `post-restore /pet feed replied ${JSON.stringify(recoveredFeed.slice(0, 140))}; wallet 500→${walletRecovered?.wallet} ` +
          `(expected 450 — one 50 debit); hunger 40→${petRecovered?.hunger} (expected 70).`,
        impact: 'The pet pipeline did not recover cleanly after the outage ended (no feed applied, or the cost debited zero/multiple times).',
      },
    );

    await proveRlsIsolation(ctx, handle, userA);
  } else {
    ctx.gate(
      'Discord',
      'db-observable',
      'With database access blocked, /pet view and /pet feed reply with the branded pets-unavailable message and no coins move; after restore a fresh /pet feed debits exactly once and applies.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'replay-safety',
      'db-observable',
      'No duplicate play-coin debit survives the outage/restore cycle.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'branding',
      'captured-reply',
      'The degradation reply uses the branded pets-unavailable template in the owner voice.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'database-RLS',
      'db-rls',
      'Pet rows stay guild-scoped through the outage window.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed pet command).',
    'requires the dependency-degradation alert aggregation plus owner alert channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'After restoration a fresh /pet feed debits exactly once and applies, logged with the run-prefixed correlation id.',
    'the pet care flow writes no DB-observable audit/ledger row (economy_subtract_balance touches only economy_wallets); the exactly-once debit itself is proven above via the wallet delta',
  );
}

/** RETRY — a purchase whose pet insert fails refunds the play coins exactly once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_pets_enabled: true },
  });
  const userA = ctx.userId('a');

  // The refund branch's PRIMITIVES: debit then economy_add_balance restores the exact
  // adoption price, and (having created no pet) no orphan pet row is left behind.
  await seedWallet(handle, userA, ADOPTION_PRICE);
  const debitErr = await debit(handle, userA, ADOPTION_PRICE);
  const afterDebit = await readWallet(handle, userA);
  const refundErr = await credit(handle, userA, ADOPTION_PRICE); // the refund the catch performs
  const afterRefund = await readWallet(handle, userA);
  const orphanPets = await petCount(handle, userA);
  ctx.expect(
    debitErr === null && afterDebit?.wallet === 0 && refundErr === null && afterRefund?.wallet === ADOPTION_PRICE && orphanPets === 0,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'When the pet insert fails, the debited coins are refunded exactly once through economy_add_balance and no orphan pet row exists.',
      observation:
        `after debit wallet=${afterDebit?.wallet} (0); after refund wallet=${afterRefund?.wallet} (expected the full ${ADOPTION_PRICE} restored); ` +
        `orphan pet rows=${orphanPets} (expected 0).`,
      impact: 'The debit/refund pair did not restore the coins exactly, or left an orphan pet — a play-coin loss or ghost pet.',
    },
  );
  // Idempotency of the ledger sequence: debit → single refund nets to zero movement.
  ctx.expect(afterRefund?.wallet === ADOPTION_PRICE, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The refund applies once: a debit followed by a single refund nets to zero wallet movement (never a double refund).',
    observation: `net wallet after debit+refund=${afterRefund?.wallet} (expected the original ${ADOPTION_PRICE}, i.e. net zero).`,
    impact: 'The refund double-applied — the play-money ledger would show a double refund.',
  });

  // The clean RETRY then adopts exactly one pet for exactly one debit.
  const retryErr = await debit(handle, userA, ADOPTION_PRICE);
  const retryPet = await insertPet(handle, userA);
  const retryWallet = await readWallet(handle, userA);
  const finalPets = await petCount(handle, userA);
  ctx.expect(retryErr === null && retryPet.id !== null && retryWallet?.wallet === 0 && finalPets === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The retried /pet buy then succeeds with exactly one debit and exactly one pet row.',
    observation: `retry debit err=${retryErr ? retryErr.message : 'none'}, pet id=${retryPet.id ?? '(null)'}, wallet=${retryWallet?.wallet} (0), pet rows=${finalPets} (1).`,
    impact: 'The clean retry after a refunded purchase did not adopt exactly one pet for one debit.',
  });

  // The injected insert-fault + the branded refund confirmation reply need the fault lane.
  ctx.gate(
    'Discord',
    'discord-readback',
    'After the injected economy_pets insert fault, run-member-a sees the branded refund confirmation and /pet view shows no pet.',
    'requires a mid-buy fault-injection lane (fail the economy_pets insert after the debit); the harness runs against a healthy DB so the insert never fails to reach the refund/confirmation branch',
  );
  gateAudit(ctx);
  await proveRlsIsolation(ctx, handle, userA); // a pet exists after the retry → positive control holds
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx, handle);
}

/** REPLAY — re-delivering the buy must not double-create; feed-replay dedup is gated. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_pets_enabled: true },
  });
  const userA = ctx.userId('a');

  // Buy is idempotent by UNIQUE (guild_id, user_id): re-delivering the adoption insert
  // is rejected with 23505 (the exact error buyPet catches to refund), leaving one pet.
  const first = await insertPet(handle, userA);
  const replay = await insertPet(handle, userA);
  const pets = await petCount(handle, userA);
  ctx.expect(first.id !== null && replay.error?.code === '23505' && pets === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Re-delivering /pet buy yields no duplicate pet: UNIQUE (guild_id, user_id) keeps exactly one economy_pets row (one effect per logical adoption).',
    observation:
      `first pet id=${first.id ?? '(null)'}; the replayed adoption insert error code=${replay.error?.code ?? '(none)'}; ` +
      `pet rows=${pets} (expected exactly 1).`,
    impact: 'A replayed /pet buy created a second pet — the one-pet-per-member guarantee is broken.',
  });

  // The FEED replay-debit is NOT dedup-observable here: economy_pet_feed +
  // economy_subtract_balance carry no interaction-id idempotency key, and the dispatcher
  // performs no interaction-id dedup, so re-driving /pet feed would simply debit twice —
  // there is no dispatcher-level feed dedup to OBSERVE (Discord itself guarantees single
  // delivery of a given interaction). Flagged, not faked, not asserted as a false pass.
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering the /pet feed interaction applies exactly one feed debit (no double charge).',
    'the feed path (economy_pet_feed + economy_subtract_balance) carries no interaction-id idempotency key and the dispatcher performs no interaction-id dedup, so re-driving /pet feed just debits twice (Discord guarantees single delivery of an interaction) — there is no dispatcher-level feed dedup to observe in this bot-only harness',
  );
  gateLivePet(
    ctx,
    'The channel shows exactly one adoption embed and one feed confirmation despite the replays, and /pet view + wallet totals match the pre-replay snapshot.',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx, handle);
  gateAudit(ctx);
}

/** RESTART — pet stats/level/prestige survive a full stack reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');

  // Boot #1: adopt + evolve the pet to a distinctive state, snapshot.
  const first = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_pets_enabled: true },
  });
  await insertPet(first, userA, { name: 'restart-pet', level: 12, xp: 350, hunger: 44, happiness: 51, energy: 77, prestige: 2, status: 'happy' });
  const snapshot = await readPet(first, userA);
  await first.cleanup(); // simulate shutdown (does NOT delete rows)

  // Boot #2: SAME guild id (restart). The pet must be byte-identical (it lives in Supabase).
  const second = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_pets_enabled: true },
  });
  const afterRestart = await readPet(second, userA);
  ctx.expect(
    afterRestart?.id === snapshot?.id &&
      afterRestart?.level === 12 &&
      afterRestart?.xp === 350 &&
      afterRestart?.hunger === 44 &&
      afterRestart?.happiness === 51 &&
      afterRestart?.energy === 77 &&
      afterRestart?.prestige === 2 &&
      afterRestart?.name === 'restart-pet',
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart, /pet view matches the pre-restart snapshot exactly (stats, level, xp, and prestige persist).',
      observation:
        `pre-restart level=${snapshot?.level}/xp=${snapshot?.xp}/hunger=${snapshot?.hunger}/prestige=${snapshot?.prestige}; ` +
        `post-restart level=${afterRestart?.level}/xp=${afterRestart?.xp}/hunger=${afterRestart?.hunger}/prestige=${afterRestart?.prestige} ` +
        `(expected 12 / 350 / 44 / 2).`,
      impact: 'Pet state did not survive a restart — persisted stats/level/prestige were lost or altered.',
    },
  );

  // The "decay interval spanning the restart decays at most once / cadence persists"
  // facet is the process-timer path.
  gateLivePet(
    ctx,
    'The decay timer resumes on its configured interval after restart and the interval spanning the restart decays the pet at most once (no catch-up double-decay).',
  );

  await proveRlsIsolation(ctx, second, userA);
  await proveNoOwnerAlert(ctx, second);
  await proveBranding(ctx, second);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** RACE — concurrent prestige applies exactly once; concurrent play cooldown needs Valkey. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_pets_enabled: true },
  });
  const userA = ctx.userId('a');

  // Seed a max-level pet, then fire TWO simultaneous atomic-prestige RPCs. The RPC only
  // applies WHERE level >= max and resets level to 1, so under the row lock exactly one
  // wins: the second re-reads level=1, matches nothing, and returns no row.
  await insertPet(handle, userA, { level: 50, xp: 4900, prestige: 0, attack: 5, defense: 5, speed: 5, health: 20 });
  const [p1, p2] = await Promise.all([prestigeRpc(handle, userA, 50), prestigeRpc(handle, userA, 50)]);
  const applied = [p1, p2].filter((r) => r.length > 0).length;
  const afterPet = await readPet(handle, userA);
  ctx.expect(applied === 1 && afterPet?.prestige === 1 && afterPet?.level === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Two simultaneous /pet prestige calls on a max-level pet apply exactly once: prestige increments by one and level resets to 1 (the loser is a no-op).',
    observation:
      `concurrent atomic-prestige RPCs that returned a row=${applied} (expected exactly 1); ` +
      `final pet prestige=${afterPet?.prestige} (expected 1), level=${afterPet?.level} (expected 1).`,
    impact: 'Concurrent prestige double-applied (or none applied) — economy_pet_atomic_prestige did not serialize the max-level guard.',
  });
  ctx.expect(afterPet?.attack === 6 && afterPet?.defense === 6 && afterPet?.speed === 6 && afterPet?.health === 22, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A single prestige applies the permanent stat bonuses exactly once (+1 ATK/DEF/SPD, +2 HP).',
    observation:
      `post-race stats attack=${afterPet?.attack} (expected 6), defense=${afterPet?.defense} (6), speed=${afterPet?.speed} (6), health=${afterPet?.health} (22).`,
    impact: 'The prestige stat bonuses were applied zero or two times under the concurrent race.',
  });

  // The /pet play cooldown that guarantees "one applied play + one refusal" is a Valkey
  // SET PX NX — not runnable without Redis.
  ctx.gate(
    'Discord',
    'redis-dependency',
    'Two simultaneous /pet play invocations yield exactly one applied happiness gain and one cooldown refusal.',
    'no Valkey/Redis reachable — the /pet play cooldown (SET PX NX) that guarantees single-application cannot run',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx, handle);
  gateAudit(ctx);
}

/** XGUILD — pets are strictly per-guild (pet row, wallet, and config). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');

  const handleA = await ctx.bootGuild({
    guildId: guildA,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_pets_enabled: true, economy_pet_feed_cost: 50 },
  });
  const handleB = await ctx.bootGuild({
    guildId: guildB,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_pets_enabled: true, economy_pet_feed_cost: 10 },
  });

  // Guild A pet in a distinctive state, snapshot.
  await insertPet(handleA, userA, { name: 'a-pet', level: 8, xp: 260, hunger: 90 });
  const snapA = await readPet(handleA, userA);

  // The SAME member adopts + trains in guild B: a SEPARATE pet under guild B; guild A untouched.
  await insertPet(handleB, userA, { name: 'b-pet', level: 1, xp: 0, energy: 100 });
  await seedWallet(handleB, userA, 1000);
  await debit(handleB, userA, 100);
  await trainRpc(handleB, userA, 30, 20);
  const petB = await readPet(handleB, userA);
  const petAAfter = await readPet(handleA, userA);

  ctx.expect(
    petB?.guild_id === guildB &&
      petB?.xp === 30 &&
      petAAfter?.guild_id === guildA &&
      petAAfter?.xp === snapA?.xp &&
      petAAfter?.level === snapA?.level &&
      snapA?.xp === 260,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Adopting and training a pet in a second guild never touches the first guild’s pet; each guild’s pet evolves independently.',
      observation:
        `guild A pet xp=${petAAfter?.xp} (unchanged at ${snapA?.xp}=260), level=${petAAfter?.level} under "${petAAfter?.guild_id}"; ` +
        `guild B pet xp=${petB?.xp} (trained to 30) under "${petB?.guild_id}".`,
      impact: 'Cross-guild activity mutated another guild’s pet — per-guild isolation broken.',
    },
  );

  // Config is per-guild too: each guild's feed cost is scoped to that guild.
  const cfgA = await readConfig(handleA);
  const cfgB = await readConfig(handleB);
  ctx.expect(cfgA?.economy_pet_feed_cost === 50 && cfgB?.economy_pet_feed_cost === 10, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Each guild’s pet feed cost is scoped to that guild (A=50, B=10).',
    observation: `guild A feed cost=${cfgA?.economy_pet_feed_cost} (expected 50), guild B feed cost=${cfgB?.economy_pet_feed_cost} (expected 10).`,
    impact: 'A guild’s pet configuration leaked across guilds.',
  });

  // Each guild scope reads its OWN distinct pet row and never the other's.
  const { data: bScoped } = await handleB.supabase
    .from('economy_pets')
    .select('xp, guild_id, name')
    .eq('guild_id', guildB)
    .eq('user_id', userA)
    .maybeSingle();
  const { data: aScoped } = await handleA.supabase
    .from('economy_pets')
    .select('xp, guild_id, name')
    .eq('guild_id', guildA)
    .eq('user_id', userA)
    .maybeSingle();
  const bRow = bScoped as { xp: number; guild_id: string; name: string } | null;
  const aRow = aScoped as { xp: number; guild_id: string; name: string } | null;
  ctx.expect(
    bRow?.guild_id === guildB && bRow?.name === 'b-pet' && aRow?.guild_id === guildA && aRow?.name === 'a-pet',
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'Each guild scope reads its OWN pet row and never the other’s: guild B → its b-pet row, guild A → its a-pet row.',
      observation:
        `guild-B-scoped read name="${bRow?.name}" under "${bRow?.guild_id}"; ` +
        `guild-A-scoped read name="${aRow?.name}" under "${aRow?.guild_id}" (distinct rows under distinct guild_ids).`,
      impact: 'A guild-scoped read returned the other guild’s pet row — cross-guild leakage.',
    },
  );
  await proveRlsIsolation(ctx, handleA, userA);

  // Drive the REAL /pet view in guild A AFTER the guild-B activity: it must still render
  // guild A's OWN pet (a-pet), proving cross-guild activity never bled into guild A's
  // member-facing surface. Live via the #331 subcommand injector.
  const viewA = await ctx.runSlash(handleA, { commandName: 'pet', userId: userA, subcommand: 'view' });
  const viewAText = petReplyText(viewA);
  ctx.expect(/a-pet/i.test(viewAText), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise:
      'After guild B activity, guild A’s /pet view still renders guild A’s own pet (a-pet) — cross-guild activity never leaks into guild A’s member surface.',
    observation: `guild A /pet view replied ${JSON.stringify(viewAText.slice(0, 120))} (expected guild A’s "a-pet").`,
    impact: 'Guild A’s /pet view surfaced the wrong (or another guild’s) pet — cross-guild leakage in the member surface.',
  });
  // The live-guild wallet-debit-at-configured-price observation stays a readback residual.
  gateLivePet(
    ctx,
    'Guild B’s adoption debits guild B’s wallet at guild B’s configured price — observed in the live guild.',
  );
  await proveNoOwnerAlert(ctx, handleA);
  await proveBranding(ctx, handleA);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_pets_enabled: true },
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Create run-prefixed operational rows: pets + wallet + a battle record.
  await seedWallet(handle, userA, 500);
  await insertPet(handle, userA, { name: 'cleanup-a' });
  await insertPet(handle, userB, { name: 'cleanup-b' });
  await handle.supabase.from('economy_pet_battles').insert({
    guild_id: handle.guildId,
    challenger_id: userA,
    defender_id: userB,
    winner_id: userA,
    challenger_dmg: 42,
    defender_dmg: 17,
    reward: 110,
  });

  const petsBefore = (await petCount(handle, userA)) + (await petCount(handle, userB));
  const battlesBefore = await battleCount(handle);
  const walletsBefore = await walletCount(handle, userA);
  ctx.expect(petsBefore >= 2 && battlesBefore >= 1 && walletsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed pet, battle, and wallet rows (pre-cleanup baseline).',
    observation: `pre-cleanup: pet rows=${petsBefore}, battle rows=${battlesBefore}, wallet rows=${walletsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep removes them).
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  // Drive the branded /pet buy surface too (before the sweep, so its brand rows are also
  // cleared and the post-sweep zero-count covers them).
  await proveBranding(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const petsAfter = (await petCount(handle, userA)) + (await petCount(handle, userB));
  const battlesAfter = await battleCount(handle);
  const walletsAfter = await walletCount(handle, userA);
  ctx.expect(petsAfter === 0 && battlesAfter === 0 && walletsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed pet, battle, and wallet rows are deleted; a final sweep finds zero run-prefixed pets resources.',
    observation: `post-sweep: pet rows=${petsAfter}, battle rows=${battlesAfter}, wallet rows=${walletsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed pets rows behind — the suite leaves residue.',
  });

  gateAudit(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed pet adoption embeds, battle announcements, or care confirmations after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane; the pet operational rows are the DB-observable evidence here',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ──────────────────────────────────────────────────────

/**
 * The Companion Pets domain proof: the guild_id-scoped tables the sweep must clear
 * (child → parent so FK-constrained rows are removed before the guild row), plus the 12
 * scenario scripts. `economy_pet_battles` and `economy_pets` are both direct guild_id
 * columns with no blocking FK into each other; `economy_profiles.favorite_pet` (not
 * written by this domain) references economy_pets ON DELETE SET NULL, so it never blocks.
 */
export const gameEconomyPetsProof: DomainProof = {
  domainId: 'game-economy-pets',
  guildScopedTables: [
    'economy_pet_battles',
    'economy_pets',
    'economy_wallets',
    'alerts',
  ],
  scripts: {
    DEF,
    'SET-A': SET_A,
    'SET-B': SET_B,
    INVALID,
    UNAUTH,
    DEPFAIL,
    RETRY,
    REPLAY,
    RESTART,
    RACE,
    XGUILD,
    CLEANUP,
  },
};
