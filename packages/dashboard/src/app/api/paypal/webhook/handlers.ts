/**
 * PayPal Webhook Event Handlers.
 *
 * V5 Audit §2.P3a: Extracted from the monolithic route.ts for maintainability.
 * Each handler deals with one PayPal event type (or a small group).
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getPayPalRuntimeConfig, getPayPalToken, getSubscriptionAmount } from '@/lib/paypal';
import { applyPayPalPolicyEnvironment, loadPayPalPolicy, type PayPalEnvironment } from '@/lib/paypal-policy';
import { isCanonicalPayPalResourceId } from '@/lib/paypal-resource-id';
import {
  paypalCaptureResourceSchema,
  paypalSaleResourceSchema,
  type PayPalCaptureResource,
  type PayPalSaleResource,
} from '@/lib/types/paypal';
import { generateLicenseKey, queueFulfillment } from './fulfillment';
import { raiseCaptureDeniedAlert, raiseDisputeAlert } from './alerts';
import {
  claimPaidFulfillment,
  holdUnknownDeliveryContract,
} from './duplicate-purchase';

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
const DEFAULT_LICENSE_KEY_PREFIX = 'SMNI';

async function loadLicenseKeyPrefix(
  supabase: AdminSupabase,
  productId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('product_license_config')
    .select('key_prefix')
    .eq('product_id', productId)
    .maybeSingle();
  requireSupabaseSuccess(error, 'Failed to load product license key prefix');
  const prefix = typeof data?.key_prefix === 'string' ? data.key_prefix : DEFAULT_LICENSE_KEY_PREFIX;
  if (!/^[A-Z]{2,8}$/.test(prefix)) {
    throw new Error('Product license key prefix is malformed');
  }
  return prefix;
}
const DELIVERY_TYPES = [
  'file',
  'link',
  'access_pass',
  'license_key',
  'mixed',
] as const;
type DeliveryType = (typeof DELIVERY_TYPES)[number];

interface FrozenGrantSnapshot {
  order_id: string;
  granted_role_ids_snapshot: string[];
  granted_channel_ids_snapshot: string[];
  temporary_role_grants_snapshot: Array<{ role_id: string; duration_seconds: number }>;
  grant_snapshot_frozen_at: string;
  delivery_type_snapshot: DeliveryType | null;
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
  paidThroughAt: string;
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
  delivery_type_snapshot?: DeliveryType | null;
}

interface EntitlementLifecycleRow {
  id: string;
  license_key_id: string | null;
}

interface LicenseKeyLifecycleRow {
  id: string;
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
  plan_id: string;
  paypal_subscription_id: string;
  amount_cents: number;
  currency: string;
  status: 'completed' | 'pending_review';
}

interface SubscriptionLifecycleCarrier {
  discordId: string;
  productName: string;
  providerPlanId: string;
}

type SubscriptionLifecycleEventType =
  | 'BILLING.SUBSCRIPTION.ACTIVATED'
  | 'PAYMENT.SALE.COMPLETED'
  | 'BILLING.SUBSCRIPTION.PAYMENT.FAILED'
  | 'BILLING.SUBSCRIPTION.SUSPENDED'
  | 'BILLING.SUBSCRIPTION.CANCELLED'
  | 'BILLING.SUBSCRIPTION.EXPIRED';

export interface ProviderMoneyHandlerOptions {
  webhookEventId: string;
  providerOccurredAt?: string;
  paypalEnvironment?: PayPalEnvironment;
}

type ProviderMoneyEventType =
  | 'PAYMENT.CAPTURE.COMPLETED'
  | 'BILLING.SUBSCRIPTION.ACTIVATED'
  | 'PAYMENT.SALE.COMPLETED';

type ProviderIncidentReason =
  | 'provider_identity_malformed'
  | 'custom_identity_missing_or_malformed'
  | 'customer_identity_missing_or_mismatched'
  | 'order_identity_missing_or_ambiguous'
  | 'product_identity_missing_or_mismatched'
  | 'plan_identity_missing_or_mismatched'
  | 'financial_identity_malformed'
  | 'gift_intent_invalid_or_replayed'
  | 'subscription_sale_router_failed';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function boundedProviderIdentity(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    ? value
    : null;
}

function boundedObservedGuildId(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    ? value
    : null;
}

function requireProviderMoneyEventId(
  options: ProviderMoneyHandlerOptions,
  operation: string,
): string {
  if (
    !isNonEmptyString(options.webhookEventId)
    || options.webhookEventId.trim() !== options.webhookEventId
    || options.webhookEventId.length > 160
  ) {
    throw new Error(`${operation} requires an exact webhook event id`);
  }
  return options.webhookEventId;
}

async function recordProviderMoneyIncident(
  supabase: AdminSupabase,
  input: {
    webhookEventId: string;
    eventType: ProviderMoneyEventType;
    resourceId: unknown;
    parentId?: unknown;
    observedGuildId?: unknown;
    reason: ProviderIncidentReason;
    evidence: Record<string, unknown>;
  },
): Promise<void> {
  if (
    !isNonEmptyString(input.webhookEventId)
    || input.webhookEventId.trim() !== input.webhookEventId
    || input.webhookEventId.length > 160
  ) {
    throw new Error('Provider money incident requires an exact webhook event id');
  }
  const providerResourceId = boundedProviderIdentity(input.resourceId);
  const providerParentId = boundedProviderIdentity(input.parentId);
  const observedGuildId = boundedObservedGuildId(input.observedGuildId);
  const { data, error } = await supabase.rpc(
    'commerce_record_provider_incident',
    {
      p_webhook_event_id: input.webhookEventId,
      p_provider_event_type: input.eventType,
      p_provider_resource_id: providerResourceId,
      p_provider_parent_id: providerParentId,
      p_observed_guild_id: observedGuildId,
      p_incident_reason: input.reason,
      p_evidence: input.evidence,
    },
  );
  requireSupabaseSuccess(error, 'Failed to persist provider money incident');
  const row = data as Record<string, unknown> | null;
  const routableGuildId = row?.routable_guild_id;
  if (
    !row
    || !['created', 'replay'].includes(String(row.disposition))
    || !isNonEmptyString(row.incident_id)
    || row.webhook_event_id !== input.webhookEventId
    || row.provider_event_type !== input.eventType
    || row.provider_resource_id !== providerResourceId
    || row.provider_parent_id !== providerParentId
    || row.observed_guild_id !== observedGuildId
    || row.incident_reason !== input.reason
    || row.fulfillment_allowed !== false
    || (
      routableGuildId !== null
      && routableGuildId !== observedGuildId
    )
    || (
      routableGuildId === null
        ? row.alert_id !== null
        : !isNonEmptyString(row.alert_id)
    )
  ) {
    throw new Error('Provider money incident returned malformed durable identity');
  }
  if (input.eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    const { error: recoveryError } = await supabase
      .from('commerce_provider_money_recovery')
      .insert({
        webhook_event_id: input.webhookEventId,
        provider_resource_id: providerResourceId,
        provider_parent_id: providerParentId,
        guild_id: observedGuildId,
        reason: input.reason,
        status: 'pending',
      });
    if (recoveryError && recoveryError.code !== '23505') {
      requireSupabaseSuccess(recoveryError, 'Failed to persist provider money recovery task');
    }
  }
}

/** Idempotent operator/cron consumer for malformed captures. */
export async function executeProviderMoneyRecovery(
  supabase: AdminSupabase,
  recoveryId: string,
): Promise<'refunded' | 'retry' | 'manual_review'> {
  const { data: claimed, error: claimError } = await supabase.rpc(
    'commerce_claim_provider_money_recovery',
    { p_webhook_event_id: recoveryId },
  );
  requireSupabaseSuccess(claimError, 'Failed to claim provider money recovery task');
  const row = Array.isArray(claimed) && claimed.length === 1 ? claimed[0] : null;
  // A concurrent worker owns the lease (or the row is already terminal). It
  // must not issue a second provider refund or write a duplicate audit row.
  if (!row) return 'retry';
  const leaseToken = typeof row.lease_token === 'string' ? row.lease_token : null;
  if (!leaseToken) throw new Error('Provider recovery claim returned no lease token');
  const finish = async (values: Record<string, unknown>): Promise<boolean> => {
    const { data, error } = await supabase
      .from('commerce_provider_money_recovery')
      .update(values)
      .eq('webhook_event_id', recoveryId)
      .eq('status', 'processing')
      .eq('lease_token', leaseToken)
      .select('webhook_event_id');
    requireSupabaseSuccess(error, 'Failed to finalize provider money recovery task');
    return Array.isArray(data) && data.length === 1;
  };
  if (!row.provider_resource_id) {
    const transitioned = await finish({
      status: 'manual_review',
      resolved_at: new Date().toISOString(),
      leased_until: null,
    });
    if (transitioned && typeof row.guild_id === 'string' && row.guild_id.length > 0) {
      await supabase.from('audit_logs').insert({
        guild_id: row.guild_id,
        actor_type: 'system',
        actor_id: 'paypal-recovery',
        action: 'commerce.provider_money_recovery_manual_review',
        target_type: 'provider_capture',
        target_id: recoveryId,
        details: { webhook_event_id: recoveryId, reason: 'missing_provider_resource_id' },
      });
    }
    return 'manual_review';
  }
  const runtimeConfig = await getPayPalRuntimeConfig();
  const policy = await loadPayPalPolicy(supabase, typeof row.guild_id === 'string' ? row.guild_id : null);
  // Recovery is tenant-routed: never let a sandbox guild's malformed capture
  // hit the live endpoint (or vice versa), even when process env defaults are
  // shared across all guilds.
  const config = applyPayPalPolicyEnvironment(runtimeConfig, policy.environment);
  const token = await getPayPalToken(config);
  if (!token) throw new Error('PayPal recovery token unavailable');
  const response = await fetch(`${config.apiBase}/v2/payments/captures/${encodeURIComponent(row.provider_resource_id)}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `recovery-${createHash('sha256').update(recoveryId).digest('hex')}`,
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok || response.status === 409) {
    const transitioned = await finish({ status: 'refunded', resolved_at: new Date().toISOString(), leased_until: null });
    if (!transitioned) return 'retry';
    if (typeof row.guild_id === 'string' && row.guild_id.length > 0) {
      await supabase.from('audit_logs').insert({ guild_id: row.guild_id, actor_type: 'system', actor_id: 'paypal-recovery', action: 'commerce.provider_money_refunded', target_type: 'provider_capture', target_id: row.provider_resource_id, details: { webhook_event_id: recoveryId } });
    }
    return 'refunded';
  }
  const attempts = Number(row.attempts ?? 0);
  const maxAttempts = Number(row.max_attempts ?? 5);
  const terminal = attempts >= maxAttempts;
  const transitioned = await finish({
    status: terminal ? 'manual_review' : 'pending',
    next_retry_at: terminal ? null : new Date(Date.now() + 60_000).toISOString(),
    leased_until: null,
    resolved_at: terminal ? new Date().toISOString() : null,
  });
  if (transitioned && terminal && typeof row.guild_id === 'string' && row.guild_id.length > 0) {
    await supabase.from('audit_logs').insert({
      guild_id: row.guild_id,
      actor_type: 'system',
      actor_id: 'paypal-recovery',
      action: 'commerce.provider_money_recovery_manual_review',
      target_type: 'provider_capture',
      target_id: row.provider_resource_id,
      details: {
        webhook_event_id: recoveryId,
        attempts,
        max_attempts: maxAttempts,
        provider_status: response.status,
      },
    });
  }
  return terminal ? 'manual_review' : 'retry';
}

/** Run a bounded provider-money recovery sweep under the same leased consumer
 * used by the operator endpoint. Concurrent schedulers safely skip processing
 * rows already claimed by another worker. */
export async function sweepProviderMoneyRecovery(
  supabase: AdminSupabase,
  limit = 20,
): Promise<Array<{ id: string; result?: string; error?: string }>> {
  const { data: rows, error } = await supabase
    .from('commerce_provider_money_recovery')
    .select('webhook_event_id')
    .in('status', ['pending', 'processing'])
    .limit(Math.min(Math.max(limit, 1), 100));
  requireSupabaseSuccess(error, 'Failed to list provider money recovery tasks');
  const results: Array<{ id: string; result?: string; error?: string }> = [];
  for (const row of rows ?? []) {
    if (!row || typeof row.webhook_event_id !== 'string') continue;
    try {
      results.push({ id: row.webhook_event_id, result: await executeProviderMoneyRecovery(supabase, row.webhook_event_id) });
    } catch (recoveryError) {
      results.push({
        id: row.webhook_event_id,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
    }
  }
  return results;
}

function verifyCheckoutSignature(token: string, signature: string): boolean {
  const secret = process.env.PAYPAL_RECONCILE_SECRET || process.env.PAYPAL_CLIENT_SECRET;
  if (!secret || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`somnibot-checkout:v1:${token}`).digest('hex'), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function parseDeliveryTypeSnapshot(value: unknown): DeliveryType | null {
  if (value === null) return null;
  if (
    typeof value === 'string'
    && (DELIVERY_TYPES as readonly string[]).includes(value)
  ) {
    return value as DeliveryType;
  }
  throw new Error('Order delivery type snapshot is malformed');
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
  carrier: SubscriptionLifecycleCarrier;
}> {
  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .select('id, order_number, guild_id, customer_id, product_id, plan_id, paypal_subscription_id, amount_cents, currency, status')
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
    !isNonEmptyString(orderData.plan_id) ||
    orderData.paypal_subscription_id !== subscriptionId
    || !Number.isSafeInteger(orderData.amount_cents)
    || orderData.amount_cents < 0
    || !isNonEmptyString(orderData.currency)
    || !['completed', 'pending_review'].includes(String(orderData.status))
  ) {
    throw new Error(`${operation}: order identity mismatch`);
  }
  const order = orderData as SubscriptionLifecycleOrderRow;

  const { data: carrierData, error: carrierError } = await supabase
    .from('bot_action_queue')
    .select('id, guild_id, action, lane, status, idempotency_key, payload')
    .eq(
      'idempotency_key',
      `paypal:subscription:${subscriptionId}:fulfill_subscription`,
    )
    .maybeSingle();
  requireSupabaseSuccess(
    carrierError,
    `${operation}: failed to load historical activation carrier`,
  );
  const carrierPayload =
    carrierData?.payload
    && typeof carrierData.payload === 'object'
    && !Array.isArray(carrierData.payload)
      ? carrierData.payload as Record<string, unknown>
      : null;
  if (
    !carrierData
    || carrierData.guild_id !== order.guild_id
    || carrierData.action !== 'fulfill_subscription'
    || carrierData.lane !== 'commerce'
    || !['staged', 'pending', 'processing', 'completed', 'failed'].includes(
      String(carrierData.status),
    )
    || carrierData.idempotency_key
      !== `paypal:subscription:${subscriptionId}:fulfill_subscription`
    || !carrierPayload
    || carrierPayload.fulfillment_type !== 'subscription_activated'
    || carrierPayload.guild_id !== order.guild_id
    || carrierPayload.customer_id !== order.customer_id
    || carrierPayload.product_id !== order.product_id
    || carrierPayload.order_id !== order.id
    || carrierPayload.order_number !== order.order_number
    || carrierPayload.plan_id !== order.plan_id
    || carrierPayload.paypal_subscription_id !== subscriptionId
    || carrierPayload.entitlement_type !== 'subscription'
    || !isNonEmptyString(carrierPayload.discord_id)
    || !isNonEmptyString(carrierPayload.product_name)
    || !isNonEmptyString(carrierPayload.paypal_plan_id)
  ) {
    throw new Error(`${operation}: historical activation carrier mismatch`);
  }

  return {
    order,
    carrier: {
      discordId: carrierPayload.discord_id,
      productName: carrierPayload.product_name,
      providerPlanId: carrierPayload.paypal_plan_id,
    },
  };
}

async function createOrRecoverSubscriptionLifecycleAction(
  supabase: AdminSupabase,
  input: {
    webhookEventId: string;
    fulfillmentType:
      | 'subscription_cancelled'
      | 'subscription_suspended'
      | 'subscription_payment_failed';
    order: SubscriptionLifecycleOrderRow;
    carrier: SubscriptionLifecycleCarrier;
  },
): Promise<void> {
  if (
    !isNonEmptyString(input.webhookEventId)
    || input.webhookEventId.trim() !== input.webhookEventId
  ) {
    throw new Error('Subscription lifecycle fulfillment requires an exact webhook event id');
  }
  const expectedAction = input.fulfillmentType === 'subscription_cancelled'
    ? 'fulfill_cancellation'
    : 'fulfill_suspension';
  const expectedIdempotencyKey =
    `paypal:lifecycle:${input.webhookEventId}:${input.fulfillmentType}`;
  const { data, error } = await supabase.rpc(
    'commerce_create_or_recover_subscription_lifecycle_action',
    {
      p_webhook_event_id: input.webhookEventId,
      p_fulfillment_type: input.fulfillmentType,
      p_guild_id: input.order.guild_id,
      p_customer_id: input.order.customer_id,
      p_discord_id: input.carrier.discordId,
      p_product_id: input.order.product_id,
      p_order_id: input.order.id,
      p_plan_id: input.order.plan_id,
      p_paypal_subscription_id: input.order.paypal_subscription_id,
    },
  );
  requireSupabaseSuccess(error, 'Failed to create subscription lifecycle fulfillment');
  const row = data as Record<string, unknown> | null;
  const disposition = row?.disposition;
  const actionStatus = row?.action_status;
  const validDispositionState =
    (disposition === 'created' && actionStatus === 'pending')
    || (
      disposition === 'replay'
      && ['pending', 'processing', 'completed'].includes(String(actionStatus))
    )
    || (
      disposition === 'operator_held'
      && ['staged', 'failed'].includes(String(actionStatus))
    );
  const validHistoricalCarrierIdentity =
    disposition === 'created'
      ? row?.discord_id === input.carrier.discordId
        && row?.product_name === input.carrier.productName
      : isNonEmptyString(row?.discord_id)
        && isNonEmptyString(row?.product_name);
  if (
    !row
    || !isNonEmptyString(row.action_id)
    || !validDispositionState
    || row.action !== expectedAction
    || row.idempotency_key !== expectedIdempotencyKey
    || row.webhook_event_id !== input.webhookEventId
    || row.fulfillment_type !== input.fulfillmentType
    || row.guild_id !== input.order.guild_id
    || row.customer_id !== input.order.customer_id
    || !validHistoricalCarrierIdentity
    || row.product_id !== input.order.product_id
    || row.order_id !== input.order.id
    || row.order_number !== input.order.order_number
    || row.plan_id !== input.order.plan_id
    || row.paypal_subscription_id !== input.order.paypal_subscription_id
    || row.amount_cents !== input.order.amount_cents
    || row.currency !== input.order.currency
  ) {
    throw new Error('Subscription lifecycle fulfillment returned malformed identity');
  }
  if (disposition === 'operator_held') {
    throw new Error(
      'Subscription lifecycle fulfillment is operator-held and was not replaced',
    );
  }
}

function requireProviderOccurredAt(
  value: unknown,
  operation: string,
): string {
  if (!isNonEmptyString(value) || value.trim() !== value) {
    throw new Error(`${operation} requires provider create_time`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${operation} has invalid provider create_time`);
  }
  return new Date(timestamp).toISOString();
}

async function recordSubscriptionLifecycleObservation(
  supabase: AdminSupabase,
  input: {
    webhookEventId: string;
    eventType: SubscriptionLifecycleEventType;
    providerOccurredAt: unknown;
    providerPaidThroughAt?: string | null;
    order: SubscriptionLifecycleOrderRow | CommerceOrderRow;
  },
): Promise<{
  accepted: boolean;
  generation: number;
  occurredAt: string;
  paidThroughAt: string | null;
}> {
  const occurredAt = requireProviderOccurredAt(
    input.providerOccurredAt,
    input.eventType,
  );
  const paidThroughAt = input.providerPaidThroughAt ?? null;
  if (paidThroughAt !== null) {
    const paidThroughTimestamp = Date.parse(paidThroughAt);
    if (
      !Number.isFinite(paidThroughTimestamp)
      || paidThroughTimestamp <= Date.parse(occurredAt)
    ) {
      throw new Error(`${input.eventType} requires a finite future paid-through boundary`);
    }
  }
  if (!isNonEmptyString(input.order.plan_id)) {
    throw new Error(`${input.eventType} requires an exact local plan identity`);
  }

  const { data, error } = await supabase.rpc(
    'commerce_record_subscription_lifecycle_observation',
    {
      p_webhook_event_id: input.webhookEventId,
      p_provider_event_type: input.eventType,
      p_provider_occurred_at: occurredAt,
      p_provider_paid_through_at: paidThroughAt,
      p_paypal_subscription_id: input.order.paypal_subscription_id,
      p_order_id: input.order.id,
      p_guild_id: input.order.guild_id,
      p_customer_id: input.order.customer_id,
      p_product_id: input.order.product_id,
      p_plan_id: input.order.plan_id,
    },
  );
  requireSupabaseSuccess(error, 'Failed to record subscription lifecycle chronology');
  const row = data as Record<string, unknown> | null;
  const disposition = String(row?.disposition ?? '');
  const accepted = row?.accepted === true;
  const generation = Number(row?.generation);
  if (
    !row
    || !['accepted', 'replay', 'stale', 'stale_replay'].includes(disposition)
    || accepted !== ['accepted', 'replay'].includes(disposition)
    || !Number.isSafeInteger(generation)
    || generation < 1
    || row.webhook_event_id !== input.webhookEventId
    || row.provider_event_type !== input.eventType
    || Date.parse(String(row.provider_occurred_at)) !== Date.parse(occurredAt)
    || (
      paidThroughAt === null
        ? row.provider_paid_through_at !== null
        : Date.parse(String(row.provider_paid_through_at))
          !== Date.parse(paidThroughAt)
    )
    || row.paypal_subscription_id !== input.order.paypal_subscription_id
    || row.order_id !== input.order.id
    || row.guild_id !== input.order.guild_id
    || row.customer_id !== input.order.customer_id
    || row.product_id !== input.order.product_id
    || row.plan_id !== input.order.plan_id
  ) {
    throw new Error('Subscription lifecycle chronology returned malformed identity');
  }
  return { accepted, generation, occurredAt, paidThroughAt };
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    throw new Error(`${label} is malformed`);
  }
  return [...new Set(value)];
}

function parseExactStringVector(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value)
    || value.some((entry) =>
      !isNonEmptyString(entry)
      || entry.trim() !== entry)
  ) {
    throw new Error(`${label} is malformed`);
  }
  const normalized = [...new Set(value as string[])];
  if (normalized.length !== value.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return normalized.sort((left, right) => left.localeCompare(right));
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
    delivery_type_snapshot: null,
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

/** Parse a canonical PayPal decimal into exact, non-negative safe cents. */
function parsePayPalAmountToCents(value: unknown, allowNegative = false): number | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 32
    || value !== value.trim()
  ) {
    return null;
  }
  const pattern = allowNegative
    ? /^-?((?:0|[1-9]\d*))(?:\.([0-9]{1,2}))?$/
    : /^((?:0|[1-9]\d*))(?:\.([0-9]{1,2}))?$/;
  const match = pattern.exec(value);
  if (!match?.[1]) return null;
  const cents = (BigInt(match[1]) * BigInt(100))
    + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
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
    return {
      ...financial,
      providerPlanId: subAmount.planId,
      paidThroughAt: subAmount.nextBillingTime,
    };
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
  const { data, error } = await supabase.rpc('bot_action_queue_release_staged', {
    p_action_id: row.id,
    p_guild_id: row.guild_id,
    p_idempotency_key: row.idempotency_key,
  });
  requireSupabaseSuccess(error, 'Failed to release staged fulfillment');
  const result = Array.isArray(data) ? data[0] : data;
  const validStatus = result?.action_status === 'pending'
    || result?.action_status === 'processing'
    || result?.action_status === 'completed'
    || result?.action_status === 'failed';
  const validDisposition = result?.disposition === 'released'
    || result?.disposition === 'already_released';
  if (!result
    || result.action_id !== row.id
    || !validStatus
    || !validDisposition
    || (result.disposition === 'released' && result.action_status !== 'pending')) {
    throw new Error('Failed to release staged fulfillment');
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
  const { data: deliveryContract, error: deliveryContractError } = await supabase
    .from('orders')
    .select('id, delivery_type_snapshot')
    .eq('id', order.id)
    .eq('guild_id', order.guild_id)
    .maybeSingle();
  requireSupabaseSuccess(
    deliveryContractError,
    'Failed to load frozen order delivery contract',
  );
  if (!deliveryContract || deliveryContract.id !== order.id) {
    throw new Error('Frozen order delivery contract returned the wrong order');
  }
  return {
    ...snapshot,
    delivery_type_snapshot: parseDeliveryTypeSnapshot(
      deliveryContract.delivery_type_snapshot,
    ),
  };
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
  const payloadPrefix = payload.license_key_prefix;
  const prefix = typeof payloadPrefix === 'string' ? payloadPrefix : groups[0];
  if (
    groups.length !== 5
    || typeof prefix !== 'string'
    || !/^[A-Z]{2,8}$/.test(prefix)
    || groups[0] !== prefix
    || groups.slice(1).some((group) => !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(group))
  ) {
    throw new Error('Staged license key plaintext is malformed');
  }
  const keyHash = createHash('sha256').update(plaintext).digest('hex');
  const deliveryCustomerId = typeof payload.recipient_customer_id === 'string'
    ? payload.recipient_customer_id : order.customer_id;
  const deliveryDiscordId = typeof payload.recipient_discord_id === 'string'
    ? payload.recipient_discord_id : String(payload.discord_id ?? '');
  const row = {
    id: licenseKeyId,
    order_id: order.id,
    customer_id: deliveryCustomerId,
    product_id: order.product_id,
    guild_id: order.guild_id,
    key_hash: keyHash,
    key_prefix: prefix,
    key_suffix: groups[4]!,
    bound_discord_id: deliveryDiscordId,
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
    existing.customer_id !== deliveryCustomerId ||
    existing.product_id !== order.product_id ||
    existing.guild_id !== order.guild_id ||
    existing.key_hash !== keyHash
  ) {
    throw new Error('Existing staged license key failed identity validation');
  }
}

function validateStagedLicenseDelivery(
  payload: Record<string, unknown>,
  deliveryType: DeliveryType | null,
): void {
  const licenseKeyId = payload.license_key_id;
  const plaintext = payload.license_key_plaintext;
  const hasExactLicense =
    isNonEmptyString(licenseKeyId) && isNonEmptyString(plaintext);
  const hasAnyLicense = licenseKeyId != null || plaintext != null;

  // A queue row staged before delivery snapshots existed is already the durable
  // sold contract. Do not re-derive or rewrite it from today's catalog.
  if (deliveryType === null) {
    if (hasAnyLicense && !hasExactLicense) {
      throw new Error('Staged legacy license key payload is malformed');
    }
    return;
  }

  if (deliveryType === 'license_key' && !hasExactLicense) {
    throw new Error('Licence-key order has no staged licence payload');
  }
  if (deliveryType !== 'license_key' && hasAnyLicense) {
    throw new Error('Non-licence order has an unexpected staged licence payload');
  }
}

const EXPIRABLE_ENTITLEMENT_STATUSES = ['active', 'pending', 'grace_period', 'suspended'];
const EXPIRY_RETRY_ENTITLEMENT_STATUSES = [
  ...EXPIRABLE_ENTITLEMENT_STATUSES,
  'expired',
];

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

function addCanonicalPayPalCandidate(candidates: string[], candidate: unknown): boolean {
  if (candidate === undefined) return true;
  if (!isCanonicalPayPalResourceId(candidate)) return false;
  candidates.push(candidate);
  return true;
}

function resolveCaptureRefundPaymentId(resource: Record<string, unknown>): string | null {
  const parsed = paypalCaptureResourceSchema.safeParse(resource);
  if (!parsed.success) return null;
  const capture: PayPalCaptureResource = parsed.data;

  const candidates: string[] = [];
  if (
    !addCanonicalPayPalCandidate(candidates, capture.capture_id)
    || !addCanonicalPayPalCandidate(
      candidates,
      capture.supplementary_data?.related_ids?.capture_id,
    )
  ) {
    return null;
  }

  for (const link of capture.links ?? []) {
    if (link.rel?.toLowerCase() !== 'capture') continue;
    if (typeof link.href !== 'string') return null;
    const match = link.href.match(/\/payments\/captures?\/([^/?#]+)\/?(?:[?#]|$)/i);
    if (!match?.[1] || !addCanonicalPayPalCandidate(candidates, match[1])) return null;
  }

  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0]! : null;
}

function resolveSaleRefundPaymentId(
  resource: Record<string, unknown>,
  eventType: string,
): string | null {
  const parsed = paypalSaleResourceSchema.safeParse(resource);
  if (!parsed.success) return null;
  const sale: PayPalSaleResource = parsed.data;
  const candidates: string[] = [];

  if (
    !addCanonicalPayPalCandidate(candidates, sale.sale_id)
    || !addCanonicalPayPalCandidate(candidates, sale.capture_id)
  ) {
    return null;
  }

  const declaredStates = [sale.state, sale.status]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toUpperCase());
  const isDirectReversedSale = eventType === 'PAYMENT.SALE.REVERSED'
    && declaredStates.length > 0
    && declaredStates.every((value) => value === 'REVERSED')
    && isCanonicalPayPalResourceId(sale.parent_payment)
    && sale.sale_id === undefined
    && sale.capture_id === undefined;

  // PayPal v1 refund resources identify their parent via sale_id/capture_id
  // or a rel=sale link. A reversed event can instead carry the Sale itself;
  // only that documented state+parent_payment shape makes resource.id a
  // parent sale identity rather than an unrelated refund transaction id.
  if (
    isDirectReversedSale
    && !addCanonicalPayPalCandidate(candidates, sale.id)
  ) {
    return null;
  }

  for (const link of sale.links ?? []) {
    const rel = link.rel?.toLowerCase();
    const relevant = rel === 'sale'
      || (isDirectReversedSale && (rel === 'self' || rel === 'refund'));
    if (!relevant) continue;
    if (typeof link.href !== 'string') return null;
    const suffix = rel === 'refund' ? '\\/refund' : '';
    const match = link.href.match(
      new RegExp(`\\/payments\\/sales?\\/([^/?#]+)${suffix}\\/?(?:[?#]|$)`, 'i'),
    );
    if (!match?.[1] || !addCanonicalPayPalCandidate(candidates, match[1])) return null;
  }

  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0]! : null;
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

/**
 * Finding 2: PayPal reports an already-captured order as HTTP 422 with
 * `details[0].issue === 'ORDER_ALREADY_CAPTURED'`. That is not a failure — it
 * is proof the capture we are retrying already happened, and the resulting
 * `PAYMENT.CAPTURE.COMPLETED` event is what actually creates the order rows.
 *
 * This matters because `CHECKOUT.ORDER.APPROVED` is now resumable: without it,
 * a capture that timed out client-side but succeeded at PayPal would fail
 * forever on every retry.
 */
function isAlreadyCapturedResponse(status: number, body: string): boolean {
  if (status !== 422) return false;
  try {
    const parsed = JSON.parse(body) as { details?: Array<{ issue?: unknown }> };
    return Array.isArray(parsed.details)
      && parsed.details.some((detail) => detail?.issue === 'ORDER_ALREADY_CAPTURED');
  } catch {
    return false;
  }
}

export async function handleOrderApproved(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: ProviderMoneyHandlerOptions,
) {
  requireProviderMoneyEventId(options, 'Order approval');
  const paypalOrderId = resource.id;
  if (!isCanonicalPayPalResourceId(paypalOrderId)) {
    throw new Error('Approved PayPal order identity is malformed');
  }
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, guild_id, paypal_order_id, status')
    .eq('paypal_order_id', paypalOrderId)
    .maybeSingle();
  requireSupabaseSuccess(orderError, 'Failed to load approved PayPal order');
  if (
    !order
    || !isNonEmptyString(order.id)
    || !isNonEmptyString(order.guild_id)
    || order.paypal_order_id !== paypalOrderId
    || !['pending', 'completed', 'pending_review'].includes(String(order.status))
  ) {
    throw new Error('Approved PayPal order has no exact resumable local carrier');
  }

  const runtimeConfig = await getPayPalRuntimeConfig();
  const paypalConfig = options.paypalEnvironment
    ? applyPayPalPolicyEnvironment(runtimeConfig, options.paypalEnvironment)
    : runtimeConfig;
  const token = await getPayPalToken(paypalConfig);
  if (!token) {
    throw new Error('Could not get PayPal token to capture order');
  }

  const providerOrderUrl =
    `${paypalConfig.apiBase}/v2/checkout/orders/${paypalOrderId}`;
  let captureRes: Response | null = null;
  try {
    captureRes = await fetch(`${providerOrderUrl}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        // Keep this stable across provider redelivery and manual replay.
        'PayPal-Request-Id': `capture-${paypalOrderId}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // A timed-out POST may have committed at PayPal. Reconcile below instead
    // of issuing a second capture under a new identity.
  }

  let captured = false;
  if (captureRes?.ok) {
    const captureBody = await captureRes.json().catch(() => null) as
      | { id?: unknown; status?: unknown }
      | null;
    captured =
      captureBody?.id === paypalOrderId
      && captureBody.status === 'COMPLETED';
  } else if (captureRes) {
    const errorText = await captureRes.text();
    if (isAlreadyCapturedResponse(captureRes.status, errorText)) {
      captured = true;
    }
  }
  if (!captured) {
    const reconcileRes = await fetch(providerOrderUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (reconcileRes.ok) {
      const reconcileBody = await reconcileRes.json().catch(() => null) as
        | { id?: unknown; status?: unknown }
        | null;
      captured =
        reconcileBody?.id === paypalOrderId
        && reconcileBody.status === 'COMPLETED';
    }
  }
  if (!captured) {
    const providerStatus = captureRes?.status ?? 'ambiguous';
    throw new Error(
      `Failed to capture PayPal order and exact reconciliation did not prove completion (${providerStatus})`,
    );
  }

  console.log(`[Webhook] Captured PayPal order: ${paypalOrderId}`);
}

// ── Payment Captured ────────────────────────────────

export async function handlePaymentCaptured(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: ProviderMoneyHandlerOptions,
) {
  const webhookEventId = requireProviderMoneyEventId(
    options,
    'Payment capture',
  );
  const parsed = paypalCaptureResourceSchema.safeParse(resource);
  const capture: PayPalCaptureResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };

  const customId = capture.custom_id
    ?? (typeof resource.custom_id === 'string' ? resource.custom_id : undefined);
  let meta: {
    guild_id: string;
    product_id: string;
    customer_id: string;
    discord_id: string;
    gift_intent_id?: string;
  } | null = null;
  let observedGuildId: string | null = null;
  let checkoutToken: string | null = null;
  let checkoutSignature: string | null = null;

  if (customId) {
    const signed = customId.match(/^v1:([0-9a-f-]{36})\.([a-f0-9]{64})$/i);
    if (signed) {
      checkoutToken = signed[1]!;
      checkoutSignature = signed[2]!;
    } else try {
      const raw = JSON.parse(customId) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const custom = raw as Record<string, unknown>;
        observedGuildId = boundedObservedGuildId(
          custom.g ?? custom.guild_id,
        );
        if (custom.g && custom.p && custom.c && custom.d) {
          meta = {
            guild_id: String(custom.g),
            product_id: String(custom.p),
            customer_id: String(custom.c),
            discord_id: String(custom.d),
            ...(typeof custom.gi === 'string' ? { gift_intent_id: custom.gi } : {}),
          };
        } else {
          meta = {
            guild_id: String(custom.guild_id ?? ''),
            product_id: String(custom.product_id ?? ''),
            customer_id: String(custom.customer_id ?? ''),
            discord_id: String(custom.discord_id ?? ''),
            ...(typeof custom.gift_intent_id === 'string' ? { gift_intent_id: custom.gift_intent_id } : {}),
          };
        }
      }
    } catch {
      /* ignore */
    }
  }

  const paypalCaptureId = resource.id;
  const rawRelatedIds = resource.supplementary_data;
  let fallbackPayPalOrderId: unknown;
  if (
    rawRelatedIds
    && typeof rawRelatedIds === 'object'
    && !Array.isArray(rawRelatedIds)
  ) {
    const relatedIds =
      (rawRelatedIds as Record<string, unknown>).related_ids;
    if (
      relatedIds
      && typeof relatedIds === 'object'
      && !Array.isArray(relatedIds)
    ) {
      fallbackPayPalOrderId =
        (relatedIds as Record<string, unknown>).order_id;
    }
  }
  const paypalOrderId = capture.supplementary_data?.related_ids?.order_id
    ?? fallbackPayPalOrderId;
  if (
    !isNonEmptyString(paypalCaptureId)
    || !isCanonicalPayPalResourceId(paypalCaptureId)
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: paypalCaptureId,
      parentId: paypalOrderId,
      observedGuildId,
      reason: 'provider_identity_malformed',
      evidence: {
        resource_id_present: isNonEmptyString(paypalCaptureId),
      },
    });
    return;
  }

  if (checkoutToken) {
    if (!checkoutSignature || !verifyCheckoutSignature(checkoutToken, checkoutSignature)) {
      await recordProviderMoneyIncident(supabase, { webhookEventId, eventType: 'PAYMENT.CAPTURE.COMPLETED', resourceId: paypalCaptureId, parentId: paypalOrderId, observedGuildId, reason: 'checkout_identity_missing_or_mismatched', evidence: { checkout_token: checkoutToken } });
      return;
    }
    const { data: checkoutIntent, error: checkoutIntentError } = await supabase
      .from('commerce_checkout_intents')
      .select('token, guild_id, customer_id, product_id, gift_checkout_token, provider_id, expires_at, status')
      .eq('token', checkoutToken)
      .maybeSingle();
    requireSupabaseSuccess(checkoutIntentError, 'Failed to validate checkout identity');
    if (!checkoutIntent || checkoutIntent.status === 'cancelled' || (['pending', 'bound'].includes(String(checkoutIntent.status)) && Date.parse(String(checkoutIntent.expires_at)) <= Date.now())
      || checkoutIntent.provider_id !== paypalOrderId) {
      await recordProviderMoneyIncident(supabase, {
        webhookEventId, eventType: 'PAYMENT.CAPTURE.COMPLETED', resourceId: paypalCaptureId,
        parentId: paypalOrderId, observedGuildId,
        reason: 'checkout_identity_missing_or_mismatched', evidence: { checkout_token: checkoutToken },
      });
      return;
    }
    meta = {
      guild_id: String(checkoutIntent.guild_id), product_id: String(checkoutIntent.product_id),
      customer_id: String(checkoutIntent.customer_id), discord_id: '',
      ...(typeof checkoutIntent.gift_checkout_token === 'string' && checkoutIntent.gift_checkout_token.length > 0
        ? { gift_intent_id: checkoutIntent.gift_checkout_token } : {}),
    };
    observedGuildId = boundedObservedGuildId(meta.guild_id);
  }

  if (
    !meta ||
    !isNonEmptyString(meta.guild_id) ||
    !isNonEmptyString(meta.product_id) ||
    !isNonEmptyString(meta.customer_id) ||
    (!meta.gift_intent_id && !isNonEmptyString(meta.discord_id))
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: paypalCaptureId,
      parentId: paypalOrderId,
      observedGuildId,
      reason: 'custom_identity_missing_or_malformed',
      evidence: {
        custom_id_present: isNonEmptyString(customId),
      },
    });
    return;
  }

  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id, guild_id, discord_id')
    .eq('id', meta.customer_id)
    .eq('guild_id', meta.guild_id)
    .maybeSingle();
  requireSupabaseSuccess(
    customerError,
    'Failed to validate captured payment customer',
  );
  if (
    !customer
    || customer.id !== meta.customer_id
    || customer.guild_id !== meta.guild_id
    || (!meta.gift_intent_id && customer.discord_id !== meta.discord_id)
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: paypalCaptureId,
      parentId: paypalOrderId,
      observedGuildId: meta.guild_id,
      reason: 'customer_identity_missing_or_mismatched',
      evidence: {
        customer_id: meta.customer_id,
        product_id: meta.product_id,
      },
    });
    return;
  }

  if (meta.gift_intent_id) {
    const token = meta.gift_intent_id;
    const legacyIntentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token);
    if (!legacyIntentId && !/^[a-f0-9]{16}(?:[a-f0-9]{32})?$/.test(token)) {
      await recordProviderMoneyIncident(supabase, {
        webhookEventId, eventType: 'PAYMENT.CAPTURE.COMPLETED', resourceId: paypalCaptureId,
        parentId: paypalOrderId, observedGuildId: meta.guild_id,
        reason: 'gift_intent_invalid_or_replayed', evidence: { gift_token: token },
      });
      return;
    }
    meta.discord_id = customer.discord_id;
    let giftLookup = supabase.from('commerce_gift_intents').select('id').eq('guild_id', meta.guild_id).eq('buyer_customer_id', meta.customer_id).eq('product_id', meta.product_id);
    giftLookup = legacyIntentId ? giftLookup.eq('id', token) : giftLookup.eq('checkout_token', token);
    const { data: giftIntent, error: giftLookupError } = await giftLookup.maybeSingle();
    requireSupabaseSuccess(giftLookupError, 'Failed to validate gift checkout token');
    if (!giftIntent?.id) {
      await recordProviderMoneyIncident(supabase, {
        webhookEventId, eventType: 'PAYMENT.CAPTURE.COMPLETED', resourceId: paypalCaptureId,
        parentId: paypalOrderId, observedGuildId: meta.guild_id,
        reason: 'gift_intent_invalid_or_replayed', evidence: { gift_token: token },
      });
      return;
    }
    meta.gift_intent_id = giftIntent.id;
  }

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
      .select('id, order_number, customer_id, guild_id, product_id, plan_id, amount_cents, currency, status, grant_snapshot_frozen_at, delivery_type_snapshot, paypal_order_id')
      .eq('id', existingPayment.order_id)
      .eq('guild_id', meta.guild_id)
      .maybeSingle();
    requireSupabaseSuccess(error, 'Failed to load captured order');
    order = data as CommerceOrderRow | null;
  } else {
    if (
      !isNonEmptyString(paypalOrderId)
      || !isCanonicalPayPalResourceId(paypalOrderId)
    ) {
      await recordProviderMoneyIncident(supabase, {
        webhookEventId,
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        resourceId: paypalCaptureId,
        parentId: paypalOrderId,
        observedGuildId: meta.guild_id,
        reason: 'provider_identity_malformed',
        evidence: {
          customer_id: meta.customer_id,
          product_id: meta.product_id,
          paypal_order_id_present: isNonEmptyString(paypalOrderId),
        },
      });
      return;
    }
    const { data, error } = await supabase
      .from('orders')
      .select('id, order_number, customer_id, guild_id, product_id, plan_id, amount_cents, currency, status, grant_snapshot_frozen_at, delivery_type_snapshot, paypal_order_id')
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
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: paypalCaptureId,
      parentId: paypalOrderId,
      observedGuildId: meta.guild_id,
      reason: 'order_identity_missing_or_ambiguous',
      evidence: {
        local_order_found: order !== null,
        local_order_id: boundedProviderIdentity(order?.id),
        customer_id: meta.customer_id,
        product_id: meta.product_id,
      },
    });
    return;
  }

  const amountCents = parsePayPalAmountToCents(capture.amount?.value);
  if (amountCents == null) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: paypalCaptureId,
      parentId: paypalOrderId,
      observedGuildId: order.guild_id,
      reason: 'financial_identity_malformed',
      evidence: {
        order_id: order.id,
        amount_present: capture.amount?.value !== undefined,
      },
    });
    return;
  }
  const rawCaptureCurrency = capture.amount?.currency_code;
  if (!isNonEmptyString(rawCaptureCurrency) || !/^[A-Za-z]{3}$/.test(rawCaptureCurrency)) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: paypalCaptureId,
      parentId: paypalOrderId,
      observedGuildId: order.guild_id,
      reason: 'financial_identity_malformed',
      evidence: {
        order_id: order.id,
        currency: boundedProviderIdentity(rawCaptureCurrency),
      },
    });
    return;
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
      await holdUnknownDeliveryContract(supabase, order, {
        kind: 'capture',
        id: paypalCaptureId,
        amountCents,
        currency: captureCurrency,
      });
      return;
    }
  }

  // The finalizer requires the sold access contract to be frozen for both
  // completed and pending_review outcomes. A financial mismatch still must
  // not stage or release any fulfillment.
  const snapshot = await freezeOrderGrantSnapshot(supabase, order);
  // Persist and re-validate the exact completed capture before fulfillment
  // arbitration. The claim RPC independently requires this payment row, so a
  // forged/malformed historical queue payload cannot seize the winner with a
  // merely syntactic capture ID. No random key or fulfillment row exists yet.
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

  let deliveryCustomerId = order.customer_id;
  let deliveryDiscordId = meta.discord_id;
  if (meta.gift_intent_id) {
    const { data: giftClaim, error: giftError } = await supabase.rpc('commerce_claim_gift_fulfillment', {
      p_intent_id: meta.gift_intent_id,
      p_order_id: order.id,
      p_guild_id: order.guild_id,
      p_buyer_customer_id: order.customer_id,
      p_product_id: order.product_id,
    });
    if (giftError || !Array.isArray(giftClaim) || giftClaim.length !== 1
      || typeof giftClaim[0]?.recipient_customer_id !== 'string'
      || typeof giftClaim[0]?.recipient_discord_id !== 'string') {
      await recordProviderMoneyIncident(supabase, {
        webhookEventId,
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        resourceId: paypalCaptureId,
        parentId: paypalOrderId,
        observedGuildId: order.guild_id,
        reason: 'gift_intent_invalid_or_replayed',
        evidence: { gift_intent_id: meta.gift_intent_id, order_id: order.id },
      });
      return;
    }
    deliveryCustomerId = giftClaim[0].recipient_customer_id;
    deliveryDiscordId = giftClaim[0].recipient_discord_id;
  }

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
            ...(meta.gift_intent_id ? { recipient_customer_id: deliveryCustomerId, recipient_discord_id: deliveryDiscordId, gift_intent_id: meta.gift_intent_id } : {}),
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
  if (
    amountMatches
    && !staged
    && snapshot.delivery_type_snapshot === null
  ) {
    await holdUnknownDeliveryContract(supabase, order, {
      kind: 'capture',
      id: paypalCaptureId,
      amountCents,
      currency: captureCurrency,
    });
    return;
  }
  if (amountMatches && !meta.gift_intent_id) {
    // The database claim is the atomic double-fulfillment boundary. It must run
    // before a random licence key or staged queue payload is created. Historical
    // PayPal links can arrive concurrently, so a JavaScript entitlement read is
    // not sufficient serialization. Unknown delivery contracts use the wrapper
    // above instead so claim + permanent hold + alert are one transaction.
    const claim = await claimPaidFulfillment(supabase, order, {
      kind: 'capture',
      id: paypalCaptureId,
      amountCents,
      currency: captureCurrency,
    });
    if (claim.disposition === 'held') {
      console.error(
        `[Webhook] DUPLICATE PURCHASE: order ${order.order_number} lost fulfillment `
          + `claim to ${claim.winning_order_id ?? 'an existing entitlement'}; payment `
          + `recorded, critical alert ${claim.alert_id} persisted, fulfillment withheld.`,
      );
      return;
    }
  }
  if (amountMatches && !staged) {
    const productName = await requireProductDisplayName(
      supabase,
      order.product_id,
      'Failed to load captured product display identity',
    );

    const license = snapshot.delivery_type_snapshot === 'license_key'
      ? generateLicenseKey(await loadLicenseKeyPrefix(supabase, order.product_id))
      : null;
    staged = await stageFulfillment(supabase, expected, {
      fulfillment_type: 'one_time_purchase',
      guild_id: order.guild_id,
      customer_id: order.customer_id,
      discord_id: meta.discord_id,
      ...(meta.gift_intent_id ? { recipient_customer_id: deliveryCustomerId, recipient_discord_id: deliveryDiscordId, gift_intent_id: meta.gift_intent_id } : {}),
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
            license_key_prefix: license.prefix,
          }
        : {}),
      entitlement_type: 'one_time',
    });
  }

  if (!staged) throw new Error('Completed capture has no staged grant snapshot');

  validateStagedLicenseDelivery(staged.payload, snapshot.delivery_type_snapshot);
  await ensureStagedLicenseKey(supabase, order, staged.payload);
  await releaseStagedFulfillment(supabase, staged);
  if (checkoutToken) {
    await supabase.from('commerce_checkout_intents').update({ status: 'captured' }).eq('token', checkoutToken);
  }

  console.log(
    `[Webhook] Order completed + fulfillment queued: ${order.order_number} for ${meta.discord_id}`,
  );
}

// ── Subscription Activated ──────────────────────────

export async function handleSubscriptionActivated(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: ProviderMoneyHandlerOptions,
) {
  const webhookEventId = requireProviderMoneyEventId(
    options,
    'Subscription activation',
  );
  const parsed = paypalCaptureResourceSchema.safeParse(resource);
  const capture: PayPalCaptureResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };
  const customId = capture.custom_id
    ?? (typeof resource.custom_id === 'string' ? resource.custom_id : undefined);

  let meta: {
    guild_id: string;
    product_id: string;
    plan_id: string;
    customer_id: string;
    discord_id: string;
  } | null = null;
  let observedGuildId: string | null = null;
  let checkoutToken: string | null = null;
  let checkoutSignature: string | null = null;
  try {
    const signed = typeof customId === 'string' ? customId.match(/^v1:([0-9a-f-]{36})\.([a-f0-9]{64})$/i) : null;
    if (signed) {
      checkoutToken = signed[1]!;
      checkoutSignature = signed[2]!;
    }
    const raw = checkoutToken ? null : JSON.parse(customId ?? '') as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const custom = raw as Record<string, unknown>;
      observedGuildId = boundedObservedGuildId(
        custom.g ?? custom.guild_id,
      );
      meta = custom.g && custom.p && custom.c && custom.d
        ? {
            guild_id: String(custom.g),
            product_id: String(custom.p),
            plan_id: String(custom.pl ?? custom.plan_id ?? ''),
            customer_id: String(custom.c),
            discord_id: String(custom.d),
          }
        : {
            guild_id: String(custom.guild_id ?? ''),
            product_id: String(custom.product_id ?? ''),
            plan_id: String(custom.plan_id ?? ''),
            customer_id: String(custom.customer_id ?? ''),
            discord_id: String(custom.discord_id ?? ''),
          };
    }
  } catch {
    /* Durable incident below. */
  }

  const subscriptionId = resource.id;
  if (
    !isNonEmptyString(subscriptionId)
    || !isCanonicalPayPalResourceId(subscriptionId)
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resourceId: subscriptionId,
      observedGuildId,
      reason: 'provider_identity_malformed',
      evidence: {
        resource_id_present: isNonEmptyString(subscriptionId),
      },
    });
    return;
  }

  if (checkoutToken) {
    if (!checkoutSignature || !verifyCheckoutSignature(checkoutToken, checkoutSignature)) {
      await recordProviderMoneyIncident(supabase, { webhookEventId, eventType: 'BILLING.SUBSCRIPTION.ACTIVATED', resourceId: subscriptionId, observedGuildId, reason: 'checkout_identity_missing_or_mismatched', evidence: { checkout_token: checkoutToken } });
      return;
    }
    const { data: checkoutIntent, error: checkoutIntentError } = await supabase
      .from('commerce_checkout_intents')
      .select('token, guild_id, customer_id, product_id, plan_id, provider_id, expires_at, status')
      .eq('token', checkoutToken)
      .maybeSingle();
    requireSupabaseSuccess(checkoutIntentError, 'Failed to validate subscription checkout identity');
    if (!checkoutIntent || checkoutIntent.status === 'cancelled' || (['pending', 'bound'].includes(String(checkoutIntent.status)) && Date.parse(String(checkoutIntent.expires_at)) <= Date.now())
      || checkoutIntent.provider_id !== subscriptionId || typeof checkoutIntent.plan_id !== 'string') {
      await recordProviderMoneyIncident(supabase, {
        webhookEventId, eventType: 'BILLING.SUBSCRIPTION.ACTIVATED', resourceId: subscriptionId,
        observedGuildId, reason: 'checkout_identity_missing_or_mismatched', evidence: { checkout_token: checkoutToken },
      });
      return;
    }
    meta = {
      guild_id: String(checkoutIntent.guild_id),
      product_id: String(checkoutIntent.product_id),
      plan_id: String(checkoutIntent.plan_id),
      customer_id: String(checkoutIntent.customer_id),
      discord_id: '',
    };
    observedGuildId = boundedObservedGuildId(meta.guild_id);
  }

  if (
    !meta ||
    !isNonEmptyString(meta.guild_id) ||
    !isNonEmptyString(meta.product_id) ||
    !isNonEmptyString(meta.plan_id) ||
    !isNonEmptyString(meta.customer_id) ||
    (!checkoutToken && !isNonEmptyString(meta.discord_id))
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resourceId: subscriptionId,
      observedGuildId,
      reason: 'custom_identity_missing_or_malformed',
      evidence: {
        custom_id_present: isNonEmptyString(customId),
      },
    });
    return;
  }

  const { data: existingOrder, error: existingOrderError } = await supabase
    .from('orders')
    .select('id, order_number, customer_id, guild_id, product_id, plan_id, amount_cents, currency, status, grant_snapshot_frozen_at, delivery_type_snapshot, paypal_subscription_id')
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
      !['pending', 'pending_review', 'completed'].includes(order.status)
    )
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resourceId: subscriptionId,
      observedGuildId: meta.guild_id,
      reason: 'order_identity_missing_or_ambiguous',
      evidence: {
        local_order_id: boundedProviderIdentity(order.id),
        customer_id: meta.customer_id,
        product_id: meta.product_id,
        plan_id: meta.plan_id,
      },
    });
    return;
  }

  let firstProviderContract: AuthoritativeSubscriptionContract | null = null;
  let prevalidatedProviderPlanId: string | null = null;

  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id, guild_id, discord_id')
    .eq('id', meta.customer_id)
    .eq('guild_id', meta.guild_id)
    .maybeSingle();
  requireSupabaseSuccess(
    customerError,
    'Failed to validate subscription customer',
  );
  if (
    !customer
    || customer.id !== meta.customer_id
    || customer.guild_id !== meta.guild_id
    || (!checkoutToken && customer.discord_id !== meta.discord_id)
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resourceId: subscriptionId,
      observedGuildId: meta.guild_id,
      reason: 'customer_identity_missing_or_mismatched',
      evidence: {
        customer_id: meta.customer_id,
        product_id: meta.product_id,
        plan_id: meta.plan_id,
      },
    });
    return;
  }
  if (checkoutToken) meta.discord_id = customer.discord_id;

  if (!order) {
    firstProviderContract = await requireAuthoritativeSubscriptionAmount(subscriptionId);
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('id, guild_id, product_id, paypal_plan_id')
      .eq('id', meta.plan_id)
      .eq('guild_id', meta.guild_id)
      .eq('product_id', meta.product_id)
      .maybeSingle();
    requireSupabaseSuccess(
      planError,
      'Failed to load subscription plan identity',
    );
    if (
      !plan
      || plan.id !== meta.plan_id
      || plan.guild_id !== meta.guild_id
      || plan.product_id !== meta.product_id
      || plan.paypal_plan_id !== firstProviderContract.providerPlanId
    ) {
      await recordProviderMoneyIncident(supabase, {
        webhookEventId,
        eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resourceId: subscriptionId,
        observedGuildId: meta.guild_id,
        reason: 'plan_identity_missing_or_mismatched',
        evidence: {
          customer_id: meta.customer_id,
          product_id: meta.product_id,
          plan_id: meta.plan_id,
          provider_plan_id:
            boundedProviderIdentity(firstProviderContract.providerPlanId),
        },
      });
      return;
    }
    prevalidatedProviderPlanId = firstProviderContract.providerPlanId;
    const recoveryOrderNumber =
      `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    let recoveryData: unknown = null;
    let recoveryError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await supabase.rpc(
        'commerce_create_subscription_activation_recovery_order',
        {
          p_order_number: recoveryOrderNumber,
          p_guild_id: meta.guild_id,
          p_customer_id: meta.customer_id,
          p_product_id: meta.product_id,
          p_plan_id: meta.plan_id,
          p_paypal_subscription_id: subscriptionId,
          p_amount_cents: firstProviderContract.amountCents,
          p_currency: firstProviderContract.currency,
        },
      );
      recoveryData = response.data;
      recoveryError = response.error;
      if (!recoveryError) {
        const candidate = recoveryData as Record<string, unknown> | null;
        const holdReason = candidate?.hold_reason;
        const expectedAlertType = holdReason === 'unknown_delivery_contract'
          ? 'commerce_unknown_delivery_contract'
          : holdReason === 'duplicate_paid_fulfillment'
            ? 'commerce_duplicate_subscription_activation'
            : null;
        const validWinner =
          isNonEmptyString(candidate?.winning_order_id)
          && (
            holdReason === 'unknown_delivery_contract'
              ? candidate?.winning_order_id === candidate?.id
                && candidate?.conflicting_entitlement_id === null
              : candidate?.winning_order_id !== candidate?.id
          );
        if (
          candidate
          && ['created', 'replay'].includes(String(candidate.disposition))
          && isNonEmptyString(candidate.id)
          && isNonEmptyString(candidate.order_number)
          && candidate.guild_id === meta.guild_id
          && candidate.customer_id === meta.customer_id
          && candidate.product_id === meta.product_id
          && candidate.plan_id === meta.plan_id
          && candidate.paypal_order_id === null
          && candidate.paypal_subscription_id === subscriptionId
          && candidate.amount_cents === firstProviderContract.amountCents
          && candidate.currency === firstProviderContract.currency
          && candidate.status === 'pending_review'
          && candidate.checkout_active === false
          && expectedAlertType !== null
          && validWinner
          && isNonEmptyString(candidate.alert_id)
          && candidate.alert_type === expectedAlertType
          && candidate.delivery_type_snapshot === null
          && candidate.grant_snapshot_frozen_at === null
          && Array.isArray(candidate.granted_role_ids_snapshot)
          && candidate.granted_role_ids_snapshot.length === 0
          && Array.isArray(candidate.granted_channel_ids_snapshot)
          && candidate.granted_channel_ids_snapshot.length === 0
          && Array.isArray(candidate.temporary_role_grants_snapshot)
          && candidate.temporary_role_grants_snapshot.length === 0
        ) {
          recoveryError = null;
          break;
        }
        recoveryError = new Error(
          'Subscription recovery order returned malformed hold identity',
        );
      }
    }
    requireSupabaseSuccess(recoveryError, 'Failed to create subscription order');
    console.warn(
      `[Webhook] Subscription activation ${subscriptionId} has no frozen sold contract; ` +
        'the payment identity is held for manual fulfillment or refund',
    );
    return;
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
    !['pending', 'pending_review', 'completed'].includes(order.status)
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resourceId: subscriptionId,
      observedGuildId: meta.guild_id,
      reason: 'order_identity_missing_or_ambiguous',
      evidence: {
        local_order_id: boundedProviderIdentity(order?.id),
        customer_id: meta.customer_id,
        product_id: meta.product_id,
        plan_id: meta.plan_id,
      },
    });
    return;
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
  let providerPaidThroughAt: string;
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
    providerPaidThroughAt = providerContract.paidThroughAt;
  } else if (!staged) {
    // Every first/pending activation is checked against PayPal. A provider
    // outage is retryable; silently trusting a local plan price can grant a
    // subscription whose provider amount has diverged.
    const providerContract = firstProviderContract ??
      await requireAuthoritativeSubscriptionAmount(subscriptionId);
    financial = providerContract;
    providerPlanId = providerContract.providerPlanId;
    providerPaidThroughAt = providerContract.paidThroughAt;
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
    const stagedPaidThroughAt = staged.payload.provider_paid_through_at;
    if (
      !isNonEmptyString(stagedPaidThroughAt)
      || !Number.isFinite(Date.parse(stagedPaidThroughAt))
    ) {
      throw new Error('Staged subscription fulfillment has malformed paid-through identity');
    }
    providerPaidThroughAt = stagedPaidThroughAt;
  }

  const deliveryTypeSnapshot = parseDeliveryTypeSnapshot(
    order.delivery_type_snapshot ?? null,
  );
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
    const { data: pricedOrder, error: priceError } = await supabase.rpc(
      'commerce_reprice_pending_subscription_order',
      {
        p_order_id: order.id,
        p_guild_id: order.guild_id,
        p_customer_id: order.customer_id,
        p_product_id: order.product_id,
        p_plan_id: meta.plan_id,
        p_paypal_subscription_id: subscriptionId,
        p_amount_cents: pendingFinancialUpdate.amountCents,
        p_currency: pendingFinancialUpdate.currency,
      },
    );
    requireSupabaseSuccess(priceError, 'Failed to persist subscription billing amount');
    if (
      !pricedOrder
      || typeof pricedOrder !== 'object'
      || Array.isArray(pricedOrder)
      || pricedOrder.order_id !== order.id
      || pricedOrder.guild_id !== order.guild_id
      || pricedOrder.status !== 'pending_review'
      || pricedOrder.disposition !== 'held_financial_mismatch'
      || pricedOrder.amount_cents !== order.amount_cents
      || pricedOrder.currency !== order.currency
      || !isNonEmptyString(pricedOrder.alert_id)
    ) {
      throw new Error('Subscription billing amount update lost its state race');
    }
    console.error(
      `[Webhook] Subscription ${subscriptionId} financials differ from the pending order; `
        + `order ${order.order_number} is held in pending_review and no fulfillment was staged.`,
    );
    return;
  }

  if (completedLegacyNoGrantContract) {
    // Legacy completed orders predate immutable grant snapshots. Their exact
    // PayPal subscription, customer, order, local-plan metadata, and financial
    // identities have already been validated above, but claiming/freeze now
    // would reserve today's mutable sale contract for an order that can only
    // safely no-op.
    console.info(
      `[Webhook] Exact legacy subscription replay has no durable grant contract; ` +
        `skipping fulfillment recovery for ${order.order_number}`,
    );
    await holdUnknownDeliveryContract(supabase, order, {
      kind: 'subscription',
      id: subscriptionId,
      amountCents: financial.amountCents,
      currency: financial.currency,
    });
    return;
  }

  if (!staged && deliveryTypeSnapshot === null) {
    await holdUnknownDeliveryContract(supabase, order, {
      kind: 'subscription',
      id: subscriptionId,
      amountCents: financial.amountCents,
      currency: financial.currency,
    });
    return;
  }

  const chronology = await recordSubscriptionLifecycleObservation(supabase, {
    webhookEventId,
    eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
    providerOccurredAt: options.providerOccurredAt,
    providerPaidThroughAt,
    order,
  });
  if (!chronology.accepted) {
    console.log(
      `[Webhook] Ignored stale subscription activation: ${subscriptionId}`,
    );
    return;
  }

  // An older inactive-but-still-payable approval link can activate concurrently
  // with another historical order. The database chooses one durable winner,
  // atomically holds every loser in pending_review, and persists its critical
  // operator alert before this handler can stage any fulfillment. Unknown
  // delivery contracts use the wrapper above instead so no claim-only crash
  // window can exist.
  const claim = await claimPaidFulfillment(supabase, order, {
    kind: 'subscription',
    id: subscriptionId,
    amountCents: financial.amountCents,
    currency: financial.currency,
  });
  if (claim.disposition === 'held') {
    console.error(
      `[Webhook] DUPLICATE SUBSCRIPTION: order ${order.order_number} lost fulfillment `
        + `claim to ${claim.winning_order_id ?? 'an existing entitlement'}; critical `
        + `alert ${claim.alert_id} persisted and fulfillment withheld.`,
    );
    return;
  }

  // A replay of a non-delivery review hold can never become fulfillable merely
  // because mutable catalog or entitlement state changed later.
  if (order.status === 'pending_review') {
    console.info(
      `[Webhook] Subscription order ${order.order_number} remains held for manual review`,
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
      provider_paid_through_at: providerPaidThroughAt,
      webhook_event_id: options.webhookEventId,
      provider_event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      provider_occurred_at: chronology.occurredAt,
      lifecycle_generation: chronology.generation,
      granted_role_ids: snapshot.granted_role_ids_snapshot,
      granted_channel_ids: snapshot.granted_channel_ids_snapshot,
      temporary_role_grants: undefined,
      entitlement_type: 'subscription',
    },
  };
  if (staged) staged = validateQueueRow(staged, expected);

  if (!staged) {
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, name')
      .eq('id', order.product_id)
      .maybeSingle();
    requireSupabaseSuccess(
      productError,
      'Failed to load subscription product display identity',
    );
    if (
      !product
      || product.id !== order.product_id
      || !isNonEmptyString(product.name)
    ) {
      await recordProviderMoneyIncident(supabase, {
        webhookEventId,
        eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resourceId: subscriptionId,
        observedGuildId: order.guild_id,
        reason: 'product_identity_missing_or_mismatched',
        evidence: {
          order_id: order.id,
          customer_id: order.customer_id,
          product_id: order.product_id,
          plan_id: order.plan_id,
        },
      });
      return;
    }
    const productName = product.name;
    const license = deliveryTypeSnapshot === 'license_key'
      ? generateLicenseKey(await loadLicenseKeyPrefix(supabase, order.product_id))
      : null;

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
      provider_paid_through_at: providerPaidThroughAt,
      webhook_event_id: options.webhookEventId,
      provider_event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      provider_occurred_at: chronology.occurredAt,
      lifecycle_generation: chronology.generation,
      amount_cents: financial.amountCents,
      currency: financial.currency,
      granted_role_ids: snapshot.granted_role_ids_snapshot,
      granted_channel_ids: snapshot.granted_channel_ids_snapshot,
      ...(license
        ? {
            license_key_id: crypto.randomUUID(),
            license_key_plaintext: license.plaintext,
            license_key_prefix: license.prefix,
          }
        : {}),
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
  validateStagedLicenseDelivery(staged.payload, deliveryTypeSnapshot);

  if (order.status === 'pending') {
    const { data: completedOrder, error: completeError } = await supabase.rpc(
      'commerce_complete_pending_subscription_order',
      {
        p_order_id: order.id,
        p_guild_id: order.guild_id,
        p_customer_id: order.customer_id,
        p_product_id: order.product_id,
        p_plan_id: meta.plan_id,
        p_paypal_subscription_id: subscriptionId,
        p_amount_cents: financial.amountCents,
        p_currency: financial.currency,
      },
    );
    requireSupabaseSuccess(completeError, 'Failed to complete subscription order');
    if (
      !completedOrder
      || typeof completedOrder !== 'object'
      || Array.isArray(completedOrder)
      || completedOrder.order_id !== order.id
      || completedOrder.guild_id !== order.guild_id
      || completedOrder.status !== 'completed'
      || completedOrder.amount_cents !== financial.amountCents
      || completedOrder.currency !== financial.currency
    ) {
      throw new Error('Subscription order completion lost its state race');
    }
  }

  await ensureStagedLicenseKey(supabase, order, staged.payload);
  await releaseStagedFulfillment(supabase, staged);
  if (checkoutToken) {
    await supabase.from('commerce_checkout_intents').update({ status: 'captured' }).eq('token', checkoutToken);
  }

  console.log(
    `[Webhook] Subscription activated + fulfillment queued: ${subscriptionId} for ${meta.discord_id}`,
  );
}

// ── Subscription Cancelled ──────────────────────────

export interface SubscriptionQueueOptions {
  retryingFailedEvent?: boolean;
  /** Canonical webhook event id — the durable lifecycle carrier identity. */
  webhookEventId: string;
  providerOccurredAt?: string;
}

export async function handleSubscriptionCancelled(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: SubscriptionQueueOptions,
) {
  const subscriptionId = resource.id;
  if (!isNonEmptyString(subscriptionId)) {
    throw new Error('Subscription cancellation has no provider id');
  }
  const { order, carrier } = await loadSubscriptionLifecycleContext(
    supabase,
    subscriptionId,
    'Subscription cancellation',
  );
  const providerContract = await requireAuthoritativeSubscriptionAmount(
    subscriptionId,
  );
  if (providerContract.providerPlanId !== carrier.providerPlanId) {
    throw new Error('Subscription cancellation provider plan identity mismatch');
  }
  const chronology = await recordSubscriptionLifecycleObservation(supabase, {
    webhookEventId: options.webhookEventId,
    eventType: 'BILLING.SUBSCRIPTION.CANCELLED',
    providerOccurredAt: options.providerOccurredAt,
    providerPaidThroughAt: providerContract.paidThroughAt,
    order,
  });
  if (!chronology.accepted) {
    console.log(
      `[Webhook] Ignored stale subscription cancellation: ${subscriptionId}`,
    );
    return;
  }

  await createOrRecoverSubscriptionLifecycleAction(supabase, {
    webhookEventId: options.webhookEventId,
    fulfillmentType: 'subscription_cancelled',
    order,
    carrier,
  });

  console.log(
    `[Webhook] Subscription cancelled + fulfillment queued: ${subscriptionId}`,
  );
}

// ── Subscription Expired ────────────────────────────

export async function handleSubscriptionExpired(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: SubscriptionQueueOptions,
) {
  const subscriptionId = resource.id;
  if (!isNonEmptyString(subscriptionId)) {
    throw new Error('Subscription expiry has no provider id');
  }

  const { order, carrier } = await loadSubscriptionLifecycleContext(
    supabase,
    subscriptionId,
    'Subscription expiry',
  );
  const chronology = await recordSubscriptionLifecycleObservation(supabase, {
    webhookEventId: options.webhookEventId,
    eventType: 'BILLING.SUBSCRIPTION.EXPIRED',
    providerOccurredAt: options.providerOccurredAt,
    order,
  });
  if (!chronology.accepted) {
    console.log(`[Webhook] Ignored stale subscription expiry: ${subscriptionId}`);
    return;
  }

  await createOrRecoverSubscriptionLifecycleAction(supabase, {
    webhookEventId: options.webhookEventId,
    fulfillmentType: 'subscription_cancelled',
    order,
    carrier,
  });

  console.log(
    `[Webhook] Subscription expired + fulfillment queued: ${subscriptionId}`,
  );
}

// ── Subscription Suspended ──────────────────────────

export async function handleSubscriptionSuspended(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: SubscriptionQueueOptions,
) {
  const subscriptionId = resource.id;
  if (!isNonEmptyString(subscriptionId)) {
    throw new Error('Subscription suspension has no provider id');
  }
  const { order, carrier } = await loadSubscriptionLifecycleContext(
    supabase,
    subscriptionId,
    'Subscription suspension',
  );
  const chronology = await recordSubscriptionLifecycleObservation(supabase, {
    webhookEventId: options.webhookEventId,
    eventType: 'BILLING.SUBSCRIPTION.SUSPENDED',
    providerOccurredAt: options.providerOccurredAt,
    order,
  });
  if (!chronology.accepted) {
    console.log(
      `[Webhook] Ignored stale subscription suspension: ${subscriptionId}`,
    );
    return;
  }

  await createOrRecoverSubscriptionLifecycleAction(supabase, {
    webhookEventId: options.webhookEventId,
    fulfillmentType: 'subscription_suspended',
    order,
    carrier,
  });

  console.log(
    `[Webhook] Subscription suspended + fulfillment queued: ${subscriptionId}`,
  );
}

export async function handleSubscriptionPaymentFailed(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: SubscriptionQueueOptions,
) {
  const subscriptionId = resource.id;
  if (!isNonEmptyString(subscriptionId)) {
    throw new Error('Subscription payment failure has no provider id');
  }
  const { order, carrier } = await loadSubscriptionLifecycleContext(
    supabase,
    subscriptionId,
    'Subscription payment failure',
  );
  const chronology = await recordSubscriptionLifecycleObservation(supabase, {
    webhookEventId: options.webhookEventId,
    eventType: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
    providerOccurredAt: options.providerOccurredAt,
    order,
  });
  if (!chronology.accepted) {
    console.log(
      `[Webhook] Ignored stale subscription payment failure: ${subscriptionId}`,
    );
    return;
  }

  await createOrRecoverSubscriptionLifecycleAction(supabase, {
    webhookEventId: options.webhookEventId,
    fulfillmentType: 'subscription_payment_failed',
    order,
    carrier,
  });

  console.log(
    `[Webhook] Subscription payment failure + grace fulfillment queued: ${subscriptionId}`,
  );
}

// ── Subscription Payment ────────────────────────────

export async function handleSubscriptionPayment(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: ProviderMoneyHandlerOptions,
) {
  const webhookEventId = requireProviderMoneyEventId(
    options,
    'Subscription payment',
  );
  const parsed = paypalSaleResourceSchema.safeParse(resource);
  const sale: PayPalSaleResource | null = parsed.success ? parsed.data : null;
  const providerPaymentId = sale?.id ?? resource.id;
  const billingAgreementId =
    sale?.billing_agreement_id ?? resource.billing_agreement_id;
  if (
    !isNonEmptyString(providerPaymentId)
    || !isCanonicalPayPalResourceId(providerPaymentId)
    || !isNonEmptyString(billingAgreementId)
    || !isCanonicalPayPalResourceId(billingAgreementId)
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.SALE.COMPLETED',
      resourceId: providerPaymentId,
      parentId: billingAgreementId,
      reason: 'provider_identity_malformed',
      evidence: {
        resource_id_present: isNonEmptyString(providerPaymentId),
        billing_agreement_id_present: isNonEmptyString(billingAgreementId),
      },
    });
    return;
  }

  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .select('id, order_number, customer_id, guild_id, product_id, plan_id, amount_cents, currency, status, paypal_subscription_id')
    .eq('paypal_subscription_id', billingAgreementId)
    .maybeSingle();
  requireSupabaseSuccess(orderError, 'Failed to load subscription payment order');
  const order = orderData as CommerceOrderRow | null;
  if (
    !order ||
    !isNonEmptyString(order.id) ||
    !isNonEmptyString(order.order_number) ||
    !isNonEmptyString(order.customer_id) ||
    !isNonEmptyString(order.guild_id) ||
    !isNonEmptyString(order.product_id) ||
    !isNonEmptyString(order.plan_id) ||
    order.paypal_subscription_id !== billingAgreementId
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.SALE.COMPLETED',
      resourceId: providerPaymentId,
      parentId: billingAgreementId,
      observedGuildId: order?.guild_id,
      reason: 'order_identity_missing_or_ambiguous',
      evidence: {
        local_order_found: order !== null,
        local_order_id: boundedProviderIdentity(order?.id),
      },
    });
    return;
  }

  const amountCents = parsePayPalAmountToCents(sale?.amount?.total);
  const rawCurrency = sale?.amount?.currency;
  if (
    amountCents == null
    || !isNonEmptyString(rawCurrency)
    || !/^[A-Za-z]{3}$/.test(rawCurrency)
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.SALE.COMPLETED',
      resourceId: providerPaymentId,
      parentId: billingAgreementId,
      observedGuildId: order.guild_id,
      reason: 'financial_identity_malformed',
      evidence: {
        order_id: order.id,
        amount_present: sale?.amount?.total !== undefined,
        currency: boundedProviderIdentity(rawCurrency),
      },
    });
    return;
  }
  const currency = rawCurrency.toUpperCase();
  const routerIncidentEvidence = {
    paypal_payment_id: providerPaymentId,
    paypal_subscription_id: billingAgreementId,
    order_id: order.id,
    order_number: order.order_number,
    guild_id: order.guild_id,
    customer_id: order.customer_id,
    product_id: order.product_id,
    plan_id: order.plan_id,
    provider_amount_cents: amountCents,
    provider_currency: currency,
  };
  let providerContract: AuthoritativeSubscriptionContract;
  let chronology: Awaited<
    ReturnType<typeof recordSubscriptionLifecycleObservation>
  >;
  try {
    providerContract = await requireAuthoritativeSubscriptionAmount(
      billingAgreementId,
    );
    chronology = await recordSubscriptionLifecycleObservation(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.SALE.COMPLETED',
      providerOccurredAt: options.providerOccurredAt,
      providerPaidThroughAt: providerContract.paidThroughAt,
      order,
    });
    if (!chronology.accepted) {
      await recordProviderMoneyIncident(supabase, {
        webhookEventId,
        eventType: 'PAYMENT.SALE.COMPLETED',
        resourceId: providerPaymentId,
        parentId: billingAgreementId,
        observedGuildId: order.guild_id,
        reason: 'subscription_sale_router_failed',
        evidence: routerIncidentEvidence,
      });
      return;
    }
  } catch {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.SALE.COMPLETED',
      resourceId: providerPaymentId,
      parentId: billingAgreementId,
      observedGuildId: order.guild_id,
      reason: 'subscription_sale_router_failed',
      evidence: routerIncidentEvidence,
    });
    return;
  }

  const { data, error } = await supabase.rpc(
    'commerce_record_subscription_sale_or_hold',
    {
      p_paypal_payment_id: providerPaymentId,
      p_paypal_subscription_id: billingAgreementId,
      p_order_id: order.id,
      p_guild_id: order.guild_id,
      p_customer_id: order.customer_id,
      p_product_id: order.product_id,
      p_plan_id: order.plan_id,
      p_webhook_event_id: webhookEventId,
      p_lifecycle_generation: chronology.generation,
      p_amount_cents: amountCents,
      p_currency: currency,
    },
  );
  if (error) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.SALE.COMPLETED',
      resourceId: providerPaymentId,
      parentId: billingAgreementId,
      observedGuildId: order.guild_id,
      reason: 'subscription_sale_router_failed',
      evidence: routerIncidentEvidence,
    });
    return;
  }
  const row = data as Record<string, unknown> | null;
  const disposition = String(row?.disposition ?? '');
  const fulfillmentAllowed = row?.fulfillment_allowed === true;
  const heldDisposition = [
    'held_financial_mismatch',
    'held_terminal_order',
    'held_contract_invalid',
  ].includes(disposition);
  const successfulDisposition = ['staged', 'replay'].includes(disposition);
  const successorReplay = disposition === 'successor_replay';
  const supersededReplay = disposition === 'superseded_replay';
  const actionStatus = row?.action_status;
  if (
    !row
    || (
      !heldDisposition
      && !successfulDisposition
      && !successorReplay
      && !supersededReplay
    )
    || row.paypal_payment_id !== providerPaymentId
    || row.paypal_subscription_id !== billingAgreementId
    || row.order_id !== order.id
    || row.order_number !== order.order_number
    || row.guild_id !== order.guild_id
    || row.customer_id !== order.customer_id
    || row.product_id !== order.product_id
    || row.plan_id !== order.plan_id
    || row.stored_order_amount_cents !== order.amount_cents
    || row.stored_order_currency !== order.currency
    || row.provider_payment_amount_cents !== amountCents
    || row.provider_payment_currency !== currency
    || !isNonEmptyString(row.payment_id)
    || typeof row.payment_created !== 'boolean'
    || !['completed', 'refunded', 'reversed'].includes(
      String(row.terminal_payment_status),
    )
    || (fulfillmentAllowed !== successfulDisposition)
    || (
      successfulDisposition
      && (
        !isNonEmptyString(row.action_id)
        || row.action !== 'fulfill_subscription'
        || !['pending', 'processing', 'completed'].includes(String(actionStatus))
        || row.idempotency_key
          !== `paypal:sale:${providerPaymentId}:fulfill_subscription_renewal`
        || !row.payload
        || typeof row.payload !== 'object'
      )
    )
    || (
      heldDisposition
      && (
        !isNonEmptyString(row.hold_reason)
        || !isNonEmptyString(row.contract_detail)
        || !isNonEmptyString(row.alert_id)
        || !isNonEmptyString(row.alert_type)
      )
    )
    || (
      successorReplay
      && (
        row.terminal_payment_status === 'completed'
        || row.alert_id !== null
        || row.hold_reason !== null
      )
    )
    || (
      supersededReplay
      && (
        fulfillmentAllowed
        || !isNonEmptyString(row.action_id)
        || row.action !== 'fulfill_subscription'
        || !isNonEmptyString(row.contract_detail)
        || row.alert_id !== null
      )
    )
  ) {
    await recordProviderMoneyIncident(supabase, {
      webhookEventId,
      eventType: 'PAYMENT.SALE.COMPLETED',
      resourceId: providerPaymentId,
      parentId: billingAgreementId,
      observedGuildId: order.guild_id,
      reason: 'subscription_sale_router_failed',
      evidence: routerIncidentEvidence,
    });
    return;
  }

  console.log(
    `[Webhook] Subscription payment ${providerPaymentId} persisted with ${disposition}`,
  );
}

// ── Capture Refunded / Reversed ─────────────────────

export interface RefundHandlerOptions {
  retryingFailedEvent?: boolean;
  legacyUsdSaleTolerance?: boolean;
}

export async function handleCaptureRefunded(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  eventType: string,
  options: RefundHandlerOptions = {},
) {
  const captureId = resolveCaptureRefundPaymentId(resource);

  if (!captureId) {
    throw new Error(
      `${eventType} arrived without one unambiguous canonical capture_id`,
    );
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
    throw new Error(
      `${eventType} arrived without one unambiguous canonical sale_id`,
    );
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

interface RefundAmountInfo {
  /** Amount of THIS refund event, in cents (null = missing/unparseable). */
  refundAmountCents: number | null;
  refundCurrency: string | null;
  refundAmountProvided: boolean;
  refundCurrencyProvided: boolean;
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
        refundAmountProvided: false,
        refundCurrencyProvided: false,
        paypalTotalRefundedCents: null,
        paypalTotalRefundedCurrency: null,
      };
    }
    const rawRefundAmount = parsed.data.amount?.value ?? parsed.data.amount?.total;
    const rawRefundCurrency = parsed.data.amount?.currency_code
      ?? parsed.data.amount?.currency;
    return {
      refundAmountCents: parsePayPalAmountToCents(rawRefundAmount),
      refundCurrency: rawRefundCurrency ?? null,
      refundAmountProvided: rawRefundAmount !== undefined,
      refundCurrencyProvided: rawRefundCurrency !== undefined,
      paypalTotalRefundedCents: parsePayPalAmountToCents(
        parsed.data.seller_payable_breakdown?.total_refunded_amount?.value
          ?? parsed.data.total_refunded_amount?.value,
      ),
      paypalTotalRefundedCurrency:
        parsed.data.seller_payable_breakdown?.total_refunded_amount?.currency_code
          ?? parsed.data.total_refunded_amount?.currency
          ?? null,
    };
  }

  const parsed = paypalSaleResourceSchema.safeParse(resource);
  if (!parsed.success) {
    return {
      refundAmountCents: null,
      refundCurrency: null,
      refundAmountProvided: false,
      refundCurrencyProvided: false,
      paypalTotalRefundedCents: null,
      paypalTotalRefundedCurrency: null,
    };
  }
  const rawRefundAmount = parsed.data.amount?.total;
  const rawRefundCurrency = parsed.data.amount?.currency;
  return {
    // Legacy v1 sale refund events express the event amount as a negative
    // decimal delta. No other numeric syntax is accepted.
    refundAmountCents: parsePayPalAmountToCents(rawRefundAmount, true),
    refundCurrency: rawRefundCurrency ?? null,
    refundAmountProvided: rawRefundAmount !== undefined,
    refundCurrencyProvided: rawRefundCurrency !== undefined,
    paypalTotalRefundedCents: parsePayPalAmountToCents(parsed.data.total_refunded_amount?.value),
    paypalTotalRefundedCurrency: parsed.data.total_refunded_amount?.currency ?? null,
  };
}

/**
 * Exact subscription evidence for the legacy USD-mislabel tolerance. A row
 * already adopted as 'sale' was proven by a signed provider event. A legacy
 * null resource type predates adoption entirely, so it qualifies only when
 * its order carries the exact subscription shape the sale ledger RPC
 * enforces (plan + provider subscription identity) — the only path that
 * ever wrote the mislabeled rows was the subscription-payment handler, and
 * that handler always bound its payment to such an order.
 */
async function isLegacySubscriptionSalePayment(
  supabase: ReturnType<typeof createAdminSupabase>,
  payment: {
    order_id: string;
    guild_id: string;
    customer_id: string;
    paypal_resource_type: string | null;
  },
): Promise<boolean> {
  if (payment.paypal_resource_type === 'sale') return true;
  if (payment.paypal_resource_type !== null) return false;
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, guild_id, customer_id, plan_id, paypal_subscription_id')
    .eq('id', payment.order_id)
    .maybeSingle();
  requireSupabaseSuccess(
    orderError,
    'Failed to load order for legacy refund currency evidence',
  );
  return Boolean(
    order
    && order.id === payment.order_id
    && order.guild_id === payment.guild_id
    && order.customer_id === payment.customer_id
    && isNonEmptyString(order.plan_id)
    && isNonEmptyString(order.paypal_subscription_id),
  );
}

type RefundScope =
  | { kind: 'full'; reason: 'reversal' | 'cumulative_total' }
  | { kind: 'partial' };

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
  const resourceType = identifierField === 'capture_id' ? 'capture' : 'sale';

  const { data: payment, error: paymentError } = await supabase
    .from('payments')
    .select('id, order_id, customer_id, guild_id, paypal_payment_id, paypal_resource_type, status, amount_cents, currency')
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
  if (
    !isNonEmptyString(payment.id)
    || !isNonEmptyString(payment.order_id)
    || !isNonEmptyString(payment.customer_id)
    || !isNonEmptyString(payment.guild_id)
    || payment.paypal_payment_id !== paymentId
    // Legacy one-time capture rows intentionally remain null until a signed
    // provider event proves their resource type. The serialized ledger RPC
    // adopts that null under the same exact payment/order lock. A conflicting
    // non-null type remains a hard identity failure.
    || (payment.paypal_resource_type !== null
      && payment.paypal_resource_type !== resourceType)
    || !['completed', 'refunded', 'reversed'].includes(payment.status)
    || !Number.isSafeInteger(payment.amount_cents)
    || payment.amount_cents <= 0
    || typeof payment.currency !== 'string'
    || !/^[A-Za-z]{3}$/.test(payment.currency)
  ) {
    throw new Error(
      `${eventType} for ${identifierName} ${paymentId} matched a malformed or wrong-resource payment`,
    );
  }
  const paymentCurrency = payment.currency.toUpperCase();

  const orderId = payment.order_id;
  const isReversal = eventType.endsWith('.REVERSED');
  const refundStatus = isReversal ? 'reversed' : 'refunded';
  const resolvedAmounts = resolveRefundAmounts(resource, eventType);
  const refundId = isCanonicalPayPalResourceId(resource.id) ? resource.id : null;
  if (!refundId) {
    throw new Error(`${eventType} for ${identifierName} ${paymentId} has no canonical refund id`);
  }

  // Legacy tolerance (W2 codex round 2, restored): the pre-deploy
  // handleSubscriptionPayment persisted a hardcoded 'USD' currency label
  // while amount_cents was parsed from the sale payload in the plan's actual
  // currency — the recorded CENTS are right, only the label is wrong. PayPal
  // always issues refunds in the parent sale's currency, so when a
  // PAYMENT.SALE.REFUNDED against a USD-labeled sale payment carries a
  // signature-verified payload whose cumulative refunded total is stated in
  // the refund's own currency, the payload — not our label — is
  // authoritative and the exact-cents comparison stays valid. Without this,
  // such a refund throws identically on every PayPal retry forever: never
  // recorded, access retained, no operator alert. Every other mismatch stays
  // a hard failure — post-deploy sale rows persist the sale's real currency
  // and capture rows always persisted the checkout currency, so for them a
  // differing refund currency is evidence of a wrong parent, not a label bug.
  // REVERSED events against the same legacy rows get the identical tolerance
  // when their payload self-states amounts: a reversal that omits amounts
  // never mismatches (the RPC computes the remaining balance), and a reversal
  // stating an amount without the confirming cumulative total stays
  // fail-closed — the payload then lacks its own proof of the sale's real
  // currency.
  const legacyUsdMislabelTolerated = options.legacyUsdSaleTolerance !== false
    && resourceType === 'sale'
    && paymentCurrency === 'USD'
    && resolvedAmounts.refundAmountCents != null
    && resolvedAmounts.refundAmountCents > 0
    && typeof resolvedAmounts.refundCurrency === 'string'
    && /^[A-Z]{3}$/.test(resolvedAmounts.refundCurrency)
    && resolvedAmounts.refundCurrency !== paymentCurrency
    && resolvedAmounts.paypalTotalRefundedCurrency != null
    && resolvedAmounts.paypalTotalRefundedCurrency.toUpperCase()
      === resolvedAmounts.refundCurrency
    && await isLegacySubscriptionSalePayment(supabase, {
      order_id: orderId,
      guild_id: payment.guild_id,
      customer_id: payment.customer_id,
      paypal_resource_type: payment.paypal_resource_type,
    });

  if (
    !isReversal
    && (
      resolvedAmounts.refundAmountCents == null
      || resolvedAmounts.refundAmountCents <= 0
      || typeof resolvedAmounts.refundCurrency !== 'string'
      || !/^[A-Z]{3}$/.test(resolvedAmounts.refundCurrency)
      || (
        resolvedAmounts.refundCurrency !== paymentCurrency
        && !legacyUsdMislabelTolerated
      )
    )
  ) {
    throw new Error(
      `${eventType} for ${identifierName} ${paymentId} has ambiguous refund amount or currency`,
    );
  }
  if (
    isReversal
    && (
      resolvedAmounts.refundAmountProvided !== resolvedAmounts.refundCurrencyProvided
      || (
        resolvedAmounts.refundAmountProvided
        && (
          resolvedAmounts.refundAmountCents == null
          || resolvedAmounts.refundAmountCents <= 0
          || typeof resolvedAmounts.refundCurrency !== 'string'
          || !/^[A-Z]{3}$/.test(resolvedAmounts.refundCurrency)
          || (
            resolvedAmounts.refundCurrency !== paymentCurrency
            && !legacyUsdMislabelTolerated
          )
        )
      )
    )
  ) {
    throw new Error(
      `${eventType} for ${identifierName} ${paymentId} has malformed reversal amount or currency`,
    );
  }

  const reversalCurrency = typeof resolvedAmounts.refundCurrency === 'string'
    && /^[A-Z]{3}$/.test(resolvedAmounts.refundCurrency)
    ? (legacyUsdMislabelTolerated ? paymentCurrency : resolvedAmounts.refundCurrency)
    : null;
  // Under the legacy tolerance the ledger row must keep the stored label:
  // the record RPC and its ledger sanity scan require every payment_refunds
  // row to match payments.currency exactly. The payload's real currency is
  // preserved in the audit details so the mislabel stays operator-visible.
  const refundLedgerCurrency = legacyUsdMislabelTolerated
    ? paymentCurrency
    : resolvedAmounts.refundCurrency;
  const legacyMislabelAuditDetails = legacyUsdMislabelTolerated
    ? {
        legacy_usd_currency_mislabel: true,
        stored_payment_currency: paymentCurrency,
        provider_refund_currency: resolvedAmounts.refundCurrency,
      }
    : {};
  const { data: recordedValue, error: recordError } = await supabase.rpc(
    'commerce_record_paypal_refund_event',
    {
      p_payment_id: payment.id,
      p_order_id: orderId,
      p_guild_id: payment.guild_id,
      p_customer_id: payment.customer_id,
      p_paypal_payment_id: paymentId,
      p_resource_type: resourceType,
      p_paypal_refund_id: refundId,
      p_event_type: eventType,
      p_refund_amount_cents: resolvedAmounts.refundAmountCents,
      p_currency: isReversal ? reversalCurrency : refundLedgerCurrency,
      p_audit_details: {
        source: 'paypal_webhook',
        provider_total_refunded_cents: resolvedAmounts.paypalTotalRefundedCents,
        provider_total_refunded_currency: resolvedAmounts.paypalTotalRefundedCurrency,
        ...legacyMislabelAuditDetails,
      },
    },
  );
  requireSupabaseSuccess(recordError, 'Failed to atomically record refund event');
  const recorded = recordedValue as Record<string, unknown> | null;
  if (
    !recorded
    || recorded.payment_id !== payment.id
    || recorded.order_id !== orderId
    || recorded.paypal_refund_id !== refundId
    || recorded.event_type !== eventType
    || !Number.isSafeInteger(recorded.refund_amount_cents)
    || (recorded.refund_amount_cents as number) < 0
    || (
      resolvedAmounts.refundAmountProvided
      && recorded.refund_amount_cents !== resolvedAmounts.refundAmountCents
    )
    || recorded.currency !== paymentCurrency
    || !Number.isSafeInteger(recorded.cumulative_refunded_cents)
    || (recorded.cumulative_refunded_cents as number) < 0
    || (
      (recorded.cumulative_refunded_cents as number)
      < (recorded.refund_amount_cents as number)
    )
    || (recorded.cumulative_refunded_cents as number) > payment.amount_cents
    || typeof recorded.full_refund !== 'boolean'
    || recorded.full_refund !== (recorded.cumulative_refunded_cents === payment.amount_cents)
    || typeof recorded.already_recorded !== 'boolean'
    || typeof recorded.terminal_witness !== 'boolean'
    || recorded.terminal_history_consistent !== true
    || typeof recorded.terminal_history_replay !== 'boolean'
    || !['completed', 'refunded', 'reversed'].includes(
      recorded.terminal_payment_status as string,
    )
    // The locked RPC view may have advanced after this handler read the row.
    // Only completed -> terminal is monotonic; an initially terminal payment
    // must remain exactly the same status.
    || (
      payment.status !== 'completed'
      && recorded.terminal_payment_status !== payment.status
    )
    || recorded.terminal_history_replay
      !== (recorded.terminal_payment_status !== 'completed')
    || (recorded.terminal_witness === true && recorded.full_refund !== true)
    || (
      recorded.already_recorded === false
      && recorded.full_refund === true
      && recorded.terminal_witness !== true
    )
    || typeof recorded.partial_audit_recorded !== 'boolean'
    || typeof recorded.partial_alert_recorded !== 'boolean'
  ) {
    throw new Error('Atomic refund event recording returned mismatched proof');
  }
  const amounts: RefundAmountInfo = {
    ...resolvedAmounts,
    refundAmountCents: recorded.refund_amount_cents as number,
    refundCurrency: recorded.currency as string,
  };
  const cumulativeRefundedCents = recorded.cumulative_refunded_cents as number;
  const alreadyRecorded = recorded.already_recorded as boolean;
  const terminalWitness = recorded.terminal_witness as boolean;
  const terminalHistoryConsistent = recorded.terminal_history_consistent as boolean;
  const terminalHistoryReplay = recorded.terminal_history_replay as boolean;
  const terminalPaymentStatus = recorded.terminal_payment_status as
    | 'completed'
    | 'refunded'
    | 'reversed';

  // A terminal payment can only acknowledge an exact, immutable ledger
  // witness. The record RPC rejects unknown terminal ids before insert; this
  // independent proof check prevents a malformed RPC response from turning a
  // new signed payload into success. A REFUNDED witness may legitimately be
  // replayed after a later REVERSED witness, but only when the locked ledger
  // proves that later REVERSED transition. Do not infer chronology from refund
  // amounts: both an old partial and an old full REFUNDED row are valid before
  // a later zero-remaining REVERSED witness.
  if (terminalPaymentStatus === 'refunded' || terminalPaymentStatus === 'reversed') {
    const targetMatchesTerminalStatus = refundStatus === terminalPaymentStatus
      || (terminalPaymentStatus === 'reversed' && refundStatus === 'refunded');
    if (
      !alreadyRecorded
      || !terminalHistoryReplay
      || !terminalHistoryConsistent
      || !targetMatchesTerminalStatus
    ) {
      throw new Error('Terminal payment refund replay does not match durable terminal history');
    }
    console.info(
      `[Webhook] ${eventType} for ${identifierName} ${paymentId} — ` +
        `validated existing terminal ledger witness ${refundId}, no effects replayed`,
    );
    return;
  }

  // A replayed historical row observes today's cumulative ledger total, but
  // it does not thereby acquire ownership of the full-refund transition. If a
  // later event filled the ledger before its own webhook finalized the payment
  // marker, only that later row may resume the access effects.
  if (alreadyRecorded && recorded.full_refund && !terminalWitness) {
    console.info(
      `[Webhook] ${eventType} for ${identifierName} ${paymentId} — ` +
        `validated historical ledger witness ${refundId}, no effects replayed`,
    );
    return;
  }

  const scope: RefundScope = terminalWitness
    ? { kind: 'full', reason: isReversal ? 'reversal' : 'cumulative_total' }
    : { kind: 'partial' };

  const finalizeRefundStatus = async (
    targetStatus: 'refunded' | 'reversed',
    auditDetails: Record<string, unknown>,
  ) => {
    const { data: finalizedValue, error: finalizeError } = await supabase.rpc(
      'commerce_finalize_paypal_refund_status',
      {
        p_payment_id: payment.id,
        p_order_id: orderId,
        p_guild_id: payment.guild_id,
        p_customer_id: payment.customer_id,
        p_paypal_payment_id: paymentId,
        p_resource_type: resourceType,
        p_payment_status: targetStatus,
        p_paypal_refund_id: refundId,
        p_event_type: eventType,
        p_audit_details: auditDetails,
      },
    );
    requireSupabaseSuccess(finalizeError, 'Failed to atomically finalize refund status');
    const finalized = finalizedValue as Record<string, unknown> | null;
    if (
      !finalized
      || finalized.order_id !== orderId
      || finalized.payment_id !== payment.id
      || finalized.order_status !== 'refunded'
      || finalized.payment_status !== targetStatus
      || typeof finalized.already_terminal !== 'boolean'
      || typeof finalized.audit_recorded !== 'boolean'
      || !Number.isSafeInteger(finalized.partial_alerts_resolved)
      || (finalized.partial_alerts_resolved as number) < 0
    ) {
      throw new Error('Atomic refund status finalization returned mismatched proof');
    }
    return finalized;
  };

  if (scope.kind === 'partial') {
    // Ledger, audit and alert commit under the same order/payment/refund
    // locks. A replay therefore has no separate crash window to repair here.
    if (alreadyRecorded && !options.retryingFailedEvent) {
      console.info(
        `[Webhook] ${eventType} for ${identifierName} ${paymentId} — partial refund ${refundId} already processed, skipping`,
      );
      return;
    }

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
        .eq('customer_id', payment.customer_id)
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
        .eq('customer_id', payment.customer_id)
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
    .eq('guild_id', payment.guild_id)
    .eq('customer_id', payment.customer_id)
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
    .eq('guild_id', payment.guild_id)
    .eq('customer_id', payment.customer_id)
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

  // Commit marker LAST. The deferred payment-parent status guard spans both
  // rows, so this must be one database transaction rather than separate
  // PostgREST updates. The RPC also records the exact full-refund audit under
  // the same ledger locks, preventing crash/concurrent-replay duplicates.
  const finalized = await finalizeRefundStatus(refundStatus, {
    full_refund_reason: scope.reason,
    refund_amount_cents: amounts.refundAmountCents,
    payment_amount_cents: payment.amount_cents,
    cumulative_refunded_cents: cumulativeRefundedCents,
    entitlement_ids: (activeEntitlements ?? []).map((ent) => ent.id),
    license_key_ids: licenseKeyIds,
    role_revocation_source: 'entitlement_status_trigger',
    ...legacyMislabelAuditDetails,
  });

  console.log(
    `[Webhook] ${eventType} processed for order ${orderId} (${identifierName} ${paymentId}) — ` +
      `full refund, access revoked, payment ${finalized.payment_status}`,
  );
}

// ── Disputes / chargebacks (Finding 9) ──────────────────────────────────────

/**
 * The transaction ids a dispute names. PayPal puts the capture (or sale) id
 * this integration stores in `payments.paypal_payment_id` on
 * `disputed_transactions[].seller_transaction_id`.
 */
export function resolveDisputedTransactionIds(
  resource: Record<string, unknown>,
): string[] {
  const transactions = resource.disputed_transactions;
  if (!Array.isArray(transactions)) return [];

  const ids = new Set<string>();
  for (const txn of transactions) {
    if (!txn || typeof txn !== 'object') continue;
    const sellerTxnId = (txn as { seller_transaction_id?: unknown }).seller_transaction_id;
    // Only canonical provider ids reach a database lookup, matching the guard
    // the refund path already applies.
    if (isNonEmptyString(sellerTxnId) && isCanonicalPayPalResourceId(sellerTxnId)) {
      ids.add(sellerTxnId);
    }
  }
  return [...ids];
}

/**
 * Lossless identity set used at authorization/mutation boundaries. Unlike the
 * display-oriented helper above, one malformed array entry invalidates the
 * whole set so a full PayPal payload can never be scoped or partly applied
 * from a silently filtered subset.
 */
export function resolveStrictDisputedTransactionIds(
  resource: Record<string, unknown>,
): { ids: string[]; valid: boolean } {
  const transactions = resource.disputed_transactions;
  if (!Array.isArray(transactions)) return { ids: [], valid: true };

  const ids: string[] = [];
  for (const txn of transactions) {
    if (!txn || typeof txn !== 'object') return { ids: [], valid: false };
    const sellerTxnId = (txn as { seller_transaction_id?: unknown }).seller_transaction_id;
    if (
      !isNonEmptyString(sellerTxnId)
      || !isCanonicalPayPalResourceId(sellerTxnId)
    ) {
      return { ids: [], valid: false };
    }
    ids.push(sellerTxnId);
  }
  return { ids, valid: true };
}

/** The dispute's own identifier. PayPal uses `dispute_id`, not `id`. */
export function resolveDisputeId(resource: Record<string, unknown>): string | null {
  const disputeId = resource.dispute_id ?? resource.id;
  return isNonEmptyString(disputeId) && isCanonicalPayPalResourceId(disputeId)
    ? disputeId
    : null;
}

function readDisputeString(value: unknown): string | null {
  return isNonEmptyString(value) && value.length <= 128 ? value : null;
}

/**
 * Handle `CUSTOMER.DISPUTE.CREATED` / `.UPDATED` / `.RESOLVED`.
 *
 * Previously these fell through to the route's `default:` branch and were then
 * written as `result: 'success'` — a chargeback recorded as a success, with
 * `orders.status = 'disputed'` present in the CHECK constraint but never set
 * by anything.
 *
 * What this does: resolve the disputed transaction(s) back to local orders,
 * flip `orders.status` to `'disputed'`, and alert the operator.
 *
 * What this deliberately does NOT do: revoke access or move money. Settlement
 * already works — `PAYMENT.CAPTURE.REVERSED` / `.REFUNDED` revoke access when
 * funds actually move — and a dispute is not yet a loss. Re-doing settlement
 * here would revoke access from a customer whose dispute the seller may win.
 *
 * Idempotent: the status flip is conditional on the current status, so a
 * redelivery or replay is a no-op, and the alert is DB-deduped on dispute id.
 */
export async function handleDisputeEvent(
  supabase: AdminSupabase,
  resource: Record<string, unknown>,
  eventType: string,
) {
  const disputeId = resolveDisputeId(resource);
  if (!disputeId) {
    throw new Error('Dispute event is missing a usable dispute id');
  }

  const transactionSet = resolveStrictDisputedTransactionIds(resource);
  if (!transactionSet.valid) {
    throw new Error('Dispute event contains a malformed transaction identity set');
  }
  const transactionIds = transactionSet.ids;

  const amount = resource.dispute_amount as
    { value?: unknown; currency_code?: unknown } | undefined;
  const amountCents = parsePayPalAmountToCents(amount?.value);
  const currency = typeof amount?.currency_code === 'string'
    && /^[A-Z]{3}$/.test(amount.currency_code)
    ? amount.currency_code
    : null;

  // Resolve and mutate through one exact-identity database boundary. The RPC
  // rejects mixed-guild matches before touching any order.
  let guildId: string | null = null;
  const orderIds: string[] = [];
  let markedDisputed = 0;
  if (transactionIds.length > 0) {
    const { data: matches, error } = await supabase.rpc(
      'commerce_apply_paypal_dispute',
      {
        p_paypal_payment_ids: transactionIds,
        p_mark_disputed: eventType !== 'CUSTOMER.DISPUTE.RESOLVED',
      },
    );
    requireSupabaseSuccess(error, 'Failed to apply PayPal dispute');

    const rows = Array.isArray(matches) ? matches : matches ? [matches] : [];
    const guildIds = new Set<string>();
    for (const match of rows) {
      if (isNonEmptyString(match.guild_id)) guildIds.add(match.guild_id);
      if (isNonEmptyString(match.order_id) && !orderIds.includes(match.order_id)) {
        orderIds.push(match.order_id);
      }
      if (match.marked_disputed === true) markedDisputed += 1;
    }
    if (guildIds.size > 1) {
      throw new Error('PayPal dispute RPC returned mixed-guild evidence');
    }
    guildId = guildIds.size === 1 ? [...guildIds][0]! : null;
  }

  await raiseDisputeAlert(supabase, {
    disputeId,
    eventType,
    guildId,
    status: readDisputeString(resource.status),
    reason: readDisputeString(resource.reason),
    amountCents,
    currency,
    orderIds,
    unmatched: orderIds.length === 0,
  });

  console.log(
    `[Webhook] ${eventType} recorded for dispute ${disputeId} — ` +
      `${orderIds.length} order(s) matched, ${markedDisputed} marked disputed`,
  );
}

// ── Denied capture (Finding 9) ──────────────────────────────────────────────

/**
 * Handle `PAYMENT.CAPTURE.DENIED` — PayPal refused to settle a capture.
 *
 * This event type was not in `PAYPAL_HANDLED_WEBHOOK_EVENTS` at all, so the
 * webhook was never even subscribed to it; had it arrived it would have been
 * recorded as a success. The order sat `pending` forever with no alert.
 *
 * Idempotent: the cancel is conditional on `status = 'pending'`, so a replay
 * is a no-op, and the alert is DB-deduped on capture id.
 */
export async function handleCaptureDenied(
  supabase: AdminSupabase,
  resource: Record<string, unknown>,
) {
  const captureId = resource.id;
  if (!isNonEmptyString(captureId) || !isCanonicalPayPalResourceId(captureId)) {
    throw new Error('Denied capture is missing its provider id');
  }

  const parsed = paypalCaptureResourceSchema.safeParse(resource);
  const capture: PayPalCaptureResource = parsed.success
    ? parsed.data
    : { id: captureId };

  const amountCents = parsePayPalAmountToCents(capture.amount?.value);
  const currency = typeof capture.amount?.currency_code === 'string'
    && /^[A-Z]{3}$/.test(capture.amount.currency_code)
    ? capture.amount.currency_code
    : null;

  // custom_id carries the signed checkout identities; a capture resource keeps
  // it at the root (unlike an Order, which keeps it on the purchase units).
  let claimedGuildId: string | null = null;
  if (isNonEmptyString(capture.custom_id)) {
    try {
      const raw = JSON.parse(capture.custom_id);
      const candidate = raw?.g ?? raw?.guild_id;
      if (isNonEmptyString(candidate)) claimedGuildId = candidate;
    } catch {
      /* malformed custom_id — only an exact local order can authorize effects */
    }
  }

  const paypalOrderId = capture.supplementary_data?.related_ids?.order_id ?? null;

  // paypal_order_id is globally unique (partial unique index). Resolve it even
  // when custom_id is absent/malformed, then derive the tenant from the local
  // order. custom_id is only a consistency hint; it never grants cross-guild
  // authority.
  let guildId: string | null = null;
  let orderId: string | null = null;
  let orderCancelled = false;
  if (isNonEmptyString(paypalOrderId)) {
    const { data: applied, error } = await supabase.rpc(
      'commerce_apply_capture_denied',
      {
        p_paypal_order_id: paypalOrderId,
        p_claimed_guild_id: claimedGuildId,
      },
    );
    requireSupabaseSuccess(error, 'Failed to apply denied capture');
    const rows = Array.isArray(applied) ? applied : applied ? [applied] : [];
    if (rows.length > 1) {
      throw new Error('Denied capture RPC returned multiple orders');
    }
    const order = rows[0];
    if (order) {
      if (!isNonEmptyString(order.guild_id) || !isNonEmptyString(order.order_id)) {
        throw new Error('Denied capture order has no usable guild identity');
      }
      orderId = order.order_id;
      guildId = order.guild_id;
      orderCancelled = order.order_cancelled === true;
    }
  }

  if (orderId && guildId) {
    await raiseCaptureDeniedAlert(supabase, {
      captureId,
      guildId,
      orderId,
      paypalOrderId: paypalOrderId ?? null,
      amountCents,
      currency,
      orderCancelled,
    });
  }

  console.log(
    `[Webhook] PAYMENT.CAPTURE.DENIED recorded for capture ${captureId} — ` +
      `order ${orderId ?? 'unmatched'}${orderCancelled ? ' cancelled' : ''}`,
  );
}
