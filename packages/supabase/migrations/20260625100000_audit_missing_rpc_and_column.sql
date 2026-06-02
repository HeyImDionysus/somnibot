-- ============================================================
-- Audit Fix: economy_credit_wallet RPC + ticket_satisfaction_survey column
-- Addresses Finding #1 (CRITICAL) and Finding #2 (HIGH)
-- ============================================================

-- ── 1. economy_credit_wallet RPC (Finding #1) ──────────────
-- cross-feature-bridge.ts:226 calls this RPC for level-milestone
-- economy bonuses. It was never created, so bonuses silently failed.

CREATE OR REPLACE FUNCTION public.economy_credit_wallet(
  p_guild_id text,
  p_user_id  text,
  p_amount   bigint,
  p_reason   text DEFAULT 'credit'
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
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

-- Only service_role should call this (bot-internal)
REVOKE ALL ON FUNCTION public.economy_credit_wallet(text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.economy_credit_wallet(text, text, bigint, text) TO service_role;

-- ── 2. ticket_satisfaction_survey column (Finding #2) ──────
-- cross-feature-bridge.ts:251 reads this column to decide whether to
-- DM a satisfaction survey on ticket close. Column was never created.

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS ticket_satisfaction_survey boolean NOT NULL DEFAULT false;
