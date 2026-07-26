/**
 * Platform Event Bus types.
 * Events emitted by features for cross-feature communication.
 * Dashboard writes → Supabase → Bot receives via Realtime.
 */

export interface PlatformEvent<T extends string = string, D = unknown> {
  type: T;
  guildId: string;
  timestamp: number;
  data: D;
  /** Stable identity for one real source occurrence across retries and restarts. */
  occurrenceId?: string;
  /** Automation chain depth — tracks how many automations deep this event is. */
  _chainDepth?: number;
}

// ============================================================
// Event Data Types
// ============================================================

export interface MemberJoinedData {
  discordId: string;
  username: string;
  isReturning: boolean;
}

export interface MemberLeftData {
  discordId: string;
  username: string;
  roles: string[];
}

export interface MemberVerifiedData {
  discordId: string;
  username: string;
  memberNumber: number;
}

export interface RoleChangedData {
  discordId: string;
  roleId: string;
  roleName: string;
  source: 'bot' | 'dashboard' | 'discord' | 'commerce' | 'levels';
}

export interface LevelUpData {
  discordId: string;
  previousLevel: number;
  newLevel: number;
  totalXp: number;
}

export interface PurchaseCompletedData {
  discordId: string;
  orderId: string;
  orderNumber: string;
  productId: string;
  productName: string;
  amount: number;
  currency: string;
}

export interface SubscriptionChangedData {
  /** Durable commerce lifecycle action/order identity for this transition. */
  lifecycleId: string;
  discordId: string;
  productId: string;
  planId: string;
  status: 'activated' | 'lapsed' | 'cancelled' | 'renewed' | 'expired';
}

export interface TicketEventData {
  ticketId: string;
  ticketNumber: number;
  channelId: string;
  /** The ticket CREATOR — automations' `{user}` context (e.g. DM-on-close). */
  userDiscordId: string;
  /**
   * The ACTING user (closer/reopener) when different from the creator. Audit
   * reads this for actor_id so a manager closing another member's ticket is
   * audited as themselves, while `{user}` automations keep the creator.
   */
  actorId?: string;
  panelId: string;
}

export interface TicketDeniedData {
  ticketId: string;
  ticketNumber: number;
  /** The member who attempted the lifecycle action without manager authority. */
  actorDiscordId: string;
  reason: 'permission-denied';
}

export interface InfractionCreatedData {
  infractionId: string;
  userId: string;
  moderatorId: string;
  type: 'warn' | 'mute' | 'kick' | 'ban';
  reason: string | null;
  totalInfractions: number;
  autoModRuleId?: string;
}

export interface MemberMutedData {
  discordId: string;
  moderatorId: string;
  reason: string;
  durationMinutes: number;
}

export interface MemberKickedData {
  discordId: string;
  moderatorId: string;
  reason: string;
}

export interface MemberBannedData {
  discordId: string;
  moderatorId: string;
  reason: string;
}

export interface GiveawayEndedData {
  giveawayId: string;
  title: string;
  winnerIds: string[];
  prizeProductId: string | null;
}

export interface MessageSentData {
  discordId: string;
  username: string;
  channelId: string;
  messageId: string;
  content: string;
}

export interface ReactionAddedData {
  discordId: string;
  username: string;
  emoji: string;
  emojiId: string | null;
  channelId: string;
  messageId: string;
}

export interface VoiceJoinedData {
  discordId: string;
  username: string;
  channelId: string;
  channelName: string;
}

export interface VoiceLeftData {
  discordId: string;
  username: string;
  channelId: string;
  channelName: string;
}

export interface ButtonClickedData {
  interactionId: string;
  discordId: string;
  username: string;
  buttonId: string;
  channelId: string;
  messageId: string;
}

export interface TrackStartedData {
  title: string;
  author: string;
  uri: string;
  duration: number;
  requestedBy: string;
}

export interface TrackEndedData {
  title: string;
  author: string;
  uri: string;
  reason: 'finished' | 'skipped' | 'stopped' | 'error';
}

export interface QueueEndedData {
  totalTracksPlayed: number;
}

export interface ConfigChangedData {
  section: string;
  changes: Record<string, unknown>;
  changedBy: string;
  /**
   * Values of the changed keys BEFORE the change was applied — the audit
   * row's before_state. Emitters that know the prior values (e.g. the
   * dashboard write APIs via the config_reload payload) should carry them;
   * when absent the AuditService falls back to its own last-known
   * guild_config snapshot for the changed keys.
   */
  before?: Record<string, unknown>;
  /** Where the change originated (e.g. 'dashboard'); recorded in the audit details. */
  source?: string;
  /**
   * Stable per-change identity (e.g. the bot_action_queue row id) used as the
   * audit occurrence key so a redelivered config_reload cannot double-write
   * the config.updated audit row.
   */
  occurrenceId?: string;
}

export interface ServerDeployedData {
  deployId: string;
  rolesCreated: number;
  channelsCreated: number;
  categoriesCreated: number;
  overridesApplied: number;
  duration: number;
}

export interface DriftDetectedData {
  driftCount: number;
  criticalCount: number;
  autoRepaired: boolean;
  items: { type: string; entityName: string; severity: string }[];
}

export interface DeployActionData {
  action: 'create' | 'update' | 'delete';
  entityType: 'role' | 'channel' | 'category' | 'override' | 'everyone';
  entityName: string;
  discordId?: string;
  success: boolean;
  error?: string;
}

export interface SyncCompletedData {
  driftItemsFound: number;
  itemsRepaired: number;
  itemsAccepted: number;
  duration: number;
}

export interface DeployRequestedData {
  roleCount: number;
  channelCount: number;
  categoryCount: number;
  cleanExisting: boolean;
}

export interface DeployFailedData {
  deployId: string;
  error: string;
  duration: number;
}

// ============================================================
// Event Type Map
// ============================================================

export interface EntitlementGrantedData {
  discordId: string;
  entitlementId: string;
  productId: string;
  productName: string;
  roleIds: string[];
}

export interface EntitlementRevokedData {
  discordId: string;
  entitlementId: string;
  productId: string;
  productName: string;
  reason: 'expired' | 'cancelled' | 'suspended' | 'revoked' | 'refund';
}


// ── Automation & Webhook Audit Events ──────────────────────
// Required by AuditService EVENT_TO_AUDIT mappings (Finding #4).

export interface AutomationExecutedData {
  automationId: string;
  automationName: string;
  trigger: string;
  actionsExecuted: number;
  actionsFailed: number;
  success: boolean;
  duration: number;
  executionId?: string;
}

export interface AutomationCreatedData {
  automationId: string;
  automationName: string;
  trigger: string;
  createdBy: string;
  enabled: boolean;
  actionCount: number;
}

export interface AutomationUpdatedData {
  automationId: string;
  automationName: string;
  updatedBy: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export interface AutomationDeletedData {
  automationId: string;
  automationName: string;
  deletedBy: string;
}

export interface WebhookReceivedData {
  eventId: string;
  eventType: string;
  provider: string;
  result: string;
}

export interface WebhookReplayedData {
  eventId: string;
  eventType: string;
  replayedBy: string;
  replayCount: number;
}

// ── Owner Notification Event Types ─────────────────────────
// These events power the OwnerNotificationService (DMs to guild owner).

export interface ModerationActionData {
  action: 'warn' | 'mute' | 'kick' | 'ban';
  discordId: string;
  moderatorId: string;
  reason: string | null;
  infractionId?: string;
  durationMinutes?: number;
}

export interface FraudDetectedData {
  signal: string;
  severity: string;
  orderId?: string;
  discordId?: string;
  action?: string;
  evidence?: Record<string, unknown>;
}

export interface IncidentCreatedData {
  incidentId: string;
  incidentNumber: number;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category?: string;
  source: string;
}

export interface PaymentFailedData {
  discordId: string;
  orderId: string;
  productName: string;
  amount: number;
  currency: string;
  error?: string;
}

export interface SyncReportData {
  report: string;
  repairedCount: number;
  needsAttentionCount: number;
  totalDrift: number;
  timestamp: string;
}

export interface PlatformEventMap {
  'member.joined': MemberJoinedData;
  'member.left': MemberLeftData;
  'member.verified': MemberVerifiedData;
  'message.sent': MessageSentData;
  'role.gained': RoleChangedData;
  'role.lost': RoleChangedData;
  'level.up': LevelUpData;
  'purchase.completed': PurchaseCompletedData;
  'subscription.activated': SubscriptionChangedData;
  'subscription.lapsed': SubscriptionChangedData;
  'subscription.expired': SubscriptionChangedData;
  'subscription.changed': SubscriptionChangedData;
  'entitlement.granted': EntitlementGrantedData;
  'entitlement.revoked': EntitlementRevokedData;
  'ticket.opened': TicketEventData;
  'ticket.claimed': TicketEventData;
  'ticket.closed': TicketEventData;
  'ticket.reopened': TicketEventData;
  'ticket.denied': TicketDeniedData;
  'infraction.created': InfractionCreatedData;
  'member.muted': MemberMutedData;
  'member.kicked': MemberKickedData;
  'member.banned': MemberBannedData;
  'giveaway.ended': GiveawayEndedData;
  'button.clicked': ButtonClickedData;
  'reaction.added': ReactionAddedData;
  /** Internal state observation used to distinguish a later real re-add. */
  'reaction.removed': ReactionAddedData;
  'voice.joined': VoiceJoinedData;
  'voice.left': VoiceLeftData;
  'track.started': TrackStartedData;
  'track.ended': TrackEndedData;
  'queue.ended': QueueEndedData;
  'config.changed': ConfigChangedData;
  'server.deployed': ServerDeployedData;
  'deploy.requested': DeployRequestedData;
  'deploy.action': DeployActionData;
  'deploy.failed': DeployFailedData;
  'drift.detected': DriftDetectedData;
  'sync.completed': SyncCompletedData;
  'sync.report': SyncReportData;
  'moderation.action': ModerationActionData;
  'fraud.detected': FraudDetectedData;
  'incident.created': IncidentCreatedData;
  'payment.failed': PaymentFailedData;
  'automation.executed': AutomationExecutedData;
  'automation.created': AutomationCreatedData;
  'automation.updated': AutomationUpdatedData;
  'automation.deleted': AutomationDeletedData;
  'webhook.received': WebhookReceivedData;
  'webhook.replayed': WebhookReplayedData;
  // ── Observability audit wave (2026-07-23): per-feature audit events ──
  'anti_raid.detected': { joinCount: number; threshold: number; windowSeconds: number; action: string };
  'anti_raid.contained': { action: 'kick' | 'ban' | 'lockdown' | 'account_age'; userId?: string; username?: string; reason: string; invitesPaused?: number };
  'anti_raid.restored': { restorationType: 'unban' | 'invites' | 'verification'; count: number };
  'anti_raid.action_failed': { action: string; userId?: string; error: string };
  'infraction.pardoned': { infractionId: string; userId: string; moderatorId: string; reason: string };
  'message_log.config_updated': { changedBy: string; before: Record<string, unknown>; after: Record<string, unknown>; changes: Record<string, unknown> };
  'message_log.degraded': { error: string; reason: string };
  'ticket.create_failed': { userDiscordId: string; panelId: string; ticketNumber?: number; stage: string; error: string };
  'ticket.transcript_failed': { ticketId: string; ticketNumber: number; error: string };
  'custom_command.denied': { commandId: string; commandName: string; userId: string; channelId: string; reason: 'missing_allowed_role' | 'denied_role' | 'channel_not_allowed' | 'channel_denied' };
  'custom_command.invoked': { commandId: string; commandName: string; userId: string; channelId: string; actionCount: number };
  'diagnostics.alert_raised': { alertType: string; severity: 'info' | 'warning' | 'critical'; title: string; message: string };
  'diagnostics.alert_resolved': { alertType: string };
  'diagnostics.snapshot_failed': { stage: 'write' | 'collect'; error: string };
  'sync.failed': { error: string; stage: string };
  'quest.claimed': { userId: string; questCount: number; currency: number; xp: number };
  'quest.claim_failed': { userId: string; questCount: number; currency: number; reason: string };
  'quest.slate_assigned': { userId: string; questType: 'daily' | 'weekly'; count: number };
  'quest.completed': { userId: string; questId: string; actionType: string; progress: number };
  'casino.bet_settled': { userId: string; game: string; net: number; loss: number };
  'achievement.unlocked': { userId: string; achievementId: string; name: string; rewardCurrency: number; rewardXp: number };
  'prestige.performed': { userId: string; newLevel: number; newMultiplier: number };
  'adventure.started': { userId: string; adventureId: string; adventureName: string; ticketCost: number; sessionId: string | null };
  'adventure.completed': { userId: string; sessionId: string; status: string; currency: number; lootCount: number };
  'adventure.payout_failed': { userId: string; sessionId: string; amount: number };
  'craft.completed': { userId: string; recipeName: string; outputQty: number };
  'craft.failed': { userId: string; recipeName: string; reason: string };
  'market.listed': { sellerId: string; listingId: string; itemName: string; quantity: number; pricePerUnit: number };
  'market.bought': { buyerId: string; sellerId: string; listingId: string; itemName: string; quantity: number; totalCost: number; fee: number };
  'market.cancelled': { sellerId: string; listingId: string; itemName: string; quantity: number };
  'farm.harvested': { userId: string; cropCount: number; earnings: number };
  'farm.payout_failed': { userId: string; amount: number; cropCount: number };
  'gather.completed': { userId: string; sourceType: string; itemName: string; quantity: number; value: number };
  'gather.payout_failed': { userId: string; sourceType: string; amount: number };
  'fishing.catch': { userId: string; species: string; rarity: string; price: number; paid: boolean };
  'fishing.payout_failed': { userId: string; species: string; amount: number };
  'heist.started': { heistId: string; userId: string; targetName: string; basePayout: number; entryFee: number };
  'heist.joined': { heistId: string; userId: string; memberCount: number; role: string };
  'heist.resolved': { heistId: string; outcome: 'success' | 'failed' | 'cancelled'; participantCount: number; payoutEach: number };
  'heist.settlement_failed': { heistId: string; attempts: number };
  'lottery.ticket_purchased': { userId: string; count: number; totalCost: number; jackpot: number };
  'lottery.drawn': { drawingId: string; winnerId: string; jackpot: number; winningNumber: number };
  'lottery.payout_failed': { drawingId: string; reason: string };
  'pet.acquired': { userId: string; petType: string; price: number };
  'pet.battle_resolved': { challengerId: string; defenderId: string; winnerId: string; reward: number; payoutFailed: boolean };
  'pet.battle_payout_failed': { winnerId: string; reward: number };
  'pet.prestiged': { userId: string; newPrestige: number };
  'trivia.completed': { channelId: string; answers: number; winners: number; paidWinners: number; totalPayout: number };
  'trivia.payout_failed': { userId: string; amount: number };
  'economy.reward_claimed': { userId: string; rewardType: string; amount: number; streak: number };
  'economy.reward_failed': { userId: string; rewardType: string; amount: number };
  'music.skipped': { userId?: string; method: 'dj_force' | 'vote' | 'self' | 'priority'; title: string; author: string; requestedBy: string; queueEnded: boolean };
  'music.stopped': { userId?: string; reason: 'command' | 'auto_leave' | 'inactivity' | 'connection_lost'; trackCount: number };
  'music.denied': { userId: string; action: string };
  'music.capacity_rejected': { userId: string; reason: 'queue_full' | 'user_limit'; limit: number };
  'music.store_outage': { userId: string; operation: string; error: string };
  'giveaway.started': { giveawayId: string; prize: string; winnerCount: number; channelId: string; creatorId: string; endsAt: string; requiredRoleId: string | null; requiredLevel: number | null };
  'giveaway.entered': { giveawayId: string; userId: string; withdrawn: boolean; entryCount: number };
  'giveaway.paused': { giveawayId: string; prize: string; actorId: string | null };
  'giveaway.resumed': { giveawayId: string; prize: string; actorId: string | null; endsAt: string };
  'giveaway.rerolled': { giveawayId: string; prize: string; winnerIds: string[]; actorId: string | null };
  'giveaway.failed': { giveawayId: string | null; stage: 'create' | 'entry' | 'reroll'; actorId: string | null; error: string };
  /**
   * Entry attempts are hot (button clicks) — audited via the batched event
   * rail only. Reasons are only the branches that actually emit: the gates
   * (role/level), a click on an ended/paused giveaway, and a missing member
   * record. Re-clicking while already entered is a WITHDRAWAL, not a denial.
   */
  'giveaway.entry_denied': { giveawayId: string; userId: string; reason: 'role_gate' | 'level_gate' | 'not_active' | 'member_not_found'; requiredRoleId?: string | null; requiredLevel?: number | null; userLevel?: number };
  'xp.admin_adjusted': { actorId: string; targetId: string; operation: 'add' | 'remove' | 'set' | 'reset'; amount: number; newXp: number; newLevel: number };
  'profile.updated': { userId: string; field: 'title' | 'bio'; value: string; truncated: boolean };
  'starboard.post_created': { sourceMessageId: string; sourceChannelId: string; starboardMessageId: string; authorId: string; starCount: number };
  'stats_channel.updated': { statChannelId: string; channelId: string; statType: string; value: string; created: boolean };
  'temp_channel.created': { channelId: string; textChannelId: string | null; hubId: string; hubChannelId: string; ownerId: string };
  'temp_channel.claimed': { channelId: string; previousOwnerId: string; newOwnerId: string };
  'temp_channel.deleted': { channelId: string; ownerId: string; reason: string };
  'temp_channel.creation_failed': { hubId: string; hubChannelId: string; memberId: string; error: string };
  'temp_channel.orphan_reconciled': { channelId: string; ownerId: string };
  /** One event for the whole /voice owner-control surface (lock/unlock/limit/name/permit/deny/ban/claim). */
  'temp_channel.settings_changed': { channelId: string; actorId: string; op: 'lock' | 'unlock' | 'limit' | 'name' | 'permit' | 'deny' | 'ban' | 'claim'; targetUserId?: string; value?: string | number; before?: Record<string, unknown>; after?: Record<string, unknown> };
  'scheduled_message.sent': { scheduleId: string; name: string; channelId: string; currentSends: number };
  'scheduled_message.delivery_failed': { scheduleId: string; name: string; channelId: string; reason: string };
  'poll.created': { pollId: string; title: string; optionCount: number; allowMultiple: boolean; creatorId: string; channelId: string };
  'poll.closed': { pollId: string; title: string; actorId: string };
  'prediction.created': { predictionId: string; title: string; optionCount: number; creatorId: string; channelId: string };
  'prediction.bet_placed': { predictionId: string; userId: string; optionId: string; amount: number; newPool: number };
  'prediction.resolved': { predictionId: string; title: string; winningOptionId: string; totalPool: number; payoutCount: number; refundedCount: number; actorId: string; redrive?: boolean };
}

export type PlatformEventType = keyof PlatformEventMap;

/**
 * Event types that a dashboard-owned config-reload row may ask the bot to
 * publish. This deliberately excludes automation triggers and every other
 * internal platform event.
 */
export const CONFIG_RELOAD_AUDIT_EVENT_TYPES = [
  'automation.created',
  'automation.updated',
  'automation.deleted',
] as const satisfies readonly PlatformEventType[];

export type ConfigReloadAuditEventType = (typeof CONFIG_RELOAD_AUDIT_EVENT_TYPES)[number];
export type ConfigReloadAuditEvent = {
  [T in ConfigReloadAuditEventType]: { type: T; data: PlatformEventMap[T] };
}[ConfigReloadAuditEventType];

/**
 * Complete allowlist for the action-queue platform-event bridge. The first
 * five entries are audit events. `subscription.expired` is the one existing
 * lifecycle event produced durably by the PayPal webhook worker.
 */
export const ACTION_QUEUE_PLATFORM_EVENT_TYPES = [
  ...CONFIG_RELOAD_AUDIT_EVENT_TYPES,
  'webhook.received',
  'webhook.replayed',
  'subscription.expired',
] as const satisfies readonly PlatformEventType[];

export type ActionQueuePlatformEventType = (typeof ACTION_QUEUE_PLATFORM_EVENT_TYPES)[number];
export type ActionQueuePlatformEvent = {
  [T in ActionQueuePlatformEventType]: { type: T; data: PlatformEventMap[T] };
}[ActionQueuePlatformEventType];

const CONFIG_RELOAD_AUDIT_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  CONFIG_RELOAD_AUDIT_EVENT_TYPES,
);
const ACTION_QUEUE_PLATFORM_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  ACTION_QUEUE_PLATFORM_EVENT_TYPES,
);

export function isConfigReloadAuditEventType(
  value: unknown,
): value is ConfigReloadAuditEventType {
  return typeof value === 'string' && CONFIG_RELOAD_AUDIT_EVENT_TYPE_SET.has(value);
}

export function isActionQueuePlatformEventType(
  value: unknown,
): value is ActionQueuePlatformEventType {
  return typeof value === 'string' && ACTION_QUEUE_PLATFORM_EVENT_TYPE_SET.has(value);
}
