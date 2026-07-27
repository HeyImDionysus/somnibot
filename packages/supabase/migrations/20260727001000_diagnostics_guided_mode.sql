-- =============================================================================
-- Diagnostics guided mode.
--
-- The Diagnostics page reports raw numbers: RSS in MB, gateway ping in ms,
-- snapshot staleness in seconds, dead-letter depth. Those are meaningful to
-- someone who already knows what "good" looks like. A non-technical owner
-- reading "RSS 612 MB" has no way to tell whether that is fine, and no idea
-- what to do if it is not.
--
-- Guided mode turns each metric into a plain-English line: what it means, the
-- healthy range, and the next step when it is outside that range. Defaults ON
-- because the owners who need it are exactly the ones who would never find a
-- setting to turn it on.
-- =============================================================================

BEGIN;

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS diagnostics_guided_mode boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.guild_config.diagnostics_guided_mode IS
  'When true, the Diagnostics page explains each metric in plain English alongside the raw value.';

COMMIT;
