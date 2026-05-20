/**
 * AUTO-GENERATED from SQL migrations — DO NOT EDIT BY HAND
 * Source: 23 migration files in packages/supabase/migrations/
 * Run `scripts/generate-db-types.ts` to regenerate.
 *
 * This file is the SINGLE SOURCE OF TRUTH for database column types.
 * If a column name doesn't exist here, it doesn't exist in the database.
 */

// ============================================================
// Helper Types & Constants (manually maintained)
// ============================================================

// Generic JSON type for JSONB columns
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// Auto-Mod Rule Config Types
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
  words: string[];
  matchMode: 'exact' | 'wildcard' | 'regex';
  caseSensitive: boolean;
}

export interface LinkFilterConfig {
  mode: 'whitelist' | 'blacklist';
  domains: string[];
}

export interface InviteFilterConfig {
  allowOwnServer: boolean;
}

export interface SpamFilterConfig {
  maxMessages: number;
  intervalSeconds: number;
}

export interface DuplicateFilterConfig {
  threshold: number;
  intervalSeconds: number;
}

export interface CapsFilterConfig {
  maxPercent: number;
  minLength: number;
}

export interface MentionSpamConfig {
  maxMentions: number;
}

export interface NewlineSpamConfig {
  maxNewlines: number;
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

// Infraction Types
export type InfractionType = 'warn' | 'mute' | 'kick' | 'ban';

// Escalation Chain
export interface EscalationStep {
  threshold: number;
  action: 'warn' | 'mute' | 'kick' | 'ban';
  durationMinutes?: number;
  dmMember: boolean;
}

export const DEFAULT_ESCALATION_CHAIN: EscalationStep[] = [
  { threshold: 1, action: 'warn', dmMember: true },
  { threshold: 2, action: 'warn', dmMember: true },
  { threshold: 3, action: 'mute', durationMinutes: 60, dmMember: true },
  { threshold: 4, action: 'mute', durationMinutes: 1440, dmMember: true },
  { threshold: 5, action: 'kick', dmMember: true },
  { threshold: 6, action: 'ban', dmMember: true },
];

// Ticket Type Config
export interface TicketTypeConfig {
  id: string;
  label: string;
  emoji: string;
  color: 'blue' | 'grey' | 'green' | 'red';
  description?: string;
  categoryOverride?: string;
  managerRoleOverride?: string[];
  introMessageOverride?: string;
}

// Dashboard Permissions
export type DashboardPermission =
  | 'dashboard.full_access'
  | 'dashboard.view_analytics'
  | 'dashboard.manage_store'
  | 'dashboard.manage_products'
  | 'dashboard.manage_orders'
  | 'dashboard.manage_customers'
  | 'dashboard.manage_licenses'
  | 'dashboard.manage_moderation'
  | 'dashboard.manage_tickets'
  | 'dashboard.manage_automations'
  | 'dashboard.manage_server'
  | 'dashboard.manage_roles'
  | 'dashboard.manage_channels'
  | 'dashboard.manage_team'
  | 'dashboard.view_audit'
  | 'dashboard.view_diagnostics'
  | 'dashboard.manage_incidents'
  | 'dashboard.view_fraud'
  | 'dashboard.manage_fraud'
  | 'dashboard.view_workflows'
  | 'dashboard.manage_workflows'
  | 'dashboard.undo_changes';

// Fraud Types
export type FraudSignalType =
  | 'velocity'
  | 'device_abuse'
  | 'chargeback'
  | 'ip_mismatch'
  | 'key_sharing'
  | 'payment_pattern';

export type FraudSeverity = 'low' | 'medium' | 'high' | 'critical';
export type FraudSignalStatus = 'open' | 'investigating' | 'confirmed' | 'dismissed' | 'auto_resolved';

export type FraudRuleType =
  | 'velocity_limit'
  | 'device_limit'
  | 'ip_block'
  | 'amount_threshold'
  | 'pattern_match';

// Incident Types
export type IncidentSeverity = 'info' | 'warning' | 'critical' | 'outage';
export type IncidentStatus = 'open' | 'investigating' | 'identified' | 'monitoring' | 'resolved';

// DLQ Types
export type DLQStatus = 'pending' | 'retrying' | 'exhausted' | 'resolved' | 'discarded';

// Admin Change Types
export type BlastRadius = 'low' | 'medium' | 'high' | 'critical';


// ============================================================
// Row Types — auto-generated from SQL migrations
// ============================================================

// — Core —

export interface DbUser {
  id: string;
  discord_id: string;
  discord_username: string;
  avatar_url: string | null;
  email: string | null;
  is_owner: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbGuild {
  id: string;
  name: string;
  icon_url: string | null;
  owner_discord_id: string;
  bot_joined_at: string;
  setup_completed: boolean;
  setup_confirmed_at: string | null;
  bot_role_id: string | null;
  bot_role_position: number | null;
  created_at: string;
  updated_at: string;
  total_roles: number | null;
}

export interface DbGuildConfig {
  guild_id: string;
  member_role_id: string | null;
  onboarding_enabled: boolean;
  interest_role_mapping: Record<string, string>;
  returning_member_skip_welcome_dm: boolean;
  returning_member_restore_entitlements: boolean;
  returning_member_restore_levels: boolean;
  welcome_enabled: boolean;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  welcome_card_enabled: boolean;
  welcome_card_background: string | null;
  welcome_dm_enabled: boolean;
  welcome_dm_message: string | null;
  welcome_auto_roles: string[];
  goodbye_enabled: boolean;
  goodbye_channel_id: string | null;
  goodbye_message: string | null;
  mod_log_channel_id: string | null;
  escalation_chain: EscalationStep[];
  infraction_expiry_days: number;
  ticket_transcript_enabled: boolean;
  ticket_dm_transcript: boolean;
  levels_enabled: boolean;
  xp_min: number;
  xp_max: number;
  xp_cooldown_seconds: number;
  voice_xp_enabled: boolean;
  voice_xp_per_interval: number;
  voice_xp_interval_minutes: number;
  level_up_channel_id: string | null;
  level_up_message: string;
  xp_multiplier_mode: 'highest' | 'additive';
  xp_channel_mode: 'blacklist' | 'whitelist';
  xp_channel_list: string[];
  rank_card_accent_color: number;
  rank_card_background: string | null;
  music_enabled: boolean;
  dj_role_id: string | null;
  music_default_volume: number;
  music_auto_leave_minutes: number;
  music_auto_destroy_minutes: number;
  store_enabled: boolean;
  store_channel_id: string | null;
  grace_period_days: number;
  stats_enabled: boolean;
  stats_category_id: string | null;
  stats_update_interval_minutes: number;
  temp_channels_enabled: boolean;
  scheduled_messages_enabled: boolean;
  giveaways_enabled: boolean;
  sync_enabled: boolean;
  sync_interval_minutes: number;
  sync_auto_repair: boolean;
  sync_auto_repair_everyone: boolean;
  updated_at: string;
  paypal_enabled: boolean;
  custom_bot_statuses: string[];
  onboarding_config: Record<string, unknown> | null;
  // V17 Behavioral Audit additions
  no_xp_role_id: string | null;
  anti_raid_enabled: boolean;
  anti_raid_join_threshold: number;
  anti_raid_join_window_seconds: number;
  anti_raid_account_age_days: number;
  anti_raid_action: 'kick' | 'ban' | 'lockdown';
  anti_raid_log_channel_id: string | null;
  starboard_enabled: boolean;
  starboard_channel_id: string | null;
  starboard_threshold: number;
  starboard_emoji: string;
  starboard_self_star: boolean;
  message_log_enabled: boolean;
  message_log_channel_id: string | null;
}

export interface DbInstanceSettings {
  key: string;
  value: string | null;
  section: string;
  updated_at: string;
}

// — Members —

export interface DbMember {
  guild_id: string;
  discord_id: string;
  username: string;
  avatar_url: string | null;
  roles: string[];
  joined_at: string;
  left_at: string | null;
  onboarding_completed: boolean;
  is_returning: boolean;
  member_number: number;
  total_time_seconds: number;
  created_at: string;
  updated_at: string;
}

// — Templates & Server Structure —

export interface DbRoleTemplate {
  id: string;
  guild_id: string | null;
  name: string;
  tier: 'everyone' | 'cosmetic' | 'member' | 'moderator' | 'admin' | 'custom';
  description: string | null;
  permissions: number;
  permission_details: Record<string, unknown>;
  is_builtin: boolean;
  base_template_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbChannelTemplate {
  id: string;
  guild_id: string | null;
  name: string;
  description: string | null;
  target_channel_type: 'text' | 'voice' | 'stage' | 'forum' | 'announcement';
  overrides: Record<string, unknown>;
  is_builtin: boolean;
  base_template_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbServerTemplate {
  id: string;
  guild_id: string | null;
  name: string;
  description: string | null;
  template_data: Record<string, unknown>;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbGuildDesiredState {
  guild_id: string;
  server_template_id: string | null;
  roles: Record<string, unknown>[];
  channels: Record<string, unknown>[];
  permission_map: Record<string, unknown>;
  applied_at: string | null;
  last_sync_at: string | null;
  drift_detected: boolean;
  drift_details: Record<string, unknown> | null;
  updated_at: string;
}

export interface DbDiscordIdMap {
  guild_id: string | null;
  entity_type: 'role' | 'channel' | 'category';
  template_key: string;
  discord_id: string;
}

export interface DbGuildLiveState {
  guild_id: string;
  roles: Record<string, unknown>[];
  channels: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  member_count: number;
  /** JSONB array of member snapshots for dashboard MemberPicker (V14). */
  members: GuildMemberSnapshot[] | null;
  bot_role_id: string | null;
  bot_role_position: number;
  onboarding_enabled: boolean;
  onboarding_prompts: Record<string, unknown>[];
  snapshot_at: string;
}

/** Shape of each member entry in guild_live_state.members JSONB. */
export interface GuildMemberSnapshot {
  id: string;
  username: string;
  display_name: string | null;
  avatar: string | null;
  bot: boolean;
  joined_at: string | null;
  roles: string[];
}

// — Reaction Roles —

export interface DbReactionRole {
  id: string;
  guild_id: string | null;
  channel_id: string;
  message_id: string;
  emoji: string;
  role_id: string;
  exclusive_group: string | null;
  require_role: string | null;
  require_level: number | null;
  max_per_group: number | null;
  remove_on_unreact: boolean;
  log_actions: boolean;
  active: boolean;
  created_at: string;
}

// — Moderation —

export interface DbAutomodRule {
  id: string;
  guild_id: string | null;
  name: string;
  type: 'word_filter' | 'link_filter' | 'invite_filter' | 'spam_filter' | 'duplicate_filter' | 'caps_filter' | 'mention_spam' | 'newline_spam';
  enabled: boolean;
  config: AutoModRuleConfig;
  action: 'delete' | 'warn' | 'mute' | 'kick' | 'ban';
  mute_duration_minutes: number | null;
  exempt_roles: string[];
  exempt_channels: string[];
  log_to_mod_channel: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
  sync_to_discord: boolean;
}

export interface DbInfraction {
  id: string;
  guild_id: string | null;
  member_id: string;
  moderator_id: string;
  type: 'warn' | 'mute' | 'kick' | 'ban';
  reason: string;
  automod_rule_id: string | null;
  duration_minutes: number | null;
  active: boolean;
  pardoned: boolean;
  pardoned_by: string | null;
  pardoned_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface DbMessageReport {
  id: string;
  guild_id: string;
  reporter_id: string;
  channel_id: string;
  message_id: string;
  message_author: string;
  reason: string;
  message_content: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

// — Ticketing —

export interface DbTicketPanel {
  id: string;
  guild_id: string | null;
  name: string;
  channel_id: string;
  message_id: string | null;
  panel_message: Record<string, unknown>;
  input_mode: 'buttons' | 'dropdown';
  ticket_types: TicketTypeConfig[];
  manager_roles: string[];
  open_category_id: string;
  closed_category_id: string | null;
  transcript_channel_id: string | null;
  dm_transcript_to_creator: boolean;
  max_open_per_user: number;
  introduction_message: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  forum_config: Record<string, unknown> | null;
  // V19 Audit: added missing schema fields
  intake_form_enabled: boolean;
  intake_form_fields: Json[] | null;
}

export interface DbTicket {
  id: string;
  guild_id: string | null;
  panel_id: string | null;
  channel_id: string | null;
  ticket_number: number;
  creator_id: string;
  type: string;
  claimed_by: string | null;
  status: 'open' | 'claimed' | 'closed' | 'deleted';
  closed_by: string | null;
  close_reason: string | null;
  transcript_path: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at: string | null;
  inactivity_warned: boolean;
  subject: string | null;
  description: string | null;
  is_forum_ticket: boolean;
  forum_thread_id: string | null;
  // V19 Audit: added missing schema fields
  feedback_rating: number | null;
  feedback_comment: string | null;
}

export interface DbTicketTranscript {
  id: string;
  guild_id: string | null;
  ticket_id: string | null;
  ticket_number: number;
  creator_id: string;
  closed_by_id: string;
  message_count: number;
  participant_ids: string[];
  html_content: string;
  created_at: string;
}

export interface DbTicketMetric {
  ticket_id: string;
  guild_id: string;
  resolution_time_ms: number;
  resolved_at: string;
}

// — Automations —

export interface DbAutomation {
  id: string;
  guild_id: string | null;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  target_user_ids: string[];
  target_channel_ids: string[];
  exclude_user_ids: string[];
  exclude_channel_ids: string[];
  conditions: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  enabled: boolean;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
  rate_limit_per_user: number | null;
  rate_limit_window_seconds: number | null;
}

export interface DbAutomationExecution {
  id: string;
  automation_id: string | null;
  guild_id: string | null;
  triggered_by: string;
  trigger_event: string;
  conditions_passed: boolean;
  actions_executed: number;
  actions_failed: number;
  errors: Record<string, unknown>[];
  duration_ms: number | null;
  created_at: string;
}

export interface DbCustomCommand {
  id: string;
  guild_id: string | null;
  name: string;
  description: string;
  actions: Record<string, unknown>[];
  allowed_roles: string[];
  allowed_channels: string[];
  denied_roles: string[];
  denied_channels: string[];
  cooldown_seconds: number;
  ephemeral: boolean;
  enabled: boolean;
  discord_command_id: string | null;
  created_at: string;
  updated_at: string;
}

// — Embeds —

export interface DbEmbedConfig {
  id: string;
  guild_id: string | null;
  name: string;
  title: string | null;
  description: string | null;
  color: number | null;
  fields: Record<string, unknown>[];
  image_url: string | null;
  thumbnail_url: string | null;
  footer_text: string | null;
  footer_icon_url: string | null;
  author_name: string | null;
  author_url: string | null;
  author_icon_url: string | null;
  include_timestamp: boolean;
  use_components_v2: boolean;
  components_v2_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// — Levels & XP —

export interface DbMemberLevel {
  guild_id: string | null;
  member_id: string;
  xp: number;
  level: number;
  total_messages: number;
  voice_minutes: number;
  last_xp_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbLevelReward {
  id: string;
  guild_id: string | null;
  level: number;
  role_id: string;
  remove_at_level: number | null;
  announce: boolean;
  created_at: string;
}

export interface DbXpMultiplier {
  id: string;
  guild_id: string | null;
  role_id: string;
  multiplier: number;
  created_at: string;
}

export interface DbMemberRankSettings {
  guild_id: string | null;
  member_id: string;
  background_url: string | null;
  background_storage_path: string | null;
  accent_color: number | null;
  progress_bar_color: number | null;
  overlay_opacity: number;
  font_color_override: 'light' | 'dark' | null;
  created_at: string;
  updated_at: string;
}

// — Temp Channels & Stats —

export interface DbTempChannelHub {
  id: string;
  guild_id: string | null;
  hub_channel_id: string;
  category_id: string;
  naming_format: string;
  default_user_limit: number;
  default_bitrate: number;
  keep_alive_minutes: number;
  allow_text_channel: boolean;
  moderator_roles: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbActiveTempChannel {
  channel_id: string;
  text_channel_id: string | null;
  guild_id: string | null;
  hub_id: string | null;
  owner_id: string;
  created_at: string;
}

export interface DbStatsChannel {
  id: string;
  guild_id: string | null;
  channel_id: string | null;
  stat_type: 'total_members' | 'online_members' | 'bot_count' | 'role_count' | 'channel_count' | 'premium_members' | 'active_tickets' | 'total_xp_earned' | 'highest_level' | 'custom_counter';
  stat_config: Record<string, unknown>;
  name_format: string;
  active: boolean;
  last_value: string | null;
  last_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

// — Scheduled Messages —

export interface DbScheduledMessage {
  id: string;
  guild_id: string | null;
  name: string;
  channel_id: string;
  message: string | null;
  embed_config_id: string | null;
  cron_expression: string;
  timezone: string;
  start_date: string | null;
  end_date: string | null;
  max_sends: number | null;
  current_sends: number;
  active: boolean;
  last_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

// — Commerce — Products —

export interface DbProduct {
  id: string;
  guild_id: string | null;
  name: string;
  description: string | null;
  type: 'one_time' | 'subscription';
  delivery_type: 'file' | 'link' | 'access_pass' | 'mixed';
  paypal_product_id: string | null;
  price_cents: number;
  currency: string;
  granted_role_ids: string[];
  granted_channel_ids: string[];
  active: boolean;
  sort_order: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DbProductFile {
  id: string;
  product_id: string | null;
  name: string;
  description: string | null;
  file_path: string | null;
  external_url: string | null;
  file_size_bytes: number | null;
  mime_type: string | null;
  download_count: number;
  sort_order: number;
  created_at: string;
  // V19 Audit: added missing schema fields
  display_name: string | null;
  file_name: string | null;
  guild_id: string;
  size_bytes: number | null;
  storage_bucket: string | null;
  storage_path: string | null;
  version: string | null;
}

export interface DbPlan {
  id: string;
  product_id: string | null;
  guild_id: string | null;
  name: string;
  paypal_plan_id: string | null;
  interval_unit: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
  interval_count: number;
  price_cents: number;
  currency: string;
  trial_days: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// — Commerce — Customers —

export interface DbCustomer {
  id: string;
  user_id: string | null;
  guild_id: string | null;
  discord_id: string;
  discord_username: string;
  paypal_customer_id: string | null;
  email: string | null;
  first_purchase_at: string | null;
  total_spent_cents: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbPromotion {
  id: string;
  guild_id: string | null;
  name: string;
  type: 'percentage' | 'fixed_amount';
  value: number;
  coupon_code: string | null;
  applies_to_product_ids: string[];
  applies_to_plan_ids: string[];
  start_date: string | null;
  end_date: string | null;
  max_uses: number | null;
  current_uses: number;
  min_purchase_cents: number | null;
  first_purchase_only: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// — Commerce — Orders —

export interface DbOrder {
  id: string;
  order_number: string;
  customer_id: string | null;
  guild_id: string | null;
  product_id: string | null;
  plan_id: string | null;
  paypal_order_id: string | null;
  paypal_subscription_id: string | null;
  amount_cents: number;
  currency: string;
  discount_cents: number;
  promotion_id: string | null;
  source: 'purchase' | 'giveaway' | 'manual' | 'automation';
  status: 'pending' | 'completed' | 'refunded' | 'disputed' | 'cancelled';
  created_at: string;
  updated_at: string;
}

// — Commerce — Licensing —

export interface DbLicenseKey {
  id: string;
  order_id: string | null;
  customer_id: string | null;
  product_id: string | null;
  guild_id: string | null;
  key_hash: string;
  key_prefix: string;
  key_suffix: string;
  bound_discord_id: string;
  status: 'pending_activation' | 'active' | 'expired' | 'revoked' | 'suspended';
  activated_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
  updated_at: string;
  failed_attempts: number;
  last_failed_at: string | null;
}

export interface DbEntitlement {
  id: string;
  customer_id: string | null;
  guild_id: string | null;
  product_id: string | null;
  plan_id: string | null;
  license_key_id: string | null;
  order_id: string | null;
  type: 'one_time' | 'subscription';
  status: 'active' | 'expired' | 'suspended' | 'cancelled' | 'pending' | 'grace_period';
  source: 'purchase' | 'giveaway' | 'manual' | 'automation';
  granted_role_ids: string[];
  granted_channel_ids: string[];
  grace_period_ends_at: string | null;
  starts_at: string;
  expires_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbProductLicenseConfig {
  product_id: string;
  license_mode: 'portal_only' | 'portal_watermark' | 'embedded' | 'access_pass';
  max_devices: number;
  heartbeat_interval_seconds: number;
  offline_grace_period_seconds: number;
  feature_flags: string[];
  tier: string | null;
  watermark_config: Record<string, unknown> | null;
  require_discord_guild_membership: boolean;
  created_at: string;
  updated_at: string;
  // V19 Audit: added missing schema fields
  device_policy: string | null;
}

export interface DbLicenseSession {
  id: string;
  license_key_id: string | null;
  device_fingerprint: string;
  device_name: string | null;
  app_version: string | null;
  ip_address: string | null;
  active: boolean;
  first_seen_at: string;
  last_seen_at: string;
  deactivated_at: string | null;
  deactivation_reason: 'user_deactivated' | 'admin_revoked' | 'device_limit' | 'heartbeat_timeout' | 'entitlement_revoked' | null;
}

export interface DbLicenseValidation {
  id: string;
  license_key_id: string | null;
  product_id: string | null;
  device_fingerprint: string | null;
  result: 'valid' | 'invalid_key' | 'expired' | 'suspended' | 'revoked' | 'over_device_limit' | 'product_mismatch';
  ip_address: string | null;
  app_version: string | null;
  created_at: string;
}

// — Commerce — Payments —

export interface DbPayment {
  id: string;
  order_id: string | null;
  customer_id: string | null;
  guild_id: string | null;
  paypal_payment_id: string | null;
  paypal_event_id: string | null;
  amount_cents: number;
  currency: string;
  status: 'completed' | 'refunded' | 'reversed' | 'pending' | 'failed';
  created_at: string;
  // V19 Audit: added missing schema fields
  provider: string | null;
}

// — Commerce — Giveaways —

export interface DbGiveaway {
  id: string;
  guild_id: string | null;
  channel_id: string;
  message_id: string | null;
  prize: string;
  prize_product_id: string | null;
  prize_license_count: number;
  winner_count: number;
  ends_at: string;
  required_role_id: string | null;
  required_level: number | null;
  required_entitlement_product_id: string | null;
  entries: string[];
  winners: string[];
  status: 'active' | 'ended' | 'cancelled';
  ended_at: string | null;
  created_by: string;
  created_at: string;
}

// — Audit & Operations —

export interface DbAuditLog {
  id: string;
  guild_id: string | null;
  timestamp: string;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  success: boolean;
  error_message: string | null;
  // V19 Audit: added missing schema fields
  category: string | null;
  correlation_id: string | null;
}

export interface DbWebhookEvent {
  event_id: string;
  event_type: string;
  processed_at: string;
  payload: Record<string, unknown>;
  result: 'success' | 'error' | 'duplicate' | null;
  error_details: string | null;
  // V19 Audit: added missing schema fields
  guild_id: string;
  replay_count: number;
  replayed_at: string | null;
}

export interface DbBotDiagnostics {
  guild_id: string;
  uptime_seconds: number;
  memory_rss_mb: number;
  memory_heap_mb: number;
  lavalink_nodes: Record<string, unknown>[];
  valkey_connected: boolean;
  valkey_memory_mb: number;
  guild_member_count: number;
  active_voice_connections: number;
  scheduled_message_count: number;
  automation_count: number;
  discord_ws_ping: number;
  snapshot_at: string;
  type: string;
  data: Record<string, unknown> | null;
}

export interface DbBotActionQueue {
  id: string;
  guild_id: string;
  action: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  // Note: V19 incorrectly added 6 fields from missing_tables.sql (action_type,
  // attempts, error, max_attempts, next_retry_at, processed_at). Those columns
  // don't exist — bot_action_queue was created by guild_live_state.sql and
  // missing_tables.sql was a no-op (IF NOT EXISTS). V10 missed this table.
  // Stale fields removed in V20.
}

// — Reconciliation —

export interface DbReconciliationRun {
  id: string;
  guild_id: string | null;
  started_at: string;
  completed_at: string | null;
  trigger: 'scheduled' | 'manual' | 'startup';
  status: 'running' | 'completed' | 'failed';
  findings: Record<string, unknown>;
  fixes_applied: Record<string, unknown>;
  error_message: string | null;
}

export interface DbAlert {
  id: string;
  guild_id: string;
  alert_type: string;
  severity: string;
  title: string;
  message: string | null;
  details: Record<string, unknown> | null;
  acknowledged: boolean;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  auto_resolved: boolean;
  resolved_at: string | null;
  created_at: string;
  // V19 Audit: added missing schema fields
  metadata: Record<string, unknown> | null;
  resolved: boolean;
  updated_at: string;
}

// — Dashboard RBAC —

export interface DbDashboardRole {
  id: string;
  guild_id: string;
  name: string;
  description: string | null;
  permissions: DashboardPermission[];
  is_system: boolean;
  created_at: string;
  updated_at: string;
  priority: number;
}

export interface DbDashboardUserRole {
  id: string;
  guild_id: string;
  discord_id: string;
  role_id: string;
  assigned_at: string;
  assigned_by: string | null;
  created_at: string;
  // V19 Audit: added missing schema fields
  granted_by: string | null;
  user_id: string | null;
}

// — Customer Portal —

export interface DbPortalSession {
  id: string;
  guild_id: string;
  customer_id: string | null;
  discord_id: string;
  /** @deprecated V22 — session_token is now nullable; all code uses token_hash. */
  session_token: string | null;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
  token_hash: string | null;
  revoked: boolean;
  last_used_at: string;
}

// — Fraud Controls —

export interface DbFraudSignal {
  id: string;
  guild_id: string;
  order_id: string | null;
  customer_id: string | null;
  discord_id: string | null;
  signal_type: string;
  severity: string;
  created_at: string;
  entity_type: string | null;
  entity_id: string | null;
  description: string | null;
  evidence: Record<string, unknown>;
  status: string;
  auto_action: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  updated_at: string;
  // V19 Audit: added missing schema fields
  action: string | null;
  details: Record<string, unknown> | null;
  resolved: boolean;
}

export interface DbFraudRule {
  id: string;
  guild_id: string;
  name: string;
  description: string | null;
  rule_type: string;
  config: Record<string, unknown>;
  action: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  auto_action: string;
  last_triggered: string | null;
  trigger_count: number;
}

// — Incidents —

export interface DbIncident {
  id: string;
  guild_id: string;
  title: string;
  description: string | null;
  severity: string;
  category: string;
  status: string;
  assigned_to: string | null;
  created_by: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  incident_number: number | null;
  source: string | null;
  source_ref_id: string | null;
  started_at: string;
  identified_at: string | null;
  duration_seconds: number | null;
  impact_summary: string | null;
  root_cause: string | null;
}

export interface DbIncidentEvent {
  id: string;
  incident_id: string;
  event_type: string;
  actor_id: string;
  details: Record<string, unknown> | null;
  created_at: string;
  message: string | null;
  metadata: Record<string, unknown>;
}

// — DLQ & Workflows —

export interface DbDeadLetterItem {
  id: string;
  guild_id: string;
  event_type: string | null;
  action_type: string | null;
  payload: Record<string, unknown>;
  error: string | null;
  error_message: string | null;
  error_stack: string | null;
  retry_count: number;
  last_retry_at: string | null;
  max_retries: number;
  source: string | null;
  source_type: string | null;
  source_id: string | null;
  status: string;
  failure_count: number;
  first_failed_at: string | null;
  last_failed_at: string | null;
  reprocessed: boolean;
  reprocessed_at: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface DbWorkflowEvent {
  id: string;
  guild_id: string;
  automation_id: string | null;
  execution_id: string | null;
  event_type: string;
  step_name: string | null;
  input_data: Record<string, unknown> | null;
  output_data: Record<string, unknown> | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
  correlation_id: string | null;
  error_message: string | null;
  parent_event_id: string | null;
  payload: Record<string, unknown>;
  result: 'success' | 'error' | 'skipped' | 'pending' | null;
  source: string | null;
}

// — Admin Changes —

export interface DbAdminChange {
  id: string;
  guild_id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  description: string | null;
  is_undoable: boolean;
  is_undone: boolean;
  undone_at: string | null;
  undone_by: string | null;
  blast_radius: string;
  requires_confirmation: boolean;
  undo_payload: Record<string, unknown> | null;
  undo_change_id: string | null;
  created_at: string;
  // V19 Audit: added missing schema fields
  change_type: string | null;
  target_table: string | null;
  undone: boolean;
}

// — Sync —

export interface DbSyncAction {
  id: string;
  guild_id: string;
  action_type: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  status: string;
  applied_at: string | null;
  created_at: string;
  // V19 Audit: added missing schema fields
  action: string | null;
  drift_item: string | null;
}
