-- Supabase CLI >= 2.110 flushes its transaction batch before
-- CREATE INDEX CONCURRENTLY, runs that statement alone, then resumes a
-- transaction for the remaining statements and migration-history insert.
--
-- A canceled concurrent build leaves its catalog row behind with
-- pg_index.indisvalid = false. CREATE INDEX ... IF NOT EXISTS alone would skip
-- that unusable relation and let the retry record this migration as applied.
-- Remove only that invalid artifact before retrying. An already-valid index is
-- left untouched if and only if its complete definition is the expected one.

DO $fraud_index_recovery$
DECLARE
  target_index_oid OID := pg_catalog.to_regclass(
    'public.idx_fraud_signals_critical_observation'
  );
  target_index_valid BOOLEAN;
  target_index_on_expected_table BOOLEAN;
  target_index_matches BOOLEAN;
BEGIN
  IF target_index_oid IS NOT NULL THEN
    SELECT
      i.indisvalid,
      i.indrelid = 'public.fraud_signals'::pg_catalog.regclass,
      COALESCE(
        i.indisready
        AND i.indislive
        AND NOT i.indisunique
        AND i.indrelid = 'public.fraud_signals'::pg_catalog.regclass
        AND access_method.amname = 'btree'
        AND i.indnkeyatts = 2
        AND i.indnatts = 2
        AND i.indexprs IS NULL
        AND pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'guild_id'
        AND pg_catalog.pg_get_indexdef(i.indexrelid, 2, true) =
          'last_observed_at'
        -- btree indoption bits: guild_id ASC NULLS LAST (0),
        -- last_observed_at DESC NULLS FIRST (3).
        AND i.indoption::TEXT = '0 3'
        AND pg_catalog.lower(
          pg_catalog.regexp_replace(
            pg_catalog.pg_get_expr(i.indpred, i.indrelid, true),
            '[[:space:]()]',
            '',
            'g'
          )
        ) IN (
          'status=''open''::textandseverity=''critical''::text',
          'severity=''critical''::textandstatus=''open''::text'
        ),
        false
      )
      INTO
        target_index_valid,
        target_index_on_expected_table,
        target_index_matches
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class index_relation
        ON index_relation.oid = i.indexrelid
      JOIN pg_catalog.pg_am access_method
        ON access_method.oid = index_relation.relam
     WHERE i.indexrelid = target_index_oid;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'public.idx_fraud_signals_critical_observation exists but is not an index'
        USING ERRCODE = '55000';
    ELSIF NOT target_index_on_expected_table THEN
      RAISE EXCEPTION
        'public.idx_fraud_signals_critical_observation belongs to an unexpected table'
        USING ERRCODE = '55000';
    ELSIF target_index_valid THEN
      IF NOT target_index_matches THEN
        RAISE EXCEPTION
          'valid public.idx_fraud_signals_critical_observation has an unexpected definition'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      -- DROP INDEX CONCURRENTLY is also forbidden inside a transaction but is
      -- not a Supabase CLI 2.110 pipeline-incompatible statement. A normal
      -- drop of this unusable index is legal here; fail quickly rather than
      -- waiting on a busy table.
      PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
      EXECUTE
        'DROP INDEX public.idx_fraud_signals_critical_observation';
    END IF;
  END IF;
END
$fraud_index_recovery$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fraud_signals_critical_observation
  ON public.fraud_signals (guild_id, last_observed_at DESC)
  WHERE status = 'open' AND severity = 'critical';

-- IF NOT EXISTS is safe only behind the preflight above and this postflight.
-- Supabase records the migration after this transaction commits, so a missing,
-- invalid, or wrong-definition index fails closed and remains retryable.
DO $fraud_index_postflight$
DECLARE
  target_index_ready BOOLEAN;
BEGIN
  SELECT COALESCE(
    i.indisvalid
    AND i.indisready
    AND i.indislive
    AND NOT i.indisunique
    AND i.indrelid = 'public.fraud_signals'::pg_catalog.regclass
    AND access_method.amname = 'btree'
    AND i.indnkeyatts = 2
    AND i.indnatts = 2
    AND i.indexprs IS NULL
    AND pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'guild_id'
    AND pg_catalog.pg_get_indexdef(i.indexrelid, 2, true) =
      'last_observed_at'
    AND i.indoption::TEXT = '0 3'
    AND pg_catalog.lower(
      pg_catalog.regexp_replace(
        pg_catalog.pg_get_expr(i.indpred, i.indrelid, true),
        '[[:space:]()]',
        '',
        'g'
      )
    ) IN (
      'status=''open''::textandseverity=''critical''::text',
      'severity=''critical''::textandstatus=''open''::text'
    ),
    false
  )
    INTO target_index_ready
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class index_relation
      ON index_relation.oid = i.indexrelid
    JOIN pg_catalog.pg_am access_method
      ON access_method.oid = index_relation.relam
   WHERE i.indexrelid = pg_catalog.to_regclass(
     'public.idx_fraud_signals_critical_observation'
   );

  IF NOT COALESCE(target_index_ready, false) THEN
    RAISE EXCEPTION
      'public.idx_fraud_signals_critical_observation is missing, invalid, or has an unexpected definition'
      USING ERRCODE = '55000';
  END IF;
END
$fraud_index_postflight$;
