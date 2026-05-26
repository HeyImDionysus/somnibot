-- V5 Audit Phase 1 — RPC Security Hardening
-- §5.6: increment_customer_totals accepts negative amounts
-- §4.4: Economy wallet INT→BIGINT
-- Bonus: increment_member_xp positive-amount guard

-- 1. increment_customer_totals — add positive-amount guard
CREATE OR REPLACE FUNCTION increment_customer_totals(
  p_customer_id UUID,
  p_amount NUMERIC
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'increment_customer_totals: amount must be positive, got %', p_amount;
  END IF;

  UPDATE public.customers
  SET total_spent_cents = COALESCE(total_spent_cents, 0) + p_amount,
      first_purchase_at = COALESCE(first_purchase_at, now()),
      updated_at = now()
  WHERE id = p_customer_id;
END;
$$;

REVOKE ALL ON FUNCTION increment_customer_totals(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_customer_totals(UUID, NUMERIC) TO service_role;

-- 2. increment_member_xp — add positive-amount guard
CREATE OR REPLACE FUNCTION increment_member_xp(
  p_guild_id TEXT,
  p_member_id TEXT,
  p_xp_gain INT,
  p_username TEXT DEFAULT NULL,
  p_avatar TEXT DEFAULT NULL
)
RETURNS TABLE(new_xp INT, new_level INT, leveled_up BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_xp INT;
  v_current_level INT;
  v_new_xp INT;
  v_new_level INT;
  v_xp_per_level INT := 100;
BEGIN
  IF p_xp_gain <= 0 THEN
    RAISE EXCEPTION 'increment_member_xp: xp_gain must be positive, got %', p_xp_gain;
  END IF;

  INSERT INTO public.member_levels (guild_id, member_id, xp, level, updated_at)
  VALUES (p_guild_id, p_member_id, p_xp_gain, 0, now())
  ON CONFLICT (guild_id, member_id)
  DO UPDATE SET
    xp = public.member_levels.xp + p_xp_gain,
    updated_at = now()
  RETURNING public.member_levels.xp, public.member_levels.level
  INTO v_new_xp, v_current_level;

  v_new_level := FLOOR(v_new_xp / v_xp_per_level);

  IF v_new_level > v_current_level THEN
    UPDATE public.member_levels
    SET level = v_new_level
    WHERE guild_id = p_guild_id AND member_id = p_member_id;
  END IF;

  RETURN QUERY SELECT v_new_xp, v_new_level, (v_new_level > v_current_level);
END;
$$;

REVOKE ALL ON FUNCTION increment_member_xp(TEXT, TEXT, INT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_member_xp(TEXT, TEXT, INT, TEXT, TEXT) TO service_role;

-- 3. Widen economy_wallets.wallet from INT to BIGINT
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'economy_wallets'
      AND column_name = 'wallet'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE public.economy_wallets ALTER COLUMN wallet TYPE BIGINT;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'economy_wallets'
      AND column_name = 'total_earned'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE public.economy_wallets ALTER COLUMN total_earned TYPE BIGINT;
  END IF;
END $$;

-- 4. economy_add_balance — accept BIGINT, positive guard
DROP FUNCTION IF EXISTS economy_add_balance(TEXT, TEXT, INT);

CREATE OR REPLACE FUNCTION economy_add_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount BIGINT
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

  INSERT INTO public.economy_wallets (guild_id, user_id, wallet, updated_at)
  VALUES (p_guild_id, p_user_id, p_amount, now())
  ON CONFLICT (guild_id, user_id)
  DO UPDATE SET wallet = public.economy_wallets.wallet + p_amount, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION economy_add_balance(TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION economy_add_balance(TEXT, TEXT, BIGINT) TO service_role;

-- 5. economy_subtract_balance — accept BIGINT
DROP FUNCTION IF EXISTS economy_subtract_balance(TEXT, TEXT, INT);

CREATE OR REPLACE FUNCTION economy_subtract_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount BIGINT
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

REVOKE ALL ON FUNCTION economy_subtract_balance(TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION economy_subtract_balance(TEXT, TEXT, BIGINT) TO service_role;
