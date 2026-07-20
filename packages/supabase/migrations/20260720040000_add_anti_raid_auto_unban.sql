-- =============================================================================
-- Add the missing anti_raid_auto_unban column to guild_config.
--
-- The anti-raid join handler (packages/bot/src/features/anti-raid/index.ts)
-- treats anti_raid_auto_unban as a real, owner-configurable toggle: loadConfig
-- SELECTs it and processAntiRaid gates the post-raid auto-unban on it. But no
-- migration ever added the column, so the SELECT hit 42703 (undefined column),
-- PostgREST rejected the WHOLE query, loadConfig swallowed the error, data was
-- null, and EVERY anti-raid setting silently fell back to its default —
-- anti_raid_enabled=false included — so no guild's raid protection ran with its
-- saved config. Surfaced by the moderation-anti-raid domain proof.
--
-- Add the column so the config read succeeds and the toggle is honored. Default
-- true preserves the prior intended behavior (auto-unban on) for existing guilds.
-- =============================================================================

BEGIN;

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS anti_raid_auto_unban BOOLEAN NOT NULL DEFAULT true;

COMMIT;
