-- Atomic reclaim of a stranded pre-action automation execution claim.
--
-- The application-side version read the candidate row, checked
-- automation_mass_action_holds.execution_id linkage, and then deleted — three
-- separate statements. Review 3689865698: when bulk member evaluation runs
-- longer than the ten-minute stale floor, a redelivery can observe no hold,
-- the original worker can insert its hold, and the redelivery's delete still
-- matches every pre-action default — removing a now-held execution, whose
-- hold then loses execution_id via ON DELETE SET NULL.
--
-- Round 15: a single DELETE with NOT EXISTS is still not enough. The
-- subquery is evaluated against the statement snapshot; a concurrent hold
-- INSERT that commits while the DELETE waits on the row's FK lock is never
-- seen, because EvalPlanQual re-checks reuse the original snapshot. The
-- reclaim therefore locks the candidate row FIRST — FOR UPDATE conflicts
-- with the KEY SHARE a referencing hold insert must take — and only then
-- checks linkage in a NEW statement whose snapshot postdates any insert
-- that won the lock race:
--   * hold insert commits first  -> our lock acquires afterwards, the fresh
--     EXISTS sees the hold, the reclaim refuses;
--   * we lock first              -> the insert waits on the FK lock, our
--     delete removes the parent, and the insert fails its FK check — the
--     worker's hold creation errors visibly instead of silently detaching.

BEGIN;

-- Round 21: the pre-action DEFAULTS are not proof that no action ran — an
-- immediate automation keeps them until finalize, so a crash after
-- send_message/send_dm/create_ticket reached Discord let a stale redelivery
-- reclaim the claim and repeat the external side effect. actions_started is
-- flipped durably BEFORE the first action executes; the reclaim refuses any
-- claim that reached it.
ALTER TABLE public.automation_executions
  ADD COLUMN IF NOT EXISTS actions_started BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.reclaim_stale_automation_execution(
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
      MESSAGE = 'reclaim_stale_automation_execution: complete claim identity is required';
  END IF;

  SELECT execution.id INTO v_candidate
    FROM public.automation_executions AS execution
   WHERE execution.guild_id = p_guild_id
     AND execution.automation_id = p_automation_id
     AND execution.occurrence_id = p_occurrence_id
     -- Exactly the pre-action insert defaults: a finalized row matches none.
     AND execution.conditions_passed = false
     AND execution.actions_executed = 0
     AND execution.actions_failed = 0
     AND execution.duration_ms = 0
     -- Never reclaim a claim whose actions may have reached Discord.
     AND execution.actions_started = false
     -- Age floor: a live run finishes in seconds; ten minutes cannot race one.
     AND execution.created_at < p_stale_before
   FOR UPDATE;

  IF v_candidate IS NULL THEN
    RETURN FALSE;
  END IF;

  -- A NEW statement, snapshot taken AFTER the row lock: a hold insert that
  -- committed before we acquired the lock is visible here.
  IF EXISTS (
    SELECT 1
      FROM public.automation_mass_action_holds AS hold
     WHERE hold.execution_id = v_candidate
  ) THEN
    RETURN FALSE;
  END IF;

  DELETE FROM public.automation_executions
   WHERE id = v_candidate;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.reclaim_stale_automation_execution(
  TEXT, UUID, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_automation_execution(
  TEXT, UUID, TEXT, TIMESTAMPTZ
) TO service_role;

COMMIT;
