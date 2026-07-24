-- =============================================================================
-- Fix: fraud notifications ignore severity + the owner-dm-on-critical toggle,
-- and there is no staff-channel mirror.
--
-- The catalog commerce-fraud contracts fraud alerts "mirrored to the configured
-- staff channel" and "critical signals DM the owner directly", with controls
-- staff-alert-channel (default empty) and owner-dm-on-critical (default true).
-- Both controls had NO storage, so the bot's owner-notifications fraud.detected
-- handler DM'd the owner for EVERY signal (no severity check, no toggle) and
-- there was no staff mirror. Add per-guild storage so the bot can honor them.
-- =============================================================================

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS fraud_owner_dm_on_critical boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS fraud_staff_alert_channel_id text;

COMMENT ON COLUMN public.guild_config.fraud_owner_dm_on_critical IS
  'commerce-fraud control owner-dm-on-critical: DM the owner on critical fraud signals (default true).';
COMMENT ON COLUMN public.guild_config.fraud_staff_alert_channel_id IS
  'commerce-fraud control staff-alert-channel: Discord channel id that mirrors fraud alerts; NULL/empty keeps alerts on dashboard + owner DM only.';
