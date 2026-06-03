-- V36: Implement lottery cron, pet decay, quest wiring, heist system
-- ============================================================

-- ── New guild_config columns ─────────────────────────────
ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS economy_pet_decay_interval_hours integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS economy_pet_low_stat_threshold   integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS economy_pet_notify_owner         boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS economy_heist_min_participants   integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS economy_heist_max_participants   integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS economy_heist_join_window_secs   integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS economy_heist_cooldown_seconds   integer NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS economy_heist_base_payout        integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS economy_heist_success_base_pct   integer NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS economy_heist_entry_fee          integer NOT NULL DEFAULT 100;

-- ── economy_heists ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS economy_heists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id        text NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  initiator_id    text NOT NULL,
  status          text NOT NULL DEFAULT 'recruiting' CHECK (status IN ('recruiting', 'in_progress', 'success', 'failed', 'cancelled')),
  target_name     text NOT NULL DEFAULT 'The Vault',
  target_payout   integer NOT NULL DEFAULT 0,
  participants     text[] NOT NULL DEFAULT '{}',
  success_chance  integer NOT NULL DEFAULT 40,
  resolved_at     timestamptz,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_heists_guild ON economy_heists(guild_id);
CREATE INDEX IF NOT EXISTS idx_heists_active ON economy_heists(guild_id, status) WHERE status IN ('recruiting', 'in_progress');
ALTER TABLE economy_heists ENABLE ROW LEVEL SECURITY;
CREATE POLICY heists_guild_access ON economy_heists FOR ALL USING (true) WITH CHECK (true);

-- ── economy_heist_participants (detailed participant data) ─
CREATE TABLE IF NOT EXISTS economy_heist_participants (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  heist_id  uuid NOT NULL REFERENCES economy_heists(id) ON DELETE CASCADE,
  guild_id  text NOT NULL,
  user_id   text NOT NULL,
  role      text NOT NULL DEFAULT 'muscle',
  payout    integer NOT NULL DEFAULT 0,
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (heist_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_heist_participants_heist ON economy_heist_participants(heist_id);
ALTER TABLE economy_heist_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY heist_participants_access ON economy_heist_participants FOR ALL USING (true) WITH CHECK (true);

-- ── Add default quest templates for servers that enable quests ─
-- (Operators can customize/delete these from the dashboard)
-- We use a function to seed defaults when quests are first enabled
CREATE OR REPLACE FUNCTION seed_default_quest_templates(p_guild_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Only seed if no templates exist yet
  IF EXISTS (SELECT 1 FROM economy_quest_templates WHERE guild_id = p_guild_id LIMIT 1) THEN
    RETURN;
  END IF;

  INSERT INTO economy_quest_templates (guild_id, quest_type, title, description, action_type, target_count, reward_currency, reward_xp) VALUES
    -- Daily quests
    (p_guild_id, 'daily', 'Hard Worker', 'Use /work 3 times', 'work', 3, 150, 50),
    (p_guild_id, 'daily', 'Gone Fishing', 'Catch 2 fish', 'fish', 2, 200, 75),
    (p_guild_id, 'daily', 'Gather Round', 'Gather resources 3 times', 'gather', 3, 150, 50),
    (p_guild_id, 'daily', 'Crafty', 'Craft 1 item', 'craft', 1, 250, 100),
    (p_guild_id, 'daily', 'Risk Taker', 'Attempt a crime', 'crime', 1, 100, 25),
    (p_guild_id, 'daily', 'Active Member', 'Send 10 messages', 'chat', 10, 100, 50),
    (p_guild_id, 'daily', 'Shopper', 'Buy something from the shop', 'shop_buy', 1, 100, 25),
    -- Weekly quests
    (p_guild_id, 'weekly', 'Dedicated Worker', 'Use /work 15 times this week', 'work', 15, 1000, 300),
    (p_guild_id, 'weekly', 'Master Angler', 'Catch 15 fish this week', 'fish', 15, 1200, 400),
    (p_guild_id, 'weekly', 'Social Butterfly', 'Send 100 messages this week', 'chat', 100, 800, 250),
    (p_guild_id, 'weekly', 'Adventurer', 'Complete 5 adventures this week', 'adventure', 5, 1500, 500),
    (p_guild_id, 'weekly', 'Market Mogul', 'Complete 3 market trades this week', 'market_trade', 3, 1000, 300);
END;
$$;
