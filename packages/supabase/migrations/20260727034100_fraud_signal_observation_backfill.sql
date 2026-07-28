-- Backfill legacy detector observations in a transaction separate from the
-- metadata lock that introduced the column.
--
-- `created_at` is nullable in the oldest authoritative fraud_signals shape.
-- Never fall back to generic `updated_at` (operator annotations change it) or
-- migration time (which would make an unknown old signal look newly observed).
-- Epoch is deliberately conservative: a timestamp-less legacy row remains old
-- until a detector observes it again through fraud_upsert_open_signal.

UPDATE public.fraud_signals
   SET last_observed_at = COALESCE(
     created_at,
     '1970-01-01 00:00:00+00'::TIMESTAMPTZ
   )
 WHERE last_observed_at IS NULL;
