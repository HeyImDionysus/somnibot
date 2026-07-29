-- =============================================================================
-- Durable administrator device revocation.
--
-- This is intentionally a FORWARD migration. Versions 20260727030000 and
-- 20260727031000 already shipped on the PR branch; changing their bodies would
-- not upgrade a database that had recorded those versions.
--
-- The replacement validation constraint is added NOT VALID here so the brief
-- ACCESS EXCLUSIVE metadata lock commits before the existing forensic ledger
-- is scanned. A later migration validates and swaps the constraints.
-- =============================================================================

ALTER TABLE public.license_validations
  ADD CONSTRAINT license_validations_result_check_admin_device_v2
  CHECK (result IN (
    'valid',
    'invalid_key',
    'expired',
    'suspended',
    'revoked',
    'over_device_limit',
    'product_mismatch',
    'cancelled',
    'pending',
    'grace_period',
    'unavailable',
    'rate_limited',
    'session_invalidated',
    'device_fingerprint_required'
  )) NOT VALID;

CREATE OR REPLACE FUNCTION public.license_validate_device(
  p_license_key_id UUID,
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
  v_existing_session_id UUID;
  v_existing_active BOOLEAN;
  v_existing_deactivation_reason TEXT;
  v_session_count INT;
  v_oldest_id UUID;
  v_session_id UUID;
  v_status TEXT;
  v_evicted BOOLEAN := false;
  v_now TIMESTAMPTZ := now();
BEGIN
  -- Serialize seat decisions for one key, then lock this fingerprint's row.
  PERFORM 1 FROM public.license_keys
    WHERE id = p_license_key_id
    FOR UPDATE;

  SELECT id, active, deactivation_reason
    INTO v_existing_session_id, v_existing_active, v_existing_deactivation_reason
    FROM public.license_sessions
    WHERE license_key_id = p_license_key_id
      AND device_fingerprint = p_device_fingerprint
    FOR UPDATE;

  IF v_existing_session_id IS NOT NULL AND v_existing_active THEN
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
      'evicted', false
    );
  END IF;

  -- An administrator revoke is a durable per-fingerprint denial. Check it
  -- before counting or evicting seats so a refused device cannot disturb a
  -- different customer device.
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
      'evicted', false
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
        'evicted', false
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

    -- Defensive fallback for a direct concurrent insert that bypassed the
    -- license-key lock but collided with an administrator-revoked row.
    IF v_session_id IS NULL THEN
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
        'evicted', false
      );
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
    'evicted', v_evicted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.license_validate_device FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.license_validate_device(
  UUID, TEXT, TEXT, TEXT, TEXT, INT, TEXT
) TO service_role;

-- Client uninstall/deactivation must be one atomic state transition. In
-- particular, a bearer of the license key and an old session id must never be
-- able to rewrite admin_revoked to a recoverable reason.
CREATE OR REPLACE FUNCTION public.license_deactivate_device(
  p_license_key_id UUID,
  p_session_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH deactivated AS (
    UPDATE public.license_sessions
       SET active = false,
           deactivated_at = pg_catalog.clock_timestamp(),
           deactivation_reason = 'user_deactivated'
     WHERE id = p_session_id
       AND license_key_id = p_license_key_id
       AND active = true
       AND deactivation_reason IS DISTINCT FROM 'admin_revoked'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM deactivated);
$$;

REVOKE ALL ON FUNCTION public.license_deactivate_device FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.license_deactivate_device(UUID, UUID) TO service_role;
