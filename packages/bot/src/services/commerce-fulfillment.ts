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
import { sendReceiptDM } from '../features/commerce/receipt-builder.js';
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
  eventEmitted?: boolean;
  errors: string[];
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

    console.log(`[Fulfillment] Processing ${payload.fulfillment_type} for ${payload.discord_id} — order ${payload.order_number}`);

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
      console.error(`[Fulfillment] Fatal error:`, err);
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
    result.receiptSent = await this.sendReceipt(payload);

    // 4. Run fraud checks (non-blocking — don't fail fulfillment)
    this.runFraudChecks(payload).catch((err) =>
      console.error('[Fulfillment] Fraud check error (non-fatal):', err),
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
    result.receiptSent = await this.sendReceipt(payload);

    // Run fraud checks (non-blocking — don't fail fulfillment)
    this.runFraudChecks(payload).catch((err) =>
      console.error('[Fulfillment] Fraud check error (non-fatal):', err),
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
      .in('status', ['active', 'grace_period']);

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
      .eq('status', 'active');

    if (entitlements && entitlements.length > 0) {
      for (const ent of entitlements) {
        const suspended = await this.entitlementService.suspend(ent.id, 3);
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
      console.error('[Fulfillment] Fraud check error (non-fatal):', err),
    );
    checkCriticalThreshold(fraudCtx).catch((err) =>
      console.error('[Fulfillment] Critical threshold check error (non-fatal):', err),
    );

    // DM warning
    try {
      const user = await this.guild.client.users.fetch(payload.discord_id);
      await user.send({
        content: `⚠️ Your payment for **${payload.product_name}** failed. You have a *3-day grace period* before your access is revoked. Please update your payment method on PayPal.`,
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

  private async sendReceipt(payload: FulfillmentPayload): Promise<boolean> {
    try {
      const user = await this.guild.client.users.fetch(payload.discord_id);
      return await sendReceiptDM(user, {
        orderNumber: payload.order_number,
        productName: payload.product_name,
        amountCents: payload.amount_cents,
        currency: payload.currency,
        licenseKey: payload.license_key_plaintext ?? null,
        date: new Date(),
      });
    } catch (err) {
      console.error(`[Fulfillment] Failed to send receipt to ${payload.discord_id}:`, err);
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
