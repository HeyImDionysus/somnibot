-- Free claims must use the same insert-then-freeze order contract as paid
-- checkout. The original RPC attempted to insert already-frozen snapshots,
-- which the order integrity triggers correctly reject.

BEGIN;

CREATE OR REPLACE FUNCTION public.commerce_freeze_free_claim_order_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_product public.products%ROWTYPE;
BEGIN
  IF OLD.grant_snapshot_frozen_at IS NOT NULL
     OR NEW.grant_snapshot_frozen_at IS NULL
     OR NOT pg_catalog.isfinite(NEW.grant_snapshot_frozen_at)
     OR OLD.status IS DISTINCT FROM 'pending'
     OR NEW.status IS DISTINCT FROM 'pending'
     OR OLD.source IS DISTINCT FROM 'manual'
     OR NEW.source IS DISTINCT FROM OLD.source
     OR OLD.amount_cents IS DISTINCT FROM 0
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR OLD.discount_cents IS DISTINCT FROM 0
     OR NEW.discount_cents IS DISTINCT FROM OLD.discount_cents
     OR OLD.checkout_active IS DISTINCT FROM false
     OR NEW.checkout_active IS DISTINCT FROM OLD.checkout_active
     OR OLD.delivery_type_snapshot IS NOT NULL
     OR NEW.delivery_type_snapshot IS NOT NULL
     OR OLD.plan_id IS NOT NULL
     OR NEW.plan_id IS NOT NULL
     OR OLD.paypal_order_id IS NOT NULL
     OR NEW.paypal_order_id IS NOT NULL
     OR OLD.paypal_subscription_id IS NOT NULL
     OR NEW.paypal_subscription_id IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_number IS DISTINCT FROM OLD.order_number
     OR NEW.guild_id IS DISTINCT FROM OLD.guild_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.promotion_id IS DISTINCT FROM OLD.promotion_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'free claim order freeze changed the claim identity';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.customers AS customer
     WHERE customer.id = OLD.customer_id
       AND customer.guild_id = OLD.guild_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'free claim order customer identity mismatch';
  END IF;

  SELECT product.*
    INTO v_product
    FROM public.products AS product
   WHERE product.id = OLD.product_id
     AND product.guild_id = OLD.guild_id
   FOR SHARE;

  IF NOT FOUND
     OR v_product.active IS DISTINCT FROM true
     OR v_product.type IS DISTINCT FROM 'free'
     OR v_product.price_cents IS DISTINCT FROM 0
     OR OLD.currency IS DISTINCT FROM v_product.currency
     OR v_product.delivery_type NOT IN ('file','link','access_pass','license_key','mixed')
     OR NOT public.commerce_valid_snowflake_snapshot(
       COALESCE(v_product.granted_role_ids, '{}'::text[])
     )
     OR NOT public.commerce_valid_snowflake_snapshot(
       COALESCE(v_product.granted_channel_ids, '{}'::text[])
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'free claim order product contract mismatch';
  END IF;

  IF NEW.granted_role_ids_snapshot IS DISTINCT FROM COALESCE(
       v_product.granted_role_ids,
       '{}'::text[]
     )
     OR NEW.granted_channel_ids_snapshot IS DISTINCT FROM COALESCE(
       v_product.granted_channel_ids,
       '{}'::text[]
     )
     OR NEW.temporary_role_grants_snapshot IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'free claim order grant snapshot mismatch';
  END IF;

  NEW.delivery_type_snapshot := v_product.delivery_type;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_freeze_free_claim_order_contract()
  FROM PUBLIC, anon, authenticated, service_role;

-- Keep the established paid-order trigger functions unchanged. Split their
-- event triggers so the one tightly-defined free transition is handled by the
-- dedicated validator above. Every insert and every later frozen-row update
-- still passes through the original protections.
DROP TRIGGER IF EXISTS commerce_orders_protect_grant_snapshot ON public.orders;
DROP TRIGGER IF EXISTS commerce_orders_freeze_delivery_contract ON public.orders;

CREATE TRIGGER commerce_orders_protect_grant_snapshot_insert
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_protect_order_grant_snapshot();

CREATE TRIGGER commerce_orders_protect_grant_snapshot_update
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  WHEN (NOT (
    OLD.grant_snapshot_frozen_at IS NULL
    AND NEW.grant_snapshot_frozen_at IS NOT NULL
    AND OLD.source IS NOT DISTINCT FROM 'manual'
    AND OLD.amount_cents IS NOT DISTINCT FROM 0
  ))
  EXECUTE FUNCTION public.commerce_protect_order_grant_snapshot();

CREATE TRIGGER commerce_orders_freeze_delivery_contract_insert
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_freeze_order_delivery_contract();

CREATE TRIGGER commerce_orders_freeze_delivery_contract_update
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  WHEN (NOT (
    OLD.grant_snapshot_frozen_at IS NULL
    AND NEW.grant_snapshot_frozen_at IS NOT NULL
    AND OLD.source IS NOT DISTINCT FROM 'manual'
    AND OLD.amount_cents IS NOT DISTINCT FROM 0
  ))
  EXECUTE FUNCTION public.commerce_freeze_order_delivery_contract();

CREATE TRIGGER commerce_orders_00_freeze_free_claim_contract
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  WHEN (
    OLD.grant_snapshot_frozen_at IS NULL
    AND NEW.grant_snapshot_frozen_at IS NOT NULL
    AND OLD.source IS NOT DISTINCT FROM 'manual'
    AND OLD.amount_cents IS NOT DISTINCT FROM 0
  )
  EXECUTE FUNCTION public.commerce_freeze_free_claim_order_contract();

CREATE OR REPLACE FUNCTION public.commerce_order_is_free_claim_carrier(
  p_order_id uuid,
  p_guild_id text,
  p_customer_id uuid,
  p_product_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.orders AS free_order
     WHERE free_order.id = p_order_id
       AND free_order.order_number = 'ORD-FREE-' || pg_catalog.upper(
         pg_catalog.replace(p_order_id::text, '-', '')
       )
       AND free_order.guild_id = p_guild_id
       AND free_order.customer_id = p_customer_id
       AND free_order.product_id = p_product_id
       AND free_order.source = 'manual'
       AND free_order.amount_cents = 0
       AND free_order.discount_cents = 0
       AND free_order.paypal_order_id IS NULL
       AND free_order.paypal_subscription_id IS NULL
       AND free_order.grant_snapshot_frozen_at IS NOT NULL
       AND free_order.delivery_type_snapshot IS NOT NULL
  );
$$;

REVOKE ALL ON FUNCTION public.commerce_order_is_free_claim_carrier(uuid,text,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_enqueue_noncommerce_activation_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_activation boolean := false;
  v_expected_activation_generation uuid;
BEGIN
  IF public.commerce_order_is_free_claim_carrier(
    NEW.order_id,
    NEW.guild_id,
    NEW.customer_id,
    NEW.product_id
  ) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_is_activation := NEW.status IN (
      'active', 'pending', 'grace_period', 'suspended'
    );
  ELSE
    v_is_activation := OLD.status IN ('expired', 'cancelled')
      AND NEW.status IN ('active', 'pending', 'grace_period', 'suspended');
  END IF;
  IF v_is_activation
     AND COALESCE(
       NEW.source IN ('manual', 'giveaway', 'automation'),
       false
     ) THEN
    SELECT head.activation_generation
      INTO v_expected_activation_generation
      FROM public.commerce_noncommerce_activation_heads AS head
     WHERE head.entitlement_id = NEW.id;
    PERFORM public.commerce_enqueue_noncommerce_activation_entitlement(
      NEW.id,
      NEW.status,
      CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE pg_catalog.gen_random_uuid() END,
      v_expected_activation_generation,
      NULL
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_enqueue_noncommerce_activation_transition()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_enqueue_noncommerce_terminal_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.commerce_order_is_free_claim_carrier(
    NEW.order_id,
    NEW.guild_id,
    NEW.customer_id,
    NEW.product_id
  ) THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('active', 'pending', 'grace_period', 'suspended')
     AND NEW.status IN ('expired', 'cancelled')
     AND (
       COALESCE(OLD.source IN ('manual', 'giveaway', 'automation'), false)
       OR COALESCE(NEW.source IN ('manual', 'giveaway', 'automation'), false)
     ) THEN
    IF NOT COALESCE(
         OLD.source IN ('manual', 'giveaway', 'automation'),
         false
       )
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.guild_id IS DISTINCT FROM OLD.guild_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
       OR NEW.granted_role_ids IS DISTINCT FROM OLD.granted_role_ids
       OR NEW.granted_channel_ids IS DISTINCT FROM OLD.granted_channel_ids THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'noncommerce terminal transition changed its origin identity';
    END IF;
    PERFORM public.commerce_enqueue_noncommerce_terminal_entitlement(
      NEW.id,
      NEW.status,
      true
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_enqueue_noncommerce_terminal_transition()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_claim_free_product(
  p_request_id uuid, p_guild_id text, p_customer_id uuid, p_product_id uuid
)
RETURNS TABLE (request_id uuid, order_id uuid, entitlement_id uuid, disposition text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_product public.products%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_order_id uuid := p_request_id;
  v_entitlement_id uuid;
  v_license_plaintext text;
  v_license_id uuid;
  v_policy text;
  v_existing_order public.orders%ROWTYPE;
  v_existing_request_id uuid;
  v_requeued integer := 0;
BEGIN
  IF p_request_id IS NULL OR p_guild_id IS NULL OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = '' OR p_customer_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='free claim identity is invalid';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_guild_id || E'\x1f' || p_customer_id::text || E'\x1f' || p_product_id::text, 0));
  SELECT c.* INTO v_customer FROM public.customers c WHERE c.id=p_customer_id AND c.guild_id=p_guild_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='free claim customer identity mismatch'; END IF;
  SELECT p.* INTO v_product FROM public.products p WHERE p.id=p_product_id AND p.guild_id=p_guild_id AND p.active IS TRUE FOR SHARE;
  IF NOT FOUND OR v_product.type IS DISTINCT FROM 'free' OR v_product.price_cents <> 0
     OR v_product.delivery_type NOT IN ('file','link','access_pass','license_key','mixed') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='product is not an active free claim';
  END IF;
  SELECT gc.free_claim_policy INTO v_policy FROM public.guild_config gc WHERE gc.guild_id=p_guild_id;
  SELECT o.* INTO v_existing_order
    FROM public.orders o
    JOIN public.commerce_free_claims f ON f.order_id=o.id
   WHERE f.request_id=p_request_id;
  IF FOUND THEN
    IF v_existing_order.guild_id IS DISTINCT FROM p_guild_id
       OR v_existing_order.customer_id IS DISTINCT FROM p_customer_id
       OR v_existing_order.product_id IS DISTINCT FROM p_product_id
       OR v_existing_order.source IS DISTINCT FROM 'manual'
       OR v_existing_order.amount_cents IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='free claim request replay identity mismatch';
    END IF;
    UPDATE public.bot_action_queue
       SET status='pending', retry_count=0, attempts=0, next_retry_at=pg_catalog.clock_timestamp(), error_message=NULL, error=NULL
     WHERE idempotency_key='free-claim:' || p_request_id::text AND status='failed';
    GET DIAGNOSTICS v_requeued = ROW_COUNT;
    INSERT INTO public.audit_logs (guild_id, actor_type, actor_id, action, target_type, target_id, details)
      VALUES (p_guild_id,'customer',p_customer_id::text,'commerce.free_claim_replay','order',v_existing_order.id::text,
        jsonb_build_object('request_id',p_request_id,'product_id',p_product_id,'requeued',v_requeued > 0));
    RETURN QUERY SELECT p_request_id, NULL::uuid, NULL::uuid, 'already-claimed'; RETURN;
  END IF;
  IF COALESCE(v_policy,'one-claim') = 'one-claim' AND EXISTS (
    SELECT 1 FROM public.commerce_free_claims f WHERE f.guild_id=p_guild_id AND f.customer_id=p_customer_id AND f.product_id=p_product_id
  ) THEN
    SELECT o.* INTO v_existing_order FROM public.orders o JOIN public.commerce_free_claims f ON f.order_id=o.id
      WHERE f.guild_id=p_guild_id AND f.customer_id=p_customer_id AND f.product_id=p_product_id LIMIT 1;
    SELECT f.request_id INTO v_existing_request_id FROM public.commerce_free_claims f
      WHERE f.order_id=v_existing_order.id AND f.guild_id=p_guild_id AND f.customer_id=p_customer_id AND f.product_id=p_product_id;
    IF v_existing_order.id IS NULL OR v_existing_order.guild_id IS DISTINCT FROM p_guild_id OR v_existing_order.customer_id IS DISTINCT FROM p_customer_id OR v_existing_order.product_id IS DISTINCT FROM p_product_id THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='existing free claim order identity mismatch';
    END IF;
    UPDATE public.bot_action_queue
       SET status='pending', retry_count=0, attempts=0, next_retry_at=pg_catalog.clock_timestamp(), error_message=NULL, error=NULL
     WHERE idempotency_key='free-claim:' || v_existing_request_id::text AND status='failed';
    GET DIAGNOSTICS v_requeued = ROW_COUNT;
    INSERT INTO public.audit_logs (guild_id, actor_type, actor_id, action, target_type, target_id, details)
      VALUES (p_guild_id,'customer',p_customer_id::text,'commerce.free_claim_replay','order',v_existing_order.id::text,
        jsonb_build_object('request_id',v_existing_request_id,'product_id',p_product_id,'requeued',v_requeued > 0));
    RETURN QUERY SELECT p_request_id, NULL::uuid, NULL::uuid, 'already-claimed'; RETURN;
  END IF;
  SELECT * INTO v_existing_order FROM public.orders WHERE id=p_request_id;
  IF FOUND AND (v_existing_order.guild_id IS DISTINCT FROM p_guild_id OR v_existing_order.customer_id IS DISTINCT FROM p_customer_id OR v_existing_order.product_id IS DISTINCT FROM p_product_id OR v_existing_order.source IS DISTINCT FROM 'manual' OR v_existing_order.amount_cents IS DISTINCT FROM 0) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='free claim request collides with another order';
  END IF;
  v_order_id := p_request_id;
  INSERT INTO public.orders (
    id, order_number, customer_id, guild_id, product_id, amount_cents,
    currency, discount_cents, source, status
  ) VALUES (
    v_order_id, 'ORD-FREE-' || pg_catalog.upper(pg_catalog.replace(p_request_id::text,'-','')),
    p_customer_id, p_guild_id, p_product_id, 0, v_product.currency, 0, 'manual', 'pending'
  ) ON CONFLICT (id) DO NOTHING;
  UPDATE public.orders
     SET granted_role_ids_snapshot=COALESCE(v_product.granted_role_ids,'{}'),
         granted_channel_ids_snapshot=COALESCE(v_product.granted_channel_ids,'{}'),
         temporary_role_grants_snapshot='[]'::jsonb,
         grant_snapshot_frozen_at=pg_catalog.clock_timestamp(),
         updated_at=pg_catalog.clock_timestamp()
   WHERE id=v_order_id
     AND status='pending'
     AND grant_snapshot_frozen_at IS NULL;
  SELECT * INTO v_existing_order FROM public.orders WHERE id=v_order_id FOR UPDATE;
  IF v_existing_order.grant_snapshot_frozen_at IS NULL
     OR v_existing_order.delivery_type_snapshot IS DISTINCT FROM v_product.delivery_type THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='free claim order contract was not frozen';
  END IF;
  UPDATE public.orders SET status='completed', updated_at=pg_catalog.clock_timestamp() WHERE id=v_order_id;
  IF v_product.delivery_type = 'license_key' THEN
    v_license_id := pg_catalog.gen_random_uuid();
    v_license_plaintext := 'SMNI-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16),'hex'),1,4)) || '-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16),'hex'),1,4)) || '-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16),'hex'),1,4)) || '-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16),'hex'),1,4));
    INSERT INTO public.license_keys (id, order_id, customer_id, product_id, guild_id, key_hash, key_prefix, key_suffix, bound_discord_id, status)
      VALUES (v_license_id, v_order_id, p_customer_id, p_product_id, p_guild_id, pg_catalog.encode(extensions.digest(v_license_plaintext,'sha256'),'hex'), 'SMNI', pg_catalog.right(v_license_plaintext,4), v_customer.discord_id, 'pending_activation');
  END IF;
  INSERT INTO public.entitlements (customer_id,guild_id,product_id,order_id,license_key_id,type,status,source,granted_role_ids,granted_channel_ids,starts_at)
  VALUES (p_customer_id,p_guild_id,p_product_id,v_order_id,v_license_id,'one_time','active','manual',COALESCE(v_product.granted_role_ids,'{}'),COALESCE(v_product.granted_channel_ids,'{}'),pg_catalog.clock_timestamp())
  ON CONFLICT DO NOTHING;
  SELECT e.id INTO v_entitlement_id FROM public.entitlements e WHERE e.order_id=v_order_id FOR SHARE;
  IF v_entitlement_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='free claim entitlement was not recorded'; END IF;
  INSERT INTO public.commerce_free_claims(request_id,guild_id,customer_id,product_id,order_id) VALUES (p_request_id,p_guild_id,p_customer_id,p_product_id,v_order_id) ON CONFLICT DO NOTHING;
  INSERT INTO public.audit_logs (guild_id, actor_type, actor_id, action, target_type, target_id, details)
    VALUES (p_guild_id,'customer',p_customer_id::text,'commerce.free_claim','order',v_order_id::text,
      jsonb_build_object('request_id',p_request_id,'product_id',p_product_id,'customer_id',p_customer_id,'delivery_type',v_product.delivery_type));
  INSERT INTO public.bot_action_queue (guild_id, action, payload, status, lane, idempotency_key)
  VALUES (p_guild_id, 'fulfill_purchase', jsonb_build_object(
    'fulfillment_type','one_time_purchase','guild_id',p_guild_id,
    'customer_id',p_customer_id,'discord_id',v_customer.discord_id,
    'product_id',p_product_id,'product_name',v_product.name,
    'order_id',v_order_id,'order_number','ORD-FREE-' || pg_catalog.upper(pg_catalog.replace(p_request_id::text,'-','')),
    'amount_cents',0,'currency',v_product.currency,'granted_role_ids',COALESCE(v_product.granted_role_ids,'{}'),
    'granted_channel_ids',COALESCE(v_product.granted_channel_ids,'{}'),'temporary_role_grants','[]'::jsonb,
    'entitlement_type','one_time','free_claim',true,
    'license_key_id',v_license_id,'license_key_plaintext',v_license_plaintext), 'pending', 'commerce', 'free-claim:' || p_request_id::text)
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  RETURN QUERY SELECT p_request_id,v_order_id,v_entitlement_id,'claimed';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_claim_free_product(uuid,text,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_claim_free_product(uuid,text,uuid,uuid)
  TO service_role;

COMMIT;
