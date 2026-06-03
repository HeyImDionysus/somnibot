/**
 * Giveaway Fulfillment Service
 *
 * Listens for giveaway.ended events and auto-grants entitlements to winners
 * when the giveaway has a prize_product_id. Also DMs winners.
 */

import type { Guild, GuildMember } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from './event-bus.js';
import { EntitlementService } from '../features/commerce/entitlement-service.js';
import { SOMNI_PALETTE, createLogger, type PlatformEvent } from '@somnibot/shared';

const log = createLogger('GiveawayFulfillment');

export class GiveawayFulfillmentService {
  private guild: Guild;
  private supabase: SupabaseClient;
  private eventBus: PlatformEventBus;
  private entitlementService: EntitlementService;
  // V10 Audit M-5: Store listener reference so stop() can remove it.
  // V11 Audit H-3: Typed as PlatformEvent so we can filter by guildId.
  private onGiveawayEnded: ((event: PlatformEvent<'giveaway.ended', { giveawayId: string; title: string; winnerIds: string[]; prizeProductId: string | null }>) => void) | null = null;

  constructor(guild: Guild, supabase: SupabaseClient, eventBus: PlatformEventBus) {
    this.guild = guild;
    this.supabase = supabase;
    this.eventBus = eventBus;
    this.entitlementService = new EntitlementService(guild, supabase, eventBus);
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
    const winnerIds = data.winnerIds;
    const prizeProductId = data.prizeProductId;
    const giveawayId = data.giveawayId;
    const title = data.title;

    if (!winnerIds || winnerIds.length === 0) {
      log.info(`No winners for giveaway ${giveawayId} — skipping`);
      return;
    }

    // Always DM winners, even without a product prize
    for (const winnerId of winnerIds) {
      await this.dmWinner(winnerId, title, !!prizeProductId);
    }

    // If there's no product prize, we're done
    if (!prizeProductId) {
      log.info(`Giveaway ${giveawayId} has no product prize — DMs sent`);
      return;
    }

    // Fetch product details for fulfillment
    const { data: product } = await this.supabase
      .from('products')
      .select('id, name, granted_role_ids, granted_channel_ids')
      .eq('id', prizeProductId)
      .single();

    if (!product) {
      log.error(`Product ${prizeProductId} not found — cannot fulfill`);
      return;
    }

    log.info(`Fulfilling ${winnerIds.length} winner(s) for "${product.name}"`);

    let fulfilled = 0;
    for (const winnerId of winnerIds) {
      try {
        // Find or create customer record
        let customerId: string | null = null;

        const { data: existingCustomer } = await this.supabase
          .from('customers')
          .select('id')
          .eq('guild_id', this.guild.id)
          .eq('discord_id', winnerId)
          .maybeSingle();

        if (existingCustomer) {
          customerId = existingCustomer.id;
        } else {
          // Create customer record
          const member = await this.guild.members.fetch(winnerId).catch(() => null);
          const { data: newCustomer } = await this.supabase
            .from('customers')
            .insert({
              guild_id: this.guild.id,
              discord_id: winnerId,
              discord_username: member?.user.tag ?? winnerId,
              total_spent_cents: 0,
            })
            .select('id')
            .single();

          customerId = newCustomer?.id ?? null;
        }

        if (!customerId) {
          log.error(`Could not find/create customer for ${winnerId}`);
          continue;
        }

        // Grant entitlement
        const entitlementId = await this.entitlementService.grant({
          customerId,
          productId: product.id,
          productName: product.name,
          orderId: `giveaway-${giveawayId}`,
          discordId: winnerId,
          type: 'one_time',
          source: 'giveaway',
          grantedRoleIds: product.granted_role_ids ?? [],
          grantedChannelIds: product.granted_channel_ids ?? [],
        });

        if (entitlementId) {
          fulfilled++;
          log.info(`Granted "${product.name}" to ${winnerId}`);
        }
      } catch (err) {
        log.error(`Failed to fulfill for ${winnerId}:`, err);
      }
    }

    log.info(`Fulfilled ${fulfilled}/${winnerIds.length} winners for giveaway ${giveawayId}`);
  }

  /**
   * DM a giveaway winner about their win.
   */
  private async dmWinner(winnerId: string, prize: string, hasProduct: boolean): Promise<void> {
    try {
      const member = await this.guild.members.fetch(winnerId).catch(() => null);
      if (!member) return;

      const embed = new EmbedBuilder()
        .setColor(SOMNI_PALETTE.CYAN)
        .setTitle('🎉 You Won a Giveaway!')
        .setDescription(
          `Congratulations! You won **${prize}** in **${this.guild.name}**!` +
          (hasProduct
            ? '\n\n✅ Your prize has been automatically delivered. Check your entitlements!'
            : '\n\n📋 A staff member will reach out to deliver your prize.')
        )
        .setTimestamp()
        .setFooter({ text: this.guild.name, iconURL: this.guild.iconURL() ?? undefined });

      await member.send({ embeds: [embed] });
    } catch {
      // DMs may be disabled — not an error
      log.warn(`Could not DM winner ${winnerId}`);
    }
  }
}
