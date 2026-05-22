-- V53 Post-Fix Audit — address all findings from the independent review.
--
-- C-1: economy_market_buy signature mismatch (CRITICAL)
--      The V53 migration created a 4-param overload that the TS code never
--      calls. The original V44 2-param function has no positive-quantity
--      guard. Fix: add the guard to the V44 function, create a dedicated
--      revert function for rollback paths, drop the dead V53 overload.
--
-- I-7: Drop the unused V53 4-param overload to clean up the namespace.

-- ============================================================
-- C-1 FIX, STEP 1: Add positive-quantity guard to the ACTIVE
-- 2-param economy_market_buy that the TS code actually calls.
-- ============================================================

CREATE OR REPLACE FUNCTION economy_market_buy(
  p_listing_id  UUID,
  p_quantity     INT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_remaining INT;
  v_actual    INT;
BEGIN
  -- V53-C1: Reject non-positive quantities (defense-in-depth;
  -- Discord command validation also enforces minValue=1).
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'economy_market_buy: quantity must be positive (got %)', p_quantity;
  END IF;

  SELECT remaining
    INTO v_remaining
    FROM public.economy_market_listings
   WHERE id = p_listing_id
     AND status = 'active'
   FOR UPDATE;

  IF NOT FOUND OR v_remaining <= 0 THEN
    RETURN 0;
  END IF;

  v_actual := LEAST(p_quantity, v_remaining);

  UPDATE public.economy_market_listings
     SET remaining = remaining - v_actual,
         status = CASE WHEN remaining - v_actual <= 0 THEN 'sold' ELSE 'active' END
   WHERE id = p_listing_id;

  RETURN v_actual;
END;
$$;

-- Permissions stay the same (already restricted to service_role from V44).

-- ============================================================
-- C-1 FIX, STEP 2: Create a dedicated revert function for
-- rollback paths. This restores listing quantity without the
-- positive-quantity guard (reverting requires negative offset).
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
  -- p_quantity is the number of items to RETURN to the listing.
  -- Must be positive (we're adding back, not removing).
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'economy_market_buy_revert: revert quantity must be positive (got %)', p_quantity;
  END IF;

  UPDATE public.economy_market_listings
     SET remaining = remaining + p_quantity,
         status = 'active',
         updated_at = NOW()
   WHERE id = p_listing_id;
END;
$$;

REVOKE ALL ON FUNCTION economy_market_buy_revert(UUID, INT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION economy_market_buy_revert(UUID, INT) TO service_role;

-- ============================================================
-- I-7 FIX: Drop the dead V53 4-param overload that is never
-- called. This prevents future confusion about which function
-- is active.
-- ============================================================

DROP FUNCTION IF EXISTS public.economy_market_buy(UUID, TEXT, INT, TEXT);

-- ============================================================
-- I-1 FIX: get_next_member_number — replace FOR UPDATE row lock
-- with pg_advisory_xact_lock.
--
-- The FOR UPDATE on `SELECT MAX(member_number) FROM guild_members
-- WHERE guild_id = …` locks EVERY row in that guild, blocking
-- unrelated reads during mass-join events.
--
-- An advisory lock keyed on the guild_id hash serializes only
-- concurrent member-number generation for the same guild, without
-- locking any actual rows.
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
  -- Serialize concurrent calls for the same guild via advisory lock.
  -- hashtext() returns INT4; advisory lock only needs a unique key.
  PERFORM pg_advisory_xact_lock(hashtext(p_guild_id));

  SELECT COALESCE(MAX(member_number), 0) + 1
  INTO v_next
  FROM public.guild_members
  WHERE guild_id = p_guild_id;

  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.get_next_member_number(TEXT) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.get_next_member_number(TEXT) TO service_role;
