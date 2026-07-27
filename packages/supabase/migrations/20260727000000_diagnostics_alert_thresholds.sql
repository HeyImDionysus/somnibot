-- =============================================================================
-- Owner-configurable diagnostics alert thresholds.
--
-- AlertManager decided "memory is high" / "the gateway is slow" / "webhooks are
-- failing" from three constants baked into the bot (512 MB, 500 ms, 25%).
-- Those are reasonable defaults and a bad fit for every server: a large guild
-- on a small VPS alerts constantly, and a tiny guild on a big box never alerts
-- at all. Neither owner could change them from anywhere.
--
-- These columns move the numbers into guild_config so the dashboard can set
-- them per guild. Defaults are EXACTLY the constants they replace, so an
-- untouched guild keeps its current alerting behavior.
--
-- The CHECK ranges are the same ones the dashboard's Zod schema mirrors — a
-- payload that passes validation can never die here as a raw 23514.
-- =============================================================================

BEGIN;

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS memory_alert_threshold_mb integer NOT NULL DEFAULT 512,
  ADD COLUMN IF NOT EXISTS ws_ping_alert_threshold_ms integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS webhook_error_rate_threshold numeric(4,3) NOT NULL DEFAULT 0.250;

-- Bounds chosen so a misconfiguration cannot silence alerting entirely or make
-- it fire on every tick: 64 MB is below any realistic bot footprint, 16 GB is
-- above any single-process ceiling; 50 ms is faster than a healthy gateway
-- round-trip, 10 s is well past unusable; the error rate is a plain fraction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_memory_alert_threshold_mb_check'
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_memory_alert_threshold_mb_check
      CHECK (memory_alert_threshold_mb BETWEEN 64 AND 16384);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_ws_ping_alert_threshold_ms_check'
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_ws_ping_alert_threshold_ms_check
      CHECK (ws_ping_alert_threshold_ms BETWEEN 50 AND 10000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_webhook_error_rate_threshold_check'
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_webhook_error_rate_threshold_check
      CHECK (webhook_error_rate_threshold >= 0 AND webhook_error_rate_threshold <= 1);
  END IF;
END $$;

COMMENT ON COLUMN public.guild_config.memory_alert_threshold_mb IS
  'RSS in MB above which AlertManager raises memory_high. Default 512.';
COMMENT ON COLUMN public.guild_config.ws_ping_alert_threshold_ms IS
  'Discord gateway ping in ms above which AlertManager raises ws_ping_high. Default 500.';
COMMENT ON COLUMN public.guild_config.webhook_error_rate_threshold IS
  'Webhook failure fraction (0-1) above which AlertManager alerts. Default 0.250.';

COMMIT;
