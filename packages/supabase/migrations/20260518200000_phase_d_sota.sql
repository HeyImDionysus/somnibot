-- Phase D: SOTA Roadmap — RBAC, Customer Portal, Fraud, Incidents, Workflows, Admin Changes
-- Migration: 20260518200000_phase_d_sota.sql

-- ============================================================
-- D1: Dashboard RBAC
-- ============================================================

CREATE TABLE IF NOT EXISTS dashboard_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_system BOOLEAN NOT NULL DEFAULT false,
  priority INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, name)
);

-- Ensure columns exist even if table was created by an earlier migration
ALTER TABLE dashboard_roles ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;
COMMENT ON TABLE dashboard_roles IS 'Dashboard role definitions with permission sets';

CREATE TABLE IF NOT EXISTS dashboard_user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  discord_id TEXT NOT NULL,
  role_id UUID NOT NULL REFERENCES dashboard_roles(id) ON DELETE CASCADE,
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, discord_id, role_id)
);

-- Ensure columns exist even if table was created by an earlier migration
ALTER TABLE dashboard_user_roles ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE dashboard_user_roles ADD COLUMN IF NOT EXISTS assigned_by UUID;
ALTER TABLE dashboard_user_roles ADD COLUMN IF NOT EXISTS discord_id TEXT;
COMMENT ON TABLE dashboard_user_roles IS 'Maps Discord users to dashboard roles';

CREATE INDEX IF NOT EXISTS idx_dashboard_user_roles_lookup ON dashboard_user_roles(guild_id, discord_id);

-- ============================================================
-- D2: Customer Portal Sessions
-- ============================================================

CREATE TABLE IF NOT EXISTS portal_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  discord_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT,
  user_agent TEXT,
  revoked BOOLEAN NOT NULL DEFAULT false
);

-- Ensure columns exist even if table was created by an earlier migration
ALTER TABLE portal_sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE portal_sessions ADD COLUMN IF NOT EXISTS revoked BOOLEAN DEFAULT false;
ALTER TABLE portal_sessions ADD COLUMN IF NOT EXISTS token_hash TEXT;
COMMENT ON TABLE portal_sessions IS 'Customer portal authentication sessions';

CREATE INDEX IF NOT EXISTS idx_portal_sessions_token ON portal_sessions(token_hash) WHERE revoked = false;
CREATE INDEX IF NOT EXISTS idx_portal_sessions_customer ON portal_sessions(customer_id);

-- ============================================================
-- D5: Fraud Controls
-- ============================================================

CREATE TABLE IF NOT EXISTS fraud_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('velocity', 'device_abuse', 'chargeback', 'ip_mismatch', 'key_sharing', 'payment_pattern')),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  discord_id TEXT,
  description TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'confirmed', 'dismissed', 'auto_resolved')),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  auto_action TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure columns exist even if table was created by an earlier migration
ALTER TABLE fraud_signals ADD COLUMN IF NOT EXISTS auto_action TEXT;
ALTER TABLE fraud_signals ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE fraud_signals ADD COLUMN IF NOT EXISTS entity_id TEXT;
ALTER TABLE fraud_signals ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE fraud_signals ADD COLUMN IF NOT EXISTS evidence JSONB;
ALTER TABLE fraud_signals ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE fraud_signals ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE fraud_signals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
COMMENT ON TABLE fraud_signals IS 'Detected fraud signals from automated checks and manual reports';

CREATE INDEX IF NOT EXISTS idx_fraud_signals_guild_status ON fraud_signals(guild_id, status);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_entity ON fraud_signals(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_severity ON fraud_signals(guild_id, severity) WHERE status NOT IN ('dismissed', 'auto_resolved');

CREATE TABLE IF NOT EXISTS fraud_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('velocity_limit', 'device_limit', 'ip_block', 'amount_threshold', 'pattern_match')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  auto_action TEXT NOT NULL DEFAULT 'flag',
  trigger_count INTEGER NOT NULL DEFAULT 0,
  last_triggered TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure columns exist even if table was created by an earlier migration
ALTER TABLE fraud_rules ADD COLUMN IF NOT EXISTS auto_action TEXT;
ALTER TABLE fraud_rules ADD COLUMN IF NOT EXISTS last_triggered TIMESTAMPTZ;
ALTER TABLE fraud_rules ADD COLUMN IF NOT EXISTS trigger_count INTEGER DEFAULT 0;
COMMENT ON TABLE fraud_rules IS 'Configurable fraud detection rules';

-- ============================================================
-- D6: Incidents
-- ============================================================

CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  incident_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical', 'outage')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'identified', 'monitoring', 'resolved')),
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref_id TEXT,
  assigned_to TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  identified_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  impact_summary TEXT,
  root_cause TEXT,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, incident_number)
);

-- Ensure columns exist even if table was created by an earlier migration
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS identified_at TIMESTAMPTZ;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS impact_summary TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS incident_number INTEGER;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS root_cause TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source_ref_id TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
COMMENT ON TABLE incidents IS 'Operational incident tracking with lifecycle management';

CREATE INDEX IF NOT EXISTS idx_incidents_guild_status ON incidents(guild_id, status);

CREATE TABLE IF NOT EXISTS incident_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure columns exist even if table was created by an earlier migration
ALTER TABLE incident_events ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE incident_events ADD COLUMN IF NOT EXISTS metadata JSONB;
COMMENT ON TABLE incident_events IS 'Timeline events within an incident';

CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events(incident_id);

-- ============================================================
-- D7: Dead-Letter Queue & Workflow Events
-- ============================================================

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  error_stack TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'exhausted', 'resolved', 'discarded')),
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_retry_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure columns exist even if table was created by an earlier migration
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS error_stack TEXT;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS max_retries INTEGER DEFAULT 5;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
COMMENT ON TABLE dead_letter_queue IS 'Failed events awaiting manual resolution or retry';

CREATE INDEX IF NOT EXISTS idx_dlq_guild_status ON dead_letter_queue(guild_id, status);

CREATE TABLE IF NOT EXISTS workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  correlation_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result TEXT CHECK (result IS NULL OR result IN ('success', 'error', 'skipped', 'pending')),
  error_message TEXT,
  duration_ms INTEGER,
  parent_event_id UUID REFERENCES workflow_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure columns exist even if table was created by an earlier migration
ALTER TABLE workflow_events ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE workflow_events ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE workflow_events ADD COLUMN IF NOT EXISTS parent_event_id UUID;
ALTER TABLE workflow_events ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE workflow_events ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE workflow_events ADD COLUMN IF NOT EXISTS source TEXT;
COMMENT ON TABLE workflow_events IS 'Durable event log for workflow operations';

CREATE INDEX IF NOT EXISTS idx_workflow_events_guild ON workflow_events(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_events_correlation ON workflow_events(correlation_id) WHERE correlation_id IS NOT NULL;

-- ============================================================
-- D8: Admin Change Tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  description TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  undo_payload JSONB,
  is_undoable BOOLEAN NOT NULL DEFAULT false,
  is_undone BOOLEAN NOT NULL DEFAULT false,
  undone_at TIMESTAMPTZ,
  undone_by TEXT,
  undo_change_id UUID REFERENCES admin_changes(id),
  blast_radius TEXT NOT NULL DEFAULT 'low' CHECK (blast_radius IN ('low', 'medium', 'high', 'critical')),
  requires_confirmation BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure columns exist even if table was created by an earlier migration
ALTER TABLE admin_changes ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE admin_changes ADD COLUMN IF NOT EXISTS blast_radius TEXT;
ALTER TABLE admin_changes ADD COLUMN IF NOT EXISTS is_undoable BOOLEAN DEFAULT false;
ALTER TABLE admin_changes ADD COLUMN IF NOT EXISTS is_undone BOOLEAN DEFAULT false;
ALTER TABLE admin_changes ADD COLUMN IF NOT EXISTS requires_confirmation BOOLEAN DEFAULT false;
ALTER TABLE admin_changes ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE admin_changes ADD COLUMN IF NOT EXISTS undo_change_id UUID;
ALTER TABLE admin_changes ADD COLUMN IF NOT EXISTS undo_payload JSONB;
COMMENT ON TABLE admin_changes IS 'Admin action history with before/after diffs and undo capability';

CREATE INDEX IF NOT EXISTS idx_admin_changes_guild ON admin_changes(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_changes_undoable ON admin_changes(guild_id) WHERE is_undoable = true AND is_undone = false;

-- ============================================================
-- RLS Policies (service_role only, consistent with existing tables)
-- ============================================================

ALTER TABLE dashboard_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letter_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_changes ENABLE ROW LEVEL SECURITY;

-- Service-role has full access
DROP POLICY IF EXISTS "service_role_dashboard_roles" ON dashboard_roles;
CREATE POLICY "service_role_dashboard_roles" ON dashboard_roles FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_dashboard_user_roles" ON dashboard_user_roles;
CREATE POLICY "service_role_dashboard_user_roles" ON dashboard_user_roles FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_portal_sessions" ON portal_sessions;
CREATE POLICY "service_role_portal_sessions" ON portal_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_fraud_signals" ON fraud_signals;
CREATE POLICY "service_role_fraud_signals" ON fraud_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_fraud_rules" ON fraud_rules;
CREATE POLICY "service_role_fraud_rules" ON fraud_rules FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_incidents" ON incidents;
CREATE POLICY "service_role_incidents" ON incidents FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_incident_events" ON incident_events;
CREATE POLICY "service_role_incident_events" ON incident_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_dead_letter_queue" ON dead_letter_queue;
CREATE POLICY "service_role_dead_letter_queue" ON dead_letter_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_workflow_events" ON workflow_events;
CREATE POLICY "service_role_workflow_events" ON workflow_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_admin_changes" ON admin_changes;
CREATE POLICY "service_role_admin_changes" ON admin_changes FOR ALL TO service_role USING (true) WITH CHECK (true);
