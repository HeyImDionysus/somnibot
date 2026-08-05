-- Align the persisted diagnostics controls with the administration-diagnostics
-- catalog contract. Existing defaults remain unchanged; legacy values outside
-- the new owner-facing range are normalized before the CHECKs are tightened.
BEGIN;

UPDATE public.guild_config
SET memory_alert_threshold_mb = LEAST(GREATEST(memory_alert_threshold_mb, 128), 8192),
    diagnostics_snapshot_interval_ms = LEAST(GREATEST(diagnostics_snapshot_interval_ms, 15000), 600000)
WHERE memory_alert_threshold_mb NOT BETWEEN 128 AND 8192
   OR diagnostics_snapshot_interval_ms NOT BETWEEN 15000 AND 600000;

ALTER TABLE public.guild_config
  DROP CONSTRAINT IF EXISTS guild_config_memory_alert_threshold_mb_check,
  DROP CONSTRAINT IF EXISTS guild_config_diagnostics_snapshot_interval_check;

ALTER TABLE public.guild_config
  ADD CONSTRAINT guild_config_memory_alert_threshold_mb_check
    CHECK (memory_alert_threshold_mb BETWEEN 128 AND 8192),
  ADD CONSTRAINT guild_config_diagnostics_snapshot_interval_check
    CHECK (diagnostics_snapshot_interval_ms BETWEEN 15000 AND 600000);

COMMENT ON COLUMN public.guild_config.memory_alert_threshold_mb IS
  'RSS in MB above which AlertManager raises memory_high. Owner range 128-8192; default 512.';
COMMENT ON COLUMN public.guild_config.diagnostics_snapshot_interval_ms IS
  'Health snapshot cadence in milliseconds. Owner range 15000-600000; default 60000.';

COMMIT;
