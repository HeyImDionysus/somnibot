-- V4 Audit Hardening
-- ==================
-- 1. economy_add_balance: Reject negative amounts (prevent sign-flip exploits)
-- 2. economy_subtract_balance: Reject negative amounts
-- 3. economy_upsert_inventory: Reject negative quantities
-- 4. Add index on action_queue_dlq(guild_id, acknowledged, retried) for dashboard queries
-- 5. Add index on portal_sessions(token_hash) for O(1) token lookups
-- 6. Add index on economy_transactions(guild_id, user_id, created_at) for history queries

-- ══════════════════════════════════════════════════════════════
-- 1. economy_add_balance — guard against negative p_amount
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION economy_add_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount INT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'economy_add_balance: p_amount must be positive, got %', p_amount;
  END IF;

  INSERT INTO public.economy_wallets (guild_id, user_id, wallet, total_earned, updated_at)
  VALUES (p_guild_id, p_user_id, p_amount, p_amount, now())
  ON CONFLICT (guild_id, user_id)
  DO UPDATE SET wallet = public.economy_wallets.wallet + p_amount,
                total_earned = public.economy_wallets.total_earned + p_amount,
                updated_at = now();
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- 2. economy_subtract_balance — guard against negative p_amount
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION economy_subtract_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount INT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'economy_subtract_balance: p_amount must be positive, got %', p_amount;
  END IF;

  UPDATE public.economy_wallets
  SET wallet = wallet - p_amount, updated_at = now()
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND wallet >= p_amount;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- 3. economy_upsert_inventory — guard against negative quantity
--    Preserves original signature: (text, text, uuid, int, int DEFAULT NULL)
--    Preserves durability_remaining field and unbounded stacking behavior
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION economy_upsert_inventory(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_item_id UUID,
  p_quantity INT,
  p_durability INT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'economy_upsert_inventory: p_quantity must be positive, got %', p_quantity;
  END IF;

  INSERT INTO public.economy_inventory (guild_id, user_id, item_id, quantity, durability_remaining, updated_at)
  VALUES (p_guild_id, p_user_id, p_item_id, p_quantity, p_durability, now())
  ON CONFLICT (guild_id, user_id, item_id)
  DO UPDATE SET
    quantity   = public.economy_inventory.quantity + p_quantity,
    updated_at = now();
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- 4. Performance indexes for dashboard queries
-- ══════════════════════════════════════════════════════════════

-- DLQ listing in dashboard — filtered by guild + status
CREATE INDEX IF NOT EXISTS idx_action_queue_dlq_guild_status
  ON action_queue_dlq (guild_id, acknowledged, retried, failed_at DESC);

-- Portal session token lookup (currently table-scans on token_hash)
CREATE INDEX IF NOT EXISTS idx_portal_sessions_token_hash
  ON portal_sessions (token_hash) WHERE revoked = false;

-- Economy transaction history — ordered by time for a user
CREATE INDEX IF NOT EXISTS idx_economy_transactions_user_time
  ON economy_transactions (guild_id, user_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- 5. Revoke execute from public roles (belt-and-suspenders)
-- ══════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION economy_add_balance(text, text, int) FROM anon, authenticated, public;
GRANT  EXECUTE ON FUNCTION economy_add_balance(text, text, int) TO service_role;

REVOKE EXECUTE ON FUNCTION economy_subtract_balance(text, text, int) FROM anon, authenticated, public;
GRANT  EXECUTE ON FUNCTION economy_subtract_balance(text, text, int) TO service_role;

REVOKE EXECUTE ON FUNCTION economy_upsert_inventory(text, text, uuid, int, int) FROM anon, authenticated, public;
GRANT  EXECUTE ON FUNCTION economy_upsert_inventory(text, text, uuid, int, int) TO service_role;
