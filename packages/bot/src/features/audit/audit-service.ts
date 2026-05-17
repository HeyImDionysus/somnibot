/**
 * AuditService — Logs all significant platform events to the audit_logs table.
 *
 * Architecture doc §33.1–§33.3.
 *
 * Subscribes to the platform EventBus catch-all listener and maps events
 * to structured audit log entries with category, actorType, and optional
 * beforeState/afterState diffs.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from '../../services/event-bus.js';
import type { PlatformEvent } from '@somnibot/shared';

// ── Action mapping ──────────────────────────────────────

interface AuditMapping {
  action: string;
  category: string;
  targetType?: string;
  actorType: 'user' | 'bot' | 'system' | 'webhook' | 'automation';
  /** Extract target ID from event data */
  targetId?: (data: Record<string, unknown>) => string | undefined;
  /** Extract actor ID from event data */
  actorId?: (data: Record<string, unknown>) => string | undefined;
  /** Build details from event data */
  details?: (data: Record<string, unknown>) => Record<string, unknown>;
}

const EVENT_TO_AUDIT: Record<string, AuditMapping> = {
  // ── Members ──
  'member.joined': {
    action: 'member.joined',
    category: 'members',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.discordId as string,
    details: (d) => ({ username: d.username, isReturning: d.isReturning }),
  },
  'member.left': {
    action: 'member.left',
    category: 'members',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.discordId as string,
    details: (d) => ({ username: d.username, roles: d.roles }),
  },
  'member.verified': {
    action: 'member.verified',
    category: 'members',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.discordId as string,
    details: (d) => ({ username: d.username }),
  },
  'role.gained': {
    action: 'member.role_granted',
    category: 'members',
    targetType: 'member',
    actorType: 'bot',
    targetId: (d) => d.discordId as string,
    details: (d) => ({ roleId: d.roleId, roleName: d.roleName, source: d.source }),
  },
  'role.lost': {
    action: 'member.role_removed',
    category: 'members',
    targetType: 'member',
    actorType: 'bot',
    targetId: (d) => d.discordId as string,
    details: (d) => ({ roleId: d.roleId, roleName: d.roleName, source: d.source }),
  },

  // ── Moderation ──
  'infraction.created': {
    action: 'warn.issued',
    category: 'moderation',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    actorId: (d) => d.moderatorId as string,
    details: (d) => ({ type: d.type, reason: d.reason, totalInfractions: d.totalInfractions }),
  },
  'member.muted': {
    action: 'mute.applied',
    category: 'moderation',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    actorId: (d) => d.moderatorId as string,
    details: (d) => ({ reason: d.reason, duration: d.duration }),
  },
  'member.kicked': {
    action: 'kick.executed',
    category: 'moderation',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    actorId: (d) => d.moderatorId as string,
    details: (d) => ({ reason: d.reason }),
  },
  'member.banned': {
    action: 'ban.executed',
    category: 'moderation',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    actorId: (d) => d.moderatorId as string,
    details: (d) => ({ reason: d.reason }),
  },

  // ── Tickets ──
  'ticket.opened': {
    action: 'ticket.opened',
    category: 'tickets',
    targetType: 'ticket',
    actorType: 'user',
    targetId: (d) => d.ticketId as string,
    actorId: (d) => d.userDiscordId as string,
    details: (d) => ({ ticketNumber: d.ticketNumber, channelId: d.channelId }),
  },
  'ticket.claimed': {
    action: 'ticket.claimed',
    category: 'tickets',
    targetType: 'ticket',
    actorType: 'user',
    targetId: (d) => d.ticketId as string,
    actorId: (d) => d.userDiscordId as string,
    details: (d) => ({ ticketNumber: d.ticketNumber }),
  },
  'ticket.closed': {
    action: 'ticket.closed',
    category: 'tickets',
    targetType: 'ticket',
    actorType: 'user',
    targetId: (d) => d.ticketId as string,
    actorId: (d) => d.userDiscordId as string,
    details: (d) => ({ ticketNumber: d.ticketNumber }),
  },
  'ticket.reopened': {
    action: 'ticket.reopened',
    category: 'tickets',
    targetType: 'ticket',
    actorType: 'user',
    targetId: (d) => d.ticketId as string,
    actorId: (d) => d.userDiscordId as string,
    details: (d) => ({ ticketNumber: d.ticketNumber }),
  },

  // ── Commerce ──
  'purchase.completed': {
    action: 'order.completed',
    category: 'commerce',
    targetType: 'order',
    actorType: 'webhook',
    targetId: (d) => d.orderId as string,
    actorId: (d) => d.discordId as string,
    details: (d) => ({
      orderNumber: d.orderNumber,
      productId: d.productId,
      productName: d.productName,
      amount: d.amount,
      currency: d.currency,
    }),
  },
  'entitlement.granted': {
    action: 'entitlement.granted',
    category: 'commerce',
    targetType: 'entitlement',
    actorType: 'system',
    targetId: (d) => d.entitlementId as string,
    actorId: (d) => d.discordId as string,
    details: (d) => ({
      productId: d.productId,
      productName: d.productName,
      roleIds: d.roleIds,
    }),
  },
  'entitlement.revoked': {
    action: 'entitlement.revoked',
    category: 'commerce',
    targetType: 'entitlement',
    actorType: 'system',
    targetId: (d) => d.entitlementId as string,
    actorId: (d) => d.discordId as string,
    details: (d) => ({
      productId: d.productId,
      productName: d.productName,
      reason: d.reason,
    }),
  },

  // ── Subscriptions ──
  'subscription.activated': {
    action: 'subscription.activated',
    category: 'subscriptions',
    targetType: 'subscription',
    actorType: 'webhook',
    targetId: (d) => d.productId as string,
    actorId: (d) => d.discordId as string,
    details: (d) => ({ planId: d.planId, status: d.status }),
  },
  'subscription.lapsed': {
    action: 'subscription.suspended',
    category: 'subscriptions',
    targetType: 'subscription',
    actorType: 'system',
    targetId: (d) => d.productId as string,
    actorId: (d) => d.discordId as string,
    details: (d) => ({ planId: d.planId, status: d.status }),
  },
  'subscription.changed': {
    action: 'subscription.renewed',
    category: 'subscriptions',
    targetType: 'subscription',
    actorType: 'webhook',
    targetId: (d) => d.productId as string,
    actorId: (d) => d.discordId as string,
    details: (d) => ({ planId: d.planId, status: d.status }),
  },

  // ── Levels ──
  'level.up': {
    action: 'level.up',
    category: 'levels',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.discordId as string,
    details: (d) => ({ previousLevel: d.previousLevel, newLevel: d.newLevel, totalXp: d.totalXp }),
  },

  // ── Giveaways ──
  'giveaway.ended': {
    action: 'giveaway.ended',
    category: 'giveaways',
    targetType: 'giveaway',
    actorType: 'system',
    targetId: (d) => d.giveawayId as string,
    details: (d) => ({ prize: d.prize, winnerCount: d.winnerCount, winners: d.winners }),
  },

  // ── Sync & Deploy ──
  'server.deployed': {
    action: 'setup.deployed',
    category: 'sync',
    targetType: 'server',
    actorType: 'bot',
    details: (d) => ({
      rolesDeployed: d.rolesDeployed,
      channelsDeployed: d.channelsDeployed,
      overridesApplied: d.overridesApplied,
      duration: d.duration,
    }),
  },
  'deploy.requested': {
    action: 'sync.started',
    category: 'sync',
    targetType: 'server',
    actorType: 'user',
    details: (d) => ({
      roleCount: d.roleCount,
      channelCount: d.channelCount,
      cleanExisting: d.cleanExisting,
    }),
  },
  'deploy.failed': {
    action: 'sync.failed',
    category: 'sync',
    targetType: 'server',
    actorType: 'system',
    details: (d) => ({ deployId: d.deployId, error: d.error, duration: d.duration }),
  },
  'drift.detected': {
    action: 'drift.detected',
    category: 'sync',
    targetType: 'server',
    actorType: 'system',
    details: (d) => ({
      driftCount: d.driftCount,
      criticalCount: d.criticalCount,
      autoRepaired: d.autoRepaired,
    }),
  },
  'sync.completed': {
    action: 'sync.completed',
    category: 'sync',
    targetType: 'server',
    actorType: 'system',
    details: (d) => ({
      driftItemsFound: d.driftItemsFound,
      itemsRepaired: d.itemsRepaired,
      itemsAccepted: d.itemsAccepted,
      duration: d.duration,
    }),
  },

  // ── Config ──
  'config.changed': {
    action: 'config.updated',
    category: 'system',
    targetType: 'config',
    actorType: 'user',
    details: (d) => ({ key: d.key, source: d.source }),
  },
};

// ── AuditService ────────────────────────────────────────

export class AuditService {
  private guildId: string;
  private supabase: SupabaseClient;
  private eventBus: PlatformEventBus;
  private queue: Array<Record<string, unknown>> = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    guildId: string,
    supabase: SupabaseClient,
    eventBus: PlatformEventBus,
  ) {
    this.guildId = guildId;
    this.supabase = supabase;
    this.eventBus = eventBus;
  }

  /**
   * Start listening to all platform events and logging them.
   */
  start(): void {
    // Listen to every event
    this.eventBus.onAny(async (event: PlatformEvent) => {
      const mapping = EVENT_TO_AUDIT[event.type];
      if (!mapping) return; // untracked event type

      const data = event.data as Record<string, unknown>;

      const entry: Record<string, unknown> = {
        guild_id: event.guildId,
        actor_type: mapping.actorType,
        actor_id: mapping.actorId?.(data) ?? (mapping.actorType === 'system' ? 'system' : 'bot'),
        action: mapping.action,
        category: mapping.category,
        target_type: mapping.targetType ?? null,
        target_id: mapping.targetId?.(data) ?? null,
        details: mapping.details?.(data) ?? {},
        success: true,
      };

      this.queue.push(entry);
    });

    // Flush queue every 5 seconds to batch inserts
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 5000);

    console.log('[AuditService] ✅ Started — listening to all platform events');
  }

  /**
   * Stop the audit service.
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush
    void this.flush();
    console.log('[AuditService] Stopped');
  }

  /**
   * Manually log an audit entry (for non-event-bus actions).
   */
  async log(entry: {
    action: string;
    actorType: 'user' | 'bot' | 'system' | 'webhook' | 'automation';
    actorId: string;
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
    beforeState?: Record<string, unknown>;
    afterState?: Record<string, unknown>;
    success?: boolean;
    errorMessage?: string;
  }): Promise<void> {
    this.queue.push({
      guild_id: this.guildId,
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
      before_state: entry.beforeState ?? null,
      after_state: entry.afterState ?? null,
      success: entry.success ?? true,
      error_message: entry.errorMessage ?? null,
    });
  }

  /**
   * Flush buffered entries to Supabase.
   */
  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.queue.length);

    const { error } = await this.supabase
      .from('audit_logs')
      .insert(batch);

    if (error) {
      console.error(`[AuditService] Failed to flush ${batch.length} entries:`, error.message);
      // Re-queue on failure (max 500 to prevent memory leak)
      if (this.queue.length < 500) {
        this.queue.unshift(...batch);
      }
    }
  }
}
