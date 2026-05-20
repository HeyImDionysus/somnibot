-- V11 Audit: Fix bot_diagnostics, tickets, and automod_rules schema gaps
-- =====================================================================

-- ── C1+C2: bot_diagnostics needs `type` and `data` columns ──────────
-- DiagnosticsService writes `type: 'health'` and uses onConflict: 'guild_id,type'.
-- MusicStatusReporter writes `type: 'music_status'` with a `data` JSONB payload.
-- The table only has guild_id as PK with no `type` or `data` column, so both
-- services silently fail → dashboard always shows bot offline.

-- Step 1: Drop the old single-column PK
ALTER TABLE bot_diagnostics DROP CONSTRAINT bot_diagnostics_pkey;

-- Step 2: Add the missing columns
ALTER TABLE bot_diagnostics
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'health',
  ADD COLUMN IF NOT EXISTS data JSONB DEFAULT NULL;

-- Step 3: Re-create PK as composite (guild_id, type)
ALTER TABLE bot_diagnostics ADD PRIMARY KEY (guild_id, type);

-- ── C3: tickets table needs forum-ticket columns ─────────────────────
-- ForumTicketService.createForumTicket() inserts ticket_type, subject,
-- description, is_forum_ticket, forum_thread_id — none exist in schema.
-- Also uses `ticket_type` but schema column is `type`.
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS is_forum_ticket BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS forum_thread_id TEXT;

-- ── C4: automod_rules needs sync_to_discord column ───────────────────
-- AutoModSync queries .eq('sync_to_discord', true) but the column doesn't exist.
ALTER TABLE automod_rules
  ADD COLUMN IF NOT EXISTS sync_to_discord BOOLEAN DEFAULT false;
