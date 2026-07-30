-- Make guild_config.economy_max_bank authoritative for deposits.
-- A value of 0 means no configured bank limit, matching the dashboard.
CREATE OR REPLACE FUNCTION public.economy_bank_deposit(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_wallet BIGINT;
  v_bank BIGINT;
  v_configured_max BIGINT;
  v_actual BIGINT;
BEGIN
  IF p_amount <= 0 THEN
    RETURN 0;
  END IF;

  SELECT wallet.wallet, wallet.bank, COALESCE(config.economy_max_bank, 0)
    INTO v_wallet, v_bank, v_configured_max
    FROM public.economy_wallets AS wallet
    LEFT JOIN public.guild_config AS config ON config.guild_id = wallet.guild_id
   WHERE wallet.guild_id = p_guild_id
     AND wallet.user_id = p_user_id
   FOR UPDATE OF wallet;

  IF NOT FOUND OR v_wallet < p_amount THEN
    RETURN 0;
  END IF;

  v_actual := CASE
    WHEN COALESCE(v_configured_max, 0) = 0 THEN p_amount
    ELSE LEAST(p_amount, v_configured_max - v_bank)
  END;
  IF v_actual <= 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.economy_wallets
     SET wallet = wallet - v_actual,
         bank = bank + v_actual,
         updated_at = now()
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id;

  RETURN v_actual;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_bank_deposit(TEXT, TEXT, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_bank_deposit(TEXT, TEXT, BIGINT) TO service_role;
