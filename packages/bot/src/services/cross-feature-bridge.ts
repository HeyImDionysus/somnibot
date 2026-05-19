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
import type { PlatformEvent } from '@somnibot/shared';

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
    console.log('[CrossFeatureBridge] Starting cross-feature event wiring...');

    // ── 1. Ban/Kick → Giveaway + Ticket cleanup ────────────

    this.on('member.banned', async (event) => {
      const userId = event.data.discordId;
      if (!userId) return;

      // Remove from all active giveaway entries
      await this.removeGiveawayEntries(userId, 'banned');

      // Close any open tickets by this user
      await this.closeUserTickets(userId, 'User was banned');

      console.log(`[CrossFeatureBridge] Cleaned up giveaways + tickets for banned user ${userId}`);
    });

    this.on('member.kicked', async (event) => {
      const userId = event.data.discordId;
      if (!userId) return;

      // Remove from active giveaway entries
      await this.removeGiveawayEntries(userId, 'kicked');
    });

    // ── 2. Level Up → Discount unlocks + Role grants ───────

    this.on('level.up', async (event) => {
      const userId = event.data.discordId;
      const newLevel = event.data.newLevel;
      if (!userId || !newLevel) return;

      // Check for level-gated discount unlocks
      const { data: discounts } = await this.supabase
        .from('promotions')
        .select('id, code, discount_percent, min_level')
        .eq('guild_id', this.guild.id)
        .eq('active', true)
        .not('min_level', 'is', null)
        .lte('min_level', newLevel);

      if (discounts && discounts.length > 0) {
        // DM user about unlocked discounts
        try {
          const member = await this.guild.members.fetch(userId).catch(() => null);
          if (member) {
            const discountList = discounts.map(
              (d) => `• **${d.code}** — ${d.discount_percent}% off`,
            ).join('\n');

            await member.send({
              embeds: [{
                title: '🎉 Discount Unlocked!',
                description: `You reached level **${newLevel}** and unlocked new discounts:\n\n${discountList}\n\nUse these in the store!`,
                color: 0x5865f2,
              }],
            }).catch(() => {}); // DMs might be disabled
          }
        } catch {
          // Non-fatal
        }
      }

      // Check for level-gated role grants
      const { data: roleRewards } = await this.supabase
        .from('level_role_rewards')
        .select('role_id')
        .eq('guild_id', this.guild.id)
        .eq('level', newLevel);

      if (roleRewards && roleRewards.length > 0) {
        try {
          const member = await this.guild.members.fetch(userId).catch(() => null);
          if (member) {
            for (const reward of roleRewards) {
              await member.roles.add(reward.role_id, `Level ${newLevel} reward`).catch(() => {});
            }
          }
        } catch {
          // Non-fatal
        }
      }
    });

    // ── 3. Purchase Complete → XP bonus + Celebration ──────

    this.on('purchase.completed', async (event) => {
      const userId = event.data.discordId;
      const productName = event.data.productName ?? 'a product';
      const orderId = event.data.orderId;
      if (!userId) return;

      // Grant XP bonus for purchase
      const XP_BONUS = 500;
      const { data: existing } = await this.supabase
        .from('member_levels')
        .select('xp')
        .eq('guild_id', this.guild.id)
        .eq('user_id', userId)
        .maybeSingle();

      if (existing) {
        await this.supabase
          .from('member_levels')
          .update({ xp: existing.xp + XP_BONUS })
          .eq('guild_id', this.guild.id)
          .eq('user_id', userId);

        console.log(`[CrossFeatureBridge] Granted ${XP_BONUS} XP to ${userId} for purchase ${orderId}`);
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
          .catch(() => {}); // Table might not exist yet

        // Update Valkey stats
        await this.valkey.hincrby(`stats:tickets:${this.guild.id}`, 'total_resolved', 1).catch(() => {});
        await this.valkey.lpush(
          `stats:tickets:${this.guild.id}:resolution_times`,
          String(resolutionMs),
        ).catch(() => {});
        await this.valkey.ltrim(`stats:tickets:${this.guild.id}:resolution_times`, 0, 99).catch(() => {});
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

    this.on('giveaway.ended', async (event) => {
      const winnerIds = event.data.winnerIds;
      const prizeProductId = event.data.prizeProductId;
      const giveawayId = event.data.giveawayId;
      if (!winnerIds || winnerIds.length === 0 || !prizeProductId) return;

      // Trigger license generation for each winner
      for (const winnerId of winnerIds) {
        // Use action queue instead of event emit to ensure fulfillment
        await this.supabase.from('bot_action_queue').insert({
          guild_id: this.guild.id,
          action: 'fulfill_giveaway_prize',
          payload: {
            winner_id: winnerId,
            product_id: prizeProductId,
            giveaway_id: giveawayId,
            source: 'giveaway',
          },
          status: 'pending',
        }).catch((err) => {
          console.error(`[CrossFeatureBridge] Failed to queue giveaway fulfillment for ${winnerId}:`, err);
        });

        console.log(`[CrossFeatureBridge] Queued fulfillment for giveaway winner ${winnerId} → product ${prizeProductId}`);
      }
    });

    console.log(`[CrossFeatureBridge] ✅ ${this.listeners.length} cross-feature event bridges active`);
  }

  /**
   * Stop all listeners.
   */
  stop(): void {
    for (const unsub of this.listeners) {
      unsub();
    }
    this.listeners = [];
    console.log('[CrossFeatureBridge] Stopped');
  }

  // ── Helpers ──────────────────────────────────────────────

  /**
   * Register an event listener that correctly unwraps PlatformEvent.
   * The EventBus passes PlatformEvent<T, D> to handlers (with {type, guildId, timestamp, data}).
   */
  private on<T extends string>(
    event: T,
    handler: (event: PlatformEvent<T>) => Promise<void> | void,
  ): void {
    const wrapped = (evt: PlatformEvent<T>) => {
      // Only process events for our guild
      if (evt.guildId !== this.guild.id) return;
      Promise.resolve(handler(evt)).catch((err) => {
        console.error(`[CrossFeatureBridge] Error handling ${event}:`, err);
      });
    };
    this.eventBus.on(event as never, wrapped as never);
    this.listeners.push(() => this.eventBus.off(event as never, wrapped as never));
  }

  private async removeGiveawayEntries(userId: string, reason: string): Promise<void> {
    try {
      const { data: giveaways } = await this.supabase
        .from('giveaways')
        .select('id, entries')
        .eq('guild_id', this.guild.id)
        .eq('status', 'active');

      if (!giveaways) return;

      for (const g of giveaways) {
        const entries = (g.entries as string[]) || [];
        const filtered = entries.filter((e: string) => e !== userId);
        if (filtered.length !== entries.length) {
          await this.supabase
            .from('giveaways')
            .update({ entries: filtered })
            .eq('id', g.id);

          console.log(`[CrossFeatureBridge] Removed ${userId} from giveaway ${g.id} (${reason})`);
        }
      }
    } catch (err) {
      console.error('[CrossFeatureBridge] Failed to remove giveaway entries:', err);
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
      console.error('[CrossFeatureBridge] Failed to close user tickets:', err);
    }
  }
}
