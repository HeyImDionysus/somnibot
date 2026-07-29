-- Add the replacement invariant without scanning historical rows while holding
-- an ACCESS EXCLUSIVE lock. NOT VALID still protects writes that occur after
-- this point; the next migration performs the weaker-lock validation scan.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.fraud_signals'::pg_catalog.regclass
       AND conname = 'fraud_signals_last_observed_at_not_null'
  ) THEN
    ALTER TABLE public.fraud_signals
      ADD CONSTRAINT fraud_signals_last_observed_at_not_null
      CHECK (last_observed_at IS NOT NULL) NOT VALID;
  END IF;
END
$$;
