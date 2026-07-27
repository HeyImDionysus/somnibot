/**
 * PayPal-truth reconciliation (Finding 1).
 *
 * ── The gap ────────────────────────────────────────────────────────────────
 * Nothing in this codebase ever compared PayPal's records to ours. The bot's
 * `reconciliation.ts` reconciles entitlements against Discord roles, grace
 * expiry, and stale license sessions — the string "paypal" does not appear in
 * it. `POST /api/reconciliation` does not reconcile either; it enqueues a
 * `bot_action_queue` row. So if a payment succeeded at PayPal but never landed
 * in the database, nothing noticed, and the operator found out when a customer
 * emailed.
 *
 * This module closes that gap: for a rolling window it lists transactions from
 * PayPal's Transaction Search API and diffs BOTH directions against
 * `payments.paypal_payment_id`.
 *
 *   - provider payment with no local row  → the customer paid and got nothing.
 *     This is the critical direction.
 *   - local completed order with no provider payment → we believe we were paid
 *     and PayPal has no record of it.
 *   - amount mismatch on a matched pair → integer-cents comparison, because a
 *     silent amount divergence is a ledger error even when both sides exist.
 *
 * Any non-empty diff raises a deduped operator alert; a clean run resolves it.
 *
 * ── Where this runs ────────────────────────────────────────────────────────
 * NOT in the bot. The whole point is that it must still work when the bot is
 * the broken thing. See ../app/api/paypal/reconcile/route.ts and
 * ../instrumentation.ts: it runs inside the dashboard container, which
 * docker-compose.prod.yml runs as a separate long-lived Node server with its
 * own healthcheck and restart policy.
 *
 * ── Two economies ──────────────────────────────────────────────────────────
 * This touches ONLY the real-money tables (`payments`, `orders`). The in-server
 * coin economy is a different system entirely and is never read or written here.
 */
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getPayPalRuntimeConfig, getPayPalTokenResult } from '@/lib/paypal';

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

// ── Tunables ────────────────────────────────────────────────────────────────

/** How far back each pass looks. PayPal caps a single query at 31 days. */
export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How much of the recent past to EXCLUDE from the diff.
 *
 * PayPal's Transaction Search index lags real time (their docs say a
 * transaction can take ~3 hours to appear), and our own webhook may still be
 * in flight. Comparing right up to `now` would therefore report a steady
 * stream of false "missing" rows in both directions. The comparison window is
 * `[now - windowMs, now - settlementLagMs]` on both sides, so each side only
 * ever sees transactions the other side has had time to record.
 */
export const DEFAULT_SETTLEMENT_LAG_MS = 6 * 60 * 60 * 1000;

/** PayPal Transaction Search page size cap. */
const PAGE_SIZE = 500;

/** Hard stop so a pagination bug cannot loop forever. */
const MAX_PAGES = 40;

/** Bound on local rows scanned per direction. */
const LOCAL_SCAN_LIMIT = 5000;

/** How many ids to name in the alert before truncating. */
const MAX_REPORTED_IDS = 25;

/** Minimum spacing between scheduled passes, enforced across processes. */
export const DEFAULT_LEASE_MS = 6 * 60 * 60 * 1000;

/** `instance_settings` keys owned by this module. */
export const RECONCILE_LEASE_KEY = 'paypal_reconcile_lease_at';
export const RECONCILE_LAST_RESULT_KEY = 'paypal_reconcile_last_result';

/** Operator-visible alert type for a PayPal/ledger divergence. */
export const RECONCILE_ALERT_TYPE = 'paypal_reconciliation_mismatch';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ProviderTransaction {
  transactionId: string;
  /** Integer cents. Never a float. */
  amountCents: number;
  currency: string;
  status: string;
  eventCode: string | null;
  initiatedAt: string | null;
}

export interface MissingLocalPayment {
  transactionId: string;
  amountCents: number;
  currency: string;
  initiatedAt: string | null;
  eventCode: string | null;
}

export interface MissingProviderPayment {
  orderId: string;
  orderNumber: string | null;
  guildId: string | null;
  paypalPaymentIds: string[];
  amountCents: number;
  createdAt: string | null;
}

export interface AmountMismatch {
  transactionId: string;
  providerAmountCents: number;
  localAmountCents: number;
  providerCurrency: string;
  localCurrency: string | null;
}

export type PayPalReconciliationResult =
  | {
      status: 'skipped';
      reason: string;
    }
  | {
      status: 'failed';
      reason: string;
      /** True when a later pass can plausibly succeed (outage, throttling). */
      retriable: boolean;
    }
  | {
      status: 'completed';
      windowStart: string;
      windowEnd: string;
      providerTransactions: number;
      localPayments: number;
      /** Customer paid, we have no record. The critical direction. */
      missingLocalPayments: MissingLocalPayment[];
      /** We think we were paid, PayPal has no record. */
      missingProviderPayments: MissingProviderPayment[];
      amountMismatches: AmountMismatch[];
      alerted: boolean;
    };

export interface PayPalReconciliationOptions {
  windowMs?: number;
  settlementLagMs?: number;
  /** Fixed clock for tests. */
  now?: number;
  /** Skip unless the cross-process lease is free (scheduled runs). */
  requireLease?: boolean;
  leaseMs?: number;
}

// ── Money ───────────────────────────────────────────────────────────────────

/**
 * Parse a PayPal decimal string into exact integer cents.
 *
 * BigInt, not `Number(value) * 100`: money is integer cents everywhere in this
 * codebase and float arithmetic must never touch it. Mirrors the parser in the
 * webhook handlers.
 */
export function parseAmountToCents(value: unknown): number | null {
  // Untrimmed input is rejected outright rather than normalised — PayPal never
  // sends it, so it means the field is not what we think it is. Matches the
  // parser in the webhook handlers.
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 32
    || value !== value.trim()
  ) {
    return null;
  }
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const cents = (BigInt(match[2]!) * BigInt(100))
    + BigInt((match[3] ?? '').padEnd(2, '0') || '0');
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return match[1] === '-' ? -Number(cents) : Number(cents);
}

// ── PayPal Transaction Search ───────────────────────────────────────────────

function toPayPalDate(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

function readTransaction(entry: unknown): ProviderTransaction | null {
  if (!entry || typeof entry !== 'object') return null;
  const info = (entry as { transaction_info?: unknown }).transaction_info;
  if (!info || typeof info !== 'object') return null;

  const record = info as Record<string, unknown>;
  const transactionId = record.transaction_id;
  if (typeof transactionId !== 'string' || transactionId.length === 0) return null;

  const amount = record.transaction_amount as
    { value?: unknown; currency_code?: unknown } | undefined;
  const amountCents = parseAmountToCents(amount?.value);
  if (amountCents === null) return null;

  const currency = typeof amount?.currency_code === 'string' ? amount.currency_code : '';

  return {
    transactionId,
    amountCents,
    currency,
    status: typeof record.transaction_status === 'string' ? record.transaction_status : '',
    eventCode: typeof record.transaction_event_code === 'string'
      ? record.transaction_event_code
      : null,
    initiatedAt: typeof record.transaction_initiation_date === 'string'
      ? record.transaction_initiation_date
      : null,
  };
}

/**
 * List successful, money-in transactions from PayPal for a window.
 *
 * Only positive amounts are kept. PayPal's transaction ledger also contains
 * fees, payouts, withdrawals, and reversals — all negative from the merchant's
 * side — and none of those correspond to a `payments` row, so including them
 * would generate pure noise in the "provider payment with no local row"
 * direction.
 */
export async function fetchProviderTransactions(
  apiBase: string,
  token: string,
  windowStartMs: number,
  windowEndMs: number,
): Promise<{ ok: true; transactions: ProviderTransaction[] } | { ok: false; retriable: boolean; reason: string }> {
  const transactions: ProviderTransaction[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      start_date: toPayPalDate(windowStartMs),
      end_date: toPayPalDate(windowEndMs),
      fields: 'transaction_info',
      // 'S' = successful. Pending/denied/reversed transactions are handled by
      // their own webhook events, not by this ledger diff.
      transaction_status: 'S',
      page_size: String(PAGE_SIZE),
      page: String(page),
    });

    let res: Response;
    try {
      res = await fetch(`${apiBase}/v1/reporting/transactions?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return {
        ok: false,
        retriable: true,
        reason: `transaction search request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!res.ok) {
      // 403 here almost always means the REST app lacks the Transaction Search
      // permission — a configuration problem no retry will fix.
      return {
        ok: false,
        retriable: res.status >= 500 || res.status === 429,
        reason: res.status === 403
          ? 'transaction search returned 403 — enable the "Transaction Search" permission on the PayPal REST app'
          : `transaction search returned ${res.status}`,
      };
    }

    let body: { transaction_details?: unknown; total_pages?: unknown };
    try {
      body = await res.json();
    } catch {
      return { ok: false, retriable: true, reason: 'transaction search returned malformed JSON' };
    }

    const details = Array.isArray(body.transaction_details) ? body.transaction_details : [];
    for (const entry of details) {
      const txn = readTransaction(entry);
      // Positive amounts only — see the doc comment above.
      if (!txn || txn.amountCents <= 0 || seen.has(txn.transactionId)) continue;
      seen.add(txn.transactionId);
      transactions.push(txn);
    }

    const totalPages = typeof body.total_pages === 'number' ? body.total_pages : 1;
    if (page >= totalPages || details.length === 0) {
      return { ok: true, transactions };
    }
  }

  // More pages than the hard cap. Reporting a partial ledger as truth would
  // produce false "missing locally" findings, so fail instead.
  return {
    ok: false,
    retriable: false,
    reason: `transaction search exceeded ${MAX_PAGES} pages — narrow the window`,
  };
}

// ── Cross-process lease ─────────────────────────────────────────────────────

/**
 * Claim the right to run a scheduled pass.
 *
 * The dashboard can run more than one replica, and every replica boots the
 * same in-process scheduler. A compare-and-set on `instance_settings` makes
 * the claim atomic: the loser's UPDATE matches zero rows (its expected prior
 * value is stale) and it simply skips.
 */
export async function acquireReconcileLease(
  supabase: AdminSupabase,
  leaseMs: number,
  nowMs: number,
): Promise<boolean> {
  const { data: existing, error } = await supabase
    .from('instance_settings')
    .select('value')
    .eq('key', RECONCILE_LEASE_KEY)
    .maybeSingle();

  if (error) {
    console.error('[PayPalReconcile] Failed to read lease:', error.message);
    return false;
  }

  if (!existing) {
    const { error: insertError } = await supabase.from('instance_settings').insert({
      key: RECONCILE_LEASE_KEY,
      value: String(nowMs),
      section: 'commerce',
    });
    // 23505 => another replica inserted first.
    return !insertError;
  }

  const priorMs = Number(existing.value);
  if (Number.isFinite(priorMs) && nowMs - priorMs < leaseMs) return false;

  const { data: claimed, error: claimError } = await supabase
    .from('instance_settings')
    .update({ value: String(nowMs), updated_at: new Date(nowMs).toISOString() })
    .eq('key', RECONCILE_LEASE_KEY)
    .eq('value', existing.value)
    .select('key');

  if (claimError) {
    console.error('[PayPalReconcile] Failed to claim lease:', claimError.message);
    return false;
  }
  return (claimed?.length ?? 0) > 0;
}

// ── Alerting ────────────────────────────────────────────────────────────────

function summarise<T>(items: T[], render: (item: T) => string): string {
  const shown = items.slice(0, MAX_REPORTED_IDS).map(render);
  const extra = items.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` (+${extra} more)` : '');
}

async function raiseMismatchAlert(
  supabase: AdminSupabase,
  guildId: string,
  result: Extract<PayPalReconciliationResult, { status: 'completed' }>,
): Promise<void> {
  const parts: string[] = [];
  if (result.missingLocalPayments.length > 0) {
    parts.push(
      `${result.missingLocalPayments.length} PayPal payment(s) have NO local record — `
      + 'the customer paid and received nothing: '
      + summarise(
        result.missingLocalPayments,
        (m) => `${m.transactionId} (${(m.amountCents / 100).toFixed(2)} ${m.currency})`,
      ),
    );
  }
  if (result.missingProviderPayments.length > 0) {
    parts.push(
      `${result.missingProviderPayments.length} completed order(s) have no matching PayPal `
      + 'transaction: '
      + summarise(result.missingProviderPayments, (m) => m.orderNumber ?? m.orderId),
    );
  }
  if (result.amountMismatches.length > 0) {
    parts.push(
      `${result.amountMismatches.length} amount mismatch(es): `
      + summarise(
        result.amountMismatches,
        (m) => `${m.transactionId} provider ${m.providerAmountCents}c vs local ${m.localAmountCents}c`,
      ),
    );
  }

  const message =
    `PayPal ledger reconciliation found divergences between ${result.windowStart} and `
    + `${result.windowEnd}. ${parts.join(' ')}`;

  const metadata = {
    window_start: result.windowStart,
    window_end: result.windowEnd,
    provider_transactions: result.providerTransactions,
    local_payments: result.localPayments,
    missing_local_payments: result.missingLocalPayments.slice(0, MAX_REPORTED_IDS),
    missing_provider_payments: result.missingProviderPayments.slice(0, MAX_REPORTED_IDS),
    amount_mismatches: result.amountMismatches.slice(0, MAX_REPORTED_IDS),
    source: 'paypal_reconciliation',
  };

  try {
    const { data: refreshed, error: updateError } = await supabase
      .from('alerts')
      .update({
        severity: 'critical',
        message,
        metadata,
        updated_at: new Date().toISOString(),
      })
      .eq('guild_id', guildId)
      .eq('alert_type', RECONCILE_ALERT_TYPE)
      .eq('resolved', false)
      .select('id');

    if (updateError) {
      console.error('[PayPalReconcile] Failed to refresh alert:', updateError.message);
      return;
    }
    if (refreshed && refreshed.length > 0) return;

    const { error: insertError } = await supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: RECONCILE_ALERT_TYPE,
      severity: 'critical',
      title: 'PayPal records do not match the order ledger',
      message,
      metadata,
    });
    if (insertError && insertError.code !== '23505') {
      console.error('[PayPalReconcile] Failed to insert alert:', insertError.message);
    }
  } catch (err) {
    console.error(
      '[PayPalReconcile] Failed to write alert:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** A clean pass clears the open divergence alert so it does not stick forever. */
async function resolveMismatchAlert(supabase: AdminSupabase, guildId: string): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    await supabase
      .from('alerts')
      .update({ resolved: true, resolved_at: nowIso, updated_at: nowIso })
      .eq('guild_id', guildId)
      .eq('alert_type', RECONCILE_ALERT_TYPE)
      .eq('resolved', false);
  } catch (err) {
    console.error(
      '[PayPalReconcile] Failed to resolve alert:',
      err instanceof Error ? err.message : err,
    );
  }
}

// ── The pass ────────────────────────────────────────────────────────────────

export async function runPayPalReconciliation(
  supabase: AdminSupabase,
  options: PayPalReconciliationOptions = {},
): Promise<PayPalReconciliationResult> {
  const nowMs = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const settlementLagMs = options.settlementLagMs ?? DEFAULT_SETTLEMENT_LAG_MS;

  const windowEndMs = nowMs - settlementLagMs;
  const windowStartMs = windowEndMs - windowMs;
  if (windowStartMs >= windowEndMs) {
    return { status: 'skipped', reason: 'reconciliation window is empty' };
  }

  if (options.requireLease) {
    const claimed = await acquireReconcileLease(
      supabase,
      options.leaseMs ?? DEFAULT_LEASE_MS,
      nowMs,
    );
    if (!claimed) {
      return { status: 'skipped', reason: 'another pass ran recently' };
    }
  }

  const config = await getPayPalRuntimeConfig();
  if (!config.clientId || !config.clientSecret) {
    return { status: 'skipped', reason: 'PayPal credentials are not configured' };
  }

  const tokenResult = await getPayPalTokenResult(config);
  if (!tokenResult.ok) {
    return { status: 'failed', reason: tokenResult.reason, retriable: tokenResult.retriable };
  }

  const provider = await fetchProviderTransactions(
    config.apiBase,
    tokenResult.token,
    windowStartMs,
    windowEndMs,
  );
  if (!provider.ok) {
    return { status: 'failed', reason: provider.reason, retriable: provider.retriable };
  }

  const windowStart = new Date(windowStartMs).toISOString();
  const windowEnd = new Date(windowEndMs).toISOString();

  // ── Local side ──
  // Instance-wide: PayPal credentials are per-instance, so the provider ledger
  // covers every guild this deployment sells for.
  const { data: localPayments, error: paymentsError } = await supabase
    .from('payments')
    .select('id, order_id, guild_id, paypal_payment_id, amount_cents, currency, status, created_at')
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .order('created_at', { ascending: true })
    .limit(LOCAL_SCAN_LIMIT);

  if (paymentsError) {
    return { status: 'failed', reason: `local payment scan failed: ${paymentsError.message}`, retriable: true };
  }

  const payments = localPayments ?? [];
  const localById = new Map<string, typeof payments[number]>();
  for (const payment of payments) {
    if (typeof payment.paypal_payment_id === 'string' && payment.paypal_payment_id.length > 0) {
      localById.set(payment.paypal_payment_id, payment);
    }
  }

  // Direction A (critical): PayPal has it, we do not.
  const missingLocalPayments: MissingLocalPayment[] = [];
  const amountMismatches: AmountMismatch[] = [];
  for (const txn of provider.transactions) {
    const local = localById.get(txn.transactionId);
    if (!local) {
      missingLocalPayments.push({
        transactionId: txn.transactionId,
        amountCents: txn.amountCents,
        currency: txn.currency,
        initiatedAt: txn.initiatedAt,
        eventCode: txn.eventCode,
      });
      continue;
    }
    // Integer-cents comparison. A divergence here is a ledger error even
    // though both sides have a row.
    if (
      typeof local.amount_cents === 'number'
      && Number.isInteger(local.amount_cents)
      && local.amount_cents !== txn.amountCents
    ) {
      amountMismatches.push({
        transactionId: txn.transactionId,
        providerAmountCents: txn.amountCents,
        localAmountCents: local.amount_cents,
        providerCurrency: txn.currency,
        localCurrency: typeof local.currency === 'string' ? local.currency : null,
      });
    }
  }

  // Direction B: we believe we were paid, PayPal has no record.
  const { data: localOrders, error: ordersError } = await supabase
    .from('orders')
    .select('id, order_number, guild_id, amount_cents, created_at, paypal_subscription_id')
    .eq('status', 'completed')
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .order('created_at', { ascending: true })
    .limit(LOCAL_SCAN_LIMIT);

  if (ordersError) {
    return { status: 'failed', reason: `local order scan failed: ${ordersError.message}`, retriable: true };
  }

  const paymentsByOrder = new Map<string, string[]>();
  for (const payment of payments) {
    if (typeof payment.order_id !== 'string') continue;
    if (typeof payment.paypal_payment_id !== 'string') continue;
    const list = paymentsByOrder.get(payment.order_id) ?? [];
    list.push(payment.paypal_payment_id);
    paymentsByOrder.set(payment.order_id, list);
  }

  const providerIds = new Set(provider.transactions.map((t) => t.transactionId));
  const missingProviderPayments: MissingProviderPayment[] = [];
  for (const order of localOrders ?? []) {
    const paymentIds = paymentsByOrder.get(order.id as string) ?? [];
    if (paymentIds.some((id) => providerIds.has(id))) continue;
    missingProviderPayments.push({
      orderId: order.id as string,
      orderNumber: typeof order.order_number === 'string' ? order.order_number : null,
      guildId: typeof order.guild_id === 'string' ? order.guild_id : null,
      paypalPaymentIds: paymentIds,
      amountCents: typeof order.amount_cents === 'number' ? order.amount_cents : 0,
      createdAt: typeof order.created_at === 'string' ? order.created_at : null,
    });
  }

  const result: Extract<PayPalReconciliationResult, { status: 'completed' }> = {
    status: 'completed',
    windowStart,
    windowEnd,
    providerTransactions: provider.transactions.length,
    localPayments: payments.length,
    missingLocalPayments,
    missingProviderPayments,
    amountMismatches,
    alerted: false,
  };

  const hasDivergence = missingLocalPayments.length > 0
    || missingProviderPayments.length > 0
    || amountMismatches.length > 0;

  // File the alert against the guild of an affected order when we know it —
  // Direction A findings are unattributable by definition, which is exactly why
  // they need the instance-primary fallback.
  const alertGuildId = missingProviderPayments.find((m) => m.guildId)?.guildId
    ?? process.env.DISCORD_GUILD_ID
    ?? null;

  if (alertGuildId) {
    if (hasDivergence) {
      await raiseMismatchAlert(supabase, alertGuildId, result);
      result.alerted = true;
    } else {
      await resolveMismatchAlert(supabase, alertGuildId);
    }
  } else if (hasDivergence) {
    console.error(
      '[PayPalReconcile] Divergence found but no guild to alert — set DISCORD_GUILD_ID',
    );
  }

  await recordLastResult(supabase, result);

  console.log(
    `[PayPalReconcile] ${windowStart}..${windowEnd}: `
    + `${provider.transactions.length} provider txn(s), ${payments.length} local payment(s), `
    + `${missingLocalPayments.length} missing locally, `
    + `${missingProviderPayments.length} missing at provider, `
    + `${amountMismatches.length} amount mismatch(es)`,
  );

  return result;
}

/**
 * Persist a small run summary so "when did we last verify against PayPal?" is
 * answerable. Kept in `instance_settings` rather than `reconciliation_runs`,
 * which belongs to the bot's entitlement/role reconciliation and has a
 * different findings shape.
 */
async function recordLastResult(
  supabase: AdminSupabase,
  result: Extract<PayPalReconciliationResult, { status: 'completed' }>,
): Promise<void> {
  const value = JSON.stringify({
    ran_at: new Date().toISOString(),
    window_start: result.windowStart,
    window_end: result.windowEnd,
    provider_transactions: result.providerTransactions,
    local_payments: result.localPayments,
    missing_local: result.missingLocalPayments.length,
    missing_provider: result.missingProviderPayments.length,
    amount_mismatches: result.amountMismatches.length,
  });

  try {
    await supabase
      .from('instance_settings')
      .upsert(
        { key: RECONCILE_LAST_RESULT_KEY, value, section: 'commerce', updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      );
  } catch (err) {
    console.error(
      '[PayPalReconcile] Failed to record last result:',
      err instanceof Error ? err.message : err,
    );
  }
}
