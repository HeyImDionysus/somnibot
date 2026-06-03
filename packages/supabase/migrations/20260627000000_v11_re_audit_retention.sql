-- =============================================================================
-- V11 Re-Audit — I-1 & I-2: Add retention policy for webhook_events and
-- license_validations to prune_expired_data(p_guild_id).
--
-- webhook_events:      90-day TTL (enough for dispute windows)
-- license_validations: 180-day TTL (keeps recent validation history)
--
-- Note: webhook_events uses `processed_at` (not created_at) and `guild_id`
-- may be NULL for older records, so the webhook prune uses a date-only filter.
-- =============================================================================

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

  -- V11 Re-Audit I-1: webhook_events older than 90 days.
  -- guild_id may be NULL on older rows, so also prune by date alone for
  -- rows belonging to this guild OR unclaimed rows older than 90 days.
  DELETE FROM public.webhook_events
  WHERE (guild_id = p_guild_id OR guild_id IS NULL)
    AND processed_at < now() - INTERVAL '90 days';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('old_webhook_events', cnt);

  -- V11 Re-Audit I-2: license_validations older than 180 days
  DELETE FROM public.license_validations
  WHERE product_id IN (
    SELECT id FROM public.products WHERE guild_id = p_guild_id
  ) AND created_at < now() - INTERVAL '180 days';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('old_license_validations', cnt);

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION prune_expired_data(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION prune_expired_data(TEXT) TO service_role;

-- Supporting indexes for efficient retention deletes
CREATE INDEX IF NOT EXISTS idx_webhook_events_guild_processed
  ON webhook_events(guild_id, processed_at);
CREATE INDEX IF NOT EXISTS idx_license_validations_created
  ON license_validations(created_at);
