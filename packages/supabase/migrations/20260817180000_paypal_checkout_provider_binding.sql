-- Bind every newly exposed PayPal checkout to the exact API environment and
-- application identity that created it. A lookup made with different merchant
-- credentials can return 404 for a still-payable object, so an unbound or
-- mismatched checkout must remain blocked rather than being retired.
BEGIN;

ALTER TABLE public.commerce_checkout_intents
  ADD COLUMN IF NOT EXISTS provider_binding TEXT;

ALTER TABLE public.commerce_checkout_intents
  DROP CONSTRAINT IF EXISTS commerce_checkout_intents_provider_binding_check;
ALTER TABLE public.commerce_checkout_intents
  ADD CONSTRAINT commerce_checkout_intents_provider_binding_check CHECK (
    provider_binding IS NULL
    OR provider_binding ~ '^[a-f0-9]{64}$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_commerce_checkout_intents_bound_order
  ON public.commerce_checkout_intents (order_id)
  WHERE order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.commerce_preserve_checkout_provider_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.provider_binding IS DISTINCT FROM NEW.provider_binding THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'checkout provider binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_preserve_checkout_provider_binding()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_checkout_intents_preserve_provider_binding
  ON public.commerce_checkout_intents;
CREATE TRIGGER commerce_checkout_intents_preserve_provider_binding
  BEFORE UPDATE OF provider_binding
  ON public.commerce_checkout_intents
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_preserve_checkout_provider_binding();

-- Direct API writes cannot replace an already-issued approval URL. The
-- The privileged refresh RPC below is the only sanctioned transition and
-- rechecks the order, provider, prior URL, and provider binding under locks.
CREATE OR REPLACE FUNCTION public.commerce_guard_checkout_approval_url()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.checkout_approval_url IS DISTINCT FROM NEW.checkout_approval_url
     AND CURRENT_USER IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'API callers cannot replace a provider checkout approval URL';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_guard_checkout_approval_url()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_orders_guard_checkout_approval_url
  ON public.orders;
CREATE TRIGGER commerce_orders_guard_checkout_approval_url
  BEFORE UPDATE OF checkout_approval_url
  ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_checkout_approval_url();

CREATE OR REPLACE FUNCTION public.commerce_refresh_pending_checkout_approval_url(
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_provider_kind TEXT,
  p_provider_id TEXT,
  p_provider_binding TEXT,
  p_old_approval_url TEXT,
  p_new_approval_url TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_intent public.commerce_checkout_intents%ROWTYPE;
BEGIN
  IF p_order_id IS NULL
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_provider_kind NOT IN ('capture', 'subscription')
     OR p_provider_id IS NULL
     OR p_provider_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR p_provider_binding IS NULL
     OR p_provider_binding !~ '^[a-f0-9]{64}$'
     OR p_old_approval_url IS NULL
     OR p_old_approval_url <> pg_catalog.btrim(p_old_approval_url)
     OR pg_catalog.length(p_old_approval_url) NOT BETWEEN 1 AND 2048
     OR p_old_approval_url !~ '^https://([^/]+\.)?paypal\.com/'
     OR p_new_approval_url IS NULL
     OR p_new_approval_url <> pg_catalog.btrim(p_new_approval_url)
     OR pg_catalog.length(p_new_approval_url) NOT BETWEEN 1 AND 2048
     OR p_new_approval_url !~ '^https://([^/]+\.)?paypal\.com/' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_refresh_pending_checkout_approval_url: exact provider identity is required';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR v_order.customer_id IS DISTINCT FROM p_customer_id
     OR v_order.product_id IS DISTINCT FROM p_product_id
     OR v_order.status IS DISTINCT FROM 'pending'
     OR NOT v_order.checkout_active
     OR NOT COALESCE((v_order.source = 'purchase' OR v_order.source IS NULL), false)
     OR (
       p_provider_kind = 'capture'
       AND (
         v_order.paypal_order_id IS DISTINCT FROM p_provider_id
         OR v_order.paypal_subscription_id IS NOT NULL
       )
     )
     OR (
       p_provider_kind = 'subscription'
       AND (
         v_order.paypal_subscription_id IS DISTINCT FROM p_provider_id
         OR v_order.paypal_order_id IS NOT NULL
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_refresh_pending_checkout_approval_url: pending checkout identity mismatch';
  END IF;

  SELECT intent.*
    INTO v_intent
    FROM public.commerce_checkout_intents AS intent
   WHERE intent.order_id = v_order.id
     AND intent.status = 'bound'
   FOR UPDATE;

  IF NOT FOUND
     OR v_intent.provider_id IS DISTINCT FROM p_provider_id
     OR v_intent.provider_binding IS DISTINCT FROM p_provider_binding THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_refresh_pending_checkout_approval_url: provider binding mismatch';
  END IF;

  IF v_order.checkout_approval_url IS DISTINCT FROM p_old_approval_url THEN
    IF v_order.checkout_approval_url IS NOT DISTINCT FROM p_new_approval_url THEN
      RETURN pg_catalog.jsonb_build_object(
        'order_id', v_order.id,
        'checkout_approval_url', v_order.checkout_approval_url,
        'disposition', 'already_refreshed'
      );
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_refresh_pending_checkout_approval_url: approval URL changed concurrently';
  END IF;

  UPDATE public.orders AS paid_order
     SET checkout_approval_url = p_new_approval_url,
         updated_at = pg_catalog.clock_timestamp()
   WHERE paid_order.id = v_order.id
     AND paid_order.checkout_active = true
     AND paid_order.status = 'pending'
     AND paid_order.checkout_approval_url = p_old_approval_url
  RETURNING paid_order.* INTO v_order;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_refresh_pending_checkout_approval_url: approval URL transition raced';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_order.id,
    'checkout_approval_url', v_order.checkout_approval_url,
    'disposition', 'refreshed'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_refresh_pending_checkout_approval_url(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_refresh_pending_checkout_approval_url(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

COMMIT;
