-- First project validation must not create an active device session beneath a
-- pending key.  Keep the seat decision, pending->active transition, and session
-- write in one transaction so every refusal leaves the key pending and every
-- successful tracked validation satisfies the active-session foreign key.

CREATE OR REPLACE FUNCTION public.license_validate_device_atomic(
  p_license_key_id UUID,
  p_product_id UUID,
  p_activate_pending BOOLEAN,
  p_device_fingerprint TEXT,
  p_device_name TEXT DEFAULT NULL,
  p_app_version TEXT DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL,
  p_max_devices INT DEFAULT 3,
  p_device_policy TEXT DEFAULT 'evict_oldest'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key_status TEXT;
  v_key_product_id UUID;
  v_existing_session_id UUID;
  v_existing_active BOOLEAN;
  v_existing_deactivation_reason TEXT;
  v_session_count INT;
  v_oldest_id UUID;
  v_session_id UUID;
  v_status TEXT;
  v_evicted BOOLEAN := false;
  v_activated BOOLEAN := false;
  v_now TIMESTAMPTZ := now();
BEGIN
  SELECT status, product_id
    INTO v_key_status, v_key_product_id
    FROM public.license_keys
    WHERE id = p_license_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 'key_unavailable',
      'session_id', NULL,
      'activated', false
    );
  END IF;

  IF v_key_status = 'pending_activation' THEN
    IF NOT p_activate_pending THEN
      RETURN jsonb_build_object(
        'status', 'pending_activation',
        'session_id', NULL,
        'activated', false
      );
    END IF;

    IF v_key_product_id IS DISTINCT FROM p_product_id THEN
      RETURN jsonb_build_object(
        'status', 'product_mismatch',
        'session_id', NULL,
        'activated', false
      );
    END IF;
  ELSIF v_key_status <> 'active' THEN
    RETURN jsonb_build_object(
      'status', v_key_status,
      'session_id', NULL,
      'activated', false
    );
  END IF;

  SELECT id, active, deactivation_reason
    INTO v_existing_session_id, v_existing_active, v_existing_deactivation_reason
    FROM public.license_sessions
    WHERE license_key_id = p_license_key_id
      AND device_fingerprint = p_device_fingerprint
    FOR UPDATE;

  IF v_existing_session_id IS NOT NULL AND v_existing_active THEN
    IF v_key_status = 'pending_activation' THEN
      UPDATE public.license_keys SET
        status = 'active',
        activated_at = COALESCE(activated_at, v_now),
        updated_at = v_now
      WHERE id = p_license_key_id
        AND product_id = p_product_id
        AND status = 'pending_activation';

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Pending license activation lost its locked state'
          USING ERRCODE = '40001';
      END IF;
      v_activated := true;
    END IF;

    UPDATE public.license_sessions SET
      last_seen_at = v_now,
      device_name = COALESCE(p_device_name, device_name),
      app_version = COALESCE(p_app_version, app_version),
      ip_address = COALESCE(p_ip_address, ip_address)
    WHERE id = v_existing_session_id;

    SELECT count(*) INTO v_session_count
      FROM public.license_sessions
      WHERE license_key_id = p_license_key_id
        AND active = true;

    RETURN jsonb_build_object(
      'status', 'existing',
      'session_id', v_existing_session_id,
      'active_devices', v_session_count,
      'max_devices', p_max_devices,
      'evicted', false,
      'activated', v_activated
    );
  END IF;

  IF v_existing_session_id IS NOT NULL
     AND v_existing_deactivation_reason = 'admin_revoked' THEN
    SELECT count(*) INTO v_session_count
      FROM public.license_sessions
      WHERE license_key_id = p_license_key_id
        AND active = true;

    RETURN jsonb_build_object(
      'status', 'session_invalidated',
      'session_id', NULL,
      'deactivation_reason', 'admin_revoked',
      'active_devices', v_session_count,
      'max_devices', p_max_devices,
      'evicted', false,
      'activated', false
    );
  END IF;

  SELECT count(*) INTO v_session_count
    FROM public.license_sessions
    WHERE license_key_id = p_license_key_id
      AND active = true;

  IF v_session_count >= p_max_devices THEN
    IF p_device_policy = 'reject' THEN
      RETURN jsonb_build_object(
        'status', 'over_device_limit',
        'active_devices', v_session_count,
        'max_devices', p_max_devices,
        'evicted', false,
        'activated', false
      );
    END IF;

    SELECT id INTO v_oldest_id
      FROM public.license_sessions
      WHERE license_key_id = p_license_key_id
        AND active = true
      ORDER BY last_seen_at ASC
      LIMIT 1;

    IF v_oldest_id IS NOT NULL THEN
      UPDATE public.license_sessions SET
        active = false,
        deactivated_at = v_now,
        deactivation_reason = 'device_limit'
      WHERE id = v_oldest_id;
      v_evicted := true;
    END IF;
  END IF;

  IF v_key_status = 'pending_activation' THEN
    UPDATE public.license_keys SET
      status = 'active',
      activated_at = COALESCE(activated_at, v_now),
      updated_at = v_now
    WHERE id = p_license_key_id
      AND product_id = p_product_id
      AND status = 'pending_activation';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pending license activation lost its locked state'
        USING ERRCODE = '40001';
    END IF;
    v_activated := true;
  END IF;

  IF v_existing_session_id IS NOT NULL THEN
    UPDATE public.license_sessions SET
      active = true,
      deactivated_at = NULL,
      deactivation_reason = NULL,
      first_seen_at = v_now,
      last_seen_at = v_now,
      device_name = COALESCE(p_device_name, device_name),
      app_version = COALESCE(p_app_version, app_version),
      ip_address = COALESCE(p_ip_address, ip_address)
    WHERE id = v_existing_session_id;

    v_session_id := v_existing_session_id;
    v_status := 'reactivated';
  ELSE
    INSERT INTO public.license_sessions (
      license_key_id, device_fingerprint, device_name,
      app_version, ip_address, active, first_seen_at, last_seen_at
    ) VALUES (
      p_license_key_id, p_device_fingerprint, p_device_name,
      p_app_version, p_ip_address, true, v_now, v_now
    )
    ON CONFLICT (license_key_id, device_fingerprint) DO UPDATE SET
      active = true,
      deactivated_at = NULL,
      deactivation_reason = NULL,
      first_seen_at = v_now,
      last_seen_at = v_now,
      device_name = COALESCE(EXCLUDED.device_name, public.license_sessions.device_name),
      app_version = COALESCE(EXCLUDED.app_version, public.license_sessions.app_version),
      ip_address = COALESCE(EXCLUDED.ip_address, public.license_sessions.ip_address)
    WHERE public.license_sessions.deactivation_reason IS DISTINCT FROM 'admin_revoked'
    RETURNING id INTO v_session_id;

    IF v_session_id IS NULL THEN
      RAISE EXCEPTION 'Device session became administrator-revoked during locked validation'
        USING ERRCODE = '40001';
    END IF;

    v_status := 'created';
  END IF;

  SELECT count(*) INTO v_session_count
    FROM public.license_sessions
    WHERE license_key_id = p_license_key_id
      AND active = true;

  RETURN jsonb_build_object(
    'status', v_status,
    'session_id', v_session_id,
    'active_devices', v_session_count,
    'max_devices', p_max_devices,
    'evicted', v_evicted,
    'activated', v_activated
  );
END;
$$;

REVOKE ALL ON FUNCTION public.license_validate_device_atomic(
  UUID, UUID, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, TEXT
) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.license_validate_device_atomic(
  UUID, UUID, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.license_validate_device_atomic(
  UUID, UUID, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, TEXT
) IS 'Atomically validates a device seat and optionally activates a pending key after all refusal checks.';
