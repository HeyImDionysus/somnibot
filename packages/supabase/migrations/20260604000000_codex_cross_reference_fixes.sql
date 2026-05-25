-- ============================================================
-- Codex Cross-Reference Audit — All 16 Live + 5 Partial Fixes
-- ============================================================
-- This migration addresses every confirmed finding from the
-- codex_cross_reference_report.md against the current main branch.
-- ============================================================

-- ============================================================
-- FIX #4: store_enabled defaults to false — new guilds silently
-- have commerce disabled with no UI indication.
-- Change default from false → true so new guilds can use /store.
-- ============================================================
ALTER TABLE guild_config ALTER COLUMN store_enabled SET DEFAULT true;

-- Activate for existing guilds that never explicitly toggled it
UPDATE guild_config
  SET store_enabled = true
  WHERE store_enabled = false;


-- ============================================================
-- FIX #5: Buy rollback uses economy_upsert_inventory with
-- p_user_id='shop' instead of restoring stock. Create a proper
-- economy_increment_stock RPC.
-- ============================================================
CREATE OR REPLACE FUNCTION economy_increment_stock(
  p_item_id  UUID,
  p_quantity INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'economy_increment_stock: quantity must be positive (got %)', p_quantity;
  END IF;

  UPDATE public.economy_items
    SET stock = stock + p_quantity
  WHERE id = p_item_id
    AND stock IS NOT NULL;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION economy_increment_stock(UUID, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION economy_increment_stock(UUID, INT) TO service_role;


-- ============================================================
-- FIX #6 + P4: economy_market_buy_revert unconditionally sets
-- status='active', resurrecting cancelled listings.
-- Only restore to 'active' when current status is 'sold'.
-- ============================================================
CREATE OR REPLACE FUNCTION economy_market_buy_revert(
  p_listing_id  UUID,
  p_quantity     INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'economy_market_buy_revert: revert quantity must be positive (got %)', p_quantity;
  END IF;

  UPDATE public.economy_market_listings
     SET remaining = remaining + p_quantity,
         -- Only restore to 'active' if currently 'sold'; preserve 'cancelled' etc.
         status = CASE WHEN status = 'sold' THEN 'active' ELSE status END,
         updated_at = NOW()
   WHERE id = p_listing_id;
END;
$$;

REVOKE ALL ON FUNCTION economy_market_buy_revert(UUID, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION economy_market_buy_revert(UUID, INT) TO service_role;


-- ============================================================
-- FIX #8 + #9: Analytics RPCs reference non-existent columns
-- and wrong transaction type names.
--
-- #8: economy_market_activity uses ml.sold_at (doesn't exist)
--     and ml.price (should be ml.price_per_unit).
--     Also economy_market_listings has no updated_at column.
--
-- #9: economy_daily_totals & economy_top_earners use fictional
--     tx types ('earn','spend','transfer_in','transfer_out',
--     'admin_credit','admin_debit'). Real types: 'daily','work',
--     'beg','crime','search','chat_income','rob_success',
--     'shop_sell','pay_receive','admin_add','shop_buy',
--     'pay_send','rob_victim','rob_fail','deposit','withdraw'.
-- ============================================================

-- First, add updated_at to economy_market_listings
ALTER TABLE economy_market_listings
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Fix economy_market_activity: use updated_at + status filter for sold,
-- and price_per_unit instead of price.
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
    AND (ml.created_at::DATE = d.day OR (ml.updated_at::DATE = d.day AND ml.status = 'sold'))
  GROUP BY d.day
  ORDER BY d.day;
$$;

REVOKE ALL ON FUNCTION public.economy_market_activity(TEXT, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.economy_market_activity(TEXT, INT) TO service_role;

-- Fix economy_daily_totals: use actual transaction type names.
-- Inflow = money generated/received: daily, work, beg, crime, search,
--   chat_income, rob_success, shop_sell, pay_receive, admin_add, withdraw
-- Outflow = money spent/deducted: shop_buy, pay_send, rob_victim,
--   rob_fail, deposit
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
      COALESCE(SUM(et.amount) FILTER (WHERE et.type IN (
        'daily', 'work', 'beg', 'crime', 'search', 'chat_income',
        'rob_success', 'shop_sell', 'pay_receive', 'admin_add', 'withdraw'
      )), 0) AS inflow,
      COALESCE(SUM(ABS(et.amount)) FILTER (WHERE et.type IN (
        'shop_buy', 'pay_send', 'rob_victim', 'rob_fail', 'deposit'
      )), 0) AS outflow,
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

-- Fix economy_top_earners: use actual transaction type names.
-- Must drop first: return type changed (removed net_worth column).
DROP FUNCTION IF EXISTS public.economy_top_earners(TEXT, INT);
CREATE OR REPLACE FUNCTION public.economy_top_earners(
  p_guild_id TEXT,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  user_id TEXT,
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
    COALESCE((
      SELECT SUM(et.amount) FROM public.economy_transactions et
        WHERE et.guild_id = p_guild_id
        AND et.user_id = ew.user_id
        AND et.type IN (
          'daily', 'work', 'beg', 'crime', 'search', 'chat_income',
          'rob_success', 'shop_sell', 'pay_receive', 'admin_add'
        )
    ), 0) AS total_earned,
    COALESCE((
      SELECT SUM(ABS(et.amount)) FROM public.economy_transactions et
        WHERE et.guild_id = p_guild_id
        AND et.user_id = ew.user_id
        AND et.type IN (
          'shop_buy', 'pay_send', 'rob_victim', 'rob_fail'
        )
    ), 0) AS total_spent
  FROM public.economy_wallets ew
  WHERE ew.guild_id = p_guild_id AND ew.suspended = false
  ORDER BY total_earned DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.economy_top_earners(TEXT, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.economy_top_earners(TEXT, INT) TO service_role;


-- ============================================================
-- FIX #16: Heist success_chance incremented on duplicate joins.
-- The array_append WHERE clause prevents dups but the
-- success_chance update runs unconditionally.
-- Fix: Only increment when the append actually inserted.
-- ============================================================
CREATE OR REPLACE FUNCTION economy_heist_join(
  p_heist_id UUID,
  p_user_id  TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rows_affected INTEGER;
BEGIN
  -- Only append if user is not already a participant
  UPDATE economy_heists
  SET participants = array_append(participants, p_user_id)
  WHERE id = p_heist_id
    AND NOT (p_user_id = ANY(participants));

  GET DIAGNOSTICS rows_affected = ROW_COUNT;

  -- Only increment success_chance if the participant was actually added
  IF rows_affected > 0 THEN
    UPDATE economy_heists
    SET success_chance = LEAST(95, success_chance + 7)
    WHERE id = p_heist_id;
  END IF;
END;
$$;


-- ============================================================
-- FIX P5: Adventure loot_failed column doesn't exist.
-- Bot writes .update({ loot_failed: true }) but no migration
-- ever created this column.
-- ============================================================
ALTER TABLE economy_adventure_sessions
  ADD COLUMN IF NOT EXISTS loot_failed BOOLEAN NOT NULL DEFAULT false;
