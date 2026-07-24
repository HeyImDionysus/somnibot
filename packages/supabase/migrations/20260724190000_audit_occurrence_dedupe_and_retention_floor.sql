-- =============================================================================
-- Audit pipeline — occurrence-level dedupe + retention floor alignment
-- (administration-audit fleet findings, wave 2).
--
-- 1) OCCURRENCE DEDUPE (REPLAY/RESTART findings): the AuditService had no
--    occurrence/idempotency key and audit_logs no uniqueness constraint, so a
--    redelivered platform event — or a re-flushed batch after a flush that
--    errored post-commit or a restart — wrote a second row for the SAME
--    occurrence. audit_logs gains `occurrence_key` (`<action>:<stable id>`,
--    e.g. `warn.issued:<infractionId>`) populated by the AuditService only
--    where the event payload carries an id that is structurally
--    created/completed once. The unique index below backs the service's
--    INSERT ... ON CONFLICT (guild_id, occurrence_key) DO NOTHING flush.
--
--    The index is intentionally FULL (not partial): PostgREST's on_conflict
--    inference cannot target a partial index's predicate, and the default
--    NULLS DISTINCT semantics already make unkeyed (NULL) rows never
--    conflict — keyless events keep plain append semantics. Tenant-purge
--    detach (guild_id → NULL) is likewise safe: keys embed per-occurrence
--    entity UUIDs, and NULL guild_ids never collide.
--
--    occurrence_key carries no personal identifiers (entity/queue-row UUIDs
--    only), so the retention scrub leaves it intact — a redelivery of an
--    ancient occurrence still dedupes after anonymization.
--
-- 2) RETENTION FLOOR (SET-A finding): scrub_expired_audit_logs RAISEd below
--    60 days and the per-guild driver clamped to GREATEST(..., 60), so the
--    catalog's 30-day retention minimum — guild_config's own
--    chk_retention_min CHECK (data_retention_days >= 30) — could never take
--    effect: an owner choosing 30 scrubbed nothing. The catalog contract
--    (administration-audit `retention-days`: min 30, max 3650) is the
--    authority; both functions now floor at 30 to match it.
-- =============================================================================
BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) occurrence_key + unique index
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS occurrence_key TEXT;

COMMENT ON COLUMN public.audit_logs.occurrence_key IS
  'Stable identity of the platform-event occurrence this row records '
  '(`<action>:<stable id>`, e.g. warn.issued:<infractionId>). NULL when the '
  'source event has no structurally-unique occurrence id. Backs exactly-once '
  'audit writes via uq_audit_logs_guild_occurrence + ON CONFLICT DO NOTHING. '
  'Contains no personal identifiers, so the retention scrub preserves it.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_logs_guild_occurrence
  ON public.audit_logs (guild_id, occurrence_key);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) scrub floor 60 → 30 (catalog minimum; body otherwise identical to
--    20260713030000 / 20260723110100)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.scrub_expired_audit_logs(
  retention_days INT DEFAULT 90
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  scrubbed_count BIGINT;
BEGIN
  IF retention_days < 30 THEN
    RAISE EXCEPTION
      'retention_days for audit_logs scrub must be at least 30, got %',
      retention_days;
  END IF;

  UPDATE public.audit_logs
     SET actor_id = 'anonymized',
         target_id = CASE WHEN target_id IS NULL THEN NULL ELSE 'anonymized' END,
         details = pg_catalog.jsonb_build_object('anonymized', true),
         before_state = NULL,
         after_state = NULL,
         error_message = NULL,
         correlation_id = NULL
   WHERE "timestamp" < pg_catalog.now()
       - (retention_days || ' days')::INTERVAL
     AND actor_id IS DISTINCT FROM 'anonymized';
  GET DIAGNOSTICS scrubbed_count = ROW_COUNT;
  RETURN scrubbed_count;
END;
$$;

REVOKE ALL ON FUNCTION public.scrub_expired_audit_logs(INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrub_expired_audit_logs(INT) TO service_role;

-- Per-guild nightly driver: honor data_retention_days down to the same
-- 30-day catalog floor (was clamped at 60).
CREATE OR REPLACE FUNCTION public.scrub_expired_audit_logs_all_guilds()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  total_scrubbed BIGINT := 0;
  batch_rows BIGINT;
  g RECORD;
BEGIN
  FOR g IN
    SELECT guild_id, data_retention_days
      FROM public.guild_config
     WHERE guild_id IS NOT NULL
  LOOP
    UPDATE public.audit_logs
       SET actor_id = 'anonymized',
           target_id = CASE WHEN target_id IS NULL THEN NULL ELSE 'anonymized' END,
           details = pg_catalog.jsonb_build_object('anonymized', true),
           before_state = NULL,
           after_state = NULL,
           error_message = NULL,
           correlation_id = NULL
     WHERE guild_id = g.guild_id
       AND "timestamp" < pg_catalog.now()
           - (GREATEST(COALESCE(g.data_retention_days, 90), 30) || ' days')::INTERVAL
       AND actor_id IS DISTINCT FROM 'anonymized';
    GET DIAGNOSTICS batch_rows = ROW_COUNT;
    total_scrubbed := total_scrubbed + batch_rows;
  END LOOP;

  RETURN total_scrubbed;
END;
$$;

REVOKE ALL ON FUNCTION public.scrub_expired_audit_logs_all_guilds()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrub_expired_audit_logs_all_guilds() TO service_role;

COMMIT;
