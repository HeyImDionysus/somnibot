-- =============================================================================
-- [commerce] Atomic license-heartbeat decision and session touch
--
-- The dashboard heartbeat route previously performed separate PostgREST reads
-- for active, live-grace, lapsed-grace, and recorded fallback states. A payment
-- recovery could change one row from grace_period to active between those
-- statements: the first read saw no active row, while every later read excluded
-- the now-active row, producing a false terminal "revoked" verdict.
--
-- The route also selected an active session and later updated it by id only.
-- A concurrent administrative deactivation could commit between those calls,
-- after which the heartbeat would touch the inactive row and still return valid.
--
-- This service-role-only RPC makes key, entitlement, and session decisions in
-- one SQL statement. Row locks linearize concurrent key/entitlement transitions,
-- while the conditional session UPDATE rechecks active=true after any competing
-- deactivation lock. Candidate rows are materialized before the database-owned
-- decision clock is taken, so query delay cannot compare grace against a stale
-- timestamp captured by the dashboard before the read. Existing commerce
-- writers do not all acquire key, entitlement, and session locks in this order,
-- so the function-local lock timeout bounds any opposite-order cycle. A timeout
-- is an RPC error and the dashboard maps it to retryable 503, never a terminal
-- license verdict.
--
-- Rollback (code must stop calling the RPC first):
--   DROP FUNCTION public.license_heartbeat_decision(TEXT, UUID);
-- =============================================================================

CREATE OR REPLACE FUNCTION public.license_heartbeat_decision(
  p_key_hash TEXT,
  p_session_id UUID
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '500ms'
AS $$
  WITH key_snapshot AS MATERIALIZED (
    SELECT
      key.id,
      key.status,
      key.product_id
    FROM public.license_keys AS key
    WHERE key.key_hash = p_key_hash
    LIMIT 1
    FOR SHARE
  ),
  heartbeat_config AS MATERIALIZED (
    SELECT config.heartbeat_interval_seconds
    FROM key_snapshot AS key
    LEFT JOIN public.product_license_config AS config
      ON config.product_id = key.product_id
  ),
  candidate_entitlements AS MATERIALIZED (
    SELECT
      entitlement.id,
      entitlement.status,
      entitlement.grace_period_ends_at,
      entitlement.updated_at
    FROM public.entitlements AS entitlement
    JOIN key_snapshot AS key
      ON key.id = entitlement.license_key_id
    FOR SHARE OF entitlement
  ),
  decision_clock AS MATERIALIZED (
    -- candidate_count is returned in the RPC receipt below, making this scan
    -- an optimizer-visible dependency rather than a prunable unused subquery.
    -- The volatile clock expression is evaluated for the aggregate output after
    -- the locked/materialized candidate rows have been consumed.
    SELECT
      pg_catalog.count(*) AS candidate_count,
      pg_catalog.clock_timestamp() AS decision_at
    FROM candidate_entitlements
  ),
  chosen AS MATERIALIZED (
    SELECT
      candidate.id,
      candidate.status,
      candidate.grace_period_ends_at,
      clock.decision_at
    FROM candidate_entitlements AS candidate
    CROSS JOIN decision_clock AS clock
    ORDER BY
      CASE
        WHEN candidate.status = 'active' THEN 0
        WHEN candidate.status = 'grace_period'
          AND candidate.grace_period_ends_at IS NOT NULL
          AND NOT (candidate.grace_period_ends_at < clock.decision_at)
          THEN 1
        WHEN candidate.status = 'grace_period' THEN 2
        ELSE 3
      END,
      CASE
        WHEN candidate.status = 'grace_period'
          THEN candidate.grace_period_ends_at
      END DESC NULLS LAST,
      CASE
        WHEN candidate.status NOT IN ('active', 'grace_period')
          THEN candidate.updated_at
      END DESC NULLS LAST,
      candidate.id ASC
    LIMIT 1
  ),
  entitlement_decision AS MATERIALIZED (
    SELECT
      chosen.id AS entitlement_id,
      CASE
        WHEN chosen.id IS NULL THEN 'revoked'
        -- The schema CHECK makes a deadline-less grace row impossible. Treat a
        -- corrupted/legacy row as an indeterminate internal result; the route
        -- converts unknown RPC statuses to a non-terminal HTTP 503.
        WHEN chosen.status = 'grace_period'
          AND chosen.grace_period_ends_at IS NULL
          THEN 'malformed'
        -- Canonical boundary: equality remains live. Grace lapses only when
        -- its deadline is strictly earlier than the database decision clock.
        WHEN chosen.status = 'grace_period'
          AND chosen.grace_period_ends_at < chosen.decision_at
          THEN 'expired'
        ELSE chosen.status
      END AS status,
      chosen.grace_period_ends_at,
      decision_clock.decision_at,
      decision_clock.candidate_count
    FROM decision_clock
    LEFT JOIN chosen ON TRUE
  ),
  touched_session AS MATERIALIZED (
    UPDATE public.license_sessions AS session
       SET last_seen_at = decision.decision_at
      FROM key_snapshot AS key,
           entitlement_decision AS decision
     WHERE session.id = p_session_id
       AND session.license_key_id = key.id
       AND session.active = true
       AND key.status = 'active'
       AND decision.status IN ('active', 'grace_period')
    RETURNING session.id
  )
  SELECT pg_catalog.jsonb_build_object(
    'entitlement_id', decision.entitlement_id,
    'status',
      CASE
        WHEN key.id IS NULL THEN 'revoked'
        WHEN key.status <> 'active' THEN key.status
        WHEN decision.status NOT IN ('active', 'grace_period')
          THEN decision.status
        WHEN touched.id IS NULL THEN 'session_invalidated'
        ELSE decision.status
      END,
    'grace_period_ends_at', decision.grace_period_ends_at,
    'decided_at', decision.decision_at,
    'candidate_count', decision.candidate_count,
    'session_touched', touched.id IS NOT NULL,
    'next_heartbeat_seconds',
      COALESCE(config.heartbeat_interval_seconds, 300)
  )
  FROM entitlement_decision AS decision
  LEFT JOIN key_snapshot AS key ON TRUE
  LEFT JOIN heartbeat_config AS config ON TRUE
  LEFT JOIN touched_session AS touched ON TRUE;
$$;

COMMENT ON FUNCTION public.license_heartbeat_decision(TEXT, UUID) IS
  'Atomically decides key and entitlement state and conditionally touches one active heartbeat session.';

REVOKE ALL ON FUNCTION public.license_heartbeat_decision(TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.license_heartbeat_decision(TEXT, UUID)
  TO service_role;
