-- V4 Audit Security Hardening
--
-- Addresses 4 findings from the V4 production readiness audit:
--   1. Economy RPCs accept negative amounts (bypass guards)
--   2. Missing REVOKE on 16 economy RPCs (callable by anon role)
--   3. Missing performance indexes
--
-- PR #98 fixes were on a branch that was never merged to main.
-- This migration applies those fixes cleanly.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Economy RPC Negative Amount Guards
-- ═══════════════════════════════════════════════════════════════════════

-- economy_add_balance: reject negative/zero amounts
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
    RAISE EXCEPTION 'amount must be positive';
  END IF;

  INSERT INTO public.economy_wallets (guild_id, user_id, wallet, updated_at)
  VALUES (p_guild_id, p_user_id, p_amount, now())
  ON CONFLICT (guild_id, user_id)
  DO UPDATE SET wallet = public.economy_wallets.wallet + p_amount, updated_at = now();
END;
$$;

-- economy_subtract_balance: reject negative/zero amounts
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
    RAISE EXCEPTION 'amount must be positive';
  END IF;

  UPDATE public.economy_wallets
  SET wallet = wallet - p_amount, updated_at = now()
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND wallet >= p_amount;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;
END;
$$;

-- economy_upsert_inventory: reject negative/zero quantity
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
    RAISE EXCEPTION 'quantity must be positive';
  END IF;

  INSERT INTO public.economy_inventory (guild_id, user_id, item_id, quantity, durability_remaining, updated_at)
  VALUES (p_guild_id, p_user_id, p_item_id, p_quantity, p_durability, now())
  ON CONFLICT (guild_id, user_id, item_id)
  DO UPDATE SET
    quantity = public.economy_inventory.quantity + p_quantity,
    updated_at = now();
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. REVOKE on Economy RPCs
--    Prevents anon/authenticated roles from calling these directly
--    via the Supabase REST API if the anon key is exposed.
-- ═══════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION economy_add_balance(TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_subtract_balance(TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_upsert_inventory(TEXT, TEXT, UUID, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_decrement_inventory(TEXT, TEXT, UUID, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_decrement_stock(UUID, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_decrement_durability(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_wallet_stats(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_increment_prediction_pool(UUID, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_bank_deposit(TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_bank_withdraw(TEXT, TEXT, BIGINT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_pet_add_xp(TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_pet_feed(TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_pet_play(TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_pet_train(TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_market_search(TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION economy_heist_join(UUID, TEXT) FROM PUBLIC, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. Performance Indexes
-- ═══════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_action_queue_dlq_guild_ack
  ON action_queue_dlq (guild_id, acknowledged, retried, failed_at);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_token_active
  ON portal_sessions (token_hash) WHERE revoked = false;

CREATE INDEX IF NOT EXISTS idx_economy_transactions_guild_user_created
  ON economy_transactions (guild_id, user_id, created_at DESC);
