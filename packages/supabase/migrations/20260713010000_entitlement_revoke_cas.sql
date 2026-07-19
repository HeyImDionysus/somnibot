-- Make bot-driven entitlement revocation one exact, replay-safe database
-- transition.  The caller must present the status and updated_at value it
-- observed; a terminal replay is a no-op and any other changed live row is
-- stale.  Only the winning transaction records lifecycle audit evidence.
--
-- Lock canon: entitlement row -> ADV('noncommerce-entitlement-customer')
-- -> customers FOR SHARE -> products FOR SHARE, matching the entitlement
-- status triggers, the relink activation worker, and purge_member_data.

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

  -- Observe the immutable parent identity without any lock first, so a
  -- missing or malformed row reports its exact contract disposition before
  -- this transaction does any serialization work.
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

  -- Canonical carrier lock order (round-3 canon), shared by every acquirer of
  -- the {entitlement rows, ADV('noncommerce-entitlement-customer'),
  -- customers rows} triple:
  --
  --   entitlement FOR UPDATE -> advisory -> customers FOR SHARE
  --     -> products FOR SHARE
  --
  -- * The status triggers on this table fire while their UPDATE already holds
  --   the entitlement row lock and only then acquire the advisory and read
  --   the customer, so any customer-first or advisory-first acquisition here
  --   is a two-transaction AB-BA against every trigger-bearing lifecycle
  --   write.
  -- * The relink activation worker
  --   (commerce_request_noncommerce_relink_activation) holds queue ->
  --   entitlement FOR SHARE -> advisory -> customer FOR SHARE.
  -- * purge_member_data cancels the captured identity set's live entitlements
  --   first (rows exclusively locked, triggers then take the advisory) and
  --   locks customers last, with NOWAIT.
  -- * purge_guild_data's deletion phase removes entitlements before
  --   customers, so child-first is also the parent-delete direction; the old
  --   customer-first order here inverted against it.
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

  -- Customer-level carrier serialization comes immediately after the row
  -- lock, exactly as the trigger family acquires it mid-UPDATE.  The CAS
  -- evidence lives on the row locked above, so no lifecycle write can slip
  -- between the row lock and this acquisition.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'noncommerce-entitlement-customer:' || v_entitlement.customer_id::TEXT,
      0
    )
  );

  -- Parent share locks are taken only now, after the row lock and advisory.
  -- Relinks hold the customer row exclusively, so the discord_id read under
  -- this share lock is the committed current identity and stays pinned from
  -- here through the lifecycle event below; a relink that committed before
  -- this point simply IS the current identity the audit evidence must carry.
  -- The parent re-check above (40001) already rejected any drifted parent
  -- linkage, so a missing row here is the same contract violation as before.
  SELECT customer.* INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = v_entitlement.customer_id
     AND customer.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: customer identity mismatch';
  END IF;

  SELECT product.* INTO v_product
    FROM public.products AS product
   WHERE product.id = v_entitlement.product_id
     AND product.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: product identity mismatch';
  END IF;

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
