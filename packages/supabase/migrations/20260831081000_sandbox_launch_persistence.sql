BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.commerce_product_launch_runs
  ADD COLUMN IF NOT EXISTS verification_started_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE public.commerce_checkout_intents
  ADD COLUMN IF NOT EXISTS launch_run_id uuid
  REFERENCES public.commerce_product_launch_runs(id) ON DELETE SET NULL;
ALTER TABLE public.commerce_free_claims
  ADD COLUMN IF NOT EXISTS launch_run_id uuid
  REFERENCES public.commerce_product_launch_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_checkout_intents_launch_run
  ON public.commerce_checkout_intents(launch_run_id, created_at)
  WHERE launch_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_free_claims_launch_run
  ON public.commerce_free_claims(launch_run_id, created_at)
  WHERE launch_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.commerce_activate_product_launch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_run public.commerce_product_launch_runs%ROWTYPE;
  v_policy_revision timestamptz;
  v_activated_at timestamptz := clock_timestamp();
BEGIN
  IF NEW.active IS NOT TRUE OR OLD.active IS TRUE THEN RETURN NEW; END IF;
  SELECT * INTO v_run
  FROM public.commerce_product_launch_runs
  WHERE guild_id = NEW.guild_id AND product_id = NEW.id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF v_run.state <> 'ready' OR v_run.launch_receipt_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product launch is not ready';
  END IF;
  IF (v_run.launch_receipt->>'product_revision')::timestamptz IS DISTINCT FROM OLD.updated_at
     OR (to_jsonb(NEW) - ARRAY['active', 'updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['active', 'updated_at']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product launch evidence is stale';
  END IF;
  IF NEW.delivery_type = 'license_key' THEN
    SELECT updated_at INTO v_policy_revision
    FROM public.product_license_config
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
      launch_receipt = COALESCE(launch_receipt, '{}'::jsonb) || jsonb_build_object(
        'activation', jsonb_build_object(
          'product_id', NEW.id, 'active', true, 'activated_at', v_activated_at,
          'product_revision', NEW.updated_at
        )
      ),
      updated_by = 'system:product-activation', version = version + 1,
      updated_at = v_activated_at
  WHERE id = v_run.id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_activate_product_launch()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS commerce_product_launch_activation_readback ON public.products;
CREATE TRIGGER commerce_product_launch_activation_readback
  AFTER UPDATE OF active ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.commerce_activate_product_launch();

CREATE OR REPLACE FUNCTION public.commerce_require_sandbox_product_launch(
  p_launch_run_id uuid,
  p_guild_id text,
  p_customer_id uuid,
  p_product_id uuid,
  p_verification_started_at timestamptz
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_customer public.customers%ROWTYPE;
  v_product public.products%ROWTYPE;
BEGIN
  IF p_launch_run_id IS NULL OR p_verification_started_at IS NULL
     OR NOT pg_catalog.isfinite(p_verification_started_at)
     OR p_verification_started_at > pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sandbox launch attempt is invalid';
  END IF;
  SELECT customer.* INTO v_customer FROM public.customers AS customer
   WHERE customer.id = p_customer_id AND customer.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sandbox launch customer identity mismatch';
  END IF;
  SELECT product.* INTO v_product FROM public.products AS product
   WHERE product.id = p_product_id AND product.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND OR v_product.active IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sandbox launch requires an inactive product';
  END IF;
  PERFORM 1 FROM public.commerce_product_launch_runs AS launch
    JOIN public.guild AS owner_guild ON owner_guild.id = launch.guild_id
   WHERE launch.id = p_launch_run_id
     AND launch.guild_id = p_guild_id AND launch.product_id = p_product_id
     AND launch.environment = 'sandbox'
     AND launch.state IN ('draft', 'sandbox_verifying', 'ready')
     AND launch.created_by = v_customer.discord_id
     AND owner_guild.owner_discord_id = v_customer.discord_id
     AND launch.verification_started_at = p_verification_started_at
   FOR SHARE OF launch, owner_guild;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sandbox launch owner or attempt is unavailable';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_require_sandbox_product_launch(uuid,text,uuid,uuid,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_preserve_checkout_launch_identity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_started_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.launch_run_id IS NOT NULL AND NEW.launch_run_id IS NULL
       AND (pg_catalog.to_jsonb(NEW) - 'launch_run_id')
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'launch_run_id')
       AND NOT EXISTS (
         SELECT 1 FROM public.commerce_product_launch_runs WHERE id = OLD.launch_run_id
       ) THEN
      RETURN NEW;
    END IF;
    IF OLD.launch_run_id IS NOT NULL OR NEW.launch_run_id IS NOT NULL THEN
      IF NEW.token IS DISTINCT FROM OLD.token
         OR NEW.guild_id IS DISTINCT FROM OLD.guild_id
         OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
         OR NEW.product_id IS DISTINCT FROM OLD.product_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.provider_binding IS DISTINCT FROM OLD.provider_binding
         OR (OLD.launch_run_id IS NOT NULL AND NEW.launch_run_id IS DISTINCT FROM OLD.launch_run_id) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox checkout launch identity is immutable';
      END IF;
    END IF;
    IF OLD.launch_run_id IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  IF NEW.launch_run_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM 'pending' OR NEW.provider_id IS NOT NULL
     OR NEW.order_id IS NOT NULL OR NEW.gift_checkout_token IS NOT NULL
     OR NEW.provider_binding IS NULL OR NEW.expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox run must bind before provider checkout';
  END IF;
  SELECT verification_started_at INTO v_started_at
    FROM public.commerce_product_launch_runs WHERE id = NEW.launch_run_id;
  PERFORM public.commerce_require_sandbox_product_launch(
    NEW.launch_run_id, NEW.guild_id, NEW.customer_id, NEW.product_id, v_started_at
  );
  IF NEW.created_at < v_started_at OR NOT pg_catalog.isfinite(NEW.created_at)
     OR NEW.created_at > pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sandbox checkout predates its verification attempt';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_preserve_checkout_launch_identity()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER commerce_checkout_intents_preserve_launch_identity
  BEFORE INSERT OR UPDATE ON public.commerce_checkout_intents
  FOR EACH ROW EXECUTE FUNCTION public.commerce_preserve_checkout_launch_identity();

CREATE OR REPLACE FUNCTION public.commerce_preserve_free_launch_identity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_started_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.launch_run_id IS NOT NULL THEN
    IF NEW.launch_run_id IS NULL
       AND (pg_catalog.to_jsonb(NEW) - 'launch_run_id')
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'launch_run_id')
       AND NOT EXISTS (
         SELECT 1 FROM public.commerce_product_launch_runs WHERE id = OLD.launch_run_id
       ) THEN
      RETURN NEW;
    END IF;
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox free claim proof is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.launch_run_id IS NULL THEN RETURN NEW; END IF;
  SELECT verification_started_at INTO v_started_at
    FROM public.commerce_product_launch_runs WHERE id = NEW.launch_run_id;
  PERFORM public.commerce_require_sandbox_product_launch(
    NEW.launch_run_id, NEW.guild_id, NEW.customer_id, NEW.product_id, v_started_at
  );
  IF NEW.created_at < v_started_at OR NOT pg_catalog.isfinite(NEW.created_at)
     OR NEW.created_at > pg_catalog.clock_timestamp()
     OR NOT EXISTS (
       SELECT 1 FROM public.orders AS claim_order
        WHERE claim_order.id = NEW.order_id AND claim_order.id = NEW.request_id
          AND claim_order.guild_id = NEW.guild_id AND claim_order.customer_id = NEW.customer_id
          AND claim_order.product_id = NEW.product_id AND claim_order.source = 'manual'
          AND claim_order.amount_cents = 0 AND claim_order.status = 'pending'
          AND claim_order.grant_snapshot_frozen_at IS NULL
          AND claim_order.created_at >= v_started_at
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox free proof must bind before grant freeze';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_preserve_free_launch_identity()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER commerce_free_claims_preserve_launch_identity
  BEFORE INSERT OR UPDATE ON public.commerce_free_claims
  FOR EACH ROW EXECUTE FUNCTION public.commerce_preserve_free_launch_identity();

CREATE OR REPLACE FUNCTION public.commerce_bind_checkout_launch(
  p_checkout_token uuid, p_guild_id text, p_customer_id uuid, p_product_id uuid,
  p_launch_run_id uuid, p_verification_started_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_intent public.commerce_checkout_intents%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM public.commerce_checkout_intents
   WHERE token = p_checkout_token FOR UPDATE;
  IF NOT FOUND OR v_intent.guild_id IS DISTINCT FROM p_guild_id
     OR v_intent.customer_id IS DISTINCT FROM p_customer_id
     OR v_intent.product_id IS DISTINCT FROM p_product_id
     OR v_intent.status IS DISTINCT FROM 'pending'
     OR v_intent.provider_id IS NOT NULL OR v_intent.order_id IS NOT NULL
     OR v_intent.gift_checkout_token IS NOT NULL
     OR v_intent.expires_at <= pg_catalog.clock_timestamp()
     OR v_intent.created_at < p_verification_started_at
     OR (v_intent.launch_run_id IS NOT NULL AND v_intent.launch_run_id IS DISTINCT FROM p_launch_run_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sandbox checkout launch binding mismatch';
  END IF;
  PERFORM public.commerce_require_sandbox_product_launch(
    p_launch_run_id, p_guild_id, p_customer_id, p_product_id, p_verification_started_at
  );
  UPDATE public.commerce_checkout_intents SET launch_run_id = p_launch_run_id
   WHERE token = p_checkout_token;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_bind_checkout_launch(uuid,text,uuid,uuid,uuid,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_bind_checkout_launch(uuid,text,uuid,uuid,uuid,timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_require_launch_checkout_intent(
  p_checkout_token uuid, p_verification_started_at timestamptz
)
RETURNS public.commerce_checkout_intents
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_intent public.commerce_checkout_intents%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM public.commerce_checkout_intents
   WHERE token = p_checkout_token FOR UPDATE;
  IF NOT FOUND OR v_intent.launch_run_id IS NULL
     OR v_intent.status NOT IN ('pending', 'bound')
     OR v_intent.expires_at <= pg_catalog.clock_timestamp()
     OR v_intent.created_at < p_verification_started_at
     OR v_intent.gift_checkout_token IS NOT NULL OR v_intent.provider_binding IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sandbox checkout intent is unavailable';
  END IF;
  PERFORM public.commerce_require_sandbox_product_launch(
    v_intent.launch_run_id, v_intent.guild_id, v_intent.customer_id,
    v_intent.product_id, p_verification_started_at
  );
  RETURN v_intent;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_require_launch_checkout_intent(uuid,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_order_is_sandbox_launch(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p_order public.orders%ROWTYPE;
  v_run_id uuid;
  v_proof_created_at timestamptz;
BEGIN
  SELECT * INTO p_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_order.grant_snapshot_frozen_at IS NOT NULL OR p_order.status IS DISTINCT FROM 'pending'
     OR p_order.created_at IS NULL OR NOT pg_catalog.isfinite(p_order.created_at)
     OR p_order.created_at > pg_catalog.clock_timestamp() THEN RETURN false; END IF;
  IF p_order.source = 'manual' AND p_order.amount_cents = 0 THEN
    SELECT claim.launch_run_id, claim.created_at INTO v_run_id, v_proof_created_at
      FROM public.commerce_free_claims AS claim
     WHERE claim.order_id = p_order.id AND claim.request_id = p_order.id
       AND claim.guild_id = p_order.guild_id AND claim.customer_id = p_order.customer_id
       AND claim.product_id = p_order.product_id;
  ELSIF p_order.source = 'purchase' AND p_order.checkout_active IS TRUE THEN
    IF (p_order.paypal_order_id IS NULL) = (p_order.paypal_subscription_id IS NULL)
       OR p_order.checkout_approval_url IS NULL
       OR p_order.checkout_approval_url !~ '^https://(www\.)?sandbox\.paypal\.com/' THEN RETURN false; END IF;
    SELECT intent.launch_run_id, intent.created_at INTO v_run_id, v_proof_created_at
      FROM public.commerce_checkout_intents AS intent
     WHERE intent.provider_id = COALESCE(p_order.paypal_order_id, p_order.paypal_subscription_id)
       AND intent.guild_id = p_order.guild_id AND intent.customer_id = p_order.customer_id
       AND intent.product_id = p_order.product_id
       AND intent.plan_id IS NOT DISTINCT FROM p_order.plan_id
       AND (intent.order_id IS NULL OR intent.order_id = p_order.id)
       AND intent.status IN ('pending', 'bound') AND intent.gift_checkout_token IS NULL
       AND intent.provider_binding IS NOT NULL
       AND intent.expires_at > pg_catalog.clock_timestamp();
  ELSE
    RETURN false;
  END IF;
  IF v_run_id IS NULL OR v_proof_created_at IS NULL
     OR NOT pg_catalog.isfinite(v_proof_created_at)
     OR v_proof_created_at > pg_catalog.clock_timestamp() THEN RETURN false; END IF;
  PERFORM 1 FROM public.commerce_product_launch_runs AS launch
    JOIN public.customers AS customer ON customer.id = p_order.customer_id AND customer.guild_id = launch.guild_id
    JOIN public.guild AS owner_guild ON owner_guild.id = launch.guild_id
    JOIN public.products AS product ON product.id = launch.product_id AND product.guild_id = launch.guild_id
   WHERE launch.id = v_run_id AND launch.guild_id = p_order.guild_id
     AND launch.product_id = p_order.product_id AND product.active IS FALSE
     AND launch.environment = 'sandbox' AND launch.state IN ('draft', 'sandbox_verifying', 'ready')
     AND launch.created_by = customer.discord_id AND owner_guild.owner_discord_id = customer.discord_id
     AND pg_catalog.isfinite(launch.verification_started_at)
     AND v_proof_created_at >= launch.verification_started_at
     AND p_order.created_at >= launch.verification_started_at
   FOR SHARE OF launch, customer, owner_guild, product;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_order_is_sandbox_launch(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_select_sandbox_product_plan(p_guild_id text, p_product_id uuid)
RETURNS SETOF public.plans
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT candidate.* FROM public.plans AS candidate
    JOIN public.products AS parent ON parent.id = candidate.product_id AND parent.guild_id = candidate.guild_id
   WHERE candidate.guild_id = p_guild_id AND candidate.product_id = p_product_id
     AND candidate.active IS TRUE AND candidate.paypal_plan_id IS NOT NULL
     AND pg_catalog.btrim(candidate.paypal_plan_id) <> ''
     AND parent.active IS FALSE AND parent.type = 'subscription'
   ORDER BY candidate.price_cents, candidate.id LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.commerce_select_sandbox_product_plan(text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_select_order_checkout_plan(p_guild_id text, p_product_id uuid, p_order_id uuid)
RETURNS SETOF public.plans
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF public.commerce_order_is_sandbox_launch(p_order_id) THEN
    RETURN QUERY SELECT * FROM public.commerce_select_sandbox_product_plan(p_guild_id, p_product_id);
  ELSE
    RETURN QUERY SELECT * FROM public.commerce_select_checkout_plan(p_guild_id, p_product_id);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_select_order_checkout_plan(text,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_select_launch_checkout_plan(
  p_checkout_token uuid, p_verification_started_at timestamptz
)
RETURNS SETOF public.plans
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_intent public.commerce_checkout_intents%ROWTYPE;
BEGIN
  v_intent := public.commerce_require_launch_checkout_intent(p_checkout_token, p_verification_started_at);
  RETURN QUERY SELECT * FROM public.commerce_select_sandbox_product_plan(v_intent.guild_id, v_intent.product_id);
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_select_launch_checkout_plan(uuid,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_select_launch_checkout_plan(uuid,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_reserve_launch_checkout_pricing(
  p_checkout_token uuid, p_verification_started_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_intent public.commerce_checkout_intents%ROWTYPE;
  v_product public.products%ROWTYPE;
BEGIN
  v_intent := public.commerce_require_launch_checkout_intent(p_checkout_token, p_verification_started_at);
  SELECT * INTO v_product FROM public.products WHERE id = v_intent.product_id AND guild_id = v_intent.guild_id;
  IF v_intent.status IS DISTINCT FROM 'pending' OR v_product.type IS DISTINCT FROM 'one_time'
     OR v_product.price_cents IS NULL OR v_product.price_cents < 1
     OR v_intent.promotion_id IS NOT NULL OR v_intent.discount_cents IS DISTINCT FROM 0
     OR (v_intent.final_amount_cents IS NOT NULL AND v_intent.final_amount_cents IS DISTINCT FROM v_product.price_cents) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox launch pricing contract mismatch';
  END IF;
  UPDATE public.commerce_checkout_intents SET final_amount_cents = v_product.price_cents
   WHERE token = p_checkout_token;
  RETURN pg_catalog.jsonb_build_object(
    'amount_cents', v_product.price_cents, 'discount_cents', 0, 'promotion_id', NULL, 'coupon_code', NULL
  );
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_reserve_launch_checkout_pricing(uuid,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_reserve_launch_checkout_pricing(uuid,timestamptz) TO service_role;

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
     OR (v_product.active IS DISTINCT FROM true
         AND NOT public.commerce_order_is_sandbox_launch(OLD.id))
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

CREATE OR REPLACE FUNCTION public.commerce_protect_order_grant_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pending_subscription_reprice BOOLEAN := false;
  v_product public.products%ROWTYPE;
  v_plan public.plans%ROWTYPE;
  v_expected_temp_snapshot JSONB := '[]'::JSONB;
BEGIN
  -- Authenticated owners can insert orders, so a caller-supplied frozen marker
  -- must never bypass the authoritative freeze transition below.
  IF TG_OP = 'INSERT' THEN
    IF NEW.grant_snapshot_frozen_at IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce order cannot be inserted with a frozen sale contract';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.grant_snapshot_frozen_at IS NULL
     AND NEW.grant_snapshot_frozen_at IS NOT NULL THEN
    -- The freeze RPC changes only the canonical snapshots, timestamp, and
    -- updated_at. A direct first-freeze update is safe only when it has the
    -- same shape and exact authoritative values.
    IF OLD.status <> 'pending'
       OR NEW.status <> 'pending'
       OR NOT pg_catalog.isfinite(NEW.grant_snapshot_frozen_at)
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.order_number IS DISTINCT FROM OLD.order_number
       OR NEW.guild_id IS DISTINCT FROM OLD.guild_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
       OR NEW.paypal_order_id IS DISTINCT FROM OLD.paypal_order_id
       OR NEW.paypal_subscription_id IS DISTINCT FROM OLD.paypal_subscription_id
       OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.discount_cents IS DISTINCT FROM OLD.discount_cents
       OR NEW.promotion_id IS DISTINCT FROM OLD.promotion_id
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce order initial freeze changed the sale identity';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.customers AS customer
       WHERE customer.id = OLD.customer_id
         AND customer.guild_id = OLD.guild_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce order initial freeze customer identity mismatch';
    END IF;

    SELECT product.*
      INTO v_product
      FROM public.products AS product
     WHERE product.id = OLD.product_id
       AND product.guild_id = OLD.guild_id
     FOR SHARE;

    IF NOT FOUND
       OR (v_product.active IS DISTINCT FROM true
           AND NOT public.commerce_order_is_sandbox_launch(OLD.id))
       OR NOT public.commerce_valid_snowflake_snapshot(
         COALESCE(v_product.granted_role_ids, '{}'::TEXT[])
       )
       OR NOT public.commerce_valid_snowflake_snapshot(
         COALESCE(v_product.granted_channel_ids, '{}'::TEXT[])
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce order initial freeze product identity mismatch';
    END IF;

    IF v_product.type = 'subscription' THEN
      PERFORM 1
        FROM public.plans AS plan
       WHERE plan.product_id = OLD.product_id
         AND plan.guild_id = OLD.guild_id
       ORDER BY plan.id
       FOR SHARE;
    END IF;

    -- Keep the direct first-freeze path in the same row-before-advisory order
    -- as the RPC and catalog writers. The order row is already locked by the
    -- UPDATE; product and (for subscriptions) existing plan rows precede the
    -- guild advisory lock. The authoritative plan selection is repeated under
    -- that advisory lock below, so concurrent inserts/moves choose a serial
    -- winner without a row/advisory cycle.
    PERFORM public.commerce_income_wall_lock_guild(OLD.guild_id);

    IF NOT COALESCE((
      OLD.source = 'purchase'
      OR (
        OLD.source IS NULL
        AND OLD.paypal_order_id IS NOT NULL
        AND OLD.paypal_order_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
      )
    ), false) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce order initial freeze is not a paid purchase';
    END IF;

    IF v_product.type = 'one_time' THEN
      IF v_product.price_cents IS NULL
         OR v_product.price_cents <= 0
         OR OLD.amount_cents IS DISTINCT FROM v_product.price_cents
         OR OLD.currency IS DISTINCT FROM v_product.currency
         OR OLD.paypal_order_id IS NULL
         OR OLD.paypal_order_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
         OR OLD.paypal_subscription_id IS NOT NULL
         OR OLD.plan_id IS NOT NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'commerce order initial freeze one-time contract mismatch';
      END IF;

      SELECT COALESCE(
               pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'role_id', temporary.role_id,
                   'duration_seconds', temporary.duration_seconds
                 )
                 ORDER BY temporary.role_id ASC, temporary.id ASC
               ),
               '[]'::JSONB
             )
        INTO v_expected_temp_snapshot
        FROM public.commerce_product_temp_role_config AS temporary
       WHERE temporary.guild_id = OLD.guild_id
         AND temporary.product_id = OLD.product_id;
    ELSIF v_product.type = 'subscription' THEN
      IF OLD.paypal_subscription_id IS NULL
         OR pg_catalog.btrim(OLD.paypal_subscription_id) = '' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'commerce order initial freeze subscription identity mismatch';
      END IF;

      SELECT selected.*
        INTO v_plan
        FROM public.commerce_select_order_checkout_plan(OLD.guild_id, OLD.product_id, OLD.id) AS selected;

      IF NOT FOUND
         OR OLD.plan_id IS DISTINCT FROM v_plan.id
         OR OLD.amount_cents IS DISTINCT FROM v_plan.price_cents
         OR OLD.currency IS DISTINCT FROM v_plan.currency THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'commerce order initial freeze subscription contract mismatch';
      END IF;
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce order initial freeze has unsupported product type';
    END IF;

    IF NEW.granted_role_ids_snapshot IS DISTINCT FROM COALESCE(
         v_product.granted_role_ids,
         '{}'::TEXT[]
       )
       OR NEW.granted_channel_ids_snapshot IS DISTINCT FROM COALESCE(
         v_product.granted_channel_ids,
         '{}'::TEXT[]
       )
       OR NEW.temporary_role_grants_snapshot IS DISTINCT FROM v_expected_temp_snapshot THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce order initial freeze grant snapshot mismatch';
    END IF;

    RETURN NEW;
  END IF;

  -- Subscription activation may discover that the provider's authoritative
  -- amount/currency differs from the local pending checkout placeholder. Keep
  -- that compatibility surface deliberately narrow: a frozen purchase with a
  -- selected plan and provider subscription identity may correct only those
  -- financial fields while it remains pending. Once it leaves pending, or for
  -- every one-time order, the financial contract is immutable too.
  v_pending_subscription_reprice := COALESCE((
    OLD.grant_snapshot_frozen_at IS NOT NULL
    AND OLD.status = 'pending'
    AND NEW.status = 'pending'
    AND OLD.source IS NOT DISTINCT FROM 'purchase'
    AND OLD.plan_id IS NOT NULL
    AND OLD.paypal_subscription_id IS NOT NULL
    AND pg_catalog.btrim(OLD.paypal_subscription_id) <> ''
    AND NEW.amount_cents IS NOT NULL
    AND NEW.amount_cents >= 0
    AND NEW.currency IS NOT NULL
    AND NEW.currency ~ '^[A-Z]{3}$'
    AND (
      NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
      OR NEW.currency IS DISTINCT FROM OLD.currency
    )
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.order_number IS NOT DISTINCT FROM OLD.order_number
    AND NEW.guild_id IS NOT DISTINCT FROM OLD.guild_id
    AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
    AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
    AND NEW.plan_id IS NOT DISTINCT FROM OLD.plan_id
    AND NEW.paypal_order_id IS NOT DISTINCT FROM OLD.paypal_order_id
    AND NEW.paypal_subscription_id IS NOT DISTINCT FROM OLD.paypal_subscription_id
    AND NEW.discount_cents IS NOT DISTINCT FROM OLD.discount_cents
    AND NEW.promotion_id IS NOT DISTINCT FROM OLD.promotion_id
    AND NEW.source IS NOT DISTINCT FROM OLD.source
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
    AND NEW.granted_role_ids_snapshot IS NOT DISTINCT FROM OLD.granted_role_ids_snapshot
    AND NEW.granted_channel_ids_snapshot IS NOT DISTINCT FROM OLD.granted_channel_ids_snapshot
    AND NEW.temporary_role_grants_snapshot IS NOT DISTINCT FROM OLD.temporary_role_grants_snapshot
    AND NEW.grant_snapshot_frozen_at IS NOT DISTINCT FROM OLD.grant_snapshot_frozen_at
  ), false);

  IF OLD.grant_snapshot_frozen_at IS NOT NULL
     AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.order_number IS DISTINCT FROM OLD.order_number
       OR NEW.guild_id IS DISTINCT FROM OLD.guild_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
       OR NEW.paypal_order_id IS DISTINCT FROM OLD.paypal_order_id
       OR NEW.paypal_subscription_id IS DISTINCT FROM OLD.paypal_subscription_id
       OR (
         (
           NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
           OR NEW.currency IS DISTINCT FROM OLD.currency
         )
         AND NOT v_pending_subscription_reprice
       )
       OR NEW.discount_cents IS DISTINCT FROM OLD.discount_cents
       OR NEW.promotion_id IS DISTINCT FROM OLD.promotion_id
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.granted_role_ids_snapshot IS DISTINCT FROM OLD.granted_role_ids_snapshot
       OR NEW.granted_channel_ids_snapshot IS DISTINCT FROM OLD.granted_channel_ids_snapshot
       OR NEW.temporary_role_grants_snapshot IS DISTINCT FROM OLD.temporary_role_grants_snapshot
       OR NEW.grant_snapshot_frozen_at IS DISTINCT FROM OLD.grant_snapshot_frozen_at
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce order sale contract is immutable after freeze';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_protect_order_grant_snapshot()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_claim_free_product_for_launch(
  p_request_id uuid, p_guild_id text, p_customer_id uuid, p_product_id uuid,
  p_launch_run_id uuid, p_verification_started_at timestamptz
)
RETURNS TABLE (request_id uuid, order_id uuid, entitlement_id uuid, disposition text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_product public.products%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_claim public.commerce_free_claims%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_entitlement_id uuid;
  v_license_plaintext text;
  v_license_id uuid;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox free claim request is required';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_guild_id || E'\x1f' || p_customer_id::text || E'\x1f' || p_product_id::text, 0
  ));
  PERFORM public.commerce_require_sandbox_product_launch(
    p_launch_run_id, p_guild_id, p_customer_id, p_product_id, p_verification_started_at
  );
  SELECT * INTO v_product FROM public.products WHERE id = p_product_id AND guild_id = p_guild_id;
  SELECT * INTO v_customer FROM public.customers WHERE id = p_customer_id AND guild_id = p_guild_id;
  IF v_product.type IS DISTINCT FROM 'free' OR v_product.price_cents IS DISTINCT FROM 0
     OR v_product.delivery_type NOT IN ('file', 'link', 'access_pass', 'license_key', 'mixed') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox launch product is not a free claim';
  END IF;
  SELECT claim.* INTO v_claim FROM public.commerce_free_claims AS claim
   WHERE claim.request_id = p_request_id;
  IF FOUND AND (v_claim.guild_id IS DISTINCT FROM p_guild_id
     OR v_claim.customer_id IS DISTINCT FROM p_customer_id OR v_claim.product_id IS DISTINCT FROM p_product_id
     OR v_claim.launch_run_id IS DISTINCT FROM p_launch_run_id
     OR v_claim.created_at < p_verification_started_at) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox free claim replay belongs to another identity or attempt';
  END IF;
  SELECT claim.* INTO v_claim FROM public.commerce_free_claims AS claim
   WHERE claim.guild_id = p_guild_id AND claim.customer_id = p_customer_id AND claim.product_id = p_product_id
     AND claim.launch_run_id = p_launch_run_id AND claim.created_at >= p_verification_started_at
   ORDER BY claim.created_at, claim.request_id LIMIT 1;
  IF FOUND THEN
    UPDATE public.bot_action_queue
       SET status = 'pending', retry_count = 0, attempts = 0,
           next_retry_at = pg_catalog.clock_timestamp(), error_message = NULL, error = NULL
     WHERE idempotency_key = 'free-claim:' || v_claim.request_id::text AND status = 'failed';
    INSERT INTO public.audit_logs (guild_id, actor_type, actor_id, action, target_type, target_id, details)
    VALUES (p_guild_id, 'customer', p_customer_id::text, 'commerce.free_claim_replay', 'order', v_claim.order_id::text,
      pg_catalog.jsonb_build_object('request_id', v_claim.request_id, 'launch_run_id', p_launch_run_id));
    RETURN QUERY SELECT v_claim.request_id, v_claim.order_id, NULL::uuid, 'already-claimed';
    RETURN;
  END IF;
  INSERT INTO public.orders (
    id, order_number, customer_id, guild_id, product_id, amount_cents, currency,
    discount_cents, source, status, checkout_active, created_at
  ) VALUES (
    p_request_id, 'ORD-FREE-' || pg_catalog.upper(pg_catalog.replace(p_request_id::text, '-', '')),
    p_customer_id, p_guild_id, p_product_id, 0, v_product.currency, 0, 'manual', 'pending', false,
    pg_catalog.clock_timestamp()
  );
  INSERT INTO public.commerce_free_claims (
    request_id, guild_id, customer_id, product_id, order_id, launch_run_id, created_at
  ) VALUES (
    p_request_id, p_guild_id, p_customer_id, p_product_id, p_request_id, p_launch_run_id, pg_catalog.clock_timestamp()
  );
  UPDATE public.orders
     SET granted_role_ids_snapshot = COALESCE(v_product.granted_role_ids, '{}'::text[]),
         granted_channel_ids_snapshot = COALESCE(v_product.granted_channel_ids, '{}'::text[]),
         temporary_role_grants_snapshot = '[]'::jsonb,
         grant_snapshot_frozen_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
   WHERE id = p_request_id
   RETURNING * INTO v_order;
  IF v_order.grant_snapshot_frozen_at IS NULL OR v_order.delivery_type_snapshot IS DISTINCT FROM v_product.delivery_type THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox free claim contract was not frozen';
  END IF;
  UPDATE public.orders SET status = 'completed', updated_at = pg_catalog.clock_timestamp() WHERE id = p_request_id;
  IF v_product.delivery_type = 'license_key' THEN
    v_license_id := pg_catalog.gen_random_uuid();
    v_license_plaintext := 'SMNI-'
      || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'), 1, 4)) || '-'
      || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'), 1, 4)) || '-'
      || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'), 1, 4)) || '-'
      || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'), 1, 4));
    INSERT INTO public.license_keys (
      id, order_id, customer_id, product_id, guild_id, key_hash, key_prefix, key_suffix, bound_discord_id, status
    ) VALUES (
      v_license_id, p_request_id, p_customer_id, p_product_id, p_guild_id,
      pg_catalog.encode(extensions.digest(v_license_plaintext, 'sha256'), 'hex'),
      'SMNI', pg_catalog.right(v_license_plaintext, 4), v_customer.discord_id, 'pending_activation'
    );
  END IF;
  INSERT INTO public.entitlements (
    customer_id, guild_id, product_id, order_id, license_key_id, type, status, source,
    granted_role_ids, granted_channel_ids, starts_at
  ) VALUES (
    p_customer_id, p_guild_id, p_product_id, p_request_id, v_license_id, 'one_time', 'active', 'manual',
    COALESCE(v_product.granted_role_ids, '{}'::text[]), COALESCE(v_product.granted_channel_ids, '{}'::text[]),
    pg_catalog.clock_timestamp()
  ) RETURNING id INTO v_entitlement_id;
  INSERT INTO public.audit_logs (guild_id, actor_type, actor_id, action, target_type, target_id, details)
  VALUES (p_guild_id, 'customer', p_customer_id::text, 'commerce.free_claim', 'order', p_request_id::text,
    pg_catalog.jsonb_build_object('request_id', p_request_id, 'product_id', p_product_id,
      'launch_run_id', p_launch_run_id, 'verification_started_at', p_verification_started_at));
  INSERT INTO public.bot_action_queue (guild_id, action, payload, status, lane, idempotency_key)
  VALUES (p_guild_id, 'fulfill_purchase', pg_catalog.jsonb_build_object(
    'fulfillment_type', 'one_time_purchase', 'guild_id', p_guild_id, 'customer_id', p_customer_id,
    'discord_id', v_customer.discord_id, 'product_id', p_product_id, 'product_name', v_product.name,
    'order_id', p_request_id, 'order_number', v_order.order_number, 'amount_cents', 0, 'currency', v_product.currency,
    'granted_role_ids', COALESCE(v_product.granted_role_ids, '{}'::text[]),
    'granted_channel_ids', COALESCE(v_product.granted_channel_ids, '{}'::text[]),
    'temporary_role_grants', '[]'::jsonb, 'entitlement_type', 'one_time', 'free_claim', true,
    'license_key_id', v_license_id, 'license_key_plaintext', v_license_plaintext
  ), 'pending', 'commerce', 'free-claim:' || p_request_id::text);
  RETURN QUERY SELECT p_request_id, p_request_id, v_entitlement_id, 'claimed';
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_claim_free_product_for_launch(uuid,text,uuid,uuid,uuid,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_claim_free_product_for_launch(uuid,text,uuid,uuid,uuid,timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_create_and_bind_launch_paid_checkout(
  p_checkout_token uuid, p_order_number text, p_guild_id text, p_customer_id uuid, p_product_id uuid,
  p_plan_id uuid, p_provider_kind text, p_provider_id text, p_approval_url text,
  p_amount_cents integer, p_currency text, p_verification_started_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_intent public.commerce_checkout_intents%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_plan public.plans%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_temporary_grants jsonb := '[]'::jsonb;
  v_disposition text := 'created';
BEGIN
  v_intent := public.commerce_require_launch_checkout_intent(p_checkout_token, p_verification_started_at);
  IF v_intent.guild_id IS DISTINCT FROM p_guild_id OR v_intent.customer_id IS DISTINCT FROM p_customer_id
     OR v_intent.product_id IS DISTINCT FROM p_product_id
     OR (v_intent.provider_id IS NOT NULL AND v_intent.provider_id IS DISTINCT FROM p_provider_id)
     OR (v_intent.plan_id IS NOT NULL AND v_intent.plan_id IS DISTINCT FROM p_plan_id)
     OR v_intent.promotion_id IS NOT NULL OR v_intent.discount_cents IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sandbox paid checkout intent identity mismatch';
  END IF;
  IF p_order_number IS NULL OR pg_catalog.btrim(p_order_number) = '' OR p_order_number <> pg_catalog.btrim(p_order_number)
     OR p_provider_kind IS NULL OR p_provider_kind NOT IN ('capture', 'subscription')
     OR p_provider_id IS NULL OR p_provider_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR p_approval_url IS NULL OR pg_catalog.length(p_approval_url) > 2048
     OR p_approval_url <> pg_catalog.btrim(p_approval_url)
     OR p_approval_url !~ '^https://(www\.)?sandbox\.paypal\.com/'
     OR p_amount_cents IS NULL OR p_amount_cents < 0 OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$'
     OR (p_provider_kind = 'capture' AND p_plan_id IS NOT NULL)
     OR (p_provider_kind = 'subscription' AND p_plan_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox paid checkout provider contract is invalid';
  END IF;
  SELECT * INTO v_product FROM public.products WHERE id = p_product_id AND guild_id = p_guild_id;
  IF p_provider_kind = 'capture' THEN
    IF v_product.type IS DISTINCT FROM 'one_time' OR v_product.price_cents IS NULL OR v_product.price_cents < 1
       OR p_amount_cents IS DISTINCT FROM v_product.price_cents
       OR p_amount_cents IS DISTINCT FROM v_intent.final_amount_cents
       OR p_currency IS DISTINCT FROM v_product.currency THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox one-time pricing mismatch';
    END IF;
  ELSE
    PERFORM 1 FROM public.plans AS plan WHERE plan.product_id = p_product_id AND plan.guild_id = p_guild_id
     ORDER BY plan.id FOR SHARE;
    SELECT * INTO v_plan FROM public.commerce_select_sandbox_product_plan(p_guild_id, p_product_id);
    IF NOT FOUND OR v_product.type IS DISTINCT FROM 'subscription' OR p_plan_id IS DISTINCT FROM v_plan.id
       OR p_amount_cents IS DISTINCT FROM v_plan.price_cents OR p_currency IS DISTINCT FROM v_plan.currency THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox subscription pricing mismatch';
    END IF;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'commerce-paid-provider:' || p_provider_kind || ':' || p_provider_id, 0
  ));
  UPDATE public.commerce_checkout_intents SET provider_id = p_provider_id, plan_id = p_plan_id
   WHERE token = p_checkout_token;
  SELECT paid_order.* INTO v_order FROM public.orders AS paid_order
   WHERE (p_provider_kind = 'capture' AND paid_order.paypal_order_id = p_provider_id AND paid_order.paypal_subscription_id IS NULL)
      OR (p_provider_kind = 'subscription' AND paid_order.paypal_subscription_id = p_provider_id AND paid_order.paypal_order_id IS NULL)
   FOR UPDATE;
  IF FOUND THEN
    IF v_order.order_number IS DISTINCT FROM p_order_number OR v_order.guild_id IS DISTINCT FROM p_guild_id
       OR v_order.customer_id IS DISTINCT FROM p_customer_id OR v_order.product_id IS DISTINCT FROM p_product_id
       OR v_order.plan_id IS DISTINCT FROM p_plan_id OR v_order.amount_cents IS DISTINCT FROM p_amount_cents
       OR v_order.currency IS DISTINCT FROM p_currency OR v_order.checkout_approval_url IS DISTINCT FROM p_approval_url
       OR v_order.status IS DISTINCT FROM 'pending' OR v_order.checkout_active IS DISTINCT FROM true
       OR v_order.grant_snapshot_frozen_at IS NULL OR v_order.created_at < p_verification_started_at
       OR (v_intent.order_id IS NOT NULL AND v_intent.order_id IS DISTINCT FROM v_order.id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox provider replay identity mismatch';
    END IF;
    v_disposition := 'replay';
  ELSE
    IF v_intent.order_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox intent already references another order';
    END IF;
    INSERT INTO public.orders (
      order_number, customer_id, guild_id, product_id, plan_id, paypal_order_id, paypal_subscription_id,
      amount_cents, currency, status, source, checkout_active, checkout_approval_url, created_at
    ) VALUES (
      p_order_number, p_customer_id, p_guild_id, p_product_id, p_plan_id,
      CASE WHEN p_provider_kind = 'capture' THEN p_provider_id END,
      CASE WHEN p_provider_kind = 'subscription' THEN p_provider_id END,
      p_amount_cents, p_currency, 'pending', 'purchase', true, p_approval_url, pg_catalog.clock_timestamp()
    ) RETURNING * INTO v_order;
    PERFORM public.commerce_income_wall_lock_guild(p_guild_id);
    IF p_provider_kind = 'capture' THEN
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'role_id', temporary.role_id, 'duration_seconds', temporary.duration_seconds
      ) ORDER BY temporary.role_id, temporary.id), '[]'::jsonb) INTO v_temporary_grants
        FROM public.commerce_product_temp_role_config AS temporary
       WHERE temporary.guild_id = p_guild_id AND temporary.product_id = p_product_id;
    END IF;
    UPDATE public.orders
       SET granted_role_ids_snapshot = COALESCE(v_product.granted_role_ids, '{}'::text[]),
           granted_channel_ids_snapshot = COALESCE(v_product.granted_channel_ids, '{}'::text[]),
           temporary_role_grants_snapshot = v_temporary_grants,
           grant_snapshot_frozen_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_order.id RETURNING * INTO v_order;
    IF v_order.grant_snapshot_frozen_at IS NULL OR v_order.delivery_type_snapshot IS DISTINCT FROM v_product.delivery_type THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sandbox paid order contract was not frozen';
    END IF;
  END IF;
  UPDATE public.commerce_checkout_intents SET status = 'bound', order_id = v_order.id
   WHERE token = p_checkout_token;
  RETURN pg_catalog.to_jsonb(v_order) || pg_catalog.jsonb_build_object('disposition', v_disposition);
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_create_and_bind_launch_paid_checkout(uuid,text,text,uuid,uuid,uuid,text,text,text,integer,text,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_and_bind_launch_paid_checkout(uuid,text,text,uuid,uuid,uuid,text,text,text,integer,text,timestamptz)
  TO service_role;

COMMIT;
