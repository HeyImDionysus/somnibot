-- ============================================================
-- SomniBot Initial Schema Migration
-- Architecture v4 — Full schema
-- ============================================================

-- ============================================================
-- CORE
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id TEXT UNIQUE NOT NULL,
  discord_username TEXT NOT NULL,
  avatar_url TEXT,
  email TEXT,
  is_owner BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_url TEXT,
  owner_discord_id TEXT NOT NULL,
  bot_joined_at TIMESTAMPTZ DEFAULT now(),
  setup_completed BOOLEAN DEFAULT false,
  setup_confirmed_at TIMESTAMPTZ,
  bot_role_id TEXT,
  bot_role_position INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY REFERENCES guild(id),
  -- Onboarding
  member_role_id TEXT,
  onboarding_enabled BOOLEAN DEFAULT true,
  interest_role_mapping JSONB DEFAULT '{}',
  returning_member_skip_welcome_dm BOOLEAN DEFAULT true,
  returning_member_restore_entitlements BOOLEAN DEFAULT true,
  returning_member_restore_levels BOOLEAN DEFAULT true,
  -- Welcome
  welcome_enabled BOOLEAN DEFAULT false,
  welcome_channel_id TEXT,
  welcome_message TEXT,
  welcome_card_enabled BOOLEAN DEFAULT true,
  welcome_card_background TEXT,
  welcome_dm_enabled BOOLEAN DEFAULT false,
  welcome_dm_message TEXT,
  welcome_auto_roles TEXT[] DEFAULT '{}',
  -- Goodbye
  goodbye_enabled BOOLEAN DEFAULT false,
  goodbye_channel_id TEXT,
  goodbye_message TEXT,
  -- Moderation
  mod_log_channel_id TEXT,
  escalation_chain JSONB DEFAULT '[]',
  infraction_expiry_days INTEGER DEFAULT 30,
  -- Ticketing (global settings)
  ticket_transcript_enabled BOOLEAN DEFAULT true,
  ticket_dm_transcript BOOLEAN DEFAULT false,
  -- Levels
  levels_enabled BOOLEAN DEFAULT false,
  xp_min INTEGER DEFAULT 15,
  xp_max INTEGER DEFAULT 25,
  xp_cooldown_seconds INTEGER DEFAULT 60,
  voice_xp_enabled BOOLEAN DEFAULT false,
  voice_xp_per_interval INTEGER DEFAULT 10,
  voice_xp_interval_minutes INTEGER DEFAULT 5,
  level_up_channel_id TEXT,
  level_up_message TEXT DEFAULT '🎉 {user} just reached **Level {level}**!',
  xp_multiplier_mode TEXT DEFAULT 'highest' CHECK (xp_multiplier_mode IN ('highest', 'additive')),
  xp_channel_mode TEXT DEFAULT 'blacklist' CHECK (xp_channel_mode IN ('blacklist', 'whitelist')),
  xp_channel_list TEXT[] DEFAULT '{}',
  rank_card_accent_color INTEGER DEFAULT 16716947,
  rank_card_background TEXT,
  -- Music
  music_enabled BOOLEAN DEFAULT true,
  dj_role_id TEXT,
  music_default_volume INTEGER DEFAULT 50,
  music_auto_leave_minutes INTEGER DEFAULT 5,
  music_auto_destroy_minutes INTEGER DEFAULT 30,
  -- Commerce
  store_enabled BOOLEAN DEFAULT false,
  store_channel_id TEXT,
  grace_period_days INTEGER DEFAULT 3,
  -- Stats channels
  stats_enabled BOOLEAN DEFAULT false,
  stats_category_id TEXT,
  stats_update_interval_minutes INTEGER DEFAULT 10,
  -- Temp channels
  temp_channels_enabled BOOLEAN DEFAULT false,
  -- Scheduled messages (global enable)
  scheduled_messages_enabled BOOLEAN DEFAULT true,
  -- Giveaways (global enable)
  giveaways_enabled BOOLEAN DEFAULT true,
  -- Sync
  sync_enabled BOOLEAN DEFAULT true,
  sync_interval_minutes INTEGER DEFAULT 15,
  sync_auto_repair BOOLEAN DEFAULT false,
  sync_auto_repair_everyone BOOLEAN DEFAULT true,
  --
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TEMPLATES & SERVER STRUCTURE
-- ============================================================

CREATE TABLE IF NOT EXISTS role_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('everyone', 'cosmetic', 'member', 'moderator', 'admin', 'custom')),
  description TEXT,
  permissions BIGINT NOT NULL,
  permission_details JSONB NOT NULL,
  is_builtin BOOLEAN DEFAULT false,
  base_template_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  description TEXT,
  target_channel_type TEXT NOT NULL CHECK (target_channel_type IN ('text', 'voice', 'stage', 'forum', 'announcement')),
  overrides JSONB NOT NULL,
  is_builtin BOOLEAN DEFAULT false,
  base_template_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS server_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  description TEXT,
  template_data JSONB NOT NULL,
  version INTEGER DEFAULT 1,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_desired_state (
  guild_id TEXT PRIMARY KEY REFERENCES guild(id),
  server_template_id UUID REFERENCES server_templates(id),
  roles JSONB NOT NULL DEFAULT '[]',
  channels JSONB NOT NULL DEFAULT '[]',
  permission_map JSONB NOT NULL DEFAULT '{}',
  applied_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  drift_detected BOOLEAN DEFAULT false,
  drift_details JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discord_id_map (
  guild_id TEXT REFERENCES guild(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('role', 'channel', 'category')),
  template_key TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, entity_type, template_key)
);

-- ============================================================
-- REACTION ROLES
-- ============================================================

CREATE TABLE IF NOT EXISTS reaction_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  role_id TEXT NOT NULL,
  exclusive_group TEXT,
  require_role TEXT,
  require_level INTEGER,
  max_per_group INTEGER,
  remove_on_unreact BOOLEAN DEFAULT true,
  log_actions BOOLEAN DEFAULT true,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(message_id, emoji)
);

-- ============================================================
-- MODERATION
-- ============================================================

CREATE TABLE IF NOT EXISTS automod_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('word_filter', 'link_filter', 'invite_filter', 'spam_filter', 'duplicate_filter', 'caps_filter', 'mention_spam', 'newline_spam')),
  enabled BOOLEAN DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}',
  action TEXT NOT NULL CHECK (action IN ('delete', 'warn', 'mute', 'kick', 'ban')),
  mute_duration_minutes INTEGER,
  exempt_roles TEXT[] DEFAULT '{}',
  exempt_channels TEXT[] DEFAULT '{}',
  log_to_mod_channel BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS infractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  member_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('warn', 'mute', 'kick', 'ban')),
  reason TEXT NOT NULL,
  automod_rule_id UUID REFERENCES automod_rules(id),
  duration_minutes INTEGER,
  active BOOLEAN DEFAULT true,
  pardoned BOOLEAN DEFAULT false,
  pardoned_by TEXT,
  pardoned_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TICKETING
-- ============================================================

CREATE TABLE IF NOT EXISTS ticket_panels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  panel_message JSONB NOT NULL,
  input_mode TEXT NOT NULL CHECK (input_mode IN ('buttons', 'dropdown')),
  ticket_types JSONB NOT NULL DEFAULT '[]',
  manager_roles TEXT[] DEFAULT '{}',
  open_category_id TEXT NOT NULL,
  closed_category_id TEXT,
  transcript_channel_id TEXT,
  dm_transcript_to_creator BOOLEAN DEFAULT false,
  max_open_per_user INTEGER DEFAULT 3,
  introduction_message TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  panel_id UUID REFERENCES ticket_panels(id),
  channel_id TEXT,
  ticket_number INTEGER NOT NULL,
  creator_id TEXT NOT NULL,
  type TEXT NOT NULL,
  claimed_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'closed', 'deleted')),
  closed_by TEXT,
  close_reason TEXT,
  transcript_path TEXT,
  message_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE SEQUENCE ticket_number_seq START 1;

-- ============================================================
-- AUTOMATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL,
  trigger_config JSONB DEFAULT '{}',
  -- Scope filters (v4) — empty arrays = full server scope
  target_user_ids TEXT[] DEFAULT '{}',
  target_channel_ids TEXT[] DEFAULT '{}',
  exclude_user_ids TEXT[] DEFAULT '{}',
  exclude_channel_ids TEXT[] DEFAULT '{}',
  conditions JSONB NOT NULL DEFAULT '[]',
  actions JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN DEFAULT true,
  execution_count INTEGER DEFAULT 0,
  last_executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID REFERENCES automations(id) ON DELETE CASCADE,
  guild_id TEXT REFERENCES guild(id),
  triggered_by TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  conditions_passed BOOLEAN NOT NULL,
  actions_executed INTEGER DEFAULT 0,
  actions_failed INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- CUSTOM COMMANDS
-- ============================================================

CREATE TABLE IF NOT EXISTS custom_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  actions JSONB NOT NULL DEFAULT '[]',
  allowed_roles TEXT[] DEFAULT '{}',
  allowed_channels TEXT[] DEFAULT '{}',
  denied_roles TEXT[] DEFAULT '{}',
  denied_channels TEXT[] DEFAULT '{}',
  cooldown_seconds INTEGER DEFAULT 0,
  ephemeral BOOLEAN DEFAULT false,
  enabled BOOLEAN DEFAULT true,
  discord_command_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(guild_id, name)
);

-- ============================================================
-- EMBED BUILDER
-- ============================================================

CREATE TABLE IF NOT EXISTS embed_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  color INTEGER,
  fields JSONB DEFAULT '[]',
  image_url TEXT,
  thumbnail_url TEXT,
  footer_text TEXT,
  footer_icon_url TEXT,
  author_name TEXT,
  author_url TEXT,
  author_icon_url TEXT,
  include_timestamp BOOLEAN DEFAULT false,
  use_components_v2 BOOLEAN DEFAULT false,
  components_v2_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- LEVELS & XP
-- ============================================================

CREATE TABLE IF NOT EXISTS member_levels (
  guild_id TEXT REFERENCES guild(id),
  member_id TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  voice_minutes INTEGER DEFAULT 0,
  last_xp_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (guild_id, member_id)
);

CREATE TABLE IF NOT EXISTS level_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  level INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  remove_at_level INTEGER,
  announce BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(guild_id, level, role_id)
);

CREATE TABLE IF NOT EXISTS xp_multipliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  role_id TEXT NOT NULL,
  multiplier NUMERIC NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(guild_id, role_id)
);

-- Per-user rank card customization (v4)
CREATE TABLE IF NOT EXISTS member_rank_settings (
  guild_id TEXT REFERENCES guild(id),
  member_id TEXT NOT NULL,
  background_url TEXT,
  background_storage_path TEXT,
  accent_color INTEGER,
  progress_bar_color INTEGER,
  overlay_opacity NUMERIC DEFAULT 0.7,
  font_color_override TEXT CHECK (font_color_override IN ('light', 'dark')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (guild_id, member_id)
);

-- ============================================================
-- TEMPORARY VOICE CHANNELS
-- ============================================================

CREATE TABLE IF NOT EXISTS temp_channel_hubs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  hub_channel_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  naming_format TEXT DEFAULT '{username}''s Channel',
  default_user_limit INTEGER DEFAULT 0,
  default_bitrate INTEGER DEFAULT 64000,
  keep_alive_minutes INTEGER DEFAULT 1,
  allow_text_channel BOOLEAN DEFAULT false,
  moderator_roles TEXT[] DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS active_temp_channels (
  channel_id TEXT PRIMARY KEY,
  text_channel_id TEXT,
  guild_id TEXT REFERENCES guild(id),
  hub_id UUID REFERENCES temp_channel_hubs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- STATISTICS CHANNELS
-- ============================================================

CREATE TABLE IF NOT EXISTS stats_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  channel_id TEXT,
  stat_type TEXT NOT NULL CHECK (stat_type IN ('total_members', 'online_members', 'bot_count', 'role_count', 'channel_count', 'premium_members', 'active_tickets', 'total_xp_earned', 'highest_level', 'custom_counter')),
  stat_config JSONB DEFAULT '{}',
  name_format TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  last_value TEXT,
  last_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- SCHEDULED MESSAGES
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message TEXT,
  embed_config_id UUID REFERENCES embed_configs(id),
  cron_expression TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  max_sends INTEGER,
  current_sends INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- COMMERCE
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('one_time', 'subscription')),
  delivery_type TEXT NOT NULL CHECK (delivery_type IN ('file', 'link', 'access_pass', 'mixed')),
  paypal_product_id TEXT,
  price_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  granted_role_ids TEXT[] DEFAULT '{}',
  granted_channel_ids TEXT[] DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  file_path TEXT,
  external_url TEXT,
  file_size_bytes BIGINT,
  mime_type TEXT,
  download_count INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  paypal_plan_id TEXT,
  interval_unit TEXT NOT NULL CHECK (interval_unit IN ('DAY', 'WEEK', 'MONTH', 'YEAR')),
  interval_count INTEGER DEFAULT 1,
  price_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  trial_days INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  guild_id TEXT REFERENCES guild(id),
  discord_id TEXT NOT NULL,
  discord_username TEXT NOT NULL,
  paypal_customer_id TEXT,
  email TEXT,
  first_purchase_at TIMESTAMPTZ,
  total_spent_cents INTEGER DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(discord_id, guild_id)
);

CREATE TABLE IF NOT EXISTS promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('percentage', 'fixed_amount')),
  value NUMERIC NOT NULL,
  coupon_code TEXT,
  applies_to_product_ids UUID[] DEFAULT '{}',
  applies_to_plan_ids UUID[] DEFAULT '{}',
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  max_uses INTEGER,
  current_uses INTEGER DEFAULT 0,
  min_purchase_cents INTEGER,
  first_purchase_only BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number TEXT UNIQUE NOT NULL,
  customer_id UUID REFERENCES customers(id),
  guild_id TEXT REFERENCES guild(id),
  product_id UUID REFERENCES products(id),
  plan_id UUID REFERENCES plans(id),
  paypal_order_id TEXT,
  paypal_subscription_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  discount_cents INTEGER DEFAULT 0,
  promotion_id UUID REFERENCES promotions(id),
  source TEXT DEFAULT 'purchase' CHECK (source IN ('purchase', 'giveaway', 'manual', 'automation')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'refunded', 'disputed', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS license_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  customer_id UUID REFERENCES customers(id),
  product_id UUID REFERENCES products(id),
  guild_id TEXT REFERENCES guild(id),
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  key_suffix TEXT NOT NULL,
  bound_discord_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_activation', 'active', 'expired', 'revoked', 'suspended')),
  activated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  guild_id TEXT REFERENCES guild(id),
  product_id UUID REFERENCES products(id),
  plan_id UUID REFERENCES plans(id),
  license_key_id UUID REFERENCES license_keys(id),
  order_id UUID REFERENCES orders(id),
  type TEXT NOT NULL CHECK (type IN ('one_time', 'subscription')),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'suspended', 'cancelled', 'pending', 'grace_period')),
  source TEXT DEFAULT 'purchase' CHECK (source IN ('purchase', 'giveaway', 'manual', 'automation')),
  granted_role_ids TEXT[] DEFAULT '{}',
  granted_channel_ids TEXT[] DEFAULT '{}',
  grace_period_ends_at TIMESTAMPTZ,
  starts_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- GIVEAWAYS (after products table for FK)
-- ============================================================

CREATE TABLE IF NOT EXISTS giveaways (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  channel_id TEXT NOT NULL,
  message_id TEXT,
  prize TEXT NOT NULL,
  prize_product_id UUID REFERENCES products(id),
  prize_license_count INTEGER DEFAULT 1,
  winner_count INTEGER NOT NULL DEFAULT 1,
  ends_at TIMESTAMPTZ NOT NULL,
  required_role_id TEXT,
  required_level INTEGER,
  required_entitlement_product_id UUID,
  entries TEXT[] DEFAULT '{}',
  winners TEXT[] DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('active', 'ended', 'cancelled')),
  ended_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- UNIVERSAL LICENSING (v4)
-- ============================================================

CREATE TABLE IF NOT EXISTS product_license_config (
  product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  license_mode TEXT NOT NULL DEFAULT 'portal_only' CHECK (license_mode IN ('portal_only', 'portal_watermark', 'embedded', 'access_pass')),
  max_devices INTEGER DEFAULT 3,
  heartbeat_interval_seconds INTEGER DEFAULT 300,
  offline_grace_period_seconds INTEGER DEFAULT 86400,
  feature_flags TEXT[] DEFAULT '{}',
  tier TEXT,
  watermark_config JSONB,
  require_discord_guild_membership BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS license_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key_id UUID REFERENCES license_keys(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL,
  device_name TEXT,
  app_version TEXT,
  ip_address TEXT,
  active BOOLEAN DEFAULT true,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  deactivated_at TIMESTAMPTZ,
  deactivation_reason TEXT CHECK (deactivation_reason IN ('user_deactivated', 'admin_revoked', 'device_limit', 'heartbeat_timeout', 'entitlement_revoked')),
  UNIQUE(license_key_id, device_fingerprint)
);

CREATE TABLE IF NOT EXISTS license_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key_id UUID REFERENCES license_keys(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  device_fingerprint TEXT,
  result TEXT NOT NULL CHECK (result IN ('valid', 'invalid_key', 'expired', 'suspended', 'revoked', 'over_device_limit', 'product_mismatch')),
  ip_address TEXT,
  app_version TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- PAYMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  customer_id UUID REFERENCES customers(id),
  guild_id TEXT REFERENCES guild(id),
  paypal_payment_id TEXT UNIQUE,
  paypal_event_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  status TEXT NOT NULL CHECK (status IN ('completed', 'refunded', 'reversed', 'pending', 'failed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- AUDIT & OPERATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  timestamp TIMESTAMPTZ DEFAULT now(),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB DEFAULT '{}',
  before_state JSONB,
  after_state JSONB,
  success BOOLEAN DEFAULT true,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT now(),
  payload JSONB NOT NULL,
  result TEXT CHECK (result IN ('success', 'error', 'duplicate')),
  error_details TEXT
);

-- Order and ticket number sequences
CREATE SEQUENCE order_number_seq START 1;
-- ticket_number_seq already created above with tickets table

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_audit_guild_time ON audit_logs(guild_id, timestamp DESC);
CREATE INDEX idx_audit_action ON audit_logs(action);
CREATE INDEX idx_entitlements_customer ON entitlements(customer_id);
CREATE INDEX idx_entitlements_status ON entitlements(guild_id, status);
CREATE INDEX idx_license_keys_hash ON license_keys(key_hash);
CREATE INDEX idx_license_keys_discord ON license_keys(bound_discord_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_number ON orders(order_number);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_reaction_roles_message ON reaction_roles(message_id);
CREATE INDEX idx_reaction_roles_guild ON reaction_roles(guild_id);
CREATE INDEX idx_customers_discord ON customers(discord_id);
CREATE INDEX idx_webhook_events_type ON webhook_events(event_type);
CREATE INDEX idx_product_files_product ON product_files(product_id);
CREATE INDEX idx_infractions_member ON infractions(guild_id, member_id);
CREATE INDEX idx_infractions_active ON infractions(guild_id, active);
CREATE INDEX idx_tickets_guild ON tickets(guild_id, status);
CREATE INDEX idx_tickets_creator ON tickets(creator_id);
CREATE INDEX idx_member_levels_guild ON member_levels(guild_id, level DESC);
CREATE INDEX idx_member_levels_xp ON member_levels(guild_id, xp DESC);
CREATE INDEX idx_automations_guild ON automations(guild_id, enabled);
CREATE INDEX idx_automation_executions_time ON automation_executions(automation_id, created_at DESC);
CREATE INDEX idx_giveaways_active ON giveaways(guild_id, status);
CREATE INDEX idx_custom_commands_guild ON custom_commands(guild_id, enabled);
CREATE INDEX idx_scheduled_messages_guild ON scheduled_messages(guild_id, active);
-- v4 indexes
CREATE INDEX idx_license_sessions_key ON license_sessions(license_key_id, active);
CREATE INDEX idx_license_sessions_fingerprint ON license_sessions(device_fingerprint);
CREATE INDEX idx_license_validations_key ON license_validations(license_key_id, created_at DESC);
CREATE INDEX idx_license_validations_product ON license_validations(product_id, created_at DESC);
CREATE INDEX idx_product_license_config_mode ON product_license_config(license_mode);
CREATE INDEX idx_member_rank_settings_guild ON member_rank_settings(guild_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE server_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_desired_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_id_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE reaction_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE automod_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE infractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_panels ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE embed_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE level_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE xp_multipliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE temp_channel_hubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_temp_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE stats_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE giveaways ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_license_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_rank_settings ENABLE ROW LEVEL SECURITY;

-- Owner has full access on all guild-scoped tables
-- This policy checks if the authenticated user is the owner
CREATE POLICY "owner_full_access" ON guild
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON guild_config
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON role_templates
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON channel_templates
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON server_templates
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON guild_desired_state
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON discord_id_map
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON reaction_roles
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON automod_rules
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON infractions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON ticket_panels
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON tickets
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON automations
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON automation_executions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON custom_commands
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON embed_configs
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON member_levels
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON level_rewards
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON xp_multipliers
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON member_rank_settings
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON temp_channel_hubs
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON active_temp_channels
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON stats_channels
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON scheduled_messages
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON giveaways
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON products
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON product_files
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON plans
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON customers
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON orders
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON license_keys
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON entitlements
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON promotions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON payments
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON audit_logs
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON webhook_events
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON product_license_config
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON license_sessions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

CREATE POLICY "owner_full_access" ON license_validations
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

-- Users can read their own profile
CREATE POLICY "users_read_own" ON users
  FOR SELECT USING (id = auth.uid());

-- Users can update their own profile
CREATE POLICY "users_update_own" ON users
  FOR UPDATE USING (id = auth.uid());

-- Members can read their own level data
CREATE POLICY "members_read_own_levels" ON member_levels
  FOR SELECT USING (
    member_id = (SELECT discord_id FROM users WHERE id = auth.uid())
  );

-- Members can read/update their own rank settings
CREATE POLICY "members_manage_own_rank" ON member_rank_settings
  FOR ALL USING (
    member_id = (SELECT discord_id FROM users WHERE id = auth.uid())
  );

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at trigger to all tables with updated_at column
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_guild_updated_at BEFORE UPDATE ON guild
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_guild_config_updated_at BEFORE UPDATE ON guild_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_role_templates_updated_at BEFORE UPDATE ON role_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_channel_templates_updated_at BEFORE UPDATE ON channel_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_server_templates_updated_at BEFORE UPDATE ON server_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_guild_desired_state_updated_at BEFORE UPDATE ON guild_desired_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_automod_rules_updated_at BEFORE UPDATE ON automod_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_ticket_panels_updated_at BEFORE UPDATE ON ticket_panels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_automations_updated_at BEFORE UPDATE ON automations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_custom_commands_updated_at BEFORE UPDATE ON custom_commands
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_embed_configs_updated_at BEFORE UPDATE ON embed_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_member_levels_updated_at BEFORE UPDATE ON member_levels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_member_rank_settings_updated_at BEFORE UPDATE ON member_rank_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_temp_channel_hubs_updated_at BEFORE UPDATE ON temp_channel_hubs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_stats_channels_updated_at BEFORE UPDATE ON stats_channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_scheduled_messages_updated_at BEFORE UPDATE ON scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_plans_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_license_keys_updated_at BEFORE UPDATE ON license_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_entitlements_updated_at BEFORE UPDATE ON entitlements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_promotions_updated_at BEFORE UPDATE ON promotions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_product_license_config_updated_at BEFORE UPDATE ON product_license_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Grants — ensure service_role and authenticated can access tables
-- ============================================================

GRANT USAGE ON SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO anon;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
