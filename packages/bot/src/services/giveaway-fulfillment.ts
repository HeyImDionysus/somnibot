/**
 * Giveaway Fulfillment Service
 *
 * Product entitlements and every winner notification are fulfilled only from
 * durable actions queued by the same database transaction that commits the
 * winner set. The in-memory event is informational and never owns a side
 * effect.
 */

import type { Guild } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from './event-bus.js';
import { createLogger, type PlatformEvent } from '@somnibot/shared';
import { applyBrand, resolveBrandKit } from '../features/branding/index.js';
import { deterministicUuidV8 } from '../utils/deterministic-uuid.js';
import {
  codePointLength,
  prizeSnapshotOf,
  sqlSpaceTrim,
} from '../utils/prize-snapshot.js';

const log = createLogger('GiveawayFulfillment');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

type PrizeDeliveryState = 'manual' | 'product';

export class GiveawayPrizeContractError extends Error {}

export interface GiveawayPrizeFulfillmentResult {
  giveawayId: string;
  winnerId: string;
  productId: string;
  entitlementId: string;
  requestId: string;
}

export interface GiveawayWinnerNotificationResult {
  giveawayId: string;
  winnerId: string;
  deliveryKind: PrizeDeliveryState;
  entitlementId: string | null;
  messageId: string;
  nonce: string;
}

function isExactUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export class GiveawayFulfillmentService {
  private guild: Guild;
  private supabase: SupabaseClient;
  private eventBus: PlatformEventBus;
  // V10 Audit M-5: Store listener reference so stop() can remove it.
  // V11 Audit H-3: Typed as PlatformEvent so we can filter by guildId.
  private onGiveawayEnded: ((event: PlatformEvent<'giveaway.ended', { giveawayId: string; title: string; winnerIds: string[]; prizeProductId: string | null }>) => void) | null = null;

  constructor(guild: Guild, supabase: SupabaseClient, eventBus: PlatformEventBus) {
    this.guild = guild;
    this.supabase = supabase;
    this.eventBus = eventBus;
  }

  /**
   * Start listening for giveaway.ended events.
   */
  start(): void {
    this.onGiveawayEnded = (event) => {
      // V11 Audit H-3: Only process events for this guild to prevent
      // cross-guild data corruption in multi-guild deployments.
      if (event.guildId !== this.guild.id) return;

      this.handleGiveawayEnded(event.data).catch((err) => {
        log.error('Error handling giveaway end:', { error: String(err) });
      });
    };
    this.eventBus.on('giveaway.ended', this.onGiveawayEnded);
    log.info('Service started — listening for giveaway.ended');
  }

  /**
   * V10 Audit M-5: Remove event listener to prevent leaks on guild destroy.
   */
  stop(): void {
    if (this.onGiveawayEnded) {
      this.eventBus.off('giveaway.ended', this.onGiveawayEnded);
      this.onGiveawayEnded = null;
    }
    log.info('Service stopped');
  }

  private async handleGiveawayEnded(data: {
    giveawayId: string;
    title: string;
    winnerIds: string[];
    prizeProductId: string | null;
  }): Promise<void> {
    if (!Array.isArray(data.winnerIds) || data.winnerIds.length === 0) {
      log.info(`No winners for giveaway ${data.giveawayId} — skipping`);
      return;
    }
    const winnerIds = [...new Set(data.winnerIds)];
    const prizeProductId = data.prizeProductId;
    const giveawayId = data.giveawayId;
    const title = data.title;

    if (
      !isExactUuid(giveawayId)
      || !DISCORD_SNOWFLAKE_PATTERN.test(this.guild.id)
      || winnerIds.some((winnerId) =>
        typeof winnerId !== 'string'
        || !DISCORD_SNOWFLAKE_PATTERN.test(winnerId))
      || (prizeProductId !== null && !isExactUuid(prizeProductId))
    ) {
      throw new Error(`Giveaway ${giveawayId} contains malformed fulfillment identity`);
    }

    // giveaway_atomic_end / giveaway_atomic_reroll queue the exact product
    // fulfillment (when applicable) and one notification action per winner in
    // the same transaction. Sending here would be both crash-lossy and a
    // duplicate race against those durable carriers.
    log.info(
      `Giveaway ${giveawayId} ${prizeProductId ? 'product fulfillment and ' : ''}`
      + `${winnerIds.length} notification(s) are owned by the durable queue (${title})`,
    );
  }

  /** Fulfill one database-queued product-prize winner. */
  async fulfillQueuedProductPrize(input: {
    giveawayId: string;
    winnerId: string;
    productId: string;
  }): Promise<GiveawayPrizeFulfillmentResult> {
    const { giveawayId, winnerId, productId } = input;
    if (
      !isExactUuid(giveawayId)
      || !isExactUuid(productId)
      || !DISCORD_SNOWFLAKE_PATTERN.test(this.guild.id)
      || !DISCORD_SNOWFLAKE_PATTERN.test(winnerId)
    ) {
      throw new GiveawayPrizeContractError('Malformed queued giveaway prize identity');
    }

    const { data: giveaway, error: giveawayError } = await this.supabase
      .from('giveaways')
      .select('id, guild_id, status, winners, prize_product_id, prize')
      .eq('id', giveawayId)
      .eq('guild_id', this.guild.id)
      .maybeSingle();
    if (giveawayError) {
      throw new Error(`Giveaway lookup failed: ${giveawayError.message}`);
    }
    if (
      !giveaway
      || giveaway.id !== giveawayId
      || giveaway.guild_id !== this.guild.id
      || giveaway.status !== 'ended'
      || giveaway.prize_product_id !== productId
      || typeof giveaway.prize !== 'string'
      || !Array.isArray(giveaway.winners)
      || giveaway.winners.some((value: unknown) =>
        typeof value !== 'string'
        || !DISCORD_SNOWFLAKE_PATTERN.test(value))
      || !giveaway.winners.includes(winnerId)
    ) {
      throw new GiveawayPrizeContractError(
        'Queued giveaway prize is not backed by the exact ended winner contract',
      );
    }

    const { data: product, error: productError } = await this.supabase
      .from('products')
      .select('id, name, type, granted_role_ids, granted_channel_ids')
      .eq('id', productId)
      .eq('guild_id', this.guild.id)
      .maybeSingle();
    if (productError) {
      throw new Error(`Giveaway product lookup failed: ${productError.message}`);
    }
    if (
      !product
      || product.id !== productId
      || typeof product.name !== 'string'
      || !['one_time', 'subscription'].includes(String(product.type))
    ) {
      throw new GiveawayPrizeContractError('Queued giveaway product contract is missing');
    }

    const customerId = await this.resolveCustomerId(winnerId);
    const requestId = deterministicUuidV8('somnibot:giveaway-entitlement:v1', [
      this.guild.id,
      giveawayId,
      winnerId,
      productId,
    ]);
    const rpc = this.supabase.rpc as unknown as (
      name: string,
      params: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
    const { data: grantRows, error: grantError } = await rpc(
      'commerce_create_noncommerce_entitlement',
      {
        p_request_id: requestId,
        p_guild_id: this.guild.id,
        p_customer_id: customerId,
        p_product_id: productId,
        p_source: 'giveaway',
        p_type: product.type,
        p_plan_id: null,
        p_expires_at: null,
        p_granted_role_ids: product.granted_role_ids ?? [],
        p_granted_channel_ids: product.granted_channel_ids ?? [],
      },
    );
    if (grantError) {
      throw new Error(`Entitlement grant failed: ${grantError.message}`);
    }
    const grant = Array.isArray(grantRows) && grantRows.length === 1
      ? grantRows[0] as Record<string, unknown>
      : null;
    if (
      !grant
      || !isExactUuid(grant.entitlement_id)
      || grant.order_id !== requestId
      || grant.request_id !== requestId
    ) {
      throw new GiveawayPrizeContractError(
        'Entitlement grant returned malformed replay identity evidence',
      );
    }

    log.info(`Recorded "${product.name}" delivery for ${winnerId}`);
    return {
      giveawayId,
      winnerId,
      productId,
      entitlementId: grant.entitlement_id,
      requestId,
    };
  }

  async notifyQueuedWinner(input: {
    source: 'giveaway_atomic_end' | 'giveaway_atomic_reroll';
    giveawayId: string;
    winnerId: string;
    productId: string | null;
    deliveryKind: PrizeDeliveryState;
    prizeSnapshot: string;
  }): Promise<GiveawayWinnerNotificationResult> {
    const {
      giveawayId,
      winnerId,
      productId,
      deliveryKind,
      prizeSnapshot,
    } = input;
    if (
      !['giveaway_atomic_end', 'giveaway_atomic_reroll'].includes(input.source)
      || !isExactUuid(giveawayId)
      || !DISCORD_SNOWFLAKE_PATTERN.test(this.guild.id)
      || !DISCORD_SNOWFLAKE_PATTERN.test(winnerId)
      || !['manual', 'product'].includes(deliveryKind)
      || (deliveryKind === 'product' && !isExactUuid(productId))
      || (deliveryKind === 'manual' && productId !== null)
      || typeof prizeSnapshot !== 'string'
      || prizeSnapshot.length === 0
      // SQL btrim strips only spaces and left() counts code points — a
      // legal snapshot may carry edge tabs/newlines and up to 1000 code
      // points of astral content; JS trim()/length would reject it.
      || sqlSpaceTrim(prizeSnapshot) !== prizeSnapshot
      || codePointLength(prizeSnapshot) > 1_000
    ) {
      throw new GiveawayPrizeContractError('Malformed queued giveaway notification identity');
    }

    const { data: giveaway, error: giveawayError } = await this.supabase
      .from('giveaways')
      .select('id, guild_id, status, winners, prize_product_id, prize')
      .eq('id', giveawayId)
      .eq('guild_id', this.guild.id)
      .maybeSingle();
    if (giveawayError) {
      throw new Error(`Giveaway notification lookup failed: ${giveawayError.message}`);
    }
    if (
      !giveaway
      || giveaway.id !== giveawayId
      || giveaway.guild_id !== this.guild.id
      || giveaway.status !== 'ended'
      || giveaway.prize_product_id !== productId
      // giveaway_atomic_end/reroll snapshot the prize NORMALIZED —
      // btrim(left(btrim(prize), 1000)) — so the stored prize must get the
      // byte-exact SQL transform before the exact-match check, or any
      // giveaway whose stored prize is non-canonical permanently fails
      // every winner notification.
      || typeof giveaway.prize !== 'string'
      || prizeSnapshotOf(giveaway.prize) !== prizeSnapshot
      || !Array.isArray(giveaway.winners)
      || giveaway.winners.some((value: unknown) =>
        typeof value !== 'string' || !DISCORD_SNOWFLAKE_PATTERN.test(value))
      || !giveaway.winners.includes(winnerId)
    ) {
      throw new GiveawayPrizeContractError(
        'Queued giveaway notification is not backed by the exact ended winner contract',
      );
    }

    let entitlementId: string | null = null;
    if (deliveryKind === 'product') {
      const requestId = deterministicUuidV8('somnibot:giveaway-entitlement:v1', [
        this.guild.id,
        giveawayId,
        winnerId,
        productId as string,
      ]);
      const { data: entitlement, error: entitlementError } = await this.supabase
        .from('entitlements')
        .select('id, guild_id, order_id, product_id, source, status')
        .eq('guild_id', this.guild.id)
        .eq('order_id', requestId)
        .eq('product_id', productId as string)
        .eq('source', 'giveaway')
        .maybeSingle();
      if (entitlementError) {
        throw new Error(`Giveaway entitlement proof lookup failed: ${entitlementError.message}`);
      }
      if (!entitlement) {
        throw new Error('Giveaway product entitlement is not durable yet');
      }
      if (
        !isExactUuid(entitlement.id)
        || entitlement.guild_id !== this.guild.id
        || entitlement.order_id !== requestId
        || entitlement.product_id !== productId
        || entitlement.source !== 'giveaway'
        || !['active', 'pending', 'grace_period', 'suspended'].includes(
          String(entitlement.status),
        )
      ) {
        throw new GiveawayPrizeContractError(
          'Queued giveaway notification entitlement proof is cross-linked',
        );
      }
      entitlementId = entitlement.id;
    }

    const nonce = deterministicUuidV8('somnibot:giveaway-winner-notification:v1', [
      this.guild.id,
      giveawayId,
      winnerId,
    ]).replace(/-/g, '').slice(0, 25);
    // dm-winners control: when disabled, the prize is still fulfilled (the
    // entitlement resolution above) and the winner is announced in-channel by
    // the manager, but no personal DM is sent. The messageId records the skip.
    const dmWinners = await this.dmWinnersEnabled();
    let messageId: string;
    if (!dmWinners) {
      messageId = 'dm-disabled';
    } else {
      try {
        messageId = await this.sendWinnerNotification(winnerId, prizeSnapshot, deliveryKind, nonce);
      } catch (error) {
        // Discord code 50007 is the definitive "cannot send messages to this
        // user" response.  The manager has already posted the durable channel
        // announcement, so record the fallback as a successful terminal
        // notification rather than retrying a permanently blocked DM. Other
        // errors remain retryable and continue through the queue's backoff.
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code !== 50007 && code !== '50007') throw error;
        this.eventBus.emit('giveaway.winner_dm_fallback', this.guild.id, {
          giveawayId,
          winnerId,
          occurrenceId: `${giveawayId}:winner-dm-fallback:${winnerId}`,
          correlationId: `giveaway:${giveawayId}`,
        });
        messageId = 'channel-fallback';
      }
    }
    return {
      giveawayId,
      winnerId,
      deliveryKind,
      entitlementId,
      messageId,
      nonce,
    };
  }

  private async resolveCustomerId(winnerId: string): Promise<string> {
    let { data: customer, error: customerError } = await this.supabase
      .from('customers')
      .select('id')
      .eq('guild_id', this.guild.id)
      .eq('discord_id', winnerId)
      .maybeSingle();
    if (customerError) {
      throw new Error(`Customer lookup failed: ${customerError.message}`);
    }

    if (!customer) {
      const member = await this.guild.members.fetch(winnerId).catch(() => null);
      const { data: insertedCustomer, error: insertError } = await this.supabase
        .from('customers')
        .insert({
          guild_id: this.guild.id,
          discord_id: winnerId,
          discord_username: member?.user.username ?? winnerId,
          total_spent_cents: 0,
        })
        .select('id')
        .maybeSingle();
      customer = insertError ? null : insertedCustomer;

      // Resolve unique-insert races and committed inserts whose response was
      // lost through one exact guild/member-scoped read-back.
      if (!customer) {
        const { data: observedCustomer, error: observeError } = await this.supabase
          .from('customers')
          .select('id')
          .eq('guild_id', this.guild.id)
          .eq('discord_id', winnerId)
          .maybeSingle();
        if (observeError) {
          throw new Error(`Customer create read-back failed: ${observeError.message}`);
        }
        customer = observedCustomer;
      }

      if (!customer && insertError) {
        throw new Error(`Customer create failed: ${insertError.message}`);
      }
    }

    if (!customer || !isExactUuid(customer.id)) {
      throw new GiveawayPrizeContractError('Failed to resolve an exact giveaway customer');
    }
    return customer.id;
  }

  /**
   * DM a giveaway winner about their win.
   */
  /** Whether the guild DMs winners (default true). Channel announcement is
   *  handled by the manager regardless, so a false value just skips the DM. */
  private async dmWinnersEnabled(): Promise<boolean> {
    const { data } = await this.supabase
      .from('guild_config')
      .select('giveaway_dm_winners')
      .eq('guild_id', this.guild.id)
      .maybeSingle();
    return data?.giveaway_dm_winners ?? true;
  }

  private async sendWinnerNotification(
    winnerId: string,
    prize: string,
    deliveryState: PrizeDeliveryState,
    nonce: string,
  ): Promise<string> {
    const member = await this.guild.members.fetch(winnerId);

    // Event-driven (no interaction): the cached guild name is the brand fallback.
    const kit = await resolveBrandKit(this.supabase, this.guild.id, {
      fallbackName: this.guild.name,
    });
    const embed = new EmbedBuilder()
      .setTitle('🎉 You Won a Giveaway!')
      .setDescription(
        `Congratulations! You won **${prize}** in **${this.guild.name}**!` +
        (deliveryState === 'product'
          ? '\n\n✅ Your prize has been recorded and delivery is being processed. Check your entitlements shortly!'
          : '\n\n📋 A staff member will reach out to deliver your prize.')
      )
      .setTimestamp()
      .setFooter({ text: this.guild.name, iconURL: this.guild.iconURL() ?? undefined });
    applyBrand(embed, kit, { intent: 'info' });

    const message = await member.send({
      embeds: [embed],
      nonce,
      enforceNonce: true,
    });
    if (!message || !DISCORD_SNOWFLAKE_PATTERN.test(message.id)) {
      throw new Error('Discord giveaway notification returned no exact message evidence');
    }
    return message.id;
  }
}
