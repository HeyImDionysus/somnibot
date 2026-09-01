BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.commerce_require_launch_owner(p_guild_id text, p_actor_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.guild
   WHERE id = p_guild_id AND owner_discord_id = p_actor_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Product launch requires the current guild owner';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_require_launch_owner(text,text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_record_launch_audit(
  p_run public.commerce_product_launch_runs, p_actor_id text, p_action text, p_details jsonb DEFAULT '{}'::jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, target_type, target_id, correlation_id, details
  ) VALUES (
    p_run.guild_id, 'user', p_actor_id, p_action, 'product', p_run.product_id::text,
    p_run.operation_id::text, COALESCE(p_details, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'operation_id', p_run.operation_id, 'launch_run_id', p_run.id, 'version', p_run.version
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_record_launch_audit(public.commerce_product_launch_runs,text,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_create_tutorial_launch(p_guild_id text, p_actor_id text)
RETURNS public.commerce_product_launch_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_product_id uuid := pg_catalog.gen_random_uuid();
  v_run public.commerce_product_launch_runs%ROWTYPE;
BEGIN
  PERFORM public.commerce_require_launch_owner(p_guild_id, p_actor_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('commerce-launch-tutorial:' || p_guild_id, 0));
  SELECT * INTO v_run FROM public.commerce_product_launch_runs
   WHERE guild_id = p_guild_id AND is_tutorial = true FOR UPDATE;
  IF FOUND THEN
    UPDATE public.commerce_product_launch_runs
       SET tutorial_visibility = 'visible', updated_by = p_actor_id,
           version = version + 1, updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_run.id RETURNING * INTO v_run;
    PERFORM public.commerce_record_launch_audit(v_run, p_actor_id, 'commerce.launch.tutorial_reopened');
    RETURN v_run;
  END IF;
  INSERT INTO public.products (
    id, guild_id, name, description, type, delivery_type, price_cents, currency,
    granted_role_ids, granted_channel_ids, active, sort_order, metadata
  ) VALUES (
    v_product_id, p_guild_id, 'SomniBot Product Launch Tutorial',
    'Inactive sandbox tutorial for pricing, SDK integration, fulfillment, reversal, and launch verification.',
    'free', 'license_key', 0, 'USD', '{}', '{}', false, 0,
    pg_catalog.jsonb_build_object('somnibot_tutorial', pg_catalog.jsonb_build_object(
      'schemaVersion', 1, 'sandboxSafe', true, 'walkthrough', pg_catalog.jsonb_build_array(
        'pricing', 'fulfillment', 'entitlements', 'sdk_handoff', 'sandbox_purchase',
        'webhook', 'cancellation', 'refund', 'revocation', 'launch_receipt'
      )
    ))
  );
  INSERT INTO public.commerce_product_launch_runs (
    guild_id, product_id, is_tutorial, tutorial_visibility, environment, state, created_by, updated_by
  ) VALUES (
    p_guild_id, v_product_id, true, 'visible', 'sandbox', 'draft', p_actor_id, p_actor_id
  ) RETURNING * INTO v_run;
  PERFORM public.commerce_record_launch_audit(v_run, p_actor_id, 'commerce.launch.tutorial_created');
  RETURN v_run;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_create_tutorial_launch(text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_tutorial_launch(text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_start_product_launch(
  p_guild_id text, p_actor_id text, p_product_id uuid, p_tutorial boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_run public.commerce_product_launch_runs%ROWTYPE;
  v_previous public.commerce_product_launch_runs%ROWTYPE;
  v_started_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM public.commerce_require_launch_owner(p_guild_id, p_actor_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('commerce-launch-tutorial:' || p_guild_id, 0));
  PERFORM 1 FROM public.products
   WHERE id = p_product_id AND guild_id = p_guild_id AND active = false FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_tutorial IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Product launch tutorial flag is invalid';
  END IF;
  IF p_tutorial THEN
    FOR v_previous IN
      UPDATE public.commerce_product_launch_runs
         SET is_tutorial = false, updated_by = p_actor_id, version = version + 1, updated_at = v_started_at
       WHERE guild_id = p_guild_id AND is_tutorial = true AND product_id <> p_product_id
       RETURNING *
    LOOP
      PERFORM public.commerce_record_launch_audit(v_previous, p_actor_id, 'commerce.launch.tutorial_reassigned');
    END LOOP;
  END IF;
  INSERT INTO public.commerce_product_launch_runs AS existing (
    guild_id, product_id, is_tutorial, created_by, updated_by, verification_started_at, updated_at
  ) VALUES (
    p_guild_id, p_product_id, p_tutorial, p_actor_id, p_actor_id, v_started_at, v_started_at
  ) ON CONFLICT (guild_id, product_id) DO UPDATE SET
    operation_id = pg_catalog.gen_random_uuid(), is_tutorial = EXCLUDED.is_tutorial,
    tutorial_visibility = 'visible', environment = 'sandbox', state = 'draft',
    stages = EXCLUDED.stages, launch_receipt = NULL, launch_receipt_hash = NULL, last_error = NULL,
    created_by = p_actor_id, updated_by = p_actor_id, version = existing.version + 1,
    verification_started_at = v_started_at, verified_at = NULL, activated_at = NULL, updated_at = v_started_at
  RETURNING * INTO v_run;
  PERFORM public.commerce_record_launch_audit(
    v_run, p_actor_id, 'commerce.launch.started', pg_catalog.jsonb_build_object('tutorial', p_tutorial)
  );
  RETURN pg_catalog.to_jsonb(v_run);
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_start_product_launch(text,text,uuid,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_start_product_launch(text,text,uuid,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_mutate_product_launch(
  p_guild_id text, p_actor_id text, p_launch_run_id uuid, p_expected_version integer, p_action text,
  p_stage text DEFAULT NULL, p_stage_state text DEFAULT NULL, p_evidence jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_run public.commerce_product_launch_runs%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_action text;
  v_details jsonb := '{}'::jsonb;
BEGIN
  PERFORM public.commerce_require_launch_owner(p_guild_id, p_actor_id);
  IF p_action IS NULL OR p_action NOT IN ('restart', 'hide', 'disable', 'remove', 'stage')
     OR p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Product launch mutation is invalid';
  END IF;
  SELECT launch.* INTO v_run FROM public.commerce_product_launch_runs AS launch
   WHERE launch.id = p_launch_run_id AND launch.guild_id = p_guild_id
     AND launch.version = p_expected_version FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_action = 'remove' THEN
    DELETE FROM public.commerce_product_launch_runs WHERE id = v_run.id;
    PERFORM public.commerce_record_launch_audit(v_run, p_actor_id, 'commerce.launch.removed');
    RETURN pg_catalog.to_jsonb(v_run);
  ELSIF p_action = 'restart' THEN
    UPDATE public.commerce_product_launch_runs
       SET environment = 'sandbox', state = 'draft', tutorial_visibility = 'visible',
           stages = '{"product":"pending","policy":"pending","pricing":"pending","integration":"pending","sandbox_transaction":"pending","webhook":"pending","entitlement":"pending","fulfillment":"pending","reversal":"pending"}'::jsonb,
           launch_receipt = NULL, launch_receipt_hash = NULL, last_error = NULL,
           verification_started_at = v_now, verified_at = NULL, activated_at = NULL,
           created_by = p_actor_id, updated_by = p_actor_id, version = version + 1, updated_at = v_now
     WHERE id = v_run.id RETURNING * INTO v_run;
    v_action := 'commerce.launch.restart';
  ELSIF p_action IN ('hide', 'disable') THEN
    UPDATE public.commerce_product_launch_runs
       SET tutorial_visibility = CASE p_action WHEN 'hide' THEN 'hidden' ELSE 'disabled' END,
           updated_by = p_actor_id, version = version + 1, updated_at = v_now
     WHERE id = v_run.id RETURNING * INTO v_run;
    v_action := 'commerce.launch.' || p_action;
  ELSE
    IF p_stage IS NULL OR p_stage NOT IN (
      'product', 'policy', 'pricing', 'integration', 'sandbox_transaction', 'webhook', 'entitlement', 'fulfillment', 'reversal'
    ) OR p_stage_state IS NULL OR p_stage_state NOT IN ('pending', 'failed')
      OR p_evidence IS NULL OR pg_catalog.jsonb_typeof(p_evidence) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Product launch stage mutation is invalid';
    END IF;
    UPDATE public.commerce_product_launch_runs
       SET stages = stages || pg_catalog.jsonb_build_object(p_stage, p_stage_state),
           state = CASE p_stage_state WHEN 'failed' THEN 'failed' ELSE 'sandbox_verifying' END,
           launch_receipt = NULL, launch_receipt_hash = NULL, verified_at = NULL,
           last_error = CASE WHEN p_stage_state = 'failed' THEN COALESCE(p_evidence->>'error', 'Verification failed') ELSE NULL END,
           updated_by = p_actor_id, version = version + 1, updated_at = v_now
     WHERE id = v_run.id RETURNING * INTO v_run;
    v_action := 'commerce.launch.stage_changed';
    v_details := pg_catalog.jsonb_build_object('stage', p_stage, 'state', p_stage_state, 'evidence', p_evidence);
  END IF;
  PERFORM public.commerce_record_launch_audit(v_run, p_actor_id, v_action, v_details);
  RETURN pg_catalog.to_jsonb(v_run);
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_mutate_product_launch(text,text,uuid,integer,text,text,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_mutate_product_launch(text,text,uuid,integer,text,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_verify_product_launch(
  p_guild_id text, p_actor_id text, p_launch_run_id uuid, p_expected_version integer,
  p_product_revision timestamptz, p_policy_revision timestamptz, p_stages jsonb,
  p_receipt jsonb, p_receipt_hash text, p_ready boolean
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_run public.commerce_product_launch_runs%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_policy_revision timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_ready boolean;
BEGIN
  PERFORM public.commerce_require_launch_owner(p_guild_id, p_actor_id);
  SELECT product.* INTO v_product FROM public.products AS product
    JOIN public.commerce_product_launch_runs AS launch ON launch.product_id = product.id
   WHERE launch.id = p_launch_run_id AND launch.guild_id = p_guild_id AND product.guild_id = p_guild_id
   FOR SHARE OF product;
  IF NOT FOUND OR v_product.active IS DISTINCT FROM false
     OR v_product.updated_at IS DISTINCT FROM p_product_revision THEN RETURN NULL; END IF;
  IF v_product.delivery_type = 'license_key' THEN
    SELECT updated_at INTO v_policy_revision FROM public.product_license_config
     WHERE product_id = v_product.id FOR SHARE;
  END IF;
  IF v_policy_revision IS DISTINCT FROM p_policy_revision THEN RETURN NULL; END IF;
  SELECT * INTO v_run FROM public.commerce_product_launch_runs
   WHERE id = p_launch_run_id AND guild_id = p_guild_id AND version = p_expected_version FOR UPDATE;
  IF NOT FOUND OR v_run.environment <> 'sandbox' OR v_run.state IN ('live', 'retired')
     OR v_run.tutorial_visibility = 'disabled' THEN RETURN NULL; END IF;
  IF p_receipt IS NULL OR pg_catalog.jsonb_typeof(p_receipt) <> 'object'
     OR p_stages IS NULL OR pg_catalog.jsonb_typeof(p_stages) <> 'object'
     OR p_ready IS NULL OR p_receipt_hash IS NULL OR p_receipt_hash !~ '^[a-f0-9]{64}$'
     OR (p_receipt->>'operation_id')::uuid IS DISTINCT FROM v_run.operation_id
     OR (p_receipt->>'product_id')::uuid IS DISTINCT FROM v_product.id
     OR (p_receipt->>'product_revision')::timestamptz IS DISTINCT FROM p_product_revision
     OR (p_receipt->>'policy_revision')::timestamptz IS DISTINCT FROM p_policy_revision
     OR (p_receipt->>'verification_started_at')::timestamptz IS DISTINCT FROM v_run.verification_started_at
     OR p_receipt->'stages' IS DISTINCT FROM p_stages THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Product launch verification identity is invalid';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.jsonb_each_text(p_stages)) <> 9
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(p_stages) AS stage WHERE
       stage.key NOT IN ('product','policy','pricing','integration','sandbox_transaction','webhook','entitlement','fulfillment','reversal')
       OR stage.value IS NULL OR stage.value NOT IN ('pending','verified','failed','not_applicable')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Product launch verification stages are invalid';
  END IF;
  v_ready := p_receipt->>'environment' = 'sandbox'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(p_stages) AS stage WHERE
      stage.value IS DISTINCT FROM CASE
        WHEN v_product.type = 'free' AND stage.key IN ('sandbox_transaction','webhook','reversal') THEN 'not_applicable'
        ELSE 'verified'
      END);
  IF p_ready IS DISTINCT FROM COALESCE(v_ready, false) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Product launch readiness does not match its proof';
  END IF;
  UPDATE public.commerce_product_launch_runs
     SET stages = p_stages, state = CASE WHEN p_ready THEN 'ready' ELSE 'sandbox_verifying' END,
         launch_receipt = p_receipt, launch_receipt_hash = p_receipt_hash,
         verified_at = CASE WHEN p_ready THEN v_now ELSE NULL END,
         updated_by = p_actor_id, version = version + 1, updated_at = v_now
   WHERE id = v_run.id RETURNING * INTO v_run;
  PERFORM public.commerce_record_launch_audit(v_run, p_actor_id, 'commerce.launch.verified',
    pg_catalog.jsonb_build_object('state', v_run.state, 'stages', p_stages, 'receipt_hash', p_receipt_hash));
  RETURN pg_catalog.to_jsonb(v_run);
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_verify_product_launch(text,text,uuid,integer,timestamptz,timestamptz,jsonb,jsonb,text,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_verify_product_launch(text,text,uuid,integer,timestamptz,timestamptz,jsonb,jsonb,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_activate_product_launch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_run public.commerce_product_launch_runs%ROWTYPE;
  v_policy_revision timestamptz;
  v_activated_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF NEW.active IS NOT TRUE OR OLD.active IS TRUE THEN RETURN NEW; END IF;
  SELECT * INTO v_run FROM public.commerce_product_launch_runs
   WHERE guild_id = NEW.guild_id AND product_id = NEW.id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF v_run.state <> 'ready' OR v_run.launch_receipt_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product launch is not ready';
  END IF;
  IF (v_run.launch_receipt->>'product_revision')::timestamptz IS DISTINCT FROM OLD.updated_at
     OR (pg_catalog.to_jsonb(NEW) - ARRAY['active', 'updated_at'])
        IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['active', 'updated_at']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product launch evidence is stale';
  END IF;
  IF NEW.delivery_type = 'license_key' THEN
    SELECT updated_at INTO v_policy_revision FROM public.product_license_config
     WHERE product_id = NEW.id;
    IF NOT FOUND
       OR (v_run.launch_receipt->>'policy_revision')::timestamptz IS DISTINCT FROM v_policy_revision THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product launch policy evidence is stale';
    END IF;
  ELSIF v_run.launch_receipt->>'policy_revision' IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product launch policy evidence is stale';
  END IF;
  UPDATE public.commerce_product_launch_runs
     SET state = 'live', environment = 'live', activated_at = v_activated_at,
         launch_receipt = COALESCE(launch_receipt, '{}'::jsonb) || pg_catalog.jsonb_build_object(
           'activation', pg_catalog.jsonb_build_object(
             'product_id', NEW.id, 'active', true, 'activated_at', v_activated_at,
             'product_revision', NEW.updated_at
           )
         ),
         updated_by = 'system:product-activation', version = version + 1, updated_at = v_activated_at
   WHERE id = v_run.id RETURNING * INTO v_run;
  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, target_type, target_id, correlation_id, details
  ) VALUES (
    v_run.guild_id, 'system', 'system:product-activation', 'commerce.launch.activated',
    'product', v_run.product_id::text, v_run.operation_id::text,
    pg_catalog.jsonb_build_object(
      'operation_id', v_run.operation_id, 'launch_run_id', v_run.id, 'version', v_run.version,
      'activation', v_run.launch_receipt->'activation', 'receipt_hash', v_run.launch_receipt_hash
    )
  );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_activate_product_launch()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
