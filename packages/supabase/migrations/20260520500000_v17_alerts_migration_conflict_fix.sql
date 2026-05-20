-- ═══════════════════════════════════════════════════════════════════════
-- V17 Audit: Fix alerts table migration conflict
-- ═══════════════════════════════════════════════════════════════════════
--
-- Problem: 20260518000001_missing_tables.sql creates `alerts` FIRST.
--          20260518100000_alerts_table.sql uses CREATE TABLE IF NOT EXISTS
--          → silently skipped because the table already exists.
--
-- Missing columns (from alerts_table.sql, used by bot + dashboard):
--   resolved   BOOLEAN   — code uses .eq('resolved', false), .update({resolved: true})
--   updated_at TIMESTAMPTZ — code writes on every acknowledge/resolve/update
--   metadata   JSONB     — bot AlertManager inserts alerts with metadata field
--
-- Stale columns (from missing_tables.sql, unused by any code):
--   auto_resolved BOOLEAN — never referenced in bot or dashboard
--   details       JSONB  — code uses metadata instead
--
-- Impact: Entire alerts system broken — bot can't create/resolve alerts,
--         dashboard can't filter/display/acknowledge/resolve alerts.
-- ═══════════════════════════════════════════════════════════════════════

-- Add the three missing columns
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS resolved BOOLEAN DEFAULT false;

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Backfill: if any rows exist with auto_resolved=true, mark them resolved
UPDATE alerts SET resolved = true WHERE auto_resolved = true AND resolved IS NULL;

-- Backfill: copy details → metadata for any existing rows
UPDATE alerts SET metadata = details WHERE metadata = '{}' AND details IS NOT NULL;
