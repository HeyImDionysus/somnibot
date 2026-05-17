-- Phase 13: Operations & Admin
-- Adds bot_diagnostics table for health snapshots
-- Adds category + indexes to audit_logs
-- Extends webhook_events with replay support

-- ============================================================
-- Bot Diagnostics
-- ============================================================

CREATE TABLE IF NOT EXISTS bot_diagnostics (
  guild_id TEXT PRIMARY KEY REFERENCES guild(id),
  uptime_seconds INTEGER DEFAULT 0,
  memory_rss_mb NUMERIC(10,2) DEFAULT 0,
  memory_heap_mb NUMERIC(10,2) DEFAULT 0,
  lavalink_nodes JSONB DEFAULT '[]',
  valkey_connected BOOLEAN DEFAULT false,
  valkey_memory_mb NUMERIC(10,2) DEFAULT 0,
  guild_member_count INTEGER DEFAULT 0,
  active_voice_connections INTEGER DEFAULT 0,
  scheduled_message_count INTEGER DEFAULT 0,
  automation_count INTEGER DEFAULT 0,
  discord_ws_ping INTEGER DEFAULT -1,
  snapshot_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bot_diagnostics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_full_access" ON bot_diagnostics
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- Audit Logs — add category column for filtering
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_logs' AND column_name = 'category'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN category TEXT DEFAULT 'system';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_logs(category);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);

-- ============================================================
-- Webhook Events — add replay support columns
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'webhook_events' AND column_name = 'replayed_at'
  ) THEN
    ALTER TABLE webhook_events ADD COLUMN replayed_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'webhook_events' AND column_name = 'replay_count'
  ) THEN
    ALTER TABLE webhook_events ADD COLUMN replay_count INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'webhook_events' AND column_name = 'guild_id'
  ) THEN
    ALTER TABLE webhook_events ADD COLUMN guild_id TEXT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_webhook_type ON webhook_events(event_type);
CREATE INDEX IF NOT EXISTS idx_webhook_result ON webhook_events(result);
