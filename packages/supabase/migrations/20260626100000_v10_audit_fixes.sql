-- ============================================================
-- V10 Audit Fixes: economy_credit_wallet hardening + idempotent schema
-- Addresses Findings #9, #10, #11
-- ============================================================

-- ── Finding 9 + 10: Harden economy_credit_wallet RPC ──────────
-- §9: Add SET search_path = public for consistency with all v8+ RPCs.
-- §10: Guard against negative amounts that would silently debit wallets.

CREATE OR REPLACE FUNCTION public.economy_credit_wallet(
  p_guild_id text,
  p_user_id  text,
  p_amount   bigint,
  p_reason   text DEFAULT 'credit'
) RETURNS void LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- V10 Audit §10: Reject non-positive amounts at the DB level
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'economy_credit_wallet: p_amount must be positive, got %', p_amount;
  END IF;

  -- Upsert wallet: credit existing or create with starting balance
  INSERT INTO economy_wallets (guild_id, user_id, wallet, bank, total_earned, total_spent)
  VALUES (p_guild_id, p_user_id, p_amount, 0, p_amount, 0)
  ON CONFLICT (guild_id, user_id)
  DO UPDATE SET
    wallet       = economy_wallets.wallet + p_amount,
    total_earned = economy_wallets.total_earned + p_amount;

  -- Record the transaction with accurate balance_after
  INSERT INTO economy_transactions (guild_id, user_id, type, amount, balance_after, description)
  SELECT p_guild_id, p_user_id, 'level_bonus', p_amount, w.wallet, p_reason
  FROM economy_wallets w
  WHERE w.guild_id = p_guild_id AND w.user_id = p_user_id;
END;
$$;

-- Preserve existing grants
REVOKE ALL ON FUNCTION public.economy_credit_wallet(text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.economy_credit_wallet(text, text, bigint, text) TO service_role;
