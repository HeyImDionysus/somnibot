-- Phase 11: Music System settings
-- guild_config already has: dj_role_id, music_default_volume, music_auto_leave_minutes, music_auto_destroy_minutes
-- Add missing columns for dashboard controls

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS music_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS default_volume INTEGER NOT NULL DEFAULT 50;

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS max_queue_length INTEGER NOT NULL DEFAULT 500;

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS allow_duplicates BOOLEAN NOT NULL DEFAULT true;

-- Backfill default_volume from music_default_volume if it exists and was set
UPDATE guild_config
  SET default_volume = music_default_volume
  WHERE music_default_volume IS NOT NULL
    AND music_default_volume != 50;
