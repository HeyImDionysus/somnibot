CREATE OR REPLACE FUNCTION public.commerce_preserve_cancellation_grace_boundary()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_grace_until TIMESTAMPTZ;
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
     OR NEW.payload ->> 'fulfillment_type'
          IS DISTINCT FROM 'subscription_cancelled' THEN
    RETURN NEW;
  END IF;

  SELECT pg_catalog.max(entitlement.grace_period_ends_at)
    INTO v_grace_until
    FROM public.entitlements AS entitlement
   WHERE entitlement.guild_id = NEW.guild_id
     AND entitlement.order_id::TEXT = NEW.payload ->> 'order_id'
     AND entitlement.customer_id::TEXT = NEW.payload ->> 'customer_id'
     AND entitlement.product_id::TEXT = NEW.payload ->> 'product_id'
     AND entitlement.type = 'subscription'
     AND entitlement.status = 'grace_period'
     AND entitlement.grace_period_ends_at > pg_catalog.clock_timestamp();

  IF v_grace_until IS NOT NULL
     AND (NEW.next_retry_at IS NULL OR NEW.next_retry_at < v_grace_until) THEN
    NEW.next_retry_at := v_grace_until;
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

WITH grace_boundaries AS (
  SELECT
    queue.id AS action_id,
    pg_catalog.max(entitlement.grace_period_ends_at) AS grace_until
  FROM public.bot_action_queue AS queue
  JOIN public.entitlements AS entitlement
    ON entitlement.guild_id = queue.guild_id
   AND entitlement.order_id::TEXT = queue.payload ->> 'order_id'
   AND entitlement.customer_id::TEXT = queue.payload ->> 'customer_id'
   AND entitlement.product_id::TEXT = queue.payload ->> 'product_id'
   AND entitlement.type = 'subscription'
   AND entitlement.status = 'grace_period'
   AND entitlement.grace_period_ends_at > pg_catalog.clock_timestamp()
  WHERE queue.action = 'fulfill_cancellation'
    AND queue.status IN ('staged', 'pending', 'failed')
    AND queue.payload ->> 'fulfillment_type' = 'subscription_cancelled'
  GROUP BY queue.id
)
UPDATE public.bot_action_queue AS queue
   SET next_retry_at = boundary.grace_until
  FROM grace_boundaries AS boundary
 WHERE queue.id = boundary.action_id
   AND (queue.next_retry_at IS NULL
     OR queue.next_retry_at < boundary.grace_until);
