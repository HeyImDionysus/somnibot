CREATE TABLE IF NOT EXISTS public.portal_cancellation_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  entitlement_id UUID NOT NULL REFERENCES public.entitlements(id),
  order_id UUID NOT NULL REFERENCES public.orders(id),
  guild_id TEXT NOT NULL REFERENCES public.guild(id),
  customer_id UUID NOT NULL REFERENCES public.customers(id),
  paypal_subscription_id TEXT NOT NULL CHECK (
    paypal_subscription_id = pg_catalog.btrim(paypal_subscription_id)
    AND paypal_subscription_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
  ),
  cancellation_timing TEXT NOT NULL CHECK (
    cancellation_timing IN ('immediate', 'end-of-term')
  ),
  access_until TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'uncertain', 'provider_confirmed', 'completed', 'failed')
  ),
  provider_http_status INTEGER CHECK (
    provider_http_status BETWEEN 100 AND 599
  ),
  provider_debug_id TEXT CHECK (
    provider_debug_id ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  provider_status TEXT CHECK (
    provider_status IN ('ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED')
  ),
  reconciliation_state TEXT NOT NULL DEFAULT 'not_required' CHECK (
    reconciliation_state IN ('not_required', 'pending', 'confirmed_cancelled', 'confirmed_active', 'unavailable')
  ),
  failure_code TEXT CHECK (
    failure_code IN ('provider_rejected', 'provider_uncertain', 'local_commit_failed')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT portal_cancellation_operation_terminal_shape CHECK (
    (status = 'completed' AND provider_confirmed_at IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'provider_confirmed' AND provider_confirmed_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('pending', 'uncertain', 'failed') AND completed_at IS NULL)
  )
);

CREATE UNIQUE INDEX uniq_portal_cancellation_current_entitlement
  ON public.portal_cancellation_operations (entitlement_id)
  WHERE status IN ('pending', 'uncertain', 'provider_confirmed', 'completed');

CREATE OR REPLACE FUNCTION public.protect_portal_cancellation_operation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.guild_id IS DISTINCT FROM OLD.guild_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.paypal_subscription_id IS DISTINCT FROM OLD.paypal_subscription_id
     OR NEW.cancellation_timing IS DISTINCT FROM OLD.cancellation_timing
     OR NEW.access_until IS DISTINCT FROM OLD.access_until
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'portal cancellation operation: immutable identity changed';
  END IF;

  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('pending', 'uncertain', 'provider_confirmed', 'failed'))
    OR (OLD.status = 'uncertain' AND NEW.status IN ('uncertain', 'provider_confirmed', 'failed'))
    OR (OLD.status = 'provider_confirmed' AND NEW.status IN ('provider_confirmed', 'completed'))
    OR (OLD.status = 'completed' AND NEW.status = 'completed')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'portal cancellation operation: invalid state transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portal_cancellation_operation_immutable
  BEFORE UPDATE ON public.portal_cancellation_operations
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_portal_cancellation_operation();

REVOKE ALL ON FUNCTION public.protect_portal_cancellation_operation()
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.portal_cancellation_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_cancellation_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.portal_cancellation_operations TO service_role;

CREATE OR REPLACE FUNCTION public.claim_portal_cancellation_operation(
  p_entitlement_id UUID,
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_paypal_subscription_id TEXT,
  p_cancellation_timing TEXT,
  p_access_until TIMESTAMPTZ
)
RETURNS SETOF public.portal_cancellation_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claimed public.portal_cancellation_operations%ROWTYPE;
BEGIN
  IF p_entitlement_id IS NULL
     OR p_order_id IS NULL
     OR p_guild_id IS NULL
     OR p_customer_id IS NULL
     OR p_paypal_subscription_id IS NULL
     OR p_cancellation_timing NOT IN ('immediate', 'end-of-term')
     OR p_access_until IS NULL
     OR NOT pg_catalog.isfinite(p_access_until) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'portal cancellation operation: complete valid identity is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_entitlement_id::text, 0)
  );

  SELECT operation.*
    INTO claimed
    FROM public.portal_cancellation_operations AS operation
   WHERE operation.entitlement_id = p_entitlement_id
     AND operation.status IN ('pending', 'uncertain', 'provider_confirmed', 'completed')
   ORDER BY operation.created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF claimed.id IS NULL THEN
    INSERT INTO public.portal_cancellation_operations (
      entitlement_id,
      order_id,
      guild_id,
      customer_id,
      paypal_subscription_id,
      cancellation_timing,
      access_until
    ) VALUES (
      p_entitlement_id,
      p_order_id,
      p_guild_id,
      p_customer_id,
      p_paypal_subscription_id,
      p_cancellation_timing,
      p_access_until
    )
    RETURNING * INTO claimed;
  END IF;

  IF claimed.id IS NULL
     OR claimed.order_id IS DISTINCT FROM p_order_id
     OR claimed.guild_id IS DISTINCT FROM p_guild_id
     OR claimed.customer_id IS DISTINCT FROM p_customer_id
     OR claimed.paypal_subscription_id IS DISTINCT FROM p_paypal_subscription_id
     OR claimed.cancellation_timing IS DISTINCT FROM p_cancellation_timing
     OR claimed.access_until IS DISTINCT FROM p_access_until THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'portal cancellation operation: immutable intent mismatch';
  END IF;

  RETURN NEXT claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_portal_cancellation_operation(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_portal_cancellation_operation(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ
) TO service_role;

COMMENT ON TABLE public.portal_cancellation_operations IS
  'Durable PayPal cancellation identities with immutable failed-attempt history and one current operation per entitlement.';
COMMENT ON COLUMN public.portal_cancellation_operations.request_id IS
  'Stable PayPal-Request-Id reused for every retry of this cancellation intent.';
