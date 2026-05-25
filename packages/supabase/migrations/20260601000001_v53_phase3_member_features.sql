-- V53 Phase 3 — Member-Facing Features
-- Findings: 3.2 (tutorial system), 3.3 (mydata RPC), 3.7 (embed overrides)

-- ─── 3.7: Per-Feature Embed Overrides ────────────────────
CREATE TABLE IF NOT EXISTS feature_embed_overrides (
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL CHECK (feature_key IN (
    'welcome', 'goodbye', 'level_up', 'moderation',
    'economy', 'music', 'tickets', 'giveaways', 'achievements'
  )),
  color TEXT,               -- hex color e.g. '#5865F2'
  footer_text TEXT,
  footer_icon_url TEXT,
  thumbnail_url TEXT,
  author_name TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (guild_id, feature_key)
);

ALTER TABLE feature_embed_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "feature_embed_overrides_guild_rls"
  ON feature_embed_overrides
  USING (guild_id = current_setting('app.guild_id', true));

-- ─── 3.2: Tutorial System ────────────────────────────────
CREATE TABLE IF NOT EXISTS tutorial_configs (
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT false,
  auto_trigger BOOLEAN DEFAULT false,
  trigger_mode TEXT DEFAULT 'first_command' CHECK (trigger_mode IN ('first_command', 'join', 'disabled')),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (guild_id)
);

ALTER TABLE tutorial_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tutorial_configs_guild_rls"
  ON tutorial_configs
  USING (guild_id = current_setting('app.guild_id', true));

CREATE TABLE IF NOT EXISTS tutorial_steps (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  step_order INT NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  image_url TEXT,
  built_in_key TEXT,  -- 'welcome', 'economy', 'leveling', 'music', 'tickets', 'fun' or NULL for custom
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE tutorial_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tutorial_steps_guild_rls"
  ON tutorial_steps
  USING (guild_id = current_setting('app.guild_id', true));

CREATE TABLE IF NOT EXISTS tutorial_progress (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  current_step INT DEFAULT 0,
  completed BOOLEAN DEFAULT false,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (guild_id, user_id)
);

ALTER TABLE tutorial_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tutorial_progress_guild_rls"
  ON tutorial_progress
  USING (guild_id = current_setting('app.guild_id', true));

-- ─── 3.5: Market search RPC ─────────────────────────────
CREATE OR REPLACE FUNCTION economy_market_search(
  p_guild_id TEXT,
  p_query TEXT DEFAULT NULL,
  p_min_price BIGINT DEFAULT NULL,
  p_max_price BIGINT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_rarity TEXT DEFAULT NULL,
  p_sort TEXT DEFAULT 'newest',
  p_page INT DEFAULT 0,
  p_page_size INT DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  seller_id TEXT,
  item_id UUID,
  item_name TEXT,
  item_description TEXT,
  item_rarity TEXT,
  item_category TEXT,
  price BIGINT,
  quantity INT,
  created_at TIMESTAMPTZ,
  total_count BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH filtered AS (
    SELECT
      ml.id,
      ml.seller_id,
      ml.item_id,
      ei.name AS item_name,
      ei.description AS item_description,
      ei.rarity AS item_rarity,
      ei.category AS item_category,
      ml.price,
      ml.quantity,
      ml.created_at
    FROM economy_market_listings ml
    JOIN economy_items ei ON ei.id = ml.item_id
    WHERE ml.guild_id = p_guild_id
      AND ml.status = 'active'
      AND (p_query IS NULL OR ei.name ILIKE '%' || p_query || '%')
      AND (p_min_price IS NULL OR ml.price >= p_min_price)
      AND (p_max_price IS NULL OR ml.price <= p_max_price)
      AND (p_category IS NULL OR ei.category = p_category)
      AND (p_rarity IS NULL OR ei.rarity = p_rarity)
  )
  SELECT
    f.id, f.seller_id, f.item_id, f.item_name, f.item_description,
    f.item_rarity, f.item_category, f.price, f.quantity, f.created_at,
    (SELECT count(*) FROM filtered)::BIGINT AS total_count
  FROM filtered f
  ORDER BY
    CASE WHEN p_sort = 'price_asc'  THEN f.price END ASC,
    CASE WHEN p_sort = 'price_desc' THEN f.price END DESC,
    CASE WHEN p_sort = 'name'       THEN f.item_name END ASC,
    CASE WHEN p_sort = 'newest'     THEN f.created_at END DESC
  LIMIT p_page_size
  OFFSET p_page * p_page_size;
END;
$$;
