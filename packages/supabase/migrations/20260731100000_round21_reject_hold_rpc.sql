-- =============================================================================
-- PR #408 round 21: atomic hold rejection.
--
-- The dashboard rejected a hold and finalized its linked execution row in
-- two separate writes; a transient fault after the first left history
-- reading 'Conditions not met' forever for an owner-rejected match, with no
-- retry path. Both transitions now happen inside one function call (one
-- transaction): the hold flips held -> rejected and the linked execution is
-- finalized as an owner rejection — conditional on the exact pre-action
-- counters so an already-finalized execution is never clobbered.
--
-- Definer-rights with an empty search_path, service_role only — the same
-- conventions as reclaim_stale_automation_execution (20260731050000).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reject_automation_mass_action_hold(
  p_hold_id UUID,
  p_guild_id TEXT,
  p_actor TEXT
) RETURNS SETOF public.automation_mass_action_holds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hold public.automation_mass_action_holds;
BEGIN
  IF p_hold_id IS NULL
     OR p_guild_id IS NULL
     OR pg_catalog.btrim(p_guild_id) = ''
     OR p_actor IS NULL
     OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'reject_automation_mass_action_hold: hold, guild, and actor are required';
  END IF;

  UPDATE public.automation_mass_action_holds
     SET status = 'rejected',
         rejected_by = p_actor,
         rejected_at = pg_catalog.now(),
         last_error = NULL
   WHERE id = p_hold_id
     AND guild_id = p_guild_id
     AND status = 'held'
  RETURNING * INTO v_hold;

  IF v_hold.id IS NULL THEN
    RETURN;
  END IF;

  IF v_hold.execution_id IS NOT NULL THEN
    UPDATE public.automation_executions
       SET conditions_passed = TRUE,
           errors = '["Rejected by the owner before any action ran"]'::jsonb
     WHERE id = v_hold.execution_id
       AND guild_id = p_guild_id
       AND conditions_passed = FALSE
       AND actions_executed = 0
       AND actions_failed = 0;
  END IF;

  RETURN NEXT v_hold;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_automation_mass_action_hold(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_automation_mass_action_hold(UUID, TEXT, TEXT)
  TO service_role;
