-- ============================================================
-- V10 Audit §3.P2a: Atomic device-limit eviction for licenses
-- ============================================================
-- Wraps the device-count check + eviction + insert inside a single
-- transaction with SELECT … FOR UPDATE on the license key row.
-- This eliminates the race condition where concurrent validations
-- for the same key could both pass the device-limit check and
-- temporarily exceed the configured max_devices.
-- ============================================================

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
  v_session_count INT;
  v_oldest_id UUID;
  v_session_id UUID;
  v_now TIMESTAMPTZ := now();
BEGIN
  -- Lock the license key row to serialize concurrent validations
  PERFORM 1 FROM public.license_keys
    WHERE id = p_license_key_id
    FOR UPDATE;

  -- Check for existing session with this fingerprint
  SELECT id INTO v_existing_session_id
    FROM public.license_sessions
    WHERE license_key_id = p_license_key_id
      AND device_fingerprint = p_device_fingerprint
      AND active = true
    LIMIT 1;

  IF v_existing_session_id IS NOT NULL THEN
    -- Update existing session
    UPDATE public.license_sessions SET
      last_seen_at = v_now,
      device_name = COALESCE(p_device_name, device_name),
      app_version = COALESCE(p_app_version, app_version),
      ip_address = COALESCE(p_ip_address, ip_address)
    WHERE id = v_existing_session_id;

    RETURN jsonb_build_object(
      'status', 'existing',
      'session_id', v_existing_session_id
    );
  END IF;

  -- Count active sessions
  SELECT count(*) INTO v_session_count
    FROM public.license_sessions
    WHERE license_key_id = p_license_key_id
      AND active = true;

  -- Handle device limit
  IF v_session_count >= p_max_devices THEN
    IF p_device_policy = 'reject' THEN
      RETURN jsonb_build_object(
        'status', 'over_device_limit',
        'active_devices', v_session_count,
        'max_devices', p_max_devices
      );
    END IF;

    -- evict_oldest: deactivate the oldest active session
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
    END IF;
  END IF;

  -- Insert new session
  INSERT INTO public.license_sessions (
    license_key_id, device_fingerprint, device_name,
    app_version, ip_address, active
  ) VALUES (
    p_license_key_id, p_device_fingerprint, p_device_name,
    p_app_version, p_ip_address, true
  )
  RETURNING id INTO v_session_id;

  RETURN jsonb_build_object(
    'status', 'created',
    'session_id', v_session_id
  );
END;
$$;

-- Restrict access
REVOKE ALL ON FUNCTION public.license_validate_device FROM public, anon, authenticated;
