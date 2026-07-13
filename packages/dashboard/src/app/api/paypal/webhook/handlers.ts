/**
 * PayPal Webhook Event Handlers.
 *
 * V5 Audit §2.P3a: Extracted from the monolithic route.ts for maintainability.
 * Each handler deals with one PayPal event type (or a small group).
 */

import { createHash } from 'crypto';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getPayPalRuntimeConfig, getPayPalToken, getSubscriptionAmount } from '@/lib/paypal';
import {
  paypalCaptureResourceSchema,
  paypalSaleResourceSchema,
  type PayPalCaptureResource,
  type PayPalSaleResource,
} from '@/lib/types/paypal';
import { generateLicenseKey, queueFulfillment } from './fulfillment';

function formatSupabaseError(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return String(error);
}

function requireSupabaseSuccess(error: unknown, operation: string) {
  if (error) {
    throw new Error(`${operation}: ${formatSupabaseError(error)}`);
  }
}

type AdminSupabase = ReturnType<typeof createAdminSupabase>;
const LIFECYCLE_SCAN_PAGE_SIZE = 500;

interface FrozenGrantSnapshot {
  order_id: string;
  granted_role_ids_snapshot: string[];
  granted_channel_ids_snapshot: string[];
  temporary_role_grants_snapshot: Array<{ role_id: string; duration_seconds: number }>;
  grant_snapshot_frozen_at: string;
}

interface LegacySubscriptionGrantContract {
  order_id: string;
  source_queue_id: string;
  granted_role_ids_snapshot: string[];
  granted_channel_ids_snapshot: string[];
  persisted_at: string;
}

interface CaptureFinalization {
  order_id: string;
  order_status: 'completed' | 'pending_review' | 'refunded' | 'disputed';
  payment_id: string;
  payment_created: boolean;
}

interface FinancialAmount {
  amountCents: number;
  currency: string;
}

interface AuthoritativeSubscriptionContract extends FinancialAmount {
  providerPlanId: string;
}

interface FulfillmentQueueRow {
  id: string;
  guild_id: string;
  action: string;
  payload: Record<string, unknown>;
  status: string;
  idempotency_key: string;
}

interface FulfillmentExpectation {
  idempotencyKey: string;
  action: string;
  guildId: string;
  orderId: string;
  fulfillmentType: string;
  payload?: Record<string, unknown>;
}

interface CommerceOrderRow {
  id: string;
  order_number: string;
  customer_id: string;
  guild_id: string;
  product_id: string;
  plan_id?: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  grant_snapshot_frozen_at?: string | null;
  paypal_order_id?: string | null;
  paypal_subscription_id?: string | null;
}

interface EntitlementLifecycleRow {
  id: string;
  license_key_id: string | null;
}

interface LicenseKeyLifecycleRow {
  id: string;
}

interface RefundAmountRow {
  id: string;
  amount_cents: number | null;
}

interface CustomerIdentityRow {
  id: string;
  guild_id: string;
  discord_id: string;
}

interface SubscriptionPlanIdentityRow {
  id: string;
  guild_id: string;
  product_id: string;
  paypal_plan_id: string;
}

interface SubscriptionLifecycleOrderRow {
  id: string;
  order_number: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
  paypal_subscription_id: string;
}

interface SubscriptionProductIdentityRow {
  id: string;
  guild_id: string;
  name: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

async function fetchAllLifecycleRowsById<T extends { id: string }>(
  fetchPage: (
    afterId: string | null,
  ) => Promise<{ data: T[] | null; error: unknown }>,
  operation: string,
): Promise<T[]> {
  const rows: T[] = [];
  let afterId: string | null = null;

  for (;;) {
    const { data, error } = await fetchPage(afterId);
    requireSupabaseSuccess(error, operation);
    if (!Array.isArray(data)) throw new Error(`${operation}: query returned no data`);

    let previousId = afterId;
    for (const row of data) {
      if (!row || !isNonEmptyString(row.id) || (previousId !== null && row.id <= previousId)) {
        throw new Error(`${operation}: invalid id cursor order`);
      }
      previousId = row.id;
    }
    rows.push(...data);
    if (data.length < LIFECYCLE_SCAN_PAGE_SIZE) return rows;
    afterId = data[data.length - 1]!.id;
  }
}

async function requireExactCustomerIdentity(
  supabase: AdminSupabase,
  input: {
    customerId: string;
    guildId: string;
    expectedDiscordId?: string;
    operation: string;
  },
): Promise<CustomerIdentityRow> {
  const { data, error } = await supabase
    .from('customers')
    .select('id, guild_id, discord_id')
    .eq('id', input.customerId)
    .eq('guild_id', input.guildId)
    .maybeSingle();
  requireSupabaseSuccess(error, input.operation);
  if (
    !data ||
    data.id !== input.customerId ||
    data.guild_id !== input.guildId ||
    !isNonEmptyString(data.discord_id) ||
    (input.expectedDiscordId !== undefined && data.discord_id !== input.expectedDiscordId)
  ) {
    throw new Error(`${input.operation}: customer identity mismatch`);
  }
  return data as CustomerIdentityRow;
}

async function requireExactSubscriptionPlan(
  supabase: AdminSupabase,
  input: {
    planId: string;
    guildId: string;
    productId: string;
    providerPlanId: string;
  },
): Promise<SubscriptionPlanIdentityRow> {
  const { data, error } = await supabase
    .from('plans')
    .select('id, guild_id, product_id, paypal_plan_id')
    .eq('id', input.planId)
    .eq('guild_id', input.guildId)
    .eq('product_id', input.productId)
    .maybeSingle();
  requireSupabaseSuccess(error, 'Failed to load subscription plan identity');
  if (
    !data ||
    data.id !== input.planId ||
    data.guild_id !== input.guildId ||
    data.product_id !== input.productId ||
    !isNonEmptyString(data.paypal_plan_id) ||
    data.paypal_plan_id !== input.providerPlanId
  ) {
    throw new Error('Subscription provider plan identity mismatch');
  }
  return data as SubscriptionPlanIdentityRow;
}

async function requireProductDisplayName(
  supabase: AdminSupabase,
  productId: string,
  operation: string,
): Promise<string> {
  // Product ids are globally unique. Captured funds are authorized by the
  // immutable order contract, so a later catalog guild move must not make the
  // display-name lookup re-authorize or dead-letter that sale.
  const { data, error } = await supabase
    .from('products')
    .select('id, name')
    .eq('id', productId)
    .maybeSingle();
  requireSupabaseSuccess(error, operation);
  if (!data || data.id !== productId || !isNonEmptyString(data.name)) {
    throw new Error(`Product ${productId} has no exact display identity`);
  }
  return data.name;
}

async function loadSubscriptionLifecycleContext(
  supabase: AdminSupabase,
  subscriptionId: string,
  operation: string,
): Promise<{
  order: SubscriptionLifecycleOrderRow;
  product: SubscriptionProductIdentityRow;
  customer: CustomerIdentityRow;
}> {
  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .select('id, order_number, guild_id, customer_id, product_id, paypal_subscription_id')
    .eq('paypal_subscription_id', subscriptionId)
    .maybeSingle();
  requireSupabaseSuccess(orderError, `${operation}: failed to load order`);
  if (
    !orderData ||
    !isNonEmptyString(orderData.id) ||
    !isNonEmptyString(orderData.order_number) ||
    !isNonEmptyString(orderData.guild_id) ||
    !isNonEmptyString(orderData.customer_id) ||
    !isNonEmptyString(orderData.product_id) ||
    orderData.paypal_subscription_id !== subscriptionId
  ) {
    throw new Error(`${operation}: order identity mismatch`);
  }
  const order = orderData as SubscriptionLifecycleOrderRow;

  const { data: productData, error: productError } = await supabase
    .from('products')
    .select('id, guild_id, name')
    .eq('id', order.product_id)
    .eq('guild_id', order.guild_id)
    .maybeSingle();
  requireSupabaseSuccess(productError, `${operation}: failed to load product`);
  if (
    !productData ||
    productData.id !== order.product_id ||
    productData.guild_id !== order.guild_id ||
    !isNonEmptyString(productData.name)
  ) {
    throw new Error(`${operation}: product identity mismatch`);
  }

  const customer = await requireExactCustomerIdentity(supabase, {
    customerId: order.customer_id,
    guildId: order.guild_id,
    operation: `${operation}: failed to load customer`,
  });
  return {
    order,
    product: productData as SubscriptionProductIdentityRow,
    customer,
  };
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    throw new Error(`${label} is malformed`);
  }
  return [...new Set(value)];
}

function parseTemporaryRoleSnapshot(
  value: unknown,
): Array<{ role_id: string; duration_seconds: number }> {
  if (!Array.isArray(value)) throw new Error('Temporary role snapshot is malformed');
  const seen = new Set<string>();
  return value.map((entry) => {
    const roleId = (entry as { role_id?: unknown } | null)?.role_id;
    const durationSeconds = (entry as { duration_seconds?: unknown } | null)?.duration_seconds;
    if (
      !entry ||
      typeof entry !== 'object' ||
      !isNonEmptyString(roleId) ||
      !/^\d{17,20}$/.test(roleId) ||
      seen.has(roleId) ||
      !Number.isSafeInteger(durationSeconds) ||
      Number(durationSeconds) <= 0 ||
      Number(durationSeconds) > 315_360_000
    ) {
      throw new Error('Temporary role snapshot is malformed');
    }
    seen.add(roleId);
    return {
      role_id: roleId,
      duration_seconds: Number(durationSeconds),
    };
  });
}

function parseFrozenGrantSnapshot(data: unknown): FrozenGrantSnapshot {
  if (!data || typeof data !== 'object') {
    throw new Error('Order grant snapshot RPC returned malformed data');
  }
  const candidate = data as Record<string, unknown>;
  if (!isNonEmptyString(candidate.order_id) || !isNonEmptyString(candidate.grant_snapshot_frozen_at)) {
    throw new Error('Order grant snapshot RPC returned malformed identity');
  }
  return {
    order_id: candidate.order_id,
    granted_role_ids_snapshot: parseStringArray(
      candidate.granted_role_ids_snapshot,
      'Permanent role snapshot',
    ),
    granted_channel_ids_snapshot: parseStringArray(
      candidate.granted_channel_ids_snapshot,
      'Channel snapshot',
    ),
    temporary_role_grants_snapshot: parseTemporaryRoleSnapshot(
      candidate.temporary_role_grants_snapshot,
    ),
    grant_snapshot_frozen_at: candidate.grant_snapshot_frozen_at,
  };
}

function parseLegacySubscriptionGrantContract(
  data: unknown,
): LegacySubscriptionGrantContract {
  if (!data || typeof data !== 'object') {
    throw new Error('Legacy subscription grant contract RPC returned malformed data');
  }
  const candidate = data as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.order_id)
    || !isNonEmptyString(candidate.source_queue_id)
    || !isNonEmptyString(candidate.persisted_at)
    || !Number.isFinite(Date.parse(candidate.persisted_at))
  ) {
    throw new Error('Legacy subscription grant contract RPC returned malformed identity');
  }
  return {
    order_id: candidate.order_id,
    source_queue_id: candidate.source_queue_id,
    granted_role_ids_snapshot: parseStringArray(
      candidate.granted_role_ids_snapshot,
      'Legacy subscription role snapshot',
    ),
    granted_channel_ids_snapshot: parseStringArray(
      candidate.granted_channel_ids_snapshot,
      'Legacy subscription channel snapshot',
    ),
    persisted_at: candidate.persisted_at,
  };
}

function parseCaptureFinalization(data: unknown): CaptureFinalization {
  if (!data || typeof data !== 'object') {
    throw new Error('Capture finalization RPC returned malformed data');
  }
  const candidate = data as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.order_id) ||
    !['completed', 'pending_review', 'refunded', 'disputed'].includes(
      String(candidate.order_status),
    ) ||
    !isNonEmptyString(candidate.payment_id) ||
    typeof candidate.payment_created !== 'boolean'
  ) {
    throw new Error('Capture finalization RPC returned malformed data');
  }
  return candidate as unknown as CaptureFinalization;
}

async function finalizePayPalCapture(
  supabase: AdminSupabase,
  input: {
    order: CommerceOrderRow;
    paypalCaptureId: string;
    amountCents: number;
    currency: string;
  },
): Promise<CaptureFinalization> {
  const { order, paypalCaptureId, amountCents, currency } = input;
  const { data, error } = await supabase.rpc(
    'commerce_finalize_paypal_capture',
    {
      p_order_id: order.id,
      p_guild_id: order.guild_id,
      p_customer_id: order.customer_id,
      p_product_id: order.product_id,
      p_paypal_order_id: order.paypal_order_id,
      p_paypal_capture_id: paypalCaptureId,
      p_amount_cents: amountCents,
      p_currency: currency,
    },
  );
  requireSupabaseSuccess(error, 'Failed to finalize captured payment');
  const finalization = parseCaptureFinalization(data);
  if (finalization.order_id !== order.id) {
    throw new Error('Capture finalization RPC returned the wrong order');
  }
  return finalization;
}

function shouldSkipCaptureFulfillment(
  finalization: CaptureFinalization,
  input: {
    order: CommerceOrderRow;
    amountCents: number;
    currency: string;
  },
): boolean {
  const { order, amountCents, currency } = input;
  if (finalization.order_status === 'refunded' || finalization.order_status === 'disputed') {
    if (finalization.payment_created) {
      throw new Error('Capture successor-state replay unexpectedly created a payment');
    }
    console.info(
      `[Webhook] Capture finalization preserved successor order state ${finalization.order_status}; ` +
        `skipping fulfillment for ${order.order_number}`,
    );
    return true;
  }
  if (finalization.order_status === 'pending_review') {
    console.error(
      `[Webhook] AMOUNT/CURRENCY MISMATCH: PayPal captured ${amountCents} ${currency} ` +
        `but order ${order.id} expected ${order.amount_cents} ${order.currency}. ` +
        `Order flagged as pending_review — manual intervention required.`,
    );
    console.warn(
      `[Webhook] Skipping auto-fulfillment for order ${order.order_number} due to amount mismatch. ` +
        `Resolve via dashboard → Orders → pending_review.`,
    );
    return true;
  }
  return false;
}

function parseFinancialAmount(
  amountCents: unknown,
  currency: unknown,
  label: string,
): FinancialAmount {
  if (
    !Number.isSafeInteger(amountCents) ||
    Number(amountCents) < 0 ||
    !isNonEmptyString(currency) ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    throw new Error(`${label} has malformed financial state`);
  }
  return { amountCents: Number(amountCents), currency };
}

function parseCapturedAmountToCents(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    return null;
  }
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

async function requireAuthoritativeSubscriptionAmount(
  subscriptionId: string,
): Promise<AuthoritativeSubscriptionContract> {
  const subAmount = await getSubscriptionAmount(subscriptionId);
  if (
    !subAmount ||
    !isNonEmptyString(subAmount.currency) ||
    !isNonEmptyString(subAmount.planId) ||
    subAmount.planId.trim() !== subAmount.planId
  ) {
    throw new Error(
      `Subscription ${subscriptionId} authoritative billing amount is unavailable`,
    );
  }
  try {
    const financial = parseFinancialAmount(
      subAmount.amountCents,
      subAmount.currency.toUpperCase(),
      `Subscription ${subscriptionId} authoritative billing amount`,
    );
    return { ...financial, providerPlanId: subAmount.planId };
  } catch {
    throw new Error(
      `Subscription ${subscriptionId} authoritative billing amount is unavailable`,
    );
  }
}

function payloadValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => payloadValuesEqual(entry, right[index]));
  }
  if (
    left &&
    right &&
    typeof left === 'object' &&
    typeof right === 'object'
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          payloadValuesEqual(leftRecord[key], rightRecord[key]),
      );
  }
  return false;
}

function validateQueueRow(
  data: unknown,
  expected: FulfillmentExpectation,
): FulfillmentQueueRow {
  if (!data || typeof data !== 'object') {
    throw new Error('Fulfillment outbox returned no row');
  }
  const row = data as Record<string, unknown>;
  const payload = row.payload;
  if (
    !isNonEmptyString(row.id) ||
    row.idempotency_key !== expected.idempotencyKey ||
    row.action !== expected.action ||
    row.guild_id !== expected.guildId ||
    !payload ||
    typeof payload !== 'object' ||
    (payload as Record<string, unknown>).order_id !== expected.orderId ||
    (payload as Record<string, unknown>).fulfillment_type !== expected.fulfillmentType ||
    !isNonEmptyString(row.status)
  ) {
    throw new Error('Fulfillment outbox row failed identity validation');
  }
  if (expected.payload) {
    const payloadRecord = payload as Record<string, unknown>;
    if (!isNonEmptyString(payloadRecord.product_name)) {
      throw new Error('Fulfillment outbox row failed payload validation');
    }
    for (const [key, value] of Object.entries(expected.payload)) {
      if (!payloadValuesEqual(payloadRecord[key], value)) {
        throw new Error(`Fulfillment outbox row failed payload validation (${key})`);
      }
    }
  }
  return row as unknown as FulfillmentQueueRow;
}

async function loadFulfillmentByIdempotencyKey(
  supabase: AdminSupabase,
  expected: Parameters<typeof validateQueueRow>[1],
): Promise<FulfillmentQueueRow | null> {
  const { data, error } = await supabase
    .from('bot_action_queue')
    .select('id, guild_id, action, payload, status, idempotency_key')
    .eq('idempotency_key', expected.idempotencyKey)
    .maybeSingle();
  requireSupabaseSuccess(error, 'Failed to inspect fulfillment outbox');
  return data ? validateQueueRow(data, expected) : null;
}

async function stageFulfillment(
  supabase: AdminSupabase,
  expected: Parameters<typeof validateQueueRow>[1],
  payload: Record<string, unknown>,
): Promise<FulfillmentQueueRow> {
  const existing = await loadFulfillmentByIdempotencyKey(supabase, expected);
  if (existing) return existing;

  const { data, error } = await supabase
    .from('bot_action_queue')
    .insert({
      guild_id: expected.guildId,
      action: expected.action,
      payload,
      status: 'staged',
      idempotency_key: expected.idempotencyKey,
    })
    .select('id, guild_id, action, payload, status, idempotency_key')
    .single();
  if (error?.code === '23505') {
    const raced = await loadFulfillmentByIdempotencyKey(supabase, expected);
    if (raced) return raced;
  }
  requireSupabaseSuccess(error, 'Failed to stage fulfillment outbox');
  return validateQueueRow(data, expected);
}

async function releaseStagedFulfillment(
  supabase: AdminSupabase,
  row: FulfillmentQueueRow,
): Promise<void> {
  if (row.status !== 'staged') return;
  const { data, error } = await supabase
    .from('bot_action_queue')
    .update({ status: 'pending', error: null, next_retry_at: null })
    .eq('id', row.id)
    .eq('status', 'staged')
    .select('id')
    .maybeSingle();
  requireSupabaseSuccess(error, 'Failed to release staged fulfillment');
  if (!data) {
    const current = await loadFulfillmentByIdempotencyKey(supabase, {
      idempotencyKey: row.idempotency_key,
      action: row.action,
      guildId: row.guild_id,
      orderId: String(row.payload.order_id ?? ''),
      fulfillmentType: String(row.payload.fulfillment_type ?? ''),
    });
    if (!current || current.status === 'staged') {
      throw new Error('Failed to release staged fulfillment');
    }
  }
}

async function freezeOrderGrantSnapshot(
  supabase: AdminSupabase,
  order: CommerceOrderRow,
): Promise<FrozenGrantSnapshot> {
  const { data, error } = await supabase.rpc('commerce_freeze_order_grant_snapshot', {
    p_order_id: order.id,
    p_guild_id: order.guild_id,
    p_customer_id: order.customer_id,
    p_product_id: order.product_id,
  });
  requireSupabaseSuccess(error, 'Failed to freeze order grant snapshot');
  const snapshot = parseFrozenGrantSnapshot(data);
  if (snapshot.order_id !== order.id) {
    throw new Error('Order grant snapshot RPC returned the wrong order');
  }
  return snapshot;
}

async function adoptLegacySubscriptionGrantContract(
  supabase: AdminSupabase,
  order: CommerceOrderRow,
  staged: FulfillmentQueueRow,
): Promise<LegacySubscriptionGrantContract> {
  const { data, error } = await supabase.rpc(
    'commerce_adopt_legacy_subscription_grant_contract',
    {
      p_order_id: order.id,
      p_source_queue_id: staged.id,
    },
  );
  requireSupabaseSuccess(error, 'Failed to persist legacy subscription grant contract');
  const contract = parseLegacySubscriptionGrantContract(data);
  if (contract.order_id !== order.id || contract.source_queue_id !== staged.id) {
    throw new Error('Legacy subscription grant contract RPC returned the wrong identity');
  }
  return contract;
}

async function ensureStagedLicenseKey(
  supabase: AdminSupabase,
  order: CommerceOrderRow,
  payload: Record<string, unknown>,
): Promise<void> {
  const licenseKeyId = payload.license_key_id;
  const plaintext = payload.license_key_plaintext;
  if (licenseKeyId == null && plaintext == null) return;
  if (!isNonEmptyString(licenseKeyId) || !isNonEmptyString(plaintext)) {
    throw new Error('Staged license key payload is malformed');
  }

  const groups = plaintext.split('-');
  if (groups.length !== 5 || groups[0] !== 'SMNI' || groups.slice(1).some((group) => group.length !== 4)) {
    throw new Error('Staged license key plaintext is malformed');
  }
  const keyHash = createHash('sha256').update(plaintext).digest('hex');
  const row = {
    id: licenseKeyId,
    order_id: order.id,
    customer_id: order.customer_id,
    product_id: order.product_id,
    guild_id: order.guild_id,
    key_hash: keyHash,
    key_prefix: 'SMNI',
    key_suffix: groups[4]!,
    bound_discord_id: String(payload.discord_id ?? ''),
    status: 'pending_activation',
  };
  if (!isNonEmptyString(row.bound_discord_id)) {
    throw new Error('Staged license key Discord identity is malformed');
  }

  const { data, error } = await supabase
    .from('license_keys')
    .insert(row)
    .select('id, order_id, customer_id, product_id, guild_id, key_hash')
    .single();
  if (!error) {
    if (!data || data.id !== licenseKeyId) throw new Error('License key insert returned no row');
    return;
  }
  if (error.code !== '23505') {
    throw new Error(`Failed to persist staged license key: ${error.message}`);
  }

  const { data: existing, error: existingError } = await supabase
    .from('license_keys')
    .select('id, order_id, customer_id, product_id, guild_id, key_hash')
    .eq('id', licenseKeyId)
    .maybeSingle();
  requireSupabaseSuccess(existingError, 'Failed to inspect staged license key');
  if (
    !existing ||
    existing.order_id !== order.id ||
    existing.customer_id !== order.customer_id ||
    existing.product_id !== order.product_id ||
    existing.guild_id !== order.guild_id ||
    existing.key_hash !== keyHash
  ) {
    throw new Error('Existing staged license key failed identity validation');
  }
}

const EXPIRABLE_ENTITLEMENT_STATUSES = ['active', 'pending', 'grace_period', 'suspended'];
const EXPIRY_RETRY_ENTITLEMENT_STATUSES = [
  ...EXPIRABLE_ENTITLEMENT_STATUSES,
  'expired',
];

/**
 * W2 codex round 2: retry-dedupe probe for cancellation/suspension
 * fulfillments. A failed BILLING.SUBSCRIPTION.CANCELLED / .SUSPENDED /
 * .PAYMENT.FAILED event is resumable (RESUMABLE_FAILED_EVENT_TYPES), and the
 * failed attempt may already have queued the fulfillment (insert committed
 * but the response was lost, or the process died before recording success).
 * The bot-side entitlement effects are idempotent, but the user DM / event
 * emission are not — so a resumed retry must not queue a second action.
 * The probe is scoped by the triggering webhook event id (stamped into the
 * payload) so a fulfillment queued by an EARLIER suspension episode of the
 * same order never suppresses a genuinely new one.
 */
async function hasQueuedOrderFulfillment(
  supabase: ReturnType<typeof createAdminSupabase>,
  input: {
    guildId: string;
    action: string;
    orderId: string;
    fulfillmentType: string;
    webhookEventId?: string;
  },
): Promise<boolean> {
  const payloadFilter: Record<string, string> = {
    order_id: input.orderId,
    fulfillment_type: input.fulfillmentType,
  };
  if (input.webhookEventId) {
    payloadFilter.webhook_event_id = input.webhookEventId;
  }

  const { data, error } = await supabase
    .from('bot_action_queue')
    .select('id')
    .eq('guild_id', input.guildId)
    .eq('action', input.action)
    .in('status', ['pending', 'processing', 'completed'])
    .contains('payload', payloadFilter)
    .limit(1);
  requireSupabaseSuccess(error, `Failed to inspect queued ${input.action}`);
  if (!Array.isArray(data) || data.some((row) => !row || !isNonEmptyString(row.id))) {
    throw new Error(`Failed to inspect queued ${input.action}: query returned malformed data`);
  }
  return data.length > 0;
}

async function hasQueuedSubscriptionExpiredAuditEvent(
  supabase: ReturnType<typeof createAdminSupabase>,
  input: {
    guildId: string;
    discordId: string;
    orderId: string;
    productId: string;
  },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('bot_action_queue')
    .select('id')
    .eq('guild_id', input.guildId)
    .eq('action', 'emit_audit_event')
    .in('status', ['pending', 'processing', 'completed'])
    .contains('payload', {
      event_type: 'subscription.expired',
      event_data: {
        discordId: input.discordId,
        orderId: input.orderId,
        productId: input.productId,
      },
    })
    .limit(1);
  requireSupabaseSuccess(
    error,
    'Failed to inspect queued subscription expired audit event',
  );
  if (!Array.isArray(data) || data.some((row) => !row || !isNonEmptyString(row.id))) {
    throw new Error(
      'Failed to inspect queued subscription expired audit event: query returned malformed data',
    );
  }
  return data.length > 0;
}

function resolveCaptureRefundPaymentId(resource: Record<string, unknown>): string | null {
  const parsed = paypalCaptureResourceSchema.safeParse(resource);
  const capture: PayPalCaptureResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };

  const supp = capture.supplementary_data;
  if (supp?.related_ids?.capture_id) {
    return supp.related_ids.capture_id;
  }

  const links = capture.links ?? [];
  const up = links.find((l) => l.rel === 'up');
  if (up?.href) {
    const m = up.href.match(/\/captures\/([^/?#]+)/);
    if (m?.[1]) return m[1];
  }

  return null;
}

function resolveSaleRefundPaymentId(
  resource: Record<string, unknown>,
  eventType: string,
): string | null {
  const parsed = paypalSaleResourceSchema.safeParse(resource);
  const sale: PayPalSaleResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };

  if (sale.sale_id) return sale.sale_id;
  if (sale.capture_id) return sale.capture_id;

  const links = sale.links ?? [];
  const saleLink = links.find((l) => /\/sales?\//.test(l.href ?? ''));
  if (saleLink?.href) {
    const m = saleLink.href.match(/\/sales?\/([^/?#]+)/);
    if (m?.[1]) return m[1];
  }

  if (eventType === 'PAYMENT.SALE.REVERSED' && sale.id) {
    return sale.id;
  }

  return null;
}

export function resolveRefundPaymentId(
  resource: Record<string, unknown>,
  eventType: string,
): string | null {
  if (eventType === 'PAYMENT.CAPTURE.REFUNDED' || eventType === 'PAYMENT.CAPTURE.REVERSED') {
    return resolveCaptureRefundPaymentId(resource);
  }

  if (eventType === 'PAYMENT.SALE.REFUNDED' || eventType === 'PAYMENT.SALE.REVERSED') {
    return resolveSaleRefundPaymentId(resource, eventType);
  }

  return null;
}

// ── Order Approved ──────────────────────────────────

export async function handleOrderApproved(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const paypalOrderId = resource.id as string;
  if (!paypalOrderId) return;

  const paypalConfig = await getPayPalRuntimeConfig();
  const token = await getPayPalToken(paypalConfig);
  if (!token) {
    throw new Error('Could not get PayPal token to capture order');
  }

  const captureRes = await fetch(
    `${paypalConfig.apiBase}/v2/checkout/orders/${paypalOrderId}/capture`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!captureRes.ok) {
    const errorText = await captureRes.text();
    throw new Error(`Failed to capture PayPal order: ${errorText}`);
  }

  console.log(`[Webhook] Captured PayPal order: ${paypalOrderId}`);
}

// ── Payment Captured ────────────────────────────────

export async function handlePaymentCaptured(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const parsed = paypalCaptureResourceSchema.safeParse(resource);
  const capture: PayPalCaptureResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };

  const customId = capture.custom_id;
  let meta: {
    guild_id: string;
    product_id: string;
    customer_id: string;
    discord_id: string;
  } | null = null;

  if (customId) {
    try {
      const raw = JSON.parse(customId);
      if (raw.g && raw.p && raw.c && raw.d) {
        meta = {
          guild_id: raw.g,
          product_id: raw.p,
          customer_id: raw.c,
          discord_id: raw.d,
        };
      } else {
        meta = raw;
      }
    } catch {
      /* ignore */
    }
  }

  if (
    !meta ||
    !isNonEmptyString(meta.guild_id) ||
    !isNonEmptyString(meta.product_id) ||
    !isNonEmptyString(meta.customer_id) ||
    !isNonEmptyString(meta.discord_id)
  ) {
    const captureId = resource.id as string | undefined;
    console.error(
      `[Webhook] Payment captured but custom_id is missing or malformed — ` +
        `captureId=${captureId ?? 'unknown'}, raw custom_id=${JSON.stringify(customId)}. ` +
        `Customer was charged but no order/entitlement was created. Manual reconciliation required.`,
    );
    throw new Error(
      `Payment captured without valid custom_id metadata (capture ${captureId})`,
    );
  }

  const paypalCaptureId = resource.id as string;
  if (!isNonEmptyString(paypalCaptureId)) {
    throw new Error('Payment capture is missing its provider id');
  }
  const paypalOrderId = capture.supplementary_data?.related_ids?.order_id;
  await requireExactCustomerIdentity(supabase, {
    customerId: meta.customer_id,
    guildId: meta.guild_id,
    expectedDiscordId: meta.discord_id,
    operation: 'Failed to validate captured payment customer',
  });

  // A resumed event first follows the capture's unique payment row back to
  // the exact order. Before the first successful payment insert, the order is
  // still pending and can be resolved from the signed checkout identities.
  const { data: existingPayment, error: existingPaymentError } = await supabase
    .from('payments')
    .select('order_id')
    .eq('paypal_payment_id', paypalCaptureId)
    .maybeSingle();
  requireSupabaseSuccess(existingPaymentError, 'Failed to inspect captured payment');
  const replayingExistingPayment = isNonEmptyString(existingPayment?.order_id);

  let order: CommerceOrderRow | null = null;
  if (existingPayment?.order_id) {
    const { data, error } = await supabase
      .from('orders')
      .select('id, order_number, customer_id, guild_id, product_id, plan_id, amount_cents, currency, status, grant_snapshot_frozen_at, paypal_order_id')
      .eq('id', existingPayment.order_id)
      .eq('guild_id', meta.guild_id)
      .maybeSingle();
    requireSupabaseSuccess(error, 'Failed to load captured order');
    order = data as CommerceOrderRow | null;
  } else {
    if (!isNonEmptyString(paypalOrderId)) {
      throw new Error(
        `Payment capture ${paypalCaptureId} is missing its PayPal order identity`,
      );
    }
    const { data, error } = await supabase
      .from('orders')
      .select('id, order_number, customer_id, guild_id, product_id, plan_id, amount_cents, currency, status, grant_snapshot_frozen_at, paypal_order_id')
      .eq('guild_id', meta.guild_id)
      .eq('customer_id', meta.customer_id)
      .eq('product_id', meta.product_id)
      .eq('paypal_order_id', paypalOrderId)
      .eq('status', 'pending')
      .maybeSingle();
    requireSupabaseSuccess(error, 'Failed to load pending captured order');
    order = data as CommerceOrderRow | null;
  }

  if (
    !order ||
    !isNonEmptyString(order.id) ||
    !isNonEmptyString(order.order_number) ||
    order.guild_id !== meta.guild_id ||
    order.customer_id !== meta.customer_id ||
    order.product_id !== meta.product_id ||
    !isNonEmptyString(order.paypal_order_id) ||
    (isNonEmptyString(paypalOrderId) && order.paypal_order_id !== paypalOrderId) ||
    !Number.isSafeInteger(order.amount_cents) ||
    !isNonEmptyString(order.currency)
  ) {
    throw new Error(`Captured payment ${paypalCaptureId} has no matching order identity`);
  }

  const amountCents = parseCapturedAmountToCents(capture.amount?.value);
  if (amountCents == null) {
    throw new Error(`Payment capture ${paypalCaptureId} has an invalid amount`);
  }
  const rawCaptureCurrency = capture.amount?.currency_code;
  if (!isNonEmptyString(rawCaptureCurrency) || !/^[A-Za-z]{3}$/.test(rawCaptureCurrency)) {
    throw new Error(`Payment capture ${paypalCaptureId} has an invalid currency`);
  }
  const captureCurrency = rawCaptureCurrency.toUpperCase();
  const amountMatches = amountCents === order.amount_cents
    && captureCurrency === order.currency.toUpperCase();

  const replayFinalization = replayingExistingPayment
    ? await finalizePayPalCapture(supabase, {
      order,
      paypalCaptureId,
      amountCents,
      currency: captureCurrency,
    })
    : null;
  if (replayFinalization) {
    if (replayFinalization.payment_created) {
      throw new Error('Capture replay unexpectedly created a payment');
    }
    if (shouldSkipCaptureFulfillment(replayFinalization, {
      order,
      amountCents,
      currency: captureCurrency,
    })) return;
    if (
      replayFinalization.order_status === 'completed'
      && order.status === 'completed'
      && order.grant_snapshot_frozen_at === null
    ) {
      console.info(
        `[Webhook] Exact legacy capture replay has no frozen grant snapshot; ` +
          `skipping fulfillment recovery for ${order.order_number}`,
      );
      return;
    }
  }

  // The finalizer requires the sold access contract to be frozen for both
  // completed and pending_review outcomes. A financial mismatch still must
  // not stage or release any fulfillment.
  const snapshot = await freezeOrderGrantSnapshot(supabase, order);
  const expected: FulfillmentExpectation = {
    idempotencyKey: `paypal:capture:${paypalCaptureId}:fulfill_purchase`,
    action: 'fulfill_purchase',
    guildId: order.guild_id,
    orderId: order.id,
    fulfillmentType: 'one_time_purchase',
    ...(amountMatches
      ? {
          payload: {
            fulfillment_type: 'one_time_purchase',
            guild_id: order.guild_id,
            customer_id: order.customer_id,
            discord_id: meta.discord_id,
            product_id: order.product_id,
            order_id: order.id,
            order_number: order.order_number,
            paypal_capture_id: paypalCaptureId,
            amount_cents: amountCents,
            currency: captureCurrency,
            granted_role_ids: snapshot.granted_role_ids_snapshot,
            granted_channel_ids: snapshot.granted_channel_ids_snapshot,
            temporary_role_grants: snapshot.temporary_role_grants_snapshot,
            entitlement_type: 'one_time',
          },
        }
      : {}),
  };
  let staged: FulfillmentQueueRow | null = null;
  if (amountMatches) {
    staged = await loadFulfillmentByIdempotencyKey(supabase, expected);
  }
  if (amountMatches && !staged) {
    const productName = await requireProductDisplayName(
      supabase,
      order.product_id,
      'Failed to load captured product display identity',
    );

    const { data: licenseConfig, error: licenseConfigError } = await supabase
      .from('product_license_config')
      .select('product_id')
      .eq('product_id', order.product_id)
      .maybeSingle();
    requireSupabaseSuccess(licenseConfigError, 'Failed to load product license configuration');

    const license = licenseConfig ? generateLicenseKey() : null;
    staged = await stageFulfillment(supabase, expected, {
      fulfillment_type: 'one_time_purchase',
      guild_id: order.guild_id,
      customer_id: order.customer_id,
      discord_id: meta.discord_id,
      product_id: order.product_id,
      product_name: productName,
      order_id: order.id,
      order_number: order.order_number,
      paypal_capture_id: paypalCaptureId,
      amount_cents: amountCents,
      currency: captureCurrency,
      granted_role_ids: snapshot.granted_role_ids_snapshot,
      granted_channel_ids: snapshot.granted_channel_ids_snapshot,
      temporary_role_grants: snapshot.temporary_role_grants_snapshot,
      ...(license
        ? {
            license_key_id: crypto.randomUUID(),
            license_key_plaintext: license.plaintext,
          }
        : {}),
      entitlement_type: 'one_time',
    });
  }

  // The sold grant contract is frozen before every first finalization. Exact
  // payments additionally have an immutable grant/license payload durably
  // staged; mismatches have no queue row and can only become pending_review.
  const finalization = replayFinalization ?? await finalizePayPalCapture(supabase, {
    order,
    paypalCaptureId,
    amountCents,
    currency: captureCurrency,
  });
  if (shouldSkipCaptureFulfillment(finalization, {
    order,
    amountCents,
    currency: captureCurrency,
  })) return;
  if (!staged) throw new Error('Completed capture has no staged grant snapshot');

  await ensureStagedLicenseKey(supabase, order, staged.payload);
  await releaseStagedFulfillment(supabase, staged);

  console.log(
    `[Webhook] Order completed + fulfillment queued: ${order.order_number} for ${meta.discord_id}`,
  );
}

// ── Subscription Activated ──────────────────────────

export async function handleSubscriptionActivated(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const parsed = paypalCaptureResourceSchema.safeParse(resource);
  const capture: PayPalCaptureResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };
  const customId = capture.custom_id;
  if (!customId) throw new Error('Subscription activation is missing custom_id');

  let meta: {
    guild_id: string;
    product_id: string;
    plan_id: string;
    customer_id: string;
    discord_id: string;
  };
  try {
    const raw = JSON.parse(customId);
    if (raw.g && raw.p && raw.c && raw.d) {
      meta = {
        guild_id: raw.g,
        product_id: raw.p,
        plan_id: raw.pl ?? raw.plan_id ?? '',
        customer_id: raw.c,
        discord_id: raw.d,
      };
    } else {
      meta = raw;
    }
  } catch {
    throw new Error('Subscription activation has malformed custom_id');
  }

  if (
    !isNonEmptyString(meta.guild_id) ||
    !isNonEmptyString(meta.product_id) ||
    !isNonEmptyString(meta.plan_id) ||
    !isNonEmptyString(meta.customer_id) ||
    !isNonEmptyString(meta.discord_id)
  ) {
    throw new Error('Subscription activation has malformed custom_id');
  }

  const subscriptionId = resource.id as string;
  if (!isNonEmptyString(subscriptionId)) throw new Error('Subscription activation has no provider id');
  await requireExactCustomerIdentity(supabase, {
    customerId: meta.customer_id,
    guildId: meta.guild_id,
    expectedDiscordId: meta.discord_id,
    operation: 'Failed to validate subscription customer',
  });

  const { data: existingOrder, error: existingOrderError } = await supabase
    .from('orders')
    .select('id, order_number, customer_id, guild_id, product_id, plan_id, amount_cents, currency, status, grant_snapshot_frozen_at, paypal_subscription_id')
    .eq('paypal_subscription_id', subscriptionId)
    .eq('guild_id', meta.guild_id)
    .maybeSingle();
  requireSupabaseSuccess(existingOrderError, 'Failed to inspect subscription order');

  let order = existingOrder as CommerceOrderRow | null;
  if (
    order && (
      !isNonEmptyString(order.id) ||
      !isNonEmptyString(order.order_number) ||
      order.guild_id !== meta.guild_id ||
      order.customer_id !== meta.customer_id ||
      order.product_id !== meta.product_id ||
      order.plan_id !== meta.plan_id ||
      order.paypal_subscription_id !== subscriptionId ||
      !['pending', 'completed'].includes(order.status)
    )
  ) {
    throw new Error('Subscription order failed identity validation');
  }

  let firstProviderContract: AuthoritativeSubscriptionContract | null = null;
  let prevalidatedProviderPlanId: string | null = null;

  if (!order) {
    firstProviderContract = await requireAuthoritativeSubscriptionAmount(subscriptionId);
    await requireExactSubscriptionPlan(supabase, {
      planId: meta.plan_id,
      guildId: meta.guild_id,
      productId: meta.product_id,
      providerPlanId: firstProviderContract.providerPlanId,
    });
    prevalidatedProviderPlanId = firstProviderContract.providerPlanId;
    const { data, error } = await supabase
      .from('orders')
      .insert({
        order_number: `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
        customer_id: meta.customer_id,
        guild_id: meta.guild_id,
        product_id: meta.product_id,
        plan_id: meta.plan_id,
        paypal_subscription_id: subscriptionId,
        amount_cents: firstProviderContract.amountCents,
        currency: firstProviderContract.currency,
        status: 'pending',
        source: 'purchase',
      })
      .select('id, order_number, customer_id, guild_id, product_id, plan_id, amount_cents, currency, status, grant_snapshot_frozen_at, paypal_subscription_id')
      .single();
    requireSupabaseSuccess(error, 'Failed to create subscription order');
    order = data as CommerceOrderRow | null;
  }

  if (
    !order ||
    !isNonEmptyString(order.id) ||
    !isNonEmptyString(order.order_number) ||
    order.guild_id !== meta.guild_id ||
    order.customer_id !== meta.customer_id ||
    order.product_id !== meta.product_id ||
    order.plan_id !== meta.plan_id ||
    order.paypal_subscription_id !== subscriptionId ||
    !['pending', 'completed'].includes(order.status)
  ) {
    throw new Error('Subscription order failed identity validation');
  }

  const baseExpectation: FulfillmentExpectation = {
    idempotencyKey: `paypal:subscription:${subscriptionId}:fulfill_subscription`,
    action: 'fulfill_subscription',
    guildId: order.guild_id,
    orderId: order.id,
    fulfillmentType: 'subscription_activated',
  };
  let staged = await loadFulfillmentByIdempotencyKey(supabase, baseExpectation);
  let financial: FinancialAmount;
  let providerPlanId: string;
  let pendingFinancialUpdate: FinancialAmount | null = null;
  if (!staged && order.status === 'completed') {
    financial = parseFinancialAmount(
      order.amount_cents,
      order.currency,
      'Completed subscription order',
    );
    const providerContract = firstProviderContract ??
      await requireAuthoritativeSubscriptionAmount(subscriptionId);
    if (
      providerContract.amountCents !== financial.amountCents ||
      providerContract.currency !== financial.currency
    ) {
      throw new Error('Completed subscription order disagrees with PayPal financial state');
    }
    providerPlanId = providerContract.providerPlanId;
  } else if (!staged) {
    // Every first/pending activation is checked against PayPal. A provider
    // outage is retryable; silently trusting a local plan price can grant a
    // subscription whose provider amount has diverged.
    const providerContract = firstProviderContract ??
      await requireAuthoritativeSubscriptionAmount(subscriptionId);
    financial = providerContract;
    providerPlanId = providerContract.providerPlanId;
    if (
      order.amount_cents !== financial.amountCents ||
      order.currency !== financial.currency
    ) {
      // Checkout freezes the access snapshot before exposing the PayPal link.
      // The database trigger therefore permits this one narrow post-freeze
      // correction while the exact subscription order is still pending:
      // amount/currency only, with every identity and grant field unchanged.
      // The compare-and-update below makes a concurrent lifecycle change a
      // retryable failure instead of overwriting it.
      pendingFinancialUpdate = financial;
    }
  } else {
    financial = parseFinancialAmount(
      staged.payload.amount_cents,
      staged.payload.currency,
      'Staged subscription fulfillment',
    );
    if (
      financial.amountCents !== order.amount_cents ||
      financial.currency !== order.currency
    ) {
      throw new Error('Staged subscription fulfillment disagrees with the order financial state');
    }
    const stagedProviderPlanId = staged.payload.paypal_plan_id;
    if (!isNonEmptyString(stagedProviderPlanId)) {
      throw new Error('Staged subscription fulfillment has malformed provider plan identity');
    }
    providerPlanId = stagedProviderPlanId;
  }

  const trustFrozenOrderContract = isNonEmptyString(order.grant_snapshot_frozen_at);
  const hasDurableGrantContract = trustFrozenOrderContract || staged !== null;
  const completedLegacyNoGrantContract =
    order.status === 'completed' && !hasDurableGrantContract;
  // A frozen order or its already-staged outbox payload is the sold contract.
  // Current catalog ownership or plan attachment may legitimately have moved
  // after checkout. A completed legacy row with no durable grant contract is
  // also never re-authorized against today's catalog: exact customer, order,
  // subscription, local plan, and PayPal financial identities were validated
  // above, and this branch can only no-op without creating access.
  if (
    !hasDurableGrantContract
    && !completedLegacyNoGrantContract
    && prevalidatedProviderPlanId !== providerPlanId
  ) {
    await requireExactSubscriptionPlan(supabase, {
      planId: meta.plan_id,
      guildId: order.guild_id,
      productId: order.product_id,
      providerPlanId,
    });
  }

  if (pendingFinancialUpdate) {
    const { data: pricedOrder, error: priceError } = await supabase
      .from('orders')
      .update({
        amount_cents: pendingFinancialUpdate.amountCents,
        currency: pendingFinancialUpdate.currency,
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id)
      .eq('guild_id', order.guild_id)
      .eq('status', 'pending')
      .eq('amount_cents', order.amount_cents)
      .eq('currency', order.currency)
      .select('id')
      .maybeSingle();
    requireSupabaseSuccess(priceError, 'Failed to persist subscription billing amount');
    if (!pricedOrder) throw new Error('Subscription billing amount update lost its state race');
    order.amount_cents = pendingFinancialUpdate.amountCents;
    order.currency = pendingFinancialUpdate.currency;
  }

  if (completedLegacyNoGrantContract) {
    // Legacy completed orders predate immutable grant snapshots. Their exact
    // PayPal subscription, customer, order, local-plan metadata, and financial
    // identities have already been validated above, but freezing now would
    // either fail (the RPC only accepts pending orders) or grant today's
    // mutable product configuration.
    console.info(
      `[Webhook] Exact legacy subscription replay has no durable grant contract; ` +
        `skipping fulfillment recovery for ${order.order_number}`,
    );
    return;
  }

  const snapshot = !trustFrozenOrderContract && staged
    // A staged row written before completion is recoverable only after the
    // database locks it with the completed legacy order, validates every
    // identity/financial/grant field, and persists an immutable contract that
    // the bot can independently require. Current catalog grants are never read.
    ? await adoptLegacySubscriptionGrantContract(supabase, order, staged)
    : await freezeOrderGrantSnapshot(supabase, order);
  const expected: FulfillmentExpectation = {
    ...baseExpectation,
    payload: {
      fulfillment_type: 'subscription_activated',
      guild_id: order.guild_id,
      customer_id: order.customer_id,
      discord_id: meta.discord_id,
      product_id: order.product_id,
      order_id: order.id,
      order_number: order.order_number,
      paypal_subscription_id: subscriptionId,
      plan_id: meta.plan_id,
      paypal_plan_id: providerPlanId,
      granted_role_ids: snapshot.granted_role_ids_snapshot,
      granted_channel_ids: snapshot.granted_channel_ids_snapshot,
      temporary_role_grants: undefined,
      license_key_id: undefined,
      license_key_plaintext: undefined,
      entitlement_type: 'subscription',
    },
  };
  if (staged) staged = validateQueueRow(staged, expected);

  if (!staged) {
    const productName = await requireProductDisplayName(
      supabase,
      order.product_id,
      'Failed to load subscription product display identity',
    );

    staged = await stageFulfillment(supabase, expected, {
      fulfillment_type: 'subscription_activated',
      guild_id: order.guild_id,
      customer_id: order.customer_id,
      discord_id: meta.discord_id,
      product_id: order.product_id,
      product_name: productName,
      order_id: order.id,
      order_number: order.order_number,
      paypal_subscription_id: subscriptionId,
      plan_id: meta.plan_id,
      paypal_plan_id: providerPlanId,
      amount_cents: financial.amountCents,
      currency: financial.currency,
      granted_role_ids: snapshot.granted_role_ids_snapshot,
      granted_channel_ids: snapshot.granted_channel_ids_snapshot,
      entitlement_type: 'subscription',
    });
  }

  const stagedFinancial = parseFinancialAmount(
    staged.payload.amount_cents,
    staged.payload.currency,
    'Staged subscription fulfillment',
  );
  if (
    stagedFinancial.amountCents !== financial.amountCents ||
    stagedFinancial.currency !== financial.currency
  ) {
    throw new Error('Staged subscription fulfillment changed financial identity');
  }

  if (order.status === 'pending') {
    const { data: completedOrder, error: completeError } = await supabase
      .from('orders')
      .update({
        status: 'completed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id)
      .eq('guild_id', order.guild_id)
      .eq('status', 'pending')
      .eq('amount_cents', financial.amountCents)
      .eq('currency', financial.currency)
      .select('id')
      .maybeSingle();
    requireSupabaseSuccess(completeError, 'Failed to complete subscription order');
    if (!completedOrder) throw new Error('Subscription order completion lost its state race');
  }

  await releaseStagedFulfillment(supabase, staged);

  console.log(
    `[Webhook] Subscription activated + fulfillment queued: ${subscriptionId} for ${meta.discord_id}`,
  );
}

// ── Subscription Cancelled ──────────────────────────

export interface SubscriptionQueueOptions {
  retryingFailedEvent?: boolean;
  /** Webhook event id — stamped into the fulfillment payload for retry dedupe. */
  webhookEventId?: string;
}

export async function handleSubscriptionCancelled(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: SubscriptionQueueOptions = {},
) {
  const subscriptionId = resource.id;
  if (!isNonEmptyString(subscriptionId)) {
    throw new Error('Subscription cancellation has no provider id');
  }
  const { order, product, customer } = await loadSubscriptionLifecycleContext(
    supabase,
    subscriptionId,
    'Subscription cancellation',
  );

  // W2 codex round 2: on a resumed retry the failed attempt may already have
  // queued this fulfillment — don't queue a duplicate (double DM / event).
  if (options.retryingFailedEvent) {
    const alreadyQueued = await hasQueuedOrderFulfillment(supabase, {
      guildId: order.guild_id,
      action: 'fulfill_cancellation',
      orderId: order.id,
      fulfillmentType: 'subscription_cancelled',
      webhookEventId: options.webhookEventId,
    });
    if (alreadyQueued) {
      console.info(
        `[Webhook] Subscription cancellation fulfillment already queued for ${subscriptionId}, skipping duplicate`,
      );
      return;
    }
  }

  const queued = await queueFulfillment(supabase, 'fulfill_cancellation', order.guild_id, {
    fulfillment_type: 'subscription_cancelled',
    guild_id: order.guild_id,
    customer_id: order.customer_id,
    discord_id: customer.discord_id,
    product_id: order.product_id,
    product_name: product.name,
    order_id: order.id,
    order_number: order.order_number,
    amount_cents: 0,
    currency: 'USD',
    granted_role_ids: [],
    granted_channel_ids: [],
    entitlement_type: 'subscription',
    ...(options.webhookEventId ? { webhook_event_id: options.webhookEventId } : {}),
  });
  // W2: a failed queue insert used to be logged and swallowed — the
  // cancellation (and the bot-side entitlement revocation it drives) was
  // silently lost. Throw so the webhook records an error and PayPal's
  // redelivery re-processes it (BILLING.SUBSCRIPTION.CANCELLED is in
  // RESUMABLE_FAILED_EVENT_TYPES); the bot-side revoke is a no-op for
  // already-revoked entitlements, so a retry cannot double-revoke.
  if (!queued) {
    throw new Error('Failed to queue subscription cancellation fulfillment');
  }

  console.log(
    `[Webhook] Subscription cancelled + fulfillment queued: ${subscriptionId}`,
  );
}

// ── Subscription Expired ────────────────────────────

export async function handleSubscriptionExpired(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: { retryingFailedEvent?: boolean } = {},
) {
  const subscriptionId = resource.id;
  if (!isNonEmptyString(subscriptionId)) {
    throw new Error('Subscription expiry has no provider id');
  }

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, order_number, guild_id, customer_id, product_id, plan_id, status, paypal_subscription_id')
    .eq('paypal_subscription_id', subscriptionId)
    .maybeSingle();

  requireSupabaseSuccess(orderError, 'Failed to load expired subscription order');
  if (
    !order ||
    !isNonEmptyString(order.id) ||
    !isNonEmptyString(order.order_number) ||
    !isNonEmptyString(order.guild_id) ||
    !isNonEmptyString(order.customer_id) ||
    !isNonEmptyString(order.product_id) ||
    !isNonEmptyString(order.status) ||
    order.paypal_subscription_id !== subscriptionId
  ) {
    throw new Error('Expired subscription order identity mismatch');
  }

  const now = new Date().toISOString();
  const entitlementLookupStatuses = options.retryingFailedEvent
    ? EXPIRY_RETRY_ENTITLEMENT_STATUSES
    : EXPIRABLE_ENTITLEMENT_STATUSES;
  const licenseKeyLookupStatuses = options.retryingFailedEvent
    ? ['pending_activation', 'active', 'suspended', 'expired']
    : ['pending_activation', 'active', 'suspended'];

  const activeEntitlements = await fetchAllLifecycleRowsById<EntitlementLifecycleRow>(
    async (afterId) => {
      let query = supabase
        .from('entitlements')
        .select('id, license_key_id')
        .eq('order_id', order.id)
        .eq('guild_id', order.guild_id)
        .eq('product_id', order.product_id)
        .in('status', entitlementLookupStatuses)
        .order('id', { ascending: true })
        .limit(LIFECYCLE_SCAN_PAGE_SIZE);
      if (afterId !== null) query = query.gt('id', afterId);
      return await query as {
        data: EntitlementLifecycleRow[] | null;
        error: unknown;
      };
    },
    'Failed to load active entitlements for subscription expiry',
  );

  const activeLicenseKeys = await fetchAllLifecycleRowsById<LicenseKeyLifecycleRow>(
    async (afterId) => {
      let query = supabase
        .from('license_keys')
        .select('id')
        .eq('order_id', order.id)
        .eq('guild_id', order.guild_id)
        .eq('product_id', order.product_id)
        .in('status', licenseKeyLookupStatuses)
        .order('id', { ascending: true })
        .limit(LIFECYCLE_SCAN_PAGE_SIZE);
      if (afterId !== null) query = query.gt('id', afterId);
      return await query as {
        data: LicenseKeyLifecycleRow[] | null;
        error: unknown;
      };
    },
    'Failed to load active license keys for subscription expiry',
  );

  const licenseKeyIds = [
    ...new Set([
      ...(activeEntitlements ?? [])
        .map((ent) => ent.license_key_id)
        .filter((id): id is string => Boolean(id)),
      ...(activeLicenseKeys ?? [])
        .map((key) => key.id)
        .filter((id): id is string => Boolean(id)),
    ]),
  ];

  // This terminal status transition atomically enqueues identity-rich
  // revoke_roles rows through commerce_entitlements_enqueue_role_revocation.
  // Do not add a second payload-only queue row here: it would bypass the
  // trigger's shared-owner/re-activation safety.
  const { error: expireEntitlementsError } = await supabase
    .from('entitlements')
    .update({
      status: 'expired',
      expires_at: now,
      grace_period_ends_at: null,
      updated_at: now,
    })
    .eq('order_id', order.id)
    .eq('guild_id', order.guild_id)
    .eq('product_id', order.product_id)
    .in('status', EXPIRABLE_ENTITLEMENT_STATUSES);
  requireSupabaseSuccess(
    expireEntitlementsError,
    'Failed to expire entitlements for subscription expiry',
  );

  // W2 codex round 2: EXPIRABLE_ENTITLEMENT_STATUSES includes 'grace_period',
  // so this expiry is a terminal transition for a row that suspend() may have
  // left an 'entitlement_grace_period' operator alert open on. revoke() and
  // the reconciliation sweep resolve that alert on their terminal writes; this
  // direct webhook expiry bypassed both. Resolve it with the same
  // entitlement-scoped, entitlement_grace_period filter (no-op when none open).
  // Non-fatal: the entitlement expiry above has already committed.
  const expiryGraceAlertEntitlementIds = (activeEntitlements ?? []).map((ent) => ent.id);
  if (expiryGraceAlertEntitlementIds.length > 0) {
    const { error: expireGraceAlertError } = await supabase
      .from('alerts')
      .update({ resolved: true, resolved_at: now, updated_at: now })
      .eq('guild_id', order.guild_id)
      .eq('alert_type', 'entitlement_grace_period')
      .in('metadata->>entitlement_id', expiryGraceAlertEntitlementIds)
      .eq('resolved', false);
    if (expireGraceAlertError) {
      console.error(
        '[Webhook] Failed to resolve grace-period alerts for subscription expiry:',
        formatSupabaseError(expireGraceAlertError),
      );
    }
  }

  const { error: expireLicenseKeysError } = await supabase
    .from('license_keys')
    .update({
      status: 'expired',
      expires_at: now,
      updated_at: now,
    })
    .eq('order_id', order.id)
    .eq('guild_id', order.guild_id)
    .eq('product_id', order.product_id)
    .in('status', ['pending_activation', 'active', 'suspended']);
  requireSupabaseSuccess(
    expireLicenseKeysError,
    'Failed to expire license keys for subscription expiry',
  );

  if (licenseKeyIds.length > 0) {
    const { error: deactivateSessionsError } = await supabase
      .from('license_sessions')
      .update({
        active: false,
        deactivated_at: now,
        deactivation_reason: 'entitlement_revoked',
      })
      .in('license_key_id', licenseKeyIds)
      .eq('active', true);
    requireSupabaseSuccess(
      deactivateSessionsError,
      'Failed to deactivate license sessions for subscription expiry',
    );
  }

  const hadActiveAccess =
    (activeEntitlements?.length ?? 0) > 0 || licenseKeyIds.length > 0;

  if (hadActiveAccess) {
    const customer = await requireExactCustomerIdentity(supabase, {
      customerId: order.customer_id,
      guildId: order.guild_id,
      operation: 'Failed to load customer for subscription expiry fulfillment',
    });
    let shouldQueueAuditEvent = true;
    if (options.retryingFailedEvent) {
      shouldQueueAuditEvent = !(await hasQueuedSubscriptionExpiredAuditEvent(
        supabase,
        {
          guildId: order.guild_id,
          discordId: customer.discord_id,
          orderId: order.id,
          productId: order.product_id,
        },
      ));
    }

    if (shouldQueueAuditEvent) {
      const queued = await queueFulfillment(supabase, 'emit_audit_event', order.guild_id, {
        event_type: 'subscription.expired',
        event_data: {
          discordId: customer.discord_id,
          orderId: order.id,
          productId: order.product_id,
          planId: order.plan_id ?? '',
          status: 'expired',
        },
      });
      if (!queued) {
        throw new Error('Failed to queue subscription expired audit event');
      }
    }
  }

  await supabase
    .from('audit_logs')
    .insert({
      guild_id: order.guild_id,
      actor_type: 'system',
      actor_id: 'paypal_webhook',
      action: 'subscription.expired',
      target_type: 'order',
      target_id: order.id,
      details: {
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        paypal_subscription_id: subscriptionId,
        product_id: order.product_id,
        entitlement_ids: (activeEntitlements ?? []).map((ent) => ent.id),
        license_key_ids: licenseKeyIds,
        role_revocation_source: 'entitlement_status_trigger',
      },
    })
    .then(
      () => {},
      () => {
        /* ignore */
      },
    );

  console.log(
    `[Webhook] Subscription expired + product access expired: ${subscriptionId}`,
  );
}

// ── Subscription Suspended ──────────────────────────

export async function handleSubscriptionSuspended(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: SubscriptionQueueOptions = {},
) {
  const subscriptionId = resource.id;
  if (!isNonEmptyString(subscriptionId)) {
    throw new Error('Subscription suspension has no provider id');
  }
  const { order, product, customer } = await loadSubscriptionLifecycleContext(
    supabase,
    subscriptionId,
    'Subscription suspension',
  );

  // W2 codex round 2: same retry dedupe as handleSubscriptionCancelled.
  if (options.retryingFailedEvent) {
    const alreadyQueued = await hasQueuedOrderFulfillment(supabase, {
      guildId: order.guild_id,
      action: 'fulfill_suspension',
      orderId: order.id,
      fulfillmentType: 'subscription_suspended',
      webhookEventId: options.webhookEventId,
    });
    if (alreadyQueued) {
      console.info(
        `[Webhook] Subscription suspension fulfillment already queued for ${subscriptionId}, skipping duplicate`,
      );
      return;
    }
  }

  const queued = await queueFulfillment(supabase, 'fulfill_suspension', order.guild_id, {
    fulfillment_type: 'subscription_suspended',
    guild_id: order.guild_id,
    customer_id: order.customer_id,
    discord_id: customer.discord_id,
    product_id: order.product_id,
    product_name: product.name,
    order_id: order.id,
    order_number: order.order_number,
    amount_cents: 0,
    currency: 'USD',
    granted_role_ids: [],
    granted_channel_ids: [],
    entitlement_type: 'subscription',
    ...(options.webhookEventId ? { webhook_event_id: options.webhookEventId } : {}),
  });
  // W2: same reasoning as handleSubscriptionCancelled — losing this insert
  // silently means the entitlement never enters its grace period. The
  // bot-side suspend targets 'active' entitlements only, so retries are safe
  // (BILLING.SUBSCRIPTION.SUSPENDED / .PAYMENT.FAILED are in
  // RESUMABLE_FAILED_EVENT_TYPES).
  if (!queued) {
    throw new Error('Failed to queue subscription suspension fulfillment');
  }

  console.log(
    `[Webhook] Subscription suspended + fulfillment queued: ${subscriptionId}`,
  );
}

// ── Subscription Payment ────────────────────────────

export async function handleSubscriptionPayment(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const parsed = paypalSaleResourceSchema.safeParse(resource);
  if (!parsed.success) throw new Error('Subscription payment payload is malformed');
  const sale: PayPalSaleResource = parsed.data;
  const providerPaymentId = sale.id;
  const billingAgreementId = sale.billing_agreement_id;
  const amountCents = parseCapturedAmountToCents(sale.amount?.total);
  const rawCurrency = sale.amount?.currency;
  if (
    !isNonEmptyString(providerPaymentId) ||
    !isNonEmptyString(billingAgreementId) ||
    amountCents == null ||
    !isNonEmptyString(rawCurrency) ||
    !/^[A-Za-z]{3}$/.test(rawCurrency)
  ) {
    throw new Error('Subscription payment provider identity or amount is malformed');
  }
  const currency = rawCurrency.toUpperCase();

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, customer_id, guild_id, status, paypal_subscription_id')
    .eq('paypal_subscription_id', billingAgreementId)
    .maybeSingle();
  requireSupabaseSuccess(orderError, 'Failed to load subscription payment order');
  if (
    !order ||
    !isNonEmptyString(order.id) ||
    !isNonEmptyString(order.customer_id) ||
    !isNonEmptyString(order.guild_id) ||
    order.paypal_subscription_id !== billingAgreementId
  ) {
    throw new Error('Subscription payment order identity mismatch');
  }

  const expectedPayment = {
    order_id: order.id,
    customer_id: order.customer_id,
    guild_id: order.guild_id,
    paypal_payment_id: providerPaymentId,
    amount_cents: amountCents,
    currency,
    status: 'completed',
  };
  const validatePayment = (
    data: unknown,
    allowSuccessorState = false,
  ): 'completed' | 'refunded' | 'reversed' => {
    if (!data || typeof data !== 'object') {
      throw new Error('Subscription payment persistence returned no row');
    }
    const row = data as Record<string, unknown>;
    const validStatus = row.status === expectedPayment.status
      || (allowSuccessorState && (row.status === 'refunded' || row.status === 'reversed'));
    if (
      !isNonEmptyString(row.id) ||
      row.order_id !== expectedPayment.order_id ||
      row.customer_id !== expectedPayment.customer_id ||
      row.guild_id !== expectedPayment.guild_id ||
      row.paypal_payment_id !== expectedPayment.paypal_payment_id ||
      row.amount_cents !== expectedPayment.amount_cents ||
      row.currency !== expectedPayment.currency ||
      !validStatus
    ) {
      throw new Error('Subscription payment persistence identity mismatch');
    }
    return row.status as 'completed' | 'refunded' | 'reversed';
  };

  const { data: insertedPayment, error: insertError } = await supabase
    .from('payments')
    .insert(expectedPayment)
    .select('id, order_id, customer_id, guild_id, paypal_payment_id, amount_cents, currency, status')
    .single();
  if (insertError) {
    if (!isUniqueViolation(insertError)) {
      throw new Error(`Failed to persist subscription payment: ${formatSupabaseError(insertError)}`);
    }
    const { data: existingPayment, error: existingError } = await supabase
      .from('payments')
      .select('id, order_id, customer_id, guild_id, paypal_payment_id, amount_cents, currency, status')
      .eq('paypal_payment_id', providerPaymentId)
      .maybeSingle();
    requireSupabaseSuccess(existingError, 'Failed to inspect replayed subscription payment');
    const replayStatus = validatePayment(existingPayment, true);
    if (replayStatus !== 'completed') {
      const validSuccessorOrderState = replayStatus === 'refunded'
        ? order.status === 'refunded'
        : order.status === 'refunded' || order.status === 'disputed';
      if (!validSuccessorOrderState) {
        throw new Error('Subscription payment successor state mismatch');
      }
      console.info(
        `[Webhook] Subscription payment replay preserved successor state ${replayStatus}; ` +
          `skipping persistence for ${providerPaymentId}`,
      );
      return;
    }
  } else {
    validatePayment(insertedPayment);
  }

  console.log(`[Webhook] Subscription payment recorded: ${providerPaymentId}`);
}

// ── Capture Refunded / Reversed ─────────────────────

export interface RefundHandlerOptions {
  retryingFailedEvent?: boolean;
}

export async function handleCaptureRefunded(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  eventType: string,
  options: RefundHandlerOptions = {},
) {
  const captureId = resolveCaptureRefundPaymentId(resource);

  if (!captureId) {
    console.error(
      `[Webhook] ${eventType} arrived without a recoverable capture_id — payload:`,
      JSON.stringify(resource).slice(0, 500),
    );
    return;
  }

  await handleExternalPaymentRefunded(
    supabase,
    captureId,
    eventType,
    'capture_id',
    resource,
    options,
  );
}

// ── Subscription Sale Refunded / Reversed ───────────

export async function handleSaleRefunded(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  eventType: string,
  options: RefundHandlerOptions = {},
) {
  const saleId = resolveSaleRefundPaymentId(resource, eventType);

  if (!saleId) {
    console.error(
      `[Webhook] ${eventType} arrived without a recoverable sale_id — payload:`,
      JSON.stringify(resource).slice(0, 500),
    );
    return;
  }

  await handleExternalPaymentRefunded(
    supabase,
    saleId,
    eventType,
    'sale_id',
    resource,
    options,
  );
}

// ── Refund semantics (W2) ───────────────────────────

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === '23505',
  );
}

/**
 * Parse a PayPal money string ("10.00", or "-5.00" — v1 sale refund events
 * report the refund amount as a negative delta) into non-negative cents.
 */
function parseAmountToCents(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.abs(Math.round(parsed * 100));
}

interface RefundAmountInfo {
  /** Amount of THIS refund event, in cents (null = missing/unparseable). */
  refundAmountCents: number | null;
  refundCurrency: string | null;
  /** PayPal's cumulative refunded total for the parent capture/sale. */
  paypalTotalRefundedCents: number | null;
  /**
   * Currency of PayPal's cumulative refunded total. PayPal issues refunds in
   * the parent sale's currency, so this is the payload's own statement of the
   * sale's actual currency — used to tolerate legacy payments rows whose
   * currency label was persisted as a hardcoded 'USD'.
   */
  paypalTotalRefundedCurrency: string | null;
}

function resolveRefundAmounts(
  resource: Record<string, unknown>,
  eventType: string,
): RefundAmountInfo {
  if (eventType.startsWith('PAYMENT.CAPTURE.')) {
    const parsed = paypalCaptureResourceSchema.safeParse(resource);
    if (!parsed.success) {
      return {
        refundAmountCents: null,
        refundCurrency: null,
        paypalTotalRefundedCents: null,
        paypalTotalRefundedCurrency: null,
      };
    }
    return {
      refundAmountCents: parseAmountToCents(parsed.data.amount?.value),
      refundCurrency: parsed.data.amount?.currency_code ?? null,
      paypalTotalRefundedCents: parseAmountToCents(
        parsed.data.seller_payable_breakdown?.total_refunded_amount?.value,
      ),
      paypalTotalRefundedCurrency:
        parsed.data.seller_payable_breakdown?.total_refunded_amount?.currency_code ?? null,
    };
  }

  const parsed = paypalSaleResourceSchema.safeParse(resource);
  if (!parsed.success) {
    return {
      refundAmountCents: null,
      refundCurrency: null,
      paypalTotalRefundedCents: null,
      paypalTotalRefundedCurrency: null,
    };
  }
  return {
    refundAmountCents: parseAmountToCents(parsed.data.amount?.total),
    refundCurrency: parsed.data.amount?.currency ?? null,
    paypalTotalRefundedCents: parseAmountToCents(parsed.data.total_refunded_amount?.value),
    paypalTotalRefundedCurrency: parsed.data.total_refunded_amount?.currency ?? null,
  };
}

type FullRefundReason =
  | 'reversal'
  | 'unparseable_amount'
  | 'currency_mismatch'
  | 'no_payment_baseline'
  | 'cumulative_total';

type RefundScope = { kind: 'full'; reason: FullRefundReason } | { kind: 'partial' };

/**
 * Decide whether a refund event revokes access (full) or is flagged for
 * operator review (partial). Every ambiguous case resolves to FULL — the
 * merchant-safe default (money left, so access goes) that also matches the
 * pre-W2 behavior:
 *   - .REVERSED events are chargebacks/reversals — always full.
 *   - Unparseable/missing amounts can't be compared — full.
 *   - A refund in a different currency can't be compared — full, EXCEPT for
 *     legacy mislabeled subscription payments (see below).
 *   - A payment recorded with amount_cents <= 0 (e.g. a subscription sale
 *     whose amount lookup failed) has no baseline — full.
 * Otherwise the cumulative refunded total (max of PayPal's authoritative
 * total and the locally recorded payment_refunds sum) decides.
 *
 * Legacy tolerance (W2 codex round 2): handleSubscriptionPayment used to
 * persist a hardcoded 'USD' currency label while amount_cents was parsed
 * from the sale payload in the plan's actual currency — the recorded CENTS
 * are right, only the label is wrong. PayPal always issues refunds in the
 * parent sale's currency, so when a PAYMENT.SALE.* refund against a
 * USD-labeled payment carries a signature-verified payload whose cumulative
 * refunded total is in the refund's own currency, the payload — not our
 * label — is authoritative and the cents comparison remains valid. Capture
 * refunds keep the strict fail-safe: their payments rows were always
 * persisted with the checkout currency.
 */
function classifyRefundScope(input: {
  eventType: string;
  paymentAmountCents: number | null;
  paymentCurrency: string | null;
  refundAmountCents: number | null;
  refundCurrency: string | null;
  paypalTotalRefundedCurrency: string | null;
  cumulativeRefundedCents: number;
}): RefundScope {
  if (input.eventType.endsWith('.REVERSED')) {
    return { kind: 'full', reason: 'reversal' };
  }
  if (input.refundAmountCents == null) {
    return { kind: 'full', reason: 'unparseable_amount' };
  }
  if (
    input.refundCurrency &&
    input.paymentCurrency &&
    input.refundCurrency.toUpperCase() !== input.paymentCurrency.toUpperCase()
  ) {
    const legacyMislabeledSalePayment =
      input.eventType.startsWith('PAYMENT.SALE.') &&
      input.paymentCurrency.toUpperCase() === 'USD' &&
      input.paypalTotalRefundedCurrency != null &&
      input.paypalTotalRefundedCurrency.toUpperCase() === input.refundCurrency.toUpperCase();
    if (!legacyMislabeledSalePayment) {
      return { kind: 'full', reason: 'currency_mismatch' };
    }
  }
  if (typeof input.paymentAmountCents !== 'number' || input.paymentAmountCents <= 0) {
    return { kind: 'full', reason: 'no_payment_baseline' };
  }
  if (input.cumulativeRefundedCents >= input.paymentAmountCents) {
    return { kind: 'full', reason: 'cumulative_total' };
  }
  return { kind: 'partial' };
}

function formatCents(cents: number | null, currency: string | null): string {
  if (cents == null) return 'an unknown amount';
  return `${(cents / 100).toFixed(2)} ${currency ?? ''}`.trim();
}

/**
 * PAYMENT.CAPTURE.REFUNDED / .REVERSED and PAYMENT.SALE.REFUNDED / .REVERSED.
 *
 * W2 semantics:
 *  - FULL refund/reversal → revoke entitlements, license keys and their
 *    active license sessions, and write the audit trail. The entitlement
 *    status trigger atomically owns Discord role-revocation enqueueing. The
 *    payments.status flip to refunded/reversed happens LAST:
 *    it is the commit marker the replay guard keys off, so a crash mid-way
 *    leaves the event retryable instead of half-revoked-but-skipped.
 *  - PARTIAL refund → access is NOT auto-revoked. The refund is recorded,
 *    an operator-review alert is raised (deduped per refund id by a partial
 *    unique index), and the decision is written to audit_logs. (No per-product
 *    auto-revoke override exists in the schema today; review-first is the
 *    only behavior.)
 *  - Idempotency → each refund id is recorded in payment_refunds under a
 *    unique index; a replayed event tolerates the 23505 and skips its side
 *    effects unless it is resuming a previously failed attempt.
 *  - Ordering → a refund arriving before its capture/sale-completed event
 *    (no payments row yet) throws so the webhook is recorded as an error and
 *    PayPal's retry re-processes it once the payment exists (refund event
 *    types are in RESUMABLE_FAILED_EVENT_TYPES).
 */
async function handleExternalPaymentRefunded(
  supabase: ReturnType<typeof createAdminSupabase>,
  paymentId: string,
  eventType: string,
  identifierField: 'capture_id' | 'sale_id',
  resource: Record<string, unknown>,
  options: RefundHandlerOptions = {},
) {
  const identifierName = identifierField === 'capture_id' ? 'capture' : 'sale';

  const { data: payment, error: paymentError } = await supabase
    .from('payments')
    .select('id, order_id, customer_id, guild_id, status, amount_cents, currency')
    .eq('paypal_payment_id', paymentId)
    .maybeSingle();
  requireSupabaseSuccess(paymentError, 'Failed to load payment for refund');

  if (!payment?.order_id) {
    // Out-of-order webhook: the refund raced ahead of its
    // PAYMENT.CAPTURE.COMPLETED / PAYMENT.SALE.COMPLETED (or the payment was
    // never recorded). Silently ignoring this — the old behavior — left the
    // customer with full access after an external refund. Throw instead so
    // the event is recorded as an error and PayPal's retries re-process it
    // once the payment row exists.
    throw new Error(
      `${eventType} for ${identifierName} ${paymentId} has no matching payment row yet — ` +
        'deferring for webhook retry (out-of-order delivery or unknown payment)',
    );
  }

  // Idempotency guard: only set after every revocation effect has succeeded.
  if (payment.status === 'refunded' || payment.status === 'reversed') {
    console.info(
      `[Webhook] ${eventType} for ${identifierName} ${paymentId} — payment already ${payment.status}, skipping`,
    );
    return;
  }

  const orderId = payment.order_id;
  const refundStatus = eventType.endsWith('.REVERSED') ? 'reversed' : 'refunded';
  const amounts = resolveRefundAmounts(resource, eventType);
  const refundId =
    typeof resource.id === 'string' && resource.id.length > 0 ? resource.id : null;

  // Record this refund id — the unique index on payment_refunds
  // (paypal_refund_id) is the atomic dedupe across replays, resumed retries
  // and concurrent instances; a 23505 means "already recorded", not an error.
  let alreadyRecorded = false;
  if (refundId) {
    const { error: refundInsertError } = await supabase.from('payment_refunds').insert({
      payment_id: payment.id,
      order_id: orderId,
      guild_id: payment.guild_id,
      paypal_refund_id: refundId,
      event_type: eventType,
      amount_cents: amounts.refundAmountCents,
      currency: amounts.refundCurrency,
    });
    if (refundInsertError) {
      if (isUniqueViolation(refundInsertError)) {
        alreadyRecorded = true;
      } else {
        throw new Error(
          `Failed to record refund ${refundId}: ${formatSupabaseError(refundInsertError)}`,
        );
      }
    }
  }

  // Locally recorded cumulative total (includes this refund's row).
  const recordedRefunds = await fetchAllLifecycleRowsById<RefundAmountRow>(
    async (afterId) => {
      let query = supabase
        .from('payment_refunds')
        .select('id, amount_cents')
        .eq('payment_id', payment.id)
        .order('id', { ascending: true })
        .limit(LIFECYCLE_SCAN_PAGE_SIZE);
      if (afterId !== null) query = query.gt('id', afterId);
      return await query as {
        data: RefundAmountRow[] | null;
        error: unknown;
      };
    },
    'Failed to load recorded refunds for payment',
  );
  const locallyRecordedCents = recordedRefunds.reduce(
    (sum, row) =>
      sum + (typeof row?.amount_cents === 'number' ? row.amount_cents : 0),
    0,
  );
  // Two concurrent partial refunds can each miss the other's row locally;
  // PayPal's cumulative total (present on capture refunds and sale refunds)
  // is authoritative and closes that window on whichever event carries it.
  const cumulativeRefundedCents = Math.max(
    locallyRecordedCents,
    amounts.paypalTotalRefundedCents ?? 0,
    amounts.refundAmountCents ?? 0,
  );

  const scope = classifyRefundScope({
    eventType,
    paymentAmountCents: typeof payment.amount_cents === 'number' ? payment.amount_cents : null,
    paymentCurrency: typeof payment.currency === 'string' ? payment.currency : null,
    refundAmountCents: amounts.refundAmountCents,
    refundCurrency: amounts.refundCurrency,
    paypalTotalRefundedCurrency: amounts.paypalTotalRefundedCurrency,
    cumulativeRefundedCents,
  });

  if (scope.kind === 'partial') {
    // A replayed, already-recorded partial refund has nothing left to do —
    // unless this is the resumption of a previously FAILED attempt, where
    // the alert/audit writes may not have happened (both are idempotent:
    // the alert is deduped per refund id by a partial unique index).
    if (alreadyRecorded && !options.retryingFailedEvent) {
      console.info(
        `[Webhook] ${eventType} for ${identifierName} ${paymentId} — partial refund ${refundId} already processed, skipping`,
      );
      return;
    }

    const { error: alertError } = await supabase.from('alerts').insert({
      guild_id: payment.guild_id,
      alert_type: 'partial_refund_review',
      severity: 'warning',
      title: 'Partial PayPal refund — review required',
      message:
        `PayPal reported a partial refund of ${formatCents(amounts.refundAmountCents, amounts.refundCurrency)} ` +
        `against a payment of ${formatCents(payment.amount_cents, payment.currency)} (order ${orderId}). ` +
        'Access was NOT revoked automatically — review the order and revoke manually if warranted.',
      metadata: {
        source: 'paypal_webhook',
        event_type: eventType,
        paypal_refund_id: refundId,
        [identifierField]: paymentId,
        order_id: orderId,
        payment_id: payment.id,
        refund_amount_cents: amounts.refundAmountCents,
        payment_amount_cents: payment.amount_cents ?? null,
        cumulative_refunded_cents: cumulativeRefundedCents,
        currency: amounts.refundCurrency ?? payment.currency ?? null,
      },
    });
    if (alertError && !isUniqueViolation(alertError)) {
      throw new Error(
        `Failed to raise partial refund review alert: ${formatSupabaseError(alertError)}`,
      );
    }

    const { error: auditError } = await supabase.from('audit_logs').insert({
      guild_id: payment.guild_id,
      actor_type: 'system',
      actor_id: 'paypal_webhook',
      action: 'order.refund_partial',
      target_type: 'order',
      target_id: orderId,
      details: {
        event_type: eventType,
        [identifierField]: paymentId,
        paypal_refund_id: refundId,
        refund_scope: 'partial',
        refund_amount_cents: amounts.refundAmountCents,
        payment_amount_cents: payment.amount_cents ?? null,
        cumulative_refunded_cents: cumulativeRefundedCents,
        currency: amounts.refundCurrency ?? payment.currency ?? null,
        decision: 'access_retained_pending_review',
      },
    });
    requireSupabaseSuccess(auditError, 'Failed to write partial refund audit log');

    console.log(
      `[Webhook] ${eventType} processed for order ${orderId} (${identifierName} ${paymentId}) — ` +
        `partial refund (${cumulativeRefundedCents}/${payment.amount_cents} cents), access retained, operator review raised`,
    );
    return;
  }

  // ── FULL refund/reversal: revoke everything, marker last ──

  // On a resumed retry, entitlements may already be expired by the failed
  // attempt — include their identities for grace-alert and session cleanup.
  const entitlementLookupStatuses = options.retryingFailedEvent
    ? EXPIRY_RETRY_ENTITLEMENT_STATUSES
    : EXPIRABLE_ENTITLEMENT_STATUSES;

  const activeEntitlements = await fetchAllLifecycleRowsById<EntitlementLifecycleRow>(
    async (afterId) => {
      let query = supabase
        .from('entitlements')
        .select('id, license_key_id')
        .eq('order_id', orderId)
        .eq('guild_id', payment.guild_id)
        .in('status', entitlementLookupStatuses)
        .order('id', { ascending: true })
        .limit(LIFECYCLE_SCAN_PAGE_SIZE);
      if (afterId !== null) query = query.gt('id', afterId);
      return await query as {
        data: EntitlementLifecycleRow[] | null;
        error: unknown;
      };
    },
    'Failed to load entitlements for refund revocation',
  );

  // All of the order's license keys (any status) so already-revoked keys from
  // a crashed earlier attempt still get their sessions deactivated.
  const orderLicenseKeys = await fetchAllLifecycleRowsById<LicenseKeyLifecycleRow>(
    async (afterId) => {
      let query = supabase
        .from('license_keys')
        .select('id')
        .eq('order_id', orderId)
        .eq('guild_id', payment.guild_id)
        .order('id', { ascending: true })
        .limit(LIFECYCLE_SCAN_PAGE_SIZE);
      if (afterId !== null) query = query.gt('id', afterId);
      return await query as {
        data: LicenseKeyLifecycleRow[] | null;
        error: unknown;
      };
    },
    'Failed to load license keys for refund revocation',
  );

  const licenseKeyIds = [
    ...new Set([
      ...(activeEntitlements ?? [])
        .map((ent) => ent.license_key_id)
        .filter((id): id is string => Boolean(id)),
      ...(orderLicenseKeys ?? [])
        .map((key) => key.id)
        .filter((id): id is string => Boolean(id)),
    ]),
  ];

  const nowIso = new Date().toISOString();

  // The entitlement-status trigger is the sole Discord role-revocation
  // producer. Its queue insert commits with this update and carries the exact
  // entitlement identity needed for shared-role and re-activation checks.
  const { error: expireEntitlementsError } = await supabase
    .from('entitlements')
    .update({
      status: 'expired',
      cancelled_at: nowIso,
      updated_at: nowIso,
    })
    .eq('order_id', orderId)
    .in('status', EXPIRABLE_ENTITLEMENT_STATUSES);
  requireSupabaseSuccess(expireEntitlementsError, 'Failed to revoke entitlements for refund');

  // W2 codex round 2: EXPIRABLE_ENTITLEMENT_STATUSES includes 'grace_period',
  // so a full refund is a terminal transition for a row that suspend() may
  // have left an 'entitlement_grace_period' operator alert open on. revoke()
  // and the reconciliation sweep resolve that alert on their terminal writes;
  // this direct refund expiry bypassed both. Resolve it with the same
  // entitlement-scoped, entitlement_grace_period filter (a no-op when none is
  // open). Non-fatal: the entitlement revocation above has already committed.
  const graceAlertEntitlementIds = (activeEntitlements ?? []).map((ent) => ent.id);
  if (graceAlertEntitlementIds.length > 0) {
    const { error: refundGraceAlertError } = await supabase
      .from('alerts')
      .update({ resolved: true, resolved_at: nowIso, updated_at: nowIso })
      .eq('guild_id', payment.guild_id)
      .eq('alert_type', 'entitlement_grace_period')
      .in('metadata->>entitlement_id', graceAlertEntitlementIds)
      .eq('resolved', false);
    if (refundGraceAlertError) {
      console.error(
        '[Webhook] Failed to resolve grace-period alerts for refund revocation:',
        formatSupabaseError(refundGraceAlertError),
      );
    }
  }

  const { error: revokeKeysError } = await supabase
    .from('license_keys')
    .update({
      status: 'revoked',
      revoked_at: nowIso,
      revocation_reason: refundStatus,
      updated_at: nowIso,
    })
    .eq('order_id', orderId)
    .neq('status', 'revoked');
  requireSupabaseSuccess(revokeKeysError, 'Failed to revoke license keys for refund');

  if (licenseKeyIds.length > 0) {
    const { error: deactivateSessionsError } = await supabase
      .from('license_sessions')
      .update({
        active: false,
        deactivated_at: nowIso,
        deactivation_reason: 'entitlement_revoked',
      })
      .in('license_key_id', licenseKeyIds)
      .eq('active', true);
    requireSupabaseSuccess(
      deactivateSessionsError,
      'Failed to deactivate license sessions for refund',
    );
  }

  const { error: auditError } = await supabase.from('audit_logs').insert({
    guild_id: payment.guild_id,
    actor_type: 'system',
    actor_id: 'paypal_webhook',
    action:
      eventType.endsWith('.REVERSED')
        ? 'order.reversed'
        : 'order.refunded_external',
    target_type: 'order',
    target_id: orderId,
    details: {
      event_type: eventType,
      [identifierField]: paymentId,
      paypal_refund_id: refundId,
      refund_scope: 'full',
      full_refund_reason: scope.reason,
      refund_amount_cents: amounts.refundAmountCents,
      payment_amount_cents: payment.amount_cents ?? null,
      cumulative_refunded_cents: cumulativeRefundedCents,
      entitlement_ids: (activeEntitlements ?? []).map((ent) => ent.id),
      license_key_ids: licenseKeyIds,
      role_revocation_source: 'entitlement_status_trigger',
    },
  });
  requireSupabaseSuccess(auditError, 'Failed to write refund audit log');

  const { error: orderUpdateError } = await supabase
    .from('orders')
    .update({ status: 'refunded', updated_at: nowIso })
    .eq('id', orderId);
  requireSupabaseSuccess(orderUpdateError, 'Failed to mark order refunded');

  // Commit marker LAST — the replay guard at the top keys off this status,
  // so it must only flip once every revocation effect has been applied.
  const { error: paymentUpdateError } = await supabase
    .from('payments')
    .update({ status: refundStatus })
    .eq('id', payment.id);
  requireSupabaseSuccess(paymentUpdateError, `Failed to mark payment ${refundStatus}`);

  console.log(
    `[Webhook] ${eventType} processed for order ${orderId} (${identifierName} ${paymentId}) — full refund, access revoked`,
  );
}
