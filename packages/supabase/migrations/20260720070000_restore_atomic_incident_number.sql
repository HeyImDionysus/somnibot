-- =============================================================================
-- Restore atomic incident numbering.
--
-- nextval_incident() was defined as an atomic sequence draw in v13
-- (20260520300000_v13_audit_fixes.sql: RETURN nextval('incident_number_seq')),
-- but v42 (20260522600000_v42_audit_fixes.sql) — intending only to add
-- SECURITY DEFINER + search_path — REGRESSED the body to
-- `SELECT COALESCE(MAX(incident_number),0)+1 FROM incidents`. That draws WITHOUT
-- inserting, so back-to-back or concurrent calls with no intervening insert all
-- return the SAME number (a live `SELECT nextval_incident(), nextval_incident()`
-- returns 1,1). Two purchases racing checkCriticalThreshold both draw N before
-- either inserts → duplicate incident_number. The incident_number_seq sequence
-- still exists (unused since v42). Restore the atomic body and realign the seq.
-- =============================================================================

BEGIN;

-- Point the sequence at the next unused number so the first post-fix draw does not
-- collide with an already-recorded incident (is_called=false → next draw == value).
SELECT pg_catalog.setval(
  'public.incident_number_seq',
  COALESCE((SELECT pg_catalog.max(incident_number) FROM public.incidents), 0) + 1,
  false
);

CREATE OR REPLACE FUNCTION public.nextval_incident()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN pg_catalog.nextval('public.incident_number_seq');
END;
$$;

REVOKE ALL ON FUNCTION public.nextval_incident() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nextval_incident() TO service_role;

COMMIT;
