-- ============================================================
-- Missing Tables Migration
-- Creates all tables referenced in code but not yet in the
-- database. Covers: action queue, RBAC, fraud/incidents,
-- portal, workflow observability, admin changes, alerts,
-- guild live state, sync actions, message reports.
-- ============================================================

-- ── bot_action_queue ────────────────────────────────────────
-- Commerce fulfillment pipeline: webhook → queue → bot processes
CREATE TABLE IF NOT EXISTS bot_action_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id      TEXT NOT NULL,
  action_type   TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  error         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_action_queue_status ON bot_action_queue (status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_action_queue_guild ON bot_action_queue (guild_id, status);

ALTER TABLE bot_action_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON bot_action_queue
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── guild_live_state ────────────────────────────────────────
-- Cached snapshot of Discord guild state for drift detection
CREATE TABLE IF NOT EXISTS guild_live_state (
  guild_id     TEXT PRIMARY KEY,
  roles        JSONB NOT NULL DEFAULT '[]',
  channels     JSONB NOT NULL DEFAULT '[]',
  categories   JSONB NOT NULL DEFAULT '[]',
  member_count INTEGER,
  bot_role_id  TEXT,
  snapshot_at  TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE guild_live_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON guild_live_state
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── sync_actions ────────────────────────────────────────────
-- Log of server sync repair actions taken
CREATE TABLE IF NOT EXISTS sync_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  details     JSONB,
  status      TEXT NOT NULL DEFAULT 'pending',
  applied_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_actions_guild ON sync_actions (guild_id, created_at DESC);

ALTER TABLE sync_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON sync_actions
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── dashboard_roles (RBAC) ──────────────────────────────────
-- Dashboard team roles with permission arrays
CREATE TABLE IF NOT EXISTS dashboard_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  permissions JSONB NOT NULL DEFAULT '[]',
  is_system   BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (guild_id, name)
);

ALTER TABLE dashboard_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON dashboard_roles
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── dashboard_user_roles (RBAC) ─────────────────────────────
-- Maps dashboard users to their roles
CREATE TABLE IF NOT EXISTS dashboard_user_roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id   TEXT NOT NULL,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    UUID NOT NULL REFERENCES dashboard_roles(id) ON DELETE CASCADE,
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (guild_id, user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_user_roles_user ON dashboard_user_roles (user_id, guild_id);

ALTER TABLE dashboard_user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON dashboard_user_roles
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── fraud_signals ───────────────────────────────────────────
-- Individual fraud detection signals from bot-side checks
CREATE TABLE IF NOT EXISTS fraud_signals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    TEXT NOT NULL,
  order_id    UUID REFERENCES orders(id),
  customer_id UUID REFERENCES customers(id),
  discord_id  TEXT,
  signal_type TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'medium',
  details     JSONB,
  action      TEXT NOT NULL DEFAULT 'flag',
  resolved    BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fraud_signals_guild ON fraud_signals (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_order ON fraud_signals (order_id);

ALTER TABLE fraud_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON fraud_signals
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── fraud_rules ─────────────────────────────────────────────
-- Configurable fraud detection rules
CREATE TABLE IF NOT EXISTS fraud_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  rule_type   TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}',
  action      TEXT NOT NULL DEFAULT 'flag',
  enabled     BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE fraud_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON fraud_rules
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── incidents ───────────────────────────────────────────────
-- Incident management with lifecycle (open → investigating → resolved → closed)
CREATE TABLE IF NOT EXISTS incidents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  severity     TEXT NOT NULL DEFAULT 'medium',
  category     TEXT NOT NULL DEFAULT 'general',
  status       TEXT NOT NULL DEFAULT 'open',
  assigned_to  TEXT,
  created_by   TEXT NOT NULL,
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT,
  resolution   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incidents_guild ON incidents (guild_id, status, created_at DESC);

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON incidents
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── incident_events ─────────────────────────────────────────
-- Timeline events within an incident
CREATE TABLE IF NOT EXISTS incident_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  details     JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events (incident_id, created_at);

ALTER TABLE incident_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON incident_events
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── dead_letter_queue ───────────────────────────────────────
-- Failed actions/events that exhausted retries
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id        TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  source_id       UUID,
  action_type     TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  error           TEXT,
  failure_count   INTEGER NOT NULL DEFAULT 1,
  first_failed_at TIMESTAMPTZ DEFAULT now(),
  last_failed_at  TIMESTAMPTZ DEFAULT now(),
  reprocessed     BOOLEAN DEFAULT false,
  reprocessed_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_guild ON dead_letter_queue (guild_id, reprocessed, created_at DESC);

ALTER TABLE dead_letter_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON dead_letter_queue
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── admin_changes ───────────────────────────────────────────
-- Admin change tracking with undo capability
CREATE TABLE IF NOT EXISTS admin_changes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id      TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  change_type   TEXT NOT NULL,
  target_table  TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  before_state  JSONB,
  after_state   JSONB,
  description   TEXT,
  undone        BOOLEAN DEFAULT false,
  undone_at     TIMESTAMPTZ,
  undone_by     TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_changes_guild ON admin_changes (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_changes_target ON admin_changes (target_table, target_id);

ALTER TABLE admin_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON admin_changes
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── alerts ──────────────────────────────────────────────────
-- System alerts from the AlertManager
CREATE TABLE IF NOT EXISTS alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    TEXT NOT NULL,
  alert_type  TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warning',
  title       TEXT NOT NULL,
  message     TEXT,
  details     JSONB,
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  auto_resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_guild ON alerts (guild_id, acknowledged, created_at DESC);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON alerts
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── portal_sessions ─────────────────────────────────────────
-- Customer portal auth sessions (Discord OAuth → session token)
CREATE TABLE IF NOT EXISTS portal_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id     TEXT NOT NULL,
  customer_id  UUID REFERENCES customers(id) ON DELETE CASCADE,
  discord_id   TEXT NOT NULL,
  session_token TEXT NOT NULL UNIQUE,
  ip_address   TEXT,
  user_agent   TEXT,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_token ON portal_sessions (session_token);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_customer ON portal_sessions (customer_id);

ALTER TABLE portal_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON portal_sessions
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── workflow_events ─────────────────────────────────────────
-- Workflow/automation execution event log for observability
CREATE TABLE IF NOT EXISTS workflow_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id        TEXT NOT NULL,
  automation_id   UUID REFERENCES automations(id) ON DELETE SET NULL,
  execution_id    UUID REFERENCES automation_executions(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  step_name       TEXT,
  input_data      JSONB,
  output_data     JSONB,
  error           TEXT,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_guild ON workflow_events (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_events_execution ON workflow_events (execution_id);

ALTER TABLE workflow_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON workflow_events
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── message_reports ─────────────────────────────────────────
-- Reports submitted via "Report Message" context menu
CREATE TABLE IF NOT EXISTS message_reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id       TEXT NOT NULL,
  reporter_id    TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  message_id     TEXT NOT NULL,
  message_author TEXT NOT NULL,
  reason         TEXT NOT NULL,
  message_content TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_reports_guild ON message_reports (guild_id, status, created_at DESC);

ALTER TABLE message_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON message_reports
  FOR ALL USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true));

-- ── Fix: product-files typo in downloads route ──────────────
-- The code at /api/downloads/[productId]/[fileId] queries 'product-files'
-- but the actual table is 'product_files'. Create a VIEW as an alias
-- so both names work:
CREATE OR REPLACE VIEW "product-files" AS SELECT * FROM product_files;

-- ============================================================
-- Seed default RBAC roles if dashboard_roles is empty
-- ============================================================
INSERT INTO dashboard_roles (guild_id, name, description, permissions, is_system)
SELECT 
  g.id,
  r.name,
  r.description,
  r.permissions::jsonb,
  true
FROM guild g
CROSS JOIN (VALUES
  ('Owner', 'Full access to all dashboard features', '["dashboard.full_access"]'),
  ('Admin', 'Manage most features except team and security', '["dashboard.view_analytics","dashboard.manage_store","dashboard.manage_products","dashboard.manage_orders","dashboard.manage_customers","dashboard.manage_licenses","dashboard.manage_moderation","dashboard.manage_tickets","dashboard.manage_automations","dashboard.manage_server","dashboard.view_audit","dashboard.view_diagnostics","dashboard.manage_incidents","dashboard.view_fraud","dashboard.manage_fraud","dashboard.view_workflows","dashboard.manage_workflows"]'),
  ('Moderator', 'View analytics and manage moderation/tickets', '["dashboard.view_analytics","dashboard.manage_moderation","dashboard.manage_tickets","dashboard.view_audit"]'),
  ('Viewer', 'Read-only access to analytics and diagnostics', '["dashboard.view_analytics","dashboard.view_audit","dashboard.view_diagnostics"]'),
  ('Support', 'Manage customers, orders, and tickets', '["dashboard.manage_customers","dashboard.manage_orders","dashboard.manage_tickets","dashboard.view_analytics"]')
) AS r(name, description, permissions)
WHERE NOT EXISTS (SELECT 1 FROM dashboard_roles WHERE dashboard_roles.guild_id = g.id);
