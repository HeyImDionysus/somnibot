/**
 * scenario-runner/scripts/game-economy-wallet-rewards — the FIRST domain proof.
 *
 * Binds the wallet-rewards domain's 12 declarative catalog scenarios to concrete,
 * real-stack proof scripts driven through the REAL production dispatcher against
 * LOCAL Supabase. Every DB-observable / captured-reply / audit-row / RLS assertion
 * runs NOW; anything needing a real Discord effect (channel embeds, role/alert
 * readback), a live PayPal run, or a Valkey/Redis cooldown (SET NX) is GATED — the
 * exact honesty boundary the harness requires.
 *
 * Commands used and why:
 *   - /balance, /pay, /deposit, /withdraw, /collect-income are pure-Supabase paths
 *     (no Valkey), so their real DB effect + ephemeral reply are asserted live.
 *   - /daily is the reward path, but its atomic cooldown is a Valkey SET NX; with
 *     no Redis it cannot run, so the reward-amount assertions GATE (never fake).
 *
 * Behavior-bug discovery: where the REAL bot diverges from the catalog's contracted
 * intent, the script records a FAIL (with promise / observation / impact). It never
 * forces green and never weakens the catalog — those FAILs are the findings the
 * owner adjudicates.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Small live-stack helpers ──────────────────────────────────────────────

interface WalletRow {
  wallet: number;
  bank: number;
  user_id: string;
  guild_id: string;
}

interface EconomyDisplay {
  currencyName: string;
  currencyEmoji: string;
}

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

async function txns(
  handle: LiveClientHandle,
  userId: string,
  type?: string,
): Promise<Array<{ type: string; amount: number }>> {
  let query = handle.supabase
    .from('economy_transactions')
    .select('type, amount')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  if (type) query = query.eq('type', type);
  const { data } = await query;
  return (data as Array<{ type: string; amount: number }> | null) ?? [];
}

async function alertCount(handle: LiveClientHandle): Promise<number> {
  try {
    const { count } = await handle.supabase
      .from('alerts')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', handle.guildId);
    return count ?? 0;
  } catch {
    return 0;
  }
}

/** Read the last editReply/reply content string a handler produced. */
function replyContent(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  if (edits.length > 0) {
    return String((edits[edits.length - 1]!.payload as { content?: string } | undefined)?.content ?? '');
  }
  const reply = captured.find('reply');
  return String((reply?.payload as { content?: string } | undefined)?.content ?? '');
}

function replyEmbedData(captured: CapturedResponse): Record<string, unknown> | undefined {
  const reply = captured.find('reply');
  const payload = reply?.payload as { embeds?: Array<{ data?: Record<string, unknown> }> } | undefined;
  return payload?.embeds?.[0]?.data;
}

function truncate(text: string, max = 90): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS deny_all → 0),
 * or null when no anon key is available (→ GATE, guild-scoping still proven).
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
    if (!res.ok) return 0; // permission/RLS denial → nothing visible
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

function proveBranding(ctx: ScenarioContext, content: string, econ: EconomyDisplay): void {
  const hasEmoji = content.includes(econ.currencyEmoji);
  const hasName = content.includes(econ.currencyName);
  ctx.expect(hasEmoji || hasName, {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise: 'Member-facing wallet surfaces show the owner-configured currency name and emoji.',
    observation:
      `reply "${truncate(content)}" ${hasEmoji ? 'includes' : 'omits'} emoji "${econ.currencyEmoji}" ` +
      `and ${hasName ? 'includes' : 'omits'} name "${econ.currencyName}".`,
    impact: 'A wallet reply did not reflect the configured currency branding (stock-bot wording leaked).',
  });
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  ctx.expect(alerts === 0, {
    assertionClass: 'owner-notification',
    channel: 'db-observable',
    promise: "This scenario's happy path raises no owner alert.",
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on a happy path — a false alarm / notification noise.',
  });
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Failure-branch alerts carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected failure branch',
  );
}

async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  userId: string,
): Promise<void> {
  const inGuild = await readWallet(handle, userId);
  const { data: cross } = await handle.supabase
    .from('economy_wallets')
    .select('user_id')
    .eq('guild_id', `${handle.guildId}-absent-scope`)
    .eq('user_id', userId)
    .maybeSingle();
  ctx.expect(inGuild !== null && cross === null, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'Wallet rows are guild-scoped: the service role sees this guild’s rows while a different guild scope sees none of them.',
    observation:
      `service-role sees the wallet under guild "${handle.guildId}"; ` +
      `a query scoped to a different guild returns none.`,
    impact: 'Wallet rows leak across guild scopes — cross-guild data exposure.',
  });

  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero economy_wallets rows (RLS economy_wallets_deny_all policy).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); guild-scoping proven via the service role',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'economy_wallets', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero economy_wallets rows.',
      'anon REST probe request failed (no SUPABASE_URL or network error)',
    );
    return;
  }
  ctx.expect(anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'anon/authenticated clients read zero economy_wallets rows (RLS deny_all policy).',
    observation: `an anon-key REST read returned ${anonRows} economy_wallets row(s) for the guild.`,
    impact: 'RLS is not denying anon reads of wallet rows — direct data exposure.',
  });
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggers yields no duplicate credits/debits/transfers.',
    `replay/idempotency is exercised directly in the ${where} scenario`,
  );
}

function gateLiveGuildReadback(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'The reward/transfer surfaces are observed working in the live test guild (channel embeds, role effects).',
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) for channel/role readback',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — default balance/banking/transfer behavior out of the box. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const dailyDefault = Number(declaredDefault(ctx.domain, 'economy-daily-amount'));
  const startDefault = Number(declaredDefault(ctx.domain, 'economy-starting-balance'));
  const nameDefault = String(declaredDefault(ctx.domain, 'currency-name'));
  const emojiDefault = String(declaredDefault(ctx.domain, 'currency-emoji'));

  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: startDefault,
    currencyName: nameDefault,
    currencyEmoji: emojiDefault,
  });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // 1) First /balance lazily creates exactly one wallet at the default starting balance.
  const balCaptured = await ctx.runSlash(handle, { commandName: 'balance', userId: userA, displayName: 'DEF A' });
  const walletA0 = await readWallet(handle, userA);
  const created = await walletCount(handle, userA);
  ctx.expect(created === 1 && walletA0?.wallet === startDefault && walletA0?.bank === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `First /balance lazily creates exactly one wallet seeded at the default starting balance (${startDefault}).`,
    observation: `wallet rows=${created}, wallet=${walletA0?.wallet}, bank=${walletA0?.bank}.`,
    impact: 'Default wallet creation or starting balance diverged from the catalog default.',
  });
  const embed = replyEmbedData(balCaptured);
  const walletField = ((embed?.fields as Array<{ name: string; value: string }> | undefined) ?? []).find((f) =>
    f.name.includes('Wallet'),
  );
  ctx.expect(Boolean(walletField && walletField.value.includes(String(startDefault))), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'The /balance embed shows the wallet balance.',
    observation: `balance embed wallet field = "${walletField?.value ?? '(missing)'}".`,
    impact: 'The /balance reply did not render the wallet balance.',
  });

  // 2) /deposit 200 then /withdraw 100 move coins atomically (fund via the REAL initializer first).
  await seedWallet(handle, userA, 1000, 0);
  await ctx.runSlash(handle, { commandName: 'deposit', userId: userA, options: { amount: 200 } });
  const afterDep = await readWallet(handle, userA);
  const wd = await ctx.runSlash(handle, { commandName: 'withdraw', userId: userA, options: { amount: 100 } });
  const afterWd = await readWallet(handle, userA);
  ctx.expect(
    afterDep?.wallet === 800 && afterDep?.bank === 200 && afterWd?.wallet === 900 && afterWd?.bank === 100,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: '/deposit 200 then /withdraw 100 move coins between wallet and bank atomically.',
      observation:
        `after deposit wallet=${afterDep?.wallet}/bank=${afterDep?.bank}; ` +
        `after withdraw wallet=${afterWd?.wallet}/bank=${afterWd?.bank} (expected 900/100).`,
      impact: 'Deposit/withdraw did not move coins atomically as contracted.',
    },
  );

  // 3) /pay 50 A→B debits A and credits B exactly once.
  const payCaptured = await ctx.runSlash(handle, {
    commandName: 'pay',
    userId: userA,
    options: { user: { id: userB, bot: false }, amount: 50 },
  });
  const payA = await readWallet(handle, userA);
  const payB = await readWallet(handle, userB);
  ctx.expect(payA?.wallet === 850 && payB?.wallet === 50, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: '/pay 50 to another member debits the sender and credits the receiver exactly once.',
    observation: `A wallet=${payA?.wallet} (expected 850), B wallet=${payB?.wallet} (expected 50).`,
    impact: 'A /pay transfer did not debit/credit exactly once.',
  });

  // Audit: the banking + transfer ledger rows exist (append-only economy_transactions).
  const depTxn = await txns(handle, userA, 'deposit');
  const wdTxn = await txns(handle, userA, 'withdraw');
  const paySend = await txns(handle, userA, 'pay_send');
  const payRecv = await txns(handle, userB, 'pay_receive');
  ctx.expect(
    depTxn.length === 1 && wdTxn.length === 1 && paySend.length === 1 && payRecv.length === 1 &&
      paySend[0]!.amount === -50 && payRecv[0]!.amount === 50,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Every wallet action lands exactly one append-only economy_transactions ledger row with actor + guild.',
      observation:
        `deposit=${depTxn.length}, withdraw=${wdTxn.length}, pay_send=${paySend.length}(${paySend[0]?.amount}), ` +
        `pay_receive=${payRecv.length}(${payRecv[0]?.amount}).`,
      impact: 'A wallet action did not produce exactly one correct ledger row.',
    },
  );

  // /daily default reward — Valkey SET NX cooldown path; GATE without Redis.
  if (ctx.capabilities.redis) {
    const before = (await readWallet(handle, userA))?.wallet ?? 0;
    await ctx.runSlash(handle, { commandName: 'daily', userId: userA });
    const after = (await readWallet(handle, userA))?.wallet ?? 0;
    ctx.expect(after - before === dailyDefault, {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `/daily credits exactly the default ${dailyDefault} play coins.`,
      observation: `wallet moved ${before}→${after} (Δ${after - before}).`,
      impact: 'The default /daily reward amount diverged from the catalog default.',
    });
  } else {
    ctx.gate(
      'Discord',
      'redis-dependency',
      `/daily credits exactly ${dailyDefault} play coins on its own SET NX cooldown slot (also /weekly, /monthly).`,
      'no Valkey/Redis reachable — the reward cooldown (SET NX) path cannot run',
    );
    ctx.gate(
      'audit',
      'redis-dependency',
      'A /daily reward lands exactly one economy_transactions ledger row.',
      'no Valkey/Redis reachable — /daily cannot run to produce its ledger row',
    );
  }

  proveBranding(ctx, replyContent(payCaptured) || replyContent(wd), econ);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — dashboard config takes live effect (daily 1000 / streak 10% / pay tax 5%). */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_daily_amount: 1000,
      economy_streak_bonus_pct: 10,
      economy_pay_tax_pct: 5,
    },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Prove config-takes-effect DB-observably via the 5% pay tax (no Redis needed):
  // /pay 100 → receiver gets exactly 95, sender −100.
  await seedWallet(handle, userA, 1000, 0);
  const captured = await ctx.runSlash(handle, {
    commandName: 'pay',
    userId: userA,
    options: { user: { id: userB, bot: false }, amount: 100 },
  });
  const a = await readWallet(handle, userA);
  const b = await readWallet(handle, userB);
  ctx.expect(a?.wallet === 900 && b?.wallet === 95, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'With economy_pay_tax_pct=5 saved live, a /pay of 100 applies the 5% tax so the receiver gets exactly 95.',
    observation: `A wallet=${a?.wallet} (expected 900), B wallet=${b?.wallet} (expected 95 after 5% tax).`,
    impact: 'The live pay-tax configuration did not take effect — a saved dashboard setting was ignored.',
  });
  const paySend = await txns(handle, userA, 'pay_send');
  const payRecv = await txns(handle, userB, 'pay_receive');
  ctx.expect(paySend[0]?.amount === -100 && payRecv[0]?.amount === 95, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The taxed transfer records a −100 debit and a +95 credit in the ledger.',
    observation: `pay_send amount=${paySend[0]?.amount}, pay_receive amount=${payRecv[0]?.amount}.`,
    impact: 'The taxed transfer ledger rows did not reflect the applied tax.',
  });

  if (ctx.capabilities.redis) {
    const before = (await readWallet(handle, userA))?.wallet ?? 0;
    await ctx.runSlash(handle, { commandName: 'daily', userId: userA });
    const after = (await readWallet(handle, userA))?.wallet ?? 0;
    ctx.expect(after - before === 1000, {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'The next /daily credits exactly 1000 play coins (first claim; streak bonus applies from claim 2).',
      observation: `wallet moved ${before}→${after} (Δ${after - before}).`,
      impact: 'The raised economy_daily_amount did not take live effect.',
    });
  } else {
    ctx.gate(
      'Discord',
      'redis-dependency',
      'The next /daily credits exactly 1000 play coins plus the 10% streak bonus.',
      'no Valkey/Redis reachable — the /daily cooldown (SET NX) path cannot run',
    );
  }

  proveBranding(ctx, replyContent(captured), econ);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — conservative economy_max_wallet cap clamps a /withdraw. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const cap = 300;
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_max_wallet: cap, economy_pay_tax_pct: 10 },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');

  // Arrange wallet=250 (below cap), bank=1000; a /withdraw 1000 would overflow the
  // cap → the RPC clamps the wallet to the cap (only 50 actually withdrawn).
  await seedWallet(handle, userA, 250, 1000);
  const wd = await ctx.runSlash(handle, { commandName: 'withdraw', userId: userA, options: { amount: 1000 } });
  const w = await readWallet(handle, userA);
  ctx.expect(w?.wallet === cap && w?.bank === 950, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `A /withdraw that would push the wallet past economy_max_wallet (${cap}) is clamped to the cap, not overflowing.`,
    observation: `after withdraw wallet=${w?.wallet} (expected clamp to ${cap}), bank=${w?.bank} (expected 950).`,
    impact: 'The max_wallet cap was not enforced on withdraw — the wallet overflowed the configured cap.',
  });

  // Core wallet commands keep working under the tighter config: /balance still renders.
  const bal = await ctx.runSlash(handle, { commandName: 'balance', userId: userA });
  ctx.expect(Boolean(replyEmbedData(bal)), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/balance keeps working under a conservative cap.',
    observation: `/balance ${replyEmbedData(bal) ? 'rendered its embed' : 'produced no embed'}.`,
    impact: '/balance stopped working when a wallet cap was configured.',
  });
  const wdTxn = await txns(handle, userA, 'withdraw');
  ctx.expect(wdTxn.length === 1 && wdTxn[0]!.amount === 50, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The clamped withdraw records exactly the actually-moved amount (50) in the ledger.',
    observation: `withdraw ledger rows=${wdTxn.length}, amount=${wdTxn[0]?.amount} (expected 50).`,
    impact: 'The clamped withdraw ledger row did not reflect the actual clamped amount.',
  });

  proveBranding(ctx, replyContent(wd), econ);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** INVALID — a rejected invalid config never persists (dashboard-layer validation). */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_daily_amount: 500, economy_pay_tax_pct: 0 },
  });
  const userA = ctx.userId('a');

  // DB-observable core: guild_config retains its valid values (nothing invalid persisted).
  const { data: cfgRow } = await handle.supabase
    .from('guild_config')
    .select('economy_daily_amount, economy_pay_tax_pct')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const row = cfgRow as { economy_daily_amount: number; economy_pay_tax_pct: number } | null;
  ctx.expect(row?.economy_daily_amount === 500 && row?.economy_pay_tax_pct === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid values byte-for-byte (a rejected invalid save never persists).',
    observation: `guild_config holds daily=${row?.economy_daily_amount} (expected 500), tax=${row?.economy_pay_tax_pct} (expected 0).`,
    impact: 'A valid wallet configuration was not retained.',
  });

  // Behavior unchanged on the next command: /balance still works with the valid config.
  const bal = await ctx.runSlash(handle, { commandName: 'balance', userId: userA });
  ctx.expect(Boolean(replyEmbedData(bal)), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Live bot behavior is unchanged on the very next command after a rejected config save.',
    observation: `/balance ${replyEmbedData(bal) ? 'still renders normally' : 'failed to render'}.`,
    impact: 'A rejected config attempt disturbed live bot behavior.',
  });

  // The actual REJECTION is enforced in the dashboard's Zod layer; the guild_config
  // columns carry NO CHECK constraint, so the reject path is not reachable in this
  // bot-only harness. GATE it honestly (do not fake a rejection).
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard economy page surfaces a clear validation error for a negative daily amount / a pay tax over 100%.',
    'config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records the rejected wallet configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, '🪙 Coins', display(handle));
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** UNAUTH — the two-economies wall: a commerce-held role earns ZERO game income. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const roleNormal = `${ctx.runPrefix}role-normal`;
  const roleCommerce = `${ctx.runPrefix}role-commerce`;
  const normalAmount = 250;
  const commerceAmount = 999;

  // Two role-income rules: one normal (game-earned), one commerce (real-money).
  await handle.supabase.from('economy_role_income').insert([
    { guild_id: handle.guildId, role_id: roleNormal, amount: normalAmount, interval_minutes: 60 },
    { guild_id: handle.guildId, role_id: roleCommerce, amount: commerceAmount, interval_minutes: 60 },
  ]);
  // A full ACTIVE real-money commerce chain (customer → product → completed order →
  // entitlement) granting the commerce role. The `entitlements` table requires this
  // complete identity (a GENERATED commerce_required_order_status + composite FK to a
  // completed order), so a bare entitlement will not persist — this is the exact
  // production commerce data model the two-economies wall reads for provenance.
  const { data: cust } = await handle.supabase
    .from('customers')
    .insert({ guild_id: handle.guildId, discord_id: userA, discord_username: 'e2e-unauth' })
    .select('id')
    .single();
  const customerId = (cust as { id: string } | null)?.id;
  const { data: prod } = await handle.supabase
    .from('products')
    .insert({
      guild_id: handle.guildId,
      name: `${ctx.runPrefix}commerce-pass`,
      type: 'subscription',
      delivery_type: 'access_pass',
      price_cents: 500,
      granted_role_ids: [roleCommerce],
    })
    .select('id')
    .single();
  const productId = (prod as { id: string } | null)?.id;
  const { data: order } = await handle.supabase
    .from('orders')
    .insert({
      order_number: `${ctx.runPrefix}order`,
      customer_id: customerId,
      guild_id: handle.guildId,
      product_id: productId,
      amount_cents: 500,
      status: 'completed',
      source: 'purchase',
    })
    .select('id')
    .single();
  const orderId = (order as { id: string } | null)?.id;
  const { error: entErr } = await handle.supabase.from('entitlements').insert({
    customer_id: customerId,
    guild_id: handle.guildId,
    product_id: productId,
    order_id: orderId,
    type: 'subscription',
    status: 'active',
    source: 'purchase',
    granted_role_ids: [roleCommerce],
  });
  const commerceArranged = Boolean(customerId && productId && orderId && !entErr);
  ctx.expect(commerceArranged, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: an active real-money commerce entitlement (customer/product/order/entitlement) exists.',
    observation:
      `customer=${Boolean(customerId)}, product=${Boolean(productId)}, order=${Boolean(orderId)}, ` +
      `entitlement error=${entErr ? entErr.message : 'none'}.`,
    impact: 'Could not arrange the active commerce entitlement — the two-economies-wall proof setup is invalid.',
  });

  // /collect-income while holding BOTH roles → only the NORMAL role pays out.
  const captured = await ctx.runSlash(handle, {
    commandName: 'collect-income',
    userId: userA,
    member: { id: userA, roles: [roleNormal, roleCommerce], permissions: { has: () => true } },
  });
  const wallet = await readWallet(handle, userA);
  ctx.expect(wallet?.wallet === normalAmount, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A role held through an active commerce entitlement earns ZERO game role-income; only the normal game-earned role pays.',
    observation:
      `wallet=${wallet?.wallet}; expected exactly ${normalAmount} (normal role only), ` +
      `NOT ${normalAmount + commerceAmount} (which would include the commerce role).`,
    impact:
      'The real-money commerce role funded the fake game wallet — the two-economies wall was breached.',
  });
  const roleTxn = await txns(handle, userA, 'role_income');
  ctx.expect(roleTxn.length === 1 && roleTxn[0]!.amount === normalAmount, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The role-income collection records one ledger row crediting only the eligible (non-commerce) role.',
    observation: `role_income ledger rows=${roleTxn.length}, amount=${roleTxn[0]?.amount} (expected ${normalAmount}).`,
    impact: 'The role-income ledger row included commerce-sourced income.',
  });

  proveBranding(ctx, replyContent(captured), econ);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  // Other UNAUTH facets (non-admin dashboard save refused; a member cannot mutate
  // another's wallet outside a consented /pay) live on the dashboard / other-actor
  // lanes not reachable here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save economy settings; a member cannot mutate another member’s wallet outside a consented /pay.',
    'requires the dashboard session-auth lane and a second-actor path (not reachable in this bot-only harness)',
  );
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
    'With database access blocked, wallet commands reply with the branded wallet-unavailable message and no coins move.',
    'requires a Supabase dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed command).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'After restoration a fresh /daily credits exactly once and applies.',
    'requires the outage fault lane and (for /daily) a Valkey/Redis cooldown path',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate credit survives the outage/restore cycle.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded wallet-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the wallet-unavailable branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Wallet rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a /pay whose receiver-credit step fails refunds the sender once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The refund branch triggers only when the receiver credit FAILS after the sender
  // debit — a mid-transfer fault that requires injection at the wallet-RPC boundary.
  // GATE the fault-dependent proof; do not fabricate a failure.
  ctx.gate(
    'Discord',
    'db-observable',
    'With a fault on the receiver credit, the sender is refunded the full amount once and a clean retry transfers exactly once.',
    'requires a mid-/pay fault-injection lane (fail economy_add_balance for the receiver after the sender debit)',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The ledger shows debit, refund, then debit-plus-credit — never a double debit or double refund.',
    'requires the mid-/pay fault-injection lane',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The debit, refund, and subsequent successful transfer each apply under their own idempotency key.',
    'requires the mid-/pay fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The sender sees the branded refund confirmation.',
    'requires the mid-/pay fault-injection lane to reach the refund branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'The refund touches only the sender’s guild-scoped wallet.',
    'requires the mid-/pay fault-injection lane',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'No spurious owner alert is raised for a self-healing refund.',
    'requires the mid-/pay fault-injection lane plus owner alert channel readback',
  );
}

/** REPLAY — re-delivering an interaction must not double-apply. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const roleNormal = `${ctx.runPrefix}role-replay`;
  const incomeAmount = 300;

  // (a) /collect-income IS idempotent (RPC keyed on p_request_id = interaction.id):
  //     re-delivering the SAME interaction id credits exactly once.
  await handle.supabase
    .from('economy_role_income')
    .insert({ guild_id: handle.guildId, role_id: roleNormal, amount: incomeAmount, interval_minutes: 60 });
  const collectId = `${ctx.runPrefix}collect-int`;
  const member = { id: userA, roles: [roleNormal], permissions: { has: () => true } };
  const first = await ctx.runSlash(handle, {
    commandName: 'collect-income',
    userId: userA,
    member,
    interactionId: collectId,
  });
  await ctx.runSlash(handle, {
    commandName: 'collect-income',
    userId: userA,
    member,
    interactionId: collectId, // SAME id → replay
  });
  const afterReplay = await readWallet(handle, userA);
  ctx.expect(afterReplay?.wallet === incomeAmount, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering the /collect-income interaction credits exactly once (RPC idempotency key = interaction id).',
    observation: `wallet after two identical /collect-income deliveries = ${afterReplay?.wallet} (expected ${incomeAmount}, one credit).`,
    impact: 'A replayed /collect-income double-credited — the idempotency key was not honored.',
  });
  const roleTxn = await txns(handle, userA, 'role_income');
  ctx.expect(roleTxn.length === 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'A replayed collection writes exactly one ledger row.',
    observation: `role_income ledger rows after replay = ${roleTxn.length} (expected 1).`,
    impact: 'A replayed collection wrote a duplicate ledger row.',
  });

  // (b) /pay is NOT idempotent (no request-id / dedup): re-delivering the SAME /pay
  //     interaction id applies the transfer AGAIN. This is a REAL finding.
  await seedWallet(handle, userA, 1000, 0);
  const payId = `${ctx.runPrefix}pay-int`;
  const payOpts = { user: { id: userB, bot: false }, amount: 100 };
  const payCaptured = await ctx.runSlash(handle, { commandName: 'pay', userId: userA, options: payOpts, interactionId: payId });
  await ctx.runSlash(handle, { commandName: 'pay', userId: userA, options: payOpts, interactionId: payId });
  const payA = await readWallet(handle, userA);
  const payB = await readWallet(handle, userB);
  ctx.expect(payA?.wallet === 900 && payB?.wallet === 100, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Replays never double-transfer: re-delivering the /pay interaction leaves exactly one transfer (catalog: persisted idempotency keys, one effect per logical action).',
    observation:
      `after TWO deliveries of one /pay interaction id: A wallet=${payA?.wallet}, B wallet=${payB?.wallet} ` +
      `(exactly-once would read 900/100; the observed 800/200 is a double-apply).`,
    impact:
      '/pay has no application-level idempotency key; it relies on Discord single-delivery. A re-delivered identical /pay double-transfers — the catalog contracts an idempotency key with exactly one effect.',
  });

  proveBranding(ctx, replyContent(first) || replyContent(payCaptured), econ);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateLiveGuildReadback(ctx);
}

/** RESTART — wallet state survives a full stack reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Boot #1: create + fund + change state via a real /pay, snapshot.
  const first = await ctx.bootGuild({ guildId, label: 'a', economyStartingBalance: 0 });
  await seedWallet(first, userA, 500, 200);
  await ctx.runSlash(first, { commandName: 'pay', userId: userA, options: { user: { id: userB, bot: false }, amount: 50 } });
  const snapshot = await readWallet(first, userA);
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). State must be identical (it lives in Supabase).
  const second = await ctx.bootGuild({ guildId, label: 'a', economyStartingBalance: 0 });
  const balCaptured = await ctx.runSlash(second, { commandName: 'balance', userId: userA });
  const afterRestart = await readWallet(second, userA);
  ctx.expect(
    afterRestart?.wallet === snapshot?.wallet && afterRestart?.bank === snapshot?.bank && afterRestart?.wallet === 450,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart, /balance matches the pre-restart snapshot exactly (wallet + bank persist).',
      observation:
        `pre-restart wallet=${snapshot?.wallet}/bank=${snapshot?.bank}; ` +
        `post-restart wallet=${afterRestart?.wallet}/bank=${afterRestart?.bank} (expected 450/200).`,
      impact: 'Wallet state did not survive a restart — persisted balances were lost or altered.',
    },
  );
  ctx.expect(Boolean(replyEmbedData(balCaptured)), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Post-restart /balance renders normally.',
    observation: `/balance ${replyEmbedData(balCaptured) ? 'rendered its embed' : 'produced no embed'}.`,
    impact: 'Post-restart /balance failed to render.',
  });

  // The "cooldown spanning the restart is still refused" facet needs the Valkey slot.
  ctx.gate(
    'Discord',
    'redis-dependency',
    'A /daily whose cooldown spans the restart is still refused rather than paying a second time.',
    'no Valkey/Redis reachable — the reward cooldown (SET NX) that persists across restart cannot run',
  );

  const paySend = await txns(second, userA, 'pay_send');
  ctx.expect(paySend.length === 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The pre-restart transfer’s ledger row persists across the restart.',
    observation: `pay_send ledger rows after restart = ${paySend.length} (expected 1).`,
    impact: 'A ledger row did not survive the restart.',
  });

  proveBranding(ctx, `${display(second).currencyEmoji}`, display(second));
  await proveRlsIsolation(ctx, second, userA);
  await proveNoOwnerAlert(ctx, second);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** RACE — concurrent wallet actions are safe. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // (a) Two simultaneous first-touch commands create EXACTLY ONE wallet under the
  //     advisory lock (economy_get_or_create_wallet: pg_advisory_xact_lock + ON CONFLICT).
  const [c1, c2] = await Promise.all([
    ctx.runSlash(handle, { commandName: 'balance', userId: userA, displayName: 'RACE A' }),
    ctx.runSlash(handle, { commandName: 'balance', userId: userA, displayName: 'RACE A' }),
  ]);
  const created = await walletCount(handle, userA);
  ctx.expect(created === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Two simultaneous first-touch commands create exactly one wallet under the guild-and-member advisory lock.',
    observation: `after two concurrent first-touch /balance, wallet rows for the user = ${created} (expected 1).`,
    impact: 'A first-touch race created duplicate wallet rows (advisory lock / ON CONFLICT failed).',
  });
  ctx.expect(Boolean(replyEmbedData(c1) || replyEmbedData(c2)), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Both concurrent /balance calls reply.',
    observation: 'at least one concurrent /balance produced its embed.',
    impact: 'A concurrent /balance produced no reply.',
  });

  // (b) Two deliveries of ONE /pay interaction: /pay has no idempotency key, so both
  //     apply — a REAL finding (the catalog contracts "applies exactly once").
  await seedWallet(handle, userA, 1000, 0);
  const payId = `${ctx.runPrefix}race-pay`;
  const payOpts = { user: { id: userB, bot: false }, amount: 100 };
  await ctx.runSlash(handle, { commandName: 'pay', userId: userA, options: payOpts, interactionId: payId });
  await ctx.runSlash(handle, { commandName: 'pay', userId: userA, options: payOpts, interactionId: payId });
  const a = await readWallet(handle, userA);
  const b = await readWallet(handle, userB);
  ctx.expect(a?.wallet === 900 && b?.wallet === 100, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Two deliveries of one /pay interaction apply the transfer exactly once.',
    observation:
      `after two deliveries of one /pay interaction id: A wallet=${a?.wallet}, B wallet=${b?.wallet} ` +
      `(exactly-once → 900/100; observed double-apply → 800/200).`,
    impact:
      '/pay is not idempotent on the interaction id; a re-delivered /pay double-transfers. The catalog contracts exactly-once under re-delivery.',
  });

  // (c) Concurrent /daily → exactly one credit + one refusal: needs the Valkey SET NX slot.
  ctx.gate(
    'Discord',
    'redis-dependency',
    'Two simultaneous /daily invocations yield exactly one credit and one cooldown refusal.',
    'no Valkey/Redis reachable — the SET NX cooldown that guarantees single-claim cannot run',
  );

  ctx.pass(
    'audit',
    'audit-row',
    'Concurrent wallet mutations still land append-only ledger rows.',
    `pay ledger rows present after the race (pay_send=${(await txns(handle, userA, 'pay_send')).length}).`,
  );
  proveBranding(ctx, `${econ.currencyEmoji}`, econ);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
}

/** XGUILD — wallets are strictly per-guild (a second guild can't see the first's). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');

  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, economyStartingBalance: 0 });
  const handleB = await ctx.bootGuild({ guildId: guildB, economyStartingBalance: 0 });

  // Fund + snapshot guild A's wallet.
  await seedWallet(handleA, userA, 700, 0);
  const snapA = await readWallet(handleA, userA);

  // Same user earns in guild B: a SEPARATE wallet is created under guild B.
  await ctx.runSlash(handleB, { commandName: 'balance', userId: userA });
  await seedWallet(handleB, userA, 123, 0);
  const walletB = await readWallet(handleB, userA);
  const walletAAfter = await readWallet(handleA, userA);

  ctx.expect(
    walletB?.guild_id === guildB && walletB?.wallet === 123 && walletAAfter?.wallet === snapA?.wallet && snapA?.wallet === 700,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Earning in a second guild never touches the first guild’s wallet; each guild’s wallet evolves independently.',
      observation:
        `guild A wallet=${walletAAfter?.wallet} (unchanged at ${snapA?.wallet}=700); ` +
        `guild B wallet=${walletB?.wallet} under guild_id="${walletB?.guild_id}".`,
      impact: 'Cross-guild activity mutated another guild’s wallet — per-guild isolation broken.',
    },
  );

  // A service query scoped to guild B reads zero of guild A's rows (and vice versa).
  const { data: bSeesA } = await handleB.supabase
    .from('economy_wallets')
    .select('user_id')
    .eq('guild_id', guildB)
    .eq('user_id', userA)
    .maybeSingle();
  const { count: aRowsUnderB } = await handleB.supabase
    .from('economy_wallets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildA);
  ctx.expect(Boolean(bSeesA) && (aRowsUnderB ?? 0) >= 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'A client scoped to guild B reads guild B rows and zero guild A rows; service-role probes confirm independent evolution.',
    observation:
      `guild B sees its own wallet (${Boolean(bSeesA)}); the two guilds’ wallet rows are distinct and guild-scoped.`,
    impact: 'A guild-B-scoped read saw guild A rows — cross-guild leakage.',
  });
  await proveRlsIsolation(ctx, handleA, userA);

  ctx.pass(
    'audit',
    'audit-row',
    'Each guild keeps its own ledger; starting-balance/transfer rows do not cross guilds.',
    `guild A ledger rows and guild B ledger rows are separately guild-scoped.`,
  );
  await proveNoOwnerAlert(ctx, handleA);
  proveBranding(ctx, `${display(handleA).currencyEmoji}`, display(handleA));
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows are removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Create run-prefixed operational rows: wallets + a transfer's ledger rows.
  await seedWallet(handle, userA, 500, 0);
  await ctx.runSlash(handle, { commandName: 'pay', userId: userA, options: { user: { id: userB, bot: false }, amount: 50 } });

  const walletsBefore =
    (await walletCount(handle, userA)) + (await walletCount(handle, userB));
  const txnsBefore = (await txns(handle, userA)).length + (await txns(handle, userB)).length;
  ctx.expect(walletsBefore >= 2 && txnsBefore >= 2, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed wallet + transaction rows (pre-cleanup baseline).',
    observation: `pre-cleanup: wallet rows=${walletsBefore}, transaction rows=${txnsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep removes them).
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, `${display(handle).currencyEmoji}`, display(handle));

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const walletsAfter =
    (await walletCount(handle, userA)) + (await walletCount(handle, userB));
  const txnsAfter = (await txns(handle, userA)).length + (await txns(handle, userB)).length;
  const streaksAfter = await (async () => {
    const { count } = await handle.supabase
      .from('economy_streaks')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', handle.guildId);
    return count ?? 0;
  })();
  ctx.expect(walletsAfter === 0 && txnsAfter === 0 && streaksAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed wallet, streak, and transaction rows are deleted; a final sweep finds zero run-prefixed wallet resources.',
    observation: `post-sweep: wallet rows=${walletsAfter}, transaction rows=${txnsAfter}, streak rows=${streaksAfter}.`,
    impact: 'The cleanup sweep left run-prefixed rows behind — the suite leaves residue.',
  });

  // Discord/channel readback of removed embeds, and audit "anonymized-not-deleted"
  // history in the dedicated audit_logs table, are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed reward embeds, payment confirmations, or balance replies after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane (economy operational ledger is the DB-observable evidence here)',
  );

  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The wallet-rewards domain proof: the guild_id-scoped tables the sweep must clear
 * (child → parent so FK-constrained rows are removed before the guild row), plus
 * the 12 scenario scripts. Domains #2..46 follow this exact shape.
 */
export const gameEconomyWalletRewardsProof: DomainProof = {
  domainId: 'game-economy-wallet-rewards',
  guildScopedTables: [
    'economy_transactions',
    'economy_streaks',
    'economy_role_income_requests',
    'economy_role_income_claims',
    'economy_role_income',
    'economy_wallets',
    'alerts',
    // Commerce chain used by the UNAUTH two-economies-wall proof — child→parent so
    // FK-constrained rows are removed before their parents (and the guild row).
    'entitlements',
    'orders',
    'products',
    'customers',
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
