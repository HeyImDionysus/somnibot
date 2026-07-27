-- =============================================================================
-- Durable anti-raid state.
--
-- Raid mode lives only in Valkey with a 5-minute PX expiry (and an in-memory
-- fallback when Valkey is down). Both die with the process. If the bot
-- restarts mid-raid — which is exactly when an operator is most likely to
-- restart it — everything is lost at once:
--
--   * raid mode switches off, so joins stop being contained;
--   * the lockdown restore loses its driver, leaving the server pinned at
--     "Very High" verification with its invites paused and nothing scheduled
--     to undo either;
--   * the auto-unban queue loses its driver, so members banned during the
--     raid are never unbanned.
--
-- This table is the durable record the resume path reads at boot. Valkey stays
-- the hot path — it is checked on every join — and this is written alongside
-- it, so a restart can rebuild the state rather than silently dropping it.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.anti_raid_state (
  guild_id             text        PRIMARY KEY,
  activated_at         timestamptz NOT NULL DEFAULT now(),
  -- Join count that tripped the threshold, for the resume notice and audit.
  trigger_joins        integer     NOT NULL DEFAULT 0,
  -- When raid mode lapses. The resume path treats an elapsed row as over and
  -- runs the normal deactivation (unban sweep + lockdown restore) rather than
  -- re-entering raid mode for a raid that already ended.
  expires_at           timestamptz NOT NULL,
  -- Verification level to restore, and the invites paused, when lockdown ends.
  -- NULL previous_verification_level means lockdown was not engaged.
  previous_verification_level integer,
  lockdown_channel_ids jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.anti_raid_state IS
  'Durable mirror of active raid mode so a bot restart mid-raid can resume '
  'containment, restore verification level, and still run the auto-unban sweep. '
  'Valkey remains the hot path; this is the recovery record.';

-- The resume path scans for rows that are still live at boot.
CREATE INDEX IF NOT EXISTS idx_anti_raid_state_expires
  ON public.anti_raid_state (expires_at);

ALTER TABLE public.anti_raid_state ENABLE ROW LEVEL SECURITY;

-- Bot-only: the dashboard reads raid status through its own surfaces, and
-- nothing outside the service role has any reason to write containment state.
DROP POLICY IF EXISTS anti_raid_state_service_role ON public.anti_raid_state;
CREATE POLICY anti_raid_state_service_role ON public.anti_raid_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.anti_raid_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.anti_raid_state TO service_role;

COMMIT;
