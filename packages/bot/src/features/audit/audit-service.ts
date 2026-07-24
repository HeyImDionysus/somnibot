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
  'music.skipped': {
    action: 'music.skipped',
    category: 'music',
    targetType: 'track',
    actorType: 'user',
    targetId: (d) => d.requestedBy as string,
    details: (d) => ({ userId: d.userId, method: d.method, title: d.title, author: d.author, requester: d.requestedBy, queueEnded: d.queueEnded }),
  },
  'music.stopped': {
    action: 'music.stopped',
    category: 'music',
    targetType: 'music_session',
    actorType: 'user',
    details: (d) => ({ userId: d.userId, reason: d.reason, trackCount: d.trackCount }),
  },
  'music.denied': {
    action: 'music.denied',
    category: 'music',
    targetType: 'music_control',
    actorType: 'user',
    targetId: (d) => d.action as string,
    details: (d) => ({ userId: d.userId, action: d.action }),
    success: false,
  },
  'music.capacity_rejected': {
    action: 'music.capacity_rejected',
    category: 'music',
    targetType: 'music_queue',
    actorType: 'user',
    targetId: (d) => d.userId as string,
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
    details: (d) => ({ title: d.title, winningOptionId: d.winningOptionId, totalPool: d.totalPool, payoutCount: d.payoutCount, refundedCount: d.refundedCount }),
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
