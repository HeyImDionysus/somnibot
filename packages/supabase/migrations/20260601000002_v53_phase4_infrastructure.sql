-- V53 Phase 4: Infrastructure & Engine Completeness
-- 4.1: Sync auto-repair reports
-- 4.2: Cross-feature bridge support tables
-- 4.3: Multi-guild (DB already scoped — only adding helper views)
-- 4.4: Bulk operations

-- ── 4.1: Sync reports table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  repaired_count integer NOT NULL DEFAULT 0,
  attention_count integer NOT NULL DEFAULT 0,
  total_drift integer NOT NULL DEFAULT 0,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_reports_guild_date ON sync_reports(guild_id, created_at DESC);

ALTER TABLE sync_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY sync_reports_guild ON sync_reports
  FOR ALL USING (guild_id = current_setting('app.guild_id', true));

-- ── 4.2: Level unlock configs ────────────────────────────────────
CREATE TABLE IF NOT EXISTS level_unlock_configs (
  guild_id text NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  required_level integer NOT NULL DEFAULT 1,
  unlock_message text,
  PRIMARY KEY (guild_id, feature_key)
);

ALTER TABLE level_unlock_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY level_unlock_configs_guild ON level_unlock_configs
  FOR ALL USING (guild_id = current_setting('app.guild_id', true));

-- Member feature unlocks (tracking what's been unlocked per user)
CREATE TABLE IF NOT EXISTS member_feature_unlocks (
  guild_id text NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  feature_key text NOT NULL,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id, feature_key)
);

ALTER TABLE member_feature_unlocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_feature_unlocks_guild ON member_feature_unlocks
  FOR ALL USING (guild_id = current_setting('app.guild_id', true));

-- Temporary role grants (for economy role purchases with duration)
CREATE TABLE IF NOT EXISTS temp_role_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'economy_purchase',
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_temp_role_grants_expiry ON temp_role_grants(expires_at);

ALTER TABLE temp_role_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY temp_role_grants_guild ON temp_role_grants
  FOR ALL USING (guild_id = current_setting('app.guild_id', true));

-- ── 4.4: Bulk member economy reset RPC ──────────────────────────

ALTER TABLE economy_market_listings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION bulk_reset_economy(
  p_guild_id text,
  p_member_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_affected integer;
BEGIN
  -- Reset wallets
  UPDATE economy_wallets
  SET wallet = 0, bank = 0, suspended = false
  WHERE guild_id = p_guild_id
    AND user_id = ANY(p_member_ids);

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  -- Cancel active market listings
  UPDATE economy_market_listings
  SET status = 'cancelled', cancelled_at = now()
  WHERE guild_id = p_guild_id
    AND seller_id = ANY(p_member_ids)
    AND status = 'active';

  -- Clear inventories
  DELETE FROM economy_inventories
  WHERE guild_id = p_guild_id
    AND user_id = ANY(p_member_ids);

  RETURN jsonb_build_object(
    'wallets_reset', v_affected,
    'member_count', array_length(p_member_ids, 1)
  );
END;
$$;
