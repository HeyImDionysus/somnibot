-- V32: Economy bug fixes
--
-- 1. Create missing economy_add_balance / economy_subtract_balance RPCs
--    (called by 8 modules but never defined — all transactions silently failed)
-- 2. economy_subtract_balance is atomic — prevents TOCTOU race conditions
--    and negative balances even under concurrent access.

-- ── economy_add_balance ──────────────────────────────────────────────
-- Atomically credit a user's wallet. Creates the wallet row if it doesn't exist.
CREATE OR REPLACE FUNCTION economy_add_balance(
  p_guild_id TEXT,
  p_user_id  TEXT,
  p_amount   INTEGER
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO economy_wallets (guild_id, user_id, wallet, bank, total_earned, updated_at)
  VALUES (p_guild_id, p_user_id, p_amount, 0, p_amount, NOW())
  ON CONFLICT (guild_id, user_id)
  DO UPDATE SET
    wallet       = economy_wallets.wallet + p_amount,
    total_earned = economy_wallets.total_earned + p_amount,
    updated_at   = NOW();
END;
$$;

-- ── economy_subtract_balance ─────────────────────────────────────────
-- Atomically debit a user's wallet. Raises an exception if insufficient funds.
-- The caller's `.catch(() => {})` will swallow this for backward compat, but
-- the wallet can never go negative.
CREATE OR REPLACE FUNCTION economy_subtract_balance(
  p_guild_id TEXT,
  p_user_id  TEXT,
  p_amount   INTEGER
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  rows_affected INTEGER;
BEGIN
  UPDATE economy_wallets
  SET wallet      = wallet - p_amount,
      total_spent = total_spent + p_amount,
      updated_at  = NOW()
  WHERE guild_id = p_guild_id
    AND user_id  = p_user_id
    AND wallet  >= p_amount;

  GET DIAGNOSTICS rows_affected = ROW_COUNT;

  IF rows_affected = 0 THEN
    RAISE EXCEPTION 'Insufficient balance or wallet not found';
  END IF;
END;
$$;
