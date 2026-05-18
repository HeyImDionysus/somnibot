-- ============================================================
-- Alerts Table — Phase C: Real diagnostics & alerting
-- Stores threshold-based alerts from bot diagnostics.
-- ============================================================

CREATE TABLE IF NOT EXISTS alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    TEXT NOT NULL REFERENCES guild(id),
  alert_type  TEXT NOT NULL,           -- 'memory_high', 'bot_offline', 'lavalink_down', 'valkey_disconnected', 'webhook_errors', 'disk_pressure'
  severity    TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  title       TEXT NOT NULL,
  message     TEXT,
  metadata    JSONB DEFAULT '{}',
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ,
  resolved    BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

-- Owner/service role access only
CREATE POLICY "service_role_full_access" ON alerts
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_alerts_guild ON alerts(guild_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(guild_id, resolved) WHERE resolved = false;

-- ============================================================
-- Audit Logs — add before_state/after_state & correlation_id
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_logs' AND column_name = 'before_state'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN before_state JSONB;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_logs' AND column_name = 'after_state'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN after_state JSONB;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_logs' AND column_name = 'correlation_id'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN correlation_id TEXT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_logs(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);

COMMENT ON TABLE alerts IS 'Threshold-based alerts from bot diagnostics for the operations dashboard.';
