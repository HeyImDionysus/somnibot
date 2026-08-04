-- Automation definitions must be previewed before they can execute when the
-- guild safety control is enabled. The hash binds approval to exact content;
-- changing any trigger, condition, action, or scope invalidates it.
BEGIN;

ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS preview_hash text,
  ADD COLUMN IF NOT EXISTS previewed_at timestamptz;

COMMENT ON COLUMN public.automations.preview_hash IS
  'SHA-256 of the exact definition shown in the dashboard dry-run preview.';
COMMENT ON COLUMN public.automations.previewed_at IS
  'When the owner last acknowledged the exact preview_hash.';

COMMIT;
