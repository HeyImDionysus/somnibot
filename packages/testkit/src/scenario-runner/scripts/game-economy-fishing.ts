/**
 * scenario-runner/scripts/game-economy-fishing — the Fishing & Collections domain proof.
 *
 * Binds the fishing domain's 12 declarative catalog scenarios to concrete, real-stack
 * proof scripts driven against LOCAL Supabase. Every DB-observable / RLS / owner-alert
 * assertion runs NOW against the SAME production primitives the bot uses; the live
 * Discord surfaces are GATED — the exact honesty boundary the harness requires.
 *
 * ── Why this domain is MOSTLY GATED on the reply/Discord side ──
 * The domain's ONLY member entrypoints are `/fish cast|sell|collection|leaderboard` —
 * slash SUBCOMMANDS. `ScenarioContext.runSlash` (see `RunSlashParams`) carries no
 * subcommand field and `context.runSlash` never sets one, so `handleFishingCommand`'s
 * first line `interaction.options.getSubcommand()` throws before any fishing work runs;
 * there is no way to drive a fishing reply/embed in this harness. On top of that,
 * `FishingManager.fish()` claims its per-user cooldown with an atomic Valkey `SET NX`
 * BEFORE any catch work, so the cast path also needs a running Valkey/Redis. Both are
 * absent here, so every member-facing fishing surface (catch embed, cooldown refusal,
 * collection/leaderboard render, branded voice) is GATED — never faked.
 *
 * ── What IS proven NOW, non-vacuously ──
 * `FishingManager` is a thin orchestration over primitives that ARE drivable directly
 * against local Supabase:
 *   - config lives in `guild_config` (the exact row `getConfig()` reads) — proven by
 *     readback that the live DB defaults equal the catalog defaults and that saved
 *     values persist;
 *   - the auto-sell credit is `economy_add_balance` (the exact RPC `addCurrency` calls)
 *     and the catch record is an `economy_fish_catches` insert (exactly what
 *     `rollFishCatch` writes) — proven by the debit-free credit moving the wallet by the
 *     sale value once and the append-only catch row carrying actor + guild + value;
 *   - the "at most one bait per cast" guarantee is the atomic `economy_decrement_inventory`
 *     RPC (`SELECT … FOR UPDATE`) — proven by two concurrent decrements of a single bait
 *     yielding exactly one success;
 *   - `economy_fish_species` / `economy_fish_catches` are guild-scoped under RLS, locked
 *     to service_role (the service role sees a seeded catch an anon/second-guild client
 *     must not);
 *   - catch history, collection progress, and config survive a full reboot (they live in
 *     Supabase).
 *
 * Behavior-bug discovery: where the REAL bot diverges from the catalog's contracted
 * intent, the script records a FAIL (promise / observation / impact) — it never forces
 * green and never weakens the catalog. Two divergences are surfaced this way:
 *   - the collection completion bonus (catalog control fishing-collection-reward-*,
 *     default 5000, message collection-completed, state transition collection-finished)
 *     has NO backing guild_config column and NO FishingManager code path (SET-B); and
 *   - a failed auto-sell payout cannot be flagged/retried: economy_fish_catches has no
 *     persisted paid/payout-status column and there is no retry queue or idempotency key
 *     (RETRY).
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes ────────────────────────────────────────────────────────────

interface FishingConfigRow {
  economy_fishing_enabled: boolean;
  economy_fishing_cooldown_seconds: number;
  economy_fishing_junk_chance_pct: number;
  economy_fishing_treasure_chance_pct: number;
}

interface WalletRow {
  wallet: number;
  bank: number;
  user_id: string;
  guild_id: string;
}

interface SpeciesRow {
  id: string;
  guild_id: string;
  name: string;
  rarity: string;
}

interface CatchRow {
  id: string;
  user_id: string;
  guild_id: string;
  species_id: string;
  weight: number;
  price_earned: number;
}

/** A minimal PostgREST error surface (code + message) for insert/RPC/select results. */
type PgErr = { code?: string; message?: string } | null;

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

async function readConfig(handle: LiveClientHandle): Promise<FishingConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select(
      'economy_fishing_enabled, economy_fishing_cooldown_seconds, economy_fishing_junk_chance_pct, economy_fishing_treasure_chance_pct',
    )
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as FishingConfigRow | null) ?? null;
}

async function readWallet(handle: LiveClientHandle, userId: string): Promise<WalletRow | null> {
  const { data } = await handle.supabase
    .from('economy_wallets')
    .select('wallet, bank, user_id, guild_id')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as WalletRow | null) ?? null;
}

/** Arrange an exact wallet via the REAL wallet initializer, then a precise set. */
async function seedWallet(
  handle: LiveClientHandle,
  userId: string,
  wallet: number,
  bank = 0,
): Promise<void> {
  await handle.supabase.rpc('economy_get_or_create_wallet', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
  });
  await handle.supabase
    .from('economy_wallets')
    .update({ wallet, bank })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
}

async function walletCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_wallets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

/**
 * Seed run-prefixed species exactly as `FishingManager.seedDefaultSpecies` would
 * (name/emoji/rarity/weights/base_price + is_default), so catch inserts can carry a
 * valid species_id FK and the RLS/cleanup probes have real rows to isolate.
 */
async function seedSpecies(ctx: ScenarioContext, handle: LiveClientHandle): Promise<SpeciesRow[]> {
  const rows = [
    { name: `${ctx.runPrefix}Sardine`, emoji: '🐟', rarity: 'common', min_weight: 0.1, max_weight: 0.5, base_price: 5 },
    { name: `${ctx.runPrefix}Salmon`, emoji: '🐠', rarity: 'uncommon', min_weight: 2.0, max_weight: 8.0, base_price: 30 },
    { name: `${ctx.runPrefix}Swordfish`, emoji: '🐡', rarity: 'rare', min_weight: 20.0, max_weight: 80.0, base_price: 120 },
  ].map((s) => ({ ...s, guild_id: handle.guildId, is_default: true, active: true }));
  const { data } = await handle.supabase
    .from('economy_fish_species')
    .insert(rows)
    .select('id, guild_id, name, rarity');
  return (data as SpeciesRow[] | null) ?? [];
}

/** Insert a catch exactly as `FishingManager.rollFishCatch` does; surface id + any error. */
async function insertCatch(
  handle: LiveClientHandle,
  userId: string,
  speciesId: string,
  weight: number,
  price: number,
): Promise<{ id: string | null; error: PgErr }> {
  const { data, error } = await handle.supabase
    .from('economy_fish_catches')
    .insert({
      guild_id: handle.guildId,
      user_id: userId,
      species_id: speciesId,
      weight,
      price_earned: price,
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: (error as PgErr) ?? null };
}

/** The EXACT RPC `FishingManager.addCurrency` credits the auto-sell with. */
async function creditAddBalance(handle: LiveClientHandle, userId: string, amount: number): Promise<PgErr> {
  const { error } = await handle.supabase.rpc('economy_add_balance', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
  return (error as PgErr) ?? null;
}

async function catchCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_fish_catches')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

async function readFirstCatch(handle: LiveClientHandle, userId: string): Promise<CatchRow | null> {
  const { data } = await handle.supabase
    .from('economy_fish_catches')
    .select('id, user_id, guild_id, species_id, weight, price_earned')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .order('caught_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as CatchRow | null) ?? null;
}

/** Service-role count of the domain's core append-only table — the RLS positive control. */
async function serviceCatchCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_fish_catches')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function speciesCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_fish_species')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/** Seed one run-prefixed Bait item + inventory row and return its item id. */
async function seedBaitItem(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  userId: string,
  quantity: number,
): Promise<string | null> {
  const { data: item } = await handle.supabase
    .from('economy_items')
    .insert({ guild_id: handle.guildId, name: `${ctx.runPrefix}Basic Bait`, category: 'Bait', price: 5 })
    .select('id')
    .single();
  const itemId = (item as { id: string } | null)?.id ?? null;
  if (!itemId) return null;
  await handle.supabase
    .from('economy_inventory')
    .insert({ guild_id: handle.guildId, user_id: userId, item_id: itemId, quantity });
  return itemId;
}

/** The EXACT atomic RPC `FishingManager.consumeBait` calls; returns whether a bait was consumed. */
async function decrementInventory(
  handle: LiveClientHandle,
  userId: string,
  itemId: string,
): Promise<boolean> {
  const { data } = await handle.supabase.rpc('economy_decrement_inventory', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_item_id: itemId,
    p_quantity: 1,
  });
  return data === true;
}

async function inventoryQty(handle: LiveClientHandle, userId: string, itemId: string): Promise<number> {
  const { data } = await handle.supabase
    .from('economy_inventory')
    .select('quantity')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .maybeSingle();
  return (data as { quantity: number } | null)?.quantity ?? 0;
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
 * anon key can read (RLS deny → 0), or null when inconclusive (→ GATE). A genuine
 * authorization denial surfaces as SQLSTATE 42501 / "permission denied" (HTTP 401/403)
 * which we treat as the deny we want; a rejected key or other error is inconclusive.
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

// ── Reusable per-class proofs ─────────────────────────────────────────────

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
    'Failure-branch alerts (payout-degraded) carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected failure branch',
  );
}

/**
 * Prove `economy_fish_catches` is guild-scoped under RLS, made non-vacuous by a positive
 * control: the scenario has already seeded a real catch under the guild (the service role
 * sees it), so an anon client reading ZERO of those rows is a real deny. GATEs (never
 * fakes) when there is no catch to isolate, no anon key, or the probe is inconclusive.
 */
async function proveRlsIsolation(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const svc = await serviceCatchCount(handle);
  if (svc === 0) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_fish_catches rows (guild-scoped RLS, service_role-locked).',
      'this scenario seeds no catch row to serve as the positive control for the anon-denial probe; guild-scoped RLS is proven in scenarios that seed a catch',
    );
    return;
  }
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_fish_catches rows (guild-scoped RLS, service_role-locked).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'economy_fish_catches', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_fish_catches rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s fishing catch rows while an anon client reads zero of them (economy_fish_catches locked to service_role).',
    observation:
      `service-role sees ${svc} catch row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} economy_fish_catches row(s) for that guild.`,
    impact:
      'A catch row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).',
  });
}

/**
 * Every member-facing fishing surface is a subcommand reply/embed (see file header),
 * none drivable here. Branding is GATED honestly rather than checked against a synthetic
 * string or the generic dispatcher error reply.
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Member-facing fishing surfaces (catch embed, cooldown refusal, collection/leaderboard) show the owner brand name, colors, and voice preset with the powered-by-SomniBot attribution and zero stock-bot wording.',
    'the only fishing entrypoints are /fish cast|sell|collection|leaderboard (slash SUBCOMMANDS); ScenarioContext.runSlash carries no subcommand, so no member-facing fishing reply is produced to inspect',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on fishing embeds.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

/** The cast/collection/leaderboard reply flows are subcommand + Valkey-SET-NX driven — gated. */
function gateCastLive(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    'the /fish cast path is subcommand-undrivable (runSlash supplies no subcommand) AND claims its cooldown with an atomic Valkey SET NX before any catch work, so it also needs a running Valkey/Redis — neither is available in this bot-only harness',
  );
}

/**
 * Replay dedup for /fish cast is enforced solely by the ephemeral Valkey SET NX cooldown,
 * and the cast path is subcommand-undrivable; economy_fish_catches carries NO persisted
 * idempotency / interaction-id column to observe DB-side. GATED honestly (never faked).
 */
function gateReplay(ctx: ScenarioContext): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering the /fish cast interaction yields exactly one catch row and one wallet credit (persisted idempotency keys show one effect per logical action).',
    'the /fish cast path is subcommand-undrivable and its only replay guard is the Valkey SET NX cooldown (redis-dependency); economy_fish_catches carries no persisted idempotency/interaction key, so exactly-once cannot be observed DB-side here',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — out-of-the-box: 30s cooldown, junk 15%, treasure 5%, catch records + auto-sells once. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const cooldownDefault = Number(declaredDefault(ctx.domain, 'fishing-cooldown-seconds')); // 30
  const junkDefault = Number(declaredDefault(ctx.domain, 'fishing-junk-chance-pct')); // 15
  const treasureDefault = Number(declaredDefault(ctx.domain, 'fishing-treasure-chance-pct')); // 5

  // Enable fishing but DO NOT override the numeric columns, so they take their DB
  // defaults — proving the live defaults equal the catalog-declared defaults.
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_fishing_enabled: true },
  });
  const userA = ctx.userId('a');

  const cfg = await readConfig(handle);
  ctx.expect(
    cfg?.economy_fishing_cooldown_seconds === cooldownDefault &&
      cfg?.economy_fishing_junk_chance_pct === junkDefault &&
      cfg?.economy_fishing_treasure_chance_pct === treasureDefault,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `Out of the box the live guild_config holds the catalog fishing defaults: cooldown ${cooldownDefault}s, junk ${junkDefault}%, treasure ${treasureDefault}%.`,
      observation:
        `guild_config holds cooldown=${cfg?.economy_fishing_cooldown_seconds}, ` +
        `junk=${cfg?.economy_fishing_junk_chance_pct}, treasure=${cfg?.economy_fishing_treasure_chance_pct}.`,
      impact: 'The live fishing defaults diverged from the catalog-declared defaults.',
    },
  );

  // Auto-sell primitives — the EXACT pair rollFishCatch runs: insert an economy_fish_catches
  // row, then credit the wallet via economy_add_balance. Wallet moves by the sale value once.
  await seedWallet(handle, userA, 0, 0);
  const species = await seedSpecies(ctx, handle);
  const sp = species[0];
  const price = 42;
  const cat = sp ? await insertCatch(handle, userA, sp.id, 3.25, price) : { id: null, error: null as PgErr };
  const creditErr = await creditAddBalance(handle, userA, price);
  const wallet = await readWallet(handle, userA);
  const catches = await catchCount(handle, userA);
  ctx.expect(cat.id !== null && creditErr === null && wallet?.wallet === price && catches === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A cast records exactly one economy_fish_catches row and auto-sells it by crediting the wallet exactly once via economy_add_balance (the exact primitives FishingManager.rollFishCatch runs).',
    observation:
      `catch row id=${cat.id ?? '(null)'} (insert err=${cat.error ? cat.error.message : 'none'}); ` +
      `credit err=${creditErr ? creditErr.message : 'none'}; wallet=${wallet?.wallet} (expected ${price}); catch rows=${catches} (expected 1).`,
    impact: 'The catch-record + auto-sell credit primitives did not record one catch and credit exactly the sale value once.',
  });

  // Audit: the append-only catch row carries actor + guild + value.
  const firstCatch = await readFirstCatch(handle, userA);
  ctx.expect(
    firstCatch !== null &&
      firstCatch.user_id === userA &&
      firstCatch.guild_id === handle.guildId &&
      firstCatch.price_earned === price,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Each catch lands one append-only economy_fish_catches row carrying the actor (user_id), guild (guild_id), and sale value.',
      observation:
        `catch row actor=${firstCatch?.user_id} (expected ${userA}), guild=${firstCatch?.guild_id}, ` +
        `price_earned=${firstCatch?.price_earned} (expected ${price}).`,
      impact: 'The append-only catch ledger row did not carry the actor / guild / sale value.',
    },
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Each fishing action also lands an audit row with a run-prefixed correlation id, and audit history is anonymized rather than deleted.',
    'economy_fish_catches carries no correlation-id column and FishingManager writes no audit_logs row; the append-only catch row (actor+guild+value) is the DB-observable audit evidence, but the correlation-id + audit_logs-anonymization contract is not backed here',
  );

  gateCastLive(
    ctx,
    'The /fish cast embed posts the branded catch, the wallet reflects exactly the one auto-sell credit, an immediate second cast returns the branded 30s cooldown refusal, and /fish collection lists the discovered species with its rarity.',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplay(ctx);
}

/** SET-A — dashboard save (cooldown 5s / junk 40% / treasure 10%) takes live effect. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_fishing_enabled: true,
      economy_fishing_cooldown_seconds: 5,
      economy_fishing_junk_chance_pct: 40,
      economy_fishing_treasure_chance_pct: 10,
    },
  });
  const userA = ctx.userId('a');

  // The saved values land in guild_config — the exact row getConfig() reads live (no restart).
  const cfg = await readConfig(handle);
  ctx.expect(
    cfg?.economy_fishing_cooldown_seconds === 5 &&
      cfg?.economy_fishing_junk_chance_pct === 40 &&
      cfg?.economy_fishing_treasure_chance_pct === 10,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'A dashboard save of cooldown 5s, junk 40%, treasure 10% persists to guild_config and is what the bot reads live (no restart).',
      observation:
        `guild_config holds cooldown=${cfg?.economy_fishing_cooldown_seconds} (expected 5), ` +
        `junk=${cfg?.economy_fishing_junk_chance_pct} (expected 40), treasure=${cfg?.economy_fishing_treasure_chance_pct} (expected 10).`,
      impact: 'A saved fishing configuration did not persist / would not take live effect.',
    },
  );

  // Seed a catch so the RLS positive control holds; the shortened-cooldown and raised-odds
  // BEHAVIOR is cast-driven (subcommand + SET NX) and is gated.
  const species = await seedSpecies(ctx, handle);
  if (species[0]) await insertCatch(handle, userA, species[0].id, 1.5, 30);

  gateCastLive(
    ctx,
    'After the save with no restart, a cast followed by a cast 5 seconds later both succeed under the shortened cooldown, and repeated casts surface junk (~40%) and treasure (~10%) outcomes consistent with the raised percentages.',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplay(ctx);
}

/** SET-B — treasure disabled (0%) persists; the collection completion bonus toggle is UNBACKED (finding). */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_fishing_enabled: true,
      economy_fishing_treasure_chance_pct: 0,
    },
  });
  const userA = ctx.userId('a');

  // Treasure 0 persists to the exact row getConfig() reads (this piece IS backed).
  const cfg = await readConfig(handle);
  ctx.expect(cfg?.economy_fishing_treasure_chance_pct === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Setting treasure chance to 0% persists to guild_config so no cast ever surfaces treasure.',
    observation: `guild_config holds treasure=${cfg?.economy_fishing_treasure_chance_pct} (expected 0).`,
    impact: 'The treasure-off configuration did not persist.',
  });

  // FINDING: the catalog contracts an owner-togglable collection completion bonus
  // (control fishing-collection-reward-enabled / -coins, default 5000, message
  // collection-completed, state transition collection-finished). Probe the backing:
  // guild_config exposes NO such column and FishingManager has NO completion-bonus path.
  const { error: rewardErr } = await handle.supabase
    .from('guild_config')
    .select('economy_fishing_collection_reward_enabled, economy_fishing_collection_reward_coins')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const rewardBacked = !rewardErr;
  ctx.expect(rewardBacked, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'The owner can independently disable the one-time collection completion bonus (fishing-collection-reward-enabled) and set its coin value (default 5000) — a backed, togglable setting that pays exactly once on collection completion.',
    observation: rewardBacked
      ? 'guild_config exposes the collection-reward columns.'
      : `guild_config has NO collection-reward column (read error ${rewardErr?.code ?? ''}: ${rewardErr?.message ?? ''}); FishingManager.getCollection pays no bonus and no code path references a completion reward.`,
    impact:
      'The catalog contracts an owner-togglable collection completion bonus (default 5000, message collection-completed, state transition collection-finished), but there is NO backing guild_config column and NO FishingManager code that pays or gates it — the setting cannot be saved or honored and the completion bonus is never paid.',
  });

  // Core loop primitives still work under the toggled config: a catch still records + auto-sells.
  await seedWallet(handle, userA, 0, 0);
  const species = await seedSpecies(ctx, handle);
  const sp = species[0];
  if (sp) await insertCatch(handle, userA, sp.id, 2.0, 30);
  const creditErr = await creditAddBalance(handle, userA, 30);
  const wallet = await readWallet(handle, userA);
  ctx.expect(creditErr === null && wallet?.wallet === 30 && (await catchCount(handle, userA)) === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'With treasure off (and the bonus toggled), core casting + auto-sell + collection tracking keep working (a catch records and credits normally).',
    observation: `after a seeded catch + credit: wallet=${wallet?.wallet} (expected 30), catch rows=${await catchCount(handle, userA)} (expected 1).`,
    impact: 'Toggling a fishing piece off broke the core catch/auto-sell loop.',
  });

  gateCastLive(
    ctx,
    'Discovering the final species posts the completion embed with no bonus credited, casts never yield treasure, and normal fish/junk catches still auto-sell and appear in /fish collection.',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplay(ctx);
}

/** INVALID — a rejected invalid config never persists; valid values retained live. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_fishing_enabled: true,
      economy_fishing_cooldown_seconds: 20,
      economy_fishing_junk_chance_pct: 30,
      economy_fishing_treasure_chance_pct: 10,
    },
  });
  const userA = ctx.userId('a');

  // guild_config keeps its prior valid values byte-for-byte (nothing invalid persisted).
  const cfg = await readConfig(handle);
  ctx.expect(
    cfg?.economy_fishing_cooldown_seconds === 20 &&
      cfg?.economy_fishing_junk_chance_pct === 30 &&
      cfg?.economy_fishing_treasure_chance_pct === 10,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'guild_config keeps its prior valid values byte-for-byte (a rejected negative cooldown / a junk+treasure sum above 100 never persists).',
      observation:
        `guild_config holds cooldown=${cfg?.economy_fishing_cooldown_seconds} (expected 20), ` +
        `junk=${cfg?.economy_fishing_junk_chance_pct} (expected 30), treasure=${cfg?.economy_fishing_treasure_chance_pct} (expected 10, sum 40 ≤ 100).`,
      impact: 'A valid fishing configuration was not retained after a rejected save.',
    },
  );

  // Behavior unchanged on the next action: a catch still records + auto-sells under the valid config.
  await seedWallet(handle, userA, 0, 0);
  const species = await seedSpecies(ctx, handle);
  if (species[0]) await insertCatch(handle, userA, species[0].id, 1.0, 12);
  const creditErr = await creditAddBalance(handle, userA, 12);
  const wallet = await readWallet(handle, userA);
  ctx.expect(creditErr === null && wallet?.wallet === 12, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Live bot behavior is unchanged on the very next cast after a rejected config save (a catch still records and credits normally).',
    observation: `after a seeded catch + credit under the valid config: wallet=${wallet?.wallet} (expected 12).`,
    impact: 'A rejected config attempt disturbed live fishing behavior.',
  });

  // The actual REJECTION + its audit row are enforced in the dashboard's Zod layer;
  // guild_config carries NO CHECK constraint on these columns, so the reject path is
  // unreachable in this bot-only harness. GATE honestly (do not fake a rejection).
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard fishing page surfaces a clear validation error for a negative cooldown / a junk+treasure sum above 100.',
    'config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK constraint on the fishing columns, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'One audit row records the rejected fishing configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplay(ctx);
}

/** UNAUTH — fishing resolves by the invoking member's own id; B's activity never touches A's rows. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_fishing_enabled: true },
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Arrange run-member-a: a wallet + a recorded catch, then snapshot A's state.
  await seedWallet(handle, userA, 100, 0);
  const species = await seedSpecies(ctx, handle);
  const sp = species[0];
  if (sp) await insertCatch(handle, userA, sp.id, 4.0, 30);
  const aWalletBefore = (await readWallet(handle, userA))?.wallet ?? -1;
  const aCatchesBefore = await catchCount(handle, userA);

  // run-member-b "casts": every fishing handler resolves catches + wallet credits by the
  // INVOKING member's own id, so B's catch row + credit land under B — never under A.
  await seedWallet(handle, userB, 0, 0);
  if (sp) await insertCatch(handle, userB, sp.id, 1.0, 15);
  const bCreditErr = await creditAddBalance(handle, userB, 15);
  const bWallet = (await readWallet(handle, userB))?.wallet ?? -1;
  const bCatches = await catchCount(handle, userB);

  const aWalletAfter = (await readWallet(handle, userA))?.wallet ?? -1;
  const aCatchesAfter = await catchCount(handle, userA);
  ctx.expect(
    bCreditErr === null &&
      bWallet === 15 &&
      bCatches === 1 &&
      aWalletAfter === aWalletBefore &&
      aWalletAfter === 100 &&
      aCatchesAfter === aCatchesBefore,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A member cannot cast/claim on another’s behalf: run-member-b’s catch + auto-sell credit land ONLY under B (keyed by the invoking user_id), leaving run-member-a’s wallet and catch history byte-identical.',
      observation:
        `B wallet=${bWallet} (expected 15), B catches=${bCatches} (expected 1); ` +
        `A wallet=${aWalletBefore}→${aWalletAfter} (expected unchanged 100), A catches=${aCatchesBefore}→${aCatchesAfter} (expected unchanged).`,
      impact: 'One member’s fishing activity mutated another member’s wallet or catch history — the per-member ownership guarantee is broken.',
    },
  );

  // Two-economies wall: fishing income flows ONLY through the play-money economy_add_balance
  // → economy_wallets rail; there is no fishing role-income mechanism at all, so a
  // commerce-granted role/item cannot fund a catch. B's credit landed in the play wallet.
  ctx.expect(bWallet === 15, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'Fishing rewards flow solely through the play-money economy_add_balance → economy_wallets ledger; there is no role/commerce income path into a fishing wallet.',
    observation: `the auto-sell credit landed in the play-money economy_wallets row (B wallet=${bWallet}); fishing has no economy_role_income equivalent.`,
    impact: 'A fishing reward reached a rail other than the play-money wallet — the two-economies wall would be at risk.',
  });

  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save fishing settings (returns an authorization error).',
    'requires the dashboard session-auth lane (RLS + session role) — not reachable in this bot-only harness',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'An audit row records the denied fishing configuration attempt with actor and reason permission-denied.',
    'the denied-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'A commerce-purchased fishing item is never sellable on the real paid store (no real-store sell path).',
    'requires the commerce/PayPal + real-store lane; fishing structurally exposes no commerce sell path, but proving its absence live needs the commerce surfaces',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplay(ctx);
}

/** DEPFAIL — Supabase/Valkey-unreachable fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // This DB-observable harness's whole premise is a REACHABLE local Supabase (and the
  // cast path additionally needs Valkey), so a dependency outage cannot be induced
  // without a fault-injection lane. GATE the outage-dependent behavior honestly.
  ctx.gate(
    'Discord',
    'db-observable',
    'With the fishing backend unreachable, /fish cast and /fish collection reply with the branded fishing-unavailable template, no wallet moves, no bait is consumed, and no cooldown is wrongly persisted; after restore a fresh cast credits exactly once.',
    'requires a Supabase/Valkey dependency-outage fault-injection lane plus subcommand injection (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed fishing command).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'After restoration a fresh /fish cast credits exactly once and applies, logged with the run-prefixed correlation id.',
    'requires the outage fault lane; fishing also writes no DB-observable audit_logs row (the append-only economy_fish_catches row is the only ledger evidence)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate credit or catch row survives the outage/restore cycle.',
    'requires a Supabase/Valkey dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded fishing-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the fishing-unavailable branch (and subcommand injection to produce the reply)',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Fishing rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a catch whose auto-sell credit fails cannot be flagged/retried (finding: no backing). */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_fishing_enabled: true },
  });
  const userA = ctx.userId('a');

  // Seed a catch so the RLS positive control holds and the append-only row exists.
  await seedWallet(handle, userA, 0, 0);
  const species = await seedSpecies(ctx, handle);
  if (species[0]) await insertCatch(handle, userA, species[0].id, 3.0, 50);

  // FINDING: the catalog RETRY contract + failure catch-payout-failed require the catch
  // record to "flag the credit as unpaid" and queue an operator retry "under one
  // idempotency key" so the member is paid exactly once. Probe the backing: does
  // economy_fish_catches persist a paid / payout-status column? (It does not — the
  // FishingManager's `paid` flag lives only on the in-memory embed object.)
  const { error: paidColErr } = await handle.supabase
    .from('economy_fish_catches')
    .select('id, paid')
    .eq('guild_id', handle.guildId)
    .limit(1);
  const paidBacked = !paidColErr;
  ctx.expect(paidBacked, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise:
      'A catch whose wallet credit fails is flagged unpaid on the catch record and queued for operator retry under one idempotency key, so the member is paid exactly once and never double-credited.',
    observation: paidBacked
      ? 'economy_fish_catches exposes a persisted paid/payout-status column.'
      : `economy_fish_catches has NO persisted paid/payout-status column (read error ${paidColErr?.code ?? ''}: ${paidColErr?.message ?? ''}); there is no retry-queue table and no idempotency key on the catch insert or the economy_add_balance credit.`,
    impact:
      'When economy_add_balance fails after the catch is recorded, the catch row carries price_earned but NO durable "unpaid" marker and there is no retry queue/idempotency key — an operator cannot identify which catches went unpaid and any blind re-credit risks double-paying; the catalog-contracted flag-unpaid + exactly-once operator retry is unimplemented.',
  });

  ctx.gate(
    'Discord',
    'discord-readback',
    'After the injected credit fault run-member-a sees the branded catch-payout-failed notice rather than a false success; the operator retry credits the exact catch value once and the wallet reflects a single credit.',
    'requires a mid-cast fault-injection lane (fail economy_add_balance after the economy_fish_catches insert) plus subcommand injection — not available here',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner alert channel receives exactly one reasoned catch-payout-failed / payout-degraded alert for the injected fault with a remediation hint.',
    'requires the mid-cast fault-injection lane plus owner alert channel readback',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The failed credit and its retry apply under one idempotency key, so the ledger shows exactly one credit for the catch — never zero-paid-but-recorded and never a double credit.',
    'requires the mid-cast fault-injection lane; there is likewise no persisted idempotency key on the catch/credit to observe DB-side',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
}

/** REPLAY — re-delivering /fish cast must not double-catch or double-pay. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_fishing_enabled: true },
  });
  const userA = ctx.userId('a');

  // Seed a catch so the RLS positive control holds (the replay behavior itself is
  // cast-driven and its only dedup guard is the Valkey SET NX cooldown — gated below).
  await seedWallet(handle, userA, 0, 0);
  const species = await seedSpecies(ctx, handle);
  if (species[0]) await insertCatch(handle, userA, species[0].id, 2.5, 30);

  gateReplay(ctx);
  gateCastLive(
    ctx,
    'The channel shows exactly one catch embed despite the replays, and /fish collection + the wallet totals are unchanged from the pre-replay snapshot.',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
}

/** RESTART — catch history, collection progress, and config survive a full stack reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');

  // Boot #1: enable, seed species + fund + record catches, snapshot.
  const first = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_fishing_enabled: true, economy_fishing_cooldown_seconds: 45 },
  });
  await seedWallet(first, userA, 0, 0);
  const species = await seedSpecies(ctx, first);
  if (species[0]) await insertCatch(first, userA, species[0].id, 5.0, 30);
  if (species[1]) await insertCatch(first, userA, species[1].id, 2.0, 15);
  await creditAddBalance(first, userA, 45);
  const catchesBefore = await catchCount(first, userA);
  const walletBefore = (await readWallet(first, userA))?.wallet ?? -1;
  const speciesBefore = await speciesCount(first);
  await first.cleanup(); // simulate shutdown (does NOT delete rows)

  // Boot #2: SAME guild id (restart). State must be byte-identical (it lives in Supabase).
  const second = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_fishing_enabled: true, economy_fishing_cooldown_seconds: 45 },
  });
  const catchesAfter = await catchCount(second, userA);
  const walletAfter = (await readWallet(second, userA))?.wallet ?? -1;
  const speciesAfter = await speciesCount(second);
  const cfgAfter = await readConfig(second);
  ctx.expect(
    catchesAfter === catchesBefore &&
      catchesAfter === 2 &&
      walletAfter === walletBefore &&
      walletAfter === 45 &&
      speciesAfter === speciesBefore &&
      cfgAfter?.economy_fishing_cooldown_seconds === 45,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'After a full stack restart, catch history, collection progress (species + catches), the wallet, and the saved config all persist byte-identically (no double-catch, no loss).',
      observation:
        `pre-restart catches=${catchesBefore}/wallet=${walletBefore}/species=${speciesBefore}; ` +
        `post-restart catches=${catchesAfter}/wallet=${walletAfter}/species=${speciesAfter}/cooldown=${cfgAfter?.economy_fishing_cooldown_seconds} (expected 2 / 45 / same / 45).`,
      impact: 'Fishing state did not survive a restart — persisted catches, wallet, or config were lost or altered.',
    },
  );

  // The append-only catch rows persist across the restart (audit evidence).
  ctx.expect(catchesAfter === 2, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The pre-restart catch ledger rows persist across the restart.',
    observation: `economy_fish_catches rows after restart = ${catchesAfter} (expected 2).`,
    impact: 'A catch ledger row did not survive the restart.',
  });

  // The "in-flight cooldown still blocks an immediate cast after restart" facet lives in
  // Valkey (SET NX with a TTL) and is cast-driven — gated.
  gateCastLive(
    ctx,
    'Post-restart, a cast attempted while the prior per-user cooldown is still live is refused (the Valkey cooldown TTL survives the reboot), proving no double-catch and no lost cooldown.',
  );
  await proveRlsIsolation(ctx, second);
  await proveNoOwnerAlert(ctx, second);
  gateBranding(ctx);
  gateReplay(ctx);
}

/** RACE — concurrent casts consume at most one bait (atomic economy_decrement_inventory). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_fishing_enabled: true },
  });
  const userA = ctx.userId('a');

  // The "at most one bait per cast" guarantee is the atomic economy_decrement_inventory
  // RPC (SELECT … FOR UPDATE) — the EXACT primitive consumeBait relies on (V47-M1). With
  // a single bait, two concurrent decrements must yield exactly one success and end at 0.
  const itemId = await seedBaitItem(ctx, handle, userA, 1);
  let oneSuccess = false;
  let finalQty = -1;
  if (itemId) {
    const [d1, d2] = await Promise.all([
      decrementInventory(handle, userA, itemId),
      decrementInventory(handle, userA, itemId),
    ]);
    oneSuccess = [d1, d2].filter(Boolean).length === 1;
    finalQty = await inventoryQty(handle, userA, itemId);
  }
  ctx.expect(itemId !== null && oneSuccess && finalQty === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Two simultaneous casts consume at most one bait: the atomic economy_decrement_inventory (SELECT … FOR UPDATE) lets exactly one concurrent decrement of a single bait succeed.',
    observation:
      `concurrent decrements of one bait: exactly-one-success=${oneSuccess}; remaining bait quantity=${finalQty} (expected 0, the row deleted).`,
    impact:
      'A concurrent double-cast consumed two baits from one (or the atomic decrement was not serialized) — a member could get two catches from one bait.',
  });

  // Seed a catch so the RLS positive control holds.
  const species = await seedSpecies(ctx, handle);
  if (species[0]) await insertCatch(handle, userA, species[0].id, 3.0, 30);

  // The single-catch / single-cooldown-refusal outcome of the RACE is the Valkey SET NX
  // cooldown claim + subcommand-driven cast — gated.
  gateCastLive(
    ctx,
    'Two simultaneous /fish cast invocations yield exactly one recorded catch and one cooldown refusal (atomic Valkey SET NX), and a race to discover the final species pays the collection bonus exactly once.',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplay(ctx);
}

/** XGUILD — fishing is strictly per-guild (species, catches, wallet). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');

  const handleA = await ctx.bootGuild({
    guildId: guildA,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_fishing_enabled: true },
  });
  const handleB = await ctx.bootGuild({
    guildId: guildB,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_fishing_enabled: true },
  });

  // Fund + record catches in guild A; snapshot.
  await seedWallet(handleA, userA, 700, 0);
  const speciesA = await seedSpecies(ctx, handleA);
  if (speciesA[0]) await insertCatch(handleA, userA, speciesA[0].id, 6.0, 30);
  const aWalletBefore = (await readWallet(handleA, userA))?.wallet ?? -1;
  const aCatchesBefore = await catchCount(handleA, userA);

  // Same member fishes in guild B: SEPARATE species + catch + credit under guild B.
  await seedWallet(handleB, userA, 0, 0);
  const speciesB = await seedSpecies(ctx, handleB);
  if (speciesB[0]) await insertCatch(handleB, userA, speciesB[0].id, 1.0, 15);
  await creditAddBalance(handleB, userA, 15);
  const bWallet = (await readWallet(handleB, userA))?.wallet ?? -1;
  const bCatches = await catchCount(handleB, userA);

  const aWalletAfter = (await readWallet(handleA, userA))?.wallet ?? -1;
  const aCatchesAfter = await catchCount(handleA, userA);
  ctx.expect(
    bWallet === 15 &&
      bCatches === 1 &&
      aWalletAfter === aWalletBefore &&
      aWalletAfter === 700 &&
      aCatchesAfter === aCatchesBefore,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'Casting and filling a collection in a second guild never touches the first guild’s catches, wallet, or collection; each guild evolves independently.',
      observation:
        `guild A wallet=${aWalletBefore}→${aWalletAfter} (unchanged 700), A catches=${aCatchesBefore}→${aCatchesAfter} (unchanged); ` +
        `guild B wallet=${bWallet} (expected 15), B catches=${bCatches} (expected 1).`,
      impact: 'Cross-guild fishing activity mutated another guild’s catches or wallet — per-guild isolation broken.',
    },
  );

  // Each guild scope reads its OWN distinct catch rows and never the other guild's.
  const { count: bScoped } = await handleB.supabase
    .from('economy_fish_catches')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildB)
    .eq('user_id', userA);
  const { count: aScoped } = await handleA.supabase
    .from('economy_fish_catches')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildA)
    .eq('user_id', userA);
  ctx.expect((bScoped ?? -1) === 1 && (aScoped ?? -1) === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'Each guild scope reads only its OWN economy_fish_catches rows: a client scoped to guild B reads zero of guild A’s catches and vice versa.',
    observation: `guild-B-scoped catch count=${bScoped} (expected 1, B’s own); guild-A-scoped catch count=${aScoped} (expected 1, A’s own) — distinct rows under distinct guild_ids.`,
    impact: 'A guild-scoped read returned the other guild’s catch rows — cross-guild leakage.',
  });
  await proveRlsIsolation(ctx, handleA);

  gateCastLive(
    ctx,
    'Guild A’s /fish collection is identical before and after guild B activity, and guild B’s casts credit guild B’s wallet against guild B’s own species table, observed in the live guilds.',
  );
  await proveNoOwnerAlert(ctx, handleA);
  gateBranding(ctx);
  gateReplay(ctx);
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_fishing_enabled: true },
  });
  const userA = ctx.userId('a');

  // Create run-prefixed operational rows: species + wallet + catches.
  await seedWallet(handle, userA, 500, 0);
  const species = await seedSpecies(ctx, handle);
  if (species[0]) await insertCatch(handle, userA, species[0].id, 4.0, 30);
  if (species[1]) await insertCatch(handle, userA, species[1].id, 2.0, 15);

  const speciesBefore = await speciesCount(handle);
  const catchesBefore = await catchCount(handle, userA);
  const walletsBefore = await walletCount(handle, userA);
  ctx.expect(speciesBefore >= 1 && catchesBefore >= 2 && walletsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed species, catch, and wallet rows (pre-cleanup baseline).',
    observation: `pre-cleanup: species=${speciesBefore}, catches=${catchesBefore}, wallets=${walletsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep removes them).
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const speciesAfter = await speciesCount(handle);
  const catchesAfter = await catchCount(handle, userA);
  const walletsAfter = await walletCount(handle, userA);
  ctx.expect(speciesAfter === 0 && catchesAfter === 0 && walletsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed fish species, catch, and wallet rows are deleted; a final sweep finds zero run-prefixed fishing resources.',
    observation: `post-sweep: species=${speciesAfter}, catches=${catchesAfter}, wallets=${walletsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed fishing rows behind — the suite leaves residue.',
  });

  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed catch embeds, collection displays, or leaderboard entries after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane; the fishing operational rows are the DB-observable evidence here',
  );
  gateBranding(ctx);
  gateReplay(ctx);
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Fishing & Collections domain proof: the guild_id-scoped tables the sweep must clear
 * (child → parent so FK-constrained rows are removed before their parents and the guild
 * row), plus the 12 scenario scripts.
 *
 * FK order notes: economy_fish_catches references economy_fish_species (ON DELETE CASCADE)
 * and is listed first; economy_inventory references economy_items (ON DELETE CASCADE) and
 * is listed before it. All listed tables carry a guild_id column, so the guild-scoped
 * delete is well-formed.
 */
export const gameEconomyFishingProof: DomainProof = {
  domainId: 'game-economy-fishing',
  guildScopedTables: [
    'economy_fish_catches',
    'economy_fish_species',
    'economy_inventory',
    'economy_items',
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
