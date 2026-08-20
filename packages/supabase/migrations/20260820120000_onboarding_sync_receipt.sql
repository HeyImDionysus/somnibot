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
  RETURNING onboarding_sync_state INTO v_state;

  RETURN v_state;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_pending_onboarding_sync(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_pending_onboarding_sync(TEXT, TEXT) TO service_role;
