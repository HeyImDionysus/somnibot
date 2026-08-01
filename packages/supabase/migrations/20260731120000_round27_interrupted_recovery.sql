-- Round 27 review repairs: interrupted executions must terminalize with
-- truthful history.
--
-- 1) finalize_stale_started_automation_execution — an immediate-path worker
--    that dies between the durable actions marker and finalize leaves its
--    execution row carrying the insert defaults forever: the occurrence
--    claim is consumed (correctly — actions may have reached Discord, so it
--    must never re-run), the reclaim RPC refuses marked rows by design, and
--    history reads 'Conditions not met'. A redelivery now terminalizes such
--    rows as interrupted instead of leaving them lying.
--
-- 2) Durable held progress — the engine mirrors bulk progress only in
--    process memory, so a holder that died mid-run was finalized by the
--    lease-expiry RPC with zero counts despite real Discord mutations.
--    Progress now persists on the hold row at every confirmed lease renewal
--    (no extra write frequency), and the recovery RPC restores it as an
--    explicit lower bound.

BEGIN;

-- ── 1. Terminalize stale STARTED immediate-path claims ──

CREATE OR REPLACE FUNCTION public.finalize_stale_started_automation_execution(
  p_guild_id TEXT,
  p_automation_id UUID,
  p_occurrence_id TEXT,
  p_stale_before TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_candidate UUID;
BEGIN
  IF p_guild_id IS NULL
     OR pg_catalog.btrim(p_guild_id) = ''
     OR p_automation_id IS NULL
     OR p_occurrence_id IS NULL
     OR pg_catalog.btrim(p_occurrence_id) = ''
     OR p_stale_before IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'finalize_stale_started_automation_execution: complete claim identity is required';
  END IF;

  -- Lock-then-check: a single-statement NOT EXISTS reuses the original
  -- snapshot under EvalPlanQual, so the hold check runs as its own
  -- statement AFTER the row lock.
  SELECT execution.id INTO v_candidate
    FROM public.automation_executions AS execution
   WHERE execution.guild_id = p_guild_id
     AND execution.automation_id = p_automation_id
     AND execution.occurrence_id = p_occurrence_id
     -- The marker is set and nothing else moved: exactly the shape a crash
     -- between markActionsStarted and finalize leaves behind. A finalized
     -- row matches none of these.
     AND execution.actions_started = true
     AND execution.conditions_passed = false
     AND execution.actions_executed = 0
     AND execution.actions_failed = 0
     AND execution.duration_ms = 0
     -- Age floor: a live run finishes in seconds; ten minutes cannot race one.
     AND execution.created_at < p_stale_before
   FOR UPDATE;

  IF v_candidate IS NULL THEN
    RETURN FALSE;
  END IF;

  -- A HELD execution stays pre-action shaped for as long as approval takes;
  -- its terminal truth belongs to the hold recovery paths, never this one.
  -- Fresh statement, snapshot taken after the row lock.
  IF EXISTS (
    SELECT 1
      FROM public.automation_mass_action_holds AS hold
     WHERE hold.execution_id = v_candidate
  ) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.automation_executions
     SET conditions_passed = true,
         errors =
           '["Automation worker was interrupted after its actions marker was set; completed action counts were lost with the worker and the occurrence will not be retried"]'::jsonb
   WHERE id = v_candidate;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_stale_started_automation_execution(
  TEXT, UUID, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_stale_started_automation_execution(
  TEXT, UUID, TEXT, TIMESTAMPTZ
) TO service_role;

-- ── 2. Durable lower-bound progress for executing holds ──

ALTER TABLE public.automation_mass_action_holds
  ADD COLUMN IF NOT EXISTS progress_executed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_failed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_errors JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The lease renewal now carries the worker's confirmed progress. The old
-- 3-argument signature must not linger: two resolvable signatures make
-- PostgREST RPC dispatch ambiguous.
DROP FUNCTION IF EXISTS public.renew_automation_mass_action_hold_lease(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.renew_automation_mass_action_hold_lease(
  p_hold_id UUID,
  p_guild_id TEXT,
  p_owner_token TEXT,
  p_progress_executed INTEGER DEFAULT NULL,
  p_progress_failed INTEGER DEFAULT NULL,
  p_progress_errors JSONB DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  renewed BOOLEAN;
BEGIN
  UPDATE public.automation_mass_action_holds
     SET execution_lease_expires_at = pg_catalog.now() + INTERVAL '2 minutes',
         progress_executed = COALESCE(p_progress_executed, progress_executed),
         progress_failed = COALESCE(p_progress_failed, progress_failed),
         progress_errors = COALESCE(p_progress_errors, progress_errors)
   WHERE id = p_hold_id
     AND guild_id = p_guild_id
     AND status = 'executing'
     AND execution_owner_token = p_owner_token
     -- Review 3691834558: never revive an already-expired lease. Once expiry
     -- passes, the periodic recovery path may have failed the hold and another
     -- worker may own the occurrence; renewing here would let the old worker
     -- keep running a destructive bulk action it no longer owns.
     AND execution_lease_expires_at > pg_catalog.now();
  renewed := FOUND;
  RETURN renewed;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_automation_mass_action_hold_lease(
  UUID, TEXT, TEXT, INTEGER, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_automation_mass_action_hold_lease(
  UUID, TEXT, TEXT, INTEGER, INTEGER, JSONB
) TO service_role;

-- Lease-expiry recovery restores the persisted lower bound instead of
-- finalizing an interrupted run as '0 actions OK'.
CREATE OR REPLACE FUNCTION public.fail_stale_automation_mass_action_executions(
  p_guild_id TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  affected INTEGER;
BEGIN
  -- Round 20: fail the expired holds AND finalize their linked execution
  -- rows in the SAME statement; the finalize is conditional on the exact
  -- pre-action defaults so an execution finalized before the lease expired
  -- is preserved untouched. Round 27: the finalize restores the durable
  -- progress persisted by lease renewals — counts are an explicit lower
  -- bound, not zeros.
  WITH failed_holds AS (
    UPDATE public.automation_mass_action_holds
       SET status = 'failed',
           completed_at = pg_catalog.now(),
           last_error =
             'Execution lease expired after work started. Some member actions may have completed; inspect the audit log before retrying manually.',
           execution_owner_token = NULL,
           execution_lease_expires_at = NULL
     WHERE guild_id = p_guild_id
       AND status = 'executing'
       AND execution_lease_expires_at IS NOT NULL
       AND execution_lease_expires_at < pg_catalog.now()
    RETURNING id, execution_id, progress_executed, progress_failed, progress_errors
  ), finalized AS (
    UPDATE public.automation_executions AS execution
       SET conditions_passed = TRUE,
           actions_executed = failed_holds.progress_executed,
           actions_failed = failed_holds.progress_failed,
           errors = failed_holds.progress_errors
             || '["Execution lease expired after work started; recovery failed the hold. Recorded counts are the last confirmed lower bound; the exact tail is unknown."]'::jsonb
      FROM failed_holds
     WHERE execution.id = failed_holds.execution_id
       AND execution.conditions_passed = FALSE
       AND execution.actions_executed = 0
       AND execution.actions_failed = 0
  )
  SELECT pg_catalog.count(*) INTO affected FROM failed_holds;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_stale_automation_mass_action_executions(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_stale_automation_mass_action_executions(TEXT)
  TO service_role;

COMMIT;
