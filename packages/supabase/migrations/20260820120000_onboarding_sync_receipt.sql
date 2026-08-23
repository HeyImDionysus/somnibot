ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS onboarding_sync_state JSONB NOT NULL
  DEFAULT '{"status":"idle"}'::JSONB;

ALTER TABLE public.guild_config
  DROP CONSTRAINT IF EXISTS guild_config_onboarding_sync_state_check;

ALTER TABLE public.guild_config
  ADD CONSTRAINT guild_config_onboarding_sync_state_check
  CHECK (
    jsonb_typeof(onboarding_sync_state) = 'object'
    AND onboarding_sync_state->>'status' IN ('idle', 'pending', 'synced', 'drifted', 'failed')
    AND (
      NOT (onboarding_sync_state ? 'request_id')
      OR (onboarding_sync_state->>'request_id') ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );

CREATE OR REPLACE FUNCTION public.fail_pending_onboarding_sync(
  p_guild_id TEXT,
  p_request_id UUID,
  p_error TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state JSONB;
BEGIN
  UPDATE public.guild_config
  SET onboarding_sync_state = onboarding_sync_state || jsonb_build_object(
    'status', 'failed',
    'observed_at', now(),
    'error', left(p_error, 1000)
  )
  WHERE guild_id = p_guild_id
    AND onboarding_sync_state->>'status' = 'pending'
    AND onboarding_sync_state->>'request_id' = p_request_id::TEXT
  RETURNING onboarding_sync_state INTO v_state;

  RETURN v_state;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_pending_onboarding_sync(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_pending_onboarding_sync(TEXT, UUID, TEXT) TO service_role;

CREATE TABLE IF NOT EXISTS public.onboarding_sync_leases (
  guild_id TEXT PRIMARY KEY REFERENCES public.guild(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  lease_token UUID NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.onboarding_sync_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.onboarding_sync_leases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.onboarding_sync_leases TO service_role;

CREATE OR REPLACE FUNCTION public.acquire_onboarding_sync_lease(
  p_guild_id TEXT,
  p_request_id UUID,
  p_lease_seconds INTEGER DEFAULT 90
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_request_id TEXT;
  v_lease_token UUID;
BEGIN
  IF p_lease_seconds < 15 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'onboarding synchronization lease duration is out of range';
  END IF;

  SELECT onboarding_sync_state->>'request_id'
    INTO v_current_request_id
    FROM public.guild_config
   WHERE guild_id = p_guild_id
   FOR UPDATE;

  IF v_current_request_id IS DISTINCT FROM p_request_id::TEXT THEN
    RETURN jsonb_build_object('disposition', 'stale', 'lease_token', NULL);
  END IF;

  INSERT INTO public.onboarding_sync_leases AS lease (
    guild_id,
    request_id,
    lease_token,
    acquired_at,
    expires_at
  ) VALUES (
    p_guild_id,
    p_request_id,
    gen_random_uuid(),
    clock_timestamp(),
    clock_timestamp() + make_interval(secs => p_lease_seconds)
  )
  ON CONFLICT (guild_id) DO UPDATE
    SET request_id = EXCLUDED.request_id,
        lease_token = EXCLUDED.lease_token,
        acquired_at = EXCLUDED.acquired_at,
        expires_at = EXCLUDED.expires_at
    WHERE lease.expires_at <= clock_timestamp()
  RETURNING lease_token INTO v_lease_token;

  IF v_lease_token IS NULL THEN
    RETURN jsonb_build_object('disposition', 'busy', 'lease_token', NULL);
  END IF;
  RETURN jsonb_build_object('disposition', 'acquired', 'lease_token', v_lease_token);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_onboarding_sync_lease(
  p_guild_id TEXT,
  p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.onboarding_sync_leases
   WHERE guild_id = p_guild_id
     AND lease_token = p_lease_token;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_onboarding_sync_lease(
  p_guild_id TEXT,
  p_request_id UUID,
  p_lease_token UUID,
  p_lease_seconds INTEGER DEFAULT 90
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_lease_seconds < 15 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'onboarding synchronization lease duration is out of range';
  END IF;

  UPDATE public.onboarding_sync_leases AS lease
     SET expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
   WHERE lease.guild_id = p_guild_id
     AND lease.request_id = p_request_id
     AND lease.lease_token = p_lease_token
     AND lease.expires_at > clock_timestamp()
     AND EXISTS (
       SELECT 1
         FROM public.guild_config AS config
        WHERE config.guild_id = p_guild_id
          AND config.onboarding_sync_state->>'request_id' = p_request_id::TEXT
     );
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.persist_onboarding_sync_state_if_leased(
  p_guild_id TEXT,
  p_request_id UUID,
  p_lease_token UUID,
  p_state JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF jsonb_typeof(p_state) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'onboarding synchronization state must be an object';
  END IF;
  IF p_state->>'request_id' IS DISTINCT FROM p_request_id::TEXT THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'onboarding synchronization state request does not match its lease';
  END IF;

  PERFORM 1
    FROM public.onboarding_sync_leases AS lease
   WHERE lease.guild_id = p_guild_id
     AND lease.request_id = p_request_id
     AND lease.lease_token = p_lease_token
     AND lease.expires_at > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE public.guild_config AS config
     SET onboarding_sync_state = p_state
   WHERE config.guild_id = p_guild_id
     AND config.onboarding_sync_state->>'request_id' = p_request_id::TEXT;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_onboarding_sync_lease(TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_onboarding_sync_lease(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_onboarding_sync_lease(TEXT, UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_onboarding_sync_state_if_leased(TEXT, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_onboarding_sync_lease(TEXT, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_onboarding_sync_lease(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_onboarding_sync_lease(TEXT, UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_onboarding_sync_state_if_leased(TEXT, UUID, UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.undo_onboarding_change(
  p_change_id UUID,
  p_guild_id TEXT,
  p_actor_id TEXT,
  p_expected_request_id UUID,
  p_new_request_id UUID,
  p_requested_at TIMESTAMPTZ,
  p_undo_data JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_change public.admin_changes%ROWTYPE;
  v_undo_record public.admin_changes%ROWTYPE;
  v_sync_state JSONB;
BEGIN
  IF jsonb_typeof(p_undo_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'onboarding undo data must be an object';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_object_keys(p_undo_data) AS key(name)
     WHERE key.name NOT IN (
       'member_role_id',
       'onboarding_enabled',
       'interest_role_mapping',
       'returning_member_skip_welcome_dm',
       'returning_member_restore_entitlements',
       'returning_member_restore_levels',
       'onboarding_config',
       'fallback_mode',
       'fallback_timeout_minutes'
     )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'onboarding undo data contains an unsupported field';
  END IF;

  SELECT *
    INTO v_change
    FROM public.admin_changes
   WHERE id = p_change_id
     AND guild_id = p_guild_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF NOT v_change.is_undoable OR v_change.is_undone THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;
  IF v_change.action IS DISTINCT FROM 'onboarding.updated'
     OR v_change.after_state #>> '{onboarding_sync_state,request_id}'
        IS DISTINCT FROM p_expected_request_id::TEXT THEN
    RETURN jsonb_build_object('status', 'invalid_revision');
  END IF;

  v_sync_state := jsonb_build_object(
    'status', 'pending',
    'managed', TRUE,
    'request_id', p_new_request_id,
    'requested_at', p_requested_at
  );

  UPDATE public.guild_config AS config
     SET member_role_id = CASE
           WHEN p_undo_data ? 'member_role_id' THEN p_undo_data->>'member_role_id'
           ELSE config.member_role_id
         END,
         onboarding_enabled = CASE
           WHEN p_undo_data ? 'onboarding_enabled' THEN (p_undo_data->>'onboarding_enabled')::BOOLEAN
           ELSE config.onboarding_enabled
         END,
         interest_role_mapping = CASE
           WHEN p_undo_data ? 'interest_role_mapping' THEN p_undo_data->'interest_role_mapping'
           ELSE config.interest_role_mapping
         END,
         returning_member_skip_welcome_dm = CASE
           WHEN p_undo_data ? 'returning_member_skip_welcome_dm'
             THEN (p_undo_data->>'returning_member_skip_welcome_dm')::BOOLEAN
           ELSE config.returning_member_skip_welcome_dm
         END,
         returning_member_restore_entitlements = CASE
           WHEN p_undo_data ? 'returning_member_restore_entitlements'
             THEN (p_undo_data->>'returning_member_restore_entitlements')::BOOLEAN
           ELSE config.returning_member_restore_entitlements
         END,
         returning_member_restore_levels = CASE
           WHEN p_undo_data ? 'returning_member_restore_levels'
             THEN (p_undo_data->>'returning_member_restore_levels')::BOOLEAN
           ELSE config.returning_member_restore_levels
         END,
         onboarding_config = CASE
           WHEN p_undo_data ? 'onboarding_config'
             THEN NULLIF(p_undo_data->'onboarding_config', 'null'::JSONB)
           ELSE config.onboarding_config
         END,
         fallback_mode = CASE
           WHEN p_undo_data ? 'fallback_mode' THEN p_undo_data->>'fallback_mode'
           ELSE config.fallback_mode
         END,
         fallback_timeout_minutes = CASE
           WHEN p_undo_data ? 'fallback_timeout_minutes'
             THEN (p_undo_data->>'fallback_timeout_minutes')::INTEGER
           ELSE config.fallback_timeout_minutes
         END,
         onboarding_sync_state = v_sync_state
   WHERE config.guild_id = p_guild_id
     AND config.onboarding_sync_state->>'request_id' = p_expected_request_id::TEXT;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'stale');
  END IF;

  INSERT INTO public.admin_changes (
    guild_id,
    actor_id,
    action,
    target_type,
    target_id,
    description,
    before_state,
    after_state,
    undo_payload,
    is_undoable,
    blast_radius
  ) VALUES (
    p_guild_id,
    p_actor_id,
    'undo:' || v_change.action,
    v_change.target_type,
    v_change.target_id,
    'Undid: ' || v_change.description,
    v_change.after_state,
    v_change.before_state,
    NULL,
    FALSE,
    v_change.blast_radius
  )
  RETURNING * INTO v_undo_record;

  UPDATE public.admin_changes
     SET is_undone = TRUE,
         undone_at = clock_timestamp(),
         undone_by = p_actor_id,
         undo_change_id = v_undo_record.id
   WHERE id = p_change_id
     AND guild_id = p_guild_id;

  RETURN jsonb_build_object(
    'status', 'applied',
    'sync_state', v_sync_state,
    'undo_record', to_jsonb(v_undo_record)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.undo_onboarding_change(UUID, TEXT, TEXT, UUID, UUID, TIMESTAMPTZ, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.undo_onboarding_change(UUID, TEXT, TEXT, UUID, UUID, TIMESTAMPTZ, JSONB)
  TO service_role;
