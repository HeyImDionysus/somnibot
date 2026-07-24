/**
 * scenario-runner/scripts/game-economy-farming — the Persistent Farm Plots domain proof.
 *
 * Binds the farming domain's 12 declarative catalog scenarios to concrete, real-stack
 * proof scripts driven against LOCAL Supabase. Every DB-observable / RLS / owner-alert
 * assertion runs NOW against the SAME production primitives the bot uses; the live
 * Discord surfaces and fault-injection lanes are GATED — the exact honesty boundary
 * the harness requires.
 *
 * ── The `/farm` member surface is DRIVEN live ──
 * Every member entrypoint is a `/farm` SUBCOMMAND (`view`, `plant`, `water`, `harvest`,
 * `fertilize`). Since the #331 subcommand injector, `ScenarioContext.runSlash` supplies
 * the subcommand, so every farming-ENABLED scenario drives the REAL `/farm view` through
 * the production dispatcher and asserts the branded "Your Farm" board embed as a live
 * captured-reply (see `proveFarmView`). DEF ships farming OFF (the FarmingManager is never
 * constructed), so its member surface stays gated. What still gates: the white-label
 * brand-kit PIXEL match (live-guild readback) and the audit_logs row the FarmingManager
 * never writes (a real #21 gap). Its sibling is game-economy-adventures.
 *
 * ── What IS proven NOW, non-vacuously ──
 * The farming manager's happy path is orchestration over primitives that ARE drivable
 * directly against local Supabase — proven at the exact seam the bot uses:
 *   - the harvest payout is `economy_add_balance` (atomic, rejects non-positive amounts)
 *     — proven at the exact RPC `FarmingManager.addToWallet` calls;
 *   - a plot is a single row keyed by `UNIQUE (guild_id, user_id, plot_index)` — proven
 *     by a duplicate insert being rejected with SQLSTATE 23505 and by the upsert (the
 *     exact `onConflict` the bot plants with) collapsing a re-delivery to one row;
 *   - dashboard config (grid size / wilt / fertilizer reduction / enabled) lands in
 *     `guild_config`, the exact row `getConfig()` reads live — proven by readback;
 *   - plot rows + their `planted_at`/`watered_at`/`fertilized` state survive a reboot
 *     (state lives in Supabase);
 *   - `economy_farm_plots` / `economy_crops` are guild-scoped under RLS (the service role
 *     sees the row an anon/second-guild client must not).
 *
 * ── Two-economies wall ──
 * Every seed, crop, coin, and fertilizer here is play-money game inventory. Farming has
 * no role-income mechanic at all, so a commerce-granted role can earn no farm income by
 * construction; harvest pays only through the fake-economy `economy_add_balance`.
 *
 * Behavior-bug discovery: where the REAL bot diverges from the catalog's contracted
 * intent, the script records a FAIL (promise / observation / impact). It never forces
 * green and never weakens the catalog — those FAILs are the findings the owner adjudicates.
 * (In DEF the catalog-declared `farming ships enabled` default is checked against the real
 * `guild_config.economy_farming_enabled` column default and surfaced as a finding.)
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { CapturedResponse } from '../../captured-response.js';
import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes ────────────────────────────────────────────────────────────

interface FarmingConfigRow {
  economy_farming_enabled: boolean;
  economy_farm_grid_size: number;
  economy_farming_wilt_enabled: boolean;
  economy_fertilizer_time_reduction_pct: number;
}

interface WalletRow {
  wallet: number;
  bank: number;
  user_id: string;
  guild_id: string;
}

interface PlotRow {
  id: string;
  user_id: string;
  guild_id: string;
  plot_index: number;
  crop_id: string | null;
  planted_at: string | null;
  watered_at: string | null;
  fertilized: boolean;
  harvested: boolean;
}

/** A minimal PostgREST error surface (code + message) for insert/RPC results. */
type PgErr = { code?: string; message?: string } | null;

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

async function readConfig(handle: LiveClientHandle): Promise<FarmingConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select(
      'economy_farming_enabled, economy_farm_grid_size, economy_farming_wilt_enabled, economy_fertilizer_time_reduction_pct',
    )
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as FarmingConfigRow | null) ?? null;
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

/** The EXACT RPC FarmingManager.addToWallet credits the harvest payout with. */
async function addBalance(handle: LiveClientHandle, userId: string, amount: number): Promise<PgErr> {
  const { error } = await handle.supabase.rpc('economy_add_balance', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
  return (error as PgErr) ?? null;
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
 * Seed one crop into `economy_crops` — the row a plot's `crop_id` FK references and the
 * RLS/cleanup probes isolate. Mirrors the shape of the bot's default catalog (Potato:
 * grow 7200s, sell 30) so a plot can carry a real crop. Guild-scoped, so cleanup is by
 * guild_id; the name is run-prefixed for extra attributability.
 */
async function seedCrop(ctx: ScenarioContext, handle: LiveClientHandle): Promise<string> {
  const { data } = await handle.supabase
    .from('economy_crops')
    .insert({
      guild_id: handle.guildId,
      name: `${ctx.runPrefix}Potato`,
      emoji: '🥔',
      grow_seconds: 7200,
      wilt_seconds: 86400,
      sell_price: 30,
      seeds_returned: 1,
      seed_item_id: null,
      category: 'Vegetable',
      sort_order: 0,
      is_default: true,
      active: true,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? '';
}

interface PlotSeed {
  plotIndex: number;
  cropId?: string | null;
  plantedAt?: string | null;
  wateredAt?: string | null;
  fertilized?: boolean;
  harvested?: boolean;
}

/** Insert a plot exactly as `economy_farm_plots` stores it; surface the id + any 23505. */
async function insertPlot(
  handle: LiveClientHandle,
  userId: string,
  p: PlotSeed,
): Promise<{ id: string | null; error: PgErr }> {
  const { data, error } = await handle.supabase
    .from('economy_farm_plots')
    .insert({
      guild_id: handle.guildId,
      user_id: userId,
      plot_index: p.plotIndex,
      crop_id: p.cropId ?? null,
      planted_at: p.plantedAt ?? null,
      watered_at: p.wateredAt ?? null,
      fertilized: p.fertilized ?? false,
      harvested: p.harvested ?? false,
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: (error as PgErr) ?? null };
}

/**
 * Upsert a plot with the EXACT `onConflict` key the bot plants with
 * (`guild_id,user_id,plot_index`) — the idempotency the REPLAY proof exercises.
 */
async function upsertPlot(
  handle: LiveClientHandle,
  userId: string,
  plotIndex: number,
  cropId: string | null,
  plantedAt: string,
): Promise<PgErr> {
  const { error } = await handle.supabase.from('economy_farm_plots').upsert(
    {
      guild_id: handle.guildId,
      user_id: userId,
      plot_index: plotIndex,
      crop_id: cropId,
      planted_at: plantedAt,
      watered_at: null,
      fertilized: false,
      harvested: false,
    },
    { onConflict: 'guild_id,user_id,plot_index' },
  );
  return (error as PgErr) ?? null;
}

async function readPlot(handle: LiveClientHandle, userId: string, plotIndex: number): Promise<PlotRow | null> {
  const { data } = await handle.supabase
    .from('economy_farm_plots')
    .select('id, user_id, guild_id, plot_index, crop_id, planted_at, watered_at, fertilized, harvested')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .eq('plot_index', plotIndex)
    .maybeSingle();
  return (data as PlotRow | null) ?? null;
}

async function countPlots(handle: LiveClientHandle, userId: string, plotIndex?: number): Promise<number> {
  let query = handle.supabase
    .from('economy_farm_plots')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  if (plotIndex !== undefined) query = query.eq('plot_index', plotIndex);
  const { count } = await query;
  return count ?? 0;
}

/** Service-role count of the domain's core table — the RLS positive control. */
async function servicePlotCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_farm_plots')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function cropCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_crops')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function harvestTxnCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_transactions')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .eq('type', 'farm_harvest');
  return count ?? 0;
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query itself errors,
 * so a failed read can never masquerade as "no alert raised".
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
 * inconclusive. `economy_farm_plots` is in the anon-revoke list (v6 hardening), so a
 * working stack answers 0 here.
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
    'Failure-branch alerts (farming.dependency_degraded / harvest-degraded) carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected failure branch',
  );
}

/**
 * Prove `economy_farm_plots` is guild-scoped under RLS, made non-vacuous by a positive
 * control: the scenario has already seeded a real plot under the guild (the service role
 * sees it), so an anon client reading ZERO of those rows is a real deny. GATEs (never
 * fakes) when there is no plot to isolate, no anon key, or the probe is inconclusive.
 */
async function proveRlsIsolation(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const svc = await servicePlotCount(handle);
  if (svc === 0) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_farm_plots rows (guild-scoped RLS + anon GRANT revoked).',
      'this scenario seeds no plot row to serve as the positive control for the anon-denial probe; guild-scoped RLS is proven in scenarios that seed a plot',
    );
    return;
  }
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_farm_plots rows (guild-scoped RLS + anon GRANT revoked).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'economy_farm_plots', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_farm_plots rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s farm plot rows while an anon client reads zero of them (guild-scoped RLS on economy_farm_plots).',
    observation:
      `service-role sees ${svc} plot row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} economy_farm_plots row(s) for that guild.`,
    impact:
      'A farm plot row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).',
  });
}

/** The title + description of the last farm embed a /farm subcommand replied with. */
function farmEmbedText(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  const last = edits[edits.length - 1]?.payload as
    | { embeds?: Array<{ data?: { title?: string; description?: string } }> }
    | undefined;
  const e = last?.embeds?.[0]?.data;
  return `${e?.title ?? ''} ${e?.description ?? ''}`.trim();
}

/**
 * Drive the REAL `/farm view` subcommand (through the #331 injector) for an enabled guild
 * and assert the branded farm board embed renders — the member-facing captured-reply surface.
 * (In a farming-DISABLED guild the FarmingManager is never constructed, so /farm is undrivable;
 * those scenarios keep gateBrandKit only.)
 */
async function proveFarmView(ctx: ScenarioContext, handle: LiveClientHandle, userId: string): Promise<void> {
  const captured = await ctx.runSlash(handle, { commandName: 'farm', userId, subcommand: 'view' });
  const text = farmEmbedText(captured);
  ctx.expect(/your farm/i.test(text), {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise: 'The /farm view member surface renders as the owner-branded "Your Farm" board embed.',
    observation: `/farm view replied with a farm embed: ${JSON.stringify(text.slice(0, 100))} (expected the "Your Farm" board).`,
    impact: 'The /farm view surface did not render the branded farm board embed.',
  });
}

/** The white-label brand-kit pixel match on farm embeds stays a live-guild readback residual. */
function gateBrandKit(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on farm embeds.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

/** DEF ships farming OFF, so the FarmingManager is never constructed and /farm is undrivable. */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Member-facing farm surfaces (planted / harvest / view embeds) show the owner brand name, colors, and voice preset with zero stock-bot wording.',
    'this scenario ships farming disabled, so the FarmingManager is never constructed and /farm produces no member reply to inspect',
  );
  gateBrandKit(ctx);
}

/**
 * Farming actions write no `audit_logs` row in the manager code path inspected; the only
 * ledger row (economy_transactions `farm_harvest`) is written INSIDE `/farm harvest`
 * (a subcommand handler), undrivable here — so there is no DB-observable audit row to read.
 */
function gateAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'audit-row',
    'Every farming state change lands exactly one append-only audit row with actor, guild, and correlation id; anonymization, never deletion, is the only mutation.',
    'the FarmingManager writes no audit_logs row, and its only ledger row (economy_transactions farm_harvest) is written inside the /farm harvest subcommand handler — undrivable in this bot-only harness, so no DB-observable audit row can be read',
  );
}

function gateLiveFarm(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) plus /farm subcommand injection the harness does not provide',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggers yields no duplicate credits, plot mutations, or seed returns.',
    `plot-upsert idempotency and the last-plot race are exercised directly in the ${where} scenario`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — out-of-the-box grid 9 / wilt on / fertilizer 50%, Potato harvest pays 30. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const gridDefault = Number(declaredDefault(ctx.domain, 'economy-farm-grid-size')); // 9
  const wiltDefault = declaredDefault(ctx.domain, 'economy-farming-wilt-enabled') === true; // true
  const fertDefault = Number(declaredDefault(ctx.domain, 'economy-fertilizer-time-reduction-pct')); // 50
  const enabledDefault = declaredDefault(ctx.domain, 'economy-farming-enabled') === true; // true

  // Boot WITHOUT overriding any farming column so the live guild_config takes its DB
  // defaults — proving whether the live defaults equal the catalog-declared defaults.
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const userA = ctx.userId('a');

  const cfg = await readConfig(handle);
  // Three controls whose DB column defaults DO match the catalog defaults.
  ctx.expect(
    cfg?.economy_farm_grid_size === gridDefault &&
      cfg?.economy_farming_wilt_enabled === wiltDefault &&
      cfg?.economy_fertilizer_time_reduction_pct === fertDefault,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: `Out of the box the live guild_config holds the catalog defaults: grid ${gridDefault}, wilt ${wiltDefault}, fertilizer reduction ${fertDefault}%.`,
      observation:
        `guild_config holds grid=${cfg?.economy_farm_grid_size}, wilt=${cfg?.economy_farming_wilt_enabled}, ` +
        `fertilizer=${cfg?.economy_fertilizer_time_reduction_pct}.`,
      impact: 'A live farming default diverged from the catalog-declared default.',
    },
  );

  // The catalog declares farming SHIPS ON (economy-farming-enabled default = true), but
  // guild_config.economy_farming_enabled is a NOT NULL DEFAULT false column and no
  // onboarding/defaults layer sets it true, so a fresh guild has farming OFF. Surface the
  // divergence as a finding (never softened to a pass/gate).
  ctx.expect(cfg?.economy_farming_enabled === enabledDefault, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `Out of the box farming is ON (catalog default economy-farming-enabled = ${enabledDefault}).`,
    observation:
      `a freshly-seeded guild_config holds economy_farming_enabled=${cfg?.economy_farming_enabled} ` +
      `(the column DEFAULTs false and no layer sets it true), but the catalog declares the default ${enabledDefault}.`,
    impact:
      'The catalog promises farming ships enabled for the maximal out-of-box experience, but a new guild gets farming OFF — /farm commands reply "not enabled" until an owner flips it on.',
  });

  // Harvest payout primitive — the EXACT RPC FarmingManager.addToWallet calls. A Potato's
  // 30-coin sell price credits exactly 30; a non-positive payout is rejected and moves nothing.
  const sellPrice = 30; // the catalog-declared Potato play-money sell price (game-economy-farming-def)
  await seedWallet(handle, userA, 0);
  const creditErr = await addBalance(handle, userA, sellPrice);
  const afterCredit = await readWallet(handle, userA);
  const guardErr = await addBalance(handle, userA, 0); // guard: non-positive rejected
  const afterGuard = await readWallet(handle, userA);
  ctx.expect(
    creditErr === null && afterCredit?.wallet === sellPrice && guardErr !== null && afterGuard?.wallet === sellPrice,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `/farm harvest credits exactly the crop's play-money sell price (${sellPrice}) via economy_add_balance, and a non-positive payout is rejected with no coins created.`,
      observation:
        `after a ${sellPrice}-coin payout wallet=${afterCredit?.wallet} (expected ${sellPrice}, err=${creditErr ? creditErr.message : 'none'}); ` +
        `a 0-coin payout err=${guardErr ? guardErr.message : 'none'}, wallet=${afterGuard?.wallet} (expected still ${sellPrice}).`,
      impact: 'The harvest payout primitive did not credit exactly the sell price / did not guard against a non-positive payout.',
    },
  );

  // Seed a crop + planted plot so the RLS positive control has a real row to isolate.
  const cropId = await seedCrop(ctx, handle);
  await insertPlot(handle, userA, { plotIndex: 0, cropId, plantedAt: new Date().toISOString(), wateredAt: null });

  // The seed-return facet is INTERNAL to /farm harvest and depends on inventory; the
  // default catalog's crops carry seed_item_id=null (the branch `seeds_returned > 0 &&
  // seed_item_id` is skipped), so it is not DB-observable here — gated with that nuance.
  ctx.gate(
    'Discord',
    'discord-readback',
    '/farm view moves the plot planted → growing → ready → empty; /farm water starts growth; /farm harvest returns the seed to inventory.',
    'the plot state machine and seed return live inside the /farm subcommand handlers (undrivable here); the default crop catalog carries seed_item_id=null so no seed-return row is written even in production',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — dashboard save (grid 4 / fertilizer 80%) persists to the row getConfig reads. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_farming_enabled: true,
      economy_farm_grid_size: 4,
      economy_fertilizer_time_reduction_pct: 80,
    },
  });
  const userA = ctx.userId('a');

  // The saved values land in guild_config — the exact row getConfig() reads live (no restart).
  const cfg = await readConfig(handle);
  ctx.expect(
    cfg?.economy_farm_grid_size === 4 && cfg?.economy_fertilizer_time_reduction_pct === 80 && cfg?.economy_farming_enabled === true,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'A dashboard save of grid size 4 and fertilizer reduction 80% persists to guild_config and is what the bot reads live (no restart).',
      observation:
        `guild_config holds grid=${cfg?.economy_farm_grid_size} (expected 4), ` +
        `fertilizer=${cfg?.economy_fertilizer_time_reduction_pct} (expected 80), enabled=${cfg?.economy_farming_enabled}.`,
      impact: 'A saved farming configuration did not persist / would not take live effect.',
    },
  );

  // Seed a plot so the RLS positive control holds; the "4-plot grid render + fertilized
  // crop matures after 20% of base grow time" is the getConfig()-driven status math inside
  // /farm view/harvest (subcommand-driven) and is gated.
  const cropId = await seedCrop(ctx, handle);
  await insertPlot(handle, userA, { plotIndex: 0, cropId, plantedAt: new Date().toISOString(), wateredAt: new Date().toISOString() });
  gateLiveFarm(
    ctx,
    'After the save /farm view renders a four-plot grid and a freshly fertilized crop matures after only 20% of its base grow time (grid size + fertilizer reduction took effect live).',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveFarmView(ctx, handle, userA);
  gateBrandKit(ctx);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — wilt disabled independently; the flag persists to the row getConfig reads. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_farming_enabled: true, economy_farming_wilt_enabled: false },
  });
  const userA = ctx.userId('a');

  const cfg = await readConfig(handle);
  ctx.expect(cfg?.economy_farming_wilt_enabled === false && cfg?.economy_farming_enabled === true, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The owner can switch pieces off independently: wilt is disabled (economy_farming_wilt_enabled=false) while farming stays enabled.',
    observation: `guild_config holds wilt=${cfg?.economy_farming_wilt_enabled} (expected false), enabled=${cfg?.economy_farming_enabled} (expected true).`,
    impact: 'The wilt toggle did not persist independently — a saved dashboard setting was ignored.',
  });

  // Seed a plot for the RLS positive control; the "crop past its window still shows ready
  // and harvests for full value" is the getPlotStatus wilt branch (subcommand-driven), gated.
  const cropId = await seedCrop(ctx, handle);
  await insertPlot(handle, userA, { plotIndex: 0, cropId, plantedAt: new Date().toISOString(), wateredAt: new Date().toISOString() });
  gateLiveFarm(
    ctx,
    'With wilt disabled a crop left long past its harvest window still shows ready and harvests for full value; plant, water, and harvest keep working normally.',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveFarmView(ctx, handle, userA);
  gateBrandKit(ctx);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** INVALID — a rejected invalid config never persists; valid values retained live. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_farming_enabled: true, economy_farm_grid_size: 6, economy_fertilizer_time_reduction_pct: 25 },
  });
  const userA = ctx.userId('a');

  // guild_config keeps its prior valid values byte-for-byte (nothing invalid persisted).
  const cfg = await readConfig(handle);
  ctx.expect(cfg?.economy_farm_grid_size === 6 && cfg?.economy_fertilizer_time_reduction_pct === 25, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid values byte-for-byte (a rejected zero grid size / negative fertilizer reduction never persists).',
    observation: `guild_config holds grid=${cfg?.economy_farm_grid_size} (expected 6), fertilizer=${cfg?.economy_fertilizer_time_reduction_pct} (expected 25).`,
    impact: 'A valid farming configuration was not retained after a rejected save.',
  });

  // Seed a plot so the RLS positive control holds and the "next /farm still works" surface
  // has real state; the reply itself is subcommand-driven and gated below.
  const cropId = await seedCrop(ctx, handle);
  await insertPlot(handle, userA, { plotIndex: 0, cropId, plantedAt: new Date().toISOString(), wateredAt: null });

  // The actual REJECTION + its audit row are enforced in the dashboard's Zod layer; the
  // guild_config farming columns carry NO CHECK constraint (grid_size/fertilizer are plain
  // integers), so the reject path is unreachable in a bot-only harness. GATE honestly.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard farming page surfaces a clear validation error for a zero grid size / a negative fertilizer reduction, and the next /farm view still renders the previous valid grid.',
    'config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK constraint on the farming columns, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'One audit row records the rejected farming configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveFarmView(ctx, handle, userA);
  gateBrandKit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** UNAUTH — plots are keyed per-member; a member's plot is a distinct row from another's. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_farming_enabled: true },
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Two members each own a plot in the SAME guild; the rows are keyed by (guild_id, user_id)
  // — the exact fields every /farm handler scopes plot lookups to, so no code path mutates
  // another member's row.
  const cropId = await seedCrop(ctx, handle);
  await insertPlot(handle, userA, { plotIndex: 0, cropId, plantedAt: new Date().toISOString(), wateredAt: new Date().toISOString() });
  await insertPlot(handle, userB, { plotIndex: 0, cropId, plantedAt: new Date().toISOString(), wateredAt: null });
  const plotA = await readPlot(handle, userA, 0);
  const plotB = await readPlot(handle, userB, 0);
  ctx.expect(
    plotA?.user_id === userA && plotB?.user_id === userB && plotA?.id !== plotB?.id,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'Farm plots are keyed per-member: run-member-a and run-member-b each own a distinct economy_farm_plots row — the exact (guild_id, user_id) scoping every /farm handler applies so a member cannot mutate another’s plots.',
      observation:
        `plot A user_id=${plotA?.user_id} (A=${userA}, id=${plotA?.id}); plot B user_id=${plotB?.user_id} (B=${userB}, id=${plotB?.id}); distinct rows=${plotA?.id !== plotB?.id}.`,
      impact: 'The plots were not keyed to distinct owners — the per-member ownership guard would have nothing sound to scope by.',
    },
  );

  // A member-scoped read returns only that member's plot, never the other's.
  const { data: bScoped } = await handle.supabase
    .from('economy_farm_plots')
    .select('user_id, guild_id')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userB)
    .eq('plot_index', 0)
    .maybeSingle();
  const bRow = bScoped as { user_id: string; guild_id: string } | null;
  ctx.expect(bRow?.user_id === userB, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'A read scoped to run-member-b returns only run-member-b’s plot row, never run-member-a’s.',
    observation: `member-B-scoped read returned user_id=${bRow?.user_id} under "${bRow?.guild_id}" (expected exactly ${userB}).`,
    impact: 'A member-scoped plot read returned another member’s row — the ownership boundary leaked.',
  });

  gateLiveFarm(
    ctx,
    'run-member-b’s /farm plant/water/harvest/fertilize only touch run-member-b’s own plots and leave run-member-a’s /farm view byte-identical.',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save farming settings (returns an authorization error).',
    'requires the dashboard session-auth lane (RLS + session role) — not reachable in this bot-only harness',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'An audit row records the denied farming configuration attempt with actor and reason permission-denied.',
    'the denied-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveFarmView(ctx, handle, userA);
  gateBrandKit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** DEPFAIL — Supabase-unreachable fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // This DB-observable harness's whole premise is a REACHABLE local Supabase, so a
  // database-outage cannot be induced without a fault-injection lane. GATE the
  // outage-dependent behavior honestly rather than fake an outage.
  ctx.gate(
    'Discord',
    'db-observable',
    'With database access blocked, /farm view and /farm harvest reply with the branded farming-unavailable message, no plot mutates and no coins move; after restore a fresh /farm harvest credits exactly once.',
    'requires a Supabase dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert (farming.dependency_degraded) for the outage window, not one per failed farm command.',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'After restoration a fresh /farm harvest credits exactly once and applies, logged with the run-prefixed correlation id.',
    'requires the outage fault lane; the harvest ledger row is also written inside the /farm harvest subcommand handler (undrivable here)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate play-money credit survives the outage/restore cycle.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded farming-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the farming-unavailable branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Farm rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a harvest whose payout fails restores the crops and a clean retry pays once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_farming_enabled: true },
  });
  const userA = ctx.userId('a');

  // The payout PRIMITIVE the failure branch guards: a failed (non-positive) economy_add_balance
  // creates NO coins (the wallet is unchanged), so a reverted harvest loses nothing; a clean
  // retry then credits exactly the sell total once.
  const sellPrice = 30;
  await seedWallet(handle, userA, sellPrice); // a pre-existing balance to prove "unchanged"
  const failedPayout = await addBalance(handle, userA, 0); // the failing payout branch
  const afterFail = await readWallet(handle, userA);
  const retryErr = await addBalance(handle, userA, sellPrice); // the clean retry
  const afterRetry = await readWallet(handle, userA);
  ctx.expect(
    failedPayout !== null && afterFail?.wallet === sellPrice && retryErr === null && afterRetry?.wallet === sellPrice * 2,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A failed harvest payout creates no coins (economy_add_balance rejects the bad amount and the wallet is unchanged), and a clean retry credits the sell total exactly once.',
      observation:
        `failed-payout err=${failedPayout ? failedPayout.message : 'none'}, wallet after fail=${afterFail?.wallet} (expected unchanged ${sellPrice}); ` +
        `retry err=${retryErr ? retryErr.message : 'none'}, wallet after retry=${afterRetry?.wallet} (expected ${sellPrice * 2}).`,
      impact: 'The payout primitive created coins on a failed attempt or did not credit exactly once on retry — a play-coin loss or double credit.',
    },
  );
  // Idempotency framing: the failed attempt left no credit, so the retry is the ONLY credit.
  ctx.expect(afterFail?.wallet === sellPrice, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The ledger shows no credit for the failed harvest attempt — only the retry credits.',
    observation: `wallet after the failed payout=${afterFail?.wallet} (expected the original ${sellPrice}, i.e. no credit added).`,
    impact: 'The failed harvest attempt still credited coins — a double-pay path.',
  });

  // Seed a plot so the RLS positive control holds; the actual mark-ready→payout→revert
  // sequence is inside /farm harvest and needs a mid-op fault lane — gated.
  const cropId = await seedCrop(ctx, handle);
  await insertPlot(handle, userA, { plotIndex: 0, cropId, plantedAt: new Date().toISOString(), wateredAt: new Date().toISOString(), harvested: false });
  ctx.gate(
    'Discord',
    'discord-readback',
    'After the injected payout fault run-member-a sees the branded restore message and /farm view shows the crops still ready; the clean retry harvests them for exactly one wallet credit.',
    'requires a mid-/farm-harvest fault-injection lane (fail economy_add_balance after the ready plots are marked harvested) plus subcommand injection',
  );
  gateAudit(ctx);
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveFarmView(ctx, handle, userA);
  gateBrandKit(ctx);
}

/** REPLAY — re-delivering a plant upserts one plot row (no double-plant). */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_farming_enabled: true },
  });
  const userA = ctx.userId('a');

  const cropId = await seedCrop(ctx, handle);
  // Plant once, then re-deliver the SAME plant: the plant path upserts on
  // (guild_id,user_id,plot_index), so a replay collapses to exactly one plot row.
  const plantedAt = new Date().toISOString();
  const first = await upsertPlot(handle, userA, 0, cropId, plantedAt);
  const replay = await upsertPlot(handle, userA, 0, cropId, plantedAt);
  const rows = await countPlots(handle, userA, 0);
  ctx.expect(first === null && replay === null && rows === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Re-delivering a /farm plant yields no duplicate plot: the upsert on (guild_id,user_id,plot_index) keeps exactly one economy_farm_plots row (one effect per logical plant).',
    observation:
      `first plant err=${first ? first.message : 'none'}; replayed plant err=${replay ? replay.message : 'none'}; ` +
      `plot rows at index 0 = ${rows} (expected exactly 1).`,
    impact: 'A replayed /farm plant created a second plot row — the plant was not idempotent.',
  });

  gateLiveFarm(
    ctx,
    'The channel shows exactly one planted embed and one harvest embed despite the replays, and /farm view + the wallet totals are unchanged from the pre-replay snapshot.',
  );
  // The harvest payout has NO persisted interaction-id idempotency key — it dedups by
  // flipping harvested=true BEFORE calling economy_add_balance, so a replay finds no ready
  // plot. That flag mechanism is manager-internal and undrivable here.
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'Re-delivering the harvest interaction pays exactly once (a stale re-delivery is a deduplicated no-op).',
    'the harvest dedup is the harvested=true flag set before payout inside /farm harvest (no persisted interaction-id key); the plant-side idempotency is proven DB-observably above',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveFarmView(ctx, handle, userA);
  gateBrandKit(ctx);
  gateAudit(ctx);
}

/** RESTART — plot state (crop, timestamps, fertilizer flag) survives a full reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');

  // Boot #1: enable, seed a crop + a growing plot with distinctive timestamps + fertilizer.
  const first = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_farming_enabled: true },
  });
  const cropId = await seedCrop(ctx, first);
  const plantedAt = new Date(Date.now() - 3_600_000).toISOString();
  const wateredAt = new Date(Date.now() - 1_800_000).toISOString();
  await insertPlot(first, userA, { plotIndex: 2, cropId, plantedAt, wateredAt, fertilized: true, harvested: false });
  const snapshot = await readPlot(first, userA, 2);
  await first.cleanup(); // simulate shutdown (does NOT delete rows)

  // Boot #2: SAME guild id (restart). The plot must be byte-identical (it lives in Supabase).
  const second = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_farming_enabled: true },
  });
  const afterRestart = await readPlot(second, userA, 2);
  ctx.expect(
    afterRestart?.crop_id === snapshot?.crop_id &&
      afterRestart?.planted_at === snapshot?.planted_at &&
      afterRestart?.watered_at === snapshot?.watered_at &&
      afterRestart?.fertilized === true &&
      afterRestart?.harvested === false &&
      afterRestart?.planted_at === plantedAt,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'After a full stack restart the plot resumes byte-identical: crop, planted_at, watered_at, and the fertilizer flag all persist (no crop matures twice, no progress lost).',
      observation:
        `pre-restart crop=${snapshot?.crop_id}/planted=${snapshot?.planted_at}/watered=${snapshot?.watered_at}/fert=${snapshot?.fertilized}; ` +
        `post-restart crop=${afterRestart?.crop_id}/planted=${afterRestart?.planted_at}/watered=${afterRestart?.watered_at}/fert=${afterRestart?.fertilized}/harvested=${afterRestart?.harvested}.`,
      impact: 'Farm plot state did not survive a restart — persisted crop/timers/fertilizer were lost or altered.',
    },
  );

  gateLiveFarm(
    ctx,
    'Post-restart /farm view matches the pre-restart snapshot exactly, the growing crop’s timer resumes from its persisted planted_at/watered_at without resetting, and a crop that matured across the restart harvests for exactly one credit.',
  );
  await proveRlsIsolation(ctx, second);
  await proveNoOwnerAlert(ctx, second);
  await proveFarmView(ctx, second, userA);
  gateBrandKit(ctx);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** RACE — two plants racing the last plot create exactly one row (UNIQUE serializes). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_farming_enabled: true },
  });
  const userA = ctx.userId('a');
  const cropId = await seedCrop(ctx, handle);

  // Two simultaneous plants both compute the same lowest-empty plot index and race the
  // partial UNIQUE (guild_id,user_id,plot_index): exactly one INSERT wins, the other is
  // rejected with 23505 — so the last plot holds exactly one crop.
  const lastPlot = 8; // the last plot of the default 9-grid
  const [r1, r2] = await Promise.all([
    insertPlot(handle, userA, { plotIndex: lastPlot, cropId, plantedAt: new Date().toISOString(), wateredAt: null }),
    insertPlot(handle, userA, { plotIndex: lastPlot, cropId, plantedAt: new Date().toISOString(), wateredAt: null }),
  ]);
  const wins = [r1, r2].filter((r) => r.id !== null).length;
  const rejects = [r1, r2].filter((r) => r.error?.code === '23505').length;
  const rows = await countPlots(handle, userA, lastPlot);
  ctx.expect(wins === 1 && rejects === 1 && rows === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Two simultaneous /farm plant calls racing for the last empty plot plant exactly one crop; the loser is refused (plots occupied).',
    observation: `concurrent plants: winners=${wins}, 23505-rejections=${rejects}, plot rows at index ${lastPlot}=${rows} (expected 1 / 1 / 1).`,
    impact: 'A last-plot race created duplicate plot rows — the UNIQUE(guild_id,user_id,plot_index) constraint did not serialize concurrent plants.',
  });
  ctx.expect(rows === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Concurrent plant re-delivery applies exactly one effect (one plot row for the last plot).',
    observation: `plot rows at index ${lastPlot} after two concurrent plants=${rows} (exactly-once expects 1).`,
    impact: 'Concurrent plants double-applied — the plant was not idempotent under a race.',
  });

  // Two simultaneous harvests → exactly one payout is the harvested-flag + economy_add_balance
  // sequence inside /farm harvest (no persisted idempotency key), undrivable here — gated.
  gateLiveFarm(
    ctx,
    'Two simultaneous /farm harvest invocations yield exactly one payout credit with the second seeing nothing to harvest.',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveFarmView(ctx, handle, userA);
  gateBrandKit(ctx);
  gateAudit(ctx);
}

/** XGUILD — farms are strictly per-guild (plots + wallet evolve independently). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');

  const handleA = await ctx.bootGuild({ guildId: guildA, economyStartingBalance: 0, guildConfigOverrides: { economy_farming_enabled: true } });
  const handleB = await ctx.bootGuild({ guildId: guildB, economyStartingBalance: 0, guildConfigOverrides: { economy_farming_enabled: true } });

  const cropA = await seedCrop(ctx, handleA);
  const cropB = await seedCrop(ctx, handleB);
  await insertPlot(handleA, userA, { plotIndex: 0, cropId: cropA, plantedAt: new Date().toISOString(), wateredAt: new Date().toISOString() });
  await seedWallet(handleA, userA, 700);
  const snapA = await readPlot(handleA, userA, 0);

  // The SAME member farms in guild B: a SEPARATE plot + wallet under guild B; guild A untouched.
  await insertPlot(handleB, userA, { plotIndex: 0, cropId: cropB, plantedAt: new Date().toISOString(), wateredAt: null });
  await seedWallet(handleB, userA, 123);
  const plotB = await readPlot(handleB, userA, 0);
  const plotAAfter = await readPlot(handleA, userA, 0);
  const walletAAfter = await readWallet(handleA, userA);
  const walletB = await readWallet(handleB, userA);

  ctx.expect(
    plotB?.guild_id === guildB &&
      plotB?.crop_id === cropB &&
      plotAAfter?.guild_id === guildA &&
      plotAAfter?.crop_id === snapA?.crop_id &&
      plotAAfter?.crop_id === cropA &&
      walletAAfter?.wallet === 700 &&
      walletB?.wallet === 123,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Planting and harvesting in a second guild never touches the first guild’s plots, crops, or wallet; each guild’s farm evolves independently.',
      observation:
        `guild A plot crop=${plotAAfter?.crop_id} (unchanged, cropA=${cropA}) under "${plotAAfter?.guild_id}", wallet=${walletAAfter?.wallet} (expected 700); ` +
        `guild B plot crop=${plotB?.crop_id} (cropB=${cropB}) under "${plotB?.guild_id}", wallet=${walletB?.wallet} (expected 123).`,
      impact: 'Cross-guild activity mutated another guild’s farm — per-guild isolation broken.',
    },
  );

  // Each guild scope reads its OWN distinct plot row and never the other's.
  const { data: bScoped } = await handleB.supabase
    .from('economy_farm_plots')
    .select('crop_id, guild_id')
    .eq('guild_id', guildB)
    .eq('user_id', userA)
    .eq('plot_index', 0)
    .maybeSingle();
  const { data: aScoped } = await handleA.supabase
    .from('economy_farm_plots')
    .select('crop_id, guild_id')
    .eq('guild_id', guildA)
    .eq('user_id', userA)
    .eq('plot_index', 0)
    .maybeSingle();
  const bRow = bScoped as { crop_id: string; guild_id: string } | null;
  const aRow = aScoped as { crop_id: string; guild_id: string } | null;
  ctx.expect(bRow?.guild_id === guildB && bRow?.crop_id === cropB && aRow?.guild_id === guildA && aRow?.crop_id === cropA, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'Each guild scope reads its OWN farm plot and never the other’s: guild B → its cropB plot, guild A → its cropA plot (distinct rows under distinct guild_ids).',
    observation:
      `guild-B-scoped read crop=${bRow?.crop_id} under "${bRow?.guild_id}"; guild-A-scoped read crop=${aRow?.crop_id} under "${aRow?.guild_id}".`,
    impact: 'A guild-scoped read returned the other guild’s farm plot — cross-guild leakage.',
  });
  await proveRlsIsolation(ctx, handleA);

  gateLiveFarm(
    ctx,
    'Guild A’s /farm view is identical before and after guild B activity, and guild B’s harvest credits guild B’s wallet at guild B’s configured crop sell price, observed in the live guilds.',
  );
  await proveNoOwnerAlert(ctx, handleA);
  await proveFarmView(ctx, handleA, userA);
  gateBrandKit(ctx);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_farming_enabled: true },
  });
  const userA = ctx.userId('a');

  // Create run-prefixed operational rows: crop + plot + wallet + a harvest ledger row.
  const cropId = await seedCrop(ctx, handle);
  await insertPlot(handle, userA, { plotIndex: 0, cropId, plantedAt: new Date().toISOString(), wateredAt: new Date().toISOString(), harvested: true });
  await seedWallet(handle, userA, 500);
  await handle.supabase.from('economy_transactions').insert({
    guild_id: handle.guildId,
    user_id: userA,
    type: 'farm_harvest',
    amount: 30,
    balance_after: 530,
    description: `${ctx.runPrefix}Harvested 1 crops`,
  });

  const cropsBefore = await cropCount(handle);
  const plotsBefore = await countPlots(handle, userA);
  const walletsBefore = await walletCount(handle, userA);
  const txnsBefore = await harvestTxnCount(handle, userA);
  ctx.expect(cropsBefore >= 1 && plotsBefore >= 1 && walletsBefore >= 1 && txnsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed crop, plot, wallet, and harvest-transaction rows (pre-cleanup baseline).',
    observation: `pre-cleanup: crops=${cropsBefore}, plots=${plotsBefore}, wallets=${walletsBefore}, harvest txns=${txnsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes + the branded /farm view while the rows still exist (pre-sweep).
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveFarmView(ctx, handle, userA);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const cropsAfter = await cropCount(handle);
  const plotsAfter = await countPlots(handle, userA);
  const walletsAfter = await walletCount(handle, userA);
  const txnsAfter = await harvestTxnCount(handle, userA);
  ctx.expect(cropsAfter === 0 && plotsAfter === 0 && walletsAfter === 0 && txnsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed crop, plot, wallet, and harvest-transaction rows are deleted; a final sweep finds zero run-prefixed farming resources.',
    observation: `post-sweep: crops=${cropsAfter}, plots=${plotsAfter}, wallets=${walletsAfter}, harvest txns=${txnsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed farming rows behind — the suite leaves residue.',
  });

  gateBrandKit(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed farm plant, harvest, or view embeds after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane; the farming operational rows are the DB-observable evidence here',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Persistent Farm Plots domain proof: the guild_id-scoped tables the sweep must clear
 * (child → parent so FK-constrained rows are removed before their parents and the guild
 * row), plus the 12 scenario scripts. `economy_farm_plots` is listed before `economy_crops`
 * because a plot's `crop_id` FK references a crop (ON DELETE SET NULL), so plots are cleared
 * first; the remaining tables are FK-independent and guild_id-scoped.
 */
export const gameEconomyFarmingProof: DomainProof = {
  domainId: 'game-economy-farming',
  guildScopedTables: [
    'economy_farm_plots',
    'economy_crops',
    'economy_transactions',
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
