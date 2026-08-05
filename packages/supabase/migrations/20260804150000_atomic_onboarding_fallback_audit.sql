-- Atomic safe-fallback grant for native Discord onboarding outages.
-- The role change is performed by the bot, but the durable member state,
-- append-only audit row, and owner alert are committed together here. A
-- retry is idempotent by the stable member occurrence key.

CREATE OR REPLACE FUNCTION public.grant_onboarding_fallback_atomic(
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_timeout_minutes INTEGER,
  p_correlation_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member members%ROWTYPE;
  v_occurrence TEXT := 'member.onboarding_fallback_granted:' || p_guild_id || ':' || p_discord_id;
  v_correlation TEXT := COALESCE(p_correlation_id, 'onboarding:' || p_guild_id || ':' || p_discord_id);
  v_metadata JSONB := jsonb_build_object(
    'member_id', p_discord_id,
    'timeout_minutes', GREATEST(1, LEAST(COALESCE(p_timeout_minutes, 10), 1440)),
    'correlation_id', v_correlation
  );
BEGIN
  SELECT * INTO v_member
    FROM public.members
   WHERE guild_id = p_guild_id AND discord_id = p_discord_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF COALESCE(v_member.onboarding_completed, false) THEN
    RETURN jsonb_build_object('status', 'already_granted');
  END IF;

  UPDATE public.members
     SET onboarding_completed = true,
         updated_at = now()
   WHERE guild_id = p_guild_id AND discord_id = p_discord_id;

  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, category, target_type, target_id,
    details, correlation_id, occurrence_key, success, error_message
  ) VALUES (
    p_guild_id, 'system', 'onboarding', 'member.onboarding_fallback_granted',
    'members', 'member', p_discord_id,
    v_metadata, v_correlation, v_occurrence, true, NULL
  ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM public.alerts
     WHERE guild_id = p_guild_id
       AND alert_type = 'onboarding_fallback_granted'
       AND resolved = false
       AND metadata->>'member_id' = p_discord_id
  ) THEN
    INSERT INTO public.alerts (
      guild_id, alert_type, severity, title, message, metadata, resolved
    ) VALUES (
      p_guild_id,
      'onboarding_fallback_granted',
      'info',
      'Onboarding fallback granted access',
      'A member was granted the Member role after the configured onboarding timeout.',
      v_metadata,
      false
    );
  END IF;

  RETURN jsonb_build_object('status', 'granted', 'occurrence_key', v_occurrence);
END;
$$;

REVOKE ALL ON FUNCTION public.grant_onboarding_fallback_atomic(TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.grant_onboarding_fallback_atomic(TEXT, TEXT, INTEGER, TEXT) TO service_role;
