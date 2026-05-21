-- V31 PR #46: Pets, Quests, Achievements, Prestige, Profiles
-- FAKE economy only — no connection to real-money store.

-- ── guild_config additions (~15 columns) ──────────────────

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS economy_pets_enabled            boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_pet_decay_rate          integer  NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS economy_pet_battle_enabled      boolean  NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS economy_pet_prestige_enabled    boolean  NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS economy_pet_feed_cost           integer  NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS economy_pet_train_cost          integer  NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS economy_quests_enabled          boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_daily_quest_count       integer  NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS economy_weekly_quest_count      integer  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS economy_quest_reward_base       integer  NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS economy_achievements_enabled    boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_prestige_enabled        boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_prestige_multiplier_pct integer  NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS economy_prestige_min_level      integer  NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS economy_prestige_min_net_worth  bigint   NOT NULL DEFAULT 1000000;

-- ── economy_pets ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_pets (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  guild_id    text    NOT NULL,
  user_id     text    NOT NULL,
  name        text    NOT NULL DEFAULT 'Pet',
  pet_type    text    NOT NULL DEFAULT 'hunting',
  level       integer NOT NULL DEFAULT 1,
  xp          integer NOT NULL DEFAULT 0,
  hunger      integer NOT NULL DEFAULT 100,
  happiness   integer NOT NULL DEFAULT 100,
  energy      integer NOT NULL DEFAULT 100,
  attack      integer NOT NULL DEFAULT 1,
  defense     integer NOT NULL DEFAULT 1,
  speed       integer NOT NULL DEFAULT 1,
  health      integer NOT NULL DEFAULT 10,
  prestige    integer NOT NULL DEFAULT 0,
  status      text    NOT NULL DEFAULT 'happy',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, user_id)
);

ALTER TABLE economy_pets ENABLE ROW LEVEL SECURITY;
CREATE POLICY economy_pets_guild ON economy_pets FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_economy_pets_guild ON economy_pets (guild_id);

-- ── economy_pet_battles ───────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_pet_battles (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  guild_id        text    NOT NULL,
  challenger_id   text    NOT NULL,
  defender_id     text    NOT NULL,
  winner_id       text,
  challenger_dmg  integer NOT NULL DEFAULT 0,
  defender_dmg    integer NOT NULL DEFAULT 0,
  reward          integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE economy_pet_battles ENABLE ROW LEVEL SECURITY;
CREATE POLICY economy_pet_battles_guild ON economy_pet_battles FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_economy_pet_battles_guild ON economy_pet_battles (guild_id);

-- ── economy_quest_templates ───────────────────────────────

CREATE TABLE IF NOT EXISTS economy_quest_templates (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  guild_id        text    NOT NULL,
  quest_type      text    NOT NULL DEFAULT 'daily',
  title           text    NOT NULL,
  description     text    NOT NULL DEFAULT '',
  action_type     text    NOT NULL DEFAULT 'generic',
  target_count    integer NOT NULL DEFAULT 1,
  reward_currency integer NOT NULL DEFAULT 100,
  reward_xp       integer NOT NULL DEFAULT 50,
  required_module text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE economy_quest_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY economy_quest_templates_guild ON economy_quest_templates FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_economy_quest_templates_guild ON economy_quest_templates (guild_id);

-- ── economy_quest_progress ────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_quest_progress (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  guild_id      text    NOT NULL,
  user_id       text    NOT NULL,
  template_id   uuid    NOT NULL REFERENCES economy_quest_templates(id) ON DELETE CASCADE,
  progress      integer NOT NULL DEFAULT 0,
  completed     boolean NOT NULL DEFAULT false,
  claimed       boolean NOT NULL DEFAULT false,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

ALTER TABLE economy_quest_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY economy_quest_progress_guild ON economy_quest_progress FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_economy_quest_progress_user ON economy_quest_progress (guild_id, user_id);

-- ── economy_achievement_defs ──────────────────────────────

CREATE TABLE IF NOT EXISTS economy_achievement_defs (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  guild_id        text    NOT NULL,
  name            text    NOT NULL,
  description     text    NOT NULL DEFAULT '',
  badge_emoji     text    NOT NULL DEFAULT '🏆',
  condition_type  text    NOT NULL DEFAULT 'generic',
  condition_value integer NOT NULL DEFAULT 1,
  reward_currency integer NOT NULL DEFAULT 0,
  reward_xp       integer NOT NULL DEFAULT 0,
  hidden          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE economy_achievement_defs ENABLE ROW LEVEL SECURITY;
CREATE POLICY economy_achievement_defs_guild ON economy_achievement_defs FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_economy_achievement_defs_guild ON economy_achievement_defs (guild_id);

-- ── economy_user_achievements ─────────────────────────────

CREATE TABLE IF NOT EXISTS economy_user_achievements (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  guild_id        text    NOT NULL,
  user_id         text    NOT NULL,
  achievement_id  uuid    NOT NULL REFERENCES economy_achievement_defs(id) ON DELETE CASCADE,
  unlocked_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, user_id, achievement_id)
);

ALTER TABLE economy_user_achievements ENABLE ROW LEVEL SECURITY;
CREATE POLICY economy_user_achievements_guild ON economy_user_achievements FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_economy_user_achievements_user ON economy_user_achievements (guild_id, user_id);

-- ── economy_prestige ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_prestige (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  guild_id        text    NOT NULL,
  user_id         text    NOT NULL,
  prestige_level  integer NOT NULL DEFAULT 0,
  total_resets    integer NOT NULL DEFAULT 0,
  multiplier_pct  integer NOT NULL DEFAULT 0,
  title           text,
  last_prestige   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, user_id)
);

ALTER TABLE economy_prestige ENABLE ROW LEVEL SECURITY;
CREATE POLICY economy_prestige_guild ON economy_prestige FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_economy_prestige_user ON economy_prestige (guild_id, user_id);

-- ── economy_profiles ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_profiles (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  guild_id      text    NOT NULL,
  user_id       text    NOT NULL,
  bio           text    NOT NULL DEFAULT '',
  title         text    NOT NULL DEFAULT '',
  badge_slots   text[]  NOT NULL DEFAULT '{}',
  favorite_pet  uuid    REFERENCES economy_pets(id) ON DELETE SET NULL,
  profile_views integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, user_id)
);

ALTER TABLE economy_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY economy_profiles_guild ON economy_profiles FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_economy_profiles_user ON economy_profiles (guild_id, user_id);
