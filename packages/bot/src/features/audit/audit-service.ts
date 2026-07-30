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
import { randomUUID } from 'node:crypto';

const log = createLogger('AuditService');

// ── Action mapping ──────────────────────────────────────

type AuditActorType = 'user' | 'bot' | 'system' | 'webhook' | 'automation';

interface AuditMapping {
  /**
   * The audit_logs `action`. A per-event resolver (like `targetType` below)
   * lets ONE event type carry a family of actions that differ only by a
   * payload field — e.g. automod's `automod.delete` / `automod.warn` /
   * `automod.observe.mute`, which would otherwise need ten near-identical
   * mappings and ten event types for one feature.
   */
  action: string | ((data: Record<string, unknown>) => string);
  category: string;
  /** Static target type, or a per-event resolver for dual-target events. */
  targetType?: string | ((data: Record<string, unknown>) => string | undefined);
  actorType: AuditActorType | ((data: Record<string, unknown>) => AuditActorType);
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
  /**
   * Extract the stable identity of THIS event occurrence for exactly-once
   * audit writes. Only defined where the payload carries an id that is
   * structurally created/completed ONCE (an infraction is created once, an
   * order completes once, a lottery drawing draws once). The resulting
   * `occurrence_key` (`<action>:<id>`) is deduped in-queue and enforced by
   * the `uq_audit_logs_guild_occurrence` unique index (flush inserts with
   * ON CONFLICT DO NOTHING), so a redelivered platform event or a re-flushed
   * batch cannot write a second row. Events without a stable semantic
   * occurrence identity (joins, messages, repeated state toggles) receive a
   * fresh immutable delivery key. That preserves append semantics between
   * separate events while making an ambiguously acknowledged batch retry
   * idempotent.
   * Any emit site may alternatively pass `occurrenceId` in the event data.
   */
  occurrenceId?: (data: Record<string, unknown>) => string | undefined;
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
    occurrenceId: (d) => d.infractionId as string | undefined,
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
    occurrenceId: (d) => d.ticketId as string | undefined,
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
    // The ACTING closer when carried (a manager closing another member's
    // ticket); falls back to the creator for legacy emissions.
    actorId: (d) => (d.actorId ?? d.userDiscordId) as string,
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
    // The ACTING reopener when carried; creator fallback (see ticket.closed).
    actorId: (d) => (d.actorId ?? d.userDiscordId) as string,
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
    occurrenceId: (d) => d.orderId as string | undefined,
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
    occurrenceId: (d) => d.giveawayId as string | undefined,
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
    // Emitter-carried before wins; when absent the enqueue path fills
    // before_state from the service's last-known guild_config snapshot so the
    // config.updated diff is two-sided even for legacy emissions.
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
    occurrenceId: (d) => d.automationId as string | undefined,
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
  // ── Auto-mod (rail A) ──
  // Auto-mod evaluates EVERY message, so these are the hottest audit writes in
  // the bot; they ride the batched event rail rather than a direct per-message
  // insert. `action` resolves per event so one mapping covers the whole
  // family (automod.delete / automod.warn / … / automod.observe.<action>) with
  // the exact strings the dashboard and the fleet's `automod.%` query expect.
  'automod.observed': {
    action: (d) => `automod.observe.${d.wouldAction as string}`,
    category: 'moderation',
    targetType: 'message',
    actorType: 'bot',
    actorId: () => 'automod',
    targetId: (d) => d.messageId as string,
    details: (d) => ({
      rule: d.rule,
      ruleType: d.ruleType,
      violation: d.violation,
      wouldAction: d.wouldAction,
      channelId: d.channelId,
    }),
    // At most one rule executes per message, so the message id is this
    // detection's once-only identity: a redelivered messageCreate collapses
    // onto the same row instead of duplicating it.
    occurrenceId: (d) => d.messageId as string | undefined,
    correlationId: (d) => `automod-${d.messageId as string}`,
  },
  'automod.enforced': {
    action: (d) => `automod.${d.action as string}`,
    category: 'moderation',
    // 'delete' targets the offending MESSAGE; every other action targets the
    // MEMBER it was applied to (this is the rail-B shape, preserved exactly).
    targetType: (d) => (d.action === 'delete' ? 'message' : 'member'),
    actorType: 'bot',
    actorId: () => 'automod',
    targetId: (d) => (d.action === 'delete' ? d.messageId : d.memberId) as string,
    details: (d) => {
      const details: Record<string, unknown> = {
        rule: d.rule,
        ruleType: d.ruleType,
        violation: d.violation,
      };
      // Only the branches that carried extra context on the direct rail add
      // it here — an absent key must stay absent, not become undefined.
      if (d.action === 'delete') details.channelId = d.channelId;
      if (d.action === 'warn') {
        details.infractionId = d.infractionId;
        details.activeWarnings = d.activeWarnings;
      }
      if (d.action === 'mute') details.durationMinutes = d.durationMinutes;
      return details;
    },
    occurrenceId: (d) => d.messageId as string | undefined,
    correlationId: (d) => `automod-${d.messageId as string}`,
  },

  // ── Observability audit wave (2026-07-23): per-feature audit events ──
  'anti_raid.detected': {
    action: 'anti_raid.detected',
    category: 'moderation',
    targetType: 'server',
    actorType: 'system',
    details: (d) => ({ joinCount: d.joinCount, threshold: d.threshold, windowSeconds: d.windowSeconds, action: d.action }),
  },
  'anti_raid.contained': {
    action: 'anti_raid.contained',
    category: 'moderation',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.userId as string | undefined,
    details: (d) => ({ action: d.action, username: d.username, reason: d.reason, invitesPaused: d.invitesPaused }),
  },
  'anti_raid.restored': {
    action: 'anti_raid.restored',
    category: 'moderation',
    targetType: 'server',
    actorType: 'system',
    details: (d) => ({ restorationType: d.restorationType, count: d.count }),
  },
  'anti_raid.action_failed': {
    action: 'anti_raid.action_failed',
    category: 'moderation',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.userId as string | undefined,
    details: (d) => ({ action: d.action, error: d.error }),
    success: false,
  },
  'infraction.pardoned': {
    action: 'infraction.pardoned',
    category: 'moderation',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ infractionId: d.infractionId, reason: d.reason, moderatorId: d.moderatorId }),
  },
  'message_log.config_updated': {
    action: 'message_log.config_updated',
    category: 'moderation',
    targetType: 'config',
    actorType: 'user',
    details: (d) => ({ changedBy: d.changedBy, changes: d.changes }),
  },
  'message_log.degraded': {
    action: 'message_log.degraded',
    category: 'moderation',
    targetType: 'config',
    actorType: 'system',
    details: (d) => ({ error: d.error, reason: d.reason }),
    success: false,
  },
  'ticket.create_failed': {
    action: 'ticket.create_failed',
    category: 'tickets',
    targetType: 'ticket',
    actorType: 'user',
    details: (d) => ({ userDiscordId: d.userDiscordId, panelId: d.panelId, ticketNumber: d.ticketNumber, stage: d.stage, error: d.error }),
    success: false,
  },
  'ticket.transcript_failed': {
    action: 'ticket.transcript_failed',
    category: 'tickets',
    targetType: 'ticket',
    actorType: 'system',
    targetId: (d) => d.ticketId as string,
    details: (d) => ({ ticketNumber: d.ticketNumber, error: d.error }),
    success: false,
  },
  'custom_command.denied': {
    action: 'custom_command.denied',
    category: 'custom_commands',
    targetType: 'custom_command',
    actorType: 'user',
    targetId: (d) => d.commandId as string,
    details: (d) => ({ commandName: d.commandName, userId: d.userId, channelId: d.channelId, reason: d.reason }),
    success: false,
  },
  'custom_command.invoked': {
    action: 'custom_command.invoked',
    category: 'custom_commands',
    targetType: 'custom_command',
    actorType: 'user',
    targetId: (d) => d.commandId as string,
    details: (d) => ({ commandName: d.commandName, userId: d.userId, channelId: d.channelId, actionCount: d.actionCount }),
  },
  'custom_command.degraded': {
    action: 'custom_command.degraded',
    category: 'custom_commands',
    targetType: 'custom_command',
    actorType: 'user',
    targetId: (d) => d.commandId as string,
    details: (d) => ({
      commandName: d.commandName,
      userId: d.userId,
      channelId: d.channelId,
      actionCount: d.actionCount,
      failedActions: d.failedActions,
      failedTypes: d.failedTypes,
    }),
    success: false,
  },
  'diagnostics.alert_raised': {
    action: 'diagnostics.alert_raised',
    category: 'diagnostics',
    targetType: 'alert',
    actorType: 'system',
    targetId: (d) => d.alertType as string,
    details: (d) => ({ alertType: d.alertType, severity: d.severity, title: d.title, message: d.message }),
  },
  'diagnostics.alert_resolved': {
    action: 'diagnostics.alert_resolved',
    category: 'diagnostics',
    targetType: 'alert',
    actorType: 'system',
    targetId: (d) => d.alertType as string,
    details: (d) => ({ alertType: d.alertType }),
  },
  'diagnostics.snapshot_failed': {
    action: 'diagnostics.snapshot_failed',
    category: 'diagnostics',
    targetType: 'diagnostics',
    actorType: 'system',
    details: (d) => ({ stage: d.stage, error: d.error }),
    success: false,
  },
  'sync.failed': {
    action: 'sync.failed',
    category: 'sync',
    targetType: 'server',
    actorType: 'system',
    details: (d) => ({ error: d.error, stage: d.stage }),
    success: false,
  },
  'quest.claimed': {
    action: 'quest.claimed',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ questCount: d.questCount, currency: d.currency, xp: d.xp }),
  },
  'quest.claim_failed': {
    action: 'quest.claim_failed',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ questCount: d.questCount, currency: d.currency, reason: d.reason }),
    success: false,
  },
  'quest.slate_assigned': {
    action: 'quest.slate_assigned',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ questType: d.questType, count: d.count }),
  },
  'quest.completed': {
    action: 'quest.completed',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ questId: d.questId, actionType: d.actionType, progress: d.progress }),
  },
  'casino.bet_settled': {
    action: 'casino.bet_settled',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ game: d.game, net: d.net, loss: d.loss }),
  },
  'achievement.unlocked': {
    action: 'achievement.unlocked',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ achievementId: d.achievementId, name: d.name, rewardCurrency: d.rewardCurrency }),
  },
  'achievement.unlock_failed': {
    action: 'achievement.unlock_failed',
    category: 'game_economy',
    targetType: 'achievement',
    actorType: 'system',
    targetId: (d) => d.achievementId as string,
    details: (d) => ({ userId: d.userId, name: d.name, stage: d.stage }),
    success: false,
  },
  'prestige.performed': {
    action: 'prestige.performed',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ newLevel: d.newLevel, newMultiplier: d.newMultiplier }),
  },
  'adventure.started': {
    action: 'adventure.started',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ adventureId: d.adventureId, adventureName: d.adventureName, ticketCost: d.ticketCost, sessionId: d.sessionId }),
    occurrenceId: (d) => d.sessionId as string | undefined,
  },
  'adventure.completed': {
    action: 'adventure.completed',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ sessionId: d.sessionId, status: d.status, currency: d.currency, lootCount: d.lootCount }),
  },
  'adventure.payout_failed': {
    action: 'adventure.payout_failed',
    category: 'economy',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.userId as string,
    details: (d) => ({ sessionId: d.sessionId, amount: d.amount }),
    success: false,
  },
  'craft.completed': {
    action: 'craft.completed',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ recipeName: d.recipeName, outputQty: d.outputQty }),
  },
  'craft.failed': {
    action: 'craft.failed',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ recipeName: d.recipeName, reason: d.reason }),
    success: false,
  },
  'market.listed': {
    action: 'market.listed',
    category: 'economy',
    targetType: 'market_listing',
    actorType: 'user',
    targetId: (d) => d.listingId as string,
    details: (d) => ({ sellerId: d.sellerId, itemName: d.itemName, quantity: d.quantity, pricePerUnit: d.pricePerUnit }),
  },
  'market.bought': {
    action: 'market.bought',
    category: 'economy',
    targetType: 'market_listing',
    actorType: 'user',
    targetId: (d) => d.listingId as string,
    details: (d) => ({ buyerId: d.buyerId, sellerId: d.sellerId, itemName: d.itemName, quantity: d.quantity, totalCost: d.totalCost, fee: d.fee }),
  },
  'market.cancelled': {
    action: 'market.cancelled',
    category: 'economy',
    targetType: 'market_listing',
    actorType: 'user',
    targetId: (d) => d.listingId as string,
    details: (d) => ({ sellerId: d.sellerId, itemName: d.itemName, quantity: d.quantity }),
  },
  'farm.harvested': {
    action: 'farm.harvested',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ cropCount: d.cropCount, earnings: d.earnings }),
  },
  'farm.payout_failed': {
    action: 'farm.payout_failed',
    category: 'economy',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.userId as string,
    details: (d) => ({ amount: d.amount, cropCount: d.cropCount }),
    success: false,
  },
  'gather.completed': {
    action: 'gather.completed',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ sourceType: d.sourceType, itemName: d.itemName, quantity: d.quantity, value: d.value }),
  },
  'gather.payout_failed': {
    action: 'gather.payout_failed',
    category: 'economy',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.userId as string,
    details: (d) => ({ sourceType: d.sourceType, amount: d.amount }),
    success: false,
  },
  'fishing.catch': {
    action: 'fishing.catch',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ species: d.species, rarity: d.rarity, price: d.price, paid: d.paid }),
  },
  'fishing.payout_failed': {
    action: 'fishing.payout_failed',
    category: 'economy',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.userId as string,
    details: (d) => ({ species: d.species, amount: d.amount }),
    success: false,
  },
  'heist.started': {
    action: 'heist.started',
    category: 'economy',
    targetType: 'heist',
    actorType: 'user',
    targetId: (d) => d.heistId as string,
    details: (d) => ({ userId: d.userId, targetName: d.targetName, basePayout: d.basePayout, entryFee: d.entryFee }),
    occurrenceId: (d) => d.heistId as string | undefined,
  },
  'heist.joined': {
    action: 'heist.joined',
    category: 'economy',
    targetType: 'heist',
    actorType: 'user',
    targetId: (d) => d.heistId as string,
    details: (d) => ({ userId: d.userId, memberCount: d.memberCount, role: d.role }),
  },
  'heist.resolved': {
    action: 'heist.resolved',
    category: 'economy',
    targetType: 'heist',
    actorType: 'system',
    targetId: (d) => d.heistId as string,
    details: (d) => ({ outcome: d.outcome, participantCount: d.participantCount, payoutEach: d.payoutEach }),
    occurrenceId: (d) => d.heistId as string | undefined,
  },
  'heist.settlement_failed': {
    action: 'heist.settlement_failed',
    category: 'economy',
    targetType: 'heist',
    actorType: 'system',
    targetId: (d) => d.heistId as string,
    details: (d) => ({ attempts: d.attempts }),
    success: false,
  },
  'lottery.ticket_purchased': {
    action: 'lottery.ticket_purchased',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ count: d.count, totalCost: d.totalCost, jackpot: d.jackpot }),
  },
  'lottery.drawn': {
    action: 'lottery.drawn',
    category: 'economy',
    targetType: 'lottery_drawing',
    actorType: 'system',
    targetId: (d) => d.drawingId as string,
    details: (d) => ({ winnerId: d.winnerId, jackpot: d.jackpot, winningNumber: d.winningNumber }),
    occurrenceId: (d) => d.drawingId as string | undefined,
  },
  'lottery.payout_failed': {
    action: 'lottery.payout_failed',
    category: 'economy',
    targetType: 'lottery_drawing',
    actorType: 'system',
    targetId: (d) => d.drawingId as string,
    details: (d) => ({ reason: d.reason }),
    success: false,
  },
  'pet.acquired': {
    action: 'pet.acquired',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ petType: d.petType, price: d.price }),
  },
  'pet.battle_resolved': {
    action: 'pet.battle_resolved',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.winnerId as string,
    details: (d) => ({ challengerId: d.challengerId, defenderId: d.defenderId, winnerId: d.winnerId, reward: d.reward, payoutFailed: d.payoutFailed }),
  },
  'pet.battle_payout_failed': {
    action: 'pet.battle_payout_failed',
    category: 'economy',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.winnerId as string,
    details: (d) => ({ reward: d.reward }),
    success: false,
  },
  'pet.prestiged': {
    action: 'pet.prestiged',
    category: 'economy',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    details: (d) => ({ newPrestige: d.newPrestige }),
  },
  'trivia.completed': {
    action: 'trivia.completed',
    category: 'economy',
    targetType: 'channel',
    actorType: 'system',
    targetId: (d) => d.channelId as string,
    details: (d) => ({ answers: d.answers, winners: d.winners, paidWinners: d.paidWinners, totalPayout: d.totalPayout }),
  },
  'trivia.payout_failed': {
    action: 'trivia.payout_failed',
    category: 'economy',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.userId as string,
    details: (d) => ({ amount: d.amount }),
    success: false,
  },
  'economy.reward_claimed': {
    action: 'economy.reward_claimed',
    category: 'economy',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.userId as string,
    details: (d) => ({ rewardType: d.rewardType, amount: d.amount, streak: d.streak }),
  },
  'economy.reward_failed': {
    action: 'economy.reward_failed',
    category: 'economy',
    targetType: 'member',
    actorType: 'system',
    targetId: (d) => d.userId as string,
    details: (d) => ({ rewardType: d.rewardType, amount: d.amount }),
    success: false,
  },
  // The ADD side of the queue. music.skipped/music.stopped record only
  // removals; without this the trail shows tracks leaving a queue nothing was
  // ever recorded as entering.
  'music.queued': {
    action: 'music.queued',
    category: 'music',
    targetType: 'music_queue',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    actorId: (d) => d.userId as string,
    details: (d) => ({
      userId: d.userId,
      title: d.title,
      author: d.author,
      uri: d.uri,
      trackCount: d.trackCount,
      playlistName: d.playlistName,
      queueLength: d.queueLength,
      sessionStarted: d.sessionStarted,
    }),
  },
  // The APPLIED side of a fairness-gated control — same target shape as
  // music.denied below (target_type 'music_control', target_id = the action),
  // so both outcomes of the same control read identically.
  'music.control_applied': {
    action: 'music.control_applied',
    category: 'music',
    targetType: 'music_control',
    actorType: 'user',
    targetId: (d) => d.action as string,
    actorId: (d) => d.userId as string,
    details: (d) => ({ userId: d.userId, action: d.action, value: d.value }),
  },
  'music.skipped': {
    action: 'music.skipped',
    category: 'music',
    targetType: 'track',
    actorType: 'user',
    targetId: (d) => d.requestedBy as string,
    actorId: (d) => d.userId as string,
    details: (d) => ({ userId: d.userId, method: d.method, title: d.title, author: d.author, requester: d.requestedBy, queueEnded: d.queueEnded }),
  },
  'music.stopped': {
    action: 'music.stopped',
    category: 'music',
    targetType: 'music_session',
    actorType: (d) => (
      typeof d.userId === 'string' && d.userId.length > 0 ? 'user' : 'system'
    ),
    actorId: (d) => (
      typeof d.userId === 'string' && d.userId.length > 0 ? d.userId : 'music-player'
    ),
    details: (d) => ({ userId: d.userId, reason: d.reason, trackCount: d.trackCount }),
  },
  'music.denied': {
    action: 'music.denied',
    category: 'music',
    targetType: 'music_control',
    actorType: 'user',
    targetId: (d) => d.action as string,
    actorId: (d) => d.userId as string,
    details: (d) => ({ userId: d.userId, action: d.action }),
    success: false,
  },
  'music.capacity_rejected': {
    action: 'music.capacity_rejected',
    category: 'music',
    targetType: 'music_queue',
    actorType: 'user',
    targetId: (d) => d.userId as string,
    actorId: (d) => d.userId as string,
    details: (d) => ({ userId: d.userId, reason: d.reason, limit: d.limit }),
    success: false,
  },
  'music.store_outage': {
    action: 'music.store_outage',
    category: 'music',
    targetType: 'music_store',
    actorType: 'system',
    details: (d) => ({ userId: d.userId, operation: d.operation, error: d.error }),
    success: false,
  },
  'giveaway.started': {
    action: 'giveaway.started',
    category: 'giveaways',
    targetType: 'giveaway',
    actorType: 'user',
    targetId: (d) => d.giveawayId as string,
    details: (d) => ({ prize: d.prize, winnerCount: d.winnerCount, channelId: d.channelId, endsAt: d.endsAt }),
    occurrenceId: (d) => d.giveawayId as string | undefined,
  },
  'giveaway.entered': {
    action: 'giveaway.entered',
    category: 'giveaways',
    targetType: 'giveaway',
    actorType: 'user',
    targetId: (d) => d.giveawayId as string,
    details: (d) => ({ userId: d.userId, withdrawn: d.withdrawn, entryCount: d.entryCount }),
  },
  'giveaway.paused': {
    action: 'giveaway.paused',
    category: 'giveaways',
    targetType: 'giveaway',
    actorType: 'user',
    targetId: (d) => d.giveawayId as string,
    details: (d) => ({ prize: d.prize }),
  },
  'giveaway.resumed': {
    action: 'giveaway.resumed',
    category: 'giveaways',
    targetType: 'giveaway',
    actorType: 'user',
    targetId: (d) => d.giveawayId as string,
    details: (d) => ({ prize: d.prize, endsAt: d.endsAt }),
  },
  'giveaway.rerolled': {
    action: 'giveaway.rerolled',
    category: 'giveaways',
    targetType: 'giveaway',
    actorType: 'user',
    targetId: (d) => d.giveawayId as string,
    details: (d) => ({ prize: d.prize, winnerIds: d.winnerIds, winnerCount: (d.winnerIds as string[]).length }),
  },
  'giveaway.failed': {
    action: 'giveaway.failed',
    category: 'giveaways',
    targetType: 'giveaway',
    actorType: 'system',
    targetId: (d) => d.giveawayId as string | undefined,
    details: (d) => ({ stage: d.stage, error: d.error }),
    success: false,
  },
  'giveaway.entry_denied': {
    action: 'giveaway.entry_denied',
    category: 'giveaways',
    targetType: 'giveaway',
    actorType: 'user',
    targetId: (d) => d.giveawayId as string,
    actorId: (d) => d.userId as string,
    // actor_id already carries the denied member — no details copy (M1: the
    // purge scrub anonymizes actor_id/target_id, not arbitrary detail keys).
    details: (d) => ({ reason: d.reason, requiredRoleId: d.requiredRoleId, requiredLevel: d.requiredLevel, userLevel: d.userLevel }),
    // Repeat clicks collapse to ONE row per member/giveaway/reason — denials
    // are hot button spam with no per-occurrence identity beyond this triple.
    occurrenceId: (d) => `${d.giveawayId}:${d.userId}:${d.reason}`,
    success: false,
  },
  'xp.admin_adjusted': {
    action: 'levels.xp_admin.adjusted',
    category: 'levels',
    targetType: 'member',
    actorType: 'user',
    targetId: (d) => d.targetId as string,
    details: (d) => ({ operation: d.operation, amount: d.amount, newXp: d.newXp, newLevel: d.newLevel }),
  },
  // NOTE: 'profile.updated' deliberately has NO EVENT_TO_AUDIT entry.
  // ProfilesManager writes its audit rows directly (profiles.title_updated /
  // profiles.bio_updated / profiles.content_rejected via writeAuditLog) so each
  // save lands EXACTLY ONE row; a mapping here would double-write via the batch
  // flush. The eventBus event itself still fires for non-audit consumers.
  'starboard.post_created': {
    action: 'starboard.post_created',
    category: 'starboard',
    targetType: 'message',
    actorType: 'system',
    targetId: (d) => d.sourceMessageId as string,
    details: (d) => ({ sourceChannelId: d.sourceChannelId, starboardMessageId: d.starboardMessageId, authorId: d.authorId, starCount: d.starCount }),
  },
  'stats_channel.updated': {
    action: 'stats_channel.updated',
    category: 'stats_channels',
    targetType: 'channel',
    actorType: 'system',
    targetId: (d) => d.channelId as string,
    details: (d) => ({ statChannelId: d.statChannelId, statType: d.statType, value: d.value, created: d.created }),
  },
  'temp_channel.created': {
    action: 'temp_channel.created',
    category: 'temp_channels',
    targetType: 'channel',
    actorType: 'user',
    targetId: (d) => d.channelId as string,
    details: (d) => ({ textChannelId: d.textChannelId, hubId: d.hubId, hubChannelId: d.hubChannelId, ownerId: d.ownerId }),
  },
  'temp_channel.claimed': {
    action: 'temp_channel.claimed',
    category: 'temp_channels',
    targetType: 'channel',
    actorType: 'user',
    targetId: (d) => d.channelId as string,
    details: (d) => ({ previousOwnerId: d.previousOwnerId, newOwnerId: d.newOwnerId }),
  },
  'temp_channel.deleted': {
    action: 'temp_channel.deleted',
    category: 'temp_channels',
    targetType: 'channel',
    actorType: 'system',
    targetId: (d) => d.channelId as string,
    details: (d) => ({ ownerId: d.ownerId, reason: d.reason }),
  },
  'temp_channel.creation_failed': {
    action: 'temp_channel.creation_failed',
    category: 'temp_channels',
    targetType: 'channel',
    actorType: 'system',
    targetId: (d) => d.hubChannelId as string,
    details: (d) => ({ hubId: d.hubId, memberId: d.memberId, error: d.error }),
    success: false,
  },
  'temp_channel.orphan_reconciled': {
    action: 'temp_channel.orphan_reconciled',
    category: 'temp_channels',
    targetType: 'channel',
    actorType: 'system',
    targetId: (d) => d.channelId as string,
    details: (d) => ({ ownerId: d.ownerId }),
  },
  'temp_channel.settings_changed': {
    action: 'temp_channel.settings_changed',
    category: 'temp_channels',
    // M1 privacy shaping: member-targeted ops (permit/deny/ban/claim) put the
    // AFFECTED MEMBER in target_id/target_type so purge_member_data's scrub
    // (WHERE actor_id = member OR target_id = member) reaches these rows; the
    // channel id moves into details. Channel-shaped ops keep the channel target.
    targetType: (d) => (d.targetUserId ? 'member' : 'channel'),
    actorType: 'user',
    targetId: (d) => (d.targetUserId ?? d.channelId) as string,
    actorId: (d) => d.actorId as string,
    details: (d) => ({ op: d.op, value: d.value, channelId: d.channelId }),
    beforeState: (d) => (d.before as Record<string, unknown>) ?? undefined,
    afterState: (d) => (d.after as Record<string, unknown>) ?? undefined,
  },
  'scheduled_message.sent': {
    action: 'scheduled_message.sent',
    category: 'scheduled_messages',
    targetType: 'scheduled_message',
    actorType: 'system',
    targetId: (d) => d.scheduleId as string,
    details: (d) => ({ name: d.name, channelId: d.channelId, currentSends: d.currentSends }),
  },
  'scheduled_message.delivery_failed': {
    action: 'scheduled_message.delivery_failed',
    category: 'scheduled_messages',
    targetType: 'scheduled_message',
    actorType: 'system',
    targetId: (d) => d.scheduleId as string,
    details: (d) => ({ name: d.name, channelId: d.channelId, reason: d.reason }),
    success: false,
  },
  'poll.created': {
    action: 'poll.created',
    category: 'polls',
    targetType: 'poll',
    actorType: 'user',
    targetId: (d) => d.pollId as string,
    details: (d) => ({ title: d.title, optionCount: d.optionCount, allowMultiple: d.allowMultiple, channelId: d.channelId }),
    occurrenceId: (d) => d.pollId as string | undefined,
  },
  'poll.closed': {
    action: 'poll.closed',
    category: 'polls',
    targetType: 'poll',
    actorType: 'user',
    targetId: (d) => d.pollId as string,
    details: (d) => ({ title: d.title }),
  },
  'prediction.created': {
    action: 'prediction.created',
    category: 'predictions',
    targetType: 'prediction',
    actorType: 'user',
    targetId: (d) => d.predictionId as string,
    details: (d) => ({ title: d.title, optionCount: d.optionCount, channelId: d.channelId }),
    occurrenceId: (d) => d.predictionId as string | undefined,
  },
  'prediction.bet_placed': {
    action: 'prediction.bet_placed',
    category: 'predictions',
    targetType: 'prediction',
    actorType: 'user',
    targetId: (d) => d.predictionId as string,
    details: (d) => ({ userId: d.userId, optionId: d.optionId, amount: d.amount, newPool: d.newPool }),
  },
  'prediction.resolved': {
    action: 'prediction.resolved',
    category: 'predictions',
    targetType: 'prediction',
    actorType: 'user',
    targetId: (d) => d.predictionId as string,
    details: (d) => ({ title: d.title, winningOptionId: d.winningOptionId, totalPool: d.totalPool, payoutCount: d.payoutCount, refundedCount: d.refundedCount, redrive: d.redrive }),
  },
};

// ── AuditService ────────────────────────────────────────

type AuditGapKind = 'capacity' | 'mapping';

interface MutableAuditGapWindow {
  kind: AuditGapKind;
  occurrenceKey: string;
  count: number;
  firstObservedAt: string;
  lastObservedAt: string;
  sources: Set<string>;
  eventTypes: Set<string>;
  actions: Set<string>;
  errors: Set<string>;
  labelsTruncated: boolean;
}

interface FrozenAuditGapWindow {
  kind: AuditGapKind;
  occurrenceKey: string;
  row: Readonly<Record<string, unknown>>;
}

interface AuditRecoveryStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const AUDIT_RESIDUE_VERSION = 1;
const AUDIT_ROW_KEYS = new Set([
  'guild_id',
  'actor_type',
  'actor_id',
  'action',
  'category',
  'target_type',
  'target_id',
  'details',
  'before_state',
  'after_state',
  'correlation_id',
  'occurrence_key',
  'success',
  'error_message',
]);

export class AuditService {
  // The exempt EventBus lane must not become an unbounded memory bypass.
  // Keep both buffered rows and outstanding async mapping work finite. At
  // capacity the loss is coalesced into a durable ledger gap row.
  private static readonly MAX_BUFFERED_ENTRIES = 5_000;
  private static readonly MAX_PENDING_ENQUEUES = 5_000;
  private static readonly MAX_CAPACITY_LABELS = 20;
  private static readonly MAX_STOP_DRAIN_STALLS = 3;
  private static readonly MAPPING_WAIT_TIMEOUT_MS = 10_000;
  private static readonly MAX_RECOVERY_ROWS = AuditService.MAX_BUFFERED_ENTRIES + 1_024;
  private static readonly MAX_RECOVERY_BYTES = 8 * 1024 * 1024;
  private guildId: string;
  private supabase: SupabaseClient;
  private eventBus: PlatformEventBus;
  private recoveryStore: AuditRecoveryStore | null;
  private readonly recoveryStoreKey: string;
  private persistedResidueKeys = new Set<string>();
  private persistedResidueCleanupPending = false;
  private persistedResidueRestorePending = false;
  private queue: Array<Record<string, unknown>> = [];
  private droppedAtCapacity = 0;
  /**
   * At most one mutable and one frozen window per gap kind. A frozen window
   * never changes after its INSERT begins; observations arriving concurrently
   * aggregate into the next mutable window and therefore receive a distinct
   * occurrence key. Failed INSERTs retain the same frozen row/key for retry.
   */
  private activeGapWindows = new Map<AuditGapKind, MutableAuditGapWindow>();
  private pendingGapWindows = new Map<AuditGapKind, FrozenAuditGapWindow>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushInProgress: Promise<boolean> | null = null;
  private stopInProgress: Promise<void> | null = null;
  private acceptingEntries = true;
  private eventHandler: ((event: PlatformEvent) => void) | null = null;
  /**
   * Event→entry enqueue operations still in flight (the config.changed
   * before-snapshot path awaits a lookup). flush() drains these first so a
   * forced flush (shutdown, tests) can never outrun a pending entry.
   */
  private pendingEnqueues = new Set<Promise<void>>();
  /**
   * An in-progress flush outage (set on a failed batch, cleared once a batch
   * lands and the window has been recorded as `audit.flush_failed`). Keyed by
   * its start time so the recovery row is written exactly once per window.
   */
  private flushOutage: {
    attempts: number;
    firstFailedAt: string;
    lastError: string;
  } | null = null;
  /**
   * Immutable recovery rows whose INSERT response failed or was ambiguous.
   * Retaining the exact row matters because audit_logs is append-only and the
   * idempotency key may already have committed even when the client saw an
   * error. Later audit batches must never rewrite this payload.
   */
  private pendingFlushRecoveries: Array<Readonly<Record<string, unknown>>> = [];
  /**
   * Last-known guild_config values — the BEFORE side of config.updated
   * diffs. Loaded once at start() (i.e. before any config change this
   * service will observe) and advanced by each config.changed's `changes`,
   * so it lags the database by exactly the change being audited. This
   * matters because the dashboard writes guild_config BEFORE the
   * config.changed event reaches the bot — a read at event time would
   * return the post-change values and fake the "before" side.
   */
  private guildConfigSnapshot: Record<string, unknown> | null = null;
  private snapshotLoad: Promise<void> | null = null;

  constructor(
    guildId: string,
    supabase: SupabaseClient,
    eventBus: PlatformEventBus,
    recoveryStore?: AuditRecoveryStore,
  ) {
    this.guildId = guildId;
    this.supabase = supabase;
    this.eventBus = eventBus;
    this.recoveryStore = recoveryStore ?? null;
    this.recoveryStoreKey = `guild:${guildId}:audit:shutdown-residue`;
  }

  /**
   * Start listening to all platform events and logging them.
   */
  start(): void {
    if (this.eventHandler) return;
    if (this.stopInProgress) {
      log.warn('Cannot start while the previous stop drain is still running');
      return;
    }
    this.acceptingEntries = true;

    if (this.recoveryStore) {
      this.persistedResidueRestorePending = true;
      this.trackPendingEnqueue(
        this.restorePersistedResidue(),
        'persisted audit residue',
      );
    }

    // Prime the before-snapshot baseline for config.updated diffs.
    this.snapshotLoad = this.loadGuildConfigSnapshot();

    // Listen to every event
    this.eventHandler = (event: PlatformEvent) => {
      if (!this.acceptingEntries) return;
      // V11 Audit H-1: Only log events for our guild. The event bus is a
      // process-level singleton and AuditService is per-guild, so without
      // this filter every guild's AuditService writes entries for ALL guilds,
      // producing N² duplicate rows.
      if (event.guildId !== this.guildId) return;

      const mapping = EVENT_TO_AUDIT[event.type];
      if (!mapping) return; // untracked event type

      if (this.pendingEnqueues.size >= AuditService.MAX_PENDING_ENQUEUES) {
        this.recordCapacityDrop({ source: 'pending event mapping', eventType: event.type });
        return;
      }

      this.trackPendingEnqueue(
        this.enqueueFromEvent(event, mapping),
        event.type,
        event.type,
      );
    };
    this.eventBus.onAny(this.eventHandler, { backpressureExempt: true });

    // Flush queue every 5 seconds to batch inserts
    this.flushTimer = setInterval(() => {
      void this.flush().catch((err: unknown) => {
        log.error('Unexpected audit flush failure:', err);
      });
    }, 5000);

    log.info('Started — listening to all platform events (with before/after diffs)');
  }

  private trackPendingEnqueue(
    operation: Promise<void>,
    source: string,
    eventType?: string,
  ): void {
    const op = operation
      .catch((err: unknown) => {
        log.error(`Failed to queue audit entry for ${source}:`, err);
        this.recordMappingFailure(eventType ?? source, err);
      })
      .finally(() => {
        this.pendingEnqueues.delete(op);
      });
    this.pendingEnqueues.add(op);
  }

  private async restorePersistedResidue(): Promise<void> {
    if (!this.recoveryStore) return;
    const raw = await this.withMappingDeadline(
      this.recoveryStore.get(this.recoveryStoreKey),
      'persisted audit residue load',
    );
    if (!raw) {
      this.persistedResidueRestorePending = false;
      return;
    }

    try {
      if (Buffer.byteLength(raw, 'utf8') > AuditService.MAX_RECOVERY_BYTES) {
        throw new Error('persisted audit residue exceeds the byte limit');
      }
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed === null
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
      ) {
        throw new Error('persisted audit residue envelope is invalid');
      }
      const envelope = parsed as Record<string, unknown>;
      if (
        envelope.version !== AUDIT_RESIDUE_VERSION
        || envelope.guildId !== this.guildId
        || !Array.isArray(envelope.rows)
        || Object.keys(envelope).some((key) => !['version', 'guildId', 'rows'].includes(key))
      ) {
        throw new Error('persisted audit residue envelope failed version/guild validation');
      }
      if (envelope.rows.length > AuditService.MAX_RECOVERY_ROWS) {
        throw new Error('persisted audit residue exceeds the row limit');
      }

      const validatedRows: Array<Readonly<Record<string, unknown>>> = [];
      const seenKeys = new Set<string>();
      for (const candidate of envelope.rows) {
        const row = this.validateRecoveryRow(candidate);
        const key = row.occurrence_key as string;
        if (seenKeys.has(key)) throw new Error('persisted audit residue contains duplicate keys');
        seenKeys.add(key);
        validatedRows.push(Object.freeze({ ...row }));
      }
      for (const row of validatedRows) {
        const key = row.occurrence_key as string;
        if (this.persistedResidueKeys.has(key)) continue;
        this.queue.push(row);
        this.persistedResidueKeys.add(key);
      }
    } catch (err) {
      // Never replay or preserve a poison spool forever. Delete it and let the
      // caller coalesce a bounded audit.mapping_failed integrity observation.
      await this.recoveryStore.del(this.recoveryStoreKey);
      this.persistedResidueRestorePending = false;
      throw err;
    }
    this.persistedResidueCleanupPending = this.persistedResidueKeys.size === 0;
    this.persistedResidueRestorePending = false;
    log.warn(`Restored ${this.persistedResidueKeys.size} audit row(s) from shutdown residue`);
  }

  private validateRecoveryRow(candidate: unknown): Record<string, unknown> {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('persisted audit residue contains a non-object row');
    }
    const row = candidate as Record<string, unknown>;
    if (
      Object.keys(row).length !== AUDIT_ROW_KEYS.size
      || Object.keys(row).some((key) => !AUDIT_ROW_KEYS.has(key))
      || row.guild_id !== this.guildId
      || !this.isBoundedString(row.actor_id, 256)
      || !['user', 'bot', 'system', 'webhook', 'automation'].includes(String(row.actor_type))
      || !this.isBoundedString(row.action, 256)
      || !this.isBoundedString(row.category, 128)
      || !this.isNullableBoundedString(row.target_type, 128)
      || !this.isNullableBoundedString(row.target_id, 512)
      || !this.isSafeJsonRecord(row.details)
      || !(row.before_state === null || this.isSafeJsonRecord(row.before_state))
      || !(row.after_state === null || this.isSafeJsonRecord(row.after_state))
      || !this.isNullableBoundedString(row.correlation_id, 512)
      || !this.isBoundedString(row.occurrence_key, 512)
      || typeof row.success !== 'boolean'
      || !this.isNullableBoundedString(row.error_message, 4_096)
    ) {
      throw new Error('persisted audit residue row failed schema validation');
    }
    return row;
  }

  private isBoundedString(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
  }

  private isNullableBoundedString(value: unknown, maxLength: number): boolean {
    return value === null || this.isBoundedString(value, maxLength);
  }

  private isSafeJsonRecord(value: unknown): value is Record<string, unknown> {
    return this.isSafeJson(value, 0) && value !== null && !Array.isArray(value);
  }

  private isSafeJson(value: unknown, depth: number): boolean {
    if (depth > 12) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return value.length <= 65_536;
    if (Array.isArray(value)) {
      return value.length <= 1_000 && value.every((item) => this.isSafeJson(item, depth + 1));
    }
    if (typeof value !== 'object') return false;
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length <= 200
      && entries.every(([key, item]) =>
        key.length <= 256
        && key !== '__proto__'
        && key !== 'constructor'
        && key !== 'prototype'
        && this.isSafeJson(item, depth + 1))
    );
  }

  /** Keep audit buffering finite and reserve a coalesced ledger gap record. */
  private enqueue(
    entry: Record<string, unknown>,
    capacityContext: { source: string; eventType?: string; action?: string },
  ): void {
    if (this.queue.length >= AuditService.MAX_BUFFERED_ENTRIES) {
      this.recordCapacityDrop(capacityContext);
      return;
    }
    this.queue.push(entry);
  }

  private recordCapacityDrop(
    context: {
      source: string;
      eventType?: string;
      action?: string;
      actions?: string[];
    },
    count = 1,
  ): void {
    this.recordGapObservation('capacity', context, count);

    const previous = this.droppedAtCapacity;
    this.droppedAtCapacity += count;
    if (previous === 0 || Math.floor(previous / 1_000) !== Math.floor(this.droppedAtCapacity / 1_000)) {
      log.error(
        `Audit capacity exhausted at ${context.source}; dropped ${this.droppedAtCapacity} row(s) total`,
      );
    }
  }

  private recordMappingFailure(eventType: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.recordGapObservation('mapping', {
      source: 'event mapping',
      eventType,
      errors: [message.slice(0, 500)],
    });
  }

  /**
   * Coalesce observations into one finite mutable window per kind. The window
   * is detached and frozen before any database await, so concurrent arrivals
   * cannot mutate the row being inserted.
   */
  private recordGapObservation(
    kind: AuditGapKind,
    context: {
      source: string;
      eventType?: string;
      action?: string;
      actions?: string[];
      errors?: string[];
    },
    count = 1,
  ): void {
    const now = new Date().toISOString();
    const window = this.activeGapWindows.get(kind) ?? {
      kind,
      occurrenceKey: `audit.${kind === 'capacity' ? 'capacity_exhausted' : 'mapping_failed'}:${randomUUID()}`,
      count: 0,
      firstObservedAt: now,
      lastObservedAt: now,
      sources: new Set<string>(),
      eventTypes: new Set<string>(),
      actions: new Set<string>(),
      errors: new Set<string>(),
      labelsTruncated: false,
    };
    this.activeGapWindows.set(kind, window);
    window.count += count;
    window.lastObservedAt = now;

    const addLabel = (set: Set<string>, label: string | undefined) => {
      if (!label || set.has(label)) return;
      if (set.size < AuditService.MAX_CAPACITY_LABELS) set.add(label);
      else window.labelsTruncated = true;
    };
    addLabel(window.sources, context.source);
    addLabel(window.eventTypes, context.eventType);
    addLabel(window.actions, context.action);
    for (const action of context.actions ?? []) addLabel(window.actions, action);
    for (const error of context.errors ?? []) addLabel(window.errors, error);
  }

  /** Map one platform event to an audit entry and queue it (occurrence-deduped). */
  private async enqueueFromEvent(event: PlatformEvent, mapping: AuditMapping): Promise<void> {
    const data = event.data as Record<string, unknown>;

    let beforeState = mapping.beforeState?.(data) ?? null;
    if (event.type === 'config.changed' && beforeState === null) {
      beforeState = await this.configBeforeSnapshot(data);
    }

    // Occurrence identity: per-mapping extractor first, then a generic
    // emitter-supplied `occurrenceId` field any emit site may carry.
    const occurrence =
      mapping.occurrenceId?.(data) ??
      (typeof data.occurrenceId === 'string' && data.occurrenceId !== ''
        ? data.occurrenceId
        : undefined);

    const action = typeof mapping.action === 'function' ? mapping.action(data) : mapping.action;
    const actorType =
      typeof mapping.actorType === 'function' ? mapping.actorType(data) : mapping.actorType;

    const entry: Record<string, unknown> = {
      guild_id: event.guildId,
      actor_type: actorType,
      actor_id: mapping.actorId?.(data) ?? (actorType === 'system' ? 'system' : 'bot'),
      action,
      category: mapping.category,
      target_type:
        (typeof mapping.targetType === 'function' ? mapping.targetType(data) : mapping.targetType) ?? null,
      target_id: mapping.targetId?.(data) ?? null,
      details: mapping.details?.(data) ?? {},
      before_state: beforeState,
      after_state: mapping.afterState?.(data) ?? null,
      correlation_id: mapping.correlationId?.(data) ?? null,
      occurrence_key: occurrence
        ? `${action}:${occurrence}`
        : `audit.delivery:${randomUUID()}`,
      success: mapping.success ?? true,
      // Keep every queued entry's key set identical to log()'s — PostgREST
      // bulk inserts require homogeneous objects in one batch.
      error_message: null,
    };

    // In-queue occurrence dedupe: a redelivery landing before the next flush
    // (or while a failed batch sits re-queued) must not enqueue twice. The
    // uq_audit_logs_guild_occurrence index + ON CONFLICT DO NOTHING flush is
    // the durable backstop for redeliveries that arrive after a flush.
    const key = entry.occurrence_key;
    if (this.queue.some((queued) => queued.occurrence_key === key)) {
      return;
    }

    this.enqueue(entry, { source: 'buffered audit row', eventType: event.type });
  }

  /**
   * Values of the changed keys BEFORE this config change, taken from the
   * service's last-known guild_config snapshot (see field doc). Returns null
   * when nothing is known about any changed key — an honest one-sided diff
   * beats a fabricated before-state. Advances the snapshot with the change
   * so consecutive edits diff against each other.
   */
  private async configBeforeSnapshot(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const changes = data.changes;
    if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) return null;
    const changedKeys = Object.keys(changes as Record<string, unknown>);
    if (changedKeys.length === 0) return null;

    if (this.snapshotLoad) {
      await this.withMappingDeadline(this.snapshotLoad, 'initial guild_config snapshot');
    }
    if (!this.guildConfigSnapshot) {
      // The boot-time load failed (transient DB error) — retry once now.
      this.snapshotLoad = this.loadGuildConfigSnapshot();
      await this.withMappingDeadline(this.snapshotLoad, 'retry guild_config snapshot');
    }
    const snapshot = this.guildConfigSnapshot;
    if (!snapshot) return null;

    const before: Record<string, unknown> = {};
    for (const changedKey of changedKeys) {
      if (changedKey in snapshot) before[changedKey] = snapshot[changedKey] ?? null;
    }
    for (const changedKey of changedKeys) {
      snapshot[changedKey] = (changes as Record<string, unknown>)[changedKey];
    }
    return Object.keys(before).length > 0 ? before : null;
  }

  /** Load the guild_config baseline used for config.updated before-diffs. */
  private async loadGuildConfigSnapshot(): Promise<void> {
    try {
      const { data, error } = await this.supabase
        .from('guild_config')
        .select('*')
        .eq('guild_id', this.guildId)
        .maybeSingle();
      if (!error && data) {
        this.guildConfigSnapshot = data as Record<string, unknown>;
      } else if (error) {
        log.warn(`guild_config before-snapshot load failed: ${error.message}`);
      }
    } catch (err) {
      log.warn(
        `guild_config before-snapshot load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Stop the audit service.
   */
  stop(): Promise<void> {
    if (this.stopInProgress) return this.stopInProgress;
    this.acceptingEntries = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.eventHandler) {
      // PlatformEventBus now guarantees offAny(). The runtime guard preserves
      // compatibility with small test doubles while still removing the exact
      // retained production handler.
      const offAny = (this.eventBus as PlatformEventBus & {
        offAny?: (handler: (event: PlatformEvent) => void | Promise<void>) => void;
      }).offAny;
      if (typeof offAny === 'function') {
        offAny.call(this.eventBus, this.eventHandler);
      }
      this.eventHandler = null;
    }

    const operation = this.drainForStop()
      .then(() => {
        log.info('Stopped');
      })
      .catch(async (err: unknown) => {
        try {
          const persisted = await this.persistResidueForRestart();
          log.error('Audit drain failed; residue handed off for restart recovery', {
            error: err instanceof Error ? err.message : String(err),
            persistedRows: persisted,
          });
        } catch (persistErr) {
          log.error('Stop failed; audit residue remains only in memory', {
            error: err instanceof Error ? err.message : String(err),
            persistenceError:
              persistErr instanceof Error ? persistErr.message : String(persistErr),
          });
          if (!this.recoveryStore) throw err;
          throw new AggregateError(
            [err, persistErr],
            `Audit drain stalled with residue and restart persistence failed`,
          );
        }
      })
      .finally(() => {
        if (this.stopInProgress === operation) this.stopInProgress = null;
      });
    this.stopInProgress = operation;
    return operation;
  }

  private async persistResidueForRestart(): Promise<number> {
    if (!this.recoveryStore) {
      throw new Error('No audit restart-residue store is configured');
    }
    // Never overwrite an older spool we failed to read. A successful retry
    // merges those rows into this in-memory handoff before replacing the key.
    if (this.persistedResidueRestorePending) {
      await this.restorePersistedResidue();
    }
    this.freezeActiveGapWindows();

    if (this.flushOutage) {
      const outage = this.flushOutage;
      this.pendingFlushRecoveries.push(Object.freeze({
        guild_id: this.guildId,
        actor_type: 'system',
        actor_id: 'audit-service',
        action: 'audit.flush_failed',
        category: 'system',
        target_type: null,
        target_id: null,
        details: Object.freeze({
          attempts: outage.attempts,
          firstFailedAt: outage.firstFailedAt,
          persistedAt: new Date().toISOString(),
          pendingEntries: this.queue.length,
        }),
        before_state: null,
        after_state: null,
        correlation_id: null,
        occurrence_key: `audit.flush_failed:${outage.firstFailedAt}`,
        success: false,
        error_message: outage.lastError,
      }));
      this.flushOutage = null;
    }

    const rows = [
      ...this.queue,
      ...[...this.pendingGapWindows.values()].map(({ row }) => row),
      ...this.pendingFlushRecoveries,
    ];
    if (rows.length === 0) {
      await this.maybeDeletePersistedResidue();
      return 0;
    }
    await this.recoveryStore.set(this.recoveryStoreKey, JSON.stringify({
      version: AUDIT_RESIDUE_VERSION,
      guildId: this.guildId,
      rows,
    }));

    this.queue = [];
    this.activeGapWindows.clear();
    this.pendingGapWindows.clear();
    this.pendingFlushRecoveries = [];
    this.persistedResidueKeys.clear();
    this.persistedResidueCleanupPending = false;
    return rows.length;
  }

  /**
   * A stalled Supabase request must not wedge every later audit flush or
   * shutdown. Rejecting the mapping records a durable mapping-gap window via
   * the event handler's catch path; the underlying client request may settle
   * later, but no entry remains counted as pending after this deadline.
   */
  private async withMappingDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(
              `${label} exceeded ${AuditService.MAPPING_WAIT_TIMEOUT_MS}ms audit mapping deadline`,
            ));
          }, AuditService.MAPPING_WAIT_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Wait for an already-active write, then keep taking serialized trailing
   * passes until all accepted mappings, rows, and immutable gap windows land.
   * A permanently unavailable database cannot hang shutdown forever: after a
   * small number of no-progress retries, the finite in-memory residue is
   * surfaced loudly and left intact rather than silently discarded.
   */
  private async drainForStop(): Promise<void> {
    await this.flush();

    let stalledPasses = 0;
    while (this.hasPendingAuditWork()) {
      const progressed = await this.flush();
      if (!this.hasPendingAuditWork()) return;
      stalledPasses = progressed ? 0 : stalledPasses + 1;
      if (stalledPasses >= AuditService.MAX_STOP_DRAIN_STALLS) {
        const residue = {
          queuedRows: this.queue.length,
          pendingEnqueues: this.pendingEnqueues.size,
          activeGapWindows: this.activeGapWindows.size,
          frozenGapWindows: this.pendingGapWindows.size,
          activeFlushOutage: this.flushOutage !== null,
          pendingFlushRecoveryRows: this.pendingFlushRecoveries.length,
        };
        log.error('Audit shutdown drain stalled with finite work still pending', residue);
        throw new Error(
          `Audit shutdown drain stalled with residue ${JSON.stringify(residue)}`,
        );
      }
    }
  }

  private hasPendingAuditWork(): boolean {
    return (
      this.queue.length > 0
      || this.pendingEnqueues.size > 0
      || this.activeGapWindows.size > 0
      || this.pendingGapWindows.size > 0
      || this.flushOutage !== null
      || this.pendingFlushRecoveries.length > 0
      || this.persistedResidueCleanupPending
      || this.persistedResidueRestorePending
    );
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
    /** Stable occurrence identity — dedupes re-logged/re-flushed entries. */
    occurrenceKey?: string;
    success?: boolean;
    errorMessage?: string;
  }): Promise<void> {
    if (!this.acceptingEntries) {
      log.warn(`Ignored audit log after shutdown began: ${entry.action}`);
      return;
    }
    this.enqueue({
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
      occurrence_key: entry.occurrenceKey ?? `audit.delivery:${randomUUID()}`,
      success: entry.success ?? true,
      error_message: entry.errorMessage ?? null,
    }, { source: 'manual audit log', action: entry.action });
  }

  /**
   * Flush buffered entries to Supabase.
   *
   * Exactly-once across redeliveries, retried flushes, and restarts: the
   * batch is written with ON CONFLICT (guild_id, occurrence_key) DO NOTHING
   * against the uq_audit_logs_guild_occurrence unique index, so an
   * entry that already landed (a prior flush that errored after commit, a
   * redelivered stable platform occurrence, a restart re-flush) is silently
   * skipped instead of duplicating the row. Semantically keyless entries use
   * a fresh immutable delivery key per accepted entry, so distinct events
   * remain append-only while retries of the same queued row are idempotent.
   */
  private flush(): Promise<boolean> {
    if (this.flushInProgress) return this.flushInProgress;
    const operation = this.flushBatch().finally(() => {
      if (this.flushInProgress === operation) this.flushInProgress = null;
    });
    this.flushInProgress = operation;
    return operation;
  }

  private async flushBatch(): Promise<boolean> {
    // Never outrun an entry still being resolved (config before-snapshot).
    if (this.pendingEnqueues.size > 0) {
      await Promise.all([...this.pendingEnqueues]);
    }
    if (this.persistedResidueRestorePending) {
      try {
        await this.restorePersistedResidue();
      } catch (err) {
        this.recordMappingFailure('persisted.audit.residue', err);
        return false;
      }
    }
    if (this.queue.length === 0) {
      let progressed = await this.flushGapWindows();
      progressed = await this.flushPendingRecoveries() || progressed;
      progressed = await this.maybeDeletePersistedResidue() || progressed;
      return progressed;
    }

    const batch = this.queue.splice(0, this.queue.length);
    let writeError: string | null = null;
    try {
      const { error } = await this.supabase
        .from('audit_logs')
        .upsert(batch, { onConflict: 'guild_id,occurrence_key', ignoreDuplicates: true });
      writeError = error?.message ?? null;
    } catch (err) {
      writeError = err instanceof Error ? err.message : String(err);
    }

    if (writeError) {
      log.error(`Failed to flush ${batch.length} entries:`, writeError);
      // Remember the outage window so it can be recorded once the ledger is
      // writable again — a batch that silently retried would leave the gap
      // invisible in the very trail that is supposed to explain it.
      this.flushOutage = {
        attempts: (this.flushOutage?.attempts ?? 0) + 1,
        firstFailedAt: this.flushOutage?.firstFailedAt ?? new Date().toISOString(),
        lastError: writeError,
      };
      // Keep the oldest failed rows first while retaining a hard memory bound.
      this.queue.unshift(...batch);
      if (this.queue.length > AuditService.MAX_BUFFERED_ENTRIES) {
        const overflowEntries = this.queue.splice(AuditService.MAX_BUFFERED_ENTRIES);
        this.recordCapacityDrop(
          {
            source: 'failed flush requeue',
            actions: overflowEntries
              .map((entry) => entry.action)
              .filter((action): action is string => typeof action === 'string'),
          },
          overflowEntries.length,
        );
      }
      return false;
    }

    await this.acknowledgePersistedRows(batch);

    // The batch landed. If earlier attempts failed, the ledger is writable
    // again — record the outage window exactly once, keyed on its start so a
    // retry/restart cannot duplicate it.
    if (this.flushOutage) {
      const outage = this.flushOutage;
      this.flushOutage = null;
      const guildId =
        (batch.find((entry) => typeof entry.guild_id === 'string')?.guild_id as
          | string
          | undefined)
        ?? this.guildId;
      this.pendingFlushRecoveries.push(Object.freeze({
        guild_id: guildId,
        actor_type: 'system',
        actor_id: 'audit-service',
        action: 'audit.flush_failed',
        category: 'system',
        target_type: null,
        target_id: null,
        success: false,
        error_message: outage.lastError,
        before_state: null,
        after_state: null,
        correlation_id: null,
        occurrence_key: `audit.flush_failed:${outage.firstFailedAt}`,
        details: Object.freeze({
          attempts: outage.attempts,
          firstFailedAt: outage.firstFailedAt,
          recoveredAt: new Date().toISOString(),
          recoveredEntries: batch.length,
        }),
      }));
    }
    await this.flushGapWindows();
    await this.flushPendingRecoveries();
    return true;
  }

  /**
   * Detach each active window into an immutable row, then INSERT it with
   * ON CONFLICT DO NOTHING. `service_role` deliberately has no UPDATE grant on
   * audit_logs, so a normal merge-upsert is both semantically wrong and unable
   * to persist in production.
   */
  private async flushGapWindows(): Promise<boolean> {
    this.freezeActiveGapWindows();
    let progressed = false;

    for (const kind of ['capacity', 'mapping'] as const) {
      const frozen = this.pendingGapWindows.get(kind);
      if (!frozen) continue;
      try {
        const { error } = await this.supabase.from('audit_logs').upsert(
          [frozen.row],
          { onConflict: 'guild_id,occurrence_key', ignoreDuplicates: true },
        );
        if (error) {
          log.warn(`Could not record ${String(frozen.row.action)}:`, error.message);
          continue;
        }
        if (this.pendingGapWindows.get(kind) === frozen) {
          this.pendingGapWindows.delete(kind);
          await this.acknowledgePersistedRows([frozen.row]);
          progressed = true;
        }
      } catch (err) {
        log.warn(
          `Could not record ${String(frozen.row.action)}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return progressed;
  }

  private freezeActiveGapWindows(): void {
    for (const kind of ['capacity', 'mapping'] as const) {
      if (this.pendingGapWindows.has(kind)) continue;
      const active = this.activeGapWindows.get(kind);
      if (!active) continue;

      // Delete before constructing/handing off the row. Any observation that
      // arrives from this point onward necessarily creates a new window/key.
      this.activeGapWindows.delete(kind);
      const action =
        kind === 'capacity' ? 'audit.capacity_exhausted' : 'audit.mapping_failed';
      const details = kind === 'capacity'
        ? {
            count: active.count,
            firstDroppedAt: active.firstObservedAt,
            lastDroppedAt: active.lastObservedAt,
            sources: Object.freeze([...active.sources].sort()),
            eventTypes: Object.freeze([...active.eventTypes].sort()),
            actions: Object.freeze([...active.actions].sort()),
            labelsTruncated: active.labelsTruncated,
            recoveredAt: new Date().toISOString(),
            bufferedEntryLimit: AuditService.MAX_BUFFERED_ENTRIES,
            pendingEnqueueLimit: AuditService.MAX_PENDING_ENQUEUES,
          }
        : {
            count: active.count,
            firstFailedAt: active.firstObservedAt,
            lastFailedAt: active.lastObservedAt,
            sources: Object.freeze([...active.sources].sort()),
            eventTypes: Object.freeze([...active.eventTypes].sort()),
            actions: Object.freeze([...active.actions].sort()),
            errors: Object.freeze([...active.errors].sort()),
            labelsTruncated: active.labelsTruncated,
            recoveredAt: new Date().toISOString(),
          };
      const row = Object.freeze({
        guild_id: this.guildId,
        actor_type: 'system',
        actor_id: 'audit-service',
        action,
        category: 'system',
        target_type: kind === 'capacity' ? 'audit_buffer' : 'platform_event',
        target_id: this.guildId,
        details: Object.freeze(details),
        before_state: null,
        after_state: null,
        correlation_id: null,
        occurrence_key: active.occurrenceKey,
        success: false,
        error_message: kind === 'capacity'
          ? 'Detailed audit rows were dropped at the finite buffer limit'
          : 'A platform event could not be mapped into an audit row',
      });
      this.pendingGapWindows.set(kind, {
        kind,
        occurrenceKey: active.occurrenceKey,
        row,
      });
    }
  }

  /**
   * Retry each already-frozen `audit.flush_failed` row byte-for-byte. A failed
   * or ambiguous append may already have committed, so ON CONFLICT DO NOTHING
   * is the only safe acknowledgement path.
   */
  private async flushPendingRecoveries(): Promise<boolean> {
    let progressed = false;
    for (const row of [...this.pendingFlushRecoveries]) {
      let writeError: string | null = null;
      try {
        const { error } = await this.supabase.from('audit_logs').upsert(
          [row],
          { onConflict: 'guild_id,occurrence_key', ignoreDuplicates: true },
        );
        writeError = error?.message ?? null;
      } catch (err) {
        writeError = err instanceof Error ? err.message : String(err);
      }

      if (writeError) {
        log.warn('Could not record audit.flush_failed:', writeError);
        continue;
      }

      const index = this.pendingFlushRecoveries.indexOf(row);
      if (index >= 0) this.pendingFlushRecoveries.splice(index, 1);
      await this.acknowledgePersistedRows([row]);
      progressed = true;
    }
    return progressed;
  }

  private async acknowledgePersistedRows(
    rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  ): Promise<void> {
    if (this.persistedResidueKeys.size === 0) return;
    for (const row of rows) {
      if (typeof row.occurrence_key === 'string') {
        this.persistedResidueKeys.delete(row.occurrence_key);
      }
    }
    if (this.persistedResidueKeys.size === 0) {
      this.persistedResidueCleanupPending = true;
      await this.maybeDeletePersistedResidue();
    }
  }

  private async maybeDeletePersistedResidue(): Promise<boolean> {
    if (!this.persistedResidueCleanupPending || !this.recoveryStore) return false;
    try {
      await this.recoveryStore.del(this.recoveryStoreKey);
      this.persistedResidueCleanupPending = false;
      return true;
    } catch (err) {
      log.warn('Could not clear acknowledged audit shutdown residue:', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
