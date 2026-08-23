ALTER TABLE public.guild_desired_state
  ADD COLUMN IF NOT EXISTS deploy_request_id UUID,
  ADD COLUMN IF NOT EXISTS deploy_status TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS deploy_claim_token UUID,
  ADD COLUMN IF NOT EXISTS deploy_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deploy_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deploy_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deploy_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deploy_error TEXT;

ALTER TABLE public.guild_desired_state
  DROP CONSTRAINT IF EXISTS guild_desired_state_deploy_status_check;

ALTER TABLE public.guild_desired_state
  ADD CONSTRAINT guild_desired_state_deploy_status_check
  CHECK (deploy_status IN ('idle', 'requested', 'running', 'success', 'failed'));

CREATE OR REPLACE FUNCTION public.request_server_deployment(
  p_guild_id TEXT,
  p_request_id UUID,
  p_roles JSONB,
  p_channels JSONB,
  p_categories JSONB,
  p_permission_map JSONB,
  p_deploy_mode TEXT,
  p_requested_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state public.guild_desired_state%ROWTYPE;
  v_current_status TEXT;
BEGIN
  IF jsonb_typeof(p_roles) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_channels) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_categories) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_permission_map) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'deployment roles, channels, categories, and permission map have invalid shapes';
  END IF;
  IF p_deploy_mode NOT IN ('safe', 'destructive') THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'deployment mode is invalid';
  END IF;

  INSERT INTO public.guild_desired_state AS desired (
    guild_id,
    roles,
    channels,
    categories,
    permission_map,
    deploy_mode,
    applied_at,
    deploy_request_id,
    deploy_status,
    deploy_claim_token,
    deploy_claimed_at,
    deploy_lease_expires_at,
    deploy_started_at,
    deploy_completed_at,
    deploy_error,
    updated_at
  ) VALUES (
    p_guild_id,
    p_roles,
    p_channels,
    p_categories,
    p_permission_map,
    p_deploy_mode,
    NULL,
    p_request_id,
    'requested',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    p_requested_at
  )
  ON CONFLICT (guild_id) DO UPDATE
    SET roles = EXCLUDED.roles,
        channels = EXCLUDED.channels,
        categories = EXCLUDED.categories,
        permission_map = EXCLUDED.permission_map,
        deploy_mode = EXCLUDED.deploy_mode,
        applied_at = NULL,
        deploy_request_id = EXCLUDED.deploy_request_id,
        deploy_status = 'requested',
        deploy_claim_token = NULL,
        deploy_claimed_at = NULL,
        deploy_lease_expires_at = NULL,
        deploy_started_at = NULL,
        deploy_completed_at = NULL,
        deploy_error = NULL,
        updated_at = EXCLUDED.updated_at
    WHERE desired.deploy_status NOT IN ('requested', 'running')
  RETURNING * INTO v_state;

  IF v_state.guild_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'disposition', 'accepted',
      'state', to_jsonb(v_state)
    );
  END IF;

  SELECT deploy_status
    INTO v_current_status
    FROM public.guild_desired_state
   WHERE guild_id = p_guild_id;

  RETURN jsonb_build_object(
    'disposition', 'busy',
    'status', COALESCE(v_current_status, 'unknown')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_deploy_request(
  p_guild_id TEXT,
  p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state public.guild_desired_state%ROWTYPE;
BEGIN
  UPDATE public.guild_desired_state
     SET deploy_status = 'running',
         deploy_claim_token = gen_random_uuid(),
         deploy_claimed_at = clock_timestamp(),
         deploy_lease_expires_at = clock_timestamp() + INTERVAL '2 minutes',
         deploy_started_at = clock_timestamp(),
         deploy_completed_at = NULL,
         deploy_error = NULL,
         updated_at = clock_timestamp()
   WHERE guild_id = p_guild_id
     AND deploy_request_id = p_request_id
     AND deploy_status = 'requested'
  RETURNING * INTO v_state;

  IF v_state.guild_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN to_jsonb(v_state);
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_deploy_request_claim(
  p_guild_id TEXT,
  p_request_id UUID,
  p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.guild_desired_state
     SET deploy_lease_expires_at = clock_timestamp() + INTERVAL '2 minutes',
         updated_at = clock_timestamp()
   WHERE guild_id = p_guild_id
     AND deploy_request_id = p_request_id
     AND deploy_claim_token = p_claim_token
     AND deploy_status = 'running'
     AND deploy_lease_expires_at > clock_timestamp();
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_deploy_request(
  p_guild_id TEXT,
  p_request_id UUID,
  p_claim_token UUID,
  p_success BOOLEAN,
  p_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.guild_desired_state
     SET deploy_status = CASE WHEN p_success THEN 'success' ELSE 'failed' END,
         deploy_claim_token = NULL,
         deploy_lease_expires_at = NULL,
         deploy_completed_at = clock_timestamp(),
         deploy_error = CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error, 'Deployment failed'), 2000) END,
         applied_at = CASE WHEN p_success THEN clock_timestamp() ELSE applied_at END,
         drift_detected = CASE WHEN p_success THEN false ELSE drift_detected END,
         drift_details = CASE WHEN p_success THEN NULL ELSE drift_details END,
         updated_at = clock_timestamp()
   WHERE guild_id = p_guild_id
     AND deploy_request_id = p_request_id
     AND deploy_claim_token = p_claim_token
     AND deploy_status = 'running'
     AND deploy_lease_expires_at > clock_timestamp();
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_interrupted_deploy_requests()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.guild_desired_state
     SET deploy_status = 'failed',
         deploy_claim_token = NULL,
         deploy_lease_expires_at = NULL,
         deploy_completed_at = clock_timestamp(),
         deploy_error = 'Deployment lease expired before completion; submit an explicit retry',
         updated_at = clock_timestamp()
   WHERE deploy_status = 'running'
     AND (deploy_lease_expires_at IS NULL OR deploy_lease_expires_at <= clock_timestamp());
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.request_server_deployment(TEXT, UUID, JSONB, JSONB, JSONB, JSONB, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_deploy_request(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_deploy_request_claim(TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_deploy_request(TEXT, UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_interrupted_deploy_requests() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_server_deployment(TEXT, UUID, JSONB, JSONB, JSONB, JSONB, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_deploy_request(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_deploy_request_claim(TEXT, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_deploy_request(TEXT, UUID, UUID, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_interrupted_deploy_requests() TO service_role;

REVOKE ALL ON TABLE public.guild_desired_state FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.guild_desired_state.deploy_request_id IS
  'Unique dashboard submission identifier for an explicit deployment attempt.';
COMMENT ON COLUMN public.guild_desired_state.deploy_status IS
  'Durable deployment lifecycle; only requested rows may be claimed by the bot.';
COMMENT ON COLUMN public.guild_desired_state.deploy_lease_expires_at IS
  'Server-controlled claim lease; only expired running deployments may be recovered.';
