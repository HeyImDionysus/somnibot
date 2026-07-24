-- =============================================================================
-- Message-log SET-B controls: log-edits-enabled / log-deletes-enabled /
-- ignored-channel-ids.
--
-- The catalog (moderation-b.json) contracts five message-log controls:
-- message-log-enabled, message-log-channel-id, log-edits-enabled (default true),
-- log-deletes-enabled (default true), ignored-channel-ids (default []). Only the
-- first two were schema-backed, so the SET-B "deletes-only + ignored channel"
-- configuration was unrepresentable and unhonored — the bot logged EVERY edit
-- and delete with the only exclusion being the log channel itself.
--
-- Add the three missing columns with the catalog defaults so the bot can gate on
-- them (see packages/bot/src/features/message-log/index.ts).
-- =============================================================================

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS message_log_edits_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS message_log_deletes_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS message_log_ignored_channel_ids text[] NOT NULL DEFAULT '{}'::text[];
