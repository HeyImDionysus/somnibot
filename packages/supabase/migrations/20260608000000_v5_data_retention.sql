-- V5 Audit §5.6 — Data retention RPCs for high-volume tables.
--
-- Provides configurable cleanup for tables that grow unbounded:
--   economy_transactions, audit_log, license_validations, webhook_events
--
-- Usage:  SELECT cleanup_old_records('economy_transactions', 90);
--         (deletes rows older than 90 days, returns count deleted)

-- ── Retention RPC ───────────────────────────────────────
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
    'audit_log',
    'license_validations',
    'webhook_events'
  ];
  cutoff TIMESTAMPTZ;
  deleted_count BIGINT;
BEGIN
  -- Only allow cleanup on approved tables (prevent SQL injection)
  IF NOT (target_table = ANY(allowed_tables)) THEN
    RAISE EXCEPTION 'Table "%" is not eligible for automated cleanup', target_table;
  END IF;

  IF retention_days < 30 THEN
    RAISE EXCEPTION 'retention_days must be at least 30';
  END IF;

  cutoff := NOW() - (retention_days || ' days')::INTERVAL;

  -- Delete in batches to avoid long locks
  EXECUTE format(
    'WITH to_delete AS (
       SELECT ctid FROM %I
       WHERE created_at < $1
       LIMIT 10000
     )
     DELETE FROM %I WHERE ctid IN (SELECT ctid FROM to_delete)',
    target_table, target_table
  ) USING cutoff;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Revoke from public roles — only service role can call this
REVOKE EXECUTE ON FUNCTION cleanup_old_records(TEXT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION cleanup_old_records(TEXT, INT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION cleanup_old_records(TEXT, INT) FROM public;

-- ── Indexes to support efficient date-range deletes ─────
-- These use CONCURRENTLY so they won't block writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_economy_transactions_created_at
  ON economy_transactions (created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_created_at
  ON audit_log (created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_license_validations_created_at
  ON license_validations (created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_events_created_at
  ON webhook_events (created_at);
