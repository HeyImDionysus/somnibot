-- =============================================================================
-- PayPal webhook tenant and paid-order status boundaries.
--
-- Paid orders are intentionally protected from direct service_role writes by
-- commerce_normalize_checkout_active(). These exact-identity SECURITY DEFINER
-- functions are the only sanctioned transitions for dispute and denied-capture
-- webhooks. Mixed-tenant disputes fail before any order is changed.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.webhooks_is_sole_instance_operator(
  p_discord_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_discord_id IS NOT NULL
     AND p_discord_id <> ''
     AND EXISTS (SELECT 1 FROM public.guild)
     AND NOT EXISTS (
       SELECT 1
         FROM public.guild
        WHERE owner_discord_id IS DISTINCT FROM p_discord_id
     );
$$;

CREATE OR REPLACE FUNCTION public.commerce_apply_paypal_dispute(
  p_paypal_payment_ids TEXT[],
  p_mark_disputed BOOLEAN
)
RETURNS TABLE (
  guild_id TEXT,
  order_id UUID,
  marked_disputed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_guild_count INTEGER;
  v_has_invalid_identity BOOLEAN;
BEGIN
  IF p_paypal_payment_ids IS NULL
     OR pg_catalog.cardinality(p_paypal_payment_ids) < 1
     OR pg_catalog.cardinality(p_paypal_payment_ids) > 1000
     OR p_mark_disputed IS NULL
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(p_paypal_payment_ids) AS payment_id
        WHERE payment_id IS NULL
           OR payment_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     ) THEN
    RAISE EXCEPTION 'invalid PayPal dispute identities'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    pg_catalog.count(DISTINCT payment.guild_id)::INTEGER,
    pg_catalog.bool_or(
      payment.guild_id IS NULL
      OR payment.order_id IS NULL
      OR orders.id IS NULL
      OR orders.guild_id IS DISTINCT FROM payment.guild_id
    )
    INTO v_guild_count, v_has_invalid_identity
    FROM public.payments AS payment
    LEFT JOIN public.orders AS orders
      ON orders.id = payment.order_id
   WHERE payment.paypal_payment_id = ANY (p_paypal_payment_ids);

  IF COALESCE(v_has_invalid_identity, false) OR v_guild_count > 1 THEN
    RAISE EXCEPTION 'PayPal dispute matches multiple or malformed tenant identities'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH matched AS (
    SELECT DISTINCT
           payment.guild_id,
           payment.order_id
      FROM public.payments AS payment
      JOIN public.orders AS orders
        ON orders.id = payment.order_id
       AND orders.guild_id = payment.guild_id
     WHERE payment.paypal_payment_id = ANY (p_paypal_payment_ids)
  ),
  updated AS (
    UPDATE public.orders AS orders
       SET status = 'disputed',
           updated_at = pg_catalog.clock_timestamp()
      FROM matched
     WHERE p_mark_disputed
       AND orders.id = matched.order_id
       AND orders.guild_id = matched.guild_id
       AND orders.status = 'completed'
    RETURNING orders.id
  )
  SELECT matched.guild_id,
         matched.order_id,
         updated.id IS NOT NULL
    FROM matched
    LEFT JOIN updated ON updated.id = matched.order_id
   ORDER BY matched.order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_apply_capture_denied(
  p_paypal_order_id TEXT,
  p_claimed_guild_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  guild_id TEXT,
  order_id UUID,
  previous_status TEXT,
  order_cancelled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order_id UUID;
  v_guild_id TEXT;
  v_status TEXT;
  v_cancelled BOOLEAN := false;
BEGIN
  IF p_paypal_order_id IS NULL
     OR p_paypal_order_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$' THEN
    RAISE EXCEPTION 'invalid denied-capture PayPal order identity'
      USING ERRCODE = '22023';
  END IF;

  SELECT orders.id, orders.guild_id, orders.status
    INTO v_order_id, v_guild_id, v_status
    FROM public.orders AS orders
   WHERE orders.paypal_order_id = p_paypal_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_guild_id IS NULL THEN
    RAISE EXCEPTION 'denied-capture order has no tenant identity'
      USING ERRCODE = '23514';
  END IF;
  IF p_claimed_guild_id IS NOT NULL
     AND p_claimed_guild_id IS DISTINCT FROM v_guild_id THEN
    RAISE EXCEPTION 'denied-capture metadata conflicts with the local tenant'
      USING ERRCODE = '22023';
  END IF;

  IF v_status = 'pending' THEN
    UPDATE public.orders AS orders
       SET status = 'cancelled',
           updated_at = pg_catalog.clock_timestamp()
     WHERE orders.id = v_order_id
       AND orders.guild_id = v_guild_id
       AND orders.paypal_order_id = p_paypal_order_id
       AND orders.status = 'pending';
    v_cancelled := FOUND;
  END IF;

  RETURN QUERY
  SELECT v_guild_id, v_order_id, v_status, v_cancelled;
END;
$$;

REVOKE ALL ON FUNCTION public.webhooks_is_sole_instance_operator(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_apply_paypal_dispute(TEXT[], BOOLEAN)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_apply_capture_denied(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.webhooks_is_sole_instance_operator(TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_apply_paypal_dispute(TEXT[], BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_apply_capture_denied(TEXT, TEXT)
  TO service_role;

COMMENT ON FUNCTION public.webhooks_is_sole_instance_operator(TEXT) IS
  'Atomic sole-instance ownership proof for access to unattributed webhook rows.';
COMMENT ON FUNCTION public.commerce_apply_paypal_dispute(TEXT[], BOOLEAN) IS
  'Exact-payment, single-tenant paid-order dispute transition for PayPal webhooks.';
COMMENT ON FUNCTION public.commerce_apply_capture_denied(TEXT, TEXT) IS
  'Exact-PayPal-order pending-to-cancelled transition for denied captures.';

COMMIT;
