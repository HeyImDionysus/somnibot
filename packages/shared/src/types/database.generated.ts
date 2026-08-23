/**
 * AUTO-GENERATED SNAPSHOT of the DB schema derived from SQL migrations.
 * DO NOT EDIT BY HAND — run `python scripts/generate-db-types.py` to refresh.
 * Source: 299 migration files in packages/supabase/migrations/
 *
 * This snapshot is a DRIFT TRIPWIRE, not the app's type source of truth.
 * Application code imports the hand-maintained packages/shared/src/types/
 * database.ts. CI regenerates this file and fails if it differs from the
 * committed copy, forcing a review whenever a migration changes the schema.
 * The generator is a best-effort SQL parser; see the RUNBOOK for its known
 * limitations (no ALTER COLUMN type tracking, no constraint
 * re-derivation), which is why it is a tripwire rather than the source type.
 */

// ============================================================
// Helper Types & Constants (manually maintained)
// ============================================================

// Generic JSON type for JSONB columns
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// Two-phase privacy RPC results. Both purge functions return JSONB so callers
// must inspect purge_status instead of treating a successful RPC as completion.
export type PrivacyPurgeStatus = 'pending_role_cleanup' | 'completed';

export interface PrivacyPurgeRpcResult {
  [key: string]: Json;
  purge_status: PrivacyPurgeStatus;
  pending_role_cleanup_count: number;
}

export type PurgeMemberDataRpcResult = PrivacyPurgeRpcResult;
export type PurgeGuildDataRpcResult = PrivacyPurgeRpcResult;

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
  grace_period_days: number;
  stats_enabled: boolean;
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
  message_log_channel_id: string | null;
  message_log_enabled: boolean;
  economy_enabled: boolean;
  currency_name: string;
  currency_emoji: string;
  economy_starting_balance: number;
  economy_daily_amount: number;
  economy_weekly_amount: number;
  economy_monthly_amount: number;
  economy_streak_bonus_pct: number;
  economy_work_cooldown_seconds: number;
  economy_work_min: number;
  economy_work_max: number;
  economy_crime_success_pct: number;
  economy_crime_fine_pct: number;
  economy_crime_min: number;
  economy_crime_max: number;
  economy_chat_income_enabled: boolean;
  economy_chat_income_min: number;
  economy_chat_income_max: number;
  economy_chat_income_cooldown_seconds: number;
  economy_rob_enabled: boolean;
  economy_rob_success_pct: number;
  economy_rob_fine_pct: number;
  economy_heist_enabled: boolean;
  economy_passive_mode_allowed: boolean;
  economy_pay_tax_pct: number;
  economy_max_wallet: number;
  economy_max_bank: number;
  economy_log_channel_id: string | null;
  economy_gathering_enabled: boolean;
  economy_gathering_cooldown_seconds: number;
  economy_crafting_enabled: boolean;
  economy_crafting_cooldown_seconds: number;
  economy_farming_enabled: boolean;
  economy_farm_grid_size: number;
  economy_farming_wilt_enabled: boolean;
  economy_fertilizer_time_reduction_pct: number;
  economy_fishing_enabled: boolean;
  economy_fishing_cooldown_seconds: number;
  economy_fishing_junk_chance_pct: number;
  economy_fishing_treasure_chance_pct: number;
  economy_adventures_enabled: boolean;
  economy_adventure_daily_limit: number;
  economy_adventure_ticket_cost: number;
  economy_adventure_max_scenes: number;
  economy_market_enabled: boolean;
  economy_market_fee_pct: number;
  economy_market_listing_days: number;
  economy_market_max_listings: number;
  economy_trivia_enabled: boolean;
  economy_trivia_cooldown_seconds: number;
  economy_trivia_base_payout: number;
  economy_trivia_streak_multiplier_pct: number;
  economy_trivia_hard_multiplier: number;
  economy_games_enabled: boolean;
  economy_daily_loss_limit: number;
  economy_coinflip_max_bet: number;
  economy_slots_max_bet: number;
  economy_blackjack_max_bet: number;
  economy_lottery_enabled: boolean;
  economy_lottery_schedule: string;
  economy_lottery_ticket_price: number;
  economy_lottery_max_tickets: number;
  polls_enabled: boolean;
  predictions_enabled: boolean;
  economy_pets_enabled: boolean;
  economy_pet_decay_rate: number;
  economy_pet_battle_enabled: boolean;
  economy_pet_prestige_enabled: boolean;
  economy_pet_feed_cost: number;
  economy_pet_train_cost: number;
  economy_quests_enabled: boolean;
  economy_daily_quest_count: number;
  economy_weekly_quest_count: number;
  economy_quest_reward_base: number;
  economy_achievements_enabled: boolean;
  economy_prestige_enabled: boolean;
  economy_prestige_multiplier_pct: number;
  economy_prestige_min_level: number;
  economy_prestige_min_net_worth: number;
  economy_pet_decay_interval_hours: number;
  economy_pet_low_stat_threshold: number;
  economy_pet_notify_owner: boolean;
  economy_heist_min_participants: number;
  economy_heist_max_participants: number;
  economy_heist_join_window_secs: number;
  economy_heist_cooldown_seconds: number;
  economy_heist_base_payout: number;
  economy_heist_success_base_pct: number;
  economy_heist_entry_fee: number;
  alert_channel_id: string | null;
  anti_raid_ban_delete_seconds: number;
  data_retention_days: number;
  ticket_satisfaction_survey: boolean;
  anti_raid_auto_unban: boolean;
  automod_enabled: boolean;
  automod_mode: 'observe' | 'enforce';
  vote_skip_threshold_percent: number;
  self_skip_enabled: boolean;
  requester_move_enabled: boolean;
  priority_voting_enabled: boolean;
  giveaway_default_winner_count: number;
  giveaway_dm_winners: boolean;
  giveaway_entry_button_label: string;
  giveaway_winner_announcement_style: 'embed' | 'plain';
  profiles_enabled: boolean;
  title_max_length: number;
  bio_max_length: number;
  profile_visibility: 'everyone' | 'members-after-onboarding';
  content_filter_mode: 'lenient' | 'strict';
  show_game_stats: boolean;
  fraud_owner_dm_on_critical: boolean;
  fraud_staff_alert_channel_id: string | null;
  store_brand_name: string | null;
  store_show_powered_by: boolean;
  prediction_min_bet: number;
  prediction_max_bet: number;
  fallback_mode: 'grant-after-timeout' | 'manual-review';
  fallback_timeout_minutes: number;
  message_log_edits_enabled: boolean;
  message_log_deletes_enabled: boolean;
  message_log_ignored_channel_ids: string[];
  automod_regex_budget_ms: number;
  automod_message_budget_ms: number;
  economy_fishing_collection_reward_enabled: boolean;
  economy_fishing_collection_reward_coins: number;
  economy_prestige_max_level: number;
  economy_trivia_schedule_enabled: boolean;
  economy_trivia_schedule_interval_minutes: number;
  economy_trivia_schedule_channel_id: string | null;
  economy_trivia_schedule_category: string | null;
  economy_trivia_schedule_difficulty: string | null;
  economy_trivia_schedule_last_run_at: string | null;
  team_direct_assignment_enabled: boolean;
  team_invite_dm_enabled: boolean;
  team_max_pending_invitations: number;
  team_invitation_expiry_ms: number;
  brand_primary_color: number | null;
  brand_accent_color: number | null;
  brand_voice_preset: 'default' | 'professional' | 'friendly' | 'playful';
  memory_alert_threshold_mb: number;
  ws_ping_alert_threshold_ms: number;
  webhook_error_rate_threshold: number;
  diagnostics_guided_mode: boolean;
  automation_mass_action_threshold: number;
  level_curve: Json;
  max_poll_options: number;
  allow_multiple_default: boolean;
  reaction_roles_enabled: boolean;
  default_style: 'reaction' | 'buttons' | 'select-menu';
  default_max_per_group: number;
  default_require_level: number;
  default_remove_on_unreact: boolean;
  max_schedules_per_guild: number;
  default_timezone: string;
  missed_run_policy: 'skip-missed' | 'send-latest';
  allow_embeds: boolean;
  variables_enabled: boolean;
  economy_market_max_price_per_unit: number;
  anti_raid_containment_ladder: Json;
  anti_raid_raid_cooldown_minutes: number;
  appeals_enabled: boolean;
  appeal_cooldown_hours: number;
  appeal_review_channel_id: string | null;
  dm_on_action: boolean;
  message_log_config_cache_ttl_ms: number;
  data_export_enabled: boolean;
  max_queue_length: number;
  allow_duplicates: boolean;
  per_user_queue_cap: number;
  paypal_legacy_usd_sale_tolerance: boolean;
  paypal_environment: string;
  paypal_refund_strategy: string;
  paypal_webhook_stale_processing_ms: number;
  paypal_webhook_verify_attempts: number;
  product_types_enabled: string[];
  repeat_purchase_policy: string;
  free_claim_policy: string;
  gifting_enabled: boolean;
  public_celebration_enabled: boolean;
  celebration_channel_id: string | null;
  store_brand_source: string;
  max_storefront_products: number;
  portal_session_ttl_ms: number;
  download_link_ttl_ms: number;
  self_service_cancellation: boolean;
  cancellation_timing: string;
  refund_requests_enabled: boolean;
  service_requests_enabled: boolean;
  portal_brand_source: string;
  audit_export_row_limit: number;
  audit_flush_interval_ms: number;
  automation_dm_cooldown_seconds: number;
  automation_max_chain_depth: number;
  automation_preview_required: boolean;
  automation_user_fire_limit_per_minute: number;
  custom_commands_max_per_guild: number;
  custom_commands_mention_safety: boolean;
  diagnostics_snapshot_interval_ms: number;
  incidents_auto_create_from_critical_alerts: boolean;
  incidents_default_severity: string;
  incidents_list_page_size: number;
  rbac_custom_role_priority_default: number;
  rbac_max_permissions_per_role: number;
  rbac_priority_escalation_guard: boolean;
  rbac_unknown_route_access: string;
  brand_logo_url: string | null;
  brand_logo_storage_path: string | null;
  brand_header_url: string | null;
  brand_header_storage_path: string | null;
  brand_background_url: string | null;
  brand_background_storage_path: string | null;
  economy_pet_type_config: Json;
  economy_trivia_question_source: string;
  onboarding_sync_state: Json;
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

export interface DbGuildDesiredState {
  guild_id: string;
  roles: Record<string, unknown>[];
  channels: Record<string, unknown>[];
  permission_map: Record<string, unknown>;
  applied_at: string | null;
  last_sync_at: string | null;
  drift_detected: boolean;
  drift_details: Record<string, unknown> | null;
  updated_at: string;
  categories: Json;
  deploy_mode: string;
}

export interface DbDiscordIdMap {
  guild_id: string;
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
  bot_role_id: string | null;
  bot_role_position: number;
  onboarding_enabled: boolean;
  onboarding_prompts: Record<string, unknown>[];
  snapshot_at: string;
  members: Json | null;
  snapshot_version: number;
  bot_permissions: string | null;
}

// — Reaction Roles —

export interface DbReactionRole {
  id: string;
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

// — Moderation —

export interface DbAutomodRule {
  id: string;
  guild_id: string;
  name: string;
  type: 'word_filter' | 'link_filter' | 'invite_filter' | 'spam_filter' | 'duplicate_filter' | 'caps_filter' | 'mention_spam' | 'newline_spam';
  enabled: boolean;
  config: AutoModRuleConfig;
  action: 'delete' | 'warn' | 'mute' | 'kick' | 'ban';
  mute_duration_minutes: number | null;
  exempt_roles: string[];
  exempt_channels: string[];
  log_to_mod_channel: boolean;
  created_at: string;
  updated_at: string;
  sync_to_discord: boolean;
  priority: number;
}

export interface DbInfraction {
  id: string;
  guild_id: string;
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
  correlation_id: string | null;
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
  guild_id: string;
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
  intake_form_enabled: boolean;
  intake_form_fields: Json[];
  inactivity_warn_hours: number;
  inactivity_close_hours: number;
  feedback_prompt_enabled: boolean;
}

export interface DbTicket {
  id: string;
  guild_id: string;
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
  closed_at: string | null;
  deleted_at: string | null;
  inactivity_warned: boolean;
  subject: string | null;
  description: string | null;
  is_forum_ticket: boolean;
  forum_thread_id: string | null;
  updated_at: string;
  feedback_rating: number | null;
  feedback_comment: string | null;
  creation_occurrence_id: string | null;
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
  guild_id: string;
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
  preview_hash: string | null;
  previewed_at: string | null;
}

export interface DbAutomationExecution {
  id: string;
  automation_id: string | null;
  guild_id: string;
  triggered_by: string;
  trigger_event: string;
  conditions_passed: boolean;
  actions_executed: number;
  actions_failed: number;
  errors: Record<string, unknown>[];
  duration_ms: number | null;
  created_at: string;
  occurrence_id: string | null;
  actions_started: boolean;
  recovery_context: Json | null;
  recovery_state: 'legacy' | 'running' | 'completed' | 'manual_reconcile';
}

export interface DbCustomCommand {
  id: string;
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

// — Embeds —

export interface DbEmbedConfig {
  id: string;
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

// — Levels & XP —

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
  id: string;
  guild_id: string;
  level: number;
  role_id: string | null;
  remove_at_level: number | null;
  announce: boolean;
  created_at: string;
  reward_type: string;
  remove_role_id: string | null;
  currency_amount: number | null;
  item_id: string | null;
  item_quantity: number | null;
  active: boolean;
}

export interface DbXpMultiplier {
  id: string;
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

// — Temp Channels & Stats —

export interface DbTempChannelHub {
  id: string;
  guild_id: string;
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
  allow_claim: boolean;
  empty_grace_seconds: number;
  room_created_template: string | null;
  control_applied_template: string | null;
  control_denied_template: string | null;
}

export interface DbActiveTempChannel {
  channel_id: string;
  text_channel_id: string | null;
  guild_id: string;
  hub_id: string | null;
  owner_id: string;
  created_at: string;
  creation_occurrence_id: string | null;
}

export interface DbStatsChannel {
  id: string;
  guild_id: string;
  channel_id: string | null;
  stat_type: 'total_members' | 'online_members' | 'bot_count' | 'role_count' | 'channel_count' | 'premium_members' | 'active_tickets' | 'total_xp_earned' | 'highest_level' | 'custom_counter';
  stat_config: Record<string, unknown>;
  name_format: string;
  active: boolean;
  last_value: string | null;
  last_updated_at: string | null;
  created_at: string;
  updated_at: string;
  pending_cleanup_channel_ids: Json;
}

// — Scheduled Messages —

export interface DbScheduledMessage {
  id: string;
  guild_id: string;
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
  status: 'active' | 'failed';
  last_error: string | null;
  failed_at: string | null;
  missed_run_policy: 'skip-missed' | 'send-latest';
  next_occurrence_at: string | null;
}

// — Commerce — Products —

export interface DbProduct {
  id: string;
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
  guild_id: string | null;
  file_name: string | null;
  display_name: string | null;
  version: string;
  storage_path: string | null;
  storage_bucket: string | null;
  size_bytes: number | null;
}

export interface DbPlan {
  id: string;
  product_id: string | null;
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

// — Commerce — Customers —

export interface DbCustomer {
  id: string;
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
  total_orders: number;
}

export interface DbPromotion {
  id: string;
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

// — Commerce — Orders —

export interface DbOrder {
  id: string;
  order_number: string;
  customer_id: string | null;
  guild_id: string;
  product_id: string | null;
  plan_id: string | null;
  paypal_order_id: string | null;
  paypal_subscription_id: string | null;
  amount_cents: number;
  currency: string;
  discount_cents: number;
  promotion_id: string | null;
  source: 'purchase' | 'giveaway' | 'manual' | 'automation';
  status: 'pending' | 'completed' | 'refunded' | 'disputed' | 'cancelled' | 'pending_review';
  created_at: string;
  updated_at: string;
  granted_role_ids_snapshot: string[];
  granted_channel_ids_snapshot: string[];
  temporary_role_grants_snapshot: Array<{ role_id: string; duration_seconds: number }>;
  grant_snapshot_frozen_at: string | null;
  checkout_active: boolean;
  delivery_type_snapshot: string | null;
  checkout_approval_url: string | null;
  commerce_compatible_child_status: string | null;
  download_required_snapshot: boolean | null;
}

// — Commerce — Licensing —

export interface DbLicenseKey {
  id: string;
  order_id: string | null;
  customer_id: string | null;
  product_id: string | null;
  guild_id: string;
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
  commerce_required_order_status: string | null;
  rotated_to_key_id: string | null;
}

export interface DbEntitlement {
  id: string;
  customer_id: string | null;
  guild_id: string;
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
  commerce_required_order_status: string | null;
  portal_cancellation_timing: string | null;
  portal_cancellation_access_until: string | null;
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
  device_policy: 'evict_oldest' | 'reject';
  rotation_policy: string;
  self_service_device_removal: boolean;
  sdk_cache_ttl_ms: number;
  key_prefix: string;
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
  commerce_required_license_status: string | null;
}

export interface DbLicenseValidation {
  id: string;
  license_key_id: string | null;
  product_id: string | null;
  device_fingerprint: string | null;
  result: 'valid' | 'invalid_key' | 'expired' | 'suspended' | 'revoked' | 'over_device_limit' | 'product_mismatch' | 'cancelled' | 'pending' | 'grace_period' | 'unavailable' | 'rate_limited' | 'session_invalidated' | 'device_fingerprint_required';
  ip_address: string | null;
  app_version: string | null;
  created_at: string;
}

// — Commerce — Payments —

export interface DbPayment {
  id: string;
  order_id: string | null;
  customer_id: string | null;
  guild_id: string;
  paypal_payment_id: string | null;
  paypal_event_id: string | null;
  amount_cents: number;
  currency: string;
  status: 'completed' | 'refunded' | 'reversed' | 'pending' | 'failed';
  created_at: string;
  provider: string;
  paypal_resource_type: string | null;
  commerce_required_order_status: string | null;
  commerce_settled_capture_order_id: string | null;
  commerce_customer_totals_recorded_at: string | null;
}

// — Commerce — Giveaways —

export interface DbGiveaway {
  id: string;
  guild_id: string;
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
  category: string;
  correlation_id: string | null;
  occurrence_key: string | null;
  unscoped_occurrence_key: string | null;
}

export interface DbWebhookEvent {
  event_id: string;
  event_type: string;
  processed_at: string;
  payload: Record<string, unknown>;
  result: 'success' | 'error' | 'duplicate' | null;
  error_details: string | null;
  replayed_at: string | null;
  replay_count: number;
  guild_id: string | null;
  replay_claim_token: string | null;
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
  boot_id: string | null;
}

export interface DbBotActionQueue {
  id: string;
  guild_id: string;
  action: string;
  payload: Record<string, unknown>;
  status: 'staged' | 'pending' | 'processing' | 'completed' | 'failed';
  result: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  action_type: string | null;
  attempts: number;
  max_attempts: number;
  error: string | null;
  processed_at: string | null;
  next_retry_at: string | null;
  retry_count: number;
  lane: 'commerce' | 'game';
  claim_token: string | null;
  idempotency_key: string | null;
  outward_generation_id: string | null;
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
  metadata: Record<string, unknown>;
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
  user_id: string | null;
  role_id: string;
  granted_by: string | null;
  created_at: string;
  assigned_at: string;
  assigned_by: string | null;
  discord_id: string;
}

// — Customer Portal —

export interface DbPortalSession {
  id: string;
  guild_id: string;
  customer_id: string | null;
  discord_id: string;
  session_token: string | null;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
  token_hash: string | null;
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
  details: Json | null;
  action: string;
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  auto_action: string | null;
  description: string | null;
  entity_id: string | null;
  entity_type: string | null;
  evidence: Record<string, unknown>;
  resolution_note: string | null;
  status: string;
  updated_at: string;
  last_observed_at: string;
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
  auto_action: string | null;
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
  duration_seconds: number | null;
  identified_at: string | null;
  impact_summary: string | null;
  incident_number: number;
  root_cause: string | null;
  source: string | null;
  source_ref_id: string | null;
  started_at: string | null;
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
  source_type: string;
  source_id: string | null;
  action_type: string;
  payload: Record<string, unknown>;
  error: string | null;
  failure_count: number;
  first_failed_at: string;
  last_failed_at: string;
  reprocessed: boolean;
  reprocessed_at: string | null;
  created_at: string;
  error_message: string | null;
  error_stack: string | null;
  event_type: string | null;
  last_retry_at: string | null;
  max_retries: number;
  resolution_note: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  retry_count: number;
  source: string | null;
  status: string;
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
  change_type: string | null;
  target_table: string | null;
  target_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  description: string | null;
  undone: boolean;
  undone_at: string | null;
  undone_by: string | null;
  created_at: string;
  action: string | null;
  blast_radius: string | null;
  is_undoable: boolean;
  is_undone: boolean;
  requires_confirmation: boolean;
  target_type: string | null;
  undo_change_id: string | null;
  undo_payload: Record<string, unknown> | null;
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
  action: string | null;
  drift_item: Json | null;
}

// — Other —

export interface DbActionQueueDlq {
  id: string;
  guild_id: string;
  action: string;
  payload: Record<string, Json>;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  original_id: string | null;
  failed_at: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
  retried: boolean;
  retried_at: string | null;
  created_at: string;
  lane: 'commerce' | 'game';
}

export interface DbAntiRaidState {
  guild_id: string;
  activated_at: string;
  trigger_joins: number;
  expires_at: string;
  previous_verification_level: number | null;
  lockdown_channel_ids: Json;
  updated_at: string;
}

export interface DbAppeals {
  id: string;
  guild_id: string;
  infraction_id: string;
  appellant_discord_id: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  reviewer_id: string | null;
  decision_notified: boolean;
  decided_at: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface DbAutomationActionProgress {
  execution_id: string;
  action_index: number;
  target_id: string;
  action_type: string;
  action_payload: Json;
  retry_safe: boolean;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'manual_reconcile';
  side_effect_key: string;
  owner_token: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  result: Json | null;
  started_at: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbAutomationMassActionHolds {
  id: string;
  guild_id: string;
  automation_id: string;
  execution_id: string | null;
  occurrence_id: string;
  status: 'held' | 'approved' | 'executing' | 'completed' | 'rejected' | 'failed';
  member_ids: string[];
  member_count: number;
  threshold: number;
  trigger_event: string;
  triggered_by: string;
  action_snapshot: Json;
  context_snapshot: Json;
  notification_message_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  execution_started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  execution_owner_token: string | null;
  execution_lease_expires_at: string | null;
  progress_executed: number;
  progress_failed: number;
  progress_errors: Json;
}

export interface DbButtonRoles {
  id: string;
  guild_id: string | null;
  panel_id: string;
  channel_id: string;
  message_id: string | null;
  label: string;
  emoji: string | null;
  style: 'primary' | 'secondary' | 'success' | 'danger';
  role_id: string;
  sort_order: number;
  exclusive_group: string | null;
  require_role: string | null;
  require_level: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbCommerceAdminRefundOperations {
  attempt_id: string;
  request_id: string;
  order_id: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
  plan_id: string | null;
  actor_id: string;
  paypal_order_id: string | null;
  payment_id: string | null;
  paypal_payment_id: string | null;
  resource_type: 'capture' | null;
  order_amount_cents: number;
  existing_refunded_cents: number;
  refund_amount_cents: number;
  currency: string;
  reason: string;
  provider_required: boolean;
  status: 'prepared' | 'pending' | 'provider_completed' | 'failed' | 'cancelled' | 'completed';
  provider_status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | null;
  paypal_refund_id: string | null;
  provider_reported_amount_cents: number | null;
  provider_reported_currency: string | null;
  created_at: string;
  updated_at: string;
  provider_outcome_at: string | null;
  completed_at: string | null;
}

export interface DbCommerceCheckoutDeactivationProofs {
  id: string;
  order_id: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
  provider_kind: 'capture' | 'subscription';
  provider_id: string;
  proof_kind: 'provider_cancelled' | 'provider_expired' | 'approval_link_not_exposed' | 'operator_verified_unpayable';
  proof_reference: string;
  proved_at: string;
}

export interface DbCommerceCheckoutIntents {
  token: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
  plan_id: string | null;
  gift_checkout_token: string | null;
  provider_id: string | null;
  order_id: string | null;
  status: 'pending' | 'bound' | 'captured' | 'cancelled';
  created_at: string;
  expires_at: string;
  cancel_reason: string | null;
  approval_exposed_at: string | null;
  provider_binding: string | null;
  promotion_id: string | null;
  promotion_code: string | null;
  discount_cents: number;
  final_amount_cents: number | null;
}

export interface DbCommerceDownloadDeliveries {
  id: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
  file_id: string | null;
  file_name_snapshot: string | null;
  entitlement_id: string | null;
  order_id: string | null;
  delivery_nonce_hash: string | null;
  delivered_at: string;
}

export interface DbCommerceFreeClaims {
  request_id: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
  order_id: string;
  created_at: string;
}

export interface DbCommerceFulfillmentClaims {
  guild_id: string;
  customer_id: string;
  product_id: string;
  order_id: string;
  claimed_at: string;
}

export interface DbCommerceFulfillmentHolds {
  order_id: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
  winning_order_id: string | null;
  conflicting_entitlement_id: string | null;
  provider_kind: 'capture' | 'subscription';
  provider_id: string;
  hold_reason: 'duplicate_paid_fulfillment' | 'unknown_delivery_contract';
  held_at: string;
}

export interface DbCommerceFulfillmentOutwardIntents {
  id: string;
  order_id: string;
  guild_id: string;
  outward_generation_id: string | null;
  intent_kind: 'purchase_completed_event' | 'subscription_activated_event' | 'receipt_dm' | 'subscription_renewed_event' | 'subscription_cancelled_event' | 'subscription_cancelled_dm' | 'subscription_payment_failed_lapsed_event' | 'subscription_payment_failed_event' | 'subscription_payment_failed_dm' | 'subscription_suspended_event' | 'subscription_suspended_dm';
  state: 'sending' | 'sent' | 'uncertain' | 'superseded';
  attempt_token: string | null;
  started_at: string;
  sent_at: string | null;
  uncertain_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface DbCommerceGiftIntents {
  id: string;
  guild_id: string;
  buyer_customer_id: string;
  recipient_discord_id: string;
  product_id: string;
  status: 'pending' | 'fulfilled' | 'cancelled';
  fulfilled_order_id: string | null;
  created_at: string;
  fulfilled_at: string | null;
  expires_at: string;
  checkout_token: string;
}

export interface DbCommerceLegacySubscriptionGrantContracts {
  order_id: string;
  source_queue_id: string;
  guild_id: string;
  customer_id: string;
  discord_id: string;
  product_id: string;
  product_name: string;
  order_number: string;
  plan_id: string;
  paypal_subscription_id: string;
  paypal_plan_id: string;
  amount_cents: number;
  currency: string;
  granted_role_ids_snapshot: string[];
  granted_channel_ids_snapshot: string[];
  persisted_at: string;
}

export interface DbCommerceNoncommerceActionOutcomes {
  action_id: string;
  claim_token: string;
  outcome: 'superseded' | 'unproven' | 'settled_noop';
  recorded_at: string;
}

export interface DbCommerceNoncommerceActivationHeads {
  entitlement_id: string;
  guild_id: string;
  customer_id: string;
  discord_id: string;
  order_id: string | null;
  product_id: string;
  entitlement_source: string;
  entitlement_type: string;
  plan_id: string | null;
  activation_generation: string;
  action_id: string;
  role_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface DbCommercePortalRequests {
  id: string;
  guild_id: string;
  customer_id: string;
  order_id: string | null;
  type: 'refund' | 'service';
  status: 'pending' | 'reviewing' | 'resolved' | 'rejected';
  reason: string | null;
  created_at: string;
  updated_at: string;
  reviewer_id: string | null;
  resolution_note: string | null;
  decided_at: string | null;
  customer_notified: boolean;
}

export interface DbCommerceProductTempRoleConfig {
  id: string;
  product_id: string;
  guild_id: string;
  role_id: string;
  duration_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface DbCommerceProviderIncidents {
  id: string;
  webhook_event_id: string;
  provider_event_type: 'PAYMENT.CAPTURE.COMPLETED' | 'BILLING.SUBSCRIPTION.ACTIVATED' | 'PAYMENT.SALE.COMPLETED';
  provider_resource_id: string | null;
  provider_parent_id: string | null;
  observed_guild_id: string | null;
  routable_guild_id: string | null;
  incident_reason: 'provider_identity_malformed' | 'custom_identity_missing_or_malformed' | 'customer_identity_missing_or_mismatched' | 'order_identity_missing_or_ambiguous' | 'product_identity_missing_or_mismatched' | 'plan_identity_missing_or_mismatched' | 'financial_identity_malformed' | 'subscription_sale_router_failed';
  evidence: Json;
  alert_id: string | null;
  created_at: string;
}

export interface DbCommerceProviderMoneyRecovery {
  webhook_event_id: string;
  provider_resource_id: string | null;
  provider_parent_id: string | null;
  guild_id: string | null;
  reason: string;
  status: 'pending' | 'processing' | 'refunded' | 'resolved' | 'manual_review';
  attempts: number;
  next_retry_at: string | null;
  created_at: string;
  resolved_at: string | null;
  max_attempts: number;
  lease_token: string | null;
  leased_until: string | null;
}

export interface DbCommercePurchaseCelebrations {
  order_id: string;
  guild_id: string;
  created_at: string;
}

export interface DbCommerceRoleDeliveryIntents {
  id: string;
  contract_kind: 'paid' | 'noncommerce';
  entitlement_source: string | null;
  activation_generation: string | null;
  action_id: string;
  origin_claim_token: string;
  delivery_claim_token: string;
  guild_id: string;
  entitlement_id: string;
  customer_id: string;
  discord_id: string;
  order_id: string;
  product_id: string;
  plan_id: string | null;
  entitlement_type: 'one_time' | 'subscription';
  permanent_role_ids: string[];
  completed_role_ids: string[];
  reserved_role_ids: string[];
  owned_role_ids: string[];
  reserved_temp_role_grant_ids: string[];
  temporary_role_grant_ids: string[];
  state: 'open' | 'cleanup_required' | 'operator_required' | 'settled';
  mutation_token: string | null;
  last_delivery_mutation_token: string | null;
  last_delivery_outcome: string | null;
  cleanup_action_id: string | null;
  cleanup_claim_token: string | null;
  cleanup_mutation_token: string | null;
  last_cleanup_mutation_token: string | null;
  last_cleanup_outcome: string | null;
  recovery_generation: number;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
  delivery_confirmed_at: string | null;
  mutation_started_at: string | null;
  cleanup_mutation_started_at: string | null;
  last_error: string | null;
  outward_generation_id: string | null;
}

export interface DbCommerceRoleMetadataMigrationIssues {
  id: string;
  product_id: string;
  guild_id: string;
  role_id: string | null;
  issue_type: 'invalid_role_id' | 'invalid_duration' | 'orphan_duration' | 'unsupported_product_type' | 'ambiguous_permanent_history' | 'ambiguous_historical_role' | 'invalid_historical_roles';
  details: Json;
  resolved_at: string | null;
  created_at: string;
}

export interface DbCommerceSubscriptionLifecycleEvents {
  webhook_event_id: string;
  paypal_subscription_id: string;
  provider_event_type: string;
  provider_occurred_at: string;
  provider_paid_through_at: string | null;
  order_id: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
  plan_id: string;
  disposition: 'accepted' | 'stale';
  event_priority: number;
  generation: number;
  recorded_at: string;
}

export interface DbCommerceSubscriptionLifecycleHeads {
  paypal_subscription_id: string;
  order_id: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
  plan_id: string;
  last_webhook_event_id: string;
  last_provider_event_type: string;
  last_provider_occurred_at: string;
  last_event_priority: number;
  generation: number;
  paid_through_at: string | null;
  cancellation_effective_at: string | null;
  updated_at: string;
}

export interface DbCommerceSubscriptionSaleHolds {
  payment_id: string;
  paypal_payment_id: string;
  order_id: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
  plan_id: string;
  paypal_subscription_id: string;
  hold_reason: 'financial_mismatch' | 'terminal_or_held_order' | 'renewal_contract_invalid' | 'renewal_action_failed';
  contract_detail: string;
  observed_order_status: 'pending' | 'completed' | 'refunded' | 'disputed' | 'cancelled' | 'pending_review';
  provider_amount_cents: number;
  provider_currency: string;
  stored_order_amount_cents: number;
  stored_order_currency: string;
  alert_id: string;
  action_id: string | null;
  held_at: string;
}

export interface DbCommerceTempRoleMigrationIssues {
  id: string;
  temp_role_grant_id: string;
  guild_id: string;
  user_id: string;
  role_id: string;
  source: string | null;
  source_id: string | null;
  issue_type: string;
  resolved_at: string | null;
  created_at: string;
}

export interface DbDiscordOperationOccurrences {
  id: string;
  guild_id: string;
  operation_kind: 'scheduled_message' | 'temp_channel' | 'ticket';
  occurrence_key: string;
  status: 'claimed' | 'completed' | 'failed';
  resource_id: string | null;
  result: Json;
  last_error: string | null;
  claimed_at: string;
  completed_at: string | null;
  updated_at: string;
}

export interface DbEconomyAchievementDefs {
  id: string;
  guild_id: string;
  name: string;
  description: string;
  badge_emoji: string;
  condition_type: string;
  condition_value: number;
  reward_currency: number;
  reward_xp: number;
  hidden: boolean;
  created_at: string;
}

export interface DbEconomyAdventureScenes {
  id: string;
  adventure_id: string;
  scene_index: number;
  text: string;
  image_url: string | null;
  choices: Json;
  loot: Json;
  is_ending: boolean;
  ending_type: string | null;
  created_at: string;
}

export interface DbEconomyAdventureSessions {
  id: string;
  guild_id: string;
  user_id: string;
  adventure_id: string;
  current_scene_id: string | null;
  status: string;
  loot_collected: Json;
  currency_collected: number;
  items_brought: Json;
  message_id: string | null;
  channel_id: string | null;
  started_at: string;
  ended_at: string | null;
  loot_failed: boolean;
  scenes_traversed: number;
  health_remaining: number;
}

export interface DbEconomyAdventures {
  id: string;
  guild_id: string;
  name: string;
  emoji: string;
  description: string | null;
  adventure_type: string;
  difficulty: string;
  min_scenes: number;
  max_scenes: number;
  is_default: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbEconomyCrops {
  id: string;
  guild_id: string;
  name: string;
  emoji: string;
  grow_seconds: number;
  wilt_seconds: number;
  sell_price: number;
  seeds_returned: number;
  seed_item_id: string | null;
  category: string;
  sort_order: number;
  is_default: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbEconomyDailyLosses {
  guild_id: string;
  user_id: string;
  loss_date: string;
  amount: number;
  updated_at: string;
}

export interface DbEconomyFarmPlots {
  id: string;
  guild_id: string;
  user_id: string;
  plot_index: number;
  crop_id: string | null;
  planted_at: string | null;
  watered_at: string | null;
  fertilized: boolean;
  harvested: boolean;
  created_at: string;
}

export interface DbEconomyFarmingOperations {
  guild_id: string;
  user_id: string;
  operation_id: string;
  operation_type: 'plant' | 'water' | 'fertilize';
  result: Json;
  created_at: string;
}

export interface DbEconomyFishCatches {
  id: string;
  guild_id: string;
  user_id: string;
  species_id: string;
  weight: number;
  price_earned: number;
  caught_at: string;
  paid: boolean;
  correlation_id: string | null;
}

export interface DbEconomyFishCollectionRewards {
  guild_id: string;
  user_id: string;
  paid_at: string;
}

export interface DbEconomyFishSpecies {
  id: string;
  guild_id: string;
  name: string;
  emoji: string;
  rarity: string;
  min_weight: number;
  max_weight: number;
  base_price: number;
  is_default: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbEconomyHeistParticipants {
  id: string;
  heist_id: string;
  guild_id: string;
  user_id: string;
  role: string;
  payout: number;
  joined_at: string;
  paid_at: string | null;
  payout_failed: boolean;
  claimed_at: string | null;
  entry_fee_paid: number | null;
}

export interface DbEconomyHeists {
  id: string;
  guild_id: string;
  initiator_id: string;
  status: 'recruiting' | 'in_progress' | 'success' | 'failed' | 'cancelled';
  target_name: string;
  target_payout: number;
  resolved_at: string | null;
  expires_at: string;
  created_at: string;
  payout_each: number | null;
  resolution: 'success' | 'failed' | 'cancelled' | null;
  base_success_chance: number | null;
}

export interface DbEconomyInventory {
  id: string;
  guild_id: string;
  user_id: string;
  item_id: string;
  quantity: number;
  durability_remaining: number | null;
  acquired_at: string;
  updated_at: string;
}

export interface DbEconomyItemUseOperations {
  guild_id: string;
  user_id: string;
  request_id: string;
  requested_item: string;
  item_id: string;
  result: Json;
  created_at: string;
}

export interface DbEconomyItems {
  id: string;
  guild_id: string;
  name: string;
  description: string | null;
  emoji: string;
  category: string;
  price: number;
  sell_price: number;
  stock: number | null;
  max_per_user: number | null;
  require_role_id: string | null;
  grant_role_id: string | null;
  usable: boolean;
  use_effect: Json | null;
  durability: number | null;
  tradeable: boolean;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DbEconomyLootTables {
  id: string;
  guild_id: string;
  source_type: 'hunt' | 'dig' | 'mine';
  item_name: string;
  emoji: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  min_qty: number;
  max_qty: number;
  weight: number;
  tool_tier: number;
  sell_value: number;
  gives_item_id: string | null;
  active: boolean;
  created_at: string;
}

export interface DbEconomyLotteryDrawings {
  id: string;
  guild_id: string;
  status: 'active' | 'drawn' | 'cancelled';
  jackpot: number;
  winner_user_id: string | null;
  winning_number: number | null;
  drawn_at: string | null;
  created_at: string;
  winner_paid_at: string | null;
}

export interface DbEconomyLotteryTickets {
  id: string;
  drawing_id: string;
  guild_id: string;
  user_id: string;
  ticket_number: number;
  purchased_at: string;
  request_id: string | null;
}

export interface DbEconomyMarketListings {
  id: string;
  guild_id: string;
  seller_id: string;
  item_id: string;
  item_name: string;
  quantity: number;
  remaining: number;
  price_per_unit: number;
  status: string;
  expires_at: string;
  created_at: string;
  cancelled_at: string | null;
  updated_at: string;
}

export interface DbEconomyPetBattles {
  id: string;
  guild_id: string;
  challenger_id: string;
  defender_id: string;
  winner_id: string | null;
  challenger_dmg: number;
  defender_dmg: number;
  reward: number;
  created_at: string;
}

export interface DbEconomyPetOperations {
  guild_id: string;
  user_id: string;
  pet_id: string;
  operation: string;
  request_id: string;
  result: Json;
  created_at: string;
}

export interface DbEconomyPets {
  id: string;
  guild_id: string;
  user_id: string;
  name: string;
  pet_type: string;
  level: number;
  xp: number;
  hunger: number;
  happiness: number;
  energy: number;
  attack: number;
  defense: number;
  speed: number;
  health: number;
  prestige: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface DbEconomyPrestige {
  id: string;
  guild_id: string;
  user_id: string;
  prestige_level: number;
  total_resets: number;
  multiplier_pct: number;
  title: string | null;
  last_prestige: string | null;
  created_at: string;
  last_request_id: string | null;
}

export interface DbEconomyProfiles {
  id: string;
  guild_id: string;
  user_id: string;
  bio: string;
  title: string;
  badge_slots: string[];
  favorite_pet: string | null;
  profile_views: number;
  created_at: string;
  updated_at: string;
}

export interface DbEconomyQuestProgress {
  id: string;
  guild_id: string;
  user_id: string;
  template_id: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  assigned_at: string;
  completed_at: string | null;
  assigned_date: string;
}

export interface DbEconomyQuestTemplates {
  id: string;
  guild_id: string;
  quest_type: string;
  title: string;
  description: string;
  action_type: string;
  target_count: number;
  reward_currency: number;
  reward_xp: number;
  required_module: string | null;
  active: boolean;
  created_at: string;
}

export interface DbEconomyRecipes {
  id: string;
  guild_id: string;
  name: string;
  emoji: string;
  description: string | null;
  inputs: Json[];
  output_item_id: string | null;
  output_qty: number;
  cooldown_seconds: number;
  category: string;
  is_default: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbEconomyRoleIncome {
  id: string;
  guild_id: string;
  role_id: string;
  amount: number;
  interval_minutes: number;
  created_at: string;
}

export interface DbEconomyRoleIncomeClaims {
  guild_id: string;
  user_id: string;
  role_id: string;
  next_available_at: string;
  last_request_id: string;
  updated_at: string;
}

export interface DbEconomyRoleIncomeRequests {
  guild_id: string;
  user_id: string;
  request_id: string;
  result: Json;
  created_at: string;
}

export interface DbEconomyStreaks {
  guild_id: string;
  user_id: string;
  streak_type: string;
  current_streak: number;
  longest_streak: number;
  last_claimed_at: string | null;
  next_claim_at: string | null;
  created_at: string;
}

export interface DbEconomyTransactions {
  id: string;
  guild_id: string;
  user_id: string;
  type: string;
  amount: number;
  balance_after: number;
  description: string | null;
  metadata: Json | null;
  created_at: string;
  idempotency_key: string | null;
}

export interface DbEconomyTriviaQuestions {
  id: string;
  guild_id: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
  question: string;
  correct_answer: string;
  wrong_answers: string[];
  created_at: string;
  updated_at: string;
}

export interface DbEconomyUserAchievements {
  id: string;
  guild_id: string;
  user_id: string;
  achievement_id: string;
  unlocked_at: string;
}

export interface DbEconomyWallets {
  guild_id: string;
  user_id: string;
  wallet: number;
  bank: number;
  bank_max: number;
  passive: boolean;
  total_earned: number;
  total_spent: number;
  created_at: string;
  updated_at: string;
  suspended: boolean;
  suspended_at: string | null;
  suspended_reason: string | null;
}

export interface DbExternalWebhookDeliveries {
  id: string;
  relay_id: string;
  guild_id: string;
  idempotency_key: string | null;
  request_hash: string;
  event_label: string;
  content_preview: string;
  status: 'processing' | 'delivered' | 'failed' | 'duplicate' | 'retryable';
  attempt_count: number;
  discord_message_id: string | null;
  error: string | null;
  received_at: string;
  delivered_at: string | null;
}

export interface DbExternalWebhookRelays {
  id: string;
  guild_id: string;
  name: string;
  source_label: string;
  channel_id: string;
  token_hash: string;
  message_template: string;
  active: boolean;
  last_received_at: string | null;
  last_delivery_status: 'processing' | 'delivered' | 'failed' | 'duplicate' | 'retryable' | null;
  last_error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DbFeatureEmbedOverrides {
  guild_id: string;
  feature_key: 'welcome' | 'goodbye' | 'level_up' | 'moderation' | 'economy' | 'music' | 'tickets' | 'giveaways' | 'achievements';
  color: string | null;
  footer_text: string | null;
  footer_icon_url: string | null;
  thumbnail_url: string | null;
  author_name: string | null;
  updated_at: string;
}

export interface DbGuildRuntimeFeatures {
  guild_id: string;
  feature: string;
  boot_id: string;
  started_at: string;
}

export interface DbGuildTicketCounters {
  guild_id: string;
  last_number: number;
}

export interface DbHealthMetrics {
  id: string;
  guild_id: string;
  metric_type: string;
  value_ms: number;
  recorded_at: string;
}

export interface DbInstanceSettingsWriteLeases {
  scope: string;
  operation_id: string;
  leased_until: string;
  updated_at: string;
}

export interface DbLevelRewardDeliveries {
  id: string;
  guild_id: string;
  member_id: string;
  reward_id: string;
  delivery_kind: 'award' | 'expiry';
  reached_level: number;
  status: 'queued' | 'completed';
  action_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DbLevelUnlockConfigs {
  guild_id: string;
  feature_key: string;
  required_level: number;
  unlock_message: string | null;
}

export interface DbMemberErasures {
  guild_id: string;
  discord_id: string;
  erased_at: string;
}

export interface DbMemberFeatureUnlocks {
  guild_id: string;
  user_id: string;
  feature_key: string;
  unlocked_at: string;
}

export interface DbOnboardingFallbackIntents {
  id: string;
  guild_id: string;
  discord_id: string;
  member_role_id: string;
  timeout_minutes: number;
  correlation_id: string;
  role_add_authorized: boolean;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  attempt_count: number;
  attempt_token: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string;
  last_error: string | null;
  completed_at: string | null;
  completed_attempt_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbOnboardingSyncLeases {
  guild_id: string;
  request_id: string;
  lease_token: string;
  acquired_at: string;
  expires_at: string;
}

export interface DbPaymentRefunds {
  id: string;
  payment_id: string;
  order_id: string | null;
  guild_id: string | null;
  paypal_refund_id: string;
  event_type: string;
  amount_cents: number | null;
  currency: string | null;
  created_at: string;
  is_terminal_event_witness: boolean;
  paypal_resource_type: string | null;
}

export interface DbPaypalReconciliationState {
  singleton: boolean;
  state: 'running' | 'completed';
  owner_token: string | null;
  lease_expires_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface DbPollOptions {
  id: string;
  poll_id: string;
  label: string;
  emoji: string | null;
  sort_order: number;
}

export interface DbPollVotes {
  id: string;
  poll_id: string;
  option_id: string;
  user_id: string;
  voted_at: string;
}

export interface DbPolls {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  creator_user_id: string;
  title: string;
  description: string | null;
  status: 'active' | 'closed';
  allow_multiple: boolean;
  ends_at: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface DbPortalCancellationOperations {
  id: string;
  request_id: string;
  entitlement_id: string;
  order_id: string;
  guild_id: string;
  customer_id: string;
  paypal_subscription_id: string;
  cancellation_timing: 'immediate' | 'end-of-term';
  access_until: string;
  status: 'pending' | 'uncertain' | 'provider_confirmed' | 'completed' | 'failed';
  provider_http_status: number | null;
  provider_debug_id: string | null;
  provider_status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED' | null;
  reconciliation_state: 'not_required' | 'pending' | 'confirmed_cancelled' | 'confirmed_active' | 'unavailable';
  failure_code: 'provider_rejected' | 'provider_uncertain' | 'local_commit_failed' | null;
  created_at: string;
  updated_at: string;
  provider_confirmed_at: string | null;
  completed_at: string | null;
}

export interface DbPredictionBets {
  id: string;
  prediction_id: string;
  option_id: string;
  guild_id: string;
  user_id: string;
  amount: number;
  placed_at: string;
  payout: number | null;
}

export interface DbPredictionOptions {
  id: string;
  prediction_id: string;
  label: string;
  emoji: string | null;
  sort_order: number;
}

export interface DbPredictions {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  creator_user_id: string;
  title: string;
  status: 'open' | 'locked' | 'resolved' | 'cancelled';
  winning_option_id: string | null;
  total_pool: number;
  created_at: string;
  locked_at: string | null;
  resolved_at: string | null;
}

export interface DbProfileWriteOccurrences {
  id: string;
  guild_id: string;
  interaction_id: string;
  actor_id: string;
  target_id: string;
  field: 'title' | 'bio';
  outcome: 'claimed' | 'applied' | 'denied';
  created_at: string;
  settled_at: string | null;
}

export interface DbRuntimeLeases {
  lease_name: string;
  holder_id: string;
  session_id: string;
  runtime_mode: 'regular-local' | 'vps';
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export interface DbStarboardEntries {
  id: string;
  guild_id: string | null;
  source_channel_id: string;
  source_message_id: string;
  starboard_message_id: string | null;
  star_count: number;
  author_id: string;
  created_at: string;
  updated_at: string;
}

export interface DbSyncReports {
  id: string;
  guild_id: string;
  repaired_count: number;
  attention_count: number;
  total_drift: number;
  details: Json;
  created_at: string;
}

export interface DbTeamInvitations {
  id: string;
  guild_id: string;
  discord_id: string;
  role_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';
  delivery_mode: 'dm' | 'dashboard' | null;
  dm_status: 'queued' | 'sent' | 'failed' | 'skipped';
  invited_by: string | null;
  invited_by_name: string | null;
  accept_notified: boolean;
  expires_at: string;
  accepted_at: string | null;
  responded_at: string | null;
  created_at: string;
}

export interface DbTempRoleGrants {
  id: string;
  guild_id: string;
  user_id: string;
  role_id: string;
  expires_at: string;
  source: string;
  source_id: string | null;
  created_at: string;
  order_id: string | null;
  grant_status: 'pending' | 'applied' | 'removed';
  duration_seconds: number | null;
  remove_on_expiry: boolean;
  applied_at: string | null;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

export interface DbTutorialConfigs {
  guild_id: string;
  enabled: boolean;
  auto_trigger: boolean;
  trigger_mode: 'first_command' | 'join' | 'disabled';
  updated_at: string;
}

export interface DbTutorialProgress {
  guild_id: string;
  user_id: string;
  current_step: number;
  completed: boolean;
  started_at: string;
  completed_at: string | null;
}

export interface DbTutorialSteps {
  id: string;
  guild_id: string;
  step_order: number;
  title: string;
  description: string;
  image_url: string | null;
  built_in_key: string | null;
  enabled: boolean;
  created_at: string;
}
