-- V53 Phase 5: Analytics, Performance & Testing
-- 5.1: Economy analytics RPCs
-- 5.2: Performance indexes

-- ═══════════════════════════════════════════════════════════
-- 5.2: Performance Indexes (do first — analytics queries need them)
-- ═══════════════════════════════════════════════════════════

-- Leaderboard composite index (net worth descending, skip suspended)
CREATE INDEX IF NOT EXISTS idx_econ_wallet_leaderboard
  ON economy_wallets(guild_id, ((wallet + bank)) DESC)
  WHERE suspended = false;

-- Transaction time-range queries
CREATE INDEX IF NOT EXISTS idx_econ_tx_guild_date
  ON economy_transactions(guild_id, created_at DESC);

-- Transaction type breakdown
CREATE INDEX IF NOT EXISTS idx_econ_tx_guild_type_date
  ON economy_transactions(guild_id, type, created_at DESC);

-- Market listing date + status queries
CREATE INDEX IF NOT EXISTS idx_econ_market_guild_status_date
  ON economy_market_listings(guild_id, status, created_at DESC);

-- Leaderboard XP index for levels
CREATE INDEX IF NOT EXISTS idx_members_guild_xp
  ON member_levels(guild_id, xp DESC);

-- ═══════════════════════════════════════════════════════════
-- 5.2: Paginated leaderboard RPC (replaces old economy_leaderboard)
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.economy_leaderboard(
  p_guild_id TEXT,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  user_id TEXT,
  wallet BIGINT,
  bank BIGINT,
  net_worth BIGINT,
  rank BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    ew.user_id,
    ew.wallet,
    ew.bank,
    (ew.wallet + ew.bank) AS net_worth,
    ROW_NUMBER() OVER (ORDER BY (ew.wallet + ew.bank) DESC) AS rank
  FROM public.economy_wallets ew
  WHERE ew.guild_id = p_guild_id
    AND ew.suspended = false
  ORDER BY (ew.wallet + ew.bank) DESC
  LIMIT p_limit
  OFFSET p_offset;
$$;

-- Keep existing permissions
REVOKE ALL ON FUNCTION public.economy_leaderboard(TEXT, INT, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.economy_leaderboard(TEXT, INT, INT) TO service_role;

-- ═══════════════════════════════════════════════════════════
-- 5.1: Economy Analytics RPCs
-- ═══════════════════════════════════════════════════════════

-- Daily wallet/bank totals (last N days)
CREATE OR REPLACE FUNCTION public.economy_daily_totals(
  p_guild_id TEXT,
  p_days INT DEFAULT 30
)
RETURNS TABLE (
  day DATE,
  total_wallet BIGINT,
  total_bank BIGINT,
  total_circulation BIGINT,
  active_users BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH date_series AS (
    SELECT generate_series(
      (CURRENT_DATE - (p_days || ' days')::INTERVAL)::DATE,
      CURRENT_DATE,
      '1 day'::INTERVAL
    )::DATE AS day
  ),
  daily AS (
    SELECT
      d.day,
      COALESCE(SUM(et.amount) FILTER (WHERE et.type IN ('earn', 'transfer_in', 'admin_credit')), 0) AS inflow,
      COALESCE(SUM(et.amount) FILTER (WHERE et.type IN ('spend', 'transfer_out', 'admin_debit')), 0) AS outflow,
      COUNT(DISTINCT et.user_id) AS active_users
    FROM date_series d
    LEFT JOIN public.economy_transactions et
      ON et.guild_id = p_guild_id
      AND et.created_at::DATE = d.day
    GROUP BY d.day
  )
  SELECT
    daily.day,
    0::BIGINT AS total_wallet,
    0::BIGINT AS total_bank,
    (daily.inflow - daily.outflow) AS total_circulation,
    daily.active_users
  FROM daily
  ORDER BY daily.day;
$$;

REVOKE ALL ON FUNCTION public.economy_daily_totals(TEXT, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.economy_daily_totals(TEXT, INT) TO service_role;

-- Transaction volume by type
CREATE OR REPLACE FUNCTION public.economy_tx_volume_by_type(
  p_guild_id TEXT,
  p_days INT DEFAULT 30
)
RETURNS TABLE (
  tx_type TEXT,
  tx_count BIGINT,
  total_amount BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    et.type AS tx_type,
    COUNT(*) AS tx_count,
    COALESCE(SUM(et.amount), 0) AS total_amount
  FROM public.economy_transactions et
  WHERE et.guild_id = p_guild_id
    AND et.created_at >= NOW() - (p_days || ' days')::INTERVAL
  GROUP BY et.type
  ORDER BY tx_count DESC;
$$;

REVOKE ALL ON FUNCTION public.economy_tx_volume_by_type(TEXT, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.economy_tx_volume_by_type(TEXT, INT) TO service_role;

-- Market activity (listings vs sold)
CREATE OR REPLACE FUNCTION public.economy_market_activity(
  p_guild_id TEXT,
  p_days INT DEFAULT 30
)
RETURNS TABLE (
  day DATE,
  listings_created BIGINT,
  listings_sold BIGINT,
  avg_price NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH date_series AS (
    SELECT generate_series(
      (CURRENT_DATE - (p_days || ' days')::INTERVAL)::DATE,
      CURRENT_DATE,
      '1 day'::INTERVAL
    )::DATE AS day
  )
  SELECT
    d.day,
    COUNT(ml.id) FILTER (WHERE ml.created_at::DATE = d.day) AS listings_created,
    COUNT(ml.id) FILTER (WHERE ml.updated_at::DATE = d.day AND ml.status = 'sold') AS listings_sold,
    COALESCE(AVG(ml.price_per_unit) FILTER (WHERE ml.updated_at::DATE = d.day AND ml.status = 'sold'), 0) AS avg_price
  FROM date_series d
  LEFT JOIN public.economy_market_listings ml
    ON ml.guild_id = p_guild_id
    AND (ml.created_at::DATE = d.day OR ml.updated_at::DATE = d.day)
  GROUP BY d.day
  ORDER BY d.day;
$$;

REVOKE ALL ON FUNCTION public.economy_market_activity(TEXT, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.economy_market_activity(TEXT, INT) TO service_role;

-- Top earners
CREATE OR REPLACE FUNCTION public.economy_top_earners(
  p_guild_id TEXT,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  user_id TEXT,
  net_worth BIGINT,
  total_earned BIGINT,
  total_spent BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    ew.user_id,
    (ew.wallet + ew.bank) AS net_worth,
    COALESCE((
      SELECT SUM(et.amount) FROM public.economy_transactions et
      WHERE et.guild_id = p_guild_id AND et.user_id = ew.user_id
        AND et.type IN ('earn', 'transfer_in', 'admin_credit')
    ), 0) AS total_earned,
    COALESCE((
      SELECT SUM(et.amount) FROM public.economy_transactions et
      WHERE et.guild_id = p_guild_id AND et.user_id = ew.user_id
        AND et.type IN ('spend', 'transfer_out', 'admin_debit')
    ), 0) AS total_spent
  FROM public.economy_wallets ew
  WHERE ew.guild_id = p_guild_id AND ew.suspended = false
  ORDER BY (ew.wallet + ew.bank) DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.economy_top_earners(TEXT, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.economy_top_earners(TEXT, INT) TO service_role;

-- Popular items by purchase count
CREATE OR REPLACE FUNCTION public.economy_popular_items(
  p_guild_id TEXT,
  p_days INT DEFAULT 30,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  item_id TEXT,
  item_name TEXT,
  purchase_count BIGINT,
  total_revenue BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    ei.id AS item_id,
    ei.name AS item_name,
    COUNT(et.id) AS purchase_count,
    COALESCE(SUM(et.amount), 0) AS total_revenue
  FROM public.economy_items ei
  LEFT JOIN public.economy_transactions et
    ON et.guild_id = p_guild_id
    AND et.metadata->>'item_id' = ei.id
    AND et.type = 'spend'
    AND et.created_at >= NOW() - (p_days || ' days')::INTERVAL
  WHERE ei.guild_id = p_guild_id
  GROUP BY ei.id, ei.name
  ORDER BY purchase_count DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.economy_popular_items(TEXT, INT, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.economy_popular_items(TEXT, INT, INT) TO service_role;

-- Feature participation rates
CREATE OR REPLACE FUNCTION public.economy_feature_participation(
  p_guild_id TEXT,
  p_days INT DEFAULT 7
)
RETURNS TABLE (
  feature TEXT,
  daily_active_users NUMERIC,
  total_sessions BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    et.type AS feature,
    ROUND(COUNT(DISTINCT et.user_id)::NUMERIC / GREATEST(p_days, 1), 1) AS daily_active_users,
    COUNT(*) AS total_sessions
  FROM public.economy_transactions et
  WHERE et.guild_id = p_guild_id
    AND et.created_at >= NOW() - (p_days || ' days')::INTERVAL
    AND et.type IN ('fishing', 'farming', 'gathering', 'crafting', 'heist', 'adventure', 'trivia')
  GROUP BY et.type
  ORDER BY total_sessions DESC;
$$;

REVOKE ALL ON FUNCTION public.economy_feature_participation(TEXT, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.economy_feature_participation(TEXT, INT) TO service_role;
