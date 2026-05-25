-- V17 Behavioral Audit — Schema additions
-- Adds: automod priority, no_xp_role, anti-raid config, starboard, message logging, giveaway pause

-- 1. AutoMod rule priority/ordering (Item 6)
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;
COMMENT ON COLUMN automod_rules.priority IS 'Higher value = higher priority. Rules execute in descending priority order.';

-- 2. No-XP role on guild_config (Item 5)
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS no_xp_role_id TEXT;
COMMENT ON COLUMN guild_config.no_xp_role_id IS 'Role that blocks XP gain entirely when assigned.';

-- 3. Anti-raid config on guild_config (Item 4)
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS anti_raid_enabled BOOLEAN DEFAULT false;
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS anti_raid_join_threshold INTEGER DEFAULT 10;
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS anti_raid_join_window_seconds INTEGER DEFAULT 10;
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS anti_raid_account_age_days INTEGER DEFAULT 7;
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS anti_raid_action TEXT DEFAULT 'kick' CHECK (anti_raid_action IS NULL OR anti_raid_action IN ('kick', 'ban', 'lockdown'));
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS anti_raid_log_channel_id TEXT;

-- 4. Starboard config on guild_config (Item 7)
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS starboard_enabled BOOLEAN DEFAULT false;
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS starboard_channel_id TEXT;
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS starboard_threshold INTEGER DEFAULT 3;
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS starboard_emoji TEXT DEFAULT '⭐';
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS starboard_self_star BOOLEAN DEFAULT false;

-- 5. Starboard entries table (Item 7)
CREATE TABLE IF NOT EXISTS starboard_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  source_channel_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL UNIQUE,
  starboard_message_id TEXT,
  star_count INTEGER DEFAULT 0,
  author_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_starboard_entries_guild ON starboard_entries(guild_id);
CREATE INDEX IF NOT EXISTS idx_starboard_entries_message ON starboard_entries(source_message_id);

ALTER TABLE starboard_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON starboard_entries
  FOR ALL USING (true) WITH CHECK (true);

-- 6. Message log config on guild_config (Item 10)
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS message_log_channel_id TEXT;
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS message_log_enabled BOOLEAN DEFAULT false;

-- 7. Giveaway pause status (Item 12)
-- The existing status CHECK only allows 'active', 'ended', 'cancelled'.
-- We need to add 'paused' to the allowed values.
ALTER TABLE giveaways DROP CONSTRAINT IF EXISTS giveaways_status_check;
ALTER TABLE giveaways ADD CONSTRAINT giveaways_status_check
  CHECK (status IN ('active', 'ended', 'cancelled', 'paused'));

-- 8. Ticket feedback rating (Item 2)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS feedback_rating INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS feedback_comment TEXT;
COMMENT ON COLUMN tickets.feedback_rating IS '1-5 star rating from ticket creator after close.';

-- 9. Button roles table (Item 3) — extends existing reaction_roles concept
CREATE TABLE IF NOT EXISTS button_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  panel_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  label TEXT NOT NULL,
  emoji TEXT,
  style TEXT DEFAULT 'primary' CHECK (style IN ('primary', 'secondary', 'success', 'danger')),
  role_id TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  exclusive_group TEXT,
  require_role TEXT,
  require_level INTEGER,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_button_roles_guild ON button_roles(guild_id);
CREATE INDEX IF NOT EXISTS idx_button_roles_message ON button_roles(message_id);

ALTER TABLE button_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON button_roles
  FOR ALL USING (true) WITH CHECK (true);

-- 10. Ticket intake form config on ticket_panels (Item 1)
ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS intake_form_enabled BOOLEAN DEFAULT false;
ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS intake_form_fields JSONB DEFAULT '[]';
COMMENT ON COLUMN ticket_panels.intake_form_fields IS 'Array of {label, placeholder, style, required, min_length, max_length} for the intake modal.';

-- 11. Triggers for updated_at
CREATE TRIGGER update_starboard_entries_updated_at BEFORE UPDATE ON starboard_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_button_roles_updated_at BEFORE UPDATE ON button_roles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
