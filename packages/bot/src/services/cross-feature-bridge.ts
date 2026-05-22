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

      // V53 B-4: Clean up economy data — cancel listings, forfeit heists, suspend wallet
      await this.cleanupMemberEconomy(userId, 'banned');

      console.log(`[CrossFeatureBridge] Cleaned up giveaways + tickets + economy for banned user ${userId}`);
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

    // ── 2. Level Up → (role grants handled by level-announcer) ─
    // V47-L1: removed the duplicate level.up role-grant handler.
    // `level-announcer.ts` is the canonical path for level reward
    // roles — it correctly honours `level_rewards.remove_at_level`
    // (swapping out the old role on tiered ladders), whereas this
    // bridge only added new roles, producing stacked / desynced
    // role state.

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
        console.error(`[CrossFeatureBridge] Failed to grant purchase XP to ${userId}:`, xpError.message);
      } else {
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
          .then(({ error }) => {
            if (error) console.error('[CrossFeatureBridge] ticket_metrics upsert failed:', error.message);
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
  private on<T extends keyof PlatformEventMap & string>(
    event: T,
    handler: (event: PlatformEvent<T, PlatformEventMap[T]>) => Promise<void> | void,
  ): void {
    const wrapped = (evt: PlatformEvent<T, PlatformEventMap[T]>) => {
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
        .select('id')
        .eq('guild_id', this.guild.id)
        .eq('status', 'active');

      if (!giveaways) return;

      for (const g of giveaways) {
        // Use atomic RPC to avoid read-modify-write race conditions
        const { data } = await this.supabase.rpc('giveaway_remove_entry', {
          p_giveaway_id: g.id,
          p_user_id: userId,
        });

        if (data && data.length > 0) {
          console.log(`[CrossFeatureBridge] Removed ${userId} from giveaway ${g.id} (${reason})`);
        }
      }
    } catch (err) {
      console.error('[CrossFeatureBridge] Failed to remove giveaway entries:', err);
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
        console.error(`[CrossFeatureBridge] cleanup_member_economy failed for ${userId}:`, error.message);
        return;
      }

      if (data) {
        const summary = data as {
          listings_cancelled: number;
          heists_forfeited: number;
          wallet_suspended: boolean;
        };
        if (summary.listings_cancelled > 0 || summary.heists_forfeited > 0 || summary.wallet_suspended) {
          console.log(
            `[CrossFeatureBridge] Economy cleanup for ${userId} (${reason}):`,
            `${summary.listings_cancelled} listing(s) cancelled,`,
            `${summary.heists_forfeited} heist(s) forfeited,`,
            `wallet ${summary.wallet_suspended ? 'suspended' : 'already suspended/absent'}`,
          );
        }
      }
    } catch (err) {
      console.error('[CrossFeatureBridge] Failed to clean up member economy:', err);
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
