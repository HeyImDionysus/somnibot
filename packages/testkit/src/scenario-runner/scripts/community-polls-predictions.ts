/**
 * scenario-runner/scripts/community-polls-predictions — the Polls & Predictions domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete, real-stack proof
 * scripts driven against LOCAL Supabase. Every DB-observable / RLS / owner-alert
 * assertion runs against the SAME production primitives the bot uses AND — since the
 * loopback adapter can drive slash SUBCOMMANDS + COMPONENTS in-process (PR #331) — the
 * member REPLY surfaces are driven through the REAL handlers and their captured replies
 * asserted. Only the live-CHANNEL readback (posted-message pixels, brand-kit, in-place
 * tally updates) and the fault-injection lanes remain GATED.
 *
 * ── The member surfaces are now DRIVEN, not gated ──
 * Every entrypoint is a slash SUBCOMMAND (`/poll create|close`, `/predict
 * create|bet|resolve`) and voting is a Discord BUTTON (`poll:{id}:{opt}`).
 * `ScenarioContext.runSlash` now carries `subcommand`, and `ctx.injectorFor(handle)`
 * drives button interactions, so `proveMemberSurfaces` dispatches the REAL
 * `handlePollCommand` / `handlePredictCommand` / `PollsManager.handlePollVote` and
 * asserts their captured embeds/replies (poll board, vote confirmation, prediction
 * board, bet confirmation, settle announcement, and — white-label — the owner-configured
 * currency name). (The two create handlers call `interaction.fetchReply()` after their
 * `reply()`; with no gateway that throws AFTER the reply + all DB writes land, and the
 * dispatcher's own try/catch swallows it, so the captured reply + real rows are intact.)
 *
 * ── What IS proven, non-vacuously ──
 *   - poll rows + options land the shape `createPoll` writes (status default 'active');
 *   - single-choice voting is the bot's own `poll_vote_switch_single` RPC (atomic
 *     replace-prior-vote) — driven directly AND through the real vote button;
 *   - the money path is the bot's OWN 2026-07-26 ledger flow: the debit settles FIRST
 *     through `economy_prediction_settle` (wallet delta + economy_transactions
 *     prediction_bet row in ONE call, replay-fenced on request_id = the
 *     client-generated bet id), the bet row + pool increment land through
 *     `prediction_place_bet` (atomic open-check + insert + increment; a refused fence
 *     is compensated with the keyed refund exactly as the bot does), and settlement
 *     credits flow through the same settle RPC keyed on the bet id;
 *   - every wallet movement is ALSO asserted against its economy_transactions ledger
 *     row (type prediction_bet / prediction_payout / prediction_refund with
 *     metadata.request_id = the bet id) — the #58 prediction-ledger gap, proven closed;
 *   - `prediction_bets` UNIQUE(prediction_id,user_id) + CHECK(amount>0) remain the DB
 *     backstops behind `prediction_place_bet`'s 'duplicate' fence and amount validation;
 *   - settlement's exactly-once guarantee is the bot's own `predictions_resolve_atomic`
 *     (atomic open→resolved flip returning the locked pool; a re-call returns nothing);
 *   - the per-bet `payout` marker is the idempotent settlement marker the catalog names;
 *   - polls / predictions / prediction_bets are guild-scoped with anon REVOKEd by the
 *     RLS lockdown (service role sees the row an anon/second-guild client must not).
 *
 * ── Formerly-"bug" paths now proven FIXED (driven live, not re-implemented) ──
 *   1. /poll close: DEF drives the REAL `/poll close`, which flips the poll open→closed
 *      and posts the tally. (An earlier draft re-implemented the OLD buggy
 *      `... WHERE status='open'` UPDATE and recorded a FAIL; V47-L2 fixed the handler to
 *      gate on the real 'active' status, so driving it now PASSES.)
 *   2. Raised minimum bet: the `prediction_bet_limits` migration added
 *      `guild_config.prediction_min_bet` and `placeBet` enforces it, so SET-A boots with
 *      `prediction_min_bet=100`, drives the REAL `/predict bet` for 50, and PROVES the
 *      sub-minimum bet is rejected with no stake moved.
 */
import { randomUUID } from 'node:crypto';

import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import { buildButtonInteraction } from '../../interaction-builders.js';
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

/** The jsonb result of the bot's `economy_prediction_settle` money RPC. */
interface SettleResult {
  status?: string;
  replayed?: boolean;
  amount?: number;
  wallet_balance?: number;
  existing_type?: string;
}

/** The jsonb result of the bot's `prediction_place_bet` closed-state fence RPC. */
interface PlaceResult {
  status?: string;
  replayed?: boolean;
  new_pool?: number;
}

/** One economy_transactions prediction ledger row (the #58 ledger-gap fix). */
interface TxnRow {
  type: string;
  amount: number;
  balance_after: number;
  metadata: { request_id?: string } | null;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Boot a guild with polls + predictions enabled (the DB columns default to false, so
 * they must be seeded to reflect a live guild whose owner turned the features on). The
 * primitives run regardless of the flags, but seeding them keeps the fixture faithful.
 */
async function bootPollsPredictions(
  ctx: ScenarioContext,
  opts: {
    label?: string;
    guildId?: string;
    pollsEnabled?: boolean;
    predictionsEnabled?: boolean;
    configOverrides?: Record<string, unknown>;
  } = {},
): Promise<LiveClientHandle> {
  return ctx.bootGuild({
    label: opts.label,
    guildId: opts.guildId,
    economyStartingBalance: 0,
    guildConfigOverrides: {
      polls_enabled: opts.pollsEnabled ?? true,
      predictions_enabled: opts.predictionsEnabled ?? true,
      ...(opts.configOverrides ?? {}),
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
 * The EXACT ledger settle RPC the bot's money path runs: applies the signed wallet
 * delta AND writes the economy_transactions row in ONE serializable call, replay-fenced
 * on (guild, user, metadata request_id).
 */
async function settleRpc(
  handle: LiveClientHandle,
  userId: string,
  amount: number,
  type: 'prediction_bet' | 'prediction_payout' | 'prediction_refund',
  requestId: string,
  description: string,
): Promise<{ result: SettleResult | null; error: PgErr }> {
  const { data, error } = await handle.supabase.rpc('economy_prediction_settle', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
    p_type: type,
    p_request_id: requestId,
    p_description: description,
  });
  return { result: (data as SettleResult | null) ?? null, error: (error as PgErr) ?? null };
}

/** A member's guild-scoped prediction ledger rows (economy_transactions). */
async function predictionTxns(
  handle: LiveClientHandle,
  userId: string,
  type?: 'prediction_bet' | 'prediction_payout' | 'prediction_refund',
): Promise<TxnRow[]> {
  let query = handle.supabase
    .from('economy_transactions')
    .select('type, amount, balance_after, metadata')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .in('type', ['prediction_bet', 'prediction_payout', 'prediction_refund']);
  if (type) query = query.eq('type', type);
  const { data } = await query.limit(1000);
  return (data as TxnRow[] | null) ?? [];
}

/** metadata->>request_id of a ledger row (undefined-safe for observation strings). */
function txnRequestId(txn: TxnRow | undefined): string | undefined {
  return txn?.metadata?.request_id;
}

/**
 * Reproduce `placeBet`'s exact ordered money primitives (the 2026-07-26 debit-first
 * flow): (1) settle the DEBIT through `economy_prediction_settle` (type prediction_bet,
 * request_id = the client-generated bet id — wallet delta + economy_transactions ledger
 * row land atomically), then (2) land the bet row + pool increment through
 * `prediction_place_bet` (atomic open-check + insert + increment under the same row
 * lock resolve takes). A refused fence ('duplicate' / 'closed' / 'not_found') is
 * compensated with the keyed refund exactly as the bot does. Surfaces each step's
 * outcome so a caller can assert the exact-once money movement AND its ledger rows.
 */
async function placeBet(
  handle: LiveClientHandle,
  predictionId: string,
  optionId: string,
  userId: string,
  amount: number,
): Promise<{
  betId: string;
  status: 'placed' | 'insufficient_funds' | 'debit-failed' | 'duplicate' | 'closed' | 'place-failed';
  debitErr: PgErr;
  placeErr: PgErr;
  refunded: boolean;
  newPool: number | null;
}> {
  const betId = randomUUID();
  const { result: debit, error: debitErr } = await settleRpc(
    handle,
    userId,
    -amount,
    'prediction_bet',
    betId,
    `Prediction bet (${predictionId})`,
  );
  if (debitErr) {
    return { betId, status: 'debit-failed', debitErr, placeErr: null, refunded: false, newPool: null };
  }
  if (debit?.status === 'insufficient_funds') {
    return { betId, status: 'insufficient_funds', debitErr: null, placeErr: null, refunded: false, newPool: null };
  }
  if (debit?.status !== 'settled') {
    return { betId, status: 'debit-failed', debitErr: null, placeErr: null, refunded: false, newPool: null };
  }

  const { data: placeData, error: placeErr } = await handle.supabase.rpc('prediction_place_bet', {
    p_bet_id: betId,
    p_prediction_id: predictionId,
    p_option_id: optionId,
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
  const placed = (placeData as PlaceResult | null) ?? null;

  // Keyed compensation for the settled debit (same request id — replay-safe and
  // mutually exclusive with a payout for this bet), mirroring the bot's refundBetDebit.
  const refundDebit = async (why: string): Promise<boolean> => {
    const { result } = await settleRpc(
      handle,
      userId,
      amount,
      'prediction_refund',
      betId,
      `Prediction bet refund — ${why} (${predictionId})`,
    );
    return result?.status === 'settled';
  };

  if (placeErr) {
    const refunded = await refundDebit('bet insert unconfirmed');
    await handle.supabase.from('prediction_bets').delete().eq('id', betId);
    return { betId, status: 'place-failed', debitErr: null, placeErr: (placeErr as PgErr) ?? null, refunded, newPool: null };
  }
  if (placed?.status === 'duplicate') {
    const refunded = await refundDebit('duplicate bet');
    return { betId, status: 'duplicate', debitErr: null, placeErr: null, refunded, newPool: null };
  }
  if (placed?.status === 'closed' || placed?.status === 'not_found') {
    const refunded = await refundDebit('prediction closed before bet landed');
    return { betId, status: 'closed', debitErr: null, placeErr: null, refunded, newPool: null };
  }
  if (placed?.status !== 'inserted') {
    const refunded = await refundDebit('unexpected place_bet status');
    await handle.supabase.from('prediction_bets').delete().eq('id', betId);
    return { betId, status: 'place-failed', debitErr: null, placeErr: null, refunded, newPool: null };
  }
  return {
    betId,
    status: 'placed',
    debitErr: null,
    placeErr: null,
    refunded: false,
    newPool: typeof placed.new_pool === 'number' ? placed.new_pool : null,
  };
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
 * Settle ONE bet's credit via the EXACT `economy_prediction_settle` RPC the bot's
 * settlement loop (`settleResolvedBets`) runs — request_id = the bet id, the credit
 * fence — then stamp the per-bet `payout` marker only on a FRESH settle, exactly as the
 * bot does: a marker-set bet is skipped up front, a `replayed` settle moved no money
 * now (and rewrites no marker), and a `conflicting_settlement` is a clean skip.
 */
async function settleOneBet(
  handle: LiveClientHandle,
  bet: BetRow,
  creditAmount: number,
  type: 'prediction_payout' | 'prediction_refund',
  predictionId: string,
): Promise<{ fresh: boolean; result: SettleResult | null; error: PgErr }> {
  if (bet.payout !== null) return { fresh: false, result: null, error: null }; // marker skip
  const { result, error } = await settleRpc(
    handle,
    bet.user_id,
    creditAmount,
    type,
    bet.id,
    type === 'prediction_payout' ? `Prediction payout (${predictionId})` : `Prediction refund (${predictionId})`,
  );
  if (error || result?.status !== 'settled' || result.replayed === true) {
    return { fresh: false, result, error };
  }
  await handle.supabase.from('prediction_bets').update({ payout: creditAmount }).eq('id', bet.id);
  return { fresh: true, result, error: null };
}

/** Settle a resolved prediction proportionally through the exact keyed settle RPC
 * (mirrors settleResolvedBets' winner loop: floor share, marker skip, keyed credit). */
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
    await settleOneBet(handle, bet, share, 'prediction_payout', predictionId);
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
 * PollsManager writes NO audit_logs row for any poll/prediction action. The MONEY path
 * now DOES write the economy_transactions prediction ledger (economy_prediction_settle
 * lands prediction_bet / prediction_payout / prediction_refund rows keyed on the bet
 * id), and those rows are asserted live in the money lanes alongside `prediction_bets`
 * (actor + guild + amount + idempotent payout marker). Only the dedicated
 * correlation-id audit_logs lane remains gated (a genuine architectural gap, NOT a
 * harness limitation).
 */
function gateAuditLog(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'discord-readback',
    'Every polls/predictions state change lands one append-only audit_logs row with actor, guild, and correlation id; anonymization (never deletion) is the only mutation.',
    'PollsManager still writes no audit_logs row (no AuditService call, no DB trigger); the money path now lands economy_transactions prediction_bet/payout/refund ledger rows (asserted live in the money lanes) and prediction_bets remains the per-bet operational evidence, but the dedicated correlation-id audit_logs lane is unbuilt',
  );
}

// ── Real-handler drive helpers (loopback slash-SUBCOMMAND + poll BUTTON) ────
// Since PR #331 the loopback injector drives slash subcommands + components
// in-process against the REAL handlers, so the member surfaces are driven live
// (never faked) and their captured replies asserted.

/** Captured-reply payload shape (string OR an embed-bearing object). */
interface ReplyPayload {
  content?: string;
  embeds?: Array<{ data?: { title?: string; description?: string } }>;
}

async function runPoll(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  subcommand: string,
  userId: string,
  options: Record<string, unknown>,
): Promise<CapturedResponse> {
  return ctx.runSlash(handle, { commandName: 'poll', userId, subcommand, options });
}

async function runPredict(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  subcommand: string,
  userId: string,
  options: Record<string, unknown>,
): Promise<CapturedResponse> {
  return ctx.runSlash(handle, { commandName: 'predict', userId, subcommand, options });
}

/** Drive the REAL poll vote button (`poll:{id}:{opt}`) through the injector. */
async function clickPollButton(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  pollId: string,
  optionId: string,
  userId: string,
): Promise<CapturedResponse> {
  return ctx.injectorFor(handle).inject(
    buildButtonInteraction({
      customId: `poll:${pollId}:${optionId}`,
      guildId: handle.guildId,
      client: handle.client,
      user: { id: userId, username: userId, displayName: userId },
    }),
  );
}

/** The last editReply/reply payload the handler produced (string OR embed object). */
function lastReplyPayload(cap: CapturedResponse): ReplyPayload | string | undefined {
  const edits = cap.allOf('editReply');
  const reply = cap.allOf('reply');
  return (edits[edits.length - 1] ?? reply[reply.length - 1])?.payload as ReplyPayload | string | undefined;
}

/** The text content of the last reply (for ephemeral content replies). */
function replyText(cap: CapturedResponse): string {
  const p = lastReplyPayload(cap);
  if (typeof p === 'string') return p;
  return String(p?.content ?? '');
}

/** The first embed's `.data` (title/description) of the last reply. */
function replyEmbed(cap: CapturedResponse): { title?: string; description?: string } | undefined {
  const p = lastReplyPayload(cap);
  if (typeof p === 'string' || !p) return undefined;
  return p.embeds?.[0]?.data;
}

async function pollByTitle(handle: LiveClientHandle, title: string): Promise<{ id: string } | null> {
  const { data } = await handle.supabase
    .from('polls')
    .select('id')
    .eq('guild_id', handle.guildId)
    .eq('title', title)
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null) ?? null;
}

async function predictionByTitle(handle: LiveClientHandle, title: string): Promise<{ id: string } | null> {
  const { data } = await handle.supabase
    .from('predictions')
    .select('id')
    .eq('guild_id', handle.guildId)
    .eq('title', title)
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null) ?? null;
}

async function pollOptionIds(handle: LiveClientHandle, pollId: string): Promise<string[]> {
  const { data } = await handle.supabase
    .from('poll_options')
    .select('id, sort_order')
    .eq('poll_id', pollId)
    .order('sort_order')
    .limit(1000);
  return ((data as OptionRow[] | null) ?? []).map((o) => o.id);
}

async function countPollsByTitle(handle: LiveClientHandle, title: string): Promise<number> {
  const { count } = await handle.supabase
    .from('polls')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('title', title);
  return count ?? 0;
}

/** Read the two guild_config fields the member surfaces branch on / brand with. */
async function guildSurfaceConfig(
  handle: LiveClientHandle,
): Promise<{ predictionsEnabled: boolean; currency: string }> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select('predictions_enabled, currency_name')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const row = data as { predictions_enabled?: boolean; currency_name?: string } | null;
  return { predictionsEnabled: row?.predictions_enabled ?? false, currency: row?.currency_name ?? 'coins' };
}

/**
 * Drive the REAL member surfaces end-to-end for a fresh, isolated `surface` member and
 * assert their captured replies live (replaces the former captured-reply/live-reply
 * gates). Covers: the branded poll board (/poll create), a real vote button, and — when
 * predictions are enabled — the branded prediction board, bet confirmation, and settle
 * announcement, each carrying the owner-configured currency name (white-label). When
 * predictions are OFF it proves /predict create declines gracefully while polls run.
 * Only the live-CHANNEL readback (posted-message pixels / brand-kit / in-place tally
 * updates) stays gated. Uses a run-prefixed `surface` user so it never collides with a
 * scenario's own DB assertions.
 */
async function proveMemberSurfaces(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const u = ctx.userId('surface');
  const title = `${ctx.runPrefix}srf`;
  const { predictionsEnabled, currency } = await guildSurfaceConfig(handle);

  // Poll board — the REAL /poll create renders a branded embed with vote buttons.
  const pollCap = await runPoll(ctx, handle, 'create', u, { title, options: 'Red,Green,Blue', multiple: false });
  const pollEmbed = replyEmbed(pollCap);
  ctx.expect(typeof pollEmbed?.title === 'string' && pollEmbed.title.includes(title), {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise: 'The member-facing /poll create surface renders a branded poll embed (title + option list + vote buttons) in the owner voice.',
    observation: `driving the REAL /poll create replied with an embed titled ${JSON.stringify(pollEmbed?.title)} (expected to include the poll title "${title}").`,
    impact: 'The /poll create member surface did not render the branded poll embed.',
  });

  // Vote button — clicking poll:{id}:{opt} drives handlePollVote and confirms ephemerally.
  const poll = await pollByTitle(handle, title);
  const optIds = poll ? await pollOptionIds(handle, poll.id) : [];
  const voteCap = poll && optIds[0] ? await clickPollButton(ctx, handle, poll.id, optIds[0]!, u) : null;
  const voteText = voteCap ? replyText(voteCap) : '';
  ctx.expect(voteText.toLowerCase().includes('vote'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Clicking a poll vote button drives the REAL handlePollVote, records the vote, and replies with an ephemeral confirmation.',
    observation: `the poll:{id}:{opt} button reply was ${JSON.stringify(voteText)} (expected a vote confirmation).`,
    impact: 'The poll vote button did not record and confirm the member vote.',
  });

  if (predictionsEnabled) {
    // Prediction board — branded embed carrying the owner-configured currency name.
    const createCap = await runPredict(ctx, handle, 'create', u, { title, options: 'Yes,No' });
    const createEmbed = replyEmbed(createCap);
    ctx.expect(
      typeof createEmbed?.title === 'string' && createEmbed.title.includes(title) && (createEmbed.description ?? '').includes(currency),
      {
        assertionClass: 'branding',
        channel: 'captured-reply',
        promise: 'The /predict create surface renders a branded prediction embed showing the owner-configured currency name (white-label), not the stock fallback.',
        observation: `/predict create embed titled ${JSON.stringify(createEmbed?.title)}; description mentions the configured currency "${currency}": ${(createEmbed?.description ?? '').includes(currency)}.`,
        impact: 'The /predict create surface did not render the branded embed with the configured currency name.',
      },
    );

    const pred = await predictionByTitle(handle, title);
    if (pred) {
      await seedWallet(handle, u, 100000);
      // Bet confirmation — names the staked amount + new pool in the configured currency.
      const betCap = await runPredict(ctx, handle, 'bet', u, { prediction_id: pred.id, option: 1, amount: 500 });
      const betEmbed = replyEmbed(betCap);
      ctx.expect(
        typeof betEmbed?.title === 'string' && /bet placed/i.test(betEmbed.title) && (betEmbed.description ?? '').includes(currency),
        {
          assertionClass: 'Discord',
          channel: 'captured-reply',
          promise: 'A /predict bet replies with a branded bet-confirmation embed naming the staked amount + pool in the configured currency.',
          observation: `/predict bet reply embed titled ${JSON.stringify(betEmbed?.title)}; mentions currency "${currency}": ${(betEmbed?.description ?? '').includes(currency)}.`,
          impact: 'The /predict bet member surface did not render the branded bet confirmation.',
        },
      );

      // Settle announcement — the creator's /predict resolve names the outcome + pool.
      const resolveCap = await runPredict(ctx, handle, 'resolve', u, { prediction_id: pred.id, winner: 1 });
      const resolveEmbed = replyEmbed(resolveCap);
      ctx.expect(
        typeof resolveEmbed?.title === 'string' && /resolved/i.test(resolveEmbed.title) && (resolveEmbed.description ?? '').includes(currency),
        {
          assertionClass: 'Discord',
          channel: 'captured-reply',
          promise: 'A creator /predict resolve replies with a branded settle announcement naming the winning outcome + pool in the configured currency.',
          observation: `/predict resolve reply embed titled ${JSON.stringify(resolveEmbed?.title)}; mentions currency "${currency}": ${(resolveEmbed?.description ?? '').includes(currency)}.`,
          impact: 'The /predict resolve settle announcement did not render in the branded owner voice.',
        },
      );
    }
  } else {
    // Predictions disabled — /predict create declines gracefully in the owner voice.
    const declineCap = await runPredict(ctx, handle, 'create', u, { title, options: 'Yes,No' });
    const declineText = replyText(declineCap);
    ctx.expect(declineText.toLowerCase().includes('not enabled'), {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise: 'With predictions disabled, /predict create declines gracefully (feature-off notice) while the /poll create surface still renders its branded board.',
      observation: `/predict create replied ${JSON.stringify(declineText)} (expected a "not enabled" notice).`,
      impact: 'The predictions-disabled path did not surface the feature-off notice.',
    });
  }

  // Residuals — the live CHANNEL readback still needs a real gateway; the in-process
  // replies are proven above, so these are the honest remainder (not a harness excuse).
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on the poll/prediction embeds as rendered in the live guild.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild); the in-process reply embeds + configured currency name are asserted via captured-reply above',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'The poll/prediction embeds are delivered to the live channel and the poll message’s per-option button tallies update in place as members vote.',
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) to read back the posted channel message; the in-process reply surfaces are proven via captured-reply above',
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

  // 4) /poll close — drive the REAL creator close (V47-L2 fixed the flip to gate on the
  //    real 'active' status): it transitions the poll open→closed and posts the tally.
  const closeCap = await runPoll(ctx, handle, 'close', userA, { poll_id: poll.pollId });
  const closeEmbed = replyEmbed(closeCap);
  const afterClose = await readPoll(handle, poll.pollId);
  ctx.expect(
    afterClose?.status === 'closed' &&
      afterClose?.closed_at !== null &&
      typeof closeEmbed?.title === 'string' &&
      /poll closed/i.test(closeEmbed.title),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'The creator’s /poll close transitions the poll open→closed and posts the final tally (state machine "close-poll").',
      observation:
        `after driving the REAL /poll close as the creator: poll status="${afterClose?.status}" (expected "closed"), ` +
        `closed_at=${afterClose?.closed_at ?? 'null'}; close reply embed titled ${JSON.stringify(closeEmbed?.title)} (expected a "Poll Closed" tally).`,
      impact:
        '/poll close did not flip the poll to closed and post the tally — a poll can never be closed (the close path’s status gate no longer matches the real "active" default).',
    },
  );

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

  // 6) Bets — three members stake through the EXACT money primitives the bot runs
  //    (economy_prediction_settle debit-first, then prediction_place_bet's fence).
  await seedWallet(handle, userB, 1000);
  await seedWallet(handle, userC, 1000);
  await seedWallet(handle, userD, 1000);
  const yes = pred.optionIds[0]!;
  const no = pred.optionIds[1]!;
  const betB = await placeBet(handle, pred.predictionId, yes, userB, 100);
  const betC = await placeBet(handle, pred.predictionId, yes, userC, 200);
  const betD = await placeBet(handle, pred.predictionId, no, userD, 300);
  const wB = await readWallet(handle, userB);
  const wC = await readWallet(handle, userC);
  const wD = await readWallet(handle, userD);
  const poolRow = await readPrediction(handle, pred.predictionId);
  ctx.expect(
    betB.status === 'placed' &&
      betC.status === 'placed' &&
      betD.status === 'placed' &&
      wB?.wallet === 900 &&
      wC?.wallet === 800 &&
      wD?.wallet === 700 &&
      poolRow?.total_pool === 600,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Each accepted bet settles its debit exactly once (economy_prediction_settle, debit-first) and escrows the stake into the pool through prediction_place_bet’s atomic open-check + insert + pool increment.',
      observation:
        `bet statuses B/C/D=${betB.status}/${betC.status}/${betD.status} (all "placed"); ` +
        `wallets after bets: B=${wB?.wallet} (900), C=${wC?.wallet} (800), D=${wD?.wallet} (700); ` +
        `escrowed pool=${poolRow?.total_pool} (expected 100+200+300=600).`,
      impact: 'A bet did not debit its stake exactly once or did not escrow it into the pool.',
    },
  );

  // 6b) The LEDGER — every debit landed ONE economy_transactions prediction_bet row,
  //     amount = -stake, keyed on its bet id (the #58 prediction-ledger gap, closed).
  const bDebits = await predictionTxns(handle, userB, 'prediction_bet');
  const cDebits = await predictionTxns(handle, userC, 'prediction_bet');
  const dDebits = await predictionTxns(handle, userD, 'prediction_bet');
  ctx.expect(
    bDebits.length === 1 &&
      bDebits[0]?.amount === -100 &&
      txnRequestId(bDebits[0]) === betB.betId &&
      cDebits.length === 1 &&
      cDebits[0]?.amount === -200 &&
      txnRequestId(cDebits[0]) === betC.betId &&
      dDebits.length === 1 &&
      dDebits[0]?.amount === -300 &&
      txnRequestId(dDebits[0]) === betD.betId,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Every bet debit writes exactly one economy_transactions ledger row (type prediction_bet, amount = -stake, metadata.request_id = the bet id) — prediction money is no longer invisible to /mydata exports and the analytics ledger.',
      observation:
        `prediction_bet ledger rows: B=${bDebits.length} (amount ${bDebits[0]?.amount}, keyed=${txnRequestId(bDebits[0]) === betB.betId}), ` +
        `C=${cDebits.length} (amount ${cDebits[0]?.amount}, keyed=${txnRequestId(cDebits[0]) === betC.betId}), ` +
        `D=${dDebits.length} (amount ${dDebits[0]?.amount}, keyed=${txnRequestId(dDebits[0]) === betD.betId}) — expected exactly one each, request_id = bet id.`,
      impact: 'A bet debit moved wallet money without its economy_transactions ledger row (or with a mis-keyed one) — the prediction ledger under-reports stakes.',
    },
  );

  // 7) Settlement — proportional exactly-once via the bot's own atomic resolve + the
  //    keyed economy_prediction_settle credits.
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
      promise: 'Resolve flips the prediction to settled and pays each winner its proportional pot share exactly once through economy_prediction_settle (losers keep nothing).',
      observation:
        `status="${predResolved?.status}" (resolved), locked pool=${resolved.pool} (600); ` +
        `winner wallets B=${wBs?.wallet} (900+200 share=1100), C=${wCs?.wallet} (800+400 share=1200); loser D=${wDs?.wallet} (unchanged 700).`,
      impact: 'The pot was not distributed proportionally / exactly once on resolve.',
    },
  );

  // 8) Audit — prediction_bets markers set for winners, null for the loser, pot conserved.
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

  // 8b) The settlement LEDGER — each winner's credit landed ONE prediction_payout row
  //     keyed on its bet id; the loser has NO credit row; ledger payouts = the pot.
  const bPayTx = await predictionTxns(handle, userB, 'prediction_payout');
  const cPayTx = await predictionTxns(handle, userC, 'prediction_payout');
  const dCreditTx = (await predictionTxns(handle, userD)).filter((t) => t.type !== 'prediction_bet');
  const ledgerPaid = (bPayTx[0]?.amount ?? 0) + (cPayTx[0]?.amount ?? 0);
  ctx.expect(
    bPayTx.length === 1 &&
      bPayTx[0]?.amount === 200 &&
      txnRequestId(bPayTx[0]) === betB.betId &&
      cPayTx.length === 1 &&
      cPayTx[0]?.amount === 400 &&
      txnRequestId(cPayTx[0]) === betC.betId &&
      dCreditTx.length === 0 &&
      ledgerPaid === 600,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Each winner’s payout writes exactly one economy_transactions ledger row (type prediction_payout, metadata.request_id = the bet id) whose amounts reconcile to the pot; the loser gets no credit row.',
      observation:
        `prediction_payout ledger rows: B=${bPayTx.length} (amount ${bPayTx[0]?.amount}, keyed=${txnRequestId(bPayTx[0]) === betB.betId}), ` +
        `C=${cPayTx.length} (amount ${cPayTx[0]?.amount}, keyed=${txnRequestId(cPayTx[0]) === betC.betId}); loser credit rows=${dCreditTx.length} (0); ` +
        `ledger paid total=${ledgerPaid} (expected =pool 600).`,
      impact: 'A settlement credit moved wallet money without its keyed prediction_payout ledger row (or the ledger did not reconcile to the pot).',
    },
  );

  // 9) Replay-safety — a re-delivered resolve + re-driven settlement loop move nothing:
  //    predictions_resolve_atomic returns no pool, marker-set bets are skipped, and the
  //    LEDGER shows exactly one payout row of record per winner.
  const reResolve = await resolveAtomic(handle, pred.predictionId, yes);
  const storedPool = (await readPrediction(handle, pred.predictionId))?.total_pool ?? 0;
  await settleProportional(handle, pred.predictionId, yes, storedPool); // the bot's re-drive path
  const wBReplay = await readWallet(handle, userB);
  const bPayTxReplay = await predictionTxns(handle, userB, 'prediction_payout');
  ctx.expect(reResolve.pool === null && wBReplay?.wallet === 1100 && bPayTxReplay.length === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering the resolve never double-pays: predictions_resolve_atomic settles exactly once, and re-driving the settlement loop leaves exactly one prediction_payout ledger row per winner (the economy_prediction_settle replay fence).',
    observation:
      `second predictions_resolve_atomic returned pool=${reResolve.pool} (expected none); winner wallet after replayed settle loop=${wBReplay?.wallet} (unchanged 1100); ` +
      `prediction_payout ledger rows for the winner=${bPayTxReplay.length} (expected exactly 1).`,
    impact: 'A re-delivered resolve re-settled the prediction — winners would be double-paid (or the ledger recorded a duplicate payout).',
  });

  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handle);
  await proveMemberSurfaces(ctx, handle);
  gateAuditLog(ctx);
}

/** SET-A — multi-select behavior works AND the raised minimum bet (100) is enforced live. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const minBetDefault = Number(declaredDefault(ctx.domain, 'prediction-min-bet')); // 1
  const raisedMin = 100; // SET-A's contracted raised minimum
  // Boot with the raised minimum saved (the prediction_bet_limits migration added the
  // column; placeBet enforces cfg.prediction_min_bet ?? 1 before touching the wallet).
  const handle = await bootPollsPredictions(ctx, {
    label: 'a',
    configOverrides: { prediction_min_bet: raisedMin },
  });
  const userA = ctx.userId('a');
  const bettor = ctx.userId('bettor');

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

  // The raised minimum persisted to guild_config — the value placeBet reads live.
  const { data: cfg } = await handle.supabase
    .from('guild_config')
    .select('prediction_min_bet')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const savedMin = (cfg as { prediction_min_bet?: number } | null)?.prediction_min_bet;
  ctx.expect(savedMin === raisedMin, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: `A dashboard save of the raised minimum bet (${raisedMin}) persists to guild_config and is what placeBet gates on live (no restart).`,
    observation: `guild_config.prediction_min_bet=${savedMin} (expected ${raisedMin}; catalog default ${minBetDefault}).`,
    impact: 'The raised minimum-bet setting did not persist / would not take live effect.',
  });

  // Drive the REAL /predict create + /predict bet: a sub-minimum (50) bet is REJECTED
  // citing the minimum, with no bet row and no stake moved.
  const title = `${ctx.runPrefix}minbet`;
  await runPredict(ctx, handle, 'create', userA, { title, options: 'Yes,No' });
  const pred = await predictionByTitle(handle, title);
  await seedWallet(handle, bettor, 1000);
  const rejectCap = pred ? await runPredict(ctx, handle, 'bet', bettor, { prediction_id: pred.id, option: 1, amount: 50 }) : null;
  const rejectText = rejectCap ? replyText(rejectCap) : '';
  const rejectRows = pred ? await betsFor(handle, pred.id, bettor) : [];
  const rejectTx = await predictionTxns(handle, bettor);
  const walletAfterReject = await readWallet(handle, bettor);
  ctx.expect(
    /minimum bet/i.test(rejectText) && rejectRows.length === 0 && rejectTx.length === 0 && walletAfterReject?.wallet === 1000,
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: `SET-A: with the minimum bet raised to ${raisedMin}, a 50-coin /predict bet is rejected citing the minimum, and no bet row, ledger row, or debit occurs.`,
      observation:
        `/predict bet(50) replied ${JSON.stringify(rejectText)} (expected a "Minimum bet" rejection); ` +
        `bet rows for the bettor=${rejectRows.length} (expected 0); prediction ledger rows=${rejectTx.length} (expected 0); wallet=${walletAfterReject?.wallet} (untouched 1000).`,
      impact: 'The configurable minimum-bet floor did not reject a sub-minimum bet — the owner’s raised minimum has no effect.',
    },
  );

  // A bet AT/above the minimum is accepted through the REAL handler and lands exactly
  // one prediction_bets row PLUS its keyed economy_transactions prediction_bet ledger
  // row — the driven proof that the product's debit-first ledger wiring is live.
  const acceptCap = pred ? await runPredict(ctx, handle, 'bet', bettor, { prediction_id: pred.id, option: 1, amount: raisedMin }) : null;
  const acceptEmbed = acceptCap ? replyEmbed(acceptCap) : undefined;
  const acceptRows = pred ? await betsFor(handle, pred.id, bettor) : [];
  const acceptTx = await predictionTxns(handle, bettor, 'prediction_bet');
  ctx.expect(
    acceptRows.length === 1 &&
      acceptRows[0]?.amount === raisedMin &&
      acceptTx.length === 1 &&
      acceptTx[0]?.amount === -raisedMin &&
      txnRequestId(acceptTx[0]) === acceptRows[0]?.id &&
      typeof acceptEmbed?.title === 'string' &&
      /bet placed/i.test(acceptEmbed.title),
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: `A bet at the raised minimum (${raisedMin}) driven through the REAL /predict bet lands exactly one prediction_bets row AND exactly one economy_transactions prediction_bet ledger row (amount = -${raisedMin}, request_id = the bet id).`,
      observation:
        `prediction_bets rows for the bettor=${acceptRows.length}, amount=${acceptRows[0]?.amount ?? '(none)'} (expected ${raisedMin}); ` +
        `prediction_bet ledger rows=${acceptTx.length} (amount ${acceptTx[0]?.amount ?? '(none)'}, keyed to bet id=${txnRequestId(acceptTx[0]) === acceptRows[0]?.id}); ` +
        `confirmation embed titled ${JSON.stringify(acceptEmbed?.title)}.`,
      impact: 'A minimum-satisfying bet did not produce exactly one bet row + one keyed ledger row / branded confirmation — the product’s ledger wiring is broken.',
    },
  );

  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handle);
  await proveMemberSurfaces(ctx, handle);
  gateAuditLog(ctx);
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
  // proveMemberSurfaces detects predictions-off and drives the REAL /predict create
  // decline reply live while /poll create renders its branded board.
  await proveMemberSurfaces(ctx, handle);
  gateAuditLog(ctx);
  gateReplayDeferredTo(ctx, 'DEF / REPLAY / RACE');
}

/** INVALID — invalid inputs never persist: a zero-amount bet is rejected by the DB CHECK. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const maxOptions = Number(declaredDefault(ctx.domain, 'max-poll-options')); // 10
  const handle = await bootPollsPredictions(ctx, { label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // A zero-amount bet never persists — every layer of the money path rejects it
  // independently: economy_prediction_settle's sign fence (a prediction_bet debit must
  // be negative), prediction_place_bet's amount>0 guard, and the prediction_bets
  // CHECK(amount>0) backstop for a raw insert. No ledger row, no bet row, no movement.
  const pred = await createPredictionRows(ctx, handle, userA, ['Yes', 'No']);
  await seedWallet(handle, userB, 1000);
  const zeroDebit = await settleRpc(handle, userB, 0, 'prediction_bet', randomUUID(), 'zero-amount bet probe');
  const { error: zeroPlaceErr } = await handle.supabase.rpc('prediction_place_bet', {
    p_bet_id: randomUUID(),
    p_prediction_id: pred.predictionId,
    p_option_id: pred.optionIds[0]!,
    p_guild_id: handle.guildId,
    p_user_id: userB,
    p_amount: 0,
  });
  const { error: zeroInsertErr } = await handle.supabase.from('prediction_bets').insert({
    prediction_id: pred.predictionId,
    option_id: pred.optionIds[0]!,
    guild_id: handle.guildId,
    user_id: userB,
    amount: 0,
  });
  const betRows = await betsFor(handle, pred.predictionId, userB);
  const zeroTx = await predictionTxns(handle, userB);
  const wallet = await readWallet(handle, userB);
  ctx.expect(
    zeroDebit.error !== null &&
      zeroPlaceErr !== null &&
      (zeroInsertErr as PgErr)?.code === '23514' &&
      betRows.length === 0 &&
      zeroTx.length === 0 &&
      wallet?.wallet === 1000,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'A zero-amount bet is rejected at every money layer: the settle RPC’s sign fence, prediction_place_bet’s amount>0 guard, and the prediction_bets CHECK — no bet row, no ledger row, no balance movement.',
      observation:
        `zero-amount economy_prediction_settle errored=${zeroDebit.error !== null}; prediction_place_bet errored=${zeroPlaceErr !== null}; ` +
        `raw insert error code=${(zeroInsertErr as PgErr)?.code ?? '(none)'} (expected 23514 check_violation); ` +
        `bet rows=${betRows.length} (expected 0); ledger rows=${zeroTx.length} (expected 0); wallet=${wallet?.wallet} (expected untouched 1000).`,
      impact: 'A zero-amount bet persisted, wrote a ledger row, or moved balance — an amount>0 guard did not hold.',
    },
  );

  // The prediction row itself is a valid, guild-scoped row (positive RLS control).
  await proveRlsIsolation(ctx, handle, 'predictions');
  await proveNoOwnerAlert(ctx, handle);

  // Poll option-count validation (1 option / 11 options) lives in createPoll's TypeScript
  // guard (`options.length < 2 || > 10`). Drive the REAL /poll create through the
  // subcommand handler for both out-of-range counts and assert each is rejected with the
  // "2-10 options" notice and writes NO poll row.
  const oneTitle = `${ctx.runPrefix}one`;
  const manyTitle = `${ctx.runPrefix}many`;
  const oneCap = await runPoll(ctx, handle, 'create', userA, { title: oneTitle, options: 'OnlyOne', multiple: false });
  const manyOpts = Array.from({ length: maxOptions + 1 }, (_, i) => `o${i}`).join(',');
  const manyCap = await runPoll(ctx, handle, 'create', userA, { title: manyTitle, options: manyOpts, multiple: false });
  const oneText = replyText(oneCap);
  const manyText = replyText(manyCap);
  const oneRows = await countPollsByTitle(handle, oneTitle);
  const manyRows = await countPollsByTitle(handle, manyTitle);
  ctx.expect(/2-10 options/i.test(oneText) && /2-10 options/i.test(manyText) && oneRows === 0 && manyRows === 0, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: `/poll create with 1 option or ${maxOptions + 1} options is rejected with "Polls need 2-10 options" and writes no poll/option rows.`,
    observation:
      `1-option /poll create replied ${JSON.stringify(oneText)} (rows=${oneRows}); ` +
      `${maxOptions + 1}-option /poll create replied ${JSON.stringify(manyText)} (rows=${manyRows}) — expected both rejected, zero rows.`,
    impact: 'An out-of-range poll option count was accepted (or wrote a poll row) — the 2-10 validation guard did not hold.',
  });
  ctx.gate(
    'audit',
    'discord-readback',
    'Each rejected input lands one audit row with its validation reason.',
    'PollsManager writes no audit_logs row for rejected creates/bets (no AuditService call, no DB trigger) — the reject replies are now driven live above, but there is no audit lane to read',
  );
  await proveMemberSurfaces(ctx, handle);
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

  // Drive the REAL creator-only guards as a NON-creator (userB): /poll close and
  // /predict resolve are both refused ("Only the creator…"), the poll stays active, the
  // prediction stays open, and userC's escrowed bet stays unpaid.
  const closeCap = await runPoll(ctx, handle, 'close', userB, { poll_id: poll.pollId });
  const closeText = replyText(closeCap);
  const pollAfterDenied = await readPoll(handle, poll.pollId);
  ctx.expect(/only the poll creator/i.test(closeText) && pollAfterDenied?.status === 'active', {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'A non-creator’s /poll close is refused ("Only the poll creator can close it.") and the poll stays open.',
    observation: `non-creator /poll close replied ${JSON.stringify(closeText)}; poll status="${pollAfterDenied?.status}" (expected still "active").`,
    impact: 'A non-creator was able to close (or affect) another member’s poll — the creator-only close guard failed.',
  });

  const resolveCap = await runPredict(ctx, handle, 'resolve', userB, { prediction_id: pred.predictionId, winner: 1 });
  const resolveText = replyText(resolveCap);
  const predAfterDenied = await readPrediction(handle, pred.predictionId);
  const cBetAfterDenied = await betsFor(handle, pred.predictionId, userC);
  const cCreditTx = (await predictionTxns(handle, userC)).filter((t) => t.type !== 'prediction_bet');
  ctx.expect(
    /only the creator/i.test(resolveText) &&
      predAfterDenied?.status === 'open' &&
      cBetAfterDenied[0]?.payout === null &&
      cCreditTx.length === 0,
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A non-creator’s /predict resolve is refused ("Only the creator can resolve…"), the prediction stays open, and no bet is settled — the bettor’s ledger shows the escrowed debit and NO payout/refund credit.',
      observation:
        `non-creator /predict resolve replied ${JSON.stringify(resolveText)}; prediction status="${predAfterDenied?.status}" (expected "open"); ` +
        `bettor payout=${cBetAfterDenied[0]?.payout ?? 'null'} (expected unpaid); bettor credit ledger rows=${cCreditTx.length} (expected 0).`,
      impact: 'A non-creator settled a prediction — the creator-only resolve guard failed and bets moved without authority.',
    },
  );

  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handle);
  ctx.gate(
    'audit',
    'discord-readback',
    'Each denied close/resolve attempt is audited with actor, target id, and reason permission-denied.',
    'PollsManager writes no audit_logs row for denied attempts (no AuditService call, no DB trigger); the creator-only guard is now driven live above and refuses the non-creator, but writes no audit row',
  );
  await proveMemberSurfaces(ctx, handle);
  gateReplayDeferredTo(ctx, 'DEF / REPLAY / RACE');
}

/** DEPFAIL — Supabase-unreachable fail-safe, driven through the REAL fault
 *  proxy (ctx.faults severs the actual network path run-one-domain routed the
 *  stack through). Falls back to honest gates when no proxy is registered
 *  (e.g. the CI vitest lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const supabaseFault = ctx.faults?.supabase;
  if (supabaseFault) {
    const handle = await bootPollsPredictions(ctx, { label: 'a' });
    const userA = ctx.userId('a'); // creator
    const bettor = ctx.userId('b');
    const pred = await createPredictionRows(ctx, handle, userA, ['Yes', 'No']);
    await seedWallet(handle, bettor, 1000);

    // ── Outage window: a REAL severed network path (ECONNREFUSED). ──
    await supabaseFault.sever();
    let threw: string | null = null;
    let severedReply = '';
    let severedEmbed: { title?: string; description?: string } | undefined;
    try {
      const cap = await runPredict(ctx, handle, 'bet', bettor, {
        prediction_id: pred.predictionId,
        option: 1,
        amount: 100,
      });
      severedReply = replyText(cap);
      severedEmbed = replyEmbed(cap);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await supabaseFault.restore();

    // (1) Fail-SAFE: the bet command replied, never crashed the pipeline.
    ctx.expect(threw === null && severedReply.length > 0, {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'With database access blocked, /predict bet still replies (fail-safe rejection) instead of crashing the interaction pipeline.',
      observation: `during the outage window /predict bet ${threw === null ? `replied ${JSON.stringify(truncate(severedReply, 120))}` : `THREW ${truncate(threw, 120)}`}.`,
      impact: 'A database outage crashed the /predict bet pipeline instead of degrading to a rejection.',
    });

    // (2) The catalog contracts the friendly unavailable rejection — never a
    //     data-shaped answer fabricated from the failed read. "Prediction is
    //     not open for bets" (unreadable prediction) or "Insufficient balance"
    //     (unreadable wallet) during an outage are lies about state the bot
    //     could not read. Recorded honestly; never softened.
    const looksUnavailable = /unavailable|try again|temporar|later/i.test(severedReply);
    const dataShapedLie = /not open for bets|insufficient balance|already placed|invalid option/i.test(severedReply) || severedEmbed !== undefined;
    ctx.expect(looksUnavailable && !dataShapedLie, {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise: 'The outage-window bet is rejected with the branded predictions-unavailable notice — never a fabricated state claim ("not open", "insufficient balance") or a bet confirmation.',
      observation: `outage-window reply ${JSON.stringify(truncate(severedReply, 120))} (embed=${severedEmbed !== undefined}) — looksUnavailable=${looksUnavailable}, dataShapedLie=${dataShapedLie}.`,
      impact: 'During a database outage /predict bet fabricated a data-shaped rejection (or confirmation) from state it could not read, instead of the branded unavailable notice.',
    });

    // (3) Money stays safe: zero debits without matching bet rows — no phantom
    //     or partial money movement through the outage window.
    const walletAfterOutage = await readWallet(handle, bettor);
    const betsAfterOutage = await betsFor(handle, pred.predictionId, bettor);
    const predAfterOutage = await readPrediction(handle, pred.predictionId);
    const txAfterOutage = await predictionTxns(handle, bettor);
    ctx.expect(
      walletAfterOutage?.wallet === 1000 &&
        betsAfterOutage.length === 0 &&
        txAfterOutage.length === 0 &&
        predAfterOutage?.total_pool === 0 &&
        predAfterOutage?.status === 'open',
      {
        assertionClass: 'replay-safety',
        channel: 'db-observable',
        promise: 'A bet that could not be recorded debits nothing: after restoration the balance shows no debit, no bet row exists, the ledger holds zero prediction rows, and the pool is untouched (no phantom stakes).',
        observation:
          `post-restore: bettor wallet=${walletAfterOutage?.wallet} (expected untouched 1000), bet rows=${betsAfterOutage.length} (expected 0), ` +
          `prediction ledger rows=${txAfterOutage.length} (expected 0), pool=${predAfterOutage?.total_pool} (expected 0), prediction status="${predAfterOutage?.status}" (expected "open").`,
        impact: 'The outage window produced phantom or partial money movement (a debit without a bet row, an orphaned ledger row, a ghost bet, or a corrupted pool).',
      },
    );

    // (4) RECOVERY: a fresh bet through the same real handler succeeds cleanly.
    const freshCap = await runPredict(ctx, handle, 'bet', bettor, {
      prediction_id: pred.predictionId,
      option: 1,
      amount: 100,
    });
    const freshEmbed = replyEmbed(freshCap);
    const walletAfterFresh = await readWallet(handle, bettor);
    const predAfterFresh = await readPrediction(handle, pred.predictionId);
    ctx.expect(
      typeof freshEmbed?.title === 'string' &&
        /bet placed/i.test(freshEmbed.title) &&
        walletAfterFresh?.wallet === 900 &&
        predAfterFresh?.total_pool === 100,
      {
        assertionClass: 'Discord',
        channel: 'captured-reply',
        promise: 'After restoration a fresh /predict bet succeeds cleanly: branded confirmation, one debit, and the stake escrowed into the pool.',
        observation:
          `post-restore /predict bet embed titled ${JSON.stringify(freshEmbed?.title)}; wallet=${walletAfterFresh?.wallet} (expected 900); ` +
          `pool=${predAfterFresh?.total_pool} (expected 100).`,
        impact: 'The predictions pipeline did not recover after the outage ended.',
      },
    );

    // (5) Append-only evidence for the post-recovery bet: exactly one guild-scoped
    //     prediction_bets row AND exactly one keyed economy_transactions ledger row.
    const freshBets = await betsFor(handle, pred.predictionId, bettor);
    const freshTx = await predictionTxns(handle, bettor, 'prediction_bet');
    ctx.expect(
      freshBets.length === 1 &&
        freshBets[0]?.amount === 100 &&
        freshBets[0]?.guild_id === handle.guildId &&
        freshTx.length === 1 &&
        freshTx[0]?.amount === -100 &&
        txnRequestId(freshTx[0]) === freshBets[0]?.id,
      {
        assertionClass: 'audit',
        channel: 'audit-row',
        promise: 'The post-recovery bet lands exactly one append-only prediction_bets row (actor + guild + amount) plus exactly one economy_transactions prediction_bet ledger row keyed on the bet id — the domain’s durable ledger evidence.',
        observation:
          `prediction_bets rows for the bettor=${freshBets.length} (expected 1), amount=${freshBets[0]?.amount ?? '(none)'} under guild "${freshBets[0]?.guild_id ?? '(none)'}"; ` +
          `prediction_bet ledger rows=${freshTx.length} (expected 1), amount=${freshTx[0]?.amount ?? '(none)'}, keyed to bet id=${txnRequestId(freshTx[0]) === freshBets[0]?.id}.`,
        impact: 'The post-recovery bet did not land exactly one bet row + one keyed ledger row — the outage cycle corrupted the append-only money record.',
      },
    );

    // Guild-scoping holds across the outage window.
    await proveRlsIsolation(ctx, handle, 'prediction_bets');
  } else {
    ctx.gate(
      'Discord',
      'db-observable',
      'With database access blocked, /predict bet returns the friendly unavailable rejection and no stake is debited; after restore the balance shows no debit and a fresh bet succeeds cleanly.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'audit',
      'audit-row',
      'Append-only rows capture the post-recovery bet with the run-prefixed correlation id.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'replay-safety',
      'db-observable',
      'Balance history shows zero debits without matching bet rows — no phantom or partial money movement through the outage/restore cycle.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'branding',
      'captured-reply',
      'The degradation reply uses the branded predictions-unavailable template in the owner voice.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'database-RLS',
      'db-rls',
      'Poll/prediction/bet/balance rows stay guild-scoped through the outage window.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A single dependency-degradation alert covers the outage window (not one per failed bet).',
    'the degradation alert cannot be written while the database itself is severed and no post-recovery alert emitter exists on this path today; observing the single alert needs the owner alert channel readback (DISCORD_TOKEN + live guild)',
  );
  // The dedicated audit_logs correlation-id lane stays a genuine architectural gap.
  gateAuditLog(ctx);
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
  // idempotent per-bet convergence the catalog contracts ("bets already marked paid are
  // skipped"), now running through the keyed economy_prediction_settle credits.
  const betsAfterFirst = (await betsFor(handle, pred.predictionId)).filter((b) => b.option_id === yes);
  const bBet = betsAfterFirst.find((b) => b.user_id === userB)!;
  await settleOneBet(handle, bBet, share, 'prediction_payout', pred.predictionId);
  const retryWinners = (await betsFor(handle, pred.predictionId)).filter((b) => b.option_id === yes);
  for (const bet of retryWinners) await settleOneBet(handle, bet, share, 'prediction_payout', pred.predictionId); // B skipped (already marked), C paid

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

  const bPayTx = await predictionTxns(handle, userB, 'prediction_payout');
  const cPayTx = await predictionTxns(handle, userC, 'prediction_payout');
  const paidTotal = (bPay ?? 0) + (cPay ?? 0);
  const ledgerPaidTotal = (bPayTx[0]?.amount ?? 0) + (cPayTx[0]?.amount ?? 0);
  ctx.expect(
    paidTotal === (resolved.pool ?? 0) && bPayTx.length === 1 && cPayTx.length === 1 && ledgerPaidTotal === (resolved.pool ?? 0),
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Per-bet payout markers AND the economy_transactions prediction_payout ledger rows reconcile to the pot after retry (exactly one keyed credit row per winner; totals conserve).',
      observation:
        `sum of payout markers=${paidTotal} (expected =pool ${resolved.pool}); ` +
        `prediction_payout ledger rows B=${bPayTx.length}, C=${cPayTx.length} (expected 1 each); ledger sum=${ledgerPaidTotal} (expected =pool ${resolved.pool}).`,
      impact: 'The settled payouts (markers or ledger rows) did not reconcile to the pot after the retry pass.',
    },
  );

  // The marker is only a fast-path cache — the DURABLE fence is the ledger row. Simulate
  // the crash path where a payout landed but the marker write was lost: re-drive B's
  // credit DIRECTLY through economy_prediction_settle (bypassing the marker skip) with
  // the same request key. It must replay — no fresh money, no second ledger row.
  const markerLostProbe = await settleRpc(handle, userB, share, 'prediction_payout', bBet.id, `Prediction payout (${pred.predictionId})`);
  const wBProbe = await readWallet(handle, userB);
  const bPayTxProbe = await predictionTxns(handle, userB, 'prediction_payout');
  ctx.expect(
    markerLostProbe.error === null &&
      markerLostProbe.result?.status === 'settled' &&
      markerLostProbe.result?.replayed === true &&
      wBProbe?.wallet === 1000 &&
      bPayTxProbe.length === 1,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Even with the payout marker bypassed (the lost-marker crash path), re-driving a winner’s credit through economy_prediction_settle replays: status settled/replayed=true, no wallet movement, and still exactly one prediction_payout ledger row.',
      observation:
        `direct re-settle of B’s payout returned status=${markerLostProbe.result?.status ?? '(err)'} replayed=${markerLostProbe.result?.replayed ?? '(none)'}; ` +
        `B wallet=${wBProbe?.wallet} (unchanged 1000); prediction_payout ledger rows=${bPayTxProbe.length} (still exactly 1).`,
      impact: 'The ledger replay fence failed — a re-driven credit whose marker was lost would double-pay the winner.',
    },
  );

  // The actual transient FAULT injection (economy_prediction_settle failing mid-settlement)
  // and the owner "settlement needs attention" alert are behind a fault lane + live
  // channel readback.
  ctx.gate(
    'Discord',
    'discord-readback',
    'With a transient fault injected after the first winner’s credit, the retry pays only the remaining winners and the settle announcement posts once with correct balances.',
    'requires a mid-settlement fault-injection lane (fail economy_prediction_settle for one winner) — the harness deliberately runs against a reachable, fault-free DB',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A settlement that exhausts payout retries raises exactly one reasoned owner alert (settlement-alert) with a remediation hint.',
    'requires the mid-settlement fault-injection lane plus owner alert channel readback',
  );
  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveMemberSurfaces(ctx, handle);
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
  // and settling again is a no-op — the marker skips it, and underneath the marker the
  // economy_prediction_settle replay fence (one keyed prediction_payout row of record)
  // makes a double-credit impossible.
  const replay = await resolveAtomic(handle, pred.predictionId, yes);
  await settleProportional(handle, pred.predictionId, yes, replay.pool ?? 0);
  const wAfter = await readWallet(handle, userB);
  const bBetAfter = (await betsFor(handle, pred.predictionId, userB))[0];
  const bBetTxAfter = await predictionTxns(handle, userB, 'prediction_bet');
  const bPayTxAfter = await predictionTxns(handle, userB, 'prediction_payout');

  ctx.expect(
    first.pool === 200 &&
      replay.pool === null &&
      wBefore?.wallet === 1100 &&
      wAfter?.wallet === 1100 &&
      bBetBefore?.payout === 200 &&
      bBetAfter?.payout === 200 &&
      bBetTxAfter.length === 1 &&
      bPayTxAfter.length === 1 &&
      bPayTxAfter[0]?.amount === 200,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Replays never double-pay: re-delivering the resolve leaves every balance, payout marker, AND the economy_transactions ledger byte-identical — exactly one prediction_bet and one prediction_payout row of record for the winner.',
      observation:
        `first resolve pool=${first.pool} (200); replayed resolve pool=${replay.pool} (none — already resolved); ` +
        `winner wallet ${wBefore?.wallet}→${wAfter?.wallet} (unchanged 1100); payout marker ${bBetBefore?.payout}→${bBetAfter?.payout} (unchanged 200); ` +
        `ledger rows: prediction_bet=${bBetTxAfter.length} (1), prediction_payout=${bPayTxAfter.length} (1, amount ${bPayTxAfter[0]?.amount}).`,
      impact: 'A re-delivered resolve re-settled — winners would be double-paid (an idempotency regression on the money path).',
    },
  );

  // The credit fence is ONE keyspace for payout + refund: a stale refund attempt for an
  // already-paid bet (the refund-vs-payout race, e.g. a late placeBet compensation) is
  // refused as 'conflicting_settlement' — never a double credit, never a raw 23505.
  const lateRefund = await settleRpc(handle, userB, 100, 'prediction_refund', bBetAfter?.id ?? '', 'late refund probe (conflicting settlement)');
  const wConflict = await readWallet(handle, userB);
  const bRefundTx = await predictionTxns(handle, userB, 'prediction_refund');
  ctx.expect(
    lateRefund.error === null &&
      lateRefund.result?.status === 'conflicting_settlement' &&
      wConflict?.wallet === 1100 &&
      bRefundTx.length === 0,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'A bet is settled EITHER as a payout OR as a refund, never both: a late refund keyed on an already-paid bet returns conflicting_settlement and moves no money (the shared credit keyspace fence).',
      observation:
        `late prediction_refund on the paid bet returned status=${lateRefund.result?.status ?? '(err)'} (expected conflicting_settlement); ` +
        `winner wallet=${wConflict?.wallet} (unchanged 1100); prediction_refund ledger rows=${bRefundTx.length} (expected 0).`,
      impact: 'A paid bet accepted a second settlement as a refund — the payout/refund exclusion fence failed and the member was double-credited.',
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
  await proveMemberSurfaces(ctx, handle);
  gateAuditLog(ctx);
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

  // Post-restart settlement pays the winner correctly via the same atomic resolve + the
  // keyed settle credits; the pre-restart debit ledger rows and the post-restart payout
  // row form one continuous per-bet ledger across the reboot.
  const resolved = await resolveAtomic(second, pred.predictionId, yes);
  await settleProportional(second, pred.predictionId, yes, resolved.pool ?? 0);
  const wB = await readWallet(second, userB);
  const wC = await readWallet(second, userC);
  const predResolved = await readPrediction(second, pred.predictionId);
  const bBetTx = await predictionTxns(second, userB, 'prediction_bet');
  const bPayTx = await predictionTxns(second, userB, 'prediction_payout');
  ctx.expect(
    predResolved?.status === 'resolved' &&
      wB?.wallet === 1100 &&
      wC?.wallet === 900 &&
      bBetTx.length === 1 &&
      bBetTx[0]?.amount === -100 &&
      bPayTx.length === 1 &&
      bPayTx[0]?.amount === 200,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Post-restart resolve settles the pre-restart stakes exactly: the winner is paid its proportional share once, the loser keeps nothing, and the winner’s ledger spans the reboot (one pre-restart prediction_bet row + one post-restart prediction_payout row).',
      observation:
        `post-restart resolve: status="${predResolved?.status}" (resolved); winner B wallet=${wB?.wallet} (900+200=1100), loser C wallet=${wC?.wallet} (900); ` +
        `winner ledger: prediction_bet rows=${bBetTx.length} (amount ${bBetTx[0]?.amount}), prediction_payout rows=${bPayTx.length} (amount ${bPayTx[0]?.amount}).`,
      impact: 'Post-restart settlement did not pay the pre-restart stakes correctly (or the per-bet ledger lost rows across the reboot).',
    },
  );

  await proveRlsIsolation(ctx, second, 'prediction_bets');
  await proveNoOwnerAlert(ctx, second);
  await proveMemberSurfaces(ctx, second);
  gateAuditLog(ctx);
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

  // (a) Double-clicked bet: two simultaneous debit-first bets from the SAME member.
  //     Both debits settle (distinct request ids), then prediction_place_bet's row lock
  //     serializes the race: one inserts, the other is fenced 'duplicate' and its debit
  //     handed back through the keyed refund — net exactly one stake, one bet row.
  const [r1, r2] = await Promise.all([
    placeBet(handle, pred.predictionId, yes, userB, 100),
    placeBet(handle, pred.predictionId, yes, userB, 100),
  ]);
  const raceWins = [r1, r2].filter((r) => r.status === 'placed');
  const raceDupes = [r1, r2].filter((r) => r.status === 'duplicate');
  const bBets = await betsFor(handle, pred.predictionId, userB);
  const wB = await readWallet(handle, userB);
  const bDebitTx = await predictionTxns(handle, userB, 'prediction_bet');
  const bRefundTx = await predictionTxns(handle, userB, 'prediction_refund');
  const netStake = [...bDebitTx, ...bRefundTx].reduce((s, t) => s + t.amount, 0);
  ctx.expect(
    raceWins.length === 1 &&
      raceDupes.length === 1 &&
      raceDupes[0]?.refunded === true &&
      bBets.length === 1 &&
      bBets[0]?.id === raceWins[0]?.betId &&
      wB?.wallet === 900 &&
      bDebitTx.length === 2 &&
      bRefundTx.length === 1 &&
      txnRequestId(bRefundTx[0]) === raceDupes[0]?.betId &&
      netStake === -100,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'A rapid double-click on bet nets exactly one bet row and one stake: the losing attempt is fenced as duplicate by prediction_place_bet and its debit refunded through its own request key (ledger: two prediction_bet debits + one keyed prediction_refund, net -100).',
      observation:
        `concurrent bets: placed=${raceWins.length}, duplicate-fenced=${raceDupes.length} (refunded=${raceDupes[0]?.refunded ?? false}); ` +
        `bet rows for the member=${bBets.length} (1, id = the placed attempt's bet id: ${bBets[0]?.id === raceWins[0]?.betId}); wallet=${wB?.wallet} (net one debit → 900); ` +
        `ledger: prediction_bet rows=${bDebitTx.length} (2 attempts), prediction_refund rows=${bRefundTx.length} (1, keyed to the losing attempt: ${txnRequestId(bRefundTx[0]) === raceDupes[0]?.betId}), net=${netStake} (expected -100).`,
      impact: 'A double-clicked bet double-charged the member (an unrefunded losing debit), duplicated bet rows, or mis-keyed the refund.',
    },
  );

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
  const bPayTxRace = await predictionTxns(handle, userB, 'prediction_payout');
  ctx.expect(
    finalBets.length === 1 &&
      finalBets[0]?.payout === 200 &&
      bPayTxRace.length === 1 &&
      bPayTxRace[0]?.amount === 200 &&
      txnRequestId(bPayTxRace[0]) === finalBets[0]?.id,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The raced bet + settle leave exactly one prediction_bets row with a single payout marker and exactly one keyed prediction_payout economy_transactions row.',
      observation:
        `bet rows for the winner=${finalBets.length} (1), payout marker=${finalBets[0]?.payout ?? '(none)'} (200 once); ` +
        `prediction_payout ledger rows=${bPayTxRace.length} (1, amount ${bPayTxRace[0]?.amount}, keyed to the bet id: ${txnRequestId(bPayTxRace[0]) === finalBets[0]?.id}).`,
      impact: 'A raced bet/settle wrote a duplicate ledger row or double payout marker.',
    },
  );

  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handle);
  await proveMemberSurfaces(ctx, handle);
  gateAuditLog(ctx);
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
  const bLedgerB = await predictionTxns(handleB, userB); // guild-B-scoped ledger
  const aPayLedger = await predictionTxns(handleA, userB, 'prediction_payout'); // guild-A-scoped ledger
  ctx.expect(
    bRow?.guild_id === guildB &&
      bRow?.amount === 100 &&
      bRow?.payout === null &&
      aRow?.guild_id === guildA &&
      aRow?.payout === 100 &&
      bLedgerB.length === 1 &&
      bLedgerB[0]?.type === 'prediction_bet' &&
      aPayLedger.length === 1 &&
      aPayLedger[0]?.amount === 100,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise: 'Each guild scope reads its OWN prediction_bets row and ledger and never the other’s: guild B → its unpaid 100-coin bet with only its debit ledger row, guild A → its settled bet (payout marker + one guild-A prediction_payout ledger row).',
      observation:
        `guild-B-scoped bet under "${bRow?.guild_id}" amount=${bRow?.amount} payout=${bRow?.payout} (unpaid); ` +
        `guild-A-scoped bet under "${aRow?.guild_id}" payout=${aRow?.payout} (settled); ` +
        `guild-B ledger rows=${bLedgerB.length} (1, type ${bLedgerB[0]?.type ?? '(none)'} — no credit leaked in); guild-A payout ledger rows=${aPayLedger.length} (1, amount ${aPayLedger[0]?.amount}).`,
      impact: 'A guild-scoped read returned the other guild’s bet or ledger row — cross-guild leakage.',
    },
  );
  await proveRlsIsolation(ctx, handleB, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handleA);
  await proveMemberSurfaces(ctx, handleA);
  gateAuditLog(ctx);
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
  const txnsBefore = await serviceRowCount(handle, 'economy_transactions');
  ctx.expect(
    pollsBefore >= 1 && predsBefore >= 1 && betsBefore >= 1 && votesBefore >= 1 && walletsBefore >= 1 && txnsBefore >= 1,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'The scenario created run-prefixed poll, vote, prediction, bet, wallet, and prediction-ledger rows (pre-cleanup baseline).',
      observation: `pre-cleanup: polls=${pollsBefore}, predictions=${predsBefore}, bets=${betsBefore}, votes=${votesBefore}, wallets=${walletsBefore}, ledger txns=${txnsBefore}.`,
      impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
    },
  );

  // Prove the off-theme classes + drive the live member surfaces while the rows still
  // exist (before the sweep): the surface rows proveMemberSurfaces creates are then swept
  // alongside the scenario's own, strengthening the zero-leftovers check below.
  await proveRlsIsolation(ctx, handle, 'prediction_bets');
  await proveNoOwnerAlert(ctx, handle);
  await proveMemberSurfaces(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const pollsAfter = await serviceRowCount(handle, 'polls');
  const predsAfter = await serviceRowCount(handle, 'predictions');
  const betsAfter = await serviceRowCount(handle, 'prediction_bets');
  const votesAfter = (await pollVotesFor(handle, poll.pollId)).length; // cascade-deleted with the poll
  const walletsAfter = await walletCount(handle, userB);
  const txnsAfter = await serviceRowCount(handle, 'economy_transactions');
  ctx.expect(
    pollsAfter === 0 && predsAfter === 0 && betsAfter === 0 && votesAfter === 0 && walletsAfter === 0 && txnsAfter === 0,
    {
      assertionClass: 'cleanup',
      channel: 'db-observable',
      promise: 'Run-prefixed poll, vote (cascaded), prediction, bet, wallet, and prediction-ledger rows are deleted; a final sweep finds zero run-prefixed polls/predictions resources.',
      observation: `post-sweep: polls=${pollsAfter}, predictions=${predsAfter}, bets=${betsAfter}, votes=${votesAfter}, wallets=${walletsAfter}, ledger txns=${txnsAfter}.`,
      impact: 'The cleanup sweep left run-prefixed rows behind — the suite leaves residue.',
    },
  );

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
    'economy_transactions', // the prediction_bet/payout/refund ledger this domain now writes
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
