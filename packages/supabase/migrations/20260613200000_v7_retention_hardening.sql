-- V7 Audit §5.P3a — Per-table minimum retention days.
-- Prevents accidental data loss from misconfigured cleanup_old_records() calls.
-- V7 Audit §5.P3b — Switch retention cron from weekly to daily for high-volume tables.

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
  -- V7 Audit §5.P3a — per-table minimum retention (days)
  min_retention INT;
  ts_column TEXT;
  cutoff TIMESTAMPTZ;
  deleted_count BIGINT;
BEGIN
  -- Only allow cleanup on approved tables (prevent SQL injection)
  IF NOT (target_table = ANY(allowed_tables)) THEN
    RAISE EXCEPTION 'Table "%" is not eligible for automated cleanup', target_table;
  END IF;

  -- Per-table minimum retention — prevents accidental deletion of recent data
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

REVOKE ALL ON FUNCTION cleanup_old_records(TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cleanup_old_records(TEXT, INT) TO service_role;

-- V7 Audit §5.P3b — Switch retention cron from weekly (Sunday) to daily (3 AM UTC).
-- High-volume tables (webhook_events: 30-day retention) can accumulate significantly
-- between weekly runs. Daily 10k-batch runs keep the backlog manageable.

SELECT cron.unschedule('retention-economy-transactions')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-economy-transactions');

SELECT cron.schedule(
  'retention-economy-transactions',
  '0 3 * * *',
  $$SELECT cleanup_old_records('economy_transactions', 180)$$
);

SELECT cron.unschedule('retention-audit-log')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-audit-log');

SELECT cron.schedule(
  'retention-audit-log',
  '10 3 * * *',
  $$SELECT cleanup_old_records('audit_logs', 90)$$
);

SELECT cron.unschedule('retention-license-validations')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-license-validations');

SELECT cron.schedule(
  'retention-license-validations',
  '20 3 * * *',
  $$SELECT cleanup_old_records('license_validations', 90)$$
);

SELECT cron.unschedule('retention-webhook-events')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-webhook-events');

SELECT cron.schedule(
  'retention-webhook-events',
  '30 3 * * *',
  $$SELECT cleanup_old_records('webhook_events', 30)$$
);
