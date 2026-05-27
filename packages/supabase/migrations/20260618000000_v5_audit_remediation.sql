-- ============================================================
-- V5 Audit Remediation
-- Addresses: §4.6, §5.5, §14.4, §5.3
--
-- 1. economy_market_buy: Reject buy-own-listing (§4.6 P2)
-- 2. Add index on license_keys.key_hash (§5.5 P2)
-- 3. Revoke default grants for authenticated on future tables (§5.3 P1)
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. economy_market_buy — Reject buy-own-listing (§4.6 P2)
--    Prevents a user from buying items from their own listing,
--    which could be used to manipulate transaction volumes or
--    exploit fee-free self-trades if a marketplace fee is ever added.
-- ────────────────────────────────────────────────────────────

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

  -- V5 Audit §4.6: Prevent buying from own listing
  IF v_listing.seller_id = p_buyer_id THEN
    RAISE EXCEPTION 'cannot buy from own listing';
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

REVOKE ALL ON FUNCTION public.economy_market_buy(UUID, TEXT, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_market_buy(UUID, TEXT, INT, TEXT) TO service_role;


-- ────────────────────────────────────────────────────────────
-- 2. Add index on license_keys.key_hash (§5.5 P2)
--    License validation looks up keys by hash. Without an index,
--    validation degrades linearly with key count.
-- ────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_license_keys_key_hash
  ON license_keys (key_hash);


-- ────────────────────────────────────────────────────────────
-- 3. Defensive: Ensure future tables default to service_role only (§5.3 P1)
--    The initial schema granted ALL to authenticated by default.
--    Phase A hardening revoked it, but ALTER DEFAULT PRIVILEGES
--    ensures any new table created after this point does NOT
--    auto-grant to authenticated.
-- ────────────────────────────────────────────────────────────

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon;

-- Ensure service_role retains full access on future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;


-- ────────────────────────────────────────────────────────────
-- 4. Member search RPC — Server-side JSONB filtering (§14.4 P1)
--    Replaces the full-JSONB-transfer-then-JS-filter approach.
--    For guilds with 10k+ members, transferring the entire members
--    array on every search request is a major bottleneck.
--    This RPC filters within PostgreSQL and returns only matches.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.search_guild_members(
  p_guild_id TEXT,
  p_query TEXT DEFAULT NULL,
  p_ids TEXT[] DEFAULT NULL,
  p_limit INT DEFAULT 25
)
RETURNS TABLE (
  member_id TEXT,
  username TEXT,
  display_name TEXT,
  avatar TEXT,
  is_bot BOOLEAN,
  total_matches BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_members JSONB;
  v_q TEXT;
BEGIN
  -- Fetch the JSONB blob once (in-DB, not over the wire)
  SELECT gs.members
  INTO v_members
  FROM public.guild_live_state gs
  WHERE gs.guild_id = p_guild_id;

  IF v_members IS NULL THEN
    RETURN;
  END IF;

  -- Clamp limit
  IF p_limit > 100 THEN
    p_limit := 100;
  END IF;

  -- Mode 1: Resolve specific IDs
  IF p_ids IS NOT NULL AND array_length(p_ids, 1) > 0 THEN
    RETURN QUERY
    SELECT
      (m.value ->> 'id')::TEXT,
      (m.value ->> 'username')::TEXT,
      (m.value ->> 'display_name')::TEXT,
      (m.value ->> 'avatar')::TEXT,
      COALESCE((m.value ->> 'bot')::BOOLEAN, FALSE),
      (SELECT count(*)::BIGINT FROM jsonb_array_elements(v_members) sub
       WHERE sub.value ->> 'id' = ANY(p_ids))
    FROM jsonb_array_elements(v_members) m
    WHERE m.value ->> 'id' = ANY(p_ids)
    LIMIT p_limit;
    RETURN;
  END IF;

  -- Mode 2: Search by name/ID
  v_q := LOWER(COALESCE(p_query, ''));

  IF v_q = '' THEN
    -- No filter — return first N
    RETURN QUERY
    SELECT
      (m.value ->> 'id')::TEXT,
      (m.value ->> 'username')::TEXT,
      (m.value ->> 'display_name')::TEXT,
      (m.value ->> 'avatar')::TEXT,
      COALESCE((m.value ->> 'bot')::BOOLEAN, FALSE),
      jsonb_array_length(v_members)::BIGINT
    FROM jsonb_array_elements(v_members) m
    LIMIT p_limit;
    RETURN;
  END IF;

  -- Text search within JSONB
  RETURN QUERY
  WITH matches AS (
    SELECT
      m.value,
      count(*) OVER () AS total
    FROM jsonb_array_elements(v_members) m
    WHERE LOWER(COALESCE(m.value ->> 'display_name', '')) LIKE '%' || v_q || '%'
       OR LOWER(COALESCE(m.value ->> 'username', '')) LIKE '%' || v_q || '%'
       OR m.value ->> 'id' = p_query
    LIMIT p_limit
  )
  SELECT
    (matches.value ->> 'id')::TEXT,
    (matches.value ->> 'username')::TEXT,
    (matches.value ->> 'display_name')::TEXT,
    (matches.value ->> 'avatar')::TEXT,
    COALESCE((matches.value ->> 'bot')::BOOLEAN, FALSE),
    matches.total
  FROM matches;
END;
$$;

REVOKE ALL ON FUNCTION public.search_guild_members(TEXT, TEXT, TEXT[], INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_guild_members(TEXT, TEXT, TEXT[], INT) TO service_role;
