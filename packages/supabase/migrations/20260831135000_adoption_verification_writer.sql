ALTER TABLE public.dashboard_adoption_verifications
  ADD COLUMN check_sequence BIGINT GENERATED ALWAYS AS IDENTITY;

CREATE INDEX dashboard_adoption_verifications_latest_idx
  ON public.dashboard_adoption_verifications (guild_id, track_id, check_sequence DESC);

CREATE OR REPLACE FUNCTION public.observe_dashboard_adoption_track(p_guild_id TEXT, p_track_id TEXT, p_server_context JSONB DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_config public.guild_config%ROWTYPE;
  v_health public.bot_diagnostics%ROWTYPE;
  v_boot public.audit_logs%ROWTYPE;
  v_action public.audit_logs%ROWTYPE;
  v_actions TEXT[];
  v_required TEXT[] := ARRAY[]::TEXT[];
  v_seen TEXT[] := ARRAY[]::TEXT[];
  v_ids JSONB := '[]'::JSONB;
  v_identity TEXT;
  v_result TEXT := 'unknown';
  v_reason TEXT := 'Runtime proof has not been recorded.';
  v_complete BOOLEAN := false;
  v_since TIMESTAMPTZ;
  v_expiry TIMESTAMPTZ;
  v_epoch public.dashboard_adoption_config_epochs%ROWTYPE;
  v_failure_at TIMESTAMPTZ;
  v_success_at TIMESTAMPTZ;
  v_required_success_at TIMESTAMPTZ;
  v_required_times JSONB := '{}'::JSONB;
  v_schema_at TIMESTAMPTZ;
  v_launch JSONB;
  v_staff JSONB;
  v_recovery JSONB;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_config FROM public.guild_config WHERE guild_id = p_guild_id FOR SHARE;
  SELECT * INTO v_health FROM public.bot_diagnostics WHERE guild_id = p_guild_id AND type = 'health' FOR SHARE;
  IF p_track_id IN ('store','licensing','staff') THEN
    SELECT * INTO v_epoch FROM public.dashboard_adoption_config_epochs WHERE guild_id = p_guild_id AND track_id = p_track_id;
  ELSE
    SELECT * INTO v_epoch FROM public.dashboard_adoption_config_epochs WHERE guild_id = p_guild_id AND track_id = p_track_id FOR SHARE;
  END IF;
  SELECT * INTO v_boot FROM public.audit_logs
    WHERE guild_id = p_guild_id AND action = 'bot.started'
    ORDER BY timestamp DESC, id DESC LIMIT 1;
  SELECT applied_at INTO v_schema_at FROM public.schema_migrations WHERE success IS TRUE ORDER BY applied_at DESC, filename DESC LIMIT 1;
  v_identity := md5(jsonb_build_object('config', public.adoption_track_configuration(to_jsonb(v_config), p_track_id),
    'revision', COALESCE(v_epoch.revision, 0), 'boot', v_health.boot_id,
    'migration', (SELECT filename FROM public.schema_migrations WHERE success IS TRUE ORDER BY applied_at DESC, filename DESC LIMIT 1))::TEXT);
  v_since := GREATEST(v_epoch.changed_at, v_schema_at, v_boot.timestamp, v_now - INTERVAL '24 hours');
  v_expiry := LEAST(v_health.snapshot_at + INTERVAL '5 minutes', v_now + INTERVAL '5 minutes');
  CASE p_track_id
    WHEN 'core' THEN
      v_actions := ARRAY['bot.started']; v_complete := true;
    WHEN 'structure' THEN
      v_actions := ARRAY['setup.deployed', 'sync.completed', 'sync.failed'];
      v_complete := true;
    WHEN 'moderation' THEN
      v_actions := ARRAY['mute.applied', 'kick.executed', 'ban.executed'];
      v_complete := true;
    WHEN 'welcome' THEN
      v_actions := ARRAY['member.verified','welcome.delivery_succeeded:channel','welcome.delivery_succeeded:dm','welcome.test_delivery_succeeded','welcome.delivery_failed','welcome.member_role_grant_failed'];
      v_complete := true;
      IF v_config.onboarding_enabled THEN v_required := array_append(v_required, 'member.verified'); END IF;
      IF v_config.welcome_enabled THEN v_required := array_append(v_required, 'welcome.delivery_succeeded:channel'); END IF;
      IF v_config.welcome_dm_enabled THEN v_required := array_append(v_required, 'welcome.delivery_succeeded:dm'); END IF;
      IF cardinality(v_required) = 0 THEN v_complete := false; v_reason := 'Enable a welcome or onboarding path before checking delivery proof.'; END IF;
    WHEN 'community' THEN
      IF v_config.levels_enabled THEN v_required := array_append(v_required, 'level.up'); END IF;
      IF EXISTS (SELECT 1 FROM public.giveaways WHERE guild_id = p_guild_id) THEN v_required := array_append(v_required, 'giveaway.ended'); END IF;
      IF EXISTS (SELECT 1 FROM public.scheduled_messages WHERE guild_id = p_guild_id AND active) THEN v_required := array_append(v_required, 'scheduled_message.sent'); END IF;
      IF EXISTS (SELECT 1 FROM public.reaction_roles WHERE guild_id = p_guild_id) OR EXISTS (SELECT 1 FROM public.button_roles WHERE guild_id = p_guild_id AND active) THEN
        v_required := array_append(v_required, 'member.role_granted');
      END IF;
      v_actions := v_required;
      IF 'giveaway.ended' = ANY(v_required) THEN v_actions := array_append(v_actions, 'giveaway.failed'); END IF;
      IF 'scheduled_message.sent' = ANY(v_required) THEN v_actions := array_append(v_actions, 'scheduled_message.delivery_failed'); END IF;
      v_complete := cardinality(v_required) > 0;
      IF NOT v_complete THEN v_reason := 'Configure a community feature before checking its runtime action.'; END IF;
    WHEN 'economy' THEN
      v_actions := ARRAY['economy.reward_claimed', 'economy.reward_failed', 'craft.completed', 'craft.failed', 'market.bought'];
      v_complete := v_config.economy_enabled;
    WHEN 'games' THEN
      v_actions := ARRAY[]::TEXT[]; v_complete := true;
      IF v_config.economy_games_enabled THEN v_required := array_append(v_required, 'casino.bet_settled'); v_actions := array_append(v_actions, 'casino.bet_settled'); END IF;
      IF v_config.economy_lottery_enabled THEN v_required := array_append(v_required, 'lottery.drawn'); v_actions := v_actions || ARRAY['lottery.drawn','lottery.payout_failed']; END IF;
      IF cardinality(v_required) = 0 OR NOT v_config.economy_enabled THEN
        v_complete := false; v_reason := 'Enable mini-games or lottery and the coin economy before checking runtime proof.';
      END IF;
    WHEN 'music' THEN
      v_actions := ARRAY['music.queued', 'music.control_applied', 'music.recovery_succeeded', 'music.runtime_outage', 'music.recovery_failed'];
      v_required := ARRAY['music.queued','music.control_applied']; v_complete := v_config.music_enabled;
    WHEN 'automation' THEN
      v_actions := ARRAY['automation.executed'];
      v_complete := true;
    WHEN 'store' THEN
      v_actions := ARRAY[]::TEXT[];
      v_launch := public.adoption_current_launch_proof(p_guild_id, GREATEST(v_epoch.changed_at, v_schema_at, v_now - INTERVAL '24 hours'), p_server_context);
      IF v_launch IS NOT NULL THEN
        v_identity := md5(v_identity || v_launch::TEXT);
        v_seen := ARRAY['commerce.launch.verified']; v_complete := true;
        v_ids := jsonb_build_array(v_launch->>'id');
        v_expiry := LEAST(v_expiry, (v_launch->>'verifiedAt')::TIMESTAMPTZ + INTERVAL '24 hours');
      ELSE
        v_reason := 'Complete a current product launch run: paid sandbox payment and reversal, or a real free claim with fulfillment.';
      END IF;
    WHEN 'licensing' THEN
      v_actions := ARRAY['license.key_activated', 'license.validate_unavailable'];
      v_launch := public.adoption_current_launch_proof(p_guild_id, GREATEST(v_epoch.changed_at, v_schema_at, v_now - INTERVAL '24 hours'), p_server_context);
      IF v_launch IS NOT NULL AND v_launch->>'requiresSdk' = 'true' THEN
        v_identity := md5(v_identity || v_launch::TEXT);
        v_complete := true; v_required := ARRAY['license.key_activated'];
        v_ids := jsonb_build_array(v_launch->>'id');
        v_expiry := LEAST(v_expiry, (v_launch->>'verifiedAt')::TIMESTAMPTZ + INTERVAL '24 hours');
      ELSE
        v_reason := 'A current signed SDK integration, product launch run and real key validation are required.';
      END IF;
    WHEN 'staff' THEN
      v_actions := ARRAY[]::TEXT[];
      v_staff := public.adoption_staff_authorization_proof(p_guild_id, p_server_context);
      IF v_staff IS NOT NULL THEN
        v_complete := true; v_seen := ARRAY['staff.authorization'];
        v_ids := v_staff->'evidenceIds'; v_identity := md5(v_identity || (v_staff->>'identity'));
        v_expiry := LEAST(v_expiry, (v_staff->>'expiresAt')::TIMESTAMPTZ);
      ELSE
        v_reason := 'An assigned staff member must use an allowed work surface and, for a restricted role, exercise a denied permission with the current role assignments.';
      END IF;
    WHEN 'recovery' THEN
      v_actions := ARRAY['launcher.backup.database_succeeded','launcher.backup.database_failed','launcher.backup.valkey_succeeded','launcher.backup.valkey_failed','launcher.restore.rehearsal_succeeded','launcher.restore.rehearsal_failed'];
      v_required := ARRAY['launcher.backup.database_succeeded','launcher.backup.valkey_succeeded','launcher.restore.rehearsal_succeeded'];
      v_since := GREATEST(v_epoch.changed_at, v_schema_at, v_now - INTERVAL '24 hours');
      v_reason := 'A current checksum-verified database backup, matching isolated DATABASE rehearsal, and separately verified Valkey snapshot are required. This does not prove Valkey or storage-object restore.';
      IF to_regprocedure('public.adoption_recovery_proof(text,timestamp with time zone)') IS NOT NULL THEN
        v_recovery := public.adoption_recovery_proof(p_guild_id, v_since);
        IF v_recovery IS NOT NULL THEN
          v_complete := true; v_identity := md5(v_identity || (v_recovery->>'identity'));
          v_expiry := LEAST(v_expiry, (v_recovery->>'expiresAt')::TIMESTAMPTZ);
        END IF;
      END IF;
    ELSE RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'adoption verification: unknown track';
  END CASE;

  FOR v_action IN
    SELECT source.* FROM unnest(v_actions) AS wanted(action)
    CROSS JOIN LATERAL (
      SELECT * FROM public.audit_logs AS audit
      WHERE audit.guild_id = p_guild_id AND audit.action = split_part(wanted.action, ':', 1)
        AND (split_part(wanted.action, ':', 2) = '' OR audit.details->>'deliveryKind' = split_part(wanted.action, ':', 2))
        AND audit.timestamp >= v_since
      ORDER BY audit.timestamp DESC, audit.id DESC LIMIT 1
    ) AS source
  LOOP
    v_ids := v_ids || jsonb_build_array(v_action.id);
    IF v_action.timestamp > v_now OR v_action.success IS NOT TRUE OR v_action.action LIKE '%failed' OR v_action.action LIKE '%outage'
       OR (v_action.action = 'automation.executed' AND v_action.details->>'success' IS DISTINCT FROM 'true') THEN
      v_failure_at := GREATEST(v_failure_at, v_action.timestamp);
    ELSE
      IF (v_action.action <> 'music.queued' OR v_action.details->>'sessionStarted' = 'true')
        AND (v_action.action <> 'welcome.delivery_succeeded' OR v_action.details->>'deliveryKind' = 'dm' OR v_action.details->>'channelId' = v_config.welcome_channel_id)
        AND (v_action.action <> 'welcome.test_delivery_succeeded' OR (v_action.details->>'messageType' = 'welcome' AND v_action.details->>'configuredDestination' = 'true' AND v_action.details->>'channelId' = v_config.welcome_channel_id))
        AND (v_action.action <> 'sync.completed' OR v_action.details->>'driftItemsFound' = '0')
        AND (v_action.action <> 'scheduled_message.sent' OR EXISTS (SELECT 1 FROM public.scheduled_messages WHERE guild_id = p_guild_id AND active AND id::TEXT = v_action.target_id))
        AND (v_action.action <> 'giveaway.ended' OR EXISTS (SELECT 1 FROM public.giveaways WHERE guild_id = p_guild_id AND id::TEXT = v_action.target_id))
        AND (v_action.action <> 'member.role_granted' OR EXISTS (SELECT 1 FROM public.reaction_roles WHERE guild_id = p_guild_id AND role_id = v_action.details->>'roleId') OR EXISTS (SELECT 1 FROM public.button_roles WHERE guild_id = p_guild_id AND active AND role_id = v_action.details->>'roleId'))
        AND (v_action.action <> 'license.key_activated' OR v_action.details->>'productId' = v_launch->>'productId')
        AND (v_action.action <> 'automation.executed' OR (
          v_action.details->>'success' = 'true' AND (v_action.details->>'actionsExecuted') ~ '^[1-9][0-9]*$'
          AND EXISTS (SELECT 1 FROM public.automations WHERE guild_id = p_guild_id AND id::TEXT = v_action.target_id AND enabled))) THEN
        v_seen := array_append(v_seen, CASE v_action.action
          WHEN 'welcome.delivery_succeeded' THEN v_action.action || ':' || (v_action.details->>'deliveryKind')
          WHEN 'welcome.test_delivery_succeeded' THEN 'welcome.delivery_succeeded:channel'
          ELSE v_action.action END);
        v_success_at := GREATEST(v_success_at, v_action.timestamp);
        IF v_seen[cardinality(v_seen)] = ANY(v_required) THEN
          v_required_times := v_required_times || jsonb_build_object(v_seen[cardinality(v_seen)], GREATEST((v_required_times->>v_seen[cardinality(v_seen)])::TIMESTAMPTZ, v_action.timestamp));
        END IF;
        v_expiry := LEAST(v_expiry, v_action.timestamp + INTERVAL '24 hours');
      END IF;
    END IF;
  END LOOP;

  SELECT min(value::TIMESTAMPTZ) INTO v_required_success_at FROM jsonb_each_text(v_required_times);
  IF v_failure_at IS NOT NULL AND (v_success_at IS NULL OR v_failure_at >= COALESCE(v_required_success_at, v_success_at)) THEN
    v_result := CASE WHEN v_failure_at > v_now THEN 'unknown' ELSE 'fail' END;
    v_reason := CASE WHEN v_failure_at > v_now THEN 'The newest runtime evidence is future-dated. Correct its clock/source before checking again.' ELSE 'The latest runtime outcome failed. Resolve it and repeat the real feature action before checking again.' END;
  ELSE
    IF v_config.guild_id IS NULL OR v_config.updated_at IS NULL OR v_health.guild_id IS NULL
       OR v_health.boot_id IS NULL OR v_health.boot_id = '' OR v_boot.id IS NULL
       OR v_boot.details->>'bootId' IS DISTINCT FROM v_health.boot_id::TEXT OR v_boot.timestamp < v_schema_at
       OR v_boot.success IS NOT TRUE OR v_boot.timestamp > v_now
       OR v_health.snapshot_at <= COALESCE(v_epoch.changed_at, '-infinity') OR v_health.snapshot_at > v_now
       OR v_health.snapshot_at + INTERVAL '5 minutes' <= v_now
       OR v_boot.timestamp > v_health.snapshot_at THEN
      v_result := 'unknown'; v_reason := 'Fresh server-scoped health after relevant configuration and a matching current-schema bot start are required.';
    ELSIF v_health.valkey_connected IS NOT TRUE OR v_health.discord_ws_ping IS NULL OR v_health.discord_ws_ping < 0 THEN
      v_result := 'fail'; v_reason := 'Current server health reports an unavailable runtime dependency.';
    ELSIF p_track_id = 'core' THEN
      v_result := 'pass'; v_reason := 'Server bot start and fresh Discord/Valkey health observed.';
      v_ids := jsonb_build_array(v_boot.id);
    ELSIF v_complete AND cardinality(v_seen) > 0 AND v_required <@ v_seen THEN
      v_result := 'pass'; v_reason := CASE WHEN p_track_id = 'recovery'
        THEN 'Verified database backup and matching isolated DATABASE rehearsal, plus a separately verified Valkey snapshot. Valkey restore and storage-object restore are not proven.'
        ELSE 'Successful real feature action and current server health observed after relevant configuration.' END;
    ELSIF v_complete THEN
      v_reason := 'Perform the configured real feature action after the latest relevant settings change, then check again.';
    END IF;
  END IF;
  RETURN jsonb_build_object('trackId', p_track_id, 'result', v_result, 'reason', v_reason,
    'checkedAt', v_now, 'expiresAt', GREATEST(v_expiry, v_now + INTERVAL '1 second'),
    'eligible', v_result = 'pass', 'evidenceIds', v_ids, 'identity', v_identity, 'version', 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.read_dashboard_adoption_verifications(p_guild_id TEXT, p_server_context JSONB DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_track TEXT;
  v_latest public.dashboard_adoption_verifications%ROWTYPE;
  v_observed JSONB;
  v_current JSONB;
  v_results JSONB := '[]'::JSONB;
BEGIN
  FOREACH v_track IN ARRAY ARRAY['core','structure','moderation','welcome','community','economy','games','music','automation','store','licensing','staff','recovery'] LOOP
    SELECT * INTO v_latest FROM public.dashboard_adoption_verifications
      WHERE guild_id = p_guild_id AND track_id = v_track ORDER BY check_sequence DESC LIMIT 1;
    v_observed := public.observe_dashboard_adoption_track(p_guild_id, v_track, p_server_context);
    v_current := v_observed || jsonb_build_object('eligible', false, 'checkedAt', v_latest.verified_at,
      'expiresAt', v_latest.expires_at);
    IF v_latest.id IS NULL THEN
      v_current := v_current || '{"result":"unknown"}'::JSONB;
    ELSIF v_latest.result <> 'pass' THEN
      v_current := v_current || jsonb_build_object('result', CASE WHEN v_latest.result = 'fail' THEN 'fail' ELSE 'unknown' END,
        'reason', COALESCE(v_latest.evidence->>'reason', 'The latest check did not pass.'), 'evidenceIds', COALESCE(v_latest.evidence->'evidenceIds', '[]'::JSONB));
    ELSIF v_latest.evidence->>'version' = '1' AND v_latest.evidence->>'identity' = v_observed->>'identity'
      AND v_latest.expires_at > clock_timestamp() AND v_latest.verified_at <= clock_timestamp()
      AND v_observed->>'result' = 'pass' THEN
      v_current := v_latest.evidence || jsonb_build_object('eligible', true);
    ELSE
      v_current := v_current || jsonb_build_object('result', CASE WHEN v_observed->>'result' = 'fail' THEN 'fail' ELSE 'unknown' END,
        'reason', 'Recorded proof expired or its configuration, schema, boot or runtime outcome changed. Check evidence again.');
    END IF;
    v_results := v_results || jsonb_build_array(v_current - 'identity' - 'version');
  END LOOP;
  RETURN v_results;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_dashboard_adoption_track(
  p_guild_id TEXT, p_actor_id TEXT, p_track_id TEXT, p_operation_id UUID, p_idempotency_key TEXT, p_server_context JSONB DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_operation public.significant_operations%ROWTYPE;
  v_evidence JSONB;
  v_intent JSONB := jsonb_build_object('trackId', p_track_id);
BEGIN
  PERFORM 1 FROM public.guild WHERE id = p_guild_id AND owner_discord_id = p_actor_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'adoption verification: owner required'; END IF;
  SELECT * INTO v_operation FROM public.prepare_significant_operation(
    p_operation_id, p_guild_id, 'dashboard', p_idempotency_key, 'dashboard_adoption',
    'dashboard.adoption.verify', 'owner', p_actor_id, ARRAY['validated','executed','read_back','audited']::TEXT[], 'none', v_intent);
  IF v_operation.outcome = 'completed' THEN RETURN v_operation.readback; END IF;
  v_evidence := public.observe_dashboard_adoption_track(p_guild_id, p_track_id, p_server_context) || jsonb_build_object('operationId', v_operation.id);
  PERFORM * FROM public.advance_significant_operation(v_operation.id, 0, 'validated', '{"authority":"owner","input":"track_only"}'::JSONB);
  INSERT INTO public.dashboard_adoption_verifications(guild_id, track_id, evidence_kind, result, evidence, operation_id, verified_at, expires_at)
  VALUES (p_guild_id, p_track_id, 'live', CASE WHEN v_evidence->>'result' = 'unknown' THEN 'blocked' ELSE v_evidence->>'result' END,
    v_evidence, v_operation.id, (v_evidence->>'checkedAt')::TIMESTAMPTZ, (v_evidence->>'expiresAt')::TIMESTAMPTZ);
  PERFORM * FROM public.advance_significant_operation(v_operation.id, 1, 'executed', jsonb_build_object('result', v_evidence->>'result'));
  PERFORM * FROM public.advance_significant_operation(v_operation.id, 2, 'read_back', '{"authoritative":true}'::JSONB, NULL, NULL, NULL, v_evidence - 'identity' - 'version');
  INSERT INTO public.audit_logs(guild_id, actor_type, actor_id, category, action, target_type, target_id, success, correlation_id, details)
  VALUES (p_guild_id, 'dashboard', p_actor_id, 'configuration', 'dashboard.adoption.checked', 'adoption_track', p_track_id,
    v_evidence->>'result' = 'pass', v_operation.id, jsonb_build_object('result', v_evidence->>'result', 'evidenceIds', v_evidence->'evidenceIds'));
  PERFORM * FROM public.advance_significant_operation(v_operation.id, 3, 'audited', '{"audit":"persisted"}'::JSONB,
    NULL, NULL, NULL, NULL, jsonb_build_object('operation_id', v_operation.id));
  RETURN v_evidence - 'identity' - 'version';
END;
$$;

REVOKE ALL ON FUNCTION public.observe_dashboard_adoption_track(TEXT,TEXT,JSONB),
  public.read_dashboard_adoption_verifications(TEXT,JSONB), public.check_dashboard_adoption_track(TEXT,TEXT,TEXT,UUID,TEXT,JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observe_dashboard_adoption_track(TEXT,TEXT,JSONB),
  public.read_dashboard_adoption_verifications(TEXT,JSONB), public.check_dashboard_adoption_track(TEXT,TEXT,TEXT,UUID,TEXT,JSONB)
  TO service_role;
