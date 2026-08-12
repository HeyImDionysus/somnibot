-- Durable two-phase state for onboarding fallback role grants.
-- Phase one records a bounded, leased intent before Discord is mutated.
-- Phase two records member completion and success provenance only after the
-- bot confirms that the configured Discord role is present.

CREATE TABLE public.onboarding_fallback_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  discord_id TEXT NOT NULL,
  member_role_id TEXT NOT NULL,
  timeout_minutes INTEGER NOT NULL CHECK (timeout_minutes BETWEEN 1 AND 1440),
  correlation_id TEXT NOT NULL,
  role_add_authorized BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  attempt_token UUID,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  completed_attempt_token UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, discord_id)
);

CREATE INDEX idx_onboarding_fallback_intents_pending
  ON public.onboarding_fallback_intents(guild_id, next_attempt_at)
  WHERE status = 'pending';

CREATE TRIGGER update_onboarding_fallback_intents_updated_at
  BEFORE UPDATE ON public.onboarding_fallback_intents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.onboarding_fallback_intents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.onboarding_fallback_intents FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.onboarding_fallback_intents TO service_role;

CREATE OR REPLACE FUNCTION public.list_onboarding_fallback_intents(p_guild_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object(
      'discord_id', intent.discord_id,
      'member_role_id', intent.member_role_id,
      'timeout_minutes', intent.timeout_minutes,
      'role_add_authorized', intent.role_add_authorized,
      'next_attempt_at', intent.next_attempt_at
    ) ORDER BY intent.next_attempt_at),
    '[]'::jsonb
  )
  FROM public.onboarding_fallback_intents AS intent
  WHERE intent.guild_id = p_guild_id
    AND intent.status = 'pending';
$$;

CREATE OR REPLACE FUNCTION public.claim_onboarding_fallback_intent(
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_member_role_id TEXT,
  p_timeout_minutes INTEGER,
  p_correlation_id TEXT,
  p_role_add_authorized BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_config public.guild_config%ROWTYPE;
  v_member public.members%ROWTYPE;
  v_intent public.onboarding_fallback_intents%ROWTYPE;
  v_attempt_token UUID := gen_random_uuid();
  v_now TIMESTAMPTZ := now();
  v_retry_after_ms INTEGER;
  v_config_current BOOLEAN;
BEGIN
  SELECT * INTO v_config
    FROM public.guild_config
   WHERE guild_id = p_guild_id
   FOR UPDATE;

  v_config_current := FOUND
    AND COALESCE(v_config.onboarding_enabled, false)
    AND v_config.fallback_mode = 'grant-after-timeout'
    AND v_config.member_role_id = p_member_role_id
    AND v_config.fallback_timeout_minutes = p_timeout_minutes;

  SELECT * INTO v_member
    FROM public.members
   WHERE guild_id = p_guild_id AND discord_id = p_discord_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF COALESCE(v_member.onboarding_completed, false) THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;

  SELECT * INTO v_intent
    FROM public.onboarding_fallback_intents
   WHERE guild_id = p_guild_id AND discord_id = p_discord_id
   FOR UPDATE;

  IF FOUND AND (
    NOT v_config_current
    OR v_intent.member_role_id <> p_member_role_id
    OR v_intent.timeout_minutes <> p_timeout_minutes
  ) THEN
    UPDATE public.onboarding_fallback_intents
       SET attempt_token = v_attempt_token,
           lease_expires_at = v_now + INTERVAL '30 seconds'
     WHERE id = v_intent.id;
    RETURN jsonb_build_object(
      'status', 'stale_config',
      'intent_id', v_intent.id,
      'attempt_token', v_attempt_token,
      'member_role_id', v_intent.member_role_id,
      'attempt_count', v_intent.attempt_count
    );
  END IF;

  IF NOT v_config_current THEN
    RETURN jsonb_build_object('status', 'stale_config');
  END IF;

  IF NOT FOUND THEN
    IF NOT p_role_add_authorized THEN
      RETURN jsonb_build_object('status', 'role_not_authorized');
    END IF;
    INSERT INTO public.onboarding_fallback_intents (
      guild_id, discord_id, member_role_id, timeout_minutes, correlation_id,
      role_add_authorized, attempt_count, attempt_token, lease_expires_at
    ) VALUES (
      p_guild_id, p_discord_id, p_member_role_id, p_timeout_minutes,
      p_correlation_id, true, 1, v_attempt_token, v_now + INTERVAL '30 seconds'
    ) RETURNING * INTO v_intent;
  ELSIF v_intent.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  ELSIF v_intent.status = 'failed' THEN
    RETURN jsonb_build_object('status', 'max_attempts');
  ELSIF v_intent.status = 'cancelled' THEN
    UPDATE public.onboarding_fallback_intents
       SET member_role_id = p_member_role_id,
           timeout_minutes = p_timeout_minutes,
           correlation_id = p_correlation_id,
           role_add_authorized = p_role_add_authorized,
           status = 'pending',
           attempt_count = 1,
           attempt_token = v_attempt_token,
           lease_expires_at = v_now + INTERVAL '30 seconds',
           next_attempt_at = v_now,
           last_error = NULL,
           completed_at = NULL,
           completed_attempt_token = NULL
     WHERE id = v_intent.id
     RETURNING * INTO v_intent;
  ELSIF v_intent.lease_expires_at > v_now THEN
    v_retry_after_ms := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (v_intent.lease_expires_at - v_now)) * 1000)::INTEGER
    );
    RETURN jsonb_build_object('status', 'wait', 'retry_after_ms', v_retry_after_ms);
  ELSIF v_intent.next_attempt_at > v_now THEN
    v_retry_after_ms := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (v_intent.next_attempt_at - v_now)) * 1000)::INTEGER
    );
    RETURN jsonb_build_object('status', 'wait', 'retry_after_ms', v_retry_after_ms);
  ELSIF v_intent.attempt_count >= 3 THEN
    UPDATE public.onboarding_fallback_intents
       SET status = 'failed', attempt_token = NULL, lease_expires_at = NULL
     WHERE id = v_intent.id;
    RETURN jsonb_build_object('status', 'max_attempts');
  ELSE
    UPDATE public.onboarding_fallback_intents
       SET attempt_count = attempt_count + 1,
           attempt_token = v_attempt_token,
           lease_expires_at = v_now + INTERVAL '30 seconds'
     WHERE id = v_intent.id
     RETURNING * INTO v_intent;
  END IF;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'intent_id', v_intent.id,
    'attempt_token', v_attempt_token,
    'member_role_id', v_intent.member_role_id,
    'attempt_count', v_intent.attempt_count,
    'role_add_authorized', v_intent.role_add_authorized
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_onboarding_fallback_attempt(
  p_intent_id UUID,
  p_attempt_token UUID,
  p_error TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.onboarding_fallback_intents%ROWTYPE;
  v_delay_seconds INTEGER;
BEGIN
  SELECT * INTO v_intent
    FROM public.onboarding_fallback_intents
   WHERE id = p_intent_id
   FOR UPDATE;

  IF NOT FOUND
    OR v_intent.status <> 'pending'
    OR v_intent.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('status', 'lost_claim');
  END IF;

  IF v_intent.attempt_count >= 3 THEN
    UPDATE public.onboarding_fallback_intents
       SET status = 'failed',
           attempt_token = NULL,
           lease_expires_at = NULL,
           last_error = left(p_error, 2000)
     WHERE id = p_intent_id;
    RETURN jsonb_build_object('status', 'failed');
  END IF;

  v_delay_seconds := LEAST(60, 5 * (2 ^ (v_intent.attempt_count - 1))::INTEGER);
  UPDATE public.onboarding_fallback_intents
     SET attempt_token = NULL,
         lease_expires_at = NULL,
         next_attempt_at = now() + make_interval(secs => v_delay_seconds),
         last_error = left(p_error, 2000)
   WHERE id = p_intent_id;

  RETURN jsonb_build_object('status', 'retry', 'retry_after_ms', v_delay_seconds * 1000);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_onboarding_fallback_intent(
  p_intent_id UUID,
  p_attempt_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated UUID;
BEGIN
  UPDATE public.onboarding_fallback_intents
     SET status = 'cancelled', attempt_token = NULL, lease_expires_at = NULL
   WHERE id = p_intent_id
     AND status = 'pending'
     AND attempt_token = p_attempt_token
  RETURNING id INTO v_updated;

  RETURN jsonb_build_object('status', CASE WHEN v_updated IS NULL THEN 'lost_claim' ELSE 'cancelled' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.terminate_onboarding_fallback_intent(
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated UUID;
BEGIN
  UPDATE public.onboarding_fallback_intents
     SET status = 'cancelled',
         attempt_token = NULL,
         lease_expires_at = NULL,
         last_error = left(p_reason, 1000)
   WHERE guild_id = p_guild_id
     AND discord_id = p_discord_id
     AND status = 'pending'
  RETURNING id INTO v_updated;

  RETURN jsonb_build_object(
    'status',
    CASE WHEN v_updated IS NULL THEN 'not_found' ELSE 'cancelled' END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_onboarding_fallback_intent(
  p_intent_id UUID,
  p_attempt_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_guild_id TEXT;
  v_discord_id TEXT;
  v_intent public.onboarding_fallback_intents%ROWTYPE;
  v_config public.guild_config%ROWTYPE;
  v_member public.members%ROWTYPE;
  v_occurrence TEXT;
  v_metadata JSONB;
BEGIN
  SELECT guild_id, discord_id INTO v_guild_id, v_discord_id
    FROM public.onboarding_fallback_intents
   WHERE id = p_intent_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO v_config
    FROM public.guild_config
   WHERE guild_id = v_guild_id
   FOR UPDATE;

  SELECT * INTO v_member
    FROM public.members
   WHERE guild_id = v_guild_id AND discord_id = v_discord_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO v_intent
    FROM public.onboarding_fallback_intents
   WHERE id = p_intent_id
     AND guild_id = v_guild_id
     AND discord_id = v_discord_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_intent.status = 'completed' THEN
    RETURN jsonb_build_object(
      'status',
      CASE
        WHEN v_intent.completed_attempt_token = p_attempt_token THEN 'already_completed'
        ELSE 'lost_claim'
      END
    );
  END IF;
  IF v_intent.status <> 'pending'
    OR v_intent.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('status', 'lost_claim');
  END IF;
  IF COALESCE(v_member.onboarding_completed, false) THEN
    UPDATE public.onboarding_fallback_intents
       SET status = 'cancelled', attempt_token = NULL, lease_expires_at = NULL,
           last_error = 'native_onboarding_completed'
     WHERE id = v_intent.id;
    RETURN jsonb_build_object('status', 'native_completed');
  END IF;
  IF NOT v_intent.role_add_authorized THEN
    RETURN jsonb_build_object('status', 'role_not_authorized');
  END IF;
  IF NOT COALESCE(v_config.onboarding_enabled, false)
    OR v_config.fallback_mode <> 'grant-after-timeout'
    OR v_config.member_role_id IS DISTINCT FROM v_intent.member_role_id
    OR v_config.fallback_timeout_minutes IS DISTINCT FROM v_intent.timeout_minutes THEN
    RETURN jsonb_build_object('status', 'stale_config');
  END IF;

  UPDATE public.members
     SET onboarding_completed = true, updated_at = now()
   WHERE guild_id = v_intent.guild_id AND discord_id = v_intent.discord_id;

  UPDATE public.onboarding_fallback_intents
     SET status = 'completed',
         attempt_token = NULL,
         lease_expires_at = NULL,
         completed_at = now(),
         completed_attempt_token = p_attempt_token,
         last_error = NULL
   WHERE id = v_intent.id;

  v_occurrence := 'member.onboarding_fallback_granted:' || v_intent.guild_id || ':' || v_intent.discord_id;
  v_metadata := jsonb_build_object(
    'member_id', v_intent.discord_id,
    'member_role_id', v_intent.member_role_id,
    'timeout_minutes', v_intent.timeout_minutes,
    'correlation_id', v_intent.correlation_id,
    'intent_id', v_intent.id
  );

  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, category, target_type, target_id,
    details, correlation_id, occurrence_key, success, error_message
  ) VALUES (
    v_intent.guild_id, 'system', 'onboarding', 'member.onboarding_fallback_granted',
    'members', 'member', v_intent.discord_id,
    v_metadata, v_intent.correlation_id, v_occurrence, true, NULL
  ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM public.alerts
     WHERE guild_id = v_intent.guild_id
       AND alert_type = 'onboarding_fallback_granted'
       AND resolved = false
       AND metadata->>'member_id' = v_intent.discord_id
  ) THEN
    INSERT INTO public.alerts (
      guild_id, alert_type, severity, title, message, metadata, resolved
    ) VALUES (
      v_intent.guild_id,
      'onboarding_fallback_granted',
      'info',
      'Onboarding fallback granted access',
      'A member was granted the Member role after the configured onboarding timeout.',
      v_metadata,
      false
    );
  END IF;

  RETURN jsonb_build_object('status', 'completed', 'occurrence_key', v_occurrence);
END;
$$;

REVOKE ALL ON FUNCTION public.list_onboarding_fallback_intents(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_onboarding_fallback_intent(TEXT, TEXT, TEXT, INTEGER, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_onboarding_fallback_attempt(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_onboarding_fallback_intent(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.terminate_onboarding_fallback_intent(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_onboarding_fallback_intent(UUID, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.list_onboarding_fallback_intents(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_onboarding_fallback_intent(TEXT, TEXT, TEXT, INTEGER, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_onboarding_fallback_attempt(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_onboarding_fallback_intent(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.terminate_onboarding_fallback_intent(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_onboarding_fallback_intent(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.grant_onboarding_fallback_atomic(TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_onboarding_fallback_atomic(TEXT, TEXT, INTEGER, TEXT) TO service_role;
