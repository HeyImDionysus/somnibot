-- ============================================================
-- V8 Audit §14.P3d — Batch prune expired data in a single RPC
-- ============================================================
-- Replaces the per-guild JS loop that issued 3 queries per guild
-- every 6 hours.  This single RPC handles all guilds at once,
-- using the correct column names for each table.
--
-- Bug-fix: the previous JS pruner filtered audit_logs on a
-- non-existent 'created_at' column (actual: 'timestamp') and
-- webhook_events on 'status'/'created_at' (actual: 'result'/
-- 'processed_at'), so those prunes were silently no-ops.
-- This RPC uses the correct column names.
-- ============================================================

CREATE OR REPLACE FUNCTION public.prune_expired_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_count  bigint;
  v_now    timestamptz := now();
BEGIN
  -- Audit logs older than 90 days
  DELETE FROM public.audit_logs
    WHERE "timestamp" < v_now - INTERVAL '90 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('audit_logs', v_count);

  -- Expired portal sessions
  DELETE FROM public.portal_sessions
    WHERE expires_at < v_now;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('portal_sessions', v_count);

  -- Webhook events older than 30 days (only processed/ignored)
  DELETE FROM public.webhook_events
    WHERE result IN ('success', 'duplicate')
      AND processed_at < v_now - INTERVAL '30 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('webhook_events', v_count);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_expired_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_expired_data() TO service_role;
