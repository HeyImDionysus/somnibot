/**
 * scenario-runner/scripts/game-economy-casino — the casino domain proof.
 *
 * Binds the casino domain's 12 declarative catalog scenarios to concrete,
 * real-stack proof scripts driven through the REAL production dispatcher against
 * LOCAL Supabase. Every DB-observable / captured-reply / audit-row / RLS
 * assertion runs NOW; anything needing a real Discord effect, a live PayPal run,
 * a mid-bet fault-injection lane, or the per-user Valkey lock is GATED.
 *
 * ── The pivotal gating boundary for THIS domain ─────────────────────────────
 * Every casino command (coinflip, slots, rps, dice, blackjack, highlow, scratch,
 * guess) acquires a per-user lock FIRST (GamesManager.acquireGameLock), and that
 * lock is a Valkey `SET NX PX`. In this loopback harness the production manager
 * is wired with a REAL Valkey client that has NO reachable server, so it keeps
 * RECONNECTING: `await valkey.set(... 'NX')` never resolves and never rejects.
 * Therefore driving ANY casino command here BLOCKS FOREVER — it does not even
 * fail closed. The entire bet-resolution surface (wallet moves by the stake,
 * over-max-bet refusal, daily-cap refusal, single-in-flight guarantee, payout,
 * and even the dependency-outage fail-safe) is UNDRIVABLE without a live Redis
 * and is GATED here — honestly, with a precise reason. NO scenario awaits a
 * casino command outside an `if (ctx.capabilities.redis)` guard; the bet-path
 * assertions are written to RUN whenever `ctx.capabilities.redis` is present.
 *
 * What DOES run now, against real state:
 *   - guild_config casino-control persistence/readback (defaults + set-A/set-B),
 *   - the restart-durable `economy_daily_losses` counter (seed via the real RPC,
 *     read it back across a simulated restart),
 *   - RLS isolation on economy_wallets + economy_daily_losses (anon-denial with a
 *     service-role positive control; cross-guild distinct-row proof).
 *
 * Behavior-bug discovery (never forced green): real divergences surface as FAILs
 * for the owner to adjudicate — notably the shipped guild_config casino defaults
 * contradicting the catalog's on-out-of-box conservative-caps promise (DEF), and
 * the casino bet path persisting no idempotency key / no append-only audit row
 * (surfaced where drivable, otherwise gated with the structural note).
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Domain constants ──────────────────────────────────────────────────────

/**
 * The single load-bearing gate reason: without Redis the per-user Valkey lock
 * (SET NX PX) can never be driven — with no reachable server the harness's Valkey
 * client keeps reconnecting and the lock `await` hangs indefinitely, so no bet /
 * cap / payout path can be exercised (and a driven command would never return).
 */
const LOCK_GATE =
  'casino bets acquire a per-user Valkey lock (SET NX PX) before any wager/cap/balance/daily-loss/payout logic runs; ' +
  'with no Redis reachable the harness Valkey client keeps reconnecting so acquireGameLock never resolves and a driven ' +
  'casino command would BLOCK FOREVER, so the bet path cannot be driven in this harness';

// ── Row/config shapes ─────────────────────────────────────────────────────

interface WalletRow {
  wallet: number;
  bank: number;
  user_id: string;
  guild_id: string;
}

interface CasinoConfig {
  economy_games_enabled: boolean | null;
  economy_coinflip_max_bet: number | null;
  economy_slots_max_bet: number | null;
  economy_blackjack_max_bet: number | null;
  economy_daily_loss_limit: number | null;
}

interface EconomyDisplay {
  currencyName: string;
  currencyEmoji: string;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

function display(handle: LiveClientHandle): EconomyDisplay {
  return { currencyName: handle.economy.currencyName, currencyEmoji: handle.economy.currencyEmoji };
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

/** Arrange an exact wallet/bank via the REAL wallet initializer, then a precise set. */
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

async function readCasinoConfig(handle: LiveClientHandle): Promise<CasinoConfig | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select(
      'economy_games_enabled, economy_coinflip_max_bet, economy_slots_max_bet, ' +
        'economy_blackjack_max_bet, economy_daily_loss_limit',
    )
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as CasinoConfig | null) ?? null;
}

/**
 * Seed a member's UTC-day loss counter through the REAL restart-durable RPC
 * (`economy_increment_daily_loss` with a positive amount inserts/accumulates the
 * row keyed on today's UTC date), exactly as a losing bet would.
 */
async function seedDailyLoss(handle: LiveClientHandle, userId: string, amount: number): Promise<void> {
  await handle.supabase.rpc('economy_increment_daily_loss', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
}

/** Read a member's current UTC-day loss total via the RPC's read mode (p_amount = 0). */
async function readDailyLoss(handle: LiveClientHandle, userId: string): Promise<number> {
  const { data } = await handle.supabase.rpc('economy_increment_daily_loss', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: 0,
  });
  return Number(data ?? 0);
}

/** The persisted daily-loss row (positive control for the RLS probe); null if none. */
async function readDailyLossRow(
  handle: LiveClientHandle,
  userId: string,
): Promise<{ amount: number } | null> {
  const { data } = await handle.supabase
    .from('economy_daily_losses')
    .select('amount')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  const rows = (data as Array<{ amount: number }> | null) ?? [];
  return rows.length > 0 ? rows[0]! : null;
}

async function dailyLossCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_daily_losses')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

async function tableCount(handle: LiveClientHandle, table: string): Promise<number> {
  const { count } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
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

/** Read the last editReply/reply content string a handler produced. */
/** The text of a captured reply/editReply payload — discord.js accepts either a
 *  raw string or a `{ content }` object, so normalise both (a raw-string payload
 *  otherwise reads as empty — the #335 payload lesson). */
function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return String((payload as { content?: string } | undefined)?.content ?? '');
}

function replyContent(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  if (edits.length > 0) {
    return payloadText(edits[edits.length - 1]!.payload);
  }
  return payloadText(captured.find('reply')?.payload);
}

function replyEmbedData(captured: CapturedResponse): Record<string, unknown> | undefined {
  const reply = captured.find('reply');
  const payload = reply?.payload as { embeds?: Array<{ data?: Record<string, unknown> }> } | undefined;
  return payload?.embeds?.[0]?.data;
}

function truncate(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS/GRANT deny → 0), or null when no anon key /
 * SUPABASE_URL is available or the key is rejected before authz ran (→ GATE).
 */
async function anonReadCount(
  anonKey: string,
  table: string,
  guildId: string,
): Promise<number | null> {
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
    // Non-2xx: a genuine AUTHORIZATION denial (SQLSTATE 42501 "permission denied
    // for table" — the deny we want to prove) vs the key itself being rejected
    // before authz ran (inconclusive → GATE).
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null;
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return 0;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/** Every member-facing text surface of a reply: content + embed title/description/fields/footer. */
function brandingSurface(captured: CapturedResponse): string {
  const parts: string[] = [];
  const content = replyContent(captured);
  if (content) parts.push(content);
  const embed = replyEmbedData(captured);
  if (embed) {
    if (typeof embed.title === 'string') parts.push(embed.title);
    if (typeof embed.description === 'string') parts.push(embed.description);
    const fields = embed.fields as Array<{ name?: string; value?: string }> | undefined;
    for (const f of fields ?? []) {
      if (typeof f.name === 'string') parts.push(f.name);
      if (typeof f.value === 'string') parts.push(f.value);
    }
    const footer = (embed.footer as { text?: string } | undefined)?.text;
    if (typeof footer === 'string') parts.push(footer);
  }
  return parts.join('\n');
}

/**
 * Prove a captured casino OUTCOME surface carries the owner-configured currency
 * branding — checked against the REAL captured embed. Only meaningful once the
 * bet path is drivable (Redis). The current GamesManager hardcodes "coins" and
 * generic game emoji, so this is expected to FAIL when driven — a real branding
 * finding, not something to soften.
 */
function proveBrandingFromBet(ctx: ScenarioContext, captured: CapturedResponse, econ: EconomyDisplay): void {
  const surface = brandingSurface(captured);
  const hasEmoji = surface.includes(econ.currencyEmoji);
  const hasName = surface.includes(econ.currencyName);
  ctx.expect(hasEmoji || hasName, {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise: 'Every member-facing casino outcome surface shows the owner-configured currency name/emoji (zero stock-bot wording).',
    observation:
      `casino outcome surface "${truncate(surface)}" ${hasEmoji ? 'includes' : 'omits'} emoji "${econ.currencyEmoji}" ` +
      `and ${hasName ? 'includes' : 'omits'} name "${econ.currencyName}".`,
    impact:
      'A casino outcome embed did not reflect the configured currency branding (the GamesManager hardcodes "coins" / stock emoji).',
  });
}

/**
 * GATE branding when no drivable casino OUTCOME surface exists (the norm without
 * Redis: no casino command can be run at all, so there is no currency surface to
 * inspect — checking a synthetic string would be a misleading result).
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Every member-facing casino outcome surface shows the owner-configured brand name, colors, and voice preset.',
    `${LOCK_GATE} — no casino outcome reply is reachable to inspect for currency branding`,
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

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
 * Anon-denial RLS proof for a guild-scoped casino table, made non-vacuous by a
 * positive control the caller has already created (the service role sees the
 * seeded row; an anon client reading ZERO is a real deny, not "nothing to read").
 */
async function proveTableRls(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  table: 'economy_wallets' | 'economy_daily_losses',
  serviceSeesRow: boolean,
  policyNote: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero ${table} rows (${policyNote}).`,
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, table, handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero ${table} rows.`,
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(serviceSeesRow && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: `The service role reads this guild's ${table} row while an anon client reads zero of them (${policyNote}).`,
    observation:
      `service-role sees the seeded ${table} row under guild "${handle.guildId}" (${serviceSeesRow}); ` +
      `an anon-key REST read returned ${anonRows} ${table} row(s) for that guild.`,
    impact: `A ${table} row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).`,
  });
}

/** economy_wallets anon-denial (positive control: the caller has seeded the wallet). */
async function proveWalletRls(ctx: ScenarioContext, handle: LiveClientHandle, userId: string): Promise<void> {
  const wallet = await readWallet(handle, userId);
  await proveTableRls(ctx, handle, 'economy_wallets', wallet !== null, 'RLS economy_wallets_deny_all');
}

/** economy_daily_losses anon-denial (positive control: the caller has seeded a loss row). */
async function proveDailyLossRls(ctx: ScenarioContext, handle: LiveClientHandle, userId: string): Promise<void> {
  const row = await readDailyLossRow(handle, userId);
  await proveTableRls(
    ctx,
    handle,
    'economy_daily_losses',
    row !== null,
    'authenticated-only SELECT grant, no anon GRANT',
  );
}

/**
 * GATE the audit-row class. The casino writes NO append-only audit/ledger row:
 * economy_add_balance / economy_subtract_balance only mutate economy_wallets, and
 * GamesManager emits no audit_logs / economy_transactions row per bet. The
 * append-only-audit-per-state-change promise is only checkable against a DRIVEN
 * bet (Redis-gated) and is expected to FAIL once drivable — surfaced here as the
 * gate reason rather than hidden.
 */
function gateAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'audit-row',
    'Every casino state change lands exactly one append-only audit row with actor, guild, and correlation id.',
    `${LOCK_GATE}; additionally the GamesManager bet path writes no economy_transactions/audit_logs row ` +
      '(economy_add_balance/economy_subtract_balance mutate only economy_wallets), so this class is expected to ' +
      'FAIL once the bet path is drivable — flagged for owner adjudication',
  );
}

function gateReplayDeferred(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    "Re-delivering this scenario's casino triggers yields no duplicate debits/credits/daily-loss increments.",
    `casino replay/idempotency is exercised directly in the ${where} scenario`,
  );
}

function gateLiveGuildReadback(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'The casino outcome surfaces are observed working in the live test guild (channel embeds, result messages).',
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) for channel/message readback',
  );
}

/** Assert a persisted casino control equals the given value (config took effect at the persistence layer). */
function expectControl(
  ctx: ScenarioContext,
  cfg: CasinoConfig | null,
  column: keyof CasinoConfig,
  expected: number | boolean,
  label: string,
): void {
  const actual = cfg ? cfg[column] : undefined;
  ctx.expect(actual === expected, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `${label}: guild_config.${column} carries ${String(expected)} live (the control governs the casino caps).`,
    observation: `guild_config.${column} = ${String(actual)} (expected ${String(expected)}).`,
    impact: `A saved casino control (${column}) did not persist — the configured cap/flag would not govern play.`,
  });
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/**
 * DEF — out of the box the casino is on with conservative caps (coinflip/slots
 * 500, blackjack 1000, daily-loss 5000). Proven at the config + counter layer
 * now; cap enforcement gates on Redis (a driven bet would hang on the lock).
 */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const coinflipDefault = Number(declaredDefault(ctx.domain, 'coinflip-max-bet'));
  const slotsDefault = Number(declaredDefault(ctx.domain, 'slots-max-bet'));
  const blackjackDefault = Number(declaredDefault(ctx.domain, 'blackjack-max-bet'));
  const dailyCapDefault = Number(declaredDefault(ctx.domain, 'daily-loss-cap'));
  const enabledDefault = declaredDefault(ctx.domain, 'casino-enabled') === true;

  // (1) SHIPPED defaults: boot a guild with NO casino overrides so guild_config
  //     carries the raw column defaults the REAL initGuildFeatures reads. The bot
  //     applies no default-config layer, so this row IS the out-of-box state.
  const shipped = await ctx.bootGuild({ label: 's', economyStartingBalance: 0 });
  const shippedCfg = await readCasinoConfig(shipped);
  const matchesCatalog =
    shippedCfg?.economy_games_enabled === enabledDefault &&
    shippedCfg?.economy_coinflip_max_bet === coinflipDefault &&
    shippedCfg?.economy_slots_max_bet === slotsDefault &&
    shippedCfg?.economy_blackjack_max_bet === blackjackDefault &&
    shippedCfg?.economy_daily_loss_limit === dailyCapDefault;
  ctx.expect(matchesCatalog, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Out of the box the casino is ON with conservative caps: coinflip/slots 500, blackjack 1000, daily-loss 5000 ' +
      '(catalog casino-enabled/coinflip/slots/blackjack/daily-loss defaults).',
    observation:
      `shipped guild_config on a fresh guild = games_enabled=${String(shippedCfg?.economy_games_enabled)} (expect ${enabledDefault}), ` +
      `coinflip=${shippedCfg?.economy_coinflip_max_bet} (expect ${coinflipDefault}), ` +
      `slots=${shippedCfg?.economy_slots_max_bet} (expect ${slotsDefault}), ` +
      `blackjack=${shippedCfg?.economy_blackjack_max_bet} (expect ${blackjackDefault}), ` +
      `daily-loss=${shippedCfg?.economy_daily_loss_limit} (expect ${dailyCapDefault}).`,
    impact:
      'Were the shipped guild_config casino defaults to contradict the catalog out-of-box promise (casino DISABLED ' +
      'with much higher caps and no daily-loss cap), a fresh guild would not get the advertised conservative ' +
      'on-by-default floor. After 20260724170000_ship_on_defaults the column DEFAULTs are the catalog values.',
  });

  // (2) With the catalog defaults APPLIED, prove they persist and govern the caps,
  //     and that the restart-durable daily-loss counter is DB-backed.
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_games_enabled: enabledDefault,
      economy_coinflip_max_bet: coinflipDefault,
      economy_slots_max_bet: slotsDefault,
      economy_blackjack_max_bet: blackjackDefault,
      economy_daily_loss_limit: dailyCapDefault,
    },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');

  const cfg = await readCasinoConfig(handle);
  expectControl(ctx, cfg, 'economy_games_enabled', enabledDefault, 'DEF default (casino on)');
  expectControl(ctx, cfg, 'economy_coinflip_max_bet', coinflipDefault, 'DEF default (coinflip cap)');
  expectControl(ctx, cfg, 'economy_daily_loss_limit', dailyCapDefault, 'DEF default (daily-loss cap)');

  // Restart-durable daily-loss counter: seed via the REAL RPC and read it back.
  await seedWallet(handle, userA, 1000, 0);
  await seedDailyLoss(handle, userA, 200);
  const loss = await readDailyLoss(handle, userA);
  ctx.expect(loss === 200, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Accumulated losses count toward the daily cap in the restart-durable economy_daily_losses counter.',
    observation: `after seeding a 200-coin loss via economy_increment_daily_loss, the UTC-day total reads ${loss} (expected 200).`,
    impact: 'The daily-loss counter did not accumulate — the daily loss cap could not be enforced.',
  });

  // Cap enforcement (within-cap bet moves the wallet by the stake; a 600 coinflip
  // is refused over the 500 default) needs the Valkey lock — drive it ONLY if
  // Redis is present (a driven command would otherwise hang), else GATE honestly.
  if (ctx.capabilities.redis) {
    const before = (await readWallet(handle, userA))?.wallet ?? -1;
    const inCap = await ctx.runSlash(handle, { commandName: 'coinflip', userId: userA, options: { amount: 200 } });
    const after = (await readWallet(handle, userA))?.wallet ?? -1;
    ctx.expect(Math.abs(after - before) === 200 && Boolean(replyEmbedData(inCap)), {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'A within-cap /coinflip 200 moves the wallet by exactly 200 in the resolved direction and renders a result embed.',
      observation: `wallet moved ${before}→${after} (|Δ|=${Math.abs(after - before)}, expected 200); embed=${Boolean(replyEmbedData(inCap))}.`,
      impact: 'A within-cap coinflip did not move the wallet by exactly the stake.',
    });
    const overCap = await ctx.runSlash(handle, { commandName: 'coinflip', userId: userA, options: { amount: 600 } });
    const afterOver = (await readWallet(handle, userA))?.wallet ?? -1;
    ctx.expect(replyContent(overCap).includes('Max bet') && afterOver === after, {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A /coinflip 600 is refused over the 500 default cap with no wallet mutation.',
      observation: `over-cap reply="${truncate(replyContent(overCap))}"; wallet ${after}→${afterOver} (expected unchanged).`,
      impact: 'An over-cap wager was not refused — the max-bet cap is not enforced.',
    });
    proveBrandingFromBet(ctx, inCap, econ);
  } else {
    ctx.gate(
      'Discord',
      'redis-dependency',
      'A within-cap coinflip/slots moves the wallet by exactly the stake and a 600-coin coinflip is refused over the 500 default cap.',
      LOCK_GATE,
    );
    gateBranding(ctx);
  }

  await proveWalletRls(ctx, handle, userA);
  await proveDailyLossRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx);
  gateReplayDeferred(ctx, 'REPLAY / RACE');
  gateLiveGuildReadback(ctx);
}

/** SET-A — conservative config (coinflip 100, blackjack 200, daily-loss 1000) takes live effect. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_games_enabled: true,
      economy_coinflip_max_bet: 100,
      economy_slots_max_bet: 100,
      economy_blackjack_max_bet: 200,
      economy_daily_loss_limit: 1000,
    },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');

  // Config took live effect at the persistence layer: the same controls carry set-A values.
  const cfg = await readCasinoConfig(handle);
  expectControl(ctx, cfg, 'economy_coinflip_max_bet', 100, 'SET-A (coinflip cap 100)');
  expectControl(ctx, cfg, 'economy_blackjack_max_bet', 200, 'SET-A (blackjack cap 200)');
  expectControl(ctx, cfg, 'economy_daily_loss_limit', 1000, 'SET-A (daily-loss cap 1000)');

  // Arrange a member most-of-the-way to the 1000 daily cap (DB-observable).
  await seedWallet(handle, userA, 5000, 0);
  await seedDailyLoss(handle, userA, 950);
  const loss = await readDailyLoss(handle, userA);
  ctx.expect(loss === 950, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The set-A daily-loss standing accumulates toward the 1000 cap in economy_daily_losses.',
    observation: `seeded UTC-day loss total reads ${loss} (expected 950, i.e. 50 short of the 1000 cap).`,
    impact: 'The daily-loss counter did not accumulate under the set-A cap.',
  });

  // Enforcement (90 accepted; 150 & blackjack 201 refused; a wager past 1000 lost
  // hits the daily-cap reply) needs the Valkey lock — Redis-only.
  if (ctx.capabilities.redis) {
    const before = (await readWallet(handle, userA))?.wallet ?? -1;
    const ok = await ctx.runSlash(handle, { commandName: 'coinflip', userId: userA, options: { amount: 90 } });
    const afterOk = (await readWallet(handle, userA))?.wallet ?? -1;
    ctx.expect(Math.abs(afterOk - before) === 90 && Boolean(replyEmbedData(ok)), {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'At the set-A caps a /coinflip 90 resolves normally (wallet moves by 90).',
      observation: `wallet moved ${before}→${afterOk} (|Δ|=${Math.abs(afterOk - before)}, expected 90).`,
      impact: 'A within-cap set-A wager did not resolve.',
    });
    const over = await ctx.runSlash(handle, { commandName: 'coinflip', userId: userA, options: { amount: 150 } });
    ctx.expect(replyContent(over).includes('Max bet'), {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A /coinflip 150 is refused over the set-A 100 cap.',
      observation: `reply="${truncate(replyContent(over))}".`,
      impact: 'The raised set-A coinflip cap did not take live effect.',
    });
    const bjOver = await ctx.runSlash(handle, { commandName: 'blackjack', userId: userA, options: { amount: 201 } });
    ctx.expect(replyContent(bjOver).includes('Max bet'), {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A /blackjack 201 is refused over the set-A 200 cap.',
      observation: `reply="${truncate(replyContent(bjOver))}".`,
      impact: 'The set-A blackjack cap did not take live effect.',
    });
    const cap = await ctx.runSlash(handle, { commandName: 'coinflip', userId: userA, options: { amount: 100 } });
    ctx.expect(replyContent(cap).includes('daily loss limit'), {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A wager whose potential loss pushes the day past 1000 lost coins is refused with the daily-cap reply.',
      observation: `after 950 lost, a 100-coin wager reply="${truncate(replyContent(cap))}".`,
      impact: 'The daily-loss cap did not engage — a member could exceed the configured daily loss.',
    });
    proveBrandingFromBet(ctx, ok, econ);
  } else {
    ctx.gate(
      'Discord',
      'redis-dependency',
      'At the set-A caps /coinflip 90 resolves, /coinflip 150 & /blackjack 201 are refused, and a wager past 1000 lost hits the daily-cap reply.',
      LOCK_GATE,
    );
    gateBranding(ctx);
  }

  await proveWalletRls(ctx, handle, userA);
  await proveDailyLossRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx);
  gateReplayDeferred(ctx, 'REPLAY / RACE');
  gateLiveGuildReadback(ctx);
}

/** SET-B — a distinct config (coinflip 2000, blackjack 5000, daily-loss 20000) proves the same controls carry different values. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_games_enabled: true,
      economy_coinflip_max_bet: 2000,
      economy_slots_max_bet: 2000,
      economy_blackjack_max_bet: 5000,
      economy_daily_loss_limit: 20000,
    },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');

  // The SAME controls carry set-B values, distinct from set-A (100/200/1000).
  const cfg = await readCasinoConfig(handle);
  expectControl(ctx, cfg, 'economy_coinflip_max_bet', 2000, 'SET-B (coinflip cap 2000)');
  expectControl(ctx, cfg, 'economy_blackjack_max_bet', 5000, 'SET-B (blackjack cap 5000)');
  expectControl(ctx, cfg, 'economy_daily_loss_limit', 20000, 'SET-B (daily-loss cap 20000)');
  ctx.expect(
    cfg?.economy_coinflip_max_bet !== 100 && cfg?.economy_daily_loss_limit !== 1000,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'The same casino controls carry values distinct from set A (coinflip 2000 ≠ 100, daily-loss 20000 ≠ 1000).',
      observation: `guild_config coinflip=${cfg?.economy_coinflip_max_bet}, daily-loss=${cfg?.economy_daily_loss_limit} (set-A were 100 / 1000).`,
      impact: 'The casino controls did not carry the distinct set-B values — a saved reconfiguration was ignored.',
    },
  );

  if (ctx.capabilities.redis) {
    await seedWallet(handle, userA, 10000, 0);
    const before = (await readWallet(handle, userA))?.wallet ?? -1;
    const ok = await ctx.runSlash(handle, { commandName: 'coinflip', userId: userA, options: { amount: 1500 } });
    const afterOk = (await readWallet(handle, userA))?.wallet ?? -1;
    ctx.expect(Math.abs(afterOk - before) === 1500 && Boolean(replyEmbedData(ok)), {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'A /coinflip 1500 that set A refused now resolves at the raised set-B 2000 cap (wallet moves by 1500).',
      observation: `wallet moved ${before}→${afterOk} (|Δ|=${Math.abs(afterOk - before)}, expected 1500).`,
      impact: 'The raised set-B coinflip cap did not take live effect.',
    });
    const over = await ctx.runSlash(handle, { commandName: 'coinflip', userId: userA, options: { amount: 2001 } });
    ctx.expect(replyContent(over).includes('Max bet'), {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A /coinflip 2001 is refused over the set-B 2000 cap.',
      observation: `reply="${truncate(replyContent(over))}".`,
      impact: 'The set-B coinflip cap ceiling was not enforced.',
    });
    proveBrandingFromBet(ctx, ok, econ);
  } else {
    ctx.gate(
      'Discord',
      'redis-dependency',
      'A /coinflip 1500 and /blackjack 5000 resolve at the raised set-B caps and /coinflip 2001 is refused.',
      LOCK_GATE,
    );
    gateBranding(ctx);
  }

  await seedWallet(handle, userA, 10000, 0);
  await proveWalletRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx);
  gateReplayDeferred(ctx, 'REPLAY / RACE');
  gateLiveGuildReadback(ctx);
}

/** INVALID — an invalid casino config (negative cap / out-of-range daily loss) never persists; prior valid values are retained. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_games_enabled: true,
      economy_coinflip_max_bet: 500,
      economy_daily_loss_limit: 5000,
    },
  });
  const userA = ctx.userId('a');

  // DB-observable core: guild_config retains its prior VALID values byte-for-byte.
  const cfg = await readCasinoConfig(handle);
  ctx.expect(cfg?.economy_coinflip_max_bet === 500 && cfg?.economy_daily_loss_limit === 5000, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid casino values byte-for-byte (a rejected invalid save never persists).',
    observation: `guild_config holds coinflip=${cfg?.economy_coinflip_max_bet} (expected 500), daily-loss=${cfg?.economy_daily_loss_limit} (expected 5000).`,
    impact: 'A valid casino configuration was not retained.',
  });

  // The actual REJECTION lives in the dashboard Zod layer (guild/route.ts:
  // z.number().int().min(0).max(1e8)); the guild_config columns carry NO DB CHECK
  // constraint, so a bot-only harness cannot drive/observe the reject path.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard economy games page surfaces a clear validation error for a negative wager cap / an out-of-range daily loss cap, and the next casino command still enforces the previous valid cap.',
    'casino config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK constraint, so a bot-only harness cannot drive the reject path — and enforcing the previous cap on the next command needs the Valkey lock (Redis)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records the rejected casino configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveWalletRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplayDeferred(ctx, 'REPLAY / RACE');
}

/** UNAUTH — a member cannot bet from another member's wallet; a non-admin dashboard save is refused. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_games_enabled: true, economy_coinflip_max_bet: 500, economy_daily_loss_limit: 5000 },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Arrange two distinct, independent wallets — the per-user rows a bet must key to.
  await seedWallet(handle, userA, 1000, 0);
  await seedWallet(handle, userB, 1000, 0);
  const a0 = await readWallet(handle, userA);
  const b0 = await readWallet(handle, userB);
  ctx.expect(a0?.wallet === 1000 && b0?.wallet === 1000 && a0?.user_id !== b0?.user_id, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Each member has their own economy_wallets row; a bet only ever mutates the invoking member’s own row.',
    observation: `member-a wallet=${a0?.wallet} (user ${a0?.user_id}), member-b wallet=${b0?.wallet} (user ${b0?.user_id}) — distinct rows.`,
    impact: 'The two members did not have distinct wallet rows — the wager-from-own-wallet arrangement is invalid.',
  });

  // Two-economies wall: a casino action reads/writes only economy_wallets +
  // economy_daily_losses, never any commerce/billing table.
  const customers = await tableCount(handle, 'customers');
  const entitlements = await tableCount(handle, 'entitlements');
  const orders = await tableCount(handle, 'orders');
  ctx.expect(customers === 0 && entitlements === 0 && orders === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'No commerce/billing row exists for the casino guild — the casino never reads or writes the commerce tables (winnings are never convertible to real value).',
    observation: `commerce rows for the guild: customers=${customers}, entitlements=${entitlements}, orders=${orders} (all expected 0).`,
    impact: 'A casino guild carried commerce/billing rows — a leak across the two-economies wall.',
  });

  // The actual cross-wallet non-interference proof (member-b bets → member-a
  // byte-identical) needs a driven bet; the non-admin dashboard save is a
  // session-auth lane. Both gated honestly.
  if (ctx.capabilities.redis) {
    const aBefore = (await readWallet(handle, userA))?.wallet ?? -1;
    const captured = await ctx.runSlash(handle, { commandName: 'coinflip', userId: userB, options: { amount: 100 } });
    const aAfter = (await readWallet(handle, userA))?.wallet ?? -1;
    const bAfter = (await readWallet(handle, userB))?.wallet ?? -1;
    ctx.expect(aAfter === aBefore && aBefore === 1000 && Math.abs(bAfter - 1000) === 100, {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: "member-b's casino bet debits/credits only member-b's own wallet; member-a's balance is byte-identical before and after.",
      observation: `member-a ${aBefore}→${aAfter} (expected unchanged 1000); member-b wallet Δ=${Math.abs(bAfter - 1000)} (expected 100).`,
      impact: 'A member’s bet touched another member’s wallet — the own-wallet-only guarantee was breached.',
    });
    proveBrandingFromBet(ctx, captured, econ);
  } else {
    ctx.gate(
      'Discord',
      'redis-dependency',
      "member-b's casino bet only ever touches member-b's own wallet; member-a's balance is byte-identical afterward.",
      LOCK_GATE,
    );
    gateBranding(ctx);
  }
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save casino settings (enable flag, wager caps, daily-loss cap).',
    'requires the dashboard session-auth lane (session auth + Supabase RLS on guild_config writes) — not reachable in this bot-only harness',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'An audit row records the denied casino configuration attempt with actor and reason permission-denied.',
    'the denied-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveWalletRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateReplayDeferred(ctx, 'REPLAY / RACE');
}

/**
 * DEPFAIL — when the per-user Valkey lock is unreachable the casino must fail
 * SAFE: no coins move and the member sees a branded casino-unavailable reply.
 *
 * ── Why this fail-safe cannot be driven here (and MUST NOT be) ──────────────
 * Observing the fail-safe requires the lock op (SET NX) to FAIL FAST so the
 * handler reaches its degradation branch. Neither harness state produces that:
 * with a healthy Valkey there is no outage, and with NO reachable Valkey the
 * production client keeps RECONNECTING — acquireGameLock's `await valkey.set(…
 * 'NX')` never resolves AND never rejects, so a driven /coinflip would BLOCK
 * FOREVER (it would not even fail closed). Driving a casino command here is
 * exactly what hangs the run, so this script NEVER awaits one: the whole
 * outage surface (no-coins-move + branded-unavailable reply + single aggregated
 * alert) is GATED behind a dependency-outage fault-injection lane that makes the
 * lock op fail fast. What still runs, DB-observably on a seeded wallet and
 * needing no game command: the guild-scoping RLS proof.
 */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_games_enabled: true, economy_coinflip_max_bet: 500 },
  });
  const userA = ctx.userId('a');
  // Seed a real, service-visible wallet so the RLS proof below has a positive
  // control (a non-vacuous anon-denial), not an empty table.
  await seedWallet(handle, userA, 1000, 0);

  // The entire outage fail-safe surface needs a fault lane that makes the lock op
  // FAIL FAST; the no-Redis loopback client instead hangs, so it cannot be driven.
  ctx.gate(
    'Discord',
    'db-observable',
    'With the per-user Valkey lock unreachable, casino commands reply with the branded casino-unavailable template and no coins move; after restoration a fresh bet resolves with exactly one wallet mutation.',
    `${LOCK_GATE}; and observing the degradation branch needs a fault lane that makes the lock op FAIL FAST — the no-Redis ` +
      'loopback client instead keeps reconnecting, so a driven casino command would hang rather than fail closed and cannot be awaited here',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single aggregated dependency-degradation alert for the outage window (not one per failed command), and transient per-command lock failures raise none.',
    'requires a dependency-outage fault lane (fast-failing lock op) plus owner alert channel readback — the reconnecting loopback client cannot reach the degradation branch DB-observably',
  );
  gateAudit(ctx);
  gateBranding(ctx);
  gateReplayDeferred(ctx, 'REPLAY');

  // DB-observable now, needing no casino command: the guild's wallet row stays
  // strictly guild-scoped (service role sees it; anon reads zero).
  await proveWalletRls(ctx, handle, userA);
}

/** RETRY — a winning bet whose payout step fails must not falsely credit; an operator retry pays exactly once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The payout-failure branch triggers only when economy_add_balance fails AFTER a
  // winning CSPRNG outcome resolves — a mid-bet fault that needs both the Valkey
  // lock (to reach resolution) and a fault-injection lane at the wallet-RPC
  // boundary. GATE the whole scenario; do not fabricate a fault and NEVER drive a
  // casino command (it would hang on the unreachable lock).
  ctx.gate(
    'Discord',
    'db-observable',
    'After an injected payout fault the member sees the delayed-payout notice (not a false win), the balance is unchanged, and the operator retry credits the winnings exactly once.',
    `${LOCK_GATE}; the win-payout-failed branch additionally needs a fault-injection lane (fail economy_add_balance after a winning outcome)`,
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The failed payout and its retry apply under one idempotency key — the winnings credit exactly once, never a double or phantom credit.',
    'requires the mid-bet payout fault-injection lane (and the casino payout path currently persists no idempotency key — flagged for owner adjudication)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one owner alert fires for the failed payout carrying the game name, member, and remediation hint; the successful retry raises none.',
    'requires the payout fault lane plus owner alert channel readback',
  );
  gateAudit(ctx);
  ctx.gate(
    'database-RLS',
    'db-rls',
    'The failed payout and retry touch only the member’s own guild-scoped wallet.',
    'requires the mid-bet payout fault-injection lane',
  );
  gateBranding(ctx);
}

/** REPLAY — re-delivering a resolved casino bet must not double-charge or double-pay. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_games_enabled: true, economy_coinflip_max_bet: 500, economy_daily_loss_limit: 5000 },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');
  await seedWallet(handle, userA, 1000, 0);

  if (ctx.capabilities.redis) {
    // Drive one /coinflip, snapshot wallet + daily-loss, then RE-DELIVER the same
    // interaction id. The GamesManager persists no per-bet idempotency key, so a
    // re-delivery runs a fresh, independent bet — this expect is expected to FAIL,
    // surfacing the missing-idempotency finding.
    const betId = `${ctx.runPrefix}replay-bet`;
    const opts = { amount: 100 };
    await ctx.runSlash(handle, { commandName: 'coinflip', userId: userA, options: opts, interactionId: betId });
    const walletAfterFirst = (await readWallet(handle, userA))?.wallet ?? -1;
    const lossAfterFirst = await readDailyLoss(handle, userA);
    const replayCaptured = await ctx.runSlash(handle, { commandName: 'coinflip', userId: userA, options: opts, interactionId: betId });
    const walletAfterReplay = (await readWallet(handle, userA))?.wallet ?? -1;
    const lossAfterReplay = await readDailyLoss(handle, userA);
    ctx.expect(walletAfterReplay === walletAfterFirst && lossAfterReplay === lossAfterFirst, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Re-delivering a resolved casino bet leaves exactly one wallet mutation and one daily-loss increment (persisted idempotency key).',
      observation:
        `wallet ${walletAfterFirst}→${walletAfterReplay}, daily-loss ${lossAfterFirst}→${lossAfterReplay} across a re-delivered interaction id ` +
        '(exactly-once expects both unchanged).',
      impact: 'A re-delivered casino interaction double-applied — the casino bet path persists no idempotency key (double-charge / double daily-loss on replay).',
    });
    proveBrandingFromBet(ctx, replayCaptured, econ);
  } else {
    ctx.gate(
      'replay-safety',
      'db-observable',
      'Re-delivering a resolved casino bet leaves exactly one wallet mutation and one daily-loss increment.',
      `${LOCK_GATE}; the GamesManager bet path also persists NO idempotency key (adjustBalance/economy_increment_daily_loss run unconditionally), so replay-safety is expected to FAIL once the bet path is drivable — flagged for owner adjudication`,
    );
    gateBranding(ctx);
  }

  await proveWalletRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx);
  gateLiveGuildReadback(ctx);
}

/** RESTART — daily-loss standing survives a full stack restart (the counter is DB-backed, not in-memory). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');

  // Boot #1: set the daily-loss cap, seed a member near it, snapshot, shut down.
  const first = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_games_enabled: true, economy_coinflip_max_bet: 500, economy_daily_loss_limit: 5000 },
  });
  await seedWallet(first, userA, 1000, 0);
  await seedDailyLoss(first, userA, 4000);
  const snapshotLoss = await readDailyLoss(first, userA);
  await first.cleanup(); // simulate a full shutdown (rows persist in Supabase)

  // Boot #2: SAME guild id (restart). The DB-backed counter and cap must be identical.
  const second = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_games_enabled: true, economy_coinflip_max_bet: 500, economy_daily_loss_limit: 5000 },
  });
  const afterLoss = await readDailyLoss(second, userA);
  const cfg = await readCasinoConfig(second);
  ctx.expect(afterLoss === snapshotLoss && afterLoss === 4000, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'After a full stack restart the accumulated daily losses match the pre-restart snapshot exactly (the counter is DB-backed, not in-memory).',
    observation: `pre-restart daily-loss=${snapshotLoss}; post-restart daily-loss=${afterLoss} (expected 4000).`,
    impact: 'Daily-loss standing did not survive the restart — the counter is not restart-durable and the cap could be bypassed by restarting.',
  });
  ctx.expect(cfg?.economy_daily_loss_limit === 5000, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The still-standing daily-loss cap persists across the restart.',
    observation: `post-restart guild_config.economy_daily_loss_limit = ${cfg?.economy_daily_loss_limit} (expected 5000).`,
    impact: 'The daily-loss cap did not survive the restart.',
  });

  // Post-restart enforcement (an over-cap wager is still refused; the lock TTL
  // self-heals) needs the Valkey lock — a driven bet would hang without Redis.
  ctx.gate(
    'Discord',
    'redis-dependency',
    'Post-restart a wager that would exceed the still-standing daily-loss cap is refused with the daily-cap reply, and the per-user lock TTL self-heals with no stuck lock.',
    LOCK_GATE,
  );

  await proveDailyLossRls(ctx, second, userA);
  await proveWalletRls(ctx, second, userA);
  await proveNoOwnerAlert(ctx, second);
  gateAudit(ctx);
  gateBranding(ctx);
  gateReplayDeferred(ctx, 'REPLAY / RACE');
  gateLiveGuildReadback(ctx);
}

/** RACE — concurrent casino commands from one member are safe: the per-user lock grants exactly one in-flight bet. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_games_enabled: true, economy_coinflip_max_bet: 500, economy_daily_loss_limit: 5000 },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');
  await seedWallet(handle, userA, 1000, 0);

  if (ctx.capabilities.redis) {
    const before = (await readWallet(handle, userA))?.wallet ?? -1;
    const beforeLoss = await readDailyLoss(handle, userA);
    const [c1, c2] = await Promise.all([
      ctx.runSlash(handle, { commandName: 'coinflip', userId: userA, options: { amount: 100 } }),
      ctx.runSlash(handle, { commandName: 'coinflip', userId: userA, options: { amount: 100 } }),
    ]);
    const after = (await readWallet(handle, userA))?.wallet ?? -1;
    const afterLoss = await readDailyLoss(handle, userA);
    const inProgress = [replyContent(c1), replyContent(c2)].filter((r) => /in progress/i.test(r)).length;
    ctx.expect(Math.abs(after - before) === 100 && inProgress === 1, {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Two simultaneous casino commands from one member yield exactly one accepted bet and one game-in-progress refusal; the wallet reflects only the single bet.',
      observation: `wallet Δ=${after - before} (one coinflip = ±100), game-in-progress refusals=${inProgress} of 2.`,
      impact: 'The per-user Valkey lock did not serialize concurrent bets — both applied or both refused (the daily-loss cap is bypassable by racing).',
    });
    ctx.expect(afterLoss - beforeLoss === 0 || afterLoss - beforeLoss === 100, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'The daily-loss counter reflects only the single accepted bet after a race (never both).',
      observation: `daily-loss Δ=${afterLoss - beforeLoss} (0 on a win, 100 on a loss; 200 would prove a bypass).`,
      impact: 'The daily-loss counter double-incremented under a race — the cap can be bypassed by racing two bets.',
    });
    proveBrandingFromBet(ctx, c1, econ);
  } else {
    ctx.gate(
      'Discord',
      'redis-dependency',
      'Two simultaneous casino commands yield exactly one accepted bet and one game-in-progress refusal.',
      `${LOCK_GATE} — the single-in-flight guarantee IS the Valkey SET NX lock, so it cannot be exercised without Redis`,
    );
    ctx.gate('replay-safety', 'db-observable', 'The daily-loss counter reflects only the single accepted bet after a race.', LOCK_GATE);
    gateBranding(ctx);
  }

  await proveWalletRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx);
  gateLiveGuildReadback(ctx);
}

/** XGUILD — the casino is strictly per-guild: caps, wallets, and daily-loss counters never cross guilds. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');

  const handleA = await ctx.bootGuild({
    guildId: guildA,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_games_enabled: true, economy_coinflip_max_bet: 500, economy_daily_loss_limit: 5000 },
  });
  const handleB = await ctx.bootGuild({
    guildId: guildB,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_games_enabled: true, economy_coinflip_max_bet: 2000, economy_daily_loss_limit: 20000 },
  });

  // Seed distinct wallets + daily-loss standings in each guild.
  await seedWallet(handleA, userA, 700, 0);
  await seedDailyLoss(handleA, userA, 300);
  const snapWalletA = await readWallet(handleA, userA);
  const snapLossA = await readDailyLoss(handleA, userA);

  await seedWallet(handleB, userA, 123, 0);
  await seedDailyLoss(handleB, userA, 999);
  const walletB = await readWallet(handleB, userA);
  const lossB = await readDailyLoss(handleB, userA);

  // Guild A is untouched by guild B activity; each guild's rows are distinct.
  const walletAAfter = await readWallet(handleA, userA);
  const lossAAfter = await readDailyLoss(handleA, userA);
  ctx.expect(
    walletAAfter?.wallet === snapWalletA?.wallet &&
      snapWalletA?.wallet === 700 &&
      lossAAfter === snapLossA &&
      snapLossA === 300 &&
      walletB?.wallet === 123 &&
      walletB?.guild_id === guildB &&
      lossB === 999,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'The same member playing in a second guild never touches the first guild’s wallet or daily-loss counter; each guild evolves independently.',
      observation:
        `guild A wallet=${walletAAfter?.wallet} (unchanged 700), loss=${lossAAfter} (unchanged 300); ` +
        `guild B wallet=${walletB?.wallet} under "${walletB?.guild_id}", loss=${lossB}.`,
      impact: 'Cross-guild casino activity mutated another guild’s wallet or daily-loss counter — per-guild isolation broken.',
    },
  );

  // Per-guild config isolation: the same controls carry different caps per guild.
  const cfgA = await readCasinoConfig(handleA);
  const cfgB = await readCasinoConfig(handleB);
  ctx.expect(
    cfgA?.economy_coinflip_max_bet === 500 &&
      cfgB?.economy_coinflip_max_bet === 2000 &&
      cfgA?.economy_daily_loss_limit === 5000 &&
      cfgB?.economy_daily_loss_limit === 20000,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'Each guild’s casino caps are independent: guild A coinflip 500 / daily-loss 5000, guild B coinflip 2000 / daily-loss 20000.',
      observation: `guild A coinflip=${cfgA?.economy_coinflip_max_bet}/loss=${cfgA?.economy_daily_loss_limit}; guild B coinflip=${cfgB?.economy_coinflip_max_bet}/loss=${cfgB?.economy_daily_loss_limit}.`,
      impact: 'A second guild’s casino config bled into the first — per-guild config isolation broken.',
    },
  );

  // A guild-B-scoped read returns B's row (123), a guild-A-scoped read returns A's (700).
  const { data: bScoped } = await handleB.supabase
    .from('economy_wallets')
    .select('wallet, guild_id')
    .eq('guild_id', guildB)
    .eq('user_id', userA)
    .maybeSingle();
  const { data: aScoped } = await handleA.supabase
    .from('economy_wallets')
    .select('wallet, guild_id')
    .eq('guild_id', guildA)
    .eq('user_id', userA)
    .maybeSingle();
  const bRow = bScoped as { wallet: number; guild_id: string } | null;
  const aRow = aScoped as { wallet: number; guild_id: string } | null;
  ctx.expect(bRow?.wallet === 123 && bRow?.guild_id === guildB && aRow?.wallet === 700 && aRow?.guild_id === guildA, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'Each guild scope reads its OWN casino wallet row and never the other’s (guild B → 123-coin row, guild A → 700-coin row).',
    observation: `guild-B-scoped read=${bRow?.wallet} under "${bRow?.guild_id}"; guild-A-scoped read=${aRow?.wallet} under "${aRow?.guild_id}".`,
    impact: 'A guild-scoped read returned the other guild’s wallet row — cross-guild leakage.',
  });
  await proveWalletRls(ctx, handleA, userA);

  // guild-B bets enforcing guild-B caps and debiting only guild B needs the lock
  // (a driven bet would hang without Redis).
  ctx.gate(
    'Discord',
    'redis-dependency',
    'guild B’s bets enforce guild B’s caps and debit only guild B’s wallet.',
    LOCK_GATE,
  );
  gateAudit(ctx);
  await proveNoOwnerAlert(ctx, handleA);
  gateBranding(ctx);
  gateReplayDeferred(ctx, 'REPLAY / RACE');
  gateLiveGuildReadback(ctx);
}

/** CLEANUP — the suite leaves no trace: run-prefixed casino rows are removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_games_enabled: true, economy_coinflip_max_bet: 500, economy_daily_loss_limit: 5000 },
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Create run-prefixed operational rows: two wallets + two daily-loss counters.
  await seedWallet(handle, userA, 500, 0);
  await seedWallet(handle, userB, 500, 0);
  await seedDailyLoss(handle, userA, 120);
  await seedDailyLoss(handle, userB, 80);

  const walletsBefore = (await walletCount(handle, userA)) + (await walletCount(handle, userB));
  const lossesBefore = (await dailyLossCount(handle, userA)) + (await dailyLossCount(handle, userB));
  ctx.expect(walletsBefore >= 2 && lossesBefore >= 2, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed wallet + daily-loss rows (pre-cleanup baseline).',
    observation: `pre-cleanup: wallet rows=${walletsBefore}, daily-loss rows=${lossesBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed casino rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveWalletRls(ctx, handle, userA);
  await proveDailyLossRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const walletsAfter = (await walletCount(handle, userA)) + (await walletCount(handle, userB));
  const lossesAfter = (await dailyLossCount(handle, userA)) + (await dailyLossCount(handle, userB));
  ctx.expect(walletsAfter === 0 && lossesAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed casino wallet + daily-loss rows are deleted; a final sweep finds zero run-prefixed casino resources.',
    observation: `post-sweep: wallet rows=${walletsAfter}, daily-loss rows=${lossesAfter}.`,
    impact: 'The cleanup sweep left run-prefixed casino rows behind — the suite leaves residue.',
  });

  // Channel-embed readback and the audit_logs anonymization lane are separate.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed casino result embeds or announcements after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational casino rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane (the casino operational rows are the DB-observable evidence here)',
  );
  gateReplayDeferred(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The casino domain proof: the guild_id-scoped tables the sweep must clear
 * (operational children first), plus the 12 scenario scripts. The casino writes
 * only economy_wallets + economy_daily_losses (+ owner alerts); guild_config and
 * guild are always swept by the runner.
 */
export const gameEconomyCasinoProof: DomainProof = {
  domainId: 'game-economy-casino',
  guildScopedTables: [
    'economy_daily_losses',
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
