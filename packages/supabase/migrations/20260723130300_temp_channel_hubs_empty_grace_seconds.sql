-- Temp channel empty-grace-seconds control.
--
-- The catalog (community.json empty-grace-seconds) measures the empty-room grace
-- in SECONDS with a default of 15. The implementation only stored
-- keep_alive_minutes (integer MINUTES), so the 15-second default was
-- unrepresentable (nearest is 0 = near-immediate, or 60s). Add a seconds-granular
-- column that becomes the driver. Existing hubs are backfilled from their current
-- keep_alive_minutes so their live grace does NOT change; new hubs default to the
-- catalog's 15 seconds. keep_alive_minutes is retained as a compatibility
-- fallback for any row not yet migrated by the bot's read path.

ALTER TABLE public.temp_channel_hubs
  ADD COLUMN IF NOT EXISTS empty_grace_seconds integer;

-- Clamp to the catalog's 0..3600s range: keep_alive_minutes can be as large as
-- 1440, whose *60 would exceed the CHECK bound added below.
UPDATE public.temp_channel_hubs
  SET empty_grace_seconds = LEAST(COALESCE(keep_alive_minutes, 1) * 60, 3600)
  WHERE empty_grace_seconds IS NULL;

ALTER TABLE public.temp_channel_hubs
  ALTER COLUMN empty_grace_seconds SET DEFAULT 15;

ALTER TABLE public.temp_channel_hubs
  ALTER COLUMN empty_grace_seconds SET NOT NULL;

ALTER TABLE public.temp_channel_hubs
  ADD CONSTRAINT temp_channel_hubs_empty_grace_seconds_check
    CHECK (empty_grace_seconds BETWEEN 0 AND 3600);
