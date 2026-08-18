BEGIN;

CREATE OR REPLACE FUNCTION public.commerce_claim_checkout_intent(
  p_checkout_token UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_gift_checkout_token TEXT,
  p_provider_binding TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.commerce_checkout_intents%ROWTYPE;
BEGIN
  IF p_checkout_token IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_provider_binding IS NULL
     OR p_provider_binding !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
      'commerce_claim_checkout_intent: exact checkout identity is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_guild_id || ':' || p_customer_id::TEXT || ':' || p_product_id::TEXT,
      0
    )
  );

  UPDATE public.commerce_checkout_intents
     SET status = 'cancelled', cancel_reason = 'expired before checkout claim'
   WHERE guild_id = p_guild_id
     AND customer_id = p_customer_id
     AND product_id = p_product_id
     AND status IN ('pending', 'bound')
     AND expires_at <= pg_catalog.clock_timestamp();

  SELECT intent.*
    INTO v_existing
    FROM public.commerce_checkout_intents AS intent
   WHERE intent.guild_id = p_guild_id
     AND intent.customer_id = p_customer_id
     AND intent.product_id = p_product_id
     AND intent.status IN ('pending', 'bound')
     AND intent.expires_at > pg_catalog.clock_timestamp()
   ORDER BY intent.created_at, intent.token
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'disposition', 'blocked',
      'checkout_token', v_existing.token,
      'provider_id', v_existing.provider_id,
      'order_id', v_existing.order_id
    );
  END IF;

  INSERT INTO public.commerce_checkout_intents (
    token,
    guild_id,
    customer_id,
    product_id,
    gift_checkout_token,
    provider_binding
  ) VALUES (
    p_checkout_token,
    p_guild_id,
    p_customer_id,
    p_product_id,
    p_gift_checkout_token,
    p_provider_binding
  );

  RETURN pg_catalog.jsonb_build_object(
    'disposition', 'claimed',
    'checkout_token', p_checkout_token,
    'provider_id', NULL,
    'order_id', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_claim_checkout_intent(
  UUID, TEXT, UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_claim_checkout_intent(
  UUID, TEXT, UUID, UUID, TEXT, TEXT
) TO service_role;

COMMIT;
