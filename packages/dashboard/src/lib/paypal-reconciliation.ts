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
// PayPal accepts refunds up to ~180 days after capture; captures OLDER than
// the rolling window can gain refunds whose webhooks were lost, so they are
// re-checked for refund-status changes across this lookback.
export const DEFAULT_REFUND_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;
// Provider passes heartbeat the lease between bounded chunks: a degraded
// provider at 20k rows x 15s timeouts otherwise outlives the 6h lease and a
// second scheduler overlaps the pass.
const PROVIDER_CHUNK_SIZE = 200;
// A local row represents the provider's LATEST charge only when it landed at
// or after that charge (minus clock skew): webhook writes follow the charge
// within minutes, so a generous tolerance still rejects yesterday's renewal
// standing in for today's lost one.
const SUBSCRIPTION_CHARGE_TOLERANCE_MS = 6 * 60 * 60 * 1000;
const MAX_REPORTED_IDS = 25;

export const RECONCILE_LAST_RESULT_KEY = 'paypal_reconcile_last_result';
export const RECONCILE_ALERT_TYPE = 'paypal_reconciliation_mismatch';
export const RECONCILE_FAILURE_ALERT_TYPE = 'paypal_reconciliation_failure';

/** Transaction statuses that represent moved money and demand evidence. */
const MONEY_TXN_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'];

const ORDER_SCAN_STATUSES = [
  'completed',
  'disputed',
  'refunded',
  'pending',
  'pending_review',
  // Capture-denied checkouts move to cancelled — but a LATER capture can
  // still succeed (or its webhook be lost), leaving PayPal holding settled
  // money behind a customer the ledger says was never charged. Cancelled
  // orders with a provider identity stay in the recheck set.
  'cancelled',
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
  /** Parent order from supplementary_data.related_ids — cross-tenant guard. */
  relatedOrderId: string | null;
  /** When the capture last changed; null when the API omits it. */
  updateTimeMs: number | null;
}

export interface ProviderRefundObject {
  status: string;
  amountCents: number;
  currency: string;
  /** Parent capture parsed from the refund's up-link — identity guard. */
  parentCaptureId: string | null;
}

export interface ProviderOrderCapture {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  /** Provider-side creation time; null when the API omits it. */
  createTimeMs: number | null;
}

export interface ProviderOrderRefund {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  /** Provider-side creation time; null when the API omits it. */
  createTimeMs: number | null;
  /** Parent capture from the refund's up-link; null when the API omits it. */
  parentCaptureId: string | null;
}

/** v1 sale object — subscription billing writes sale ids, not captures. */
export interface ProviderSaleObject {
  state: string;
  amountCents: number;
  currency: string;
  /** The parent subscription (billing agreement) — cross-tenant guard. */
  billingAgreementId: string | null;
  /** When the sale last changed state; null when the API omits it. */
  updateTimeMs: number | null;
}

/** v1 refund object — refunds of subscription sales live on the v1 API. */
export interface ProviderSaleRefundObject {
  state: string;
  amountCents: number;
  currency: string;
  saleId: string | null;
}

export interface ProviderOrderObject {
  status: string;
  customId: string | null;
  subscriptionId: string | null;
  captures: ProviderOrderCapture[];
  /** Provider refunds enumerated per purchase unit — the authoritative
   *  sibling list the capture object itself cannot expose. */
  refunds: ProviderOrderRefund[];
  /** When the order last changed; null when the API omits it. */
  updateTimeMs: number | null;
}

export interface ProviderSubscriptionObject {
  status: string;
  lastPaymentTime: string | null;
  lastPaymentAmountCents: number | null;
  lastPaymentCurrency: string | null;
  /** Checkout identity minted at subscription creation — tenant guard. */
  customId: string | null;
  /** The PayPal plan the provider says this subscription bills. */
  planId: string | null;
  /** When the provider status last changed; null when the API omits it. */
  statusUpdateTimeMs: number | null;
}

/** One transaction from /v1/billing/subscriptions/{id}/transactions. */
export interface ProviderSubscriptionTransaction {
  id: string;
  status: string;
  timeMs: number;
  amountCents: number | null;
  currency: string | null;
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
  refundLookbackMs?: number;
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
  const related = (record.supplementary_data as
    { related_ids?: { order_id?: unknown } } | undefined)?.related_ids;
  return {
    ok: true,
    found: true,
    value: {
      status: record.status,
      amountCents,
      currency,
      relatedOrderId: isProviderId(related?.order_id) ? related.order_id : null,
      updateTimeMs: (() => {
        const parsed = typeof record.update_time === 'string'
          ? Date.parse(record.update_time)
          : Number.NaN;
        return Number.isFinite(parsed) ? parsed : null;
      })(),
    },
  };
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
  // The refund object exposes its parent capture only through the up-link.
  let parentCaptureId: string | null = null;
  const links = Array.isArray(record.links) ? record.links : [];
  for (const link of links) {
    const linkRecord = link as { rel?: unknown; href?: unknown } | null;
    if (linkRecord?.rel === 'up' && typeof linkRecord.href === 'string') {
      const match = /\/v2\/payments\/captures\/([^/?#]+)/.exec(linkRecord.href);
      if (match && isProviderId(match[1])) parentCaptureId = match[1];
    }
  }
  return {
    ok: true,
    found: true,
    value: { status: record.status, amountCents, currency, parentCaptureId },
  };
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
  const refunds: ProviderOrderRefund[] = [];
  let customId: string | null = null;
  for (const unit of units) {
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) {
      return { ok: false, retriable: false, reason: 'order lookup returned a malformed record' };
    }
    const unitRecord = unit as Record<string, unknown>;
    if (customId === null && typeof unitRecord.custom_id === 'string') {
      customId = unitRecord.custom_id;
    }
    const payments = unitRecord.payments as
      { captures?: unknown; refunds?: unknown } | undefined;
    const unitCaptures = Array.isArray(payments?.captures) ? payments.captures : [];
    const unitRefunds = Array.isArray(payments?.refunds) ? payments.refunds : [];
    for (const refund of unitRefunds) {
      if (!refund || typeof refund !== 'object' || Array.isArray(refund)) {
        return { ok: false, retriable: false, reason: 'order lookup returned a malformed record' };
      }
      const refundRecord = refund as Record<string, unknown>;
      const money = readProviderAmount(refundRecord.amount);
      if (
        !isProviderId(refundRecord.id)
        || typeof refundRecord.status !== 'string'
        || money.amountCents === null
        || money.currency === null
      ) {
        return { ok: false, retriable: false, reason: 'order lookup returned a malformed record' };
      }
      const createTimeMs = typeof refundRecord.create_time === 'string'
        ? Date.parse(refundRecord.create_time)
        : Number.NaN;
      let refundParentCaptureId: string | null = null;
      const refundLinks = Array.isArray(refundRecord.links) ? refundRecord.links : [];
      for (const link of refundLinks) {
        const linkRecord = link as { rel?: unknown; href?: unknown } | null;
        if (linkRecord?.rel === 'up' && typeof linkRecord.href === 'string') {
          const match = /\/v2\/payments\/captures\/([^/?#]+)/.exec(linkRecord.href);
          if (match && isProviderId(match[1])) refundParentCaptureId = match[1];
        }
      }
      refunds.push({
        id: refundRecord.id,
        status: refundRecord.status,
        amountCents: money.amountCents,
        currency: money.currency,
        createTimeMs: Number.isFinite(createTimeMs) ? createTimeMs : null,
        parentCaptureId: refundParentCaptureId,
      });
    }
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
      const captureCreateMs = typeof captureRecord.create_time === 'string'
        ? Date.parse(captureRecord.create_time)
        : Number.NaN;
      captures.push({
        id: captureRecord.id,
        status: captureRecord.status,
        amountCents,
        currency,
        createTimeMs: Number.isFinite(captureCreateMs) ? captureCreateMs : null,
      });
    }
  }
  if (record.status === 'COMPLETED' && captures.length === 0) {
    // A COMPLETED order without a single capture row — the collection
    // absent OR empty — contradicts its own status: money cannot have
    // completed with nothing captured. Treating it as "no captures" let a
    // lost capture write pass cleanly behind a pending local order.
    return { ok: false, retriable: false, reason: 'order lookup returned a malformed record' };
  }
  return {
    ok: true,
    found: true,
    value: {
      status: record.status,
      customId,
      subscriptionId: isProviderId(record.subscription_id) ? record.subscription_id : null,
      captures,
      refunds,
      updateTimeMs: (() => {
        const parsed = typeof record.update_time === 'string'
          ? Date.parse(record.update_time)
          : Number.NaN;
        return Number.isFinite(parsed) ? parsed : null;
      })(),
    },
  };
}

/** v1 money shape: { total, currency } instead of v2's { value, currency_code }. */
function readV1Amount(
  record: unknown,
): { amountCents: number | null; currency: string | null } {
  const amount = record as { total?: unknown; currency?: unknown } | null | undefined;
  return {
    amountCents: parseAmountToCents(amount?.total),
    currency: normalizeCurrency(amount?.currency),
  };
}

export async function fetchProviderSale(
  apiBase: string,
  token: string,
  saleId: string,
): Promise<ProviderFetch<ProviderSaleObject>> {
  const result = await providerGet(
    apiBase,
    token,
    `/v1/payments/sale/${encodeURIComponent(saleId)}`,
    'sale lookup',
  );
  if (!result.ok || !result.found) return result;
  const record = result.value;
  const { amountCents, currency } = readV1Amount(record.amount);
  if (
    typeof record.state !== 'string'
    || record.state.length === 0
    || amountCents === null
    || currency === null
  ) {
    return { ok: false, retriable: false, reason: 'sale lookup returned a malformed record' };
  }
  return {
    ok: true,
    found: true,
    value: {
      state: record.state,
      amountCents,
      currency,
      billingAgreementId: isProviderId(record.billing_agreement_id)
        ? record.billing_agreement_id
        : null,
      updateTimeMs: (() => {
        const parsed = typeof record.update_time === 'string'
          ? Date.parse(record.update_time)
          : Number.NaN;
        return Number.isFinite(parsed) ? parsed : null;
      })(),
    },
  };
}

export async function fetchProviderSaleRefund(
  apiBase: string,
  token: string,
  refundId: string,
): Promise<ProviderFetch<ProviderSaleRefundObject>> {
  const result = await providerGet(
    apiBase,
    token,
    `/v1/payments/refund/${encodeURIComponent(refundId)}`,
    'sale refund lookup',
  );
  if (!result.ok || !result.found) return result;
  const record = result.value;
  const { amountCents, currency } = readV1Amount(record.amount);
  if (
    typeof record.state !== 'string'
    || record.state.length === 0
    || amountCents === null
    || currency === null
  ) {
    return {
      ok: false,
      retriable: false,
      reason: 'sale refund lookup returned a malformed record',
    };
  }
  return {
    ok: true,
    found: true,
    value: {
      state: record.state,
      amountCents,
      currency,
      saleId: isProviderId(record.sale_id) ? record.sale_id : null,
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
  // Every divergence branch downstream keys on a KNOWN state; an
  // unrecognized (new or malformed) status would run none of them and let
  // the subscription reconcile cleanly on silence. Fail closed instead.
  const KNOWN_SUBSCRIPTION_STATUSES = [
    'APPROVAL_PENDING',
    'APPROVED',
    'CREATED',
    'ACTIVE',
    'SUSPENDED',
    'CANCELLED',
    'EXPIRED',
  ];
  if (
    typeof record.status !== 'string'
    || record.status.length === 0
    || !KNOWN_SUBSCRIPTION_STATUSES.includes(record.status)
  ) {
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
      customId: typeof record.custom_id === 'string' && record.custom_id.length > 0
        ? record.custom_id
        : null,
      planId: isProviderId(record.plan_id) ? record.plan_id : null,
      statusUpdateTimeMs: (() => {
        const parsed = typeof record.status_update_time === 'string'
          ? Date.parse(record.status_update_time)
          : Number.NaN;
        return Number.isFinite(parsed) ? parsed : null;
      })(),
    },
  };
}

/**
 * Every transaction PayPal recorded for the subscription in a time range —
 * the discovery surface for NON-latest recurring charges whose webhooks were
 * lost (billing_info.last_payment only ever names the newest one). Standard
 * billing API; never the reporting product.
 */
export async function fetchProviderSubscriptionTransactions(
  apiBase: string,
  token: string,
  subscriptionId: string,
  startIso: string,
  endIso: string,
): Promise<ProviderFetch<ProviderSubscriptionTransaction[]>> {
  const query = `start_time=${encodeURIComponent(startIso)}&end_time=${encodeURIComponent(endIso)}`;
  const result = await providerGet(
    apiBase,
    token,
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/transactions?${query}`,
    'subscription transactions lookup',
  );
  if (!result.ok || !result.found) return result;
  const record = result.value;
  if (record.transactions !== undefined && !Array.isArray(record.transactions)) {
    return {
      ok: false,
      retriable: false,
      reason: 'subscription transactions lookup returned a malformed record',
    };
  }
  // PayPal omits the field entirely for a subscription with no transactions
  // in range; anything PRESENT must be an actual array.
  const raw = Array.isArray(record.transactions) ? record.transactions : [];
  const transactions: ProviderSubscriptionTransaction[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        ok: false,
        retriable: false,
        reason: 'subscription transactions lookup returned a malformed record',
      };
    }
    const txn = entry as Record<string, unknown>;
    const timeMs = typeof txn.time === 'string' ? Date.parse(txn.time) : Number.NaN;
    if (
      !isProviderId(txn.id)
      || typeof txn.status !== 'string'
      || txn.status.length === 0
      || !Number.isFinite(timeMs)
    ) {
      return {
        ok: false,
        retriable: false,
        reason: 'subscription transactions lookup returned a malformed record',
      };
    }
    const breakdown = (txn.amount_with_breakdown as
      { gross_amount?: unknown } | undefined)?.gross_amount;
    const money = readProviderAmount(breakdown);
    // A money-moving status with no money is not an optional field — the
    // null-guarded downstream comparisons would silently skip every check
    // and let an arbitrary local row account for the charge.
    if (
      MONEY_TXN_STATUSES.includes(txn.status)
      && (money.amountCents === null || money.currency === null)
    ) {
      return {
        ok: false,
        retriable: false,
        reason: 'subscription transactions lookup returned a malformed record',
      };
    }
    transactions.push({
      id: txn.id,
      status: txn.status,
      timeMs,
      amountCents: money.amountCents,
      currency: money.currency,
    });
  }
  return { ok: true, found: true, value: transactions };
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

/**
 * Provider fetches in bounded chunks with a lease heartbeat between chunks —
 * the whole target set must never outlive the lease silently.
 */
async function mapChunkedWithHeartbeat<T, R>(
  items: T[],
  heartbeat: () => Promise<PayPalReconciliationFailure | null>,
  handler: (item: T) => Promise<R>,
): Promise<{ ok: true; results: R[] } | { ok: false; failure: PayPalReconciliationFailure }> {
  const results: R[] = [];
  for (let from = 0; from < items.length; from += PROVIDER_CHUNK_SIZE) {
    const chunk = items.slice(from, from + PROVIDER_CHUNK_SIZE);
    results.push(...await mapWithConcurrency(chunk, PROVIDER_CONCURRENCY, handler));
    const failure = await heartbeat();
    if (failure) return { ok: false, failure };
  }
  return { ok: true, results };
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
    // One payment can carry MANY refund siblings: page each group with a
    // stable order — an unpaged read silently truncates at the PostgREST
    // response cap and a partial aggregate fakes parity.
    for (let from = 0; ; from += LOCAL_PAGE_SIZE) {
      const { data, error } = await supabase
        .from('payment_refunds')
        .select(LOCAL_REFUND_SELECT)
        .in(column, group)
        .order('id', { ascending: true })
        .range(from, from + LOCAL_PAGE_SIZE - 1);
      if (error) {
        return {
          ok: false,
          retriable: true,
          reason: `exact local refund lookup failed: ${error.message}`,
        };
      }
      const page = (data ?? []) as LocalRefundRow[];
      found.push(...page);
      if (page.length < LOCAL_PAGE_SIZE) break;
    }
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
  refundLookbackMs: number,
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
  // Historical refund parents live outside the window scan, so their orders
  // may not be loaded yet — load them before the relation guard below, or a
  // cross-tenant parent (payment and refund consistently claiming guild B
  // while the ORDER belongs to guild A) sails through every later check.
  {
    const historicalParentOrderScan = await lookupOrdersByExactColumn(
      supabase,
      'id',
      [...new Set(
        validatedRefundPayments.rows
          .map((payment) => payment.order_id)
          .filter((id): id is string => typeof id === 'string' && !ordersById.has(id)),
      )],
      configuredGuildIds,
    );
    if (!historicalParentOrderScan.ok) {
      return {
        status: 'failed',
        reason: historicalParentOrderScan.reason,
        retriable: historicalParentOrderScan.retriable,
      };
    }
    for (const order of historicalParentOrderScan.rows) ordersById.set(order.id, order);
  }
  for (const payment of [...payments, ...validatedRefundPayments.rows]) {
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
  const missingLocalPayments: MissingLocalPayment[] = [];
  const amountMismatches: AmountMismatch[] = [];
  const unsettledLocalPayments: UnsettledLocalPayment[] = [];
  const missingProviderPayments: MissingProviderPayment[] = [];
  const orderGetTargets: LocalOrderRow[] = [];
  for (const order of orders) {
    const pendingish = order.status === 'pending' || order.status === 'pending_review';
    const settled = SETTLED_ORDER_STATUSES.includes(order.status);
    if (!isProviderId(order.paypal_order_id)) {
      // A SETTLED purchase order with no provider identity anywhere — no
      // order id, no subscription id, no payment row — has zero PayPal
      // evidence behind money the ledger claims settled (historical rows or
      // a failed identity write). It can never enter a provider target, so
      // report it directly instead of silently skipping.
      if (
        settled
        && !orderIdsWithPaymentIdentity.has(order.id)
        && !isProviderId(order.paypal_subscription_id)
      ) {
        missingProviderPayments.push({
          kind: 'order',
          orderId: order.id,
          orderNumber: order.order_number,
          guildId: order.guild_id as string,
          paypalPaymentIds: [],
          amountCents: order.amount_cents,
          currency: normalizeCurrency(order.currency) as string,
          createdAt: order.created_at,
        });
      }
      continue;
    }
    if (
      pendingish
      || order.status === 'cancelled'
      || (settled && !orderIdsWithPaymentIdentity.has(order.id))
    ) {
      orderGetTargets.push(order);
    }
  }

  // Cancelled orders leave the creation-window scan after DEFAULT_WINDOW_MS,
  // but the deny-then-late-capture race outlives it: PayPal can settle a
  // capture whose webhook was lost long after the local cancellation. Page
  // the PayPal-identified historical cancelled backlog (refund-lookback
  // horizon) into the same recheck set.
  {
    const cancelledLookbackStartIso = new Date(
      windowStartMs - Math.max(0, refundLookbackMs),
    ).toISOString();
    const targetedOrderIds = new Set(orderGetTargets.map((order) => order.id));
    let scanComplete = false;
    for (let from = 0; from < LOCAL_SCAN_MAX_ROWS; from += LOCAL_PAGE_SIZE) {
      const heartbeatFailure = await heartbeat();
      if (heartbeatFailure) return heartbeatFailure;
      const { data, error } = await supabase
        .from('orders')
        .select('id, order_number, guild_id, customer_id, product_id, plan_id, amount_cents, currency, status, source, paypal_order_id, paypal_subscription_id, created_at')
        .or('source.eq.purchase,source.is.null')
        .gt('amount_cents', 0)
        .eq('status', 'cancelled')
        .not('paypal_order_id', 'is', null)
        .gte('created_at', cancelledLookbackStartIso)
        .lt('created_at', windowStart)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + LOCAL_PAGE_SIZE - 1);
      if (error) {
        return {
          status: 'failed',
          reason: `historical cancelled-order scan failed: ${error.message}`,
          retriable: true,
        };
      }
      const page = (data ?? []) as LocalOrderRow[];
      for (const order of page) {
        // Re-assert the predicate in code: the recheck set must hold ONLY
        // identified historical cancellations even if the storage layer
        // returns a wider page.
        if (
          order.status !== 'cancelled'
          || !isProviderId(order.paypal_order_id)
          || String(order.created_at ?? '') >= windowStart
          || targetedOrderIds.has(order.id)
        ) {
          continue;
        }
        targetedOrderIds.add(order.id);
        orderGetTargets.push(order);
      }
      if (page.length < LOCAL_PAGE_SIZE) {
        scanComplete = true;
        break;
      }
    }
    if (!scanComplete) {
      // Exactly-at-cap is SUPPORTED: only a probed row past the cap means
      // the backlog truly exceeds it (same discipline as the other scans).
      const { data: overflow, error: overflowError } = await supabase
        .from('orders')
        .select('id')
        .or('source.eq.purchase,source.is.null')
        .gt('amount_cents', 0)
        .eq('status', 'cancelled')
        .not('paypal_order_id', 'is', null)
        .gte('created_at', cancelledLookbackStartIso)
        .lt('created_at', windowStart)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(LOCAL_SCAN_MAX_ROWS, LOCAL_SCAN_MAX_ROWS);
      if (overflowError) {
        return {
          status: 'failed',
          reason: `historical cancelled-order overflow probe failed: ${overflowError.message}`,
          retriable: true,
        };
      }
      if (((overflow ?? []) as Array<{ id: string }>).length > 0) {
        return {
          status: 'failed',
          reason: `historical cancelled-order scan exceeded ${LOCAL_SCAN_MAX_ROWS} rows — narrow the lookback`,
          retriable: true,
        };
      }
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

  // Subscriptions to verify: the window's orders/payments seed the map, and
  // a PAGED sweep over every settled subscription order runs at judge time —
  // established subscriptions stay targets without a lifetime-wide cap.
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
  let providerObjectsVerified = 0;
  const verifiedByGuild = new Map<string, number>();
  const bumpVerified = (guildId: string | null) => {
    providerObjectsVerified += 1;
    if (typeof guildId === 'string') {
      verifiedByGuild.set(guildId, (verifiedByGuild.get(guildId) ?? 0) + 1);
    }
  };
  const PROVIDER_SETTLED_CAPTURE_STATUSES = ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'];

  // 1) Captures — every window payment by its own provider identity, plus a
  //    PAGED refund lookback over older settled rows (PayPal accepts refunds
  //    for months; a page-at-a-time sweep never trips the window row cap).
  //    Subscription billing writes v1 SALE ids — those rows are verified
  //    through /v1/payments/sale instead of being skipped blind.
  const windowPaymentIds = new Set(payments.map((payment) => payment.id));
  // The established-subscription sweep is unbounded by design; a per-
  // subscription full scan of up to 20k window payments multiplies into
  // the billions. Index once, look up in constant time.
  const windowPaymentsByOrderId = new Map<string, LocalPaymentRow[]>();
  for (const payment of payments) {
    const key = payment.order_id as string;
    const list = windowPaymentsByOrderId.get(key);
    if (list) list.push(payment);
    else windowPaymentsByOrderId.set(key, [payment]);
  }

  const isSubscriptionSaleRow = (payment: LocalPaymentRow): boolean => {
    const order = ordersById.get(payment.order_id as string);
    return Boolean(order && isProviderId(order.paypal_subscription_id));
  };

  const windowCaptureRows = payments.filter((payment) => !isSubscriptionSaleRow(payment));
  const windowSaleRows = payments.filter((payment) => isSubscriptionSaleRow(payment));

  const captureMap = await mapChunkedWithHeartbeat(
    windowCaptureRows,
    heartbeat,
    async (payment) => ({
      payment,
      lookup: await fetchProviderCapture(
        config.apiBase,
        token.token,
        payment.paypal_payment_id as string,
      ),
    }),
  );
  if (!captureMap.ok) return captureMap.failure;
  const captureResults = captureMap.results;
  for (const { lookup } of captureResults) {
    if (!lookup.ok) {
      return { status: 'failed', reason: lookup.reason, retriable: lookup.retriable };
    }
  }

  // Provider-refunded captures: resolve their local refund totals exactly
  // (refund rows may sit outside the window) AND enumerate the provider's
  // own refund list through the parent ORDER — the capture object cannot
  // list its refund siblings, but /v2/checkout/orders can, which is what
  // makes a lost later sibling of a partial series detectable.
  const refundedWindowCaptures = captureResults.filter(({ lookup }) =>
    lookup.ok && lookup.found
    && ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(lookup.value.status),
  );
  const localRefundTotalsByPaymentRow = new Map<string, number>();
  const localRefundIdsByPaymentRow = new Map<string, Set<string>>();
  const localRefundRowsByProviderId = new Map<
    string,
    { amountCents: number; currency: string | null }
  >();
  // Lag-fresh local refund rows (created inside the settlement interval):
  // held aside, counted only where the provider side is CONFIRMED settled.
  const recentLocalRefundRowsByProviderId = new Map<
    string,
    { amountCents: number; currency: string | null }
  >();
  const recentLocalRefundsByPaymentRow = new Map<
    string,
    Array<{ providerId: string; amountCents: number }>
  >();
  const refundTotalParentById = new Map<string, LocalPaymentRow>();
  const loadLocalRefundTotals = async (parents: LocalPaymentRow[]) => {
    for (const parent of parents) refundTotalParentById.set(parent.id, parent);
    const missing = parents
      .map((parent) => parent.id)
      .filter((id) => !localRefundTotalsByPaymentRow.has(id));
    if (missing.length === 0) return null;
    const scan = await lookupRefundsByExactColumn(supabase, 'payment_id', missing);
    if (!scan.ok) {
      return { status: 'failed' as const, reason: scan.reason, retriable: scan.retriable };
    }
    // Historical rows never crossed validateLocalRefunds on this pass —
    // aggregating an unvalidated amount would let a malformed old row fake
    // parity with the provider total.
    const validated = validateLocalRefunds(scan.rows, configuredGuildIds);
    if (!validated.ok) {
      return {
        status: 'failed' as const,
        reason: validated.reason,
        retriable: validated.retriable,
      };
    }
    for (const id of missing) {
      localRefundTotalsByPaymentRow.set(id, 0);
      localRefundIdsByPaymentRow.set(id, new Set());
    }
    for (const refund of validated.rows) {
      const key = refund.payment_id as string;
      const parent = refundTotalParentById.get(key);
      // Parent OWNERSHIP, exactly like the in-window relation guard: a row
      // that references this payment while carrying another order or guild
      // is corrupt linkage — summing it would suppress the real capture's
      // missing-refund finding and attribute money to the wrong ledger.
      if (
        parent
        && (refund.order_id !== parent.order_id || refund.guild_id !== parent.guild_id)
      ) {
        return {
          status: 'failed' as const,
          reason: 'provider refund identity conflict',
          retriable: false,
        };
      }
      if (
        parent
        && normalizeCurrency(refund.currency) !== normalizeCurrency(parent.currency)
      ) {
        // A cross-currency refund row cannot participate in the aggregate;
        // surface the drift instead of silently summing it.
        amountMismatches.push({
          transactionId: refund.paypal_refund_id,
          guildId: refund.guild_id as string,
          providerAmountCents: 0,
          localAmountCents: refund.amount_cents as number,
          providerCurrency: normalizeCurrency(parent.currency) ?? 'UNKNOWN',
          localCurrency: normalizeCurrency(refund.currency),
        });
        continue;
      }
      // Symmetric with the provider aggregate -- but not blindly: a refund
      // row younger than the window end may merely be the LATE local write
      // of an old, settled provider refund, and dropping it manufactured a
      // false "missing locally" against its settled sibling. Its twin may
      // equally still be in flight, so hold it aside: it counts only where
      // the provider side is CONFIRMED settled (an enumerated settled
      // sibling carrying this id, or a parent whose refunded status itself
      // passed the update-time lag gate).
      if (String(refund.created_at ?? '') > windowEnd) {
        recentLocalRefundsByPaymentRow.set(key, [
          ...(recentLocalRefundsByPaymentRow.get(key) ?? []),
          {
            providerId: refund.paypal_refund_id,
            amountCents: Math.max(0, refund.amount_cents as number),
          },
        ]);
        recentLocalRefundRowsByProviderId.set(refund.paypal_refund_id, {
          amountCents: refund.amount_cents as number,
          currency: normalizeCurrency(refund.currency),
        });
        continue;
      }
      localRefundTotalsByPaymentRow.set(
        key,
        (localRefundTotalsByPaymentRow.get(key) ?? 0)
          + Math.max(0, refund.amount_cents as number),
      );
      localRefundIdsByPaymentRow.get(key)?.add(refund.paypal_refund_id);
      localRefundRowsByProviderId.set(refund.paypal_refund_id, {
        amountCents: refund.amount_cents as number,
        currency: normalizeCurrency(refund.currency),
      });
    }
    return null;
  };
  {
    const totalsFailure = await loadLocalRefundTotals(
      refundedWindowCaptures.map(({ payment }) => payment),
    );
    if (totalsFailure) return totalsFailure;
  }

  const orderRefundLists = new Map<string, {
    refunds: ProviderOrderRefund[];
    /** Parent captures of completed refunds excluded as in-flight. */
    inFlightParentIds: Array<string | null>;
  } | null>();
  const loadOrderRefundTotals = async (orderProviderIds: string[]) => {
    const targets = [...new Set(orderProviderIds)].filter(
      (id) => !orderRefundLists.has(id),
    );
    if (targets.length === 0) return null;
    const map = await mapChunkedWithHeartbeat(
      targets,
      heartbeat,
      async (providerOrderId) => ({
        providerOrderId,
        lookup: await fetchProviderOrder(config.apiBase, token.token, providerOrderId),
      }),
    );
    if (!map.ok) return map.failure;
    for (const { providerOrderId, lookup } of map.results) {
      if (!lookup.ok) {
        return {
          status: 'failed' as const,
          reason: lookup.reason,
          retriable: lookup.retriable,
        };
      }
      if (!lookup.found) {
        orderRefundLists.set(providerOrderId, null);
      } else {
        const completed = lookup.value.refunds.filter(
          (refund) => refund.status === 'COMPLETED',
        );
        // The settlement lag applies to provider-side refunds too: a refund
        // issued moments ago has its webhook legitimately in flight, so
        // refunds younger than the window end are excluded (unknown times
        // count as old) — but if EVERYTHING was excluded, that is a defer,
        // never an authoritative empty ledger.
        const settled = completed.filter(
          (refund) => refund.createTimeMs === null || refund.createTimeMs <= windowEndMs,
        );
        // Partitioning by parent only works when every settled entry NAMES
        // a parent. A single-capture order attributes unlinked entries by
        // construction; on a multi-capture order the standalone refund
        // endpoint resolves them, and an unresolvable parent is a malformed
        // enumeration — attributing it to EVERY capture manufactured false
        // missing-refund alerts on the others.
        const captureIds = lookup.value.captures.map((capture) => capture.id);
        const resolved: ProviderOrderRefund[] = [];
        for (const refund of settled) {
          if (refund.parentCaptureId !== null) {
            resolved.push(refund);
            continue;
          }
          if (captureIds.length === 1) {
            resolved.push({ ...refund, parentCaptureId: captureIds[0] });
            continue;
          }
          const standalone = await fetchProviderRefund(
            config.apiBase,
            token.token,
            refund.id,
          );
          if (!standalone.ok) {
            return {
              status: 'failed' as const,
              reason: standalone.reason,
              retriable: standalone.retriable,
            };
          }
          if (!standalone.found || standalone.value.parentCaptureId === null) {
            return {
              status: 'failed' as const,
              reason: 'order lookup returned a malformed record',
              retriable: false,
            };
          }
          resolved.push({ ...refund, parentCaptureId: standalone.value.parentCaptureId });
        }
        orderRefundLists.set(providerOrderId, {
          refunds: resolved,
          inFlightParentIds: completed
            .filter((refund) => !settled.includes(refund))
            .map((refund) => refund.parentCaptureId),
        });
      }
    }
    return null;
  };
  const parentProviderOrderId = (
    payment: LocalPaymentRow,
    relatedOrderId: string | null,
  ): string | null => {
    if (relatedOrderId) return relatedOrderId;
    const order = ordersById.get(payment.order_id as string);
    return order && isProviderId(order.paypal_order_id) ? order.paypal_order_id : null;
  };
  {
    const enumFailure = await loadOrderRefundTotals(
      refundedWindowCaptures
        .map(({ payment, lookup }) => (lookup.ok && lookup.found
          ? parentProviderOrderId(payment, lookup.value.relatedOrderId)
          : null))
        .filter((id): id is string => id !== null),
    );
    if (enumFailure) return enumFailure;
  }

  /**
   * Judge a provider-refunded payment against the local refund ledger.
   * Provider aggregate (from the parent order's refund list) is
   * authoritative when available; otherwise the capture/sale status bounds
   * the comparison.
   */
  const judgeRefundedPayment = (input: {
    payment: LocalPaymentRow;
    guildId: string;
    providerId: string;
    providerStatusFullyRefunded: boolean;
    providerAmountCents: number;
    providerCurrency: string;
    providerRefunds: {
      refunds: ProviderOrderRefund[];
      inFlightParentIds: Array<string | null>;
    } | null;
  }) => {
    const localTotal = localRefundTotalsByPaymentRow.get(input.payment.id) ?? 0;
    const localIds = localRefundIdsByPaymentRow.get(input.payment.id) ?? new Set<string>();
    const recentRows = recentLocalRefundsByPaymentRow.get(input.payment.id) ?? [];
    // The order's list spans ALL its captures: judge THIS parent only
    // against siblings attributable to it (up-link matches, or no up-link
    // to partition by), or one capture's correct ledger reads as another's
    // missing money. Wholly lag-filtered attributable lists DEFER (webhooks
    // in flight, the next pass owns them); an empty list behind a capture
    // whose own state proves refund activity is provider-inconsistent and
    // falls back to the status-bound comparison; a populated list is
    // authoritative.
    const attributable = (parentId: string | null) =>
      parentId === null || parentId === input.providerId;
    const refundsForParent = input.providerRefunds === null
      ? null
      : input.providerRefunds.refunds.filter(
          (refund) => attributable(refund.parentCaptureId),
        );
    if (
      refundsForParent !== null
      && refundsForParent.length === 0
      && input.providerRefunds !== null
      && input.providerRefunds.inFlightParentIds.some(attributable)
    ) {
      return;
    }
    const providerRefunds = refundsForParent !== null && refundsForParent.length > 0
      ? refundsForParent
      : null;
    if (providerRefunds !== null) {
      // Per-SIBLING diff, not an aggregate: operators get the exact refund
      // id to inspect/replay, and a same-total ledger with WRONG sibling
      // ids cannot mask identity drift.
      const providerTotal = providerRefunds
        .reduce((sum, refund) => sum + refund.amountCents, 0);
      let recentMatchedTotal = 0;
      for (const refund of providerRefunds) {
        // A lag-fresh local row whose id matches THIS enumerated settled
        // sibling is the late write of an old refund -- present, not
        // missing; its provider twin is confirmed settled by the list.
        const recentRow = localIds.has(refund.id)
          ? undefined
          : recentLocalRefundRowsByProviderId.get(refund.id);
        if (recentRow !== undefined) {
          recentMatchedTotal += Math.max(0, recentRow.amountCents);
        }
        if (localIds.has(refund.id) || recentRow !== undefined) {
          // Matched by id is not matched by MONEY: an understated historical
          // row (or offsetting sibling errors) must still surface. The
          // in-window refund pass owns window rows; this catches the rest.
          const localRow = recentRow ?? localRefundRowsByProviderId.get(refund.id);
          if (
            localRow
            && (
              localRow.amountCents !== refund.amountCents
              || (localRow.currency !== null && localRow.currency !== refund.currency)
            )
          ) {
            amountMismatches.push({
              transactionId: refund.id,
              guildId: input.guildId,
              providerAmountCents: refund.amountCents,
              localAmountCents: localRow.amountCents,
              providerCurrency: refund.currency,
              localCurrency: localRow.currency,
            });
          }
          continue;
        }
        missingLocalPayments.push({
          kind: 'refund',
          transactionId: refund.id,
          guildId: input.guildId,
          amountCents: refund.amountCents,
          currency: refund.currency,
          initiatedAt: refund.createTimeMs !== null
            ? new Date(refund.createTimeMs).toISOString()
            : null,
          source: 'capture',
          referenceId: input.providerId,
        });
      }
      const coveredLocalTotal = localTotal + recentMatchedTotal;
      if (coveredLocalTotal > providerTotal) {
        amountMismatches.push({
          transactionId: input.providerId,
          guildId: input.guildId,
          providerAmountCents: providerTotal,
          localAmountCents: coveredLocalTotal,
          providerCurrency: input.providerCurrency,
          localCurrency: input.providerCurrency,
        });
      }
      // A FULLY refunded capture is the stronger truth than the enumerated
      // list: when the list (and the ledger) cover less than the capture
      // amount, the uncovered remainder is a lost refund the order response
      // failed to enumerate.
      if (input.providerStatusFullyRefunded) {
        const covered = Math.max(coveredLocalTotal, providerTotal);
        if (covered < input.providerAmountCents) {
          missingLocalPayments.push({
            kind: 'refund',
            transactionId: input.providerId,
            guildId: input.guildId,
            amountCents: input.providerAmountCents - covered,
            currency: input.providerCurrency,
            initiatedAt: null,
            source: 'capture',
            referenceId: input.providerId,
          });
        }
      }
      return;
    }
    // The status-bound fallback runs only for parents whose refunded state
    // passed the update-time lag gate: every refund that state reflects is
    // settled-age, so lag-fresh local rows for THIS parent are late writes
    // of settled refunds and count.
    const fallbackLocalTotal = localTotal
      + recentRows.reduce((sum, row) => sum + Math.max(0, row.amountCents), 0);
    if (input.providerStatusFullyRefunded && fallbackLocalTotal < input.providerAmountCents) {
      missingLocalPayments.push({
        kind: 'refund',
        transactionId: input.providerId,
        guildId: input.guildId,
        amountCents: input.providerAmountCents - fallbackLocalTotal,
        currency: input.providerCurrency,
        initiatedAt: null,
        source: 'capture',
        referenceId: input.providerId,
      });
    } else if (
      input.providerStatusFullyRefunded
      && fallbackLocalTotal > input.providerAmountCents
    ) {
      // Symmetric with the enumerated over-refund check: a fully refunded
      // parent bounds its ledger at the parent amount, and an OVERSTATED
      // aggregate is corruption the under-refund branch cannot see.
      amountMismatches.push({
        transactionId: input.providerId,
        guildId: input.guildId,
        providerAmountCents: input.providerAmountCents,
        localAmountCents: fallbackLocalTotal,
        providerCurrency: input.providerCurrency,
        localCurrency: input.providerCurrency,
      });
    } else if (!input.providerStatusFullyRefunded && fallbackLocalTotal === 0) {
      missingLocalPayments.push({
        kind: 'refund',
        transactionId: input.providerId,
        guildId: input.guildId,
        amountCents: input.payment.amount_cents,
        currency: input.providerCurrency,
        initiatedAt: null,
        source: 'capture',
        referenceId: input.providerId,
      });
    } else if (
      !input.providerStatusFullyRefunded
      && fallbackLocalTotal >= input.providerAmountCents
    ) {
      amountMismatches.push({
        transactionId: input.providerId,
        guildId: input.guildId,
        providerAmountCents: input.providerAmountCents,
        localAmountCents: fallbackLocalTotal,
        providerCurrency: input.providerCurrency,
        localCurrency: input.providerCurrency,
      });
    }
  };

  for (const { payment, lookup } of captureResults) {
    if (!lookup.ok) continue;
    const order = ordersById.get(payment.order_id as string);
    const guildId = payment.guild_id as string;
    const providerId = payment.paypal_payment_id as string;
    // An order that CLAIMS settlement demands provider evidence even when
    // its only payment row is pending/failed: entitlements follow the order,
    // and a nonterminal row must not exempt the claim from proof.
    const orderClaimsSettlement = Boolean(
      order && SETTLED_ORDER_STATUSES.includes(order.status),
    );
    if (!lookup.found) {
      if (isSettledPair(payment, order) || orderClaimsSettlement) {
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
    // Cross-tenant identity: the capture's parent order must be the LOCAL
    // order's provider identity. A valid capture id borrowed from another
    // order/guild with matching amounts previously verified cleanly.
    if (
      order
      && isProviderId(order.paypal_order_id)
      && (
        capture.relatedOrderId === null
        || capture.relatedOrderId !== order.paypal_order_id
      )
    ) {
      // An omitted related order is the same defect as a foreign one: the
      // only capture-to-order ownership check must not be skippable by
      // stripping supplementary_data.
      return { status: 'failed', reason: 'provider identity conflict', retriable: false };
    }
    const providerRefunded = ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(capture.status)
      // A capture whose state changed inside the settlement lag has its
      // refund webhook in flight; without the order's refund list to time-
      // filter, the status-only fallback must defer.
      && !(capture.updateTimeMs !== null && capture.updateTimeMs > windowEndMs);
    if (providerRefunded) {
      const parentId = parentProviderOrderId(payment, capture.relatedOrderId);
      judgeRefundedPayment({
        payment,
        guildId,
        providerId,
        providerStatusFullyRefunded: capture.status === 'REFUNDED',
        providerAmountCents: capture.amountCents,
        providerCurrency: capture.currency,
        providerRefunds: parentId !== null
          ? orderRefundLists.get(parentId) ?? null
          : null,
      });
    }
    if (
      ['refunded', 'reversed'].includes(payment.status)
      && capture.status === 'COMPLETED'
      // A refund issued moments ago has not flipped the capture yet — the
      // update-time lag owns that case.
      && !(capture.updateTimeMs !== null && capture.updateTimeMs > windowEndMs)
    ) {
      // Settled statuses are not interchangeable: the ledger revoked access
      // over a refund the provider has NO trace of — the capture still
      // holds the customer's money as an ordinary completed charge.
      unsettledLocalPayments.push({
        transactionId: providerId,
        guildId,
        orderId: payment.order_id,
        paymentStatus: payment.status,
        orderStatus: order?.status ?? null,
      });
      continue;
    }
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
    if (!settledAtProvider && (isSettledPair(payment, order) || orderClaimsSettlement)) {
      // The ledger (and entitlements) claim settled money the provider says
      // is PENDING/DECLINED/etc. The window already starts a settlement lag
      // behind now, so this is a material disagreement, not ordinary lag.
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
  }

  // 1b) Subscription sale rows — the captures API 404s v1 sale ids by
  //     design, but /v1/payments/sale serves them: verify settlement AND
  //     refund state instead of skipping blind (a lost PAYMENT.SALE.REFUNDED
  //     left the refunded subscriber's access live).
  const saleMap = await mapChunkedWithHeartbeat(
    windowSaleRows,
    heartbeat,
    async (payment) => ({
      payment,
      lookup: await fetchProviderSale(
        config.apiBase,
        token.token,
        payment.paypal_payment_id as string,
      ),
    }),
  );
  if (!saleMap.ok) return saleMap.failure;
  for (const { lookup } of saleMap.results) {
    if (!lookup.ok) {
      return { status: 'failed', reason: lookup.reason, retriable: lookup.retriable };
    }
  }
  const refundedSaleRows = saleMap.results.filter(({ lookup }) =>
    lookup.ok && lookup.found
    && ['refunded', 'partially_refunded', 'reversed'].includes(lookup.value.state),
  );
  {
    const totalsFailure = await loadLocalRefundTotals(
      refundedSaleRows.map(({ payment }) => payment),
    );
    if (totalsFailure) return totalsFailure;
  }
  for (const { payment, lookup } of saleMap.results) {
    if (!lookup.ok) continue;
    const order = ordersById.get(payment.order_id as string);
    const guildId = payment.guild_id as string;
    const providerId = payment.paypal_payment_id as string;
    // Same claim discipline as captures: an order that says settled demands
    // provider sale evidence even when its only row is pending/failed.
    const saleOrderClaimsSettlement = Boolean(
      order && SETTLED_ORDER_STATUSES.includes(order.status),
    );
    if (!lookup.found) {
      if (isSettledPair(payment, order) || saleOrderClaimsSettlement) {
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
    const sale = lookup.value;
    // Cross-tenant identity: the sale's billing agreement must be the local
    // order's subscription. A valid sale id borrowed from another
    // subscription/guild with matching amounts must never verify.
    if (order && isProviderId(order.paypal_subscription_id)) {
      // Ingestion never records a subscription sale without a canonical
      // billing agreement (provider_identity_malformed): a fetched sale
      // MISSING its agreement id is not a valid subscription-sale shape,
      // and a mismatched one is a borrowed identity. Either way the row
      // must not verify.
      if (
        sale.billingAgreementId === null
        || sale.billingAgreementId !== order.paypal_subscription_id
      ) {
        return { status: 'failed', reason: 'provider identity conflict', retriable: false };
      }
    }
    if (
      ['refunded', 'partially_refunded', 'reversed'].includes(sale.state)
      // A sale whose state changed inside the settlement lag has its refund
      // webhook legitimately in flight — the next pass owns it.
      && !(sale.updateTimeMs !== null && sale.updateTimeMs > windowEndMs)
    ) {
      // The v1 sale exposes no refund-sibling list; the sale state bounds
      // the aggregate (documented boundary). REVERSED is a full-reversal
      // terminal state and is judged like a full refund.
      judgeRefundedPayment({
        payment,
        guildId,
        providerId,
        providerStatusFullyRefunded: sale.state === 'refunded' || sale.state === 'reversed',
        providerAmountCents: sale.amountCents,
        providerCurrency: sale.currency,
        providerRefunds: null,
      });
    }
    if (
      ['refunded', 'reversed'].includes(payment.status)
      && sale.state === 'completed'
      && !(sale.updateTimeMs !== null && sale.updateTimeMs > windowEndMs)
    ) {
      // Same family rule as captures: a locally terminal row behind an
      // ordinary completed sale means the provider never saw the refund.
      unsettledLocalPayments.push({
        transactionId: providerId,
        guildId,
        orderId: payment.order_id,
        paymentStatus: payment.status,
        orderStatus: order?.status ?? null,
      });
      continue;
    }
    // The same settled-pair and money checks captures get: an older daily
    // charge with drifted amounts (or a non-settled provider state) must
    // not hide behind a correct newest charge.
    const saleSettledAtProvider = ['completed', 'refunded', 'partially_refunded', 'reversed']
      .includes(sale.state);
    if (saleSettledAtProvider && !isSettledPair(payment, order)) {
      unsettledLocalPayments.push({
        transactionId: providerId,
        guildId,
        orderId: payment.order_id,
        paymentStatus: payment.status,
        orderStatus: order?.status ?? null,
      });
      continue;
    }
    if (!saleSettledAtProvider && (isSettledPair(payment, order) || saleOrderClaimsSettlement)) {
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
      continue;
    }
    if (
      saleSettledAtProvider
      && (
        sale.amountCents !== payment.amount_cents
        || sale.currency !== normalizeCurrency(payment.currency)
      )
    ) {
      amountMismatches.push({
        transactionId: providerId,
        guildId,
        providerAmountCents: sale.amountCents,
        localAmountCents: payment.amount_cents,
        providerCurrency: sale.currency,
        localCurrency: normalizeCurrency(payment.currency),
      });
    }
  }

  // 1c) Refund lookback — PAGED sweep of settled rows older than the window
  //     (up to refundLookbackMs). Each page is verified and judged before the
  //     next loads: no global accumulation, no window-cap failure, and lease
  //     heartbeats inside every provider chunk.
  const lookbackStartMs = windowStartMs - Math.max(0, refundLookbackMs);
  if (lookbackStartMs < windowStartMs) {
    const lookbackStartIso = new Date(lookbackStartMs).toISOString();
    const lookbackEndIso = new Date(windowStartMs - 1).toISOString();
    for (let from = 0; ; from += LOCAL_PAGE_SIZE) {
      const { data, error } = await supabase
        .from('payments')
        .select('id, order_id, guild_id, paypal_payment_id, amount_cents, currency, status, provider, created_at')
        .eq('provider', 'paypal')
        .gte('created_at', lookbackStartIso)
        .lte('created_at', lookbackEndIso)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + LOCAL_PAGE_SIZE - 1);
      if (error) {
        return {
          status: 'failed',
          reason: `refund lookback scan failed: ${error.message}`,
          retriable: true,
        };
      }
      const pageRows = (data ?? []) as LocalPaymentRow[];
      if (pageRows.length === 0) break;
      const validatedPage = validateLocalPayments(pageRows, configuredGuildIds);
      if (!validatedPage.ok) {
        return {
          status: 'failed',
          reason: validatedPage.reason,
          retriable: validatedPage.retriable,
        };
      }
      const pagePayments = validatedPage.rows.filter(
        (payment) => !windowPaymentIds.has(payment.id) && payment.status === 'completed',
      );
      const pageParentScan = await lookupOrdersByExactColumn(
        supabase,
        'id',
        [...new Set(
          pagePayments
            .map((payment) => payment.order_id)
            .filter((id): id is string => typeof id === 'string' && !ordersById.has(id)),
        )],
        configuredGuildIds,
      );
      if (!pageParentScan.ok) {
        return {
          status: 'failed',
          reason: pageParentScan.reason,
          retriable: pageParentScan.retriable,
        };
      }
      for (const order of pageParentScan.rows) ordersById.set(order.id, order);
      // Same relation guard the window and refund-parent rows cross: a
      // historical payment claiming guild B while referencing guild A's
      // order must fail the pass, not sail into the provider comparisons.
      for (const payment of pagePayments) {
        const parentOrder = typeof payment.order_id === 'string'
          ? ordersById.get(payment.order_id)
          : undefined;
        if (!parentOrder) {
          return {
            status: 'failed',
            reason: 'local PayPal payment relation is missing',
            retriable: false,
          };
        }
        if (payment.guild_id !== parentOrder.guild_id) {
          return { status: 'failed', reason: 'provider identity conflict', retriable: false };
        }
      }
      const pageCaptureRows = pagePayments.filter((payment) => !isSubscriptionSaleRow(payment));
      const pageSaleRows = pagePayments.filter((payment) => isSubscriptionSaleRow(payment));

      const pageCaptureMap = await mapChunkedWithHeartbeat(
        pageCaptureRows,
        heartbeat,
        async (payment) => ({
          payment,
          kind: 'capture' as const,
          lookup: await fetchProviderCapture(
            config.apiBase,
            token.token,
            payment.paypal_payment_id as string,
          ),
        }),
      );
      if (!pageCaptureMap.ok) return pageCaptureMap.failure;
      const pageSaleMap = await mapChunkedWithHeartbeat(
        pageSaleRows,
        heartbeat,
        async (payment) => ({
          payment,
          kind: 'sale' as const,
          lookup: await fetchProviderSale(
            config.apiBase,
            token.token,
            payment.paypal_payment_id as string,
          ),
        }),
      );
      if (!pageSaleMap.ok) return pageSaleMap.failure;
      for (const { lookup } of [...pageCaptureMap.results, ...pageSaleMap.results]) {
        if (!lookup.ok) {
          return { status: 'failed', reason: lookup.reason, retriable: lookup.retriable };
        }
      }
      const pageRefunded: Array<{
        payment: LocalPaymentRow;
        fullyRefunded: boolean;
        providerAmountCents: number;
        providerCurrency: string;
        relatedOrderId: string | null;
      }> = [];
      for (const { payment, lookup } of pageCaptureMap.results) {
        if (!lookup.ok || !lookup.found) continue;
        const lookbackOrder = ordersById.get(payment.order_id as string);
        if (
          lookbackOrder
          && isProviderId(lookbackOrder.paypal_order_id)
          && (
            lookup.value.relatedOrderId === null
            || lookup.value.relatedOrderId !== lookbackOrder.paypal_order_id
          )
        ) {
          return { status: 'failed', reason: 'provider identity conflict', retriable: false };
        }
        if (
          ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(lookup.value.status)
          // Same lag discipline as the window path: a state change inside
          // the final interval defers to the next pass.
          && !(lookup.value.updateTimeMs !== null && lookup.value.updateTimeMs > windowEndMs)
        ) {
          pageRefunded.push({
            payment,
            fullyRefunded: lookup.value.status === 'REFUNDED',
            providerAmountCents: lookup.value.amountCents,
            providerCurrency: lookup.value.currency,
            relatedOrderId: lookup.value.relatedOrderId,
          });
        }
      }
      for (const { payment, lookup } of pageSaleMap.results) {
        if (!lookup.ok || !lookup.found) continue;
        const lookbackOrder = ordersById.get(payment.order_id as string);
        // Same strict rule as the window sale pass: an agreement-less sale
        // is not a valid subscription-sale shape, and a mismatched one is a
        // borrowed identity — the lookback is this row's ONLY verification.
        if (
          lookbackOrder
          && isProviderId(lookbackOrder.paypal_subscription_id)
          && (
            lookup.value.billingAgreementId === null
            || lookup.value.billingAgreementId !== lookbackOrder.paypal_subscription_id
          )
        ) {
          return { status: 'failed', reason: 'provider identity conflict', retriable: false };
        }
        if (
          ['refunded', 'partially_refunded', 'reversed'].includes(lookup.value.state)
          && !(lookup.value.updateTimeMs !== null && lookup.value.updateTimeMs > windowEndMs)
        ) {
          pageRefunded.push({
            payment,
            fullyRefunded: lookup.value.state === 'refunded' || lookup.value.state === 'reversed',
            providerAmountCents: lookup.value.amountCents,
            providerCurrency: lookup.value.currency,
            relatedOrderId: null,
          });
        }
      }
      if (pageRefunded.length > 0) {
        const totalsFailure = await loadLocalRefundTotals(
          pageRefunded.map(({ payment }) => payment),
        );
        if (totalsFailure) return totalsFailure;
        const enumFailure = await loadOrderRefundTotals(
          pageRefunded
            .map(({ payment, relatedOrderId }) => parentProviderOrderId(payment, relatedOrderId))
            .filter((id): id is string => id !== null),
        );
        if (enumFailure) return enumFailure;
        for (const target of pageRefunded) {
          const guildId = target.payment.guild_id as string;
          const providerId = target.payment.paypal_payment_id as string;
          bumpVerified(guildId);
          // Refund-ledger truth does not excuse PAYMENT-money drift: this
          // is the historical row's only provider touch, so its own amount
          // gets the same comparison the window passes perform.
          if (
            target.providerAmountCents !== target.payment.amount_cents
            || target.providerCurrency !== normalizeCurrency(target.payment.currency)
          ) {
            amountMismatches.push({
              transactionId: providerId,
              guildId,
              providerAmountCents: target.providerAmountCents,
              localAmountCents: target.payment.amount_cents,
              providerCurrency: target.providerCurrency,
              localCurrency: normalizeCurrency(target.payment.currency),
            });
          }
          const parentId = parentProviderOrderId(target.payment, target.relatedOrderId);
          judgeRefundedPayment({
            payment: target.payment,
            guildId,
            providerId,
            providerStatusFullyRefunded: target.fullyRefunded,
            providerAmountCents: target.providerAmountCents,
            providerCurrency: target.providerCurrency,
            providerRefunds: parentId !== null
              ? orderRefundLists.get(parentId) ?? null
              : null,
          });
        }
      }
      if (pageRows.length < LOCAL_PAGE_SIZE) break;
    }
  }

  // 2) Refunds — every window refund by its provider identity.
  const refundPaymentRowsById = new Map(
    validatedRefundPayments.rows.map((payment) => [payment.id, payment]),
  );
  // Refunds of v2 captures live at /v2/payments/refunds; refunds of v1
  // subscription SALES live at /v1/payments/refund. Dispatch by the refund's
  // event family (falling back to the parent payment's order) or a
  // legitimate sale refund 404s on the v2 endpoint and reads as missing at
  // PayPal on every pass.
  const isSaleRefundRow = (refund: LocalRefundRow): boolean => {
    if (typeof refund.event_type === 'string' && refund.event_type.startsWith('PAYMENT.SALE.')) {
      return true;
    }
    const parentRow = typeof refund.payment_id === 'string'
      ? refundPaymentRowsById.get(refund.payment_id)
      : undefined;
    const parentOrder = parentRow
      ? ordersById.get(parentRow.order_id as string)
      : undefined;
    return Boolean(parentOrder && isProviderId(parentOrder.paypal_subscription_id));
  };
  const refundMap = await mapChunkedWithHeartbeat(
    windowRefunds,
    heartbeat,
    async (refund) => {
      // Family AGREEMENT, not preference: ingestion and the ledger rules
      // distinguish capture and sale refund families, so a SALE.* row on a
      // capture-backed order (or a CAPTURE.* row on a subscription sale) is
      // mislabeled identity — normalizing it onto the other endpoint let it
      // verify on matching parent id and money.
      {
        const familyParentRow = typeof refund.payment_id === 'string'
          ? refundPaymentRowsById.get(refund.payment_id)
          : undefined;
        const familyParentOrder = familyParentRow
          ? ordersById.get(familyParentRow.order_id as string)
          : undefined;
        const eventFamily = typeof refund.event_type === 'string'
          && refund.event_type.startsWith('PAYMENT.SALE.')
          ? 'sale'
          : typeof refund.event_type === 'string'
            && refund.event_type.startsWith('PAYMENT.CAPTURE.')
            ? 'capture'
            : null;
        if (
          eventFamily !== null
          && familyParentOrder !== undefined
          && (eventFamily === 'sale')
            !== isProviderId(familyParentOrder.paypal_subscription_id)
        ) {
          return {
            refund,
            lookup: {
              ok: false as const,
              retriable: false,
              reason: 'provider refund identity conflict',
            },
          };
        }
      }
      if (isSaleRefundRow(refund)) {
        const parentRow = typeof refund.payment_id === 'string'
          ? refundPaymentRowsById.get(refund.payment_id)
          : undefined;
        if (
          parentRow
          && refund.paypal_refund_id === parentRow.paypal_payment_id
          // Ingestion permits the sale-id-as-refund-id substitution ONLY
          // for the documented PAYMENT.SALE.REVERSED shape; any other row
          // carrying the sale id is malformed identity and must face the
          // real refund endpoint instead of a synthesized verdict.
          && refund.event_type === 'PAYMENT.SALE.REVERSED'
        ) {
          // Direct Sale reversal witness: the webhook stores the SALE id as
          // the refund id because PayPal minted no distinct refund object.
          // The refund endpoint can never serve it — the sale's own terminal
          // state IS the evidence.
          const saleLookup = await fetchProviderSale(
            config.apiBase,
            token.token,
            refund.paypal_refund_id,
          );
          if (!saleLookup.ok || !saleLookup.found) {
            return { refund, lookup: saleLookup as ProviderFetch<ProviderRefundObject> };
          }
          // Only a FULLY terminal reversal state is completed evidence: a
          // partially_refunded sale behind a full-reversal witness means
          // the provider disagrees with the terminal local claim.
          const reversed = ['reversed', 'refunded'].includes(saleLookup.value.state);
          // The witness row's amount is the remaining balance by design, so
          // the per-row comparison echoes it — the REAL money check is the
          // full-ledger aggregate. Window parents get it from the sale
          // pass; OLDER parents (reversed status, excluded from the
          // completed-only lookback) get it here.
          if (
            reversed
            && String(parentRow.created_at ?? '') < windowStart
          ) {
            // Reversed parents are excluded from the completed-only
            // lookback, so this witness is their only provider touch: the
            // billing-agreement identity and the parent row's own money
            // get the same checks the window sale pass performs.
            const witnessParentOrder = ordersById.get(parentRow.order_id as string);
            if (
              witnessParentOrder
              && isProviderId(witnessParentOrder.paypal_subscription_id)
              && (
                saleLookup.value.billingAgreementId === null
                || saleLookup.value.billingAgreementId
                  !== witnessParentOrder.paypal_subscription_id
              )
            ) {
              return {
                refund,
                lookup: {
                  ok: false as const,
                  retriable: false,
                  reason: 'provider identity conflict',
                },
              };
            }
            if (
              saleLookup.value.amountCents !== parentRow.amount_cents
              || saleLookup.value.currency !== normalizeCurrency(parentRow.currency)
            ) {
              amountMismatches.push({
                transactionId: parentRow.paypal_payment_id as string,
                guildId: parentRow.guild_id as string,
                providerAmountCents: saleLookup.value.amountCents,
                localAmountCents: parentRow.amount_cents,
                providerCurrency: saleLookup.value.currency,
                localCurrency: normalizeCurrency(parentRow.currency),
              });
            }
            const totalsFailure = await loadLocalRefundTotals([parentRow]);
            if (totalsFailure) {
              return {
                refund,
                lookup: {
                  ok: false as const,
                  retriable: totalsFailure.retriable,
                  reason: totalsFailure.reason,
                },
              };
            }
            judgeRefundedPayment({
              payment: parentRow,
              guildId: parentRow.guild_id as string,
              providerId: parentRow.paypal_payment_id as string,
              providerStatusFullyRefunded: true,
              providerAmountCents: saleLookup.value.amountCents,
              providerCurrency: saleLookup.value.currency,
              providerRefunds: null,
            });
          }
          return {
            refund,
            lookup: {
              ok: true as const,
              found: true as const,
              value: {
                status: reversed ? 'COMPLETED' : saleLookup.value.state.toUpperCase(),
                amountCents: refund.amount_cents as number,
                currency: normalizeCurrency(refund.currency) as string,
                parentCaptureId: parentRow.paypal_payment_id,
              },
            },
          };
        }
        const saleLookup = await fetchProviderSaleRefund(
          config.apiBase,
          token.token,
          refund.paypal_refund_id,
        );
        if (!saleLookup.ok || !saleLookup.found) {
          return { refund, lookup: saleLookup as ProviderFetch<ProviderRefundObject> };
        }
        // Normalize the v1 shape onto the v2 verdict surface: state maps to
        // status, sale_id is the parent identity.
        return {
          refund,
          lookup: {
            ok: true as const,
            found: true as const,
            value: {
              status: saleLookup.value.state === 'completed'
                ? 'COMPLETED'
                : saleLookup.value.state.toUpperCase(),
              amountCents: saleLookup.value.amountCents,
              currency: saleLookup.value.currency,
              parentCaptureId: saleLookup.value.saleId,
            },
          },
        };
      }
      return {
        refund,
        lookup: await fetchProviderRefund(config.apiBase, token.token, refund.paypal_refund_id),
      };
    },
  );
  if (!refundMap.ok) return refundMap.failure;
  for (const { refund, lookup } of refundMap.results) {
    if (!lookup.ok) {
      return { status: 'failed', reason: lookup.reason, retriable: lookup.retriable };
    }
    const guildId = refund.guild_id as string;
    if (!lookup.found) {
      // A zero-amount row is a terminal reversal witness with no distinct
      // provider refund object; its absence is expected — EXCEPT when the
      // row IS a direct-sale witness (refund id equals the sale id): then
      // the sale itself was the object we failed to find, and silence would
      // bless a vanished sale behind a full reversal claim.
      const witnessParent = typeof refund.payment_id === 'string'
        ? refundPaymentRowsById.get(refund.payment_id)
        : undefined;
      const isDirectSaleWitness = Boolean(
        witnessParent && refund.paypal_refund_id === witnessParent.paypal_payment_id,
      );
      if (refund.amount_cents === 0 && !isDirectSaleWitness) {
        // The witness's own refund object is EXPECTED to be absent — but
        // only when the PARENT shows the fully terminal state the witness
        // claims. An unreversed parent behind a 404 witness is missing
        // provider evidence, not an expected gap; a parent whose state
        // changed inside the settlement lag defers to the next pass.
        if (witnessParent && isProviderId(witnessParent.paypal_payment_id)) {
          if (isSaleRefundRow(refund)) {
            const parentLookup = await fetchProviderSale(
              config.apiBase,
              token.token,
              witnessParent.paypal_payment_id,
            );
            if (!parentLookup.ok) {
              return {
                status: 'failed',
                reason: parentLookup.reason,
                retriable: parentLookup.retriable,
              };
            }
            if (parentLookup.found) {
              if (
                parentLookup.value.updateTimeMs !== null
                && parentLookup.value.updateTimeMs > windowEndMs
              ) {
                continue;
              }
              if (['reversed', 'refunded'].includes(parentLookup.value.state)) {
                const parentSale = parentLookup.value;
                // Same rule as the capture-witness path: acceptance must
                // not skip the checks an OLD parent never met elsewhere —
                // agreement identity, the parent row's own money, and the
                // full refund ledger (v1 exposes no sibling list, so the
                // status-bound aggregate judges it).
                if (String(witnessParent.created_at ?? '') < windowStart) {
                  const parentOrder = ordersById.get(witnessParent.order_id as string);
                  if (
                    parentOrder
                    && isProviderId(parentOrder.paypal_subscription_id)
                    && (
                      parentSale.billingAgreementId === null
                      || parentSale.billingAgreementId !== parentOrder.paypal_subscription_id
                    )
                  ) {
                    return {
                      status: 'failed',
                      reason: 'provider identity conflict',
                      retriable: false,
                    };
                  }
                  if (
                    parentSale.amountCents !== witnessParent.amount_cents
                    || parentSale.currency !== normalizeCurrency(witnessParent.currency)
                  ) {
                    amountMismatches.push({
                      transactionId: witnessParent.paypal_payment_id as string,
                      guildId,
                      providerAmountCents: parentSale.amountCents,
                      localAmountCents: witnessParent.amount_cents,
                      providerCurrency: parentSale.currency,
                      localCurrency: normalizeCurrency(witnessParent.currency),
                    });
                  }
                  const totalsFailure = await loadLocalRefundTotals([witnessParent]);
                  if (totalsFailure) return totalsFailure;
                  judgeRefundedPayment({
                    payment: witnessParent,
                    guildId,
                    providerId: witnessParent.paypal_payment_id as string,
                    providerStatusFullyRefunded: true,
                    providerAmountCents: parentSale.amountCents,
                    providerCurrency: parentSale.currency,
                    providerRefunds: null,
                  });
                }
                continue;
              }
            }
          } else {
            const parentLookup = await fetchProviderCapture(
              config.apiBase,
              token.token,
              witnessParent.paypal_payment_id,
            );
            if (!parentLookup.ok) {
              return {
                status: 'failed',
                reason: parentLookup.reason,
                retriable: parentLookup.retriable,
              };
            }
            if (parentLookup.found) {
              if (
                parentLookup.value.updateTimeMs !== null
                && parentLookup.value.updateTimeMs > windowEndMs
              ) {
                continue;
              }
              // Only a FULLY refunded capture evidences a zero-remaining
              // reversal witness; PARTIALLY_REFUNDED means PayPal still
              // holds money the terminal local claim says is gone.
              if (parentLookup.value.status === 'REFUNDED') {
                const parentCapture = parentLookup.value;
                // Accepting the witness must not skip the checks the parent
                // never met elsewhere: an older reversed parent is outside
                // both the window pass and the completed-only lookback, so
                // this is its ONLY provider touch — identity, money, and
                // the refund ledger all still apply. Window parents were
                // already judged by the capture pass.
                if (String(witnessParent.created_at ?? '') < windowStart) {
                  const parentOrder = ordersById.get(witnessParent.order_id as string);
                  if (
                    parentOrder
                    && isProviderId(parentOrder.paypal_order_id)
                    && (
                      parentCapture.relatedOrderId === null
                      || parentCapture.relatedOrderId !== parentOrder.paypal_order_id
                    )
                  ) {
                    return {
                      status: 'failed',
                      reason: 'provider identity conflict',
                      retriable: false,
                    };
                  }
                  if (
                    parentCapture.amountCents !== witnessParent.amount_cents
                    || parentCapture.currency !== normalizeCurrency(witnessParent.currency)
                  ) {
                    amountMismatches.push({
                      transactionId: witnessParent.paypal_payment_id as string,
                      guildId,
                      providerAmountCents: parentCapture.amountCents,
                      localAmountCents: witnessParent.amount_cents,
                      providerCurrency: parentCapture.currency,
                      localCurrency: normalizeCurrency(witnessParent.currency),
                    });
                  }
                  const totalsFailure = await loadLocalRefundTotals([witnessParent]);
                  if (totalsFailure) return totalsFailure;
                  const parentProviderOrder = parentProviderOrderId(
                    witnessParent,
                    parentCapture.relatedOrderId,
                  );
                  if (parentProviderOrder !== null) {
                    const enumFailure = await loadOrderRefundTotals([parentProviderOrder]);
                    if (enumFailure) return enumFailure;
                  }
                  judgeRefundedPayment({
                    payment: witnessParent,
                    guildId,
                    providerId: witnessParent.paypal_payment_id as string,
                    providerStatusFullyRefunded: true,
                    providerAmountCents: parentCapture.amountCents,
                    providerCurrency: parentCapture.currency,
                    providerRefunds: parentProviderOrder !== null
                      ? orderRefundLists.get(parentProviderOrder) ?? null
                      : null,
                  });
                }
                continue;
              }
            }
          }
        }
      }
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
    // Parent identity: the provider refund's up-link capture must be the
    // capture our ledger says this refund belongs to. A refund id borrowed
    // from another capture with matching amounts previously verified.
    const parentRow = typeof refund.payment_id === 'string'
      ? refundPaymentRowsById.get(refund.payment_id)
      : undefined;
    if (
      parentRow
      && isProviderId(parentRow.paypal_payment_id)
      && (
        lookup.value.parentCaptureId === null
        || lookup.value.parentCaptureId !== parentRow.paypal_payment_id
      )
    ) {
      // Ingestion refuses refund events without one unambiguous canonical
      // parent; a fetched refund OMITTING its up-link (or naming another
      // parent) is a standalone/foreign object and must not verify.
      return { status: 'failed', reason: 'provider refund identity conflict', retriable: false };
    }
    if (lookup.value.status !== 'COMPLETED') {
      // The local row already drove the order and access into a refunded
      // state, but the provider says the money did NOT complete its return
      // (PENDING/FAILED/CANCELLED). That is missing provider evidence for a
      // terminal local refund, not a clean pass.
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
  const orderMap = await mapChunkedWithHeartbeat(
    orderGetTargets,
    heartbeat,
    async (order) => ({
      order,
      lookup: await fetchProviderOrder(
        config.apiBase,
        token.token,
        order.paypal_order_id as string,
      ),
    }),
  );
  if (!orderMap.ok) return orderMap.failure;
  for (const { order, lookup } of orderMap.results) {
    if (!lookup.ok) {
      return { status: 'failed', reason: lookup.reason, retriable: lookup.retriable };
    }
    const guildId = order.guild_id as string;
    const pendingish = order.status === 'pending' || order.status === 'pending_review';
    if (!lookup.found) {
      // PayPal purges unapproved orders; a vanished PENDING or CANCELLED
      // order moved no money. A vanished order behind SETTLED local
      // commerce with no payment identity means the settlement cannot be
      // evidenced at the provider.
      if (SETTLED_ORDER_STATUSES.includes(order.status)) {
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
      // count. Only captures with NO local row are this path's finding —
      // and "known" must mean known ON THIS ORDER: historical refund
      // parents enter the map without ever crossing the capture pass, so a
      // capture id attached to another order/guild is an identity conflict,
      // not a reason to skip.
      const knownRow = localByProviderId.get(capture.id);
      if (knownRow) {
        if (knownRow.order_id !== order.id) {
          return { status: 'failed', reason: 'provider identity conflict', retriable: false };
        }
        continue;
      }
      // A capture created inside the settlement lag has its payment webhook
      // legitimately in flight — the next pass owns it.
      if (capture.createTimeMs !== null && capture.createTimeMs > windowEndMs) continue;
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
      pendingish
      && ['APPROVED', 'COMPLETED'].includes(providerOrder.status)
      && settledCaptures.length === 0
      // A transition inside the settlement lag has its webhook legitimately
      // in flight.
      && !(providerOrder.updateTimeMs !== null && providerOrder.updateTimeMs > windowEndMs)
    ) {
      // APPROVED: the buyer approved the checkout and the
      // CHECKOUT.ORDER.APPROVED webhook -- the only path that captures an
      // intent-CAPTURE order -- was lost: neither charged nor fulfilled.
      // COMPLETED: PayPal claims completion while every capture row is
      // still PENDING/DENIED -- no money settled and nothing local advanced,
      // so completion alone must not read as clean. Surface for replay.
      unsettledLocalPayments.push({
        transactionId: order.paypal_order_id as string,
        guildId,
        orderId: order.id,
        paymentStatus: providerOrder.status === 'APPROVED'
          ? 'order_approved_uncaptured'
          : 'order_completed_uncaptured',
        orderStatus: order.status,
      });
    }
    if (SETTLED_ORDER_STATUSES.includes(order.status) && settledCaptures.length === 0) {
      // Locally settled with NO settled provider capture — regardless of the
      // provider order's own status: a CREATED/APPROVED/VOIDED order with no
      // completed capture is PayPal explicitly saying no money settled.
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
  // Lifecycle divergence compares the provider status with the DURABLE
  // lifecycle head — purchase orders stay 'completed' forever by design, so
  // judging by order status would re-alert after every properly processed
  // cancellation.
  const TERMINAL_PRIORITY_BY_STATUS: Record<string, number> = {
    SUSPENDED: 50,
    CANCELLED: 60,
    EXPIRED: 60,
  };
  const lifecycleHeads = new Map<string, {
    priority: number;
    eventType: string | null;
    lastWebhookEventId: string | null;
  }>();
  const loadLifecycleHeads = async (subscriptionIds: string[]) => {
    const missing = [...new Set(subscriptionIds)].filter(
      (id) => !lifecycleHeads.has(id),
    );
    for (let from = 0; from < missing.length; from += EXACT_LOOKUP_CHUNK_SIZE) {
      const chunk = missing.slice(from, from + EXACT_LOOKUP_CHUNK_SIZE);
      const { data, error } = await supabase
        .from('commerce_subscription_lifecycle_heads')
        .select('paypal_subscription_id, last_event_priority, last_provider_event_type, last_webhook_event_id')
        .in('paypal_subscription_id', chunk);
      if (error) {
        return {
          status: 'failed' as const,
          reason: `subscription lifecycle head scan failed: ${error.message}`,
          retriable: true,
        };
      }
      for (const id of chunk) {
        if (!lifecycleHeads.has(id)) {
          lifecycleHeads.set(id, { priority: 0, eventType: null, lastWebhookEventId: null });
        }
      }
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        if (
          typeof row.paypal_subscription_id === 'string'
          && typeof row.last_event_priority === 'number'
        ) {
          lifecycleHeads.set(row.paypal_subscription_id, {
            priority: row.last_event_priority,
            eventType: typeof row.last_provider_event_type === 'string'
              ? row.last_provider_event_type
              : null,
            lastWebhookEventId: typeof row.last_webhook_event_id === 'string'
              ? row.last_webhook_event_id
              : null,
          });
        }
      }
    }
    return null;
  };

  const processedSubscriptionIds = new Set<string>();
  const latestChargeUnaccounted = new Map<string, {
    order: LocalOrderRow;
    subscription: ProviderSubscriptionObject;
  }>();
  const judgeSubscriptionEntries = async (
    entries: Array<[string, LocalOrderRow]>,
  ): Promise<PayPalReconciliationFailure | null> => {
    const fresh = entries.filter(([id]) => !processedSubscriptionIds.has(id));
    if (fresh.length === 0) return null;
    for (const [id] of fresh) processedSubscriptionIds.add(id);
    const map = await mapChunkedWithHeartbeat(
      fresh,
      heartbeat,
      async ([subscriptionId, order]) => ({
        subscriptionId,
        order,
        lookup: await fetchProviderSubscription(config.apiBase, token.token, subscriptionId),
      }),
    );
    if (!map.ok) return map.failure;
    const headsFailure = await loadLifecycleHeads(fresh.map(([id]) => id));
    if (headsFailure) return headsFailure;
    // Checkout identity backs the custom_id tamper check on fetched
    // subscriptions; the plan map backs the plan identity check.
    const batchCustomerScan = await loadCustomerIdentities(
      supabase,
      [...new Set(
        fresh
          .map(([, order]) => order.customer_id)
          .filter((id): id is string => typeof id === 'string'),
      )],
      configuredGuildIds,
    );
    if (!batchCustomerScan.ok) {
      return {
        status: 'failed',
        reason: batchCustomerScan.reason,
        retriable: batchCustomerScan.retriable,
      };
    }
    const batchCustomersById = new Map(
      batchCustomerScan.rows.map((customer) => [customer.id, customer]),
    );
    // The head only proves the transition was OBSERVED; the fulfillment
    // ACTION that actually revokes/suspends access is a separate write that
    // can fail or stay held — and it must be the action for the CURRENT
    // transition, keyed by the head's webhook event id, or an old completed
    // suspension masks a lost second one after a reactivation. Staged-row
    // detection is likewise scoped to the ACTIVATION carrier so a held
    // cancellation row cannot fake an unreleased activation.
    const FULFILLMENT_TYPE_BY_HEAD_EVENT: Record<string, string> = {
      'BILLING.SUBSCRIPTION.CANCELLED': 'subscription_cancelled',
      'BILLING.SUBSCRIPTION.SUSPENDED': 'subscription_suspended',
      'BILLING.SUBSCRIPTION.PAYMENT.FAILED': 'subscription_payment_failed',
      // Expiry fulfills through the cancellation carrier.
      'BILLING.SUBSCRIPTION.EXPIRED': 'subscription_cancelled',
    };
    const expectedActionKeyBySubscription = new Map<string, string>();
    for (const [subscriptionId] of fresh) {
      const head = lifecycleHeads.get(subscriptionId);
      const fulfillmentType = head?.eventType
        ? FULFILLMENT_TYPE_BY_HEAD_EVENT[head.eventType]
        : undefined;
      if (head?.lastWebhookEventId && fulfillmentType) {
        expectedActionKeyBySubscription.set(
          subscriptionId,
          `paypal:lifecycle:${head.lastWebhookEventId}:${fulfillmentType}`,
        );
      }
    }
    const healthyActionKeys = new Set<string>();
    const expectedKeys = [...new Set(expectedActionKeyBySubscription.values())];
    for (let from = 0; from < expectedKeys.length; from += EXACT_LOOKUP_CHUNK_SIZE) {
      const chunk = expectedKeys.slice(from, from + EXACT_LOOKUP_CHUNK_SIZE);
      const { data: actionRows, error: actionError } = await supabase
        .from('bot_action_queue')
        .select('idempotency_key, status, created_at')
        .in('idempotency_key', chunk);
      if (actionError) {
        return {
          status: 'failed',
          reason: `lifecycle action scan failed: ${actionError.message}`,
          retriable: true,
        };
      }
      for (const row of (actionRows ?? []) as Array<Record<string, unknown>>) {
        if (typeof row.idempotency_key !== 'string') continue;
        // completed is proof. pending/processing only mean "still working"
        // while the carrier is younger than the settlement lag: this pass
        // is the watchdog for a BROKEN bot, and a queue row aging past the
        // lag with access unrevoked is exactly the failure it must surface.
        const createdAtMs = typeof row.created_at === 'string'
          ? Date.parse(row.created_at)
          : Number.NaN;
        const inProgressFresh = ['pending', 'processing'].includes(String(row.status))
          && Number.isFinite(createdAtMs)
          && createdAtMs > windowEndMs;
        if (String(row.status) === 'completed' || inProgressFresh) {
          healthyActionKeys.add(row.idempotency_key);
        }
      }
    }
    const batchOrderIds = [...new Set(fresh.map(([, order]) => order.id))];

    // Plan identity compares against the HISTORICAL provider plan retained
    // by the ACTIVATION carrier's payload — addressed by its exact
    // idempotency key (paypal:subscription:<id>:fulfill_subscription), so
    // per-renewal actions can never flood the lookup past the response cap
    // and silently skip the comparison. The mutable plans row is never
    // consulted: owners rotate paypal_plan_id for future checkouts while
    // old subscriptions keep billing the plan they were minted on.
    const historicalPlanBySubscription = new Map<string, string>();
    // The activation carrier's STATUS decides fulfillment truth: staged
    // means never released, failed means released and lost — either way an
    // ACTIVE subscription's buyer received nothing.
    const activationCarrierStatusBySubscription = new Map<string, string>();
    const activationCarrierCreatedAtMsBySubscription = new Map<string, number>();
    const activationKeys = fresh.map(([subscriptionId]) =>
      `paypal:subscription:${subscriptionId}:fulfill_subscription`,
    );
    for (let from = 0; from < activationKeys.length; from += EXACT_LOOKUP_CHUNK_SIZE) {
      const chunk = activationKeys.slice(from, from + EXACT_LOOKUP_CHUNK_SIZE);
      const { data, error } = await supabase
        .from('bot_action_queue')
        .select('idempotency_key, payload, status, created_at')
        .in('idempotency_key', chunk);
      if (error) {
        return {
          status: 'failed',
          reason: `plan identity scan failed: ${error.message}`,
          retriable: true,
        };
      }
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const key = row.idempotency_key;
        if (typeof key !== 'string') continue;
        const subscriptionId = key.slice(
          'paypal:subscription:'.length,
          -':fulfill_subscription'.length,
        );
        const providerPlan = (row.payload as Record<string, unknown> | null)?.paypal_plan_id;
        if (isProviderId(providerPlan)) {
          historicalPlanBySubscription.set(subscriptionId, providerPlan);
        }
        if (typeof row.status === 'string') {
          activationCarrierStatusBySubscription.set(subscriptionId, row.status);
        }
        const carrierCreatedAtMs = typeof row.created_at === 'string'
          ? Date.parse(row.created_at)
          : Number.NaN;
        if (Number.isFinite(carrierCreatedAtMs)) {
          activationCarrierCreatedAtMsBySubscription.set(subscriptionId, carrierCreatedAtMs);
        }
      }
    }
    for (const { subscriptionId, order, lookup } of map.results) {
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
      // Checkout identity: the subscription's custom_id was minted by OUR
      // checkout with the guild/product/customer identity — a valid
      // subscription id from another checkout or tenant must never verify.
      const subscriptionIdentity = parseCustomIdentity(subscription.customId);
      if (
        subscriptionIdentity
        && !customIdentityMatchesOrder(
          subscriptionIdentity,
          order,
          true,
          typeof order.customer_id === 'string'
            ? batchCustomersById.get(order.customer_id)
            : undefined,
        )
      ) {
        return { status: 'failed', reason: 'provider identity conflict', retriable: false };
      }
      // Plan identity: the provider's plan must be the HISTORICAL plan this
      // subscription was minted on (absent history → no check, never the
      // mutable current plans row).
      const historicalPlanId = historicalPlanBySubscription.get(subscriptionId) ?? null;
      // When activation history NAMES a plan, the fetched subscription must
      // carry that plan: an omitted/malformed plan_id alongside an accepted
      // missing custom_id would leave a misattached subscription with zero
      // checkout identity checks.
      if (
        historicalPlanId !== null
        && (subscription.planId === null || subscription.planId !== historicalPlanId)
      ) {
        return { status: 'failed', reason: 'provider identity conflict', retriable: false };
      }
      const head = lifecycleHeads.get(subscriptionId) ?? { priority: 0, eventType: null };
      // Reactivation: PayPal says ACTIVE while the durable head's LATEST
      // observed event is a suspension/payment failure — the ACTIVATED (or
      // recovering SALE.COMPLETED) webhook that would have superseded it
      // was lost, and access remains wrongly revoked/suspended.
      if (
        subscription.status === 'ACTIVE'
        && head.eventType !== null
        && [
          'BILLING.SUBSCRIPTION.SUSPENDED',
          'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
          // A CANCELLED/EXPIRED head behind an ACTIVE provider means the
          // completed lifecycle action revoked access while PayPal still
          // bills the customer — a divergence needing replay either way.
          'BILLING.SUBSCRIPTION.CANCELLED',
          'BILLING.SUBSCRIPTION.EXPIRED',
        ].includes(head.eventType)
        // A reactivation inside the lag interval is in flight, not lost.
        && (subscription.statusUpdateTimeMs === null
          || subscription.statusUpdateTimeMs <= windowEndMs)
      ) {
        unsettledLocalPayments.push({
          transactionId: subscriptionId,
          guildId,
          orderId: order.id,
          paymentStatus: 'subscription_reactivated_unfulfilled',
          orderStatus: order.status,
        });
      }
      // A transition that happened inside the settlement lag has its
      // lifecycle webhook legitimately in flight — the next pass owns it.
      const transitionSettled = subscription.statusUpdateTimeMs === null
        || subscription.statusUpdateTimeMs <= windowEndMs;
      const expectedPriority = TERMINAL_PRIORITY_BY_STATUS[subscription.status];
      // Divergent when the transition was never OBSERVED (head below the
      // priority) OR observed but its fulfillment ACTION is missing, failed,
      // or operator-held — the head is committed BEFORE the action write,
      // so head-parity alone cannot prove access was revoked.
      const expectedActionKey = expectedActionKeyBySubscription.get(subscriptionId);
      // The head must match the provider's terminal FAMILY: a cancellation
      // head (priority 60) must not satisfy a provider SUSPENSION whose
      // distinct subscription_suspended fulfillment was never observed.
      const HEAD_EVENTS_BY_PROVIDER_STATUS: Record<string, string[]> = {
        SUSPENDED: ['BILLING.SUBSCRIPTION.SUSPENDED'],
        CANCELLED: ['BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED'],
        EXPIRED: ['BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.CANCELLED'],
      };
      const matchingHeadFamily = HEAD_EVENTS_BY_PROVIDER_STATUS[subscription.status];
      if (
        expectedPriority !== undefined
        && transitionSettled
        && (
          (lifecycleHeads.get(subscriptionId)?.priority ?? 0) < expectedPriority
          || (matchingHeadFamily !== undefined
            && !matchingHeadFamily.includes(head.eventType ?? ''))
          || expectedActionKey === undefined
          || !healthyActionKeys.has(expectedActionKey)
        )
      ) {
        // PayPal reports a terminal state the durable lifecycle head never
        // observed: the revoke/suspend fulfillment action was lost. A head
        // at or past this priority means the transition WAS processed and
        // must not re-alert forever.
        unsettledLocalPayments.push({
          transactionId: subscriptionId,
          guildId,
          orderId: order.id,
          paymentStatus: `subscription_${subscription.status.toLowerCase()}`,
          orderStatus: order.status,
        });
      }
      // The lag anchors on the provider's own transition time when it is
      // known (activation can happen long after order creation); the order
      // age remains the fallback guard.
      const activationSettled = subscription.statusUpdateTimeMs !== null
        ? subscription.statusUpdateTimeMs <= windowEndMs
        : String(order.created_at ?? '') <= windowEnd;
      if (
        ['APPROVAL_PENDING', 'APPROVED', 'CREATED'].includes(subscription.status)
        && SETTLED_ORDER_STATUSES.includes(order.status)
        && transitionSettled
      ) {
        // The local order (and entitlements) claim an activated
        // subscription PayPal says never activated — free trials have no
        // payment rows, so no billing check would ever catch this.
        unsettledLocalPayments.push({
          transactionId: subscriptionId,
          guildId,
          orderId: order.id,
          paymentStatus: 'subscription_never_activated',
          orderStatus: order.status,
        });
      }
      const activationCarrierStatus =
        activationCarrierStatusBySubscription.get(subscriptionId) ?? '';
      // In-progress only means "still working" while the carrier is younger
      // than the settlement lag — the same age gate the terminal lifecycle
      // carriers use. A released activation stuck pending/processing past
      // the lag left the buyer unfulfilled behind healthy-looking rows.
      const activationCarrierCreatedAtMs =
        activationCarrierCreatedAtMsBySubscription.get(subscriptionId) ?? null;
      const activationCarrierStalled =
        ['pending', 'processing'].includes(activationCarrierStatus)
        && !(activationCarrierCreatedAtMs !== null
          && activationCarrierCreatedAtMs > windowEndMs);
      if (
        subscription.status === 'ACTIVE'
        && order.status === 'completed'
        && (['staged', 'failed'].includes(activationCarrierStatus) || activationCarrierStalled)
        && activationSettled
      ) {
        // The activation handler completes the order BEFORE releasing the
        // staged fulfillment: a STAGED carrier means the release never ran,
        // and a FAILED carrier means the queue worker lost it after release
        // — either way the buyer received nothing while the order and
        // subscription both read healthy.
        unsettledLocalPayments.push({
          transactionId: subscriptionId,
          guildId,
          orderId: order.id,
          paymentStatus: 'subscription_activation_unreleased',
          orderStatus: order.status,
        });
      }
      if (
        subscription.status === 'ACTIVE'
        && order.status === 'refunded'
        && (subscription.statusUpdateTimeMs === null
          || subscription.statusUpdateTimeMs <= windowEndMs)
      ) {
        // The refund revoked local access, but refunding a sale does not
        // cancel the billing agreement: PayPal keeps charging a customer
        // who has nothing. Surface for cancellation replay.
        unsettledLocalPayments.push({
          transactionId: subscriptionId,
          guildId,
          orderId: order.id,
          paymentStatus: 'subscription_active_after_refund',
          orderStatus: order.status,
        });
      }
      if (
        subscription.status === 'ACTIVE'
        && (order.status === 'pending' || order.status === 'pending_review')
        && activationSettled
      ) {
        // Lost BILLING.SUBSCRIPTION.ACTIVATED: PayPal activated (free trials
        // may legitimately never show a payment) but activation fulfillment
        // never ran. The created_at guard keeps ordinary approval→webhook
        // latency inside the settlement lag from false-alerting.
        unsettledLocalPayments.push({
          transactionId: subscriptionId,
          guildId,
          orderId: order.id,
          paymentStatus: 'subscription_active_unfulfilled',
          orderStatus: order.status,
        });
      }
      const lastPaymentMs = subscription.lastPaymentTime === null
        ? Number.NaN
        : Date.parse(subscription.lastPaymentTime);
      const lastPaymentInWindow = Number.isFinite(lastPaymentMs)
        && lastPaymentMs >= windowStartMs
        && lastPaymentMs <= windowEndMs;
      const orderWindowPayments = windowPaymentsByOrderId.get(order.id) ?? [];
      // Only a COMPLETED local row can represent the provider's charge — a
      // pending/failed row matching on amount is exactly the divergence this
      // pass exists to catch (fulfillment may never have run). And the row
      // must CORRELATE with the latest charge in time: daily plans bill
      // several times per window, and an older renewal must not stand in for
      // the latest charge whose webhook was lost.
      const SETTLED_ROW_STATUSES = ['completed', 'refunded', 'reversed'];
      const settledWindowPayments = orderWindowPayments.filter((payment) => {
        // Refunded/reversed rows are terminal SETTLED states — the sale pass
        // already judged their reversal ledgers; only pending/failed rows
        // mean the charge never settled locally.
        if (!SETTLED_ROW_STATUSES.includes(payment.status)) return false;
        if (!lastPaymentInWindow) return true;
        const createdMs = Date.parse(String(payment.created_at ?? ''));
        return Number.isFinite(createdMs)
          && createdMs >= lastPaymentMs - SUBSCRIPTION_CHARGE_TOLERANCE_MS;
      });
      if (lastPaymentInWindow && settledWindowPayments.length === 0) {
        // Only a non-settled row that CORRELATES with the latest charge is
        // evidence that THAT charge failed locally — an older failed
        // renewal must not stand in while the enumeration reports the
        // actual missing sale.
        const correlatedNonSettledRows = orderWindowPayments.filter((payment) => {
          if (SETTLED_ROW_STATUSES.includes(payment.status)) return false;
          const createdMs = Date.parse(String(payment.created_at ?? ''));
          return Number.isFinite(createdMs)
            && createdMs >= lastPaymentMs - SUBSCRIPTION_CHARGE_TOLERANCE_MS;
        });
        if (correlatedNonSettledRows.length > 0) {
          // Provider billed; a local row exists but never settled.
          const latest = correlatedNonSettledRows.reduce((best, candidate) =>
            String(candidate.created_at ?? '') > String(best.created_at ?? '') ? candidate : best,
          );
          unsettledLocalPayments.push({
            transactionId: subscriptionId,
            guildId,
            orderId: order.id,
            paymentStatus: latest.status,
            orderStatus: order.status,
          });
        } else {
          // A wholly missing latest charge is DISCOVERED by the transaction
          // enumeration below and reported once, by its actual sale id —
          // reporting it here under the subscription id double-counted the
          // loss and handed operators an id that cannot replay the payment.
          // The flag makes the deferral SAFE: if the enumeration turns up
          // no money transactions at all, the last_payment evidence still
          // reports under the subscription id.
          latestChargeUnaccounted.set(subscriptionId, { order, subscription });
        }
        continue;
      }
      // A latest charge NEWER than the window end is not absent billing
      // evidence — it is today's charge still inside the settlement lag
      // (daily plans hit this naturally). Only a stale or missing latest
      // payment makes local settled sales unevidenced.
      const lastPaymentFresh = Number.isFinite(lastPaymentMs) && lastPaymentMs > windowEndMs;
      // A charge just BEFORE the window start whose webhook row landed just
      // after it belongs to the previous pass — within the same tolerance,
      // it is not absent billing evidence.
      const lastPaymentJustBeforeWindow = Number.isFinite(lastPaymentMs)
        && lastPaymentMs < windowStartMs
        && lastPaymentMs >= windowStartMs - SUBSCRIPTION_CHARGE_TOLERANCE_MS;
      // Only money the ledger claims KEPT needs billing evidence — a
      // refunded/reversed row's evidence is the sale object itself, which
      // the sale pass already verified.
      const keptWindowPayments = settledWindowPayments.filter(
        (payment) => payment.status === 'completed',
      );
      if (
        !lastPaymentInWindow
        && !lastPaymentFresh
        && !lastPaymentJustBeforeWindow
        && keptWindowPayments.length > 0
      ) {
        const latest = keptWindowPayments.reduce((best, candidate) =>
          String(candidate.created_at ?? '') > String(best.created_at ?? '') ? candidate : best,
        );
        missingProviderPayments.push({
          kind: 'payment',
          orderId: order.id,
          orderNumber: order.order_number,
          guildId,
          paypalPaymentIds: [subscriptionId],
          amountCents: latest.amount_cents,
          currency: normalizeCurrency(latest.currency) as string,
          createdAt: latest.created_at,
        });
      }
    }
    // Discovery beyond the latest charge: billing_info.last_payment names
    // only the NEWEST transaction, so a lost webhook for an older charge
    // (daily plans) stayed invisible whenever a newer charge matched.
    // Enumerate every provider transaction in the window and require a
    // local row for each money-moving one.
    const txnMap = await mapChunkedWithHeartbeat(
      map.results.filter((entry) => entry.lookup.ok && entry.lookup.found),
      heartbeat,
      async ({ subscriptionId, order }) => ({
        subscriptionId,
        order,
        lookup: await fetchProviderSubscriptionTransactions(
          config.apiBase,
          token.token,
          subscriptionId,
          windowStart,
          new Date(nowMs).toISOString(),
        ),
      }),
    );
    if (!txnMap.ok) return txnMap.failure;
    const unknownTxns: Array<{
      subscriptionId: string;
      order: LocalOrderRow;
      txn: ProviderSubscriptionTransaction;
    }> = [];
    for (const { subscriptionId, order, lookup } of txnMap.results) {
      if (!lookup.ok) {
        return { status: 'failed', reason: lookup.reason, retriable: lookup.retriable };
      }
      const unaccounted = latestChargeUnaccounted.get(subscriptionId);
      const unaccountedLastPaymentMs = unaccounted?.subscription.lastPaymentTime
        ? Date.parse(unaccounted.subscription.lastPaymentTime)
        : Number.NaN;
      if (
        unaccounted
        && lookup.ok
        && lookup.found
        // The list must contain the ADVERTISED latest charge itself — any
        // older in-window renewal (yesterday's known daily charge) must not
        // suppress the fallback for today's missing one.
        && !lookup.value.some((txn) =>
          MONEY_TXN_STATUSES.includes(txn.status)
          && Number.isFinite(unaccountedLastPaymentMs)
          && txn.timeMs >= unaccountedLastPaymentMs - SUBSCRIPTION_CHARGE_TOLERANCE_MS)
      ) {
        // billing_info.last_payment proved an in-window charge, but the
        // enumeration has no money transaction to name. Fall back to the
        // subscription-keyed finding rather than completing clean against
        // the provider's own evidence.
        missingLocalPayments.push({
          kind: 'payment',
          transactionId: subscriptionId,
          guildId: unaccounted.order.guild_id as string,
          amountCents: unaccounted.subscription.lastPaymentAmountCents
            ?? unaccounted.order.amount_cents,
          currency: unaccounted.subscription.lastPaymentCurrency
            ?? (normalizeCurrency(unaccounted.order.currency) as string),
          initiatedAt: unaccounted.subscription.lastPaymentTime,
          source: 'subscription',
          referenceId: subscriptionId,
        });
      }
      if (!lookup.found) {
        // The subscription GET just succeeded; a vanished transactions
        // subresource would silently remove the only discovery surface for
        // non-latest charges. That is a provider anomaly, never "zero
        // transactions".
        return {
          status: 'failed',
          reason: `subscription transactions unavailable for ${subscriptionId}`,
          retriable: true,
        };
      }
      for (const txn of lookup.value) {
        if (!MONEY_TXN_STATUSES.includes(txn.status)) continue;
        // In-flight charges (newer than the window end) get the settlement
        // lag; older-than-window charges belong to earlier passes.
        if (txn.timeMs < windowStartMs || txn.timeMs > windowEndMs) continue;
        const knownRow = localByProviderId.get(txn.id);
        if (knownRow) {
          // Known is not enough: the row must belong to THIS subscription's
          // order. A sale id attached to a one-time order (or another
          // tenant) is a provider-identity conflict, and suppressing the
          // transaction would hide subscription A's missing money behind
          // the wrong order's row.
          const rowOrder = ordersById.get(knownRow.order_id as string);
          if (!rowOrder || rowOrder.paypal_subscription_id !== subscriptionId) {
            return { status: 'failed', reason: 'provider identity conflict', retriable: false };
          }
          // Known is not JUDGED: only WINDOW rows crossed the sale pass
          // (money, status, refund ledger). A row registered merely as the
          // PARENT of a window refund row never met any money comparison —
          // hand it to the fallback machinery for the same terminal-family
          // and drift judgment instead of silently accounting the charge.
          if (windowPaymentIds.has(knownRow.id)) continue;
        }
        unknownTxns.push({ subscriptionId, order, txn });
      }
    }
    if (unknownTxns.length > 0) {
      const lookupScan = await lookupPaymentsByExactColumn(
        supabase,
        'paypal_payment_id',
        [...new Set(unknownTxns.map(({ txn }) => txn.id))],
      );
      if (!lookupScan.ok) {
        return { status: 'failed', reason: lookupScan.reason, retriable: lookupScan.retriable };
      }
      // Fallback rows never crossed the window validators: run them through
      // the same shape/guild validation, and only a SETTLED row may account
      // for a settled provider transaction.
      const validatedFallback = validateLocalPayments(lookupScan.rows, configuredGuildIds);
      if (!validatedFallback.ok) {
        return {
          status: 'failed',
          reason: validatedFallback.reason,
          retriable: validatedFallback.retriable,
        };
      }
      const fallbackRowsByProviderId = new Map(
        validatedFallback.rows.map((row) => [row.paypal_payment_id as string, row]),
      );
      const fallbackParentScan = await lookupOrdersByExactColumn(
        supabase,
        'id',
        [...new Set(
          lookupScan.rows
            .map((row) => row.order_id)
            .filter((id): id is string => typeof id === 'string' && !ordersById.has(id)),
        )],
        configuredGuildIds,
      );
      if (!fallbackParentScan.ok) {
        return {
          status: 'failed',
          reason: fallbackParentScan.reason,
          retriable: fallbackParentScan.retriable,
        };
      }
      for (const order of fallbackParentScan.rows) ordersById.set(order.id, order);
      for (const { subscriptionId, order, txn } of unknownTxns) {
        const fallbackRow = fallbackRowsByProviderId.get(txn.id);
        if (fallbackRow) {
          const rowOrder = ordersById.get(fallbackRow.order_id as string);
          if (
            !rowOrder
            || rowOrder.paypal_subscription_id !== subscriptionId
            || rowOrder.guild_id !== fallbackRow.guild_id
          ) {
            return { status: 'failed', reason: 'provider identity conflict', retriable: false };
          }
          // A TERMINAL provider transaction always faces the aggregate
          // judgment: a completed row means the refund webhook was lost,
          // and a terminal row may sit over an INCOMPLETE ledger (one
          // sibling lost) that status alone would bless — terminal rows are
          // also excluded from the completed-only lookback, so this is
          // their only ledger check. A non-settled row never accounts.
          const terminalTxn = ['REFUNDED', 'REVERSED'].includes(txn.status);
          if (
            terminalTxn
            && !['completed', 'refunded', 'reversed'].includes(fallbackRow.status)
          ) {
            // pending/failed behind terminal provider money: not accounted.
            missingLocalPayments.push({
              kind: 'payment',
              transactionId: txn.id,
              guildId: order.guild_id as string,
              amountCents: txn.amountCents ?? order.amount_cents,
              currency: txn.currency ?? (normalizeCurrency(order.currency) as string),
              initiatedAt: new Date(txn.timeMs).toISOString(),
              source: 'subscription',
              referenceId: subscriptionId,
            });
            continue;
          }
          if (terminalTxn || txn.status === 'PARTIALLY_REFUNDED') {
            // Terminal or partially refunded provider money behind an
            // out-of-window row: judge the refund ledger — a lost partial
            // webhook leaves zero local rows and must surface.
            const totalsFailure = await loadLocalRefundTotals([fallbackRow]);
            if (totalsFailure) return totalsFailure;
            judgeRefundedPayment({
              payment: fallbackRow,
              guildId: fallbackRow.guild_id as string,
              providerId: txn.id,
              providerStatusFullyRefunded: txn.status !== 'PARTIALLY_REFUNDED',
              providerAmountCents: txn.amountCents ?? fallbackRow.amount_cents,
              providerCurrency: txn.currency
                ?? (normalizeCurrency(fallbackRow.currency) as string),
              providerRefunds: null,
            });
            // Refund-ledger parity does not excuse PAYMENT-money drift: the
            // out-of-window row never met the sale pass, so its own amount
            // must still match the discovered transaction, or an offsetting
            // refund ledger masks a drifted charge row.
            if (
              (txn.amountCents !== null && txn.amountCents !== fallbackRow.amount_cents)
              || (txn.currency !== null
                && txn.currency !== normalizeCurrency(fallbackRow.currency))
            ) {
              amountMismatches.push({
                transactionId: txn.id,
                guildId: fallbackRow.guild_id as string,
                providerAmountCents: txn.amountCents ?? 0,
                localAmountCents: fallbackRow.amount_cents,
                providerCurrency: txn.currency ?? 'UNKNOWN',
                localCurrency: normalizeCurrency(fallbackRow.currency),
              });
            }
            continue;
          }
          if (!terminalTxn && fallbackRow.status !== 'completed') {
            missingLocalPayments.push({
              kind: 'payment',
              transactionId: txn.id,
              guildId: order.guild_id as string,
              amountCents: txn.amountCents ?? order.amount_cents,
              currency: txn.currency ?? (normalizeCurrency(order.currency) as string),
              initiatedAt: new Date(txn.timeMs).toISOString(),
              source: 'subscription',
              referenceId: subscriptionId,
            });
            continue;
          }
          // Rows outside the window never met the sale pass: the discovered
          // transaction's money must match or the drift surfaces here.
          if (
            (txn.amountCents !== null && txn.amountCents !== fallbackRow.amount_cents)
            || (txn.currency !== null
              && txn.currency !== normalizeCurrency(fallbackRow.currency))
          ) {
            amountMismatches.push({
              transactionId: txn.id,
              guildId: fallbackRow.guild_id as string,
              providerAmountCents: txn.amountCents ?? 0,
              localAmountCents: fallbackRow.amount_cents,
              providerCurrency: txn.currency ?? 'UNKNOWN',
              localCurrency: normalizeCurrency(fallbackRow.currency),
            });
          }
          continue;
        }
        missingLocalPayments.push({
          kind: 'payment',
          transactionId: txn.id,
          guildId: order.guild_id as string,
          amountCents: txn.amountCents ?? order.amount_cents,
          currency: txn.currency ?? (normalizeCurrency(order.currency) as string),
          initiatedAt: new Date(txn.timeMs).toISOString(),
          source: 'subscription',
          referenceId: subscriptionId,
        });
      }
    }
    return null;
  };

  {
    const windowFailure = await judgeSubscriptionEntries([...subscriptionTargets.entries()]);
    if (windowFailure) return windowFailure;
  }

  // Established subscriptions, page by page: every settled subscription order
  // is a provider target regardless of age — a monthly renewal with a lost
  // webhook must not be invisible — and each page is judged before the next
  // loads, so a mature merchant's history can never trip a lifetime cap.
  for (let from = 0; ; from += LOCAL_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('orders')
      .select('id, order_number, guild_id, customer_id, product_id, plan_id, amount_cents, currency, status, source, paypal_order_id, paypal_subscription_id, created_at')
      .not('paypal_subscription_id', 'is', null)
      .in('status', ORDER_SCAN_STATUSES)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LOCAL_PAGE_SIZE - 1);
    if (error) {
      return {
        status: 'failed',
        reason: `subscription order scan failed: ${error.message}`,
        retriable: true,
      };
    }
    const pageRows = (data ?? []) as LocalOrderRow[];
    if (pageRows.length === 0) break;
    const validatedPage = validateLocalOrders(pageRows, configuredGuildIds);
    if (!validatedPage.ok) {
      return {
        status: 'failed',
        reason: validatedPage.reason,
        retriable: validatedPage.retriable,
      };
    }
    const entries: Array<[string, LocalOrderRow]> = [];
    for (const order of validatedPage.rows) {
      ordersById.set(order.id, order);
      if (isProviderId(order.paypal_subscription_id)) {
        entries.push([order.paypal_subscription_id, order]);
      }
    }
    const pageFailure = await judgeSubscriptionEntries(entries);
    if (pageFailure) return pageFailure;
    if (pageRows.length < LOCAL_PAGE_SIZE) break;
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
  const refundLookbackMs = options.refundLookbackMs ?? DEFAULT_REFUND_LOOKBACK_MS;
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
        refundLookbackMs,
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
