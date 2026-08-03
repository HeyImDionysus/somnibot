-- One active bot runtime per independently hosted SomniBot installation.
-- The lease is additive and service-role-only. Existing code remains valid
-- until the bot lifecycle begins calling these functions.

CREATE TABLE IF NOT EXISTS public.runtime_leases (
  lease_name text PRIMARY KEY,
  holder_id text NOT NULL,
  session_id uuid NOT NULL,
  runtime_mode text NOT NULL CHECK (runtime_mode IN ('regular-local', 'vps')),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

ALTER TABLE public.runtime_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.runtime_leases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.runtime_leases TO service_role;

CREATE OR REPLACE FUNCTION public.claim_somnibot_runtime(
  p_holder_id text,
  p_session_id uuid,
  p_runtime_mode text,
  p_ttl_seconds integer DEFAULT 45
)
RETURNS TABLE(acquired boolean, active_mode text, lease_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_rows integer;
BEGIN
  IF length(trim(p_holder_id)) < 16 OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'invalid runtime lease identity' USING ERRCODE = '22023';
  END IF;
  IF p_runtime_mode NOT IN ('regular-local', 'vps') THEN
    RAISE EXCEPTION 'invalid runtime mode' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds < 30 OR p_ttl_seconds > 120 THEN
    RAISE EXCEPTION 'runtime lease TTL must be between 30 and 120 seconds' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.runtime_leases AS lease (
    lease_name, holder_id, session_id, runtime_mode,
    acquired_at, heartbeat_at, expires_at
  ) VALUES (
    'primary-bot', trim(p_holder_id), p_session_id, p_runtime_mode,
    v_now, v_now, v_now + make_interval(secs => p_ttl_seconds)
  )
  ON CONFLICT (lease_name) DO UPDATE SET
    holder_id = EXCLUDED.holder_id,
    session_id = EXCLUDED.session_id,
    runtime_mode = EXCLUDED.runtime_mode,
    acquired_at = v_now,
    heartbeat_at = v_now,
    expires_at = v_now + make_interval(secs => p_ttl_seconds)
  WHERE lease.expires_at <= v_now;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 1 THEN
    RETURN QUERY SELECT true, p_runtime_mode, v_now + make_interval(secs => p_ttl_seconds);
  ELSE
    RETURN QUERY
      SELECT false, lease.runtime_mode, lease.expires_at
      FROM public.runtime_leases AS lease
      WHERE lease.lease_name = 'primary-bot';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_somnibot_runtime(
  p_holder_id text,
  p_session_id uuid,
  p_ttl_seconds integer DEFAULT 45
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_ttl_seconds < 30 OR p_ttl_seconds > 120 THEN
    RAISE EXCEPTION 'runtime lease TTL must be between 30 and 120 seconds' USING ERRCODE = '22023';
  END IF;
  UPDATE public.runtime_leases
  SET heartbeat_at = v_now,
      expires_at = v_now + make_interval(secs => p_ttl_seconds)
  WHERE lease_name = 'primary-bot'
    AND holder_id = trim(p_holder_id)
    AND session_id = p_session_id
    AND expires_at > v_now;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_somnibot_runtime(
  p_holder_id text,
  p_session_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  DELETE FROM public.runtime_leases
  WHERE lease_name = 'primary-bot'
    AND holder_id = trim(p_holder_id)
    AND session_id = p_session_id;
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_somnibot_runtime(text, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_somnibot_runtime(text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_somnibot_runtime(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_somnibot_runtime(text, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_somnibot_runtime(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_somnibot_runtime(text, uuid) TO service_role;
