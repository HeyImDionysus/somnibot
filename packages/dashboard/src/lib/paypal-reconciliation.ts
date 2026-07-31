/**
 * PayPal-to-local real-money reconciliation.
 *
 * The provider account can contain transactions from more than one
 * application, while the local database can contain free/manual commerce
 * records. This pass therefore treats neither side as attributable merely
 * because a row is positive or completed. It compares only:
 *
 * - successful balance-affecting Checkout/subscription transactions that have
 *   an exact local PayPal payment id or exact ODR/SUB reference;
 * - local PayPal payments and positive purchase orders;
 * - settled, currency-normalized integer-cent pairs.
 *
 * A strictly parsed SomniBot custom field is only a consistency check after an
 * exact provider/local identity matched; it is never tenant authority in a
 * shared merchant account. Every finding carries a guild and every alert
 * contains only that guild's findings. Partial provider or local scans fail
 * closed.
 */
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getPayPalRuntimeConfig, getPayPalTokenResult } from '@/lib/paypal';
import { randomUUID } from 'node:crypto';

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

// ── Tunables and durable identities ────────────────────────────────────────

export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Per-object commerce GETs are live (unlike the retired reporting sweep,
// which lagged by hours); the lag only needs to absorb webhook/capture
// latency so an order completed seconds ago is not flagged mid-flight.
export const DEFAULT_SETTLEMENT_LAG_MS = 15 * 60 * 1000;
export const DEFAULT_LEASE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const PROVIDER_CONCURRENCY = 5;
const PROVIDER_TIMEOUT_MS = 15_000;
const LOCAL_PAGE_SIZE = 1000;
const EXACT_LOOKUP_CHUNK_SIZE = 100;
export const LOCAL_SCAN_MAX_ROWS = 20_000;
const MAX_REPORTED_IDS = 25;

export const RECONCILE_LAST_RESULT_KEY = 'paypal_reconcile_last_result';
export const RECONCILE_ALERT_TYPE = 'paypal_reconciliation_mismatch';
export const RECONCILE_FAILURE_ALERT_TYPE = 'paypal_reconciliation_failure';

const ORDER_SCAN_STATUSES = [
  'completed',
  'disputed',
  'refunded',
  'pending',
  'pending_review',
] as const;

// ── Types ──────────────────────────────────────────────────────────────────

export interface SomniBotTransactionIdentity {
  guildId: string;
  productId: string;
  customerId: string;
  discordId: string;
  planId: string | null;
}

export interface ProviderCaptureObject {
  status: string;
  amountCents: number;
  currency: string;
}

export interface ProviderRefundObject {
  status: string;
  amountCents: number;
  currency: string;
}

export interface ProviderOrderCapture {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
}

export interface ProviderOrderObject {
  status: string;
  customId: string | null;
  subscriptionId: string | null;
  captures: ProviderOrderCapture[];
}

export interface ProviderSubscriptionObject {
  status: string;
  lastPaymentTime: string | null;
  lastPaymentAmountCents: number | null;
  lastPaymentCurrency: string | null;
}

export interface MissingLocalPayment {
  kind: 'payment' | 'refund';
  /** The provider object id evidencing the money movement (capture/sale id). */
  transactionId: string;
  guildId: string;
  amountCents: number;
  currency: string;
  initiatedAt: string | null;
  /** Which per-object verification surfaced it. */
  source: 'order' | 'capture' | 'subscription';
  /** The parent provider object (order id, capture id, or subscription id). */
  referenceId: string | null;
}

export interface MissingProviderPayment {
  kind: 'payment' | 'order' | 'refund';
  orderId: string;
  orderNumber: string | null;
  guildId: string;
  paypalPaymentIds: string[];
  amountCents: number;
  currency: string;
  createdAt: string | null;
}

export interface AmountMismatch {
  transactionId: string;
  guildId: string;
  providerAmountCents: number;
  localAmountCents: number;
  providerCurrency: string;
  localCurrency: string | null;
}

export interface UnsettledLocalPayment {
  transactionId: string;
  guildId: string;
  orderId: string | null;
  paymentStatus: string;
  orderStatus: string | null;
}

export type PayPalReconciliationFailure = {
  status: 'failed';
  reason: string;
  retriable: boolean;
};

export type PayPalReconciliationResult =
  | {
      status: 'skipped';
      reason: string;
    }
  | PayPalReconciliationFailure
  | {
      status: 'completed';
      windowStart: string;
      windowEnd: string;
      /** Attributable SomniBot provider transactions only. */
      providerTransactions: number;
      /** Eligible local PayPal payment rows only. */
      localPayments: number;
      /** Eligible local PayPal refund ledger rows only. */
      localRefunds: number;
      missingLocalPayments: MissingLocalPayment[];
      missingProviderPayments: MissingProviderPayment[];
      amountMismatches: AmountMismatch[];
      unsettledLocalPayments: UnsettledLocalPayment[];
      /** True only when every required guild alert write succeeded. */
      alerted: boolean;
    };

export interface PayPalReconciliationOptions {
  windowMs?: number;
  settlementLagMs?: number;
  now?: number;
  leaseMs?: number;
  cooldownMs?: number;
  /** Manual owner runs may skip completed cadence, but never an active owner. */
  bypassCooldown?: boolean;
  /** Scheduler triggers persist failures and resolve their standing alert. */
  scheduledVisibility?: boolean;
  /** Limit the returned findings to one owner tenant; the pass still checks all guilds. */
  resultGuildId?: string;
}

interface LocalPaymentRow {
  id: string;
  order_id: string | null;
  guild_id: string | null;
  paypal_payment_id: string | null;
  amount_cents: number;
  currency: string | null;
  status: string;
  provider: string | null;
  created_at: string | null;
}

interface LocalOrderRow {
  id: string;
  order_number: string | null;
  guild_id: string | null;
  customer_id: string | null;
  product_id: string | null;
  plan_id: string | null;
  amount_cents: number;
  currency: string | null;
  status: string;
  source: string | null;
  paypal_order_id: string | null;
  paypal_subscription_id: string | null;
  created_at: string | null;
}

interface LocalRefundRow {
  id: string;
  payment_id: string;
  order_id: string | null;
  guild_id: string | null;
  paypal_refund_id: string;
  event_type: string;
  amount_cents: number | null;
  currency: string | null;
  created_at: string | null;
}

interface LocalCustomerIdentityRow {
  id: string;
  guild_id: string;
  discord_id: string;
}

interface LocalPaymentIdentityRow {
  id: string;
  order_id: string | null;
  guild_id: string | null;
  paypal_payment_id: string | null;
}

type ScanResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; reason: string; retriable: boolean };

// ── Exact money and identity parsing ───────────────────────────────────────

export function parseAmountToCents(value: unknown): number | null {
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

function normalizeCurrency(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value)
    ? value.toUpperCase()
    : null;
}

function isProviderId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function parseCustomIdentity(value: unknown): SomniBotTransactionIdentity | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  if (hasExactKeys(record, ['g', 'p', 'c', 'd'])) {
    if (
      !isDiscordSnowflake(record.g)
      || !isUuid(record.p)
      || !isUuid(record.c)
      || !isDiscordSnowflake(record.d)
    ) {
      return null;
    }
    return {
      guildId: record.g,
      productId: record.p,
      customerId: record.c,
      discordId: record.d,
      planId: null,
    };
  }

  const baseKeys = ['guild_id', 'product_id', 'customer_id', 'discord_id'];
  const subscriptionKeys = [...baseKeys, 'plan_id'];
  if (!hasExactKeys(record, baseKeys) && !hasExactKeys(record, subscriptionKeys)) {
    return null;
  }
  if (
    !isDiscordSnowflake(record.guild_id)
    || !isUuid(record.product_id)
    || !isUuid(record.customer_id)
    || !isDiscordSnowflake(record.discord_id)
    || ('plan_id' in record && !isUuid(record.plan_id))
  ) {
    return null;
  }
  return {
    guildId: record.guild_id,
    productId: record.product_id,
    customerId: record.customer_id,
    discordId: record.discord_id,
    planId: 'plan_id' in record ? record.plan_id as string : null,
  };
}

// ── PayPal Transaction Search ──────────────────────────────────────────────

// ── Per-object provider verification ───────────────────────────────────────────
//
// SomniBot does PayPal per-object: every order/capture/refund/subscription id
// in the local ledger was stored when WE created or confirmed that object, so
// reconciliation asks PayPal about exactly those objects over the same
// commerce API the webhook handler and refund/cancel routes already use.
// This works with a bare REST app (client id/secret) for every
// wizard-onboarded operator. The previous implementation swept
// /v1/reporting/transactions — PayPal's separately entitled reporting
// product — which 403s for standard operator apps and lags settlement by
// hours; it could never run in the white-label credential model.

type ProviderFetch<T> =
  | { ok: true; found: true; value: T }
  | { ok: true; found: false }
  | { ok: false; retriable: boolean; reason: string };

async function providerGet(
  apiBase: string,
  token: string,
  path: string,
  label: string,
): Promise<ProviderFetch<Record<string, unknown>>> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      retriable: true,
      reason: `${label} request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (response.status === 404) return { ok: true, found: false };
  if (!response.ok) {
    return {
      ok: false,
      retriable: response.status >= 500 || response.status === 429,
      reason: `${label} returned ${response.status}`,
    };
  }
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, retriable: false, reason: `${label} returned a malformed envelope` };
    }
    return { ok: true, found: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, retriable: true, reason: `${label} returned malformed JSON` };
  }
}

function readProviderAmount(
  record: unknown,
): { amountCents: number | null; currency: string | null } {
  const amount = record as { value?: unknown; currency_code?: unknown } | null | undefined;
  return {
    amountCents: parseAmountToCents(amount?.value),
    currency: normalizeCurrency(amount?.currency_code),
  };
}

export async function fetchProviderCapture(
  apiBase: string,
  token: string,
  captureId: string,
): Promise<ProviderFetch<ProviderCaptureObject>> {
  const result = await providerGet(
    apiBase,
    token,
    `/v2/payments/captures/${encodeURIComponent(captureId)}`,
    'capture lookup',
  );
  if (!result.ok || !result.found) return result;
  const record = result.value;
  const { amountCents, currency } = readProviderAmount(record.amount);
  if (
    typeof record.status !== 'string'
    || record.status.length === 0
    || amountCents === null
    || currency === null
  ) {
    return { ok: false, retriable: false, reason: 'capture lookup returned a malformed record' };
  }
  return { ok: true, found: true, value: { status: record.status, amountCents, currency } };
}

export async function fetchProviderRefund(
  apiBase: string,
  token: string,
  refundId: string,
): Promise<ProviderFetch<ProviderRefundObject>> {
  const result = await providerGet(
    apiBase,
    token,
    `/v2/payments/refunds/${encodeURIComponent(refundId)}`,
    'refund lookup',
  );
  if (!result.ok || !result.found) return result;
  const record = result.value;
  const { amountCents, currency } = readProviderAmount(record.amount);
  if (
    typeof record.status !== 'string'
    || record.status.length === 0
    || amountCents === null
    || currency === null
  ) {
    return { ok: false, retriable: false, reason: 'refund lookup returned a malformed record' };
  }
  return { ok: true, found: true, value: { status: record.status, amountCents, currency } };
}

export async function fetchProviderOrder(
  apiBase: string,
  token: string,
  orderId: string,
): Promise<ProviderFetch<ProviderOrderObject>> {
  const result = await providerGet(
    apiBase,
    token,
    `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    'order lookup',
  );
  if (!result.ok || !result.found) return result;
  const record = result.value;
  if (typeof record.status !== 'string' || record.status.length === 0) {
    return { ok: false, retriable: false, reason: 'order lookup returned a malformed record' };
  }
  const units = Array.isArray(record.purchase_units) ? record.purchase_units : [];
  const captures: ProviderOrderCapture[] = [];
  let customId: string | null = null;
  for (const unit of units) {
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) {
      return { ok: false, retriable: false, reason: 'order lookup returned a malformed record' };
    }
    const unitRecord = unit as Record<string, unknown>;
    if (customId === null && typeof unitRecord.custom_id === 'string') {
      customId = unitRecord.custom_id;
    }
    const payments = unitRecord.payments as { captures?: unknown } | undefined;
    const unitCaptures = Array.isArray(payments?.captures) ? payments.captures : [];
    for (const capture of unitCaptures) {
      if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
        return { ok: false, retriable: false, reason: 'order lookup returned a malformed record' };
      }
      const captureRecord = capture as Record<string, unknown>;
      const { amountCents, currency } = readProviderAmount(captureRecord.amount);
      if (
        !isProviderId(captureRecord.id)
        || typeof captureRecord.status !== 'string'
        || amountCents === null
        || currency === null
      ) {
        return { ok: false, retriable: false, reason: 'order lookup returned a malformed record' };
      }
      captures.push({
        id: captureRecord.id,
        status: captureRecord.status,
        amountCents,
        currency,
      });
    }
  }
  return {
    ok: true,
    found: true,
    value: {
      status: record.status,
      customId,
      subscriptionId: isProviderId(record.subscription_id) ? record.subscription_id : null,
      captures,
    },
  };
}

export async function fetchProviderSubscription(
  apiBase: string,
  token: string,
  subscriptionId: string,
): Promise<ProviderFetch<ProviderSubscriptionObject>> {
  const result = await providerGet(
    apiBase,
    token,
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
    'subscription lookup',
  );
  if (!result.ok || !result.found) return result;
  const record = result.value;
  if (typeof record.status !== 'string' || record.status.length === 0) {
    return {
      ok: false,
      retriable: false,
      reason: 'subscription lookup returned a malformed record',
    };
  }
  const billing = record.billing_info as
    { last_payment?: { time?: unknown; amount?: unknown } } | undefined;
  const lastPayment = billing?.last_payment;
  const { amountCents, currency } = readProviderAmount(lastPayment?.amount);
  return {
    ok: true,
    found: true,
    value: {
      status: record.status,
      lastPaymentTime: typeof lastPayment?.time === 'string' ? lastPayment.time : null,
      lastPaymentAmountCents: amountCents,
      lastPaymentCurrency: currency,
    },
  };
}

/** Bounded-concurrency map preserving order; provider GETs are I/O-bound. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  handler: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await handler(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ── Lease ownership ────────────────────────────────────────────────────────

export type ReconcileLeaseAcquireResult =
  | { status: 'acquired' | 'busy' | 'cooldown' }
  | { status: 'error'; reason: string };

type ReconcileLeaseMutationResult =
  | { ok: true }
  | { ok: false; reason: string };

function durationSeconds(valueMs: number, label: string): number | null {
  if (!Number.isSafeInteger(valueMs) || valueMs < 0) return null;
  const seconds = Math.ceil(valueMs / 1000);
  const maximum = label === 'lease' ? 86_400 : 604_800;
  return seconds <= maximum && (label !== 'lease' || seconds >= 1)
    ? seconds
    : null;
}

export async function acquireReconcileLease(
  supabase: AdminSupabase,
  ownerToken: string,
  leaseMs: number,
  cooldownMs: number,
  bypassCooldown: boolean,
): Promise<ReconcileLeaseAcquireResult> {
  const leaseSeconds = durationSeconds(leaseMs, 'lease');
  const cooldownSeconds = durationSeconds(cooldownMs, 'cooldown');
  if (leaseSeconds === null || cooldownSeconds === null) {
    return { status: 'error', reason: 'invalid reconciliation lease duration' };
  }

  try {
    const { data, error } = await supabase.rpc('paypal_reconcile_acquire', {
      p_owner_token: ownerToken,
      p_lease_seconds: leaseSeconds,
      p_cooldown_seconds: cooldownSeconds,
      p_bypass_cooldown: bypassCooldown,
    });
    if (error) {
      return {
        status: 'error',
        reason: `reconciliation lease acquisition failed: ${error.message}`,
      };
    }
    if (data === 'acquired' || data === 'busy' || data === 'cooldown') {
      return { status: data };
    }
    return {
      status: 'error',
      reason: 'reconciliation lease acquisition returned an invalid result',
    };
  } catch (error) {
    return {
      status: 'error',
      reason: `reconciliation lease acquisition failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Extend only the exact active owner's lease. False means the owner expired or
 * was replaced; RPC/storage errors are distinguishable from contention.
 */
export async function heartbeatReconcileLease(
  supabase: AdminSupabase,
  ownerToken: string,
  leaseMs: number,
): Promise<ReconcileLeaseMutationResult> {
  const leaseSeconds = durationSeconds(leaseMs, 'lease');
  if (leaseSeconds === null) {
    return { ok: false, reason: 'invalid reconciliation heartbeat duration' };
  }
  try {
    const { data, error } = await supabase
      .rpc('paypal_reconcile_heartbeat', {
        p_owner_token: ownerToken,
        p_lease_seconds: leaseSeconds,
      });
    if (error) {
      return {
        ok: false,
        reason: `reconciliation lease heartbeat failed: ${error.message}`,
      };
    }
    return data === true
      ? { ok: true }
      : { ok: false, reason: 'reconciliation lease ownership was lost' };
  } catch (error) {
    return {
      ok: false,
      reason: `reconciliation lease heartbeat failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Finalize only the exact active owner. Success enters completed cooldown;
 * every non-success outcome releases the row for an immediate retry.
 */
export async function finalizeReconcileLease(
  supabase: AdminSupabase,
  ownerToken: string,
  succeeded: boolean,
): Promise<ReconcileLeaseMutationResult> {
  try {
    const { data, error } = await supabase.rpc('paypal_reconcile_finalize', {
      p_owner_token: ownerToken,
      p_succeeded: succeeded,
    });
    if (error) {
      return {
        ok: false,
        reason: `reconciliation lease finalization failed: ${error.message}`,
      };
    }
    return data === true
      ? { ok: true }
      : { ok: false, reason: 'reconciliation lease finalization lost ownership' };
  } catch (error) {
    return {
      ok: false,
      reason: `reconciliation lease finalization failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

// ── Complete local scans (no silent PostgREST cap) ─────────────────────────

async function scanLocalPayments(
  supabase: AdminSupabase,
  windowStart: string,
  windowEnd: string,
): Promise<ScanResult<LocalPaymentRow>> {
  const rows: LocalPaymentRow[] = [];
  for (let from = 0; from < LOCAL_SCAN_MAX_ROWS; from += LOCAL_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('payments')
      .select('id, order_id, guild_id, paypal_payment_id, amount_cents, currency, status, provider, created_at')
      .eq('provider', 'paypal')
      .gte('created_at', windowStart)
      .lte('created_at', windowEnd)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LOCAL_PAGE_SIZE - 1);
    if (error) {
      return {
        ok: false,
        retriable: true,
        reason: `local payment scan failed: ${error.message}`,
      };
    }
    const page = (data ?? []) as LocalPaymentRow[];
    rows.push(...page);
    if (page.length < LOCAL_PAGE_SIZE) return { ok: true, rows };
  }

  const { data: overflow, error: overflowError } = await supabase
    .from('payments')
    .select('id')
    .eq('provider', 'paypal')
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(LOCAL_SCAN_MAX_ROWS, LOCAL_SCAN_MAX_ROWS);
  if (overflowError) {
    return {
      ok: false,
      retriable: true,
      reason: `local payment overflow probe failed: ${overflowError.message}`,
    };
  }
  return (overflow?.length ?? 0) > 0
    ? {
        ok: false,
        retriable: false,
        reason: `local payment scan exceeded ${LOCAL_SCAN_MAX_ROWS} rows — narrow the window`,
      }
    : { ok: true, rows };
}

async function scanLocalRefunds(
  supabase: AdminSupabase,
  windowStart: string,
  windowEnd: string,
): Promise<ScanResult<LocalRefundRow>> {
  const rows: LocalRefundRow[] = [];
  for (let from = 0; from < LOCAL_SCAN_MAX_ROWS; from += LOCAL_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('payment_refunds')
      .select('id, payment_id, order_id, guild_id, paypal_refund_id, event_type, amount_cents, currency, created_at')
      .gte('created_at', windowStart)
      .lte('created_at', windowEnd)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LOCAL_PAGE_SIZE - 1);
    if (error) {
      return {
        ok: false,
        retriable: true,
        reason: `local refund scan failed: ${error.message}`,
      };
    }
    const page = (data ?? []) as LocalRefundRow[];
    rows.push(...page);
    if (page.length < LOCAL_PAGE_SIZE) return { ok: true, rows };
  }

  const { data: overflow, error: overflowError } = await supabase
    .from('payment_refunds')
    .select('id')
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(LOCAL_SCAN_MAX_ROWS, LOCAL_SCAN_MAX_ROWS);
  if (overflowError) {
    return {
      ok: false,
      retriable: true,
      reason: `local refund overflow probe failed: ${overflowError.message}`,
    };
  }
  return (overflow?.length ?? 0) > 0
    ? {
        ok: false,
        retriable: false,
        reason: `local refund scan exceeded ${LOCAL_SCAN_MAX_ROWS} rows — narrow the window`,
      }
    : { ok: true, rows };
}

async function scanLocalOrders(
  supabase: AdminSupabase,
  windowStart: string,
  windowEnd: string,
): Promise<ScanResult<LocalOrderRow>> {
  const rows: LocalOrderRow[] = [];
  for (let from = 0; from < LOCAL_SCAN_MAX_ROWS; from += LOCAL_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('orders')
      .select('id, order_number, guild_id, customer_id, product_id, plan_id, amount_cents, currency, status, source, paypal_order_id, paypal_subscription_id, created_at')
      .or('source.eq.purchase,source.is.null')
      .gt('amount_cents', 0)
      .in('status', [...ORDER_SCAN_STATUSES])
      .gte('created_at', windowStart)
      .lte('created_at', windowEnd)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LOCAL_PAGE_SIZE - 1);
    if (error) {
      return {
        ok: false,
        retriable: true,
        reason: `local order scan failed: ${error.message}`,
      };
    }
    const page = (data ?? []) as LocalOrderRow[];
    rows.push(...page);
    if (page.length < LOCAL_PAGE_SIZE) return { ok: true, rows };
  }

  const { data: overflow, error: overflowError } = await supabase
    .from('orders')
    .select('id')
    .or('source.eq.purchase,source.is.null')
    .gt('amount_cents', 0)
    .in('status', [...ORDER_SCAN_STATUSES])
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(LOCAL_SCAN_MAX_ROWS, LOCAL_SCAN_MAX_ROWS);
  if (overflowError) {
    return {
      ok: false,
      retriable: true,
      reason: `local order overflow probe failed: ${overflowError.message}`,
    };
  }
  return (overflow?.length ?? 0) > 0
    ? {
        ok: false,
        retriable: false,
        reason: `local order scan exceeded ${LOCAL_SCAN_MAX_ROWS} rows — narrow the window`,
      }
    : { ok: true, rows };
}

async function loadConfiguredGuildIds(
  supabase: AdminSupabase,
): Promise<ScanResult<string>> {
  const ids: string[] = [];
  for (let from = 0; from < LOCAL_SCAN_MAX_ROWS; from += LOCAL_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('guild')
      .select('id')
      .order('id', { ascending: true })
      .range(from, from + LOCAL_PAGE_SIZE - 1);
    if (error) {
      return {
        ok: false,
        retriable: true,
        reason: `configured guild scan failed: ${error.message}`,
      };
    }
    const page = data ?? [];
    for (const row of page) {
      if (typeof row.id === 'string' && row.id.length > 0) ids.push(row.id);
    }
    if (page.length < LOCAL_PAGE_SIZE) {
      if (
        ids.length === 0
        && typeof process.env.DISCORD_GUILD_ID === 'string'
        && process.env.DISCORD_GUILD_ID.length > 0
      ) {
        ids.push(process.env.DISCORD_GUILD_ID);
      }
      return { ok: true, rows: [...new Set(ids)] };
    }
  }
  return {
    ok: false,
    retriable: false,
    reason: `configured guild scan exceeded ${LOCAL_SCAN_MAX_ROWS} rows`,
  };
}

function validateLocalPayments(
  rows: LocalPaymentRow[],
  guildIds: Set<string>,
): ScanResult<LocalPaymentRow> {
  const eligible: LocalPaymentRow[] = [];
  for (const row of rows) {
    // The server-side predicate owns this exclusion. Retain the client guard
    // because tests and future query refactors must not conflate providers.
    if (row.provider !== 'paypal') continue;
    if (
      typeof row.id !== 'string'
      || row.id.length === 0
      || typeof row.guild_id !== 'string'
      || !guildIds.has(row.guild_id)
      || typeof row.order_id !== 'string'
      || !isProviderId(row.paypal_payment_id)
      || !Number.isSafeInteger(row.amount_cents)
      || normalizeCurrency(row.currency) === null
      || !['completed', 'refunded', 'reversed', 'pending', 'failed'].includes(row.status)
    ) {
      return {
        ok: false,
        retriable: false,
        reason: 'malformed local PayPal payment row',
      };
    }
    eligible.push(row);
  }
  return { ok: true, rows: eligible };
}

const LOCAL_REFUND_EVENT_TYPES = new Set([
  'ADMIN.REFUND',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
]);

const LOCAL_ZERO_AMOUNT_REFUND_EVENT_TYPES = new Set([
  'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.SALE.REVERSED',
]);

function validateLocalRefunds(
  rows: LocalRefundRow[],
  guildIds: Set<string>,
): ScanResult<LocalRefundRow> {
  const eligible: LocalRefundRow[] = [];
  for (const row of rows) {
    if (
      !isUuid(row.id)
      || !isUuid(row.payment_id)
      || !isUuid(row.order_id)
      || typeof row.guild_id !== 'string'
      || !guildIds.has(row.guild_id)
      || !isProviderId(row.paypal_refund_id)
      || !LOCAL_REFUND_EVENT_TYPES.has(row.event_type)
      || !Number.isSafeInteger(row.amount_cents)
      || (row.amount_cents as number) < 0
      || (
        row.amount_cents === 0
        && !LOCAL_ZERO_AMOUNT_REFUND_EVENT_TYPES.has(row.event_type)
      )
      || normalizeCurrency(row.currency) === null
    ) {
      return {
        ok: false,
        retriable: false,
        reason: 'malformed local PayPal refund row',
      };
    }
    eligible.push(row);
  }
  return { ok: true, rows: eligible };
}

function validateLocalOrders(
  rows: LocalOrderRow[],
  guildIds: Set<string>,
  exactPayPalEvidence = false,
): ScanResult<LocalOrderRow> {
  const eligible: LocalOrderRow[] = [];
  for (const row of rows) {
    const isPurchase = row.source === 'purchase';
    const isLegacyPayPalPurchase =
      row.source === null
      && (
        exactPayPalEvidence
        || row.paypal_order_id !== null
        || row.paypal_subscription_id !== null
      );
    if ((!isPurchase && !isLegacyPayPalPurchase) || row.amount_cents === 0) continue;
    if (
      typeof row.id !== 'string'
      || row.id.length === 0
      || typeof row.guild_id !== 'string'
      || !guildIds.has(row.guild_id)
      || !Number.isSafeInteger(row.amount_cents)
      || row.amount_cents < 0
      || normalizeCurrency(row.currency) === null
      || ![
        'pending',
        'completed',
        'refunded',
        'disputed',
        'cancelled',
        'pending_review',
      ].includes(row.status)
      || (row.paypal_order_id !== null && !isProviderId(row.paypal_order_id))
      || (
        row.paypal_subscription_id !== null
        && !isProviderId(row.paypal_subscription_id)
      )
    ) {
      return {
        ok: false,
        retriable: false,
        reason: 'malformed local PayPal purchase order',
      };
    }
    eligible.push(row);
  }
  return { ok: true, rows: eligible };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

const LOCAL_ORDER_SELECT =
  'id, order_number, guild_id, customer_id, product_id, plan_id, amount_cents, currency, status, source, paypal_order_id, paypal_subscription_id, created_at';
const LOCAL_PAYMENT_SELECT =
  'id, order_id, guild_id, paypal_payment_id, amount_cents, currency, status, provider, created_at';
const LOCAL_REFUND_SELECT =
  'id, payment_id, order_id, guild_id, paypal_refund_id, event_type, amount_cents, currency, created_at';

async function lookupPaymentsByExactColumn(
  supabase: AdminSupabase,
  column: 'id' | 'paypal_payment_id',
  values: string[],
): Promise<ScanResult<LocalPaymentRow>> {
  if (values.length === 0) return { ok: true, rows: [] };
  const found: LocalPaymentRow[] = [];
  for (const group of chunks([...new Set(values)], EXACT_LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('payments')
      .select(LOCAL_PAYMENT_SELECT)
      .eq('provider', 'paypal')
      .in(column, group);
    if (error) {
      return {
        ok: false,
        retriable: true,
        reason: `exact local payment ${column} lookup failed: ${error.message}`,
      };
    }
    found.push(...(data ?? []) as LocalPaymentRow[]);
  }
  return { ok: true, rows: found };
}

async function lookupRefundsByExactColumn(
  supabase: AdminSupabase,
  column: 'paypal_refund_id' | 'payment_id',
  values: string[],
): Promise<ScanResult<LocalRefundRow>> {
  if (values.length === 0) return { ok: true, rows: [] };
  const found: LocalRefundRow[] = [];
  for (const group of chunks([...new Set(values)], EXACT_LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('payment_refunds')
      .select(LOCAL_REFUND_SELECT)
      .in(column, group);
    if (error) {
      return {
        ok: false,
        retriable: true,
        reason: `exact local refund lookup failed: ${error.message}`,
      };
    }
    found.push(...(data ?? []) as LocalRefundRow[]);
  }
  return { ok: true, rows: found };
}

async function lookupOrdersByExactColumn(
  supabase: AdminSupabase,
  column: 'id' | 'paypal_order_id' | 'paypal_subscription_id',
  values: string[],
  guildIds: Set<string>,
): Promise<ScanResult<LocalOrderRow>> {
  if (values.length === 0) return { ok: true, rows: [] };
  const found: LocalOrderRow[] = [];
  for (const group of chunks([...new Set(values)], EXACT_LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('orders')
      .select(LOCAL_ORDER_SELECT)
      .or('source.eq.purchase,source.is.null')
      .gt('amount_cents', 0)
      .in(column, group);
    if (error) {
      return {
        ok: false,
        retriable: true,
        reason: `exact local ${column} lookup failed: ${error.message}`,
      };
    }
    // The exact ODR/SUB value — or the local PayPal payment that supplied an
    // exact order id — is durable commerce evidence for nullable legacy rows.
    const validated = validateLocalOrders(
      (data ?? []) as LocalOrderRow[],
      guildIds,
      true,
    );
    if (!validated.ok) return validated;
    found.push(...validated.rows);
  }
  return { ok: true, rows: found };
}

/**
 * Find durable PayPal payment identities for candidate orders without applying
 * the reconciliation creation window. This keeps the order-level fallback
 * limited to commerce where the payment identity write is genuinely absent,
 * rather than merely older than the current provider-search window.
 */
async function loadOrderPaymentIdentities(
  supabase: AdminSupabase,
  orderIds: string[],
): Promise<ScanResult<LocalPaymentIdentityRow>> {
  const requested = [...new Set(orderIds)];
  if (requested.length === 0) return { ok: true, rows: [] };

  const rows: LocalPaymentIdentityRow[] = [];
  for (const group of chunks(requested, EXACT_LOOKUP_CHUNK_SIZE)) {
    let from = 0;
    while (true) {
      const remaining = LOCAL_SCAN_MAX_ROWS - rows.length;
      if (remaining <= 0) {
        const { data: overflow, error: overflowError } = await supabase
          .from('payments')
          .select('id')
          .eq('provider', 'paypal')
          .not('paypal_payment_id', 'is', null)
          .in('order_id', group)
          .order('id', { ascending: true })
          .range(from, from);
        if (overflowError) {
          return {
            ok: false,
            retriable: true,
            reason: `local payment identity overflow probe failed: ${overflowError.message}`,
          };
        }
        if ((overflow?.length ?? 0) > 0) {
          return {
            ok: false,
            retriable: false,
            reason: `local payment identity lookup exceeded ${LOCAL_SCAN_MAX_ROWS} rows`,
          };
        }
        break;
      }

      const pageSize = Math.min(LOCAL_PAGE_SIZE, remaining);
      const { data, error } = await supabase
        .from('payments')
        .select('id, order_id, guild_id, paypal_payment_id')
        .eq('provider', 'paypal')
        .not('paypal_payment_id', 'is', null)
        .in('order_id', group)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) {
        return {
          ok: false,
          retriable: true,
          reason: `local payment identity lookup failed: ${error.message}`,
        };
      }
      const page = (data ?? []) as LocalPaymentIdentityRow[];
      rows.push(...page);
      if (page.length < pageSize) break;
      from += pageSize;
    }
  }
  return { ok: true, rows };
}

async function loadCustomerIdentities(
  supabase: AdminSupabase,
  customerIds: string[],
  guildIds: Set<string>,
): Promise<ScanResult<LocalCustomerIdentityRow>> {
  const requested = new Set(customerIds);
  if (requested.size === 0) return { ok: true, rows: [] };

  const found = new Map<string, LocalCustomerIdentityRow>();
  for (const group of chunks([...requested], EXACT_LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, guild_id, discord_id')
      .in('id', group);
    if (error) {
      return {
        ok: false,
        retriable: true,
        reason: `durable customer identity lookup failed: ${error.message}`,
      };
    }
    for (const candidate of data ?? []) {
      const row = candidate as LocalCustomerIdentityRow;
      if (!requested.has(row.id)) continue;
      if (
        !isUuid(row.id)
        || !guildIds.has(row.guild_id)
        || !isDiscordSnowflake(row.discord_id)
      ) {
        return {
          ok: false,
          retriable: false,
          reason: 'malformed durable customer identity',
        };
      }
      const existing = found.get(row.id);
      if (
        existing
        && (
          existing.guild_id !== row.guild_id
          || existing.discord_id !== row.discord_id
        )
      ) {
        return {
          ok: false,
          retriable: false,
          reason: 'provider identity conflict',
        };
      }
      found.set(row.id, row);
    }
  }
  if ([...requested].some((id) => !found.has(id))) {
    return {
      ok: false,
      retriable: false,
      reason: 'durable customer identity lookup returned incomplete data',
    };
  }
  return { ok: true, rows: [...found.values()] };
}

function customIdentityMatchesOrder(
  identity: SomniBotTransactionIdentity,
  order: LocalOrderRow,
  subscriptionCommerce: boolean,
  customer: LocalCustomerIdentityRow | undefined,
): boolean {
  if (!customer) return false;
  if (
    identity.guildId !== order.guild_id
    || identity.customerId !== order.customer_id
    || identity.productId !== order.product_id
    || customer.id !== order.customer_id
    || customer.guild_id !== order.guild_id
    || identity.discordId !== customer.discord_id
  ) {
    return false;
  }
  return subscriptionCommerce
    ? identity.planId !== null && identity.planId === order.plan_id
    : order.plan_id === null;
}

function isSettledPair(payment: LocalPaymentRow, order: LocalOrderRow | undefined): boolean {
  if (!order || payment.order_id !== order.id || payment.guild_id !== order.guild_id) {
    return false;
  }
  if (payment.status === 'completed') {
    return order.status === 'completed' || order.status === 'disputed';
  }
  if (payment.status === 'refunded' || payment.status === 'reversed') {
    return order.status === 'refunded';
  }
  return false;
}

// ── Tenant-partitioned alert writes ────────────────────────────────────────

function summarise<T>(items: T[], render: (item: T) => string): string {
  const shown = items.slice(0, MAX_REPORTED_IDS).map(render);
  const extra = items.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` (+${extra} more)` : '');
}

function resultForGuild(
  result: Extract<PayPalReconciliationResult, { status: 'completed' }>,
  guildId: string,
  providerTransactions: number,
  localPayments: number,
  localRefunds: number,
): Extract<PayPalReconciliationResult, { status: 'completed' }> {
  const scoped = {
    ...result,
    providerTransactions,
    localPayments,
    localRefunds,
    missingLocalPayments: result.missingLocalPayments.filter((item) => item.guildId === guildId),
    missingProviderPayments:
      result.missingProviderPayments.filter((item) => item.guildId === guildId),
    amountMismatches: result.amountMismatches.filter((item) => item.guildId === guildId),
    unsettledLocalPayments:
      result.unsettledLocalPayments.filter((item) => item.guildId === guildId),
  };
  scoped.alerted = hasDivergence(scoped);
  return scoped;
}

function hasDivergence(
  result: Extract<PayPalReconciliationResult, { status: 'completed' }>,
): boolean {
  return result.missingLocalPayments.length > 0
    || result.missingProviderPayments.length > 0
    || result.amountMismatches.length > 0
    || result.unsettledLocalPayments.length > 0;
}

async function raiseMismatchAlert(
  supabase: AdminSupabase,
  guildId: string,
  result: Extract<PayPalReconciliationResult, { status: 'completed' }>,
): Promise<boolean> {
  const parts: string[] = [];
  if (result.missingLocalPayments.length > 0) {
    parts.push(
      `${result.missingLocalPayments.length} PayPal payment/refund transaction(s) `
      + 'have NO matching local ledger row — a payment may mean the customer paid '
      + 'and received nothing: '
      + summarise(
        result.missingLocalPayments,
        (item) =>
          `${item.kind}:${item.transactionId} `
          + `(${(item.amountCents / 100).toFixed(2)} ${item.currency})`,
      ),
    );
  }
  if (result.missingProviderPayments.length > 0) {
    parts.push(
      `${result.missingProviderPayments.length} settled local payment/order record(s) `
      + 'have no matching PayPal transaction: '
      + summarise(
        result.missingProviderPayments,
        (item) => item.paypalPaymentIds[0]
          ? `${item.kind}:${item.orderNumber ?? item.orderId} [${item.paypalPaymentIds[0]}]`
          : item.orderNumber ?? item.orderId,
      ),
    );
  }
  if (result.amountMismatches.length > 0) {
    parts.push(
      `${result.amountMismatches.length} amount/currency mismatch(es): `
      + summarise(
        result.amountMismatches,
        (item) =>
          `${item.transactionId} provider ${item.providerAmountCents}c ${item.providerCurrency} `
          + `vs local ${item.localAmountCents}c ${item.localCurrency ?? 'invalid'}`,
      ),
    );
  }
  if (result.unsettledLocalPayments.length > 0) {
    parts.push(
      `${result.unsettledLocalPayments.length} provider transaction(s) match an unsettled local state: `
      + summarise(
        result.unsettledLocalPayments,
        (item) =>
          `${item.transactionId} payment=${item.paymentStatus} order=${item.orderStatus ?? 'missing'}`,
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
    local_refunds: result.localRefunds,
    missing_local_payments: result.missingLocalPayments.slice(0, MAX_REPORTED_IDS),
    missing_provider_payments: result.missingProviderPayments.slice(0, MAX_REPORTED_IDS),
    amount_mismatches: result.amountMismatches.slice(0, MAX_REPORTED_IDS),
    unsettled_local_payments: result.unsettledLocalPayments.slice(0, MAX_REPORTED_IDS),
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
      return false;
    }
    if ((refreshed?.length ?? 0) > 0) return true;

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
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      '[PayPalReconcile] Failed to write alert:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function resolveAlertType(
  supabase: AdminSupabase,
  guildId: string,
  alertType: string,
): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('alerts')
      .update({ resolved: true, resolved_at: now, updated_at: now })
      .eq('guild_id', guildId)
      .eq('alert_type', alertType)
      .eq('resolved', false);
    if (error) {
      console.error(`[PayPalReconcile] Failed to resolve ${alertType} alert:`, error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      `[PayPalReconcile] Failed to resolve ${alertType} alert:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function writeLastResult(
  supabase: AdminSupabase,
  value: Record<string, unknown>,
): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('instance_settings')
      .upsert(
        {
          key: RECONCILE_LAST_RESULT_KEY,
          value: JSON.stringify({ ran_at: now, ...value }),
          section: 'commerce',
          updated_at: now,
        },
        { onConflict: 'key' },
      );
    if (error) {
      console.error('[PayPalReconcile] Failed to record last result:', error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      '[PayPalReconcile] Failed to record last result:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function recordCompletedResult(
  supabase: AdminSupabase,
  result: Extract<PayPalReconciliationResult, { status: 'completed' }>,
): Promise<boolean> {
  return writeLastResult(supabase, {
    status: 'completed',
    window_start: result.windowStart,
    window_end: result.windowEnd,
    provider_transactions: result.providerTransactions,
    local_payments: result.localPayments,
    local_refunds: result.localRefunds,
    missing_local: result.missingLocalPayments.length,
    missing_provider: result.missingProviderPayments.length,
    amount_mismatches: result.amountMismatches.length,
    unsettled_local: result.unsettledLocalPayments.length,
  });
}

async function raiseScheduledFailureAlert(
  supabase: AdminSupabase,
  guildId: string,
  failure: PayPalReconciliationFailure,
): Promise<boolean> {
  const reason = failure.reason.slice(0, 1000);
  const message =
    `The scheduled PayPal reconciliation monitor failed. ${reason}. `
    + `Retriable: ${failure.retriable ? 'yes' : 'no'}.`;
  const metadata = {
    reason,
    retriable: failure.retriable,
    source: 'paypal_reconciliation_scheduler',
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
      .eq('alert_type', RECONCILE_FAILURE_ALERT_TYPE)
      .eq('resolved', false)
      .select('id');
    if (updateError) return false;
    if ((refreshed?.length ?? 0) > 0) return true;
    const { error: insertError } = await supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: RECONCILE_FAILURE_ALERT_TYPE,
      severity: 'critical',
      title: 'PayPal reconciliation monitor failed',
      message,
      metadata,
    });
    return !insertError || insertError.code === '23505';
  } catch {
    return false;
  }
}

export async function recordScheduledReconciliationFailure(
  supabase: AdminSupabase,
  failure: PayPalReconciliationFailure,
): Promise<boolean> {
  const recorded = await writeLastResult(supabase, {
    status: 'failed',
    reason: failure.reason.slice(0, 1000),
    retriable: failure.retriable,
  });
  if (!recorded) return false;

  const guildScan = await loadConfiguredGuildIds(supabase);
  if (!guildScan.ok) return false;
  let allWritten = guildScan.rows.length > 0;
  for (const guildId of guildScan.rows) {
    allWritten = await raiseScheduledFailureAlert(supabase, guildId, failure) && allWritten;
  }
  return allWritten;
}

export async function resolveScheduledReconciliationFailure(
  supabase: AdminSupabase,
): Promise<boolean> {
  const guildScan = await loadConfiguredGuildIds(supabase);
  if (!guildScan.ok) return false;
  let allResolved = true;
  for (const guildId of guildScan.rows) {
    allResolved = await resolveAlertType(
      supabase,
      guildId,
      RECONCILE_FAILURE_ALERT_TYPE,
    ) && allResolved;
  }
  return allResolved;
}

async function applyScheduledVisibility(
  supabase: AdminSupabase,
  result: PayPalReconciliationResult,
): Promise<PayPalReconciliationResult> {
  if (result.status === 'failed') {
    return await recordScheduledReconciliationFailure(supabase, result)
      ? result
      : {
          status: 'failed',
          reason: `scheduler failure visibility failed after: ${result.reason}`,
          retriable: true,
        };
  }
  if (result.status === 'completed') {
    return await resolveScheduledReconciliationFailure(supabase)
      ? result
      : {
          status: 'failed',
          reason: 'scheduler success could not resolve its standing failure alert',
          retriable: true,
        };
  }
  return result;
}

/**
 * Scheduled visibility is part of the acquired pass. A transient rejection
 * must become a retriable result so the caller can release its exact owner
 * lease, while a second bounded attempt preserves durable failure visibility.
 */
async function applyScheduledVisibilitySafely(
  supabase: AdminSupabase,
  result: PayPalReconciliationResult,
): Promise<PayPalReconciliationResult> {
  try {
    return await applyScheduledVisibility(supabase, result);
  } catch (error) {
    const priorOutcome = result.status === 'failed'
      ? result.reason
      : `reconciliation ${result.status}`;
    const failure: PayPalReconciliationFailure = {
      status: 'failed',
      reason: `scheduler visibility threw after ${priorOutcome}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      retriable: true,
    };
    try {
      return await applyScheduledVisibility(supabase, failure);
    } catch (retryError) {
      return {
        status: 'failed',
        reason: `${failure.reason}; scheduler failure visibility retry threw: ${
          retryError instanceof Error ? retryError.message : String(retryError)
        }`,
        retriable: true,
      };
    }
  }
}

// ── Reconciliation pass ────────────────────────────────────────────────────

async function runPass(
  supabase: AdminSupabase,
  nowMs: number,
  windowStartMs: number,
  windowEndMs: number,
  heartbeat: () => Promise<PayPalReconciliationFailure | null>,
  resultGuildId?: string,
): Promise<PayPalReconciliationResult> {
  const config = await getPayPalRuntimeConfig();
  if (!config.clientId || !config.clientSecret) {
    return { status: 'skipped', reason: 'PayPal credentials are not configured' };
  }

  const token = await getPayPalTokenResult(config);
  if (!token.ok) {
    return { status: 'failed', reason: token.reason, retriable: token.retriable };
  }

  const windowStart = new Date(windowStartMs).toISOString();
  const windowEnd = new Date(windowEndMs).toISOString();

  const [guildScan, paymentScan, refundScan, orderScan] = await Promise.all([
    loadConfiguredGuildIds(supabase),
    scanLocalPayments(supabase, windowStart, windowEnd),
    scanLocalRefunds(supabase, windowStart, windowEnd),
    scanLocalOrders(supabase, windowStart, windowEnd),
  ]);
  if (!guildScan.ok) {
    return { status: 'failed', reason: guildScan.reason, retriable: guildScan.retriable };
  }
  if (!paymentScan.ok) {
    return { status: 'failed', reason: paymentScan.reason, retriable: paymentScan.retriable };
  }
  if (!refundScan.ok) {
    return { status: 'failed', reason: refundScan.reason, retriable: refundScan.retriable };
  }
  if (!orderScan.ok) {
    return { status: 'failed', reason: orderScan.reason, retriable: orderScan.retriable };
  }

  const configuredGuildIds = new Set(guildScan.rows);
  const validatedPayments = validateLocalPayments(paymentScan.rows, configuredGuildIds);
  if (!validatedPayments.ok) {
    return {
      status: 'failed',
      reason: validatedPayments.reason,
      retriable: validatedPayments.retriable,
    };
  }
  const validatedWindowRefunds = validateLocalRefunds(
    refundScan.rows,
    configuredGuildIds,
  );
  if (!validatedWindowRefunds.ok) {
    return {
      status: 'failed',
      reason: validatedWindowRefunds.reason,
      retriable: validatedWindowRefunds.retriable,
    };
  }
  const validatedWindowOrders = validateLocalOrders(orderScan.rows, configuredGuildIds);
  if (!validatedWindowOrders.ok) {
    return {
      status: 'failed',
      reason: validatedWindowOrders.reason,
      retriable: validatedWindowOrders.retriable,
    };
  }

  const payments = validatedPayments.rows;
  const windowRefunds = validatedWindowRefunds.rows;
  const orders = validatedWindowOrders.rows;

  // Parent orders of window payments/refunds may be older than the window.
  const windowOrderIds = new Set(orders.map((order) => order.id));
  const parentOrderIds = new Set<string>();
  for (const payment of payments) {
    if (typeof payment.order_id === 'string' && !windowOrderIds.has(payment.order_id)) {
      parentOrderIds.add(payment.order_id);
    }
  }
  for (const refund of windowRefunds) {
    if (typeof refund.order_id === 'string' && !windowOrderIds.has(refund.order_id)) {
      parentOrderIds.add(refund.order_id);
    }
  }
  const parentOrderScan = await lookupOrdersByExactColumn(
    supabase,
    'id',
    [...parentOrderIds],
    configuredGuildIds,
  );
  if (!parentOrderScan.ok) {
    return { status: 'failed', reason: parentOrderScan.reason, retriable: parentOrderScan.retriable };
  }
  const ordersById = new Map<string, LocalOrderRow>();
  for (const order of [...orders, ...parentOrderScan.rows]) {
    ordersById.set(order.id, order);
  }

  // Refund parents (payment rows) may also predate the window.
  const refundPaymentScan = await lookupPaymentsByExactColumn(
    supabase,
    'id',
    windowRefunds.map((refund) => refund.payment_id),
  );
  if (!refundPaymentScan.ok) {
    return {
      status: 'failed',
      reason: refundPaymentScan.reason,
      retriable: refundPaymentScan.retriable,
    };
  }
  const validatedRefundPayments = validateLocalPayments(
    refundPaymentScan.rows,
    configuredGuildIds,
  );
  if (!validatedRefundPayments.ok) {
    return {
      status: 'failed',
      reason: validatedRefundPayments.reason,
      retriable: validatedRefundPayments.retriable,
    };
  }

  // Local identity maps + conflict checks. These are pure local-ledger
  // consistency guards carried over from the previous implementation: a
  // provider id claimed by two rows, or a refund pointing across guilds or
  // orders, poisons every comparison built on top of it.
  const paymentEvidenceById = new Map<string, LocalPaymentRow>();
  const localByProviderId = new Map<string, LocalPaymentRow>();
  for (const payment of [...payments, ...validatedRefundPayments.rows]) {
    const providerId = payment.paypal_payment_id as string;
    const existing = localByProviderId.get(providerId);
    if (existing && existing.id !== payment.id) {
      return { status: 'failed', reason: 'provider identity conflict', retriable: false };
    }
    localByProviderId.set(providerId, payment);
    paymentEvidenceById.set(payment.id, payment);
  }
  for (const payment of payments) {
    const order = typeof payment.order_id === 'string'
      ? ordersById.get(payment.order_id)
      : undefined;
    if (!order) {
      return {
        status: 'failed',
        reason: 'local PayPal payment relation is missing',
        retriable: false,
      };
    }
    if (payment.guild_id !== order.guild_id) {
      return { status: 'failed', reason: 'provider identity conflict', retriable: false };
    }
  }
  const refundsByProviderId = new Map<string, LocalRefundRow>();
  for (const refund of windowRefunds) {
    const existing = refundsByProviderId.get(refund.paypal_refund_id);
    if (existing && existing.id !== refund.id) {
      return { status: 'failed', reason: 'provider refund identity conflict', retriable: false };
    }
    refundsByProviderId.set(refund.paypal_refund_id, refund);
    const ledgerPayment = paymentEvidenceById.get(refund.payment_id);
    if (!ledgerPayment) {
      return {
        status: 'failed',
        reason: 'local PayPal refund payment relation is missing',
        retriable: false,
      };
    }
    if (
      refund.guild_id !== ledgerPayment.guild_id
      || refund.order_id !== ledgerPayment.order_id
    ) {
      return { status: 'failed', reason: 'provider refund identity conflict', retriable: false };
    }
  }
  const localHeartbeatFailure = await heartbeat();
  if (localHeartbeatFailure) return localHeartbeatFailure;

  // ── Verification target selection ────────────────────────────────────────
  //
  // Orders get a direct GET when the capture path cannot already prove them:
  //  A) window orders still pending/pending_review (did the buyer complete
  //     approval while our webhook was lost?), and
  //  B) settled window orders with NO local payment identity at all (the
  //     payment write is wholly absent, so no capture id exists to verify).
  const paymentIdentityScan = await loadOrderPaymentIdentities(
    supabase,
    orders.map((order) => order.id),
  );
  if (!paymentIdentityScan.ok) {
    return {
      status: 'failed',
      reason: paymentIdentityScan.reason,
      retriable: paymentIdentityScan.retriable,
    };
  }
  const orderIdsWithPaymentIdentity = new Set<string>();
  for (const identity of paymentIdentityScan.rows) {
    const order = identity.order_id ? ordersById.get(identity.order_id) : undefined;
    if (
      typeof identity.id !== 'string'
      || identity.id.length === 0
      || !order
      || identity.guild_id !== order.guild_id
      || !isProviderId(identity.paypal_payment_id)
    ) {
      return {
        status: 'failed',
        reason: 'malformed local PayPal payment identity row',
        retriable: false,
      };
    }
    orderIdsWithPaymentIdentity.add(order.id);
  }
  const SETTLED_ORDER_STATUSES = ['completed', 'disputed', 'refunded'];
  const orderGetTargets: LocalOrderRow[] = [];
  for (const order of orders) {
    if (!isProviderId(order.paypal_order_id)) continue;
    const pendingish = order.status === 'pending' || order.status === 'pending_review';
    const settled = SETTLED_ORDER_STATUSES.includes(order.status);
    if (pendingish || (settled && !orderIdsWithPaymentIdentity.has(order.id))) {
      orderGetTargets.push(order);
    }
  }

  // Customer identities back the custom_id tamper check on fetched orders.
  const customerIdentityScan = await loadCustomerIdentities(
    supabase,
    [...new Set(
      orderGetTargets
        .map((order) => order.customer_id)
        .filter((id): id is string => typeof id === 'string'),
    )],
    configuredGuildIds,
  );
  if (!customerIdentityScan.ok) {
    return {
      status: 'failed',
      reason: customerIdentityScan.reason,
      retriable: customerIdentityScan.retriable,
    };
  }
  const customersById = new Map(
    customerIdentityScan.rows.map((customer) => [customer.id, customer]),
  );

  // Subscriptions to verify: any window order or window payment's parent that
  // carries a subscription identity.
  const subscriptionTargets = new Map<string, LocalOrderRow>();
  for (const order of orders) {
    if (isProviderId(order.paypal_subscription_id)) {
      subscriptionTargets.set(order.paypal_subscription_id, order);
    }
  }
  for (const payment of payments) {
    const order = ordersById.get(payment.order_id as string);
    if (order && isProviderId(order.paypal_subscription_id)) {
      subscriptionTargets.set(order.paypal_subscription_id, order);
    }
  }

  // ── Per-object provider verification ─────────────────────────────────────
  const missingLocalPayments: MissingLocalPayment[] = [];
  const amountMismatches: AmountMismatch[] = [];
  const unsettledLocalPayments: UnsettledLocalPayment[] = [];
  const missingProviderPayments: MissingProviderPayment[] = [];
  let providerObjectsVerified = 0;
  const verifiedByGuild = new Map<string, number>();
  const bumpVerified = (guildId: string | null) => {
    providerObjectsVerified += 1;
    if (typeof guildId === 'string') {
      verifiedByGuild.set(guildId, (verifiedByGuild.get(guildId) ?? 0) + 1);
    }
  };
  const PROVIDER_SETTLED_CAPTURE_STATUSES = ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'];

  // 1) Captures — every window payment by its own provider identity.
  const captureResults = await mapWithConcurrency(
    payments,
    PROVIDER_CONCURRENCY,
    async (payment) => ({
      payment,
      lookup: await fetchProviderCapture(
        config.apiBase,
        token.token,
        payment.paypal_payment_id as string,
      ),
    }),
  );
  const refundedCapturePaymentRowIds: string[] = [];
  for (const { lookup } of captureResults) {
    if (!lookup.ok) {
      return { status: 'failed', reason: lookup.reason, retriable: lookup.retriable };
    }
  }
  for (const { payment, lookup } of captureResults) {
    if (!lookup.ok || !lookup.found) continue;
    if (['REFUNDED', 'PARTIALLY_REFUNDED'].includes(lookup.value.status)) {
      refundedCapturePaymentRowIds.push(payment.id);
    }
  }
  // Local refunds for provider-refunded captures may sit outside the refund
  // window; resolve them exactly before judging "refund missing locally".
  const refundsForRefundedScan = await lookupRefundsByExactColumn(
    supabase,
    'payment_id',
    refundedCapturePaymentRowIds,
  );
  if (!refundsForRefundedScan.ok) {
    return {
      status: 'failed',
      reason: refundsForRefundedScan.reason,
      retriable: refundsForRefundedScan.retriable,
    };
  }
  const refundedPaymentRowsWithLocalRefund = new Set(
    refundsForRefundedScan.rows.map((refund) => refund.payment_id),
  );
  for (const { payment, lookup } of captureResults) {
    if (!lookup.ok) continue;
    const order = ordersById.get(payment.order_id as string);
    const guildId = payment.guild_id as string;
    const providerId = payment.paypal_payment_id as string;
    if (!lookup.found) {
      // Subscription billing writes v1 sale ids, which the captures API does
      // not serve; those rows are verified through their subscription below.
      if (order && isProviderId(order.paypal_subscription_id)) continue;
      if (isSettledPair(payment, order)) {
        missingProviderPayments.push({
          kind: 'payment',
          orderId: payment.order_id as string,
          orderNumber: order?.order_number ?? null,
          guildId,
          paypalPaymentIds: [providerId],
          amountCents: payment.amount_cents,
          currency: normalizeCurrency(payment.currency) as string,
          createdAt: payment.created_at,
        });
      }
      continue;
    }
    bumpVerified(guildId);
    const capture = lookup.value;
    const settledAtProvider = PROVIDER_SETTLED_CAPTURE_STATUSES.includes(capture.status);
    if (settledAtProvider && !isSettledPair(payment, order)) {
      unsettledLocalPayments.push({
        transactionId: providerId,
        guildId,
        orderId: payment.order_id,
        paymentStatus: payment.status,
        orderStatus: order?.status ?? null,
      });
      continue;
    }
    if (
      settledAtProvider
      && (
        capture.amountCents !== payment.amount_cents
        || capture.currency !== normalizeCurrency(payment.currency)
      )
    ) {
      amountMismatches.push({
        transactionId: providerId,
        guildId,
        providerAmountCents: capture.amountCents,
        localAmountCents: payment.amount_cents,
        providerCurrency: capture.currency,
        localCurrency: normalizeCurrency(payment.currency),
      });
    }
    if (
      ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(capture.status)
      && !refundedPaymentRowsWithLocalRefund.has(payment.id)
    ) {
      // The operator refunded at PayPal (dashboard/app UI) and no webhook
      // landed: entitlements would stay live for money that went back.
      missingLocalPayments.push({
        kind: 'refund',
        transactionId: providerId,
        guildId,
        amountCents: payment.amount_cents,
        currency: capture.currency,
        initiatedAt: null,
        source: 'capture',
        referenceId: providerId,
      });
    }
  }
  const captureHeartbeatFailure = await heartbeat();
  if (captureHeartbeatFailure) return captureHeartbeatFailure;

  // 2) Refunds — every window refund by its provider identity.
  const refundResults = await mapWithConcurrency(
    windowRefunds,
    PROVIDER_CONCURRENCY,
    async (refund) => ({
      refund,
      lookup: await fetchProviderRefund(config.apiBase, token.token, refund.paypal_refund_id),
    }),
  );
  for (const { refund, lookup } of refundResults) {
    if (!lookup.ok) {
      return { status: 'failed', reason: lookup.reason, retriable: lookup.retriable };
    }
    const guildId = refund.guild_id as string;
    if (!lookup.found) {
      // A zero-amount row is a terminal reversal witness with no distinct
      // provider refund object; its absence is expected.
      if (refund.amount_cents === 0) continue;
      const order = refund.order_id ? ordersById.get(refund.order_id) : undefined;
      missingProviderPayments.push({
        kind: 'refund',
        orderId: refund.order_id as string,
        orderNumber: order?.order_number ?? null,
        guildId,
        paypalPaymentIds: [refund.paypal_refund_id],
        amountCents: refund.amount_cents as number,
        currency: normalizeCurrency(refund.currency) as string,
        createdAt: refund.created_at,
      });
      continue;
    }
    bumpVerified(guildId);
    // Local refund rows and provider refund objects both carry positive
    // amounts (the ledger validator rejects negatives).
    const providerAmountCents = lookup.value.amountCents;
    if (
      refund.amount_cents !== providerAmountCents
      || normalizeCurrency(refund.currency) !== lookup.value.currency
    ) {
      amountMismatches.push({
        transactionId: refund.paypal_refund_id,
        guildId,
        providerAmountCents,
        localAmountCents: refund.amount_cents as number,
        providerCurrency: lookup.value.currency,
        localCurrency: normalizeCurrency(refund.currency),
      });
    }
  }

  // 3) Orders — pending approval states and settled orders with no payment
  //    identity.
  const orderResults = await mapWithConcurrency(
    orderGetTargets,
    PROVIDER_CONCURRENCY,
    async (order) => ({
      order,
      lookup: await fetchProviderOrder(
        config.apiBase,
        token.token,
        order.paypal_order_id as string,
      ),
    }),
  );
  for (const { order, lookup } of orderResults) {
    if (!lookup.ok) {
      return { status: 'failed', reason: lookup.reason, retriable: lookup.retriable };
    }
    const guildId = order.guild_id as string;
    const pendingish = order.status === 'pending' || order.status === 'pending_review';
    if (!lookup.found) {
      // PayPal purges unapproved orders; a vanished PENDING order moved no
      // money. A vanished order behind SETTLED local commerce with no payment
      // identity means the settlement cannot be evidenced at the provider.
      if (!pendingish) {
        missingProviderPayments.push({
          kind: 'order',
          orderId: order.id,
          orderNumber: order.order_number,
          guildId,
          paypalPaymentIds: [],
          amountCents: order.amount_cents,
          currency: normalizeCurrency(order.currency) as string,
          createdAt: order.created_at,
        });
      }
      continue;
    }
    bumpVerified(guildId);
    const providerOrder = lookup.value;
    const identity = parseCustomIdentity(providerOrder.customId);
    if (
      identity
      && !customIdentityMatchesOrder(
        identity,
        order,
        isProviderId(order.paypal_subscription_id),
        typeof order.customer_id === 'string'
          ? customersById.get(order.customer_id)
          : undefined,
      )
    ) {
      return { status: 'failed', reason: 'provider identity conflict', retriable: false };
    }
    const settledCaptures = providerOrder.captures.filter((capture) =>
      PROVIDER_SETTLED_CAPTURE_STATUSES.includes(capture.status),
    );
    for (const capture of settledCaptures) {
      // A locally-known capture was already judged by the capture pass
      // (settlement, amounts, refunds); reporting it again here would double
      // count. Only captures with NO local row are this path's finding.
      if (localByProviderId.has(capture.id)) continue;
      // The buyer's money settled at PayPal and no local payment row
      // exists — the customer may have paid and received nothing.
      missingLocalPayments.push({
        kind: 'payment',
        transactionId: capture.id,
        guildId,
        amountCents: capture.amountCents,
        currency: capture.currency,
        initiatedAt: null,
        source: 'order',
        referenceId: order.paypal_order_id,
      });
    }
    if (
      !pendingish
      && providerOrder.status === 'COMPLETED'
      && settledCaptures.length === 0
    ) {
      // Locally settled, provider order exists but shows no settled capture.
      missingProviderPayments.push({
        kind: 'order',
        orderId: order.id,
        orderNumber: order.order_number,
        guildId,
        paypalPaymentIds: [],
        amountCents: order.amount_cents,
        currency: normalizeCurrency(order.currency) as string,
        createdAt: order.created_at,
      });
    }
  }

  // 4) Subscriptions — recurring billing writes v1 sale objects the captures
  //    API cannot serve, so subscription commerce is verified through the
  //    subscription's own billing state. Boundary (documented in the
  //    walkthrough): only the LATEST provider charge is individually
  //    assertable without the reporting product.
  const subscriptionResults = await mapWithConcurrency(
    [...subscriptionTargets.entries()],
    PROVIDER_CONCURRENCY,
    async ([subscriptionId, order]) => ({
      subscriptionId,
      order,
      lookup: await fetchProviderSubscription(config.apiBase, token.token, subscriptionId),
    }),
  );
  for (const { subscriptionId, order, lookup } of subscriptionResults) {
    if (!lookup.ok) {
      return { status: 'failed', reason: lookup.reason, retriable: lookup.retriable };
    }
    const guildId = order.guild_id as string;
    if (!lookup.found) {
      if (SETTLED_ORDER_STATUSES.includes(order.status)) {
        missingProviderPayments.push({
          kind: 'order',
          orderId: order.id,
          orderNumber: order.order_number,
          guildId,
          paypalPaymentIds: [subscriptionId],
          amountCents: order.amount_cents,
          currency: normalizeCurrency(order.currency) as string,
          createdAt: order.created_at,
        });
      }
      continue;
    }
    bumpVerified(guildId);
    const subscription = lookup.value;
    const lastPaymentMs = subscription.lastPaymentTime === null
      ? Number.NaN
      : Date.parse(subscription.lastPaymentTime);
    const lastPaymentInWindow = Number.isFinite(lastPaymentMs)
      && lastPaymentMs >= windowStartMs
      && lastPaymentMs <= windowEndMs;
    const orderWindowPayments = payments.filter(
      (payment) => payment.order_id === order.id,
    );
    if (lastPaymentInWindow && orderWindowPayments.length === 0) {
      missingLocalPayments.push({
        kind: 'payment',
        transactionId: subscriptionId,
        guildId,
        amountCents: subscription.lastPaymentAmountCents ?? order.amount_cents,
        currency: subscription.lastPaymentCurrency
          ?? (normalizeCurrency(order.currency) as string),
        initiatedAt: subscription.lastPaymentTime,
        source: 'subscription',
        referenceId: subscriptionId,
      });
      continue;
    }
    if (
      lastPaymentInWindow
      && subscription.lastPaymentAmountCents !== null
      && orderWindowPayments.length > 0
    ) {
      const latest = orderWindowPayments.reduce((best, candidate) =>
        String(candidate.created_at ?? '') > String(best.created_at ?? '') ? candidate : best,
      );
      if (
        latest.amount_cents !== subscription.lastPaymentAmountCents
        || normalizeCurrency(latest.currency) !== subscription.lastPaymentCurrency
      ) {
        amountMismatches.push({
          transactionId: subscriptionId,
          guildId,
          providerAmountCents: subscription.lastPaymentAmountCents,
          localAmountCents: latest.amount_cents,
          providerCurrency: subscription.lastPaymentCurrency ?? 'UNKNOWN',
          localCurrency: normalizeCurrency(latest.currency),
        });
      }
    }
  }

  const result: Extract<PayPalReconciliationResult, { status: 'completed' }> = {
    status: 'completed',
    windowStart,
    windowEnd,
    providerTransactions: providerObjectsVerified,
    localPayments: payments.length,
    localRefunds: windowRefunds.length,
    missingLocalPayments,
    missingProviderPayments,
    amountMismatches,
    unsettledLocalPayments,
    alerted: false,
  };

  const providerCountByGuild = verifiedByGuild;
  const paymentCountByGuild = new Map<string, number>();
  for (const payment of payments) {
    const guildId = payment.guild_id as string;
    paymentCountByGuild.set(guildId, (paymentCountByGuild.get(guildId) ?? 0) + 1);
  }
  const refundCountByGuild = new Map<string, number>();
  for (const refund of windowRefunds) {
    const guildId = refund.guild_id as string;
    refundCountByGuild.set(guildId, (refundCountByGuild.get(guildId) ?? 0) + 1);
  }

  let divergenceGuilds = 0;
  const alertHeartbeatFailure = await heartbeat();
  if (alertHeartbeatFailure) return alertHeartbeatFailure;
  for (const guildId of guildScan.rows) {
    const scoped = resultForGuild(
      result,
      guildId,
      providerCountByGuild.get(guildId) ?? 0,
      paymentCountByGuild.get(guildId) ?? 0,
      refundCountByGuild.get(guildId) ?? 0,
    );
    if (hasDivergence(scoped)) {
      divergenceGuilds += 1;
      if (!await raiseMismatchAlert(supabase, guildId, scoped)) {
        return {
          status: 'failed',
          reason: 'operator alert write failed',
          retriable: true,
        };
      }
    } else if (!await resolveAlertType(supabase, guildId, RECONCILE_ALERT_TYPE)) {
      return {
        status: 'failed',
        reason: 'operator alert resolution failed',
        retriable: true,
      };
    }
  }
  result.alerted = divergenceGuilds > 0;

  if (!await recordCompletedResult(supabase, result)) {
    return {
      status: 'failed',
      reason: 'last result bookkeeping failed',
      retriable: true,
    };
  }

  console.log(
    `[PayPalReconcile] ${windowStart}..${windowEnd}: `
    + `${providerObjectsVerified} provider object(s) verified, `
    + `${payments.length} local PayPal payment(s), `
    + `${windowRefunds.length} local PayPal refund(s), `
    + `${missingLocalPayments.length} missing locally, `
    + `${missingProviderPayments.length} missing at provider, `
    + `${amountMismatches.length} amount/currency mismatch(es), `
    + `${unsettledLocalPayments.length} unsettled local match(es)`,
  );
  void nowMs;
  return resultGuildId
    ? resultForGuild(
        result,
        resultGuildId,
        providerCountByGuild.get(resultGuildId) ?? 0,
        paymentCountByGuild.get(resultGuildId) ?? 0,
        refundCountByGuild.get(resultGuildId) ?? 0,
      )
    : result;
}

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

  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const ownerToken = randomUUID();
  const acquisition = await acquireReconcileLease(
    supabase,
    ownerToken,
    leaseMs,
    cooldownMs,
    options.bypassCooldown ?? true,
  );
  if (acquisition.status === 'error') {
    const failure: PayPalReconciliationFailure = {
      status: 'failed',
      reason: acquisition.reason,
      retriable: true,
    };
    return options.scheduledVisibility
      ? applyScheduledVisibility(supabase, failure)
      : failure;
  }
  if (acquisition.status === 'busy') {
    return { status: 'skipped', reason: 'another reconciliation pass is running' };
  }
  if (acquisition.status === 'cooldown') {
    return { status: 'skipped', reason: 'another reconciliation pass completed recently' };
  }

  let result: PayPalReconciliationResult = {
    status: 'failed',
    reason: 'reconciliation pass did not complete',
    retriable: true,
  };
  let fullyCompletedAndVisible = false;
  let finalization: ReconcileLeaseMutationResult = {
    ok: false,
    reason: 'reconciliation lease finalization did not run',
  };
  try {
    try {
      result = await runPass(
        supabase,
        nowMs,
        windowStartMs,
        windowEndMs,
        async () => {
          const heartbeat = await heartbeatReconcileLease(
            supabase,
            ownerToken,
            leaseMs,
          );
          return heartbeat.ok
            ? null
            : {
                status: 'failed',
                reason: heartbeat.reason,
                retriable: true,
              };
        },
        options.resultGuildId,
      );
    } catch (error) {
      result = {
        status: 'failed',
        reason: error instanceof Error ? error.message : 'reconciliation threw',
        retriable: true,
      };
    }

    if (options.scheduledVisibility) {
      result = await applyScheduledVisibilitySafely(supabase, result);
    }
    fullyCompletedAndVisible = result.status === 'completed';
  } finally {
    // Once acquisition succeeds, every pass/visibility exit releases or
    // completes this exact opaque owner exactly once.
    finalization = await finalizeReconcileLease(
      supabase,
      ownerToken,
      fullyCompletedAndVisible,
    );
  }
  if (!finalization.ok) {
    const failure: PayPalReconciliationFailure = {
      status: 'failed',
      reason: finalization.reason,
      retriable: true,
    };
    return options.scheduledVisibility
      ? applyScheduledVisibilitySafely(supabase, failure)
      : failure;
  }
  return result;
}
