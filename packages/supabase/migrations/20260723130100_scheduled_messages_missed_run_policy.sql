-- Scheduled message missed-run policy.
--
-- The catalog (community.json missed-run-policy) contracts a configurable
-- behaviour for occurrences that were due while the stack was down: either drop
-- them with a single owner notice (skip-missed), or send the single most recent
-- missed occurrence on recovery (send-latest). It was completely inert — no
-- storage column and no runner wiring, so any occurrence due during downtime was
-- silently skipped. Add the column with the catalog default (skip-missed).

ALTER TABLE public.scheduled_messages
  ADD COLUMN IF NOT EXISTS missed_run_policy text NOT NULL DEFAULT 'skip-missed'
    CHECK (missed_run_policy IN ('skip-missed', 'send-latest'));
