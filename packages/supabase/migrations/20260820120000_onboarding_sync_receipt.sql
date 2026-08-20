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
