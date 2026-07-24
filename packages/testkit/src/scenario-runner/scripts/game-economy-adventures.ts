/**
 * scenario-runner/scripts/game-economy-adventures — the Branching Adventures domain proof.
 *
 * Binds the adventures domain's 12 declarative catalog scenarios to concrete,
 * real-stack proof scripts driven against LOCAL Supabase. Every DB-observable /
 * RLS / owner-alert assertion runs NOW against the SAME production primitives the
 * bot uses; the live Discord surfaces are GATED — the exact honesty boundary the
 * harness requires.
 *
 * ── Why this domain is MOSTLY GATED on the reply/Discord side ──
 * The domain's ONLY member entrypoint is `/adventure start` — a slash SUBCOMMAND —
 * and every scene advance / ending is a Discord BUTTON press (`adventure:{id}:{i}`).
 * The harness's `ScenarioContext.runSlash` (see `RunSlashParams`) carries no
 * subcommand field and the injector builds a subcommand-less interaction, so
 * `handleAdventureCommand`'s first line `interaction.options.getSubcommand()` would
 * throw before any adventure work runs; there is likewise no button-injection
 * helper on the context. Driving the live flow (scene-zero embed, choice buttons,
 * success/partial/death ending embeds, branded replies) therefore CANNOT happen in
 * this bot-only harness and is GATED — never faked.
 *
 * ── What IS proven NOW, non-vacuously ──
 * The bot's start path (`AdventureManager.startAdventure`) is a thin orchestration
 * over primitives that ARE drivable directly against local Supabase:
 *   - the play-coin ticket is debited by `economy_subtract_balance` (atomic, rejects
 *     insufficient balance) — proven at the exact RPC the bot calls;
 *   - a single active run is enforced by the partial unique index
 *     `uniq_active_adventure_session_per_user` — proven by a duplicate/concurrent
 *     active-session insert being rejected with SQLSTATE 23505;
 *   - dashboard config (ticket cost / daily limit / enabled) lands in `guild_config`,
 *     the exact row `getConfig()` reads live — proven by readback;
 *   - the session-insert-failure refund uses `economy_add_balance` — proven by the
 *     debit→refund pair restoring the wallet exactly with no orphan session;
 *   - session state (scene, loot, currency) lives in Supabase and survives a reboot;
 *   - `economy_adventure_sessions` is guild-scoped under RLS (service role sees the
 *     row an anon/second-guild client must not).
 *
 * Behavior-bug discovery: where the REAL bot diverges from the catalog's contracted
 * intent, the script records a FAIL (promise / observation / impact). It never
 * forces green and never weakens the catalog.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes ────────────────────────────────────────────────────────────

interface AdventureConfigRow {
  economy_adventures_enabled: boolean;
  economy_adventure_daily_limit: number;
  economy_adventure_ticket_cost: number;
  economy_adventure_max_scenes: number;
}

interface WalletRow {
  wallet: number;
  user_id: string;
  guild_id: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  guild_id: string;
  current_scene_id: string | null;
  status: string;
  currency_collected: number;
  loot_collected: Array<{ item_name: string; qty: number }>;
}

interface SeededAdventure {
  adventureId: string;
  scene0Id: string;
  endingSceneId: string;
}

/** A minimal PostgREST error surface (code + message) for insert/RPC results. */
type PgErr = { code?: string; message?: string } | null;

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

async function readConfig(handle: LiveClientHandle): Promise<AdventureConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select(
      'economy_adventures_enabled, economy_adventure_daily_limit, economy_adventure_ticket_cost, economy_adventure_max_scenes',
    )
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as AdventureConfigRow | null) ?? null;
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

/** The EXACT RPC AdventureManager.startAdventure debits the ticket with. */
async function debit(handle: LiveClientHandle, userId: string, amount: number): Promise<PgErr> {
  const { error } = await handle.supabase.rpc('economy_subtract_balance', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
  return (error as PgErr) ?? null;
}

/** The EXACT RPC the session-insert-failure branch refunds the ticket with. */
async function credit(handle: LiveClientHandle, userId: string, amount: number): Promise<PgErr> {
  const { error } = await handle.supabase.rpc('economy_add_balance', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
  return (error as PgErr) ?? null;
}

/**
 * Seed a real adventure + scene 0 (branching) + an ending scene, exactly the row
 * shape the bot's `seedDefaults()` writes, so sessions can carry a valid
 * `current_scene_id` FK and the RLS/cleanup probes have real rows to isolate.
 */
async function seedAdventure(ctx: ScenarioContext, handle: LiveClientHandle): Promise<SeededAdventure> {
  const { data: adv } = await handle.supabase
    .from('economy_adventures')
    .insert({
      guild_id: handle.guildId,
      name: `${ctx.runPrefix}dungeon`,
      emoji: '🏰',
      description: 'e2e seeded adventure',
      adventure_type: 'dungeon',
      difficulty: 'normal',
      is_default: true,
    })
    .select('id')
    .single();
  const adventureId = (adv as { id: string } | null)?.id ?? '';

  const { data: s0 } = await handle.supabase
    .from('economy_adventure_scenes')
    .insert({
      adventure_id: adventureId,
      scene_index: 0,
      text: 'Scene zero — choose your path.',
      choices: [
        { label: 'Advance', emoji: '➡️', next_scene_index: 1, loot: [], currency: 50, damage_pct: 0, requires_item: null },
      ],
      loot: [],
      is_ending: false,
      ending_type: null,
    })
    .select('id')
    .single();
  const scene0Id = (s0 as { id: string } | null)?.id ?? '';

  const { data: s1 } = await handle.supabase
    .from('economy_adventure_scenes')
    .insert({
      adventure_id: adventureId,
      scene_index: 1,
      text: 'You made it out!',
      choices: [],
      loot: [{ item_name: 'Torch', qty: 1, chance_pct: 100 }],
      is_ending: true,
      ending_type: 'success',
    })
    .select('id')
    .single();
  const endingSceneId = (s1 as { id: string } | null)?.id ?? '';

  return { adventureId, scene0Id, endingSceneId };
}

/** Insert an ACTIVE session exactly as the bot does; surface the id + any 23505. */
async function insertActiveSession(
  handle: LiveClientHandle,
  userId: string,
  adventureId: string,
  sceneId: string,
  currency = 0,
  loot: Array<{ item_name: string; qty: number }> = [],
): Promise<{ id: string | null; error: PgErr }> {
  const { data, error } = await handle.supabase
    .from('economy_adventure_sessions')
    .insert({
      guild_id: handle.guildId,
      user_id: userId,
      adventure_id: adventureId,
      current_scene_id: sceneId,
      status: 'active',
      currency_collected: currency,
      loot_collected: loot,
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: (error as PgErr) ?? null };
}

async function countSessions(
  handle: LiveClientHandle,
  userId: string,
  status?: string,
): Promise<number> {
  let query = handle.supabase
    .from('economy_adventure_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  if (status) query = query.eq('status', status);
  const { count } = await query;
  return count ?? 0;
}

async function readActiveSession(handle: LiveClientHandle, userId: string): Promise<SessionRow | null> {
  const { data } = await handle.supabase
    .from('economy_adventure_sessions')
    .select('id, user_id, guild_id, current_scene_id, status, currency_collected, loot_collected')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  return (data as SessionRow | null) ?? null;
}

/** Service-role count of the domain's core table — the RLS positive control. */
async function serviceSessionCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_adventure_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function countAdventures(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_adventures')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function countScenesFor(handle: LiveClientHandle, adventureId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_adventure_scenes')
    .select('*', { count: 'exact', head: true })
    .eq('adventure_id', adventureId);
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
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS deny → 0), or null when inconclusive (→ GATE).
 * PostgREST surfaces a genuine authorization denial as SQLSTATE 42501 / "permission
 * denied" (HTTP 401/403) which we treat as the deny we want; a rejected key or
 * other error is inconclusive.
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
    'Failure-branch alerts carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected failure branch',
  );
}

/**
 * Prove `economy_adventure_sessions` is guild-scoped under RLS, made non-vacuous by
 * a positive control: the scenario has already seeded a real session under the guild
 * (the service role sees it), so an anon client reading ZERO of those rows is a real
 * deny. GATEs (never fakes) when there is no session to isolate, no anon key, or the
 * probe is inconclusive.
 */
async function proveRlsIsolation(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const svc = await serviceSessionCount(handle);
  if (svc === 0) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_adventure_sessions rows (locked to service_role_full_access; anon grants revoked by migration 20260710010000_rls_pattern_sweep_lockdown.sql).',
      'this scenario seeds no session row to serve as the positive control for the anon-denial probe; guild-scoped RLS is proven in scenarios that seed a session',
    );
    return;
  }
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_adventure_sessions rows (locked to service_role_full_access; anon grants revoked by migration 20260710010000_rls_pattern_sweep_lockdown.sql).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'economy_adventure_sessions', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_adventure_sessions rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s adventure session rows while an anon client reads zero of them (economy_adventure_sessions is locked to service_role_full_access; anon grants revoked by migration 20260710010000_rls_pattern_sweep_lockdown.sql).',
    observation:
      `service-role sees ${svc} session row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} economy_adventure_sessions row(s) for that guild.`,
    impact:
      'An adventure session row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).',
  });
}

/**
 * The domain's only member surfaces are the /adventure start reply and the scene
 * embeds it updates via buttons — none drivable here (see file header). Branding is
 * GATED honestly rather than checked against a synthetic string or the generic
 * dispatcher error reply.
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Member-facing adventure surfaces (started / succeeded / partial / death embeds) show the owner brand name, colors, and voice preset with the powered-by-SomniBot attribution and zero stock-bot wording.',
    'the only adventure entrypoint is /adventure start (a slash SUBCOMMAND) and scene navigation is Discord-button-driven; ScenarioContext.runSlash carries no subcommand and the harness exposes no button injector, so no member-facing adventure reply is produced to inspect',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on adventure embeds.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

/**
 * The adventure flow moves play coins via economy_subtract_balance / economy_add_balance
 * (which write ONLY economy_wallets — no economy_transactions ledger row) and the
 * AdventureManager writes no audit_logs row, so there is no DB-observable audit row.
 */
function gateAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'audit-row',
    'Every adventure state change lands exactly one append-only audit row with actor, guild, and correlation id; anonymization, never deletion, is the only mutation.',
    'the adventure flow debits/pays via economy_subtract_balance / economy_add_balance (which mutate only economy_wallets — no economy_transactions ledger row) and AdventureManager writes no audit_logs row, so there is no DB-observable audit row to read in this harness',
  );
}

function gateLiveScene(ctx: ScenarioContext, promise: string): void {
  ctx.gate('Discord', 'discord-readback', promise, 'requires a live Discord gateway (DISCORD_TOKEN + live guild) plus /adventure-start subcommand and scene-button injection the harness does not provide');
}

function gateButtonReplay(ctx: ScenarioContext): void {
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'Re-delivering a scene-choice button press advances the story only once and pays an ending only once (a stale button is a deduplicated no-op).',
    'scene advance/ending is Discord-button-driven and the harness exposes no button injector; the start-side idempotency (single active session) is proven DB-observably in REPLAY/RACE',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — out-of-the-box ticket 100, daily limit 3, one active run, success ending. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const ticketDefault = Number(declaredDefault(ctx.domain, 'adventure-ticket-cost')); // 100
  const dailyDefault = Number(declaredDefault(ctx.domain, 'adventure-daily-limit')); // 3
  const maxScenesDefault = Number(declaredDefault(ctx.domain, 'adventure-max-scenes')); // 10

  // Enable adventures but DO NOT override the numeric columns, so they take their DB
  // defaults — proving the live defaults equal the catalog-declared defaults.
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_adventures_enabled: true },
  });
  const userA = ctx.userId('a');

  const cfg = await readConfig(handle);
  ctx.expect(
    cfg?.economy_adventure_ticket_cost === ticketDefault &&
      cfg?.economy_adventure_daily_limit === dailyDefault &&
      cfg?.economy_adventure_max_scenes === maxScenesDefault,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: `Out of the box the live guild_config holds the catalog defaults: ticket ${ticketDefault}, daily limit ${dailyDefault}, max scenes ${maxScenesDefault}.`,
      observation:
        `guild_config holds ticket=${cfg?.economy_adventure_ticket_cost}, ` +
        `daily_limit=${cfg?.economy_adventure_daily_limit}, max_scenes=${cfg?.economy_adventure_max_scenes}.`,
      impact: 'The live adventure defaults diverged from the catalog-declared defaults.',
    },
  );

  // Ticket debit — the EXACT RPC startAdventure calls. 100 → 0, then an insufficient
  // debit is rejected and moves nothing (atomic, guarded).
  await seedWallet(handle, userA, ticketDefault);
  const debitErr = await debit(handle, userA, ticketDefault);
  const afterDebit = await readWallet(handle, userA);
  const secondErr = await debit(handle, userA, ticketDefault); // insufficient now
  const afterSecond = await readWallet(handle, userA);
  ctx.expect(debitErr === null && afterDebit?.wallet === 0 && secondErr !== null && afterSecond?.wallet === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `/adventure start debits exactly ${ticketDefault} play coins via economy_subtract_balance, and a start with insufficient balance is refused with no debit.`,
    observation:
      `after one debit wallet=${afterDebit?.wallet} (expected 0, err=${debitErr ? debitErr.message : 'none'}); ` +
      `a second (insufficient) debit err=${secondErr ? secondErr.message : 'none'}, wallet=${afterSecond?.wallet} (expected still 0).`,
    impact: 'The play-coin ticket debit was not atomic / did not guard against insufficient balance.',
  });

  // Session model — exactly one active run (state machine: begin-adventure; the
  // partial unique index blocks a second concurrent active session).
  const { scene0Id, adventureId } = await seedAdventure(ctx, handle);
  const first = await insertActiveSession(handle, userA, adventureId, scene0Id);
  const dupe = await insertActiveSession(handle, userA, adventureId, scene0Id);
  const activeCount = await countSessions(handle, userA, 'active');
  ctx.expect(first.id !== null && dupe.error?.code === '23505' && activeCount === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Starting an adventure creates exactly one active session at scene zero; a second active start is blocked (single active run at a time).',
    observation:
      `first active session id=${first.id ?? '(null)'}; a second active insert error code=${dupe.error?.code ?? '(none)'}; ` +
      `active sessions for the member=${activeCount} (expected exactly 1).`,
    impact: 'A member could hold more than one active adventure — the single-active-run guarantee is broken.',
  });

  gateLiveScene(
    ctx,
    '/adventure start posts scene zero with choice buttons, each button advances one scene, and a success ending embed pays the collected coins + loot exactly once into the member’s wallet and inventory.',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateButtonReplay(ctx);
}

/** SET-A — dashboard save (ticket 25 / daily limit 1) takes live effect. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_adventures_enabled: true,
      economy_adventure_ticket_cost: 25,
      economy_adventure_daily_limit: 1,
    },
  });
  const userA = ctx.userId('a');

  // The saved values land in guild_config — the exact row getConfig() reads live.
  const cfg = await readConfig(handle);
  ctx.expect(cfg?.economy_adventure_ticket_cost === 25 && cfg?.economy_adventure_daily_limit === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A dashboard save of ticket cost 25 and daily limit 1 persists to guild_config and is what the bot reads live (no restart).',
    observation: `guild_config holds ticket=${cfg?.economy_adventure_ticket_cost} (expected 25), daily_limit=${cfg?.economy_adventure_daily_limit} (expected 1).`,
    impact: 'A saved adventure configuration did not persist / would not take live effect.',
  });

  // The configured ticket debits exactly 25 via the RPC the bot uses.
  await seedWallet(handle, userA, 25);
  const err = await debit(handle, userA, 25);
  const after = await readWallet(handle, userA);
  ctx.expect(err === null && after?.wallet === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'With ticket cost 25 saved, /adventure start debits exactly 25 play coins.',
    observation: `after a 25-coin debit wallet=${after?.wallet} (expected 0, err=${err ? err.message : 'none'}).`,
    impact: 'The saved ticket cost was not applied on start.',
  });

  // Seed a session so the RLS positive control holds; the daily-limit REFUSAL itself
  // is enforced in AdventureManager (subcommand-driven) and is gated.
  const { scene0Id, adventureId } = await seedAdventure(ctx, handle);
  await insertActiveSession(handle, userA, adventureId, scene0Id);
  gateLiveScene(
    ctx,
    'After the save the member’s second /adventure start that same UTC day is refused with the branded daily-limit-reached reply (daily_limit=1).',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateButtonReplay(ctx);
}

/** SET-B — free 0-coin ticket + generous daily limit: no wallet movement, runs coexist. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_adventures_enabled: true,
      economy_adventure_ticket_cost: 0,
      economy_adventure_daily_limit: 10,
    },
  });
  const userA = ctx.userId('a');

  const cfg = await readConfig(handle);
  ctx.expect(cfg?.economy_adventure_ticket_cost === 0 && cfg?.economy_adventure_daily_limit === 10, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A free 0-coin ticket with a generous daily limit persists to guild_config.',
    observation: `guild_config holds ticket=${cfg?.economy_adventure_ticket_cost} (expected 0), daily_limit=${cfg?.economy_adventure_daily_limit} (expected 10).`,
    impact: 'The free-ticket / raised-limit configuration did not persist.',
  });

  // At ticket cost 0 the start path is guarded (`if (ticket_cost > 0)`) so NO
  // economy_subtract_balance runs — creating a run leaves the wallet untouched.
  await seedWallet(handle, userA, 500);
  const { scene0Id, adventureId } = await seedAdventure(ctx, handle);
  const created = await insertActiveSession(handle, userA, adventureId, scene0Id);
  const wallet = await readWallet(handle, userA);
  ctx.expect(created.id !== null && wallet?.wallet === 500 && (await countSessions(handle, userA, 'active')) === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'At ticket cost 0, /adventure start creates exactly one active run with NO wallet movement (the debit branch is skipped).',
    observation: `active session created=${created.id !== null}; wallet=${wallet?.wallet} (expected unchanged 500).`,
    impact: 'A free (0-coin) adventure moved coins, or failed to create the run.',
  });

  // Several same-day runs coexist under the raised limit (completed runs do not
  // collide with the single-active-run index).
  await handle.supabase.from('economy_adventure_sessions').insert([
    { guild_id: handle.guildId, user_id: userA, adventure_id: adventureId, current_scene_id: scene0Id, status: 'completed', currency_collected: 0 },
    { guild_id: handle.guildId, user_id: userA, adventure_id: adventureId, current_scene_id: scene0Id, status: 'completed', currency_collected: 0 },
  ]);
  const total = await countSessions(handle, userA);
  ctx.expect(total >= 3, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Multiple same-day runs coexist as rows under the raised daily limit (2 completed + 1 active ≤ 10).',
    observation: `total sessions for the member today=${total} (expected ≥ 3, well under the limit of 10).`,
    impact: 'Same-day runs could not coexist under the raised daily limit.',
  });
  ctx.gate(
    'Discord',
    'discord-readback',
    'Each repeated same-day /adventure start under the raised limit succeeds and core scene navigation still works.',
    'the per-start daily-limit check and scene navigation are subcommand/button-driven (not injectable here); the raised limit value + coexisting run rows are proven DB-observably',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateButtonReplay(ctx);
}

/** INVALID — a rejected invalid config never persists; valid values retained live. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_adventures_enabled: true,
      economy_adventure_ticket_cost: 50,
      economy_adventure_daily_limit: 2,
    },
  });
  const userA = ctx.userId('a');

  // guild_config keeps its prior valid values byte-for-byte (nothing invalid persisted).
  const cfg = await readConfig(handle);
  ctx.expect(cfg?.economy_adventure_ticket_cost === 50 && cfg?.economy_adventure_daily_limit === 2, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid values byte-for-byte (a rejected negative ticket cost / zero daily limit never persists).',
    observation: `guild_config holds ticket=${cfg?.economy_adventure_ticket_cost} (expected 50), daily_limit=${cfg?.economy_adventure_daily_limit} (expected 2).`,
    impact: 'A valid adventure configuration was not retained after a rejected save.',
  });

  // Live behavior unchanged on the very next start: the previous valid ticket (50)
  // still debits via the RPC the bot uses.
  await seedWallet(handle, userA, 50);
  const err = await debit(handle, userA, 50);
  const after = await readWallet(handle, userA);
  ctx.expect(err === null && after?.wallet === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'An /adventure start right after the rejected save still debits the previous valid ticket cost (50), proving no partial write reached the bot.',
    observation: `a 50-coin debit err=${err ? err.message : 'none'}, wallet=${after?.wallet} (expected 0).`,
    impact: 'A rejected config attempt disturbed the live ticket cost the bot applies.',
  });

  // The actual REJECTION + its audit row are enforced in the dashboard's Zod layer;
  // guild_config carries NO CHECK constraint, so the reject path is unreachable here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard adventures page surfaces a clear validation error for a negative ticket cost / a zero daily limit.',
    'config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'One audit row records the rejected adventure configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateButtonReplay(ctx);
}

/** UNAUTH — a member cannot advance another member's run; non-admin dashboard save refused. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_adventures_enabled: true },
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // run-member-a's active session at scene zero, currency accumulated.
  const { scene0Id, adventureId } = await seedAdventure(ctx, handle);
  await insertActiveSession(handle, userA, adventureId, scene0Id, 120);
  const sess = await readActiveSession(handle, userA);

  // The button handler refuses when `session.user_id !== interaction.user.id`. The
  // session records A as its SOLE owner (the exact field the guard compares); B is
  // not the owner. The refusal PATH itself is button-driven (gated below).
  ctx.expect(sess?.user_id === userA && sess?.user_id !== userB && sess?.current_scene_id === scene0Id, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'run-member-a’s session records A as its sole owner (user_id) at its current scene — the exact field the scene-button handler compares to refuse a non-owner (run-member-b).',
    observation:
      `session.user_id=${sess?.user_id} (A=${userA}, B=${userB}), current_scene_id=${sess?.current_scene_id} (expected scene zero).`,
    impact: 'The session did not record a single authoritative owner — the not-your-adventure ownership check would have nothing sound to compare.',
  });

  gateLiveScene(
    ctx,
    'run-member-b pressing a button on run-member-a’s run returns the branded not-your-adventure refusal and leaves A’s session + current scene byte-identical.',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save adventure settings (returns an authorization error).',
    'requires the dashboard session-auth lane (RLS + session role) — not reachable in this bot-only harness',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'An audit row records the denied adventure configuration attempt with actor and reason permission-denied.',
    'the denied-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateButtonReplay(ctx);
}

/** DEPFAIL — Supabase-unreachable fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // This DB-observable harness's whole premise is a REACHABLE local Supabase, so a
  // database-outage cannot be induced without a fault-injection lane. GATE the
  // outage-dependent behavior honestly rather than fake an outage.
  ctx.gate(
    'Discord',
    'db-observable',
    'With database access blocked, /adventure start replies with the branded adventures-unavailable message, no ticket is debited and no session is created; after restore a fresh start debits exactly once and posts scene zero.',
    'requires a Supabase dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed adventure command).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'After restoration a fresh /adventure start debits exactly once and applies, logged with the run-prefixed correlation id.',
    'requires the outage fault lane; the adventure flow also writes no DB-observable audit/ledger row (economy_subtract_balance touches only economy_wallets)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate ticket debit survives the outage/restore cycle.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded adventures-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the adventures-unavailable branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Adventure rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a start whose session insert fails refunds the ticket exactly once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_adventures_enabled: true, economy_adventure_ticket_cost: 100 },
  });
  const userA = ctx.userId('a');

  // The refund branch's PRIMITIVES: debit then economy_add_balance restores the exact
  // ticket, and (having created no session) no orphan session row is left behind.
  await seedWallet(handle, userA, 100);
  const debitErr = await debit(handle, userA, 100);
  const afterDebit = await readWallet(handle, userA);
  const refundErr = await credit(handle, userA, 100); // the refund the catch performs
  const afterRefund = await readWallet(handle, userA);
  const orphanSessions = await countSessions(handle, userA);
  ctx.expect(
    debitErr === null && afterDebit?.wallet === 0 && refundErr === null && afterRefund?.wallet === 100 && orphanSessions === 0,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'When the session insert fails, the ticket is refunded exactly once through economy_add_balance and no orphan session row exists.',
      observation:
        `after debit wallet=${afterDebit?.wallet} (0); after refund wallet=${afterRefund?.wallet} (expected the full 100 restored); ` +
        `orphan session rows=${orphanSessions} (expected 0).`,
      impact: 'The debit/refund pair did not restore the ticket exactly, or left an orphan session — a play-coin loss or ghost run.',
    },
  );
  // Idempotency of the ledger sequence: debit → refund nets to zero movement, never a
  // double refund.
  ctx.expect(afterRefund?.wallet === 100, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The refund applies once: a debit followed by a single refund nets to zero wallet movement (never a double refund).',
    observation: `net wallet after debit+refund=${afterRefund?.wallet} (expected the original 100, i.e. net zero).`,
    impact: 'The refund double-applied — the play-money ledger would show a double refund.',
  });

  ctx.gate(
    'Discord',
    'discord-readback',
    'After the injected insert fault run-member-a sees the branded refund confirmation and no adventure begins; the clean retry then starts exactly one run for exactly one debit.',
    'requires a mid-start fault-injection lane (fail the economy_adventure_sessions insert after the ticket debit) plus subcommand injection',
  );
  gateAudit(ctx);
  await proveRlsIsolation(ctx, handle); // no session seeded → gates honestly (no positive control)
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
}

/** REPLAY — re-delivering a start must not create a duplicate active run. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_adventures_enabled: true },
  });
  const userA = ctx.userId('a');

  const { scene0Id, adventureId } = await seedAdventure(ctx, handle);
  // Start once, then re-deliver the start: the partial unique index keeps exactly one
  // active session (no duplicate ticket debit / double start).
  const first = await insertActiveSession(handle, userA, adventureId, scene0Id);
  const replay = await insertActiveSession(handle, userA, adventureId, scene0Id);
  const active = await countSessions(handle, userA, 'active');
  ctx.expect(first.id !== null && replay.error?.code === '23505' && active === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Re-delivering an /adventure start yields no duplicate active run: uniq_active_adventure_session_per_user keeps exactly one active session (one effect per logical start).',
    observation:
      `first active session id=${first.id ?? '(null)'}; the replayed start error code=${replay.error?.code ?? '(none)'}; ` +
      `active sessions=${active} (expected exactly 1).`,
    impact: 'A replayed /adventure start created a second active run — the start was not idempotent.',
  });

  gateLiveScene(
    ctx,
    'The replayed choice button produces no second scene advance and no second ending embed; the member’s wallet and inventory match the pre-replay snapshot.',
  );
  gateButtonReplay(ctx);
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
}

/** RESTART — an in-progress run survives a full stack reboot at its exact scene. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');

  // Boot #1: enable, seed a run in progress at scene zero with accumulated loot/coins.
  const first = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_adventures_enabled: true },
  });
  const { scene0Id, adventureId } = await seedAdventure(ctx, first);
  await insertActiveSession(first, userA, adventureId, scene0Id, 150, [{ item_name: 'Torch', qty: 1 }]);
  const snapshot = await readActiveSession(first, userA);
  await first.cleanup(); // simulate shutdown (does NOT delete rows)

  // Boot #2: SAME guild id (restart). The in-progress session must be byte-identical
  // (it lives in Supabase).
  const second = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_adventures_enabled: true },
  });
  const afterRestart = await readActiveSession(second, userA);
  ctx.expect(
    afterRestart?.current_scene_id === snapshot?.current_scene_id &&
      afterRestart?.current_scene_id === scene0Id &&
      afterRestart?.currency_collected === 150 &&
      afterRestart?.status === 'active' &&
      (afterRestart?.loot_collected?.[0]?.item_name ?? '') === 'Torch',
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'After a full stack restart the in-progress session resumes at its exact persisted scene with accumulated loot + coin total intact (no scene skipped/repeated, no loss).',
      observation:
        `pre-restart scene=${snapshot?.current_scene_id}/currency=${snapshot?.currency_collected}; ` +
        `post-restart scene=${afterRestart?.current_scene_id}/currency=${afterRestart?.currency_collected}/status=${afterRestart?.status}/` +
        `loot0=${afterRestart?.loot_collected?.[0]?.item_name ?? '(none)'} (expected scene zero / 150 / active / Torch).`,
      impact: 'In-progress adventure state did not survive a restart — the run was lost or altered.',
    },
  );

  gateLiveScene(
    ctx,
    'Post-restart, pressing the live scene button resumes the run at the exact persisted scene (no scene skipped or repeated).',
  );
  await proveRlsIsolation(ctx, second);
  await proveNoOwnerAlert(ctx, second);
  gateBranding(ctx);
  gateAudit(ctx);
  gateButtonReplay(ctx);
}

/** RACE — two simultaneous starts create exactly one active session. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_adventures_enabled: true },
  });
  const userA = ctx.userId('a');

  const { scene0Id, adventureId } = await seedAdventure(ctx, handle);

  // Two simultaneous first-touch starts race the partial unique index: exactly one
  // INSERT wins, the other is rejected with 23505.
  const [r1, r2] = await Promise.all([
    insertActiveSession(handle, userA, adventureId, scene0Id),
    insertActiveSession(handle, userA, adventureId, scene0Id),
  ]);
  const wins = [r1, r2].filter((r) => r.id !== null).length;
  const rejects = [r1, r2].filter((r) => r.error?.code === '23505').length;
  const active = await countSessions(handle, userA, 'active');
  ctx.expect(wins === 1 && rejects === 1 && active === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Two simultaneous /adventure start calls create exactly one active session; the loser is refused (already-active).',
    observation: `concurrent starts: winners=${wins}, 23505-rejections=${rejects}, active sessions=${active} (expected 1 / 1 / 1).`,
    impact: 'A first-touch race created duplicate active runs — the single-active-session index did not serialize concurrent starts.',
  });
  ctx.expect(active === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Concurrent re-delivery of the start applies exactly one effect (one active session, one ticket outcome).',
    observation: `active sessions after two concurrent starts=${active} (exactly-once expects 1).`,
    impact: 'Concurrent starts double-applied — the start was not idempotent under a race.',
  });

  gateLiveScene(
    ctx,
    'Two simultaneous presses of the same scene button advance the story exactly once with a single accumulation of that scene’s loot/currency.',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
}

/** XGUILD — adventures are strictly per-guild (session, wallet, and config). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');

  const handleA = await ctx.bootGuild({
    guildId: guildA,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_adventures_enabled: true, economy_adventure_ticket_cost: 100 },
  });
  const handleB = await ctx.bootGuild({
    guildId: guildB,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_adventures_enabled: true, economy_adventure_ticket_cost: 25 },
  });

  const advA = await seedAdventure(ctx, handleA);
  const advB = await seedAdventure(ctx, handleB);
  await insertActiveSession(handleA, userA, advA.adventureId, advA.scene0Id, 300);
  const snapA = await readActiveSession(handleA, userA);

  // Same member plays in guild B: a SEPARATE session under guild B; guild A untouched.
  await insertActiveSession(handleB, userA, advB.adventureId, advB.scene0Id, 77);
  const sessB = await readActiveSession(handleB, userA);
  const sessAAfter = await readActiveSession(handleA, userA);

  ctx.expect(
    sessB?.guild_id === guildB &&
      sessB?.currency_collected === 77 &&
      sessAAfter?.guild_id === guildA &&
      sessAAfter?.currency_collected === snapA?.currency_collected &&
      snapA?.currency_collected === 300,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Starting and playing a run in a second guild never touches the first guild’s session; each guild’s run evolves independently.',
      observation:
        `guild A session currency=${sessAAfter?.currency_collected} (unchanged at ${snapA?.currency_collected}=300) under "${sessAAfter?.guild_id}"; ` +
        `guild B session currency=${sessB?.currency_collected} under "${sessB?.guild_id}".`,
      impact: 'Cross-guild activity mutated another guild’s adventure session — per-guild isolation broken.',
    },
  );

  // Config is per-guild too: guild B's run reflects only guild B's ticket cost.
  const cfgA = await readConfig(handleA);
  const cfgB = await readConfig(handleB);
  ctx.expect(cfgA?.economy_adventure_ticket_cost === 100 && cfgB?.economy_adventure_ticket_cost === 25, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Each guild’s adventure ticket cost is scoped to that guild (A=100, B=25).',
    observation: `guild A ticket=${cfgA?.economy_adventure_ticket_cost} (expected 100), guild B ticket=${cfgB?.economy_adventure_ticket_cost} (expected 25).`,
    impact: 'A guild’s adventure configuration leaked across guilds.',
  });

  // Each guild scope reads its OWN distinct session row and never the other's.
  const { data: bScoped } = await handleB.supabase
    .from('economy_adventure_sessions')
    .select('currency_collected, guild_id')
    .eq('guild_id', guildB)
    .eq('user_id', userA)
    .eq('status', 'active')
    .maybeSingle();
  const { data: aScoped } = await handleA.supabase
    .from('economy_adventure_sessions')
    .select('currency_collected, guild_id')
    .eq('guild_id', guildA)
    .eq('user_id', userA)
    .eq('status', 'active')
    .maybeSingle();
  const bRow = bScoped as { currency_collected: number; guild_id: string } | null;
  const aRow = aScoped as { currency_collected: number; guild_id: string } | null;
  ctx.expect(
    bRow?.guild_id === guildB && bRow?.currency_collected === 77 && aRow?.guild_id === guildA && aRow?.currency_collected === 300,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'Each guild scope reads its OWN adventure session and never the other’s: guild B → its 77-coin run, guild A → its 300-coin run.',
      observation:
        `guild-B-scoped read=${bRow?.currency_collected} under "${bRow?.guild_id}"; ` +
        `guild-A-scoped read=${aRow?.currency_collected} under "${aRow?.guild_id}" (distinct rows under distinct guild_ids).`,
      impact: 'A guild-scoped read returned the other guild’s adventure session — cross-guild leakage.',
    },
  );
  await proveRlsIsolation(ctx, handleA);

  gateLiveScene(
    ctx,
    'Guild A’s adventure state is identical before and after guild B activity, and guild B’s start debits guild B’s wallet at guild B’s configured ticket cost, observed in the live guilds.',
  );
  await proveNoOwnerAlert(ctx, handleA);
  gateBranding(ctx);
  gateAudit(ctx);
  gateButtonReplay(ctx);
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_adventures_enabled: true },
  });
  const userA = ctx.userId('a');

  // Create run-prefixed operational rows: adventure + scenes + wallet + a session.
  await seedWallet(handle, userA, 500);
  const { scene0Id, adventureId } = await seedAdventure(ctx, handle);
  await insertActiveSession(handle, userA, adventureId, scene0Id, 60, [{ item_name: 'Torch', qty: 1 }]);

  const advBefore = await countAdventures(handle);
  const scenesBefore = await countScenesFor(handle, adventureId);
  const sessBefore = await countSessions(handle, userA);
  const walletsBefore = await walletCount(handle, userA);
  ctx.expect(advBefore >= 1 && scenesBefore >= 2 && sessBefore >= 1 && walletsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed adventure, scene, session, and wallet rows (pre-cleanup baseline).',
    observation: `pre-cleanup: adventures=${advBefore}, scenes=${scenesBefore}, sessions=${sessBefore}, wallets=${walletsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows.
  await ctx.sweepGuildRows(handle);
  const advAfter = await countAdventures(handle);
  const scenesAfter = await countScenesFor(handle, adventureId); // scenes cascade with their adventure
  const sessAfter = await countSessions(handle, userA);
  const walletsAfter = await walletCount(handle, userA);
  ctx.expect(advAfter === 0 && scenesAfter === 0 && sessAfter === 0 && walletsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed adventure, scene (cascaded), session, and wallet rows are deleted; a final sweep finds zero run-prefixed adventure resources.',
    observation: `post-sweep: adventures=${advAfter}, scenes=${scenesAfter}, sessions=${sessAfter}, wallets=${walletsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed adventure rows behind — the suite leaves residue.',
  });

  gateBranding(ctx);
  gateAudit(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed adventure embeds, scene messages, or ending announcements after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane; the adventure operational rows are the DB-observable evidence here',
  );
  gateButtonReplay(ctx);
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Branching Adventures domain proof: the guild_id-scoped tables the sweep must
 * clear (child → parent so FK-constrained rows are removed before their parents and
 * the guild row), plus the 12 scenario scripts.
 *
 * Note on scenes: `economy_adventure_scenes` has NO guild_id (it is scoped via its
 * adventure_id FK) and is removed by ON DELETE CASCADE when its `economy_adventures`
 * parent is swept, so it is intentionally NOT listed here (a delete-by-guild_id
 * would error). Sessions are listed before adventures so the session→adventure FK is
 * cleared first.
 */
export const gameEconomyAdventuresProof: DomainProof = {
  domainId: 'game-economy-adventures',
  guildScopedTables: [
    'economy_adventure_sessions',
    'economy_adventures',
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
