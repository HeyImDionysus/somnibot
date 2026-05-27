-- ============================================================
-- V8 Audit §5.P3a — Drop orphaned 3-param cleanup_old_records overload
-- ============================================================
-- Migration 20260613200000 (v7 retention hardening) defines the authoritative
-- 2-param version with per-table minimum retention guards + daily cron calls.
-- Migration 20260614000000 (v5 audit hardening) added a 3-param overload
-- (p_table_name, p_retention_days, p_batch_size) with 50k-batch looping,
-- but no cron job references it and it creates confusion about which
-- function is canonical. The batch looping feature from the 3-param version
-- is merged into the authoritative 2-param version below.
-- ============================================================

-- Drop the orphaned 3-param overload
DROP FUNCTION IF EXISTS public.cleanup_old_records(TEXT, INT, INT);

-- Upgrade the authoritative 2-param version with batch looping
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
    'audit_logs',
    'license_validations',
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
  -- Only allow cleanup on approved tables (prevent SQL injection)
  IF NOT (target_table = ANY(allowed_tables)) THEN
    RAISE EXCEPTION 'Table "%" is not eligible for automated cleanup', target_table;
  END IF;

  -- Per-table minimum retention
  min_retention := CASE target_table
    WHEN 'economy_transactions' THEN 90
    WHEN 'audit_logs'           THEN 60
    WHEN 'license_validations'  THEN 60
    WHEN 'webhook_events'       THEN 14
    ELSE 30
  END;

  IF retention_days < min_retention THEN
    RAISE EXCEPTION 'retention_days for "%" must be at least %, got %',
      target_table, min_retention, retention_days;
  END IF;

  -- Map each table to its timestamp column
  ts_column := CASE target_table
    WHEN 'audit_logs'     THEN 'timestamp'
    WHEN 'webhook_events' THEN 'processed_at'
    ELSE 'created_at'
  END;

  cutoff := NOW() - (retention_days || ' days')::INTERVAL;

  -- V8 Audit: batch looping (up to 5 × 10k rows per invocation)
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

REVOKE ALL ON FUNCTION cleanup_old_records(TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cleanup_old_records(TEXT, INT) TO service_role;
