-- Durable idempotency fences for Discord side effects whose delivery may be
-- replayed or whose process may crash between Discord and Postgres.
CREATE TABLE IF NOT EXISTS discord_operation_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  operation_kind TEXT NOT NULL CHECK (
    operation_kind IN ('scheduled_message', 'temp_channel', 'ticket')
  ),
  occurrence_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (
    status IN ('claimed', 'completed', 'failed')
  ),
  resource_id TEXT,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operation_kind, occurrence_key)
);

CREATE INDEX IF NOT EXISTS idx_discord_operation_occurrences_guild
  ON discord_operation_occurrences(guild_id, operation_kind, claimed_at DESC);

ALTER TABLE discord_operation_occurrences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_full_access" ON discord_operation_occurrences;
CREATE POLICY "owner_full_access" ON discord_operation_occurrences
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid() AND users.is_owner = true
    )
  );

CREATE TRIGGER update_discord_operation_occurrences_updated_at
  BEFORE UPDATE ON discord_operation_occurrences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE active_temp_channels
  ADD COLUMN IF NOT EXISTS creation_occurrence_id UUID
    REFERENCES discord_operation_occurrences(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_temp_channels_creation_occurrence
  ON active_temp_channels(creation_occurrence_id)
  WHERE creation_occurrence_id IS NOT NULL;

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS creation_occurrence_id UUID
    REFERENCES discord_operation_occurrences(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_creation_occurrence
  ON tickets(creation_occurrence_id)
  WHERE creation_occurrence_id IS NOT NULL;

REVOKE ALL ON TABLE discord_operation_occurrences FROM anon, authenticated;
GRANT ALL ON TABLE discord_operation_occurrences TO service_role;
