-- Round 28 review repairs.
--
-- 1) settle_discord_occurrence — completing (or failing) an occurrence used
--    to REPLACE the whole result object, dropping the counterReserved marker
--    the scheduled-send reservation depends on. Recovery completing a
--    reclaimed occurrence then let the stalled original sender re-reserve a
--    second slot for the same due minute. Settlement now MERGES into result.
--
-- 2) finalize_stale_started_automation_executions — the claim-time
--    terminalizer only runs when a redelivery happens to arrive, but the
--    in-memory event bus replays nothing across restarts. A guild-wide
--    startup sweep terminalizes every stale started, non-held row.
--
-- 3) bot_diagnostics.boot_id — runtime-feature rows carry a boot identity;
--    the heartbeat publishes the SAME id so the dashboard can reject rows
--    stranded by an earlier boot instead of letting a current heartbeat
--    vouch for managers this process never constructed.

BEGIN;

-- ── 1. Merge-settlement for durable occurrences ──

CREATE OR REPLACE FUNCTION public.settle_discord_occurrence(
  p_occurrence_id UUID,
  p_status TEXT,
  p_resource_id TEXT,
  p_result JSONB,
  p_last_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'settle_discord_occurrence: status must be completed or failed';
  END IF;

  -- MERGE, never replace: reservation markers (counterReserved) written by
  -- claim_scheduled_message_send must survive settlement, or a stalled
  -- sender resuming after recovery settled the occurrence re-reserves a
  -- second slot for the same due minute.
  UPDATE public.discord_operation_occurrences
     SET status = p_status,
         resource_id = p_resource_id,
         result = COALESCE(result, '{}'::jsonb) || COALESCE(p_result, '{}'::jsonb),
         last_error = p_last_error,
         completed_at = pg_catalog.now()
   WHERE id = p_occurrence_id
     AND status = 'claimed';

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_discord_occurrence(UUID, TEXT, TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_discord_occurrence(UUID, TEXT, TEXT, JSONB, TEXT)
  TO service_role;

-- ── 2. Guild-wide startup sweep for interrupted immediate executions ──

CREATE OR REPLACE FUNCTION public.finalize_stale_started_automation_executions(
  p_guild_id TEXT,
  p_stale_before TIMESTAMPTZ
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  locked_ids UUID[];
  affected INTEGER;
BEGIN
  IF p_guild_id IS NULL
     OR pg_catalog.btrim(p_guild_id) = ''
     OR p_stale_before IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'finalize_stale_started_automation_executions: guild and stale floor are required';
  END IF;

  -- Lock-then-check: lock every candidate first, then apply the hold
  -- exclusion in a SECOND statement whose snapshot sees any hold insert
  -- that committed before the locks were acquired.
  SELECT pg_catalog.array_agg(locked.id) INTO locked_ids
    FROM (
      SELECT execution.id
        FROM public.automation_executions AS execution
       WHERE execution.guild_id = p_guild_id
         AND execution.actions_started = true
         AND execution.conditions_passed = false
         AND execution.actions_executed = 0
         AND execution.actions_failed = 0
         AND execution.duration_ms = 0
         AND execution.created_at < p_stale_before
       FOR UPDATE
    ) AS locked;

  IF locked_ids IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.automation_executions AS execution
     SET conditions_passed = true,
         errors =
           '["Automation worker was interrupted after its actions marker was set; completed action counts were lost with the worker and the occurrence will not be retried"]'::jsonb
   WHERE execution.id = ANY(locked_ids)
     AND NOT EXISTS (
       SELECT 1
         FROM public.automation_mass_action_holds AS hold
        WHERE hold.execution_id = execution.id
     );

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_stale_started_automation_executions(TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_stale_started_automation_executions(TEXT, TIMESTAMPTZ)
  TO service_role;

-- ── 3. Boot identity on the heartbeat ──

ALTER TABLE public.bot_diagnostics
  ADD COLUMN IF NOT EXISTS boot_id TEXT;

COMMIT;
