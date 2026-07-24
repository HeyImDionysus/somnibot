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
  userDiscordId: string;
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
