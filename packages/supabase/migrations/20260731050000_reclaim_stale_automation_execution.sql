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
-- One statement closes the race: the NOT EXISTS is evaluated by the same
-- DELETE that removes the row, so a concurrently inserted hold either commits
-- first (its execution row no longer matches) or blocks on the row lock and
-- the linkage check sees it.

BEGIN;

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
  v_removed UUID;
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

  DELETE FROM public.automation_executions AS execution
   WHERE execution.guild_id = p_guild_id
     AND execution.automation_id = p_automation_id
     AND execution.occurrence_id = p_occurrence_id
     -- Exactly the pre-action insert defaults: a finalized row matches none.
     AND execution.conditions_passed = false
     AND execution.actions_executed = 0
     AND execution.actions_failed = 0
     AND execution.duration_ms = 0
     -- Age floor: a live run finishes in seconds; ten minutes cannot race one.
     AND execution.created_at < p_stale_before
     -- The atomic hold guard. Evaluated by the same statement that deletes,
     -- so a concurrent hold insert cannot slip between check and delete.
     AND NOT EXISTS (
       SELECT 1
         FROM public.automation_mass_action_holds AS hold
        WHERE hold.execution_id = execution.id
     )
  RETURNING execution.id INTO v_removed;

  RETURN v_removed IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.reclaim_stale_automation_execution(
  TEXT, UUID, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_automation_execution(
  TEXT, UUID, TEXT, TIMESTAMPTZ
) TO service_role;

COMMIT;
