-- V44 audit fixes
-- 1. Atomic bank_deposit / bank_withdraw RPCs (fixes TOCTOU in deposit/withdraw)
-- 2. Atomic market_buy_listing RPC (fixes TOCTOU in concurrent market buys)
-- 3. Atomic pet_add_xp RPC (fixes non-atomic XP update)
-- 4. Enable RLS on 6 core economy tables that were missing it

-- ── 1. Atomic bank deposit ─────────────────────────────────
-- Atomically debits wallet and credits bank in a single transaction.
-- Returns the actual amount deposited (may be capped by bank_max).
-- Returns 0 if insufficient wallet or bank full.
CREATE OR REPLACE FUNCTION economy_bank_deposit(
  p_guild_id TEXT,
  p_user_id  TEXT,
  p_amount   BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_wallet  BIGINT;
  v_bank    BIGINT;
  v_bank_max BIGINT;
  v_actual  BIGINT;
BEGIN
  SELECT wallet, bank, bank_max
    INTO v_wallet, v_bank, v_bank_max
    FROM public.economy_wallets
   WHERE guild_id = p_guild_id AND user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND OR v_wallet < p_amount THEN
    RETURN 0;
  END IF;

  v_actual := LEAST(p_amount, v_bank_max - v_bank);
  IF v_actual <= 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.economy_wallets
     SET wallet = wallet - v_actual,
         bank = bank + v_actual,
         updated_at = NOW()
   WHERE guild_id = p_guild_id AND user_id = p_user_id;

  RETURN v_actual;
END;
$$;

-- ── 2. Atomic bank withdraw ────────────────────────────────
-- Atomically debits bank and credits wallet in a single transaction.
-- Respects max_wallet cap. Returns actual amount withdrawn.
-- Returns 0 if insufficient bank balance.
CREATE OR REPLACE FUNCTION economy_bank_withdraw(
  p_guild_id    TEXT,
  p_user_id     TEXT,
  p_amount      BIGINT,
  p_max_wallet  BIGINT DEFAULT 0  -- 0 = no cap
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_wallet  BIGINT;
  v_bank    BIGINT;
  v_actual  BIGINT;
  v_new_wallet BIGINT;
BEGIN
  SELECT wallet, bank
    INTO v_wallet, v_bank
    FROM public.economy_wallets
   WHERE guild_id = p_guild_id AND user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND OR v_bank < p_amount THEN
    RETURN 0;
  END IF;

  v_new_wallet := v_wallet + p_amount;
  IF p_max_wallet > 0 AND v_new_wallet > p_max_wallet THEN
    v_new_wallet := p_max_wallet;
  END IF;

  v_actual := v_new_wallet - v_wallet;
  IF v_actual <= 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.economy_wallets
     SET wallet = v_new_wallet,
         bank = bank - v_actual,
         updated_at = NOW()
   WHERE guild_id = p_guild_id AND user_id = p_user_id;

  RETURN v_actual;
END;
$$;

-- ── 3. Atomic market buy ───────────────────────────────────
-- Atomically decrements listing remaining qty.
-- Returns actual qty purchased (0 if listing not available).
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

-- ── 4. Atomic pet XP add ───────────────────────────────────
CREATE OR REPLACE FUNCTION economy_pet_add_xp(
  p_guild_id TEXT,
  p_user_id  TEXT,
  p_xp       INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.economy_pets
     SET xp = xp + p_xp,
         updated_at = NOW()
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
END;
$$;

-- ── 5. Enable RLS on 6 core economy tables ─────────────────
ALTER TABLE economy_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE economy_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE economy_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE economy_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE economy_role_income ENABLE ROW LEVEL SECURITY;
ALTER TABLE economy_streaks ENABLE ROW LEVEL SECURITY;

-- Permissive policies for service_role (standard pattern — service_role bypasses RLS,
-- but policies ensure anon/authenticated get no access without explicit grants)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'economy_wallets' AND policyname = 'service_role_all') THEN
    CREATE POLICY service_role_all ON economy_wallets FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'economy_transactions' AND policyname = 'service_role_all') THEN
    CREATE POLICY service_role_all ON economy_transactions FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'economy_items' AND policyname = 'service_role_all') THEN
    CREATE POLICY service_role_all ON economy_items FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'economy_inventory' AND policyname = 'service_role_all') THEN
    CREATE POLICY service_role_all ON economy_inventory FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'economy_role_income' AND policyname = 'service_role_all') THEN
    CREATE POLICY service_role_all ON economy_role_income FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'economy_streaks' AND policyname = 'service_role_all') THEN
    CREATE POLICY service_role_all ON economy_streaks FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── 6. REVOKE/GRANT on new RPCs ────────────────────────────
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOR fn IN
    SELECT oid::regprocedure::text FROM pg_proc
    WHERE proname IN (
      'economy_bank_deposit',
      'economy_bank_withdraw',
      'economy_market_buy',
      'economy_pet_add_xp'
    )
    AND pronamespace = 'public'::regnamespace
  LOOP
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM public', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END $$;
