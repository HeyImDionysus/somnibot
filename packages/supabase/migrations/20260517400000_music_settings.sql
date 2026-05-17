-- Phase 11: Music System settings
-- guild_config already has default_volume, max_queue_length, allow_duplicates, dj_role_id
-- Add music_enabled flag for the dashboard toggle

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS music_enabled BOOLEAN NOT NULL DEFAULT true;
