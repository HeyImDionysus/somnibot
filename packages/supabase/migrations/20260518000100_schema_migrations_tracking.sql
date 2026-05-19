-- ============================================================
-- Schema Migrations Tracking Table
-- Phase C: Replace first-boot-only migration runner with
-- per-file tracking, checksums, and safe retry.
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ DEFAULT now(),
  duration_ms INTEGER DEFAULT 0,
  success     BOOLEAN DEFAULT true
);

ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

-- Only service role can read/write migration tracking
CREATE POLICY "service_role_only" ON schema_migrations
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE schema_migrations IS 'Tracks which SQL migrations have been applied, with checksums for drift detection.';
