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
}

export interface GiveawayEndedData {
  giveawayId: string;
  title: string;
  winnerIds: string[];
  prizeProductId: string | null;
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

// ============================================================
// Event Type Map
// ============================================================

export interface PlatformEventMap {
  'member.joined': MemberJoinedData;
  'member.left': MemberLeftData;
  'member.verified': MemberVerifiedData;
  'role.gained': RoleChangedData;
  'role.lost': RoleChangedData;
  'level.up': LevelUpData;
  'purchase.completed': PurchaseCompletedData;
  'subscription.changed': SubscriptionChangedData;
  'ticket.opened': TicketEventData;
  'ticket.closed': TicketEventData;
  'infraction.created': InfractionCreatedData;
  'giveaway.ended': GiveawayEndedData;
  'config.changed': ConfigChangedData;
  'server.deployed': ServerDeployedData;
  'deploy.action': DeployActionData;
  'drift.detected': DriftDetectedData;
  'sync.completed': SyncCompletedData;
}

export type PlatformEventType = keyof PlatformEventMap;
