-- ============================================================
-- Phase 7: Ticket Number Sequence RPC + Transcripts table
-- ============================================================

-- RPC to get next ticket number from the sequence
CREATE OR REPLACE FUNCTION nextval_ticket()
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT nextval('ticket_number_seq'); $$;

CREATE TABLE IF NOT EXISTS ticket_transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
  ticket_number INTEGER NOT NULL,
  creator_id TEXT NOT NULL,
  closed_by_id TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  participant_ids TEXT[] DEFAULT '{}',
  html_content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_transcripts_guild ON ticket_transcripts(guild_id);
CREATE INDEX IF NOT EXISTS idx_ticket_transcripts_ticket ON ticket_transcripts(ticket_id);

ALTER TABLE ticket_transcripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_full_access" ON ticket_transcripts
  FOR ALL USING (true) WITH CHECK (true);
