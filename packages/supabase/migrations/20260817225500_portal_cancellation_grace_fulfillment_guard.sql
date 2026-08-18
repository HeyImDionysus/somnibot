ALTER TABLE public.entitlements
  ADD COLUMN IF NOT EXISTS portal_cancellation_timing TEXT,
  ADD COLUMN IF NOT EXISTS portal_cancellation_access_until TIMESTAMPTZ;

ALTER TABLE public.entitlements
  DROP CONSTRAINT IF EXISTS entitlements_portal_cancellation_timing_check;
ALTER TABLE public.entitlements
  ADD CONSTRAINT entitlements_portal_cancellation_timing_check
  CHECK (
    (portal_cancellation_timing IS NULL
      AND portal_cancellation_access_until IS NULL)
    OR
    (portal_cancellation_timing IN ('immediate', 'end-of-term')
      AND portal_cancellation_access_until IS NOT NULL)
  );

COMMENT ON COLUMN public.entitlements.portal_cancellation_timing IS
  'Applied buyer-portal cancellation policy. NULL for provider, seller, and lifecycle cancellations.';
COMMENT ON COLUMN public.entitlements.portal_cancellation_access_until IS
  'Durable access boundary confirmed with a buyer-portal cancellation.';

CREATE OR REPLACE FUNCTION public.commerce_preserve_cancellation_grace_boundary()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cancellation_timing TEXT;
  v_access_until TIMESTAMPTZ;
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
     OR NEW.payload ->> 'fulfillment_type'
          IS DISTINCT FROM 'subscription_cancelled' THEN
    RETURN NEW;
  END IF;

  SELECT
    entitlement.portal_cancellation_timing,
    entitlement.portal_cancellation_access_until
    INTO v_cancellation_timing, v_access_until
    FROM public.entitlements AS entitlement
   WHERE entitlement.guild_id = NEW.guild_id
     AND entitlement.order_id::TEXT = NEW.payload ->> 'order_id'
     AND entitlement.customer_id::TEXT = NEW.payload ->> 'customer_id'
     AND entitlement.product_id::TEXT = NEW.payload ->> 'product_id'
     AND entitlement.type = 'subscription'
   ORDER BY entitlement.created_at DESC
   LIMIT 1
   FOR KEY SHARE;

  IF v_cancellation_timing = 'end-of-term'
     AND v_access_until > pg_catalog.clock_timestamp()
     AND (NEW.next_retry_at IS NULL OR NEW.next_retry_at < v_access_until) THEN
    NEW.next_retry_at := v_access_until;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_preserve_cancellation_grace_boundary()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_bot_action_queue_preserve_cancellation_grace
  ON public.bot_action_queue;
CREATE TRIGGER trg_bot_action_queue_preserve_cancellation_grace
  BEFORE INSERT OR UPDATE ON public.bot_action_queue
  FOR EACH ROW
  WHEN (NEW.action = 'fulfill_cancellation')
  EXECUTE FUNCTION public.commerce_preserve_cancellation_grace_boundary();

CREATE OR REPLACE FUNCTION public.commerce_reclamp_portal_cancellation_queue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.portal_cancellation_timing IS DISTINCT FROM 'end-of-term'
     OR NEW.portal_cancellation_access_until IS NULL
     OR NEW.portal_cancellation_access_until <= pg_catalog.clock_timestamp() THEN
    RETURN NEW;
  END IF;

  UPDATE public.bot_action_queue AS queue
     SET next_retry_at = NEW.portal_cancellation_access_until
   WHERE queue.guild_id = NEW.guild_id
     AND queue.action = 'fulfill_cancellation'
     AND queue.status IN ('staged', 'pending', 'failed')
     AND queue.payload ->> 'fulfillment_type' = 'subscription_cancelled'
     AND queue.payload ->> 'order_id' = NEW.order_id::TEXT
     AND queue.payload ->> 'customer_id' = NEW.customer_id::TEXT
     AND queue.payload ->> 'product_id' = NEW.product_id::TEXT
     AND (queue.next_retry_at IS NULL
       OR queue.next_retry_at < NEW.portal_cancellation_access_until);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_reclamp_portal_cancellation_queue()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_entitlements_reclamp_portal_cancellation_queue
  ON public.entitlements;
CREATE TRIGGER trg_entitlements_reclamp_portal_cancellation_queue
  AFTER UPDATE OF portal_cancellation_timing, portal_cancellation_access_until
  ON public.entitlements
  FOR EACH ROW
  WHEN (
    OLD.portal_cancellation_timing IS DISTINCT FROM NEW.portal_cancellation_timing
    OR OLD.portal_cancellation_access_until IS DISTINCT FROM NEW.portal_cancellation_access_until
  )
  EXECUTE FUNCTION public.commerce_reclamp_portal_cancellation_queue();

WITH cancellation_boundaries AS (
  SELECT
    queue.id AS action_id,
    pg_catalog.max(entitlement.portal_cancellation_access_until) AS access_until
  FROM public.bot_action_queue AS queue
  JOIN public.entitlements AS entitlement
    ON entitlement.guild_id = queue.guild_id
   AND entitlement.order_id::TEXT = queue.payload ->> 'order_id'
   AND entitlement.customer_id::TEXT = queue.payload ->> 'customer_id'
   AND entitlement.product_id::TEXT = queue.payload ->> 'product_id'
   AND entitlement.type = 'subscription'
   AND entitlement.portal_cancellation_timing = 'end-of-term'
   AND entitlement.portal_cancellation_access_until > pg_catalog.clock_timestamp()
  WHERE queue.action = 'fulfill_cancellation'
    AND queue.status IN ('staged', 'pending', 'failed')
    AND queue.payload ->> 'fulfillment_type' = 'subscription_cancelled'
  GROUP BY queue.id
)
UPDATE public.bot_action_queue AS queue
   SET next_retry_at = boundary.access_until
  FROM cancellation_boundaries AS boundary
 WHERE queue.id = boundary.action_id
   AND (queue.next_retry_at IS NULL
     OR queue.next_retry_at < boundary.access_until);
