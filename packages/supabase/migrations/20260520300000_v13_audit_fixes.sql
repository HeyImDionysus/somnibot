-- ================================================================
-- V13 Audit Fixes
-- ================================================================

-- ── Bug 1: Non-atomic incident_number generation ────────────────
-- Both fraud-detection.ts and incidents/route.ts use
-- SELECT max(incident_number) + 1, which is racy under concurrent
-- inserts (same pattern fixed for tickets in V8 with nextval_ticket).
-- Fix: create a sequence + RPC wrapper, matching the ticket pattern.

CREATE SEQUENCE IF NOT EXISTS incident_number_seq START 1;

-- Seed the sequence from existing data so it doesn't collide
DO $$
DECLARE
  max_num BIGINT;
BEGIN
  SELECT COALESCE(MAX(incident_number), 0) INTO max_num FROM incidents;
  IF max_num > 0 THEN
    PERFORM setval('incident_number_seq', max_num);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION nextval_incident()
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
AS $$ SELECT nextval('incident_number_seq'); $$;

-- ── Bug 2: reconciliation_runs missing guild_id column ──────────
-- In multi-guild deployments every guild sees every other guild's
-- reconciliation runs. The bot already has guild context but doesn't
-- write it; the dashboard extracts guildId but never filters.
-- Fix: add guild_id column + index.

ALTER TABLE reconciliation_runs
  ADD COLUMN IF NOT EXISTS guild_id TEXT REFERENCES guild(id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_guild
  ON reconciliation_runs (guild_id, started_at DESC);

-- ── Bug 3: reconciliation_runs missing from generated types ─────
-- The generate-db-types.py script missed this table entirely.
-- (Fixed in database.ts below — this comment is for audit trail.)
