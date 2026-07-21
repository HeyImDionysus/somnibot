/**
 * scenario-runner/scripts/community-polls-predictions — the Polls & Predictions domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete, real-stack proof
 * scripts driven against LOCAL Supabase. Every DB-observable / RLS / owner-alert
 * assertion runs NOW against the SAME production primitives the bot uses; the live
 * Discord reply surfaces are GATED — the exact honesty boundary the harness requires.
 *
 * ── Why the member REPLY side is GATED (same posture as game-economy-adventures) ──
 * Every entrypoint here is a slash SUBCOMMAND (`/poll create|close`,
 * `/predict create|bet|resolve`) and voting is a Discord BUTTON (`poll:{id}:{opt}`).
 * `ScenarioContext.runSlash` carries NO subcommand field and the injector builds a
 * subcommand-less interaction, so each handler's first line
 * `interaction.options.getSubcommand()` would throw before any work runs; there is
 * likewise no button-injection helper on the context. Driving the live embeds/tally
 * replies therefore CANNOT happen in this bot-only harness and is GATED — never faked.
 *
 * ── What IS proven NOW, non-vacuously ──
 * The handlers are thin orchestrations over primitives that ARE drivable directly
 * against local Supabase — the EXACT RPCs / constraint-guarded inserts / UPDATE gates
 * the bot itself runs:
 *   - poll rows + options land the same shape `createPoll` writes (status defaults to
 *     'active' via the DB default, the exact value the vote/close paths read);
 *   - single-choice voting is the bot's own `poll_vote_switch_single` RPC (atomic
 *     replace-prior-vote, so a re-vote switches the member's choice);
 *   - `prediction_bets` UNIQUE(prediction_id,user_id) + CHECK(amount>0) are the exact
 *     gates `placeBet` relies on for dedupe and amount validation;
 *   - the ticket debit / pool increment / winner payout use the EXACT RPCs
 *     `economy_subtract_balance` / `economy_increment_prediction_pool` /
 *     `economy_add_balance`;
 *   - settlement's exactly-once guarantee is the bot's own `predictions_resolve_atomic`
 *     (atomic open→resolved flip returning the locked pool; a re-call returns nothing);
 *   - the per-bet `payout` marker is the idempotent settlement marker the catalog names;
 *   - polls / predictions / prediction_bets are guild-scoped with anon REVOKEd by the
 *     RLS lockdown (service role sees the row an anon/second-guild client must not).
 *
 * ── Behavior bugs surfaced as DB-observable FAILs (never softened) ──
 *   1. /poll close is unsatisfiable: polls are created at status 'active' (DB default,
 *      and the polls CHECK only allows 'active'|'closed'), but `closePoll`'s atomic
 *      flip filters `... WHERE status = 'open'` — a value the constraint forbids — so
 *      the UPDATE matches zero rows and every close no-ops as "already closed" with no
 *      tally ever posted. Proven by running that exact UPDATE against a real poll.
 *   2. SET-A's raised minimum bet (100) has no implementation: guild_config has no
 *      `prediction_min_bet` column and `prediction_bets` has no floor beyond
 *      CHECK(amount>0), so a 50-coin bet persists. Proven by the column read erroring
 *      and the sub-minimum bet row inserting.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes ────────────────────────────────────────────────────────────

interface PollRow {
  id: string;
  guild_id: string;
  status: string;
  title: string;
  allow_multiple: boolean;
  closed_at: string | null;
  creator_user_id: string;
}

interface PredictionRow {
  id: string;
  guild_id: string;
  status: string;
  total_pool: number;
  winning_option_id: string | null;
  creator_user_id: string;
}

interface BetRow {
  id: string;
  user_id: string;
  option_id: string;
  amount: number;
  payout: number | null;
  guild_id: string;
}

interface WalletRow {
  wallet: number;
  user_id: string;
  guild_id: string;
}

interface OptionRow {
  id: string;
  sort_order: number;
}

interface PollHandle {
  pollId: string;
  optionIds: string[];
}

interface PredictionHandle {
  predictionId: string;
  optionIds: string[];
}

/** A minimal PostgREST error surface (code + message) for insert/RPC results. */
type PgErr = { code?: string; message?: string } | null;

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/**
 * Boot a guild with polls + predictions enabled (the DB columns default to false, so
 * they must be seeded to reflect a live guild whose owner turned the features on). The
 * primitives run regardless of the flags, but seeding them keeps the fixture faithful.
 */
async function bootPollsPredictions(
  ctx: ScenarioContext,
  opts: { label?: string; guildId?: string; pollsEnabled?: boolean; predictionsEnabled?: boolean } = {},
): Promise<LiveClientHandle> {
  return ctx.bootGuild({
    label: opts.label,
    guildId: opts.guildId,
    economyStartingBalance: 0,
    guildConfigOverrides: {
      polls_enabled: opts.pollsEnabled ?? true,
      predictions_enabled: opts.predictionsEnabled ?? true,
    },
  });
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

/** Arrange an exact play-money wallet via the REAL wallet initializer, then a precise set. */
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

async function walletCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_wallets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

/** Insert a poll + its options exactly as `createPoll` does (status left to the DB default). */
async function createPollRows(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  creator: string,
  labels: string[],
  allowMultiple: boolean,
): Promise<PollHandle> {
  const { data: poll } = await handle.supabase
    .from('polls')
    .insert({
      guild_id: handle.guildId,
      channel_id: `${ctx.runPrefix}chan`,
      creator_user_id: creator,
      title: `${ctx.runPrefix}poll`,
      allow_multiple: allowMultiple,
    })
    .select('id')
    .single();
  const pollId = (poll as { id: string } | null)?.id ?? '';
  const { data: opts } = await handle.supabase
    .from('poll_options')
    .insert(labels.map((label, i) => ({ poll_id: pollId, label, sort_order: i })))
    .select('id, sort_order')
    .limit(1000);
  const optionIds = ((opts as OptionRow[] | null) ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((o) => o.id);
  return { pollId, optionIds };
}

async function readPoll(handle: LiveClientHandle, pollId: string): Promise<PollRow | null> {
  const { data } = await handle.supabase
    .from('polls')
    .select('id, guild_id, status, title, allow_multiple, closed_at, creator_user_id')
    .eq('id', pollId)
    .maybeSingle();
  return (data as PollRow | null) ?? null;
}

async function countPollOptions(handle: LiveClientHandle, pollId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('poll_options')
    .select('*', { count: 'exact', head: true })
    .eq('poll_id', pollId);
  return count ?? 0;
}

/** The EXACT single-choice vote primitive the bot runs: an atomic switch that
 * removes the member's prior vote on the poll and records the new option. */
async function voteSingle(
  handle: LiveClientHandle,
  pollId: string,
  optionId: string,
  userId: string,
): Promise<{ inserted: number; error: PgErr }> {
  const { data, error } = await handle.supabase.rpc('poll_vote_switch_single', {
    p_poll_id: pollId,
    p_option_id: optionId,
    p_user_id: userId,
  });
  const rows = Array.isArray(data) ? data.length : data ? 1 : 0;
  return { inserted: rows, error: (error as PgErr) ?? null };
}

/** The EXACT multi-choice vote primitive (direct insert gated by UNIQUE(poll_id,option_id,user_id)). */
async function voteMulti(
  handle: LiveClientHandle,
  pollId: string,
  optionId: string,
  userId: string,
): Promise<PgErr> {
  const { error } = await handle.supabase
    .from('poll_votes')
    .insert({ poll_id: pollId, option_id: optionId, user_id: userId });
  return (error as PgErr) ?? null;
}

async function pollVotesFor(
  handle: LiveClientHandle,
  pollId: string,
  userId?: string,
): Promise<Array<{ option_id: string; user_id: string }>> {
  let query = handle.supabase.from('poll_votes').select('option_id, user_id').eq('poll_id', pollId);
  if (userId) query = query.eq('user_id', userId);
  const { data } = await query.limit(1000);
  return (data as Array<{ option_id: string; user_id: string }> | null) ?? [];
}

/**
 * Run the EXACT atomic status flip `closePoll` runs after its creator check:
 * `UPDATE polls SET status='closed', closed_at=now() WHERE id=? AND status='open'`.
 * Returns how many rows it actually flipped (the bot treats 0 as "already closed").
 */
async function attemptClose(handle: LiveClientHandle, pollId: string): Promise<number> {
  const { data } = await handle.supabase
    .from('polls')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', pollId)
    .eq('status', 'open')
    .select('id')
    .limit(1000);
  return ((data as Array<{ id: string }> | null) ?? []).length;
}

/** Insert a prediction + its options exactly as `createPrediction` does (status defaults to 'open'). */
async function createPredictionRows(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  creator: string,
  labels: string[],
): Promise<PredictionHandle> {
  const { data: pred } = await handle.supabase
    .from('predictions')
    .insert({
      guild_id: handle.guildId,
      channel_id: `${ctx.runPrefix}chan`,
      creator_user_id: creator,
      title: `${ctx.runPrefix}prediction`,
    })
    .select('id')
    .single();
  const predictionId = (pred as { id: string } | null)?.id ?? '';
  const { data: opts } = await handle.supabase
    .from('prediction_options')
    .insert(labels.map((label, i) => ({ prediction_id: predictionId, label, sort_order: i })))
    .select('id, sort_order')
    .limit(1000);
  const optionIds = ((opts as OptionRow[] | null) ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((o) => o.id);
  return { predictionId, optionIds };
}

async function readPrediction(handle: LiveClientHandle, predictionId: string): Promise<PredictionRow | null> {
  const { data } = await handle.supabase
    .from('predictions')
    .select('id, guild_id, status, total_pool, winning_option_id, creator_user_id')
    .eq('id', predictionId)
    .maybeSingle();
  return (data as PredictionRow | null) ?? null;
}

async function betsFor(
  handle: LiveClientHandle,
  predictionId: string,
  userId?: string,
): Promise<BetRow[]> {
  let query = handle.supabase
    .from('prediction_bets')
    .select('id, user_id, option_id, amount, payout, guild_id')
    .eq('prediction_id', predictionId);
  if (userId) query = query.eq('user_id', userId);
  const { data } = await query.limit(1000);
  return (data as BetRow[] | null) ?? [];
}

/**
 * Reproduce `placeBet`'s exact ordered primitives: insert the bet FIRST (so the
 * UNIQUE(prediction_id,user_id) constraint is the authoritative gate), then debit via
 * `economy_subtract_balance`, then bump the pool via `economy_increment_prediction_pool`.
 * Surfaces each step's error so a caller can assert the exact-once money movement.
 */
async function placeBet(
  handle: LiveClientHandle,
  predictionId: string,
  optionId: string,
  userId: string,
  amount: number,
): Promise<{ betId: string | null; insertErr: PgErr; debitErr: PgErr; newPool: number | null }> {
  const { data: bet, error: insertErr } = await handle.supabase
    .from('prediction_bets')
    .insert({
      prediction_id: predictionId,
      option_id: optionId,
      guild_id: handle.guildId,
      user_id: userId,
      amount,
    })
    .select('id')
    .single();
  const betId = (bet as { id: string } | null)?.id ?? null;
  if (insertErr || !betId) {
    return { betId: null, insertErr: (insertErr as PgErr) ?? null, debitErr: null, newPool: null };
  }
  const { error: debitErr } = await handle.supabase.rpc('economy_subtract_balance', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
  if (debitErr) {
    await handle.supabase.from('prediction_bets').delete().eq('id', betId);
    return { betId: null, insertErr: null, debitErr: (debitErr as PgErr) ?? null, newPool: null };
  }
  const { data: pool } = await handle.supabase.rpc('economy_increment_prediction_pool', {
    p_prediction_id: predictionId,
    p_amount: amount,
  });
  return { betId, insertErr: null, debitErr: null, newPool: typeof pool === 'number' ? pool : null };
}

/** The bot's own atomic, idempotent settle flip. Returns the locked pool, or null when it settled nothing. */
async function resolveAtomic(
  handle: LiveClientHandle,
  predictionId: string,
  winningOptionId: string,
): Promise<{ pool: number | null; error: PgErr }> {
  const { data, error } = await handle.supabase.rpc('predictions_resolve_atomic', {
    p_prediction_id: predictionId,
    p_winning_option_id: winningOptionId,
  });
  const row = Array.isArray(data) ? data[0] : data;
  const pool = (row as { total_pool?: number } | null | undefined)?.total_pool;
  return { pool: typeof pool === 'number' ? pool : null, error: (error as PgErr) ?? null };
}

/**
 * Pay one winning bet its share via the EXACT `economy_add_balance` RPC, then stamp the
 * per-bet idempotent `payout` marker — the same two steps `resolvePrediction` performs.
 * Skips a bet whose marker is already set (the bot's `if (bet.payout != null) continue`).
 */
async function payWinner(handle: LiveClientHandle, bet: BetRow, share: number): Promise<PgErr> {
  if (bet.payout !== null) return null; // already paid — the idempotent skip
  const { error } = await handle.supabase.rpc('economy_add_balance', {
    p_guild_id: handle.guildId,
    p_user_id: bet.user_id,
    p_amount: share,
  });
  if (error) return (error as PgErr) ?? null;
  await handle.supabase.from('prediction_bets').update({ payout: share }).eq('id', bet.id);
  return null;
}

/** Settle a resolved prediction proportionally through the exact payout RPC (mirrors resolvePrediction's loop). */
async function settleProportional(
  handle: LiveClientHandle,
  predictionId: string,
  winningOptionId: string,
  finalPool: number,
): Promise<void> {
  const winners = (await betsFor(handle, predictionId)).filter((b) => b.option_id === winningOptionId);
  const winnerPool = winners.reduce((s, b) => s + b.amount, 0);
  for (const bet of winners) {
    const share = winnerPool > 0 ? Math.floor((finalPool * bet.amount) / winnerPool) : 0;
    await payWinner(handle, bet, share);
  }
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
 * anon key can read (RLS/GRANT deny → 0), or null when inconclusive (→ GATE). A genuine
 * authorization denial surfaces as SQLSTATE 42501 / "permission denied" (HTTP 401/403),
 * which is the deny we want; a rejected key or other error is inconclusive.
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
      return 0; // the anon role is denied the table — RLS/GRANT lockdown working
    }
    return null; // rejected/invalid key or other error → inconclusive (GATE)
  } catch {
    return null;
  }
}

async function serviceRowCount(handle: LiveClientHandle, table: string): Promise<number> {
  const { count } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
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
    'Failure-branch alerts (e.g. settlement-needs-attention) carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected settlement failure branch',
  );
}

/**
 * Prove `table` is guild-scoped under the RLS lockdown, made non-vacuous by a positive
 * control: the scenario has already written a real row under the guild (the service
 * role sees it), so an anon client reading ZERO of those rows is a real deny. GATEs
 * (never fakes) when there is no row to isolate, no anon key, or the probe is inconclusive.
 */
async function proveRlsIsolation(ctx: ScenarioContext, handle: LiveClientHandle, table: string): Promise<void> {
  const svc = await serviceRowCount(handle, table);
  if (svc === 0) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon clients read zero ${table} rows (guild-scoped; the RLS-lockdown sweep REVOKEd anon).`,
      `this scenario writes no ${table} row to serve as the positive control; guild-scoped RLS is proven in scenarios that write one`,
    );
    return;
  }
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon clients read zero ${table} rows (guild-scoped; the RLS-lockdown sweep REVOKEd anon).`,
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, table, handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon clients read zero ${table} rows.`,
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: `The service role reads this guild’s ${table} rows while an anon client reads zero of them (RLS-lockdown REVOKEd anon; ${table} is guild-scoped).`,
    observation:
      `service-role sees ${svc} ${table} row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} row(s) for that guild.`,
    impact: `A ${table} row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).`,
  });
}

/**
 * The member surfaces (poll/prediction embeds, vote confirmations, settle announcement,
 * bet/close/resolve rejections) are all slash-SUBCOMMAND or Discord-BUTTON driven and
 * NOT injectable here (see header). Branding is GATED honestly rather than checked
 * against a synthetic string or the generic dispatcher error reply.
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Member-facing poll/prediction surfaces (poll embed + tally, bet confirmation, settle announcement) show the owner brand name, colors, currency name, and voice preset with the powered-by-SomniBot attribution and zero stock-bot wording.',
    'every entrypoint is a slash SUBCOMMAND and voting is a Discord BUTTON; ScenarioContext.runSlash carries no subcommand and the harness exposes no button injector, so no member-facing reply is produced to inspect (the embeds also hard-code "coins" rather than the configured currency — a reply-side finding only observable once a reply can be captured)',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on poll/prediction embeds.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

/**
 * PollsManager writes NO audit_logs row for any poll/prediction action, and the money
 * RPCs write only economy_wallets (no economy_transactions ledger). The append-only
 * operational evidence is `prediction_bets` (actor + guild + amount + idempotent payout
 * marker) — asserted directly where bets exist; the dedicated correlation-id audit_logs
 * lane is gated.
 */
function gateAuditLog(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'discord-readback',
    'Every polls/predictions state change lands one append-only audit_logs row with actor, guild, and correlation id; anonymization (never deletion) is the only mutation.',
    'PollsManager writes no audit_logs row and the money RPCs touch only economy_wallets (no economy_transactions ledger); the prediction_bets operational rows are the DB-observable evidence here',
  );
}

function gateLiveReply(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) plus slash-subcommand + poll-button injection the harness does not provide',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggers yields no duplicate votes, play-money debits, or settlement payouts.',
    `settlement/vote idempotency is exercised directly in the ${where} scenario(s)`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/**
 * DEF — out-of-the-box single-choice poll + a prediction that settles the pot to
 * winners proportionally, exactly once. Surfaces the poll-close and vote-switch bugs.
 */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const handle = await bootPollsPredictions(ctx, { label: 'a' });
  const userA = ctx.userId('a'); // creator
  const userB = ctx.userId('b');
  const userC = ctx.userId('c');
  const userD = ctx.userId('d');

  // 1) Poll created — a single-choice poll + 3 options land the exact shape createPoll writes.
  const poll = await createPollRows(ctx, handle, userA, ['Red', 'Green', 'Blue'], false);
  const pollRow = await readPoll(handle, poll.pollId);
  const optCount = await countPollOptions(handle, poll.pollId);
  ctx.expect(pollRow?.status === 'active' && optCount === 3 && poll.optionIds.length === 3, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Out of the box /poll create persists one poll (status "active", the open state the vote/close paths read) with its option rows.',
    observation: `poll status="${pollRow?.status}" (expected "active"), option rows=${optCount} (expected 3).`,
    impact: 'Poll creation did not persist the poll + options in the shape the bot reads.',
  });

  // 2) Vote recorded — the bot's own poll_vote_switch_single RPC records exactly one vote.
  const rec = await voteSingle(handle, poll.pollId, poll.optionIds[0]!, userB);
  const bVotes = await pollVotesFor(handle, poll.pollId, userB);
  ctx.expect(rec.inserted === 1 && bVotes.length === 1 && bVotes[0]?.option_id === poll.optionIds[0], {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A single-choice vote records exactly one poll_votes row for the member on the chosen option.',
    observation: `poll_vote_switch_single recorded ${rec.inserted} row(s); member holds ${bVotes.length} vote(s) on option ${bVotes[0]?.option_id ?? '(none)'}.`,
    impact: 'A recorded vote did not persist exactly one poll_votes row.',
  });

  // 3) Single-choice vote-switching: a member's new vote replaces the prior one.
  await voteSingle(handle, poll.pollId, poll.optionIds[0]!, userA); // first vote on option 1
  const switchRes = await voteSingle(handle, poll.pollId, poll.optionIds[1]!, userA); // switch to option 2
  const aVotes = await pollVotesFor(handle, poll.pollId, userA);
  const switched = aVotes.length === 1 && aVotes[0]?.option_id === poll.optionIds[1];
  ctx.expect(switched, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'In single-choice mode a member’s new vote replaces their prior vote (state machine "vote" transition; DEF contracts vote-switching).',
    observation:
      `after voting option 1 then option 2, the member holds ${aVotes.length} vote(s) on option(s) [${aVotes.map((v) => v.option_id).join(', ')}] ` +
      `(expected exactly 1 on option 2 "${poll.optionIds[1]}"); the switch recorded ${switchRes.inserted} row(s).`,
    impact:
      'Single-choice vote-switching failed: the member’s prior vote was not replaced by the new selection, so DEF’s contracted vote-switching does not occur.',
  });

  // 4) FAIL — /poll close is unsatisfiable: the close primitive filters status='open' but polls are 'active'.
  const flipped = await attemptClose(handle, poll.pollId);
  const afterClose = await readPoll(handle, poll.pollId);
  ctx.expect(flipped === 1 && afterClose?.status === 'closed', {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The creator’s /poll close transitions the poll open→closed and posts the final tally (state machine "close-poll").',
    observation:
      `closePoll’s atomic UPDATE (…WHERE status='open') flipped ${flipped} row(s) (expected 1); ` +
      `poll status="${afterClose?.status}" (expected "closed"), closed_at=${afterClose?.closed_at ?? 'null'}.`,
    impact:
      '/poll close can never close a poll: polls are created at status "active" (DB default; the polls CHECK allows only "active"|"closed") but closePoll gates its flip on status="open", so the UPDATE matches zero rows and every close no-ops as "already closed" — no tally is ever posted.',
  });

  // 5) Prediction created — one prediction (status "open") + its outcome options.
  const pred = await createPredictionRows(ctx, handle, userA, ['Yes', 'No']);
  const predRow = await readPrediction(handle, pred.predictionId);
  ctx.expect(predRow?.status === 'open' && pred.optionIds.length === 2 && predRow?.total_pool === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Out of the box /predict create persists one open prediction with its outcome options and a zero starting pool.',
    observation: `prediction status="${predRow?.status}" (expected "open"), options=${pred.optionIds.length} (expected 2), pool=${predRow?.total_pool}.`,
    impact: 'Prediction creation did not persist an open prediction with its options.',
  });

  // 6) Bets — three members stake through the EXACT RPCs; balances debited, pool bumped.
  await seedWallet(handle, userB, 1000);
  await seedWallet(handle, userC, 1000);
  await seedWallet(handle, userD, 1000);
  const yes = pred.optionIds[0]!;
  const no = pred.optionIds[1]!;
  await placeBet(handle, pred.predictionId, yes, userB, 100);
  await placeBet(handle, pred.predictionId, yes, userC, 200);
  await placeBet(handle, pred.predictionId, no, userD, 300);
  const wB = await readWallet(handle, userB);
  const wC = await readWallet(handle, userC);
  const wD = await readWallet(handle, userD);
  const poolRow = await readPrediction(handle, pred.predictionId);
  ctx.expect(
    wB?.wallet === 900 && wC?.wallet === 800 && wD?.wallet === 700 && poolRow?.total_pool === 600,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Each accepted bet debits its stake once (economy_subtract_balance) and escrows it into the pool (economy_increment_prediction_pool).',
      observation:
        `wallets after bets: B=${wB?.wallet} (900), C=${wC?.wallet} (800), D=${wD?.wallet} (700); ` +
        `escrowed pool=${poolRow?.total_pool} (expected 100+200+300=600).`,
      impact: 'A bet did not debit its stake exactly once or did not escrow it into the pool.',
    },
  );

  // 7) Settlement — proportional exactly-once via the bot's own atomic resolve + payout RPC.
  const resolved = await resolveAtomic(handle, pred.predictionId, yes);
  await settleProportional(handle, pred.predictionId, yes, resolved.pool ?? 0);
  const wBs = await readWallet(handle, userB);
  const wCs = await readWallet(handle, userC);
  const wDs = await readWallet(handle, userD);
  const predResolved = await readPrediction(handle, pred.predictionId);
  ctx.expect(
    predResolved?.status === 'resolved' &&
      resolved.pool === 600 &&
      wBs?.wallet === 1100 &&
      wCs?.wallet === 1200 &&
      wDs?.wallet === 700,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Resolve flips the prediction to settled and pays each winner its proportional pot share exactly once (losers keep nothing).',
      observation:
        `status="${predResolved?.status}" (resolved), locked pool=${resolved.pool} (600); ` +
        `winner wallets B=${wBs?.wallet} (900+200 share=1100), C=${wCs?.wallet} (800+400 share=1200); loser D=${wDs?.wallet} (unchanged 700).`,
      impact: 'The pot was not distributed proportionally / exactly once on resolve.',
    },
  );

  // 8) Audit — prediction_bets is the append-only ledger; winner markers set, loser null, pot conserved.
  const finalBets = await betsFor(handle, pred.predictionId);
  const bPay = finalBets.find((b) => b.user_id === userB)?.payout ?? null;
  const cPay = finalBets.find((b) => b.user_id === userC)?.payout ?? null;
  const dPay = finalBets.find((b) => b.user_id === userD)?.payout ?? null;
  const paidTotal = (bPay ?? 0) + (cPay ?? 0);
  ctx.expect(finalBets.length === 3 && bPay === 200 && cPay === 400 && dPay === null && paidTotal === 600, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Each bet lands one append-only prediction_bets row (actor + guild + amount); winning bets carry a per-bet payout marker whose sum reconciles to the pot, losing bets carry none.',
    observation: `bet rows=${finalBets.length}; payout markers B=${bPay}, C=${cPay}, D=${dPay}; paid total=${paidTotal} (expected =pool 600).`,
    impact: 'A bet ledger row was missing, mis-marked, or the payouts did not reconcile to the pot.',
  });

  // 9) Replay-safety — the atomic settle is idempotent: a re-delivered resolve settles nothing.
  const reResolve = await resolveAtomic(handle, pred.predictionId, yes);
  const wBReplay = await readWallet(handle, userB);
  ctx.expect(reResolve.pool === null && wBReplay?.wallet === 1100, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering the resolve never double-pays: predictions_resolve_atomic settles exactly once (a second call returns no pool and moves no balance).',
    observation: `second predictions_resolve_atomic returned pool=${reResolve.pool} (expected none); winner wallet after replay=${wBReplay?.wallet} (unchanged 1100).`,
    impact: 'A re-delivered resolve re-settled the prediction — winners would be double-paid.',
  });

  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAuditLog(ctx);
  gateLiveReply(
    ctx,
    'The poll message shows live button tallies and the settle announcement names the winning outcome, winner count, and pot in the owner voice.',
  );
}

/** SET-A — multi-select behavior works, but the contracted raised minimum bet (100) is unimplemented. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const minBetDefault = Number(declaredDefault(ctx.domain, 'prediction-min-bet')); // 1
  const raisedMin = 100; // SET-A's contracted raised minimum
  const handle = await bootPollsPredictions(ctx, { label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Multiple-selection behavior: an allow_multiple poll lets one member pick two options (both count).
  const poll = await createPollRows(ctx, handle, userA, ['A', 'B', 'C'], true);
  await voteMulti(handle, poll.pollId, poll.optionIds[0]!, userA);
  await voteMulti(handle, poll.pollId, poll.optionIds[1]!, userA);
  const aVotes = await pollVotesFor(handle, poll.pollId, userA);
  const optionSet = new Set(aVotes.map((v) => v.option_id));
  ctx.expect(aVotes.length === 2 && optionSet.has(poll.optionIds[0]!) && optionSet.has(poll.optionIds[1]!), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'On a multiple-selection poll a member’s two selections both count (two poll_votes rows under the UNIQUE(poll_id,option_id,user_id) gate).',
    observation: `member holds ${aVotes.length} vote(s) on options [${aVotes.map((v) => v.option_id).join(', ')}] (expected both option 1 and option 2).`,
    impact: 'Multiple-selection voting did not record both of the member’s selections.',
  });

  // FAIL — the raised minimum bet has no implementation backing.
  const { error: colErr } = await handle.supabase
    .from('guild_config')
    .select('prediction_min_bet')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const columnAbsent = colErr !== null; // selecting a non-existent column errors
  const pred = await createPredictionRows(ctx, handle, userA, ['Yes', 'No']);
  await seedWallet(handle, userB, 1000);
  const bet = await placeBet(handle, pred.predictionId, pred.optionIds[0]!, userB, 50); // below the raised 100 minimum
  const wallet = await readWallet(handle, userB);
  const belowMinAccepted = bet.betId !== null && wallet?.wallet === 950;
  ctx.expect(!belowMinAccepted && !columnAbsent, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `SET-A: with the minimum bet raised to ${raisedMin}, a ${50}-coin bet is rejected citing the minimum, and the setting is enforced from a saved guild_config value.`,
    observation:
      `guild_config.prediction_min_bet column ${columnAbsent ? 'does NOT exist' : 'exists'} (read error: ${colErr ? (colErr as { message?: string }).message : 'none'}); ` +
      `a ${50}-coin bet ${belowMinAccepted ? `WAS accepted (bet row created, wallet ${wallet?.wallet})` : 'was rejected'}.`,
    impact:
      `The configurable minimum-bet floor is unimplemented: guild_config has no prediction_min_bet column and prediction_bets’ only amount guard is CHECK(amount>0) (catalog default min ${minBetDefault}), so a sub-minimum bet persists — SET-A’s contracted raised minimum of ${raisedMin} cannot take effect.`,
  });

  const betRow = await betsFor(handle, pred.predictionId, userB);
  ctx.expect(betRow.length === 1 && betRow[0]?.amount === 50, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Each accepted bet lands exactly one append-only prediction_bets row with the staked amount.',
    observation: `prediction_bets rows for the bettor=${betRow.length}, amount=${betRow[0]?.amount ?? '(none)'}.`,
    impact: 'The accepted bet did not produce exactly one ledger row.',
  });

  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAuditLog(ctx);
  gateLiveReply(ctx, 'The under-minimum bet gets a clear branded rejection and the multi-select tally renders both picks.');
  gateReplayDeferredTo(ctx, 'DEF / REPLAY / RACE');
}

/** SET-B — a second config takes effect: predictions disabled while polls keep working. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await bootPollsPredictions(ctx, { label: 'a', pollsEnabled: true, predictionsEnabled: false });
  const userA = ctx.userId('a');

  // The saved flags land in guild_config — the EXACT row the bot's getConfig() reads live.
  const { data: cfg } = await handle.supabase
    .from('guild_config')
    .select('polls_enabled, predictions_enabled')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfgRow = cfg as { polls_enabled: boolean; predictions_enabled: boolean } | null;
  ctx.expect(cfgRow?.polls_enabled === true && cfgRow?.predictions_enabled === false, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A dashboard save of predictions-off / polls-on persists to guild_config and is what createPrediction/createPoll gate on live (no restart).',
    observation: `guild_config holds polls_enabled=${cfgRow?.polls_enabled} (expected true), predictions_enabled=${cfgRow?.predictions_enabled} (expected false).`,
    impact: 'The predictions-disabled / polls-enabled configuration did not persist / would not take live effect.',
  });

  // Polls keep working fully at the primitive level under this config.
  const poll = await createPollRows(ctx, handle, userA, ['Up', 'Down'], false);
  const pollRow = await readPoll(handle, poll.pollId);
  ctx.expect(pollRow?.status === 'active' && poll.optionIds.length === 2, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'With predictions disabled, /poll create still creates a working poll.',
    observation: `poll status="${pollRow?.status}" (expected "active"), options=${poll.optionIds.length} (expected 2).`,
    impact: 'Polls stopped working when predictions were disabled.',
  });

  await proveRlsIsolation(ctx, handle, 'polls');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAuditLog(ctx);
  gateLiveReply(
    ctx,
    'With predictions_enabled off, /predict create declines gracefully in the owner’s voice while /poll create runs fully (the config gate is read by createPrediction/createPoll, which are subcommand-driven).',
  );
  gateReplayDeferredTo(ctx, 'DEF / REPLAY / RACE');
}

/** INVALID — invalid inputs never persist: a zero-amount bet is rejected by the DB CHECK. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const maxOptions = Number(declaredDefault(ctx.domain, 'max-poll-options')); // 10
  const handle = await bootPollsPredictions(ctx, { label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // A zero-amount bet never persists — prediction_bets CHECK(amount > 0) is the authoritative gate.
  const pred = await createPredictionRows(ctx, handle, userA, ['Yes', 'No']);
  await seedWallet(handle, userB, 1000);
  const zeroBet = await placeBet(handle, pred.predictionId, pred.optionIds[0]!, userB, 0);
  const betRows = await betsFor(handle, pred.predictionId, userB);
  const wallet = await readWallet(handle, userB);
  ctx.expect(
    zeroBet.betId === null && zeroBet.insertErr?.code === '23514' && betRows.length === 0 && wallet?.wallet === 1000,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'A zero-amount bet is rejected atomically: no prediction_bets row is written and no balance moves.',
      observation:
        `zero-amount insert error code=${zeroBet.insertErr?.code ?? '(none)'} (expected 23514 check_violation); ` +
        `bet rows=${betRows.length} (expected 0); wallet=${wallet?.wallet} (expected untouched 1000).`,
      impact: 'A zero-amount bet persisted or debited the wallet — the amount>0 guard did not hold.',
    },
  );

  // The prediction row itself is a valid, guild-scoped row (positive RLS control).
  await proveRlsIsolation(ctx, handle, 'predictions');
  await proveNoOwnerAlert(ctx, handle);

  // Poll option-count validation (1 option / 11 options) lives in createPoll's TypeScript
  // guard (`options.length < 2 || > 10`) — there is NO DB constraint on poll_options count,
  // so the reject path is only reachable through the subcommand handler (gated here).
  ctx.gate(
    'Discord',
    'discord-readback',
    `/poll create with 1 option or ${maxOptions + 1} options is rejected with "Polls need 2-10 options" and writes no poll/option rows.`,
    `option-count validation is a createPoll TypeScript guard (2-${maxOptions}); poll_options carries no count CHECK, so the reject path is only reachable via the slash subcommand the harness cannot drive`,
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Each rejected input lands one audit row with its validation reason.',
    'PollsManager writes no audit_logs row for rejected creates/bets; the reject paths are also subcommand-driven (not injectable here)',
  );
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'DEF / REPLAY / RACE');
}

/** UNAUTH — resolution is protected: the creator_user_id the handlers compare is recorded as the sole authority. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await bootPollsPredictions(ctx, { label: 'a' });
  const userA = ctx.userId('a'); // creator
  const userB = ctx.userId('b'); // neither creator nor Manage Guild
  const userC = ctx.userId('c'); // a bettor

  // A poll whose creator is A: closePoll compares poll.creator_user_id to the caller.
  const poll = await createPollRows(ctx, handle, userA, ['One', 'Two'], false);
  const pollRow = await readPoll(handle, poll.pollId);
  ctx.expect(pollRow?.creator_user_id === userA && pollRow?.creator_user_id !== userB, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A poll records its creator (A) as the sole authority — the exact field /poll close compares to refuse a non-creator (B).',
    observation: `poll.creator_user_id=${pollRow?.creator_user_id} (A=${userA}, B=${userB}).`,
    impact: 'The poll did not record a single authoritative creator — the close authorization check would have nothing sound to compare.',
  });

  // A prediction whose creator is A, with a real escrowed bet: resolvePrediction compares
  // prediction.creator_user_id and, on refusal, leaves the prediction open and the bet unpaid.
  const pred = await createPredictionRows(ctx, handle, userA, ['Yes', 'No']);
  await seedWallet(handle, userC, 1000);
  await placeBet(handle, pred.predictionId, pred.optionIds[0]!, userC, 100);
  const predRow = await readPrediction(handle, pred.predictionId);
  const cBet = await betsFor(handle, pred.predictionId, userC);
  ctx.expect(
    predRow?.creator_user_id === userA &&
      predRow?.creator_user_id !== userB &&
      predRow?.status === 'open' &&
      cBet.length === 1 &&
      cBet[0]?.payout === null,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'The prediction records A as its sole resolver (creator_user_id) and stays open with the bet unpaid while a non-creator (B) has no authority to settle.',
      observation:
        `prediction.creator_user_id=${predRow?.creator_user_id} (A=${userA}, B=${userB}), status="${predRow?.status}" (open); ` +
        `bettor’s bet payout=${cBet[0]?.payout ?? 'null'} (unsettled).`,
      impact: 'The prediction did not record a single authoritative resolver, or a bet was settled without an authorized resolve.',
    },
  );

  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handle);
  gateLiveReply(
    ctx,
    'run-member-b’s /poll close and /predict resolve are refused ephemerally ("Only the creator…"); the poll stays open and no settlement occurs.',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Each denied close/resolve attempt is audited with actor, target id, and reason permission-denied.',
    'PollsManager writes no audit_logs row for denied attempts, and the creator-only guard runs inside the slash-subcommand handler (not injectable here)',
  );
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'DEF / REPLAY / RACE');
}

/** DEPFAIL — Supabase-unreachable fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // This DB-observable harness's whole premise is a REACHABLE local Supabase, so a
  // database-outage cannot be induced without a fault-injection lane. GATE the
  // outage-dependent behavior honestly rather than fake an outage.
  ctx.gate(
    'Discord',
    'db-observable',
    'With database access blocked, /predict bet returns the friendly unavailable rejection and no stake is debited; after restore the balance shows no debit and a fresh bet succeeds cleanly.',
    'requires a Supabase dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A single dependency-degradation alert covers the outage window (not one per failed bet).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Append-only rows capture the post-recovery bet with the run-prefixed correlation id.',
    'requires the outage fault lane; the money path also writes no economy_transactions ledger row (economy_subtract_balance touches only economy_wallets)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Balance history shows zero debits without matching bet rows — no phantom or partial money movement through the outage/restore cycle.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded predictions-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the unavailable branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Poll/prediction/bet/balance rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — transient settlement failures converge: the per-bet payout marker credits each winner exactly once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await bootPollsPredictions(ctx, { label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const userC = ctx.userId('c');

  const pred = await createPredictionRows(ctx, handle, userA, ['Yes', 'No']);
  await seedWallet(handle, userB, 1000);
  await seedWallet(handle, userC, 1000);
  const yes = pred.optionIds[0]!;
  await placeBet(handle, pred.predictionId, yes, userB, 100);
  await placeBet(handle, pred.predictionId, yes, userC, 100);
  const resolved = await resolveAtomic(handle, pred.predictionId, yes); // pool 200
  const winnerPool = 200; // both bet on Yes
  const share = Math.floor(((resolved.pool ?? 0) * 100) / winnerPool); // 100 each

  // Pay winner B, mark it; then a "retry" pass (as after a transient fault mid-settlement)
  // re-scans all winning bets: B is skipped (payout marker set), C is credited — the exact
  // idempotent per-bet convergence the catalog contracts ("bets already marked paid are skipped").
  const betsAfterFirst = (await betsFor(handle, pred.predictionId)).filter((b) => b.option_id === yes);
  const bBet = betsAfterFirst.find((b) => b.user_id === userB)!;
  await payWinner(handle, bBet, share);
  const retryWinners = (await betsFor(handle, pred.predictionId)).filter((b) => b.option_id === yes);
  for (const bet of retryWinners) await payWinner(handle, bet, share); // B skipped (already marked), C paid

  const wB = await readWallet(handle, userB);
  const wC = await readWallet(handle, userC);
  const finalBets = (await betsFor(handle, pred.predictionId)).filter((b) => b.option_id === yes);
  const bPay = finalBets.find((b) => b.user_id === userB)?.payout ?? null;
  const cPay = finalBets.find((b) => b.user_id === userC)?.payout ?? null;
  ctx.expect(wB?.wallet === 1000 && wC?.wallet === 1000 && bPay === 100 && cPay === 100, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Settlement retries per-bet under idempotent payout markers: an already-paid winner is skipped on retry and each winner is credited its share exactly once.',
    observation:
      `after paying B then re-running settlement: B wallet=${wB?.wallet} (900+100 once=1000, not double), C wallet=${wC?.wallet} (900+100=1000); ` +
      `payout markers B=${bPay}, C=${cPay} (each 100 once).`,
    impact: 'A winner was double-credited on retry, or an unpaid winner was skipped — settlement did not converge to exactly-once.',
  });

  const paidTotal = (bPay ?? 0) + (cPay ?? 0);
  ctx.expect(paidTotal === (resolved.pool ?? 0), {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Per-bet payout markers reconcile to the pot after retry (totals conserve).',
    observation: `sum of payout markers=${paidTotal} (expected =pool ${resolved.pool}).`,
    impact: 'The settled payouts did not reconcile to the pot after the retry pass.',
  });

  // The actual transient FAULT injection (economy_add_balance failing mid-settlement) and the
  // owner "settlement needs attention" alert are behind a fault lane + live channel readback.
  ctx.gate(
    'Discord',
    'discord-readback',
    'With a transient fault injected after the first winner’s credit, the retry pays only the remaining winners and the settle announcement posts once with correct balances.',
    'requires a mid-settlement fault-injection lane (fail economy_add_balance for one winner) plus slash-subcommand injection',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A settlement that exhausts payout retries raises exactly one reasoned owner alert (settlement-alert) with a remediation hint.',
    'requires the mid-settlement fault-injection lane plus owner alert channel readback',
  );
  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  gateBranding(ctx);
  gateAuditLog(ctx);
}

/** REPLAY — re-delivering the resolve changes no balance (atomic settle + per-bet markers). */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await bootPollsPredictions(ctx, { label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const userC = ctx.userId('c');

  const pred = await createPredictionRows(ctx, handle, userA, ['Yes', 'No']);
  await seedWallet(handle, userB, 1000);
  await seedWallet(handle, userC, 1000);
  const yes = pred.optionIds[0]!;
  const no = pred.optionIds[1]!;
  await placeBet(handle, pred.predictionId, yes, userB, 100); // winner
  await placeBet(handle, pred.predictionId, no, userC, 100); // loser

  // First resolve + settle.
  const first = await resolveAtomic(handle, pred.predictionId, yes);
  await settleProportional(handle, pred.predictionId, yes, first.pool ?? 0);
  const wBefore = await readWallet(handle, userB);
  const bBetBefore = (await betsFor(handle, pred.predictionId, userB))[0];

  // Re-deliver the resolve: predictions_resolve_atomic returns nothing (already resolved),
  // and settling again is a no-op because the winning bet's payout marker is already set.
  const replay = await resolveAtomic(handle, pred.predictionId, yes);
  await settleProportional(handle, pred.predictionId, yes, replay.pool ?? 0);
  const wAfter = await readWallet(handle, userB);
  const bBetAfter = (await betsFor(handle, pred.predictionId, userB))[0];

  ctx.expect(
    first.pool === 200 &&
      replay.pool === null &&
      wBefore?.wallet === 1100 &&
      wAfter?.wallet === 1100 &&
      bBetBefore?.payout === 200 &&
      bBetAfter?.payout === 200,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Replays never double-pay: re-delivering the resolve leaves every balance and payout marker byte-identical (persisted per-bet marker + atomic settle = one effect per logical action).',
      observation:
        `first resolve pool=${first.pool} (200); replayed resolve pool=${replay.pool} (none — already resolved); ` +
        `winner wallet ${wBefore?.wallet}→${wAfter?.wallet} (unchanged 1100); payout marker ${bBetBefore?.payout}→${bBetAfter?.payout} (unchanged 200).`,
      impact: 'A re-delivered resolve re-settled — winners would be double-paid (an idempotency regression on the money path).',
    },
  );

  const predRow = await readPrediction(handle, pred.predictionId);
  ctx.expect(predRow?.status === 'resolved', {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The prediction remains in the single settled state across the replay (exactly one settlement of record).',
    observation: `prediction status after replay="${predRow?.status}" (expected "resolved").`,
    impact: 'The replayed resolve changed the settled state of record.',
  });

  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAuditLog(ctx);
  gateLiveReply(ctx, 'Exactly one settlement announcement exists and winners’ balances did not change on replay.');
}

/** RESTART — open predictions + escrowed stakes survive a stack reboot; post-restart settle pays correctly. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const userC = ctx.userId('c');

  // Boot #1: create a prediction, escrow two bets, snapshot.
  const first = await bootPollsPredictions(ctx, { guildId, label: 'a' });
  const pred = await createPredictionRows(ctx, first, userA, ['Yes', 'No']);
  await seedWallet(first, userB, 1000);
  await seedWallet(first, userC, 1000);
  const yes = pred.optionIds[0]!;
  const no = pred.optionIds[1]!;
  await placeBet(first, pred.predictionId, yes, userB, 100); // winner
  await placeBet(first, pred.predictionId, no, userC, 100); // loser
  const snapshot = await readPrediction(first, pred.predictionId);
  const betsSnapshot = await betsFor(first, pred.predictionId);
  await first.cleanup(); // simulate shutdown (does NOT delete rows)

  // Boot #2: SAME guild id (restart). The open prediction + escrowed bets must be intact.
  const second = await bootPollsPredictions(ctx, { guildId, label: 'a' });
  const afterRestart = await readPrediction(second, pred.predictionId);
  const betsAfter = await betsFor(second, pred.predictionId);
  ctx.expect(
    afterRestart?.status === 'open' &&
      afterRestart?.total_pool === snapshot?.total_pool &&
      afterRestart?.total_pool === 200 &&
      betsAfter.length === betsSnapshot.length &&
      betsAfter.length === 2,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart the open prediction and its escrowed bets are intact (state lives in Supabase).',
      observation:
        `pre-restart status=${snapshot?.status}/pool=${snapshot?.total_pool}/bets=${betsSnapshot.length}; ` +
        `post-restart status=${afterRestart?.status} (open)/pool=${afterRestart?.total_pool} (200)/bets=${betsAfter.length} (2).`,
      impact: 'Open prediction or escrowed stakes did not survive a restart — state was lost or altered.',
    },
  );

  // Post-restart settlement pays the winner correctly via the same atomic resolve + payout RPCs.
  const resolved = await resolveAtomic(second, pred.predictionId, yes);
  await settleProportional(second, pred.predictionId, yes, resolved.pool ?? 0);
  const wB = await readWallet(second, userB);
  const wC = await readWallet(second, userC);
  const predResolved = await readPrediction(second, pred.predictionId);
  ctx.expect(predResolved?.status === 'resolved' && wB?.wallet === 1100 && wC?.wallet === 900, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Post-restart resolve settles the pre-restart stakes exactly: the winner is paid its proportional share once, the loser keeps nothing.',
    observation: `post-restart resolve: status="${predResolved?.status}" (resolved); winner B wallet=${wB?.wallet} (900+200=1100), loser C wallet=${wC?.wallet} (900).`,
    impact: 'Post-restart settlement did not pay the pre-restart stakes correctly.',
  });

  await proveRlsIsolation(ctx, second, 'prediction_bets');
  await proveNoOwnerAlert(ctx, second);
  gateBranding(ctx);
  gateAuditLog(ctx);
  gateLiveReply(ctx, 'Post-restart /predict resolve produces payouts matching the pre-restart stakes exactly.');
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** RACE — concurrency is safe: double-clicked bets debit once, and two simultaneous resolves settle exactly once. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await bootPollsPredictions(ctx, { label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const userC = ctx.userId('c');

  const pred = await createPredictionRows(ctx, handle, userA, ['Yes', 'No']);
  await seedWallet(handle, userB, 1000);
  await seedWallet(handle, userC, 1000);
  const yes = pred.optionIds[0]!;
  const no = pred.optionIds[1]!;

  // (a) Double-clicked bet: two simultaneous bets from the SAME member race the
  //     UNIQUE(prediction_id,user_id) constraint — exactly one row wins, exactly one debit.
  const [r1, r2] = await Promise.all([
    placeBet(handle, pred.predictionId, yes, userB, 100),
    placeBet(handle, pred.predictionId, yes, userB, 100),
  ]);
  const wins = [r1, r2].filter((r) => r.betId !== null).length;
  const rejects = [r1, r2].filter((r) => r.insertErr?.code === '23505').length;
  const bBets = await betsFor(handle, pred.predictionId, userB);
  const wB = await readWallet(handle, userB);
  ctx.expect(wins === 1 && rejects === 1 && bBets.length === 1 && wB?.wallet === 900, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A rapid double-click on bet yields exactly one bet row and one debit (the UNIQUE(prediction_id,user_id) index serializes the race).',
    observation: `concurrent bets: winners=${wins}, 23505-rejections=${rejects}; bet rows for the member=${bBets.length} (1); wallet=${wB?.wallet} (debited once → 900).`,
    impact: 'A double-clicked bet created duplicate bet rows or double-debited the member.',
  });

  // (b) Two simultaneous resolves settle exactly once: predictions_resolve_atomic’s
  //     FOR UPDATE lock lets exactly one call flip open→resolved and return the pool.
  await placeBet(handle, pred.predictionId, no, userC, 100); // a loser so the pot > winner stake
  const [rr1, rr2] = await Promise.all([
    resolveAtomic(handle, pred.predictionId, yes),
    resolveAtomic(handle, pred.predictionId, yes),
  ]);
  const settledCount = [rr1, rr2].filter((r) => r.pool !== null).length;
  const pool = rr1.pool ?? rr2.pool ?? 0;
  await settleProportional(handle, pred.predictionId, yes, pool);
  const wBs = await readWallet(handle, userB);
  const predRow = await readPrediction(handle, pred.predictionId);
  ctx.expect(settledCount === 1 && predRow?.status === 'resolved' && wBs?.wallet === 1100, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Two simultaneous /predict resolve calls settle exactly once with singly-paid winners.',
    observation: `concurrent resolves that returned a pool=${settledCount} (expected 1); status="${predRow?.status}" (resolved); winner wallet=${wBs?.wallet} (900+200=1100, paid once).`,
    impact: 'Concurrent resolves double-settled — a winner would be paid more than once.',
  });

  const finalBets = await betsFor(handle, pred.predictionId, userB);
  ctx.expect(finalBets.length === 1 && finalBets[0]?.payout === 200, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The raced bet + settle leave exactly one prediction_bets row with a single payout marker.',
    observation: `bet rows for the winner=${finalBets.length} (1), payout marker=${finalBets[0]?.payout ?? '(none)'} (200 once).`,
    impact: 'A raced bet/settle wrote a duplicate ledger row or double payout marker.',
  });

  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAuditLog(ctx);
  gateLiveReply(ctx, 'One bet confirmation and one settlement announcement despite the concurrent actions.');
}

/** XGUILD — polls, predictions, and play-money balances are strictly per-guild. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');

  const handleA = await bootPollsPredictions(ctx, { guildId: guildA });
  const handleB = await bootPollsPredictions(ctx, { guildId: guildB });

  // A prediction + escrowed bet in EACH guild for the SAME member (separate wallets).
  const predA = await createPredictionRows(ctx, handleA, userA, ['Yes', 'No']);
  const predB = await createPredictionRows(ctx, handleB, userA, ['Yes', 'No']);
  await seedWallet(handleA, userB, 1000);
  await seedWallet(handleB, userB, 1000);
  await placeBet(handleA, predA.predictionId, predA.optionIds[0]!, userB, 100);
  await placeBet(handleB, predB.predictionId, predB.optionIds[0]!, userB, 100);
  const walletBbeforeA = await readWallet(handleB, userB); // 900 after B's bet

  // Settle guild A only.
  const resolvedA = await resolveAtomic(handleA, predA.predictionId, predA.optionIds[0]!);
  await settleProportional(handleA, predA.predictionId, predA.optionIds[0]!, resolvedA.pool ?? 0);

  const predBAfter = await readPrediction(handleB, predB.predictionId);
  const walletBafterA = await readWallet(handleB, userB);
  const betBAfter = (await betsFor(handleB, predB.predictionId, userB))[0];
  ctx.expect(
    predBAfter?.status === 'open' &&
      betBAfter?.payout === null &&
      walletBafterA?.wallet === walletBbeforeA?.wallet &&
      walletBafterA?.wallet === 900,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Settling in guild A never moves guild B: guild B’s prediction stays open, its bet unpaid, and the member’s guild-B balance is unchanged.',
      observation:
        `after guild A settled: guild B prediction status="${predBAfter?.status}" (open), bet payout=${betBAfter?.payout ?? 'null'} (unpaid), ` +
        `member guild-B wallet=${walletBafterA?.wallet} (unchanged 900).`,
      impact: 'Guild A’s settlement leaked into guild B — per-guild isolation of predictions/balances is broken.',
    },
  );

  // Each guild scope reads its OWN distinct bet row and never the other's: guild A's
  // sole bettor (no loser in A) gets its 100 stake returned as its settled payout marker,
  // while guild B's identical bet stays unpaid.
  const { data: bScoped } = await handleB.supabase
    .from('prediction_bets')
    .select('guild_id, amount, payout')
    .eq('guild_id', guildB)
    .eq('user_id', userB)
    .maybeSingle();
  const { data: aScoped } = await handleA.supabase
    .from('prediction_bets')
    .select('guild_id, amount, payout')
    .eq('guild_id', guildA)
    .eq('user_id', userB)
    .maybeSingle();
  const bRow = bScoped as { guild_id: string; amount: number; payout: number | null } | null;
  const aRow = aScoped as { guild_id: string; amount: number; payout: number | null } | null;
  ctx.expect(
    bRow?.guild_id === guildB &&
      bRow?.amount === 100 &&
      bRow?.payout === null &&
      aRow?.guild_id === guildA &&
      aRow?.payout === 100,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise: 'Each guild scope reads its OWN prediction_bets row and never the other’s: guild B → its unpaid 100-coin bet, guild A → its settled bet (payout marker set).',
      observation:
        `guild-B-scoped bet under "${bRow?.guild_id}" amount=${bRow?.amount} payout=${bRow?.payout} (unpaid); ` +
        `guild-A-scoped bet under "${aRow?.guild_id}" payout=${aRow?.payout} (settled) — distinct rows under distinct guild_ids.`,
      impact: 'A guild-scoped read returned the other guild’s bet row — cross-guild leakage.',
    },
  );
  await proveRlsIsolation(ctx, handleB, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handleA);
  gateBranding(ctx);
  gateAuditLog(ctx);
  gateLiveReply(ctx, 'Guild B’s prediction and balances show no change when guild A settles.');
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed poll/prediction/bet/vote rows removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await bootPollsPredictions(ctx, { label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Create run-prefixed operational rows: a voted poll + a bet-backed prediction.
  const poll = await createPollRows(ctx, handle, userA, ['Yes', 'No'], false);
  await voteSingle(handle, poll.pollId, poll.optionIds[0]!, userB);
  const pred = await createPredictionRows(ctx, handle, userA, ['Yes', 'No']);
  await seedWallet(handle, userB, 1000);
  await placeBet(handle, pred.predictionId, pred.optionIds[0]!, userB, 100);

  const pollsBefore = await serviceRowCount(handle, 'polls');
  const predsBefore = await serviceRowCount(handle, 'predictions');
  const betsBefore = await serviceRowCount(handle, 'prediction_bets');
  const votesBefore = (await pollVotesFor(handle, poll.pollId)).length;
  const walletsBefore = await walletCount(handle, userB);
  ctx.expect(pollsBefore >= 1 && predsBefore >= 1 && betsBefore >= 1 && votesBefore >= 1 && walletsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed poll, vote, prediction, bet, and wallet rows (pre-cleanup baseline).',
    observation: `pre-cleanup: polls=${pollsBefore}, predictions=${predsBefore}, bets=${betsBefore}, votes=${votesBefore}, wallets=${walletsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const pollsAfter = await serviceRowCount(handle, 'polls');
  const predsAfter = await serviceRowCount(handle, 'predictions');
  const betsAfter = await serviceRowCount(handle, 'prediction_bets');
  const votesAfter = (await pollVotesFor(handle, poll.pollId)).length; // cascade-deleted with the poll
  const walletsAfter = await walletCount(handle, userB);
  ctx.expect(
    pollsAfter === 0 && predsAfter === 0 && betsAfter === 0 && votesAfter === 0 && walletsAfter === 0,
    {
      assertionClass: 'cleanup',
      channel: 'db-observable',
      promise: 'Run-prefixed poll, vote (cascaded), prediction, bet, and wallet rows are deleted; a final sweep finds zero run-prefixed polls/predictions resources.',
      observation: `post-sweep: polls=${pollsAfter}, predictions=${predsAfter}, bets=${betsAfter}, votes=${votesAfter}, wallets=${walletsAfter}.`,
      impact: 'The cleanup sweep left run-prefixed rows behind — the suite leaves residue.',
    },
  );

  gateBranding(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed poll or prediction messages after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane; the polls/predictions operational rows are the DB-observable evidence here',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Polls & Predictions domain proof: the guild_id-scoped tables the sweep must clear
 * (child → parent so FK-constrained rows are removed before their parents and the guild
 * row), plus the 12 scenario scripts.
 *
 * Note on child tables: poll_options, poll_votes, and prediction_options have NO guild_id
 * (they are scoped via their poll_id / prediction_id FKs) and are removed by ON DELETE
 * CASCADE when their `polls` / `predictions` parents are swept, so they are intentionally
 * NOT listed here (a delete-by-guild_id would error). prediction_bets is listed before
 * predictions so its prediction_id FK is cleared first.
 */
export const communityPollsPredictionsProof: DomainProof = {
  domainId: 'community-polls-predictions',
  guildScopedTables: [
    'prediction_bets',
    'predictions',
    'polls',
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
