-- ============================================================
-- V8 Audit §5.P3b — Explicit RLS policy for reconciliation_runs
-- ============================================================
-- RLS was enabled in v53 but no policy was created. While
-- default-deny is correct (anon/authenticated can't access),
-- an explicit service-role-only policy makes intent clear and
-- protects against future role grants.
-- ============================================================

-- Ensure RLS is enabled (idempotent)
ALTER TABLE IF EXISTS reconciliation_runs ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access (bot + dashboard use this role)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'reconciliation_runs'
      AND policyname = 'service_role_full_access'
  ) THEN
    CREATE POLICY service_role_full_access ON reconciliation_runs
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END;
$$;
