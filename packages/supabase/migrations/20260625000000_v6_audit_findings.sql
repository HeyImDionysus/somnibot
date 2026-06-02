-- =============================================================================
-- V6 Audit Findings — Fix C-2, H-4, M-1
-- =============================================================================

-- ── C-2: Missing guild_config.ticket_satisfaction_survey column ──────────────
-- CrossFeatureBridge queries this column on every ticket close.
ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS ticket_satisfaction_survey BOOLEAN NOT NULL DEFAULT false;

-- ── H-4: prune_expired_data — add per-guild overload ────────────────────────
-- The bot calls prune_expired_data(p_guild_id) but only a parameterless
-- version existed. Add an overload that accepts a guild_id filter so the
-- bot can prune per-guild without the fallback error path.
CREATE OR REPLACE FUNCTION prune_expired_data(p_guild_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result JSONB := '{}';
  cnt INTEGER;
BEGIN
  -- Expired temp bans
  DELETE FROM public.infractions
  WHERE guild_id = p_guild_id AND active = true AND expires_at < now();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('expired_infractions', cnt);

  -- Expired temp mutes
  DELETE FROM public.mutes
  WHERE guild_id = p_guild_id AND active = true AND expires_at < now();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('expired_mutes', cnt);

  -- Old audit logs (>90 days)
  DELETE FROM public.audit_logs
  WHERE guild_id = p_guild_id AND timestamp < now() - INTERVAL '90 days';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('old_audit_logs', cnt);

  -- Expired temp role grants
  DELETE FROM public.temp_role_grants
  WHERE guild_id = p_guild_id AND expires_at < now();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('expired_temp_roles', cnt);

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION prune_expired_data(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION prune_expired_data(TEXT) TO service_role;
