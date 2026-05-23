/**
 * CrossFeatureBridge — Wires together features that were previously siloed.
 *
 * Listens to EventBus events and triggers cross-cutting side effects:
 *
 * 1. Ban / Kick → remove active giveaway entries, close open tickets
 * 2. Level Up → check for discount unlock thresholds, grant roles
 * 3. Purchase Complete → grant XP bonus, emit celebration
 * 4. Fraud Flag → auto-flag related tickets, notify owner
 * 5. Ticket Closed → trigger satisfaction survey (future), log resolution time
 * 6. Infraction Created → check escalation thresholds, remove giveaway entries if ban
 * 7. Giveaway Won → auto-fulfill if commerce product prize
 * 8. Music Idle → pause after timeout, free resources
 *
 * GAP 3: Features Completely Siloed
 *
 * FIXED: Event names now match PlatformEventMap, handler signature correctly
 * unwraps PlatformEvent wrapper, field names match typed event data.
 */

import { Guild } from 'discord.js';
import { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from './event-bus.js';
import type Valkey from 'iovalkey';
import type { PlatformEvent, PlatformEventMap } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('CrossFeatureBridge');

export class CrossFeatureBridge {
  private listeners: (() => void)[] = [];

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus,
    private valkey: Valkey,
  ) {}

  /**
   * Start listening to all cross-feature events.
   */
  start(): void {
    log.info('Starting cross-feature event wiring...');

    // ── 1. Ban/Kick → Giveaway + Ticket cleanup ────────────

    this.on('member.banned', async (event) => {
      const userId = event.data.discordId;
      if (!userId) return;

      // Remove from all active giveaway entries
      await this.removeGiveawayEntries(userId, 'banned');

      // Close any open tickets by this user
      await this.closeUserTickets(userId, 'User was banned');

      // V53 B-4: Clean up economy data — cancel listings, forfeit heists, suspend wallet
      await this.cleanupMemberEconomy(userId, 'banned');

      log.info(`Cleaned up giveaways + tickets + economy for banned user ${userId}`);
    });

    this.on('member.kicked', async (event) => {
      const userId = event.data.discordId;
      if (!userId) return;

      // Remove from active giveaway entries
      await this.removeGiveawayEntries(userId, 'kicked');

      // V53 B-4: Clean up economy data
      await this.cleanupMemberEconomy(userId, 'kicked');
    });

    // ── 1b. Member Left → Economy cleanup ──────────────────
    this.on('member.left', async (event) => {
      const userId = event.data.discordId;
      if (!userId) return;

      // V53 B-4: Clean up economy data for departing members
      await this.cleanupMemberEconomy(userId, 'left');
    });

    // ── 2. Level Up → Unlock Economy Features (V53 Phase 4 — Finding 4.2) ──
    // Role grants still handled by level-announcer.ts (V47-L1).
    // Bridge handles feature unlocks (fishing, farming, etc.) based on level_unlock_configs.
    this.on('level.up', async (event) => {
      const userId = event.data.discordId;
      const newLevel = event.data.newLevel;
      if (!userId || !newLevel) return;

      try {
        // Check for feature unlocks at this level
        const { data: unlocks } = await this.supabase
          .from('level_unlock_configs')
          .select('feature_key, unlock_message')
          .eq('guild_id', this.guild.id)
          .eq('required_level', newLevel);

        if (unlocks && unlocks.length > 0) {
          for (const unlock of unlocks) {
            // Record unlock for user
            await this.supabase.from('member_feature_unlocks').upsert({
              guild_id: this.guild.id,
              user_id: userId,
              feature_key: unlock.feature_key,
              unlocked_at: new Date().toISOString(),
            }, { onConflict: 'guild_id,user_id,feature_key' });

            log.info(`User ${userId} unlocked "${unlock.feature_key}" at level ${newLevel}`);
          }

          // Cache unlocked features in Valkey for fast command-time checks
          const allKeys = unlocks.map(u => u.feature_key);
          const cacheKey = `unlocks:${this.guild.id}:${userId}`;
          const existing = await this.valkey.smembers(cacheKey);
          const newKeys = allKeys.filter(k => !existing.includes(k));
          if (newKeys.length > 0) {
            await this.valkey.sadd(cacheKey, ...newKeys);
            await this.valkey.expire(cacheKey, 86400); // 24h TTL, refreshed on access
          }
        }
      } catch (err) {
        log.error(`Level-up unlock check failed for ${userId}:`, err);
      }
    });

    // ── 3. Purchase Complete → XP bonus + Celebration ──────

    this.on('purchase.completed', async (event) => {
      const userId = event.data.discordId;
      const productName = event.data.productName ?? 'a product';
      const orderId = event.data.orderId;
      if (!userId) return;

      // Grant XP bonus for purchase (atomic — handles upsert, increment, and level recalc)
      const XP_BONUS = 500;
      const { error: xpError } = await this.supabase.rpc('increment_member_xp', {
        p_guild_id: this.guild.id,
        p_member_id: userId,
        p_xp_amount: XP_BONUS,
      });

      if (xpError) {
        log.error(`Failed to grant purchase XP to ${userId}:`, xpError.message);
      } else {
        log.info(`Granted ${XP_BONUS} XP to ${userId} for purchase ${orderId}`);
      }
    });

    // ── 4. Ticket Closed → Resolution metrics ──────────────

    this.on('ticket.closed', async (event) => {
      const ticketId = event.data.ticketId;
      if (!ticketId) return;

      // Calculate resolution time
      const { data: ticket } = await this.supabase
        .from('tickets')
        .select('created_at, closed_at, creator_id')
        .eq('id', ticketId)
        .maybeSingle();

      if (ticket) {
        const createdAt = new Date(ticket.created_at).getTime();
        const closedAt = new Date(ticket.closed_at ?? Date.now()).getTime();
        const resolutionMs = closedAt - createdAt;

        // Store resolution metric
        await this.supabase
          .from('ticket_metrics')
          .upsert({
            ticket_id: ticketId,
            guild_id: this.guild.id,
            resolution_time_ms: resolutionMs,
            resolved_at: new Date().toISOString(),
          }, { onConflict: 'ticket_id' })
          .then(({ error }) => {
            if (error) log.error('ticket_metrics upsert failed:', error.message);
          });

        // Update Valkey stats
        await this.valkey.hincrby(`stats:tickets:${this.guild.id}`, 'total_resolved', 1).catch(() => { /* fire-and-forget stats */ });
        await this.valkey.lpush(
          `stats:tickets:${this.guild.id}:resolution_times`,
          String(resolutionMs),
        ).catch(() => { /* fire-and-forget stats */ });
        await this.valkey.ltrim(`stats:tickets:${this.guild.id}:resolution_times`, 0, 99).catch(() => { /* fire-and-forget stats */ });
      }
    });

    // ── 5. Infraction → Escalation + Giveaway cleanup ──────

    this.on('infraction.created', async (event) => {
      const userId = event.data.userId;
      const type = event.data.type;
      if (!userId) return;

      // If it's a ban, clean up giveaway entries
      if (type === 'ban') {
        await this.removeGiveawayEntries(userId, 'infraction:ban');
      }
    });

    // ── 6. Giveaway Ended → Commerce fulfillment ───────────
    // NOTE: Giveaway prize fulfillment is handled by GiveawayFulfillmentService,
    // which listens to the same event with proper product lookup, customer
    // creation, and EntitlementService.grant() calls. Removed duplicate handler
    // here that was queuing action-queue entries with an incompatible payload
    // shape (missing required FulfillmentPayload fields), risking double
    // fulfillment and error spam.

    // ── 7. Achievement Earned → Economy Bonus (V53 Phase 4 — Finding 4.2) ──
    this.on('level.up', async (event) => {
      const userId = event.data.discordId;
      const newLevel = event.data.newLevel;
      if (!userId || !newLevel) return;

      // Check if this level is an achievement milestone (multiples of 10)
      if (newLevel % 10 !== 0) return;

      try {
        // Grant milestone bonus: 100 coins per 10 levels
        const bonus = (newLevel / 10) * 100;
        const { error } = await this.supabase.rpc('economy_credit_wallet', {
          p_guild_id: this.guild.id,
          p_user_id: userId,
          p_amount: bonus,
          p_reason: `Level ${newLevel} milestone bonus`,
        });

        if (!error) {
          log.info(`Granted ${bonus} coins to ${userId} for level ${newLevel} milestone`);
        }
      } catch (err) {
        log.error('Milestone bonus failed:', { error: String(err) });
      }
    });

    // ── 8. Ticket Closed → Satisfaction Survey DM (V53 Phase 4 — Finding 4.2) ──
    this.on('ticket.closed', async (event) => {
      const ticketId = event.data.ticketId;
      const creatorId = event.data.userDiscordId;
      if (!ticketId || !creatorId) return;

      try {
        // Check if satisfaction surveys are enabled
        const { data: config } = await this.supabase
          .from('guild_config')
          .select('ticket_satisfaction_survey')
          .eq('guild_id', this.guild.id)
          .single();

        if (!config?.ticket_satisfaction_survey) return;

        // DM the ticket creator with a satisfaction survey
        const member = await this.guild.members.fetch(creatorId).catch(() => null);
        if (!member) return;

        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
        const embed = new EmbedBuilder()
          .setTitle('📋 How was your support experience?')
          .setDescription(`Your ticket #${ticketId.slice(0, 8)} has been resolved. We\'d love your feedback!`)
          .setColor(0x5865F2)
          .setTimestamp();

        const row = new ActionRowBuilder<InstanceType<typeof ButtonBuilder>>().addComponents(
          new ButtonBuilder().setCustomId(`survey:${ticketId}:great`).setLabel('😊 Great').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`survey:${ticketId}:okay`).setLabel('😐 Okay').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`survey:${ticketId}:poor`).setLabel('😞 Poor').setStyle(ButtonStyle.Danger),
        );

        await member.send({ embeds: [embed], components: [row] }).catch(() => {
          // User may have DMs disabled — that's fine
        });
      } catch (err) {
        log.error('Satisfaction survey failed:', { error: String(err) });
      }
    });

    // ── 9. Economy Purchase of Role Item → Grant Discord Role (V53 Phase 4 — Finding 4.2) ──
    this.on('purchase.completed', async (event) => {
      const userId = event.data.discordId;
      const productId = event.data.productId;
      if (!userId || !productId) return;

      try {
        // Check if this product is a role-grant item
        const { data: product } = await this.supabase
          .from('economy_items')
          .select('metadata')
          .eq('id', productId)
          .maybeSingle();

        if (!product) return;
        const metadata = product.metadata as Record<string, unknown> | null;
        const roleId = metadata?.grant_role_id as string | undefined;
        if (!roleId) return;

        const member = await this.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        const roleDurationHours = metadata?.role_duration_hours as number | undefined;
        const durationMs = roleDurationHours ? roleDurationHours * 3600_000 : null;

        await member.roles.add(roleId, 'SomniBot economy purchase — role item');
        log.info(`Granted role ${roleId} to ${userId} via economy purchase`);

        // If temporary role, schedule removal
        if (durationMs) {
          const expiresAt = new Date(Date.now() + durationMs).toISOString();
          await this.supabase.from('temp_role_grants').insert({
            guild_id: this.guild.id,
            user_id: userId,
            role_id: roleId,
            expires_at: expiresAt,
            source: 'economy_purchase',
            source_id: productId,
          });
          log.info(`Temporary role ${roleId} for ${userId} expires at ${expiresAt}`);
        }
      } catch (err) {
        log.error('Role grant from purchase failed:', { error: String(err) });
      }
    });

    log.info(`${this.listeners.length} cross-feature event bridges active`);
  }

  /**
   * Stop all listeners.
   */
  stop(): void {
    for (const unsub of this.listeners) {
      unsub();
    }
    this.listeners = [];
    log.info('Stopped');
  }

  // ── Helpers ──────────────────────────────────────────────

  /**
   * Register an event listener that correctly unwraps PlatformEvent.
   * The EventBus passes PlatformEvent<T, D> to handlers (with {type, guildId, timestamp, data}).
   */
  private on<T extends keyof PlatformEventMap & string>(
    event: T,
    handler: (event: PlatformEvent<T, PlatformEventMap[T]>) => Promise<void> | void,
  ): void {
    const wrapped = (evt: PlatformEvent<T, PlatformEventMap[T]>) => {
      // Only process events for our guild
      if (evt.guildId !== this.guild.id) return;
      Promise.resolve(handler(evt)).catch((err) => {
        log.error(`Error handling ${event}:`, err);
      });
    };
    this.eventBus.on(event as never, wrapped as never);
    this.listeners.push(() => this.eventBus.off(event as never, wrapped as never));
  }

  private async removeGiveawayEntries(userId: string, reason: string): Promise<void> {
    try {
      const { data: giveaways } = await this.supabase
        .from('giveaways')
        .select('id')
        .eq('guild_id', this.guild.id)
        .eq('status', 'active');

      if (!giveaways || giveaways.length === 0) return;

      // V5 audit 14.2 — batch RPC calls with Promise.allSettled instead of serial N+1
      const results = await Promise.allSettled(
        giveaways.map((g) =>
          this.supabase.rpc('giveaway_remove_entry', {
            p_giveaway_id: g.id,
            p_user_id: userId,
          }),
        ),
      );

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled' && r.value.data && r.value.data.length > 0) {
          log.info(`Removed ${userId} from giveaway ${giveaways[i].id} (${reason})`);
        }
      }
    } catch (err) {
      log.error('Failed to remove giveaway entries:', { error: String(err) });
    }
  }

  /**
   * V53 B-4: Clean up economy data when a member is banned/kicked/leaves.
   * Calls the cleanup_member_economy RPC which atomically:
   * - Cancels active market listings (refunds items to inventory)
   * - Forfeits active heist participation
   * - Suspends the wallet (prevents targeting by /rob etc.)
   */
  private async cleanupMemberEconomy(userId: string, reason: string): Promise<void> {
    try {
      const { data, error } = await this.supabase.rpc('cleanup_member_economy', {
        p_guild_id: this.guild.id,
        p_user_id: userId,
        p_reason: reason,
      });

      if (error) {
        log.error(`cleanup_member_economy failed for ${userId}:`, error.message);
        return;
      }

      if (data) {
        const summary = data as {
          listings_cancelled: number;
          heists_forfeited: number;
          wallet_suspended: boolean;
        };
        if (summary.listings_cancelled > 0 || summary.heists_forfeited > 0 || summary.wallet_suspended) {
          log.info(
            `Economy cleanup for ${userId} (${reason})`,
            {
              listings_cancelled: summary.listings_cancelled,
              heists_forfeited: summary.heists_forfeited,
              wallet: summary.wallet_suspended ? 'suspended' : 'already suspended/absent',
            },
          );
        }
      }
    } catch (err) {
      log.error('Failed to clean up member economy:', { error: String(err) });
    }
  }

  private async closeUserTickets(userId: string, reason: string): Promise<void> {
    try {
      await this.supabase
        .from('tickets')
        .update({
          status: 'closed',
          closed_at: new Date().toISOString(),
          close_reason: reason,
        })
        .eq('guild_id', this.guild.id)
        .eq('creator_id', userId)
        .eq('status', 'open');
    } catch (err) {
      log.error('Failed to close user tickets:', { error: String(err) });
    }
  }
}
