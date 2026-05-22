-- V53 Phase 2 — Observability & Reliability
-- Adds: alert_channel_id to guild_config, action_queue_dlq table,
-- health_metrics table for sparkline trends.

-- ── 2.2: Alert channel for automation failure alerts ────────
ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS alert_channel_id TEXT;

COMMENT ON COLUMN guild_config.alert_channel_id IS
  'Discord channel ID where bot alerts (automation failures, DLQ, etc.) are posted';

-- ── 2.3: Dead Letter Queue table ────────────────────────────
CREATE TABLE IF NOT EXISTS action_queue_dlq (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id        TEXT NOT NULL REFERENCES guild(id),
  action          TEXT NOT NULL,
  payload         JSONB DEFAULT '{}',
  error_message   TEXT,
  retry_count     INTEGER DEFAULT 0,
  max_retries     INTEGER DEFAULT 5,
  original_id     TEXT,                    -- reference to the original bot_action_queue row
  failed_at       TIMESTAMPTZ DEFAULT now(),
  acknowledged    BOOLEAN DEFAULT false,
  acknowledged_at TIMESTAMPTZ,
  retried         BOOLEAN DEFAULT false,
  retried_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE action_queue_dlq ENABLE ROW LEVEL SECURITY;

CREATE POLICY "guild_owner_access" ON action_queue_dlq
  FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_action_queue_dlq_guild
  ON action_queue_dlq (guild_id, acknowledged, retried);

-- ── 2.4: Health metrics time-series for sparklines ──────────
CREATE TABLE IF NOT EXISTS health_metrics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    TEXT NOT NULL REFERENCES guild(id),
  metric_type TEXT NOT NULL,             -- 'db_latency', 'valkey_latency', 'ws_ping', 'cmd_p95'
  value_ms    NUMERIC(10,2) NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE health_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "guild_owner_access" ON health_metrics
  FOR ALL USING (true) WITH CHECK (true);

-- Partition-friendly index for time-range queries
CREATE INDEX IF NOT EXISTS idx_health_metrics_guild_type_time
  ON health_metrics (guild_id, metric_type, recorded_at DESC);

-- Auto-cleanup: keep only 24h of metrics
-- (Bot should call this periodically, or use pg_cron if available)
CREATE OR REPLACE FUNCTION cleanup_old_health_metrics()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  DELETE FROM health_metrics
  WHERE recorded_at < now() - INTERVAL '24 hours';
$$;
