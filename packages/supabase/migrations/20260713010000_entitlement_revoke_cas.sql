-- Make bot-driven entitlement revocation one exact, replay-safe database
-- transition.  The caller must present the status and updated_at value it
-- observed; a terminal replay is a no-op and any other changed live row is
-- stale.  Only the winning transaction records lifecycle audit evidence.

BEGIN;

CREATE OR REPLACE FUNCTION public.commerce_revoke_entitlement_exact(
  p_entitlement_id UUID,
  p_guild_id TEXT,
  p_expected_status TEXT,
  p_expected_updated_at TIMESTAMPTZ,
  p_reason TEXT
)
RETURNS TABLE (
  disposition TEXT,
  transition_id UUID,
  entitlement_id UUID,
  guild_id TEXT,
  customer_id UUID,
  discord_id TEXT,
  product_id UUID,
  product_name TEXT,
  license_key_id UUID,
  role_ids TEXT[],
  status TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_observed public.entitlements%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_target_status TEXT;
  v_transition_id UUID;
BEGIN
  IF p_entitlement_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = ''
     OR NOT COALESCE(
       p_expected_status IN (
         'active', 'pending', 'grace_period', 'suspended', 'expired', 'cancelled'
       ),
       false
     )
     OR (
       p_expected_updated_at IS NOT NULL
       AND NOT pg_catalog.isfinite(p_expected_updated_at)
     )
     OR NOT COALESCE(
       p_reason IN ('expired', 'cancelled', 'revoked', 'refund'),
       false
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: request contract is invalid';
  END IF;

  v_target_status := CASE p_reason
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'expired'
  END;

  -- Observe only the immutable parent identity first. Locking the child before
  -- its FK parents would invert PostgreSQL's parent-delete order and can
  -- deadlock (child UPDATE waits on parent while parent DELETE's FK check waits
  -- on the child). The exact status decision is made only after parent locks.
  SELECT entitlement.* INTO v_observed
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
     AND entitlement.guild_id = p_guild_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'not_found'::TEXT,
      NULL::UUID,
      NULL::UUID,
      NULL::TEXT,
      NULL::UUID,
      NULL::TEXT,
      NULL::UUID,
      NULL::TEXT,
      NULL::UUID,
      NULL::TEXT[],
      NULL::TEXT,
      NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF v_observed.customer_id IS NULL OR v_observed.product_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: parent identity is malformed';
  END IF;

  -- Canonical FK lock order: customer -> product -> entitlement. Parent
  -- deletion therefore either finishes before this transition or waits behind
  -- it; neither side can hold the lock the other side needs next.
  SELECT customer.* INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id
     AND customer.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: customer identity mismatch';
  END IF;

  SELECT product.* INTO v_product
    FROM public.products AS product
   WHERE product.id = v_observed.product_id
     AND product.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: product identity mismatch';
  END IF;

  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
     AND entitlement.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'not_found'::TEXT,
      NULL::UUID,
      NULL::UUID,
      NULL::TEXT,
      NULL::UUID,
      NULL::TEXT,
      NULL::UUID,
      NULL::TEXT,
      NULL::UUID,
      NULL::TEXT[],
      NULL::TEXT,
      NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF v_entitlement.customer_id IS DISTINCT FROM v_observed.customer_id
     OR v_entitlement.product_id IS DISTINCT FROM v_observed.product_id THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'commerce_revoke_entitlement_exact: parent identity changed';
  END IF;

  -- Customer-level carrier serialization comes only after the entitlement row
  -- lock.  The status triggers on this table acquire the same advisory key
  -- while their firing UPDATE already holds the row lock, so an advisory-first
  -- acquisition here is a two-transaction lock-order inversion against every
  -- trigger-bearing lifecycle write (row -> advisory vs advisory -> row).  The
  -- customer FOR SHARE above pins discord_id against relinks for this whole
  -- transaction, and the CAS evidence lives on the row locked above, so no
  -- write can slip between the row lock and this acquisition.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'noncommerce-entitlement-customer:' || v_entitlement.customer_id::TEXT,
      0
    )
  );

  -- Every already-terminal row is a completed operational no-op.  In
  -- particular, a late expiry may not overwrite a cancellation (or vice
  -- versa), and no replay may manufacture a second lifecycle audit row.
  IF v_entitlement.status IN ('expired', 'cancelled') THEN
    RETURN QUERY SELECT
      'noop'::TEXT,
      NULL::UUID,
      v_entitlement.id,
      v_entitlement.guild_id,
      v_entitlement.customer_id,
      NULL::TEXT,
      v_entitlement.product_id,
      NULL::TEXT,
      v_entitlement.license_key_id,
      COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[]),
      v_entitlement.status,
      v_entitlement.updated_at;
    RETURN;
  END IF;

  -- The locked row is still live, but it is not the state the caller
  -- observed.  updated_at is maintained by the table trigger, so pairing it
  -- with status also rejects status-only ABA and same-status intervening
  -- lifecycle writes.
  IF v_entitlement.status IS DISTINCT FROM p_expected_status
     OR v_entitlement.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN QUERY SELECT
      'stale'::TEXT,
      NULL::UUID,
      v_entitlement.id,
      v_entitlement.guild_id,
      v_entitlement.customer_id,
      NULL::TEXT,
      v_entitlement.product_id,
      NULL::TEXT,
      v_entitlement.license_key_id,
      COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[]),
      v_entitlement.status,
      v_entitlement.updated_at;
    RETURN;
  END IF;

  IF v_entitlement.status NOT IN ('active', 'pending', 'grace_period', 'suspended') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: stored status is invalid';
  END IF;

  v_transition_id := gen_random_uuid();

  UPDATE public.entitlements AS entitlement
     SET status = v_target_status,
         cancelled_at = CASE
           WHEN v_target_status = 'cancelled' THEN COALESCE(
             entitlement.cancelled_at,
             pg_catalog.clock_timestamp()
           )
           ELSE entitlement.cancelled_at
         END
   WHERE entitlement.id = v_entitlement.id
     AND entitlement.guild_id = p_guild_id
     AND entitlement.status = p_expected_status
     AND entitlement.updated_at IS NOT DISTINCT FROM p_expected_updated_at
   RETURNING entitlement.* INTO v_entitlement;

  IF NOT FOUND THEN
    -- The FOR UPDATE lock makes this unreachable unless another database
    -- trigger changed the exact CAS identity.  Never turn that anomaly into a
    -- false no-op after side-effect authority was expected.
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'commerce_revoke_entitlement_exact: transition authority changed';
  END IF;

  IF v_entitlement.license_key_id IS NOT NULL THEN
    UPDATE public.license_sessions AS session
       SET active = false,
           deactivated_at = pg_catalog.clock_timestamp(),
           deactivation_reason = 'entitlement_revoked'
     WHERE session.license_key_id = v_entitlement.license_key_id
       AND session.active = true;
  END IF;

  UPDATE public.alerts AS alert
     SET resolved = true,
         resolved_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.guild_id = p_guild_id
     AND alert.alert_type = 'entitlement_grace_period'
     AND alert.metadata ->> 'entitlement_id' = v_entitlement.id::TEXT
     AND alert.resolved = false;

  PERFORM public.commerce_record_entitlement_lifecycle_event(
    v_transition_id,
    'entitlement.revoked',
    v_entitlement.id,
    v_entitlement.guild_id,
    v_customer.discord_id,
    v_entitlement.product_id,
    v_product.name,
    COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[]),
    p_reason
  );

  RETURN QUERY SELECT
    'applied'::TEXT,
    v_transition_id,
    v_entitlement.id,
    v_entitlement.guild_id,
    v_entitlement.customer_id,
    v_customer.discord_id,
    v_entitlement.product_id,
    v_product.name,
    v_entitlement.license_key_id,
    COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[]),
    v_entitlement.status,
    v_entitlement.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_revoke_entitlement_exact(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_revoke_entitlement_exact(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT
) TO service_role;

COMMIT;
