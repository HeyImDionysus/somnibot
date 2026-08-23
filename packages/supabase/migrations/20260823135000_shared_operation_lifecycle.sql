CREATE OR REPLACE FUNCTION public.operation_lifecycle_is_canonical(p_stages TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  WITH canonical(stage, position) AS (
    VALUES
      ('draft', 1), ('validated', 2), ('conflict_checked', 3),
      ('previewed', 4), ('committed', 5), ('executed', 6),
      ('read_back', 7), ('audited', 8)
  ), supplied AS (
    SELECT value AS stage, ordinal
      FROM pg_catalog.unnest(p_stages) WITH ORDINALITY AS item(value, ordinal)
  )
  SELECT pg_catalog.cardinality(p_stages) > 0
    AND (SELECT count(*) FROM supplied) = (SELECT count(DISTINCT stage) FROM supplied)
    AND NOT EXISTS (
      SELECT 1 FROM supplied
      LEFT JOIN canonical USING (stage)
      WHERE canonical.stage IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
        FROM supplied AS left_stage
        JOIN supplied AS right_stage ON left_stage.ordinal < right_stage.ordinal
        JOIN canonical AS left_canonical ON left_canonical.stage = left_stage.stage
        JOIN canonical AS right_canonical ON right_canonical.stage = right_stage.stage
       WHERE left_canonical.position >= right_canonical.position
    );
$$;

CREATE TABLE public.significant_operations (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key = pg_catalog.btrim(idempotency_key)
    AND pg_catalog.char_length(idempotency_key) BETWEEN 1 AND 200
  ),
  domain TEXT NOT NULL CHECK (pg_catalog.char_length(domain) BETWEEN 1 AND 80),
  action TEXT NOT NULL CHECK (pg_catalog.char_length(action) BETWEEN 1 AND 160),
  actor_type TEXT NOT NULL CHECK (actor_type IN (
    'owner', 'administrator', 'moderator', 'finance', 'support', 'system', 'customer'
  )),
  actor_id TEXT NOT NULL CHECK (pg_catalog.char_length(actor_id) BETWEEN 1 AND 160),
  source_surface TEXT NOT NULL CHECK (source_surface IN (
    'dashboard', 'discord', 'launcher', 'portal', 'sdk', 'system'
  )),
  lifecycle_stages TEXT[] NOT NULL CHECK (public.operation_lifecycle_is_canonical(lifecycle_stages)),
  current_stage TEXT NOT NULL,
  recovery_strategy TEXT NOT NULL CHECK (recovery_strategy IN ('none', 'rollback', 'compensation')),
  outcome TEXT NOT NULL DEFAULT 'active' CHECK (outcome IN (
    'active', 'completed', 'failed', 'recovering', 'rolled_back', 'compensated', 'forward_fixed'
  )),
  request_payload JSONB NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  conflicts JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(conflicts) = 'array'),
  blast_radius JSONB NOT NULL DEFAULT '{"resources":[],"reversibility":"reversible"}'::JSONB
    CHECK (jsonb_typeof(blast_radius) = 'object'),
  external_effects JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(external_effects) = 'array'),
  readback JSONB,
  audit_evidence JSONB,
  recovery_evidence JSONB,
  recovery_outcome TEXT CHECK (recovery_outcome IN ('rolled_back', 'compensated', 'forward_fixed')),
  failure_code TEXT,
  configuration_generation BIGINT CHECK (configuration_generation IS NULL OR configuration_generation >= 0),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  UNIQUE (guild_id, source_surface, idempotency_key),
  CHECK (current_stage = ANY(lifecycle_stages)),
  CHECK ((outcome = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE public.operation_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id UUID NOT NULL REFERENCES public.significant_operations(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence >= 0),
  stage TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'prepared', 'stage_completed', 'conflict_detected', 'stage_retry',
    'failed', 'recovery_started', 'rolled_back', 'compensated', 'forward_fixed'
  )),
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(evidence) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operation_id, sequence)
);

CREATE TABLE public.configuration_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL UNIQUE REFERENCES public.significant_operations(id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  config_domain TEXT NOT NULL CHECK (pg_catalog.char_length(config_domain) BETWEEN 1 AND 80),
  base_revision BIGINT NOT NULL CHECK (base_revision >= 0),
  target_revision BIGINT NOT NULL CHECK (target_revision > base_revision),
  base_snapshot JSONB NOT NULL CHECK (jsonb_typeof(base_snapshot) = 'object'),
  target_snapshot JSONB NOT NULL CHECK (jsonb_typeof(target_snapshot) = 'object'),
  config_diff JSONB NOT NULL CHECK (jsonb_typeof(config_diff) = 'array'),
  validation JSONB NOT NULL CHECK (
    jsonb_typeof(validation) = 'object'
    AND validation @> '{"valid":true}'::JSONB
  ),
  recovery_kind TEXT NOT NULL CHECK (recovery_kind IN ('rollback', 'compensation', 'forward_fix')),
  recovery_payload JSONB NOT NULL CHECK (jsonb_typeof(recovery_payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN (
    'prepared', 'applied', 'read_back', 'rolled_back', 'compensated', 'forward_fixed'
  )),
  readback JSONB CHECK (readback IS NULL OR jsonb_typeof(readback) = 'object'),
  recovered_readback JSONB CHECK (recovered_readback IS NULL OR jsonb_typeof(recovered_readback) = 'object'),
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (guild_id, config_domain, target_revision)
);

CREATE INDEX significant_operations_guild_updated_idx
  ON public.significant_operations (guild_id, updated_at DESC);
CREATE INDEX significant_operations_active_idx
  ON public.significant_operations (guild_id, current_stage, updated_at DESC)
  WHERE outcome = 'active';
CREATE INDEX configuration_releases_guild_domain_idx
  ON public.configuration_releases (guild_id, config_domain, target_revision DESC);

CREATE OR REPLACE FUNCTION public.prepare_significant_operation(
  p_operation_id UUID,
  p_guild_id TEXT,
  p_source_surface TEXT,
  p_idempotency_key TEXT,
  p_domain TEXT,
  p_action TEXT,
  p_actor_type TEXT,
  p_actor_id TEXT,
  p_lifecycle_stages TEXT[],
  p_recovery_strategy TEXT,
  p_request_payload JSONB,
  p_configuration_generation BIGINT DEFAULT NULL
)
RETURNS SETOF public.significant_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.significant_operations%ROWTYPE;
  v_lock_key TEXT;
BEGIN
  IF p_operation_id IS NULL OR p_guild_id IS NULL OR p_idempotency_key IS NULL
     OR p_request_payload IS NULL OR NOT public.operation_lifecycle_is_canonical(p_lifecycle_stages) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'significant operation: complete valid identity is required';
  END IF;

  v_lock_key := p_guild_id || ':' || p_source_surface || ':' || p_idempotency_key;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key, 0));

  SELECT operation.* INTO v_operation
    FROM public.significant_operations AS operation
   WHERE operation.guild_id = p_guild_id
     AND operation.source_surface = p_source_surface
     AND operation.idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF v_operation.id IS NULL THEN
    INSERT INTO public.significant_operations (
      id, guild_id, source_surface, idempotency_key, domain, action,
      actor_type, actor_id, lifecycle_stages, current_stage,
      recovery_strategy, request_payload, configuration_generation
    ) VALUES (
      p_operation_id, p_guild_id, p_source_surface, p_idempotency_key, p_domain, p_action,
      p_actor_type, p_actor_id, p_lifecycle_stages, p_lifecycle_stages[1],
      p_recovery_strategy, p_request_payload, p_configuration_generation
    ) RETURNING * INTO v_operation;

    INSERT INTO public.operation_events (operation_id, sequence, stage, event_type, evidence)
    VALUES (v_operation.id, 0, v_operation.current_stage, 'prepared', '{}'::JSONB);
  ELSIF v_operation.domain IS DISTINCT FROM p_domain
     OR v_operation.action IS DISTINCT FROM p_action
     OR v_operation.actor_type IS DISTINCT FROM p_actor_type
     OR v_operation.actor_id IS DISTINCT FROM p_actor_id
     OR v_operation.lifecycle_stages IS DISTINCT FROM p_lifecycle_stages
     OR v_operation.recovery_strategy IS DISTINCT FROM p_recovery_strategy
     OR v_operation.request_payload IS DISTINCT FROM p_request_payload
     OR v_operation.configuration_generation IS DISTINCT FROM p_configuration_generation THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'significant operation: idempotency intent mismatch';
  END IF;

  RETURN NEXT v_operation;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_significant_operation(
  p_operation_id UUID,
  p_expected_revision BIGINT,
  p_completed_stage TEXT,
  p_evidence JSONB,
  p_conflicts JSONB DEFAULT NULL,
  p_blast_radius JSONB DEFAULT NULL,
  p_external_effects JSONB DEFAULT NULL,
  p_readback JSONB DEFAULT NULL,
  p_audit_evidence JSONB DEFAULT NULL
)
RETURNS SETOF public.significant_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.significant_operations%ROWTYPE;
  v_position INTEGER;
  v_next_stage TEXT;
  v_blocked BOOLEAN;
BEGIN
  SELECT operation.* INTO v_operation
    FROM public.significant_operations AS operation
   WHERE operation.id = p_operation_id
   FOR UPDATE;

  IF v_operation.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'significant operation: not found';
  END IF;
  IF v_operation.revision = p_expected_revision + 1
     AND EXISTS (
       SELECT 1 FROM public.operation_events AS event
        WHERE event.operation_id = p_operation_id
          AND event.sequence = v_operation.revision
          AND event.stage = p_completed_stage
          AND event.evidence = COALESCE(p_evidence, '{}'::JSONB)
     )
     AND (p_conflicts IS NULL OR v_operation.conflicts = p_conflicts)
     AND (p_blast_radius IS NULL OR v_operation.blast_radius = p_blast_radius)
     AND (p_external_effects IS NULL OR v_operation.external_effects = p_external_effects)
     AND (p_readback IS NULL OR v_operation.readback = p_readback)
     AND (p_audit_evidence IS NULL OR v_operation.audit_evidence = p_audit_evidence) THEN
    RETURN NEXT v_operation;
    RETURN;
  END IF;
  IF v_operation.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'significant operation: stale revision';
  END IF;
  IF (p_evidence IS NOT NULL AND jsonb_typeof(p_evidence) <> 'object')
     OR (p_conflicts IS NOT NULL AND jsonb_typeof(p_conflicts) <> 'array')
     OR (p_blast_radius IS NOT NULL AND jsonb_typeof(p_blast_radius) <> 'object')
     OR (p_external_effects IS NOT NULL AND jsonb_typeof(p_external_effects) <> 'array')
     OR (p_readback IS NOT NULL AND jsonb_typeof(p_readback) <> 'object')
     OR (p_audit_evidence IS NOT NULL AND jsonb_typeof(p_audit_evidence) <> 'object') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'significant operation: invalid lifecycle evidence';
  END IF;
  IF v_operation.outcome <> 'active' OR v_operation.current_stage IS DISTINCT FROM p_completed_stage THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'significant operation: invalid stage transition';
  END IF;

  v_blocked := p_completed_stage = 'conflict_checked'
    AND p_conflicts IS NOT NULL
    AND pg_catalog.jsonb_path_exists(p_conflicts, '$[*] ? (@.blocking == true)');
  v_position := pg_catalog.array_position(v_operation.lifecycle_stages, p_completed_stage);
  v_next_stage := v_operation.lifecycle_stages[v_position + 1];

  UPDATE public.significant_operations
     SET current_stage = CASE WHEN v_blocked OR v_next_stage IS NULL THEN current_stage ELSE v_next_stage END,
         outcome = CASE WHEN NOT v_blocked AND v_next_stage IS NULL THEN 'completed' ELSE outcome END,
         conflicts = COALESCE(p_conflicts, conflicts),
         blast_radius = COALESCE(p_blast_radius, blast_radius),
         external_effects = COALESCE(p_external_effects, external_effects),
         readback = COALESCE(p_readback, readback),
         audit_evidence = COALESCE(p_audit_evidence, audit_evidence),
         revision = revision + 1,
         updated_at = clock_timestamp(),
         completed_at = CASE WHEN NOT v_blocked AND v_next_stage IS NULL THEN clock_timestamp() ELSE NULL END
   WHERE id = p_operation_id
   RETURNING * INTO v_operation;

  INSERT INTO public.operation_events (operation_id, sequence, stage, event_type, evidence)
  VALUES (
    v_operation.id,
    v_operation.revision,
    p_completed_stage,
    CASE WHEN v_blocked THEN 'conflict_detected' ELSE 'stage_completed' END,
    COALESCE(p_evidence, '{}'::JSONB)
  );
  RETURN NEXT v_operation;
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_significant_operation(
  p_operation_id UUID,
  p_expected_revision BIGINT,
  p_recovery_outcome TEXT,
  p_recovery_evidence JSONB
)
RETURNS SETOF public.significant_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.significant_operations%ROWTYPE;
BEGIN
  SELECT operation.* INTO v_operation
    FROM public.significant_operations AS operation
   WHERE operation.id = p_operation_id
   FOR UPDATE;

  IF v_operation.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'significant operation: not found';
  END IF;
  IF v_operation.revision = p_expected_revision + 1
     AND v_operation.recovery_outcome = p_recovery_outcome
     AND v_operation.recovery_evidence = p_recovery_evidence THEN
    RETURN NEXT v_operation;
    RETURN;
  END IF;
  IF v_operation.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'significant operation: stale revision';
  END IF;
  IF p_recovery_evidence IS NULL OR jsonb_typeof(p_recovery_evidence) <> 'object'
     OR p_recovery_outcome NOT IN ('rolled_back', 'compensated', 'forward_fixed')
     OR v_operation.recovery_strategy = 'none'
     OR (v_operation.outcome NOT IN ('active', 'failed', 'completed'))
     OR (v_operation.outcome <> 'completed' AND v_operation.current_stage NOT IN ('committed', 'executed', 'read_back', 'audited'))
     OR (v_operation.recovery_strategy = 'rollback' AND p_recovery_outcome <> 'rolled_back')
     OR (v_operation.recovery_strategy = 'compensation' AND p_recovery_outcome = 'rolled_back') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'significant operation: invalid recovery outcome';
  END IF;

  UPDATE public.significant_operations
     SET outcome = p_recovery_outcome,
         recovery_outcome = p_recovery_outcome,
         recovery_evidence = p_recovery_evidence,
         revision = revision + 1,
         updated_at = clock_timestamp(),
         completed_at = NULL
   WHERE id = p_operation_id
   RETURNING * INTO v_operation;

  INSERT INTO public.operation_events (operation_id, sequence, stage, event_type, evidence)
  VALUES (v_operation.id, v_operation.revision, v_operation.current_stage, p_recovery_outcome, p_recovery_evidence);
  RETURN NEXT v_operation;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_significant_operation_failure(
  p_operation_id UUID,
  p_expected_revision BIGINT,
  p_failure_code TEXT,
  p_retryable BOOLEAN,
  p_evidence JSONB
)
RETURNS SETOF public.significant_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.significant_operations%ROWTYPE;
BEGIN
  SELECT operation.* INTO v_operation
    FROM public.significant_operations AS operation
   WHERE operation.id = p_operation_id
   FOR UPDATE;
  IF v_operation.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'significant operation: not found';
  END IF;
  IF v_operation.revision = p_expected_revision + 1
     AND v_operation.failure_code = p_failure_code
     AND EXISTS (
       SELECT 1 FROM public.operation_events AS event
        WHERE event.operation_id = p_operation_id
          AND event.sequence = v_operation.revision
          AND event.event_type = CASE WHEN p_retryable THEN 'stage_retry' ELSE 'failed' END
          AND event.evidence = p_evidence
     ) THEN
    RETURN NEXT v_operation;
    RETURN;
  END IF;
  IF v_operation.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'significant operation: stale revision';
  END IF;
  IF v_operation.outcome <> 'active' OR p_failure_code IS NULL OR pg_catalog.btrim(p_failure_code) = ''
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'significant operation: invalid failure transition';
  END IF;

  UPDATE public.significant_operations
     SET outcome = CASE WHEN p_retryable THEN outcome ELSE 'failed' END,
         failure_code = p_failure_code,
         revision = revision + 1,
         updated_at = clock_timestamp()
   WHERE id = p_operation_id
   RETURNING * INTO v_operation;
  INSERT INTO public.operation_events (operation_id, sequence, stage, event_type, evidence)
  VALUES (
    v_operation.id, v_operation.revision, v_operation.current_stage,
    CASE WHEN p_retryable THEN 'stage_retry' ELSE 'failed' END,
    p_evidence
  );
  RETURN NEXT v_operation;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_configuration_release(
  p_operation_id UUID,
  p_guild_id TEXT,
  p_config_domain TEXT,
  p_base_revision BIGINT,
  p_target_revision BIGINT,
  p_base_snapshot JSONB,
  p_target_snapshot JSONB,
  p_config_diff JSONB,
  p_validation JSONB,
  p_recovery_kind TEXT,
  p_recovery_payload JSONB
)
RETURNS SETOF public.configuration_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.significant_operations%ROWTYPE;
  v_release public.configuration_releases%ROWTYPE;
BEGIN
  SELECT operation.* INTO v_operation
    FROM public.significant_operations AS operation
   WHERE operation.id = p_operation_id
   FOR UPDATE;
  IF v_operation.id IS NULL OR v_operation.guild_id IS DISTINCT FROM p_guild_id
     OR v_operation.outcome <> 'active'
     OR v_operation.current_stage NOT IN ('previewed', 'committed') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'configuration release: operation is not ready';
  END IF;

  SELECT release.* INTO v_release
    FROM public.configuration_releases AS release
   WHERE release.operation_id = p_operation_id
   FOR UPDATE;
  IF v_release.id IS NULL THEN
    INSERT INTO public.configuration_releases (
      operation_id, guild_id, config_domain, base_revision, target_revision,
      base_snapshot, target_snapshot, config_diff, validation, recovery_kind, recovery_payload
    ) VALUES (
      p_operation_id, p_guild_id, p_config_domain, p_base_revision, p_target_revision,
      p_base_snapshot, p_target_snapshot, p_config_diff, p_validation, p_recovery_kind, p_recovery_payload
    ) RETURNING * INTO v_release;
  ELSIF v_release.guild_id IS DISTINCT FROM p_guild_id
     OR v_release.config_domain IS DISTINCT FROM p_config_domain
     OR v_release.base_revision IS DISTINCT FROM p_base_revision
     OR v_release.target_revision IS DISTINCT FROM p_target_revision
     OR v_release.base_snapshot IS DISTINCT FROM p_base_snapshot
     OR v_release.target_snapshot IS DISTINCT FROM p_target_snapshot
     OR v_release.config_diff IS DISTINCT FROM p_config_diff
     OR v_release.validation IS DISTINCT FROM p_validation
     OR v_release.recovery_kind IS DISTINCT FROM p_recovery_kind
     OR v_release.recovery_payload IS DISTINCT FROM p_recovery_payload THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'configuration release: immutable intent mismatch';
  END IF;
  RETURN NEXT v_release;
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_configuration_release(
  p_operation_id UUID,
  p_expected_operation_revision BIGINT
)
RETURNS SETOF public.configuration_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.significant_operations%ROWTYPE;
  v_release public.configuration_releases%ROWTYPE;
BEGIN
  SELECT operation.* INTO v_operation
    FROM public.significant_operations AS operation
   WHERE operation.id = p_operation_id
   FOR UPDATE;
  IF v_operation.id IS NULL OR v_operation.revision IS DISTINCT FROM p_expected_operation_revision
     OR v_operation.outcome <> 'active' OR v_operation.current_stage <> 'executed' THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'configuration release: operation commit is stale';
  END IF;
  UPDATE public.configuration_releases
     SET activated_at = COALESCE(activated_at, clock_timestamp()),
         status = CASE WHEN status = 'prepared' THEN 'applied' ELSE status END
   WHERE operation_id = p_operation_id
   RETURNING * INTO v_release;
  IF v_release.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'configuration release: not found';
  END IF;
  RETURN NEXT v_release;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_configuration_release_readback(
  p_operation_id UUID,
  p_readback JSONB
)
RETURNS SETOF public.configuration_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_release public.configuration_releases%ROWTYPE;
BEGIN
  IF p_readback IS NULL OR pg_catalog.jsonb_typeof(p_readback) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'configuration release: object readback is required';
  END IF;
  UPDATE public.configuration_releases
     SET readback = p_readback,
         status = 'read_back'
   WHERE operation_id = p_operation_id
     AND status IN ('applied', 'read_back')
     AND target_snapshot = p_readback
   RETURNING * INTO v_release;
  IF v_release.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'configuration release: authoritative readback mismatch';
  END IF;
  RETURN NEXT v_release;
END;
$$;

ALTER TABLE public.significant_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.configuration_releases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.significant_operations, public.operation_events, public.configuration_releases
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.significant_operations, public.configuration_releases TO service_role;
GRANT SELECT, INSERT ON public.operation_events TO service_role;

REVOKE ALL ON FUNCTION public.operation_lifecycle_is_canonical(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_significant_operation(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, JSONB, BIGINT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.advance_significant_operation(UUID, BIGINT, TEXT, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recover_significant_operation(UUID, BIGINT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_significant_operation_failure(UUID, BIGINT, TEXT, BOOLEAN, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_configuration_release(UUID, TEXT, TEXT, BIGINT, BIGINT, JSONB, JSONB, JSONB, JSONB, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.activate_configuration_release(UUID, BIGINT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_configuration_release_readback(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.operation_lifecycle_is_canonical(TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_significant_operation(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, JSONB, BIGINT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_significant_operation(UUID, BIGINT, TEXT, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_significant_operation(UUID, BIGINT, TEXT, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_significant_operation_failure(UUID, BIGINT, TEXT, BOOLEAN, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_configuration_release(UUID, TEXT, TEXT, BIGINT, BIGINT, JSONB, JSONB, JSONB, JSONB, TEXT, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_configuration_release(UUID, BIGINT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_configuration_release_readback(UUID, JSONB)
  TO service_role;

COMMENT ON TABLE public.significant_operations IS
  'Universal trace identities for consequential operations; simple preference changes do not use this lifecycle.';
COMMENT ON TABLE public.operation_events IS
  'Append-only lifecycle, retry, conflict, readback, audit, and recovery evidence for a significant operation.';
COMMENT ON TABLE public.configuration_releases IS
  'Authoritative versioned before/after snapshots, machine-readable diffs, validation, readback, and recovery points for significant configuration changes.';
