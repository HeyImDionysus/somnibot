-- Restore a previously debited wallet balance without classifying the
-- compensation as newly earned currency. A durable idempotency key makes an
-- ambiguous client retry safe: the wallet is restored at most once.
CREATE OR REPLACE FUNCTION public.economy_refund_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount BIGINT,
  p_idempotency_key TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_balance BIGINT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'economy_refund_balance: p_amount must be positive, got %', p_amount;
  END IF;

  IF p_idempotency_key IS NULL
     OR p_idempotency_key <> pg_catalog.btrim(p_idempotency_key)
     OR p_idempotency_key = '' THEN
    RAISE EXCEPTION 'economy_refund_balance: p_idempotency_key is required and must be canonical';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'economy-role-income:' || p_guild_id || ':' || p_user_id,
      0
    )
  );

  PERFORM 1
    FROM public.economy_transactions AS t
   WHERE t.guild_id = p_guild_id
     AND t.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN;
  END IF;

  UPDATE public.economy_wallets
     SET wallet = wallet + p_amount,
         updated_at = now()
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id
  RETURNING wallet INTO v_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'economy_refund_balance: wallet not found';
  END IF;

  INSERT INTO public.economy_transactions
    (guild_id, user_id, type, amount, balance_after, description, idempotency_key)
  VALUES
    (p_guild_id, p_user_id, 'refund', p_amount, v_balance,
     'Idempotent wallet compensation', p_idempotency_key);
END;
$$;

REVOKE ALL ON FUNCTION public.economy_refund_balance(TEXT, TEXT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_refund_balance(TEXT, TEXT, BIGINT, TEXT)
  TO service_role;
