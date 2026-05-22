-- V53 Audit Fixes
-- M-2: economy_leaderboard RPC for accurate server-side net_worth ranking
-- L-2: economy_market_buy positive quantity guard
-- L-6: get_next_member_number FOR UPDATE lock

-- ============================================================
-- M-2: Server-side leaderboard RPC
-- Computes wallet + bank as net_worth, sorts and limits server-side
-- so we don't miss top users when the table is large.
-- ============================================================

CREATE OR REPLACE FUNCTION public.economy_leaderboard(
  p_guild_id TEXT,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  user_id TEXT,
  wallet BIGINT,
  bank BIGINT,
  net_worth BIGINT
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
    (ew.wallet + ew.bank) AS net_worth
  FROM public.economy_wallets ew
  WHERE ew.guild_id = p_guild_id
  ORDER BY (ew.wallet + ew.bank) DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.economy_leaderboard(TEXT, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.economy_leaderboard(TEXT, INT) TO service_role;

-- ============================================================
-- L-2: Guard against negative quantity in economy_market_buy
-- Prevents any caller from using negative quantities to inflate listings.
-- ============================================================

CREATE OR REPLACE FUNCTION public.economy_market_buy(
  p_listing_id UUID,
  p_buyer_id TEXT,
  p_quantity INT,
  p_guild_id TEXT
)
RETURNS TABLE (
  seller_id TEXT,
  item_id UUID,
  item_name TEXT,
  price_per_unit BIGINT,
  bought_qty INT,
  remaining INT,
  listing_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_listing RECORD;
BEGIN
  -- V53-L2: Reject non-positive quantities
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be positive';
  END IF;

  SELECT l.*
  INTO v_listing
  FROM public.economy_market_listings l
  WHERE l.id = p_listing_id
    AND l.guild_id = p_guild_id
    AND l.status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Clamp to available
  IF p_quantity > v_listing.remaining THEN
    p_quantity := v_listing.remaining;
  END IF;

  -- Update remaining and status
  UPDATE public.economy_market_listings
  SET remaining = remaining - p_quantity,
      status = CASE WHEN remaining - p_quantity <= 0 THEN 'sold' ELSE 'active' END,
      updated_at = NOW()
  WHERE id = p_listing_id;

  RETURN QUERY SELECT
    v_listing.seller_id,
    v_listing.item_id,
    v_listing.item_name,
    v_listing.price_per_unit,
    p_quantity AS bought_qty,
    (v_listing.remaining - p_quantity) AS remaining,
    CASE WHEN v_listing.remaining - p_quantity <= 0 THEN 'sold'::TEXT ELSE 'active'::TEXT END AS listing_status;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_market_buy(UUID, TEXT, INT, TEXT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.economy_market_buy(UUID, TEXT, INT, TEXT) TO service_role;

-- ============================================================
-- L-6: get_next_member_number — add FOR UPDATE to prevent race
-- Without FOR UPDATE, two concurrent calls could read the same MAX
-- and both try to insert the same number.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_next_member_number(
  p_guild_id TEXT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_next INT;
BEGIN
  -- Lock the rows for this guild to prevent concurrent reads of the same MAX
  SELECT COALESCE(MAX(member_number), 0) + 1
  INTO v_next
  FROM public.guild_members
  WHERE guild_id = p_guild_id
  FOR UPDATE;

  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.get_next_member_number(TEXT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.get_next_member_number(TEXT) TO service_role;
