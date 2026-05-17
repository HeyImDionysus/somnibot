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
  discordId: string;
  productId: string;
  planId: string;
  status: 'activated' | 'lapsed' | 'cancelled' | 'renewed';
}

export interface TicketEventData {
  ticketId: string;
  ticketNumber: number;
  channelId: string;
  userDiscordId: string;
  panelId: string;
}

export interface InfractionCreatedData {
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
  'subscription.changed': SubscriptionChangedData;
  'ticket.opened': TicketEventData;
  'ticket.claimed': TicketEventData;
  'ticket.closed': TicketEventData;
  'ticket.reopened': TicketEventData;
  'infraction.created': InfractionCreatedData;
  'member.muted': MemberMutedData;
  'member.kicked': MemberKickedData;
  'member.banned': MemberBannedData;
  'giveaway.ended': GiveawayEndedData;
  'button.clicked': ButtonClickedData;
  'reaction.added': ReactionAddedData;
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
}

export type PlatformEventType = keyof PlatformEventMap;
