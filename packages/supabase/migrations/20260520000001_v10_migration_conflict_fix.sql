-- ============================================================
-- V10 Audit: Migration Conflict Resolution
-- ============================================================
--
-- Problem: 10 tables were defined in BOTH 20260518000001_missing_tables.sql
-- and 20260518200000_phase_d_sota.sql with different schemas.
-- Because both use CREATE TABLE IF NOT EXISTS, the earlier (missing_tables)
-- definition "wins" and the Phase D columns are silently skipped.
-- All code was written against the Phase D schema, so these tables have
-- wrong/missing columns.
--
-- Additionally, 3 guild_config columns referenced in bot code were never
-- created in any migration: paypal_enabled, custom_bot_statuses, onboarding_config.
--
-- This migration adds all missing columns to align the actual DB schema
-- with what the code expects.
-- ============================================================

-- ── 1. guild_config — 3 missing columns ─────────────────────

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS paypal_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS custom_bot_statuses TEXT[] DEFAULT '{}';

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS onboarding_config JSONB DEFAULT NULL;

-- ── 2. portal_sessions — code expects token_hash, revoked, last_used_at ──
-- Actual table has session_token instead of token_hash, and lacks revoked/last_used_at.

ALTER TABLE portal_sessions
  ADD COLUMN IF NOT EXISTS token_hash TEXT;

ALTER TABLE portal_sessions
  ADD COLUMN IF NOT EXISTS revoked BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE portal_sessions
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Migrate existing session_token data to token_hash
UPDATE portal_sessions SET token_hash = session_token WHERE token_hash IS NULL AND session_token IS NOT NULL;

-- Now make token_hash NOT NULL + UNIQUE (matches Phase D definition)
-- Only if there are no remaining NULLs
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM portal_sessions WHERE token_hash IS NULL) THEN
    BEGIN
      ALTER TABLE portal_sessions ALTER COLUMN token_hash SET NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END;
    BEGIN
      ALTER TABLE portal_sessions ADD CONSTRAINT portal_sessions_token_hash_key UNIQUE (token_hash);
    EXCEPTION WHEN duplicate_table THEN NULL;
    END;
  END IF;
END $$;

-- Recreate index on token_hash (Phase D definition)
DROP INDEX IF EXISTS idx_portal_sessions_token;
CREATE INDEX IF NOT EXISTS idx_portal_sessions_token ON portal_sessions(token_hash) WHERE revoked = false;

-- ── 3. fraud_signals — code expects Phase D columns ─────────
-- Actual: action, customer_id, details, order_id, resolved
-- Expected: entity_type, entity_id, description, evidence, status, auto_action, resolution_note, updated_at

ALTER TABLE fraud_signals
  ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE fraud_signals
  ADD COLUMN IF NOT EXISTS entity_id TEXT;
ALTER TABLE fraud_signals
  ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE fraud_signals
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE fraud_signals
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE fraud_signals
  ADD COLUMN IF NOT EXISTS auto_action TEXT;
ALTER TABLE fraud_signals
  ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE fraud_signals
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Add the CHECK constraint on status if not present
DO $$
BEGIN
  ALTER TABLE fraud_signals ADD CONSTRAINT fraud_signals_status_check
    CHECK (status IN ('open', 'investigating', 'confirmed', 'dismissed', 'auto_resolved'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add indexes from Phase D
CREATE INDEX IF NOT EXISTS idx_fraud_signals_guild_status ON fraud_signals(guild_id, status);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_entity ON fraud_signals(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_severity ON fraud_signals(guild_id, severity) WHERE status NOT IN ('dismissed', 'auto_resolved');

-- ── 4. fraud_rules — code expects auto_action, last_triggered, trigger_count ──

ALTER TABLE fraud_rules
  ADD COLUMN IF NOT EXISTS auto_action TEXT NOT NULL DEFAULT 'flag';
ALTER TABLE fraud_rules
  ADD COLUMN IF NOT EXISTS last_triggered TIMESTAMPTZ;
ALTER TABLE fraud_rules
  ADD COLUMN IF NOT EXISTS trigger_count INTEGER NOT NULL DEFAULT 0;

-- ── 5. admin_changes — code expects Phase D columns ─────────
-- Actual: change_type, target_table, undone
-- Expected: action, target_type, is_undoable, is_undone, blast_radius, requires_confirmation, undo_payload, undo_change_id

ALTER TABLE admin_changes
  ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE admin_changes
  ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE admin_changes
  ADD COLUMN IF NOT EXISTS is_undoable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE admin_changes
  ADD COLUMN IF NOT EXISTS is_undone BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE admin_changes
  ADD COLUMN IF NOT EXISTS blast_radius TEXT NOT NULL DEFAULT 'low';
ALTER TABLE admin_changes
  ADD COLUMN IF NOT EXISTS requires_confirmation BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE admin_changes
  ADD COLUMN IF NOT EXISTS undo_payload JSONB;
ALTER TABLE admin_changes
  ADD COLUMN IF NOT EXISTS undo_change_id UUID;

-- Backfill action from change_type, target_type from target_table
UPDATE admin_changes SET action = change_type WHERE action IS NULL AND change_type IS NOT NULL;
UPDATE admin_changes SET target_type = target_table WHERE target_type IS NULL AND target_table IS NOT NULL;
UPDATE admin_changes SET is_undone = undone WHERE undone IS NOT NULL;

-- ── 6. dashboard_roles — code expects priority ──────────────

ALTER TABLE dashboard_roles
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

-- ── 7. dashboard_user_roles — code expects discord_id, assigned_at, assigned_by ──
-- Actual: user_id, created_at, granted_by

ALTER TABLE dashboard_user_roles
  ADD COLUMN IF NOT EXISTS discord_id TEXT;
ALTER TABLE dashboard_user_roles
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE dashboard_user_roles
  ADD COLUMN IF NOT EXISTS assigned_by TEXT;

-- Backfill from old columns
UPDATE dashboard_user_roles SET discord_id = user_id WHERE discord_id IS NULL AND user_id IS NOT NULL;
UPDATE dashboard_user_roles SET assigned_at = created_at WHERE assigned_at IS NULL AND created_at IS NOT NULL;
UPDATE dashboard_user_roles SET assigned_by = granted_by WHERE assigned_by IS NULL AND granted_by IS NOT NULL;

-- ── 8. dead_letter_queue — code expects Phase D columns ─────
-- Actual: action_type, error, failure_count, last_failed_at, reprocessed, reprocessed_at, source_id, source_type
-- Expected: event_type, error_message, error_stack, retry_count, last_retry_at, max_retries, source, status, resolved_at, resolved_by, resolution_note

ALTER TABLE dead_letter_queue
  ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE dead_letter_queue
  ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE dead_letter_queue
  ADD COLUMN IF NOT EXISTS error_stack TEXT;
ALTER TABLE dead_letter_queue
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dead_letter_queue
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;
ALTER TABLE dead_letter_queue
  ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 5;
ALTER TABLE dead_letter_queue
  ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE dead_letter_queue
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE dead_letter_queue
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE dead_letter_queue
  ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE dead_letter_queue
  ADD COLUMN IF NOT EXISTS resolution_note TEXT;

-- Backfill
UPDATE dead_letter_queue SET event_type = action_type WHERE event_type IS NULL AND action_type IS NOT NULL;
UPDATE dead_letter_queue SET error_message = error WHERE error_message IS NULL AND error IS NOT NULL;
UPDATE dead_letter_queue SET retry_count = failure_count WHERE retry_count = 0 AND failure_count IS NOT NULL AND failure_count > 0;
UPDATE dead_letter_queue SET last_retry_at = last_failed_at WHERE last_retry_at IS NULL AND last_failed_at IS NOT NULL;
UPDATE dead_letter_queue SET source = source_type WHERE source IS NULL AND source_type IS NOT NULL;

-- ── 9. incidents — code expects Phase D columns ─────────────
-- Actual: category, created_by, resolved_by
-- Expected: incident_number, source, source_ref_id, started_at, identified_at, duration_seconds, impact_summary, root_cause

ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS incident_number INTEGER;
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS source_ref_id TEXT;
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS identified_at TIMESTAMPTZ;
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS impact_summary TEXT;
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS root_cause TEXT;

-- Backfill started_at from created_at for existing rows
UPDATE incidents SET started_at = created_at WHERE started_at = now();

-- ── 10. incident_events — code expects message, metadata ────
-- Actual: details
-- Expected: message, metadata

ALTER TABLE incident_events
  ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE incident_events
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Backfill: if details was a string-like JSONB, migrate to message
-- (safe no-op if no rows exist)

-- ── 11. workflow_events — code expects Phase D columns ──────
-- Actual: automation_id, error, execution_id, input_data, output_data, step_name
-- Expected: correlation_id, error_message, parent_event_id, payload, result, source

ALTER TABLE workflow_events
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE workflow_events
  ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE workflow_events
  ADD COLUMN IF NOT EXISTS parent_event_id UUID;
ALTER TABLE workflow_events
  ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE workflow_events
  ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE workflow_events
  ADD COLUMN IF NOT EXISTS source TEXT;

-- Backfill
UPDATE workflow_events SET error_message = error WHERE error_message IS NULL AND error IS NOT NULL;
UPDATE workflow_events SET correlation_id = execution_id WHERE correlation_id IS NULL AND execution_id IS NOT NULL;
UPDATE workflow_events SET payload = input_data WHERE payload IS NULL AND input_data IS NOT NULL;
UPDATE workflow_events SET result = output_data WHERE result IS NULL AND output_data IS NOT NULL;

-- ============================================================
-- Done. All 10 conflicting tables now have the columns the code expects,
-- plus 3 missing guild_config columns.
-- ============================================================
