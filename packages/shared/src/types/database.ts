/**
 * Database row types mirroring the Supabase schema.
 * These are the source of truth shared between bot and dashboard.
 */

// ============================================================
// Core
// ============================================================

export interface DbUser {
  id: string; // UUID (Supabase auth user)
  discord_id: string;
  discord_username: string;
  discord_avatar: string | null;
  email: string | null;
  is_owner: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbGuild {
  id: string; // Discord guild ID (snowflake)
  name: string;
  icon: string | null;
  owner_discord_id: string;
  bot_role_id: string | null;    // Discord snowflake of the bot's managed role
  bot_role_position: number | null; // Position in role hierarchy
  setup_completed: boolean;
  setup_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbGuildConfig {
  guild_id: string;
  // Onboarding
  member_role_id: string | null;
  onboarding_enabled: boolean;
  interest_role_mapping: Record<string, string>; // Discord onboarding option → role ID
  returning_member_skip_welcome_dm: boolean;
  returning_member_restore_entitlements: boolean;
  returning_member_restore_levels: boolean;
  // Welcome
  welcome_enabled: boolean;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  welcome_card_enabled: boolean;
  welcome_card_background: string | null;
  welcome_dm_enabled: boolean;
  welcome_dm_message: string | null;
  welcome_auto_roles: string[];
  // Goodbye
  goodbye_enabled: boolean;
  goodbye_channel_id: string | null;
  goodbye_message: string | null;
  // Moderation
  mod_log_channel_id: string | null;
  escalation_chain: unknown[];
  infraction_expiry_days: number;
  // Levels
  levels_enabled: boolean;
  level_up_channel_id: string | null;
  level_up_message: string | null;
  min_xp: number;
  max_xp: number;
  xp_cooldown_seconds: number;
  voice_xp_enabled: boolean;
  voice_xp_per_interval: number;
  voice_xp_interval_minutes: number;
  // Music
  default_volume: number;
  max_queue_length: number;
  allow_duplicates: boolean;
  dj_role_id: string | null;
  // Commerce
  store_enabled: boolean;
  store_channel_id: string | null;
  purchase_log_channel_id: string | null;
  // Sync
  sync_enabled: boolean;
  sync_interval_minutes: number;
  sync_auto_repair: boolean;
  sync_auto_repair_everyone: boolean;
  // Audit
  audit_log_channel_id: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Members
// ============================================================

export interface DbMember {
  guild_id: string;
  discord_id: string;
  username: string;
  avatar_url: string | null;
  roles: string[];           // Role IDs at time of last update/leave
  joined_at: string;
  left_at: string | null;
  onboarding_completed: boolean;
  is_returning: boolean;
  member_number: number;     // Sequential member join number
  total_time_seconds: number; // Cumulative time in server
  created_at: string;
  updated_at: string;
}

// ============================================================
// Roles & Channels
// ============================================================

export interface DbRoleTemplate {
  id: string; // UUID
  guild_id: string;
  name: string;
  tier: 'everyone' | 'cosmetic' | 'member' | 'moderator' | 'admin' | 'custom';
  permissions: string; // bigint as string
  color: number | null;
  hoist: boolean;
  mentionable: boolean;
  position: number;
  discord_role_id: string | null;
  is_managed: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbChannelTemplate {
  id: string; // UUID
  guild_id: string;
  name: string;
  template_type: string;
  channel_type: number; // Discord channel type enum
  category_id: string | null;
  discord_channel_id: string | null;
  position: number;
  topic: string | null;
  slowmode_seconds: number;
  nsfw: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbGuildDesiredState {
  id: string; // UUID
  guild_id: string;
  entity_type: 'role' | 'channel';
  entity_id: string; // reference to role_template or channel_template ID
  desired_config: Record<string, unknown>;
  actual_discord_id: string | null;
  sync_status: 'synced' | 'drift' | 'pending' | 'error';
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbDiscordIdMap {
  id: string; // UUID
  guild_id: string;
  entity_type: 'role' | 'channel' | 'category';
  internal_id: string;
  discord_id: string;
  created_at: string;
}

// ============================================================
// Features
// ============================================================

export interface DbReactionRole {
  id: string; // UUID
  guild_id: string;
  channel_id: string;
  message_id: string;
  emoji: string;
  role_id: string;
  group_id: string | null; // for exclusive groups
  group_max: number | null;
  created_at: string;
}

// ============================================================
// Auto-Mod Rule Types (per-rule config shapes)
// ============================================================

export type AutoModRuleType =
  | 'word_filter'
  | 'link_filter'
  | 'invite_filter'
  | 'spam_filter'
  | 'duplicate_filter'
  | 'caps_filter'
  | 'mention_spam'
  | 'newline_spam';

export type AutoModAction = 'delete' | 'warn' | 'mute' | 'kick' | 'ban';

export interface WordFilterConfig {
  words: string[];          // Banned words/phrases
  matchMode: 'exact' | 'wildcard' | 'regex';
  caseSensitive: boolean;
}

export interface LinkFilterConfig {
  mode: 'whitelist' | 'blacklist';
  domains: string[];         // Domain list
}

export interface InviteFilterConfig {
  allowOwnServer: boolean;   // Allow invites to this server
}

export interface SpamFilterConfig {
  maxMessages: number;        // X messages
  intervalSeconds: number;    // in Y seconds
}

export interface DuplicateFilterConfig {
  threshold: number;          // Number of identical messages to trigger
  intervalSeconds: number;    // Time window
}

export interface CapsFilterConfig {
  maxPercent: number;         // e.g. 70 = 70% uppercase
  minLength: number;          // Minimum message length to check
}

export interface MentionSpamConfig {
  maxMentions: number;        // Max user/role mentions per message
}

export interface NewlineSpamConfig {
  maxNewlines: number;        // Max newlines per message
}

export type AutoModRuleConfig =
  | WordFilterConfig
  | LinkFilterConfig
  | InviteFilterConfig
  | SpamFilterConfig
  | DuplicateFilterConfig
  | CapsFilterConfig
  | MentionSpamConfig
  | NewlineSpamConfig;

export interface DbAutomodRule {
  id: string; // UUID
  guild_id: string;
  name: string;
  type: AutoModRuleType;
  enabled: boolean;
  config: AutoModRuleConfig;
  action: AutoModAction;
  mute_duration_minutes: number | null;
  exempt_roles: string[];
  exempt_channels: string[];
  log_to_mod_channel: boolean;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Infractions
// ============================================================

export type InfractionType = 'warn' | 'mute' | 'kick' | 'ban';

export interface DbInfraction {
  id: string; // UUID
  guild_id: string;
  member_id: string;
  moderator_id: string;       // 'system' for auto-mod
  type: InfractionType;
  reason: string;
  automod_rule_id: string | null;
  duration_minutes: number | null;  // For mutes
  active: boolean;
  pardoned: boolean;
  pardoned_by: string | null;
  pardoned_at: string | null;
  expires_at: string | null;   // When warning falls off (infraction expiry)
  created_at: string;
}

// ============================================================
// Escalation Chain
// ============================================================

export interface EscalationStep {
  threshold: number;                   // Number of active warnings
  action: 'warn' | 'mute' | 'kick' | 'ban';
  durationMinutes?: number;            // For mutes
  dmMember: boolean;                   // DM the member about the action
}

export const DEFAULT_ESCALATION_CHAIN: EscalationStep[] = [
  { threshold: 1, action: 'warn', dmMember: true },
  { threshold: 2, action: 'warn', dmMember: true },
  { threshold: 3, action: 'mute', durationMinutes: 60, dmMember: true },
  { threshold: 4, action: 'mute', durationMinutes: 1440, dmMember: true },
  { threshold: 5, action: 'kick', dmMember: true },
  { threshold: 6, action: 'ban', dmMember: true },
];

export interface DbTicketPanel {
  id: string; // UUID
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  description: string;
  button_label: string;
  button_emoji: string | null;
  ticket_category_id: string | null;
  manager_role_ids: string[];
  max_open_per_user: number;
  created_at: string;
  updated_at: string;
}

export interface DbTicket {
  id: string; // UUID
  guild_id: string;
  panel_id: string;
  channel_id: string;
  user_discord_id: string;
  claimed_by: string | null;
  status: 'open' | 'claimed' | 'closed';
  ticket_number: number;
  created_at: string;
  closed_at: string | null;
}

export interface DbAutomation {
  id: string; // UUID
  guild_id: string;
  name: string;
  enabled: boolean;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  conditions: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  scope_target_user_ids: string[];
  scope_target_channel_ids: string[];
  scope_exclude_user_ids: string[];
  scope_exclude_channel_ids: string[];
  rate_limit_per_user: number | null;
  rate_limit_window_seconds: number | null;
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  updated_at: string;
}

export interface DbCustomCommand {
  id: string; // UUID
  guild_id: string;
  name: string;
  description: string;
  enabled: boolean;
  actions: Record<string, unknown>[];
  required_role_ids: string[];
  allowed_channel_ids: string[];
  cooldown_seconds: number;
  ephemeral: boolean;
  discord_command_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbEmbedConfig {
  id: string; // UUID
  guild_id: string;
  name: string;
  embed_data: Record<string, unknown>;
  is_template: boolean;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Levels
// ============================================================

export interface DbMemberLevel {
  id: string; // UUID
  guild_id: string;
  user_discord_id: string;
  total_xp: number;
  level: number;
  message_count: number;
  voice_minutes: number;
  last_xp_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbLevelReward {
  id: string; // UUID
  guild_id: string;
  level: number;
  role_id: string;
  remove_previous_reward: boolean;
  created_at: string;
}

export interface DbXpMultiplier {
  id: string; // UUID
  guild_id: string;
  target_type: 'role' | 'channel';
  target_id: string;
  multiplier: number;
  created_at: string;
}

export interface DbMemberRankSettings {
  id: string; // UUID
  guild_id: string;
  user_discord_id: string;
  background_url: string | null;
  accent_color: number | null;
  opacity: number;
  progress_bar_color: number | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Miscellaneous Features
// ============================================================

export interface DbTempChannelHub {
  id: string; // UUID
  guild_id: string;
  voice_channel_id: string;
  category_id: string;
  name_template: string;
  user_limit: number | null;
  created_at: string;
}

export interface DbStatsChannel {
  id: string; // UUID
  guild_id: string;
  voice_channel_id: string;
  stat_type: 'members' | 'online' | 'roles' | 'channels' | 'boosts' |
             'bots' | 'text_channels' | 'voice_channels' | 'categories' | 'custom';
  name_template: string;
  custom_value: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbScheduledMessage {
  id: string; // UUID
  guild_id: string;
  channel_id: string;
  embed_config_id: string | null;
  content: string | null;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
  last_sent_at: string | null;
  next_send_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbGiveaway {
  id: string; // UUID
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  description: string | null;
  winner_count: number;
  required_role_ids: string[];
  prize_product_id: string | null;
  ends_at: string;
  ended: boolean;
  winner_discord_ids: string[];
  created_at: string;
}

// ============================================================
// Commerce
// ============================================================

export interface DbProduct {
  id: string; // UUID
  guild_id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  product_type: 'one_time' | 'subscription';
  entitlement_role_id: string | null;
  active: boolean;
  sort_order: number;
  image_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbProductFile {
  id: string; // UUID
  product_id: string;
  file_name: string;
  storage_path: string;
  file_size: number;
  mime_type: string;
  created_at: string;
}

export interface DbPlan {
  id: string; // UUID
  product_id: string;
  paypal_plan_id: string;
  name: string;
  interval: 'monthly' | 'quarterly' | 'yearly';
  price: number;
  currency: string;
  active: boolean;
  created_at: string;
}

export interface DbCustomer {
  id: string; // UUID
  guild_id: string;
  discord_id: string;
  discord_username: string;
  email: string | null;
  paypal_payer_id: string | null;
  total_spent: number;
  order_count: number;
  created_at: string;
  updated_at: string;
}

export interface DbOrder {
  id: string; // UUID
  guild_id: string;
  customer_id: string;
  product_id: string;
  order_number: string; // SMNI-XXXXX
  status: 'pending' | 'completed' | 'refunded' | 'cancelled';
  amount: number;
  currency: string;
  paypal_order_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbLicenseKey {
  id: string; // UUID
  order_id: string;
  product_id: string;
  key_hash: string;
  key_prefix: string; // SMNI-XXXX (display)
  bound_discord_id: string;
  status: 'active' | 'suspended' | 'revoked';
  created_at: string;
  updated_at: string;
}

export interface DbEntitlement {
  id: string; // UUID
  guild_id: string;
  customer_id: string;
  product_id: string;
  order_id: string;
  discord_id: string;
  role_id: string | null;
  status: 'active' | 'suspended' | 'revoked' | 'expired';
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbProductLicenseConfig {
  id: string; // UUID
  product_id: string;
  license_mode: 'portal_only' | 'portal_watermark' | 'embedded' | 'access_pass';
  max_devices: number;
  heartbeat_interval_seconds: number;
  offline_grace_seconds: number;
  feature_flags: Record<string, boolean>;
  watermark_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbLicenseSession {
  id: string; // UUID
  license_key_id: string;
  device_hash: string;
  platform: string;
  ip_address: string | null;
  last_heartbeat_at: string;
  session_token: string;
  active: boolean;
  created_at: string;
}

export interface DbLicenseValidation {
  id: string; // UUID
  license_key_id: string;
  action: 'validate' | 'heartbeat' | 'deactivate';
  success: boolean;
  device_hash: string | null;
  platform: string | null;
  ip_address: string | null;
  failure_reason: string | null;
  created_at: string;
}

export interface DbPromotion {
  id: string; // UUID
  guild_id: string;
  code: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  product_ids: string[] | null; // null = all products
  max_uses: number | null;
  use_count: number;
  starts_at: string | null;
  expires_at: string | null;
  active: boolean;
  created_at: string;
}

export interface DbPayment {
  id: string; // UUID
  order_id: string;
  paypal_capture_id: string;
  amount: number;
  currency: string;
  status: 'completed' | 'refunded' | 'partially_refunded';
  refund_amount: number;
  created_at: string;
}

export interface DbAuditLog {
  id: string; // UUID
  guild_id: string;
  actor_discord_id: string | null;
  actor_type: 'user' | 'bot' | 'system' | 'webhook';
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface DbWebhookEvent {
  id: string; // UUID
  guild_id: string;
  source: 'paypal' | 'discord' | 'supabase';
  event_type: string;
  payload: Record<string, unknown>;
  status: 'received' | 'processed' | 'failed';
  error: string | null;
  processed_at: string | null;
  created_at: string;
}
