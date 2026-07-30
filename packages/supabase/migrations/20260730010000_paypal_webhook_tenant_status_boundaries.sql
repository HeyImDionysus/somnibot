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
  v_input_count INTEGER;
  v_matched_count INTEGER;
  v_distinct_payment_count INTEGER;
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

  SELECT pg_catalog.cardinality(p_paypal_payment_ids),
         pg_catalog.count(DISTINCT payment_id)::INTEGER
    INTO v_input_count, v_distinct_payment_count
    FROM pg_catalog.unnest(p_paypal_payment_ids) AS payment_id;
  IF v_distinct_payment_count <> v_input_count THEN
    RAISE EXCEPTION 'duplicate PayPal dispute identities'
      USING ERRCODE = '22023';
  END IF;

  -- Disputes are rare and security-sensitive. A SHARE lock keeps the exact
  -- payment-id set stable across validation and mutation; inserts/updates wait
  -- until this function's transaction ends. Matching orders are row-locked so
  -- their tenant identities cannot move between the two statements either.
  LOCK TABLE public.payments IN SHARE MODE;
  PERFORM 1
    FROM public.orders AS orders
    JOIN public.payments AS payment
      ON payment.order_id = orders.id
   WHERE payment.paypal_payment_id = ANY (p_paypal_payment_ids)
   FOR UPDATE OF orders;

  SELECT
    pg_catalog.count(*)::INTEGER,
    pg_catalog.count(DISTINCT payment.guild_id)::INTEGER,
    pg_catalog.bool_or(
      payment.guild_id IS NULL
      OR payment.order_id IS NULL
      OR payment.provider IS DISTINCT FROM 'paypal'
      OR payment.paypal_resource_type IS NULL
      OR payment.paypal_resource_type NOT IN ('capture', 'sale')
      OR orders.id IS NULL
      OR orders.guild_id IS DISTINCT FROM payment.guild_id
    )
    INTO v_matched_count, v_guild_count, v_has_invalid_identity
    FROM public.payments AS payment
    LEFT JOIN public.orders AS orders
      ON orders.id = payment.order_id
   WHERE payment.paypal_payment_id = ANY (p_paypal_payment_ids);

  IF v_matched_count <> v_input_count
     OR COALESCE(v_has_invalid_identity, false)
     OR v_guild_count <> 1 THEN
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

CREATE OR REPLACE FUNCTION public.webhooks_list_scoped(
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_result TEXT,
  p_event_type TEXT,
  p_offset INTEGER,
  p_limit INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_sole_operator BOOLEAN;
  v_result JSONB;
BEGIN
  IF p_guild_id IS NULL
     OR p_guild_id !~ '^[0-9]{1,32}$'
     OR p_discord_id IS NULL
     OR p_discord_id = ''
     OR p_offset IS NULL
     OR p_offset < 0
     OR p_limit IS NULL
     OR p_limit < 1
     OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid scoped webhook list request'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize the ownership proof with guild inserts/updates/deletes for the
  -- duration of the protected read.
  LOCK TABLE public.guild IN SHARE MODE;
  v_is_sole_operator := public.webhooks_is_sole_instance_operator(p_discord_id);

  WITH scoped AS MATERIALIZED (
    SELECT event.*
      FROM public.webhook_events AS event
     WHERE (
       event.guild_id = p_guild_id
       OR (event.guild_id IS NULL AND v_is_sole_operator)
     )
       AND (p_result IS NULL OR event.result = p_result)
       AND (p_event_type IS NULL OR event.event_type = p_event_type)
  ),
  page AS (
    SELECT scoped.*
      FROM scoped
     ORDER BY scoped.processed_at DESC
     OFFSET p_offset
     LIMIT p_limit
  )
  SELECT pg_catalog.jsonb_build_object(
           'data',
           COALESCE(
             (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page)) FROM page),
             '[]'::JSONB
           ),
           'total',
           (SELECT pg_catalog.count(*) FROM scoped)
         )
    INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.webhooks_claim_scoped_replay(
  p_event_id TEXT,
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_stale_seconds INTEGER
)
RETURNS TABLE (
  outcome TEXT,
  event_data JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event public.webhook_events%ROWTYPE;
  v_is_sole_operator BOOLEAN;
BEGIN
  IF p_event_id IS NULL
     OR p_event_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR p_guild_id IS NULL
     OR p_guild_id !~ '^[0-9]{1,32}$'
     OR p_discord_id IS NULL
     OR p_discord_id = ''
     OR p_stale_seconds IS NULL
     OR p_stale_seconds < 1
     OR p_stale_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid scoped webhook replay claim'
      USING ERRCODE = '22023';
  END IF;

  -- Hold the ownership set stable through authorization and the replay claim.
  LOCK TABLE public.guild IN SHARE MODE;
  SELECT event.*
    INTO v_event
    FROM public.webhook_events AS event
   WHERE event.event_id = p_event_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::JSONB;
    RETURN;
  END IF;

  v_is_sole_operator := public.webhooks_is_sole_instance_operator(p_discord_id);
  IF v_event.guild_id IS DISTINCT FROM p_guild_id
     AND NOT (v_event.guild_id IS NULL AND v_is_sole_operator) THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::JSONB;
    RETURN;
  END IF;

  IF v_event.result IS NULL
     AND (
       v_event.processed_at IS NULL
       OR v_event.processed_at >=
          pg_catalog.clock_timestamp()
          - pg_catalog.make_interval(secs => p_stale_seconds)
     ) THEN
    RETURN QUERY SELECT 'processing'::TEXT, NULL::JSONB;
    RETURN;
  END IF;

  UPDATE public.webhook_events AS event
     SET result = NULL,
         error_details = NULL,
         replayed_at = pg_catalog.clock_timestamp(),
         replay_count = COALESCE(event.replay_count, 0) + 1,
         processed_at = pg_catalog.clock_timestamp()
   WHERE event.event_id = p_event_id;

  RETURN QUERY SELECT 'claimed'::TEXT, pg_catalog.to_jsonb(v_event);
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
REVOKE ALL ON FUNCTION public.webhooks_list_scoped(
  TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.webhooks_claim_scoped_replay(
  TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.webhooks_is_sole_instance_operator(TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_apply_paypal_dispute(TEXT[], BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_apply_capture_denied(TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.webhooks_list_scoped(
  TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.webhooks_claim_scoped_replay(
  TEXT, TEXT, TEXT, INTEGER
) TO service_role;

COMMENT ON FUNCTION public.webhooks_is_sole_instance_operator(TEXT) IS
  'Atomic sole-instance ownership proof for access to unattributed webhook rows.';
COMMENT ON FUNCTION public.commerce_apply_paypal_dispute(TEXT[], BOOLEAN) IS
  'Exact-payment, single-tenant paid-order dispute transition for PayPal webhooks.';
COMMENT ON FUNCTION public.commerce_apply_capture_denied(TEXT, TEXT) IS
  'Exact-PayPal-order pending-to-cancelled transition for denied captures.';
COMMENT ON FUNCTION public.webhooks_list_scoped(
  TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER
) IS 'Atomic tenant and sole-operator scoped webhook event listing.';
COMMENT ON FUNCTION public.webhooks_claim_scoped_replay(
  TEXT, TEXT, TEXT, INTEGER
) IS 'Atomic tenant and sole-operator authorization plus webhook replay claim.';

COMMIT;
