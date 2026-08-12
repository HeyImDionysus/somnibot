-- Atomically create/replay a paid checkout order and bind its checkout intent.
-- The provider response is only an opaque identity; all tenant/product/customer
-- fields are rechecked under the locked service-role intent row.
BEGIN;

CREATE OR REPLACE FUNCTION public.commerce_create_and_bind_active_paid_checkout(
  p_checkout_token UUID,
  p_order_number TEXT,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_plan_id UUID,
  p_provider_kind TEXT,
  p_provider_id TEXT,
  p_approval_url TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_checkout_intents%ROWTYPE;
  v_order JSONB;
  v_order_id UUID;
  v_updated INTEGER;
BEGIN
  IF p_checkout_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
      'commerce_create_and_bind_active_paid_checkout: checkout token is required';
  END IF;

  SELECT * INTO v_intent
    FROM public.commerce_checkout_intents
   WHERE token = p_checkout_token
   FOR UPDATE;

  IF NOT FOUND
     OR v_intent.guild_id IS DISTINCT FROM p_guild_id
     OR v_intent.customer_id IS DISTINCT FROM p_customer_id
     OR v_intent.product_id IS DISTINCT FROM p_product_id
     OR v_intent.status NOT IN ('pending', 'bound')
     OR v_intent.expires_at <= pg_catalog.clock_timestamp()
     OR (v_intent.plan_id IS NOT NULL AND v_intent.plan_id IS DISTINCT FROM p_plan_id)
     OR (v_intent.provider_id IS NOT NULL AND v_intent.provider_id IS DISTINCT FROM p_provider_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE =
      'commerce_create_and_bind_active_paid_checkout: checkout intent identity mismatch';
  END IF;

  IF p_provider_kind NOT IN ('capture', 'subscription')
     OR (p_provider_kind = 'capture' AND p_plan_id IS NOT NULL)
     OR (p_provider_kind = 'subscription' AND p_plan_id IS NULL)
     OR p_provider_id IS NULL
     OR p_provider_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
      'commerce_create_and_bind_active_paid_checkout: exact provider identity is required';
  END IF;

  v_order := public.commerce_create_active_paid_checkout(
    p_order_number,
    p_guild_id,
    p_customer_id,
    p_product_id,
    p_plan_id,
    p_provider_kind,
    p_provider_id,
    p_approval_url,
    p_amount_cents,
    p_currency
  );
  v_order_id := (v_order ->> 'id')::UUID;

  IF v_order_id IS NULL
     OR v_order ->> 'order_number' IS DISTINCT FROM p_order_number
     OR v_order ->> 'guild_id' IS DISTINCT FROM p_guild_id
     OR (v_order ->> 'customer_id')::UUID IS DISTINCT FROM p_customer_id
     OR (v_order ->> 'product_id')::UUID IS DISTINCT FROM p_product_id
     OR NULLIF(v_order ->> 'plan_id', '')::UUID IS DISTINCT FROM p_plan_id
     OR v_order ->> 'status' IS DISTINCT FROM 'pending'
     OR (v_order ->> 'checkout_active')::BOOLEAN IS DISTINCT FROM TRUE
     OR v_order ->> 'checkout_approval_url' IS DISTINCT FROM p_approval_url
     OR (v_order ->> 'amount_cents')::INTEGER IS DISTINCT FROM p_amount_cents
     OR v_order ->> 'currency' IS DISTINCT FROM p_currency
     OR (p_provider_kind = 'capture' AND v_order ->> 'paypal_order_id' IS DISTINCT FROM p_provider_id)
     OR (p_provider_kind = 'capture' AND v_order ->> 'paypal_subscription_id' IS NOT NULL)
     OR (p_provider_kind = 'subscription' AND v_order ->> 'paypal_subscription_id' IS DISTINCT FROM p_provider_id)
     OR (p_provider_kind = 'subscription' AND v_order ->> 'paypal_order_id' IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
      'commerce_create_and_bind_active_paid_checkout: order identity mismatch';
  END IF;

  UPDATE public.commerce_checkout_intents
     SET provider_id = p_provider_id,
         plan_id = p_plan_id,
         status = 'bound',
         order_id = v_order_id
   WHERE token = p_checkout_token
     AND guild_id = p_guild_id
     AND customer_id = p_customer_id
     AND product_id = p_product_id
     AND status IN ('pending', 'bound')
     AND expires_at > pg_catalog.clock_timestamp()
     AND (provider_id IS NULL OR provider_id = p_provider_id)
     AND (plan_id IS NULL OR plan_id = p_plan_id)
     AND (order_id IS NULL OR order_id = v_order_id);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE =
      'commerce_create_and_bind_active_paid_checkout: checkout intent binding failed';
  END IF;

  RETURN v_order;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_create_and_bind_active_paid_checkout(
  UUID, TEXT, TEXT, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_and_bind_active_paid_checkout(
  UUID, TEXT, TEXT, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT
) TO service_role;

COMMIT;
