ALTER TABLE public.dashboard_adoption_verifications
  DROP CONSTRAINT dashboard_adoption_verifications_track_id_check;

ALTER TABLE public.dashboard_adoption_verifications
  ADD CONSTRAINT dashboard_adoption_verifications_track_id_check CHECK (track_id IN (
    'core', 'structure', 'moderation', 'welcome', 'community', 'economy', 'games',
    'music', 'automation', 'store', 'licensing', 'staff', 'recovery'
  ));

CREATE OR REPLACE FUNCTION public.publish_dashboard_adoption_map(
  p_operation_id UUID,
  p_guild_id TEXT,
  p_actor_id TEXT,
  p_idempotency_key TEXT,
  p_state JSONB,
  p_server_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_known_tracks CONSTANT TEXT[] := ARRAY[
    'core', 'structure', 'moderation', 'welcome', 'community', 'economy', 'games',
    'music', 'automation', 'store', 'licensing', 'staff', 'recovery'
  ]::TEXT[];
  v_selected TEXT[];
  v_verified TEXT[];
  v_base_revision BIGINT;
  v_target_revision BIGINT;
  v_base JSONB;
  v_target JSONB;
  v_readback JSONB;
  v_operation public.significant_operations%ROWTYPE;
  v_release public.configuration_releases%ROWTYPE;
  v_track RECORD;
  v_previous_states JSONB;
BEGIN
  PERFORM 1 FROM public.guild WHERE id = p_guild_id AND owner_discord_id = p_actor_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'adoption map: owner required';
  END IF;
  SELECT track_states INTO v_previous_states FROM public.dashboard_adoption_maps WHERE guild_id = p_guild_id FOR UPDATE;
  IF p_state IS NULL OR jsonb_typeof(p_state) <> 'object'
     OR p_state->>'mode' NOT IN ('guided', 'expert')
     OR jsonb_typeof(p_state->'tutorialVisible') <> 'boolean'
     OR jsonb_typeof(p_state->'selectedTrackIds') <> 'array'
     OR jsonb_typeof(p_state->'trackStates') <> 'object'
     OR p_state ? 'verifiedTrackIds' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'adoption map: invalid owner-controlled state';
  END IF;

  SELECT pg_catalog.array_agg(value ORDER BY ordinal)
    INTO v_selected
    FROM jsonb_array_elements_text(p_state->'selectedTrackIds') WITH ORDINALITY AS selected(value, ordinal);
  v_selected := COALESCE(v_selected, ARRAY[]::TEXT[]);
  IF NOT ARRAY['core', 'recovery']::TEXT[] <@ v_selected
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_selected) AS item(value) WHERE NOT item.value = ANY(v_known_tracks))
     OR pg_catalog.cardinality(v_selected) <> (SELECT count(DISTINCT value) FROM pg_catalog.unnest(v_selected) AS item(value)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'adoption map: required, unique, known tracks are required';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(verification->>'trackId'), ARRAY[]::TEXT[])
    INTO v_verified
    FROM jsonb_array_elements(public.read_dashboard_adoption_verifications(p_guild_id, p_server_context)) AS verification
   WHERE verification->>'eligible' = 'true';

  FOR v_track IN SELECT key, value FROM jsonb_each_text(p_state->'trackStates') LOOP
    IF NOT v_track.key = ANY(v_known_tracks)
       OR v_track.value NOT IN ('not_started', 'in_progress', 'ready', 'active', 'paused', 'skipped')
       OR (v_track.key IN ('core', 'recovery') AND v_track.value = 'skipped')
       OR (v_track.value = 'active' AND COALESCE(v_previous_states->>v_track.key, '') <> 'active' AND NOT v_track.key = ANY(v_verified))
       OR (v_track.value = 'active' AND v_track.key <> ALL(v_selected)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'adoption map: invalid or unverified track state';
    END IF;
  END LOOP;
  IF p_state->'trackStates'->>'recovery' = 'active' AND p_state->'trackStates'->>'core' IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'adoption map: recovery requires active core';
  END IF;
  IF p_state->'trackStates'->>'licensing' = 'active' AND p_state->'trackStates'->>'store' IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'adoption map: licensing requires active store';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each_text(p_state->'trackStates') AS track(key, value)
     WHERE track.value = 'active'
       AND track.key NOT IN ('core', 'recovery', 'licensing')
       AND p_state->'trackStates'->>'core' IS DISTINCT FROM 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'adoption map: feature tracks require active core';
  END IF;

  SELECT operation.* INTO v_operation
    FROM public.significant_operations AS operation
   WHERE operation.guild_id = p_guild_id
     AND operation.source_surface = 'dashboard'
     AND operation.idempotency_key = p_idempotency_key;
  IF v_operation.id IS NOT NULL THEN
    IF v_operation.action IS DISTINCT FROM 'dashboard.adoption_map.publish'
       OR v_operation.actor_id IS DISTINCT FROM p_actor_id
       OR v_operation.request_payload IS DISTINCT FROM p_state THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'adoption map: idempotency intent mismatch';
    END IF;
    IF v_operation.outcome <> 'completed' THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'adoption map: prior publication is incomplete';
    END IF;
    SELECT * INTO v_release FROM public.configuration_releases WHERE operation_id = v_operation.id;
    RETURN jsonb_build_object(
      'state', v_operation.readback,
      'updatedAt', v_operation.completed_at,
      'revision', v_release.target_revision,
      'operationId', v_operation.id,
      'releaseId', v_release.id
    );
  END IF;

  SELECT adoption.revision,
         jsonb_build_object(
           'mode', adoption.mode,
           'tutorialVisible', adoption.tutorial_visible,
           'selectedTrackIds', to_jsonb(adoption.selected_track_ids),
           'trackStates', adoption.track_states
         )
    INTO v_base_revision, v_base
    FROM public.dashboard_adoption_maps AS adoption
   WHERE adoption.guild_id = p_guild_id
   FOR UPDATE;
  v_base_revision := COALESCE(v_base_revision, 0);
  v_base := COALESCE(v_base, '{"mode":"guided","tutorialVisible":true,"selectedTrackIds":["core","recovery"],"trackStates":{}}'::JSONB);
  v_target_revision := v_base_revision + 1;
  v_target := p_state;

  SELECT * INTO v_operation FROM public.prepare_significant_operation(
    p_operation_id, p_guild_id, 'dashboard', p_idempotency_key,
    'dashboard_adoption', 'dashboard.adoption_map.publish', 'owner', p_actor_id,
    ARRAY['validated', 'conflict_checked', 'previewed', 'committed', 'executed', 'read_back', 'audited']::TEXT[],
    'rollback', p_state, v_target_revision
  );
  PERFORM * FROM public.advance_significant_operation(v_operation.id, 0, 'validated', '{"schema":"pass","authority":"dashboard"}'::JSONB);
  PERFORM * FROM public.advance_significant_operation(
    v_operation.id, 1, 'conflict_checked', '{"dependency_check":"pass"}'::JSONB,
    '[]'::JSONB,
    jsonb_build_object('resources', jsonb_build_array(jsonb_build_object('kind', 'dashboard_adoption_map', 'id', p_guild_id)), 'reversibility', 'reversible')
  );
  SELECT * INTO v_release FROM public.prepare_configuration_release(
    v_operation.id, p_guild_id, 'dashboard_adoption', v_base_revision, v_target_revision,
    v_base, v_target,
    jsonb_build_array(jsonb_build_object('path', '$', 'kind', 'changed', 'before', v_base, 'after', v_target)),
    '{"valid":true,"errors":[]}'::JSONB,
    'rollback', v_base
  );
  PERFORM * FROM public.advance_significant_operation(v_operation.id, 2, 'previewed', jsonb_build_object('release_id', v_release.id, 'diff', v_release.config_diff));
  PERFORM * FROM public.advance_significant_operation(v_operation.id, 3, 'committed', jsonb_build_object('target_revision', v_target_revision));

  INSERT INTO public.dashboard_adoption_maps (
    guild_id, mode, tutorial_visible, selected_track_ids, track_states, revision, updated_by, updated_at
  ) VALUES (
    p_guild_id, p_state->>'mode', (p_state->>'tutorialVisible')::BOOLEAN,
    v_selected, p_state->'trackStates', v_target_revision, p_actor_id, clock_timestamp()
  ) ON CONFLICT (guild_id) DO UPDATE SET
    mode = EXCLUDED.mode,
    tutorial_visible = EXCLUDED.tutorial_visible,
    selected_track_ids = EXCLUDED.selected_track_ids,
    track_states = EXCLUDED.track_states,
    revision = EXCLUDED.revision,
    updated_by = EXCLUDED.updated_by,
    updated_at = EXCLUDED.updated_at
  WHERE public.dashboard_adoption_maps.revision = v_base_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'adoption map: stale configuration revision';
  END IF;

  SELECT * INTO v_release FROM public.activate_configuration_release(v_operation.id, 4);
  PERFORM * FROM public.advance_significant_operation(
    v_operation.id, 4, 'executed', jsonb_build_object('release_id', v_release.id),
    NULL, NULL, jsonb_build_array(jsonb_build_object('kind', 'database', 'status', 'applied'))
  );
  SELECT jsonb_build_object(
           'mode', adoption.mode,
           'tutorialVisible', adoption.tutorial_visible,
           'selectedTrackIds', to_jsonb(adoption.selected_track_ids),
           'verifiedTrackIds', to_jsonb(v_verified),
           'trackStates', adoption.track_states
         )
    INTO v_readback
    FROM public.dashboard_adoption_maps AS adoption
   WHERE adoption.guild_id = p_guild_id AND adoption.revision = v_target_revision;
  IF (v_readback - 'verifiedTrackIds') IS DISTINCT FROM v_target THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'adoption map: authoritative readback mismatch';
  END IF;
  PERFORM * FROM public.record_configuration_release_readback(v_operation.id, v_target);
  PERFORM * FROM public.advance_significant_operation(v_operation.id, 5, 'read_back', '{"authoritative":"pass"}'::JSONB, NULL, NULL, NULL, v_readback);

  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, category, action, target_type, target_id,
    success, correlation_id, details
  ) VALUES (
    p_guild_id, 'dashboard', p_actor_id, 'configuration', 'dashboard.adoption_map.published',
    'dashboard_adoption_map', p_guild_id, true, v_operation.id,
    jsonb_build_object('operation_id', v_operation.id, 'release_id', v_release.id, 'revision', v_target_revision)
  );
  PERFORM * FROM public.advance_significant_operation(
    v_operation.id, 6, 'audited', '{"audit":"persisted"}'::JSONB,
    NULL, NULL, NULL, NULL, jsonb_build_object('operation_id', v_operation.id)
  );

  RETURN jsonb_build_object(
    'state', v_readback,
    'updatedAt', (SELECT updated_at FROM public.dashboard_adoption_maps WHERE guild_id = p_guild_id),
    'revision', v_target_revision,
    'operationId', v_operation.id,
    'releaseId', v_release.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_dashboard_adoption_map(
  p_operation_id UUID, p_guild_id TEXT, p_actor_id TEXT, p_idempotency_key TEXT, p_state JSONB
) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.publish_dashboard_adoption_map(p_operation_id, p_guild_id, p_actor_id, p_idempotency_key, p_state, NULL::JSONB);
$$;
REVOKE ALL ON FUNCTION public.publish_dashboard_adoption_map(UUID,TEXT,TEXT,TEXT,JSONB,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_dashboard_adoption_map(UUID,TEXT,TEXT,TEXT,JSONB,JSONB) TO service_role;
