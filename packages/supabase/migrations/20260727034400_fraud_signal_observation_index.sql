-- Supabase CLI runs migrations in a transaction during reset and deploy.
-- Keep this index build transaction-compatible so the migration is accepted
-- by the CLI pipeline as well as by the in-process migration runner.
--
-- A canceled concurrent build leaves its catalog row behind with
-- pg_index.indisvalid = false. CREATE INDEX ... IF NOT EXISTS alone would skip
-- that unusable relation and let the retry record this migration as applied.
-- Remove only that invalid artifact before retrying. An already-valid index is
-- left untouched if and only if its complete definition is the expected one.

DO $fraud_index_recovery$
DECLARE
  target_index_oid OID;
  target_index_valid BOOLEAN;
  target_index_ready BOOLEAN;
  target_index_live BOOLEAN;
  target_index_on_expected_table BOOLEAN;
  target_index_definition_matches BOOLEAN;
BEGIN
  -- SHARE UPDATE EXCLUSIVE conflicts with another concurrent index build but
  -- not normal INSERT/UPDATE/DELETE traffic. Resolve the catalog row only
  -- after this bounded wait so an in-progress build cannot be mistaken for a
  -- canceled artifact and dropped after its builder finishes.
  PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
  LOCK TABLE public.fraud_signals IN SHARE UPDATE EXCLUSIVE MODE;

  target_index_oid := pg_catalog.to_regclass(
    'public.idx_fraud_signals_critical_observation'
  );

  IF target_index_oid IS NOT NULL THEN
    SELECT
      i.indisvalid,
      i.indisready,
      i.indislive,
      i.indrelid = 'public.fraud_signals'::pg_catalog.regclass,
      COALESCE(
        NOT i.indisunique
        AND NOT i.indisexclusion
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
        -- pg_get_indexdef(index, column) omits opclass and collation. Check
        -- their catalog vectors explicitly against each table column's
        -- default btree opclass and declared collation.
        AND i.indclass[0] = first_default_opclass.oid
        AND i.indclass[1] = second_default_opclass.oid
        AND i.indcollation[0] = first_key_column.attcollation
        AND i.indcollation[1] = second_key_column.attcollation
        -- Compare the exact deparsed tree. Whitespace inside a quoted literal
        -- is data and must never be normalized away.
        AND pg_catalog.pg_get_expr(i.indpred, i.indrelid, false) =
          '((status = ''open''::text) AND (severity = ''critical''::text))',
        false
      )
      INTO
        target_index_valid,
        target_index_ready,
        target_index_live,
        target_index_on_expected_table,
        target_index_definition_matches
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class index_relation
        ON index_relation.oid = i.indexrelid
      JOIN pg_catalog.pg_am access_method
        ON access_method.oid = index_relation.relam
      JOIN pg_catalog.pg_attribute first_key_column
        ON first_key_column.attrelid = i.indrelid
       AND first_key_column.attnum = i.indkey[0]
      JOIN pg_catalog.pg_attribute second_key_column
        ON second_key_column.attrelid = i.indrelid
       AND second_key_column.attnum = i.indkey[1]
      JOIN pg_catalog.pg_opclass first_default_opclass
        ON first_default_opclass.opcmethod = index_relation.relam
       AND first_default_opclass.opcintype = first_key_column.atttypid
       AND first_default_opclass.opcdefault
      JOIN pg_catalog.pg_opclass second_default_opclass
        ON second_default_opclass.opcmethod = index_relation.relam
       AND second_default_opclass.opcintype = second_key_column.atttypid
       AND second_default_opclass.opcdefault
     WHERE i.indexrelid = target_index_oid;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'public.idx_fraud_signals_critical_observation exists but is not an index'
        USING ERRCODE = '55000';
    ELSIF NOT target_index_on_expected_table THEN
      RAISE EXCEPTION
        'public.idx_fraud_signals_critical_observation belongs to an unexpected table'
        USING ERRCODE = '55000';
    ELSIF NOT target_index_definition_matches THEN
      RAISE EXCEPTION
        'public.idx_fraud_signals_critical_observation has an unexpected definition'
        USING ERRCODE = '55000';
    ELSIF target_index_valid THEN
      IF NOT target_index_ready OR NOT target_index_live THEN
        RAISE EXCEPTION
          'valid public.idx_fraud_signals_critical_observation is not ready and live'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      -- The ordinary drop of this invalid exact-definition index is legal
      -- while the table lock proves no concurrent builder still owns it.
      EXECUTE
        'DROP INDEX public.idx_fraud_signals_critical_observation';
    END IF;
  END IF;
END
$fraud_index_recovery$;

CREATE INDEX IF NOT EXISTS idx_fraud_signals_critical_observation
  ON public.fraud_signals (guild_id, last_observed_at DESC)
  WHERE status = 'open' AND severity = 'critical';

-- IF NOT EXISTS is safe only behind the preflight above and this postflight.
-- Supabase records the migration after this transaction commits, so a missing,
-- invalid, or wrong-definition index fails closed and remains retryable.
DO $fraud_index_postflight$
DECLARE
  target_index_ready BOOLEAN;
BEGIN
  -- Keep the postflight in the same transaction as the index build and
  -- migration-history insert so a missing, invalid, or wrong-definition index
  -- fails closed and leaves the migration retryable.
  PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
  LOCK TABLE public.fraud_signals IN SHARE UPDATE EXCLUSIVE MODE;

  SELECT COALESCE(
    i.indisvalid
    AND i.indisready
    AND i.indislive
    AND NOT i.indisunique
    AND NOT i.indisexclusion
    AND i.indrelid = 'public.fraud_signals'::pg_catalog.regclass
    AND access_method.amname = 'btree'
    AND i.indnkeyatts = 2
    AND i.indnatts = 2
    AND i.indexprs IS NULL
    AND pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'guild_id'
    AND pg_catalog.pg_get_indexdef(i.indexrelid, 2, true) =
      'last_observed_at'
    AND i.indoption::TEXT = '0 3'
    AND i.indclass[0] = first_default_opclass.oid
    AND i.indclass[1] = second_default_opclass.oid
    AND i.indcollation[0] = first_key_column.attcollation
    AND i.indcollation[1] = second_key_column.attcollation
    AND pg_catalog.pg_get_expr(i.indpred, i.indrelid, false) =
      '((status = ''open''::text) AND (severity = ''critical''::text))',
    false
  )
    INTO target_index_ready
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class index_relation
      ON index_relation.oid = i.indexrelid
    JOIN pg_catalog.pg_am access_method
      ON access_method.oid = index_relation.relam
    JOIN pg_catalog.pg_attribute first_key_column
      ON first_key_column.attrelid = i.indrelid
     AND first_key_column.attnum = i.indkey[0]
    JOIN pg_catalog.pg_attribute second_key_column
      ON second_key_column.attrelid = i.indrelid
     AND second_key_column.attnum = i.indkey[1]
    JOIN pg_catalog.pg_opclass first_default_opclass
      ON first_default_opclass.opcmethod = index_relation.relam
     AND first_default_opclass.opcintype = first_key_column.atttypid
     AND first_default_opclass.opcdefault
    JOIN pg_catalog.pg_opclass second_default_opclass
      ON second_default_opclass.opcmethod = index_relation.relam
     AND second_default_opclass.opcintype = second_key_column.atttypid
     AND second_default_opclass.opcdefault
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
