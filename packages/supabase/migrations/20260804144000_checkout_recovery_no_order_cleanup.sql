-- Follow-up hardening: recover intents whose atomic checkout attempt failed
-- before an order was created, without ever touching exposed links.
BEGIN;

CREATE OR REPLACE FUNCTION public.commerce_reap_unexposed_paid_checkout(
  p_checkout_token UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_plan_id UUID,
  p_provider_kind TEXT,
  p_provider_id TEXT,
  p_order_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_checkout_intents%ROWTYPE;
  v_order_id UUID;
  v_order public.orders%ROWTYPE;
  v_result JSONB;
  v_updated INTEGER;
BEGIN
  SELECT * INTO v_intent FROM public.commerce_checkout_intents
   WHERE token = p_checkout_token FOR UPDATE;
  IF NOT FOUND
     OR v_intent.guild_id IS DISTINCT FROM p_guild_id
     OR v_intent.customer_id IS DISTINCT FROM p_customer_id
     OR v_intent.product_id IS DISTINCT FROM p_product_id
     OR v_intent.plan_id IS DISTINCT FROM p_plan_id
     OR p_provider_kind NOT IN ('capture', 'subscription') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE =
      'commerce_reap_unexposed_paid_checkout: checkout identity mismatch';
  END IF;
  IF v_intent.approval_exposed_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('disposition', 'exposed', 'order_id', v_intent.order_id);
  END IF;

  -- A provider response can exist while the atomic order RPC failed before
  -- inserting an order. The link was never exposed, so cancel this exact
  -- intent and release any gift retry without manufacturing an order.
  IF v_intent.order_id IS NULL THEN
    IF NOT (
      (v_intent.status = 'pending' AND v_intent.provider_id IS NULL)
      OR (v_intent.status = 'bound' AND v_intent.provider_id = p_provider_id)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
        'commerce_reap_unexposed_paid_checkout: unlinked intent identity mismatch';
    END IF;
    UPDATE public.commerce_checkout_intents
       SET status = 'cancelled', cancel_reason = p_reason
     WHERE token = p_checkout_token
       AND status IN ('pending', 'bound')
       AND order_id IS NULL
       AND approval_exposed_at IS NULL;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE =
        'commerce_reap_unexposed_paid_checkout: unlinked intent cancellation failed';
    END IF;
    RETURN pg_catalog.jsonb_build_object('disposition', 'cancelled_no_order', 'order_id', NULL);
  END IF;

  v_order_id := COALESCE(p_order_id, v_intent.order_id);
  IF v_intent.order_id IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
      'commerce_reap_unexposed_paid_checkout: linked order token mismatch';
  END IF;
  IF v_intent.status IS DISTINCT FROM 'bound'
     OR v_intent.provider_id IS DISTINCT FROM p_provider_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
      'commerce_reap_unexposed_paid_checkout: linked intent identity mismatch';
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = v_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR v_order.customer_id IS DISTINCT FROM p_customer_id
     OR v_order.product_id IS DISTINCT FROM p_product_id
     OR v_order.status IS DISTINCT FROM 'pending'
     OR NOT v_order.checkout_active
     OR (p_provider_kind = 'capture' AND (v_order.paypal_order_id IS DISTINCT FROM p_provider_id OR v_order.paypal_subscription_id IS NOT NULL))
     OR (p_provider_kind = 'subscription' AND (v_order.paypal_subscription_id IS DISTINCT FROM p_provider_id OR v_order.paypal_order_id IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
      'commerce_reap_unexposed_paid_checkout: linked order identity mismatch';
  END IF;
  v_result := public.commerce_deactivate_pending_checkout(
    v_order.id, p_guild_id, p_customer_id, p_product_id,
    p_provider_kind, p_provider_id, 'approval_link_not_exposed', p_reason
  );
  UPDATE public.commerce_checkout_intents
     SET status = 'cancelled', cancel_reason = p_reason
   WHERE token = p_checkout_token AND status = 'bound' AND order_id = v_order.id
     AND approval_exposed_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE =
      'commerce_reap_unexposed_paid_checkout: intent cancellation failed';
  END IF;
  RETURN pg_catalog.jsonb_build_object('disposition', 'reaped', 'order_id', v_order.id, 'deactivation', v_result);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_reap_unexposed_paid_checkouts_for_product(
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_checkout_intents%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_kind TEXT;
  v_provider TEXT;
  v_reaped INTEGER := 0;
BEGIN
  FOR v_intent IN
    SELECT * FROM public.commerce_checkout_intents
     WHERE guild_id = p_guild_id AND customer_id = p_customer_id
       AND product_id = p_product_id AND status IN ('pending', 'bound')
       AND approval_exposed_at IS NULL
       AND (status = 'bound' OR created_at <= pg_catalog.clock_timestamp() - INTERVAL '60 seconds')
     FOR UPDATE
  LOOP
    IF v_intent.order_id IS NULL THEN
      IF (v_intent.status = 'pending' AND v_intent.provider_id IS NULL)
         OR (v_intent.status = 'bound' AND v_intent.provider_id IS NOT NULL) THEN
        UPDATE public.commerce_checkout_intents
           SET status = 'cancelled', cancel_reason = p_reason
         WHERE token = v_intent.token AND status IN ('pending', 'bound')
           AND order_id IS NULL AND approval_exposed_at IS NULL;
        IF FOUND THEN v_reaped := v_reaped + 1; END IF;
        CONTINUE;
      END IF;
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
        'commerce_reap_unexposed_paid_checkouts_for_product: unlinked intent identity mismatch';
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = v_intent.order_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
        'commerce_reap_unexposed_paid_checkouts_for_product: linked order missing';
    END IF;
    IF v_order.guild_id IS DISTINCT FROM p_guild_id
       OR v_order.customer_id IS DISTINCT FROM p_customer_id
       OR v_order.product_id IS DISTINCT FROM p_product_id
       OR v_order.status IS DISTINCT FROM 'pending'
       OR NOT v_order.checkout_active THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
        'commerce_reap_unexposed_paid_checkouts_for_product: linked order identity mismatch';
    END IF;
    IF v_order.paypal_order_id IS NOT NULL AND v_order.paypal_subscription_id IS NULL THEN
      v_kind := 'capture'; v_provider := v_order.paypal_order_id;
    ELSIF v_order.paypal_subscription_id IS NOT NULL AND v_order.paypal_order_id IS NULL THEN
      v_kind := 'subscription'; v_provider := v_order.paypal_subscription_id;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
        'commerce_reap_unexposed_paid_checkouts_for_product: linked provider identity mismatch';
    END IF;
    IF v_intent.status IS DISTINCT FROM 'bound' OR v_intent.provider_id IS DISTINCT FROM v_provider THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
        'commerce_reap_unexposed_paid_checkouts_for_product: intent provider identity mismatch';
    END IF;
    PERFORM public.commerce_deactivate_pending_checkout(
      v_order.id, p_guild_id, p_customer_id, p_product_id,
      v_kind, v_provider, 'approval_link_not_exposed', p_reason
    );
    UPDATE public.commerce_checkout_intents
       SET status = 'cancelled', cancel_reason = p_reason
     WHERE token = v_intent.token AND status = 'bound'
       AND order_id = v_order.id AND approval_exposed_at IS NULL;
    IF FOUND THEN v_reaped := v_reaped + 1; END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('disposition', 'swept', 'reaped_count', v_reaped);
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_reap_unexposed_paid_checkout(UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_reap_unexposed_paid_checkout(UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT)
  TO service_role;
REVOKE ALL ON FUNCTION public.commerce_reap_unexposed_paid_checkouts_for_product(TEXT, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_reap_unexposed_paid_checkouts_for_product(TEXT, UUID, UUID, TEXT)
  TO service_role;

COMMIT;
