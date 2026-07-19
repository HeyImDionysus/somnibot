-- =============================================================================
-- Audit rows are NEVER deleted (owner decision, 2026-07-18).
--
-- trg_prevent_audit_log_delete stays unconditional. Tenant deletion
-- (purge_guild_data) and retention pruning ANONYMIZE instead:
-- identity-bearing fields (actor/target ids, payload snapshots, error text,
-- correlation) are scrubbed while the forensic skeleton (action, actor
-- type, timestamp, outcome) is retained forever.
--
-- Tenant purge additionally DETACHES the scrubbed rows from the erased
-- guild so the guild row itself can be deleted: guild_id must therefore
-- accept NULL for anonymized orphans. Live audit writes still always carry
-- a guild binding — the bot and dashboard never insert NULL — and the FK
-- continues to validate every non-NULL binding.
--
-- This migration also RETIRES every standing deletion path so nothing
-- fights the trigger: the nightly retention cron switches from
-- cleanup_old_records('audit_logs', ...) — whose DELETE the trigger would
-- reject every night forever once any row ages past the window — to a
-- sanctioned scrub; the generic cleaner refuses audit_logs outright; the
-- stale parameterless prune_expired_data() overload is dropped; and
-- service_role loses UPDATE/DELETE/TRUNCATE (TRUNCATE bypasses row
-- triggers entirely) so the never-delete contract holds even against a
-- compromised service credential. All scrubs run inside table-owner
-- SECURITY DEFINER functions.
-- =============================================================================
BEGIN;

ALTER TABLE public.audit_logs
  ALTER COLUMN guild_id DROP NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- Sanctioned global retention scrub — replaces the deletion cron.
-- Identity and payloads leave at the retention boundary, the skeleton stays.
-- Idempotent: the actor_id guard keeps repeat runs from rescanning rows.
-- Detached (guild_id IS NULL) tenant-purge orphans are already fully
-- scrubbed and are excluded by the guard as well.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.scrub_expired_audit_logs(
  retention_days INT DEFAULT 90
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  scrubbed_count BIGINT;
BEGIN
  IF retention_days < 60 THEN
    RAISE EXCEPTION
      'retention_days for audit_logs scrub must be at least 60, got %',
      retention_days;
  END IF;

  UPDATE public.audit_logs
     SET actor_id = 'anonymized',
         target_id = CASE WHEN target_id IS NULL THEN NULL ELSE 'anonymized' END,
         details = pg_catalog.jsonb_build_object('anonymized', true),
         before_state = NULL,
         after_state = NULL,
         error_message = NULL,
         correlation_id = NULL
   WHERE "timestamp" < pg_catalog.now()
       - (retention_days || ' days')::INTERVAL
     AND actor_id IS DISTINCT FROM 'anonymized';
  GET DIAGNOSTICS scrubbed_count = ROW_COUNT;
  RETURN scrubbed_count;
END;
$$;

REVOKE ALL ON FUNCTION public.scrub_expired_audit_logs(INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrub_expired_audit_logs(INT) TO service_role;

SELECT cron.unschedule('retention-audit-log')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-audit-log');

SELECT cron.schedule(
  'retention-audit-scrub',
  '10 3 * * *',
  $$SELECT public.scrub_expired_audit_logs(90)$$
);

-- ────────────────────────────────────────────────────────────────────────────
-- The generic cleaner may never target audit_logs again. Same body as
-- 20260613200000 with audit_logs removed from the allowlist and an explicit
-- pointer at the sanctioned scrub.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cleanup_old_records(
  target_table TEXT,
  retention_days INT DEFAULT 180
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  allowed_tables TEXT[] := ARRAY[
    'economy_transactions',
    'license_validations',
    'webhook_events'
  ];
  min_retention INT;
  ts_column TEXT;
  cutoff TIMESTAMPTZ;
  deleted_count BIGINT;
BEGIN
  IF target_table = 'audit_logs' THEN
    RAISE EXCEPTION
      'audit_logs rows are never deleted; retention runs through scrub_expired_audit_logs()';
  END IF;
  IF NOT (target_table = ANY(allowed_tables)) THEN
    RAISE EXCEPTION 'Table "%" is not eligible for automated cleanup', target_table;
  END IF;

  min_retention := CASE target_table
    WHEN 'economy_transactions' THEN 90
    WHEN 'license_validations'  THEN 60
    WHEN 'webhook_events'       THEN 14
    ELSE 30
  END;

  IF retention_days < min_retention THEN
    RAISE EXCEPTION 'retention_days for "%" must be at least %, got %',
      target_table, min_retention, retention_days;
  END IF;

  ts_column := CASE target_table
    WHEN 'webhook_events' THEN 'processed_at'
    ELSE 'created_at'
  END;

  cutoff := NOW() - (retention_days || ' days')::INTERVAL;

  -- Delete in batches to avoid long locks
  EXECUTE format(
    'WITH to_delete AS (
       SELECT ctid FROM %I
       WHERE %I < $1
       LIMIT 10000
     )
     DELETE FROM %I WHERE ctid IN (SELECT ctid FROM to_delete)',
    target_table, ts_column, target_table
  ) USING cutoff;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- The stale parameterless retention overload predates the scrub contract
-- and still DELETEs audit rows; nothing schedules it, nothing may call it.
DROP FUNCTION IF EXISTS public.prune_expired_data();

-- Never-delete holds against service_role too: TRUNCATE bypasses row
-- triggers, UPDATE would allow in-place rewriting. Bot and dashboard only
-- ever INSERT and SELECT audit rows; every scrub runs as the table owner.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.audit_logs FROM service_role;

COMMIT;
