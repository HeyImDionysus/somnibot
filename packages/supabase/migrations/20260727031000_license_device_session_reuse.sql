-- =============================================================================
-- license_validate_device: a device that returns after being deactivated must
-- reclaim its row instead of colliding with it.
--
-- THE BUG
-- -------
-- The function looked for an existing session with `AND active = true`. Once a
-- device had EVER been deactivated — by the customer, by an admin, by
-- reconciliation, or (most commonly) by `evict_oldest` itself — there was no
-- active row to find, so the function fell through to a bare INSERT.
--
-- `license_sessions` carries a FULL unique constraint,
-- `UNIQUE(license_key_id, device_fingerprint)` — not a partial one on `active`
-- (initial_schema:690, never altered since). The deactivated row is still
-- there, so the INSERT raised 23505 out of the RPC, forever, for that machine.
--
-- The caller then logged and SWALLOWED the error and returned `valid: true`
-- with `session_id: null`. Consequences, all of them permanent and per-machine:
--
--   * the machine kept validating as healthy while consuming ZERO seats, so
--     the device limit silently stopped counting it;
--   * `session_id: null` makes the SDK's heartbeat() short-circuit to
--     'no_session', so that install never contacted the server again;
--   * the portal's device list stopped reflecting reality.
--
-- And `evict_oldest` — the schema DEFAULT — *causes* this on every eviction:
-- evict device A, and device A is bricked (and free) the moment it comes back.
--
-- THE FIX
-- -------
-- Find the row by (key, fingerprint) regardless of `active`, and treat a
-- returning-but-inactive device as what it is: a NEW SEAT CLAIM by a machine we
-- have seen before. It goes through the same count/policy/eviction path as a
-- brand-new device and then REUSES its own row (active = true, deactivation
-- fields cleared) instead of trying to insert a duplicate.
--
-- WHY NOT A PARTIAL UNIQUE INDEX
-- ------------------------------
-- Making the constraint partial (`... WHERE active`) and inserting a fresh row
-- per activation would also work and would keep per-activation history. It was
-- rejected because it alters a live constraint on the table that gates paying
-- customers' access for a history benefit `license_validations` (the permanent
-- forensic ledger) already provides. Reusing the row needs NO constraint change
-- at all, so there is no live-data migration risk here: the constraint, its
-- index, and every existing row are untouched. The only object replaced is the
-- function body.
--
-- EXISTING ROWS
-- -------------
-- Nothing is rewritten and nothing is backfilled. Devices currently stuck in
-- the broken state (a deactivated row + an install validating with no session)
-- heal by themselves on their next validation: the lookup now finds their row,
-- the seat claim runs, and the row is reactivated. Their install starts
-- heartbeating again as soon as it next calls validate() — which is what the
-- SDK does when its cache TTL lapses.
-- =============================================================================

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
  v_session_count INT;
  v_oldest_id UUID;
  v_session_id UUID;
  v_status TEXT;
  v_evicted BOOLEAN := false;
  v_now TIMESTAMPTZ := now();
BEGIN
  -- Lock the license key row to serialize concurrent validations
  PERFORM 1 FROM public.license_keys
    WHERE id = p_license_key_id
    FOR UPDATE;

  -- Look for this device's row REGARDLESS of `active`. The unique constraint
  -- guarantees at most one, so a deactivated row is not "no row" — it is this
  -- device's row, waiting to be reclaimed.
  SELECT id, active INTO v_existing_session_id, v_existing_active
    FROM public.license_sessions
    WHERE license_key_id = p_license_key_id
      AND device_fingerprint = p_device_fingerprint
    LIMIT 1;

  IF v_existing_session_id IS NOT NULL AND v_existing_active THEN
    -- Already holds a seat: just refresh it. No limit check — this device is
    -- already counted, so re-validating must never cost it (or anyone else)
    -- a seat.
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

  -- ── New seat claim: a brand-new device, OR a known device coming back ──

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

    -- evict_oldest: deactivate the least-recently-seen active session. It can
    -- never be this device's own row — we only get here when this device has
    -- no active row.
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
    -- Reclaim this device's existing row. `first_seen_at` is reset because it
    -- describes THIS activation, and the 24h fraud windows read it; the
    -- previous activation's history lives in license_validations.
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
    -- Brand-new device. The FOR UPDATE above serializes callers for this key,
    -- so the conflict target should be unreachable; ON CONFLICT is here so that
    -- if it ever IS reached (e.g. the key row vanished, so nothing was locked)
    -- the outcome is a reclaimed session rather than a 23505 that the caller
    -- turns into a seatless "valid" — which is the exact failure this
    -- migration exists to remove.
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
    RETURNING id INTO v_session_id;

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

-- Restrict access. The explicit service_role grant is belt-and-braces: Supabase
-- default privileges already grant EXECUTE on new public functions to
-- service_role, and the REVOKE below does not touch it — but this function is
-- now the ONLY thing standing between a paying customer and a "could not
-- establish a session" response, so its executability must not rest on a
-- default. Without it, a deployment lacking those default privileges would fail
-- every device-bearing validation.
REVOKE ALL ON FUNCTION public.license_validate_device FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.license_validate_device(
  UUID, TEXT, TEXT, TEXT, TEXT, INT, TEXT
) TO service_role;
