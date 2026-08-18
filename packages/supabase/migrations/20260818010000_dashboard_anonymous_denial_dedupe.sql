BEGIN;

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS unscoped_occurrence_key TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.audit_logs
    WHERE unscoped_occurrence_key IS NOT NULL
    GROUP BY unscoped_occurrence_key
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot add unscoped audit occurrence dedupe: duplicate keys exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_logs_unscoped_occurrence
  ON public.audit_logs (unscoped_occurrence_key);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.audit_logs'::regclass
      AND conname = 'audit_logs_unscoped_occurrence_requires_null_guild'
  ) THEN
    ALTER TABLE public.audit_logs
      ADD CONSTRAINT audit_logs_unscoped_occurrence_requires_null_guild
      CHECK (unscoped_occurrence_key IS NULL OR guild_id IS NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.audit_logs
  VALIDATE CONSTRAINT audit_logs_unscoped_occurrence_requires_null_guild;

COMMIT;
