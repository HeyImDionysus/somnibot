CREATE TABLE public.dashboard_adoption_config_epochs (
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL CHECK (track_id IN ('core','structure','moderation','welcome','community','economy','games','music','automation','store','licensing','staff','recovery')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (guild_id, track_id)
);
CREATE INDEX dashboard_adoption_audit_source_idx ON public.audit_logs (guild_id, action, timestamp DESC);
ALTER TABLE public.dashboard_adoption_config_epochs ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_access ON public.dashboard_adoption_config_epochs TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.dashboard_adoption_config_epochs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.dashboard_adoption_config_epochs TO service_role;

CREATE OR REPLACE FUNCTION public.adoption_track_configuration(p_config JSONB, p_track TEXT)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::JSONB) FROM jsonb_each(COALESCE(p_config, '{}'::JSONB))
  WHERE CASE p_track
    WHEN 'core' THEN key IN ('diagnostics_snapshot_interval_ms')
    WHEN 'structure' THEN key ~ '^(sync_|setup_|permission_)'
    WHEN 'moderation' THEN key ~ '^(mod_|automod_|anti_raid_|infraction_|escalation_)'
    WHEN 'welcome' THEN key ~ '^(welcome_|goodbye_|onboarding_|member_role_|returning_member_|interest_role_)'
    WHEN 'community' THEN key ~ '^(levels_|xp_|voice_xp_|level_up_|rank_card_|reaction_|giveaway_|scheduled_)'
    WHEN 'economy' THEN key ~ '^economy_' AND key !~ '^economy_(games_|lottery_|coinflip_|slots_|blackjack_|daily_loss_)'
    WHEN 'games' THEN key = 'economy_enabled' OR key ~ '^economy_(games_|lottery_|coinflip_|slots_|blackjack_|daily_loss_)'
    WHEN 'music' THEN key = 'dj_role_id' OR key ~ '^music_'
    WHEN 'automation' THEN key ~ '^automation_'
    WHEN 'store' THEN key ~ '^(store_|paypal_|commerce_)'
    WHEN 'licensing' THEN key ~ '^license_'
    WHEN 'staff' THEN key ~ '^(staff_|rbac_)'
    WHEN 'recovery' THEN key ~ '^(backup_|recovery_)'
    ELSE false END;
$$;

CREATE OR REPLACE FUNCTION public.advance_adoption_config_epoch()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old JSONB := CASE WHEN TG_OP = 'INSERT' THEN '{}'::JSONB ELSE to_jsonb(OLD) END;
  v_new JSONB := CASE WHEN TG_OP = 'DELETE' THEN '{}'::JSONB ELSE to_jsonb(NEW) END;
  v_guild TEXT;
  v_track TEXT;
  v_tracks TEXT[] := CASE WHEN TG_TABLE_NAME = 'guild_config' THEN
    ARRAY['core','structure','moderation','welcome','community','economy','games','music','automation','store','licensing','staff','recovery']
    ELSE string_to_array(TG_ARGV[0], ',') END;
BEGIN
  v_guild := COALESCE(v_new->>'guild_id', v_old->>'guild_id');
  IF v_guild IS NULL AND TG_ARGV[1] = 'product_id' THEN
    SELECT guild_id INTO v_guild FROM public.products WHERE id::TEXT = COALESCE(v_new->>'product_id', v_old->>'product_id');
  END IF;
  IF v_guild IS NULL OR NOT EXISTS (SELECT 1 FROM public.guild WHERE id = v_guild) THEN RETURN COALESCE(NEW, OLD); END IF;
  FOREACH v_track IN ARRAY v_tracks LOOP
    IF (TG_TABLE_NAME = 'guild_config' AND (TG_OP = 'INSERT' OR public.adoption_track_configuration(v_old, v_track) IS DISTINCT FROM public.adoption_track_configuration(v_new, v_track)))
      OR (TG_TABLE_NAME <> 'guild_config' AND
        (v_old - CASE TG_TABLE_NAME WHEN 'products' THEN ARRAY['updated_at','active'] WHEN 'giveaways' THEN ARRAY['message_id','entries','winners','status','ended_at'] WHEN 'scheduled_messages' THEN ARRAY['updated_at','current_sends','last_sent_at'] ELSE ARRAY['updated_at','execution_count','last_executed_at'] END)
        IS DISTINCT FROM (v_new - CASE TG_TABLE_NAME WHEN 'products' THEN ARRAY['updated_at','active'] WHEN 'giveaways' THEN ARRAY['message_id','entries','winners','status','ended_at'] WHEN 'scheduled_messages' THEN ARRAY['updated_at','current_sends','last_sent_at'] ELSE ARRAY['updated_at','execution_count','last_executed_at'] END)) THEN
      INSERT INTO public.dashboard_adoption_config_epochs(guild_id, track_id)
      VALUES (v_guild, v_track) ON CONFLICT (guild_id, track_id) DO UPDATE
        SET revision = public.dashboard_adoption_config_epochs.revision + 1, changed_at = clock_timestamp();
    END IF;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER adoption_config_epoch AFTER INSERT OR UPDATE OR DELETE ON public.guild_config
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch();
CREATE TRIGGER adoption_structure_epoch AFTER INSERT OR UPDATE OR DELETE ON public.guild_desired_state
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('structure');
CREATE TRIGGER adoption_moderation_epoch AFTER INSERT OR UPDATE OR DELETE ON public.automod_rules
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('moderation');
CREATE TRIGGER adoption_automation_epoch AFTER INSERT OR UPDATE OR DELETE ON public.automations
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('automation');
CREATE TRIGGER adoption_reaction_epoch AFTER INSERT OR UPDATE OR DELETE ON public.reaction_roles
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('community');
CREATE TRIGGER adoption_products_epoch AFTER INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('store,licensing');
CREATE TRIGGER adoption_license_policy_epoch AFTER INSERT OR UPDATE OR DELETE ON public.product_license_config
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('store,licensing', 'product_id');
CREATE TRIGGER adoption_product_files_epoch AFTER INSERT OR UPDATE OR DELETE ON public.product_files
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('store,licensing', 'product_id');
CREATE TRIGGER adoption_staff_assignments_epoch AFTER INSERT OR UPDATE OR DELETE ON public.dashboard_user_roles
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('staff');
CREATE TRIGGER adoption_staff_roles_epoch AFTER INSERT OR UPDATE OR DELETE ON public.dashboard_roles
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('staff');
CREATE TRIGGER adoption_button_roles_epoch AFTER INSERT OR UPDATE OR DELETE ON public.button_roles
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('community');
CREATE TRIGGER adoption_scheduled_epoch AFTER INSERT OR UPDATE OR DELETE ON public.scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('community');
CREATE TRIGGER adoption_giveaways_epoch AFTER INSERT OR UPDATE OR DELETE ON public.giveaways
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('community');
CREATE TRIGGER adoption_items_epoch AFTER INSERT OR UPDATE OR DELETE ON public.economy_items
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('economy');
CREATE TRIGGER adoption_recipes_epoch AFTER INSERT OR UPDATE OR DELETE ON public.economy_recipes
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('economy');
CREATE TRIGGER adoption_income_epoch AFTER INSERT OR UPDATE OR DELETE ON public.economy_role_income
  FOR EACH ROW EXECUTE FUNCTION public.advance_adoption_config_epoch('economy');

INSERT INTO public.dashboard_adoption_config_epochs(guild_id, track_id, changed_at)
SELECT config.guild_id, track.id, COALESCE(config.updated_at, clock_timestamp()) FROM public.guild_config AS config
CROSS JOIN unnest(ARRAY['core','structure','moderation','welcome','community','economy','games','music','automation','store','licensing','staff','recovery']) AS track(id)
ON CONFLICT DO NOTHING;

REVOKE ALL ON FUNCTION public.adoption_track_configuration(JSONB,TEXT), public.advance_adoption_config_epoch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adoption_track_configuration(JSONB,TEXT), public.advance_adoption_config_epoch() TO service_role;

CREATE OR REPLACE FUNCTION public.adoption_current_launch_proof(p_guild_id TEXT, p_since TIMESTAMPTZ, p_context JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_run public.commerce_product_launch_runs%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_policy public.product_license_config%ROWTYPE;
  v_requires_sdk BOOLEAN;
BEGIN
  SELECT product.* INTO v_product FROM public.products AS product
    JOIN public.commerce_product_launch_runs AS launch ON launch.product_id = product.id AND launch.guild_id = product.guild_id
    WHERE product.guild_id = p_guild_id
    ORDER BY launch.updated_at DESC, launch.id DESC LIMIT 1 FOR SHARE OF product;
  IF v_product.id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_policy FROM public.product_license_config WHERE product_id = v_product.id FOR SHARE;
  SELECT * INTO v_run FROM public.commerce_product_launch_runs
    WHERE guild_id = p_guild_id AND product_id = v_product.id FOR SHARE;
  PERFORM 1 FROM public.dashboard_adoption_config_epochs WHERE guild_id = p_guild_id AND track_id IN ('store','licensing') FOR SHARE;
  v_requires_sdk := v_product.delivery_type = 'license_key' OR v_product.metadata ? 'completed_project_licensing' OR v_product.metadata ? 'somnibot_sdk_integration_receipt';
  IF p_context IS NULL OR p_context->>'productId' IS DISTINCT FROM v_product.id::TEXT
    OR (p_context->>'productRevision')::TIMESTAMPTZ IS DISTINCT FROM v_product.updated_at
    OR (p_context->>'policyRevision')::TIMESTAMPTZ IS DISTINCT FROM CASE WHEN v_product.delivery_type = 'license_key' THEN v_policy.updated_at ELSE NULL END
    OR p_context->>'integrationVerified' IS DISTINCT FROM 'true'
    OR (p_context->>'requiresSdk')::BOOLEAN IS DISTINCT FROM v_requires_sdk
    OR (v_requires_sdk AND NULLIF(p_context->>'origin', '') IS NULL)
    OR COALESCE((p_context->>'storeRevision')::BIGINT, -1) <> COALESCE((SELECT revision FROM public.dashboard_adoption_config_epochs WHERE guild_id = p_guild_id AND track_id = 'store'), 0)
    OR COALESCE((p_context->>'licensingRevision')::BIGINT, -1) <> COALESCE((SELECT revision FROM public.dashboard_adoption_config_epochs WHERE guild_id = p_guild_id AND track_id = 'licensing'), 0) THEN RETURN NULL; END IF;
  IF v_run.state NOT IN ('ready','live') OR v_run.verified_at IS NULL
    OR (v_run.state = 'ready' AND v_run.environment <> 'sandbox') OR (v_run.state = 'live' AND (NOT v_product.active OR v_run.activated_at IS NULL))
    OR v_run.verified_at < p_since OR v_run.verified_at > clock_timestamp()
    OR v_run.verified_at + INTERVAL '24 hours' <= clock_timestamp()
    OR v_run.launch_receipt_hash IS NULL OR v_run.launch_receipt IS NULL
    OR v_run.launch_receipt->>'product_id' IS DISTINCT FROM v_product.id::TEXT
    OR (CASE WHEN v_run.state = 'live' THEN v_run.launch_receipt->'activation'->>'product_revision' ELSE v_run.launch_receipt->>'product_revision' END)::TIMESTAMPTZ IS DISTINCT FROM v_product.updated_at
    OR v_run.launch_receipt->>'environment' IS DISTINCT FROM 'sandbox'
    OR EXISTS (SELECT 1 FROM jsonb_each_text(v_run.stages) AS stage WHERE value IS DISTINCT FROM CASE
      WHEN v_product.type = 'free' AND key IN ('sandbox_transaction','webhook','reversal') THEN 'not_applicable' ELSE 'verified' END)
    OR (SELECT count(*) FROM jsonb_each_text(v_run.stages)) <> 9
    OR (v_product.delivery_type = 'license_key' AND ((v_run.launch_receipt->>'policy_revision')::TIMESTAMPTZ IS DISTINCT FROM v_policy.updated_at OR v_policy.product_id IS NULL))
    OR EXISTS (SELECT 1 FROM public.product_files WHERE product_id = v_product.id AND created_at > v_run.verified_at) THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('id', v_run.id, 'hash', v_run.launch_receipt_hash, 'verifiedAt', v_run.verified_at,
    'productId', v_product.id, 'requiresSdk', v_requires_sdk, 'origin', p_context->>'origin');
END;
$$;
REVOKE ALL ON FUNCTION public.adoption_current_launch_proof(TEXT,TIMESTAMPTZ,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adoption_current_launch_proof(TEXT,TIMESTAMPTZ,JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.adoption_staff_authorization_proof(p_guild_id TEXT, p_context JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_staff JSONB;
  v_allowed public.audit_logs%ROWTYPE;
  v_denied public.audit_logs%ROWTYPE;
  v_permissions TEXT[];
  v_since TIMESTAMPTZ;
BEGIN
  IF jsonb_typeof(p_context->'staff') IS DISTINCT FROM 'array' OR jsonb_array_length(p_context->'staff') > 100 THEN RETURN NULL; END IF;
  FOR v_staff IN SELECT value FROM jsonb_array_elements(p_context->'staff') LOOP
    IF v_staff->>'actorId' = (SELECT owner_discord_id FROM public.guild WHERE id = p_guild_id) THEN CONTINUE; END IF;
    PERFORM role.id FROM public.dashboard_roles AS role JOIN public.dashboard_user_roles AS assignment ON assignment.role_id = role.id
      WHERE assignment.guild_id = p_guild_id AND role.guild_id = p_guild_id AND assignment.discord_id = v_staff->>'actorId' FOR SHARE OF role;
    PERFORM id FROM public.dashboard_user_roles WHERE guild_id = p_guild_id AND discord_id = v_staff->>'actorId' FOR SHARE;
    SELECT changed_at INTO v_since FROM public.dashboard_adoption_config_epochs WHERE guild_id = p_guild_id AND track_id = 'staff' FOR SHARE;
    IF jsonb_typeof(v_staff->'assignments') IS DISTINCT FROM 'array' OR jsonb_array_length(v_staff->'assignments') = 0
      OR (SELECT count(*) FROM public.dashboard_user_roles WHERE guild_id = p_guild_id AND discord_id = v_staff->>'actorId') <> jsonb_array_length(v_staff->'assignments')
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_staff->'assignments') AS expected(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.dashboard_user_roles AS assignment JOIN public.dashboard_roles AS role ON role.id = assignment.role_id
          WHERE assignment.id::TEXT = expected.value->>'id' AND assignment.guild_id = p_guild_id
            AND assignment.discord_id = v_staff->>'actorId' AND role.guild_id = p_guild_id
            AND assignment.role_id::TEXT = expected.value->>'role_id'
            AND assignment.assigned_at IS NOT DISTINCT FROM (expected.value->>'assigned_at')::TIMESTAMPTZ
            AND role.updated_at IS NOT DISTINCT FROM (expected.value->'dashboard_roles'->>'updated_at')::TIMESTAMPTZ
            AND (SELECT array_agg(DISTINCT p ORDER BY p) FROM jsonb_array_elements_text(role.permissions) AS p)
              IS NOT DISTINCT FROM (SELECT array_agg(DISTINCT p ORDER BY p) FROM jsonb_array_elements_text(expected.value->'dashboard_roles'->'permissions') AS p)
        )
      ) THEN CONTINUE; END IF;
    SELECT array_agg(DISTINCT permission) INTO v_permissions FROM public.dashboard_user_roles AS assignment
      JOIN public.dashboard_roles AS role ON role.id = assignment.role_id
      CROSS JOIN LATERAL jsonb_array_elements_text(role.permissions) AS permission
      WHERE assignment.guild_id = p_guild_id AND role.guild_id = p_guild_id AND assignment.discord_id = v_staff->>'actorId';
    SELECT * INTO v_allowed FROM public.audit_logs WHERE guild_id = p_guild_id AND actor_id = v_staff->>'actorId'
      AND action = 'dashboard.authorization_allowed' AND success IS TRUE
      AND details->>'rbac_identity' = v_staff->>'identity' AND details->>'authorization_only' = 'true'
      AND (details->>'required_permission' = ANY(v_permissions) OR 'dashboard.full_access' = ANY(v_permissions))
      AND timestamp >= GREATEST(v_since, clock_timestamp() - INTERVAL '24 hours') AND timestamp <= clock_timestamp()
      ORDER BY timestamp DESC LIMIT 1;
    IF v_allowed.id IS NULL THEN CONTINUE; END IF;
    SELECT * INTO v_denied FROM public.audit_logs WHERE guild_id = p_guild_id AND actor_id = v_staff->>'actorId'
      AND action = 'dashboard.authorization_denied' AND success IS FALSE
      AND details->>'rbac_identity' = v_staff->>'identity'
      AND details->>'reason' = 'permission_denied'
      AND details->>'required_permission' <> ALL(v_permissions)
      AND timestamp >= GREATEST(v_since, clock_timestamp() - INTERVAL '24 hours') AND timestamp <= clock_timestamp()
      ORDER BY timestamp DESC LIMIT 1;
    IF v_denied.id IS NOT NULL OR 'dashboard.full_access' = ANY(v_permissions) THEN
      RETURN jsonb_build_object('identity', v_staff->>'identity', 'evidenceIds',
        CASE WHEN v_denied.id IS NULL THEN jsonb_build_array(v_allowed.id) ELSE jsonb_build_array(v_allowed.id,v_denied.id) END,
        'expiresAt', LEAST(v_allowed.timestamp, COALESCE(v_denied.timestamp, v_allowed.timestamp)) + INTERVAL '24 hours');
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.adoption_staff_authorization_proof(TEXT,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adoption_staff_authorization_proof(TEXT,JSONB) TO service_role;
