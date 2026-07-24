-- Scheduled message delivery-failure state.
--
-- The runner's sendMessage() previously only log.warn()'d when the target
-- channel was missing/non-text: no failed state, no owner alert, no way to stop
-- the schedule re-evaluating and re-warning every minute forever. There was no
-- column to record a terminal failure. Add status/last_error/failed_at so a
-- delivery failure can be marked, surfaced to the owner (alerts row), and stop
-- re-firing until the owner repairs the schedule.

ALTER TABLE public.scheduled_messages
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'failed')),
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz;
