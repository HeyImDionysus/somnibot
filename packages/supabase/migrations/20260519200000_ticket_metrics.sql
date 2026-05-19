-- Ticket resolution metrics table.
-- CrossFeatureBridge records resolution time when tickets close.
-- Used for support analytics (avg resolution time, trends, etc).

CREATE TABLE IF NOT EXISTS ticket_metrics (
  ticket_id UUID PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guild(id),
  resolution_time_ms BIGINT NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_metrics_guild
  ON ticket_metrics (guild_id, resolved_at DESC);

-- RLS: only authenticated guild owner can read metrics
ALTER TABLE ticket_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_full_access" ON ticket_metrics
  FOR ALL USING (
    guild_id IN (
      SELECT id FROM guild WHERE owner_discord_id = (
        SELECT raw_user_meta_data->>'provider_id'
        FROM auth.users
        WHERE id = auth.uid()
      )
    )
  );
