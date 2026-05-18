/**
 * Commerce Fulfillment Service — Processes fulfillment actions from bot_action_queue.
 *
 * When the PayPal webhook (dashboard side) processes a payment, it queues a
 * fulfillment action. This service (bot side) picks it up and:
 *
 * 1. Creates the entitlement via EntitlementService (which grants roles)
 * 2. Sends receipt DM to the customer
 * 3. Emits commerce events for automations (purchase.completed, etc.)
 * 4. Logs the fulfillment audit trail
 *
 * This architecture ensures the bot handles all Discord interactions,
 * while the dashboard handles all PayPal/payment interactions.
 */
import type { Guild, Client } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { sendReceiptDM } from './receipt-builder.js';

interface FulfillmentPayload {
  fulfillment_type: string;
  guild_id: string;
  customer_id: string;
  discord_id: string;
  product_id: string;
  product_name: string;
  order_id: string;
  order_number: string;
  amount_cents: number;
  currency: string;
  granted_role_ids: string[];
  granted_channel_ids: string[];
  license_key_id?: string;
  license_key_plaintext?: string;
  entitlement_type: string;
  plan_id?: string;
}

export class CommerceFulfillmentService {
  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus,
  ) {}

  /**
   * Process a fulfillment action from the queue.
   */
  async processFulfillment(action: string, payload: FulfillmentPayload): Promise<void> {
    console.log(`[Fulfillment] Processing ${action} for ${payload.discord_id} — order ${payload.order_number}`);

    switch (action) {
      case 'fulfill_purchase':
        await this.fulfillPurchase(payload);
        break;
      case 'fulfill_subscription':
        await this.fulfillSubscription(payload);
        break;
      case 'fulfill_cancellation':
        await this.fulfillCancellation(payload);
        break;
      case 'fulfill_suspension':
        await this.fulfillSuspension(payload);
        break;
      default:
        console.warn(`[Fulfillment] Unknown action: ${action}`);
    }
  }

  // ── Purchase Fulfillment ────────────────────────────────

  private async fulfillPurchase(payload: FulfillmentPayload): Promise<void> {
    const member = await this.guild.members.fetch(payload.discord_id).catch(() => null);

    // 1. Create entitlement
    const { error: entError } = await this.supabase.from('entitlements').insert({
      guild_id: payload.guild_id,
      customer_id: payload.customer_id,
      product_id: payload.product_id,
      order_id: payload.order_id,
      license_key_id: payload.license_key_id ?? null,
      type: payload.entitlement_type,
      status: 'active',
      discord_id: payload.discord_id,
    });

    if (entError) {
      console.error('[Fulfillment] Failed to create entitlement:', entError.message);
    }

    // 2. Grant roles
    if (member && payload.granted_role_ids.length > 0) {
      for (const roleId of payload.granted_role_ids) {
        try {
          await member.roles.add(roleId, `Purchase: ${payload.product_name}`);
        } catch (err) {
          console.error(`[Fulfillment] Failed to grant role ${roleId}:`, err);
        }
      }
    }

    // 3. Grant channel access
    if (member && payload.granted_channel_ids.length > 0) {
      for (const channelId of payload.granted_channel_ids) {
        try {
          const channel = this.guild.channels.cache.get(channelId);
          if (channel && 'permissionOverwrites' in channel) {
            await channel.permissionOverwrites.create(member.id, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true,
            });
          }
        } catch (err) {
          console.error(`[Fulfillment] Failed to grant channel ${channelId}:`, err);
        }
      }
    }

    // 4. Send receipt DM
    if (member) {
      try {
        await sendReceiptDM(member.user, {
          orderNumber: payload.order_number,
          productName: payload.product_name,
          amountCents: payload.amount_cents,
          currency: payload.currency,
          licenseKey: payload.license_key_plaintext ?? null,
          date: new Date(),
        });
      } catch (err) {
        console.error('[Fulfillment] Receipt DM failed:', err);
      }
    }

    // 5. Emit commerce event for automations
    this.eventBus.emit('purchase.completed', payload.guild_id, {
      customerId: payload.customer_id,
      discordId: payload.discord_id,
      productId: payload.product_id,
      productName: payload.product_name,
      orderId: payload.order_id,
      orderNumber: payload.order_number,
      amountCents: payload.amount_cents,
      currency: payload.currency,
      licenseKeyId: payload.license_key_id,
    });

    // 6. Audit log
    await this.supabase.from('audit_logs').insert({
      guild_id: payload.guild_id,
      action: 'purchase_fulfilled',
      entity_type: 'order',
      entity_id: payload.order_id,
      actor_type: 'system',
      actor_id: 'commerce-fulfillment',
      details: {
        customer_id: payload.customer_id,
        discord_id: payload.discord_id,
        product_name: payload.product_name,
        amount_cents: payload.amount_cents,
        roles_granted: payload.granted_role_ids,
        channels_granted: payload.granted_channel_ids,
        license_key_issued: !!payload.license_key_id,
      },
    }).catch(() => {});

    console.log(`[Fulfillment] ✅ Purchase fulfilled: ${payload.order_number} → ${payload.discord_id}`);
  }

  // ── Subscription Fulfillment ────────────────────────────

  private async fulfillSubscription(payload: FulfillmentPayload): Promise<void> {
    const member = await this.guild.members.fetch(payload.discord_id).catch(() => null);

    // Create entitlement
    await this.supabase.from('entitlements').insert({
      guild_id: payload.guild_id,
      customer_id: payload.customer_id,
      product_id: payload.product_id,
      order_id: payload.order_id,
      type: 'subscription',
      status: 'active',
      discord_id: payload.discord_id,
    }).catch(() => {});

    // Grant roles
    if (member && payload.granted_role_ids.length > 0) {
      for (const roleId of payload.granted_role_ids) {
        await member.roles.add(roleId, `Subscription: ${payload.product_name}`).catch(() => {});
      }
    }

    // Grant channel access
    if (member && payload.granted_channel_ids.length > 0) {
      for (const channelId of payload.granted_channel_ids) {
        const channel = this.guild.channels.cache.get(channelId);
        if (channel && 'permissionOverwrites' in channel) {
          await channel.permissionOverwrites.create(member.id, {
            ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
          }).catch(() => {});
        }
      }
    }

    // Send welcome DM
    if (member) {
      try {
        await sendReceiptDM(member.user, {
          orderNumber: payload.order_number,
          productName: payload.product_name,
          amountCents: payload.amount_cents,
          currency: payload.currency,
          licenseKey: null,
          date: new Date(),
        });
      } catch { /* Non-fatal */ }
    }

    // Emit event
    this.eventBus.emit('subscription.activated', payload.guild_id, {
      customerId: payload.customer_id,
      discordId: payload.discord_id,
      productId: payload.product_id,
      productName: payload.product_name,
      planId: payload.plan_id ?? '',
    });

    await this.supabase.from('audit_logs').insert({
      guild_id: payload.guild_id,
      action: 'subscription_activated',
      entity_type: 'order',
      entity_id: payload.order_id,
      actor_type: 'system',
      actor_id: 'commerce-fulfillment',
      details: { customer_id: payload.customer_id, product_name: payload.product_name },
    }).catch(() => {});

    console.log(`[Fulfillment] ✅ Subscription activated: ${payload.product_name} → ${payload.discord_id}`);
  }

  // ── Cancellation Fulfillment ────────────────────────────

  private async fulfillCancellation(payload: FulfillmentPayload): Promise<void> {
    // Revoke entitlements
    await this.supabase
      .from('entitlements')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('order_id', payload.order_id)
      .eq('guild_id', payload.guild_id);

    // Revoke roles (get from product, not payload — payload may be empty)
    const { data: product } = await this.supabase
      .from('products')
      .select('granted_role_ids, granted_channel_ids')
      .eq('id', payload.product_id)
      .single();

    const member = await this.guild.members.fetch(payload.discord_id).catch(() => null);
    if (member && product?.granted_role_ids?.length) {
      for (const roleId of product.granted_role_ids) {
        await member.roles.remove(roleId, `Subscription cancelled: ${payload.product_name}`).catch(() => {});
      }
    }

    // Emit event
    this.eventBus.emit('subscription.lapsed', payload.guild_id, {
      customerId: payload.customer_id,
      discordId: payload.discord_id,
      productId: payload.product_id,
      productName: payload.product_name,
      reason: 'cancelled',
    });

    // Notify user
    if (member) {
      try {
        const { EmbedBuilder } = await import('discord.js');
        const dm = await member.user.createDM();
        await dm.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xFF4444)
              .setTitle('Subscription Cancelled')
              .setDescription(`Your subscription to **${payload.product_name}** has been cancelled. Your access has been revoked.`)
              .setTimestamp(),
          ],
        });
      } catch { /* DMs may be disabled */ }
    }

    console.log(`[Fulfillment] ✅ Cancellation processed: ${payload.product_name} → ${payload.discord_id}`);
  }

  // ── Suspension Fulfillment ──────────────────────────────

  private async fulfillSuspension(payload: FulfillmentPayload): Promise<void> {
    // Suspend entitlements
    await this.supabase
      .from('entitlements')
      .update({ status: 'suspended', updated_at: new Date().toISOString() })
      .eq('order_id', payload.order_id)
      .eq('guild_id', payload.guild_id);

    // Revoke roles temporarily
    const { data: product } = await this.supabase
      .from('products')
      .select('granted_role_ids')
      .eq('id', payload.product_id)
      .single();

    const member = await this.guild.members.fetch(payload.discord_id).catch(() => null);
    if (member && product?.granted_role_ids?.length) {
      for (const roleId of product.granted_role_ids) {
        await member.roles.remove(roleId, `Subscription suspended: ${payload.product_name}`).catch(() => {});
      }
    }

    // Notify user
    if (member) {
      try {
        const { EmbedBuilder } = await import('discord.js');
        const dm = await member.user.createDM();
        await dm.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xFFAA00)
              .setTitle('⚠️ Subscription Suspended')
              .setDescription(`Your subscription to **${payload.product_name}** has been suspended due to a payment issue. Please update your payment method to restore access.`)
              .setTimestamp(),
          ],
        });
      } catch { /* DMs may be disabled */ }
    }

    console.log(`[Fulfillment] ✅ Suspension processed: ${payload.product_name} → ${payload.discord_id}`);
  }
}
