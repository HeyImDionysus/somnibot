/**
 * Commerce Fulfillment Service
 *
 * Unified pipeline for post-payment fulfillment. When the dashboard webhook
 * writes a fulfillment request to `bot_action_queue`, this service:
 *
 * 1. Grants entitlement via EntitlementService (creates DB record + Discord roles)
 * 2. Emits platform events (purchase.completed / subscription.activated)
 * 3. Sends receipt DM with license key (if applicable)
 * 4. Logs everything to audit trail
 *
 * This bridges the gap between the Next.js webhook (no Discord access) and the
 * bot process (full Discord access + event bus).
 */

import type { Guild, User } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from './event-bus.js';
import {
  preparedOutwardEffect,
  runCommerceOutwardIntent,
  type CommerceOutwardBeginMode,
  type CommerceOutwardIntentKind,
  type CommerceOutwardResult,
} from './commerce-outward.js';
import { inspectTemporaryRoleGrant } from './temp-role-ownership.js';
import {
  EntitlementService,
  PurchaseRoleDeliveryTerminalNoopError,
  type PurchaseRoleDeliveryAttempt,
  type RoleDeliveryActionClaim,
} from '../features/commerce/entitlement-service.js';
import { prepareReceiptDM } from '../features/commerce/receipt-builder.js';
import { resolveBrandKit } from '../features/branding/index.js';
import { raiseOwnerAlert } from './alert-service.js';
import { createLogger, getGracePeriodDays } from '@somnibot/shared';

const log = createLogger('Fulfillment');
import { checkPurchaseVelocity, checkPaymentPattern, checkCriticalThreshold, loadFraudThresholds } from './fraud-detection.js';

const KNOWN_ORDER_STATUSES = [
  'pending',
  'completed',
  'refunded',
  'disputed',
  'cancelled',
  'pending_review',
];

const TERMINAL_ORDER_STATUSES = new Set(['refunded', 'disputed', 'cancelled']);
const PAYPAL_SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

class CommerceOutwardSupersededError extends Error {
  constructor(label: string) {
    super(`${label} was superseded by a terminal subscription lifecycle`);
    this.name = 'CommerceOutwardSupersededError';
  }
}

function requireTerminalOrderStatus(status: string): void {
  if (!TERMINAL_ORDER_STATUSES.has(status)) {
    throw new Error(
      `Fulfillment order is not committed (status ${status}); retry after payment state resolves`,
    );
  }
}

function hasExactPayPalSubscriptionIdentity(
  orderValue: unknown,
  payload: FulfillmentPayload,
): boolean {
  const orderSubscriptionId = orderValue ?? null;
  const payloadSubscriptionId = payload.paypal_subscription_id ?? null;
  if (payload.entitlement_type === 'one_time') {
    return orderSubscriptionId === null && payloadSubscriptionId === null;
  }
  return typeof orderSubscriptionId === 'string'
    && PAYPAL_SUBSCRIPTION_ID_PATTERN.test(orderSubscriptionId)
    && payloadSubscriptionId === orderSubscriptionId;
}

// ── Types ──────────────────────────────────────────────────

export interface FulfillmentPayload {
  /** Exact immutable fulfillment contract carried by the claimed queue action. */
  fulfillment_type: string;
  guild_id: string;
  customer_id: string;
  discord_id: string;
  product_id: string;
  product_name: string;
  order_id: string;
  order_number: string;
  /** Exact completed PayPal capture carried by one-time purchase actions. */
  paypal_capture_id?: string;
  plan_id?: string;
  paypal_subscription_id?: string;
  paypal_plan_id?: string;
  webhook_event_id?: string;
  provider_event_type?: string;
  provider_occurred_at?: string;
  provider_paid_through_at?: string | null;
  lifecycle_generation?: number;
  amount_cents: number;
  currency: string;
  granted_role_ids: string[];
  granted_channel_ids: string[];
  /** Frozen one-time-purchase configuration; subscriptions never use this. */
  temporary_role_grants?: Array<{
    role_id: string;
    duration_seconds: number;
  }>;
  license_key_id?: string;
  license_key_plaintext?: string;
  entitlement_type: 'one_time' | 'subscription';
  /** For renewals — existing entitlement to reactivate */
  existing_entitlement_id?: string;
}

function requireSubscriptionLifecyclePayload(
  payload: FulfillmentPayload,
): { paidThroughAt: string | null } {
  const allowedEventTypes: Record<string, string[]> = {
    subscription_activated: ['BILLING.SUBSCRIPTION.ACTIVATED'],
    subscription_renewed: ['PAYMENT.SALE.COMPLETED'],
    subscription_cancelled: [
      'BILLING.SUBSCRIPTION.CANCELLED',
      'BILLING.SUBSCRIPTION.EXPIRED',
    ],
    subscription_suspended: ['BILLING.SUBSCRIPTION.SUSPENDED'],
    subscription_payment_failed: ['BILLING.SUBSCRIPTION.PAYMENT.FAILED'],
  };
  const eventTypes = allowedEventTypes[payload.fulfillment_type];
  const occurredAt = Date.parse(payload.provider_occurred_at ?? '');
  const paidThroughAt = payload.provider_paid_through_at ?? null;
  if (
    !eventTypes
    || typeof payload.webhook_event_id !== 'string'
    || payload.webhook_event_id.length === 0
    || payload.webhook_event_id.trim() !== payload.webhook_event_id
    || typeof payload.provider_event_type !== 'string'
    || !eventTypes.includes(payload.provider_event_type)
    || !Number.isFinite(occurredAt)
    || !Number.isSafeInteger(payload.lifecycle_generation)
    || (payload.lifecycle_generation ?? 0) < 1
    || (
      paidThroughAt !== null
      && (
        typeof paidThroughAt !== 'string'
        || !Number.isFinite(Date.parse(paidThroughAt))
      )
    )
    || (
      ['subscription_activated', 'subscription_renewed'].includes(
        payload.fulfillment_type,
      )
      && (
        paidThroughAt === null
        || Date.parse(paidThroughAt) <= occurredAt
      )
    )
  ) {
    throw new Error('Subscription fulfillment payload failed lifecycle validation');
  }
  return { paidThroughAt };
}

export interface FulfillmentExecutionContext extends RoleDeliveryActionClaim {}

type PreparedTemporaryRoleGrant = {
  id: string;
  grant_status: 'pending' | 'applied' | 'removed';
  remove_on_expiry: boolean;
  expires_at: string;
};

type AcknowledgedTemporaryRoleGrant = {
  id: string;
  grant_status: 'applied';
  applied_at: string;
  expires_at: string;
};

type TemporaryRoleAttachmentDisposition =
  | 'reserve_add'
  | 'reserve_inherited'
  | 'reserved_replay'
  | 'owned_replay'
  | 'manual_baseline'
  | 'dependency_pending'
  | 'terminal'
  | 'operator_held';

type TemporaryRoleAttachment = {
  intentState: 'open' | 'cleanup_required' | 'operator_required';
  mayMutate: boolean;
  ownsRemoval: boolean;
  claimNewlyAcquired: boolean;
  disposition: TemporaryRoleAttachmentDisposition;
};

type TemporaryRolePromotion = {
  intentState: 'open' | 'operator_required';
  promoted: boolean;
  ownsRemoval: boolean;
  grantStatus: 'applied' | 'pending';
  expiresAt: string;
};

class TemporaryRoleMutationUncertainError extends Error {
  constructor(roleId: string, detail: unknown) {
    super(
      `Temporary role ${roleId} add result is uncertain; durable ownership requires operator recovery: ${
        detail instanceof Error ? detail.message : String(detail)
      }`,
    );
  }
}

const DISCORD_ROLE_ID_PATTERN = /^\d{17,20}$/;
const MAX_TEMP_ROLE_DURATION_SECONDS = 315_360_000;

function normalizeTemporaryRoleGrants(
  value: FulfillmentPayload['temporary_role_grants'],
): Array<{ role_id: string; duration_seconds: number }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('Malformed temporary_role_grants payload');
  }

  const validated = value.map((grant) => {
    if (
      !grant
      || typeof grant.role_id !== 'string'
      || !DISCORD_ROLE_ID_PATTERN.test(grant.role_id)
      || !Number.isSafeInteger(grant.duration_seconds)
      || grant.duration_seconds <= 0
      || grant.duration_seconds > MAX_TEMP_ROLE_DURATION_SECONDS
    ) {
      throw new Error('Malformed temporary role grant snapshot');
    }
    return grant;
  });

  // A queue payload is untrusted input. Sort first so duplicate role rows are
  // resolved deterministically; for conflicting durations, retain the longest
  // frozen duration so a duplicate cannot shorten purchased access.
  validated.sort((left, right) =>
    left.role_id.localeCompare(right.role_id)
    || right.duration_seconds - left.duration_seconds,
  );

  const unique = new Map<string, { role_id: string; duration_seconds: number }>();
  for (const grant of validated) {
    if (!unique.has(grant.role_id)) unique.set(grant.role_id, grant);
  }
  return [...unique.values()];
}

function isPreparedTemporaryRoleGrant(value: unknown): value is PreparedTemporaryRoleGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<PreparedTemporaryRoleGrant>;
  return (
    typeof grant.id === 'string'
    && grant.id.length > 0
    && (
      grant.grant_status === 'pending'
      || grant.grant_status === 'applied'
      || grant.grant_status === 'removed'
    )
    && typeof grant.remove_on_expiry === 'boolean'
    && typeof grant.expires_at === 'string'
    && Number.isFinite(Date.parse(grant.expires_at))
  );
}

function isAcknowledgedTemporaryRoleGrant(
  value: unknown,
): value is AcknowledgedTemporaryRoleGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<AcknowledgedTemporaryRoleGrant>;
  return (
    typeof grant.id === 'string'
    && grant.id.length > 0
    && grant.grant_status === 'applied'
    && typeof grant.applied_at === 'string'
    && Number.isFinite(Date.parse(grant.applied_at))
    && typeof grant.expires_at === 'string'
    && Number.isFinite(Date.parse(grant.expires_at))
  );
}

function isSameUniqueStringSet(value: unknown, expected: string[]): boolean {
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    return false;
  }
  const actualSet = new Set(value);
  const expectedSet = new Set(expected);
  if (actualSet.size !== value.length || expectedSet.size !== expected.length) return false;
  if (actualSet.size !== expectedSet.size) return false;
  return [...actualSet].every((entry) => expectedSet.has(entry));
}

export interface FulfillmentResult {
  success: boolean;
  entitlementId?: string;
  receiptSent?: boolean;
  /** False when receipt delivery is uncertain and automatic re-delivery is blocked. */
  receiptRetryQueued?: boolean;
  /** Durable database arbitration withheld this duplicate paid order. */
  paidFulfillmentHeld?: boolean;
  eventEmitted: boolean;
  errors: string[];
}

// ── Receipt Delivery Recovery ──────────────────────────────
// A paid customer's receipt/license-key DM must never fail silently, but an
// external timeout cannot prove Discord rejected the message. An uncertain
// attempt is therefore never re-queued automatically. The full payload is
// preserved in `action_queue_dlq` for deliberate operator reconciliation and
// a critical alert explains that the original acceptance must be checked
// before any manual retry.

/** bot_action_queue action used for persistent receipt re-delivery. */
export const RECEIPT_DELIVERY_ACTION = 'deliver_receipt';

export interface ReceiptDeliveryPayload {
  guild_id: string;
  customer_id: string;
  discord_id: string;
  product_id: string;
  order_id: string;
  order_number: string;
  product_name: string;
  amount_cents: number;
  currency: string;
  license_key_id?: string;
  license_key_plaintext?: string;
  /** Durable generation of the original receipt protocol, when known. */
  outward_generation_id?: string;
  /**
   * ISO timestamp of the order (captured at fulfillment time — the same
   * date the initial receipt DM would have shown). A delayed redelivery
   * must render this, not the time the retry finally succeeded.
   */
  order_date?: string;
}

export type DeliveryFailureKind = 'permanent' | 'transient';

// Discord REST error codes for which retrying a DM can never succeed:
// 50007 = Cannot send messages to this user (DMs disabled / bot blocked)
// 10013 = Unknown User
const PERMANENT_DELIVERY_ERROR_CODES = new Set([50007, 10013]);

/**
 * Classify a receipt DM delivery error. Permanent failures (user has DMs
 * disabled, unknown user) should not be retried; everything else (network
 * blips, Discord 5xx, rate limits) is assumed transient and retryable.
 */
export function classifyDeliveryError(err: unknown): DeliveryFailureKind {
  const rawCode = (err as { code?: unknown } | null)?.code;
  const code = typeof rawCode === 'string' ? Number(rawCode) : rawCode;
  if (typeof code === 'number' && PERMANENT_DELIVERY_ERROR_CODES.has(code)) {
    return 'permanent';
  }
  return 'transient';
}

/**
 * Write the operator-visible alert for a receipt delivery failure. The
 * dashboard surfaces `alerts` rows; the message tells the operator the
 * recovery path that actually works: the full delivery payload (including
 * the plaintext license key) is preserved in the dead-letter queue, but the
 * original attempt must be reconciled before any deliberate manual resend.
 * The customer portal is NOT a recovery path — license_keys stores only
 * hash/prefix/suffix, and the portal displays only the masked key.
 */
export async function writeReceiptDeliveryAlert(
  supabase: SupabaseClient,
  opts: {
    guildId: string;
    orderNumber: string;
    productName: string;
    discordId: string;
    kind: DeliveryFailureKind;
    attempts: number;
    lastError: string;
    /**
     * Whether the delivery payload (with the plaintext key) made it into
     * action_queue_dlq. Defaults to true — every caller writes the DLQ row
     * before alerting; pass false only when that write itself failed, so
     * the operator isn't sent to an empty DLQ.
     */
    payloadPreserved?: boolean;
    /** Discord delivery context — pass when a Guild is in scope (X1/M2). */
    guild?: Guild | null;
  },
): Promise<void> {
  const payloadPreserved = opts.payloadPreserved ?? true;
  const recovery = payloadPreserved
    ? 'The full delivery payload (including the license key) is preserved in the dead-letter queue. ' +
      'Automatic retry is blocked because the original attempt may have been accepted. Reconcile that ' +
      'attempt before deliberately retrying from the dashboard DLQ or delivering the preserved key through ' +
      'another channel. Note: the customer portal shows only a masked key, so it cannot be used for recovery.'
    : 'The delivery payload could NOT be preserved in the dead-letter queue (database write failed), ' +
      'so the plaintext key is unrecoverable — revoke the license key for this order and reissue it manually.';
  const message =
    opts.kind === 'permanent'
      ? `Could not DM the receipt/license key for **${opts.productName}** (order ${opts.orderNumber}): ` +
        'the customer has DMs disabled or is unreachable, so automatic retries will not help. ' +
        recovery
      : `Could not DM the receipt/license key for **${opts.productName}** (order ${opts.orderNumber}) ` +
        `after ${opts.attempts} attempt(s). ` +
        recovery;

  await raiseOwnerAlert(supabase, opts.guildId, {
    alertType: 'receipt_delivery_failed',
    severity: 'critical',
    title: `Receipt delivery failed — order ${opts.orderNumber}`,
    message,
    metadata: {
      orderNumber: opts.orderNumber,
      productName: opts.productName,
      discordId: opts.discordId,
      kind: opts.kind,
      attempts: opts.attempts,
      lastError: opts.lastError,
      payloadPreserved,
      acceptanceUncertain: true,
    },
    guild: opts.guild,
  });
}

// ── Service ────────────────────────────────────────────────

export class CommerceFulfillmentService {
  private entitlementService: EntitlementService;
  private executionContext: FulfillmentExecutionContext | null = null;

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus,
  ) {
    this.entitlementService = new EntitlementService(guild, supabase, eventBus);
  }

  /**
   * Process a fulfillment request from the action queue.
   */
  async fulfill(
    payload: FulfillmentPayload,
    context?: FulfillmentExecutionContext,
  ): Promise<FulfillmentResult> {
    const result: FulfillmentResult = {
      success: false,
      eventEmitted: false,
      errors: [],
    };

    if (
      context === undefined
      || (
        typeof context.actionId !== 'string'
        || context.actionId.length === 0
        || context.actionId.trim() !== context.actionId
        || typeof context.claimToken !== 'string'
        || context.claimToken.length === 0
        || context.claimToken.trim() !== context.claimToken
      )
    ) {
      result.errors.push('Fulfillment action claim failed exact validation');
      return result;
    }
    this.executionContext = context;

    // The action row is dispatched by a concrete Discord guild instance. A
    // payload for any other guild (or without complete identity) must be
    // rejected before even a database read, audit write, or Discord call.
    if (
      payload.guild_id !== this.guild.id
      || ![
        payload.guild_id,
        payload.customer_id,
        payload.discord_id,
        payload.product_id,
        payload.order_id,
        payload.order_number,
      ].every((value) => typeof value === 'string' && value.length > 0 && value.trim() === value)
      || !Array.isArray(payload.granted_role_ids)
      || !Array.isArray(payload.granted_channel_ids)
      || payload.granted_role_ids.some((value) =>
        typeof value !== 'string' || value.length === 0 || value.trim() !== value)
      || payload.granted_channel_ids.some((value) =>
        typeof value !== 'string' || value.length === 0 || value.trim() !== value)
      || !Number.isSafeInteger(payload.amount_cents)
      || payload.amount_cents < 0
      || typeof payload.currency !== 'string'
      || payload.currency.length === 0
      || payload.currency.trim() !== payload.currency
    ) {
      result.errors.push('Fulfillment payload failed exact guild/identity validation');
      return result;
    }

    // Audit V2 Finding 3.7 — Redact discord_id from logs (show last 4 chars only)
    const redactedId = payload.discord_id ? `***${payload.discord_id.slice(-4)}` : 'unknown';
    log.info('Processing fulfillment', { type: payload.fulfillment_type, user: redactedId, order: payload.order_number });

    try {
      switch (payload.fulfillment_type) {
        case 'one_time_purchase':
          await this.handleOneTimePurchase(payload, result);
          break;
        case 'subscription_activated':
          await this.handleSubscriptionActivated(payload, result);
          break;
        case 'subscription_renewed':
          await this.handleSubscriptionRenewed(payload, result);
          break;
        case 'subscription_cancelled':
          await this.handleSubscriptionCancelled(payload, result);
          break;
        case 'subscription_suspended':
          await this.handleSubscriptionSuspended(payload, result);
          break;
        case 'subscription_payment_failed':
          await this.handleSubscriptionPaymentFailed(payload, result);
          break;
        default:
          result.errors.push(`Unknown fulfillment type: ${payload.fulfillment_type}`);
          return result;
      }

      if (result.errors.length > 0) {
        throw new Error(`Fulfillment handler failed: ${result.errors.join('; ')}`);
      }

      const activeAttempt = this.entitlementService.getActivePurchaseRoleDeliveryAttempt();
      if (activeAttempt) {
        throw new Error(
          'Paid role delivery remained active after the pre-outward confirmation boundary',
        );
      }

      result.success = result.errors.length === 0;
    } catch (err) {
      if (err instanceof CommerceOutwardSupersededError) {
        if (this.entitlementService.getActivePurchaseRoleDeliveryAttempt()) {
          throw new Error('Superseded lifecycle retained live role-delivery authority');
        }
        result.success = true;
        await this.auditLog(payload, result);
        return result;
      }
      if (err instanceof PurchaseRoleDeliveryTerminalNoopError) {
        const activeAttempt = this.entitlementService.getActivePurchaseRoleDeliveryAttempt();
        if (activeAttempt) {
          const compensated = await this.entitlementService.finishPurchaseRoleDeliveryAttempt(
            activeAttempt,
            'compensated',
          );
          if (
            !compensated.settled
            || compensated.state !== 'settled'
            || !compensated.authorityEmpty
          ) {
            throw new Error('Terminal paid role delivery compensation did not settle');
          }
        }
        if (err.entitlementId) result.entitlementId = err.entitlementId;
        result.success = true;
        await this.auditLog(payload, result);
        return result;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const activeAttempt = this.entitlementService.getActivePurchaseRoleDeliveryAttempt();
      if (activeAttempt) {
        try {
          await this.entitlementService.finishPurchaseRoleDeliveryAttempt(
            activeAttempt,
            'retry',
            msg.slice(0, 1_000),
          );
        } catch (intentError) {
          result.errors.push(
            `Role delivery intent remained unresolved: ${
              intentError instanceof Error ? intentError.message : String(intentError)
            }`,
          );
        }
      }
      result.errors.push(`Fulfillment error: ${msg}`);
      log.error('Fatal error in fulfillment pipeline', { detail: err });
    }

    // Audit log the fulfillment attempt
    await this.auditLog(payload, result);

    return result;
  }

  private requireExecutionContext(): FulfillmentExecutionContext {
    if (!this.executionContext) {
      throw new Error('Fulfillment action claim is required for paid role mutation');
    }
    return this.executionContext;
  }

  private requireOutwardSent(
    outcome: CommerceOutwardResult,
    label: string,
  ): void {
    if (outcome.state === 'sent') return;
    if (outcome.state === 'superseded') {
      throw new CommerceOutwardSupersededError(label);
    }
    if (outcome.externalError !== undefined) throw outcome.externalError;
    throw new Error(
      `${label} delivery is ${outcome.state} and requires operator reconciliation`,
    );
  }

  /**
   * Make the role-delivery confirmation durable before the first externally
   * visible side effect in this generation. Once this succeeds the active
   * attempt is cleared, so a later event/DM failure cannot downgrade a
   * confirmed Discord delivery to a retryable role attempt.
   */
  private async confirmRoleDeliveryBeforeOutward(
    outwardGenerationId: string | null,
  ): Promise<void> {
    const activeAttempt = this.entitlementService.getActivePurchaseRoleDeliveryAttempt();
    if (!activeAttempt) return;
    if (
      outwardGenerationId === null
      || activeAttempt.outwardGenerationId !== outwardGenerationId
    ) {
      throw new Error('Paid role delivery outward generation changed before confirmation');
    }

    const finalized = await this.entitlementService.finishPurchaseRoleDeliveryAttempt(
      activeAttempt,
      'live',
    );
    const validOwnedLive =
      finalized.state === 'open'
      && !finalized.settled
      && !finalized.authorityEmpty;
    const validZeroAuthorityLive =
      finalized.state === 'settled'
      && finalized.settled
      && finalized.authorityEmpty;
    if (!validOwnedLive && !validZeroAuthorityLive) {
      throw new Error('Paid role delivery intent did not confirm before outward delivery');
    }
  }

  private async finishTerminalRoleDelivery(
    payload: FulfillmentPayload,
    entitlementId: string | null,
  ): Promise<never> {
    if (!entitlementId) {
      throw new PurchaseRoleDeliveryTerminalNoopError(null);
    }
    const context = this.requireExecutionContext();
    const begun = await this.entitlementService.beginPurchaseRoleDeliveryAttempt(
      entitlementId,
      {
        customerId: payload.customer_id,
        productId: payload.product_id,
        orderId: payload.order_id,
        planId: payload.plan_id ?? null,
        discordId: payload.discord_id,
        grantedRoleIds: payload.granted_role_ids,
        entitlementType: payload.entitlement_type,
      },
      context,
    );
    if (begun.state !== 'terminal') {
      throw new Error('Terminal order returned a live paid role delivery contract');
    }
    if (begun.cleanupNeeded) {
      const cleanup = await this.entitlementService.executeOwnedPurchaseRoleCleanup(
        begun.intentId,
        context,
      );
      if (!cleanup.settled) {
        throw new Error('Terminal paid role cleanup remains unresolved');
      }
    }
    throw new PurchaseRoleDeliveryTerminalNoopError(entitlementId);
  }

  /**
   * Re-check the database's durable paid-order winner before a queue worker can
   * create an entitlement or touch Discord. This is intentionally repeated in
   * the worker even though current webhooks claim before staging: historical
   * staged/pending rows predate that boundary and are still executable.
   */
  private async claimInitialPaidFulfillment(
    payload: FulfillmentPayload,
  ): Promise<'winner' | 'held'> {
    const providerKind = payload.entitlement_type === 'one_time'
      ? 'capture'
      : 'subscription';
    const providerId = providerKind === 'capture'
      ? payload.paypal_capture_id
      : payload.paypal_subscription_id;
    if (
      typeof providerId !== 'string'
      || !PAYPAL_SUBSCRIPTION_ID_PATTERN.test(providerId)
    ) {
      throw new Error(
        `${providerKind === 'capture' ? 'One-time' : 'Subscription'} fulfillment `
          + 'payload has no exact paid provider identity',
      );
    }

    const { data, error } = await this.supabase.rpc('commerce_claim_paid_fulfillment', {
      p_order_id: payload.order_id,
      p_guild_id: payload.guild_id,
      p_customer_id: payload.customer_id,
      p_product_id: payload.product_id,
      p_provider_kind: providerKind,
      p_provider_id: providerId,
      p_amount_cents: payload.amount_cents,
      p_currency: payload.currency,
    });
    if (error) {
      throw new Error(`Failed to claim paid fulfillment: ${error.message}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Paid fulfillment claim RPC returned malformed data');
    }

    const claim = data as Record<string, unknown>;
    const nullableIdentity = (value: unknown) =>
      value === null
      || (typeof value === 'string' && value.length > 0 && value.trim() === value);
    if (
      claim.order_id !== payload.order_id
      || !['winner', 'held'].includes(String(claim.disposition))
      || !nullableIdentity(claim.winning_order_id)
      || !nullableIdentity(claim.conflicting_entitlement_id)
      || !nullableIdentity(claim.alert_id)
    ) {
      throw new Error('Paid fulfillment claim RPC returned malformed identity');
    }
    if (
      claim.disposition === 'winner'
      && (
        claim.winning_order_id !== payload.order_id
        || claim.conflicting_entitlement_id !== null
        || claim.alert_id !== null
      )
    ) {
      throw new Error('Paid fulfillment winner RPC returned an inconsistent result');
    }
    if (
      claim.disposition === 'held'
      && (
        typeof claim.alert_id !== 'string'
        || claim.alert_id.length === 0
        || claim.alert_id.trim() !== claim.alert_id
      )
    ) {
      throw new Error('Paid fulfillment hold has no durable critical alert');
    }
    return claim.disposition as 'winner' | 'held';
  }

  private async runFulfillmentOutwardIntent(
    payload: FulfillmentPayload,
    intentKind: CommerceOutwardIntentKind,
    outwardGenerationId: string | null,
    prepared: ReturnType<typeof preparedOutwardEffect> | null,
    mode: CommerceOutwardBeginMode,
  ): Promise<CommerceOutwardResult> {
    const context = this.requireExecutionContext();
    const legacyPredecessorKind = mode === 'legacy-receipt-continuation'
      ? payload.fulfillment_type === 'one_time_purchase'
        ? 'purchase_completed_event'
        : payload.fulfillment_type === 'subscription_activated'
          ? 'subscription_activated_event'
          : null
      : undefined;
    if (legacyPredecessorKind === null) {
      throw new Error('Legacy receipt continuation has no supported predecessor');
    }
    return runCommerceOutwardIntent(
      this.supabase,
      {
        orderId: payload.order_id,
        guildId: payload.guild_id,
        intentKind,
        outwardGenerationId,
        actionId: context.actionId,
        claimToken: context.claimToken,
        ...(legacyPredecessorKind === undefined ? {} : { legacyPredecessorKind }),
      },
      prepared,
      mode,
    );
  }

  // ── One-Time Purchase ────────────────────────────────────

  private async handleOneTimePurchase(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    if (payload.entitlement_type !== 'one_time') {
      throw new Error('One-time fulfillment payload failed entitlement type validation');
    }
    const temporaryRoleGrants = normalizeTemporaryRoleGrants(payload.temporary_role_grants);
    const orderStatus = await this.validatePayloadOrderSnapshot(payload, temporaryRoleGrants);
    if (orderStatus !== 'completed' && orderStatus !== 'pending_review') {
      requireTerminalOrderStatus(orderStatus);
      const terminalEntitlementId = await this.findOrderEntitlement(payload);
      result.entitlementId = terminalEntitlementId ?? undefined;
      await this.finishTerminalRoleDelivery(payload, terminalEntitlementId);
    }
    await this.validatePayloadCustomerIdentity(payload);
    const claim = await this.claimInitialPaidFulfillment(payload);
    if (claim === 'held') {
      result.paidFulfillmentHeld = true;
      return;
    }
    if (orderStatus !== 'completed') {
      requireTerminalOrderStatus(orderStatus);
    }

    // 1. Grant the entitlement once, or reuse the durable order-scoped row on
    // a queue retry after a later temporary-role step failed.
    let entitlementId = await this.findOrderEntitlement(payload);
    let reusedEntitlement = entitlementId !== null;
    if (!entitlementId) {
      entitlementId = await this.entitlementService.grant({
        customerId: payload.customer_id,
        productId: payload.product_id,
        productName: payload.product_name,
        orderId: payload.order_id,
        licenseKeyId: payload.license_key_id,
        discordId: payload.discord_id,
        type: 'one_time',
        source: 'purchase',
        grantedRoleIds: payload.granted_role_ids,
        grantedChannelIds: payload.granted_channel_ids,
        roleDeliveryClaim: this.requireExecutionContext(),
      });

      // A concurrent/replayed worker may have won the unique order_id insert.
      // Re-read the durable row before treating a null grant result as fatal.
      if (!entitlementId) {
        entitlementId = await this.findOrderEntitlement(payload);
        reusedEntitlement = entitlementId !== null;
      }
    }

    if (!entitlementId) {
      result.errors.push('Failed to create entitlement');
      return;
    }
    result.entitlementId = entitlementId;

    // An at-least-once queue retry can resume after the entitlement insert but
    // before Discord acknowledged every permanent role. Reusing the row is
    // safe only after a fresh Discord read repairs and confirms the frozen
    // role vector.
    let roleDeliveryAlreadySettled = false;
    let outwardGenerationId: string | null =
      this.entitlementService.getActivePurchaseRoleDeliveryAttempt()
        ?.outwardGenerationId
      ?? null;
    if (reusedEntitlement) {
      const contract = {
        customerId: payload.customer_id,
        productId: payload.product_id,
        orderId: payload.order_id,
        planId: null,
        discordId: payload.discord_id,
        grantedRoleIds: payload.granted_role_ids,
        entitlementType: 'one_time' as const,
      };
      const begun = await this.entitlementService.beginPurchaseRoleDeliveryAttempt(
        entitlementId,
        contract,
        this.requireExecutionContext(),
      );
      if (begun.state === 'terminal') {
        await this.finishTerminalRoleDelivery(payload, entitlementId);
      } else if (begun.state === 'confirmed_live') {
        roleDeliveryAlreadySettled = true;
        outwardGenerationId = begun.outwardGenerationId;
      } else {
        outwardGenerationId = begun.attempt.outwardGenerationId ?? null;
        await this.entitlementService.ensurePurchaseGrantedRoles(
          entitlementId,
          contract,
          begun.attempt,
        );
      }
    }
    if (!roleDeliveryAlreadySettled && outwardGenerationId === null) {
      throw new Error('Live paid role delivery is missing its outward generation');
    }

    // 2. Commit durable provenance before mutating any temporary Discord role.
    // A confirmed role-delivery replay may be a legacy action from before
    // outward intents existed. Resume only when an existing event row proves
    // this handler had entered the new crash-fenced delivery path.
    if (!roleDeliveryAlreadySettled) {
      await this.applyTemporaryRoleGrants(payload, temporaryRoleGrants);
    }

    // 3. Confirm the role generation before any outward row can be created.
    await this.confirmRoleDeliveryBeforeOutward(outwardGenerationId);

    // 4. Emit purchase.completed once. A crash after listener acceptance but
    // before the sent marker becomes a manual-review `uncertain`, never resend.
    const preparedEvent = outwardGenerationId === null
      ? null
      : this.eventBus.prepareEmitAndWait('purchase.completed', payload.guild_id, {
        discordId: payload.discord_id,
        orderId: payload.order_id,
        orderNumber: payload.order_number,
        productId: payload.product_id,
        productName: payload.product_name,
        amount: payload.amount_cents,
        currency: payload.currency,
      });
    const eventOutcome = await this.runFulfillmentOutwardIntent(
      payload,
      'purchase_completed_event',
      outwardGenerationId,
      preparedEvent,
      outwardGenerationId === null ? 'legacy-resume' : 'generated',
    );
    if (eventOutcome.state === 'absent') return;
    result.eventEmitted = eventOutcome.state === 'sent';
    if (eventOutcome.state !== 'sent') {
      log.error('Purchase event delivery is uncertain; automatic replay blocked', {
        order: payload.order_number,
        detail: eventOutcome.externalError,
      });
    }
    this.requireOutwardSent(eventOutcome, 'Purchase event');

    // 5. Send receipt DM
    await this.sendReceipt(payload, result, outwardGenerationId);

    if (roleDeliveryAlreadySettled) return;

    // 6. Run fraud checks (non-blocking — don't fail fulfillment)
    this.runFraudChecks(payload).catch((err) =>
      log.warn('Fraud check error (non-fatal)', { detail: err }),
    );
  }

  private async findOrderEntitlement(payload: FulfillmentPayload): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('entitlements')
      .select('id, customer_id, product_id, plan_id, license_key_id, type, status, source, granted_role_ids, granted_channel_ids')
      .eq('guild_id', payload.guild_id)
      .eq('order_id', payload.order_id)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to inspect existing entitlement: ${error.message}`);
    }
    if (!data) return null;

    if (
      typeof data.id !== 'string'
      || data.id.length === 0
      || data.customer_id !== payload.customer_id
      || data.product_id !== payload.product_id
      || (data.plan_id ?? null) !== (payload.plan_id ?? null)
      || (data.license_key_id ?? null) !== (payload.license_key_id ?? null)
      || data.type !== payload.entitlement_type
      || typeof data.status !== 'string'
      || !['active', 'pending', 'grace_period', 'suspended', 'expired', 'cancelled']
        .includes(data.status)
      || data.source !== 'purchase'
      || !isSameUniqueStringSet(data.granted_role_ids, payload.granted_role_ids)
      || !isSameUniqueStringSet(data.granted_channel_ids, payload.granted_channel_ids)
    ) {
      throw new Error('Existing order entitlement failed identity validation');
    }
    return data.id;
  }

  private async validatePayloadCustomerIdentity(payload: FulfillmentPayload): Promise<void> {
    const { data, error } = await this.supabase
      .from('customers')
      .select('id, guild_id, discord_id')
      .eq('id', payload.customer_id)
      .eq('guild_id', payload.guild_id)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to verify fulfillment customer identity: ${error.message}`);
    }
    if (
      !data
      || data.id !== payload.customer_id
      || data.guild_id !== payload.guild_id
      || data.discord_id !== payload.discord_id
    ) {
      throw new Error('Fulfillment customer identity is missing or mismatched');
    }
  }

  private async validatePayloadOrderSnapshot(
    payload: FulfillmentPayload,
    temporaryRoleGrants: Array<{ role_id: string; duration_seconds: number }>,
  ): Promise<string> {
    const { data, error } = await this.supabase
      .from('orders')
      .select('id, order_number, guild_id, customer_id, product_id, plan_id, paypal_subscription_id, amount_cents, currency, source, status, granted_role_ids_snapshot, granted_channel_ids_snapshot, temporary_role_grants_snapshot, grant_snapshot_frozen_at')
      .eq('id', payload.order_id)
      .eq('guild_id', payload.guild_id)
      .maybeSingle();
    if (error) throw new Error(`Failed to verify fulfillment order snapshot: ${error.message}`);

    if (
      !data
      || data.id !== payload.order_id
      || data.order_number !== payload.order_number
      || data.guild_id !== payload.guild_id
      || data.customer_id !== payload.customer_id
      || data.product_id !== payload.product_id
      || (data.plan_id ?? null) !== (payload.plan_id ?? null)
      || !hasExactPayPalSubscriptionIdentity(data.paypal_subscription_id, payload)
      || data.amount_cents !== payload.amount_cents
      || data.currency !== payload.currency
      || (data.source !== 'purchase' && data.source !== null)
      || typeof data.status !== 'string'
      || !KNOWN_ORDER_STATUSES.includes(data.status)
    ) {
      throw new Error('Fulfillment order failed exact frozen snapshot validation');
    }

    let authoritativeRoleIds: unknown = data.granted_role_ids_snapshot;
    let authoritativeChannelIds: unknown = data.granted_channel_ids_snapshot;
    let authoritativeTemporaryRoleGrants: unknown = data.temporary_role_grants_snapshot;
    let hasAuthoritativeContract =
      typeof data.grant_snapshot_frozen_at === 'string'
      && data.grant_snapshot_frozen_at.length > 0
      && Number.isFinite(Date.parse(data.grant_snapshot_frozen_at));

    // Completed subscription rows from before order snapshots are never
    // authorized from a null marker alone. The dashboard must first have
    // persisted the exact staged payload through the locked adoption RPC;
    // this read-only row survives normal queue retention and is compared in
    // full before any entitlement or Discord mutation.
    if (data.grant_snapshot_frozen_at === null && payload.entitlement_type === 'subscription') {
      const { data: legacy, error: legacyError } = await this.supabase
        .from('commerce_legacy_subscription_grant_contracts')
        .select('order_id, source_queue_id, guild_id, customer_id, discord_id, product_id, product_name, order_number, plan_id, paypal_subscription_id, paypal_plan_id, amount_cents, currency, granted_role_ids_snapshot, granted_channel_ids_snapshot, persisted_at')
        .eq('order_id', payload.order_id)
        .maybeSingle();
      if (legacyError) {
        throw new Error(`Failed to verify legacy subscription grant contract: ${legacyError.message}`);
      }

      if (
        !legacy
        || typeof legacy.source_queue_id !== 'string'
        || legacy.source_queue_id.length === 0
        || legacy.order_id !== payload.order_id
        || legacy.guild_id !== payload.guild_id
        || legacy.customer_id !== payload.customer_id
        || legacy.discord_id !== payload.discord_id
        || legacy.product_id !== payload.product_id
        || legacy.product_name !== payload.product_name
        || legacy.order_number !== payload.order_number
        || legacy.plan_id !== payload.plan_id
        || legacy.paypal_subscription_id !== payload.paypal_subscription_id
        || legacy.paypal_plan_id !== payload.paypal_plan_id
        || legacy.amount_cents !== payload.amount_cents
        || legacy.currency !== payload.currency
        || data.order_number !== legacy.order_number
        || data.paypal_subscription_id !== legacy.paypal_subscription_id
        || typeof legacy.persisted_at !== 'string'
        || !Number.isFinite(Date.parse(legacy.persisted_at))
        || !isSameUniqueStringSet(legacy.granted_role_ids_snapshot, payload.granted_role_ids)
        || !isSameUniqueStringSet(legacy.granted_channel_ids_snapshot, payload.granted_channel_ids)
        || temporaryRoleGrants.length !== 0
      ) {
        throw new Error('Fulfillment order failed exact legacy contract validation');
      }

      authoritativeRoleIds = legacy.granted_role_ids_snapshot;
      authoritativeChannelIds = legacy.granted_channel_ids_snapshot;
      authoritativeTemporaryRoleGrants = [];
      hasAuthoritativeContract = true;
    }

    let frozenTemporaryRoleGrants: Array<{ role_id: string; duration_seconds: number }>;
    try {
      frozenTemporaryRoleGrants = normalizeTemporaryRoleGrants(
        authoritativeTemporaryRoleGrants as FulfillmentPayload['temporary_role_grants'],
      );
    } catch {
      throw new Error('Fulfillment order returned a malformed frozen grant snapshot');
    }
    const tempSnapshotsMatch = frozenTemporaryRoleGrants.length === temporaryRoleGrants.length
      && frozenTemporaryRoleGrants.every((grant, index) =>
        grant.role_id === temporaryRoleGrants[index]?.role_id
        && grant.duration_seconds === temporaryRoleGrants[index]?.duration_seconds);

    if (
      !hasAuthoritativeContract
      || !isSameUniqueStringSet(authoritativeRoleIds, payload.granted_role_ids)
      || !isSameUniqueStringSet(authoritativeChannelIds, payload.granted_channel_ids)
      || !tempSnapshotsMatch
    ) {
      throw new Error('Fulfillment order failed exact frozen snapshot validation');
    }
    return data.status;
  }

  private async findSubscriptionLifecycleEntitlement(
    payload: FulfillmentPayload,
    expectedEntitlementId?: string,
  ): Promise<{
    id: string;
    status: string;
    updatedAt: string | null;
  }> {
    if (
      payload.entitlement_type !== 'subscription'
      || typeof payload.plan_id !== 'string'
      || payload.plan_id.length === 0
      || payload.plan_id.trim() !== payload.plan_id
      || typeof payload.paypal_subscription_id !== 'string'
      || payload.paypal_subscription_id.length === 0
      || payload.paypal_subscription_id.trim() !== payload.paypal_subscription_id
      || (
        expectedEntitlementId !== undefined
        && (
          expectedEntitlementId.length === 0
          || expectedEntitlementId.trim() !== expectedEntitlementId
        )
      )
    ) {
      throw new Error('Subscription lifecycle payload failed entitlement type validation');
    }

    let entitlementQuery = this.supabase
      .from('entitlements')
      .select('id, guild_id, customer_id, order_id, product_id, plan_id, type, status, updated_at, source, granted_role_ids, granted_channel_ids, customers(id, guild_id, discord_id)')
      .eq('guild_id', payload.guild_id)
      .eq('order_id', payload.order_id);
    if (expectedEntitlementId !== undefined) {
      entitlementQuery = entitlementQuery.eq('id', expectedEntitlementId);
    }
    const { data, error } = await entitlementQuery.maybeSingle();
    if (error) {
      throw new Error(`Failed to inspect subscription entitlement: ${error.message}`);
    }

    const customer = Array.isArray(data?.customers) ? data.customers[0] : data?.customers;
    if (
      !data
      || typeof data.id !== 'string'
      || data.id.length === 0
      || (expectedEntitlementId !== undefined && data.id !== expectedEntitlementId)
      || data.guild_id !== payload.guild_id
      || data.customer_id !== payload.customer_id
      || data.order_id !== payload.order_id
      || data.product_id !== payload.product_id
      || (payload.plan_id !== undefined && data.plan_id !== payload.plan_id)
      || data.type !== 'subscription'
      || typeof data.status !== 'string'
      || ![
        'active',
        'pending',
        'grace_period',
        'suspended',
        'cancelled',
        'expired',
      ].includes(data.status)
      || (data.updated_at !== null && typeof data.updated_at !== 'string')
      || (data.source !== 'purchase' && data.source !== null)
      || !customer
      || customer.id !== payload.customer_id
      || customer.guild_id !== payload.guild_id
      || customer.discord_id !== payload.discord_id
      || (
        expectedEntitlementId !== undefined
        && (
          !isSameUniqueStringSet(data.granted_role_ids, payload.granted_role_ids)
          || !isSameUniqueStringSet(data.granted_channel_ids, payload.granted_channel_ids)
        )
      )
    ) {
      throw new Error('Subscription entitlement failed exact lifecycle identity validation');
    }

    return {
      id: data.id,
      status: data.status,
      updatedAt: data.updated_at ?? null,
    };
  }

  private async applyTemporaryRoleGrants(
    payload: FulfillmentPayload,
    grants: Array<{ role_id: string; duration_seconds: number }>,
  ): Promise<void> {
    for (const grant of grants) {
      const { data, error } = await this.supabase.rpc('commerce_prepare_temp_role_grant', {
        p_guild_id: payload.guild_id,
        p_user_id: payload.discord_id,
        p_role_id: grant.role_id,
        p_order_id: payload.order_id,
        p_product_id: payload.product_id,
        p_duration_seconds: grant.duration_seconds,
      });

      if (error) {
        throw new Error(
          `Failed to prepare temporary role ${grant.role_id}: ${error.message}`,
        );
      }
      if (!isPreparedTemporaryRoleGrant(data)) {
        throw new Error(`Malformed temporary role provenance for ${grant.role_id}`);
      }

      const expiresAt = Date.parse(data.expires_at);
      if (data.grant_status === 'removed') {
        // An expired/terminal commerce grant remains as immutable revocation
        // evidence. Fulfillment replays must never revive its Discord access.
        continue;
      }
      if (data.grant_status === 'applied' && expiresAt <= Date.now()) {
        // The canonical temp-grant sweeper owns expiry retirement. A replay
        // must neither resurrect access nor perform an unfenced cleanup here.
        continue;
      }

      let requiresManualAcknowledgement = false;
      try {
        let member = await this.guild.members.fetch({
          user: payload.discord_id,
          force: true,
        });

        const roleWasPresent = member.roles.cache.has(grant.role_id);
        const activeAttempt = this.entitlementService.getActivePurchaseRoleDeliveryAttempt();
        if (!activeAttempt) {
          throw new Error('Temporary paid role delivery has no active durable controller');
        }
        let attached = await this.attachTemporaryRoleDeliveryAttempt(
          activeAttempt,
          data.id,
          grant.role_id,
          grant.duration_seconds,
          roleWasPresent,
        );
        if (attached.disposition === 'terminal') {
          await this.entitlementService.executeOwnedPurchaseRoleCleanup(
            activeAttempt.intentId,
            activeAttempt,
          );
          throw new PurchaseRoleDeliveryTerminalNoopError(null);
        }
        if (attached.disposition === 'operator_held') {
          throw new TemporaryRoleMutationUncertainError(
            grant.role_id,
            'the durable delivery controller is held for operator recovery',
          );
        }
        if (attached.disposition === 'dependency_pending') {
          throw new Error(
            `Temporary role ${grant.role_id} ownership dependency remains unresolved`,
          );
        }

        // Re-read after the durable classifier. A manual baseline that
        // disappears cannot authorize a write; reclassify the now-absent
        // role so only an exact provisional reservation can proceed.
        member = await this.guild.members.fetch({
          user: payload.discord_id,
          force: true,
        });
        if (attached.disposition === 'manual_baseline') {
          if (member.roles.cache.has(grant.role_id)) {
            // Purchased access is satisfied, but manual access never becomes
            // commerce-owned and must not be removed at expiry.
            requiresManualAcknowledgement = data.grant_status === 'pending';
          } else {
            if (data.grant_status === 'applied') {
              throw new Error(
                'Applied unowned temporary role is absent and cannot acquire removal ownership',
              );
            }
            attached = await this.attachTemporaryRoleDeliveryAttempt(
              activeAttempt,
              data.id,
              grant.role_id,
              grant.duration_seconds,
              false,
            );
            if (attached.disposition === 'terminal') {
              await this.entitlementService.executeOwnedPurchaseRoleCleanup(
                activeAttempt.intentId,
                activeAttempt,
              );
              throw new PurchaseRoleDeliveryTerminalNoopError(null);
            }
            if (attached.disposition === 'operator_held') {
              throw new TemporaryRoleMutationUncertainError(
                grant.role_id,
                'the durable delivery controller is held for operator recovery',
              );
            }
            if (attached.disposition === 'dependency_pending') {
              throw new Error(
                `Temporary role ${grant.role_id} ownership dependency remains unresolved`,
              );
            }
            if (
              attached.disposition !== 'reserve_add'
              || attached.ownsRemoval
              || !attached.claimNewlyAcquired
            ) {
              throw new Error('Absent temporary role did not acquire an exact add reservation');
            }
            member = await this.guild.members.fetch({
              user: payload.discord_id,
              force: true,
            });
          }
        }

        // A newly-created absent-role reservation loses to a role that appears
        // before this invocation writes Discord. Release it, then classify the
        // present role again: a confirmed predecessor is inheritable, a manual
        // baseline remains unowned, and an unresolved predecessor retries.
        if (
          attached.disposition === 'reserve_add'
          && member.roles.cache.has(grant.role_id)
        ) {
          const released = await this.releaseUnconsumedTemporaryRoleClaim(
            activeAttempt,
            data.id,
            grant.role_id,
          );
          if (!released.mayMutate) {
            if (released.cleanupNeeded) {
              await this.entitlementService.executeOwnedPurchaseRoleCleanup(
                activeAttempt.intentId,
                activeAttempt,
              );
            } else if (!released.settled) {
              throw new Error('Terminal temporary role release has no cleanup carrier');
            }
            throw new PurchaseRoleDeliveryTerminalNoopError(null);
          }
          attached = await this.attachTemporaryRoleDeliveryAttempt(
            activeAttempt,
            data.id,
            grant.role_id,
            grant.duration_seconds,
            true,
          );
          if (attached.disposition === 'terminal') {
            await this.entitlementService.executeOwnedPurchaseRoleCleanup(
              activeAttempt.intentId,
              activeAttempt,
            );
            throw new PurchaseRoleDeliveryTerminalNoopError(null);
          }
          if (attached.disposition === 'operator_held') {
            throw new TemporaryRoleMutationUncertainError(
              grant.role_id,
              'the durable delivery controller is held for operator recovery',
            );
          }
          if (attached.disposition === 'dependency_pending') {
            throw new Error(
              `Temporary role ${grant.role_id} ownership dependency remains unresolved`,
            );
          }
          member = await this.guild.members.fetch({
            user: payload.discord_id,
            force: true,
          });
          if (attached.disposition === 'manual_baseline') {
            if (!member.roles.cache.has(grant.role_id)) {
              throw new Error('Temporary role changed during baseline classification');
            }
            requiresManualAcknowledgement = data.grant_status === 'pending';
          }
        }

        // A pre-existing reservation plus a present role is ambiguous across
        // an add-before-promote crash and a concurrent manual assignment.
        // Preserve access but never auto-promote it into removal authority.
        if (
          attached.disposition === 'reserved_replay'
          && member.roles.cache.has(grant.role_id)
        ) {
          throw new TemporaryRoleMutationUncertainError(
            grant.role_id,
            'a pre-existing provisional reservation now observes the role present',
          );
        }

        if (!member.roles.cache.has(grant.role_id)) {
          const hasReservation = attached.disposition === 'reserve_add'
            || attached.disposition === 'reserve_inherited'
            || attached.disposition === 'reserved_replay';
          if (!attached.ownsRemoval && !hasReservation) {
            throw new Error('Temporary role is absent without exact ownership or reservation');
          }
          if (hasReservation && data.grant_status !== 'pending') {
            throw new Error('Applied temporary role cannot use provisional add ownership');
          }
          try {
            await member.roles.add(
              grant.role_id,
              `SomniBot temporary commerce role — order ${payload.order_number}`,
            );
          } catch (addError) {
            try {
              member = await this.guild.members.fetch({
                user: payload.discord_id,
                force: true,
              });
            } catch (readError) {
              throw new TemporaryRoleMutationUncertainError(
                grant.role_id,
                `${addError instanceof Error ? addError.message : String(addError)}; post-error read failed: ${
                  readError instanceof Error ? readError.message : String(readError)
                }`,
              );
            }
            if (member.roles.cache.has(grant.role_id)) {
              if (attached.disposition === 'owned_replay') {
                continue;
              }
              throw new TemporaryRoleMutationUncertainError(grant.role_id, addError);
            }

            if (hasReservation) {
              const released = await this.releaseUnconsumedTemporaryRoleClaim(
                activeAttempt,
                data.id,
                grant.role_id,
              );
              if (!released.mayMutate) {
                if (released.cleanupNeeded) {
                  await this.entitlementService.executeOwnedPurchaseRoleCleanup(
                    activeAttempt.intentId,
                    activeAttempt,
                  );
                }
                throw new PurchaseRoleDeliveryTerminalNoopError(null);
              }
            }
            throw addError;
          }
          // Confirm the role from Discord before acknowledging provenance. A
          // successful REST response followed by a failed confirmation leaves
          // the row pending so a retry can safely observe and finish it.
          try {
            member = await this.guild.members.fetch({
              user: payload.discord_id,
              force: true,
            });
          } catch (readError) {
            throw new TemporaryRoleMutationUncertainError(grant.role_id, readError);
          }
          if (!member.roles.cache.has(grant.role_id)) {
            if (hasReservation) {
              const released = await this.releaseUnconsumedTemporaryRoleClaim(
                activeAttempt,
                data.id,
                grant.role_id,
              );
              if (!released.mayMutate) {
                if (released.cleanupNeeded) {
                  await this.entitlementService.executeOwnedPurchaseRoleCleanup(
                    activeAttempt.intentId,
                    activeAttempt,
                  );
                }
                throw new PurchaseRoleDeliveryTerminalNoopError(null);
              }
            }
            throw new Error('Discord did not confirm the temporary role');
          }
        }

        if (!member.roles.cache.has(grant.role_id)) {
          throw new Error('Discord did not confirm the temporary role');
        }

        if (
          attached.disposition === 'reserve_add'
          || attached.disposition === 'reserve_inherited'
          || attached.disposition === 'reserved_replay'
        ) {
          const promotion = await this.confirmTemporaryRoleDeliveryAttempt(
            activeAttempt,
            data.id,
            grant.role_id,
          );
          if (
            promotion.intentState !== 'open'
            || !promotion.ownsRemoval
            || promotion.grantStatus !== 'applied'
            || Date.parse(promotion.expiresAt) <= Date.now()
          ) {
            throw new TemporaryRoleMutationUncertainError(
              grant.role_id,
              'the provisional temporary role could not be promoted',
            );
          }
        }
      } catch (discordError) {
        if (discordError instanceof PurchaseRoleDeliveryTerminalNoopError) {
          throw discordError;
        }
        const detail = (
          discordError instanceof Error ? discordError.message : String(discordError)
        ).slice(0, 1_000);
        await this.recordTemporaryRoleFailure(data.id, detail);
        if (discordError instanceof TemporaryRoleMutationUncertainError) {
          throw discordError;
        }
        throw new Error(`Failed to apply temporary role ${grant.role_id}: ${detail}`);
      }

      // Owned/reserved rows are acknowledged only by the atomic promotion
      // RPC above. The legacy acknowledgement path is restricted to a
      // confirmed manual baseline, where remove_on_expiry remains false.
      if (!requiresManualAcknowledgement) continue;

      const { data: acknowledged, error: acknowledgeError } = await this.supabase.rpc(
        'commerce_acknowledge_temp_role_grant',
        { p_grant_id: data.id },
      );
      const acknowledgedDurationSeconds = isAcknowledgedTemporaryRoleGrant(acknowledged)
        ? (Date.parse(acknowledged.expires_at) - Date.parse(acknowledged.applied_at)) / 1_000
        : Number.NaN;
      if (
        acknowledgeError
        || !isAcknowledgedTemporaryRoleGrant(acknowledged)
        || acknowledged.id !== data.id
        || acknowledgedDurationSeconds !== grant.duration_seconds
      ) {
        let detail = acknowledgeError?.message ?? 'provenance row was not acknowledged exactly';
        try {
          // The acknowledgement may have committed even when its response was
          // lost. Re-read the exact row before any compensating Discord write.
          const inspection = await inspectTemporaryRoleGrant(this.supabase, data.id);
          const exactInspection = inspection
            && inspection.guild_id === payload.guild_id
            && inspection.user_id === payload.discord_id
            && inspection.role_id === grant.role_id
            && inspection.order_id === payload.order_id
            && inspection.duration_seconds === grant.duration_seconds;

          if (exactInspection && inspection.grant_status === 'applied') {
            const appliedAt = inspection.applied_at === null
              ? Number.NaN
              : Date.parse(inspection.applied_at);
            const inspectedDurationSeconds = (
              Date.parse(inspection.expires_at) - appliedAt
            ) / 1_000;
            if (
              inspection.parent_order_status === 'completed'
              && inspection.entitlement_is_live
              && inspectedDurationSeconds === grant.duration_seconds
              && Date.parse(inspection.expires_at) > Date.now()
            ) {
              // The DB transition succeeded; only the RPC response was lost.
              continue;
            }
          }

          if (
            exactInspection
            && inspection.grant_status === 'pending'
            && inspection.parent_order_status === 'completed'
            && inspection.entitlement_is_live
          ) {
            // Ordinary transient ACK failure: the role was confirmed and the
            // paid parent is still live. Keep access and retry acknowledgement.
            detail += '; acknowledgement remains pending on a live order';
          } else if (exactInspection) {
            await this.reconcileTerminalPendingRole(
              payload,
              grant.role_id,
              data.id,
              inspection.remove_on_expiry,
            );
          } else {
            detail += '; authoritative grant state was missing or mismatched';
          }
        } catch (cleanupError) {
          if (cleanupError instanceof PurchaseRoleDeliveryTerminalNoopError) {
            throw cleanupError;
          }
          // Inspection uncertainty is fail-closed: do not blindly remove a
          // role whose acknowledgement may have committed.
          detail += `; authoritative role reconciliation failed: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`;
        }
        await this.recordTemporaryRoleFailure(data.id, detail);
        throw new Error(`Failed to acknowledge temporary role ${grant.role_id}: ${detail}`);
      }
    }
  }

  private async reconcileTerminalPendingRole(
    payload: FulfillmentPayload,
    roleId: string,
    grantId: string,
    ownsRemoval: boolean,
  ): Promise<void> {
    if (!ownsRemoval) return;

    const activeAttempt = this.entitlementService.getActivePurchaseRoleDeliveryAttempt();
    if (!activeAttempt) {
      throw new Error('Terminal temporary-role cleanup has no durable controller');
    }
    const cleanup = await this.entitlementService.executeOwnedPurchaseRoleCleanup(
      activeAttempt.intentId,
      activeAttempt,
    );
    if (!cleanup.settled && cleanup.state !== 'cleanup_required') {
      throw new Error('Terminal temporary-role cleanup remains unresolved');
    }
    throw new PurchaseRoleDeliveryTerminalNoopError(null);
  }

  private async attachTemporaryRoleDeliveryAttempt(
    attempt: PurchaseRoleDeliveryAttempt,
    grantId: string,
    roleId: string,
    durationSeconds: number,
    roleWasPresent: boolean,
  ): Promise<TemporaryRoleAttachment> {
    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_attach_temp_role_delivery', {
      p_intent_id: attempt.intentId,
      p_mutation_token: attempt.mutationToken,
      p_grant_id: grantId,
      p_role_id: roleId,
      p_duration_seconds: durationSeconds,
      p_role_was_present: roleWasPresent,
    });
    if (error) throw new Error(`Failed to attach temporary role delivery: ${error.message}`);
    const candidate = Array.isArray(data)
      ? (data.length === 1 ? data[0] : null)
      : data;
    if (
      !candidate
      || typeof candidate !== 'object'
      || Array.isArray(candidate)
      || typeof candidate.may_mutate !== 'boolean'
      || typeof candidate.owns_removal !== 'boolean'
      || typeof candidate.claim_newly_acquired !== 'boolean'
      || typeof candidate.intent_state !== 'string'
      || !['open', 'cleanup_required', 'operator_required'].includes(
        candidate.intent_state,
      )
      || typeof candidate.disposition !== 'string'
      || ![
        'reserve_add',
        'reserve_inherited',
        'reserved_replay',
        'owned_replay',
        'manual_baseline',
        'dependency_pending',
        'terminal',
        'operator_held',
      ].includes(candidate.disposition)
    ) {
      throw new Error('Temporary role delivery attachment returned malformed evidence');
    }

    const disposition = candidate.disposition as TemporaryRoleAttachmentDisposition;
    const liveOwned = candidate.intent_state === 'open'
      && candidate.may_mutate === true
      && candidate.owns_removal === true
      && candidate.claim_newly_acquired === false;
    const dispositionMatches =
      (disposition === 'reserve_add'
        && candidate.intent_state === 'open'
        && candidate.may_mutate === true
        && candidate.owns_removal === false
        && candidate.claim_newly_acquired === true)
      || (disposition === 'owned_replay' && liveOwned)
      || ((
        disposition === 'reserve_inherited'
        || disposition === 'reserved_replay'
        || disposition === 'manual_baseline'
        || disposition === 'dependency_pending'
      )
        && candidate.intent_state === 'open'
        && candidate.may_mutate === true
        && candidate.owns_removal === false
        && candidate.claim_newly_acquired === false)
      || (disposition === 'terminal'
        && candidate.intent_state === 'cleanup_required'
        && candidate.may_mutate === false
        && candidate.owns_removal === false
        && candidate.claim_newly_acquired === false)
      || (disposition === 'operator_held'
        && candidate.intent_state === 'operator_required'
        && candidate.may_mutate === false
        && candidate.owns_removal === false
        && candidate.claim_newly_acquired === false);
    if (!dispositionMatches) {
      throw new Error('Temporary role delivery attachment returned mismatched evidence');
    }
    if (
      (disposition === 'reserve_add' && roleWasPresent)
      || (disposition === 'reserve_inherited' && !roleWasPresent)
      || ((disposition === 'manual_baseline' || disposition === 'dependency_pending')
        && !roleWasPresent)
    ) {
      throw new Error('Temporary role delivery attachment contradicted the Discord observation');
    }
    return {
      intentState: candidate.intent_state as TemporaryRoleAttachment['intentState'],
      mayMutate: candidate.may_mutate,
      ownsRemoval: candidate.owns_removal,
      claimNewlyAcquired: candidate.claim_newly_acquired,
      disposition,
    };
  }

  private async confirmTemporaryRoleDeliveryAttempt(
    attempt: PurchaseRoleDeliveryAttempt,
    grantId: string,
    roleId: string,
  ): Promise<TemporaryRolePromotion> {
    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_confirm_temp_role_delivery', {
      p_intent_id: attempt.intentId,
      p_mutation_token: attempt.mutationToken,
      p_grant_id: grantId,
      p_role_id: roleId,
    });
    if (error) {
      throw new TemporaryRoleMutationUncertainError(
        roleId,
        `durable temporary-role promotion failed: ${error.message}`,
      );
    }
    const candidate = Array.isArray(data)
      ? (data.length === 1 ? data[0] : null)
      : data;
    if (
      !candidate
      || typeof candidate !== 'object'
      || Array.isArray(candidate)
      || typeof candidate.intent_state !== 'string'
      || !['open', 'operator_required'].includes(candidate.intent_state)
      || typeof candidate.promoted !== 'boolean'
      || typeof candidate.owns_removal !== 'boolean'
      || (candidate.grant_status !== 'applied' && candidate.grant_status !== 'pending')
      || typeof candidate.expires_at !== 'string'
      || !Number.isFinite(Date.parse(candidate.expires_at))
    ) {
      throw new TemporaryRoleMutationUncertainError(
        roleId,
        'durable temporary-role promotion returned malformed evidence',
      );
    }
    const matches = candidate.intent_state === 'open'
      ? candidate.owns_removal === true && candidate.grant_status === 'applied'
      : candidate.promoted === false
        && candidate.owns_removal === false
        && candidate.grant_status === 'pending';
    if (!matches) {
      throw new TemporaryRoleMutationUncertainError(
        roleId,
        'durable temporary-role promotion returned mismatched evidence',
      );
    }
    return {
      intentState: candidate.intent_state as TemporaryRolePromotion['intentState'],
      promoted: candidate.promoted,
      ownsRemoval: candidate.owns_removal,
      grantStatus: candidate.grant_status,
      expiresAt: candidate.expires_at,
    };
  }

  private async releaseUnconsumedTemporaryRoleClaim(
    attempt: PurchaseRoleDeliveryAttempt,
    grantId: string,
    roleId: string,
  ): Promise<{
    mayMutate: boolean;
    cleanupNeeded: boolean;
    settled: boolean;
  }> {
    const { data, error } = await (
      this.supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof this.supabase.rpc>
    )('commerce_release_unconsumed_temp_role_claim', {
      p_intent_id: attempt.intentId,
      p_mutation_token: attempt.mutationToken,
      p_grant_id: grantId,
      p_role_id: roleId,
    });
    if (error) {
      throw new Error(`Failed to release unconsumed temporary role ownership: ${error.message}`);
    }
    const candidate = Array.isArray(data)
      ? (data.length === 1 ? data[0] : null)
      : data;
    if (
      !candidate
      || typeof candidate !== 'object'
      || Array.isArray(candidate)
      || typeof candidate.intent_state !== 'string'
      || !['open', 'cleanup_required', 'operator_required', 'settled'].includes(
        candidate.intent_state,
      )
      || candidate.released !== true
      || typeof candidate.may_mutate !== 'boolean'
      || typeof candidate.cleanup_needed !== 'boolean'
      || typeof candidate.settled !== 'boolean'
    ) {
      throw new Error('Temporary role ownership release returned malformed evidence');
    }
    if (
      candidate.may_mutate
      && (
        candidate.intent_state !== 'open'
        || candidate.cleanup_needed
        || candidate.settled
      )
    ) {
      throw new Error('Temporary role ownership release returned mismatched live evidence');
    }
    return {
      mayMutate: candidate.may_mutate,
      cleanupNeeded: candidate.cleanup_needed,
      settled: candidate.settled,
    };
  }

  private async recordTemporaryRoleFailure(grantId: string, detail: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('temp_role_grants')
        .update({
          last_error: detail,
          updated_at: new Date().toISOString(),
        })
        .eq('id', grantId)
        .eq('grant_status', 'pending');
      if (error) {
        log.warn('Failed to record temporary role delivery error', {
          grantId,
          detail: error.message,
        });
      }
    } catch (err) {
      log.warn('Failed to record temporary role delivery error', { grantId, detail: err });
    }
  }

  // ── Subscription Activated ───────────────────────────────

  private async handleSubscriptionActivated(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    const lifecycle = requireSubscriptionLifecyclePayload(payload);
    if (
      payload.entitlement_type !== 'subscription'
      || typeof payload.plan_id !== 'string'
      || payload.plan_id.length === 0
      || payload.plan_id.trim() !== payload.plan_id
    ) {
      throw new Error('Subscription fulfillment payload failed entitlement type validation');
    }
    const temporaryRoleGrants = normalizeTemporaryRoleGrants(payload.temporary_role_grants);
    const orderStatus = await this.validatePayloadOrderSnapshot(payload, temporaryRoleGrants);
    if (orderStatus !== 'completed' && orderStatus !== 'pending_review') {
      requireTerminalOrderStatus(orderStatus);
      const terminalEntitlementId = await this.findOrderEntitlement(payload);
      result.entitlementId = terminalEntitlementId ?? undefined;
      await this.finishTerminalRoleDelivery(payload, terminalEntitlementId);
    }
    await this.validatePayloadCustomerIdentity(payload);
    const claim = await this.claimInitialPaidFulfillment(payload);
    if (claim === 'held') {
      result.paidFulfillmentHeld = true;
      return;
    }
    if (orderStatus !== 'completed') {
      requireTerminalOrderStatus(orderStatus);
    }

    // 1. Grant once, or resume the exact durable entitlement after a worker
    // crash/Discord failure. Subscription actions use the same unique order_id
    // boundary as one-time purchases and therefore need the same replay path.
    // Always pass activation through the lifecycle RPC, including replay.
    // The database then proves or repairs the exact paid-through boundary
    // before any Discord or outward effect can continue.
    const entitlementId = await this.entitlementService.grant({
      customerId: payload.customer_id,
      productId: payload.product_id,
      productName: payload.product_name,
      orderId: payload.order_id,
      planId: payload.plan_id,
      licenseKeyId: payload.license_key_id,
      discordId: payload.discord_id,
      type: 'subscription',
      source: 'purchase',
      grantedRoleIds: payload.granted_role_ids,
      grantedChannelIds: payload.granted_channel_ids,
      expiresAt: lifecycle.paidThroughAt,
      roleDeliveryClaim: this.requireExecutionContext(),
    });

    if (!entitlementId) {
      result.errors.push('Failed to create subscription entitlement');
      return;
    }
    result.entitlementId = entitlementId;

    let roleDeliveryAlreadySettled = false;
    let outwardGenerationId: string | null =
      this.entitlementService.getActivePurchaseRoleDeliveryAttempt()
        ?.outwardGenerationId
      ?? null;
    roleDeliveryAlreadySettled =
      this.entitlementService.wasPurchaseRoleDeliveryConfirmedReplay();
    outwardGenerationId =
      this.entitlementService.getPurchaseRoleDeliveryOutwardGeneration();
    if (!roleDeliveryAlreadySettled && outwardGenerationId === null) {
      throw new Error('Live paid role delivery is missing its outward generation');
    }

    // 2. Temporary grants are part of the frozen subscription grant contract,
    // so they must be reconciled before role confirmation authorizes outward
    // event/receipt delivery.
    if (!roleDeliveryAlreadySettled) {
      await this.applyTemporaryRoleGrants(payload, temporaryRoleGrants);
    }

    // 3. Confirm the role generation before any outward row can be created.
    await this.confirmRoleDeliveryBeforeOutward(outwardGenerationId);

    // 4. Emit subscription.activated once under the same crash fence.
    const preparedEvent = outwardGenerationId === null
      ? null
      : this.eventBus.prepareEmitAndWait('subscription.activated', payload.guild_id, {
        discordId: payload.discord_id,
        productId: payload.product_id,
        planId: payload.plan_id ?? '',
        lifecycleId: this.requireExecutionContext().actionId,
        status: 'activated',
      });
    const eventOutcome = await this.runFulfillmentOutwardIntent(
      payload,
      'subscription_activated_event',
      outwardGenerationId,
      preparedEvent,
      outwardGenerationId === null ? 'legacy-resume' : 'generated',
    );
    // A missing row is an action completed before outward intents existed.
    // Preserve the old delivery-confirmed dedupe boundary in that case.
    if (eventOutcome.state === 'absent') return;
    result.eventEmitted = eventOutcome.state === 'sent';
    if (eventOutcome.state !== 'sent') {
      log.error('Subscription event delivery is uncertain; automatic replay blocked', {
        order: payload.order_number,
        detail: eventOutcome.externalError,
      });
    }
    this.requireOutwardSent(eventOutcome, 'Subscription activation event');

    // 5. Send receipt DM
    await this.sendReceipt(payload, result, outwardGenerationId);

    if (roleDeliveryAlreadySettled) return;

    // Run fraud checks (non-blocking — don't fail fulfillment)
    this.runFraudChecks(payload).catch((err) =>
      log.warn('Fraud check error (non-fatal)', { detail: err }),
    );
  }

  // ── Subscription Renewed ─────────────────────────────────

  private async handleSubscriptionRenewed(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    const lifecycle = requireSubscriptionLifecyclePayload(payload);
    if (
      payload.entitlement_type !== 'subscription'
      || typeof payload.plan_id !== 'string'
      || payload.plan_id.length === 0
      || payload.plan_id.trim() !== payload.plan_id
      || typeof payload.existing_entitlement_id !== 'string'
      || payload.existing_entitlement_id.length === 0
      || payload.existing_entitlement_id.trim() !== payload.existing_entitlement_id
    ) {
      result.errors.push('Subscription renewal requires an exact existing entitlement and plan');
      return;
    }

    const orderStatus = await this.validatePayloadOrderSnapshot(payload, []);
    const entitlement = await this.findSubscriptionLifecycleEntitlement(
      payload,
      payload.existing_entitlement_id,
    );
    if (orderStatus !== 'completed') {
      requireTerminalOrderStatus(orderStatus);
      result.entitlementId = entitlement.id;
      await this.finishTerminalRoleDelivery(payload, entitlement.id);
    }
    await this.validatePayloadCustomerIdentity(payload);
    if (!['active', 'grace_period', 'suspended'].includes(entitlement.status)) {
      result.errors.push(
        `Subscription renewal rejected entitlement status ${entitlement.status}`,
      );
      return;
    }

    const reactivated = await this.entitlementService.reactivate(
      entitlement.id,
      {
        customerId: payload.customer_id,
        productId: payload.product_id,
        orderId: payload.order_id,
        planId: payload.plan_id,
        discordId: payload.discord_id,
        grantedRoleIds: payload.granted_role_ids,
        grantedChannelIds: payload.granted_channel_ids,
        entitlementType: 'subscription',
        expiresAt: lifecycle.paidThroughAt as string,
      },
      this.requireExecutionContext(),
    );
    if (!reactivated) {
      result.errors.push('Failed to reactivate entitlement');
      return;
    }
    result.entitlementId = entitlement.id;

    const outwardGenerationId =
      this.entitlementService.getPurchaseRoleDeliveryOutwardGeneration();
    await this.confirmRoleDeliveryBeforeOutward(outwardGenerationId);
    const preparedEvent = outwardGenerationId === null
      ? null
      : this.eventBus.prepareEmitAndWait('subscription.activated', payload.guild_id, {
        discordId: payload.discord_id,
        productId: payload.product_id,
        planId: payload.plan_id,
        lifecycleId: this.requireExecutionContext().actionId,
        status: 'renewed',
      });
    const outward = await this.runFulfillmentOutwardIntent(
      payload,
      'subscription_renewed_event',
      outwardGenerationId,
      preparedEvent,
      outwardGenerationId === null ? 'legacy-resume' : 'generated',
    );
    if (outward.state === 'absent') return;
    result.eventEmitted = outward.state === 'sent';
    this.requireOutwardSent(outward, 'Subscription renewal event');
  }

  // ── Subscription Cancelled ───────────────────────────────

  private async handleSubscriptionCancelled(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    const entitlement = await this.findSubscriptionLifecycleEntitlement(payload);
    result.entitlementId = entitlement.id;

    if (
      ![
        'active',
        'pending',
        'grace_period',
        'suspended',
        'cancelled',
        'expired',
      ].includes(entitlement.status)
    ) {
      throw new Error(`Subscription cancellation found unsupported status ${entitlement.status}`);
    }

    const revocation = await this.entitlementService.revoke(
      entitlement.id,
      'cancelled',
      {
        ...this.requireExecutionContext(),
        orderId: payload.order_id,
        orderNumber: payload.order_number,
        customerId: payload.customer_id,
        discordId: payload.discord_id,
        productId: payload.product_id,
        productName: payload.product_name,
        planId: payload.plan_id!,
        paypalSubscriptionId: payload.paypal_subscription_id!,
        amountCents: payload.amount_cents,
        currency: payload.currency,
        expectedStatus: entitlement.status as
          | 'active'
          | 'pending'
          | 'grace_period'
          | 'suspended'
          | 'expired'
          | 'cancelled',
        expectedUpdatedAt: entitlement.updatedAt,
      },
    );
    if (
      revocation.disposition === 'noop'
      && (revocation.outwardGenerationId ?? null) === null
    ) {
      return;
    }
    if (revocation.disposition !== 'applied') {
      if (
        revocation.disposition === 'noop'
        && typeof revocation.outwardGenerationId === 'string'
      ) {
        // Exact same-action recovery of an already committed cancellation.
      } else {
        result.errors.push(
          `Failed to revoke entitlement ${entitlement.id} (${revocation.disposition})`,
        );
        return;
      }
    }
    const outwardGenerationId = revocation.outwardGenerationId ?? null;
    if (outwardGenerationId === null) {
      result.errors.push(
        `Failed to revoke entitlement ${entitlement.id} (missing outward generation)`,
      );
      return;
    }

    const preparedEvent = this.eventBus.prepareEmitAndWait(
      'subscription.lapsed',
      payload.guild_id,
      {
        discordId: payload.discord_id,
        productId: payload.product_id,
        planId: payload.plan_id ?? '',
        lifecycleId: this.requireExecutionContext().actionId,
        status: 'cancelled',
      },
    );
    const eventOutcome = await this.runFulfillmentOutwardIntent(
      payload,
      'subscription_cancelled_event',
      outwardGenerationId,
      preparedEvent,
      'generated',
    );
    result.eventEmitted = eventOutcome.state === 'sent';
    this.requireOutwardSent(eventOutcome, 'Subscription cancellation event');

    // Prepare the immutable billing DM before its own durable begin. A failed
    // user lookup is therefore safely retryable and creates no DM intent row.
    const user = await this.guild.client.users.fetch(payload.discord_id);
    const preparedDm = preparedOutwardEffect(() => user.send({
      content: `Your subscription to **${payload.product_name}** has been cancelled. If this was a mistake, you can re-subscribe in the server store.`,
      allowedMentions: { parse: [] },
    }));
    const dmOutcome = await this.runFulfillmentOutwardIntent(
      payload,
      'subscription_cancelled_dm',
      outwardGenerationId,
      preparedDm,
      'generated',
    );
    this.requireOutwardSent(dmOutcome, 'Subscription cancellation DM');
  }

  // ── Subscription Suspended ───────────────────────────────

  private async handleSubscriptionSuspended(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    const entitlement = await this.findSubscriptionLifecycleEntitlement(payload);
    result.entitlementId = entitlement.id;

    const suspension = await this.entitlementService.revoke(
      entitlement.id,
      'suspended',
      {
        ...this.requireExecutionContext(),
        orderId: payload.order_id,
        orderNumber: payload.order_number,
        customerId: payload.customer_id,
        discordId: payload.discord_id,
        productId: payload.product_id,
        productName: payload.product_name,
        planId: payload.plan_id!,
        paypalSubscriptionId: payload.paypal_subscription_id!,
        amountCents: payload.amount_cents,
        currency: payload.currency,
        expectedStatus: entitlement.status as
          | 'active'
          | 'pending'
          | 'grace_period'
          | 'suspended'
          | 'expired'
          | 'cancelled',
        expectedUpdatedAt: entitlement.updatedAt,
      },
    );
    if (
      suspension.disposition === 'noop'
      && (suspension.outwardGenerationId ?? null) === null
    ) {
      return;
    }
    if (
      suspension.disposition !== 'applied'
      && !(
        suspension.disposition === 'noop'
        && typeof suspension.outwardGenerationId === 'string'
      )
    ) {
      result.errors.push(
        `Failed to suspend entitlement ${entitlement.id} (${suspension.disposition})`,
      );
      return;
    }
    const outwardGenerationId = suspension.outwardGenerationId ?? null;
    if (outwardGenerationId === null) {
      result.errors.push(
        `Failed to suspend entitlement ${entitlement.id} (missing outward generation)`,
      );
      return;
    }

    const preparedEvent = this.eventBus.prepareEmitAndWait(
      'subscription.lapsed',
      payload.guild_id,
      {
        discordId: payload.discord_id,
        productId: payload.product_id,
        planId: payload.plan_id ?? '',
        lifecycleId: this.requireExecutionContext().actionId,
        status: 'lapsed',
      },
    );
    const eventOutcome = await this.runFulfillmentOutwardIntent(
      payload,
      'subscription_suspended_event',
      outwardGenerationId,
      preparedEvent,
      'generated',
    );
    result.eventEmitted = eventOutcome.state === 'sent';
    this.requireOutwardSent(eventOutcome, 'Subscription suspension event');

    const user = await this.guild.client.users.fetch(payload.discord_id);
    const preparedDm = preparedOutwardEffect(() => user.send({
      content: `Your subscription to **${payload.product_name}** was suspended by PayPal, so access has been removed. Restore the subscription in PayPal to regain access.`,
      allowedMentions: { parse: [] },
    }));
    const dmOutcome = await this.runFulfillmentOutwardIntent(
      payload,
      'subscription_suspended_dm',
      outwardGenerationId,
      preparedDm,
      'generated',
    );
    this.requireOutwardSent(dmOutcome, 'Subscription suspension DM');
  }

  // ── Subscription Payment Failed ──────────────────────────

  private async handleSubscriptionPaymentFailed(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    const entitlement = await this.findSubscriptionLifecycleEntitlement(payload);
    result.entitlementId = entitlement.id;

    if (
      ![
        'active',
        'grace_period',
        'suspended',
        'cancelled',
        'expired',
      ].includes(entitlement.status)
    ) {
      throw new Error(`Subscription payment failure found unsupported status ${entitlement.status}`);
    }
    if (['cancelled', 'expired'].includes(entitlement.status)) return;

    const graceDays = await getGracePeriodDays(this.supabase, payload.guild_id);
    const suspension = await this.entitlementService.startPaymentFailureGraceForFulfillment(
      entitlement.id,
      graceDays,
      {
        ...this.requireExecutionContext(),
        orderId: payload.order_id,
        orderNumber: payload.order_number,
        customerId: payload.customer_id,
        discordId: payload.discord_id,
        productId: payload.product_id,
        productName: payload.product_name,
        planId: payload.plan_id!,
        paypalSubscriptionId: payload.paypal_subscription_id!,
        amountCents: payload.amount_cents,
        currency: payload.currency,
        expectedStatus: entitlement.status as 'active' | 'grace_period' | 'suspended',
        expectedUpdatedAt: entitlement.updatedAt,
      },
    );
    if (
      (suspension.disposition === 'noop' || suspension.disposition === 'replay')
      && suspension.outwardGenerationId === null
    ) {
      return;
    }
    if (
      !['applied', 'replay'].includes(suspension.disposition)
      || suspension.outwardGenerationId === null
    ) {
      result.errors.push(
        `Failed to start payment-failure grace for entitlement ${entitlement.id} (${suspension.disposition})`,
      );
      return;
    }
    const outwardGenerationId = suspension.outwardGenerationId;
    if (
      typeof suspension.gracePeriodEndsAt !== 'string'
      || !Number.isFinite(Date.parse(suspension.gracePeriodEndsAt))
    ) {
      throw new Error('Subscription payment failure returned no committed grace deadline');
    }
    const graceDeadlineTimestamp = Math.floor(
      Date.parse(suspension.gracePeriodEndsAt) / 1_000,
    );

    const lapsedEvent = this.eventBus.prepareEmitAndWait('subscription.lapsed', payload.guild_id, {
      discordId: payload.discord_id,
      productId: payload.product_id,
      planId: payload.plan_id ?? '',
      lifecycleId: this.requireExecutionContext().actionId,
      status: 'lapsed',
    });
    const lapsedOutcome = await this.runFulfillmentOutwardIntent(
      payload,
      'subscription_payment_failed_lapsed_event',
      outwardGenerationId,
      lapsedEvent,
      'generated',
    );
    this.requireOutwardSent(lapsedOutcome, 'Subscription payment-failure lapsed event');

    const failedEvent = this.eventBus.prepareEmitAndWait('payment.failed', payload.guild_id, {
      discordId: payload.discord_id,
      orderId: payload.order_id,
      productName: payload.product_name,
      amount: payload.amount_cents,
      currency: payload.currency,
    });
    const failedOutcome = await this.runFulfillmentOutwardIntent(
      payload,
      'subscription_payment_failed_event',
      outwardGenerationId,
      failedEvent,
      'generated',
    );
    this.requireOutwardSent(failedOutcome, 'Subscription payment-failed event');
    result.eventEmitted =
      lapsedOutcome.state === 'sent'
      && failedOutcome.state === 'sent';

    const user = await this.guild.client.users.fetch(payload.discord_id);
    const preparedDm = preparedOutwardEffect(() => user.send({
      content: `⚠️ Your payment for **${payload.product_name}** failed. Your grace period ends <t:${graceDeadlineTimestamp}:F>, when access will be revoked if payment has not recovered. Please update your payment method on PayPal.`,
      allowedMentions: { parse: [] },
    }));
    const dmOutcome = await this.runFulfillmentOutwardIntent(
      payload,
      'subscription_payment_failed_dm',
      outwardGenerationId,
      preparedDm,
      'generated',
    );
    this.requireOutwardSent(dmOutcome, 'Subscription payment-failure DM');

    // Run fraud checks only after the fixed customer-notification protocol has
    // drained. These checks are non-blocking and must not interleave with the
    // lapsed -> payment.failed -> billing-DM sequence above.
    const fraudCtx = { supabase: this.supabase, guildId: payload.guild_id, eventBus: this.eventBus };
    void (async () => {
      const thresholds = await loadFraudThresholds(this.supabase, payload.guild_id);
      await checkPaymentPattern(fraudCtx, payload.customer_id, payload.discord_id, {
        threshold: thresholds.failedPaymentThreshold,
      });
      await checkCriticalThreshold(fraudCtx, { threshold: thresholds.criticalIncidentThreshold });
    })().catch((err) => log.warn('Fraud check error (non-fatal)', { detail: err }));
  }

  // ── Fraud Checks ──────────────────────────────────────────
  // Non-blocking checks run after successful fulfillment.
  // These feed the fraud_signals table and can trigger incidents / owner DMs.

  private async runFraudChecks(payload: FulfillmentPayload): Promise<void> {
    const ctx = { supabase: this.supabase, guildId: payload.guild_id, eventBus: this.eventBus };
    const thresholds = await loadFraudThresholds(this.supabase, payload.guild_id);
    await checkPurchaseVelocity(ctx, payload.customer_id, payload.discord_id, {
      threshold: thresholds.velocityThreshold,
      windowMs: thresholds.velocityWindowMs,
    });
    await checkCriticalThreshold(ctx, { threshold: thresholds.criticalIncidentThreshold });
  }

  // ── Receipt DM ───────────────────────────────────────────

  /**
   * Deliver the receipt/license-key DM under a durable external-effect fence.
   * Any ambiguous response becomes `uncertain` and blocks automatic resend.
   */
  private async sendReceipt(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
    outwardGenerationId: string | null,
  ): Promise<void> {
    // Fulfillment runs immediately after payment, so "now" is the order
    // date. Captured once so a queued redelivery renders the same date the
    // initial DM would have shown, not the date the retry succeeded.
    const orderDate = new Date();
    // Preparation is provably pre-send work. Resolve the user, DM channel,
    // brand, and one immutable payload before the durable row enters
    // `sending`; a failure here remains safely retryable instead of becoming a
    // false "Discord may have accepted it" incident.
    const brandKit = await resolveBrandKit(this.supabase, payload.guild_id, {
      fallbackName: this.guild.name,
    });
    const user = await this.guild.client.users.fetch(payload.discord_id);
    const deliver = await prepareReceiptDM(
      user,
      {
        orderNumber: payload.order_number,
        productName: payload.product_name,
        amountCents: payload.amount_cents,
        currency: payload.currency,
        licenseKey: payload.license_key_plaintext ?? null,
        date: orderDate,
      },
      brandKit,
    );
    const outward = await this.runFulfillmentOutwardIntent(
      payload,
      'receipt_dm',
      outwardGenerationId,
      preparedOutwardEffect(deliver),
      outwardGenerationId === null
        ? 'legacy-receipt-continuation'
        : 'generated',
    );
    if (outward.state === 'absent') {
      throw new Error('New receipt outward intent unexpectedly returned absent');
    }
    result.receiptSent = outward.state === 'sent';
    if (outward.state === 'uncertain') {
      // The queue finalizer sees this same durable uncertain intent and
      // atomically preserves the original claimed action plus one alert.
      // Writing a second receipt DLQ/alert here would duplicate the incident.
      result.receiptRetryQueued = false;
      const redacted = payload.discord_id ? `***${payload.discord_id.slice(-4)}` : 'unknown';
      log.error('Receipt delivery is uncertain; automatic replay blocked', {
        user: redacted,
        detail: outward.externalError,
      });
    }
    this.requireOutwardSent(outward, 'Receipt DM');
  }

  // ── Audit ────────────────────────────────────────────────

  private async auditLog(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    try {
      await this.supabase.from('audit_logs').insert({
        guild_id: payload.guild_id,
        actor_type: 'system',
        actor_id: 'commerce-fulfillment',
        action: `fulfillment.${payload.fulfillment_type}`,
        target_type: 'order',
        target_id: payload.order_id,
        details: {
          discordId: payload.discord_id,
          productId: payload.product_id,
          productName: payload.product_name,
          orderNumber: payload.order_number,
          amountCents: payload.amount_cents,
          entitlementId: result.entitlementId,
          receiptSent: result.receiptSent,
          receiptRetryQueued: result.receiptRetryQueued,
          paidFulfillmentHeld: result.paidFulfillmentHeld,
          eventEmitted: result.eventEmitted,
          success: result.success,
          errors: result.errors,
        },
      });
    } catch {
      // Non-fatal — don't let audit failure break fulfillment
    }
  }
}
