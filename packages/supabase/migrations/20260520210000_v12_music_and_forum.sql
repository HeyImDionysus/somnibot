-- V12 audit fixes: add missing columns
-- ============================================================

-- 1. ticket_panels: add forum_config column
-- ForumTicketService reads ticket_panels.forum_config but the column
-- was never created.  Without it, forum tickets can never be configured.
ALTER TABLE ticket_panels
  ADD COLUMN IF NOT EXISTS forum_config JSONB;

-- 2. bot_diagnostics: ensure snapshot_at is NOT NULL with a default
-- (no-op if already correct, but guards against older versions)
-- Already has snapshot_at from V11 migration.  Nothing else needed.
