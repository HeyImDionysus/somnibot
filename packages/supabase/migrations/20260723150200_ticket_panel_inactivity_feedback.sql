-- =============================================================================
-- Ticket-panel inactivity + feedback controls.
--
-- The catalog contracts three ticket_panels controls: inactivity-warn-hours
-- (default 24), inactivity-close-hours (default 48), feedback-prompt-enabled
-- (default true). None were schema-backed, so checkInactiveTickets could only
-- use its 24h/48h call-site defaults (invoked with no options) and closeTicket
-- always posted the 5-star feedback prompt — owner customization was silently
-- ignored.
--
-- Add the columns with the catalog defaults; the bot now resolves each open
-- ticket's panel to drive warn/close timing and gates the feedback prompt.
-- =============================================================================

ALTER TABLE public.ticket_panels
  ADD COLUMN IF NOT EXISTS inactivity_warn_hours integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS inactivity_close_hours integer NOT NULL DEFAULT 48,
  ADD COLUMN IF NOT EXISTS feedback_prompt_enabled boolean NOT NULL DEFAULT true;
