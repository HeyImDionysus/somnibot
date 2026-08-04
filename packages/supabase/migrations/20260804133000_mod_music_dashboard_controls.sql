-- Owner-facing moderation and music controls that were previously either
-- missing from guild_config or hardcoded in the bot/dashboard.
BEGIN;

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS anti_raid_containment_ladder jsonb NOT NULL
    DEFAULT '[{"stage":1,"action":"kick"},{"stage":2,"action":"lockdown"}]'::jsonb,
  ADD COLUMN IF NOT EXISTS anti_raid_raid_cooldown_minutes integer NOT NULL DEFAULT 5
    CHECK (anti_raid_raid_cooldown_minutes BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS appeals_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS appeal_cooldown_hours integer NOT NULL DEFAULT 24
    CHECK (appeal_cooldown_hours BETWEEN 1 AND 168),
  ADD COLUMN IF NOT EXISTS appeal_review_channel_id text,
  ADD COLUMN IF NOT EXISTS dm_on_action boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS message_log_config_cache_ttl_ms integer NOT NULL DEFAULT 60000
    CHECK (message_log_config_cache_ttl_ms BETWEEN 0 AND 3600000),
  ADD COLUMN IF NOT EXISTS data_export_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_queue_length integer NOT NULL DEFAULT 5000
    CHECK (max_queue_length BETWEEN 1 AND 5000),
  ADD COLUMN IF NOT EXISTS allow_duplicates boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS per_user_queue_cap integer NOT NULL DEFAULT 50
    CHECK (per_user_queue_cap BETWEEN 1 AND 500);

COMMENT ON COLUMN public.guild_config.anti_raid_containment_ladder IS
  'Ordered [{stage, action, ban-delete-seconds?}] containment stages; stage 1 is the first response.';
COMMENT ON COLUMN public.guild_config.message_log_config_cache_ttl_ms IS
  'Per-guild message-log configuration cache TTL. Zero disables caching.';
COMMENT ON COLUMN public.guild_config.data_export_enabled IS
  'Whether member data export is enabled for the guild privacy surface.';

COMMIT;
