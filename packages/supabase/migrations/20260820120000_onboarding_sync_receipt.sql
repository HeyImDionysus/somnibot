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

REVOKE ALL ON FUNCTION public.acquire_onboarding_sync_lease(TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_onboarding_sync_lease(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_onboarding_sync_lease(TEXT, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_onboarding_sync_lease(TEXT, UUID) TO service_role;
