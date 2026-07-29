-- Validate with SHARE UPDATE EXCLUSIVE, then use the proven CHECK to make the
-- column physically NOT NULL without another full-table scan. Only the brief
-- final metadata swap needs ACCESS EXCLUSIVE.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.fraud_signals'::pg_catalog.regclass
       AND conname = 'fraud_signals_last_observed_at_not_null'
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.fraud_signals
      VALIDATE CONSTRAINT fraud_signals_last_observed_at_not_null;
  END IF;
END
$$;

ALTER TABLE public.fraud_signals
  ALTER COLUMN last_observed_at SET NOT NULL;

ALTER TABLE public.fraud_signals
  DROP CONSTRAINT IF EXISTS fraud_signals_last_observed_at_not_null;
