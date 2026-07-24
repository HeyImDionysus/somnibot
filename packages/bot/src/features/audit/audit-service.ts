/**
 * AuditService — Logs all significant platform events to the audit_logs table.
 *
 * Architecture doc §33.1–§33.3.
 * Phase C: Enhanced with before/after state diffs, correlation IDs,
 * and complete event coverage including automations and config changes.
 *
 * Subscribes to the platform EventBus catch-all listener and maps events
 * to structured audit log entries with category, actorType, and optional
 * beforeState/afterState diffs.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from '../../services/event-bus.js';
import type { PlatformEvent } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('AuditService');

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
  /** Extract before state for diffs */
  beforeState?: (data: Record<string, unknown>) => Record<string, unknown> | undefined;
  /** Extract after state for diffs */
  afterState?: (data: Record<string, unknown>) => Record<string, unknown> | undefined;
  /** Extract correlation ID for grouping related entries */
  correlationId?: (data: Record<string, unknown>) => string | undefined;
  /** Override the row's success flag (defaults to true) — e.g. denied attempts. */
  success?: boolean;
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
    afterState: (d) => ({ roles: d.roles }),
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
    beforeState: (d) => ({ hasRole: false }),
    afterState: (d) => ({ hasRole: true, roleId: d.roleId, roleName: d.roleName }),
  },
  'role.lost': {
    action: 'member.role_removed',
    category: 'members',
    targetType: 'member',
    actorType: 'bot',
    targetId: (d) => d.discordId as string,
    details: (d) => ({ roleId: d.roleId, roleName: d.roleName, source: d.source }),
    beforeState: (d) => ({ hasRole: true, roleId: d.roleId, roleName: d.roleName }),
    afterState: (d) => ({ hasRole: false }),
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
    beforeState: (d) => ({ totalInfractions: ((d.totalInfractions as number) ?? 1) - 1 }),
    afterState: (d) => ({ totalInfractions: d.totalInfractions }),
  },
  'member.muted': {
    action: 'mute.applied',
    category: 'moderation',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.discordId as string ?? d.userId as string,
    actorId: (d) => d.moderatorId as string,
    details: (d) => ({ reason: d.reason, duration: d.duration ?? d.durationMinutes }),
    beforeState: () => ({ muted: false }),
    afterState: (d) => ({ muted: true, duration: d.duration ?? d.durationMinutes }),
  },
  'member.kicked': {
    action: 'kick.executed',
    category: 'moderation',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.discordId as string ?? d.userId as string,
    actorId: (d) => d.moderatorId as string,
    details: (d) => ({ reason: d.reason }),
    beforeState: () => ({ inServer: true }),
    afterState: () => ({ inServer: false }),
  },
  'member.banned': {
    action: 'ban.executed',
    category: 'moderation',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.discordId as string ?? d.userId as string,
    actorId: (d) => d.moderatorId as string,
    details: (d) => ({ reason: d.reason }),
    beforeState: () => ({ banned: false }),
    afterState: () => ({ banned: true }),
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
    afterState: (d) => ({ status: 'open', ticketNumber: d.ticketNumber }),
  },
  'ticket.claimed': {
    action: 'ticket.claimed',
    category: 'tickets',
    targetType: 'ticket',
    actorType: 'user',
    targetId: (d) => d.ticketId as string,
    actorId: (d) => d.userDiscordId as string,
    details: (d) => ({ ticketNumber: d.ticketNumber }),
    beforeState: () => ({ claimed: false }),
    afterState: (d) => ({ claimed: true, claimedBy: d.userDiscordId }),
  },
  'ticket.closed': {
    action: 'ticket.closed',
    category: 'tickets',
    targetType: 'ticket',
    actorType: 'user',
    targetId: (d) => d.ticketId as string,
    actorId: (d) => d.userDiscordId as string,
    details: (d) => ({ ticketNumber: d.ticketNumber }),
    beforeState: () => ({ status: 'open' }),
    afterState: () => ({ status: 'closed' }),
  },
  'ticket.reopened': {
    action: 'ticket.reopened',
    category: 'tickets',
    targetType: 'ticket',
    actorType: 'user',
    targetId: (d) => d.ticketId as string,
    actorId: (d) => d.userDiscordId as string,
    details: (d) => ({ ticketNumber: d.ticketNumber }),
    beforeState: () => ({ status: 'closed' }),
    afterState: () => ({ status: 'open' }),
  },
  'ticket.denied': {
    action: 'ticket.denied',
    category: 'tickets',
    targetType: 'ticket',
    actorType: 'user',
    targetId: (d) => d.ticketId as string,
    actorId: (d) => d.actorDiscordId as string,
    details: (d) => ({ ticketNumber: d.ticketNumber, reason: d.reason }),
    success: false,
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
    correlationId: (d) => `order-${d.orderId}`,
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
    beforeState: () => ({ entitled: false }),
    afterState: (d) => ({ entitled: true, productId: d.productId, roleIds: d.roleIds }),
    correlationId: (d) => d.orderId ? `order-${d.orderId}` : undefined,
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
    beforeState: (d) => ({ entitled: true, productId: d.productId }),
    afterState: (d) => ({ entitled: false, reason: d.reason }),
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
    afterState: (d) => ({ status: 'active', planId: d.planId }),
  },
  'subscription.lapsed': {
    action: 'subscription.suspended',
    category: 'subscriptions',
    targetType: 'subscription',
    actorType: 'system',
    targetId: (d) => d.productId as string,
    actorId: (d) => d.discordId as string,
    details: (d) => ({ planId: d.planId, status: d.status }),
    beforeState: () => ({ status: 'active' }),
    afterState: (d) => ({ status: 'lapsed' }),
  },
  'subscription.expired': {
    action: 'subscription.expired',
    category: 'subscriptions',
    targetType: 'subscription',
    actorType: 'system',
    targetId: (d) => d.productId as string,
    actorId: (d) => d.discordId as string,
    details: (d) => ({ planId: d.planId, status: d.status }),
    beforeState: () => ({ status: 'active' }),
    afterState: (d) => ({ status: 'expired' }),
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
    beforeState: (d) => ({ level: d.previousLevel }),
    afterState: (d) => ({ level: d.newLevel, totalXp: d.totalXp }),
  },

  // ── Giveaways ──
  'giveaway.ended': {
    action: 'giveaway.ended',
    category: 'giveaways',
    targetType: 'giveaway',
    actorType: 'system',
    targetId: (d) => d.giveawayId as string,
    details: (d) => ({ prize: d.title ?? d.prize, winnerCount: (d.winnerIds as string[])?.length ?? d.winnerCount, winners: d.winnerIds ?? d.winners }),
    afterState: (d) => ({ status: 'ended', winners: d.winnerIds ?? d.winners }),
  },

  // ── Sync & Deploy ──
  'server.deployed': {
    action: 'setup.deployed',
    category: 'sync',
    targetType: 'server',
    actorType: 'bot',
    details: (d) => ({
      rolesDeployed: d.rolesCreated ?? d.rolesDeployed,
      channelsDeployed: d.channelsCreated ?? d.channelsDeployed,
      overridesApplied: d.overridesApplied,
      duration: d.duration,
    }),
    correlationId: (d) => d.deployId ? `deploy-${d.deployId}` : undefined,
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
    correlationId: (d) => d.deployId ? `deploy-${d.deployId}` : undefined,
  },
  'deploy.failed': {
    action: 'sync.failed',
    category: 'sync',
    targetType: 'server',
    actorType: 'system',
    details: (d) => ({ deployId: d.deployId, error: d.error, duration: d.duration }),
    correlationId: (d) => d.deployId ? `deploy-${d.deployId}` : undefined,
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

  // ── Config Changes (with before/after diffs) ──
  'config.changed': {
    action: 'config.updated',
    category: 'system',
    targetType: 'config',
    actorType: 'user',
    actorId: (d) => d.changedBy as string,
    details: (d) => ({ section: d.section, source: d.source ?? 'dashboard' }),
    beforeState: (d) => (d.before as Record<string, unknown>) ?? undefined,
    afterState: (d) => (d.after ?? d.changes) as Record<string, unknown> | undefined,
  },

  // ── Automations ── (Phase C addition)
  'automation.executed': {
    action: 'automation.executed',
    category: 'automations',
    targetType: 'automation',
    actorType: 'automation',
    targetId: (d) => d.automationId as string,
    details: (d) => ({
      automationName: d.automationName,
      trigger: d.trigger,
      actionsExecuted: d.actionsExecuted,
      success: d.success,
      duration: d.duration,
    }),
    correlationId: (d) => d.executionId ? `auto-${d.executionId}` : undefined,
  },
  'automation.created': {
    action: 'automation.created',
    category: 'automations',
    targetType: 'automation',
    actorType: 'user',
    targetId: (d) => d.automationId as string,
    actorId: (d) => d.createdBy as string,
    details: (d) => ({ automationName: d.automationName, trigger: d.trigger }),
    afterState: (d) => ({ enabled: d.enabled, trigger: d.trigger, actionCount: d.actionCount }),
  },
  'automation.updated': {
    action: 'automation.updated',
    category: 'automations',
    targetType: 'automation',
    actorType: 'user',
    targetId: (d) => d.automationId as string,
    actorId: (d) => d.updatedBy as string,
    details: (d) => ({ automationName: d.automationName }),
    beforeState: (d) => (d.before as Record<string, unknown>) ?? undefined,
    afterState: (d) => (d.after as Record<string, unknown>) ?? undefined,
  },
  'automation.deleted': {
    action: 'automation.deleted',
    category: 'automations',
    targetType: 'automation',
    actorType: 'user',
    targetId: (d) => d.automationId as string,
    actorId: (d) => d.deletedBy as string,
    details: (d) => ({ automationName: d.automationName }),
    beforeState: (d) => ({ existed: true, name: d.automationName }),
    afterState: () => ({ existed: false }),
  },

  // ── Webhook Events ── (Phase C addition)
  'webhook.received': {
    action: 'webhook.received',
    category: 'webhooks',
    targetType: 'webhook',
    actorType: 'webhook',
    targetId: (d) => d.eventId as string,
    details: (d) => ({ eventType: d.eventType, provider: d.provider, result: d.result }),
  },
  'webhook.replayed': {
    action: 'webhook.replayed',
    category: 'webhooks',
    targetType: 'webhook',
    actorType: 'user',
    targetId: (d) => d.eventId as string,
    actorId: (d) => d.replayedBy as string,
    details: (d) => ({ eventType: d.eventType, replayCount: d.replayCount }),
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
      // V11 Audit H-1: Only log events for our guild. The event bus is a
      // process-level singleton and AuditService is per-guild, so without
      // this filter every guild's AuditService writes entries for ALL guilds,
      // producing N² duplicate rows.
      if (event.guildId !== this.guildId) return;

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
        before_state: mapping.beforeState?.(data) ?? null,
        after_state: mapping.afterState?.(data) ?? null,
        correlation_id: mapping.correlationId?.(data) ?? null,
        success: mapping.success ?? true,
      };

      this.queue.push(entry);
    });

    // Flush queue every 5 seconds to batch inserts
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 5000);

    log.info('Started — listening to all platform events (with before/after diffs)');
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
    log.info('Stopped');
  }

  /**
   * Manually log an audit entry (for non-event-bus actions).
   */
  async log(entry: {
    action: string;
    category?: string;
    actorType: 'user' | 'bot' | 'system' | 'webhook' | 'automation';
    actorId: string;
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
    beforeState?: Record<string, unknown>;
    afterState?: Record<string, unknown>;
    correlationId?: string;
    success?: boolean;
    errorMessage?: string;
  }): Promise<void> {
    this.queue.push({
      guild_id: this.guildId,
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      action: entry.action,
      category: entry.category ?? 'system',
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
      before_state: entry.beforeState ?? null,
      after_state: entry.afterState ?? null,
      correlation_id: entry.correlationId ?? null,
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
      log.error(`Failed to flush ${batch.length} entries:`, error.message);
      // Re-queue on failure (max 500 to prevent memory leak)
      if (this.queue.length < 500) {
        this.queue.unshift(...batch);
      }
    }
  }
}
