-- V31 PR #44: Fishing, Adventures, Market
-- New guild_config columns + 6 new tables

-- ── guild_config additions ─────────────────────────────────
ALTER TABLE guild_config
  -- Fishing
  ADD COLUMN IF NOT EXISTS economy_fishing_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_fishing_cooldown_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS economy_fishing_junk_chance_pct integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS economy_fishing_treasure_chance_pct integer NOT NULL DEFAULT 5,
  -- Adventures
  ADD COLUMN IF NOT EXISTS economy_adventures_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_adventure_daily_limit integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS economy_adventure_ticket_cost integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS economy_adventure_max_scenes integer NOT NULL DEFAULT 10,
  -- Market
  ADD COLUMN IF NOT EXISTS economy_market_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_market_fee_pct integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS economy_market_listing_days integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS economy_market_max_listings integer NOT NULL DEFAULT 10;

-- ── economy_fish_species ───────────────────────────────────
CREATE TABLE IF NOT EXISTS economy_fish_species (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  name text NOT NULL,
  emoji text NOT NULL DEFAULT '🐟',
  rarity text NOT NULL DEFAULT 'common',
  min_weight numeric(8,2) NOT NULL DEFAULT 0.5,
  max_weight numeric(8,2) NOT NULL DEFAULT 5.0,
  base_price integer NOT NULL DEFAULT 10,
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE economy_fish_species ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fish_species_guild" ON economy_fish_species
  USING (guild_id = current_setting('app.guild_id', true))
  WITH CHECK (guild_id = current_setting('app.guild_id', true));

-- ── economy_fish_catches ───────────────────────────────────
CREATE TABLE IF NOT EXISTS economy_fish_catches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  species_id uuid NOT NULL REFERENCES economy_fish_species(id) ON DELETE CASCADE,
  weight numeric(8,2) NOT NULL,
  price_earned integer NOT NULL DEFAULT 0,
  caught_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fish_catches_user ON economy_fish_catches(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_fish_catches_species ON economy_fish_catches(guild_id, species_id);

ALTER TABLE economy_fish_catches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fish_catches_guild" ON economy_fish_catches
  USING (guild_id = current_setting('app.guild_id', true))
  WITH CHECK (guild_id = current_setting('app.guild_id', true));

-- ── economy_adventures ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS economy_adventures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  name text NOT NULL,
  emoji text NOT NULL DEFAULT '⚔️',
  description text,
  adventure_type text NOT NULL DEFAULT 'dungeon',
  difficulty text NOT NULL DEFAULT 'normal',
  min_scenes integer NOT NULL DEFAULT 5,
  max_scenes integer NOT NULL DEFAULT 10,
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE economy_adventures ENABLE ROW LEVEL SECURITY;
CREATE POLICY "adventures_guild" ON economy_adventures
  USING (guild_id = current_setting('app.guild_id', true))
  WITH CHECK (guild_id = current_setting('app.guild_id', true));

-- ── economy_adventure_scenes ───────────────────────────────
CREATE TABLE IF NOT EXISTS economy_adventure_scenes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adventure_id uuid NOT NULL REFERENCES economy_adventures(id) ON DELETE CASCADE,
  scene_index integer NOT NULL DEFAULT 0,
  text text NOT NULL,
  image_url text,
  choices jsonb NOT NULL DEFAULT '[]'::jsonb,
  loot jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_ending boolean NOT NULL DEFAULT false,
  ending_type text, -- 'success', 'death', 'partial'
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_adventure_scenes_adv ON economy_adventure_scenes(adventure_id, scene_index);

ALTER TABLE economy_adventure_scenes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "adventure_scenes_guild" ON economy_adventure_scenes
  USING (
    EXISTS (
      SELECT 1 FROM economy_adventures a
      WHERE a.id = economy_adventure_scenes.adventure_id
        AND a.guild_id = current_setting('app.guild_id', true)
    )
  );

-- ── economy_adventure_sessions ─────────────────────────────
CREATE TABLE IF NOT EXISTS economy_adventure_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  adventure_id uuid NOT NULL REFERENCES economy_adventures(id) ON DELETE CASCADE,
  current_scene_id uuid REFERENCES economy_adventure_scenes(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  loot_collected jsonb NOT NULL DEFAULT '[]'::jsonb,
  currency_collected integer NOT NULL DEFAULT 0,
  items_brought jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_id text,
  channel_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_adventure_sessions_user ON economy_adventure_sessions(guild_id, user_id, status);

ALTER TABLE economy_adventure_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "adventure_sessions_guild" ON economy_adventure_sessions
  USING (guild_id = current_setting('app.guild_id', true))
  WITH CHECK (guild_id = current_setting('app.guild_id', true));

-- ── economy_market_listings ────────────────────────────────
CREATE TABLE IF NOT EXISTS economy_market_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  seller_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES economy_items(id) ON DELETE CASCADE,
  item_name text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  remaining integer NOT NULL DEFAULT 1,
  price_per_unit integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_market_listings_guild ON economy_market_listings(guild_id, status);
CREATE INDEX IF NOT EXISTS idx_market_listings_seller ON economy_market_listings(guild_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_market_listings_item ON economy_market_listings(guild_id, item_id, status);

ALTER TABLE economy_market_listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "market_listings_guild" ON economy_market_listings
  USING (guild_id = current_setting('app.guild_id', true))
  WITH CHECK (guild_id = current_setting('app.guild_id', true));
