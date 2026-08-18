-- Durable per-action automation recovery.
--
-- A pending row proves the action never started. An executing row is safe to
-- reclaim only when the action itself has a durable idempotency key. Ambiguous
-- Discord side effects are terminalized for manual reconciliation instead of
-- being replayed after a worker crash.

BEGIN;

ALTER TABLE public.automation_executions
  ADD COLUMN IF NOT EXISTS recovery_context JSONB,
  ADD COLUMN IF NOT EXISTS recovery_state TEXT NOT NULL DEFAULT 'legacy'
    CHECK (recovery_state IN ('legacy', 'running', 'completed', 'manual_reconcile'));

CREATE TABLE IF NOT EXISTS public.automation_action_progress (
  execution_id UUID NOT NULL
    REFERENCES public.automation_executions(id) ON DELETE CASCADE,
  action_index INTEGER NOT NULL CHECK (action_index >= 0),
  target_id TEXT NOT NULL DEFAULT '',
  action_type TEXT NOT NULL CHECK (pg_catalog.btrim(action_type) <> ''),
  action_payload JSONB NOT NULL CHECK (jsonb_typeof(action_payload) = 'object'),
  retry_safe BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'manual_reconcile')),
  side_effect_key TEXT NOT NULL,
  owner_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  result JSONB,
  started_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (execution_id, action_index, target_id),
  UNIQUE (side_effect_key),
  CHECK (
    (status = 'executing' AND owner_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'executing' AND owner_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_automation_action_progress_recovery
  ON public.automation_action_progress (status, lease_expires_at)
  WHERE status IN ('pending', 'executing');

ALTER TABLE public.automation_action_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_action_progress FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.automation_action_progress TO service_role;

CREATE OR REPLACE FUNCTION public.initialize_automation_action_progress(
  p_execution_id UUID,
  p_actions JSONB,
  p_recovery_context JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  expected_count INTEGER;
  stored_execution RECORD;
  enriched_context JSONB;
BEGIN
  IF p_execution_id IS NULL
     OR jsonb_typeof(p_actions) <> 'array'
     OR jsonb_array_length(p_actions) = 0
     OR jsonb_typeof(p_recovery_context) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'initialize_automation_action_progress: execution, actions, and context are required';
  END IF;

  expected_count := jsonb_array_length(p_actions);

  SELECT execution.id, execution.automation_id, execution.occurrence_id,
         execution.triggered_by, execution.trigger_event,
         execution.recovery_context, execution.recovery_state
    INTO stored_execution
    FROM public.automation_executions AS execution
   WHERE execution.id = p_execution_id
     AND execution.actions_started = TRUE
     AND execution.recovery_state IN ('legacy', 'running')
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002',
      MESSAGE = 'initialize_automation_action_progress: started execution not found';
  END IF;

  enriched_context := p_recovery_context || jsonb_build_object(
    'automationId', stored_execution.automation_id,
    'occurrenceId', stored_execution.occurrence_id,
    'triggeredBy', stored_execution.triggered_by,
    'triggerEvent', stored_execution.trigger_event
  );

  INSERT INTO public.automation_action_progress (
    execution_id,
    action_index,
    target_id,
    action_type,
    action_payload,
    retry_safe,
    side_effect_key
  )
  SELECT
    p_execution_id,
    item.action_index,
    COALESCE(item.target_id, ''),
    item.action_type,
    item.action_payload,
    item.retry_safe,
    'automation-action:' || p_execution_id::TEXT || ':' || item.action_index::TEXT
      || ':' || COALESCE(item.target_id, '')
  FROM jsonb_to_recordset(p_actions) AS item(
    action_index INTEGER,
    target_id TEXT,
    action_type TEXT,
    action_payload JSONB,
    retry_safe BOOLEAN
  )
  WHERE item.action_index IS NOT NULL
    AND item.action_index >= 0
    AND item.action_type IS NOT NULL
    AND pg_catalog.btrim(item.action_type) <> ''
    AND jsonb_typeof(item.action_payload) = 'object'
    AND item.retry_safe IS NOT NULL
  ON CONFLICT (execution_id, action_index, target_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
      FROM public.automation_action_progress AS stored
     WHERE stored.execution_id = p_execution_id
     GROUP BY stored.execution_id
    HAVING pg_catalog.count(*) = expected_count
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_actions) AS requested(
        action_index INTEGER,
        target_id TEXT,
        action_type TEXT,
        action_payload JSONB,
        retry_safe BOOLEAN
      )
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.automation_action_progress AS stored
        WHERE stored.execution_id = p_execution_id
          AND stored.action_index = requested.action_index
          AND stored.target_id = COALESCE(requested.target_id, '')
          AND stored.action_type = requested.action_type
          AND stored.action_payload = requested.action_payload
          AND stored.retry_safe = requested.retry_safe
     )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'initialize_automation_action_progress: malformed or conflicting action plan';
  END IF;

  IF stored_execution.recovery_state = 'legacy' THEN
    UPDATE public.automation_executions
       SET recovery_context = enriched_context,
           recovery_state = 'running'
     WHERE id = p_execution_id;
  ELSIF stored_execution.recovery_context IS DISTINCT FROM enriched_context THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'initialize_automation_action_progress: conflicting recovery context';
  END IF;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.initialize_automation_action_progress(UUID, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_automation_action_progress(UUID, JSONB, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_automation_action_progress(
  p_execution_id UUID,
  p_action_index INTEGER,
  p_target_id TEXT,
  p_owner_token TEXT,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS TABLE (
  claim_state TEXT,
  action_payload JSONB,
  retry_safe BOOLEAN,
  attempt_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  progress public.automation_action_progress%ROWTYPE;
  normalized_target TEXT := COALESCE(p_target_id, '');
BEGIN
  IF p_execution_id IS NULL
     OR p_action_index IS NULL
     OR p_action_index < 0
     OR p_owner_token IS NULL
     OR pg_catalog.btrim(p_owner_token) = ''
     OR p_lease_seconds < 30
     OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'claim_automation_action_progress: invalid claim identity or lease';
  END IF;

  SELECT action.* INTO progress
    FROM public.automation_action_progress AS action
   WHERE action.execution_id = p_execution_id
     AND action.action_index = p_action_index
     AND action.target_id = normalized_target
   FOR UPDATE;

  IF progress.execution_id IS NULL THEN
    RETURN QUERY SELECT 'missing'::TEXT, NULL::JSONB, FALSE, 0;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.automation_action_progress AS sibling
     WHERE sibling.execution_id = p_execution_id
       AND sibling.status = 'manual_reconcile'
  ) THEN
    RETURN QUERY SELECT 'manual_reconcile'::TEXT, progress.action_payload,
      progress.retry_safe, progress.attempt_count;
    RETURN;
  END IF;

  IF progress.status IN ('completed', 'failed') THEN
    RETURN QUERY SELECT progress.status, progress.action_payload,
      progress.retry_safe, progress.attempt_count;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.automation_action_progress AS predecessor
     WHERE predecessor.execution_id = p_execution_id
       AND predecessor.action_index < p_action_index
       AND predecessor.status NOT IN ('completed', 'failed')
  ) THEN
    RETURN QUERY SELECT 'busy'::TEXT, progress.action_payload,
      progress.retry_safe, progress.attempt_count;
    RETURN;
  END IF;

  IF progress.status = 'executing'
     AND progress.lease_expires_at > pg_catalog.clock_timestamp() THEN
    RETURN QUERY SELECT 'busy'::TEXT, progress.action_payload,
      progress.retry_safe, progress.attempt_count;
    RETURN;
  END IF;

  IF progress.status = 'executing' AND NOT progress.retry_safe THEN
    UPDATE public.automation_action_progress
       SET status = 'manual_reconcile',
           owner_token = NULL,
           lease_expires_at = NULL,
           result = jsonb_build_object(
             'reason', 'Worker lease expired after a non-idempotent side effect began; manual reconciliation is required'
           ),
           settled_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     WHERE execution_id = p_execution_id
       AND action_index = p_action_index
       AND target_id = normalized_target;

    UPDATE public.automation_executions
       SET recovery_state = 'manual_reconcile',
           conditions_passed = TRUE,
           errors = errors || jsonb_build_array(
             'Interrupted non-idempotent action requires manual reconciliation'
           )
     WHERE id = p_execution_id;

    INSERT INTO public.audit_logs (
      guild_id, actor_type, actor_id, action, target_type, target_id,
      details, success, error_message, occurrence_key
    )
    SELECT
      execution.guild_id,
      'system',
      'automation-recovery',
      'automation.recovery_failed',
      'automation_execution',
      execution.id::TEXT,
      jsonb_build_object(
        'automationId', execution.automation_id,
        'actionIndex', p_action_index,
        'targetId', normalized_target,
        'recoveryOutcome', 'manual_reconcile'
      ),
      FALSE,
      'A worker stopped after a non-idempotent action began; the action was not replayed',
      'automation.recovery_failed:' || execution.id::TEXT || ':'
        || p_action_index::TEXT || ':' || normalized_target
    FROM public.automation_executions AS execution
    WHERE execution.id = p_execution_id
    ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

    RETURN QUERY SELECT 'manual_reconcile'::TEXT, progress.action_payload,
      progress.retry_safe, progress.attempt_count;
    RETURN;
  END IF;

  UPDATE public.automation_action_progress AS action
     SET status = 'executing',
         owner_token = p_owner_token,
         lease_expires_at = pg_catalog.clock_timestamp()
           + pg_catalog.make_interval(secs => p_lease_seconds),
         attempt_count = action.attempt_count + 1,
         started_at = COALESCE(action.started_at, pg_catalog.clock_timestamp()),
         updated_at = pg_catalog.clock_timestamp()
   WHERE action.execution_id = p_execution_id
     AND action.action_index = p_action_index
     AND action.target_id = normalized_target
  RETURNING action.action_payload,
            action.retry_safe,
            action.attempt_count
       INTO progress.action_payload, progress.retry_safe, progress.attempt_count;

  RETURN QUERY SELECT 'claimed'::TEXT, progress.action_payload,
    progress.retry_safe, progress.attempt_count;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_automation_action_progress(UUID, INTEGER, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_automation_action_progress(UUID, INTEGER, TEXT, TEXT, INTEGER)
  TO service_role;

CREATE OR REPLACE FUNCTION public.settle_automation_action_progress(
  p_execution_id UUID,
  p_action_index INTEGER,
  p_target_id TEXT,
  p_owner_token TEXT,
  p_success BOOLEAN,
  p_result JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  settled BOOLEAN;
BEGIN
  UPDATE public.automation_action_progress
     SET status = CASE WHEN p_success THEN 'completed' ELSE 'failed' END,
         owner_token = NULL,
         lease_expires_at = NULL,
         result = p_result,
         settled_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   WHERE execution_id = p_execution_id
     AND action_index = p_action_index
     AND target_id = COALESCE(p_target_id, '')
     AND status = 'executing'
     AND owner_token = p_owner_token;
  settled := FOUND;
  RETURN settled;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_automation_action_progress(UUID, INTEGER, TEXT, TEXT, BOOLEAN, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_automation_action_progress(UUID, INTEGER, TEXT, TEXT, BOOLEAN, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.recover_stale_automation_action_progress(
  p_guild_id TEXT,
  p_stale_before TIMESTAMPTZ
)
RETURNS TABLE (
  execution_id UUID,
  recovery_state TEXT,
  recovery_context JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  ambiguous RECORD;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' OR p_stale_before IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'recover_stale_automation_action_progress: guild and stale floor are required';
  END IF;

  UPDATE public.automation_action_progress AS action
     SET status = 'pending',
         owner_token = NULL,
         lease_expires_at = NULL
    FROM public.automation_executions AS execution
   WHERE action.execution_id = execution.id
     AND execution.guild_id = p_guild_id
     AND action.status = 'executing'
     AND action.retry_safe = TRUE
     AND action.lease_expires_at < pg_catalog.clock_timestamp()
     AND NOT EXISTS (
       SELECT 1 FROM public.automation_action_progress AS fresh
        WHERE fresh.execution_id = execution.id
          AND fresh.updated_at >= p_stale_before
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.automation_mass_action_holds AS hold
        WHERE hold.execution_id = execution.id
     );

  FOR ambiguous IN
    UPDATE public.automation_action_progress AS action
       SET status = 'manual_reconcile',
           owner_token = NULL,
           lease_expires_at = NULL,
           result = jsonb_build_object(
             'reason', 'Worker lease expired after a non-idempotent side effect began; manual reconciliation is required'
           ),
           settled_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
      FROM public.automation_executions AS execution
     WHERE action.execution_id = execution.id
       AND execution.guild_id = p_guild_id
       AND action.status = 'executing'
       AND action.retry_safe = FALSE
       AND action.lease_expires_at < pg_catalog.clock_timestamp()
       AND NOT EXISTS (
         SELECT 1 FROM public.automation_action_progress AS fresh
          WHERE fresh.execution_id = execution.id
            AND fresh.updated_at >= p_stale_before
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.automation_mass_action_holds AS hold
          WHERE hold.execution_id = execution.id
       )
    RETURNING action.execution_id, action.action_index, action.target_id,
              execution.guild_id, execution.automation_id
  LOOP
    UPDATE public.automation_executions
       SET recovery_state = 'manual_reconcile',
           conditions_passed = TRUE,
           errors = errors || jsonb_build_array(
             'Interrupted non-idempotent action requires manual reconciliation'
           )
     WHERE id = ambiguous.execution_id;

    INSERT INTO public.audit_logs (
      guild_id, actor_type, actor_id, action, target_type, target_id,
      details, success, error_message, occurrence_key
    ) VALUES (
      ambiguous.guild_id,
      'system',
      'automation-recovery',
      'automation.recovery_failed',
      'automation_execution',
      ambiguous.execution_id::TEXT,
      jsonb_build_object(
        'automationId', ambiguous.automation_id,
        'actionIndex', ambiguous.action_index,
        'targetId', ambiguous.target_id,
        'recoveryOutcome', 'manual_reconcile'
      ),
      FALSE,
      'A worker stopped after a non-idempotent action began; the action was not replayed',
      'automation.recovery_failed:' || ambiguous.execution_id::TEXT || ':'
        || ambiguous.action_index::TEXT || ':' || ambiguous.target_id
    ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;
  END LOOP;

  RETURN QUERY
  SELECT DISTINCT execution.id, 'resumable'::TEXT, execution.recovery_context
    FROM public.automation_executions AS execution
   WHERE execution.guild_id = p_guild_id
     AND execution.recovery_state = 'running'
     AND NOT EXISTS (
       SELECT 1 FROM public.automation_action_progress AS fresh
        WHERE fresh.execution_id = execution.id
          AND fresh.updated_at >= p_stale_before
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.automation_action_progress AS action
        WHERE action.execution_id = execution.id
          AND action.status IN ('executing', 'manual_reconcile')
     )
     AND EXISTS (
       SELECT 1 FROM public.automation_action_progress AS action
        WHERE action.execution_id = execution.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.automation_mass_action_holds AS hold
        WHERE hold.execution_id = execution.id
     );
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stale_automation_action_progress(TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_automation_action_progress(TEXT, TIMESTAMPTZ)
  TO service_role;

CREATE OR REPLACE FUNCTION public.complete_automation_action_progress(
  p_execution_id UUID,
  p_recovered BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  completed_execution RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.automation_action_progress
     WHERE execution_id = p_execution_id
       AND status IN ('pending', 'executing', 'manual_reconcile')
  ) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.automation_executions
     SET recovery_state = 'completed'
   WHERE id = p_execution_id
     AND recovery_state = 'running'
  RETURNING id, guild_id, automation_id INTO completed_execution;

  IF completed_execution.id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF p_recovered THEN
    INSERT INTO public.audit_logs (
      guild_id, actor_type, actor_id, action, target_type, target_id,
      details, success, occurrence_key
    ) VALUES (
      completed_execution.guild_id,
      'system',
      'automation-recovery',
      'automation.recovery_completed',
      'automation_execution',
      completed_execution.id::TEXT,
      jsonb_build_object(
        'automationId', completed_execution.automation_id,
        'recoveryOutcome', 'completed'
      ),
      TRUE,
      'automation.recovery_completed:' || completed_execution.id::TEXT
    ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;
  END IF;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_automation_action_progress(UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_automation_action_progress(UUID, BOOLEAN)
  TO service_role;

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
  candidate UUID;
BEGIN
  SELECT execution.id INTO candidate
    FROM public.automation_executions AS execution
   WHERE execution.guild_id = p_guild_id
     AND execution.automation_id = p_automation_id
     AND execution.occurrence_id = p_occurrence_id
     AND execution.actions_started = TRUE
     AND execution.conditions_passed = FALSE
     AND execution.actions_executed = 0
     AND execution.actions_failed = 0
     AND execution.duration_ms = 0
     AND execution.created_at < p_stale_before
     AND execution.recovery_state = 'legacy'
   FOR UPDATE;

  IF candidate IS NULL OR EXISTS (
    SELECT 1 FROM public.automation_mass_action_holds AS hold
     WHERE hold.execution_id = candidate
  ) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.automation_executions
     SET conditions_passed = TRUE,
         errors = '["Automation worker was interrupted after its actions marker was set; completed action counts were lost with the worker and the occurrence will not be retried"]'::JSONB
   WHERE id = candidate;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_stale_started_automation_execution(TEXT, UUID, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_stale_started_automation_execution(TEXT, UUID, TEXT, TIMESTAMPTZ)
  TO service_role;

-- Keep the legacy terminalizer as a compatibility backstop for executions
-- created before this migration. Per-action managed rows belong exclusively to
-- the recovery RPC above.
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
  affected INTEGER;
BEGIN
  WITH candidates AS (
    SELECT execution.id
      FROM public.automation_executions AS execution
     WHERE execution.guild_id = p_guild_id
       AND execution.actions_started = TRUE
       AND execution.conditions_passed = FALSE
       AND execution.actions_executed = 0
       AND execution.actions_failed = 0
       AND execution.duration_ms = 0
       AND execution.created_at < p_stale_before
       AND execution.recovery_state = 'legacy'
       AND NOT EXISTS (
         SELECT 1 FROM public.automation_mass_action_holds AS hold
          WHERE hold.execution_id = execution.id
       )
     FOR UPDATE SKIP LOCKED
  ), finalized AS (
    UPDATE public.automation_executions AS execution
       SET conditions_passed = TRUE,
           errors = '["Automation worker was interrupted after its actions marker was set; completed action counts were lost with the worker and the occurrence will not be retried"]'::JSONB
      FROM candidates
     WHERE execution.id = candidates.id
    RETURNING execution.id
  )
  SELECT pg_catalog.count(*) INTO affected FROM finalized;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_stale_started_automation_executions(TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_stale_started_automation_executions(TEXT, TIMESTAMPTZ)
  TO service_role;

COMMIT;
