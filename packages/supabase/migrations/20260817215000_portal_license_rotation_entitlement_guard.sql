BEGIN;

CREATE OR REPLACE FUNCTION public.license_rotate_key_without_receipt_stage(
  p_license_key_id UUID,
  p_new_key_hash TEXT,
  p_new_key_prefix TEXT,
  p_new_key_suffix TEXT,
  p_actor_discord_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old public.license_keys%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_new_id UUID;
  v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
  SELECT license_key.* INTO v_old
    FROM public.license_keys AS license_key
    WHERE license_key.id = p_license_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_old.status = 'revoked' AND v_old.revocation_reason = 'rotated' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_rotated',
      'old_key_id', v_old.id,
      'new_key_id', v_old.rotated_to_key_id
    );
  END IF;

  IF v_old.status NOT IN ('pending_activation', 'active', 'suspended') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_rotatable',
      'key_status', v_old.status
    );
  END IF;

  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
    WHERE entitlement.license_key_id = v_old.id
      AND entitlement.order_id = v_old.order_id
      AND entitlement.customer_id = v_old.customer_id
      AND entitlement.product_id = v_old.product_id
      AND entitlement.guild_id = v_old.guild_id
      AND (
        (
          entitlement.status = 'active'
          AND (
            entitlement.expires_at IS NULL
            OR entitlement.expires_at > v_now
          )
        )
        OR (
          entitlement.status = 'grace_period'
          AND entitlement.grace_period_ends_at > v_now
        )
      )
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'license_rotate_key_without_receipt_stage: entitlement is not usable';
  END IF;

  UPDATE public.license_keys
     SET status = 'revoked',
         revoked_at = v_now,
         revocation_reason = 'rotated'
   WHERE id = v_old.id;

  INSERT INTO public.license_keys (
    order_id, customer_id, product_id, guild_id,
    key_hash, key_prefix, key_suffix, bound_discord_id,
    status, activated_at, expires_at
  ) VALUES (
    v_old.order_id, v_old.customer_id, v_old.product_id, v_old.guild_id,
    p_new_key_hash, p_new_key_prefix, p_new_key_suffix, v_old.bound_discord_id,
    v_old.status,
    CASE WHEN v_old.status = 'active' THEN COALESCE(v_old.activated_at, v_now) END,
    v_old.expires_at
  )
  RETURNING id INTO v_new_id;

  UPDATE public.license_keys
     SET rotated_to_key_id = v_new_id
   WHERE id = v_old.id;

  UPDATE public.entitlements
     SET license_key_id = v_new_id
   WHERE license_key_id = v_old.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'license_rotate_key_without_receipt_stage: entitlement relink raced';
  END IF;

  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, target_type, target_id, category, details
  ) VALUES (
    v_old.guild_id,
    CASE WHEN p_actor_discord_id IS NULL THEN 'system' ELSE 'user' END,
    COALESCE(p_actor_discord_id, 'system'),
    'key.rotated',
    'license_key',
    v_old.id::TEXT,
    'commerce',
    pg_catalog.jsonb_build_object(
      'old_key_id', v_old.id,
      'new_key_id', v_new_id,
      'old_key_suffix', v_old.key_suffix,
      'new_key_suffix', p_new_key_suffix
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'rotated',
    'old_key_id', v_old.id,
    'new_key_id', v_new_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.license_rotate_key_without_receipt_stage(
  UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
