-- Safe non-PayPal free claims and validated gift intent ledger. Gifts retain
-- the buyer/payment order while routing the existing fulfillment outbox to a
-- guild-scoped recipient exactly once.
BEGIN;

CREATE TABLE IF NOT EXISTS public.commerce_free_claims (
  request_id uuid PRIMARY KEY,
  guild_id text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, customer_id, product_id, request_id)
);
ALTER TABLE public.commerce_free_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_free_claims FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS service_role_all ON public.commerce_free_claims;
CREATE POLICY service_role_all ON public.commerce_free_claims FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON public.commerce_free_claims TO service_role;

CREATE TABLE IF NOT EXISTS public.commerce_gift_intents (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL,
  buyer_customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  recipient_discord_id text NOT NULL CHECK (recipient_discord_id ~ '^[0-9]{17,20}$'),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fulfilled','cancelled')),
  fulfilled_order_id uuid REFERENCES public.orders(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  checkout_token text NOT NULL DEFAULT '',
  UNIQUE (id, guild_id)
);
ALTER TABLE public.commerce_gift_intents ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes');
ALTER TABLE public.commerce_gift_intents ADD COLUMN IF NOT EXISTS checkout_token text;
UPDATE public.commerce_gift_intents SET checkout_token = pg_catalog.substr(md5(id::text), 1, 16) WHERE checkout_token IS NULL OR checkout_token = '';
ALTER TABLE public.commerce_gift_intents ALTER COLUMN checkout_token SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_gift_intents_checkout_token ON public.commerce_gift_intents (checkout_token);
CREATE INDEX IF NOT EXISTS idx_commerce_gift_intents_pending ON public.commerce_gift_intents (guild_id, buyer_customer_id, product_id, status, expires_at);
ALTER TABLE public.commerce_gift_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_gift_intents FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS service_role_all ON public.commerce_gift_intents;
CREATE POLICY service_role_all ON public.commerce_gift_intents FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public.commerce_gift_intents TO service_role;

-- PayPal custom_id is an opaque lookup handle only. All tenant, buyer,
-- product, and gift identity lives here and is validated again by webhooks.
CREATE TABLE IF NOT EXISTS public.commerce_checkout_intents (
  token uuid PRIMARY KEY,
  guild_id text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  plan_id uuid,
  gift_checkout_token text,
  provider_id text,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','bound','captured','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '45 minutes')
);
ALTER TABLE public.commerce_checkout_intents ADD COLUMN IF NOT EXISTS plan_id uuid;
ALTER TABLE public.commerce_checkout_intents ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE public.commerce_checkout_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_checkout_intents FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS service_role_all ON public.commerce_checkout_intents;
CREATE POLICY service_role_all ON public.commerce_checkout_intents FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public.commerce_checkout_intents TO service_role;
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_checkout_intents_provider ON public.commerce_checkout_intents(provider_id) WHERE provider_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_checkout_intents_gift_open
  ON public.commerce_checkout_intents(gift_checkout_token)
  WHERE gift_checkout_token IS NOT NULL AND status IN ('pending','bound');
CREATE INDEX IF NOT EXISTS idx_commerce_checkout_intents_expiry ON public.commerce_checkout_intents(expires_at, status);

CREATE TABLE IF NOT EXISTS public.commerce_provider_money_recovery (
  webhook_event_id text PRIMARY KEY,
  provider_resource_id text,
  provider_parent_id text,
  guild_id text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','refunded','resolved')),
  attempts integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
ALTER TABLE public.commerce_provider_money_recovery ALTER COLUMN provider_resource_id DROP NOT NULL;
ALTER TABLE public.commerce_provider_money_recovery ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.commerce_provider_money_recovery ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
ALTER TABLE public.commerce_provider_money_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_provider_money_recovery FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS service_role_all ON public.commerce_provider_money_recovery;
CREATE POLICY service_role_all ON public.commerce_provider_money_recovery FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public.commerce_provider_money_recovery TO service_role;

-- Free claims use the same durable role-intent machinery, but a distinct
-- classifier: they have no payment carrier and must never be admitted to the
-- paid contract merely because a snapshot happens to be present.
CREATE OR REPLACE FUNCTION public.commerce_free_role_delivery_business_contract_state(p_intent_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE i public.commerce_role_delivery_intents%ROWTYPE; q public.bot_action_queue%ROWTYPE;
  o public.orders%ROWTYPE; e public.entitlements%ROWTYPE; c public.customers%ROWTYPE;
BEGIN
  SELECT * INTO i FROM public.commerce_role_delivery_intents WHERE id=p_intent_id;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  SELECT * INTO q FROM public.bot_action_queue WHERE id=i.action_id;
  SELECT * INTO o FROM public.orders WHERE id=i.order_id;
  SELECT * INTO e FROM public.entitlements WHERE id=i.entitlement_id;
  SELECT * INTO c FROM public.customers WHERE id=i.customer_id;
  IF q.id IS NULL OR q.action IS DISTINCT FROM 'fulfill_purchase' OR q.payload->>'free_claim' IS DISTINCT FROM 'true'
     OR i.entitlement_type IS DISTINCT FROM 'one_time' OR o.id IS NULL OR e.id IS NULL OR c.id IS NULL
     OR o.source IS DISTINCT FROM 'manual' OR o.amount_cents IS DISTINCT FROM 0 OR o.status IS NULL OR o.status NOT IN ('completed','pending_review')
     OR o.grant_snapshot_frozen_at IS NULL OR o.customer_id IS DISTINCT FROM i.customer_id OR o.guild_id IS DISTINCT FROM i.guild_id OR o.product_id IS DISTINCT FROM i.product_id
     OR e.source IS DISTINCT FROM 'manual' OR e.customer_id IS DISTINCT FROM i.customer_id OR e.order_id IS DISTINCT FROM i.order_id OR e.product_id IS DISTINCT FROM i.product_id
     OR c.guild_id IS DISTINCT FROM i.guild_id OR c.discord_id IS DISTINCT FROM i.discord_id
     OR public.commerce_jsonb_snowflake_snapshot_matches(q.payload->'granted_role_ids', i.permanent_role_ids) IS NOT TRUE
     OR o.granted_role_ids_snapshot IS DISTINCT FROM i.permanent_role_ids THEN RETURN 'invalid'; END IF;
  IF o.status IS NULL OR o.status NOT IN ('completed','pending_review') OR e.status IS NULL OR e.status NOT IN ('active','pending','grace_period','suspended') THEN RETURN 'terminal'; END IF;
  RETURN 'live';
END; $$;
REVOKE ALL ON FUNCTION public.commerce_free_role_delivery_business_contract_state(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_role_delivery_business_contract_state(p_intent_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text; free_claim boolean;
BEGIN
  SELECT intent.contract_kind, queue.payload->>'free_claim'='true' INTO k, free_claim
    FROM public.commerce_role_delivery_intents intent LEFT JOIN public.bot_action_queue queue ON queue.id=intent.action_id
   WHERE intent.id=p_intent_id;
  IF free_claim THEN RETURN public.commerce_free_role_delivery_business_contract_state(p_intent_id); END IF;
  IF k='paid' THEN RETURN public.commerce_paid_role_delivery_business_contract_state(p_intent_id); END IF;
  IF k='noncommerce' THEN RETURN public.commerce_noncommerce_role_delivery_business_contract_state(p_intent_id); END IF;
  RETURN 'invalid';
END; $$;
REVOKE ALL ON FUNCTION public.commerce_role_delivery_business_contract_state(uuid) FROM PUBLIC, anon, authenticated, service_role;

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
  IF COALESCE(v_policy,'one-claim') = 'one-claim' AND EXISTS (
    SELECT 1 FROM public.commerce_free_claims f WHERE f.guild_id=p_guild_id AND f.customer_id=p_customer_id AND f.product_id=p_product_id
  ) THEN
    SELECT o, f.request_id INTO v_existing_order, v_existing_request_id FROM public.orders o JOIN public.commerce_free_claims f ON f.order_id=o.id
      WHERE f.guild_id=p_guild_id AND f.customer_id=p_customer_id AND f.product_id=p_product_id LIMIT 1;
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
  INSERT INTO public.orders (id, order_number, customer_id, guild_id, product_id, amount_cents, currency, discount_cents, source, status, delivery_type_snapshot, granted_role_ids_snapshot, granted_channel_ids_snapshot, temporary_role_grants_snapshot, grant_snapshot_frozen_at)
  VALUES (v_order_id, 'ORD-FREE-' || pg_catalog.upper(pg_catalog.replace(p_request_id::text,'-','')), p_customer_id, p_guild_id, p_product_id, 0, 'USD', 0, 'manual', 'completed', v_product.delivery_type, COALESCE(v_product.granted_role_ids,'{}'), COALESCE(v_product.granted_channel_ids,'{}'), '[]'::jsonb, pg_catalog.clock_timestamp())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.entitlements (customer_id,guild_id,product_id,order_id,type,status,source,granted_role_ids,granted_channel_ids,starts_at)
  VALUES (p_customer_id,p_guild_id,p_product_id,v_order_id,'one_time','active','manual',COALESCE(v_product.granted_role_ids,'{}'),COALESCE(v_product.granted_channel_ids,'{}'),pg_catalog.clock_timestamp())
  ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING;
  SELECT e.id INTO v_entitlement_id FROM public.entitlements e WHERE e.order_id=v_order_id FOR SHARE;
  IF v_entitlement_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='free claim entitlement was not recorded'; END IF;
  INSERT INTO public.commerce_free_claims(request_id,guild_id,customer_id,product_id,order_id) VALUES (p_request_id,p_guild_id,p_customer_id,p_product_id,v_order_id) ON CONFLICT DO NOTHING;
  INSERT INTO public.audit_logs (guild_id, actor_type, actor_id, action, target_type, target_id, details)
    VALUES (p_guild_id,'customer',p_customer_id::text,'commerce.free_claim','order',v_order_id::text,
      jsonb_build_object('request_id',p_request_id,'product_id',p_product_id,'customer_id',p_customer_id,'delivery_type',v_product.delivery_type));
  IF v_product.delivery_type = 'license_key' THEN
    v_license_id := pg_catalog.gen_random_uuid();
    v_license_plaintext := 'SMNI-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16),'hex'),1,4)) || '-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16),'hex'),1,4)) || '-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16),'hex'),1,4)) || '-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16),'hex'),1,4));
    INSERT INTO public.license_keys (id, order_id, customer_id, product_id, guild_id, key_hash, key_prefix, key_suffix, bound_discord_id, status)
      VALUES (v_license_id, v_order_id, p_customer_id, p_product_id, p_guild_id, pg_catalog.encode(extensions.digest(v_license_plaintext,'sha256'),'hex'), 'SMNI', pg_catalog.right(v_license_plaintext,4), v_customer.discord_id, 'pending_activation');
    UPDATE public.entitlements SET license_key_id=v_license_id WHERE order_id=v_order_id;
  END IF;
  INSERT INTO public.bot_action_queue (guild_id, action, payload, status, lane, idempotency_key)
  VALUES (p_guild_id, 'fulfill_purchase', jsonb_build_object(
    'fulfillment_type','one_time_purchase','guild_id',p_guild_id,
    'customer_id',p_customer_id,'discord_id',v_customer.discord_id,
    'product_id',p_product_id,'product_name',v_product.name,
    'order_id',v_order_id,'order_number','ORD-FREE-' || pg_catalog.upper(pg_catalog.replace(p_request_id::text,'-','')),
    'amount_cents',0,'currency','USD','granted_role_ids',COALESCE(v_product.granted_role_ids,'{}'),
    'granted_channel_ids',COALESCE(v_product.granted_channel_ids,'{}'),'temporary_role_grants','[]'::jsonb,
    'entitlement_type','one_time','free_claim',true,
    'license_key_id',v_license_id,'license_key_plaintext',v_license_plaintext), 'pending', 'commerce', 'free-claim:' || p_request_id::text)
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN QUERY SELECT p_request_id,v_order_id,v_entitlement_id,'claimed';
END; $$;
REVOKE ALL ON FUNCTION public.commerce_claim_free_product(uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_claim_free_product(uuid,text,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_create_gift_intent(
  p_id uuid, p_guild_id text, p_buyer_customer_id uuid, p_product_id uuid, p_recipient_discord_id text
)
RETURNS TABLE (id uuid, disposition text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_id IS NULL OR p_guild_id IS NULL OR p_buyer_customer_id IS NULL OR p_product_id IS NULL
     OR p_recipient_discord_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='gift intent identity is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.guild_config gc WHERE gc.guild_id=p_guild_id AND gc.gifting_enabled IS TRUE)
     OR NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id=p_buyer_customer_id AND c.guild_id=p_guild_id)
     OR NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id=p_product_id AND p.guild_id=p_guild_id AND p.active IS TRUE AND p.type = 'one_time' AND p.price_cents > 0) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='gifting is unavailable for this product';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commerce_gift_intents WHERE id=p_id AND status='fulfilled') THEN
    RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='gift intent has already been fulfilled';
  END IF;
  UPDATE public.commerce_gift_intents
     SET status='cancelled'
   WHERE guild_id=p_guild_id AND buyer_customer_id=p_buyer_customer_id
     AND product_id=p_product_id AND status='pending' AND expires_at <= pg_catalog.clock_timestamp();
  IF EXISTS (SELECT 1 FROM public.commerce_gift_intents WHERE id=p_id) THEN
    RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='gift intent id already exists';
  END IF;
  INSERT INTO public.commerce_gift_intents(id,guild_id,buyer_customer_id,product_id,recipient_discord_id,expires_at,checkout_token)
  VALUES (p_id,p_guild_id,p_buyer_customer_id,p_product_id,p_recipient_discord_id,pg_catalog.clock_timestamp() + interval '30 minutes',pg_catalog.encode(extensions.gen_random_bytes(24),'hex'));
  RETURN QUERY SELECT p_id, 'created';
END; $$;
REVOKE ALL ON FUNCTION public.commerce_create_gift_intent(uuid,text,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_create_gift_intent(uuid,text,uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_claim_gift_fulfillment(
  p_intent_id uuid, p_order_id uuid, p_guild_id text, p_buyer_customer_id uuid, p_product_id uuid
)
RETURNS TABLE (disposition text, recipient_customer_id uuid, recipient_discord_id text, buyer_customer_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_intent public.commerce_gift_intents%ROWTYPE; v_recipient uuid; v_order public.orders%ROWTYPE; v_buyer public.customers%ROWTYPE;
BEGIN
  IF p_intent_id IS NULL OR p_order_id IS NULL OR p_guild_id IS NULL OR p_buyer_customer_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='gift fulfillment identity is invalid';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gift:'||p_intent_id::text,0));
  SELECT * INTO v_intent FROM public.commerce_gift_intents WHERE id=p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_intent.guild_id<>p_guild_id OR v_intent.buyer_customer_id<>p_buyer_customer_id OR v_intent.product_id<>p_product_id THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='gift intent identity mismatch';
  END IF;
  SELECT * INTO v_buyer FROM public.customers WHERE id=p_buyer_customer_id AND guild_id=p_guild_id FOR SHARE;
  SELECT * INTO v_order FROM public.orders WHERE id=p_order_id AND guild_id=p_guild_id AND customer_id=p_buyer_customer_id AND product_id=p_product_id FOR SHARE;
  IF v_buyer.id IS NULL OR v_order.id IS NULL OR v_order.source <> 'purchase' OR v_order.status NOT IN ('completed','pending_review')
     OR v_order.amount_cents <= 0 OR v_order.paypal_order_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.payments pay WHERE pay.order_id=p_order_id AND pay.guild_id=p_guild_id AND pay.customer_id=p_buyer_customer_id AND pay.provider='paypal' AND pay.paypal_resource_type='capture' AND pay.amount_cents=v_order.amount_cents AND pay.currency=v_order.currency AND pay.status='completed') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='gift order/payment identity is not proven';
  END IF;
  IF v_intent.status='fulfilled' THEN
    IF v_intent.fulfilled_order_id IS NULL OR v_intent.fulfilled_order_id<>p_order_id THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='gift intent replay mismatch'; END IF;
  ELSE
    IF v_intent.status<>'pending' OR v_intent.expires_at <= pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='gift intent expired or unavailable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.products WHERE id=p_product_id AND guild_id=p_guild_id AND type='one_time' AND price_cents > 0) THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='gifting is unavailable for this product';
    END IF;
    INSERT INTO public.customers (guild_id, discord_id, discord_username)
      VALUES (p_guild_id, v_intent.recipient_discord_id, 'Gift recipient')
      ON CONFLICT (discord_id,guild_id) DO NOTHING;
    SELECT id INTO v_recipient FROM public.customers WHERE guild_id=p_guild_id AND discord_id=v_intent.recipient_discord_id;
    UPDATE public.commerce_gift_intents SET status='fulfilled', fulfilled_order_id=p_order_id, fulfilled_at=pg_catalog.clock_timestamp() WHERE id=p_intent_id;
    INSERT INTO public.audit_logs (guild_id, actor_type, actor_id, action, target_type, target_id, details)
      VALUES (p_guild_id,'webhook',p_buyer_customer_id::text,'commerce.gift_fulfilled','order',p_order_id::text,
        jsonb_build_object('gift_intent_id',p_intent_id,'buyer_customer_id',p_buyer_customer_id,'recipient_customer_id',v_recipient,'recipient_discord_id',v_intent.recipient_discord_id));
  END IF;
  SELECT id INTO v_recipient FROM public.customers WHERE guild_id=p_guild_id AND discord_id=v_intent.recipient_discord_id;
  RETURN QUERY SELECT CASE WHEN v_intent.status='fulfilled' AND v_intent.fulfilled_order_id=p_order_id THEN 'fulfilled' ELSE 'claimed' END, v_recipient, v_intent.recipient_discord_id, p_buyer_customer_id;
END; $$;
REVOKE ALL ON FUNCTION public.commerce_claim_gift_fulfillment(uuid,uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_claim_gift_fulfillment(uuid,uuid,text,uuid,uuid) TO service_role;
COMMIT;
