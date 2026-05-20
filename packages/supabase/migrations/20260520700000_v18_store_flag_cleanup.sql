-- V18 Audit: Drop stale guild_config columns from music_settings migration
-- =========================================================================
-- The 20260517400000_music_settings.sql migration added default_volume,
-- max_queue_length, and allow_duplicates to guild_config. These duplicate
-- the existing music_default_volume column and are never used by any code
-- (V12 audit confirmed all code uses music_default_volume). Drop them to
-- prevent confusion.

ALTER TABLE guild_config DROP COLUMN IF EXISTS default_volume;
ALTER TABLE guild_config DROP COLUMN IF EXISTS max_queue_length;
ALTER TABLE guild_config DROP COLUMN IF EXISTS allow_duplicates;
