BEGIN;

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS operation_id TEXT;

UPDATE public.audit_logs
   SET operation_id = COALESCE(NULLIF(correlation_id, ''), NULLIF(occurrence_key, ''), id::text)
 WHERE operation_id IS NULL OR pg_catalog.btrim(operation_id) = '';

ALTER TABLE public.audit_logs
  ALTER COLUMN operation_id SET NOT NULL;

CREATE OR REPLACE FUNCTION public.assign_audit_operation_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.actor_id IN ('anonymized', 'deleted_user')
       OR NEW.target_id IN ('anonymized', 'deleted_user')
       OR NEW.details = pg_catalog.jsonb_build_object('anonymized', true)
     )
  THEN
    NEW.operation_id := 'audit:' || NEW.id::text;
  ELSE
    NEW.operation_id := COALESCE(NULLIF(NEW.correlation_id, ''), NULLIF(NEW.occurrence_key, ''), NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_audit_operation_identity ON public.audit_logs;
CREATE TRIGGER trg_assign_audit_operation_identity
  BEFORE INSERT OR UPDATE ON public.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_audit_operation_identity();

CREATE TABLE IF NOT EXISTS public.audit_log_integrity_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audit_id UUID NOT NULL REFERENCES public.audit_logs(id),
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('inserted', 'anonymized')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  current_content_hash TEXT NOT NULL CHECK (current_content_hash ~ '^[0-9a-f]{64}$'),
  prior_event_hash TEXT CHECK (prior_event_hash IS NULL OR prior_event_hash ~ '^[0-9a-f]{64}$'),
  event_hash TEXT NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (audit_id, event_sequence),
  UNIQUE (event_hash)
);

ALTER TABLE public.audit_log_integrity_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_log_integrity_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.audit_log_integrity_events TO service_role;

CREATE OR REPLACE FUNCTION public.audit_log_content_hash(p_row public.audit_logs)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'integrity_version', 1,
          'id', (p_row).id,
          'guild_id', (p_row).guild_id,
          'timestamp', (p_row)."timestamp",
          'actor_type', (p_row).actor_type,
          'actor_id', (p_row).actor_id,
          'action', (p_row).action,
          'category', (p_row).category,
          'target_type', (p_row).target_type,
          'target_id', (p_row).target_id,
          'details', (p_row).details,
          'before_state', (p_row).before_state,
          'after_state', (p_row).after_state,
          'correlation_id', (p_row).correlation_id,
          'occurrence_key', (p_row).occurrence_key,
          'unscoped_occurrence_key', (p_row).unscoped_occurrence_key,
          'operation_id', (p_row).operation_id,
          'success', (p_row).success,
          'error_message', (p_row).error_message
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

CREATE OR REPLACE FUNCTION public.record_audit_integrity_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  prior_event public.audit_log_integrity_events%ROWTYPE;
  next_sequence INTEGER;
  change_kind TEXT;
  content_hash TEXT;
  occurred_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
  event_hash TEXT;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.id::text, 0));

  IF TG_OP = 'UPDATE' THEN
    IF NEW.actor_id NOT IN (OLD.actor_id, 'anonymized', 'deleted_user')
       OR (
         NEW.target_id IS DISTINCT FROM OLD.target_id
         AND NEW.target_id IS DISTINCT FROM 'anonymized'
         AND NEW.target_id IS DISTINCT FROM 'deleted_user'
       )
       OR NEW.details IS DISTINCT FROM pg_catalog.jsonb_build_object('anonymized', true)
       OR NEW.before_state IS NOT NULL
       OR NEW.after_state IS NOT NULL
       OR NEW.error_message IS NOT NULL
       OR NEW.correlation_id IS NOT NULL
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW."timestamp" IS DISTINCT FROM OLD."timestamp"
       OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
       OR NEW.action IS DISTINCT FROM OLD.action
       OR NEW.target_type IS DISTINCT FROM OLD.target_type
       OR NEW.success IS DISTINCT FROM OLD.success
       OR NEW.occurrence_key IS DISTINCT FROM OLD.occurrence_key
       OR NEW.operation_id IS DISTINCT FROM 'audit:' || NEW.id::text
       OR (NEW.guild_id IS DISTINCT FROM OLD.guild_id AND NEW.guild_id IS NOT NULL)
    THEN
      RAISE EXCEPTION 'audit_logs are append-only except for the sanctioned anonymization transition';
    END IF;
    change_kind := 'anonymized';
  ELSE
    change_kind := 'inserted';
  END IF;

  SELECT * INTO prior_event
    FROM public.audit_log_integrity_events
   WHERE audit_id = NEW.id
   ORDER BY event_sequence DESC
   LIMIT 1
   FOR UPDATE;

  next_sequence := COALESCE(prior_event.event_sequence, 0) + 1;
  content_hash := public.audit_log_content_hash(NEW);
  event_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'audit_id', NEW.id,
          'event_sequence', next_sequence,
          'change_kind', change_kind,
          'occurred_at', occurred_at,
          'current_content_hash', content_hash,
          'prior_event_hash', prior_event.event_hash
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.audit_log_integrity_events (
    audit_id, event_sequence, change_kind,
    occurred_at, current_content_hash, prior_event_hash, event_hash
  ) VALUES (
    NEW.id, next_sequence, change_kind,
    occurred_at, content_hash, prior_event.event_hash, event_hash
  );
  RETURN NEW;
END;
$$;

INSERT INTO public.audit_log_integrity_events (
  audit_id, event_sequence, change_kind,
  occurred_at, current_content_hash, prior_event_hash, event_hash
)
SELECT
  a.id,
  1,
  CASE WHEN a.actor_id = 'anonymized' THEN 'anonymized' ELSE 'inserted' END,
  a."timestamp",
  public.audit_log_content_hash(a),
  NULL,
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'audit_id', a.id,
          'event_sequence', 1,
          'change_kind', CASE WHEN a.actor_id = 'anonymized' THEN 'anonymized' ELSE 'inserted' END,
          'occurred_at', a."timestamp",
          'current_content_hash', public.audit_log_content_hash(a),
          'prior_event_hash', NULL
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
FROM public.audit_logs a
ON CONFLICT (audit_id, event_sequence) DO NOTHING;

DROP TRIGGER IF EXISTS trg_record_audit_integrity_event ON public.audit_logs;
CREATE TRIGGER trg_record_audit_integrity_event
  AFTER INSERT OR UPDATE ON public.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.record_audit_integrity_event();

CREATE OR REPLACE FUNCTION public.prevent_audit_integrity_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'audit integrity evidence is append-only';
END;
$$;

CREATE TRIGGER trg_prevent_audit_integrity_mutation
  BEFORE UPDATE OR DELETE ON public.audit_log_integrity_events
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_audit_integrity_mutation();

CREATE TRIGGER trg_prevent_audit_integrity_truncate
  BEFORE TRUNCATE ON public.audit_log_integrity_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.prevent_audit_integrity_mutation();

CREATE OR REPLACE FUNCTION public.verify_audit_integrity(p_guild_id TEXT)
RETURNS TABLE (
  total_rows BIGINT,
  verified_rows BIGINT,
  mismatched_rows BIGINT,
  broken_chain_events BIGINT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  WITH ordered_events AS (
    SELECT
      e.*,
      pg_catalog.lag(e.event_hash) OVER (PARTITION BY e.audit_id ORDER BY e.event_sequence) AS expected_prior_hash,
      pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(
            pg_catalog.jsonb_build_object(
              'audit_id', e.audit_id,
              'event_sequence', e.event_sequence,
              'change_kind', e.change_kind,
              'occurred_at', e.occurred_at,
              'current_content_hash', e.current_content_hash,
              'prior_event_hash', e.prior_event_hash
            )::text,
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) AS expected_event_hash
    FROM public.audit_log_integrity_events e
    INNER JOIN public.audit_logs a ON a.id = e.audit_id
    WHERE a.guild_id IS NOT DISTINCT FROM p_guild_id
  ),
  latest_events AS (
    SELECT DISTINCT ON (e.audit_id) e.audit_id, e.current_content_hash
    FROM ordered_events e
    ORDER BY e.audit_id, e.event_sequence DESC
  ),
  row_checks AS (
    SELECT
      a.id,
      latest.current_content_hash = public.audit_log_content_hash(a) AS verified
    FROM public.audit_logs a
    LEFT JOIN latest_events latest ON latest.audit_id = a.id
    WHERE a.guild_id IS NOT DISTINCT FROM p_guild_id
  )
  SELECT
    pg_catalog.count(*)::BIGINT,
    pg_catalog.count(*) FILTER (WHERE verified)::BIGINT,
    pg_catalog.count(*) FILTER (WHERE NOT COALESCE(verified, false))::BIGINT,
    (
      SELECT pg_catalog.count(*)::BIGINT
      FROM ordered_events e
      WHERE e.prior_event_hash IS DISTINCT FROM e.expected_prior_hash
         OR e.event_hash IS DISTINCT FROM e.expected_event_hash
    )
  FROM row_checks;
$$;

REVOKE ALL ON FUNCTION public.assign_audit_operation_identity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_log_content_hash(public.audit_logs) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_audit_integrity_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_audit_integrity_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_audit_integrity(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_audit_integrity(text) TO service_role;

COMMIT;
