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
  total_roles: number | null;      // Total roles in the guild
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
  xp_min: number;
  xp_max: number;
  xp_cooldown_seconds: number;
  voice_xp_enabled: boolean;
  voice_xp_per_interval: number;
  voice_xp_interval_minutes: number;
  xp_multiplier_mode: 'highest' | 'additive';
  xp_channel_mode: 'blacklist' | 'whitelist';
  xp_channel_list: string[];
  rank_card_accent_color: number | null;
  rank_card_background: string | null;
  // Music
  music_enabled: boolean;
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
  exclusive_group: string | null;
  require_role: string | null;
  require_level: number | null;
  max_per_group: number | null;
  remove_on_unreact: boolean;
  log_actions: boolean;
  active: boolean;
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

export interface DbTicketPanel {
  id: string; // UUID
  guild_id: string;
  name: string;
  channel_id: string;
  message_id: string | null;
  panel_message: Record<string, unknown>; // Embed config (JSONB)
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
}

export interface DbTicket {
  id: string; // UUID
  guild_id: string;
  panel_id: string;
  channel_id: string;
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
  closed_at: string | null;
  deleted_at: string | null;
}

export interface DbTicketTranscript {
  id: string; // UUID
  guild_id: string;
  ticket_id: string;
  ticket_number: number;
  creator_id: string;
  closed_by_id: string;
  message_count: number;
  participant_ids: string[];
  html_content: string;
  created_at: string;
}

export interface DbAutomation {
  id: string; // UUID
  guild_id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  conditions: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  target_user_ids: string[];
  target_channel_ids: string[];
  exclude_user_ids: string[];
  exclude_channel_ids: string[];
  rate_limit_per_user: number | null;
  rate_limit_window_seconds: number | null;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbCustomCommand {
  id: string; // UUID
  guild_id: string;
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

export interface DbEmbedConfig {
  id: string; // UUID
  guild_id: string;
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

// ============================================================
// Levels
// ============================================================

export interface DbMemberLevel {
  guild_id: string;
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
  id: string; // UUID
  guild_id: string;
  level: number;
  role_id: string;
  remove_at_level: number | null;
  announce: boolean;
  created_at: string;
}

export interface DbXpMultiplier {
  id: string; // UUID
  guild_id: string;
  role_id: string;
  multiplier: number;
  created_at: string;
}

export interface DbMemberRankSettings {
  guild_id: string;
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

// ============================================================
// Commerce — Products
// ============================================================

export interface DbProduct {
  id: string; // UUID
  guild_id: string;
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
  id: string; // UUID
  product_id: string;
  name: string;
  description: string | null;
  file_path: string | null;
  external_url: string | null;
  file_size_bytes: number | null;
  mime_type: string | null;
  download_count: number;
  sort_order: number;
  created_at: string;
}

export interface DbPlan {
  id: string; // UUID
  product_id: string;
  guild_id: string;
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

// ============================================================
// Commerce — Customers
// ============================================================

export interface DbCustomer {
  id: string; // UUID
  user_id: string | null;
  guild_id: string;
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

// ============================================================
// Commerce — Promotions
// ============================================================

export interface DbPromotion {
  id: string; // UUID
  guild_id: string;
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

// ============================================================
// Commerce — Orders
// ============================================================

export interface DbOrder {
  id: string; // UUID
  order_number: string; // INS-XXXXX
  customer_id: string;
  guild_id: string;
  product_id: string;
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

// ============================================================
// Commerce — License Keys
// ============================================================

export interface DbLicenseKey {
  id: string; // UUID
  order_id: string;
  customer_id: string;
  product_id: string;
  guild_id: string;
  key_hash: string;
  key_prefix: string; // SMNI
  key_suffix: string; // last 4 chars
  bound_discord_id: string;
  status: 'pending_activation' | 'active' | 'expired' | 'revoked' | 'suspended';
  activated_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Commerce — Entitlements
// ============================================================

export interface DbEntitlement {
  id: string; // UUID
  customer_id: string;
  guild_id: string;
  product_id: string;
  plan_id: string | null;
  license_key_id: string | null;
  order_id: string;
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

// ============================================================
// Commerce — License Config & Sessions
// ============================================================

export interface DbProductLicenseConfig {
  product_id: string; // PK, FK to products
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
}

export interface DbLicenseSession {
  id: string; // UUID
  license_key_id: string;
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
  id: string; // UUID
  license_key_id: string;
  product_id: string;
  device_fingerprint: string | null;
  result: 'valid' | 'invalid_key' | 'expired' | 'suspended' | 'revoked' | 'over_device_limit' | 'product_mismatch';
  ip_address: string | null;
  app_version: string | null;
  created_at: string;
}

// ============================================================
// Commerce — Payments
// ============================================================

export interface DbPayment {
  id: string; // UUID
  order_id: string;
  customer_id: string;
  guild_id: string;
  paypal_payment_id: string | null;
  paypal_event_id: string | null;
  amount_cents: number;
  currency: string;
  status: 'completed' | 'refunded' | 'reversed' | 'pending' | 'failed';
  created_at: string;
}

// ============================================================
// Audit & Operations
// ============================================================

export interface DbAuditLog {
  id: string; // UUID
  guild_id: string;
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
}

export interface DbWebhookEvent {
  event_id: string; // PK
  event_type: string;
  processed_at: string;
  payload: Record<string, unknown>;
  result: 'success' | 'error' | 'duplicate' | null;
  error_details: string | null;
}

// ============================================================
// Phase D — SOTA: Dashboard RBAC
// ============================================================

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

export interface DbDashboardRole {
  id: string; // UUID
  guild_id: string;
  name: string;
  description: string | null;
  permissions: DashboardPermission[];
  is_system: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface DbDashboardUserRole {
  id: string; // UUID
  guild_id: string;
  discord_id: string;
  role_id: string;
  assigned_by: string | null;
  assigned_at: string;
}

// ============================================================
// Phase D — SOTA: Customer Portal
// ============================================================

export interface DbPortalSession {
  id: string; // UUID
  guild_id: string;
  customer_id: string;
  token_hash: string;
  discord_id: string;
  expires_at: string;
  created_at: string;
  last_used_at: string;
  ip_address: string | null;
  user_agent: string | null;
  revoked: boolean;
}

// ============================================================
// Phase D — SOTA: Fraud Controls
// ============================================================

export type FraudSignalType =
  | 'velocity'
  | 'device_abuse'
  | 'chargeback'
  | 'ip_mismatch'
  | 'key_sharing'
  | 'payment_pattern';

export type FraudSeverity = 'low' | 'medium' | 'high' | 'critical';

export type FraudSignalStatus = 'open' | 'investigating' | 'confirmed' | 'dismissed' | 'auto_resolved';

export interface DbFraudSignal {
  id: string; // UUID
  guild_id: string;
  signal_type: FraudSignalType;
  severity: FraudSeverity;
  entity_type: string;
  entity_id: string;
  discord_id: string | null;
  description: string;
  evidence: Record<string, unknown>;
  status: FraudSignalStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  auto_action: string | null;
  created_at: string;
  updated_at: string;
}

export type FraudRuleType =
  | 'velocity_limit'
  | 'device_limit'
  | 'ip_block'
  | 'amount_threshold'
  | 'pattern_match';

export interface DbFraudRule {
  id: string; // UUID
  guild_id: string;
  name: string;
  description: string | null;
  rule_type: FraudRuleType;
  enabled: boolean;
  config: Record<string, unknown>;
  auto_action: string;
  trigger_count: number;
  last_triggered: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Phase D — SOTA: Incidents
// ============================================================

export type IncidentSeverity = 'info' | 'warning' | 'critical' | 'outage';
export type IncidentStatus = 'open' | 'investigating' | 'identified' | 'monitoring' | 'resolved';

export interface DbIncident {
  id: string; // UUID
  guild_id: string;
  incident_number: number;
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  source: string;
  source_ref_id: string | null;
  assigned_to: string | null;
  started_at: string;
  identified_at: string | null;
  resolved_at: string | null;
  duration_seconds: number | null;
  impact_summary: string | null;
  root_cause: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbIncidentEvent {
  id: string; // UUID
  incident_id: string;
  event_type: string;
  actor_id: string | null;
  message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ============================================================
// Phase D — SOTA: Dead-Letter Queue & Workflow Events
// ============================================================

export type DLQStatus = 'pending' | 'retrying' | 'exhausted' | 'resolved' | 'discarded';

export interface DbDeadLetterItem {
  id: string; // UUID
  guild_id: string;
  event_type: string;
  source: string;
  payload: Record<string, unknown>;
  error_message: string | null;
  error_stack: string | null;
  retry_count: number;
  max_retries: number;
  status: DLQStatus;
  first_failed_at: string;
  last_retry_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
}

export interface DbWorkflowEvent {
  id: string; // UUID
  guild_id: string;
  event_type: string;
  source: string;
  correlation_id: string | null;
  payload: Record<string, unknown>;
  result: 'success' | 'error' | 'skipped' | 'pending' | null;
  error_message: string | null;
  duration_ms: number | null;
  parent_event_id: string | null;
  created_at: string;
}

// ============================================================
// Phase D — SOTA: Admin Change Tracking
// ============================================================

export type BlastRadius = 'low' | 'medium' | 'high' | 'critical';

export interface DbAdminChange {
  id: string; // UUID
  guild_id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  description: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  undo_payload: Record<string, unknown> | null;
  is_undoable: boolean;
  is_undone: boolean;
  undone_at: string | null;
  undone_by: string | null;
  undo_change_id: string | null;
  blast_radius: BlastRadius;
  requires_confirmation: boolean;
  created_at: string;
}
