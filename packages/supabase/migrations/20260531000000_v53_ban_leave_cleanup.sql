-- ============================================================
-- V53 Phase 1.6: Ban/leave economy data cleanup
-- ============================================================
-- When a member is banned or leaves, their active economy
-- participation must be suspended to prevent orphaned state:
--   - Cancel active market listings (refund items to seller)
--   - Forfeit active heist participation
--   - Suspend wallet (prevent /rob, /heist targeting absent users)
--
-- Adds a `suspended` flag to economy_wallets and an RPC that
-- atomically cleans up all economy state for a departing member.
-- ============================================================

-- ── 1. Add suspended column to economy_wallets ──────────────

ALTER TABLE economy_wallets
  ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;

ALTER TABLE economy_wallets
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

ALTER TABLE economy_wallets
  ADD COLUMN IF NOT EXISTS suspended_reason text;

COMMENT ON COLUMN economy_wallets.suspended IS
  'True when member is banned/left — blocks economy commands and targeting';

-- ── 2. Index for quickly finding suspended wallets ──────────

CREATE INDEX IF NOT EXISTS idx_economy_wallets_suspended
  ON economy_wallets (guild_id, suspended)
  WHERE suspended = true;

-- ── 3. cleanup_member_economy() RPC ─────────────────────────
-- Atomically: cancel listings, forfeit heists, suspend wallet.
-- Returns a summary of what was cleaned up.

CREATE OR REPLACE FUNCTION public.cleanup_member_economy(
  p_guild_id text,
  p_user_id  text,
  p_reason   text DEFAULT 'left'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listings_cancelled int := 0;
  v_heists_forfeited   int := 0;
  v_wallet_suspended   boolean := false;
  v_items_refunded     jsonb := '[]'::jsonb;
  v_listing            record;
BEGIN
  -- ── Cancel active market listings and refund items ────────
  FOR v_listing IN
    SELECT id, item_id, remaining
    FROM economy_market_listings
    WHERE guild_id = p_guild_id
      AND seller_id = p_user_id
      AND status = 'active'
  LOOP
    -- Cancel the listing
    UPDATE economy_market_listings
    SET status = 'cancelled'
    WHERE id = v_listing.id;

    -- Return unsold items to inventory
    INSERT INTO economy_inventory (guild_id, user_id, item_id, quantity)
    VALUES (p_guild_id, p_user_id, v_listing.item_id, v_listing.remaining)
    ON CONFLICT (guild_id, user_id, item_id)
    DO UPDATE SET quantity = economy_inventory.quantity + EXCLUDED.quantity,
                  updated_at = now();

    v_listings_cancelled := v_listings_cancelled + 1;
    v_items_refunded := v_items_refunded || jsonb_build_object(
      'item_id', v_listing.item_id,
      'quantity', v_listing.remaining
    );
  END LOOP;

  -- ── Forfeit active heist participation ────────────────────
  -- Remove from recruiting/in_progress heists
  UPDATE economy_heist_participants
  SET payout = 0
  WHERE guild_id = p_guild_id
    AND user_id = p_user_id
    AND heist_id IN (
      SELECT id FROM economy_heists
      WHERE guild_id = p_guild_id
        AND status IN ('recruiting', 'in_progress')
    );

  -- Also remove from the participants array on the heist itself
  UPDATE economy_heists
  SET participants = array_remove(participants, p_user_id)
  WHERE guild_id = p_guild_id
    AND status IN ('recruiting', 'in_progress')
    AND p_user_id = ANY(participants);

  GET DIAGNOSTICS v_heists_forfeited = ROW_COUNT;

  -- ── Suspend wallet ────────────────────────────────────────
  UPDATE economy_wallets
  SET suspended = true,
      suspended_at = now(),
      suspended_reason = p_reason,
      updated_at = now()
  WHERE guild_id = p_guild_id
    AND user_id = p_user_id
    AND suspended = false;

  IF FOUND THEN
    v_wallet_suspended := true;
  END IF;

  RETURN jsonb_build_object(
    'listings_cancelled', v_listings_cancelled,
    'heists_forfeited',   v_heists_forfeited,
    'wallet_suspended',   v_wallet_suspended,
    'items_refunded',     v_items_refunded
  );
END;
$$;

-- ── 4. unsuspend_member_economy() — for returning members ───

CREATE OR REPLACE FUNCTION public.unsuspend_member_economy(
  p_guild_id text,
  p_user_id  text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE economy_wallets
  SET suspended = false,
      suspended_at = null,
      suspended_reason = null,
      updated_at = now()
  WHERE guild_id = p_guild_id
    AND user_id = p_user_id
    AND suspended = true;

  RETURN FOUND;
END;
$$;

-- ── 5. Grant execute to service_role ────────────────────────

GRANT EXECUTE ON FUNCTION public.cleanup_member_economy(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.unsuspend_member_economy(text, text) TO service_role;
