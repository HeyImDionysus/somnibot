-- C3: version the Discord live-state contract and persist the bot's effective
-- guild permissions. Existing snapshots remain v1 until the bot refreshes
-- them; the dashboard must not mistake legacy JSON for verified live facts.
ALTER TABLE public.guild_live_state
  ADD COLUMN IF NOT EXISTS snapshot_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS bot_permissions TEXT;

ALTER TABLE public.guild_live_state
  DROP CONSTRAINT IF EXISTS guild_live_state_snapshot_version_check;

ALTER TABLE public.guild_live_state
  ADD CONSTRAINT guild_live_state_snapshot_version_check
  CHECK (snapshot_version >= 1);
