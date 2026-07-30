-- ============================================================
-- alerts.severity — add the CHECK constraint that was never applied.
--
-- The live `alerts` table has NO constraint on `severity`. It looks like it
-- does, which is why this went unnoticed:
--
--   20260518000001_missing_tables.sql:263  CREATE TABLE IF NOT EXISTS alerts (
--                                            severity TEXT NOT NULL DEFAULT 'warning'
--                                          )                      <- no CHECK, runs FIRST
--   20260518100000_alerts_table.sql:6      CREATE TABLE IF NOT EXISTS alerts (
--                                            severity ... CHECK (severity IN
--                                              ('info','warning','critical'))
--                                          )                      <- runs LATER, so the
--                                                                    IF NOT EXISTS makes
--                                                                    the whole body a no-op
--
-- The constraint has therefore never existed on any database built from this
-- migration set, and no later migration re-adds it. The enum has been enforced
-- only by TypeScript — which means anything writing through the service-role
-- client, a raw SQL session, or a future route that forgets the union could
-- store an arbitrary string.
--
-- That is not hypothetical bookkeeping: `/api/alerts` filters with
-- `.eq('severity', …)`, so a row stored with an off-enum severity is invisible
-- to every severity filter while still counting as an unresolved alert.
--
-- Forward-only and idempotent: safe to re-run, and does not touch either of the
-- historical migrations above.
-- ============================================================

-- 1. Normalise any rows that would violate the constraint.
--
-- Expected to affect zero rows — every writer in the codebase is typed to the
-- three values. It exists because ADDING a constraint that an existing row
-- violates aborts the migration, and a deployment that fails on someone's real
-- database is worse than a constraint that arrives with its data tidied.
--
-- The mapping preserves intent rather than flattening everything to the column
-- default: an operator who somehow stored 'high' meant something urgent, and
-- collapsing that to 'warning' would quietly downgrade a real alert.
UPDATE alerts
SET severity = CASE
  WHEN lower(severity) IN ('critical', 'fatal', 'severe', 'high', 'outage') THEN 'critical'
  WHEN lower(severity) IN ('info', 'informational', 'low', 'debug', 'notice') THEN 'info'
  ELSE 'warning'
END
WHERE severity NOT IN ('info', 'warning', 'critical');

-- 2. Add the constraint.
--
-- Validated immediately rather than NOT VALID: step 1 guarantees every existing
-- row conforms, the table is small (operational alerts, pruned on a retention
-- window), and a NOT VALID constraint that nobody remembers to VALIDATE is a
-- constraint that only half exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.alerts'::regclass
      AND conname = 'alerts_severity_check'
  ) THEN
    ALTER TABLE public.alerts
      ADD CONSTRAINT alerts_severity_check
      CHECK (severity IN ('info', 'warning', 'critical'));
  END IF;
END $$;

COMMENT ON CONSTRAINT alerts_severity_check ON public.alerts IS
  'Matches OwnerAlertSeverity in packages/bot/src/services/alert-service.ts and the VALID_SEVERITIES whitelist in /api/alerts. Change all three together.';
