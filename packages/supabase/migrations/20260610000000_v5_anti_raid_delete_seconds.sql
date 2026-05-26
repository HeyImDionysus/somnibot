-- V5 Audit — Add configurable message deletion for anti-raid bans.
--
-- When the anti-raid system bans a raider, Discord can retroactively
-- delete their messages. Previously hardcoded to 0 (no deletion).
-- Default: 86400 seconds (1 day) to auto-purge raid spam.

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS anti_raid_ban_delete_seconds INT NOT NULL DEFAULT 86400;

-- Constrain to Discord's allowed range (0–604800 = 0–7 days)
ALTER TABLE guild_config
  ADD CONSTRAINT chk_anti_raid_ban_delete_seconds
  CHECK (anti_raid_ban_delete_seconds >= 0 AND anti_raid_ban_delete_seconds <= 604800);
