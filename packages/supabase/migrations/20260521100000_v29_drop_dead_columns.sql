-- V29: Drop dead guild_config columns
-- stats_category_id: never read by bot or dashboard; per-channel stat_config.category_id is used instead
-- store_channel_id: never read by bot; dashboard has Zod + type entry but no UI or functionality
ALTER TABLE guild_config DROP COLUMN IF EXISTS stats_category_id;
ALTER TABLE guild_config DROP COLUMN IF EXISTS store_channel_id;
