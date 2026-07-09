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
import { EntitlementService } from '../features/commerce/entitlement-service.js';
import { deliverReceiptDM } from '../features/commerce/receipt-builder.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Fulfillment');
import { checkPurchaseVelocity, checkPaymentPattern, checkCriticalThreshold } from './fraud-detection.js';

// ── Types ──────────────────────────────────────────────────

export interface FulfillmentPayload {
  /** 'one_time_purchase' | 'subscription_activated' | 'subscription_renewed' | 'subscription_cancelled' | 'subscription_suspended' */
  fulfillment_type: string;
  guild_id: string;
  customer_id: string;
  discord_id: string;
  product_id: string;
  product_name: string;
  order_id: string;
  order_number: string;
  plan_id?: string;
  amount_cents: number;
  currency: string;
  granted_role_ids: string[];
  granted_channel_ids: string[];
  license_key_id?: string;
  license_key_plaintext?: string;
  entitlement_type: 'one_time' | 'subscription';
  /** For renewals — existing entitlement to reactivate */
  existing_entitlement_id?: string;
}

export interface FulfillmentResult {
  success: boolean;
  entitlementId?: string;
  receiptSent?: boolean;
  /** Set when the receipt DM failed and a persistent re-delivery was queued. */
  receiptRetryQueued?: boolean;
  eventEmitted?: boolean;
  errors: string[];
}

// ── Receipt Delivery Retry ─────────────────────────────────
// A paid customer's receipt/license-key DM must never fail silently. When
// the initial DM attempt fails, delivery is re-queued through
// `bot_action_queue` (the existing persistent retry infrastructure: backoff,
// max attempts, stale recovery). The queue handler classifies failures —
// transient ones retry, permanent ones (DMs disabled) don't burn retries —
// and final failures are dead-lettered to `action_queue_dlq` plus surfaced
// via an `alerts` row so the dashboard shows "delivery failed, act manually".

/** bot_action_queue action used for persistent receipt re-delivery. */
export const RECEIPT_DELIVERY_ACTION = 'deliver_receipt';

export interface ReceiptDeliveryPayload {
  guild_id: string;
  discord_id: string;
  order_id: string;
  order_number: string;
  product_name: string;
  amount_cents: number;
  currency: string;
  license_key_plaintext?: string;
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
 * dashboard surfaces `alerts` rows; the message tells the operator what to
 * do (customer-portal pickup for DMs-disabled users, manual delivery / DLQ
 * retry for exhausted transient failures).
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
  },
): Promise<void> {
  const message =
    opts.kind === 'permanent'
      ? `Could not DM the receipt/license key for **${opts.productName}** (order ${opts.orderNumber}): ` +
        'the customer has DMs disabled or is unreachable, so retrying will not help. ' +
        'The license key remains available through the customer portal — consider contacting the customer another way.'
      : `Could not DM the receipt/license key for **${opts.productName}** (order ${opts.orderNumber}) ` +
        `after ${opts.attempts} attempt(s). Deliver it manually or retry it from the dead-letter queue.`;

  const { error } = await supabase.from('alerts').insert({
    guild_id: opts.guildId,
    alert_type: 'receipt_delivery_failed',
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
    },
  });
  if (error) {
    log.error('Failed to write receipt delivery alert', { order: opts.orderNumber, detail: error.message });
  }
}

// ── Service ────────────────────────────────────────────────

export class CommerceFulfillmentService {
  private entitlementService: EntitlementService;

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
  async fulfill(payload: FulfillmentPayload): Promise<FulfillmentResult> {
    const result: FulfillmentResult = {
      success: false,
      errors: [],
    };

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
        default:
          result.errors.push(`Unknown fulfillment type: ${payload.fulfillment_type}`);
          return result;
      }

      result.success = result.errors.length === 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Fulfillment error: ${msg}`);
      log.error('Fatal error in fulfillment pipeline', { detail: err });
    }

    // Audit log the fulfillment attempt
    await this.auditLog(payload, result);

    return result;
  }

  // ── One-Time Purchase ────────────────────────────────────

  private async handleOneTimePurchase(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    // 1. Grant entitlement (creates DB record + Discord roles)
    const entitlementId = await this.entitlementService.grant({
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
    });

    if (!entitlementId) {
      result.errors.push('Failed to create entitlement');
      return;
    }
    result.entitlementId = entitlementId;

    // 2. Emit purchase.completed event
    this.eventBus.emit('purchase.completed', payload.guild_id, {
      discordId: payload.discord_id,
      orderId: payload.order_id,
      orderNumber: payload.order_number,
      productId: payload.product_id,
      productName: payload.product_name,
      amount: payload.amount_cents,
      currency: payload.currency,
    });
    result.eventEmitted = true;

    // 3. Send receipt DM
    await this.sendReceipt(payload, result);

    // 4. Run fraud checks (non-blocking — don't fail fulfillment)
    this.runFraudChecks(payload).catch((err) =>
      log.warn('Fraud check error (non-fatal)', { detail: err }),
    );
  }

  // ── Subscription Activated ───────────────────────────────

  private async handleSubscriptionActivated(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    // 1. Grant entitlement
    const entitlementId = await this.entitlementService.grant({
      customerId: payload.customer_id,
      productId: payload.product_id,
      productName: payload.product_name,
      orderId: payload.order_id,
      planId: payload.plan_id,
      discordId: payload.discord_id,
      type: 'subscription',
      source: 'purchase',
      grantedRoleIds: payload.granted_role_ids,
      grantedChannelIds: payload.granted_channel_ids,
    });

    if (!entitlementId) {
      result.errors.push('Failed to create subscription entitlement');
      return;
    }
    result.entitlementId = entitlementId;

    // 2. Emit subscription.activated event
    this.eventBus.emit('subscription.activated', payload.guild_id, {
      discordId: payload.discord_id,
      productId: payload.product_id,
      planId: payload.plan_id ?? '',
      status: 'activated',
    });
    result.eventEmitted = true;

    // 3. Send receipt DM
    await this.sendReceipt(payload, result);

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
    // Reactivate existing entitlement if it was in grace period
    if (payload.existing_entitlement_id) {
      const reactivated = await this.entitlementService.reactivate(payload.existing_entitlement_id);
      if (reactivated) {
        result.entitlementId = payload.existing_entitlement_id;
      } else {
        result.errors.push('Failed to reactivate entitlement');
      }
    }

    // Emit event
    this.eventBus.emit('subscription.activated', payload.guild_id, {
      discordId: payload.discord_id,
      productId: payload.product_id,
      planId: payload.plan_id ?? '',
      status: 'renewed',
    });
    result.eventEmitted = true;
  }

  // ── Subscription Cancelled ───────────────────────────────

  private async handleSubscriptionCancelled(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    // Find active entitlement for this order and revoke
    const { data: entitlements } = await this.supabase
      .from('entitlements')
      .select('id')
      .eq('order_id', payload.order_id)
      .in('status', ['active', 'grace_period'])
      .limit(1000);

    if (entitlements && entitlements.length > 0) {
      for (const ent of entitlements) {
        const revoked = await this.entitlementService.revoke(ent.id, 'cancelled');
        if (!revoked) {
          result.errors.push(`Failed to revoke entitlement ${ent.id}`);
        }
      }
    }

    // Emit event
    this.eventBus.emit('subscription.lapsed', payload.guild_id, {
      discordId: payload.discord_id,
      productId: payload.product_id,
      planId: payload.plan_id ?? '',
      status: 'cancelled',
    });
    result.eventEmitted = true;

    // DM the user about cancellation
    try {
      const user = await this.guild.client.users.fetch(payload.discord_id);
      await user.send({
        content: `Your subscription to **${payload.product_name}** has been cancelled. If this was a mistake, you can re-subscribe in the server store.`,
      });
    } catch {
      // DMs may be disabled — non-fatal
    }
  }

  // ── Subscription Suspended ───────────────────────────────

  private async handleSubscriptionSuspended(
    payload: FulfillmentPayload,
    result: FulfillmentResult,
  ): Promise<void> {
    // Put entitlement in grace period
    const { data: entitlements } = await this.supabase
      .from('entitlements')
      .select('id')
      .eq('order_id', payload.order_id)
      .eq('status', 'active')
      .limit(1000);

    // Read configurable grace period (default 3 days if not set)
    const { data: guildCfg } = await this.supabase
      .from('guild_config')
      .select('grace_period_days')
      .eq('guild_id', payload.guild_id)
      .maybeSingle();
    const graceDays = guildCfg?.grace_period_days ?? 3;

    if (entitlements && entitlements.length > 0) {
      for (const ent of entitlements) {
        const suspended = await this.entitlementService.suspend(ent.id, graceDays);
        if (!suspended) {
          result.errors.push(`Failed to suspend entitlement ${ent.id}`);
        }
      }
    }

    // Emit subscription lapsed event
    this.eventBus.emit('subscription.lapsed', payload.guild_id, {
      discordId: payload.discord_id,
      productId: payload.product_id,
      planId: payload.plan_id ?? '',
      status: 'lapsed',
    });

    // Emit payment.failed so owner gets notified
    this.eventBus.emit('payment.failed', payload.guild_id, {
      discordId: payload.discord_id,
      orderId: payload.order_id,
      productName: payload.product_name,
      amount: payload.amount_cents,
      currency: payload.currency,
    });
    result.eventEmitted = true;

    // Check for payment pattern fraud (non-blocking)
    const fraudCtx = { supabase: this.supabase, guildId: payload.guild_id, eventBus: this.eventBus };
    checkPaymentPattern(fraudCtx, payload.customer_id, payload.discord_id).catch((err) =>
      log.warn('Fraud check error (non-fatal)', { detail: err }),
    );
    checkCriticalThreshold(fraudCtx).catch((err) =>
      log.warn('Critical threshold check error (non-fatal)', { detail: err }),
    );

    // DM warning
    try {
      const user = await this.guild.client.users.fetch(payload.discord_id);
      await user.send({
        content: `⚠️ Your payment for **${payload.product_name}** failed. You have a *${graceDays}-day grace period* before your access is revoked. Please update your payment method on PayPal.`,
      });
    } catch {
      // DMs may be disabled — non-fatal
    }
  }

  // ── Fraud Checks ──────────────────────────────────────────
  // Non-blocking checks run after successful fulfillment.
  // These feed the fraud_signals table and can trigger incidents / owner DMs.

  private async runFraudChecks(payload: FulfillmentPayload): Promise<void> {
    const ctx = { supabase: this.supabase, guildId: payload.guild_id, eventBus: this.eventBus };
    await checkPurchaseVelocity(ctx, payload.customer_id, payload.discord_id);
    await checkCriticalThreshold(ctx);
  }

  // ── Receipt DM ───────────────────────────────────────────

  /**
   * Deliver the receipt/license-key DM. Failures are never dropped silently:
   * the delivery is re-queued through `bot_action_queue` for persistent retry
   * (see handleDeliverReceipt in action-queue.ts for backoff, permanent-vs-
   * transient classification, and dead-letter + alert on final failure).
   *
   * A delivery failure intentionally does NOT fail the fulfillment itself —
   * the entitlement is already granted, and retrying the whole fulfillment
   * action would double-grant it. Only the delivery is retried.
   */
  private async sendReceipt(payload: FulfillmentPayload, result: FulfillmentResult): Promise<void> {
    try {
      const user = await this.guild.client.users.fetch(payload.discord_id);
      await deliverReceiptDM(user, {
        orderNumber: payload.order_number,
        productName: payload.product_name,
        amountCents: payload.amount_cents,
        currency: payload.currency,
        licenseKey: payload.license_key_plaintext ?? null,
        date: new Date(),
      });
      result.receiptSent = true;
    } catch (err) {
      const redacted = payload.discord_id ? `***${payload.discord_id.slice(-4)}` : 'unknown';
      log.error('Failed to send receipt', { user: redacted, detail: err });
      result.receiptSent = false;
      result.receiptRetryQueued = await this.queueReceiptRedelivery(payload, err);
    }
  }

  /**
   * Queue a persistent re-delivery of the receipt DM via `bot_action_queue`.
   * If even the queueing fails, fall back to writing the operator alert
   * directly so the failed delivery is always operator-visible.
   */
  private async queueReceiptRedelivery(
    payload: FulfillmentPayload,
    deliveryError: unknown,
  ): Promise<boolean> {
    const deliveryPayload: ReceiptDeliveryPayload = {
      guild_id: payload.guild_id,
      discord_id: payload.discord_id,
      order_id: payload.order_id,
      order_number: payload.order_number,
      product_name: payload.product_name,
      amount_cents: payload.amount_cents,
      currency: payload.currency,
      license_key_plaintext: payload.license_key_plaintext,
    };

    try {
      const { error } = await this.supabase.from('bot_action_queue').insert({
        guild_id: payload.guild_id,
        action: RECEIPT_DELIVERY_ACTION,
        payload: deliveryPayload,
        status: 'pending',
      });
      if (error) throw new Error(error.message);
      log.info('Queued receipt re-delivery', { order: payload.order_number });
      return true;
    } catch (queueErr) {
      log.error('Failed to queue receipt re-delivery', { order: payload.order_number, detail: queueErr });
      await writeReceiptDeliveryAlert(this.supabase, {
        guildId: payload.guild_id,
        orderNumber: payload.order_number,
        productName: payload.product_name,
        discordId: payload.discord_id,
        kind: classifyDeliveryError(deliveryError),
        attempts: 1,
        lastError: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
      });
      return false;
    }
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
