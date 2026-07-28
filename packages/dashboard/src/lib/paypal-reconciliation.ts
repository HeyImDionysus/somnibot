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

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

// ── Tunables and durable identities ────────────────────────────────────────

export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SETTLEMENT_LAG_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_LEASE_MS = 6 * 60 * 60 * 1000;

const PROVIDER_PAGE_SIZE = 500;
const PROVIDER_MAX_PAGES = 40;
const LOCAL_PAGE_SIZE = 1000;
const EXACT_LOOKUP_CHUNK_SIZE = 100;
export const LOCAL_SCAN_MAX_ROWS = 20_000;
const MAX_REPORTED_IDS = 25;

export const RECONCILE_LEASE_KEY = 'paypal_reconcile_lease_at';
export const RECONCILE_LAST_RESULT_KEY = 'paypal_reconcile_last_result';
export const RECONCILE_ALERT_TYPE = 'paypal_reconciliation_mismatch';
export const RECONCILE_FAILURE_ALERT_TYPE = 'paypal_reconciliation_failure';

const SUPPORTED_EVENT_CODES = new Set(['T0006', 'T0002']);
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

export interface ProviderTransaction {
  transactionId: string;
  amountCents: number;
  currency: string;
  status: 'S';
  eventCode: 'T0006' | 'T0002';
  initiatedAt: string | null;
  referenceId: string | null;
  referenceType: 'ODR' | 'SUB' | null;
  customIdentity: SomniBotTransactionIdentity | null;
}

export interface MissingLocalPayment {
  transactionId: string;
  guildId: string;
  amountCents: number;
  currency: string;
  initiatedAt: string | null;
  eventCode: 'T0006' | 'T0002';
  referenceId: string | null;
  referenceType: 'ODR' | 'SUB' | null;
}

export interface MissingProviderPayment {
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
  requireLease?: boolean;
  leaseMs?: number;
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

interface LocalCustomerIdentityRow {
  id: string;
  guild_id: string;
  discord_id: string;
}

interface AttributedProviderTransaction {
  transaction: ProviderTransaction;
  guildId: string;
  referencedOrderId: string | null;
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

function toPayPalDate(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

type ProviderTransactionParse =
  | { kind: 'ignored' }
  | { kind: 'malformed' }
  | { kind: 'transaction'; transaction: ProviderTransaction };

function readTransaction(entry: unknown): ProviderTransactionParse {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { kind: 'malformed' };
  }
  const info = (entry as { transaction_info?: unknown }).transaction_info;
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    return { kind: 'malformed' };
  }
  const record = info as Record<string, unknown>;

  if (record.transaction_status !== 'S') return { kind: 'ignored' };
  if (
    typeof record.transaction_event_code !== 'string'
    || !SUPPORTED_EVENT_CODES.has(record.transaction_event_code)
  ) {
    return { kind: 'ignored' };
  }
  if (!isProviderId(record.transaction_id)) return { kind: 'malformed' };

  const amount = record.transaction_amount as
    { value?: unknown; currency_code?: unknown } | undefined;
  const amountCents = parseAmountToCents(amount?.value);
  const currency = normalizeCurrency(amount?.currency_code);
  if (amountCents === null || amountCents <= 0 || currency === null) {
    return { kind: 'malformed' };
  }

  const eventCode = record.transaction_event_code as 'T0006' | 'T0002';
  const candidateReferenceId = isProviderId(record.paypal_reference_id)
    ? record.paypal_reference_id
    : null;
  const candidateReferenceType =
    record.paypal_reference_id_type === 'ODR' || record.paypal_reference_id_type === 'SUB'
      ? record.paypal_reference_id_type
      : null;
  const referenceMatchesEvent =
    (eventCode === 'T0006' && candidateReferenceType === 'ODR')
    || (eventCode === 'T0002' && candidateReferenceType === 'SUB');

  const parsedIdentity = parseCustomIdentity(record.custom_field);
  const customIdentity = eventCode === 'T0002' && parsedIdentity?.planId === null
    ? null
    : parsedIdentity;

  return {
    kind: 'transaction',
    transaction: {
      transactionId: record.transaction_id,
      amountCents,
      currency,
      status: 'S',
      eventCode,
      initiatedAt: typeof record.transaction_initiation_date === 'string'
        ? record.transaction_initiation_date
        : null,
      referenceId: referenceMatchesEvent ? candidateReferenceId : null,
      referenceType: referenceMatchesEvent ? candidateReferenceType : null,
      customIdentity,
    },
  };
}

function sameProviderTransaction(
  left: ProviderTransaction,
  right: ProviderTransaction,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function fetchProviderTransactions(
  apiBase: string,
  token: string,
  windowStartMs: number,
  windowEndMs: number,
): Promise<
  { ok: true; transactions: ProviderTransaction[] }
  | { ok: false; retriable: boolean; reason: string }
> {
  const transactions: ProviderTransaction[] = [];
  const seen = new Map<string, ProviderTransaction>();
  let expectedTotalPages: number | null = null;

  for (let page = 1; page <= PROVIDER_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      start_date: toPayPalDate(windowStartMs),
      end_date: toPayPalDate(windowEndMs),
      fields: 'transaction_info',
      transaction_status: 'S',
      // PayPal documents transaction ids as unique only inside the
      // balance-affecting result set. Pin the default explicitly.
      balance_affecting_records_only: 'Y',
      page_size: String(PROVIDER_PAGE_SIZE),
      page: String(page),
    });

    let response: Response;
    try {
      response = await fetch(`${apiBase}/v1/reporting/transactions?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return {
        ok: false,
        retriable: true,
        reason: `transaction search request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        retriable: response.status >= 500 || response.status === 429,
        reason: response.status === 403
          ? 'transaction search returned 403 — enable the "Transaction Search" permission on the PayPal REST app'
          : `transaction search returned ${response.status}`,
      };
    }

    let body: { transaction_details?: unknown; total_pages?: unknown };
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        retriable: true,
        reason: 'transaction search returned malformed JSON',
      };
    }

    const totalPages = body.total_pages;
    if (
      typeof totalPages !== 'number'
      || !Number.isSafeInteger(totalPages)
      || totalPages < 1
    ) {
      return {
        ok: false,
        retriable: false,
        reason: 'transaction search returned invalid pagination metadata',
      };
    }
    if (totalPages > PROVIDER_MAX_PAGES) {
      return {
        ok: false,
        retriable: false,
        reason: `transaction search exceeded ${PROVIDER_MAX_PAGES} pages — narrow the window`,
      };
    }
    if (expectedTotalPages !== null && totalPages !== expectedTotalPages) {
      return {
        ok: false,
        retriable: false,
        reason: 'transaction search returned inconsistent pagination metadata',
      };
    }
    expectedTotalPages = totalPages;

    if (
      body.transaction_details !== undefined
      && !Array.isArray(body.transaction_details)
    ) {
      return {
        ok: false,
        retriable: false,
        reason: 'transaction search returned malformed transaction details',
      };
    }
    const details = body.transaction_details ?? [];
    for (const entry of details) {
      const parsed = readTransaction(entry);
      if (parsed.kind === 'ignored') continue;
      if (parsed.kind === 'malformed') {
        return {
          ok: false,
          retriable: false,
          reason: 'transaction search returned a malformed supported payment record',
        };
      }
      const transaction = parsed.transaction;
      const prior = seen.get(transaction.transactionId);
      if (prior) {
        if (!sameProviderTransaction(prior, transaction)) {
          return {
            ok: false,
            retriable: false,
            reason: 'transaction search returned conflicting duplicate transaction ids',
          };
        }
        continue;
      }
      seen.set(transaction.transactionId, transaction);
      transactions.push(transaction);
    }

    if (page >= totalPages) return { ok: true, transactions };
    if (details.length === 0) {
      return {
        ok: false,
        retriable: false,
        reason: 'transaction search pagination ended before total_pages',
      };
    }
  }

  return {
    ok: false,
    retriable: false,
    reason: `transaction search exceeded ${PROVIDER_MAX_PAGES} pages — narrow the window`,
  };
}

// ── Lease ownership ────────────────────────────────────────────────────────

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

/**
 * Release only the lease value this pass claimed. A newer replica's lease can
 * never be cleared by an older failed pass.
 */
export async function releaseReconcileLease(
  supabase: AdminSupabase,
  claimedAtMs: number,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('instance_settings')
      .update({ value: '0', updated_at: new Date().toISOString() })
      .eq('key', RECONCILE_LEASE_KEY)
      .eq('value', String(claimedAtMs))
      .select('key');
    if (error) {
      console.error('[PayPalReconcile] Failed to release lease:', error.message);
      return false;
    }
    return (data?.length ?? 0) > 0;
  } catch (error) {
    console.error(
      '[PayPalReconcile] Failed to release lease:',
      error instanceof Error ? error.message : error,
    );
    return false;
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

async function loadDurableAttributionOrders(
  supabase: AdminSupabase,
  transactions: ProviderTransaction[],
  payments: LocalPaymentRow[],
  guildIds: Set<string>,
): Promise<ScanResult<LocalOrderRow>> {
  const orderReferences = transactions
    .filter((transaction) => transaction.referenceType === 'ODR')
    .map((transaction) => transaction.referenceId)
    .filter((id): id is string => id !== null);
  const subscriptionReferences = transactions
    .filter((transaction) => transaction.referenceType === 'SUB')
    .map((transaction) => transaction.referenceId)
    .filter((id): id is string => id !== null);
  const localOrderIds = payments
    .map((payment) => payment.order_id)
    .filter((id): id is string => typeof id === 'string');

  const [byOrderReference, bySubscriptionReference, byLocalOrder] =
    await Promise.all([
      lookupOrdersByExactColumn(
        supabase,
        'paypal_order_id',
        orderReferences,
        guildIds,
      ),
      lookupOrdersByExactColumn(
        supabase,
        'paypal_subscription_id',
        subscriptionReferences,
        guildIds,
      ),
      lookupOrdersByExactColumn(supabase, 'id', localOrderIds, guildIds),
    ]);
  if (!byOrderReference.ok) return byOrderReference;
  if (!bySubscriptionReference.ok) return bySubscriptionReference;
  if (!byLocalOrder.ok) return byLocalOrder;

  const deduped = new Map<string, LocalOrderRow>();
  for (const row of [
    ...byOrderReference.rows,
    ...bySubscriptionReference.rows,
    ...byLocalOrder.rows,
  ]) {
    deduped.set(row.id, row);
  }
  return { ok: true, rows: [...deduped.values()] };
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
  eventCode: ProviderTransaction['eventCode'],
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
  return eventCode === 'T0002'
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
): Extract<PayPalReconciliationResult, { status: 'completed' }> {
  const scoped = {
    ...result,
    providerTransactions,
    localPayments,
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
      `${result.missingLocalPayments.length} PayPal payment(s) have NO local record — `
      + 'the customer paid and received nothing: '
      + summarise(
        result.missingLocalPayments,
        (item) =>
          `${item.transactionId} (${(item.amountCents / 100).toFixed(2)} ${item.currency})`,
      ),
    );
  }
  if (result.missingProviderPayments.length > 0) {
    parts.push(
      `${result.missingProviderPayments.length} settled order(s) have no matching PayPal transaction: `
      + summarise(
        result.missingProviderPayments,
        (item) => item.orderNumber ?? item.orderId,
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

// ── Reconciliation pass ────────────────────────────────────────────────────

async function runPass(
  supabase: AdminSupabase,
  nowMs: number,
  windowStartMs: number,
  windowEndMs: number,
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

  const provider = await fetchProviderTransactions(
    config.apiBase,
    token.token,
    windowStartMs,
    windowEndMs,
  );
  if (!provider.ok) {
    return { status: 'failed', reason: provider.reason, retriable: provider.retriable };
  }

  const windowStart = new Date(windowStartMs).toISOString();
  const windowEnd = new Date(windowEndMs).toISOString();

  const [guildScan, paymentScan, orderScan] = await Promise.all([
    loadConfiguredGuildIds(supabase),
    scanLocalPayments(supabase, windowStart, windowEnd),
    scanLocalOrders(supabase, windowStart, windowEnd),
  ]);
  if (!guildScan.ok) {
    return { status: 'failed', reason: guildScan.reason, retriable: guildScan.retriable };
  }
  if (!paymentScan.ok) {
    return { status: 'failed', reason: paymentScan.reason, retriable: paymentScan.retriable };
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
  const validatedWindowOrders = validateLocalOrders(orderScan.rows, configuredGuildIds);
  if (!validatedWindowOrders.ok) {
    return {
      status: 'failed',
      reason: validatedWindowOrders.reason,
      retriable: validatedWindowOrders.retriable,
    };
  }

  const payments = validatedPayments.rows;
  const orders = validatedWindowOrders.rows;
  const durableOrderScan = await loadDurableAttributionOrders(
    supabase,
    provider.transactions,
    payments,
    configuredGuildIds,
  );
  if (!durableOrderScan.ok) {
    return {
      status: 'failed',
      reason: durableOrderScan.reason,
      retriable: durableOrderScan.retriable,
    };
  }

  const ordersById = new Map<string, LocalOrderRow>();
  for (const order of [...orders, ...durableOrderScan.rows]) {
    ordersById.set(order.id, order);
  }
  const ordersByPayPalOrder = new Map(
    [...ordersById.values()]
      .filter((order) => isProviderId(order.paypal_order_id))
      .map((order) => [order.paypal_order_id as string, order]),
  );
  const ordersBySubscription = new Map(
    [...ordersById.values()]
      .filter((order) => isProviderId(order.paypal_subscription_id))
      .map((order) => [order.paypal_subscription_id as string, order]),
  );
  const localByProviderId = new Map<string, LocalPaymentRow>();
  const paymentsByOrder = new Map<string, string[]>();
  for (const payment of payments) {
    const existingPayment = localByProviderId.get(payment.paypal_payment_id as string);
    if (existingPayment && existingPayment.id !== payment.id) {
      return {
        status: 'failed',
        reason: 'provider identity conflict',
        retriable: false,
      };
    }
    localByProviderId.set(payment.paypal_payment_id as string, payment);
    const existing = paymentsByOrder.get(payment.order_id as string) ?? [];
    existing.push(payment.paypal_payment_id as string);
    paymentsByOrder.set(payment.order_id as string, existing);
  }

  const customConsistencyCustomerIds = new Set<string>();
  for (const transaction of provider.transactions) {
    if (!transaction.customIdentity) continue;
    const local = localByProviderId.get(transaction.transactionId);
    const localOrder = local ? ordersById.get(local.order_id as string) : undefined;
    const referencedOrder = transaction.referenceType === 'ODR' && transaction.referenceId
      ? ordersByPayPalOrder.get(transaction.referenceId)
      : transaction.referenceType === 'SUB' && transaction.referenceId
        ? ordersBySubscription.get(transaction.referenceId)
        : undefined;
    for (const order of [localOrder, referencedOrder]) {
      if (typeof order?.customer_id === 'string') {
        customConsistencyCustomerIds.add(order.customer_id);
      }
    }
  }
  const customerIdentityScan = await loadCustomerIdentities(
    supabase,
    [...customConsistencyCustomerIds],
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

  const attributed: AttributedProviderTransaction[] = [];
  for (const transaction of provider.transactions) {
    const local = localByProviderId.get(transaction.transactionId);
    const localOrder = local
      ? ordersById.get(local.order_id as string)
      : undefined;
    if (local && !localOrder) {
      return {
        status: 'failed',
        reason: 'local PayPal payment relation is missing',
        retriable: false,
      };
    }
    if (local && localOrder && local.guild_id !== localOrder.guild_id) {
      return {
        status: 'failed',
        reason: 'provider identity conflict',
        retriable: false,
      };
    }

    const referencedOrder = transaction.referenceType === 'ODR' && transaction.referenceId
      ? ordersByPayPalOrder.get(transaction.referenceId)
      : transaction.referenceType === 'SUB' && transaction.referenceId
        ? ordersBySubscription.get(transaction.referenceId)
        : undefined;
    if (localOrder && referencedOrder && localOrder.id !== referencedOrder.id) {
      return {
        status: 'failed',
        reason: 'provider identity conflict',
        retriable: false,
      };
    }

    const localProviderReference = localOrder
      ? transaction.eventCode === 'T0002'
        ? localOrder.paypal_subscription_id
        : localOrder.paypal_order_id
      : null;
    if (
      transaction.referenceId
      && localProviderReference
      && transaction.referenceId !== localProviderReference
    ) {
      return {
        status: 'failed',
        reason: 'provider identity conflict',
        retriable: false,
      };
    }

    const identity = transaction.customIdentity;
    if (
      identity
      && (
        (localOrder && !customIdentityMatchesOrder(
          identity,
          localOrder,
          transaction.eventCode,
          typeof localOrder.customer_id === 'string'
            ? customersById.get(localOrder.customer_id)
            : undefined,
        ))
        || (referencedOrder && !customIdentityMatchesOrder(
          identity,
          referencedOrder,
          transaction.eventCode,
          typeof referencedOrder.customer_id === 'string'
            ? customersById.get(referencedOrder.customer_id)
            : undefined,
        ))
      )
    ) {
      return {
        status: 'failed',
        reason: 'provider identity conflict',
        retriable: false,
      };
    }

    const authoritativeOrder = localOrder ?? referencedOrder;
    if (authoritativeOrder?.guild_id) {
      attributed.push({
        transaction,
        guildId: authoritativeOrder.guild_id,
        referencedOrderId: authoritativeOrder.id,
      });
      continue;
    }

    // custom_field is deliberately not a fallback authority. In a shared
    // merchant account, a foreign application can supply a syntactically
    // valid (even copied) value. Without an exact payment id or ODR/SUB
    // reference this transaction remains unattributed.
  }

  const missingLocalPayments: MissingLocalPayment[] = [];
  const amountMismatches: AmountMismatch[] = [];
  const unsettledLocalPayments: UnsettledLocalPayment[] = [];
  for (const item of attributed) {
    const transaction = item.transaction;
    const local = localByProviderId.get(transaction.transactionId);
    if (!local) {
      missingLocalPayments.push({
        transactionId: transaction.transactionId,
        guildId: item.guildId,
        amountCents: transaction.amountCents,
        currency: transaction.currency,
        initiatedAt: transaction.initiatedAt,
        eventCode: transaction.eventCode,
        referenceId: transaction.referenceId,
        referenceType: transaction.referenceType,
      });
      continue;
    }

    const order = typeof local.order_id === 'string'
      ? ordersById.get(local.order_id)
      : undefined;
    if (!isSettledPair(local, order)) {
      unsettledLocalPayments.push({
        transactionId: transaction.transactionId,
        guildId: item.guildId,
        orderId: local.order_id,
        paymentStatus: local.status,
        orderStatus: order?.status ?? null,
      });
      continue;
    }

    const localCurrency = normalizeCurrency(local.currency);
    if (
      local.amount_cents !== transaction.amountCents
      || localCurrency !== transaction.currency
    ) {
      amountMismatches.push({
        transactionId: transaction.transactionId,
        guildId: item.guildId,
        providerAmountCents: transaction.amountCents,
        localAmountCents: local.amount_cents,
        providerCurrency: transaction.currency,
        localCurrency,
      });
    }
  }

  const providerIds = new Set(attributed.map((item) => item.transaction.transactionId));
  const providerOrderIds = new Set(
    attributed
      .map((item) => item.referencedOrderId)
      .filter((id): id is string => id !== null),
  );
  const rawWindowOrderIds = new Set(
    orderScan.rows
      .map((order) => order.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const ordersForMissingProvider = new Map(orders.map((order) => [order.id, order]));
  for (const order of durableOrderScan.rows) {
    if (
      rawWindowOrderIds.has(order.id)
      && paymentsByOrder.has(order.id)
    ) {
      // A nullable legacy source plus missing ODR/SUB write is still proven
      // PayPal commerce when this window contains an exact linked PayPal
      // payment. Do not lose that row merely because the window validator had
      // to withhold it until the payment relation was loaded.
      ordersForMissingProvider.set(order.id, order);
    }
  }
  const missingProviderPayments: MissingProviderPayment[] = [];
  for (const order of ordersForMissingProvider.values()) {
    if (!['completed', 'disputed', 'refunded'].includes(order.status)) continue;
    const paymentIds = paymentsByOrder.get(order.id) ?? [];
    if (providerOrderIds.has(order.id) || paymentIds.some((id) => providerIds.has(id))) {
      continue;
    }
    missingProviderPayments.push({
      orderId: order.id,
      orderNumber: order.order_number,
      guildId: order.guild_id as string,
      paypalPaymentIds: paymentIds,
      amountCents: order.amount_cents,
      currency: normalizeCurrency(order.currency) as string,
      createdAt: order.created_at,
    });
  }

  const result: Extract<PayPalReconciliationResult, { status: 'completed' }> = {
    status: 'completed',
    windowStart,
    windowEnd,
    providerTransactions: attributed.length,
    localPayments: payments.length,
    missingLocalPayments,
    missingProviderPayments,
    amountMismatches,
    unsettledLocalPayments,
    alerted: false,
  };

  const providerCountByGuild = new Map<string, number>();
  for (const item of attributed) {
    providerCountByGuild.set(
      item.guildId,
      (providerCountByGuild.get(item.guildId) ?? 0) + 1,
    );
  }
  const paymentCountByGuild = new Map<string, number>();
  for (const payment of payments) {
    const guildId = payment.guild_id as string;
    paymentCountByGuild.set(guildId, (paymentCountByGuild.get(guildId) ?? 0) + 1);
  }

  let divergenceGuilds = 0;
  for (const guildId of guildScan.rows) {
    const scoped = resultForGuild(
      result,
      guildId,
      providerCountByGuild.get(guildId) ?? 0,
      paymentCountByGuild.get(guildId) ?? 0,
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
    + `${attributed.length} attributable provider transaction(s), `
    + `${payments.length} local PayPal payment(s), `
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

  let leaseOwned = false;
  let completed = false;
  if (options.requireLease) {
    leaseOwned = await acquireReconcileLease(
      supabase,
      options.leaseMs ?? DEFAULT_LEASE_MS,
      nowMs,
    );
    if (!leaseOwned) {
      return { status: 'skipped', reason: 'another pass ran recently' };
    }
  }

  try {
    const result = await runPass(
      supabase,
      nowMs,
      windowStartMs,
      windowEndMs,
      options.resultGuildId,
    );
    completed = result.status === 'completed';
    return result;
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : 'reconciliation threw',
      retriable: true,
    };
  } finally {
    if (leaseOwned && !completed) {
      await releaseReconcileLease(supabase, nowMs);
    }
  }
}
