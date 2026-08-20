BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.promotions
     WHERE coupon_code IS NOT NULL
       AND (
         coupon_code <> pg_catalog.upper(pg_catalog.btrim(coupon_code))
         OR coupon_code !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'
         OR value <> pg_catalog.trunc(value)
         OR (type = 'percentage' AND (value < 1 OR value > 99))
         OR (type = 'fixed_amount' AND value < 1)
       )
  ) THEN
    RAISE EXCEPTION 'promotion_checkout_redemption: existing promotion rows require correction';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.promotions
     WHERE coupon_code IS NOT NULL
     GROUP BY guild_id, pg_catalog.upper(coupon_code)
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'promotion_checkout_redemption: duplicate coupon codes exist';
  END IF;
END;
$$;

ALTER TABLE public.promotions
  ALTER COLUMN current_uses SET DEFAULT 0;

UPDATE public.promotions
   SET current_uses = 0
 WHERE current_uses IS NULL;

ALTER TABLE public.promotions
  ALTER COLUMN current_uses SET NOT NULL,
  ADD CONSTRAINT promotions_coupon_code_shape
  CHECK (
    coupon_code IS NULL
    OR (
      coupon_code = pg_catalog.upper(pg_catalog.btrim(coupon_code))
      AND coupon_code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'
    )
  ),
  ADD CONSTRAINT promotions_integer_discount_value
  CHECK (
    value = pg_catalog.trunc(value)
    AND (
      (type = 'percentage' AND value BETWEEN 1 AND 99)
      OR (type = 'fixed_amount' AND value >= 1)
    )
  ),
  ADD CONSTRAINT promotions_usage_bounds
  CHECK (
    (max_uses IS NULL OR max_uses >= 1)
    AND current_uses >= 0
    AND min_purchase_cents >= 0
  ),
  ADD CONSTRAINT promotions_date_order
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date > start_date);

CREATE UNIQUE INDEX promotions_guild_coupon_code_key
  ON public.promotions (guild_id, pg_catalog.upper(coupon_code))
  WHERE coupon_code IS NOT NULL;

DROP TRIGGER IF EXISTS commerce_promotions_disabled_write ON public.promotions;
DROP FUNCTION IF EXISTS public.commerce_reject_disabled_promotion_write();

ALTER TABLE public.commerce_checkout_intents
  ADD COLUMN promotion_id UUID REFERENCES public.promotions(id) ON DELETE RESTRICT,
  ADD COLUMN promotion_code TEXT,
  ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN final_amount_cents INTEGER;

ALTER TABLE public.commerce_checkout_intents
  ADD CONSTRAINT commerce_checkout_intents_promotion_pricing
  CHECK (
    discount_cents >= 0
    AND (final_amount_cents IS NULL OR final_amount_cents >= 1)
    AND (
      promotion_id IS NOT NULL
      OR (promotion_code IS NULL AND discount_cents = 0)
    )
  );

CREATE INDEX commerce_checkout_intents_promotion_reservations
  ON public.commerce_checkout_intents (promotion_id, status, expires_at)
  WHERE promotion_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.commerce_reserve_checkout_pricing(
  p_checkout_token UUID,
  p_coupon_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_checkout_intents%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_promotion public.promotions%ROWTYPE;
  v_code TEXT;
  v_discount INTEGER := 0;
  v_final INTEGER;
  v_reserved_uses INTEGER := 0;
  v_pending_order_uses INTEGER := 0;
BEGIN
  SELECT * INTO v_intent
    FROM public.commerce_checkout_intents
   WHERE token = p_checkout_token
   FOR UPDATE;

  IF NOT FOUND
     OR v_intent.status <> 'pending'
     OR v_intent.expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE =
      'commerce_reserve_checkout_pricing: checkout intent is unavailable';
  END IF;

  SELECT * INTO v_product
    FROM public.products
   WHERE id = v_intent.product_id
     AND guild_id = v_intent.guild_id
     AND active = TRUE
   FOR SHARE;
  IF NOT FOUND
     OR v_product.type <> 'one_time'
     OR v_product.price_cents < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
      'commerce_reserve_checkout_pricing: only priced one-time products are eligible';
  END IF;

  v_code := pg_catalog.upper(pg_catalog.btrim(pg_catalog.coalesce(p_coupon_code, '')));
  IF v_intent.final_amount_cents IS NOT NULL THEN
    IF (v_intent.promotion_code IS NULL AND v_code = '')
       OR v_intent.promotion_code = v_code THEN
      RETURN pg_catalog.jsonb_build_object(
        'amount_cents', v_intent.final_amount_cents,
        'discount_cents', v_intent.discount_cents,
        'promotion_id', v_intent.promotion_id,
        'coupon_code', v_intent.promotion_code
      );
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
      'commerce_reserve_checkout_pricing: pricing is already reserved';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'promotion:first-purchase:' || v_intent.guild_id || ':' || v_intent.customer_id::TEXT,
    0
  ));

  IF v_code = '' THEN
    UPDATE public.commerce_checkout_intents
       SET final_amount_cents = v_product.price_cents
     WHERE token = p_checkout_token;
    RETURN pg_catalog.jsonb_build_object(
      'amount_cents', v_product.price_cents,
      'discount_cents', 0,
      'promotion_id', NULL,
      'coupon_code', NULL
    );
  END IF;

  SELECT * INTO v_promotion
    FROM public.promotions
   WHERE guild_id = v_intent.guild_id
     AND coupon_code = v_code
   FOR UPDATE;
  IF NOT FOUND
     OR v_promotion.active IS DISTINCT FROM TRUE
     OR (v_promotion.start_date IS NOT NULL AND v_promotion.start_date > pg_catalog.clock_timestamp())
     OR (v_promotion.end_date IS NOT NULL AND v_promotion.end_date <= pg_catalog.clock_timestamp())
     OR (v_promotion.min_purchase_cents IS NOT NULL AND v_product.price_cents < v_promotion.min_purchase_cents)
     OR (
       pg_catalog.cardinality(v_promotion.applies_to_product_ids) > 0
       AND NOT (v_intent.product_id = ANY(v_promotion.applies_to_product_ids))
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE =
      'commerce_reserve_checkout_pricing: coupon is invalid or not eligible';
  END IF;

  IF v_promotion.first_purchase_only THEN
    IF EXISTS (
      SELECT 1
        FROM public.orders
       WHERE guild_id = v_intent.guild_id
         AND customer_id = v_intent.customer_id
         AND source = 'purchase'
         AND (status = 'completed' OR (status = 'pending' AND checkout_active = TRUE))
    ) OR EXISTS (
      SELECT 1
        FROM public.commerce_checkout_intents AS prior_intent
       WHERE prior_intent.guild_id = v_intent.guild_id
         AND prior_intent.customer_id = v_intent.customer_id
         AND prior_intent.token <> p_checkout_token
         AND prior_intent.status = 'pending'
         AND prior_intent.final_amount_cents IS NOT NULL
         AND prior_intent.expires_at > pg_catalog.clock_timestamp()
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE =
        'commerce_reserve_checkout_pricing: coupon is limited to first purchases';
    END IF;
  END IF;

  IF v_promotion.max_uses IS NOT NULL THEN
    SELECT pg_catalog.count(*)::INTEGER INTO v_reserved_uses
      FROM public.commerce_checkout_intents AS reserved
     WHERE reserved.promotion_id = v_promotion.id
       AND reserved.order_id IS NULL
       AND reserved.status = 'pending'
       AND reserved.expires_at > pg_catalog.clock_timestamp();
    SELECT pg_catalog.count(*)::INTEGER INTO v_pending_order_uses
      FROM public.orders AS pending_order
     WHERE pending_order.promotion_id = v_promotion.id
       AND pending_order.status = 'pending'
       AND pending_order.checkout_active = TRUE;
    IF v_promotion.current_uses + v_reserved_uses + v_pending_order_uses >= v_promotion.max_uses THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE =
        'commerce_reserve_checkout_pricing: coupon usage limit reached';
    END IF;
  END IF;

  IF v_promotion.type = 'percentage' THEN
    v_discount := pg_catalog.floor(v_product.price_cents * v_promotion.value / 100)::INTEGER;
  ELSE
    v_discount := v_promotion.value::INTEGER;
  END IF;
  v_final := v_product.price_cents - v_discount;
  IF v_discount < 1 OR v_final < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE =
      'commerce_reserve_checkout_pricing: coupon would reduce the purchase below one cent';
  END IF;

  UPDATE public.commerce_checkout_intents
     SET promotion_id = v_promotion.id,
         promotion_code = v_code,
         discount_cents = v_discount,
         final_amount_cents = v_final
   WHERE token = p_checkout_token;

  RETURN pg_catalog.jsonb_build_object(
    'amount_cents', v_final,
    'discount_cents', v_discount,
    'promotion_id', v_promotion.id,
    'coupon_code', v_code
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_reserve_checkout_pricing(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_reserve_checkout_pricing(UUID, TEXT)
  TO service_role;

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
  v_expected_amount INTEGER;
  v_expected_currency TEXT;
  v_updated INTEGER;
BEGIN
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

  IF p_provider_kind = 'capture' THEN
    SELECT v_intent.final_amount_cents, currency
      INTO v_expected_amount, v_expected_currency
      FROM public.products
     WHERE id = p_product_id AND guild_id = p_guild_id AND active = TRUE AND type = 'one_time';
  ELSIF p_provider_kind = 'subscription' AND p_plan_id IS NOT NULL THEN
    SELECT plan.price_cents, plan.currency
      INTO v_expected_amount, v_expected_currency
      FROM public.plans AS plan
      JOIN public.products AS product ON product.id = plan.product_id
     WHERE plan.id = p_plan_id
       AND plan.product_id = p_product_id
       AND plan.active = TRUE
       AND product.guild_id = p_guild_id
       AND product.active = TRUE
       AND product.type = 'subscription';
  ELSE
  END IF;

  IF v_expected_amount IS NULL
     OR p_amount_cents IS DISTINCT FROM v_expected_amount
     OR p_currency IS DISTINCT FROM pg_catalog.upper(v_expected_currency) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
      'commerce_create_and_bind_active_paid_checkout: authoritative pricing mismatch';
  END IF;

  v_order := public.commerce_create_active_paid_checkout(
    p_order_number, p_guild_id, p_customer_id, p_product_id, p_plan_id,
    p_provider_kind, p_provider_id, p_approval_url, p_amount_cents, p_currency
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

  UPDATE public.orders AS target_order
     SET promotion_id = v_intent.promotion_id,
         discount_cents = v_intent.discount_cents
   WHERE id = v_order_id
     AND guild_id = p_guild_id
     AND customer_id = p_customer_id
     AND product_id = p_product_id
     AND amount_cents = p_amount_cents
     AND (promotion_id IS NULL OR promotion_id = v_intent.promotion_id)
     AND discount_cents IN (0, v_intent.discount_cents)
  RETURNING pg_catalog.to_jsonb(target_order.*) INTO v_order;

  IF v_order IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE =
      'commerce_create_and_bind_active_paid_checkout: promotion binding mismatch';
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

  RETURN v_order || pg_catalog.jsonb_build_object(
    'disposition', pg_catalog.coalesce(v_order ->> 'disposition', 'created'),
    'promotion_id', v_intent.promotion_id,
    'discount_cents', v_intent.discount_cents
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_create_and_bind_active_paid_checkout(
  UUID, TEXT, TEXT, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_create_and_bind_active_paid_checkout(
  UUID, TEXT, TEXT, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_promotion_current_uses()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP <> 'INSERT'
     AND OLD.promotion_id IS NOT NULL
     AND OLD.status = 'completed'
     AND (TG_OP = 'DELETE' OR NEW.status <> 'completed' OR NEW.promotion_id IS DISTINCT FROM OLD.promotion_id) THEN
    UPDATE public.promotions
       SET current_uses = pg_catalog.greatest(0, current_uses - 1)
     WHERE id = OLD.promotion_id;
  END IF;
  IF TG_OP <> 'DELETE'
     AND NEW.promotion_id IS NOT NULL
     AND NEW.status = 'completed'
     AND (TG_OP = 'INSERT' OR OLD.status <> 'completed' OR NEW.promotion_id IS DISTINCT FROM OLD.promotion_id) THEN
    UPDATE public.promotions
       SET current_uses = current_uses + 1
     WHERE id = NEW.promotion_id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_refresh_promotion_uses_insert_delete ON public.orders;
CREATE TRIGGER orders_refresh_promotion_uses_insert_delete
AFTER INSERT OR DELETE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.refresh_promotion_current_uses();

DROP TRIGGER IF EXISTS orders_refresh_promotion_uses_update ON public.orders;
CREATE TRIGGER orders_refresh_promotion_uses_update
AFTER UPDATE OF status, promotion_id ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.refresh_promotion_current_uses();

REVOKE ALL ON FUNCTION public.refresh_promotion_current_uses()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
