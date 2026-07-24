-- =============================================================================
-- license_validations is a PERMANENT forensic audit ledger (owner decision).
--
-- The catalog contracts the validation ledger as a durable audit trail:
-- "every validation attempt leaves a durable log row with IP and result; rows
-- are never deleted, only anonymized under retention" and
-- "validation-log audit rows persist per anonymize-over-delete". But the live
-- implementation HARD-DELETES license_validations three ways:
--
--   1. the nightly cron 'retention-license-validations' runs
--      cleanup_old_records('license_validations', 90) — license_validations was
--      still in that function's allowlist (20260713030000, which only carved out
--      audit_logs);
--   2. prune_expired_data(p_guild_id) DELETEs rows older than 180 days
--      (20260627000000, carried forward into the 20260711030000 canonical body);
--   3. the FK license_validations_license_key_id_fkey is ON DELETE CASCADE from
--      license_keys, so deleting a key instantly wipes its entire validation
--      history.
--
-- The 2026-07-18 never-delete/anonymize decision (20260713030000) was scoped to
-- audit_logs ONLY and deliberately left license_validations on the hard-delete
-- path. This migration aligns license_validations to the same anonymize-over-
-- delete contract (Option A of the infrastructure-license-sdk ASK finding):
--
--   * FK license_key_id becomes ON DELETE SET NULL (license_key_id is nullable),
--     so deleting a parent key detaches — never erases — its validation history.
--   * cleanup_old_records() refuses license_validations and drops it from the
--     allowlist; the 'retention-license-validations' cron is unscheduled.
--   * prune_expired_data() stops DELETEing license_validations (the result key
--     stays at 0 for API compatibility, mirroring expired_mutes).
--   * scrub_expired_license_validations(retention_days) ANONYMIZES the PII
--     (ip_address, device_fingerprint, app_version) past the retention boundary
--     while retaining the forensic skeleton (result + created_at + key/product
--     linkage); a daily cron runs it. GRANT EXECUTE to service_role only.
-- =============================================================================
BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Deleting a license key must DETACH its validation history, not erase it.
--    license_key_id is already nullable, so SET NULL needs no column change.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.license_validations
  DROP CONSTRAINT IF EXISTS license_validations_license_key_id_fkey;
ALTER TABLE public.license_validations
  ADD CONSTRAINT license_validations_license_key_id_fkey
    FOREIGN KEY (license_key_id)
    REFERENCES public.license_keys(id)
    ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Sanctioned retention scrub — anonymize past the boundary, never delete.
--    Mirrors scrub_expired_audit_logs (20260713030000): identity-bearing fields
--    leave, the forensic skeleton (result, created_at, key/product linkage)
--    stays. The device_fingerprint guard keeps repeat runs from rescanning
--    already-scrubbed rows. Floor of 60 days matches the audit-log scrub floor.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.scrub_expired_license_validations(
  retention_days INT DEFAULT 60
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
      'retention_days for license_validations scrub must be at least 60, got %',
      retention_days;
  END IF;

  UPDATE public.license_validations
     SET ip_address = NULL,
         device_fingerprint = 'anonymized',
         app_version = NULL
   WHERE created_at < pg_catalog.now()
       - (retention_days || ' days')::INTERVAL
     AND device_fingerprint IS DISTINCT FROM 'anonymized';
  GET DIAGNOSTICS scrubbed_count = ROW_COUNT;
  RETURN scrubbed_count;
END;
$$;

REVOKE ALL ON FUNCTION public.scrub_expired_license_validations(INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrub_expired_license_validations(INT)
  TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. The generic cleaner may never delete license_validations again. Body taken
--    from the LIVE definition (20260713030000) with 'license_validations'
--    removed from the allowlist and its min_retention arm, and an explicit
--    RAISE pointing callers at the sanctioned scrub. audit_logs stays refused.
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
    'webhook_events'
  ];
  -- Per-table minimum retention (days) — prevents accidental deletion
  min_retention INT;
  ts_column TEXT;
  cutoff TIMESTAMPTZ;
  v_batch BIGINT;
  v_total BIGINT := 0;
  v_max_batches CONSTANT INT := 5;
  v_batch_num INT := 0;
  v_batch_size CONSTANT INT := 10000;
BEGIN
  IF target_table = 'audit_logs' THEN
    RAISE EXCEPTION
      'audit_logs rows are never deleted; retention runs through scrub_expired_audit_logs()';
  END IF;

  IF target_table = 'license_validations' THEN
    RAISE EXCEPTION
      'license_validations rows are never deleted; retention runs through scrub_expired_license_validations()';
  END IF;

  -- Only allow cleanup on approved tables (prevent SQL injection)
  IF NOT (target_table = ANY(allowed_tables)) THEN
    RAISE EXCEPTION 'Table "%" is not eligible for automated cleanup', target_table;
  END IF;

  -- Per-table minimum retention
  min_retention := CASE target_table
    WHEN 'economy_transactions' THEN 90
    WHEN 'webhook_events'       THEN 14
    ELSE 30
  END;

  IF retention_days < min_retention THEN
    RAISE EXCEPTION 'retention_days for "%" must be at least %, got %',
      target_table, min_retention, retention_days;
  END IF;

  -- Map each table to its timestamp column
  ts_column := CASE target_table
    WHEN 'webhook_events' THEN 'processed_at'
    ELSE 'created_at'
  END;

  cutoff := NOW() - (retention_days || ' days')::INTERVAL;

  -- Batch looping (up to 5 × 10k rows per invocation)
  LOOP
    v_batch_num := v_batch_num + 1;
    EXIT WHEN v_batch_num > v_max_batches;

    EXECUTE format(
      'WITH to_delete AS (
         SELECT ctid FROM public.%I
         WHERE %I < $1
         LIMIT %s
       )
       DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM to_delete)',
      target_table, ts_column, v_batch_size, target_table
    ) USING cutoff;

    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;

    -- Exit early if this batch was smaller than the limit (no more rows)
    EXIT WHEN v_batch < v_batch_size;
  END LOOP;

  RETURN v_total;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Retire the standing deletion cron. The scrub cron replaces it. Unschedule
--    is guarded so re-running the migration is safe.
-- ────────────────────────────────────────────────────────────────────────────
SELECT cron.unschedule('retention-license-validations')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-license-validations');

SELECT cron.unschedule('retention-license-validations-scrub')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-license-validations-scrub');

SELECT cron.schedule(
  'retention-license-validations-scrub',
  '20 3 * * *',
  $$SELECT public.scrub_expired_license_validations(60)$$
);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. prune_expired_data() must stop DELETEing license_validations. Body taken
--    from the LIVE canonical definition (20260711030000) with the
--    license_validations DELETE dropped; the 'old_license_validations' result
--    key stays at 0 for API compatibility (same pattern as expired_mutes).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prune_expired_data(p_guild_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result JSONB := '{}'::JSONB;
  cnt INTEGER;
BEGIN
  DELETE FROM public.infractions
   WHERE guild_id = p_guild_id AND active = true AND expires_at < now();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('expired_infractions', cnt);

  -- No mutes table has ever existed: mutes are infractions rows with
  -- type='mute' and are already covered by the expired_infractions delete
  -- above. The result key stays for API compatibility (same pattern as
  -- expired_temp_roles below).
  result := result || jsonb_build_object('expired_mutes', 0);

  -- Retention scrubs, never deletes (owner decision, 2026-07-18): identity
  -- and payloads leave at the retention boundary, the forensic skeleton
  -- stays. The actor_id guard keeps repeat prune runs from recounting
  -- already-scrubbed rows.
  UPDATE public.audit_logs
     SET actor_id = 'anonymized',
         target_id = CASE WHEN target_id IS NULL THEN NULL ELSE 'anonymized' END,
         details = pg_catalog.jsonb_build_object('anonymized', true),
         before_state = NULL,
         after_state = NULL,
         error_message = NULL,
         correlation_id = NULL
   WHERE guild_id = p_guild_id
     AND timestamp < now() - interval '90 days'
     AND actor_id IS DISTINCT FROM 'anonymized';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('old_audit_logs', cnt);

  result := result || jsonb_build_object('expired_temp_roles', 0);

  DELETE FROM public.webhook_events
   WHERE (guild_id = p_guild_id OR guild_id IS NULL)
     AND processed_at < now() - interval '90 days';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('old_webhook_events', cnt);

  -- license_validations is a permanent forensic ledger: never TTL-deleted here.
  -- PII anonymization runs through scrub_expired_license_validations() on its
  -- own cron. The result key stays at 0 for API compatibility.
  result := result || jsonb_build_object('old_license_validations', 0);

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_expired_data(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_expired_data(TEXT)
  TO service_role;

COMMIT;
