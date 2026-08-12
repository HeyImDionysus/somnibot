-- Atomically retire expired paid checkout-intent rows before a gift retry.
-- The gift intent row is locked so a concurrent fulfillment cannot race this
-- cleanup, and captured/fulfilled rows are never made reusable.
BEGIN;

CREATE OR REPLACE FUNCTION public.commerce_prepare_gift_checkout(
  p_guild_id text,
  p_buyer_customer_id uuid,
  p_product_id uuid,
  p_checkout_token text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_gift public.commerce_gift_intents%ROWTYPE;
  v_cancelled integer := 0;
BEGIN
  IF p_guild_id IS NULL OR p_buyer_customer_id IS NULL OR p_product_id IS NULL
     OR p_checkout_token IS NULL OR p_checkout_token = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'gift checkout identity is invalid';
  END IF;

  SELECT * INTO v_gift
    FROM public.commerce_gift_intents
   WHERE checkout_token = p_checkout_token
   FOR UPDATE;
  IF NOT FOUND
     OR v_gift.guild_id IS DISTINCT FROM p_guild_id
     OR v_gift.buyer_customer_id IS DISTINCT FROM p_buyer_customer_id
     OR v_gift.product_id IS DISTINCT FROM p_product_id
     OR v_gift.status IS DISTINCT FROM 'pending'
     OR v_gift.expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gift intent expired or unavailable';
  END IF;

  UPDATE public.commerce_checkout_intents
     SET status = 'cancelled', cancel_reason = 'expired gift checkout intent'
   WHERE gift_checkout_token = p_checkout_token
     AND status IN ('pending', 'bound')
     AND expires_at <= pg_catalog.clock_timestamp();
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;
  RETURN v_cancelled;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_prepare_gift_checkout(text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_prepare_gift_checkout(text, uuid, uuid, text)
  TO service_role;

COMMIT;
