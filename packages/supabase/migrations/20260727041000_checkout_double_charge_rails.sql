-- =============================================================================
-- Finding 10 — one active PayPal checkout per customer/product.
--
-- A checkout is still provider-payable after the local row is written. Existing
-- duplicate rows therefore MUST stay `pending`: changing their order status
-- would make an eventual PayPal capture invisible to the pending-order lookup
-- and rejected by commerce_finalize_paypal_capture after the customer paid.
--
-- `checkout_active` is a separate arbitration flag. Exactly one pending provider
-- checkout in each (customer, product) group is active and can block/create the
-- next link; older duplicates remain pending but inactive. Their already-issued
-- approval URLs keep the same deterministic capture/activation path they had
-- before this migration.
--
-- Both one-time orders and subscriptions participate. A subscription activation
-- recovery insert deliberately leaves checkout_active at its false default:
-- provider activation is already authoritative and must never be rejected by an
-- unrelated abandoned checkout. New bot-created approval links explicitly set
-- checkout_active = true and the unique index serializes concurrent inserts.
--
-- Forward-only. Idempotent.
-- =============================================================================

BEGIN;

-- Provider currency is a canonical three-letter code everywhere it crosses the
-- real-money boundary.  Earlier schema revisions left product and plan
-- currencies nullable and case-preserving, so normalize valid legacy rows
-- before installing fail-closed constraints.  Invalid legacy values abort the
-- migration with their table/id instead of being guessed or silently changed.
DO $commerce_currency_preflight$
DECLARE
  v_invalid_table TEXT;
  v_invalid_id UUID;
BEGIN
  SELECT 'products', product.id
    INTO v_invalid_table, v_invalid_id
    FROM public.products AS product
   WHERE product.currency IS NULL
      OR product.currency <> pg_catalog.btrim(product.currency)
      OR product.currency !~ '^[A-Za-z]{3}$'
   ORDER BY product.id
   LIMIT 1;

  IF v_invalid_id IS NULL THEN
    SELECT 'plans', plan.id
      INTO v_invalid_table, v_invalid_id
      FROM public.plans AS plan
     WHERE plan.currency IS NULL
        OR plan.currency <> pg_catalog.btrim(plan.currency)
        OR plan.currency !~ '^[A-Za-z]{3}$'
     ORDER BY plan.id
     LIMIT 1;
  END IF;

  IF v_invalid_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce currency backfill found a malformed legacy value',
      DETAIL = v_invalid_table || '.id=' || v_invalid_id::TEXT;
  END IF;
END;
$commerce_currency_preflight$;

UPDATE public.products AS product
   SET currency = pg_catalog.upper(product.currency)
 WHERE product.currency IS DISTINCT FROM pg_catalog.upper(product.currency);
UPDATE public.plans AS plan
   SET currency = pg_catalog.upper(plan.currency)
 WHERE plan.currency IS DISTINCT FROM pg_catalog.upper(plan.currency);

ALTER TABLE public.products
  ALTER COLUMN currency SET DEFAULT 'USD',
  ALTER COLUMN currency SET NOT NULL;
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_currency_canonical;
ALTER TABLE public.products
  ADD CONSTRAINT products_currency_canonical
  CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE public.plans
  ALTER COLUMN currency SET DEFAULT 'USD',
  ALTER COLUMN currency SET NOT NULL;
ALTER TABLE public.plans
  DROP CONSTRAINT IF EXISTS plans_currency_canonical;
ALTER TABLE public.plans
  ADD CONSTRAINT plans_currency_canonical
  CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS checkout_active BOOLEAN NOT NULL DEFAULT false;

-- An idempotent replay re-ranks historical payable rows below. Remove the
-- runtime reservation trigger first so that controlled migration repair is not
-- mistaken for a new buyer checkout; it is recreated after all private rails
-- and blocker functions are current.
DROP TRIGGER IF EXISTS commerce_orders_reservation_guard ON public.orders;

-- Keep the flag structurally honest and automatically retire it with every
-- terminal/non-pending order transition. This trigger performs no privileged
-- reads, so it remains SECURITY INVOKER.
CREATE OR REPLACE FUNCTION public.commerce_normalize_checkout_active()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_old_protected_payment BOOLEAN := false;
  v_new_protected_payment BOOLEAN := false;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_protected_payment := COALESCE((
      OLD.status IN ('pending', 'completed', 'pending_review')
      AND (OLD.source = 'purchase' OR OLD.source IS NULL)
      AND (
        OLD.paypal_order_id IS NOT NULL
        OR OLD.paypal_subscription_id IS NOT NULL
      )
    ), false);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_protected_payment := COALESCE((
      NEW.status IN ('pending', 'completed', 'pending_review')
      AND (NEW.source = 'purchase' OR NEW.source IS NULL)
      AND (
        NEW.paypal_order_id IS NOT NULL
        OR NEW.paypal_subscription_id IS NOT NULL
      )
    ), false);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_old_protected_payment
       AND CURRENT_USER IN ('anon', 'authenticated', 'service_role') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'authenticated callers cannot delete a provider-payable checkout';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT'
     AND v_new_protected_payment
     AND CURRENT_USER IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'API callers must create paid orders through a sanctioned commerce RPC';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (v_old_protected_payment OR v_new_protected_payment)
     AND CURRENT_USER IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'API callers must mutate paid orders through a sanctioned commerce RPC';
  END IF;

  IF TG_OP = 'UPDATE'
     AND v_old_protected_payment
     AND CURRENT_USER IN ('anon', 'authenticated', 'service_role') THEN
    IF OLD.checkout_active AND NOT NEW.checkout_active THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'authenticated callers cannot retire an active checkout';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
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
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.checkout_active IS DISTINCT FROM OLD.checkout_active
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.delivery_type_snapshot IS DISTINCT FROM OLD.delivery_type_snapshot
       OR NEW.granted_role_ids_snapshot IS DISTINCT FROM OLD.granted_role_ids_snapshot
       OR NEW.granted_channel_ids_snapshot IS DISTINCT FROM OLD.granted_channel_ids_snapshot
       OR NEW.temporary_role_grants_snapshot
            IS DISTINCT FROM OLD.temporary_role_grants_snapshot
       OR NEW.grant_snapshot_frozen_at IS DISTINCT FROM OLD.grant_snapshot_frozen_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'authenticated callers cannot rewrite a provider-payable checkout';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM 'pending' THEN
    NEW.checkout_active := false;
  END IF;

  IF NEW.checkout_active AND NOT (
    NEW.status = 'pending'
    AND (NEW.source = 'purchase' OR NEW.source IS NULL)
    AND NEW.guild_id IS NOT NULL
    AND NEW.customer_id IS NOT NULL
    AND NEW.product_id IS NOT NULL
    AND (
      (NEW.paypal_order_id IS NOT NULL AND NEW.paypal_subscription_id IS NULL)
      OR
      (NEW.paypal_order_id IS NULL AND NEW.paypal_subscription_id IS NOT NULL)
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'active checkout requires one pending paid provider identity';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_normalize_checkout_active()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_orders_normalize_checkout_active ON public.orders;
CREATE TRIGGER commerce_orders_normalize_checkout_active
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_normalize_checkout_active();

-- Promotions are intentionally read/delete-only until checkout owns an exact
-- discount contract.  Route-level rejection is not an authorization boundary:
-- authenticated/PostgREST callers with an owner policy could otherwise create
-- or rewrite a coupon which the money path never redeems.
CREATE OR REPLACE FUNCTION public.commerce_reject_disabled_promotion_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF CURRENT_USER IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'promotions are disabled until checkout redemption is implemented';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_reject_disabled_promotion_write()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_promotions_disabled_write
  ON public.promotions;
CREATE TRIGGER commerce_promotions_disabled_write
  BEFORE INSERT OR UPDATE
  ON public.promotions
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_reject_disabled_promotion_write();

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_checkout_active_contract_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_checkout_active_contract_check
  CHECK (
    NOT checkout_active
    OR (
      status = 'pending'
      AND (source = 'purchase' OR source IS NULL)
      AND guild_id IS NOT NULL
      AND customer_id IS NOT NULL
      AND product_id IS NOT NULL
      AND (
        (paypal_order_id IS NOT NULL AND paypal_subscription_id IS NULL)
        OR
        (paypal_order_id IS NULL AND paypal_subscription_id IS NOT NULL)
      )
    )
  );

-- Proof-backed retirement has to exist before replay repair.  Otherwise an
-- idempotent migration replay can rank a previously proved-unpayable checkout
-- back to active before the proof table is recreated later in the file.
CREATE TABLE IF NOT EXISTS public.commerce_checkout_deactivation_proofs (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL,
  customer_id UUID NOT NULL,
  product_id UUID NOT NULL,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('capture', 'subscription')),
  provider_id TEXT NOT NULL,
  proof_kind TEXT NOT NULL CHECK (
    proof_kind IN (
      'provider_cancelled',
      'provider_expired',
      'approval_link_not_exposed',
      'operator_verified_unpayable'
    )
  ),
  proof_reference TEXT NOT NULL,
  proved_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

-- Existing proof is immutable money-path evidence.  Fail closed rather than
-- silently accepting a proof whose copied identity no longer describes its
-- exact order/provider tuple.  Status is deliberately not restricted: a
-- provider may later capture a checkout which was locally proved unpayable,
-- and replay must preserve that completed parent while keeping it inactive.
DO $proof_validation$
DECLARE
  v_invalid_proof UUID;
BEGIN
  SELECT proof.id
    INTO v_invalid_proof
    FROM public.commerce_checkout_deactivation_proofs AS proof
    LEFT JOIN public.orders AS proved_order
      ON proved_order.id = proof.order_id
   WHERE proved_order.id IS NULL
      OR proved_order.guild_id IS DISTINCT FROM proof.guild_id
      OR proved_order.customer_id IS DISTINCT FROM proof.customer_id
      OR proved_order.product_id IS DISTINCT FROM proof.product_id
      OR NOT COALESCE(
        proved_order.source = 'purchase' OR proved_order.source IS NULL,
        false
      )
      OR (
        proof.provider_kind = 'capture'
        AND (
          proved_order.paypal_order_id IS DISTINCT FROM proof.provider_id
          OR proved_order.paypal_subscription_id IS NOT NULL
        )
      )
      OR (
        proof.provider_kind = 'subscription'
        AND (
          proved_order.paypal_subscription_id IS DISTINCT FROM proof.provider_id
          OR proved_order.paypal_order_id IS NOT NULL
        )
      )
   ORDER BY proof.id
   LIMIT 1;

  IF v_invalid_proof IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'checkout deactivation proof identity mismatch: ' || v_invalid_proof::TEXT;
  END IF;
END;
$proof_validation$;

UPDATE public.orders AS proved_order
   SET checkout_active = false,
       updated_at = pg_catalog.clock_timestamp()
 WHERE proved_order.checkout_active = true
   AND EXISTS (
     SELECT 1
       FROM public.commerce_checkout_deactivation_proofs AS proof
      WHERE proof.order_id = proved_order.id
        AND proof.guild_id = proved_order.guild_id
        AND proof.customer_id = proved_order.customer_id
        AND proof.product_id = proved_order.product_id
        AND (
          (
            proof.provider_kind = 'capture'
            AND proof.provider_id = proved_order.paypal_order_id
            AND proved_order.paypal_subscription_id IS NULL
          )
          OR (
            proof.provider_kind = 'subscription'
            AND proof.provider_id = proved_order.paypal_subscription_id
            AND proved_order.paypal_order_id IS NULL
          )
        )
   );

-- Remove an earlier local/dev or replayed copy before re-ranking. Keeping the
-- old unique index during an idempotent replay could reject the row that becomes
-- the new winner before PostgreSQL happens to clear the previous winner.
DROP INDEX IF EXISTS public.uniq_orders_pending_one_time_checkout;

-- Preserve every provider-payable row as pending. Only the newest row in each
-- group arbitrates future links; all older links remain payable but inactive.
WITH ranked AS (
  SELECT
    paid_order.id,
    row_number() OVER (
      PARTITION BY paid_order.customer_id, paid_order.product_id
      ORDER BY
        paid_order.checkout_active DESC,
        paid_order.created_at DESC,
        paid_order.id DESC
    ) AS rank
  FROM public.orders AS paid_order
  WHERE paid_order.status = 'pending'
    AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
    AND paid_order.guild_id IS NOT NULL
    AND paid_order.customer_id IS NOT NULL
    AND paid_order.product_id IS NOT NULL
    AND (
      (paid_order.paypal_order_id IS NOT NULL AND paid_order.paypal_subscription_id IS NULL)
      OR
      (paid_order.paypal_order_id IS NULL AND paid_order.paypal_subscription_id IS NOT NULL)
    )
    AND NOT EXISTS (
      SELECT 1
        FROM public.commerce_checkout_deactivation_proofs AS proof
       WHERE proof.order_id = paid_order.id
         AND proof.guild_id = paid_order.guild_id
         AND proof.customer_id = paid_order.customer_id
         AND proof.product_id = paid_order.product_id
         AND (
           (
             proof.provider_kind = 'capture'
             AND proof.provider_id = paid_order.paypal_order_id
             AND paid_order.paypal_subscription_id IS NULL
           )
           OR (
             proof.provider_kind = 'subscription'
             AND proof.provider_id = paid_order.paypal_subscription_id
             AND paid_order.paypal_order_id IS NULL
           )
         )
    )
)
UPDATE public.orders AS paid_order
SET checkout_active = (ranked.rank = 1)
FROM ranked
WHERE paid_order.id = ranked.id
  AND paid_order.checkout_active IS DISTINCT FROM (ranked.rank = 1);

-- The committed definition covers both PayPal order and subscription checkouts.
CREATE UNIQUE INDEX uniq_orders_pending_one_time_checkout
  ON public.orders (customer_id, product_id)
  WHERE checkout_active = true;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_duplicate_subscription
  ON public.alerts (guild_id, ((metadata ->> 'order_id')))
  WHERE alert_type = 'commerce_duplicate_subscription_activation'
    AND resolved = false;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_duplicate_purchase
  ON public.alerts (guild_id, ((metadata ->> 'order_id')))
  WHERE alert_type = 'commerce_duplicate_purchase_capture'
    AND resolved = false;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_unknown_delivery
  ON public.alerts (guild_id, ((metadata ->> 'order_id')))
  WHERE alert_type = 'commerce_unknown_delivery_contract'
    AND resolved = false;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_subscription_financial_mismatch
  ON public.alerts (guild_id, ((metadata ->> 'order_id')))
  WHERE alert_type = 'commerce_subscription_financial_mismatch'
    AND resolved = false;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_outward_action_held
  ON public.alerts (guild_id, ((metadata ->> 'action_id')))
  WHERE alert_type = 'commerce_fulfillment_outward_action_held'
    AND resolved = false;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_license_rotation_delivery
  ON public.alerts (guild_id, ((metadata ->> 'old_key_id')))
  WHERE alert_type = 'commerce_license_rotation_delivery_held'
    AND resolved = false;

DROP INDEX IF EXISTS public.uniq_alerts_unresolved_outward_uncertain;
CREATE UNIQUE INDEX uniq_alerts_unresolved_outward_uncertain
  ON public.alerts (
    guild_id,
    ((metadata ->> 'order_id')),
    ((metadata ->> 'intent_kind')),
    (COALESCE(metadata ->> 'outward_generation_id', '<legacy>'))
  )
  WHERE alert_type = 'commerce_fulfillment_outward_uncertain'
    AND resolved = false;

-- Checkout insertion prevents new duplicate approval links, but historical links
-- can still be paid concurrently. A read-before-write entitlement check cannot
-- serialize those webhooks: both can observe "no entitlement" before either
-- stages delivery. These two owner-only tables are the durable arbitration rail.
--
-- A claim names the one order allowed to stage/release fulfillment for an exact
-- guild/customer/product generation. A hold makes a losing paid order
-- permanently non-fulfillable on replay, independent of whether its operator
-- alert is later resolved.
CREATE TABLE IF NOT EXISTS public.commerce_fulfillment_claims (
  guild_id TEXT NOT NULL,
  customer_id UUID NOT NULL,
  product_id UUID NOT NULL,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (guild_id, customer_id, product_id),
  UNIQUE (order_id)
);

CREATE TABLE IF NOT EXISTS public.commerce_fulfillment_holds (
  order_id UUID PRIMARY KEY REFERENCES public.orders(id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL,
  customer_id UUID NOT NULL,
  product_id UUID NOT NULL,
  winning_order_id UUID REFERENCES public.orders(id) ON DELETE RESTRICT,
  conflicting_entitlement_id UUID REFERENCES public.entitlements(id) ON DELETE RESTRICT,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('capture', 'subscription')),
  provider_id TEXT NOT NULL,
  hold_reason TEXT NOT NULL DEFAULT 'duplicate_paid_fulfillment'
    CHECK (hold_reason IN ('duplicate_paid_fulfillment', 'unknown_delivery_contract')),
  held_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.commerce_fulfillment_holds
  ADD COLUMN IF NOT EXISTS hold_reason TEXT NOT NULL
  DEFAULT 'duplicate_paid_fulfillment';
ALTER TABLE public.commerce_fulfillment_holds
  DROP CONSTRAINT IF EXISTS commerce_fulfillment_holds_hold_reason_check;
ALTER TABLE public.commerce_fulfillment_holds
  ADD CONSTRAINT commerce_fulfillment_holds_hold_reason_check
  CHECK (hold_reason IN ('duplicate_paid_fulfillment', 'unknown_delivery_contract'));

CREATE TABLE IF NOT EXISTS public.commerce_checkout_deactivation_proofs (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL,
  customer_id UUID NOT NULL,
  product_id UUID NOT NULL,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('capture', 'subscription')),
  provider_id TEXT NOT NULL,
  proof_kind TEXT NOT NULL CHECK (
    proof_kind IN (
      'provider_cancelled',
      'provider_expired',
      'approval_link_not_exposed',
      'operator_verified_unpayable'
    )
  ),
  proof_reference TEXT NOT NULL,
  proved_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.commerce_fulfillment_outward_intents (
  id UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL,
  outward_generation_id UUID,
  intent_kind TEXT NOT NULL CHECK (
    intent_kind IN (
      'purchase_completed_event',
      'subscription_activated_event',
      'receipt_dm',
      'subscription_renewed_event',
      'subscription_cancelled_event',
      'subscription_cancelled_dm',
      'subscription_payment_failed_lapsed_event',
      'subscription_payment_failed_event',
      'subscription_payment_failed_dm',
      'subscription_suspended_event',
      'subscription_suspended_dm'
    )
  ),
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'uncertain')),
  attempt_token UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  sent_at TIMESTAMPTZ,
  uncertain_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (id),
  CHECK (
    (state = 'sending' AND attempt_token IS NOT NULL AND sent_at IS NULL AND uncertain_at IS NULL)
    OR (state = 'sent' AND attempt_token IS NULL AND sent_at IS NOT NULL AND uncertain_at IS NULL)
    OR (state = 'uncertain' AND attempt_token IS NULL AND sent_at IS NULL AND uncertain_at IS NOT NULL)
  )
);

-- Replay-upgrade the earlier per-order schema.  A generation is a durable
-- lifecycle episode, so the same order/kind may legitimately recur under a
-- different generation while one legacy NULL identity remains unique.
ALTER TABLE public.commerce_fulfillment_outward_intents
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT pg_catalog.gen_random_uuid();
UPDATE public.commerce_fulfillment_outward_intents
   SET id = pg_catalog.gen_random_uuid()
 WHERE id IS NULL;
ALTER TABLE public.commerce_fulfillment_outward_intents
  ALTER COLUMN id SET NOT NULL;
ALTER TABLE public.commerce_fulfillment_outward_intents
  ADD COLUMN IF NOT EXISTS outward_generation_id UUID;
ALTER TABLE public.commerce_fulfillment_outward_intents
  DROP CONSTRAINT IF EXISTS commerce_fulfillment_outward_intents_pkey;
ALTER TABLE public.commerce_fulfillment_outward_intents
  ADD CONSTRAINT commerce_fulfillment_outward_intents_pkey PRIMARY KEY (id);
ALTER TABLE public.commerce_fulfillment_outward_intents
  DROP CONSTRAINT IF EXISTS commerce_fulfillment_outward_intents_intent_kind_check;
ALTER TABLE public.commerce_fulfillment_outward_intents
  ADD CONSTRAINT commerce_fulfillment_outward_intents_intent_kind_check
  CHECK (
    intent_kind IN (
      'purchase_completed_event',
      'subscription_activated_event',
      'receipt_dm',
      'subscription_renewed_event',
      'subscription_cancelled_event',
      'subscription_cancelled_dm',
      'subscription_payment_failed_lapsed_event',
      'subscription_payment_failed_event',
      'subscription_payment_failed_dm',
      'subscription_suspended_event',
      'subscription_suspended_dm'
    )
  );
ALTER TABLE public.commerce_fulfillment_outward_intents
  DROP CONSTRAINT IF EXISTS commerce_fulfillment_outward_intents_state_check;
ALTER TABLE public.commerce_fulfillment_outward_intents
  ADD CONSTRAINT commerce_fulfillment_outward_intents_state_check
  CHECK (state IN ('sending', 'sent', 'uncertain', 'superseded'));
ALTER TABLE public.commerce_fulfillment_outward_intents
  DROP CONSTRAINT IF EXISTS commerce_fulfillment_outward_intents_check;
ALTER TABLE public.commerce_fulfillment_outward_intents
  ADD CONSTRAINT commerce_fulfillment_outward_intents_check
  CHECK (
    (
      state = 'sending'
      AND attempt_token IS NOT NULL
      AND sent_at IS NULL
      AND uncertain_at IS NULL
    )
    OR (
      state = 'sent'
      AND attempt_token IS NULL
      AND sent_at IS NOT NULL
      AND uncertain_at IS NULL
    )
    OR (
      state = 'uncertain'
      AND attempt_token IS NULL
      AND sent_at IS NULL
      AND uncertain_at IS NOT NULL
    )
    OR (
      state = 'superseded'
      AND attempt_token IS NULL
      AND sent_at IS NULL
      AND uncertain_at IS NULL
    )
  );
DROP INDEX IF EXISTS public.uniq_commerce_outward_intent_legacy;
DROP INDEX IF EXISTS public.uniq_commerce_outward_intent_generation;
CREATE UNIQUE INDEX uniq_commerce_outward_intent_legacy
  ON public.commerce_fulfillment_outward_intents (order_id, intent_kind)
  WHERE outward_generation_id IS NULL;
CREATE UNIQUE INDEX uniq_commerce_outward_intent_generation
  ON public.commerce_fulfillment_outward_intents (
    order_id, intent_kind, outward_generation_id
  )
  WHERE outward_generation_id IS NOT NULL;

ALTER TABLE public.commerce_role_delivery_intents
  ADD COLUMN IF NOT EXISTS outward_generation_id UUID;
ALTER TABLE public.bot_action_queue
  ADD COLUMN IF NOT EXISTS outward_generation_id UUID;

-- A provider checkout is unusable if the only approval URL was lost with the
-- Discord response. Keep the exact private URL on the RLS-protected order so a
-- same-customer retry can recover it without creating a second payable object.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS checkout_approval_url TEXT;
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_checkout_approval_url_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_checkout_approval_url_check CHECK (
    checkout_approval_url IS NULL
    OR (
      checkout_approval_url = pg_catalog.btrim(checkout_approval_url)
      AND pg_catalog.length(checkout_approval_url) BETWEEN 1 AND 2048
      AND checkout_approval_url ~ '^https://'
    )
  );

ALTER TABLE public.commerce_fulfillment_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_fulfillment_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_checkout_deactivation_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_fulfillment_outward_intents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.commerce_fulfillment_claims
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.commerce_fulfillment_holds
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.commerce_checkout_deactivation_proofs
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.commerce_fulfillment_outward_intents
  FROM PUBLIC, anon, authenticated, service_role;

-- Resolve every durable reason that makes another approval link unsafe. The
-- same identity advisory lock is used by paid-fulfillment claim/hold
-- arbitration, so a checkout reservation and a capture decision cannot both
-- inspect a stale pre-arbitration snapshot.
CREATE OR REPLACE FUNCTION public.commerce_find_checkout_blocker(
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_exclude_order_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_claim public.commerce_fulfillment_claims%ROWTYPE;
  v_prior_order public.orders%ROWTYPE;
  v_inflight_fulfillment BOOLEAN := false;
  v_claim_releasable BOOLEAN := false;
BEGIN
  IF p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_find_checkout_blocker: exact checkout identity is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_guild_id || E'\x1f'
        || p_customer_id::TEXT || E'\x1f'
        || p_product_id::TEXT,
      0
    )
  );

  PERFORM customer.id
    FROM public.customers AS customer
   WHERE customer.id = p_customer_id
     AND customer.guild_id = p_guild_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_find_checkout_blocker: customer identity mismatch';
  END IF;

  PERFORM product.id
    FROM public.products AS product
   WHERE product.id = p_product_id
     AND product.guild_id = p_guild_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_find_checkout_blocker: product identity mismatch';
  END IF;

  -- A hold is permanent until explicit operator repair removes it. Resolving
  -- its alert alone is not proof that the charge was refunded or delivered.
  SELECT paid_order.*
    INTO v_order
    FROM public.commerce_fulfillment_holds AS held
    JOIN public.orders AS paid_order
      ON paid_order.id = held.order_id
   WHERE held.guild_id = p_guild_id
     AND held.customer_id = p_customer_id
     AND held.product_id = p_product_id
   ORDER BY held.held_at, held.order_id
   LIMIT 1;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'disposition', 'blocked',
      'reason', 'paid_hold',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'approval_url', NULL
    );
  END IF;

  -- Every pending provider identity remains payable until provider proof says
  -- otherwise. Historical inactive duplicates are therefore blockers too;
  -- checkout_active only chooses the current local arbitration row.
  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
     AND paid_order.product_id = p_product_id
     AND paid_order.id IS DISTINCT FROM p_exclude_order_id
     AND paid_order.status = 'pending'
     AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
     AND (
       paid_order.paypal_order_id IS NOT NULL
       OR paid_order.paypal_subscription_id IS NOT NULL
     )
      AND NOT EXISTS (
        SELECT 1
          FROM public.commerce_checkout_deactivation_proofs AS proof
         WHERE proof.order_id = paid_order.id
           AND proof.guild_id = paid_order.guild_id
           AND proof.customer_id = paid_order.customer_id
           AND proof.product_id = paid_order.product_id
           AND (
             (
               proof.provider_kind = 'capture'
               AND proof.provider_id = paid_order.paypal_order_id
               AND paid_order.paypal_subscription_id IS NULL
             )
             OR (
               proof.provider_kind = 'subscription'
               AND proof.provider_id = paid_order.paypal_subscription_id
               AND paid_order.paypal_order_id IS NULL
             )
           )
      )
   ORDER BY
     paid_order.checkout_active DESC,
     paid_order.created_at,
     paid_order.id
   LIMIT 1;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'disposition', 'blocked',
      'reason', 'provider_checkout',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'approval_url', v_order.checkout_approval_url
    );
  END IF;

  -- Repeat the active-entitlement guard under the identity lock so a grant
  -- racing the bot's earlier UX check cannot expose another payment link.
  SELECT paid_order.*
    INTO v_order
    FROM public.entitlements AS entitlement
    LEFT JOIN public.orders AS paid_order
      ON paid_order.id = entitlement.order_id
   WHERE entitlement.guild_id = p_guild_id
     AND entitlement.customer_id = p_customer_id
     AND entitlement.product_id = p_product_id
     AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
   ORDER BY entitlement.created_at, entitlement.id
   LIMIT 1;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'disposition', 'blocked',
      'reason', 'active_entitlement',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'approval_url', NULL
    );
  END IF;

  -- Cover capture/activation -> queue/claim gaps. A completed or review-held
  -- provider order with no entitlement row has not reached a releasable
  -- outcome, even if its checkout_active flag was normalized to false.
  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
     WHERE paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
     AND paid_order.product_id = p_product_id
     AND paid_order.status IN ('completed', 'pending_review')
     AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
     AND (
       paid_order.paypal_order_id IS NOT NULL
       OR paid_order.paypal_subscription_id IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.entitlements AS entitlement
        WHERE entitlement.order_id = paid_order.id
     )
   ORDER BY paid_order.created_at, paid_order.id
   LIMIT 1;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'disposition', 'blocked',
      'reason', 'paid_fulfillment',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'approval_url', NULL
    );
  END IF;

  SELECT claim.*
    INTO v_claim
    FROM public.commerce_fulfillment_claims AS claim
   WHERE claim.guild_id = p_guild_id
     AND claim.customer_id = p_customer_id
     AND claim.product_id = p_product_id;

  IF FOUND THEN
    SELECT paid_order.*
      INTO v_prior_order
      FROM public.orders AS paid_order
     WHERE paid_order.id = v_claim.order_id;

    SELECT EXISTS (
      SELECT 1
        FROM public.bot_action_queue AS queue
       WHERE queue.payload ->> 'order_id' = v_claim.order_id::TEXT
         AND queue.action IN ('fulfill_purchase', 'fulfill_subscription')
         AND queue.status IN ('staged', 'pending', 'processing')
    ) INTO v_inflight_fulfillment;

    v_claim_releasable := NOT v_inflight_fulfillment
      AND NOT EXISTS (
        SELECT 1
          FROM public.entitlements AS entitlement
         WHERE entitlement.guild_id = p_guild_id
           AND entitlement.customer_id = p_customer_id
           AND entitlement.product_id = p_product_id
           AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
      )
      AND (
        v_prior_order.status IN ('refunded', 'disputed', 'cancelled')
        OR (
          v_prior_order.status = 'completed'
          AND EXISTS (
            SELECT 1
              FROM public.entitlements AS entitlement
             WHERE entitlement.order_id = v_claim.order_id
          )
        )
      );

    IF NOT v_claim_releasable THEN
      RETURN pg_catalog.jsonb_build_object(
        'disposition', 'blocked',
        'reason', 'paid_fulfillment',
        'order_id', v_prior_order.id,
        'order_number', v_prior_order.order_number,
        'approval_url', NULL
      );
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'disposition', 'clear',
    'reason', NULL,
    'order_id', NULL,
    'order_number', NULL,
    'approval_url', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_find_checkout_blocker(
  TEXT, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

-- Service-only early inspection keeps known blockers away from PayPal
-- entirely. The trigger below calls the same owner-only resolver again at the
-- active-order write boundary, which is the authoritative race fence.
CREATE OR REPLACE FUNCTION public.commerce_inspect_checkout_blocker(
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.commerce_find_checkout_blocker(
    p_guild_id,
    p_customer_id,
    p_product_id,
    NULL
  );
$$;

REVOKE ALL ON FUNCTION public.commerce_inspect_checkout_blocker(
  TEXT, UUID, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_inspect_checkout_blocker(
  TEXT, UUID, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_guard_checkout_reservation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_blocker JSONB;
BEGIN
  IF NOT NEW.checkout_active THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.checkout_active
     AND NEW.guild_id IS NOT DISTINCT FROM OLD.guild_id
     AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id THEN
    RETURN NEW;
  END IF;

  v_blocker := public.commerce_find_checkout_blocker(
    NEW.guild_id,
    NEW.customer_id,
    NEW.product_id,
    CASE WHEN TG_OP = 'UPDATE' THEN NEW.id ELSE NULL END
  );

  IF v_blocker ->> 'disposition' = 'blocked' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'commerce_checkout_blocked: '
        || COALESCE(v_blocker ->> 'reason', 'unknown')
        || ' order '
        || COALESCE(v_blocker ->> 'order_number', 'unknown');
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_guard_checkout_reservation()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_orders_reservation_guard ON public.orders;
CREATE TRIGGER commerce_orders_reservation_guard
  BEFORE INSERT OR UPDATE OF checkout_active
  ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_checkout_reservation();

-- The inverse race fence: a manual/giveaway/automation access grant must take
-- the same exact checkout identity lock before its entitlement becomes
-- authoritative.  This closes checkout-first and grant-first interleavings.
CREATE OR REPLACE FUNCTION public.commerce_guard_noncommerce_entitlement_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payable_order public.orders%ROWTYPE;
BEGIN
  IF NOT COALESCE(
       NEW.source IN ('manual', 'giveaway', 'automation'),
       false
     )
     OR NOT COALESCE(
       NEW.status IN ('active', 'pending', 'grace_period', 'suspended'),
       false
     ) THEN
    RETURN NEW;
  END IF;

  -- An already-access-bearing row owns the identity before this UPDATE began.
  -- Rechecking the same carrier would invert the established entitlement-row
  -- lock ordering without adding any checkout authority.
  IF TG_OP = 'UPDATE'
     AND OLD.source IS NOT DISTINCT FROM NEW.source
     AND OLD.guild_id IS NOT DISTINCT FROM NEW.guild_id
     AND OLD.customer_id IS NOT DISTINCT FROM NEW.customer_id
     AND OLD.product_id IS NOT DISTINCT FROM NEW.product_id
     AND OLD.status IN ('active', 'pending', 'grace_period', 'suspended') THEN
    RETURN NEW;
  END IF;

  IF NEW.guild_id IS NULL
     OR NEW.guild_id = ''
     OR NEW.guild_id <> pg_catalog.btrim(NEW.guild_id)
     OR NEW.customer_id IS NULL
     OR NEW.product_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_guard_noncommerce_entitlement_activation: exact identity is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      NEW.guild_id || E'\x1f'
        || NEW.customer_id::TEXT || E'\x1f'
        || NEW.product_id::TEXT,
      0
    )
  );

  PERFORM customer.id
    FROM public.customers AS customer
   WHERE customer.id = NEW.customer_id
     AND customer.guild_id = NEW.guild_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_guard_noncommerce_entitlement_activation: customer identity mismatch';
  END IF;

  PERFORM product.id
    FROM public.products AS product
   WHERE product.id = NEW.product_id
     AND product.guild_id = NEW.guild_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_guard_noncommerce_entitlement_activation: product identity mismatch';
  END IF;

  SELECT paid_order.*
    INTO v_payable_order
    FROM public.orders AS paid_order
   WHERE paid_order.guild_id = NEW.guild_id
     AND paid_order.customer_id = NEW.customer_id
     AND paid_order.product_id = NEW.product_id
     AND paid_order.status = 'pending'
     AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
     AND (
       paid_order.paypal_order_id IS NOT NULL
       OR paid_order.paypal_subscription_id IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.commerce_checkout_deactivation_proofs AS proof
        WHERE proof.order_id = paid_order.id
          AND proof.guild_id = paid_order.guild_id
          AND proof.customer_id = paid_order.customer_id
          AND proof.product_id = paid_order.product_id
          AND (
            (
              proof.provider_kind = 'capture'
              AND proof.provider_id = paid_order.paypal_order_id
              AND paid_order.paypal_subscription_id IS NULL
            )
            OR (
              proof.provider_kind = 'subscription'
              AND proof.provider_id = paid_order.paypal_subscription_id
              AND paid_order.paypal_order_id IS NULL
            )
          )
     )
   ORDER BY paid_order.checkout_active DESC, paid_order.created_at, paid_order.id
   LIMIT 1
   FOR KEY SHARE;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'commerce_noncommerce_grant_blocked: provider_checkout order '
        || COALESCE(v_payable_order.order_number, v_payable_order.id::TEXT);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_guard_noncommerce_entitlement_activation()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_entitlements_checkout_guard
  ON public.entitlements;
CREATE TRIGGER commerce_entitlements_checkout_guard
  BEFORE INSERT OR UPDATE
  ON public.entitlements
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_noncommerce_entitlement_activation();

-- Put the service-only creation RPC on the same checkout identity lock before
-- its existing implementation takes any customer/product parent lock.  This
-- preserves all mature replay/snapshot validation while closing the RPC-side
-- checkout/grant race; the entitlement trigger above remains the direct-DML
-- backstop and re-enters the same transaction advisory lock.
DO $rename_noncommerce_create$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.commerce_create_noncommerce_entitlement_without_checkout_guard(uuid,text,uuid,uuid,text,text,uuid,timestamptz,text[],text[])'
     ) IS NULL THEN
    ALTER FUNCTION public.commerce_create_noncommerce_entitlement(
      UUID, TEXT, UUID, UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, TEXT[], TEXT[]
    ) RENAME TO commerce_create_noncommerce_entitlement_without_checkout_guard;
  END IF;
END;
$rename_noncommerce_create$;

REVOKE ALL ON FUNCTION public.commerce_create_noncommerce_entitlement_without_checkout_guard(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, TEXT[], TEXT[]
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_create_noncommerce_entitlement(
  p_request_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_source TEXT,
  p_type TEXT,
  p_plan_id UUID,
  p_expires_at TIMESTAMPTZ,
  p_granted_role_ids TEXT[],
  p_granted_channel_ids TEXT[]
)
RETURNS TABLE (entitlement_id UUID, order_id UUID, request_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_request_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = ''
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR NOT COALESCE(
       p_source IN ('manual', 'giveaway', 'automation'),
       false
     )
     OR NOT COALESCE(p_type IN ('one_time', 'subscription'), false)
     OR NOT public.commerce_valid_snowflake_snapshot(p_granted_role_ids)
     OR NOT public.commerce_valid_snowflake_snapshot(p_granted_channel_ids)
     OR (
       p_expires_at IS NOT NULL
       AND NOT pg_catalog.isfinite(p_expires_at)
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_create_noncommerce_entitlement: request contract is invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_guild_id || E'\x1f'
        || p_customer_id::TEXT || E'\x1f'
        || p_product_id::TEXT,
      0
    )
  );

  RETURN QUERY
  SELECT created.entitlement_id, created.order_id, created.request_id
    FROM public.commerce_create_noncommerce_entitlement_without_checkout_guard(
      p_request_id,
      p_guild_id,
      p_customer_id,
      p_product_id,
      p_source,
      p_type,
      p_plan_id,
      p_expires_at,
      p_granted_role_ids,
      p_granted_channel_ids
    ) AS created;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_create_noncommerce_entitlement(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, TEXT[], TEXT[]
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_noncommerce_entitlement(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, TEXT[], TEXT[]
) TO service_role;

-- Adopt every currently live paid entitlement and every fulfillment row that a
-- worker can still apply. DISTINCT ON chooses one deterministic historical
-- winner if the old database already contains duplicates; no order or provider
-- identity is rewritten.
WITH candidate AS (
  SELECT
    paid_order.guild_id,
    paid_order.customer_id,
    paid_order.product_id,
    paid_order.id AS order_id,
    1 AS priority,
    entitlement.created_at AS candidate_at
  FROM public.entitlements AS entitlement
  JOIN public.orders AS paid_order
    ON paid_order.id = entitlement.order_id
   AND paid_order.guild_id = entitlement.guild_id
   AND paid_order.customer_id = entitlement.customer_id
   AND paid_order.product_id = entitlement.product_id
  WHERE entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
    AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
    AND paid_order.guild_id IS NOT NULL
    AND paid_order.customer_id IS NOT NULL
    AND paid_order.product_id IS NOT NULL

  UNION ALL

  SELECT
    paid_order.guild_id,
    paid_order.customer_id,
    paid_order.product_id,
    paid_order.id AS order_id,
    2 AS priority,
    queue.created_at AS candidate_at
  FROM public.bot_action_queue AS queue
  JOIN public.orders AS paid_order
    ON queue.payload ->> 'order_id' = paid_order.id::TEXT
   AND queue.guild_id = paid_order.guild_id
   AND queue.payload ->> 'guild_id' = paid_order.guild_id
   AND queue.payload ->> 'customer_id' = paid_order.customer_id::TEXT
   AND queue.payload ->> 'product_id' = paid_order.product_id::TEXT
   AND queue.payload ->> 'order_number' = paid_order.order_number
  JOIN public.customers AS customer
    ON customer.id = paid_order.customer_id
   AND customer.guild_id = paid_order.guild_id
   AND customer.discord_id = queue.payload ->> 'discord_id'
  WHERE queue.action IN ('fulfill_purchase', 'fulfill_subscription')
    AND queue.status IN ('staged', 'pending', 'processing')
    AND pg_catalog.jsonb_typeof(queue.payload) = 'object'
    AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
    AND paid_order.guild_id IS NOT NULL
    AND paid_order.customer_id IS NOT NULL
    AND paid_order.product_id IS NOT NULL
    AND paid_order.status IN ('pending', 'completed', 'pending_review')
    AND paid_order.amount_cents >= 0
    AND pg_catalog.upper(paid_order.currency) ~ '^[A-Z]{3}$'
    AND pg_catalog.jsonb_typeof(queue.payload -> 'amount_cents') = 'number'
    AND (queue.payload ->> 'amount_cents')::NUMERIC = paid_order.amount_cents
    AND queue.payload ->> 'currency' = pg_catalog.upper(paid_order.currency)
    AND (
      (
        queue.action = 'fulfill_purchase'
        AND queue.payload ->> 'fulfillment_type' = 'one_time_purchase'
        AND queue.payload ->> 'entitlement_type' = 'one_time'
        AND queue.payload ->> 'paypal_capture_id'
          ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
        AND paid_order.status = 'completed'
        AND paid_order.paypal_order_id IS NOT NULL
        AND paid_order.paypal_subscription_id IS NULL
        AND paid_order.plan_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.payments AS payment
          WHERE payment.order_id = paid_order.id
            AND payment.customer_id = paid_order.customer_id
            AND payment.guild_id = paid_order.guild_id
            AND payment.provider = 'paypal'
            AND payment.paypal_resource_type = 'capture'
            AND payment.status = 'completed'
            AND payment.paypal_payment_id
              = queue.payload ->> 'paypal_capture_id'
            AND payment.amount_cents = paid_order.amount_cents
            AND payment.currency = pg_catalog.upper(paid_order.currency)
        )
      )
      OR
      (
        queue.action = 'fulfill_subscription'
        AND queue.payload ->> 'fulfillment_type' = 'subscription_activated'
        AND queue.payload ->> 'entitlement_type' = 'subscription'
        AND queue.payload ->> 'paypal_subscription_id'
          ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
        AND queue.payload ->> 'paypal_subscription_id'
          = paid_order.paypal_subscription_id
        AND queue.payload ->> 'plan_id' = paid_order.plan_id::TEXT
        AND paid_order.paypal_order_id IS NULL
        AND paid_order.paypal_subscription_id IS NOT NULL
        AND paid_order.plan_id IS NOT NULL
      )
    )
), winner AS (
  SELECT DISTINCT ON (guild_id, customer_id, product_id)
    guild_id,
    customer_id,
    product_id,
    order_id,
    candidate_at
  FROM candidate
  ORDER BY
    guild_id,
    customer_id,
    product_id,
    priority,
    candidate_at,
    order_id
)
INSERT INTO public.commerce_fulfillment_claims (
  guild_id,
  customer_id,
  product_id,
  order_id,
  claimed_at
)
SELECT
  winner.guild_id,
  winner.customer_id,
  winner.product_id,
  winner.order_id,
  COALESCE(winner.candidate_at, pg_catalog.clock_timestamp())
FROM winner
ON CONFLICT DO NOTHING;

-- The claim backfill is not sufficient by itself: an older staged/pending
-- queue row is still executable by the bot. Materialize every well-formed
-- losing paid queue row, persist its permanent hold and critical alert now,
-- and revoke any not-yet-entitled staged key. The worker independently calls
-- the same claim RPC before entitlement/Discord mutation, so processing rows
-- and later manual retries remain fail-closed.
DROP TABLE IF EXISTS pg_temp.commerce_fulfillment_backfill_losers;
CREATE TEMP TABLE commerce_fulfillment_backfill_losers
ON COMMIT DROP
AS
SELECT DISTINCT ON (paid_order.id)
  queue.id AS queue_id,
  paid_order.id AS order_id,
  paid_order.order_number,
  paid_order.guild_id,
  paid_order.customer_id,
  paid_order.product_id,
  claim.order_id AS winning_order_id,
  existing_entitlement.id AS conflicting_entitlement_id,
  CASE queue.action
    WHEN 'fulfill_purchase' THEN 'capture'
    ELSE 'subscription'
  END AS provider_kind,
  CASE queue.action
    WHEN 'fulfill_purchase' THEN queue.payload ->> 'paypal_capture_id'
    ELSE queue.payload ->> 'paypal_subscription_id'
  END AS provider_id,
  paid_order.amount_cents,
  pg_catalog.upper(paid_order.currency) AS currency
FROM public.bot_action_queue AS queue
JOIN public.orders AS paid_order
  ON queue.guild_id = paid_order.guild_id
 AND queue.payload ->> 'order_id' = paid_order.id::TEXT
 AND queue.payload ->> 'guild_id' = paid_order.guild_id
 AND queue.payload ->> 'customer_id' = paid_order.customer_id::TEXT
 AND queue.payload ->> 'product_id' = paid_order.product_id::TEXT
 AND queue.payload ->> 'order_number' = paid_order.order_number
JOIN public.customers AS customer
  ON customer.id = paid_order.customer_id
 AND customer.guild_id = paid_order.guild_id
 AND customer.discord_id = queue.payload ->> 'discord_id'
JOIN public.commerce_fulfillment_claims AS claim
  ON claim.guild_id = paid_order.guild_id
 AND claim.customer_id = paid_order.customer_id
 AND claim.product_id = paid_order.product_id
 AND claim.order_id <> paid_order.id
LEFT JOIN LATERAL (
  SELECT entitlement.id
  FROM public.entitlements AS entitlement
  WHERE entitlement.guild_id = paid_order.guild_id
    AND entitlement.customer_id = paid_order.customer_id
    AND entitlement.product_id = paid_order.product_id
    AND entitlement.order_id = paid_order.id
    AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
  ORDER BY entitlement.created_at, entitlement.id
  LIMIT 1
) AS existing_entitlement ON true
WHERE queue.action IN ('fulfill_purchase', 'fulfill_subscription')
  AND queue.status IN ('staged', 'pending', 'processing')
  AND pg_catalog.jsonb_typeof(queue.payload) = 'object'
  AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
  AND paid_order.status IN ('pending', 'completed', 'pending_review')
  AND paid_order.amount_cents >= 0
  AND pg_catalog.upper(paid_order.currency) ~ '^[A-Z]{3}$'
  AND pg_catalog.jsonb_typeof(queue.payload -> 'amount_cents') = 'number'
  AND (queue.payload ->> 'amount_cents')::NUMERIC = paid_order.amount_cents
  AND queue.payload ->> 'currency' = pg_catalog.upper(paid_order.currency)
  AND (
    (
      queue.action = 'fulfill_purchase'
      AND queue.payload ->> 'fulfillment_type' = 'one_time_purchase'
      AND queue.payload ->> 'entitlement_type' = 'one_time'
      AND queue.payload ->> 'paypal_capture_id'
        ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
      AND paid_order.paypal_order_id IS NOT NULL
      AND paid_order.paypal_subscription_id IS NULL
      AND paid_order.plan_id IS NULL
      AND paid_order.status = 'completed'
      AND EXISTS (
        SELECT 1
        FROM public.payments AS payment
        WHERE payment.order_id = paid_order.id
          AND payment.customer_id = paid_order.customer_id
          AND payment.guild_id = paid_order.guild_id
          AND payment.provider = 'paypal'
          AND payment.paypal_resource_type = 'capture'
          AND payment.status = 'completed'
          AND payment.paypal_payment_id
            = queue.payload ->> 'paypal_capture_id'
          AND payment.amount_cents = paid_order.amount_cents
          AND payment.currency = pg_catalog.upper(paid_order.currency)
      )
    )
    OR
    (
      queue.action = 'fulfill_subscription'
      AND queue.payload ->> 'fulfillment_type' = 'subscription_activated'
      AND queue.payload ->> 'entitlement_type' = 'subscription'
      AND queue.payload ->> 'paypal_subscription_id'
        ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
      AND queue.payload ->> 'paypal_subscription_id'
        = paid_order.paypal_subscription_id
      AND queue.payload ->> 'plan_id' = paid_order.plan_id::TEXT
      AND paid_order.paypal_order_id IS NULL
      AND paid_order.paypal_subscription_id IS NOT NULL
      AND paid_order.plan_id IS NOT NULL
    )
  )
ORDER BY paid_order.id, queue.created_at, queue.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_temp.commerce_fulfillment_backfill_losers AS loser
    JOIN public.commerce_fulfillment_holds AS held
      ON held.order_id = loser.order_id
    WHERE held.guild_id IS DISTINCT FROM loser.guild_id
       OR held.customer_id IS DISTINCT FROM loser.customer_id
       OR held.product_id IS DISTINCT FROM loser.product_id
       OR held.winning_order_id IS DISTINCT FROM loser.winning_order_id
       OR held.provider_kind IS DISTINCT FROM loser.provider_kind
       OR held.provider_id IS DISTINCT FROM loser.provider_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'historical paid fulfillment hold identity mismatch';
  END IF;
END;
$$;

INSERT INTO public.commerce_fulfillment_holds (
  order_id,
  guild_id,
  customer_id,
  product_id,
  winning_order_id,
  conflicting_entitlement_id,
  provider_kind,
  provider_id
)
SELECT
  loser.order_id,
  loser.guild_id,
  loser.customer_id,
  loser.product_id,
  loser.winning_order_id,
  loser.conflicting_entitlement_id,
  loser.provider_kind,
  loser.provider_id
FROM pg_temp.commerce_fulfillment_backfill_losers AS loser
ON CONFLICT (order_id) DO NOTHING;

-- A staged key for a queue that never produced live access must not remain
-- activatable after that order loses. Existing live entitlements are surfaced
-- for operator reconciliation instead of being revoked automatically.
UPDATE public.license_keys AS license_key
   SET status = 'revoked',
       revoked_at = COALESCE(
         license_key.revoked_at,
         pg_catalog.clock_timestamp()
       ),
       revocation_reason = COALESCE(
         license_key.revocation_reason,
         'Duplicate paid order held during fulfillment-claim backfill'
       ),
       updated_at = pg_catalog.clock_timestamp()
  FROM pg_temp.commerce_fulfillment_backfill_losers AS loser
 WHERE license_key.order_id = loser.order_id
   AND loser.conflicting_entitlement_id IS NULL
   AND license_key.status IN ('pending_activation', 'active', 'suspended');

UPDATE public.orders AS paid_order
   SET status = 'pending_review',
       updated_at = pg_catalog.clock_timestamp()
  FROM pg_temp.commerce_fulfillment_backfill_losers AS loser
 WHERE paid_order.id = loser.order_id
   AND loser.provider_kind = 'subscription'
   AND loser.conflicting_entitlement_id IS NULL
   AND paid_order.status IN ('pending', 'completed');

INSERT INTO public.alerts (
  guild_id,
  alert_type,
  severity,
  title,
  message,
  metadata
)
SELECT
  loser.guild_id,
  CASE loser.provider_kind
    WHEN 'capture' THEN 'commerce_duplicate_purchase_capture'
    ELSE 'commerce_duplicate_subscription_activation'
  END,
  'critical',
  CASE
    WHEN loser.conflicting_entitlement_id IS NOT NULL
      THEN 'Historical duplicate paid access requires reconciliation'
    WHEN loser.provider_kind = 'capture'
      THEN 'Historical duplicate captured order was held'
    ELSE 'Historical duplicate subscription activation was held'
  END,
  CASE
    WHEN loser.conflicting_entitlement_id IS NOT NULL THEN
      'Paid order ' || loser.order_number
        || ' already has live access but another historical order owns the '
        || 'durable fulfillment claim. Future worker replays are held. '
        || 'Reconcile the existing entitlement and exact provider payment manually.'
    ELSE
      'Paid order ' || loser.order_number
        || ' lost the historical fulfillment claim before worker delivery. '
        || 'Its queue replay is permanently held and any undelivered staged '
        || 'licence key was revoked. Review the exact provider payment for refund.'
  END,
  pg_catalog.jsonb_build_object(
    'source', 'migration_backfill',
    'queue_id', loser.queue_id,
    'order_id', loser.order_id,
    'order_number', loser.order_number,
    'customer_id', loser.customer_id,
    'product_id', loser.product_id,
    'provider_kind', loser.provider_kind,
    'provider_id', loser.provider_id,
    'amount_cents', loser.amount_cents,
    'currency', loser.currency,
    'winning_order_id', loser.winning_order_id,
    'existing_entitlement_id', loser.conflicting_entitlement_id,
    'required_action', CASE
      WHEN loser.conflicting_entitlement_id IS NOT NULL
        THEN 'reconcile_duplicate_access_and_payment'
      ELSE 'refund_or_cancel_duplicate'
    END
  ) || CASE loser.provider_kind
    WHEN 'capture' THEN pg_catalog.jsonb_build_object(
      'paypal_capture_id', loser.provider_id
    )
    ELSE pg_catalog.jsonb_build_object(
      'paypal_subscription_id', loser.provider_id
    )
  END
FROM pg_temp.commerce_fulfillment_backfill_losers AS loser
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_temp.commerce_fulfillment_backfill_losers AS loser
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.alerts AS alert
      WHERE alert.guild_id = loser.guild_id
        AND alert.alert_type = CASE loser.provider_kind
          WHEN 'capture' THEN 'commerce_duplicate_purchase_capture'
          ELSE 'commerce_duplicate_subscription_activation'
        END
        AND alert.resolved = false
        AND alert.metadata ->> 'order_id' = loser.order_id::TEXT
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'historical paid fulfillment hold alert was not persisted';
  END IF;
END;
$$;

-- An active provider approval link can be retired only through a trusted
-- evidence-bearing boundary. Authenticated owners retain normal order CRUD,
-- but the trigger above prevents them from directly clearing the money rail.
CREATE OR REPLACE FUNCTION public.commerce_deactivate_pending_checkout(
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_provider_kind TEXT,
  p_provider_id TEXT,
  p_proof_kind TEXT,
  p_proof_reference TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_proof public.commerce_checkout_deactivation_proofs%ROWTYPE;
BEGIN
  IF p_order_id IS NULL
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_provider_kind NOT IN ('capture', 'subscription')
     OR p_provider_id IS NULL
     OR p_provider_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR p_proof_kind NOT IN (
       'provider_cancelled',
       'provider_expired',
       'approval_link_not_exposed',
       'operator_verified_unpayable'
     )
     OR p_proof_reference IS NULL
     OR p_proof_reference = ''
     OR p_proof_reference <> pg_catalog.btrim(p_proof_reference)
     OR pg_catalog.length(p_proof_reference) > 255 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_deactivate_pending_checkout: exact provider proof is required';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR v_order.customer_id IS DISTINCT FROM p_customer_id
     OR v_order.product_id IS DISTINCT FROM p_product_id
     OR v_order.status IS DISTINCT FROM 'pending'
     OR NOT COALESCE((v_order.source = 'purchase' OR v_order.source IS NULL), false)
     OR (
       p_provider_kind = 'capture'
       AND (
         v_order.paypal_order_id IS DISTINCT FROM p_provider_id
         OR v_order.paypal_subscription_id IS NOT NULL
       )
     )
     OR (
       p_provider_kind = 'subscription'
       AND (
         v_order.paypal_subscription_id IS DISTINCT FROM p_provider_id
         OR v_order.paypal_order_id IS NOT NULL
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_deactivate_pending_checkout: pending checkout identity mismatch';
  END IF;

  SELECT proof.*
    INTO v_proof
    FROM public.commerce_checkout_deactivation_proofs AS proof
   WHERE proof.order_id = v_order.id
   FOR UPDATE;

  IF FOUND THEN
    IF v_proof.guild_id IS DISTINCT FROM p_guild_id
       OR v_proof.customer_id IS DISTINCT FROM p_customer_id
       OR v_proof.product_id IS DISTINCT FROM p_product_id
       OR v_proof.provider_kind IS DISTINCT FROM p_provider_kind
       OR v_proof.provider_id IS DISTINCT FROM p_provider_id
       OR v_proof.proof_kind IS DISTINCT FROM p_proof_kind
       OR v_proof.proof_reference IS DISTINCT FROM p_proof_reference
       OR v_order.checkout_active THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_deactivate_pending_checkout: immutable proof replay mismatch';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_order.id,
      'checkout_active', false,
      'disposition', 'already_deactivated',
      'proof_id', v_proof.id
    );
  END IF;

  IF NOT v_order.checkout_active THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_deactivate_pending_checkout: inactive checkout has no durable proof';
  END IF;

  INSERT INTO public.commerce_checkout_deactivation_proofs (
    order_id,
    guild_id,
    customer_id,
    product_id,
    provider_kind,
    provider_id,
    proof_kind,
    proof_reference
  ) VALUES (
    v_order.id,
    v_order.guild_id,
    v_order.customer_id,
    v_order.product_id,
    p_provider_kind,
    p_provider_id,
    p_proof_kind,
    p_proof_reference
  )
  RETURNING * INTO v_proof;

  UPDATE public.orders AS paid_order
     SET checkout_active = false,
         updated_at = pg_catalog.clock_timestamp()
   WHERE paid_order.id = v_order.id
     AND paid_order.status = 'pending'
     AND paid_order.checkout_active = true
  RETURNING paid_order.* INTO v_order;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_deactivate_pending_checkout: active checkout transition raced';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_order.id,
    'checkout_active', false,
    'disposition', 'deactivated',
    'proof_id', v_proof.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_deactivate_pending_checkout(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_deactivate_pending_checkout(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT
) TO service_role;

-- The service role cannot insert paid orders directly.  This owner-rights
-- primitive creates either checkout shape and freezes the sold grant contract
-- before the transaction can expose a usable active checkout row.
CREATE OR REPLACE FUNCTION public.commerce_create_active_paid_checkout(
  p_order_number TEXT,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_plan_id UUID,
  p_provider_kind TEXT,
  p_provider_id TEXT,
  p_approval_url TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_snapshot JSONB;
  v_disposition TEXT := 'created';
BEGIN
  IF p_order_number IS NULL
     OR p_order_number = ''
     OR p_order_number <> pg_catalog.btrim(p_order_number)
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_provider_kind NOT IN ('capture', 'subscription')
     OR p_provider_id IS NULL
     OR p_provider_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR p_approval_url IS NULL
     OR p_approval_url <> pg_catalog.btrim(p_approval_url)
     OR pg_catalog.length(p_approval_url) NOT BETWEEN 1 AND 2048
     OR p_approval_url !~ '^https://'
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[A-Z]{3}$'
     OR (
       p_provider_kind = 'capture'
       AND p_plan_id IS NOT NULL
     )
     OR (
       p_provider_kind = 'subscription'
       AND p_plan_id IS NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_create_active_paid_checkout: exact checkout identity is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-paid-provider:' || p_provider_kind || ':' || p_provider_id,
      0
    )
  );
  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE (
       p_provider_kind = 'capture'
       AND paid_order.paypal_order_id = p_provider_id
       AND paid_order.paypal_subscription_id IS NULL
     )
      OR (
       p_provider_kind = 'subscription'
       AND paid_order.paypal_subscription_id = p_provider_id
       AND paid_order.paypal_order_id IS NULL
     )
   FOR UPDATE;

  IF FOUND THEN
    IF v_order.order_number IS DISTINCT FROM p_order_number
       OR v_order.guild_id IS DISTINCT FROM p_guild_id
       OR v_order.customer_id IS DISTINCT FROM p_customer_id
       OR v_order.product_id IS DISTINCT FROM p_product_id
       OR v_order.plan_id IS DISTINCT FROM p_plan_id
       OR v_order.amount_cents IS DISTINCT FROM p_amount_cents
       OR v_order.currency IS DISTINCT FROM p_currency
       OR v_order.checkout_approval_url IS DISTINCT FROM p_approval_url
       OR v_order.status IS DISTINCT FROM 'pending'
       OR v_order.checkout_active IS DISTINCT FROM true
       OR v_order.grant_snapshot_frozen_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_create_active_paid_checkout: provider replay identity mismatch';
    END IF;
    v_disposition := 'replay';
  ELSE
    INSERT INTO public.orders (
      order_number,
      customer_id,
      guild_id,
      product_id,
      plan_id,
      paypal_order_id,
      paypal_subscription_id,
      amount_cents,
      currency,
      status,
      source,
      checkout_active,
      checkout_approval_url
    ) VALUES (
      p_order_number,
      p_customer_id,
      p_guild_id,
      p_product_id,
      p_plan_id,
      CASE WHEN p_provider_kind = 'capture' THEN p_provider_id END,
      CASE WHEN p_provider_kind = 'subscription' THEN p_provider_id END,
      p_amount_cents,
      p_currency,
      'pending',
      'purchase',
      true,
      p_approval_url
    )
    RETURNING * INTO v_order;

    v_snapshot := public.commerce_freeze_order_grant_snapshot(
      v_order.id,
      p_guild_id,
      p_customer_id,
      p_product_id
    );
    IF v_snapshot ->> 'order_id' IS DISTINCT FROM v_order.id::TEXT
       OR v_snapshot ->> 'grant_snapshot_frozen_at' IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_create_active_paid_checkout: grant freeze did not persist';
    END IF;
    SELECT paid_order.*
      INTO v_order
      FROM public.orders AS paid_order
     WHERE paid_order.id = v_order.id
     FOR UPDATE;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'disposition', v_disposition,
    'id', v_order.id,
    'order_number', v_order.order_number,
    'guild_id', v_order.guild_id,
    'customer_id', v_order.customer_id,
    'product_id', v_order.product_id,
    'plan_id', v_order.plan_id,
    'paypal_order_id', v_order.paypal_order_id,
    'paypal_subscription_id', v_order.paypal_subscription_id,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency,
    'status', v_order.status,
    'checkout_active', v_order.checkout_active,
    'checkout_approval_url', v_order.checkout_approval_url,
    'delivery_type_snapshot', v_order.delivery_type_snapshot,
    'granted_role_ids_snapshot',
      pg_catalog.to_jsonb(v_order.granted_role_ids_snapshot),
    'granted_channel_ids_snapshot',
      pg_catalog.to_jsonb(v_order.granted_channel_ids_snapshot),
    'temporary_role_grants_snapshot',
      v_order.temporary_role_grants_snapshot,
    'grant_snapshot_frozen_at', v_order.grant_snapshot_frozen_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_create_active_paid_checkout(
  TEXT, TEXT, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_active_paid_checkout(
  TEXT, TEXT, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT
) TO service_role;

-- Provider-confirmed money must never exist only in an exception string.  Some
-- malformed or legacy webhooks cannot be attached to a local order/payment FK;
-- this immutable ledger records the exact event and safe diagnostic evidence
-- anyway.  If the observed guild is a real local tenant, the same transaction
-- also persists one critical operator alert.
CREATE TABLE IF NOT EXISTS public.commerce_provider_incidents (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  webhook_event_id TEXT NOT NULL UNIQUE,
  provider_event_type TEXT NOT NULL CHECK (
    provider_event_type IN (
      'PAYMENT.CAPTURE.COMPLETED',
      'BILLING.SUBSCRIPTION.ACTIVATED',
      'PAYMENT.SALE.COMPLETED'
    )
  ),
  provider_resource_id TEXT,
  provider_parent_id TEXT,
  observed_guild_id TEXT,
  routable_guild_id TEXT REFERENCES public.guild(id) ON DELETE RESTRICT,
  incident_reason TEXT NOT NULL CHECK (
    incident_reason IN (
      'provider_identity_malformed',
      'custom_identity_missing_or_malformed',
      'customer_identity_missing_or_mismatched',
      'order_identity_missing_or_ambiguous',
      'product_identity_missing_or_mismatched',
      'plan_identity_missing_or_mismatched',
      'financial_identity_malformed',
      'subscription_sale_router_failed'
    )
  ),
  evidence JSONB NOT NULL,
  alert_id UUID UNIQUE REFERENCES public.alerts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT commerce_provider_incidents_identity_check
    CHECK (
      webhook_event_id = pg_catalog.btrim(webhook_event_id)
      AND pg_catalog.length(webhook_event_id) BETWEEN 1 AND 160
      AND (
        provider_resource_id IS NULL
        OR pg_catalog.length(provider_resource_id) BETWEEN 1 AND 512
      )
      AND (
        provider_parent_id IS NULL
        OR pg_catalog.length(provider_parent_id) BETWEEN 1 AND 512
      )
      AND (
        observed_guild_id IS NULL
        OR (
          observed_guild_id = pg_catalog.btrim(observed_guild_id)
          AND pg_catalog.length(observed_guild_id) BETWEEN 1 AND 512
        )
      )
      AND pg_catalog.jsonb_typeof(evidence) = 'object'
      AND pg_catalog.octet_length(evidence::TEXT) <= 8192
      AND pg_catalog.isfinite(created_at)
    )
);

ALTER TABLE public.commerce_provider_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_provider_incidents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_provider_incidents
  FROM PUBLIC, anon, authenticated, service_role;

CREATE UNIQUE INDEX IF NOT EXISTS
  uniq_alerts_commerce_provider_incident
  ON public.alerts (((metadata ->> 'provider_incident_id')))
  WHERE alert_type = 'commerce_provider_payment_incident';

CREATE OR REPLACE FUNCTION public.commerce_record_provider_incident(
  p_webhook_event_id TEXT,
  p_provider_event_type TEXT,
  p_provider_resource_id TEXT,
  p_provider_parent_id TEXT,
  p_observed_guild_id TEXT,
  p_incident_reason TEXT,
  p_evidence JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_incident public.commerce_provider_incidents%ROWTYPE;
  v_alert public.alerts%ROWTYPE;
  v_routable_guild_id TEXT;
  v_disposition TEXT := 'created';
BEGIN
  IF p_webhook_event_id IS NULL
     OR p_webhook_event_id = ''
     OR p_webhook_event_id <> pg_catalog.btrim(p_webhook_event_id)
     OR pg_catalog.length(p_webhook_event_id) > 160
     OR p_provider_event_type NOT IN (
       'PAYMENT.CAPTURE.COMPLETED',
       'BILLING.SUBSCRIPTION.ACTIVATED',
       'PAYMENT.SALE.COMPLETED'
     )
     OR p_incident_reason NOT IN (
       'provider_identity_malformed',
       'custom_identity_missing_or_malformed',
       'customer_identity_missing_or_mismatched',
       'order_identity_missing_or_ambiguous',
       'product_identity_missing_or_mismatched',
       'plan_identity_missing_or_mismatched',
       'financial_identity_malformed',
       'subscription_sale_router_failed'
     )
     OR p_evidence IS NULL
     OR pg_catalog.jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
     OR pg_catalog.octet_length(p_evidence::TEXT) > 8192
     OR (
       p_provider_resource_id IS NOT NULL
       AND (
         p_provider_resource_id = ''
         OR pg_catalog.length(p_provider_resource_id) > 512
       )
     )
     OR (
       p_provider_parent_id IS NOT NULL
       AND (
         p_provider_parent_id = ''
         OR pg_catalog.length(p_provider_parent_id) > 512
       )
     )
     OR (
       p_observed_guild_id IS NOT NULL
       AND (
         p_observed_guild_id = ''
         OR p_observed_guild_id <> pg_catalog.btrim(p_observed_guild_id)
         OR pg_catalog.length(p_observed_guild_id) > 512
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_provider_incident: exact bounded incident evidence is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-provider-incident:' || p_webhook_event_id,
      0
    )
  );

  SELECT incident.*
    INTO v_incident
    FROM public.commerce_provider_incidents AS incident
   WHERE incident.webhook_event_id = p_webhook_event_id
   FOR UPDATE;
  IF FOUND THEN
    v_disposition := 'replay';
  ELSE
    -- Routability is an observation made exactly once. A tenant appearing or
    -- disappearing later cannot change replay identity or retroactively add
    -- an alert to an immutable provider incident.
    IF p_observed_guild_id IS NOT NULL THEN
      SELECT tenant.id
        INTO v_routable_guild_id
        FROM public.guild AS tenant
       WHERE tenant.id = p_observed_guild_id
       FOR KEY SHARE;
    END IF;

    INSERT INTO public.commerce_provider_incidents (
      webhook_event_id,
      provider_event_type,
      provider_resource_id,
      provider_parent_id,
      observed_guild_id,
      routable_guild_id,
      incident_reason,
      evidence
    ) VALUES (
      p_webhook_event_id,
      p_provider_event_type,
      p_provider_resource_id,
      p_provider_parent_id,
      p_observed_guild_id,
      v_routable_guild_id,
      p_incident_reason,
      p_evidence
    )
    RETURNING * INTO v_incident;
  END IF;

  IF v_incident.id IS NULL
     OR v_incident.provider_event_type
          IS DISTINCT FROM p_provider_event_type
     OR v_incident.provider_resource_id
          IS DISTINCT FROM p_provider_resource_id
     OR v_incident.provider_parent_id
          IS DISTINCT FROM p_provider_parent_id
     OR v_incident.observed_guild_id
          IS DISTINCT FROM p_observed_guild_id
     OR v_incident.incident_reason
          IS DISTINCT FROM p_incident_reason
     OR v_incident.evidence IS DISTINCT FROM p_evidence THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_provider_incident: immutable replay evidence mismatch';
  END IF;

  IF v_incident.routable_guild_id IS NOT NULL THEN
    IF v_incident.alert_id IS NULL THEN
      INSERT INTO public.alerts (
        guild_id,
        alert_type,
        severity,
        title,
        message,
        metadata
      ) VALUES (
        v_incident.routable_guild_id,
        'commerce_provider_payment_incident',
        'critical',
        'Provider money event could not be attached safely',
        'A provider-confirmed money event could not be attached to an exact '
          || 'local order. Reconcile the immutable incident before refunding '
          || 'or fulfilling manually.',
        pg_catalog.jsonb_build_object(
          'provider_incident_id', v_incident.id,
          'webhook_event_id', v_incident.webhook_event_id,
          'provider_event_type', v_incident.provider_event_type,
          'provider_resource_id', v_incident.provider_resource_id,
          'provider_parent_id', v_incident.provider_parent_id,
          'incident_reason', v_incident.incident_reason,
          'required_action',
            'reconcile_provider_event_then_refund_or_fulfill_manually'
        )
      )
      ON CONFLICT DO NOTHING
      RETURNING * INTO v_alert;

      IF NOT FOUND THEN
        SELECT alert.*
          INTO v_alert
          FROM public.alerts AS alert
         WHERE alert.alert_type = 'commerce_provider_payment_incident'
           AND alert.metadata ->> 'provider_incident_id'
                 = v_incident.id::TEXT
         FOR UPDATE;
      END IF;

      IF v_alert.id IS NULL
         OR v_alert.guild_id
              IS DISTINCT FROM v_incident.routable_guild_id
         OR v_alert.severity IS DISTINCT FROM 'critical'
         OR v_alert.metadata ->> 'webhook_event_id'
              IS DISTINCT FROM p_webhook_event_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'commerce_record_provider_incident: critical alert did not persist exactly';
      END IF;

      UPDATE public.commerce_provider_incidents AS incident
         SET alert_id = v_alert.id
       WHERE incident.id = v_incident.id
         AND incident.alert_id IS NULL
      RETURNING incident.* INTO v_incident;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'commerce_record_provider_incident: incident alert link raced';
      END IF;
    ELSE
      SELECT alert.*
        INTO v_alert
        FROM public.alerts AS alert
       WHERE alert.id = v_incident.alert_id
         AND alert.guild_id = v_incident.routable_guild_id
         AND alert.alert_type = 'commerce_provider_payment_incident'
         AND alert.severity = 'critical'
         AND alert.metadata ->> 'provider_incident_id'
               = v_incident.id::TEXT;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'commerce_record_provider_incident: durable alert identity mismatch';
      END IF;
    END IF;
  ELSIF v_incident.alert_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_provider_incident: unroutable incident has an alert';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'disposition', v_disposition,
    'incident_id', v_incident.id,
    'webhook_event_id', v_incident.webhook_event_id,
    'provider_event_type', v_incident.provider_event_type,
    'provider_resource_id', v_incident.provider_resource_id,
    'provider_parent_id', v_incident.provider_parent_id,
    'observed_guild_id', v_incident.observed_guild_id,
    'incident_reason', v_incident.incident_reason,
    'routable_guild_id', v_incident.routable_guild_id,
    'alert_id', v_incident.alert_id,
    'fulfillment_allowed', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_record_provider_incident(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_record_provider_incident(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;

-- Provider activation can arrive for an old subscription whose checkout row
-- was never recorded. Recovery atomically records the immutable provider and
-- financial identity as pending review, claims the paid identity, and persists
-- its durable hold plus critical alert. It deliberately leaves the delivery
-- contract unfrozen and uses the schema's empty grant defaults, so later code
-- cannot reconstruct a historical sale from today's mutable catalog.
CREATE OR REPLACE FUNCTION public.commerce_create_subscription_activation_recovery_order(
  p_order_number TEXT,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_plan_id UUID,
  p_paypal_subscription_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_hold public.commerce_fulfillment_holds%ROWTYPE;
  v_alert public.alerts%ROWTYPE;
  v_hold_result JSONB;
  v_alert_type TEXT;
  v_disposition TEXT := 'created';
BEGIN
  IF p_order_number IS NULL
     OR p_order_number = ''
     OR p_order_number <> pg_catalog.btrim(p_order_number)
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_plan_id IS NULL
     OR p_paypal_subscription_id IS NULL
     OR p_paypal_subscription_id
          !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_create_subscription_activation_recovery_order: exact identity is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-paid-provider:subscription:' || p_paypal_subscription_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_guild_id || E'\x1f'
        || p_customer_id::TEXT || E'\x1f'
        || p_product_id::TEXT,
      0
    )
  );
  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.paypal_subscription_id = p_paypal_subscription_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_order.guild_id IS DISTINCT FROM p_guild_id
       OR v_order.customer_id IS DISTINCT FROM p_customer_id
       OR v_order.product_id IS DISTINCT FROM p_product_id
       OR v_order.plan_id IS DISTINCT FROM p_plan_id
       OR v_order.paypal_order_id IS NOT NULL
       OR v_order.amount_cents IS DISTINCT FROM p_amount_cents
       OR v_order.currency IS DISTINCT FROM p_currency
       OR v_order.status NOT IN ('pending', 'pending_review')
       OR v_order.checkout_active IS DISTINCT FROM false
       OR v_order.delivery_type_snapshot IS NOT NULL
       OR v_order.grant_snapshot_frozen_at IS NOT NULL
       OR v_order.granted_role_ids_snapshot <> '{}'::TEXT[]
       OR v_order.granted_channel_ids_snapshot <> '{}'::TEXT[]
       OR v_order.temporary_role_grants_snapshot <> '[]'::JSONB THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_create_subscription_activation_recovery_order: provider replay identity mismatch';
    END IF;
    v_disposition := 'replay';
  ELSE
    -- Mutable FK rows authorize only a genuinely new recovery record. Exact
    -- provider replay above is validated from its durable order/hold and must
    -- not fail merely because the catalog changed after the first commit.
    PERFORM 1
      FROM public.customers AS customer
     WHERE customer.id = p_customer_id
       AND customer.guild_id = p_guild_id
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_create_subscription_activation_recovery_order: customer identity mismatch';
    END IF;
    PERFORM 1
      FROM public.products AS product
     WHERE product.id = p_product_id
       AND product.guild_id = p_guild_id
       AND product.type = 'subscription'
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_create_subscription_activation_recovery_order: product identity mismatch';
    END IF;
    PERFORM 1
      FROM public.plans AS plan
     WHERE plan.id = p_plan_id
       AND plan.product_id = p_product_id
       AND plan.guild_id = p_guild_id
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_create_subscription_activation_recovery_order: plan identity mismatch';
    END IF;

    INSERT INTO public.orders (
      order_number,
      customer_id,
      guild_id,
      product_id,
      plan_id,
      paypal_order_id,
      paypal_subscription_id,
      amount_cents,
      currency,
      status,
      source,
      checkout_active,
      delivery_type_snapshot,
      grant_snapshot_frozen_at
    ) VALUES (
      p_order_number,
      p_customer_id,
      p_guild_id,
      p_product_id,
      p_plan_id,
      NULL,
      p_paypal_subscription_id,
      p_amount_cents,
      p_currency,
      'pending_review',
      'purchase',
      false,
      NULL,
      NULL
    )
    RETURNING * INTO v_order;
  END IF;

  v_hold_result := public.commerce_hold_unknown_delivery_contract(
    v_order.id,
    v_order.guild_id,
    v_order.customer_id,
    v_order.product_id,
    'subscription',
    v_order.paypal_subscription_id,
    v_order.amount_cents,
    v_order.currency
  );
  IF v_hold_result ->> 'disposition' IS DISTINCT FROM 'held'
     OR v_hold_result ->> 'order_id' IS DISTINCT FROM v_order.id::TEXT
     OR v_hold_result ->> 'alert_id' IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_create_subscription_activation_recovery_order: hold result mismatch';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = (v_hold_result ->> 'order_id')::UUID
     AND paid_order.status = 'pending_review'
     AND paid_order.checkout_active = false
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_create_subscription_activation_recovery_order: review hold transition mismatch';
  END IF;

  SELECT held.*
    INTO v_hold
    FROM public.commerce_fulfillment_holds AS held
   WHERE held.order_id = v_order.id
   FOR SHARE;
  IF NOT FOUND
     OR v_hold.guild_id IS DISTINCT FROM v_order.guild_id
     OR v_hold.customer_id IS DISTINCT FROM v_order.customer_id
     OR v_hold.product_id IS DISTINCT FROM v_order.product_id
     OR v_hold.provider_kind IS DISTINCT FROM 'subscription'
     OR v_hold.provider_id IS DISTINCT FROM v_order.paypal_subscription_id
     OR v_hold.hold_reason NOT IN (
       'unknown_delivery_contract',
       'duplicate_paid_fulfillment'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_create_subscription_activation_recovery_order: durable hold mismatch';
  END IF;

  v_alert_type := CASE v_hold.hold_reason
    WHEN 'unknown_delivery_contract'
      THEN 'commerce_unknown_delivery_contract'
    ELSE 'commerce_duplicate_subscription_activation'
  END;
  IF v_hold_result ->> 'alert_id' IS NOT NULL THEN
    SELECT alert.*
      INTO v_alert
      FROM public.alerts AS alert
     WHERE alert.id = (v_hold_result ->> 'alert_id')::UUID
       AND alert.guild_id = v_order.guild_id
       AND alert.alert_type = v_alert_type
       AND alert.resolved = false
       AND alert.metadata ->> 'order_id' = v_order.id::TEXT
     FOR SHARE;
  ELSE
    SELECT alert.*
      INTO v_alert
      FROM public.alerts AS alert
     WHERE alert.guild_id = v_order.guild_id
       AND alert.alert_type = v_alert_type
       AND alert.resolved = false
       AND alert.metadata ->> 'order_id' = v_order.id::TEXT
     ORDER BY alert.created_at, alert.id
     LIMIT 1
     FOR SHARE;
  END IF;

  IF v_alert.id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_create_subscription_activation_recovery_order: critical alert mismatch';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'disposition', v_disposition,
    'id', v_order.id,
    'order_number', v_order.order_number,
    'guild_id', v_order.guild_id,
    'customer_id', v_order.customer_id,
    'product_id', v_order.product_id,
    'plan_id', v_order.plan_id,
    'paypal_order_id', v_order.paypal_order_id,
    'paypal_subscription_id', v_order.paypal_subscription_id,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency,
    'status', v_order.status,
    'checkout_active', v_order.checkout_active,
    'hold_reason', v_hold.hold_reason,
    'winning_order_id', v_hold.winning_order_id,
    'conflicting_entitlement_id', v_hold.conflicting_entitlement_id,
    'alert_id', v_alert.id,
    'alert_type', v_alert.alert_type,
    'delivery_type_snapshot', v_order.delivery_type_snapshot,
    'granted_role_ids_snapshot',
      pg_catalog.to_jsonb(v_order.granted_role_ids_snapshot),
    'granted_channel_ids_snapshot',
      pg_catalog.to_jsonb(v_order.granted_channel_ids_snapshot),
    'temporary_role_grants_snapshot',
      v_order.temporary_role_grants_snapshot,
    'grant_snapshot_frozen_at', v_order.grant_snapshot_frozen_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_create_subscription_activation_recovery_order(
  TEXT, TEXT, UUID, UUID, UUID, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_subscription_activation_recovery_order(
  TEXT, TEXT, UUID, UUID, UUID, TEXT, INTEGER, TEXT
) TO service_role;

-- Provider delivery order is not execution order. Keep an immutable ledger of
-- every subscription lifecycle event plus one serialized head so a delayed
-- cancellation/payment-failure cannot overwrite a newer successful renewal or
-- reactivation. Provider create_time is the primary clock; the conservative
-- event priority and event id form a deterministic tie-breaker.
CREATE TABLE IF NOT EXISTS public.commerce_subscription_lifecycle_heads (
  paypal_subscription_id TEXT PRIMARY KEY,
  order_id UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,
  last_webhook_event_id TEXT NOT NULL UNIQUE,
  last_provider_event_type TEXT NOT NULL,
  last_provider_occurred_at TIMESTAMPTZ NOT NULL,
  last_event_priority INTEGER NOT NULL,
  generation BIGINT NOT NULL,
  paid_through_at TIMESTAMPTZ,
  cancellation_effective_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT commerce_subscription_lifecycle_heads_identity_check CHECK (
    paypal_subscription_id =
      pg_catalog.btrim(paypal_subscription_id)
    AND paypal_subscription_id
      ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
    AND last_webhook_event_id =
      pg_catalog.btrim(last_webhook_event_id)
    AND pg_catalog.length(last_webhook_event_id) BETWEEN 1 AND 160
    AND last_provider_event_type IN (
      'BILLING.SUBSCRIPTION.ACTIVATED',
      'PAYMENT.SALE.COMPLETED',
      'BILLING.SUBSCRIPTION.CANCELLED',
      'BILLING.SUBSCRIPTION.SUSPENDED',
      'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
      'BILLING.SUBSCRIPTION.EXPIRED'
    )
    AND last_event_priority BETWEEN 10 AND 60
    AND generation > 0
    AND pg_catalog.isfinite(last_provider_occurred_at)
    AND (
      paid_through_at IS NULL
      OR pg_catalog.isfinite(paid_through_at)
    )
    AND (
      cancellation_effective_at IS NULL
      OR pg_catalog.isfinite(cancellation_effective_at)
    )
    AND pg_catalog.isfinite(updated_at)
  )
);

CREATE TABLE IF NOT EXISTS public.commerce_subscription_lifecycle_events (
  webhook_event_id TEXT PRIMARY KEY,
  paypal_subscription_id TEXT NOT NULL,
  provider_event_type TEXT NOT NULL,
  provider_occurred_at TIMESTAMPTZ NOT NULL,
  provider_paid_through_at TIMESTAMPTZ,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,
  disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'stale')),
  event_priority INTEGER NOT NULL,
  generation BIGINT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT commerce_subscription_lifecycle_events_identity_check CHECK (
    webhook_event_id = pg_catalog.btrim(webhook_event_id)
    AND pg_catalog.length(webhook_event_id) BETWEEN 1 AND 160
    AND paypal_subscription_id =
      pg_catalog.btrim(paypal_subscription_id)
    AND paypal_subscription_id
      ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
    AND provider_event_type IN (
      'BILLING.SUBSCRIPTION.ACTIVATED',
      'PAYMENT.SALE.COMPLETED',
      'BILLING.SUBSCRIPTION.CANCELLED',
      'BILLING.SUBSCRIPTION.SUSPENDED',
      'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
      'BILLING.SUBSCRIPTION.EXPIRED'
    )
    AND event_priority BETWEEN 10 AND 60
    AND generation > 0
    AND pg_catalog.isfinite(provider_occurred_at)
    AND (
      provider_paid_through_at IS NULL
      OR pg_catalog.isfinite(provider_paid_through_at)
    )
    AND pg_catalog.isfinite(recorded_at)
  ),
  UNIQUE (paypal_subscription_id, webhook_event_id)
);

CREATE INDEX IF NOT EXISTS
  idx_commerce_subscription_lifecycle_events_order
  ON public.commerce_subscription_lifecycle_events (
    order_id, provider_occurred_at, event_priority, webhook_event_id
  );

ALTER TABLE public.commerce_subscription_lifecycle_heads
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_subscription_lifecycle_heads
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_subscription_lifecycle_events
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_subscription_lifecycle_events
  FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_subscription_lifecycle_heads
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.commerce_subscription_lifecycle_events
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_record_subscription_lifecycle_observation(
  p_webhook_event_id TEXT,
  p_provider_event_type TEXT,
  p_provider_occurred_at TIMESTAMPTZ,
  p_provider_paid_through_at TIMESTAMPTZ,
  p_paypal_subscription_id TEXT,
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_plan_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_head public.commerce_subscription_lifecycle_heads%ROWTYPE;
  v_event public.commerce_subscription_lifecycle_events%ROWTYPE;
  v_priority INTEGER;
  v_generation BIGINT;
  v_disposition TEXT;
  v_paid_through_at TIMESTAMPTZ;
  v_cancellation_effective_at TIMESTAMPTZ;
BEGIN
  v_priority := CASE p_provider_event_type
    WHEN 'BILLING.SUBSCRIPTION.ACTIVATED' THEN 20
    WHEN 'PAYMENT.SALE.COMPLETED' THEN 30
    WHEN 'BILLING.SUBSCRIPTION.PAYMENT.FAILED' THEN 40
    WHEN 'BILLING.SUBSCRIPTION.SUSPENDED' THEN 50
    WHEN 'BILLING.SUBSCRIPTION.CANCELLED' THEN 60
    WHEN 'BILLING.SUBSCRIPTION.EXPIRED' THEN 60
    ELSE NULL
  END;
  IF p_webhook_event_id IS NULL
     OR p_webhook_event_id = ''
     OR p_webhook_event_id <> pg_catalog.btrim(p_webhook_event_id)
     OR pg_catalog.length(p_webhook_event_id) > 160
     OR v_priority IS NULL
     OR p_provider_occurred_at IS NULL
     OR NOT pg_catalog.isfinite(p_provider_occurred_at)
     OR (
       p_provider_paid_through_at IS NOT NULL
       AND NOT pg_catalog.isfinite(p_provider_paid_through_at)
     )
     OR (
       p_provider_event_type IN (
         'BILLING.SUBSCRIPTION.ACTIVATED',
         'PAYMENT.SALE.COMPLETED',
         'BILLING.SUBSCRIPTION.CANCELLED'
       )
       AND (
         p_provider_paid_through_at IS NULL
         OR p_provider_paid_through_at <= p_provider_occurred_at
       )
     )
     OR p_paypal_subscription_id IS NULL
     OR p_paypal_subscription_id
          !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR p_order_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_plan_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_subscription_lifecycle_observation: exact provider chronology is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'commerce-guild-purge:' || p_guild_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-subscription-lifecycle:' || p_paypal_subscription_id,
      0
    )
  );

  SELECT event_row.*
    INTO v_event
    FROM public.commerce_subscription_lifecycle_events AS event_row
   WHERE event_row.webhook_event_id = p_webhook_event_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_event.paypal_subscription_id
         IS DISTINCT FROM p_paypal_subscription_id
       OR v_event.provider_event_type
         IS DISTINCT FROM p_provider_event_type
       OR v_event.provider_occurred_at
         IS DISTINCT FROM p_provider_occurred_at
       OR v_event.provider_paid_through_at
         IS DISTINCT FROM p_provider_paid_through_at
       OR v_event.order_id IS DISTINCT FROM p_order_id
       OR v_event.guild_id IS DISTINCT FROM p_guild_id
       OR v_event.customer_id IS DISTINCT FROM p_customer_id
       OR v_event.product_id IS DISTINCT FROM p_product_id
       OR v_event.plan_id IS DISTINCT FROM p_plan_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_record_subscription_lifecycle_observation: immutable event replay mismatch';
    END IF;
    SELECT head.*
      INTO v_head
      FROM public.commerce_subscription_lifecycle_heads AS head
     WHERE head.paypal_subscription_id = p_paypal_subscription_id
     FOR SHARE;
    RETURN pg_catalog.jsonb_build_object(
      'disposition', CASE
        WHEN v_event.disposition = 'accepted'
         AND v_head.last_webhook_event_id = v_event.webhook_event_id
         AND v_head.generation = v_event.generation
          THEN 'replay'
        ELSE 'stale_replay'
      END,
      'webhook_event_id', v_event.webhook_event_id,
      'provider_event_type', v_event.provider_event_type,
      'provider_occurred_at', v_event.provider_occurred_at,
      'provider_paid_through_at', v_event.provider_paid_through_at,
      'paypal_subscription_id', v_event.paypal_subscription_id,
      'order_id', v_event.order_id,
      'guild_id', v_event.guild_id,
      'customer_id', v_event.customer_id,
      'product_id', v_event.product_id,
      'plan_id', v_event.plan_id,
      'generation', v_event.generation,
      'accepted',
        v_event.disposition = 'accepted'
        AND v_head.last_webhook_event_id = v_event.webhook_event_id
        AND v_head.generation = v_event.generation
    );
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
     AND paid_order.product_id = p_product_id
     AND paid_order.plan_id = p_plan_id
     AND paid_order.paypal_subscription_id = p_paypal_subscription_id
     AND paid_order.paypal_order_id IS NULL
     AND paid_order.status IN ('pending', 'completed', 'pending_review')
     AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_subscription_lifecycle_observation: paid order identity mismatch';
  END IF;

  SELECT head.*
    INTO v_head
    FROM public.commerce_subscription_lifecycle_heads AS head
   WHERE head.paypal_subscription_id = p_paypal_subscription_id
   FOR UPDATE;

  IF v_head.paypal_subscription_id IS NULL THEN
    v_disposition := 'accepted';
    v_generation := 1;
    v_paid_through_at := p_provider_paid_through_at;
  ELSIF (
    p_provider_occurred_at,
    v_priority,
    p_webhook_event_id
  ) > (
    v_head.last_provider_occurred_at,
    v_head.last_event_priority,
    v_head.last_webhook_event_id
  ) THEN
    IF v_head.order_id IS DISTINCT FROM p_order_id
       OR v_head.guild_id IS DISTINCT FROM p_guild_id
       OR v_head.customer_id IS DISTINCT FROM p_customer_id
       OR v_head.product_id IS DISTINCT FROM p_product_id
       OR v_head.plan_id IS DISTINCT FROM p_plan_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_record_subscription_lifecycle_observation: lifecycle head identity mismatch';
    END IF;
    v_disposition := 'accepted';
    v_generation := v_head.generation + 1;
    v_paid_through_at := CASE
      WHEN p_provider_event_type IN (
        'BILLING.SUBSCRIPTION.ACTIVATED',
        'PAYMENT.SALE.COMPLETED',
        'BILLING.SUBSCRIPTION.CANCELLED'
      ) THEN p_provider_paid_through_at
      ELSE v_head.paid_through_at
    END;
  ELSE
    v_disposition := 'stale';
    v_generation := v_head.generation;
    v_paid_through_at := v_head.paid_through_at;
  END IF;

  IF v_disposition = 'accepted' THEN
    v_cancellation_effective_at := CASE p_provider_event_type
      WHEN 'BILLING.SUBSCRIPTION.CANCELLED'
        THEN p_provider_paid_through_at
      WHEN 'BILLING.SUBSCRIPTION.EXPIRED'
        THEN p_provider_occurred_at
      ELSE NULL
    END;
    INSERT INTO public.commerce_subscription_lifecycle_heads (
      paypal_subscription_id,
      order_id,
      guild_id,
      customer_id,
      product_id,
      plan_id,
      last_webhook_event_id,
      last_provider_event_type,
      last_provider_occurred_at,
      last_event_priority,
      generation,
      paid_through_at,
      cancellation_effective_at,
      updated_at
    ) VALUES (
      p_paypal_subscription_id,
      p_order_id,
      p_guild_id,
      p_customer_id,
      p_product_id,
      p_plan_id,
      p_webhook_event_id,
      p_provider_event_type,
      p_provider_occurred_at,
      v_priority,
      v_generation,
      v_paid_through_at,
      v_cancellation_effective_at,
      pg_catalog.clock_timestamp()
    )
    ON CONFLICT (paypal_subscription_id) DO UPDATE
      SET last_webhook_event_id = EXCLUDED.last_webhook_event_id,
          last_provider_event_type = EXCLUDED.last_provider_event_type,
          last_provider_occurred_at = EXCLUDED.last_provider_occurred_at,
          last_event_priority = EXCLUDED.last_event_priority,
          generation = EXCLUDED.generation,
          paid_through_at = EXCLUDED.paid_through_at,
          cancellation_effective_at = EXCLUDED.cancellation_effective_at,
          updated_at = EXCLUDED.updated_at;
  END IF;

  INSERT INTO public.commerce_subscription_lifecycle_events (
    webhook_event_id,
    paypal_subscription_id,
    provider_event_type,
    provider_occurred_at,
    provider_paid_through_at,
    order_id,
    guild_id,
    customer_id,
    product_id,
    plan_id,
    disposition,
    event_priority,
    generation
  ) VALUES (
    p_webhook_event_id,
    p_paypal_subscription_id,
    p_provider_event_type,
    p_provider_occurred_at,
    p_provider_paid_through_at,
    p_order_id,
    p_guild_id,
    p_customer_id,
    p_product_id,
    p_plan_id,
    v_disposition,
    v_priority,
    v_generation
  )
  RETURNING * INTO v_event;

  RETURN pg_catalog.jsonb_build_object(
    'disposition', v_disposition,
    'webhook_event_id', v_event.webhook_event_id,
    'provider_event_type', v_event.provider_event_type,
    'provider_occurred_at', v_event.provider_occurred_at,
    'provider_paid_through_at', v_event.provider_paid_through_at,
    'paypal_subscription_id', v_event.paypal_subscription_id,
    'order_id', v_event.order_id,
    'guild_id', v_event.guild_id,
    'customer_id', v_event.customer_id,
    'product_id', v_event.product_id,
    'plan_id', v_event.plan_id,
    'generation', v_event.generation,
    'accepted', v_event.disposition = 'accepted'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_record_subscription_lifecycle_observation(
  TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT,
  UUID, TEXT, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_record_subscription_lifecycle_observation(
  TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT,
  UUID, TEXT, UUID, UUID, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_create_or_recover_subscription_lifecycle_action(
  p_webhook_event_id TEXT,
  p_fulfillment_type TEXT,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_discord_id TEXT,
  p_product_id UUID,
  p_order_id UUID,
  p_plan_id UUID,
  p_paypal_subscription_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action_name TEXT;
  v_idempotency_key TEXT;
  v_order public.orders%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_activation_action public.bot_action_queue%ROWTYPE;
  v_event public.commerce_subscription_lifecycle_events%ROWTYPE;
  v_head public.commerce_subscription_lifecycle_heads%ROWTYPE;
  v_carrier_discord_id TEXT;
  v_carrier_product_name TEXT;
  v_payload JSONB;
  v_disposition TEXT;
  v_next_retry_at TIMESTAMPTZ;
  v_current_authority BOOLEAN;
BEGIN
  IF p_webhook_event_id IS NULL
     OR p_webhook_event_id = ''
     OR p_webhook_event_id <> pg_catalog.btrim(p_webhook_event_id)
     OR pg_catalog.length(p_webhook_event_id) > 160
     OR p_fulfillment_type NOT IN (
       'subscription_cancelled',
       'subscription_suspended',
       'subscription_payment_failed'
     )
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_customer_id IS NULL
     OR p_discord_id IS NULL
     OR p_discord_id = ''
     OR p_discord_id <> pg_catalog.btrim(p_discord_id)
     OR p_product_id IS NULL
     OR p_order_id IS NULL
     OR p_plan_id IS NULL
     OR p_paypal_subscription_id IS NULL
     OR p_paypal_subscription_id = ''
     OR p_paypal_subscription_id <> pg_catalog.btrim(p_paypal_subscription_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'subscription lifecycle action requires exact webhook and order identity';
  END IF;
  v_action_name := CASE p_fulfillment_type
    WHEN 'subscription_cancelled' THEN 'fulfill_cancellation'
    ELSE 'fulfill_suspension'
  END;
  v_idempotency_key := 'paypal:lifecycle:' || p_webhook_event_id
    || ':' || p_fulfillment_type;

  -- The shared purge barrier is always the first lock in a guild-scoped
  -- commerce mutation. Purge takes the exclusive form of this exact key.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'commerce-guild-purge:' || p_guild_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_idempotency_key, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-subscription-lifecycle:' || p_paypal_subscription_id,
      0
    )
  );

  SELECT event_row.*
    INTO v_event
    FROM public.commerce_subscription_lifecycle_events AS event_row
   WHERE event_row.webhook_event_id = p_webhook_event_id
     AND event_row.paypal_subscription_id = p_paypal_subscription_id
     AND event_row.order_id = p_order_id
     AND event_row.guild_id = p_guild_id
     AND event_row.customer_id = p_customer_id
     AND event_row.product_id = p_product_id
     AND event_row.plan_id = p_plan_id
   FOR SHARE;
  IF NOT FOUND
     OR v_event.disposition IS DISTINCT FROM 'accepted'
     OR (
       p_fulfillment_type = 'subscription_cancelled'
       AND v_event.provider_event_type NOT IN (
         'BILLING.SUBSCRIPTION.CANCELLED',
         'BILLING.SUBSCRIPTION.EXPIRED'
       )
     )
     OR (
       p_fulfillment_type = 'subscription_suspended'
       AND v_event.provider_event_type IS DISTINCT FROM
         'BILLING.SUBSCRIPTION.SUSPENDED'
     )
     OR (
       p_fulfillment_type = 'subscription_payment_failed'
       AND v_event.provider_event_type IS DISTINCT FROM
         'BILLING.SUBSCRIPTION.PAYMENT.FAILED'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'subscription lifecycle action observation mismatch';
  END IF;

  SELECT head.*
    INTO v_head
    FROM public.commerce_subscription_lifecycle_heads AS head
   WHERE head.paypal_subscription_id = p_paypal_subscription_id
     AND head.order_id = p_order_id
     AND head.guild_id = p_guild_id
     AND head.customer_id = p_customer_id
     AND head.product_id = p_product_id
     AND head.plan_id = p_plan_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'subscription lifecycle action head mismatch';
  END IF;
  v_current_authority :=
    v_head.last_webhook_event_id = v_event.webhook_event_id
    AND v_head.generation = v_event.generation;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
     AND paid_order.product_id = p_product_id
     AND paid_order.plan_id = p_plan_id
     AND paid_order.paypal_subscription_id = p_paypal_subscription_id
     AND paid_order.paypal_order_id IS NULL
     AND paid_order.status IN ('completed', 'pending_review')
     AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'subscription lifecycle action paid order identity mismatch';
  END IF;

  SELECT queue.*
    INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.idempotency_key = v_idempotency_key
   FOR UPDATE;

  IF NOT v_current_authority THEN
    IF v_action.id IS NOT NULL
       AND (
         v_action.guild_id IS DISTINCT FROM p_guild_id
         OR v_action.action IS DISTINCT FROM v_action_name
         OR v_action.lane IS DISTINCT FROM 'commerce'
         OR v_action.payload ->> 'webhook_event_id'
              IS DISTINCT FROM p_webhook_event_id
         OR pg_catalog.jsonb_typeof(
              v_action.payload -> 'lifecycle_generation'
            ) IS DISTINCT FROM 'number'
         OR (v_action.payload ->> 'lifecycle_generation')::BIGINT
              IS DISTINCT FROM v_event.generation
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'subscription lifecycle superseded action mismatch';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'disposition', 'superseded',
      'action_id', v_action.id,
      'action', CASE WHEN v_action.id IS NULL
        THEN v_action_name ELSE v_action.action
      END,
      'action_status', CASE WHEN v_action.id IS NULL
        THEN NULL ELSE v_action.status
      END,
      'idempotency_key', v_idempotency_key,
      'webhook_event_id', p_webhook_event_id,
      'provider_event_type', v_event.provider_event_type,
      'provider_occurred_at', v_event.provider_occurred_at,
      'provider_paid_through_at', v_event.provider_paid_through_at,
      'lifecycle_generation', v_event.generation,
      'current_authority', false,
      'fulfillment_type', p_fulfillment_type,
      'guild_id', p_guild_id,
      'customer_id', p_customer_id,
      'discord_id', CASE WHEN v_action.id IS NULL
        THEN NULL ELSE v_action.payload ->> 'discord_id'
      END,
      'product_id', p_product_id,
      'product_name', CASE WHEN v_action.id IS NULL
        THEN NULL ELSE v_action.payload ->> 'product_name'
      END,
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'plan_id', p_plan_id,
      'paypal_subscription_id', p_paypal_subscription_id,
      'amount_cents', v_order.amount_cents,
      'currency', v_order.currency
    );
  END IF;

  IF v_action.id IS NULL THEN
    -- First-time lifecycle delivery inherits its Discord/display carrier from
    -- the accepted activation action. Catalog/customer rows are mutable
    -- presentation state and cannot authorize or dead-letter paid history.
    SELECT queue.*
      INTO v_activation_action
      FROM public.bot_action_queue AS queue
     WHERE queue.guild_id = p_guild_id
       AND queue.action = 'fulfill_subscription'
       AND queue.lane = 'commerce'
       AND queue.payload ->> 'paypal_subscription_id'
            = p_paypal_subscription_id
       AND queue.payload ->> 'order_id' = p_order_id::TEXT
       AND queue.payload ->> 'fulfillment_type' IN (
         'subscription_activated',
         'subscription_renewed'
       )
       AND (
         NOT (queue.payload ? 'lifecycle_generation')
         OR (
           pg_catalog.jsonb_typeof(
             queue.payload -> 'lifecycle_generation'
           ) = 'number'
           AND (queue.payload ->> 'lifecycle_generation')::BIGINT
                 <= v_event.generation
         )
       )
     ORDER BY CASE
       WHEN pg_catalog.jsonb_typeof(
         queue.payload -> 'lifecycle_generation'
       ) = 'number'
         THEN (queue.payload ->> 'lifecycle_generation')::BIGINT
       ELSE 0
     END DESC,
     queue.created_at DESC,
     queue.id DESC
     LIMIT 1
     FOR SHARE;
    IF NOT FOUND
       OR v_activation_action.status NOT IN (
         'staged', 'pending', 'processing', 'completed', 'failed'
       )
       OR pg_catalog.jsonb_typeof(v_activation_action.payload)
            IS DISTINCT FROM 'object'
       OR v_activation_action.payload ->> 'fulfillment_type' NOT IN (
            'subscription_activated',
            'subscription_renewed'
          )
       OR v_activation_action.payload ->> 'guild_id'
            IS DISTINCT FROM p_guild_id
       OR v_activation_action.payload ->> 'customer_id'
            IS DISTINCT FROM p_customer_id::TEXT
       OR v_activation_action.payload ->> 'product_id'
            IS DISTINCT FROM p_product_id::TEXT
       OR v_activation_action.payload ->> 'order_id'
            IS DISTINCT FROM p_order_id::TEXT
       OR v_activation_action.payload ->> 'order_number'
            IS DISTINCT FROM v_order.order_number
       OR v_activation_action.payload ->> 'plan_id'
            IS DISTINCT FROM p_plan_id::TEXT
       OR v_activation_action.payload ->> 'paypal_subscription_id'
            IS DISTINCT FROM p_paypal_subscription_id
       OR v_activation_action.payload ->> 'entitlement_type'
            IS DISTINCT FROM 'subscription'
       OR v_activation_action.payload ->> 'discord_id' IS NULL
       OR pg_catalog.btrim(
         v_activation_action.payload ->> 'discord_id'
       ) = ''
       OR v_activation_action.payload ->> 'product_name' IS NULL
       OR pg_catalog.btrim(
         v_activation_action.payload ->> 'product_name'
       ) = '' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'subscription lifecycle action historical carrier mismatch';
    END IF;
    v_carrier_discord_id :=
      v_activation_action.payload ->> 'discord_id';
    v_carrier_product_name :=
      v_activation_action.payload ->> 'product_name';
  ELSE
    v_carrier_discord_id := v_action.payload ->> 'discord_id';
    v_carrier_product_name := v_action.payload ->> 'product_name';
  END IF;

  v_payload := pg_catalog.jsonb_build_object(
    'fulfillment_type', p_fulfillment_type,
    'guild_id', p_guild_id,
    'customer_id', p_customer_id,
    'discord_id', v_carrier_discord_id,
    'product_id', p_product_id,
    'product_name', v_carrier_product_name,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'plan_id', p_plan_id,
    'paypal_subscription_id', p_paypal_subscription_id,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency,
    'granted_role_ids', pg_catalog.jsonb_build_array(),
    'granted_channel_ids', pg_catalog.jsonb_build_array(),
    'entitlement_type', 'subscription',
    'webhook_event_id', p_webhook_event_id,
    'provider_event_type', v_event.provider_event_type,
    'provider_occurred_at', v_event.provider_occurred_at,
    'provider_paid_through_at', v_event.provider_paid_through_at,
    'lifecycle_generation', v_event.generation
  );
  v_next_retry_at := CASE
    WHEN v_event.provider_event_type = 'BILLING.SUBSCRIPTION.CANCELLED'
     AND v_event.provider_paid_through_at > pg_catalog.clock_timestamp()
      THEN v_event.provider_paid_through_at
    ELSE NULL
  END;

  IF v_action.id IS NOT NULL THEN
    IF v_action.guild_id IS DISTINCT FROM p_guild_id
       OR v_action.action IS DISTINCT FROM v_action_name
       OR v_action.lane IS DISTINCT FROM 'commerce'
       OR v_action.status NOT IN (
         'staged', 'pending', 'processing', 'completed', 'failed'
       )
       OR pg_catalog.jsonb_typeof(v_action.payload) IS DISTINCT FROM 'object'
       OR v_action.payload ->> 'fulfillment_type'
            IS DISTINCT FROM p_fulfillment_type
       OR v_action.payload ->> 'guild_id' IS DISTINCT FROM p_guild_id
       OR v_action.payload ->> 'customer_id'
            IS DISTINCT FROM p_customer_id::TEXT
       OR v_action.payload ->> 'product_id'
            IS DISTINCT FROM p_product_id::TEXT
       OR v_action.payload ->> 'order_id' IS DISTINCT FROM p_order_id::TEXT
       OR v_action.payload ->> 'order_number'
            IS DISTINCT FROM v_order.order_number
       OR v_action.payload ->> 'plan_id' IS DISTINCT FROM p_plan_id::TEXT
       OR v_action.payload ->> 'paypal_subscription_id'
            IS DISTINCT FROM p_paypal_subscription_id
       OR pg_catalog.jsonb_typeof(v_action.payload -> 'amount_cents')
            IS DISTINCT FROM 'number'
       OR (v_action.payload ->> 'amount_cents')::NUMERIC
            IS DISTINCT FROM v_order.amount_cents::NUMERIC
       OR v_action.payload ->> 'currency' IS DISTINCT FROM v_order.currency
       OR v_action.payload ->> 'entitlement_type'
            IS DISTINCT FROM 'subscription'
       OR v_action.payload ->> 'webhook_event_id'
            IS DISTINCT FROM p_webhook_event_id
       OR v_action.payload ->> 'provider_event_type'
            IS DISTINCT FROM v_event.provider_event_type
       OR (v_action.payload ->> 'provider_occurred_at')::TIMESTAMPTZ
            IS DISTINCT FROM v_event.provider_occurred_at
       OR (
         CASE
           WHEN v_action.payload ->> 'provider_paid_through_at' IS NULL
             THEN NULL
           ELSE (v_action.payload ->> 'provider_paid_through_at')::TIMESTAMPTZ
         END
       ) IS DISTINCT FROM v_event.provider_paid_through_at
       OR pg_catalog.jsonb_typeof(
            v_action.payload -> 'lifecycle_generation'
          ) IS DISTINCT FROM 'number'
       OR (v_action.payload ->> 'lifecycle_generation')::BIGINT
            IS DISTINCT FROM v_event.generation
       OR v_action.payload ->> 'discord_id' IS NULL
       OR pg_catalog.btrim(v_action.payload ->> 'discord_id') = ''
       OR v_action.payload ->> 'product_name' IS NULL
       OR pg_catalog.btrim(v_action.payload ->> 'product_name') = ''
       OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
         v_action.payload -> 'granted_role_ids',
         '{}'::TEXT[]
       )
       OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
         v_action.payload -> 'granted_channel_ids',
         '{}'::TEXT[]
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'subscription lifecycle action replay identity mismatch';
    END IF;
    v_disposition := CASE
      WHEN v_action.status IN ('pending', 'processing', 'completed')
        THEN 'replay'
      ELSE 'operator_held'
    END;
  ELSE
    IF v_carrier_discord_id IS DISTINCT FROM p_discord_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'subscription lifecycle action historical delivery identity mismatch';
    END IF;
    INSERT INTO public.bot_action_queue (
      guild_id,
      action,
      payload,
      status,
      idempotency_key,
      next_retry_at
    ) VALUES (
      p_guild_id,
      v_action_name,
      v_payload,
      'pending',
      v_idempotency_key,
      v_next_retry_at
    )
    RETURNING * INTO v_action;
    v_disposition := 'created';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'disposition', v_disposition,
    'action_id', v_action.id,
    'action', v_action.action,
    'action_status', v_action.status,
    'idempotency_key', v_action.idempotency_key,
    'webhook_event_id', p_webhook_event_id,
    'provider_event_type', v_event.provider_event_type,
    'provider_occurred_at', v_event.provider_occurred_at,
    'provider_paid_through_at', v_event.provider_paid_through_at,
    'lifecycle_generation', v_event.generation,
    'current_authority', true,
    'next_retry_at', v_action.next_retry_at,
    'fulfillment_type', p_fulfillment_type,
    'guild_id', p_guild_id,
    'customer_id', p_customer_id,
    'discord_id', v_action.payload ->> 'discord_id',
    'product_id', p_product_id,
    'product_name', v_action.payload ->> 'product_name',
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'plan_id', p_plan_id,
    'paypal_subscription_id', p_paypal_subscription_id,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_create_or_recover_subscription_lifecycle_action(
  TEXT, TEXT, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_or_recover_subscription_lifecycle_action(
  TEXT, TEXT, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT
) TO service_role;

-- Rotation and the only at-rest copy of the successor plaintext are one
-- transaction.  The old hash-only primitive is owner-private so no caller can
-- commit a rotation without also staging its exact receipt carrier.
DO $rename_license_rotation$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.license_rotate_key_without_receipt_stage(uuid,text,text,text,text)'
     ) IS NULL
     AND pg_catalog.to_regprocedure(
       'public.license_rotate_key(uuid,text,text,text,text)'
     ) IS NOT NULL THEN
    ALTER FUNCTION public.license_rotate_key(
      UUID, TEXT, TEXT, TEXT, TEXT
    ) RENAME TO license_rotate_key_without_receipt_stage;
  END IF;
END;
$rename_license_rotation$;

REVOKE ALL ON FUNCTION public.license_rotate_key_without_receipt_stage(
  UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_partial_license_rotation$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.license_rotate_key(uuid,text,text,text,text)'
     ) IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.license_rotate_key('
      || 'UUID, TEXT, TEXT, TEXT, TEXT'
      || ') FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END;
$revoke_partial_license_rotation$;

CREATE OR REPLACE FUNCTION public.commerce_rotate_license_and_stage_receipt(
  p_license_key_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_order_id UUID,
  p_discord_id TEXT,
  p_new_key_plaintext TEXT,
  p_new_key_prefix TEXT,
  p_new_key_suffix TEXT,
  p_actor_discord_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old public.license_keys%ROWTYPE;
  v_new public.license_keys%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_rotation JSONB;
  v_action public.bot_action_queue%ROWTYPE;
  v_alert public.alerts%ROWTYPE;
  v_new_hash TEXT;
  v_idempotency_key TEXT;
BEGIN
  IF p_license_key_id IS NULL
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_order_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_discord_id IS NULL
     OR p_discord_id = ''
     OR p_discord_id <> pg_catalog.btrim(p_discord_id)
     OR p_new_key_plaintext IS NULL
     OR p_new_key_plaintext = ''
     OR p_new_key_plaintext <> pg_catalog.btrim(p_new_key_plaintext)
     OR p_new_key_prefix IS NULL
     OR p_new_key_prefix = ''
     OR p_new_key_prefix <> pg_catalog.btrim(p_new_key_prefix)
     OR p_new_key_suffix IS NULL
     OR p_new_key_suffix = ''
     OR p_new_key_suffix <> pg_catalog.btrim(p_new_key_suffix)
     OR pg_catalog.left(
          p_new_key_plaintext,
          pg_catalog.length(p_new_key_prefix)
        ) IS DISTINCT FROM p_new_key_prefix
     OR pg_catalog.right(
          p_new_key_plaintext,
          pg_catalog.length(p_new_key_suffix)
        ) IS DISTINCT FROM p_new_key_suffix
     OR (
       p_actor_discord_id IS NOT NULL
       AND p_actor_discord_id IS DISTINCT FROM p_discord_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_rotate_license_and_stage_receipt: exact rotation identity is required';
  END IF;

  SELECT license_key.*
    INTO v_old
    FROM public.license_keys AS license_key
   WHERE license_key.id = p_license_key_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_old.guild_id IS DISTINCT FROM p_guild_id
     OR v_old.customer_id IS DISTINCT FROM p_customer_id
     OR v_old.product_id IS DISTINCT FROM p_product_id
     OR v_old.order_id IS DISTINCT FROM p_order_id
     OR v_old.bound_discord_id IS DISTINCT FROM p_discord_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_rotate_license_and_stage_receipt: predecessor identity mismatch';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
     AND paid_order.product_id = p_product_id
     AND paid_order.status IN ('completed', 'pending_review')
     AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
     AND paid_order.delivery_type_snapshot = 'license_key'
   FOR UPDATE;
  IF NOT FOUND
     OR v_order.currency IS NULL
     OR pg_catalog.upper(v_order.currency) !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_rotate_license_and_stage_receipt: paid order identity mismatch';
  END IF;
  IF v_order.currency IS DISTINCT FROM pg_catalog.upper(v_order.currency) THEN
    UPDATE public.orders AS paid_order
       SET currency = pg_catalog.upper(paid_order.currency),
           updated_at = pg_catalog.clock_timestamp()
     WHERE paid_order.id = p_order_id
       AND paid_order.currency = v_order.currency
    RETURNING paid_order.* INTO v_order;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_rotate_license_and_stage_receipt: currency normalization raced';
    END IF;
  END IF;

  v_idempotency_key :=
    'license-rotation:' || p_license_key_id::TEXT || ':deliver-receipt';
  IF v_old.status = 'revoked'
     AND v_old.revocation_reason = 'rotated'
     AND v_old.rotated_to_key_id IS NOT NULL THEN
    SELECT successor.*
      INTO v_new
      FROM public.license_keys AS successor
     WHERE successor.id = v_old.rotated_to_key_id
       AND successor.order_id = p_order_id
       AND successor.customer_id = p_customer_id
       AND successor.product_id = p_product_id
       AND successor.guild_id = p_guild_id
       AND successor.bound_discord_id = p_discord_id
       AND successor.status IN ('pending_activation', 'active', 'suspended')
     FOR KEY SHARE;
    SELECT queue.*
      INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.idempotency_key = v_idempotency_key
       AND queue.guild_id = p_guild_id
       AND queue.action = 'deliver_receipt'
       AND queue.lane = 'commerce'
       AND queue.status IN ('pending', 'processing', 'completed', 'failed')
       AND queue.payload ->> 'guild_id' = p_guild_id
       AND queue.payload ->> 'customer_id' = p_customer_id::TEXT
       AND queue.payload ->> 'discord_id' = p_discord_id
       AND queue.payload ->> 'product_id' = p_product_id::TEXT
       AND queue.payload ->> 'order_id' = p_order_id::TEXT
       AND queue.payload ->> 'license_key_id' = v_new.id::TEXT
       AND queue.payload ->> 'order_number' = v_order.order_number
       AND pg_catalog.jsonb_typeof(queue.payload -> 'amount_cents') = 'number'
       AND (queue.payload ->> 'amount_cents')::NUMERIC
            = v_order.amount_cents::NUMERIC
       AND pg_catalog.upper(queue.payload ->> 'currency') = v_order.currency
       AND queue.payload ->> 'product_name' IS NOT NULL
       AND pg_catalog.btrim(queue.payload ->> 'product_name') <> ''
       AND queue.payload ->> 'license_key_plaintext' IS NOT NULL
       AND pg_catalog.encode(
         extensions.digest(
           queue.payload ->> 'license_key_plaintext',
           'sha256'
         ),
         'hex'
       ) = v_new.key_hash
     FOR SHARE;
    IF v_new.id IS NULL OR v_action.id IS NULL THEN
      INSERT INTO public.alerts (
        guild_id,
        alert_type,
        severity,
        title,
        message,
        metadata
      ) VALUES (
        p_guild_id,
        'commerce_license_rotation_delivery_held',
        'critical',
        'Rotated licence key has no recoverable delivery',
        'The old key was revoked, but the exact replacement-key receipt '
          || 'carrier is missing or invalid. Restore the carrier from secure '
          || 'evidence or issue a new operator-controlled replacement.',
        pg_catalog.jsonb_build_object(
          'old_key_id', v_old.id,
          'new_key_id', v_old.rotated_to_key_id,
          'order_id', p_order_id,
          'customer_id', p_customer_id,
          'product_id', p_product_id,
          'required_action',
            'restore_secure_receipt_carrier_or_issue_operator_replacement'
        )
      )
      ON CONFLICT DO NOTHING
      RETURNING * INTO v_alert;
      IF NOT FOUND THEN
        SELECT alert.*
          INTO v_alert
          FROM public.alerts AS alert
         WHERE alert.guild_id = p_guild_id
           AND alert.alert_type = 'commerce_license_rotation_delivery_held'
           AND alert.metadata ->> 'old_key_id' = v_old.id::TEXT
           AND alert.resolved = false
         FOR UPDATE;
      END IF;
      IF v_alert.id IS NULL
         OR v_alert.severity IS DISTINCT FROM 'critical'
         OR v_alert.metadata ->> 'new_key_id'
              IS DISTINCT FROM v_old.rotated_to_key_id::TEXT THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'commerce_rotate_license_and_stage_receipt: held delivery alert was not persisted';
      END IF;
      RETURN pg_catalog.jsonb_build_object(
        'status', 'held',
        'old_key_id', v_old.id,
        'new_key_id', v_old.rotated_to_key_id,
        'reason', 'rotation_receipt_carrier_missing',
        'alert_id', v_alert.id
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_rotated',
      'delivery', 'queued',
      'old_key_id', v_old.id,
      'new_key_id', v_new.id,
      'license_key_id', v_new.id,
      'new_key_suffix', v_new.key_suffix,
      'action_id', v_action.id,
      'action_status', v_action.status,
      'guild_id', v_new.guild_id,
      'customer_id', v_new.customer_id,
      'product_id', v_new.product_id,
      'order_id', v_new.order_id,
      'discord_id', v_new.bound_discord_id,
      'order_number', v_action.payload ->> 'order_number',
      'product_name', v_action.payload ->> 'product_name',
      'amount_cents', (v_action.payload ->> 'amount_cents')::INTEGER,
      'currency', v_order.currency
    );
  END IF;
  IF v_old.status NOT IN ('pending_activation', 'active', 'suspended') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_rotatable',
      'key_status', v_old.status
    );
  END IF;

  SELECT product.*
    INTO v_product
    FROM public.products AS product
   WHERE product.id = p_product_id
     AND product.guild_id = p_guild_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_rotate_license_and_stage_receipt: product identity mismatch';
  END IF;

  v_new_hash := pg_catalog.encode(
    extensions.digest(p_new_key_plaintext, 'sha256'),
    'hex'
  );
  v_rotation := public.license_rotate_key_without_receipt_stage(
    p_license_key_id,
    v_new_hash,
    p_new_key_prefix,
    p_new_key_suffix,
    p_actor_discord_id
  );
  IF v_rotation ->> 'status' IS DISTINCT FROM 'rotated'
     OR v_rotation ->> 'old_key_id' IS DISTINCT FROM p_license_key_id::TEXT
     OR v_rotation ->> 'new_key_id' IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_rotate_license_and_stage_receipt: rotation transition failed';
  END IF;

  SELECT successor.*
    INTO v_new
    FROM public.license_keys AS successor
   WHERE successor.id = (v_rotation ->> 'new_key_id')::UUID
     AND successor.order_id = p_order_id
     AND successor.customer_id = p_customer_id
     AND successor.product_id = p_product_id
     AND successor.guild_id = p_guild_id
     AND successor.bound_discord_id = p_discord_id
     AND successor.status IN ('pending_activation', 'active', 'suspended')
     AND successor.key_hash = v_new_hash
     AND successor.key_prefix = p_new_key_prefix
     AND successor.key_suffix = p_new_key_suffix
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_rotate_license_and_stage_receipt: successor identity mismatch';
  END IF;

  INSERT INTO public.bot_action_queue (
    guild_id,
    action,
    payload,
    status,
    idempotency_key
  ) VALUES (
    p_guild_id,
    'deliver_receipt',
    pg_catalog.jsonb_build_object(
      'guild_id', p_guild_id,
      'customer_id', p_customer_id,
      'discord_id', p_discord_id,
      'product_id', p_product_id,
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'product_name', v_product.name,
      'amount_cents', v_order.amount_cents,
      'currency', v_order.currency,
      'license_key_id', v_new.id,
      'license_key_plaintext', p_new_key_plaintext,
      'order_date', v_order.created_at
    ),
    'pending',
    v_idempotency_key
  )
  RETURNING * INTO v_action;
  IF v_action.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_rotate_license_and_stage_receipt: receipt carrier was not staged';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'rotated',
    'delivery', 'queued',
    'old_key_id', v_old.id,
    'new_key_id', v_new.id,
    'license_key_id', v_new.id,
    'new_key_suffix', v_new.key_suffix,
    'action_id', v_action.id,
    'action_status', v_action.status,
    'guild_id', v_new.guild_id,
    'customer_id', v_new.customer_id,
    'product_id', v_new.product_id,
    'order_id', v_new.order_id,
    'discord_id', v_new.bound_discord_id,
    'order_number', v_order.order_number,
    'product_name', v_product.name,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_rotate_license_and_stage_receipt(
  UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_rotate_license_and_stage_receipt(
  UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

-- Webhook subscription reconciliation is an exact owner-rights transition.
-- service_role cannot rewrite provider-payable rows directly; these two RPCs
-- validate the immutable subscription identity before changing price/status.
CREATE OR REPLACE FUNCTION public.commerce_complete_pending_subscription_order(
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_plan_id UUID,
  p_paypal_subscription_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_disposition TEXT;
BEGIN
  IF p_order_id IS NULL
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_plan_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_paypal_subscription_id IS NULL
     OR p_paypal_subscription_id = ''
     OR p_paypal_subscription_id <> pg_catalog.btrim(p_paypal_subscription_id)
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_complete_pending_subscription_order: exact subscription identity is required';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR v_order.customer_id IS DISTINCT FROM p_customer_id
     OR v_order.product_id IS DISTINCT FROM p_product_id
     OR v_order.plan_id IS DISTINCT FROM p_plan_id
     OR v_order.paypal_subscription_id IS DISTINCT FROM p_paypal_subscription_id
     OR v_order.paypal_order_id IS NOT NULL
     OR v_order.amount_cents IS DISTINCT FROM p_amount_cents
     OR v_order.currency IS DISTINCT FROM p_currency
     OR NOT COALESCE(
       v_order.source = 'purchase' OR v_order.source IS NULL,
       false
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_complete_pending_subscription_order: durable order identity mismatch';
  END IF;

  IF v_order.status = 'completed' THEN
    v_disposition := 'replay';
  ELSIF v_order.status = 'pending' THEN
    UPDATE public.orders AS paid_order
       SET status = 'completed',
           updated_at = pg_catalog.clock_timestamp()
     WHERE paid_order.id = v_order.id
       AND paid_order.status = 'pending'
    RETURNING paid_order.* INTO v_order;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_complete_pending_subscription_order: pending transition raced';
    END IF;
    v_disposition := 'completed';
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_complete_pending_subscription_order: order is not pending';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_order.id,
    'status', v_order.status,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency,
    'disposition', v_disposition
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_complete_pending_subscription_order(
  UUID, TEXT, UUID, UUID, UUID, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_complete_pending_subscription_order(
  UUID, TEXT, UUID, UUID, UUID, TEXT, INTEGER, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_assert_staged_subscription_order_authority(
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_plan_id UUID,
  p_paypal_subscription_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_plan public.plans%ROWTYPE;
  v_queue public.bot_action_queue%ROWTYPE;
  v_claim public.commerce_fulfillment_claims%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_guild_id || E'\x1f'
        || p_customer_id::TEXT || E'\x1f'
        || p_product_id::TEXT,
      0
    )
  );
  SELECT customer.*
    INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = p_customer_id
     AND customer.guild_id = p_guild_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'subscription order authority: customer identity mismatch';
  END IF;
  SELECT product.*
    INTO v_product
    FROM public.products AS product
   WHERE product.id = p_product_id
     AND product.guild_id = p_guild_id
     AND product.type = 'subscription'
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'subscription order authority: product identity mismatch';
  END IF;
  SELECT plan.*
    INTO v_plan
    FROM public.plans AS plan
   WHERE plan.id = p_plan_id
     AND plan.product_id = p_product_id
     AND plan.guild_id = p_guild_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'subscription order authority: plan identity mismatch';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR v_order.customer_id IS DISTINCT FROM p_customer_id
     OR v_order.product_id IS DISTINCT FROM p_product_id
     OR v_order.plan_id IS DISTINCT FROM p_plan_id
     OR v_order.paypal_subscription_id IS DISTINCT FROM p_paypal_subscription_id
     OR v_order.paypal_order_id IS NOT NULL
     OR v_order.status NOT IN ('pending', 'completed')
     OR NOT COALESCE(
       v_order.source = 'purchase' OR v_order.source IS NULL,
       false
     )
     OR v_order.grant_snapshot_frozen_at IS NULL
     OR v_order.delivery_type_snapshot IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'subscription order authority: frozen order identity mismatch';
  END IF;

  SELECT claim.*
    INTO v_claim
    FROM public.commerce_fulfillment_claims AS claim
   WHERE claim.guild_id = p_guild_id
     AND claim.customer_id = p_customer_id
     AND claim.product_id = p_product_id
     AND claim.order_id = p_order_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'subscription order authority: exact paid fulfillment claim is missing';
  END IF;

  SELECT queue.*
    INTO v_queue
    FROM public.bot_action_queue AS queue
   WHERE queue.idempotency_key = (
     'paypal:subscription:' || p_paypal_subscription_id || ':fulfill_subscription'
   )
     AND queue.guild_id = p_guild_id
     AND queue.action = 'fulfill_subscription'
     AND queue.lane = 'commerce'
   FOR SHARE;
  IF NOT FOUND
     OR (
       v_order.status = 'pending'
       AND v_queue.status IS DISTINCT FROM 'staged'
     )
     OR (
       v_order.status = 'completed'
       AND v_queue.status NOT IN ('staged', 'pending', 'processing', 'completed')
     )
     OR pg_catalog.jsonb_typeof(v_queue.payload) IS DISTINCT FROM 'object'
     OR v_queue.payload ->> 'fulfillment_type'
          IS DISTINCT FROM 'subscription_activated'
     OR v_queue.payload ->> 'entitlement_type'
          IS DISTINCT FROM 'subscription'
     OR v_queue.payload ->> 'guild_id' IS DISTINCT FROM p_guild_id
     OR v_queue.payload ->> 'customer_id' IS DISTINCT FROM p_customer_id::TEXT
     OR v_queue.payload ->> 'discord_id' IS DISTINCT FROM v_customer.discord_id
     OR v_queue.payload ->> 'product_id' IS DISTINCT FROM p_product_id::TEXT
     OR v_queue.payload ->> 'product_name' IS DISTINCT FROM v_product.name
     OR v_queue.payload ->> 'order_id' IS DISTINCT FROM p_order_id::TEXT
     OR v_queue.payload ->> 'order_number' IS DISTINCT FROM v_order.order_number
     OR v_queue.payload ->> 'plan_id' IS DISTINCT FROM p_plan_id::TEXT
     OR v_queue.payload ->> 'paypal_subscription_id'
          IS DISTINCT FROM p_paypal_subscription_id
     OR v_queue.payload ->> 'paypal_plan_id'
          IS DISTINCT FROM v_plan.paypal_plan_id
     OR pg_catalog.jsonb_typeof(v_queue.payload -> 'amount_cents')
          IS DISTINCT FROM 'number'
     OR (v_queue.payload ->> 'amount_cents')::NUMERIC
          IS DISTINCT FROM p_amount_cents::NUMERIC
     OR v_queue.payload ->> 'currency' IS DISTINCT FROM p_currency
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_queue.payload -> 'granted_role_ids',
       COALESCE(v_order.granted_role_ids_snapshot, '{}'::TEXT[])
     )
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_queue.payload -> 'granted_channel_ids',
       COALESCE(v_order.granted_channel_ids_snapshot, '{}'::TEXT[])
     )
     OR COALESCE(
       v_queue.payload -> 'temporary_role_grants',
       '[]'::JSONB
     ) <> COALESCE(v_order.temporary_role_grants_snapshot, '[]'::JSONB)
     OR (
       v_order.delivery_type_snapshot = 'license_key'
       AND (
         v_queue.payload ->> 'license_key_id' IS NULL
         OR pg_catalog.btrim(v_queue.payload ->> 'license_key_id') = ''
         OR v_queue.payload ->> 'license_key_plaintext' IS NULL
         OR pg_catalog.btrim(v_queue.payload ->> 'license_key_plaintext') = ''
       )
     )
     OR (
       v_order.delivery_type_snapshot <> 'license_key'
       AND (
         v_queue.payload ? 'license_key_id'
         OR v_queue.payload ? 'license_key_plaintext'
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'subscription order authority: staged fulfillment contract mismatch';
  END IF;
  RETURN v_queue.id;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_assert_staged_subscription_order_authority(
  UUID, TEXT, UUID, UUID, UUID, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

-- A provider-side subscription price mismatch is never authorization to
-- rewrite local financial history.  This compatibility RPC therefore only
-- holds the exact pending order for review and persists a critical alert.
-- Completion remains a separate staged, claimed transition below.
CREATE OR REPLACE FUNCTION public.commerce_reprice_pending_subscription_order(
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_plan_id UUID,
  p_paypal_subscription_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_alert_id UUID;
  v_message TEXT;
  v_metadata JSONB;
  v_disposition TEXT;
BEGIN
  IF p_order_id IS NULL
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_plan_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_paypal_subscription_id IS NULL
     OR p_paypal_subscription_id = ''
     OR p_paypal_subscription_id <> pg_catalog.btrim(p_paypal_subscription_id)
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_reprice_pending_subscription_order: exact subscription identity is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_guild_id || E'\x1f'
        || p_customer_id::TEXT || E'\x1f'
        || p_product_id::TEXT,
      0
    )
  );

  PERFORM 1
    FROM public.customers AS customer
   WHERE customer.id = p_customer_id
     AND customer.guild_id = p_guild_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_reprice_pending_subscription_order: customer identity mismatch';
  END IF;

  PERFORM 1
    FROM public.products AS product
   WHERE product.id = p_product_id
     AND product.guild_id = p_guild_id
     AND product.type = 'subscription'
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_reprice_pending_subscription_order: product identity mismatch';
  END IF;

  PERFORM 1
    FROM public.plans AS plan
   WHERE plan.id = p_plan_id
     AND plan.product_id = p_product_id
     AND plan.guild_id = p_guild_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_reprice_pending_subscription_order: plan identity mismatch';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR v_order.customer_id IS DISTINCT FROM p_customer_id
     OR v_order.product_id IS DISTINCT FROM p_product_id
     OR v_order.plan_id IS DISTINCT FROM p_plan_id
     OR v_order.paypal_subscription_id IS DISTINCT FROM p_paypal_subscription_id
     OR v_order.paypal_order_id IS NOT NULL
     OR v_order.status NOT IN ('pending', 'pending_review')
     OR NOT COALESCE(
       v_order.source = 'purchase' OR v_order.source IS NULL,
       false
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_reprice_pending_subscription_order: durable order identity mismatch';
  END IF;

  IF v_order.amount_cents IS NOT DISTINCT FROM p_amount_cents
     AND v_order.currency IS NOT DISTINCT FROM p_currency THEN
    v_disposition := CASE v_order.status
      WHEN 'pending' THEN 'unchanged'
      ELSE 'held_replay'
    END;
  ELSE
    IF v_order.status = 'pending' THEN
      UPDATE public.orders AS paid_order
         SET status = 'pending_review',
             checkout_active = false,
             updated_at = pg_catalog.clock_timestamp()
       WHERE paid_order.id = p_order_id
         AND paid_order.status = 'pending'
         AND paid_order.amount_cents IS NOT DISTINCT FROM v_order.amount_cents
         AND paid_order.currency IS NOT DISTINCT FROM v_order.currency
      RETURNING paid_order.* INTO v_order;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'commerce_reprice_pending_subscription_order: pending hold raced';
      END IF;
    END IF;

    v_message := 'PayPal reports ' || p_amount_cents::TEXT || ' cents '
      || p_currency || ' for subscription ' || p_paypal_subscription_id
      || ', but pending order ' || v_order.order_number || ' records '
      || v_order.amount_cents::TEXT || ' cents ' || v_order.currency
      || '. The order was held before fulfillment; reconcile the provider '
      || 'contract and exact local order manually.';
    v_metadata := pg_catalog.jsonb_build_object(
      'source', 'paypal_webhook',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'customer_id', v_order.customer_id,
      'product_id', v_order.product_id,
      'plan_id', v_order.plan_id,
      'paypal_subscription_id', v_order.paypal_subscription_id,
      'stored_amount_cents', v_order.amount_cents,
      'stored_currency', v_order.currency,
      'provider_amount_cents', p_amount_cents,
      'provider_currency', p_currency,
      'required_action', 'reconcile_subscription_financial_mismatch'
    );

    UPDATE public.alerts AS alert
       SET severity = 'critical',
           title = 'Subscription financial mismatch held before fulfillment',
           message = v_message,
           metadata = v_metadata,
           updated_at = pg_catalog.clock_timestamp()
     WHERE alert.guild_id = p_guild_id
       AND alert.alert_type = 'commerce_subscription_financial_mismatch'
       AND alert.resolved = false
       AND alert.metadata ->> 'order_id' = p_order_id::TEXT
    RETURNING alert.id INTO v_alert_id;

    IF v_alert_id IS NULL THEN
      INSERT INTO public.alerts (
        guild_id,
        alert_type,
        severity,
        title,
        message,
        metadata
      ) VALUES (
        p_guild_id,
        'commerce_subscription_financial_mismatch',
        'critical',
        'Subscription financial mismatch held before fulfillment',
        v_message,
        v_metadata
      )
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_alert_id;
    END IF;

    IF v_alert_id IS NULL THEN
      SELECT alert.id
        INTO v_alert_id
        FROM public.alerts AS alert
       WHERE alert.guild_id = p_guild_id
         AND alert.alert_type = 'commerce_subscription_financial_mismatch'
         AND alert.resolved = false
         AND alert.metadata ->> 'order_id' = p_order_id::TEXT
       ORDER BY alert.created_at, alert.id
       LIMIT 1;
    END IF;

    IF v_alert_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_reprice_pending_subscription_order: critical alert was not persisted';
    END IF;
    v_disposition := 'held_financial_mismatch';
  END IF;

  IF v_order.status = 'pending' AND v_disposition = 'unchanged' THEN
    NULL;
  ELSIF v_order.status <> 'pending_review' THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_reprice_pending_subscription_order: financial hold did not persist';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_order.id,
    'guild_id', v_order.guild_id,
    'status', v_order.status,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency,
    'disposition', v_disposition,
    'alert_id', v_alert_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_reprice_pending_subscription_order(
  UUID, TEXT, UUID, UUID, UUID, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_reprice_pending_subscription_order(
  UUID, TEXT, UUID, UUID, UUID, TEXT, INTEGER, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_complete_pending_subscription_order(
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_plan_id UUID,
  p_paypal_subscription_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_disposition TEXT;
BEGIN
  IF p_order_id IS NULL
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_plan_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_paypal_subscription_id IS NULL
     OR p_paypal_subscription_id = ''
     OR p_paypal_subscription_id <> pg_catalog.btrim(p_paypal_subscription_id)
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_complete_pending_subscription_order: exact subscription identity is required';
  END IF;
  PERFORM public.commerce_assert_staged_subscription_order_authority(
    p_order_id, p_guild_id, p_customer_id, p_product_id, p_plan_id,
    p_paypal_subscription_id, p_amount_cents, p_currency
  );
  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR UPDATE;
  IF v_order.amount_cents IS DISTINCT FROM p_amount_cents
     OR v_order.currency IS DISTINCT FROM p_currency THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_complete_pending_subscription_order: staged financial identity mismatch';
  END IF;

  IF v_order.status = 'completed' THEN
    v_disposition := 'replay';
  ELSIF v_order.status = 'pending' THEN
    UPDATE public.orders AS paid_order
       SET status = 'completed',
           updated_at = pg_catalog.clock_timestamp()
     WHERE paid_order.id = p_order_id
       AND paid_order.status = 'pending'
    RETURNING paid_order.* INTO v_order;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_reprice_pending_subscription_order: pending transition raced';
    END IF;
    v_disposition := 'completed';
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_complete_pending_subscription_order: order is not pending';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_order.id,
    'guild_id', v_order.guild_id,
    'status', v_order.status,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency,
    'disposition', v_disposition
  );
END;
$$;

-- A worker must reserve each externally visible event/DM before performing it.
-- A surviving `sending` row on retry means the prior process may have reached
-- the external system; retry converts it to `uncertain` and never auto-sends.
CREATE OR REPLACE FUNCTION public.commerce_begin_fulfillment_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_intent public.commerce_fulfillment_outward_intents%ROWTYPE;
  v_attempt_token UUID := pg_catalog.gen_random_uuid();
  v_alert_id UUID;
  v_message TEXT;
  v_metadata JSONB;
BEGIN
  IF p_order_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_intent_kind NOT IN (
       'purchase_completed_event',
       'subscription_activated_event',
       'receipt_dm'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_begin_fulfillment_outward_intent: exact intent identity is required';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR KEY SHARE;

  IF NOT FOUND
     OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR NOT COALESCE((v_order.source = 'purchase' OR v_order.source IS NULL), false)
     OR v_order.status NOT IN ('completed', 'pending_review') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_begin_fulfillment_outward_intent: paid order identity mismatch';
  END IF;

  INSERT INTO public.commerce_fulfillment_outward_intents (
    order_id,
    guild_id,
    intent_kind,
    state,
    attempt_token
  ) VALUES (
    v_order.id,
    v_order.guild_id,
    p_intent_kind,
    'sending',
    v_attempt_token
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_intent;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_intent.order_id,
      'intent_kind', v_intent.intent_kind,
      'disposition', 'send',
      'state', v_intent.state,
      'attempt_token', v_intent.attempt_token,
      'alert_id', NULL
    );
  END IF;

  SELECT intent.*
    INTO v_intent
    FROM public.commerce_fulfillment_outward_intents AS intent
   WHERE intent.order_id = v_order.id
     AND intent.intent_kind = p_intent_kind
   FOR UPDATE;

  IF NOT FOUND OR v_intent.guild_id IS DISTINCT FROM v_order.guild_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_begin_fulfillment_outward_intent: durable intent disappeared';
  END IF;

  IF v_intent.state = 'sent' THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_intent.order_id,
      'intent_kind', v_intent.intent_kind,
      'disposition', 'sent',
      'state', v_intent.state,
      'attempt_token', NULL,
      'alert_id', NULL
    );
  END IF;

  IF v_intent.state = 'sending' THEN
    UPDATE public.commerce_fulfillment_outward_intents AS intent
       SET state = 'uncertain',
           attempt_token = NULL,
           uncertain_at = pg_catalog.clock_timestamp(),
           last_error = 'worker resumed while prior external acceptance was unresolved',
           updated_at = pg_catalog.clock_timestamp()
     WHERE intent.order_id = v_intent.order_id
       AND intent.intent_kind = v_intent.intent_kind
       AND intent.state = 'sending'
    RETURNING intent.* INTO v_intent;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_begin_fulfillment_outward_intent: sending transition raced';
    END IF;
  END IF;

  v_message := 'Paid order ' || v_order.order_number || ' has an uncertain '
    || p_intent_kind || ' delivery. A prior worker may have reached the external '
    || 'system, so automatic resend is blocked. Inspect the exact order and '
    || 'manually reconcile before retrying or refunding.';
  v_metadata := pg_catalog.jsonb_build_object(
    'source', 'commerce_fulfillment_worker',
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'intent_kind', p_intent_kind,
    'required_action', 'manual_reconcile_before_resend_or_refund'
  );

  UPDATE public.alerts AS alert
     SET severity = 'critical',
         title = 'Paid fulfillment delivery may already have been accepted',
         message = v_message,
         metadata = v_metadata,
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.guild_id = v_order.guild_id
     AND alert.alert_type = 'commerce_fulfillment_outward_uncertain'
     AND alert.resolved = false
     AND alert.metadata ->> 'order_id' = v_order.id::TEXT
     AND alert.metadata ->> 'intent_kind' = p_intent_kind
  RETURNING alert.id INTO v_alert_id;

  IF v_alert_id IS NULL THEN
    INSERT INTO public.alerts (
      guild_id, alert_type, severity, title, message, metadata
    ) VALUES (
      v_order.guild_id,
      'commerce_fulfillment_outward_uncertain',
      'critical',
      'Paid fulfillment delivery may already have been accepted',
      v_message,
      v_metadata
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_alert_id;
  END IF;

  IF v_alert_id IS NULL THEN
    SELECT alert.id
      INTO v_alert_id
      FROM public.alerts AS alert
     WHERE alert.guild_id = v_order.guild_id
       AND alert.alert_type = 'commerce_fulfillment_outward_uncertain'
       AND alert.resolved = false
       AND alert.metadata ->> 'order_id' = v_order.id::TEXT
       AND alert.metadata ->> 'intent_kind' = p_intent_kind
     ORDER BY alert.created_at, alert.id
     LIMIT 1;
  END IF;

  IF v_alert_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_begin_fulfillment_outward_intent: uncertain alert was not persisted';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_intent.order_id,
    'intent_kind', v_intent.intent_kind,
    'disposition', 'uncertain',
    'state', v_intent.state,
    'attempt_token', NULL,
    'alert_id', v_alert_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_begin_fulfillment_outward_intent(
  UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_begin_fulfillment_outward_intent(
  UUID, TEXT, TEXT
) TO service_role;

-- A confirmed role-delivery replay must not create a fresh outward intent:
-- the action may predate this table and its event/receipt already ran. When a
-- row does exist, it proves the crash-fenced path had started, so lock it and
-- delegate to the normal begin transition (including sending -> uncertain).
CREATE OR REPLACE FUNCTION public.commerce_resume_fulfillment_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_intent public.commerce_fulfillment_outward_intents%ROWTYPE;
BEGIN
  IF p_order_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_intent_kind NOT IN (
       'purchase_completed_event',
       'subscription_activated_event',
       'receipt_dm'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_resume_fulfillment_outward_intent: exact intent identity is required';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR KEY SHARE;

  IF NOT FOUND
     OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR NOT COALESCE((v_order.source = 'purchase' OR v_order.source IS NULL), false)
     OR v_order.status NOT IN ('completed', 'pending_review') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_resume_fulfillment_outward_intent: paid order identity mismatch';
  END IF;

  SELECT intent.*
    INTO v_intent
    FROM public.commerce_fulfillment_outward_intents AS intent
   WHERE intent.order_id = v_order.id
     AND intent.intent_kind = p_intent_kind
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_order.id,
      'intent_kind', p_intent_kind,
      'disposition', 'absent',
      'state', NULL,
      'attempt_token', NULL,
      'alert_id', NULL
    );
  END IF;

  IF v_intent.guild_id IS DISTINCT FROM v_order.guild_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_resume_fulfillment_outward_intent: durable intent identity mismatch';
  END IF;

  RETURN public.commerce_begin_fulfillment_outward_intent(
    v_order.id,
    v_order.guild_id,
    p_intent_kind
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_resume_fulfillment_outward_intent(
  UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_resume_fulfillment_outward_intent(
  UUID, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_finish_fulfillment_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT,
  p_attempt_token UUID,
  p_outcome TEXT,
  p_error TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_intent public.commerce_fulfillment_outward_intents%ROWTYPE;
  v_alert_id UUID;
  v_message TEXT;
  v_metadata JSONB;
BEGIN
  IF p_order_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_intent_kind NOT IN (
       'purchase_completed_event',
       'subscription_activated_event',
       'receipt_dm'
     )
     OR p_attempt_token IS NULL
     OR p_outcome NOT IN ('sent', 'uncertain')
     OR (p_outcome = 'uncertain' AND (p_error IS NULL OR p_error = '')) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_finish_fulfillment_outward_intent: exact outcome identity is required';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_finish_fulfillment_outward_intent: order identity mismatch';
  END IF;

  SELECT intent.*
    INTO v_intent
    FROM public.commerce_fulfillment_outward_intents AS intent
   WHERE intent.order_id = p_order_id
     AND intent.intent_kind = p_intent_kind
   FOR UPDATE;

  IF NOT FOUND OR v_intent.guild_id IS DISTINCT FROM p_guild_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_finish_fulfillment_outward_intent: intent identity mismatch';
  END IF;

  IF v_intent.state = 'sent' THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_intent.order_id,
      'intent_kind', v_intent.intent_kind,
      'state', v_intent.state,
      'alert_id', NULL
    );
  END IF;

  IF v_intent.state = 'uncertain' THEN
    SELECT alert.id
      INTO v_alert_id
      FROM public.alerts AS alert
     WHERE alert.guild_id = p_guild_id
       AND alert.alert_type = 'commerce_fulfillment_outward_uncertain'
       AND alert.resolved = false
       AND alert.metadata ->> 'order_id' = p_order_id::TEXT
       AND alert.metadata ->> 'intent_kind' = p_intent_kind
     ORDER BY alert.created_at, alert.id
     LIMIT 1;

    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_intent.order_id,
      'intent_kind', v_intent.intent_kind,
      'state', v_intent.state,
      'alert_id', v_alert_id
    );
  END IF;

  IF v_intent.state IS DISTINCT FROM 'sending'
     OR v_intent.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_finish_fulfillment_outward_intent: attempt token mismatch';
  END IF;

  UPDATE public.commerce_fulfillment_outward_intents AS intent
     SET state = p_outcome,
         attempt_token = NULL,
         sent_at = CASE WHEN p_outcome = 'sent'
           THEN pg_catalog.clock_timestamp()
           ELSE NULL
         END,
         uncertain_at = CASE WHEN p_outcome = 'uncertain'
           THEN pg_catalog.clock_timestamp()
           ELSE NULL
         END,
         last_error = CASE WHEN p_outcome = 'uncertain'
           THEN pg_catalog.left(p_error, 1000)
           ELSE NULL
         END,
         updated_at = pg_catalog.clock_timestamp()
   WHERE intent.order_id = p_order_id
     AND intent.intent_kind = p_intent_kind
     AND intent.state = 'sending'
     AND intent.attempt_token = p_attempt_token
  RETURNING intent.* INTO v_intent;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_finish_fulfillment_outward_intent: outcome transition raced';
  END IF;

  IF p_outcome = 'sent' THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_intent.order_id,
      'intent_kind', v_intent.intent_kind,
      'state', v_intent.state,
      'alert_id', NULL
    );
  END IF;

  v_message := 'Paid order ' || v_order.order_number || ' has an uncertain '
    || p_intent_kind || ' delivery. The external call did not provide a durable '
    || 'acceptance result, so automatic resend is blocked. Inspect the exact '
    || 'order and manually reconcile before retrying or refunding.';
  v_metadata := pg_catalog.jsonb_build_object(
    'source', 'commerce_fulfillment_worker',
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'intent_kind', p_intent_kind,
    'required_action', 'manual_reconcile_before_resend_or_refund'
  );

  UPDATE public.alerts AS alert
     SET severity = 'critical',
         title = 'Paid fulfillment delivery may already have been accepted',
         message = v_message,
         metadata = v_metadata,
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.guild_id = v_order.guild_id
     AND alert.alert_type = 'commerce_fulfillment_outward_uncertain'
     AND alert.resolved = false
     AND alert.metadata ->> 'order_id' = v_order.id::TEXT
     AND alert.metadata ->> 'intent_kind' = p_intent_kind
  RETURNING alert.id INTO v_alert_id;

  IF v_alert_id IS NULL THEN
    INSERT INTO public.alerts (
      guild_id, alert_type, severity, title, message, metadata
    ) VALUES (
      v_order.guild_id,
      'commerce_fulfillment_outward_uncertain',
      'critical',
      'Paid fulfillment delivery may already have been accepted',
      v_message,
      v_metadata
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_alert_id;
  END IF;

  IF v_alert_id IS NULL THEN
    SELECT alert.id
      INTO v_alert_id
      FROM public.alerts AS alert
     WHERE alert.guild_id = v_order.guild_id
       AND alert.alert_type = 'commerce_fulfillment_outward_uncertain'
       AND alert.resolved = false
       AND alert.metadata ->> 'order_id' = v_order.id::TEXT
       AND alert.metadata ->> 'intent_kind' = p_intent_kind
     ORDER BY alert.created_at, alert.id
     LIMIT 1;
  END IF;

  IF v_alert_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_finish_fulfillment_outward_intent: uncertain alert was not persisted';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_intent.order_id,
    'intent_kind', v_intent.intent_kind,
    'state', v_intent.state,
    'alert_id', v_alert_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_finish_fulfillment_outward_intent(
  UUID, TEXT, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_finish_fulfillment_outward_intent(
  UUID, TEXT, TEXT, UUID, TEXT, TEXT
) TO service_role;

-- Generation-aware outward protocol.  The three-argument definitions above
-- remain as migration-compatible legacy overloads; the current worker always
-- presents the durable lifecycle generation allocated before its first
-- external mutation.
CREATE OR REPLACE FUNCTION public.commerce_record_fulfillment_outward_uncertain(
  p_intent_id UUID,
  p_error TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_fulfillment_outward_intents%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_alert_id UUID;
  v_message TEXT;
  v_metadata JSONB;
BEGIN
  SELECT intent.*
    INTO v_intent
    FROM public.commerce_fulfillment_outward_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  IF NOT FOUND OR v_intent.state IS DISTINCT FROM 'uncertain' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_fulfillment_outward_uncertain: exact uncertain intent is required';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = v_intent.order_id
     AND paid_order.guild_id = v_intent.guild_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_fulfillment_outward_uncertain: paid order identity mismatch';
  END IF;

  v_message := 'Paid order ' || v_order.order_number || ' has an uncertain '
    || v_intent.intent_kind || ' delivery. The external call may already have '
    || 'been accepted, so automatic resend is blocked. Inspect the exact '
    || 'generation and manually reconcile before retrying or refunding.';
  v_metadata := pg_catalog.jsonb_build_object(
    'source', 'commerce_fulfillment_worker',
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'intent_kind', v_intent.intent_kind,
    'outward_generation_id', v_intent.outward_generation_id,
    'last_error', pg_catalog.left(COALESCE(p_error, v_intent.last_error), 1000),
    'required_action', 'manual_reconcile_before_resend_or_refund'
  );

  UPDATE public.alerts AS alert
     SET severity = 'critical',
         title = 'Paid fulfillment delivery may already have been accepted',
         message = v_message,
         metadata = v_metadata,
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.guild_id = v_intent.guild_id
     AND alert.alert_type = 'commerce_fulfillment_outward_uncertain'
     AND alert.resolved = false
     AND alert.metadata ->> 'order_id' = v_intent.order_id::TEXT
     AND alert.metadata ->> 'intent_kind' = v_intent.intent_kind
     AND COALESCE(
           alert.metadata ->> 'outward_generation_id',
           '<legacy>'
         ) = COALESCE(v_intent.outward_generation_id::TEXT, '<legacy>')
  RETURNING alert.id INTO v_alert_id;

  IF v_alert_id IS NULL THEN
    INSERT INTO public.alerts (
      guild_id, alert_type, severity, title, message, metadata
    ) VALUES (
      v_intent.guild_id,
      'commerce_fulfillment_outward_uncertain',
      'critical',
      'Paid fulfillment delivery may already have been accepted',
      v_message,
      v_metadata
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_alert_id;
  END IF;

  IF v_alert_id IS NULL THEN
    SELECT alert.id
      INTO v_alert_id
      FROM public.alerts AS alert
     WHERE alert.guild_id = v_intent.guild_id
       AND alert.alert_type = 'commerce_fulfillment_outward_uncertain'
       AND alert.resolved = false
       AND alert.metadata ->> 'order_id' = v_intent.order_id::TEXT
       AND alert.metadata ->> 'intent_kind' = v_intent.intent_kind
       AND COALESCE(
             alert.metadata ->> 'outward_generation_id',
             '<legacy>'
           ) = COALESCE(v_intent.outward_generation_id::TEXT, '<legacy>')
     ORDER BY alert.created_at, alert.id
     LIMIT 1;
  END IF;

  IF v_alert_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_record_fulfillment_outward_uncertain: alert was not persisted';
  END IF;
  RETURN v_alert_id;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_record_fulfillment_outward_uncertain(
  UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

-- A UUID supplied by service_role is not delivery authority by itself.  Every
-- non-legacy generation must be recoverable from the exact role-delivery or
-- queue action carrier which minted it, and that carrier fixes the allowed
-- outward kinds for the lifecycle episode.
CREATE OR REPLACE FUNCTION public.commerce_assert_outward_generation_authority(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT,
  p_outward_generation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_outward_generation_id IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.commerce_role_delivery_intents AS intent
      JOIN public.bot_action_queue AS queue
        ON queue.id = intent.action_id
     WHERE intent.contract_kind = 'paid'
       AND intent.order_id = p_order_id
       AND intent.guild_id = p_guild_id
       AND intent.outward_generation_id = p_outward_generation_id
       AND intent.delivery_confirmed_at IS NOT NULL
       AND intent.last_delivery_outcome = 'live'
       AND queue.guild_id = intent.guild_id
       AND queue.payload ->> 'order_id' = intent.order_id::TEXT
       AND queue.payload ->> 'guild_id' = intent.guild_id
       AND (
         (
           p_intent_kind = 'purchase_completed_event'
           AND queue.action = 'fulfill_purchase'
           AND queue.payload ->> 'fulfillment_type' = 'one_time_purchase'
         )
         OR (
           p_intent_kind = 'subscription_activated_event'
           AND queue.action = 'fulfill_subscription'
           AND queue.payload ->> 'fulfillment_type' = 'subscription_activated'
         )
         OR (
           p_intent_kind = 'subscription_renewed_event'
           AND queue.action = 'fulfill_subscription'
           AND queue.payload ->> 'fulfillment_type' = 'subscription_renewed'
         )
         OR (
           p_intent_kind = 'receipt_dm'
           AND (
             (
               queue.action = 'fulfill_purchase'
               AND queue.payload ->> 'fulfillment_type' = 'one_time_purchase'
             )
             OR (
               queue.action = 'fulfill_subscription'
               AND queue.payload ->> 'fulfillment_type' = 'subscription_activated'
             )
           )
         )
       )
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
     FROM public.bot_action_queue AS queue
     WHERE queue.outward_generation_id = p_outward_generation_id
       AND queue.guild_id = p_guild_id
       AND queue.lane = 'commerce'
       AND pg_catalog.jsonb_typeof(queue.payload) = 'object'
       AND queue.payload ->> 'guild_id' = p_guild_id
       AND queue.payload ->> 'order_id' = p_order_id::TEXT
       AND (
         (
           queue.action = 'fulfill_cancellation'
           AND queue.payload ->> 'fulfillment_type' = 'subscription_cancelled'
           AND p_intent_kind IN (
             'subscription_cancelled_event',
             'subscription_cancelled_dm'
           )
         )
          OR (
            queue.action = 'fulfill_suspension'
            AND queue.payload ->> 'fulfillment_type' = 'subscription_suspended'
            AND p_intent_kind IN (
              'subscription_suspended_event',
              'subscription_suspended_dm'
            )
          )
          OR (
            queue.action = 'fulfill_suspension'
            AND queue.payload ->> 'fulfillment_type' = 'subscription_payment_failed'
            AND p_intent_kind IN (
              'subscription_payment_failed_lapsed_event',
              'subscription_payment_failed_event',
              'subscription_payment_failed_dm'
            )
          )
         OR (
           queue.action = 'deliver_receipt'
           AND p_intent_kind = 'receipt_dm'
         )
       )
  ) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '42501',
    MESSAGE = 'commerce outward generation is not authorized for this order and kind';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_assert_outward_generation_authority(
  UUID, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_assert_outward_action_authority(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT,
  p_outward_generation_id UUID,
  p_action_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_outward_generation_id IS NULL OR p_action_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'commerce outward creation requires an exact carrier action';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.commerce_role_delivery_intents AS intent
      JOIN public.bot_action_queue AS queue
        ON queue.id = intent.action_id
     WHERE intent.action_id = p_action_id
       AND intent.contract_kind = 'paid'
       AND intent.order_id = p_order_id
       AND intent.guild_id = p_guild_id
       AND intent.outward_generation_id = p_outward_generation_id
       AND intent.delivery_confirmed_at IS NOT NULL
       AND intent.last_delivery_outcome = 'live'
       AND queue.guild_id = intent.guild_id
       AND queue.payload ->> 'order_id' = intent.order_id::TEXT
       AND queue.payload ->> 'guild_id' = intent.guild_id
       AND (
         (
           p_intent_kind = 'purchase_completed_event'
           AND queue.action = 'fulfill_purchase'
           AND queue.payload ->> 'fulfillment_type' = 'one_time_purchase'
         )
         OR (
           p_intent_kind = 'subscription_activated_event'
           AND queue.action = 'fulfill_subscription'
           AND queue.payload ->> 'fulfillment_type' = 'subscription_activated'
         )
         OR (
           p_intent_kind = 'subscription_renewed_event'
           AND queue.action = 'fulfill_subscription'
           AND queue.payload ->> 'fulfillment_type' = 'subscription_renewed'
         )
         OR (
           p_intent_kind = 'receipt_dm'
           AND (
             (
               queue.action = 'fulfill_purchase'
               AND queue.payload ->> 'fulfillment_type' = 'one_time_purchase'
             )
             OR (
               queue.action = 'fulfill_subscription'
               AND queue.payload ->> 'fulfillment_type' = 'subscription_activated'
             )
           )
         )
       )
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.bot_action_queue AS queue
     WHERE queue.id = p_action_id
       AND queue.outward_generation_id = p_outward_generation_id
       AND queue.guild_id = p_guild_id
       AND queue.lane = 'commerce'
       AND pg_catalog.jsonb_typeof(queue.payload) = 'object'
       AND queue.payload ->> 'guild_id' = p_guild_id
       AND queue.payload ->> 'order_id' = p_order_id::TEXT
       AND (
         (
           queue.action = 'fulfill_cancellation'
           AND queue.payload ->> 'fulfillment_type' = 'subscription_cancelled'
           AND p_intent_kind IN (
             'subscription_cancelled_event',
             'subscription_cancelled_dm'
           )
         )
          OR (
            queue.action = 'fulfill_suspension'
            AND queue.payload ->> 'fulfillment_type' = 'subscription_suspended'
            AND p_intent_kind IN (
              'subscription_suspended_event',
              'subscription_suspended_dm'
            )
          )
          OR (
            queue.action = 'fulfill_suspension'
            AND queue.payload ->> 'fulfillment_type' = 'subscription_payment_failed'
            AND p_intent_kind IN (
              'subscription_payment_failed_lapsed_event',
              'subscription_payment_failed_event',
              'subscription_payment_failed_dm'
            )
          )
         OR (
           queue.action = 'deliver_receipt'
           AND p_intent_kind = 'receipt_dm'
         )
       )
  ) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '42501',
    MESSAGE = 'commerce outward action is not authorized for this generation and kind';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_assert_outward_action_authority(
  UUID, TEXT, TEXT, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

-- Terminal subscription cancellation supersedes only outward effects that
-- have not begun. Taking a share lock on the exact entitlement serializes this
-- decision with cancellation's entitlement transition: a begin that saw the
-- pre-cancel state remains authorized, while every later begin sees cancelled.
CREATE OR REPLACE FUNCTION public.commerce_classify_lifecycle_outward_authority(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT,
  p_outward_generation_id UUID,
  p_action_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_entitlement public.entitlements%ROWTYPE;
  v_role_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
BEGIN
  IF p_intent_kind NOT IN (
    'subscription_renewed_event',
    'subscription_payment_failed_lapsed_event',
    'subscription_payment_failed_event',
    'subscription_payment_failed_dm',
    'subscription_suspended_event',
    'subscription_suspended_dm'
  ) THEN
    RETURN 'send';
  END IF;

  IF p_intent_kind = 'subscription_renewed_event' THEN
    SELECT intent.*
      INTO v_role_intent
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.action_id = p_action_id
       AND intent.order_id = p_order_id
       AND intent.guild_id = p_guild_id
       AND intent.outward_generation_id = p_outward_generation_id
       AND intent.contract_kind = 'paid'
       AND intent.delivery_confirmed_at IS NOT NULL
       AND intent.last_delivery_outcome = 'live'
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'renewal outward authority lost its exact role-delivery carrier';
    END IF;

    SELECT entitlement.*
      INTO v_entitlement
      FROM public.entitlements AS entitlement
     WHERE entitlement.id = v_role_intent.entitlement_id
       AND entitlement.order_id = p_order_id
       AND entitlement.guild_id = p_guild_id
       AND entitlement.customer_id = v_role_intent.customer_id
       AND entitlement.product_id = v_role_intent.product_id
       AND entitlement.plan_id = v_role_intent.plan_id
       AND entitlement.type = 'subscription'
       AND (
         entitlement.source = 'purchase'
         OR entitlement.source IS NULL
       )
     FOR SHARE;
  ELSE
    SELECT queue.*
      INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.id = p_action_id
       AND queue.outward_generation_id = p_outward_generation_id
       AND queue.guild_id = p_guild_id
       AND queue.action = 'fulfill_suspension'
       AND queue.lane = 'commerce'
       AND queue.payload ->> 'fulfillment_type' IN (
         'subscription_suspended',
         'subscription_payment_failed'
       )
       AND queue.payload ->> 'order_id' = p_order_id::TEXT
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'suspension outward authority lost its exact action carrier';
    END IF;

    SELECT entitlement.*
      INTO v_entitlement
      FROM public.entitlements AS entitlement
     WHERE entitlement.order_id = p_order_id
       AND entitlement.guild_id = p_guild_id
       AND v_action.payload ->> 'customer_id' = entitlement.customer_id::TEXT
       AND v_action.payload ->> 'product_id' = entitlement.product_id::TEXT
       AND v_action.payload ->> 'plan_id' = entitlement.plan_id::TEXT
       AND entitlement.type = 'subscription'
       AND (
         entitlement.source = 'purchase'
         OR entitlement.source IS NULL
       )
     ORDER BY entitlement.created_at, entitlement.id
     LIMIT 1
     FOR SHARE;
  END IF;

  IF v_entitlement.id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lifecycle outward authority lost its exact entitlement';
  END IF;
  IF v_entitlement.status = 'cancelled'
     OR (
       v_action.payload ->> 'fulfillment_type' = 'subscription_payment_failed'
       AND v_entitlement.status = 'suspended'
     ) THEN
    RETURN 'superseded';
  END IF;
  RETURN 'send';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_classify_lifecycle_outward_authority(
  UUID, TEXT, TEXT, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_begin_fulfillment_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT,
  p_outward_generation_id UUID,
  p_action_id UUID,
  p_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_intent public.commerce_fulfillment_outward_intents%ROWTYPE;
  v_attempt_token UUID := pg_catalog.gen_random_uuid();
  v_alert_id UUID;
  v_created BOOLEAN := false;
  v_lifecycle_authority TEXT;
  v_required_kinds TEXT[];
BEGIN
  IF p_order_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_outward_generation_id IS NULL
     OR p_action_id IS NULL
     OR p_claim_token IS NULL
     OR p_intent_kind NOT IN (
       'purchase_completed_event',
       'subscription_activated_event',
       'receipt_dm',
       'subscription_renewed_event',
       'subscription_cancelled_event',
       'subscription_cancelled_dm',
       'subscription_payment_failed_lapsed_event',
       'subscription_payment_failed_event',
       'subscription_payment_failed_dm',
       'subscription_suspended_event',
       'subscription_suspended_dm'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_begin_fulfillment_outward_intent: exact intent identity is required';
  END IF;

  -- Canonical outward lock order is action -> role-delivery intent ->
  -- entitlement -> outward intent. The lifecycle classifier locks the latter
  -- two, so hold the exact current action claim before invoking either
  -- authority helper. Queue finalization takes the same action row first.
  PERFORM 1
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
     AND queue.guild_id = p_guild_id
     AND queue.lane = 'commerce'
     AND queue.payload ->> 'order_id' = p_order_id::TEXT
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', p_order_id,
      'guild_id', p_guild_id,
      'intent_kind', p_intent_kind,
      'outward_generation_id', p_outward_generation_id,
      'disposition', 'absent',
      'state', NULL,
      'attempt_token', NULL,
      'alert_id', NULL
    );
  END IF;

  PERFORM public.commerce_assert_outward_action_authority(
    p_order_id,
    p_guild_id,
    p_intent_kind,
    p_outward_generation_id,
    p_action_id
  );

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR KEY SHARE;
  IF NOT FOUND
     OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR NOT COALESCE(
       v_order.source = 'purchase' OR v_order.source IS NULL,
       false
     )
     OR v_order.status NOT IN ('completed', 'pending_review') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_begin_fulfillment_outward_intent: paid order identity mismatch';
  END IF;

  v_lifecycle_authority :=
    public.commerce_classify_lifecycle_outward_authority(
      p_order_id,
      p_guild_id,
      p_intent_kind,
      p_outward_generation_id,
      p_action_id
    );
  IF v_lifecycle_authority = 'superseded' THEN
    -- Lock the exact current carrier before minting the complete set of
    -- no-send tombstones. The handler stops after the first superseded result,
    -- so every required kind must already be terminal for queue finalization.
    PERFORM 1
      FROM public.bot_action_queue AS queue
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token
       AND queue.guild_id = p_guild_id
       AND queue.lane = 'commerce'
       AND queue.payload ->> 'order_id' = p_order_id::TEXT
     FOR SHARE;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'order_id', v_order.id,
        'guild_id', v_order.guild_id,
        'intent_kind', p_intent_kind,
        'outward_generation_id', p_outward_generation_id,
        'disposition', 'absent',
        'state', NULL,
        'attempt_token', NULL,
        'alert_id', NULL
      );
    END IF;

    v_required_kinds := CASE
      WHEN p_intent_kind = 'subscription_renewed_event'
        THEN ARRAY['subscription_renewed_event']::TEXT[]
      ELSE ARRAY[
        'subscription_payment_failed_lapsed_event',
        'subscription_payment_failed_event',
        'subscription_payment_failed_dm',
        'subscription_suspended_event',
        'subscription_suspended_dm'
      ]::TEXT[]
    END;
    INSERT INTO public.commerce_fulfillment_outward_intents (
      order_id,
      guild_id,
      outward_generation_id,
      intent_kind,
      state,
      attempt_token,
      last_error
    )
    SELECT
      v_order.id,
      v_order.guild_id,
      p_outward_generation_id,
      required.required_kind,
      'superseded',
      NULL,
      'superseded by terminal subscription cancellation'
    FROM pg_catalog.unnest(v_required_kinds) AS required(required_kind)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT intent.*
    INTO v_intent
    FROM public.commerce_fulfillment_outward_intents AS intent
   WHERE intent.order_id = v_order.id
     AND intent.intent_kind = p_intent_kind
     AND intent.outward_generation_id IS NOT DISTINCT FROM p_outward_generation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- The carrier row is the creation fence.  Queue finalization and stale
    -- recovery take it exclusively; a fresh outward sender must hold this
    -- exact current processing claim before it can mint an absent intent.
    PERFORM 1
      FROM public.bot_action_queue AS queue
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token
       AND queue.guild_id = p_guild_id
       AND queue.lane = 'commerce'
       AND queue.payload ->> 'order_id' = p_order_id::TEXT
     FOR SHARE;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'order_id', v_order.id,
        'guild_id', v_order.guild_id,
        'intent_kind', p_intent_kind,
        'outward_generation_id', p_outward_generation_id,
        'disposition', 'absent',
        'state', NULL,
        'attempt_token', NULL,
        'alert_id', NULL
      );
    END IF;

    -- Fresh statement after the carrier lock closes an insert-vs-finalize
    -- race while still allowing a concurrently committed creator to win.
    SELECT intent.*
      INTO v_intent
      FROM public.commerce_fulfillment_outward_intents AS intent
     WHERE intent.order_id = v_order.id
       AND intent.intent_kind = p_intent_kind
       AND intent.outward_generation_id = p_outward_generation_id
     FOR UPDATE;

    IF NOT FOUND THEN
    INSERT INTO public.commerce_fulfillment_outward_intents (
      order_id,
      guild_id,
      outward_generation_id,
      intent_kind,
      state,
      attempt_token
    ) VALUES (
      v_order.id,
      v_order.guild_id,
      p_outward_generation_id,
      p_intent_kind,
      'sending',
      v_attempt_token
    )
    ON CONFLICT DO NOTHING
    RETURNING * INTO v_intent;

    IF FOUND THEN
      v_created := true;
    ELSE
      SELECT intent.*
        INTO v_intent
        FROM public.commerce_fulfillment_outward_intents AS intent
       WHERE intent.order_id = v_order.id
         AND intent.intent_kind = p_intent_kind
         AND intent.outward_generation_id
               IS NOT DISTINCT FROM p_outward_generation_id
       FOR UPDATE;
    END IF;
    END IF;
  END IF;

  IF v_intent.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_order.id,
      'guild_id', v_order.guild_id,
      'intent_kind', p_intent_kind,
      'outward_generation_id', p_outward_generation_id,
      'disposition', 'absent',
      'state', NULL,
      'attempt_token', NULL,
      'alert_id', NULL
    );
  END IF;

  IF v_intent.guild_id IS DISTINCT FROM v_order.guild_id
     OR v_intent.outward_generation_id IS DISTINCT FROM p_outward_generation_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_begin_fulfillment_outward_intent: durable intent identity mismatch';
  END IF;

  IF v_intent.state = 'superseded' THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_intent.order_id,
      'guild_id', v_intent.guild_id,
      'intent_kind', v_intent.intent_kind,
      'outward_generation_id', v_intent.outward_generation_id,
      'disposition', 'superseded',
      'state', v_intent.state,
      'attempt_token', NULL,
      'alert_id', NULL
    );
  END IF;

  IF v_created THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_intent.order_id,
      'guild_id', v_intent.guild_id,
      'intent_kind', v_intent.intent_kind,
      'outward_generation_id', v_intent.outward_generation_id,
      'disposition', 'send',
      'state', v_intent.state,
      'attempt_token', v_intent.attempt_token,
      'alert_id', NULL
    );
  END IF;

  IF v_intent.state = 'sent' THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_intent.order_id,
      'guild_id', v_intent.guild_id,
      'intent_kind', v_intent.intent_kind,
      'outward_generation_id', v_intent.outward_generation_id,
      'disposition', 'sent',
      'state', v_intent.state,
      'attempt_token', NULL,
      'alert_id', NULL
    );
  END IF;

  IF v_intent.state = 'sending' THEN
    UPDATE public.commerce_fulfillment_outward_intents AS intent
       SET state = 'uncertain',
           attempt_token = NULL,
           uncertain_at = pg_catalog.clock_timestamp(),
           last_error = 'worker resumed while prior external acceptance was unresolved',
           updated_at = pg_catalog.clock_timestamp()
     WHERE intent.id = v_intent.id
       AND intent.state = 'sending'
    RETURNING intent.* INTO v_intent;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_begin_fulfillment_outward_intent: sending transition raced';
    END IF;
  END IF;

  IF v_intent.state = 'uncertain' THEN
    v_alert_id := public.commerce_record_fulfillment_outward_uncertain(
      v_intent.id,
      v_intent.last_error
    );
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_intent.order_id,
      'guild_id', v_intent.guild_id,
      'intent_kind', v_intent.intent_kind,
      'outward_generation_id', v_intent.outward_generation_id,
      'disposition', 'uncertain',
      'state', v_intent.state,
      'attempt_token', NULL,
      'alert_id', v_alert_id
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_intent.order_id,
    'guild_id', v_intent.guild_id,
    'intent_kind', v_intent.intent_kind,
    'outward_generation_id', v_intent.outward_generation_id,
    'disposition', 'send',
    'state', v_intent.state,
    'attempt_token', v_intent.attempt_token,
    'alert_id', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_begin_fulfillment_outward_intent(
  UUID, TEXT, TEXT, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_begin_fulfillment_outward_intent(
  UUID, TEXT, TEXT, UUID, UUID, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_resume_fulfillment_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT,
  p_outward_generation_id UUID,
  p_action_id UUID,
  p_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_fulfillment_outward_intents%ROWTYPE;
BEGIN
  PERFORM public.commerce_assert_outward_action_authority(
    p_order_id,
    p_guild_id,
    p_intent_kind,
    p_outward_generation_id,
    p_action_id
  );

  SELECT intent.*
    INTO v_intent
    FROM public.commerce_fulfillment_outward_intents AS intent
   WHERE intent.order_id = p_order_id
     AND intent.guild_id = p_guild_id
     AND intent.intent_kind = p_intent_kind
     AND intent.outward_generation_id IS NOT DISTINCT FROM p_outward_generation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', p_order_id,
      'guild_id', p_guild_id,
      'intent_kind', p_intent_kind,
      'outward_generation_id', p_outward_generation_id,
      'disposition', 'absent',
      'state', NULL,
      'attempt_token', NULL,
      'alert_id', NULL
    );
  END IF;

  RETURN public.commerce_begin_fulfillment_outward_intent(
    p_order_id,
    p_guild_id,
    p_intent_kind,
    p_outward_generation_id,
    p_action_id,
    p_claim_token
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_resume_fulfillment_outward_intent(
  UUID, TEXT, TEXT, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_resume_fulfillment_outward_intent(
  UUID, TEXT, TEXT, UUID, UUID, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_finish_fulfillment_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT,
  p_outward_generation_id UUID,
  p_attempt_token UUID,
  p_outcome TEXT,
  p_error TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_fulfillment_outward_intents%ROWTYPE;
  v_alert_id UUID;
BEGIN
  IF p_order_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_intent_kind NOT IN (
       'purchase_completed_event',
       'subscription_activated_event',
       'receipt_dm',
       'subscription_renewed_event',
       'subscription_cancelled_event',
       'subscription_cancelled_dm',
       'subscription_payment_failed_lapsed_event',
       'subscription_payment_failed_event',
       'subscription_payment_failed_dm',
       'subscription_suspended_event',
       'subscription_suspended_dm'
     )
     OR p_attempt_token IS NULL
     OR p_outcome NOT IN ('sent', 'uncertain')
     OR (
       p_outcome = 'uncertain'
       AND (p_error IS NULL OR p_error = '')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_finish_fulfillment_outward_intent: exact outcome identity is required';
  END IF;

  PERFORM public.commerce_assert_outward_generation_authority(
    p_order_id,
    p_guild_id,
    p_intent_kind,
    p_outward_generation_id
  );

  SELECT intent.*
    INTO v_intent
    FROM public.commerce_fulfillment_outward_intents AS intent
   WHERE intent.order_id = p_order_id
     AND intent.guild_id = p_guild_id
     AND intent.intent_kind = p_intent_kind
     AND intent.outward_generation_id IS NOT DISTINCT FROM p_outward_generation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_finish_fulfillment_outward_intent: intent identity mismatch';
  END IF;

  IF v_intent.state = 'sent' THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_intent.order_id,
      'guild_id', v_intent.guild_id,
      'intent_kind', v_intent.intent_kind,
      'outward_generation_id', v_intent.outward_generation_id,
      'state', v_intent.state,
      'alert_id', NULL
    );
  ELSIF v_intent.state = 'uncertain' THEN
    v_alert_id := public.commerce_record_fulfillment_outward_uncertain(
      v_intent.id,
      v_intent.last_error
    );
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_intent.order_id,
      'guild_id', v_intent.guild_id,
      'intent_kind', v_intent.intent_kind,
      'outward_generation_id', v_intent.outward_generation_id,
      'state', v_intent.state,
      'alert_id', v_alert_id
    );
  END IF;

  IF v_intent.state IS DISTINCT FROM 'sending'
     OR v_intent.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_finish_fulfillment_outward_intent: attempt token mismatch';
  END IF;

  UPDATE public.commerce_fulfillment_outward_intents AS intent
     SET state = p_outcome,
         attempt_token = NULL,
         sent_at = CASE WHEN p_outcome = 'sent'
           THEN pg_catalog.clock_timestamp() ELSE NULL END,
         uncertain_at = CASE WHEN p_outcome = 'uncertain'
           THEN pg_catalog.clock_timestamp() ELSE NULL END,
         last_error = CASE WHEN p_outcome = 'uncertain'
           THEN pg_catalog.left(p_error, 1000) ELSE NULL END,
         updated_at = pg_catalog.clock_timestamp()
   WHERE intent.id = v_intent.id
     AND intent.state = 'sending'
     AND intent.attempt_token = p_attempt_token
  RETURNING intent.* INTO v_intent;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_finish_fulfillment_outward_intent: outcome transition raced';
  END IF;

  IF v_intent.state = 'uncertain' THEN
    v_alert_id := public.commerce_record_fulfillment_outward_uncertain(
      v_intent.id,
      v_intent.last_error
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_intent.order_id,
    'guild_id', v_intent.guild_id,
    'intent_kind', v_intent.intent_kind,
    'outward_generation_id', v_intent.outward_generation_id,
    'state', v_intent.state,
    'alert_id', v_alert_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_finish_fulfillment_outward_intent(
  UUID, TEXT, TEXT, UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_finish_fulfillment_outward_intent(
  UUID, TEXT, TEXT, UUID, UUID, TEXT, TEXT
) TO service_role;

-- The superseded four-argument surface is inspection-only.  A generation
-- without its exact carrier action and current claim can never mint an absent
-- external effect.  The NULL generation path preserves legacy dedupe evidence.
CREATE OR REPLACE FUNCTION public.commerce_begin_fulfillment_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT,
  p_outward_generation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_fulfillment_outward_intents%ROWTYPE;
  v_alert_id UUID;
BEGIN
  IF p_order_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_outward_generation_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'commerce outward creation requires carrier action and claim authority';
  END IF;

  SELECT intent.*
    INTO v_intent
    FROM public.commerce_fulfillment_outward_intents AS intent
   WHERE intent.order_id = p_order_id
     AND intent.guild_id = p_guild_id
     AND intent.intent_kind = p_intent_kind
     AND intent.outward_generation_id IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', p_order_id,
      'guild_id', p_guild_id,
      'intent_kind', p_intent_kind,
      'outward_generation_id', NULL,
      'disposition', 'absent',
      'state', NULL,
      'attempt_token', NULL,
      'alert_id', NULL
    );
  END IF;

  IF v_intent.state = 'sending' THEN
    UPDATE public.commerce_fulfillment_outward_intents AS intent
       SET state = 'uncertain',
           attempt_token = NULL,
           uncertain_at = pg_catalog.clock_timestamp(),
           last_error = 'legacy worker resumed while prior external acceptance was unresolved',
           updated_at = pg_catalog.clock_timestamp()
     WHERE intent.id = v_intent.id
       AND intent.state = 'sending'
    RETURNING intent.* INTO v_intent;
  END IF;
  IF v_intent.state = 'uncertain' THEN
    v_alert_id := public.commerce_record_fulfillment_outward_uncertain(
      v_intent.id,
      v_intent.last_error
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_intent.order_id,
    'guild_id', v_intent.guild_id,
    'intent_kind', v_intent.intent_kind,
    'outward_generation_id', NULL,
    'disposition', CASE v_intent.state
      WHEN 'sent' THEN 'sent'
      WHEN 'uncertain' THEN 'uncertain'
      ELSE 'absent'
    END,
    'state', v_intent.state,
    'attempt_token', NULL,
    'alert_id', v_alert_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_begin_fulfillment_outward_intent(
  UUID, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_resume_fulfillment_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT,
  p_outward_generation_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.commerce_begin_fulfillment_outward_intent(
    p_order_id, p_guild_id, p_intent_kind, p_outward_generation_id
  )
$$;

REVOKE ALL ON FUNCTION public.commerce_resume_fulfillment_outward_intent(
  UUID, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_continue_legacy_receipt_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_predecessor_kind TEXT,
  p_action_id UUID,
  p_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
  v_role_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_fulfillment_outward_intents%ROWTYPE;
  v_attempt_token UUID := pg_catalog.gen_random_uuid();
  v_alert_id UUID;
  v_created BOOLEAN := false;
BEGIN
  IF p_order_id IS NULL
     OR p_action_id IS NULL
     OR p_claim_token IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_predecessor_kind NOT IN (
       'purchase_completed_event',
       'subscription_activated_event'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy receipt continuation requires exact carrier identity';
  END IF;

  SELECT queue.*
    INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
     AND queue.guild_id = p_guild_id
     AND queue.lane = 'commerce'
     AND queue.payload ->> 'guild_id' = p_guild_id
     AND queue.payload ->> 'order_id' = p_order_id::TEXT
     AND (
       (
         p_predecessor_kind = 'purchase_completed_event'
         AND queue.action = 'fulfill_purchase'
         AND queue.payload ->> 'fulfillment_type' = 'one_time_purchase'
       )
       OR (
         p_predecessor_kind = 'subscription_activated_event'
         AND queue.action = 'fulfill_subscription'
         AND queue.payload ->> 'fulfillment_type' = 'subscription_activated'
       )
     )
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'legacy receipt continuation has no current carrier claim';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-role-delivery-action:' || p_action_id::TEXT,
      0
    )
  );
  SELECT intent.*
    INTO v_role_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.action_id = p_action_id
     AND intent.contract_kind = 'paid'
     AND intent.order_id = p_order_id
     AND intent.guild_id = p_guild_id
     AND intent.outward_generation_id IS NULL
     AND intent.delivery_confirmed_at IS NOT NULL
     AND intent.last_delivery_outcome = 'live'
     AND intent.mutation_token IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'legacy receipt continuation role evidence mismatch';
  END IF;
  PERFORM 1
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.status IN ('completed', 'pending_review')
     AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy receipt continuation paid order mismatch';
  END IF;

  PERFORM predecessor.id
    FROM public.commerce_fulfillment_outward_intents AS predecessor
   WHERE predecessor.order_id = p_order_id
     AND predecessor.guild_id = p_guild_id
     AND predecessor.intent_kind = p_predecessor_kind
     AND predecessor.outward_generation_id IS NULL
     AND predecessor.state = 'sent'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'legacy receipt continuation requires a sent predecessor';
  END IF;

  SELECT intent.*
    INTO v_intent
    FROM public.commerce_fulfillment_outward_intents AS intent
   WHERE intent.order_id = p_order_id
     AND intent.guild_id = p_guild_id
     AND intent.intent_kind = 'receipt_dm'
     AND intent.outward_generation_id IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.commerce_fulfillment_outward_intents (
      order_id,
      guild_id,
      outward_generation_id,
      intent_kind,
      state,
      attempt_token
    ) VALUES (
      p_order_id,
      p_guild_id,
      NULL,
      'receipt_dm',
      'sending',
      v_attempt_token
    )
    ON CONFLICT DO NOTHING
    RETURNING * INTO v_intent;
    IF FOUND THEN
      v_created := true;
    ELSE
      SELECT intent.*
        INTO v_intent
        FROM public.commerce_fulfillment_outward_intents AS intent
       WHERE intent.order_id = p_order_id
         AND intent.guild_id = p_guild_id
         AND intent.intent_kind = 'receipt_dm'
         AND intent.outward_generation_id IS NULL
       FOR UPDATE;
    END IF;
  END IF;
  IF v_intent.id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'legacy receipt continuation lost its durable intent race';
  END IF;

  IF v_created THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', p_order_id,
      'guild_id', p_guild_id,
      'intent_kind', 'receipt_dm',
      'outward_generation_id', NULL,
      'disposition', 'send',
      'state', v_intent.state,
      'attempt_token', v_intent.attempt_token,
      'alert_id', NULL
    );
  END IF;
  IF v_intent.state = 'sending' THEN
    UPDATE public.commerce_fulfillment_outward_intents AS intent
       SET state = 'uncertain',
           attempt_token = NULL,
           uncertain_at = pg_catalog.clock_timestamp(),
           last_error = 'legacy receipt continuation found an unresolved prior attempt',
           updated_at = pg_catalog.clock_timestamp()
     WHERE intent.id = v_intent.id
       AND intent.state = 'sending'
    RETURNING intent.* INTO v_intent;
  END IF;
  IF v_intent.state = 'uncertain' THEN
    v_alert_id := public.commerce_record_fulfillment_outward_uncertain(
      v_intent.id,
      v_intent.last_error
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'order_id', p_order_id,
    'guild_id', p_guild_id,
    'intent_kind', 'receipt_dm',
    'outward_generation_id', NULL,
    'disposition', CASE v_intent.state
      WHEN 'sent' THEN 'sent'
      WHEN 'uncertain' THEN 'uncertain'
      ELSE 'absent'
    END,
    'state', v_intent.state,
    'attempt_token', NULL,
    'alert_id', v_alert_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_continue_legacy_receipt_outward_intent(
  UUID, TEXT, TEXT, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_continue_legacy_receipt_outward_intent(
  UUID, TEXT, TEXT, UUID, UUID
) TO service_role;

-- Keep legacy overloads safe on a replay-upgraded table.  NULL generations
-- resume evidence but cannot mint a new event.
CREATE OR REPLACE FUNCTION public.commerce_begin_fulfillment_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.commerce_begin_fulfillment_outward_intent(
    p_order_id, p_guild_id, p_intent_kind, NULL::UUID
  )
$$;
CREATE OR REPLACE FUNCTION public.commerce_resume_fulfillment_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.commerce_resume_fulfillment_outward_intent(
    p_order_id, p_guild_id, p_intent_kind, NULL::UUID
  )
$$;
CREATE OR REPLACE FUNCTION public.commerce_finish_fulfillment_outward_intent(
  p_order_id UUID,
  p_guild_id TEXT,
  p_intent_kind TEXT,
  p_attempt_token UUID,
  p_outcome TEXT,
  p_error TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.commerce_finish_fulfillment_outward_intent(
    p_order_id, p_guild_id, p_intent_kind, NULL::UUID,
    p_attempt_token, p_outcome, p_error
  )
$$;

-- Preserve the mature role-delivery state machine and wrap its begin RPC so a
-- durable outward generation is allocated in the same transaction before the
-- worker receives Discord mutation authority.  The renamed implementation is
-- owner-private, preventing service_role from bypassing generation binding.
DO $rename_role_begin$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.commerce_begin_role_delivery_attempt_without_outward(uuid,uuid,uuid,text,uuid,text,uuid,uuid,uuid,text,text[])'
     ) IS NULL THEN
    ALTER FUNCTION public.commerce_begin_role_delivery_attempt(
      UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT[]
    ) RENAME TO commerce_begin_role_delivery_attempt_without_outward;
  END IF;
END;
$rename_role_begin$;

-- Subscription access is created or advanced only while the claimed queue
-- action is still the authoritative provider lifecycle generation.
CREATE OR REPLACE FUNCTION public.commerce_apply_subscription_entitlement_lifecycle(
  p_action_id UUID,
  p_claim_token UUID,
  p_entitlement_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_discord_id TEXT,
  p_product_id UUID,
  p_order_id UUID,
  p_plan_id UUID,
  p_license_key_id UUID,
  p_granted_role_ids TEXT[],
  p_granted_channel_ids TEXT[],
  p_expires_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
  v_event public.commerce_subscription_lifecycle_events%ROWTYPE;
  v_head public.commerce_subscription_lifecycle_heads%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_disposition TEXT;
BEGIN
  IF p_action_id IS NULL
     OR p_claim_token IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_customer_id IS NULL
     OR p_discord_id IS NULL
     OR p_discord_id = ''
     OR p_discord_id <> pg_catalog.btrim(p_discord_id)
     OR p_product_id IS NULL
     OR p_order_id IS NULL
     OR p_plan_id IS NULL
     OR p_granted_role_ids IS NULL
     OR p_granted_channel_ids IS NULL
     OR p_expires_at IS NULL
     OR NOT pg_catalog.isfinite(p_expires_at) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_apply_subscription_entitlement_lifecycle: exact access identity is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'commerce-guild-purge:' || p_guild_id,
      0
    )
  );
  SELECT queue.*
    INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
     AND queue.guild_id = p_guild_id
     AND queue.action = 'fulfill_subscription'
     AND queue.lane = 'commerce';
  IF NOT FOUND
     OR pg_catalog.jsonb_typeof(v_action.payload) IS DISTINCT FROM 'object'
     OR v_action.payload ->> 'fulfillment_type' NOT IN (
       'subscription_activated',
       'subscription_renewed'
     )
     OR v_action.payload ->> 'guild_id' IS DISTINCT FROM p_guild_id
     OR v_action.payload ->> 'customer_id'
          IS DISTINCT FROM p_customer_id::TEXT
     OR v_action.payload ->> 'discord_id' IS DISTINCT FROM p_discord_id
     OR v_action.payload ->> 'product_id'
          IS DISTINCT FROM p_product_id::TEXT
     OR v_action.payload ->> 'order_id' IS DISTINCT FROM p_order_id::TEXT
     OR v_action.payload ->> 'plan_id' IS DISTINCT FROM p_plan_id::TEXT
     OR v_action.payload ->> 'entitlement_type'
          IS DISTINCT FROM 'subscription'
     OR v_action.payload ->> 'webhook_event_id' IS NULL
     OR v_action.payload ->> 'paypal_subscription_id'
          !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR v_action.payload ->> 'provider_occurred_at' IS NULL
     OR pg_catalog.jsonb_typeof(
          v_action.payload -> 'lifecycle_generation'
        ) IS DISTINCT FROM 'number'
     OR v_action.payload ->> 'lifecycle_generation' !~ '^[1-9][0-9]*$'
     OR NOT (
       (
         v_action.payload ->> 'fulfillment_type' =
           'subscription_activated'
         AND v_action.payload ->> 'provider_event_type' =
           'BILLING.SUBSCRIPTION.ACTIVATED'
       )
       OR (
         v_action.payload ->> 'fulfillment_type' =
           'subscription_renewed'
         AND v_action.payload ->> 'provider_event_type' =
           'PAYMENT.SALE.COMPLETED'
       )
     )
     OR (v_action.payload ->> 'provider_paid_through_at')::TIMESTAMPTZ
          IS DISTINCT FROM p_expires_at
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_action.payload -> 'granted_role_ids',
       p_granted_role_ids
     )
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_action.payload -> 'granted_channel_ids',
       p_granted_channel_ids
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_apply_subscription_entitlement_lifecycle: queue action identity mismatch';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-subscription-lifecycle:'
        || (v_action.payload ->> 'paypal_subscription_id'),
      0
    )
  );
  SELECT event_row.*
    INTO v_event
    FROM public.commerce_subscription_lifecycle_events AS event_row
   WHERE event_row.webhook_event_id =
           v_action.payload ->> 'webhook_event_id'
     AND event_row.paypal_subscription_id =
           v_action.payload ->> 'paypal_subscription_id'
     AND event_row.order_id = p_order_id
     AND event_row.guild_id = p_guild_id
     AND event_row.customer_id = p_customer_id
     AND event_row.product_id = p_product_id
     AND event_row.plan_id = p_plan_id
     AND event_row.provider_event_type =
           v_action.payload ->> 'provider_event_type'
     AND event_row.provider_occurred_at =
           (v_action.payload ->> 'provider_occurred_at')::TIMESTAMPTZ
     AND event_row.generation =
           (v_action.payload ->> 'lifecycle_generation')::BIGINT
     AND event_row.provider_paid_through_at = p_expires_at
     AND event_row.disposition = 'accepted'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_apply_subscription_entitlement_lifecycle: lifecycle event identity mismatch';
  END IF;
  SELECT head.*
    INTO v_head
    FROM public.commerce_subscription_lifecycle_heads AS head
   WHERE head.paypal_subscription_id = v_event.paypal_subscription_id
     AND head.order_id = p_order_id
     AND head.guild_id = p_guild_id
     AND head.customer_id = p_customer_id
     AND head.product_id = p_product_id
     AND head.plan_id = p_plan_id
   FOR SHARE;
  IF NOT FOUND
     OR v_head.last_webhook_event_id
          IS DISTINCT FROM v_event.webhook_event_id
     OR v_head.generation IS DISTINCT FROM v_event.generation THEN
    RETURN pg_catalog.jsonb_build_object(
      'disposition', 'superseded',
      'entitlement_id', p_entitlement_id,
      'lifecycle_generation', v_event.generation
    );
  END IF;

  IF p_entitlement_id IS NOT NULL THEN
    SELECT entitlement.*
      INTO v_entitlement
      FROM public.entitlements AS entitlement
     WHERE entitlement.id = p_entitlement_id
       AND entitlement.order_id = p_order_id
       AND entitlement.guild_id = p_guild_id
     FOR UPDATE;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'noncommerce-entitlement-customer:' || p_customer_id::TEXT,
      0
    )
  );
  PERFORM 1
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
     AND paid_order.product_id = p_product_id
     AND paid_order.plan_id = p_plan_id
     AND paid_order.paypal_subscription_id = v_event.paypal_subscription_id
     AND paid_order.status IN ('completed', 'pending_review')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_apply_subscription_entitlement_lifecycle: paid order identity mismatch';
  END IF;
  PERFORM 1
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
     AND queue.guild_id = p_guild_id
     AND queue.action = 'fulfill_subscription'
     AND queue.lane = 'commerce'
     AND queue.payload = v_action.payload
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_apply_subscription_entitlement_lifecycle: action claim raced';
  END IF;
  IF p_entitlement_id IS NULL THEN
    INSERT INTO public.entitlements (
      customer_id, guild_id, product_id, plan_id, license_key_id, order_id,
      type, status, source, granted_role_ids, granted_channel_ids,
      starts_at, expires_at
    ) VALUES (
      p_customer_id, p_guild_id, p_product_id, p_plan_id, p_license_key_id,
      p_order_id, 'subscription', 'active', 'purchase',
      p_granted_role_ids, p_granted_channel_ids,
      pg_catalog.clock_timestamp(), p_expires_at
    )
    ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_entitlement;
    v_disposition := CASE WHEN FOUND THEN 'created' ELSE 'replay' END;
  ELSE
    v_disposition := 'advanced';
  END IF;

  IF v_entitlement.id IS NULL THEN
    SELECT entitlement.*
      INTO v_entitlement
      FROM public.entitlements AS entitlement
     WHERE entitlement.order_id = p_order_id
       AND (p_entitlement_id IS NULL OR entitlement.id = p_entitlement_id)
     FOR UPDATE;
  END IF;
  IF NOT FOUND
     OR v_entitlement.customer_id IS DISTINCT FROM p_customer_id
     OR v_entitlement.guild_id IS DISTINCT FROM p_guild_id
     OR v_entitlement.product_id IS DISTINCT FROM p_product_id
     OR v_entitlement.plan_id IS DISTINCT FROM p_plan_id
     OR (
       p_entitlement_id IS NULL
       AND v_entitlement.license_key_id IS DISTINCT FROM p_license_key_id
     )
     OR v_entitlement.order_id IS DISTINCT FROM p_order_id
     OR v_entitlement.type IS DISTINCT FROM 'subscription'
     OR NOT COALESCE(
       v_entitlement.source = 'purchase' OR v_entitlement.source IS NULL,
       false
     )
     OR v_entitlement.granted_role_ids IS DISTINCT FROM p_granted_role_ids
     OR v_entitlement.granted_channel_ids
          IS DISTINCT FROM p_granted_channel_ids THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_apply_subscription_entitlement_lifecycle: entitlement identity mismatch';
  END IF;

  IF p_entitlement_id IS NOT NULL THEN
    IF v_entitlement.status NOT IN ('active', 'grace_period', 'suspended') THEN
      RETURN pg_catalog.jsonb_build_object(
        'disposition', 'superseded',
        'entitlement_id', v_entitlement.id,
        'lifecycle_generation', v_event.generation
      );
    END IF;
    UPDATE public.entitlements AS entitlement
       SET status = 'active',
           grace_period_ends_at = NULL,
           expires_at = p_expires_at,
           updated_at = pg_catalog.clock_timestamp()
     WHERE entitlement.id = v_entitlement.id
       AND entitlement.status IN ('active', 'grace_period', 'suspended')
    RETURNING entitlement.* INTO v_entitlement;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_apply_subscription_entitlement_lifecycle: entitlement transition raced';
    END IF;
  ELSIF v_entitlement.status NOT IN ('active', 'grace_period', 'suspended') THEN
    RETURN pg_catalog.jsonb_build_object(
      'disposition', 'superseded',
      'entitlement_id', v_entitlement.id,
      'lifecycle_generation', v_event.generation
    );
  ELSE
    UPDATE public.entitlements AS entitlement
       SET status = 'active',
           grace_period_ends_at = NULL,
           expires_at = p_expires_at,
           updated_at = pg_catalog.clock_timestamp()
     WHERE entitlement.id = v_entitlement.id
       AND entitlement.status IN ('active', 'grace_period', 'suspended')
    RETURNING entitlement.* INTO v_entitlement;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_apply_subscription_entitlement_lifecycle: activation replay transition raced';
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'disposition', v_disposition,
    'entitlement_id', v_entitlement.id,
    'status', v_entitlement.status,
    'expires_at', v_entitlement.expires_at,
    'lifecycle_generation', v_event.generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_apply_subscription_entitlement_lifecycle(
  UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, UUID,
  TEXT[], TEXT[], TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_apply_subscription_entitlement_lifecycle(
  UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, UUID,
  TEXT[], TEXT[], TIMESTAMPTZ
) TO service_role;

REVOKE ALL ON FUNCTION public.commerce_begin_role_delivery_attempt_without_outward(
  UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT[]
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_guard_role_delivery_outward_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_begin_owner NAME;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.outward_generation_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'role delivery outward generation requires exact begin binding';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.outward_generation_id IS NOT DISTINCT FROM OLD.outward_generation_id THEN
    RETURN NEW;
  END IF;

  SELECT pg_catalog.pg_get_userbyid(proc.proowner)
    INTO v_begin_owner
    FROM pg_catalog.pg_proc AS proc
   WHERE proc.oid = pg_catalog.to_regprocedure(
     'public.commerce_begin_role_delivery_attempt(uuid,uuid,uuid,text,uuid,text,uuid,uuid,uuid,text,text[])'
   );

  IF OLD.outward_generation_id IS NOT NULL
     OR NEW.outward_generation_id IS NULL
     OR OLD.delivery_confirmed_at IS NOT NULL
     OR NEW.delivery_confirmed_at IS NOT NULL
     OR NEW.state IS DISTINCT FROM 'open'
     OR v_begin_owner IS NULL
     OR CURRENT_USER IS DISTINCT FROM v_begin_owner THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'role delivery outward generation is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_guard_role_delivery_outward_generation()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_commerce_guard_role_delivery_outward_generation
  ON public.commerce_role_delivery_intents;
CREATE TRIGGER trg_commerce_guard_role_delivery_outward_generation
  BEFORE INSERT OR UPDATE OF outward_generation_id
  ON public.commerce_role_delivery_intents
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_role_delivery_outward_generation();

CREATE OR REPLACE FUNCTION public.commerce_begin_role_delivery_attempt(
  p_action_id UUID,
  p_claim_token UUID,
  p_entitlement_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_discord_id TEXT,
  p_order_id UUID,
  p_product_id UUID,
  p_plan_id UUID,
  p_entitlement_type TEXT,
  p_permanent_role_ids TEXT[]
)
RETURNS TABLE (
  intent_id UUID,
  mutation_token UUID,
  intent_state TEXT,
  may_mutate BOOLEAN,
  contract_live BOOLEAN,
  delivery_confirmed BOOLEAN,
  cleanup_needed BOOLEAN,
  outward_generation_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_begin RECORD;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_outward_generation_id UUID;
  v_action_snapshot public.bot_action_queue%ROWTYPE;
  v_lifecycle_event public.commerce_subscription_lifecycle_events%ROWTYPE;
  v_lifecycle_head public.commerce_subscription_lifecycle_heads%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'commerce-guild-purge:' || p_guild_id,
      0
    )
  );
  IF p_entitlement_type = 'subscription' THEN
    SELECT queue.*
      INTO v_action_snapshot
      FROM public.bot_action_queue AS queue
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token
       AND queue.guild_id = p_guild_id
       AND queue.action = 'fulfill_subscription'
       AND queue.lane = 'commerce';
    IF NOT FOUND
       OR v_action_snapshot.payload ->> 'webhook_event_id' IS NULL
       OR pg_catalog.jsonb_typeof(
            v_action_snapshot.payload -> 'lifecycle_generation'
          ) IS DISTINCT FROM 'number'
       OR v_action_snapshot.payload ->> 'paypal_subscription_id' IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_begin_role_delivery_attempt: subscription lifecycle carrier mismatch';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'commerce-subscription-lifecycle:'
          || (v_action_snapshot.payload ->> 'paypal_subscription_id'),
        0
      )
    );
    SELECT event_row.*
      INTO v_lifecycle_event
      FROM public.commerce_subscription_lifecycle_events AS event_row
     WHERE event_row.webhook_event_id =
             v_action_snapshot.payload ->> 'webhook_event_id'
       AND event_row.paypal_subscription_id =
             v_action_snapshot.payload ->> 'paypal_subscription_id'
       AND event_row.order_id = p_order_id
       AND event_row.guild_id = p_guild_id
       AND event_row.customer_id = p_customer_id
       AND event_row.product_id = p_product_id
       AND event_row.plan_id = p_plan_id
       AND event_row.generation =
             (v_action_snapshot.payload ->> 'lifecycle_generation')::BIGINT
       AND event_row.disposition = 'accepted'
     FOR SHARE;
    SELECT head.*
      INTO v_lifecycle_head
      FROM public.commerce_subscription_lifecycle_heads AS head
     WHERE head.paypal_subscription_id =
             v_action_snapshot.payload ->> 'paypal_subscription_id'
       AND head.order_id = p_order_id
       AND head.guild_id = p_guild_id
       AND head.customer_id = p_customer_id
       AND head.product_id = p_product_id
       AND head.plan_id = p_plan_id
     FOR SHARE;
    IF v_lifecycle_event.webhook_event_id IS NULL
       OR v_lifecycle_head.paypal_subscription_id IS NULL
       OR v_lifecycle_head.last_webhook_event_id
            IS DISTINCT FROM v_lifecycle_event.webhook_event_id
       OR v_lifecycle_head.generation
            IS DISTINCT FROM v_lifecycle_event.generation THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'commerce_begin_role_delivery_attempt: subscription lifecycle authority was superseded';
    END IF;
  END IF;
  -- Prelock the legacy helper's full carrier in the global mutation order.
  -- The renamed implementation historically took order -> entitlement ->
  -- intent -> action; acquiring entitlement -> customer -> order -> action
  -- here first makes its later re-entrant locks safe and ensures it can never
  -- hold an intent while waiting behind the action-first classifier.
  PERFORM 1
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
     AND entitlement.guild_id = p_guild_id
     AND entitlement.customer_id = p_customer_id
     AND entitlement.order_id = p_order_id
     AND entitlement.product_id = p_product_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_attempt: entitlement is unavailable';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'noncommerce-entitlement-customer:' || p_customer_id::TEXT,
      0
    )
  );
  PERFORM 1
    FROM public.customers AS customer
   WHERE customer.id = p_customer_id
     AND customer.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_attempt: customer is unavailable';
  END IF;
  PERFORM 1
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_attempt: order is unavailable';
  END IF;
  PERFORM 1
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_attempt: action is unavailable';
  END IF;

  SELECT *
    INTO v_begin
    FROM public.commerce_begin_role_delivery_attempt_without_outward(
      p_action_id,
      p_claim_token,
      p_entitlement_id,
      p_guild_id,
      p_customer_id,
      p_discord_id,
      p_order_id,
      p_product_id,
      p_plan_id,
      p_entitlement_type,
      p_permanent_role_ids
    );
  IF NOT FOUND OR v_begin.intent_id IS NULL THEN
    RETURN;
  END IF;

  SELECT intent.*
    INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = v_begin.intent_id
     AND intent.action_id = p_action_id
     AND intent.order_id = p_order_id
     AND intent.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_begin_role_delivery_attempt: durable intent disappeared';
  END IF;

  -- Confirmed legacy rows intentionally remain NULL: their event/receipt may
  -- have run before generation evidence existed.  Any attempt that can still
  -- mutate gets one stable generation before this RPC returns.
  IF v_intent.outward_generation_id IS NULL
     AND v_intent.delivery_confirmed_at IS NULL
     AND COALESCE(v_begin.may_mutate, false) THEN
    v_outward_generation_id := pg_catalog.gen_random_uuid();
    UPDATE public.commerce_role_delivery_intents AS intent
       SET outward_generation_id = v_outward_generation_id,
           updated_at = pg_catalog.clock_timestamp()
     WHERE intent.id = v_intent.id
       AND intent.outward_generation_id IS NULL
       AND intent.delivery_confirmed_at IS NULL
       AND intent.state = 'open'
    RETURNING intent.* INTO v_intent;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_begin_role_delivery_attempt: outward generation binding raced';
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_begin.intent_id::UUID,
    v_begin.mutation_token::UUID,
    v_begin.intent_state::TEXT,
    v_begin.may_mutate::BOOLEAN,
    v_begin.contract_live::BOOLEAN,
    v_begin.delivery_confirmed::BOOLEAN,
    v_begin.cleanup_needed::BOOLEAN,
    v_intent.outward_generation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_begin_role_delivery_attempt(
  UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT[]
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_begin_role_delivery_attempt(
  UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT[]
) TO service_role;

-- Extend the established exact revocation primitive with a recoverable
-- suspended target. Suspension still removes access immediately: the same
-- transaction shuts down license sessions and records the durable role-cleanup
-- carrier, but a later activation may transition suspended -> active.
CREATE OR REPLACE FUNCTION public.commerce_revoke_entitlement_exact(
  p_entitlement_id UUID,
  p_guild_id TEXT,
  p_expected_status TEXT,
  p_expected_updated_at TIMESTAMPTZ,
  p_reason TEXT
)
RETURNS TABLE (
  disposition TEXT,
  transition_id UUID,
  entitlement_id UUID,
  guild_id TEXT,
  customer_id UUID,
  discord_id TEXT,
  product_id UUID,
  product_name TEXT,
  license_key_id UUID,
  role_ids TEXT[],
  status TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_observed public.entitlements%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_target_status TEXT;
  v_transition_id UUID;
BEGIN
  IF p_entitlement_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_expected_status NOT IN (
       'active', 'pending', 'grace_period', 'suspended', 'expired', 'cancelled'
     )
     OR (
       p_expected_updated_at IS NOT NULL
       AND NOT pg_catalog.isfinite(p_expected_updated_at)
     )
     OR p_reason NOT IN (
       'expired', 'cancelled', 'revoked', 'refund', 'suspended'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: request contract is invalid';
  END IF;

  v_target_status := CASE p_reason
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'suspended' THEN 'suspended'
    ELSE 'expired'
  END;

  SELECT entitlement.*
    INTO v_observed
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
     AND entitlement.guild_id = p_guild_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'not_found'::TEXT, NULL::UUID, NULL::UUID, NULL::TEXT,
      NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID,
      NULL::TEXT[], NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF v_observed.customer_id IS NULL OR v_observed.product_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: parent identity is malformed';
  END IF;

  -- Canonical order shared with lifecycle triggers and member purge:
  -- entitlement -> customer advisory -> customer -> product.
  SELECT entitlement.*
    INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
     AND entitlement.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'not_found'::TEXT, NULL::UUID, NULL::UUID, NULL::TEXT,
      NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID,
      NULL::TEXT[], NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF v_entitlement.customer_id IS DISTINCT FROM v_observed.customer_id
     OR v_entitlement.product_id IS DISTINCT FROM v_observed.product_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_revoke_entitlement_exact: parent identity changed';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'noncommerce-entitlement-customer:' || v_entitlement.customer_id::TEXT,
      0
    )
  );
  SELECT customer.*
    INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = v_entitlement.customer_id
     AND customer.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: customer identity mismatch';
  END IF;
  SELECT product.*
    INTO v_product
    FROM public.products AS product
   WHERE product.id = v_entitlement.product_id
     AND product.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: product identity mismatch';
  END IF;

  -- A terminal entitlement can never be revived by a late suspension.
  -- An exact already-suspended replay is also a no-op and carries no new
  -- outward authority unless its wrapper recovers the original generation.
  IF v_entitlement.status IN ('expired', 'cancelled')
     OR (
       v_target_status = 'suspended'
       AND v_entitlement.status = 'suspended'
     ) THEN
    RETURN QUERY SELECT
      'noop'::TEXT,
      NULL::UUID,
      v_entitlement.id,
      v_entitlement.guild_id,
      v_entitlement.customer_id,
      NULL::TEXT,
      v_entitlement.product_id,
      NULL::TEXT,
      v_entitlement.license_key_id,
      COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[]),
      v_entitlement.status,
      v_entitlement.updated_at;
    RETURN;
  END IF;

  IF v_entitlement.status IS DISTINCT FROM p_expected_status
     OR v_entitlement.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN QUERY SELECT
      'stale'::TEXT,
      NULL::UUID,
      v_entitlement.id,
      v_entitlement.guild_id,
      v_entitlement.customer_id,
      NULL::TEXT,
      v_entitlement.product_id,
      NULL::TEXT,
      v_entitlement.license_key_id,
      COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[]),
      v_entitlement.status,
      v_entitlement.updated_at;
    RETURN;
  END IF;
  IF v_entitlement.status NOT IN (
    'active', 'pending', 'grace_period', 'suspended'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_entitlement_exact: stored status is invalid';
  END IF;

  v_transition_id := pg_catalog.gen_random_uuid();
  UPDATE public.entitlements AS entitlement
     SET status = v_target_status,
         cancelled_at = CASE
           WHEN v_target_status = 'cancelled' THEN COALESCE(
             entitlement.cancelled_at,
             pg_catalog.clock_timestamp()
           )
           ELSE entitlement.cancelled_at
         END,
         grace_period_ends_at = CASE
           WHEN v_target_status = 'suspended' THEN NULL
           ELSE entitlement.grace_period_ends_at
         END
   WHERE entitlement.id = v_entitlement.id
     AND entitlement.guild_id = p_guild_id
     AND entitlement.status = p_expected_status
     AND entitlement.updated_at IS NOT DISTINCT FROM p_expected_updated_at
  RETURNING entitlement.* INTO v_entitlement;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_revoke_entitlement_exact: transition authority changed';
  END IF;

  IF v_entitlement.license_key_id IS NOT NULL THEN
    UPDATE public.license_sessions AS session
       SET active = false,
           deactivated_at = pg_catalog.clock_timestamp(),
           deactivation_reason = CASE
             WHEN v_target_status = 'suspended'
               THEN 'entitlement_suspended'
             ELSE 'entitlement_revoked'
           END
     WHERE session.license_key_id = v_entitlement.license_key_id
       AND session.active = true;
  END IF;
  UPDATE public.alerts AS alert
     SET resolved = true,
         resolved_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.guild_id = p_guild_id
     AND alert.alert_type = 'entitlement_grace_period'
     AND alert.metadata ->> 'entitlement_id' = v_entitlement.id::TEXT
     AND alert.resolved = false;

  PERFORM public.commerce_record_entitlement_lifecycle_event(
    v_transition_id,
    'entitlement.revoked',
    v_entitlement.id,
    v_entitlement.guild_id,
    v_customer.discord_id,
    v_entitlement.product_id,
    v_product.name,
    COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[]),
    p_reason
  );

  RETURN QUERY SELECT
    'applied'::TEXT,
    v_transition_id,
    v_entitlement.id,
    v_entitlement.guild_id,
    v_entitlement.customer_id,
    v_customer.discord_id,
    v_entitlement.product_id,
    v_product.name,
    v_entitlement.license_key_id,
    COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[]),
    v_entitlement.status,
    v_entitlement.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_revoke_entitlement_exact(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_revoke_entitlement_exact(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT
) TO service_role;

-- Cancellation and true provider suspension use the established
-- entitlement-first revocation lock canon.
-- The queue snapshot is validated without a lock; only after the entitlement
-- transition commits its exact evidence do we CAS the still-current processing
-- claim and generation.  A CAS miss raises, rolling the entire transition back.
CREATE OR REPLACE FUNCTION public.commerce_revoke_subscription_fulfillment(
  p_action_id UUID,
  p_claim_token UUID,
  p_entitlement_id UUID,
  p_guild_id TEXT,
  p_order_id UUID,
  p_customer_id UUID,
  p_discord_id TEXT,
  p_product_id UUID,
  p_plan_id UUID,
  p_paypal_subscription_id TEXT,
  p_fulfillment_type TEXT,
  p_expected_status TEXT,
  p_expected_updated_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_queue_snapshot public.bot_action_queue%ROWTYPE;
  v_revoke RECORD;
  v_entitlement public.entitlements%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_outward_generation_id UUID;
  v_action_name TEXT;
  v_reason TEXT;
  v_lifecycle_event public.commerce_subscription_lifecycle_events%ROWTYPE;
  v_lifecycle_head public.commerce_subscription_lifecycle_heads%ROWTYPE;
BEGIN
  IF p_action_id IS NULL
     OR p_claim_token IS NULL
     OR p_entitlement_id IS NULL
     OR p_order_id IS NULL
     OR p_customer_id IS NULL
     OR p_discord_id IS NULL
     OR p_discord_id = ''
     OR p_discord_id <> pg_catalog.btrim(p_discord_id)
     OR p_product_id IS NULL
     OR p_plan_id IS NULL
     OR p_paypal_subscription_id IS NULL
     OR p_paypal_subscription_id = ''
     OR p_paypal_subscription_id <> pg_catalog.btrim(p_paypal_subscription_id)
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_fulfillment_type NOT IN (
       'subscription_cancelled',
       'subscription_suspended'
     )
     OR p_expected_updated_at IS NULL
     OR NOT pg_catalog.isfinite(p_expected_updated_at) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_subscription_fulfillment: exact action identity is required';
  END IF;
  v_action_name := CASE p_fulfillment_type
    WHEN 'subscription_cancelled' THEN 'fulfill_cancellation'
    ELSE 'fulfill_suspension'
  END;
  v_reason := CASE p_fulfillment_type
    WHEN 'subscription_cancelled' THEN 'cancelled'
    ELSE 'suspended'
  END;

  SELECT queue.*
    INTO v_queue_snapshot
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id;
  IF NOT FOUND
     OR v_queue_snapshot.status IS DISTINCT FROM 'processing'
     OR v_queue_snapshot.claim_token IS DISTINCT FROM p_claim_token
     OR v_queue_snapshot.guild_id IS DISTINCT FROM p_guild_id
     OR v_queue_snapshot.action IS DISTINCT FROM v_action_name
     OR v_queue_snapshot.lane IS DISTINCT FROM 'commerce'
     OR pg_catalog.jsonb_typeof(v_queue_snapshot.payload) IS DISTINCT FROM 'object'
     OR v_queue_snapshot.payload ->> 'fulfillment_type'
          IS DISTINCT FROM p_fulfillment_type
     OR v_queue_snapshot.payload ->> 'guild_id' IS DISTINCT FROM p_guild_id
     OR v_queue_snapshot.payload ->> 'order_id' IS DISTINCT FROM p_order_id::TEXT
     OR v_queue_snapshot.payload ->> 'customer_id'
          IS DISTINCT FROM p_customer_id::TEXT
     OR v_queue_snapshot.payload ->> 'discord_id' IS DISTINCT FROM p_discord_id
     OR v_queue_snapshot.payload ->> 'product_id'
          IS DISTINCT FROM p_product_id::TEXT
     OR v_queue_snapshot.payload ->> 'plan_id' IS DISTINCT FROM p_plan_id::TEXT
     OR v_queue_snapshot.payload ->> 'paypal_subscription_id'
          IS DISTINCT FROM p_paypal_subscription_id
     OR v_queue_snapshot.payload ->> 'order_number' IS NULL
     OR pg_catalog.btrim(
          v_queue_snapshot.payload ->> 'order_number'
        ) = ''
     OR v_queue_snapshot.payload ->> 'product_name' IS NULL
     OR pg_catalog.btrim(
          v_queue_snapshot.payload ->> 'product_name'
        ) = ''
     OR pg_catalog.jsonb_typeof(
          v_queue_snapshot.payload -> 'amount_cents'
        ) IS DISTINCT FROM 'number'
     OR (v_queue_snapshot.payload ->> 'amount_cents')
          !~ '^(0|[1-9][0-9]*)$'
     OR v_queue_snapshot.payload ->> 'currency' !~ '^[A-Z]{3}$'
     OR v_queue_snapshot.payload ->> 'webhook_event_id' IS NULL
     OR pg_catalog.jsonb_typeof(
          v_queue_snapshot.payload -> 'lifecycle_generation'
        ) IS DISTINCT FROM 'number'
     OR v_queue_snapshot.payload ->> 'entitlement_type'
          IS DISTINCT FROM 'subscription' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_subscription_fulfillment: queue action identity mismatch';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'commerce-guild-purge:' || p_guild_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-subscription-lifecycle:' || p_paypal_subscription_id,
      0
    )
  );
  SELECT event_row.*
    INTO v_lifecycle_event
    FROM public.commerce_subscription_lifecycle_events AS event_row
   WHERE event_row.webhook_event_id
           = v_queue_snapshot.payload ->> 'webhook_event_id'
     AND event_row.paypal_subscription_id = p_paypal_subscription_id
     AND event_row.order_id = p_order_id
     AND event_row.guild_id = p_guild_id
     AND event_row.customer_id = p_customer_id
     AND event_row.product_id = p_product_id
     AND event_row.plan_id = p_plan_id
     AND event_row.generation
           = (v_queue_snapshot.payload ->> 'lifecycle_generation')::BIGINT
     AND event_row.disposition = 'accepted'
     AND (
       (
         p_fulfillment_type = 'subscription_cancelled'
         AND event_row.provider_event_type IN (
           'BILLING.SUBSCRIPTION.CANCELLED',
           'BILLING.SUBSCRIPTION.EXPIRED'
         )
       )
       OR (
         p_fulfillment_type = 'subscription_suspended'
         AND event_row.provider_event_type =
           'BILLING.SUBSCRIPTION.SUSPENDED'
       )
     )
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_subscription_fulfillment: lifecycle event identity mismatch';
  END IF;
  SELECT head.*
    INTO v_lifecycle_head
    FROM public.commerce_subscription_lifecycle_heads AS head
   WHERE head.paypal_subscription_id = p_paypal_subscription_id
     AND head.order_id = p_order_id
     AND head.guild_id = p_guild_id
     AND head.customer_id = p_customer_id
     AND head.product_id = p_product_id
     AND head.plan_id = p_plan_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_subscription_fulfillment: lifecycle head identity mismatch';
  END IF;
  IF v_lifecycle_head.last_webhook_event_id
       IS DISTINCT FROM v_lifecycle_event.webhook_event_id
     OR v_lifecycle_head.generation
       IS DISTINCT FROM v_lifecycle_event.generation THEN
    RETURN pg_catalog.jsonb_build_object(
      'action_id', p_action_id,
      'claim_token', p_claim_token,
      'order_id', p_order_id,
      'order_number', v_queue_snapshot.payload ->> 'order_number',
      'guild_id', p_guild_id,
      'entitlement_id', p_entitlement_id,
      'customer_id', p_customer_id,
      'discord_id', p_discord_id,
      'product_id', p_product_id,
      'product_name', v_queue_snapshot.payload ->> 'product_name',
      'plan_id', p_plan_id,
      'paypal_subscription_id', p_paypal_subscription_id,
      'amount_cents', (v_queue_snapshot.payload ->> 'amount_cents')::INTEGER,
      'currency', v_queue_snapshot.payload ->> 'currency',
      'transition_id', NULL,
      'disposition', 'noop',
      'status', p_expected_status,
      'updated_at', p_expected_updated_at,
      'outward_generation_id', NULL,
      'lifecycle_authority', 'superseded'
    );
  END IF;

  SELECT *
    INTO v_revoke
    FROM public.commerce_revoke_entitlement_exact(
      p_entitlement_id,
      p_guild_id,
      p_expected_status,
      p_expected_updated_at,
      v_reason
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_revoke_subscription_fulfillment: revocation evidence disappeared';
  END IF;

  IF v_revoke.entitlement_id IS NOT NULL THEN
    SELECT entitlement.*
      INTO v_entitlement
      FROM public.entitlements AS entitlement
     WHERE entitlement.id = p_entitlement_id
       AND entitlement.guild_id = p_guild_id
     FOR SHARE;
    IF NOT FOUND
       OR v_entitlement.customer_id IS DISTINCT FROM p_customer_id
       OR v_entitlement.product_id IS DISTINCT FROM p_product_id
       OR v_entitlement.order_id IS DISTINCT FROM p_order_id
       OR v_entitlement.plan_id IS DISTINCT FROM p_plan_id
       OR v_entitlement.type IS DISTINCT FROM 'subscription'
       OR NOT COALESCE(
         v_entitlement.source = 'purchase' OR v_entitlement.source IS NULL,
         false
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_revoke_subscription_fulfillment: entitlement identity mismatch';
    END IF;
  END IF;

  IF v_revoke.entitlement_id IS NOT NULL
     AND (
       v_revoke.entitlement_id IS DISTINCT FROM p_entitlement_id
       OR v_revoke.guild_id IS DISTINCT FROM p_guild_id
       OR v_revoke.customer_id IS DISTINCT FROM p_customer_id
       OR v_revoke.product_id IS DISTINCT FROM p_product_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_subscription_fulfillment: entitlement identity mismatch';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
     AND paid_order.product_id = p_product_id
     AND paid_order.plan_id = p_plan_id
     AND paid_order.paypal_subscription_id = p_paypal_subscription_id
     AND paid_order.paypal_order_id IS NULL
     AND paid_order.status IN ('completed', 'pending_review')
     AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
   FOR KEY SHARE;
  IF NOT FOUND
     OR v_queue_snapshot.payload ->> 'order_number'
          IS DISTINCT FROM v_order.order_number
     OR v_queue_snapshot.payload ->> 'discord_id'
          IS DISTINCT FROM p_discord_id
     OR v_queue_snapshot.payload ->> 'product_name' IS NULL
     OR pg_catalog.btrim(
       v_queue_snapshot.payload ->> 'product_name'
     ) = ''
     OR pg_catalog.jsonb_typeof(
          v_queue_snapshot.payload -> 'amount_cents'
        ) IS DISTINCT FROM 'number'
     OR (v_queue_snapshot.payload ->> 'amount_cents')::NUMERIC
          IS DISTINCT FROM v_order.amount_cents::NUMERIC
     OR v_queue_snapshot.payload ->> 'currency'
          IS DISTINCT FROM v_order.currency
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_queue_snapshot.payload -> 'granted_role_ids',
       '{}'::TEXT[]
     )
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_queue_snapshot.payload -> 'granted_channel_ids',
       '{}'::TEXT[]
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_revoke_subscription_fulfillment: paid action contract mismatch';
  END IF;

  IF v_revoke.disposition = 'applied' THEN
    v_outward_generation_id := pg_catalog.gen_random_uuid();
    UPDATE public.bot_action_queue AS queue
       SET outward_generation_id = v_outward_generation_id
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token
       AND queue.outward_generation_id IS NULL
       AND queue.guild_id = p_guild_id
       AND queue.action = v_action_name
       AND queue.lane = 'commerce'
       AND queue.payload = v_queue_snapshot.payload
       AND queue.payload ->> 'fulfillment_type' = p_fulfillment_type
       AND queue.payload ->> 'order_id' = p_order_id::TEXT
       AND queue.payload ->> 'customer_id' = p_customer_id::TEXT
       AND queue.payload ->> 'product_id' = p_product_id::TEXT
    RETURNING queue.outward_generation_id INTO v_outward_generation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_revoke_subscription_fulfillment: action generation CAS raced';
    END IF;
  ELSIF v_revoke.disposition = 'noop' THEN
    SELECT queue.outward_generation_id
      INTO v_outward_generation_id
      FROM public.bot_action_queue AS queue
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token
       AND queue.guild_id = p_guild_id
       AND queue.action = v_action_name
       AND queue.lane = 'commerce'
       AND queue.payload = v_queue_snapshot.payload
       AND queue.payload ->> 'fulfillment_type' = p_fulfillment_type
       AND queue.payload ->> 'order_id' = p_order_id::TEXT
       AND queue.outward_generation_id IS NOT NULL
     FOR UPDATE;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'action_id', p_action_id,
    'claim_token', p_claim_token,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'guild_id', p_guild_id,
    'entitlement_id', v_revoke.entitlement_id,
    'customer_id', p_customer_id,
    'discord_id', v_queue_snapshot.payload ->> 'discord_id',
    'product_id', p_product_id,
    'product_name', v_queue_snapshot.payload ->> 'product_name',
    'plan_id', p_plan_id,
    'paypal_subscription_id', p_paypal_subscription_id,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency,
    'transition_id', v_revoke.transition_id,
    'disposition', v_revoke.disposition,
    'status', v_revoke.status,
    'updated_at', v_revoke.updated_at,
    'outward_generation_id', v_outward_generation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_revoke_subscription_fulfillment(
  UUID, UUID, UUID, TEXT, UUID, UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_revoke_subscription_fulfillment(
  UUID, UUID, UUID, TEXT, UUID, UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_start_payment_failure_grace_fulfillment(
  p_action_id UUID,
  p_claim_token UUID,
  p_entitlement_id UUID,
  p_guild_id TEXT,
  p_order_id UUID,
  p_customer_id UUID,
  p_discord_id TEXT,
  p_product_id UUID,
  p_plan_id UUID,
  p_paypal_subscription_id TEXT,
  p_expected_status TEXT,
  p_expected_updated_at TIMESTAMPTZ,
  p_grace_period_days INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_queue_snapshot public.bot_action_queue%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_grace_period_ends_at TIMESTAMPTZ;
  v_outward_generation_id UUID;
  v_disposition TEXT;
  v_lifecycle_event public.commerce_subscription_lifecycle_events%ROWTYPE;
  v_lifecycle_head public.commerce_subscription_lifecycle_heads%ROWTYPE;
BEGIN
  IF p_action_id IS NULL
     OR p_claim_token IS NULL
     OR p_entitlement_id IS NULL
     OR p_order_id IS NULL
     OR p_customer_id IS NULL
     OR p_discord_id IS NULL
     OR p_discord_id = ''
     OR p_discord_id <> pg_catalog.btrim(p_discord_id)
     OR p_product_id IS NULL
     OR p_plan_id IS NULL
     OR p_paypal_subscription_id IS NULL
     OR p_paypal_subscription_id = ''
     OR p_paypal_subscription_id <> pg_catalog.btrim(p_paypal_subscription_id)
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_expected_status NOT IN ('active', 'grace_period', 'suspended')
     OR p_expected_updated_at IS NULL
     OR NOT pg_catalog.isfinite(p_expected_updated_at)
     OR p_grace_period_days IS NULL
     OR p_grace_period_days < 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_start_payment_failure_grace_fulfillment: exact action identity is required';
  END IF;

  -- Snapshot only: do not lock queue before the entitlement row.
  SELECT queue.*
    INTO v_queue_snapshot
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id;
  IF NOT FOUND
     OR v_queue_snapshot.status IS DISTINCT FROM 'processing'
     OR v_queue_snapshot.claim_token IS DISTINCT FROM p_claim_token
     OR v_queue_snapshot.guild_id IS DISTINCT FROM p_guild_id
     OR v_queue_snapshot.action IS DISTINCT FROM 'fulfill_suspension'
     OR v_queue_snapshot.lane IS DISTINCT FROM 'commerce'
     OR pg_catalog.jsonb_typeof(v_queue_snapshot.payload) IS DISTINCT FROM 'object'
     OR v_queue_snapshot.payload ->> 'fulfillment_type'
          IS DISTINCT FROM 'subscription_payment_failed'
     OR v_queue_snapshot.payload ->> 'guild_id' IS DISTINCT FROM p_guild_id
     OR v_queue_snapshot.payload ->> 'order_id' IS DISTINCT FROM p_order_id::TEXT
     OR v_queue_snapshot.payload ->> 'customer_id'
          IS DISTINCT FROM p_customer_id::TEXT
     OR v_queue_snapshot.payload ->> 'discord_id' IS DISTINCT FROM p_discord_id
     OR v_queue_snapshot.payload ->> 'product_id'
          IS DISTINCT FROM p_product_id::TEXT
     OR v_queue_snapshot.payload ->> 'plan_id' IS DISTINCT FROM p_plan_id::TEXT
     OR v_queue_snapshot.payload ->> 'paypal_subscription_id'
          IS DISTINCT FROM p_paypal_subscription_id
     OR v_queue_snapshot.payload ->> 'order_number' IS NULL
     OR pg_catalog.btrim(
          v_queue_snapshot.payload ->> 'order_number'
        ) = ''
     OR v_queue_snapshot.payload ->> 'product_name' IS NULL
     OR pg_catalog.btrim(
          v_queue_snapshot.payload ->> 'product_name'
        ) = ''
     OR pg_catalog.jsonb_typeof(
          v_queue_snapshot.payload -> 'amount_cents'
        ) IS DISTINCT FROM 'number'
     OR (v_queue_snapshot.payload ->> 'amount_cents')
          !~ '^(0|[1-9][0-9]*)$'
     OR v_queue_snapshot.payload ->> 'currency' !~ '^[A-Z]{3}$'
     OR v_queue_snapshot.payload ->> 'webhook_event_id' IS NULL
     OR pg_catalog.jsonb_typeof(
          v_queue_snapshot.payload -> 'lifecycle_generation'
        ) IS DISTINCT FROM 'number'
     OR v_queue_snapshot.payload ->> 'entitlement_type'
          IS DISTINCT FROM 'subscription' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_start_payment_failure_grace_fulfillment: queue action identity mismatch';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'commerce-guild-purge:' || p_guild_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-subscription-lifecycle:' || p_paypal_subscription_id,
      0
    )
  );
  SELECT event_row.*
    INTO v_lifecycle_event
    FROM public.commerce_subscription_lifecycle_events AS event_row
   WHERE event_row.webhook_event_id
           = v_queue_snapshot.payload ->> 'webhook_event_id'
     AND event_row.paypal_subscription_id = p_paypal_subscription_id
     AND event_row.order_id = p_order_id
     AND event_row.guild_id = p_guild_id
     AND event_row.customer_id = p_customer_id
     AND event_row.product_id = p_product_id
     AND event_row.plan_id = p_plan_id
     AND event_row.generation
           = (v_queue_snapshot.payload ->> 'lifecycle_generation')::BIGINT
     AND event_row.disposition = 'accepted'
     AND event_row.provider_event_type =
       'BILLING.SUBSCRIPTION.PAYMENT.FAILED'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_start_payment_failure_grace_fulfillment: lifecycle event identity mismatch';
  END IF;
  SELECT head.*
    INTO v_lifecycle_head
    FROM public.commerce_subscription_lifecycle_heads AS head
   WHERE head.paypal_subscription_id = p_paypal_subscription_id
     AND head.order_id = p_order_id
     AND head.guild_id = p_guild_id
     AND head.customer_id = p_customer_id
     AND head.product_id = p_product_id
     AND head.plan_id = p_plan_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_start_payment_failure_grace_fulfillment: lifecycle head identity mismatch';
  END IF;
  IF v_lifecycle_head.last_webhook_event_id
       IS DISTINCT FROM v_lifecycle_event.webhook_event_id
     OR v_lifecycle_head.generation
       IS DISTINCT FROM v_lifecycle_event.generation THEN
    RETURN pg_catalog.jsonb_build_object(
      'action_id', p_action_id,
      'claim_token', p_claim_token,
      'order_id', p_order_id,
      'order_number', v_queue_snapshot.payload ->> 'order_number',
      'guild_id', p_guild_id,
      'entitlement_id', p_entitlement_id,
      'customer_id', p_customer_id,
      'discord_id', p_discord_id,
      'product_id', p_product_id,
      'product_name', v_queue_snapshot.payload ->> 'product_name',
      'plan_id', p_plan_id,
      'paypal_subscription_id', p_paypal_subscription_id,
      'amount_cents', (v_queue_snapshot.payload ->> 'amount_cents')::INTEGER,
      'currency', v_queue_snapshot.payload ->> 'currency',
      'disposition', 'noop',
      'status', p_expected_status,
      'updated_at', p_expected_updated_at,
      'grace_period_ends_at', NULL,
      'outward_generation_id', NULL,
      'lifecycle_authority', 'superseded'
    );
  END IF;

  SELECT entitlement.*
    INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
     AND entitlement.guild_id = p_guild_id
   FOR UPDATE;
  IF FOUND AND (
     v_entitlement.customer_id IS DISTINCT FROM p_customer_id
     OR v_entitlement.product_id IS DISTINCT FROM p_product_id
     OR v_entitlement.order_id IS DISTINCT FROM p_order_id
     OR v_entitlement.plan_id IS DISTINCT FROM p_plan_id
     OR v_entitlement.type IS DISTINCT FROM 'subscription'
     OR NOT COALESCE(
       v_entitlement.source = 'purchase' OR v_entitlement.source IS NULL,
       false
     )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_start_payment_failure_grace_fulfillment: entitlement identity mismatch';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'noncommerce-entitlement-customer:' || p_customer_id::TEXT,
      0
    )
  );
  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
     AND paid_order.product_id = p_product_id
     AND paid_order.plan_id = p_plan_id
     AND paid_order.paypal_subscription_id = p_paypal_subscription_id
     AND paid_order.paypal_order_id IS NULL
     AND paid_order.status IN ('completed', 'pending_review')
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_start_payment_failure_grace_fulfillment: paid order identity mismatch';
  END IF;
  IF v_queue_snapshot.payload ->> 'order_number'
       IS DISTINCT FROM v_order.order_number
     OR v_queue_snapshot.payload ->> 'discord_id'
       IS DISTINCT FROM p_discord_id
     OR v_queue_snapshot.payload ->> 'product_name' IS NULL
     OR pg_catalog.btrim(
       v_queue_snapshot.payload ->> 'product_name'
     ) = ''
     OR pg_catalog.jsonb_typeof(v_queue_snapshot.payload -> 'amount_cents')
       IS DISTINCT FROM 'number'
     OR (v_queue_snapshot.payload ->> 'amount_cents')::NUMERIC
       IS DISTINCT FROM v_order.amount_cents::NUMERIC
     OR v_queue_snapshot.payload ->> 'currency'
       IS DISTINCT FROM v_order.currency
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_queue_snapshot.payload -> 'granted_role_ids',
       '{}'::TEXT[]
     )
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_queue_snapshot.payload -> 'granted_channel_ids',
       '{}'::TEXT[]
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_start_payment_failure_grace_fulfillment: paid action contract mismatch';
  END IF;
  -- Preserve the historical queue carrier in the existing return structure;
  -- these fields are deliberately not read from mutable customer/catalog rows.
  v_customer.discord_id := v_queue_snapshot.payload ->> 'discord_id';
  v_product.name := v_queue_snapshot.payload ->> 'product_name';

  IF v_entitlement.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'action_id', p_action_id,
      'claim_token', p_claim_token,
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'guild_id', p_guild_id,
      'entitlement_id', NULL,
      'customer_id', p_customer_id,
      'discord_id', v_customer.discord_id,
      'product_id', p_product_id,
      'product_name', v_product.name,
      'plan_id', p_plan_id,
      'paypal_subscription_id', p_paypal_subscription_id,
      'amount_cents', v_order.amount_cents,
      'currency', v_order.currency,
      'disposition', 'not_found',
      'status', NULL,
      'updated_at', NULL,
      'outward_generation_id', NULL,
      'grace_period_ends_at', NULL
    );
  END IF;

  -- Exact same action recovery wins over the terminal-state classifier.
  SELECT queue.outward_generation_id
    INTO v_outward_generation_id
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
     AND queue.guild_id = p_guild_id
     AND queue.action = 'fulfill_suspension'
     AND queue.lane = 'commerce'
     AND queue.payload = v_queue_snapshot.payload
     AND queue.outward_generation_id IS NOT NULL
   FOR UPDATE;
  IF FOUND THEN
    IF v_entitlement.status IS DISTINCT FROM 'grace_period'
       OR v_entitlement.grace_period_ends_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_start_payment_failure_grace_fulfillment: replay evidence mismatch';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'action_id', p_action_id,
      'claim_token', p_claim_token,
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'guild_id', p_guild_id,
      'entitlement_id', v_entitlement.id,
      'customer_id', v_entitlement.customer_id,
      'discord_id', v_customer.discord_id,
      'product_id', v_entitlement.product_id,
      'product_name', v_product.name,
      'plan_id', p_plan_id,
      'paypal_subscription_id', p_paypal_subscription_id,
      'amount_cents', v_order.amount_cents,
      'currency', v_order.currency,
      'disposition', 'replay',
      'status', v_entitlement.status,
      'updated_at', v_entitlement.updated_at,
      'outward_generation_id', v_outward_generation_id,
      'grace_period_ends_at', v_entitlement.grace_period_ends_at
    );
  END IF;

  IF v_entitlement.status IN ('cancelled', 'expired') THEN
    RETURN pg_catalog.jsonb_build_object(
      'action_id', p_action_id,
      'claim_token', p_claim_token,
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'guild_id', p_guild_id,
      'entitlement_id', v_entitlement.id,
      'customer_id', v_entitlement.customer_id,
      'discord_id', v_customer.discord_id,
      'product_id', v_entitlement.product_id,
      'product_name', v_product.name,
      'plan_id', p_plan_id,
      'paypal_subscription_id', p_paypal_subscription_id,
      'amount_cents', v_order.amount_cents,
      'currency', v_order.currency,
      'disposition', 'noop',
      'status', v_entitlement.status,
      'updated_at', v_entitlement.updated_at,
      'outward_generation_id', NULL,
      'grace_period_ends_at', v_entitlement.grace_period_ends_at
    );
  END IF;
  IF v_entitlement.status IN ('grace_period', 'suspended') THEN
    RETURN pg_catalog.jsonb_build_object(
      'action_id', p_action_id,
      'claim_token', p_claim_token,
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'guild_id', p_guild_id,
      'entitlement_id', v_entitlement.id,
      'customer_id', v_entitlement.customer_id,
      'discord_id', v_customer.discord_id,
      'product_id', v_entitlement.product_id,
      'product_name', v_product.name,
      'plan_id', p_plan_id,
      'paypal_subscription_id', p_paypal_subscription_id,
      'amount_cents', v_order.amount_cents,
      'currency', v_order.currency,
      'disposition', 'noop',
      'status', v_entitlement.status,
      'updated_at', v_entitlement.updated_at,
      'outward_generation_id', NULL,
      'grace_period_ends_at', v_entitlement.grace_period_ends_at
    );
  END IF;
  IF v_entitlement.status IS DISTINCT FROM p_expected_status
     OR v_entitlement.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN pg_catalog.jsonb_build_object(
      'action_id', p_action_id,
      'claim_token', p_claim_token,
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'guild_id', p_guild_id,
      'entitlement_id', v_entitlement.id,
      'customer_id', v_entitlement.customer_id,
      'discord_id', v_customer.discord_id,
      'product_id', v_entitlement.product_id,
      'product_name', v_product.name,
      'plan_id', p_plan_id,
      'paypal_subscription_id', p_paypal_subscription_id,
      'amount_cents', v_order.amount_cents,
      'currency', v_order.currency,
      'disposition', 'stale',
      'status', v_entitlement.status,
      'updated_at', v_entitlement.updated_at,
      'outward_generation_id', NULL,
      'grace_period_ends_at', v_entitlement.grace_period_ends_at
    );
  END IF;

  v_grace_period_ends_at := pg_catalog.clock_timestamp()
    + pg_catalog.make_interval(days => p_grace_period_days);
  UPDATE public.entitlements AS entitlement
     SET status = 'grace_period',
         grace_period_ends_at = v_grace_period_ends_at
   WHERE entitlement.id = p_entitlement_id
     AND entitlement.guild_id = p_guild_id
     AND entitlement.status = p_expected_status
     AND entitlement.updated_at = p_expected_updated_at
  RETURNING entitlement.* INTO v_entitlement;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_start_payment_failure_grace_fulfillment: entitlement transition raced';
  END IF;

  v_outward_generation_id := pg_catalog.gen_random_uuid();
  UPDATE public.bot_action_queue AS queue
     SET outward_generation_id = v_outward_generation_id
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
     AND queue.outward_generation_id IS NULL
     AND queue.guild_id = p_guild_id
     AND queue.action = 'fulfill_suspension'
     AND queue.lane = 'commerce'
     AND queue.payload = v_queue_snapshot.payload
     AND queue.payload ->> 'fulfillment_type' = 'subscription_payment_failed'
     AND queue.payload ->> 'order_id' = p_order_id::TEXT
     AND queue.payload ->> 'customer_id' = p_customer_id::TEXT
     AND queue.payload ->> 'product_id' = p_product_id::TEXT
  RETURNING queue.outward_generation_id INTO v_outward_generation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_start_payment_failure_grace_fulfillment: action generation CAS raced';
  END IF;
  v_disposition := 'applied';

  RETURN pg_catalog.jsonb_build_object(
    'action_id', p_action_id,
    'claim_token', p_claim_token,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'guild_id', p_guild_id,
    'entitlement_id', v_entitlement.id,
    'customer_id', v_entitlement.customer_id,
    'discord_id', v_customer.discord_id,
    'product_id', v_entitlement.product_id,
    'product_name', v_product.name,
    'plan_id', p_plan_id,
    'paypal_subscription_id', p_paypal_subscription_id,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency,
    'disposition', v_disposition,
    'status', v_entitlement.status,
    'updated_at', v_entitlement.updated_at,
    'outward_generation_id', v_outward_generation_id,
    'grace_period_ends_at', v_entitlement.grace_period_ends_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_start_payment_failure_grace_fulfillment(
  UUID, UUID, UUID, TEXT, UUID, UUID, TEXT, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_start_payment_failure_grace_fulfillment(
  UUID, UUID, UUID, TEXT, UUID, UUID, TEXT, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, INTEGER
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_prepare_action_outward_generation(
  p_action_id UUID,
  p_claim_token UUID,
  p_guild_id TEXT,
  p_order_id UUID,
  p_customer_id UUID,
  p_discord_id TEXT,
  p_product_id UUID,
  p_order_number TEXT,
  p_product_name TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_license_key_id UUID,
  p_license_key_plaintext TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_queue_snapshot public.bot_action_queue%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_license_key public.license_keys%ROWTYPE;
  v_outward_generation_id UUID;
  v_disposition TEXT;
BEGIN
  IF p_action_id IS NULL
     OR p_claim_token IS NULL
     OR p_order_id IS NULL
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id = ''
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_discord_id IS NULL
     OR p_discord_id = ''
     OR p_discord_id <> pg_catalog.btrim(p_discord_id)
     OR p_order_number IS NULL
     OR p_order_number = ''
     OR p_order_number <> pg_catalog.btrim(p_order_number)
     OR p_product_name IS NULL
     OR p_product_name = ''
     OR p_product_name <> pg_catalog.btrim(p_product_name)
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[A-Z]{3}$'
     OR (p_license_key_id IS NULL) IS DISTINCT FROM
          (p_license_key_plaintext IS NULL)
     OR (
       p_license_key_plaintext IS NOT NULL
       AND (
         p_license_key_plaintext = ''
         OR p_license_key_plaintext <> pg_catalog.btrim(p_license_key_plaintext)
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_action_outward_generation: exact action identity is required';
  END IF;

  SELECT queue.*
    INTO v_queue_snapshot
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id;
  IF NOT FOUND
     OR v_queue_snapshot.status IS DISTINCT FROM 'processing'
     OR v_queue_snapshot.claim_token IS DISTINCT FROM p_claim_token
     OR v_queue_snapshot.guild_id IS DISTINCT FROM p_guild_id
     OR v_queue_snapshot.action IS DISTINCT FROM 'deliver_receipt'
     OR v_queue_snapshot.lane IS DISTINCT FROM 'commerce'
     OR pg_catalog.jsonb_typeof(v_queue_snapshot.payload) IS DISTINCT FROM 'object'
     OR v_queue_snapshot.payload ->> 'guild_id' IS DISTINCT FROM p_guild_id
     OR v_queue_snapshot.payload ->> 'order_id' IS DISTINCT FROM p_order_id::TEXT
     OR v_queue_snapshot.payload ->> 'customer_id'
          IS DISTINCT FROM p_customer_id::TEXT
     OR v_queue_snapshot.payload ->> 'discord_id' IS DISTINCT FROM p_discord_id
     OR v_queue_snapshot.payload ->> 'product_id'
          IS DISTINCT FROM p_product_id::TEXT
     OR v_queue_snapshot.payload ->> 'order_number'
          IS DISTINCT FROM p_order_number
     OR v_queue_snapshot.payload ->> 'product_name'
          IS DISTINCT FROM p_product_name
     OR pg_catalog.jsonb_typeof(v_queue_snapshot.payload -> 'amount_cents')
          IS DISTINCT FROM 'number'
     OR (v_queue_snapshot.payload ->> 'amount_cents')::NUMERIC
          IS DISTINCT FROM p_amount_cents::NUMERIC
     OR pg_catalog.upper(v_queue_snapshot.payload ->> 'currency')
          IS DISTINCT FROM p_currency
     OR v_queue_snapshot.payload ->> 'license_key_id'
          IS DISTINCT FROM p_license_key_id::TEXT
     OR v_queue_snapshot.payload ->> 'license_key_plaintext'
          IS DISTINCT FROM p_license_key_plaintext THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_action_outward_generation: queue action identity mismatch';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_guild_id || E'\x1f'
        || p_customer_id::TEXT || E'\x1f'
        || p_product_id::TEXT,
      0
    )
  );
  SELECT customer.*
    INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = p_customer_id
     AND customer.guild_id = p_guild_id
     AND customer.discord_id = p_discord_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_action_outward_generation: customer identity mismatch';
  END IF;
  SELECT product.*
    INTO v_product
    FROM public.products AS product
   WHERE product.id = p_product_id
     AND product.guild_id = p_guild_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_action_outward_generation: product identity mismatch';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
     AND paid_order.product_id = p_product_id
     AND paid_order.order_number = p_order_number
     AND paid_order.amount_cents = p_amount_cents
     AND pg_catalog.upper(paid_order.currency) = p_currency
     AND paid_order.status IN ('completed', 'pending_review')
     AND (paid_order.source = 'purchase' OR paid_order.source IS NULL)
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_action_outward_generation: paid order identity mismatch';
  END IF;

  IF (
       v_order.delivery_type_snapshot = 'license_key'
       AND p_license_key_id IS NULL
     )
     OR (
       v_order.delivery_type_snapshot IS DISTINCT FROM 'license_key'
       AND p_license_key_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_action_outward_generation: frozen delivery shape mismatch';
  END IF;

  IF p_license_key_id IS NOT NULL THEN
    SELECT license_key.*
      INTO v_license_key
      FROM public.license_keys AS license_key
     WHERE license_key.id = p_license_key_id
       AND license_key.order_id = p_order_id
       AND license_key.customer_id = p_customer_id
       AND license_key.product_id = p_product_id
       AND license_key.guild_id = p_guild_id
       AND license_key.bound_discord_id = p_discord_id
       AND license_key.status IN ('pending_activation', 'active', 'suspended')
       AND license_key.key_hash = pg_catalog.encode(
         extensions.digest(p_license_key_plaintext, 'sha256'),
         'hex'
       )
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_prepare_action_outward_generation: license identity mismatch';
    END IF;
  END IF;

  SELECT queue.outward_generation_id
    INTO v_outward_generation_id
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
     AND queue.guild_id = p_guild_id
     AND queue.action = 'deliver_receipt'
     AND queue.lane = 'commerce'
     AND queue.payload = v_queue_snapshot.payload
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_prepare_action_outward_generation: action claim raced';
  END IF;

  IF v_outward_generation_id IS NOT NULL THEN
    v_disposition := 'replay';
  ELSE
    v_outward_generation_id := pg_catalog.gen_random_uuid();
    UPDATE public.bot_action_queue AS queue
       SET outward_generation_id = v_outward_generation_id
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token
       AND queue.outward_generation_id IS NULL
       AND queue.guild_id = p_guild_id
       AND queue.action = 'deliver_receipt'
       AND queue.lane = 'commerce'
       AND queue.payload = v_queue_snapshot.payload
    RETURNING queue.outward_generation_id INTO v_outward_generation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_prepare_action_outward_generation: generation CAS raced';
    END IF;
    v_disposition := 'prepared';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'action_id', p_action_id,
    'claim_token', p_claim_token,
    'order_id', p_order_id,
    'guild_id', p_guild_id,
    'customer_id', p_customer_id,
    'discord_id', p_discord_id,
    'product_id', p_product_id,
    'order_number', p_order_number,
    'product_name', p_product_name,
    'amount_cents', p_amount_cents,
    'currency', p_currency,
    'license_key_id', p_license_key_id,
    'disposition', v_disposition,
    'outward_generation_id', v_outward_generation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_prepare_action_outward_generation(
  UUID, UUID, TEXT, UUID, UUID, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_prepare_action_outward_generation(
  UUID, UUID, TEXT, UUID, UUID, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, UUID, TEXT
) TO service_role;

-- Queue completion is a composite protocol for commerce actions whose role or
-- entitlement mutation commits before the externally visible event/DM.  The
-- action row is locked first.  Fresh outward creation takes that same row FOR
-- SHARE, so an absent-row classification cannot race a new sender.
CREATE OR REPLACE FUNCTION public.commerce_classify_action_outward_state(
  p_action_id UUID,
  p_claim_token UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_generation UUID;
  v_order_id UUID;
  v_required_kinds TEXT[];
  v_required_count INTEGER;
  v_resolved_count INTEGER;
  v_has_legacy_rows BOOLEAN := false;
BEGIN
  SELECT queue.*
    INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'stale_claim';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-role-delivery-action:' || p_action_id::TEXT,
      0
    )
  );
  SELECT intent.*
    INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.action_id = p_action_id
      OR intent.cleanup_action_id = p_action_id
   ORDER BY CASE WHEN intent.action_id = p_action_id THEN 0 ELSE 1 END
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    -- A bound attempt with a live mutation token owns this carrier. Generic
    -- queue finalization/recovery must never run behind the binder and
    -- reclassify that in-flight attempt through the legacy no-intent path.
    IF v_intent.mutation_token IS NOT NULL
       OR v_intent.cleanup_mutation_token IS NOT NULL THEN
      RETURN 'intent_raced';
    END IF;
    IF v_intent.action_id IS DISTINCT FROM p_action_id
       OR v_intent.contract_kind IS DISTINCT FROM 'paid'
       OR v_intent.delivery_confirmed_at IS NULL
       OR v_intent.last_delivery_outcome IS DISTINCT FROM 'live'
    THEN
      RETURN 'delegate';
    END IF;
    v_generation := v_intent.outward_generation_id;
    v_order_id := v_intent.order_id;
    IF v_action.guild_id IS DISTINCT FROM v_intent.guild_id
       OR v_action.payload ->> 'guild_id' IS DISTINCT FROM v_intent.guild_id
       OR v_action.payload ->> 'order_id' IS DISTINCT FROM v_intent.order_id::TEXT THEN
      RETURN 'operator_held';
    END IF;
    IF v_action.action = 'fulfill_purchase'
       AND v_action.payload ->> 'fulfillment_type' = 'one_time_purchase' THEN
      v_required_kinds := ARRAY[
        'purchase_completed_event',
        'receipt_dm'
      ]::TEXT[];
    ELSIF v_action.action = 'fulfill_subscription'
       AND v_action.payload ->> 'fulfillment_type' = 'subscription_activated' THEN
      v_required_kinds := ARRAY[
        'subscription_activated_event',
        'receipt_dm'
      ]::TEXT[];
    ELSIF v_action.action = 'fulfill_subscription'
       AND v_action.payload ->> 'fulfillment_type' = 'subscription_renewed' THEN
      v_required_kinds := ARRAY['subscription_renewed_event']::TEXT[];
    ELSE
      RETURN 'operator_held';
    END IF;
  ELSE
    -- Fresh statement under the action/advisory lock is the no-intent race
    -- recheck. A binder cannot commit behind this classification.
    PERFORM 1
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.action_id = p_action_id
        OR intent.cleanup_action_id = p_action_id;
    IF FOUND THEN
      RETURN 'intent_raced';
    END IF;

    v_generation := v_action.outward_generation_id;
    IF v_generation IS NULL THEN
      RETURN 'delegate';
    END IF;
    IF v_action.lane IS DISTINCT FROM 'commerce'
       OR pg_catalog.jsonb_typeof(v_action.payload) IS DISTINCT FROM 'object'
       OR v_action.payload ->> 'guild_id' IS DISTINCT FROM v_action.guild_id
       OR v_action.payload ->> 'order_id' IS NULL
       OR v_action.payload ->> 'order_id'
            !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RETURN 'operator_held';
    END IF;
    v_order_id := (v_action.payload ->> 'order_id')::UUID;
    IF v_action.action = 'deliver_receipt' THEN
      v_required_kinds := ARRAY['receipt_dm']::TEXT[];
    ELSIF v_action.action = 'fulfill_cancellation'
       AND v_action.payload ->> 'fulfillment_type' = 'subscription_cancelled' THEN
      v_required_kinds := ARRAY[
        'subscription_cancelled_event',
        'subscription_cancelled_dm'
      ]::TEXT[];
    ELSIF v_action.action = 'fulfill_suspension'
       AND v_action.payload ->> 'fulfillment_type' = 'subscription_suspended' THEN
      v_required_kinds := ARRAY[
        'subscription_suspended_event',
        'subscription_suspended_dm'
      ]::TEXT[];
    ELSIF v_action.action = 'fulfill_suspension'
       AND v_action.payload ->> 'fulfillment_type' = 'subscription_payment_failed' THEN
      v_required_kinds := ARRAY[
        'subscription_payment_failed_lapsed_event',
        'subscription_payment_failed_event',
        'subscription_payment_failed_dm'
      ]::TEXT[];
    ELSE
      RETURN 'operator_held';
    END IF;
  END IF;

  v_required_count := pg_catalog.cardinality(v_required_kinds);
  IF v_generation IS NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.commerce_fulfillment_outward_intents AS outward
       WHERE outward.order_id = v_order_id
         AND outward.guild_id = v_action.guild_id
         AND outward.outward_generation_id IS NULL
         AND outward.intent_kind = ANY(v_required_kinds)
    ) INTO v_has_legacy_rows;
    IF NOT v_has_legacy_rows THEN
      RETURN 'complete';
    END IF;
  END IF;

  -- Lock every existing required row in deterministic order.  A fresh creator
  -- cannot pass its carrier FOR SHARE while this function owns the action.
  PERFORM outward.id
    FROM public.commerce_fulfillment_outward_intents AS outward
   WHERE outward.order_id = v_order_id
     AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
     AND outward.intent_kind = ANY(v_required_kinds)
   ORDER BY outward.id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM public.commerce_fulfillment_outward_intents AS outward
     WHERE outward.order_id = v_order_id
       AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
       AND outward.intent_kind = ANY(v_required_kinds)
       AND outward.guild_id IS DISTINCT FROM v_action.guild_id
  ) THEN
    RETURN 'operator_held';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.commerce_fulfillment_outward_intents AS outward
     WHERE outward.order_id = v_order_id
       AND outward.guild_id = v_action.guild_id
       AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
       AND outward.intent_kind = ANY(v_required_kinds)
       AND outward.state = 'superseded'
       AND NOT (
         (
           v_action.action = 'fulfill_subscription'
           AND v_action.payload ->> 'fulfillment_type' = 'subscription_renewed'
           AND outward.intent_kind = 'subscription_renewed_event'
         )
          OR (
            v_action.action = 'fulfill_suspension'
            AND v_action.payload ->> 'fulfillment_type' = 'subscription_payment_failed'
            AND outward.intent_kind IN (
              'subscription_payment_failed_lapsed_event',
              'subscription_payment_failed_event',
              'subscription_payment_failed_dm'
            )
          )
       )
  ) THEN
    RETURN 'operator_held';
  END IF;

  UPDATE public.commerce_fulfillment_outward_intents AS outward
     SET state = 'uncertain',
         attempt_token = NULL,
         uncertain_at = COALESCE(
           outward.uncertain_at,
           pg_catalog.clock_timestamp()
         ),
         last_error = COALESCE(
           outward.last_error,
           'queue finalization observed an unresolved external attempt'
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE outward.order_id = v_order_id
     AND outward.guild_id = v_action.guild_id
     AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
     AND outward.intent_kind = ANY(v_required_kinds)
     AND outward.state = 'sending';

  IF EXISTS (
    SELECT 1
      FROM public.commerce_fulfillment_outward_intents AS outward
     WHERE outward.order_id = v_order_id
       AND outward.guild_id = v_action.guild_id
       AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
       AND outward.intent_kind = ANY(v_required_kinds)
       AND outward.state = 'uncertain'
  ) THEN
    RETURN 'operator_held';
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_resolved_count
    FROM public.commerce_fulfillment_outward_intents AS outward
   WHERE outward.order_id = v_order_id
     AND outward.guild_id = v_action.guild_id
     AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
     AND outward.intent_kind = ANY(v_required_kinds)
     AND outward.state IN ('sent', 'superseded');
  IF v_resolved_count = v_required_count THEN
    RETURN 'complete';
  END IF;
  RETURN 'requeue';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_classify_action_outward_state(
  UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_hold_action_outward_uncertain(
  p_action_id UUID,
  p_claim_token UUID,
  p_error TEXT,
  p_max_retries INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
  v_alert_type TEXT;
  v_alert_id UUID;
  v_message TEXT;
BEGIN
  IF p_max_retries IS NULL OR p_max_retries < 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce outward operator hold requires a retry bound';
  END IF;
  UPDATE public.bot_action_queue AS queue
     SET status = 'failed',
         completed_at = pg_catalog.clock_timestamp(),
         error_message = pg_catalog.left(
           COALESCE(p_error, 'external delivery outcome is uncertain'),
           4000
         )
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
  RETURNING queue.* INTO v_action;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce outward operator hold lost its action claim';
  END IF;

  INSERT INTO public.action_queue_dlq (
    guild_id, action, payload, error_message, retry_count, max_retries,
    original_id, failed_at, lane
  )
  SELECT
    v_action.guild_id,
    v_action.action,
    v_action.payload,
    v_action.error_message,
    v_action.retry_count,
    p_max_retries,
    v_action.id::TEXT,
    pg_catalog.clock_timestamp(),
    v_action.lane
  WHERE NOT EXISTS (
    SELECT 1
      FROM public.action_queue_dlq AS dlq
     WHERE dlq.original_id = v_action.id::TEXT
       AND dlq.retried IS NOT TRUE
  )
  ON CONFLICT DO NOTHING;

  v_alert_type := CASE v_action.action
    WHEN 'deliver_receipt' THEN 'receipt_delivery_failed'
    ELSE 'commerce_fulfillment_outward_action_held'
  END;
  v_message := 'Action ' || v_action.id::TEXT
    || ' has an unresolved external delivery attempt. Automatic replay is '
    || 'disabled; inspect the exact outward intent and dead-letter action.';
  UPDATE public.alerts AS alert
     SET severity = 'critical',
         title = 'External delivery requires operator review',
         message = v_message,
         metadata = pg_catalog.jsonb_build_object(
           'action_id', v_action.id,
           'order_id', v_action.payload ->> 'order_id',
           'outward_generation_id', v_action.outward_generation_id,
           'next_step', 'inspect_action_queue_dlq_and_outward_intents'
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.guild_id = v_action.guild_id
     AND alert.alert_type = v_alert_type
     AND alert.resolved = false
     AND alert.metadata ->> 'action_id' = v_action.id::TEXT
  RETURNING alert.id INTO v_alert_id;
  IF v_alert_id IS NULL THEN
    INSERT INTO public.alerts (
      guild_id, alert_type, severity, title, message, metadata, resolved
    ) VALUES (
      v_action.guild_id,
      v_alert_type,
      'critical',
      'External delivery requires operator review',
      v_message,
      pg_catalog.jsonb_build_object(
        'action_id', v_action.id,
        'order_id', v_action.payload ->> 'order_id',
        'outward_generation_id', v_action.outward_generation_id,
        'next_step', 'inspect_action_queue_dlq_and_outward_intents'
      ),
      false
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_alert_id;
  END IF;
  IF v_alert_id IS NULL THEN
    SELECT alert.id
      INTO v_alert_id
      FROM public.alerts AS alert
     WHERE alert.guild_id = v_action.guild_id
       AND alert.alert_type = v_alert_type
       AND alert.resolved = false
       AND alert.metadata ->> 'action_id' = v_action.id::TEXT
     ORDER BY alert.created_at, alert.id
     LIMIT 1;
  END IF;
  IF v_alert_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce outward operator alert was not persisted';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_hold_action_outward_uncertain(
  UUID, UUID, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

DO $rename_queue_outward_fences$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.bot_action_queue_retry_claim_without_outward_fence(uuid,uuid,text,timestamptz)'
     ) IS NULL THEN
    ALTER FUNCTION public.bot_action_queue_retry_claim(
      UUID, UUID, TEXT, TIMESTAMPTZ
    ) RENAME TO bot_action_queue_retry_claim_without_outward_fence;
  END IF;
  IF pg_catalog.to_regprocedure(
       'public.bot_action_queue_finish_claim_without_outward_fence(uuid,uuid,boolean,jsonb,text)'
     ) IS NULL THEN
    ALTER FUNCTION public.bot_action_queue_finish_claim(
      UUID, UUID, BOOLEAN, JSONB, TEXT
    ) RENAME TO bot_action_queue_finish_claim_without_outward_fence;
  END IF;
  IF pg_catalog.to_regprocedure(
       'public.bot_action_queue_recover_stale_without_outward_fence(text,integer,integer)'
     ) IS NULL THEN
    ALTER FUNCTION public.bot_action_queue_recover_stale(
      TEXT, INTEGER, INTEGER
    ) RENAME TO bot_action_queue_recover_stale_without_outward_fence;
  END IF;
END;
$rename_queue_outward_fences$;

REVOKE ALL ON FUNCTION public.bot_action_queue_retry_claim_without_outward_fence(
  UUID, UUID, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bot_action_queue_finish_claim_without_outward_fence(
  UUID, UUID, BOOLEAN, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bot_action_queue_recover_stale_without_outward_fence(
  TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bot_action_queue_retry_claim(
  p_action_id UUID,
  p_claim_token UUID,
  p_error TEXT,
  p_next_retry_at TIMESTAMPTZ
)
RETURNS TABLE (applied BOOLEAN, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_outward_state TEXT;
  v_action public.bot_action_queue%ROWTYPE;
  v_applied BOOLEAN;
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL
     OR p_next_retry_at IS NULL
     OR NOT pg_catalog.isfinite(p_next_retry_at) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'bot_action_queue_retry_claim: exact finite claim identity is required';
  END IF;
  v_outward_state := public.commerce_classify_action_outward_state(
    p_action_id,
    p_claim_token
  );
  IF v_outward_state = 'delegate' THEN
    RETURN QUERY
      SELECT prior.applied, prior.disposition
        FROM public.bot_action_queue_retry_claim_without_outward_fence(
          p_action_id, p_claim_token, p_error, p_next_retry_at
        ) AS prior;
    RETURN;
  ELSIF v_outward_state IN ('stale_claim', 'intent_raced') THEN
    RETURN QUERY SELECT false, v_outward_state;
    RETURN;
  ELSIF v_outward_state = 'complete' THEN
    UPDATE public.bot_action_queue AS queue
       SET status = 'completed',
           completed_at = pg_catalog.clock_timestamp(),
           error_message = NULL
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token;
    RETURN QUERY SELECT false, CASE WHEN FOUND
      THEN 'completed' ELSE 'stale_claim' END;
    RETURN;
  ELSIF v_outward_state = 'operator_held' THEN
    PERFORM public.commerce_hold_action_outward_uncertain(
      p_action_id,
      p_claim_token,
      COALESCE(p_error, 'external delivery outcome is uncertain'),
      5
    );
    RETURN QUERY SELECT false, 'operator_held'::TEXT;
    RETURN;
  END IF;

  SELECT queue.*
    INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'stale_claim'::TEXT;
    RETURN;
  END IF;
  IF v_action.retry_count >= 5 THEN
    PERFORM public.commerce_hold_action_outward_uncertain(
      p_action_id,
      p_claim_token,
      COALESCE(
        p_error,
        'required outward delivery exhausted its retry budget before send'
      ),
      5
    );
    RETURN QUERY SELECT false, 'operator_held'::TEXT;
    RETURN;
  END IF;

  UPDATE public.bot_action_queue AS queue
     SET status = 'pending',
         retry_count = queue.retry_count + 1,
         error_message = COALESCE(
           p_error,
           'confirmed commerce mutation has incomplete outward delivery'
         ),
         next_retry_at = p_next_retry_at,
         started_at = NULL
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
     AND queue.retry_count = v_action.retry_count
     AND queue.retry_count < 5;
  v_applied := FOUND;
  RETURN QUERY SELECT v_applied, CASE WHEN v_applied
    THEN 'requeued' ELSE 'stale_claim' END;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_retry_claim(
  UUID, UUID, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bot_action_queue_retry_claim(
  UUID, UUID, TEXT, TIMESTAMPTZ
) TO service_role;

CREATE OR REPLACE FUNCTION public.bot_action_queue_finish_claim(
  p_action_id UUID,
  p_claim_token UUID,
  p_success BOOLEAN,
  p_result JSONB,
  p_error TEXT
)
RETURNS TABLE (applied BOOLEAN, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_outward_state TEXT;
  v_action public.bot_action_queue%ROWTYPE;
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL OR p_success IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'bot_action_queue_finish_claim: exact claim outcome is required';
  END IF;
  v_outward_state := public.commerce_classify_action_outward_state(
    p_action_id,
    p_claim_token
  );
  IF v_outward_state = 'delegate' THEN
    RETURN QUERY
      SELECT prior.applied, prior.disposition
        FROM public.bot_action_queue_finish_claim_without_outward_fence(
          p_action_id, p_claim_token, p_success, p_result, p_error
        ) AS prior;
    RETURN;
  ELSIF v_outward_state IN ('stale_claim', 'intent_raced') THEN
    RETURN QUERY SELECT false, v_outward_state;
    RETURN;
  ELSIF v_outward_state = 'operator_held' THEN
    PERFORM public.commerce_hold_action_outward_uncertain(
      p_action_id,
      p_claim_token,
      COALESCE(p_error, 'external delivery outcome is uncertain'),
      5
    );
    RETURN QUERY SELECT true, 'operator_held'::TEXT;
    RETURN;
  ELSIF v_outward_state = 'requeue' THEN
    SELECT queue.*
      INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'stale_claim'::TEXT;
      RETURN;
    END IF;
    IF v_action.retry_count >= 5 THEN
      PERFORM public.commerce_hold_action_outward_uncertain(
        p_action_id,
        p_claim_token,
        COALESCE(
          p_error,
          'required outward delivery exhausted its retry budget before send'
        ),
        5
      );
      RETURN QUERY SELECT true, 'operator_held'::TEXT;
      RETURN;
    END IF;

    UPDATE public.bot_action_queue AS queue
       SET status = 'pending',
           retry_count = queue.retry_count + 1,
           result = NULL,
           error_message = COALESCE(
             p_error,
             'confirmed commerce mutation has incomplete outward delivery'
           ),
           next_retry_at = NULL,
           started_at = NULL,
           completed_at = NULL
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token
       AND queue.retry_count = v_action.retry_count
       AND queue.retry_count < 5;
    RETURN QUERY SELECT FOUND, CASE WHEN FOUND
      THEN 'requeued' ELSE 'stale_claim' END;
    RETURN;
  END IF;

  UPDATE public.bot_action_queue AS queue
     SET status = 'completed',
         result = p_result,
         error_message = NULL,
         completed_at = pg_catalog.clock_timestamp()
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token;
  RETURN QUERY SELECT FOUND, CASE
    WHEN NOT FOUND THEN 'stale_claim'
    WHEN p_success THEN 'completed'
    ELSE 'completed_from_evidence'
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_finish_claim(
  UUID, UUID, BOOLEAN, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bot_action_queue_finish_claim(
  UUID, UUID, BOOLEAN, JSONB, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.bot_action_queue_recover_stale(
  p_guild_id TEXT,
  p_timeout_seconds INTEGER,
  p_max_retries INTEGER DEFAULT 5
)
RETURNS TABLE (id UUID, action TEXT, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_candidate RECORD;
  v_action public.bot_action_queue%ROWTYPE;
  v_outward_state TEXT;
  v_failure TEXT;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_timeout_seconds IS NULL OR p_timeout_seconds <= 0
     OR p_max_retries IS NULL OR p_max_retries < 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'bot_action_queue_recover_stale: valid recovery bounds are required';
  END IF;

  FOR v_candidate IN
    SELECT queue.id,
           queue.claim_token,
           EXISTS (
             SELECT 1
               FROM public.commerce_role_delivery_intents AS intent
              WHERE intent.action_id = queue.id
                 OR intent.cleanup_action_id = queue.id
           ) AS intent_observed
      FROM public.bot_action_queue AS queue
     WHERE queue.guild_id = p_guild_id
       AND queue.status = 'processing'
       AND queue.claim_token IS NOT NULL
       AND queue.started_at < pg_catalog.clock_timestamp()
         - pg_catalog.make_interval(secs => p_timeout_seconds)
     ORDER BY queue.id
  LOOP
    v_outward_state := public.commerce_classify_action_outward_state(
      v_candidate.id,
      v_candidate.claim_token
    );
    IF v_outward_state = 'delegate' THEN
      CONTINUE;
    ELSIF v_outward_state = 'stale_claim' THEN
      CONTINUE;
    ELSIF v_outward_state = 'intent_raced' THEN
      -- An intent that existed when this sweep selected the candidate is a
      -- genuinely stale bound attempt; leave it stale for the mature recovery
      -- state machine below to fence. If binding committed only while the
      -- classifier waited, defer this sweep without touching its mutation.
      IF v_candidate.intent_observed THEN
        CONTINUE;
      END IF;
      UPDATE public.bot_action_queue AS queue
         SET started_at = pg_catalog.clock_timestamp(),
             error_message = 'Stale recovery deferred after intent binding race'
       WHERE queue.id = v_candidate.id
         AND queue.status = 'processing'
         AND queue.claim_token = v_candidate.claim_token;
      IF FOUND THEN
        RETURN QUERY SELECT
          v_candidate.id,
          (SELECT queue.action
             FROM public.bot_action_queue AS queue
            WHERE queue.id = v_candidate.id),
          'intent_raced'::TEXT;
      END IF;
      CONTINUE;
    END IF;

    SELECT queue.*
      INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.id = v_candidate.id
       AND queue.status = 'processing'
       AND queue.claim_token = v_candidate.claim_token
     FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF v_outward_state = 'complete' THEN
      UPDATE public.bot_action_queue AS queue
         SET status = 'completed',
             completed_at = pg_catalog.clock_timestamp(),
             error_message = NULL
       WHERE queue.id = v_action.id
         AND queue.status = 'processing'
         AND queue.claim_token = v_action.claim_token;
      IF FOUND THEN
        RETURN QUERY SELECT v_action.id, v_action.action, 'completed'::TEXT;
      END IF;
      CONTINUE;
    END IF;

    IF v_outward_state = 'requeue'
       AND v_action.retry_count < p_max_retries THEN
      UPDATE public.bot_action_queue AS queue
         SET status = 'pending',
             started_at = NULL,
             retry_count = queue.retry_count + 1,
             error_message =
               'Stale processing recovery: outward delivery incomplete',
             next_retry_at = NULL
       WHERE queue.id = v_action.id
         AND queue.status = 'processing'
         AND queue.claim_token = v_action.claim_token;
      IF FOUND THEN
        RETURN QUERY SELECT v_action.id, v_action.action, 'requeued'::TEXT;
      END IF;
      CONTINUE;
    END IF;

    v_failure := CASE v_outward_state
      WHEN 'operator_held'
        THEN 'Stale processing recovery: external delivery outcome is uncertain'
      ELSE 'Stale processing recovery: outward retry budget exhausted'
    END;
    PERFORM public.commerce_hold_action_outward_uncertain(
      v_action.id,
      v_action.claim_token,
      v_failure,
      p_max_retries
    );
    RETURN QUERY SELECT v_action.id, v_action.action, 'operator_held'::TEXT;
  END LOOP;

  -- The mature recovery state machine remains authoritative for actions that
  -- have no committed outward episode. Rows handled above are no longer stale
  -- processing rows, so the private implementation cannot reclassify them.
  RETURN QUERY
    SELECT prior.id, prior.action, prior.disposition
      FROM public.bot_action_queue_recover_stale_without_outward_fence(
        p_guild_id,
        p_timeout_seconds,
        p_max_retries
      ) AS prior;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_recover_stale(
  TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bot_action_queue_recover_stale(
  TEXT, INTEGER, INTEGER
) TO service_role;

CREATE OR REPLACE FUNCTION public.bot_action_queue_guard_outward_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_binding_owner NAME;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.outward_generation_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'bot action outward generation requires an exact binding RPC';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.outward_generation_id IS NOT DISTINCT FROM OLD.outward_generation_id THEN
    RETURN NEW;
  END IF;

  SELECT pg_catalog.pg_get_userbyid(proc.proowner)
    INTO v_binding_owner
    FROM pg_catalog.pg_proc AS proc
   WHERE proc.oid = pg_catalog.to_regprocedure(
     'public.commerce_prepare_action_outward_generation(uuid,uuid,text,uuid,uuid,text,uuid,text,text,integer,text,uuid,text)'
   );
  IF OLD.outward_generation_id IS NOT NULL
     OR NEW.outward_generation_id IS NULL
     OR NEW.status IS DISTINCT FROM 'processing'
     OR NEW.claim_token IS NULL
     OR v_binding_owner IS NULL
     OR CURRENT_USER IS DISTINCT FROM v_binding_owner THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'bot action outward generation is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_guard_outward_generation()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_bot_action_queue_guard_outward_generation
  ON public.bot_action_queue;
CREATE TRIGGER trg_bot_action_queue_guard_outward_generation
  BEFORE INSERT OR UPDATE OF outward_generation_id
  ON public.bot_action_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.bot_action_queue_guard_outward_generation();

-- Atomically select the one paid order allowed to fulfill. The unique claim row
-- is the concurrency primitive: a competing INSERT waits for the winner's
-- transaction and then observes that exact winner. A losing order and its
-- critical alert are persisted in the same transaction.
CREATE OR REPLACE FUNCTION public.commerce_claim_paid_fulfillment(
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_provider_kind TEXT,
  p_provider_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_claim public.commerce_fulfillment_claims%ROWTYPE;
  v_hold public.commerce_fulfillment_holds%ROWTYPE;
  v_conflicting_entitlement public.entitlements%ROWTYPE;
  v_prior_order public.orders%ROWTYPE;
  v_claim_releasable BOOLEAN := false;
  v_inflight_fulfillment BOOLEAN := false;
  v_alert_id UUID;
  v_alert_type TEXT;
  v_alert_title TEXT;
  v_message TEXT;
  v_metadata JSONB;
BEGIN
  IF p_order_id IS NULL
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = ''
     OR p_provider_kind NOT IN ('capture', 'subscription')
     OR p_provider_id IS NULL
     OR p_provider_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_claim_paid_fulfillment: exact paid identity is required';
  END IF;

  -- Lock hierarchy for every claimant of this entitlement identity:
  -- identity advisory lock -> current order -> hold/claim rows. This is
  -- acquired before any order row so a winner replay cannot deadlock with a
  -- losing order that is inspecting the winner. Hash collisions only
  -- serialize unrelated identities; they cannot weaken correctness.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_guild_id || E'\x1f'
        || p_customer_id::TEXT || E'\x1f'
        || p_product_id::TEXT,
      0
    )
  );

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR v_order.customer_id IS DISTINCT FROM p_customer_id
     OR v_order.product_id IS DISTINCT FROM p_product_id
     OR v_order.amount_cents IS DISTINCT FROM p_amount_cents
     OR pg_catalog.upper(v_order.currency) IS DISTINCT FROM p_currency
     OR NOT COALESCE((v_order.source = 'purchase' OR v_order.source IS NULL), false)
     OR v_order.status NOT IN ('pending', 'completed', 'pending_review') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_claim_paid_fulfillment: order identity mismatch';
  END IF;

  IF p_provider_kind = 'capture' AND (
    v_order.paypal_order_id IS NULL
    OR v_order.paypal_subscription_id IS NOT NULL
    OR v_order.plan_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_claim_paid_fulfillment: capture order identity mismatch';
  ELSIF p_provider_kind = 'subscription' AND (
    v_order.paypal_order_id IS NOT NULL
    OR v_order.paypal_subscription_id IS DISTINCT FROM p_provider_id
    OR v_order.plan_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_claim_paid_fulfillment: subscription order identity mismatch';
  END IF;

  IF p_provider_kind = 'capture' THEN
    SELECT payment.*
      INTO v_payment
      FROM public.payments AS payment
     WHERE payment.paypal_payment_id = p_provider_id;

    IF NOT FOUND
       OR v_payment.order_id IS DISTINCT FROM v_order.id
       OR v_payment.customer_id IS DISTINCT FROM v_order.customer_id
       OR v_payment.guild_id IS DISTINCT FROM v_order.guild_id
       OR v_payment.provider IS DISTINCT FROM 'paypal'
       OR v_payment.paypal_resource_type IS DISTINCT FROM 'capture'
       OR v_payment.status IS DISTINCT FROM 'completed'
       OR v_payment.amount_cents IS DISTINCT FROM p_amount_cents
       OR v_payment.currency IS DISTINCT FROM p_currency THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_claim_paid_fulfillment: completed capture payment identity mismatch';
    END IF;
  END IF;

  -- A hold is permanent until an explicit operator repair removes it. Alert
  -- resolution alone cannot make an old paid link auto-fulfillable on replay.
  SELECT held.*
    INTO v_hold
    FROM public.commerce_fulfillment_holds AS held
   WHERE held.order_id = v_order.id
   FOR UPDATE;

  IF FOUND AND (
    v_hold.guild_id IS DISTINCT FROM v_order.guild_id
    OR v_hold.customer_id IS DISTINCT FROM v_order.customer_id
    OR v_hold.product_id IS DISTINCT FROM v_order.product_id
    OR v_hold.provider_kind IS DISTINCT FROM p_provider_kind
    OR v_hold.provider_id IS DISTINCT FROM p_provider_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_claim_paid_fulfillment: existing hold identity mismatch';
  END IF;

  IF NOT FOUND THEN
    -- If this exact order already produced live access, this is its normal
    -- replay. Do not let a historical duplicate claim rewrite a completed
    -- entitlement's parent state.
    SELECT entitlement.*
      INTO v_conflicting_entitlement
      FROM public.entitlements AS entitlement
     WHERE entitlement.guild_id = v_order.guild_id
       AND entitlement.customer_id = v_order.customer_id
       AND entitlement.product_id = v_order.product_id
       AND entitlement.order_id = v_order.id
       AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
     ORDER BY entitlement.created_at, entitlement.id
     LIMIT 1
     FOR SHARE;

    IF FOUND THEN
      INSERT INTO public.commerce_fulfillment_claims (
        guild_id,
        customer_id,
        product_id,
        order_id
      ) VALUES (
        v_order.guild_id,
        v_order.customer_id,
        v_order.product_id,
        v_order.id
      )
      ON CONFLICT DO NOTHING;

      RETURN pg_catalog.jsonb_build_object(
        'order_id', v_order.id,
        'disposition', 'winner',
        'winning_order_id', v_order.id,
        'conflicting_entitlement_id', NULL,
        'alert_id', NULL
      );
    END IF;

    SELECT claim.*
      INTO v_claim
      FROM public.commerce_fulfillment_claims AS claim
     WHERE claim.guild_id = v_order.guild_id
       AND claim.customer_id = v_order.customer_id
       AND claim.product_id = v_order.product_id
     FOR UPDATE;

    -- A manually granted or earlier paid live entitlement wins even when it
    -- predates the claims table.
    SELECT entitlement.*
      INTO v_conflicting_entitlement
      FROM public.entitlements AS entitlement
     WHERE entitlement.guild_id = v_order.guild_id
       AND entitlement.customer_id = v_order.customer_id
       AND entitlement.product_id = v_order.product_id
       AND entitlement.order_id IS DISTINCT FROM v_order.id
       AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
     ORDER BY entitlement.created_at, entitlement.id
     LIMIT 1
     FOR SHARE;

    IF FOUND THEN
      v_hold.order_id := v_order.id;
      v_hold.guild_id := v_order.guild_id;
      v_hold.customer_id := v_order.customer_id;
      v_hold.product_id := v_order.product_id;
      v_hold.winning_order_id := v_conflicting_entitlement.order_id;
      v_hold.conflicting_entitlement_id := v_conflicting_entitlement.id;
      v_hold.provider_kind := p_provider_kind;
      v_hold.provider_id := p_provider_id;
      v_hold.hold_reason := 'duplicate_paid_fulfillment';
    ELSIF v_claim.order_id IS NULL THEN
      INSERT INTO public.commerce_fulfillment_claims (
        guild_id,
        customer_id,
        product_id,
        order_id
      ) VALUES (
        v_order.guild_id,
        v_order.customer_id,
        v_order.product_id,
        v_order.id
      )
      ON CONFLICT (guild_id, customer_id, product_id) DO NOTHING
      RETURNING * INTO v_claim;

      IF NOT FOUND THEN
        SELECT claim.*
          INTO v_claim
          FROM public.commerce_fulfillment_claims AS claim
         WHERE claim.guild_id = v_order.guild_id
           AND claim.customer_id = v_order.customer_id
           AND claim.product_id = v_order.product_id
         FOR UPDATE;
      END IF;
    END IF;

    IF v_hold.order_id IS NULL AND v_claim.order_id = v_order.id THEN
      RETURN pg_catalog.jsonb_build_object(
        'order_id', v_order.id,
        'disposition', 'winner',
        'winning_order_id', v_order.id,
        'conflicting_entitlement_id', NULL,
        'alert_id', NULL
      );
    END IF;

    IF v_hold.order_id IS NULL AND v_claim.order_id IS NOT NULL THEN
      -- The identity advisory lock stabilizes claim replacement. Do not lock
      -- the prior winner order after already locking this losing order: that
      -- would invert a winner replay's order/claim sequence. A concurrent
      -- terminal transition can only make this conservative read postpone
      -- replacement; it cannot authorize a second winner.
      SELECT paid_order.*
        INTO v_prior_order
        FROM public.orders AS paid_order
       WHERE paid_order.id = v_claim.order_id;

      SELECT EXISTS (
        SELECT 1
          FROM public.bot_action_queue AS queue
         WHERE queue.payload ->> 'order_id' = v_claim.order_id::TEXT
           AND queue.action IN ('fulfill_purchase', 'fulfill_subscription')
           AND queue.status IN ('staged', 'pending', 'processing')
      ) INTO v_inflight_fulfillment;

      v_claim_releasable := NOT v_inflight_fulfillment
        AND NOT EXISTS (
          SELECT 1
            FROM public.entitlements AS entitlement
           WHERE entitlement.guild_id = v_order.guild_id
             AND entitlement.customer_id = v_order.customer_id
             AND entitlement.product_id = v_order.product_id
             AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
        )
        AND (
          v_prior_order.status IN ('refunded', 'disputed', 'cancelled')
          OR (
            v_prior_order.status = 'completed'
            AND EXISTS (
              SELECT 1
                FROM public.entitlements AS entitlement
               WHERE entitlement.order_id = v_claim.order_id
            )
          )
        );

      IF v_claim_releasable THEN
        UPDATE public.commerce_fulfillment_claims AS claim
           SET order_id = v_order.id,
               claimed_at = pg_catalog.clock_timestamp()
         WHERE claim.guild_id = v_order.guild_id
           AND claim.customer_id = v_order.customer_id
           AND claim.product_id = v_order.product_id
           AND claim.order_id = v_claim.order_id
        RETURNING * INTO v_claim;

        IF NOT FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'commerce_claim_paid_fulfillment: claim replacement raced';
        END IF;

        RETURN pg_catalog.jsonb_build_object(
          'order_id', v_order.id,
          'disposition', 'winner',
          'winning_order_id', v_order.id,
          'conflicting_entitlement_id', NULL,
          'alert_id', NULL
        );
      END IF;

      v_hold.order_id := v_order.id;
      v_hold.guild_id := v_order.guild_id;
      v_hold.customer_id := v_order.customer_id;
      v_hold.product_id := v_order.product_id;
      v_hold.winning_order_id := v_claim.order_id;
      v_hold.conflicting_entitlement_id := NULL;
      v_hold.provider_kind := p_provider_kind;
      v_hold.provider_id := p_provider_id;
      v_hold.hold_reason := 'duplicate_paid_fulfillment';
    END IF;

    IF v_hold.order_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_claim_paid_fulfillment: claim arbitration produced no winner';
    END IF;

    INSERT INTO public.commerce_fulfillment_holds (
      order_id,
      guild_id,
      customer_id,
      product_id,
      winning_order_id,
      conflicting_entitlement_id,
      provider_kind,
      provider_id,
      hold_reason
    ) VALUES (
      v_hold.order_id,
      v_hold.guild_id,
      v_hold.customer_id,
      v_hold.product_id,
      v_hold.winning_order_id,
      v_hold.conflicting_entitlement_id,
      v_hold.provider_kind,
      v_hold.provider_id,
      v_hold.hold_reason
    )
    RETURNING * INTO v_hold;

    IF p_provider_kind = 'subscription' AND v_order.status IN ('pending', 'completed') THEN
      UPDATE public.orders AS paid_order
         SET status = 'pending_review',
             updated_at = pg_catalog.clock_timestamp()
       WHERE paid_order.id = v_order.id
         AND paid_order.status = v_order.status
      RETURNING paid_order.* INTO v_order;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'commerce_claim_paid_fulfillment: subscription hold raced';
      END IF;
    END IF;
  END IF;

  v_alert_type := CASE
    WHEN v_hold.hold_reason = 'unknown_delivery_contract'
      THEN 'commerce_unknown_delivery_contract'
    WHEN p_provider_kind = 'capture'
      THEN 'commerce_duplicate_purchase_capture'
    ELSE 'commerce_duplicate_subscription_activation'
  END;
  v_alert_title := CASE
    WHEN v_hold.hold_reason = 'unknown_delivery_contract'
      THEN 'Paid order requires manual delivery review'
    WHEN p_provider_kind = 'capture'
      THEN 'Customer charged twice for the same product'
    ELSE 'Customer activated a duplicate paid subscription'
  END;
  v_message := CASE
    WHEN v_hold.hold_reason = 'unknown_delivery_contract' THEN
      'Paid order ' || v_order.order_number
      || ' reached PayPal without an immutable delivery type snapshot. '
      || 'The provider ' || p_provider_kind || ' ' || p_provider_id
      || ' for ' || p_amount_cents || ' cents ' || p_currency
      || ' remains financially visible, but automatic access and licence-key '
      || 'delivery are permanently held. Manually fulfil the exact order or refund it.'
    ELSE
      'Paid order ' || v_order.order_number
      || ' lost the atomic fulfillment claim for this customer and product. '
      || 'The provider ' || p_provider_kind || ' ' || p_provider_id
      || ' for ' || p_amount_cents || ' cents ' || p_currency
      || ' remains financially visible, but no second entitlement, role set, '
      || 'or licence key was released. Review and refund/cancel this exact order.'
  END;
  v_metadata := pg_catalog.jsonb_build_object(
    'source', 'paypal_webhook',
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'customer_id', v_order.customer_id,
    'product_id', v_order.product_id,
    'provider_kind', p_provider_kind,
    'provider_id', p_provider_id,
    'amount_cents', p_amount_cents,
    'currency', p_currency,
    'winning_order_id', v_hold.winning_order_id,
    'existing_entitlement_id', v_hold.conflicting_entitlement_id,
    'hold_reason', v_hold.hold_reason,
    'required_action', CASE v_hold.hold_reason
      WHEN 'unknown_delivery_contract' THEN 'manual_fulfillment_or_refund'
      ELSE 'refund_or_cancel_duplicate'
    END
  ) || CASE p_provider_kind
    WHEN 'capture' THEN pg_catalog.jsonb_build_object(
      'paypal_capture_id', p_provider_id
    )
    ELSE pg_catalog.jsonb_build_object(
      'paypal_subscription_id', p_provider_id
    )
  END;

  UPDATE public.alerts AS alert
     SET severity = 'critical',
         title = v_alert_title,
         message = v_message,
         metadata = v_metadata,
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.guild_id = v_order.guild_id
     AND alert.alert_type = v_alert_type
     AND alert.resolved = false
     AND alert.metadata ->> 'order_id' = v_order.id::TEXT
  RETURNING alert.id INTO v_alert_id;

  IF v_alert_id IS NULL THEN
    INSERT INTO public.alerts (
      guild_id,
      alert_type,
      severity,
      title,
      message,
      metadata
    ) VALUES (
      v_order.guild_id,
      v_alert_type,
      'critical',
      v_alert_title,
      v_message,
      v_metadata
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_alert_id;
  END IF;

  IF v_alert_id IS NULL THEN
    SELECT alert.id
      INTO v_alert_id
      FROM public.alerts AS alert
     WHERE alert.guild_id = v_order.guild_id
       AND alert.alert_type = v_alert_type
       AND alert.resolved = false
       AND alert.metadata ->> 'order_id' = v_order.id::TEXT
     ORDER BY alert.created_at, alert.id
     LIMIT 1;
  END IF;

  IF v_alert_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_claim_paid_fulfillment: critical hold alert was not persisted';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_order.id,
    'disposition', 'held',
    'winning_order_id', v_hold.winning_order_id,
    'conflicting_entitlement_id', v_hold.conflicting_entitlement_id,
    'alert_id', v_alert_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_claim_paid_fulfillment(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_claim_paid_fulfillment(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) TO service_role;

-- Legacy paid rows with no immutable delivery snapshot still enter the same
-- arbitration lock as every other paid order. If they win, the claim is kept
-- reserved but the order itself receives a permanent unknown-contract hold and
-- critical alert in this same transaction. If they lose, the duplicate hold
-- returned by the base claim remains authoritative.
CREATE OR REPLACE FUNCTION public.commerce_hold_unknown_delivery_contract(
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_provider_kind TEXT,
  p_provider_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claim JSONB;
  v_order public.orders%ROWTYPE;
  v_hold public.commerce_fulfillment_holds%ROWTYPE;
  v_alert_id UUID;
  v_message TEXT;
  v_metadata JSONB;
BEGIN
  v_claim := public.commerce_claim_paid_fulfillment(
    p_order_id,
    p_guild_id,
    p_customer_id,
    p_product_id,
    p_provider_kind,
    p_provider_id,
    p_amount_cents,
    p_currency
  );

  IF (
       v_claim ->> 'disposition' IS DISTINCT FROM 'held'
       AND v_claim ->> 'disposition' IS DISTINCT FROM 'winner'
     )
     OR v_claim ->> 'order_id' IS DISTINCT FROM p_order_id::TEXT THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_hold_unknown_delivery_contract: claim returned malformed winner';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR v_order.customer_id IS DISTINCT FROM p_customer_id
     OR v_order.product_id IS DISTINCT FROM p_product_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_hold_unknown_delivery_contract: order identity mismatch';
  END IF;

  IF v_claim ->> 'disposition' = 'held' THEN
    SELECT held.*
      INTO v_hold
      FROM public.commerce_fulfillment_holds AS held
     WHERE held.order_id = p_order_id
     FOR SHARE;
    IF FOUND
       AND v_hold.hold_reason = 'unknown_delivery_contract'
       AND v_order.status = 'pending' THEN
      UPDATE public.orders AS paid_order
         SET status = 'pending_review',
             checkout_active = false,
             updated_at = pg_catalog.clock_timestamp()
       WHERE paid_order.id = p_order_id
         AND paid_order.status = 'pending'
      RETURNING paid_order.* INTO v_order;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'commerce_hold_unknown_delivery_contract: review hold repair raced';
      END IF;
    END IF;
    RETURN v_claim;
  END IF;

  IF v_claim ->> 'winning_order_id' IS DISTINCT FROM p_order_id::TEXT THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_hold_unknown_delivery_contract: claim returned malformed winner';
  END IF;

  IF v_order.status = 'pending' THEN
    UPDATE public.orders AS paid_order
       SET status = 'pending_review',
           checkout_active = false,
           updated_at = pg_catalog.clock_timestamp()
     WHERE paid_order.id = p_order_id
       AND paid_order.status = 'pending'
    RETURNING paid_order.* INTO v_order;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_hold_unknown_delivery_contract: review hold transition raced';
    END IF;
  END IF;

  INSERT INTO public.commerce_fulfillment_holds (
    order_id,
    guild_id,
    customer_id,
    product_id,
    winning_order_id,
    conflicting_entitlement_id,
    provider_kind,
    provider_id,
    hold_reason
  ) VALUES (
    v_order.id,
    v_order.guild_id,
    v_order.customer_id,
    v_order.product_id,
    v_order.id,
    NULL,
    p_provider_kind,
    p_provider_id,
    'unknown_delivery_contract'
  )
  RETURNING * INTO v_hold;

  v_message := 'Paid order ' || v_order.order_number
    || ' reached PayPal without an immutable delivery type snapshot. The '
    || p_provider_kind || ' is recorded, but automatic access and licence-key '
    || 'delivery were withheld so mutable product settings cannot rewrite what '
    || 'was sold. Manually fulfil the exact order or refund the customer.';
  v_metadata := pg_catalog.jsonb_build_object(
    'source', 'paypal_webhook',
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'customer_id', v_order.customer_id,
    'product_id', v_order.product_id,
    'provider_kind', p_provider_kind,
    'provider_id', p_provider_id,
    'amount_cents', p_amount_cents,
    'currency', p_currency,
    'winning_order_id', v_order.id,
    'existing_entitlement_id', NULL,
    'hold_reason', 'unknown_delivery_contract',
    'required_action', 'manual_fulfillment_or_refund'
  ) || CASE p_provider_kind
    WHEN 'capture' THEN pg_catalog.jsonb_build_object(
      'paypal_capture_id', p_provider_id
    )
    ELSE pg_catalog.jsonb_build_object(
      'paypal_subscription_id', p_provider_id
    )
  END;

  UPDATE public.alerts AS alert
     SET severity = 'critical',
         title = 'Paid order requires manual delivery review',
         message = v_message,
         metadata = v_metadata,
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.guild_id = v_order.guild_id
     AND alert.alert_type = 'commerce_unknown_delivery_contract'
     AND alert.resolved = false
     AND alert.metadata ->> 'order_id' = v_order.id::TEXT
  RETURNING alert.id INTO v_alert_id;

  IF v_alert_id IS NULL THEN
    INSERT INTO public.alerts (
      guild_id,
      alert_type,
      severity,
      title,
      message,
      metadata
    ) VALUES (
      v_order.guild_id,
      'commerce_unknown_delivery_contract',
      'critical',
      'Paid order requires manual delivery review',
      v_message,
      v_metadata
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_alert_id;
  END IF;

  IF v_alert_id IS NULL THEN
    SELECT alert.id
      INTO v_alert_id
      FROM public.alerts AS alert
     WHERE alert.guild_id = v_order.guild_id
       AND alert.alert_type = 'commerce_unknown_delivery_contract'
       AND alert.resolved = false
       AND alert.metadata ->> 'order_id' = v_order.id::TEXT
     ORDER BY alert.created_at, alert.id
     LIMIT 1;
  END IF;

  IF v_alert_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_hold_unknown_delivery_contract: critical alert was not persisted';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_order.id,
    'disposition', 'held',
    'winning_order_id', v_hold.winning_order_id,
    'conflicting_entitlement_id', NULL,
    'alert_id', v_alert_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_hold_unknown_delivery_contract(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_hold_unknown_delivery_contract(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) TO service_role;

-- A PayPal subscription sale is authoritative money-path evidence even when
-- the local renewal contract is no longer safe to execute. Persist the exact
-- provider payment first, then atomically choose one terminal result:
--   * one exact, replayable renewal action; or
--   * one permanent payment hold and one critical operator incident.
-- The hold survives alert acknowledgement/resolution and therefore prevents a
-- later webhook replay from interpreting repaired mutable catalog state as
-- permission to fulfil the historical charge.
CREATE TABLE IF NOT EXISTS public.commerce_subscription_sale_holds (
  payment_id UUID PRIMARY KEY
    REFERENCES public.payments(id) ON DELETE RESTRICT,
  paypal_payment_id TEXT NOT NULL UNIQUE,
  order_id UUID NOT NULL
    REFERENCES public.orders(id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL
    REFERENCES public.guild(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL
    REFERENCES public.customers(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL
    REFERENCES public.products(id) ON DELETE RESTRICT,
  plan_id UUID NOT NULL
    REFERENCES public.plans(id) ON DELETE RESTRICT,
  paypal_subscription_id TEXT NOT NULL,
  hold_reason TEXT NOT NULL CHECK (
    hold_reason IN (
      'financial_mismatch',
      'terminal_or_held_order',
      'renewal_contract_invalid',
      'renewal_action_failed'
    )
  ),
  contract_detail TEXT NOT NULL,
  observed_order_status TEXT NOT NULL CHECK (
    observed_order_status IN (
      'pending',
      'completed',
      'refunded',
      'disputed',
      'cancelled',
      'pending_review'
    )
  ),
  provider_amount_cents INTEGER NOT NULL CHECK (provider_amount_cents >= 0),
  provider_currency TEXT NOT NULL CHECK (provider_currency ~ '^[A-Z]{3}$'),
  stored_order_amount_cents INTEGER NOT NULL CHECK (stored_order_amount_cents >= 0),
  stored_order_currency TEXT NOT NULL CHECK (stored_order_currency ~ '^[A-Z]{3}$'),
  alert_id UUID NOT NULL UNIQUE
    REFERENCES public.alerts(id) ON DELETE RESTRICT,
  action_id UUID,
  held_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT commerce_subscription_sale_hold_text_identity
    CHECK (
      paypal_payment_id = pg_catalog.btrim(paypal_payment_id)
      AND paypal_payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
      AND paypal_subscription_id = pg_catalog.btrim(paypal_subscription_id)
      AND paypal_subscription_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
      AND guild_id = pg_catalog.btrim(guild_id)
      AND guild_id <> ''
      AND contract_detail = pg_catalog.btrim(contract_detail)
      AND contract_detail <> ''
      AND pg_catalog.isfinite(held_at)
    )
);

ALTER TABLE public.commerce_subscription_sale_holds
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_subscription_sale_holds
  FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_subscription_sale_holds
  FROM PUBLIC, anon, authenticated, service_role;

CREATE UNIQUE INDEX IF NOT EXISTS
  uniq_alerts_unresolved_subscription_sale_hold
  ON public.alerts (((metadata ->> 'paypal_payment_id')))
  WHERE alert_type IN (
    'commerce_subscription_renewal_financial_mismatch',
    'commerce_subscription_sale_terminal_order',
    'commerce_subscription_sale_contract_invalid'
  )
  AND resolved = false;

-- Capture finalization already increments the customer's lifetime gross
-- totals, while the historical renewal handler only inserted a payment row.
-- This per-payment witness makes renewal aggregation replay-safe, including
-- migration from that old split flow. It intentionally records gross provider
-- charges; later refund/reversal state does not erase historical revenue.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS commerce_customer_totals_recorded_at TIMESTAMPTZ;
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_customer_totals_recorded_at_finite;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_customer_totals_recorded_at_finite
  CHECK (
    commerce_customer_totals_recorded_at IS NULL
    OR pg_catalog.isfinite(commerce_customer_totals_recorded_at)
  ) NOT VALID;

CREATE OR REPLACE FUNCTION public.commerce_record_subscription_sale_or_hold(
  p_paypal_payment_id TEXT,
  p_paypal_subscription_id TEXT,
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_plan_id UUID,
  p_webhook_event_id TEXT,
  p_lifecycle_generation BIGINT,
  p_amount_cents INTEGER,
  p_currency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_legacy public.commerce_legacy_subscription_grant_contracts%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_activation_action public.bot_action_queue%ROWTYPE;
  v_hold public.commerce_subscription_sale_holds%ROWTYPE;
  v_alert public.alerts%ROWTYPE;
  v_payment_created BOOLEAN := false;
  v_action_created BOOLEAN := false;
  v_has_legacy BOOLEAN := false;
  v_idempotency_key TEXT;
  v_payload JSONB;
  v_role_ids TEXT[] := '{}'::TEXT[];
  v_channel_ids TEXT[] := '{}'::TEXT[];
  v_carrier_discord_id TEXT;
  v_carrier_product_name TEXT;
  v_carrier_paypal_plan_id TEXT;
  v_hold_reason TEXT;
  v_contract_detail TEXT;
  v_alert_type TEXT;
  v_alert_title TEXT;
  v_alert_message TEXT;
  v_alert_metadata JSONB;
  v_disposition TEXT;
  v_release_status TEXT;
  v_customer_totals_recorded_at TIMESTAMPTZ;
  v_rows_changed INTEGER := 0;
  v_lifecycle_event public.commerce_subscription_lifecycle_events%ROWTYPE;
  v_lifecycle_head public.commerce_subscription_lifecycle_heads%ROWTYPE;
BEGIN
  IF p_paypal_payment_id IS NULL
     OR p_paypal_payment_id
          !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR p_paypal_subscription_id IS NULL
     OR p_paypal_subscription_id
          !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR p_order_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = ''
     OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_plan_id IS NULL
     OR p_webhook_event_id IS NULL
     OR p_webhook_event_id = ''
     OR p_webhook_event_id <> pg_catalog.btrim(p_webhook_event_id)
     OR pg_catalog.length(p_webhook_event_id) > 160
     OR p_lifecycle_generation IS NULL
     OR p_lifecycle_generation < 1
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_subscription_sale_or_hold: canonical provider and order identity are required';
  END IF;

  v_idempotency_key := 'paypal:sale:' || p_paypal_payment_id
    || ':fulfill_subscription_renewal';
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'commerce-guild-purge:' || p_guild_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-subscription-lifecycle:' || p_paypal_subscription_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-subscription-sale:' || p_paypal_payment_id,
      0
    )
  );

  SELECT event_row.*
    INTO v_lifecycle_event
    FROM public.commerce_subscription_lifecycle_events AS event_row
   WHERE event_row.webhook_event_id = p_webhook_event_id
     AND event_row.paypal_subscription_id = p_paypal_subscription_id
     AND event_row.order_id = p_order_id
     AND event_row.guild_id = p_guild_id
     AND event_row.customer_id = p_customer_id
     AND event_row.product_id = p_product_id
     AND event_row.plan_id = p_plan_id
     AND event_row.provider_event_type = 'PAYMENT.SALE.COMPLETED'
     AND event_row.generation = p_lifecycle_generation
     AND event_row.disposition = 'accepted'
     AND event_row.provider_paid_through_at IS NOT NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_subscription_sale_or_hold: lifecycle event identity mismatch';
  END IF;
  SELECT head.*
    INTO v_lifecycle_head
    FROM public.commerce_subscription_lifecycle_heads AS head
   WHERE head.paypal_subscription_id = p_paypal_subscription_id
     AND head.order_id = p_order_id
     AND head.guild_id = p_guild_id
     AND head.customer_id = p_customer_id
     AND head.product_id = p_product_id
     AND head.plan_id = p_plan_id
   FOR SHARE;
  IF NOT FOUND
     OR v_lifecycle_head.last_webhook_event_id
          IS DISTINCT FROM v_lifecycle_event.webhook_event_id
     OR v_lifecycle_head.generation
          IS DISTINCT FROM v_lifecycle_event.generation THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_record_subscription_sale_or_hold: lifecycle authority was superseded';
  END IF;

  -- Match the global entitlement mutation canon before touching customer,
  -- catalog, order, payment, or queue rows. Cancellation/suspension workers
  -- take this same entitlement -> customer-advisory order, so a provider sale
  -- racing lifecycle work serializes instead of forming an AB-BA deadlock.
  SELECT entitlement.*
    INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.guild_id = p_guild_id
     AND entitlement.customer_id = p_customer_id
     AND entitlement.order_id = p_order_id
     AND entitlement.product_id = p_product_id
     AND entitlement.plan_id = p_plan_id
   FOR UPDATE;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'noncommerce-entitlement-customer:' || p_customer_id::TEXT,
      0
    )
  );
  SELECT customer.*
    INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = p_customer_id
     AND customer.guild_id = p_guild_id
   FOR UPDATE;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
     AND paid_order.product_id = p_product_id
     AND paid_order.plan_id = p_plan_id
     AND paid_order.paypal_subscription_id = p_paypal_subscription_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_subscription_sale_or_hold: subscription order identity mismatch';
  END IF;

  SELECT payment.*
    INTO v_payment
    FROM public.payments AS payment
   WHERE payment.paypal_payment_id = p_paypal_payment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.payments (
      order_id,
      customer_id,
      guild_id,
      paypal_payment_id,
      amount_cents,
      currency,
      status,
      provider,
      paypal_resource_type
    ) VALUES (
      p_order_id,
      p_customer_id,
      p_guild_id,
      p_paypal_payment_id,
      p_amount_cents,
      p_currency,
      'completed',
      'paypal',
      'sale'
    )
    ON CONFLICT (paypal_payment_id) DO NOTHING
    RETURNING * INTO v_payment;
    v_payment_created := FOUND;

    IF NOT v_payment_created THEN
      SELECT payment.*
        INTO v_payment
        FROM public.payments AS payment
       WHERE payment.paypal_payment_id = p_paypal_payment_id
       FOR UPDATE;
    END IF;
  END IF;

  IF v_payment.id IS NULL
     OR v_payment.order_id IS DISTINCT FROM p_order_id
     OR v_payment.customer_id IS DISTINCT FROM p_customer_id
     OR v_payment.guild_id IS DISTINCT FROM p_guild_id
     OR v_payment.paypal_payment_id IS DISTINCT FROM p_paypal_payment_id
     OR v_payment.amount_cents IS DISTINCT FROM p_amount_cents
     OR v_payment.currency IS DISTINCT FROM p_currency
     OR v_payment.provider IS DISTINCT FROM 'paypal'
     OR v_payment.paypal_resource_type IS DISTINCT FROM 'sale'
     OR v_payment.status NOT IN ('completed', 'refunded', 'reversed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_subscription_sale_or_hold: provider sale identity or successor state mismatch';
  END IF;

  IF v_payment.status = 'refunded'
     AND v_order.status IS DISTINCT FROM 'refunded' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_subscription_sale_or_hold: refunded payment/order successor mismatch';
  END IF;
  IF v_payment.status = 'reversed'
     AND v_order.status NOT IN ('refunded', 'disputed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_record_subscription_sale_or_hold: reversed payment/order successor mismatch';
  END IF;

  v_customer_totals_recorded_at :=
    v_payment.commerce_customer_totals_recorded_at;
  IF v_customer_totals_recorded_at IS NULL THEN
    UPDATE public.customers AS customer
       SET total_spent_cents =
             COALESCE(customer.total_spent_cents, 0) + p_amount_cents,
           total_orders = COALESCE(customer.total_orders, 0) + 1,
           first_purchase_at = COALESCE(
             customer.first_purchase_at,
             pg_catalog.clock_timestamp()
           ),
           updated_at = pg_catalog.clock_timestamp()
     WHERE customer.id = p_customer_id
       AND customer.guild_id = p_guild_id;
    GET DIAGNOSTICS v_rows_changed = ROW_COUNT;
    IF v_rows_changed = 1 THEN
      UPDATE public.payments AS payment
         SET commerce_customer_totals_recorded_at =
               pg_catalog.clock_timestamp()
       WHERE payment.id = v_payment.id
         AND payment.commerce_customer_totals_recorded_at IS NULL
      RETURNING payment.* INTO v_payment;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'commerce_record_subscription_sale_or_hold: payment aggregate witness raced';
      END IF;
      v_customer_totals_recorded_at :=
        v_payment.commerce_customer_totals_recorded_at;
    ELSE
      v_hold_reason := 'renewal_contract_invalid';
      v_contract_detail := 'customer_revenue_aggregate_identity_missing';
    END IF;
  END IF;

  SELECT held.*
    INTO v_hold
    FROM public.commerce_subscription_sale_holds AS held
   WHERE held.payment_id = v_payment.id
   FOR UPDATE;
  IF FOUND THEN
    IF v_hold.paypal_payment_id IS DISTINCT FROM p_paypal_payment_id
       OR v_hold.order_id IS DISTINCT FROM p_order_id
       OR v_hold.guild_id IS DISTINCT FROM p_guild_id
       OR v_hold.customer_id IS DISTINCT FROM p_customer_id
       OR v_hold.product_id IS DISTINCT FROM p_product_id
       OR v_hold.plan_id IS DISTINCT FROM p_plan_id
       OR v_hold.paypal_subscription_id
            IS DISTINCT FROM p_paypal_subscription_id
       OR v_hold.provider_amount_cents IS DISTINCT FROM p_amount_cents
       OR v_hold.provider_currency IS DISTINCT FROM p_currency
       OR v_hold.stored_order_amount_cents
            IS DISTINCT FROM v_order.amount_cents
       OR v_hold.stored_order_currency IS DISTINCT FROM v_order.currency THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_record_subscription_sale_or_hold: durable hold replay identity mismatch';
    END IF;

    SELECT alert.*
      INTO v_alert
      FROM public.alerts AS alert
     WHERE alert.id = v_hold.alert_id
       AND alert.guild_id = p_guild_id
       AND alert.alert_type IN (
         'commerce_subscription_renewal_financial_mismatch',
         'commerce_subscription_sale_terminal_order',
         'commerce_subscription_sale_contract_invalid'
       )
       AND alert.severity = 'critical'
       AND alert.metadata ->> 'paypal_payment_id' = p_paypal_payment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce_record_subscription_sale_or_hold: durable hold alert identity mismatch';
    END IF;

    IF v_hold.action_id IS NOT NULL THEN
      SELECT queue.*
        INTO v_action
        FROM public.bot_action_queue AS queue
       WHERE queue.id = v_hold.action_id
         AND queue.idempotency_key = v_idempotency_key
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'commerce_record_subscription_sale_or_hold: durable hold action identity mismatch';
      END IF;
    END IF;

    v_disposition := CASE
      WHEN v_payment.status IN ('refunded', 'reversed')
        THEN 'successor_replay'
      WHEN v_hold.hold_reason = 'financial_mismatch'
        THEN 'held_financial_mismatch'
      WHEN v_hold.hold_reason = 'terminal_or_held_order'
        THEN 'held_terminal_order'
      ELSE 'held_contract_invalid'
    END;
    RETURN pg_catalog.jsonb_build_object(
      'disposition', v_disposition,
      'fulfillment_allowed', false,
      'payment_created', v_payment_created,
      'payment_id', v_payment.id,
      'terminal_payment_status', v_payment.status,
      'customer_totals_recorded_at', v_customer_totals_recorded_at,
      'paypal_payment_id', p_paypal_payment_id,
      'paypal_subscription_id', p_paypal_subscription_id,
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'order_status', v_order.status,
      'guild_id', v_order.guild_id,
      'customer_id', v_order.customer_id,
      'product_id', v_order.product_id,
      'plan_id', v_order.plan_id,
      'stored_order_amount_cents', v_order.amount_cents,
      'stored_order_currency', v_order.currency,
      'provider_payment_amount_cents', p_amount_cents,
      'provider_payment_currency', p_currency,
      'hold_reason', v_hold.hold_reason,
      'contract_detail', v_hold.contract_detail,
      'alert_id', v_alert.id,
      'alert_type', v_alert.alert_type,
      'action_id', v_hold.action_id,
      'action', CASE
        WHEN v_action.id IS NULL THEN NULL ELSE v_action.action
      END,
      'action_status', CASE
        WHEN v_action.id IS NULL THEN NULL ELSE v_action.status
      END,
      'idempotency_key', v_idempotency_key,
      'payload', CASE
        WHEN v_action.id IS NULL THEN NULL ELSE v_action.payload
      END
    );
  END IF;

  -- A terminal payment successor is observation-only. Its exact paired order
  -- state was validated above; never recreate fulfillment or overwrite it.
  IF v_payment.status IN ('refunded', 'reversed') THEN
    RETURN pg_catalog.jsonb_build_object(
      'disposition', 'successor_replay',
      'fulfillment_allowed', false,
      'payment_created', v_payment_created,
      'payment_id', v_payment.id,
      'terminal_payment_status', v_payment.status,
      'customer_totals_recorded_at', v_customer_totals_recorded_at,
      'paypal_payment_id', p_paypal_payment_id,
      'paypal_subscription_id', p_paypal_subscription_id,
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'order_status', v_order.status,
      'guild_id', v_order.guild_id,
      'customer_id', v_order.customer_id,
      'product_id', v_order.product_id,
      'plan_id', v_order.plan_id,
      'stored_order_amount_cents', v_order.amount_cents,
      'stored_order_currency', v_order.currency,
      'provider_payment_amount_cents', p_amount_cents,
      'provider_payment_currency', p_currency,
      'hold_reason', NULL,
      'contract_detail', NULL,
      'alert_id', NULL,
      'alert_type', NULL,
      'action_id', NULL,
      'action', NULL,
      'action_status', NULL,
      'idempotency_key', v_idempotency_key,
      'payload', NULL
    );
  END IF;

  IF v_hold_reason IS NULL
     AND v_order.status IS DISTINCT FROM 'completed' THEN
    v_hold_reason := 'terminal_or_held_order';
    v_contract_detail := 'order_status_' || v_order.status;
  ELSIF v_hold_reason IS NULL
        AND (
          v_order.amount_cents IS DISTINCT FROM p_amount_cents
          OR v_order.currency IS DISTINCT FROM p_currency
        ) THEN
    v_hold_reason := 'financial_mismatch';
    v_contract_detail := 'provider_and_stored_financial_identity_differ';
  ELSIF v_hold_reason IS NULL
        AND (
          v_order.paypal_order_id IS NOT NULL
        OR (v_order.source IS NOT NULL AND v_order.source <> 'purchase')
        OR v_order.order_number IS NULL
        OR v_order.order_number <> pg_catalog.btrim(v_order.order_number)
        OR v_order.order_number = ''
        OR v_order.amount_cents IS NULL
        OR v_order.amount_cents < 0
        OR v_order.currency !~ '^[A-Z]{3}$'
        OR pg_catalog.length(v_idempotency_key) > 255
        ) THEN
    v_hold_reason := 'renewal_contract_invalid';
    v_contract_detail := 'paid_order_contract_invalid';
  END IF;

  -- Replay identity is durable queue evidence. Load it before consulting any
  -- historical carrier so a response-loss replay remains exact even when the
  -- customer or catalog has since changed.
  IF v_hold_reason IS NULL THEN
    SELECT queue.*
      INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.idempotency_key = v_idempotency_key
     FOR UPDATE;
  END IF;

  IF v_hold_reason IS NULL THEN
    IF v_order.grant_snapshot_frozen_at IS NOT NULL THEN
      IF NOT pg_catalog.isfinite(v_order.grant_snapshot_frozen_at)
         OR NOT public.commerce_valid_snowflake_snapshot(
           v_order.granted_role_ids_snapshot
         )
         OR v_order.granted_role_ids_snapshot IS DISTINCT FROM
           public.commerce_canonical_snowflake_snapshot(
             v_order.granted_role_ids_snapshot
           )
         OR NOT public.commerce_valid_snowflake_snapshot(
           v_order.granted_channel_ids_snapshot
         )
         OR v_order.granted_channel_ids_snapshot IS DISTINCT FROM
           public.commerce_canonical_snowflake_snapshot(
             v_order.granted_channel_ids_snapshot
           )
         OR v_order.temporary_role_grants_snapshot
              IS DISTINCT FROM '[]'::JSONB THEN
        v_hold_reason := 'renewal_contract_invalid';
        v_contract_detail := 'frozen_grant_contract_invalid';
      ELSE
        v_role_ids := v_order.granted_role_ids_snapshot;
        v_channel_ids := v_order.granted_channel_ids_snapshot;

        -- A new renewal inherits display/delivery identity from the immutable
        -- activation carrier, never from today's mutable customer/product
        -- rows. Existing renewal actions are themselves the replay carrier and
        -- therefore do not depend on this older action still being retained.
        IF v_action.id IS NULL THEN
          SELECT queue.*
            INTO v_activation_action
            FROM public.bot_action_queue AS queue
           WHERE queue.idempotency_key = (
             'paypal:subscription:' || p_paypal_subscription_id
               || ':fulfill_subscription'
           )
           FOR SHARE;
          IF NOT FOUND
             OR v_activation_action.guild_id IS DISTINCT FROM p_guild_id
             OR v_activation_action.action
                  IS DISTINCT FROM 'fulfill_subscription'
             OR v_activation_action.lane IS DISTINCT FROM 'commerce'
             OR v_activation_action.status NOT IN (
               'staged', 'pending', 'processing', 'completed', 'failed'
             )
             OR pg_catalog.jsonb_typeof(v_activation_action.payload)
                  IS DISTINCT FROM 'object'
             OR v_activation_action.payload ->> 'fulfillment_type'
                  IS DISTINCT FROM 'subscription_activated'
             OR v_activation_action.payload ->> 'guild_id'
                  IS DISTINCT FROM p_guild_id
             OR v_activation_action.payload ->> 'customer_id'
                  IS DISTINCT FROM p_customer_id::TEXT
             OR v_activation_action.payload ->> 'product_id'
                  IS DISTINCT FROM p_product_id::TEXT
             OR v_activation_action.payload ->> 'order_id'
                  IS DISTINCT FROM p_order_id::TEXT
             OR v_activation_action.payload ->> 'order_number'
                  IS DISTINCT FROM v_order.order_number
             OR v_activation_action.payload ->> 'plan_id'
                  IS DISTINCT FROM p_plan_id::TEXT
             OR v_activation_action.payload ->> 'paypal_subscription_id'
                  IS DISTINCT FROM p_paypal_subscription_id
             OR v_activation_action.payload ->> 'entitlement_type'
                  IS DISTINCT FROM 'subscription'
             OR v_activation_action.payload -> 'amount_cents'
                  IS DISTINCT FROM pg_catalog.to_jsonb(v_order.amount_cents)
             OR v_activation_action.payload ->> 'currency'
                  IS DISTINCT FROM v_order.currency
             OR v_activation_action.payload ->> 'discord_id' IS NULL
             OR v_activation_action.payload ->> 'discord_id'
                  !~ '^[0-9]{17,20}$'
             OR v_activation_action.payload ->> 'product_name' IS NULL
             OR v_activation_action.payload ->> 'product_name'
                  <> pg_catalog.btrim(
                    v_activation_action.payload ->> 'product_name'
                  )
             OR v_activation_action.payload ->> 'product_name' = ''
             OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
               v_activation_action.payload -> 'granted_role_ids',
               v_role_ids
             )
             OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
               v_activation_action.payload -> 'granted_channel_ids',
               v_channel_ids
             ) THEN
            v_hold_reason := 'renewal_contract_invalid';
            v_contract_detail :=
              'durable_activation_carrier_missing_or_invalid';
          ELSE
            v_carrier_discord_id :=
              v_activation_action.payload ->> 'discord_id';
            v_carrier_product_name :=
              v_activation_action.payload ->> 'product_name';
            v_carrier_paypal_plan_id :=
              v_activation_action.payload ->> 'paypal_plan_id';
          END IF;
        END IF;
      END IF;
    ELSE
      SELECT legacy.*
        INTO v_legacy
        FROM public.commerce_legacy_subscription_grant_contracts AS legacy
       WHERE legacy.order_id = p_order_id
       FOR KEY SHARE;
      IF NOT FOUND
         OR v_legacy.guild_id IS DISTINCT FROM p_guild_id
         OR v_legacy.customer_id IS DISTINCT FROM p_customer_id
         OR v_legacy.product_id IS DISTINCT FROM p_product_id
         OR v_legacy.order_number IS DISTINCT FROM v_order.order_number
         OR v_legacy.plan_id IS DISTINCT FROM p_plan_id
         OR v_legacy.paypal_subscription_id
              IS DISTINCT FROM p_paypal_subscription_id
         OR v_legacy.amount_cents IS DISTINCT FROM v_order.amount_cents
         OR v_legacy.currency IS DISTINCT FROM v_order.currency
         OR v_legacy.discord_id IS NULL
         OR v_legacy.discord_id <> pg_catalog.btrim(v_legacy.discord_id)
         OR v_legacy.discord_id = ''
         OR v_legacy.product_name IS NULL
         OR v_legacy.product_name <> pg_catalog.btrim(v_legacy.product_name)
         OR v_legacy.product_name = ''
         OR v_legacy.paypal_plan_id IS NULL
         OR v_legacy.paypal_plan_id
              <> pg_catalog.btrim(v_legacy.paypal_plan_id)
         OR v_legacy.paypal_plan_id = ''
         OR NOT pg_catalog.isfinite(v_legacy.persisted_at) THEN
        v_hold_reason := 'renewal_contract_invalid';
        v_contract_detail := 'legacy_grant_contract_missing_or_invalid';
      ELSE
        v_has_legacy := true;
        v_role_ids := v_legacy.granted_role_ids_snapshot;
        v_channel_ids := v_legacy.granted_channel_ids_snapshot;
        v_carrier_discord_id := v_legacy.discord_id;
        v_carrier_product_name := v_legacy.product_name;
        v_carrier_paypal_plan_id := v_legacy.paypal_plan_id;
      END IF;
    END IF;
  END IF;

  IF v_hold_reason IS NULL THEN
    IF v_entitlement.id IS NULL
       OR v_entitlement.type IS DISTINCT FROM 'subscription'
       OR v_entitlement.status NOT IN (
         'active',
         'pending',
         'grace_period',
         'suspended',
         'cancelled',
         'expired'
       )
       OR (
         v_action.id IS NULL
         AND v_entitlement.status IN ('cancelled', 'expired')
       )
       OR (
         v_entitlement.source IS NOT NULL
         AND v_entitlement.source <> 'purchase'
       )
       OR v_entitlement.granted_role_ids IS DISTINCT FROM v_role_ids
       OR v_entitlement.granted_channel_ids IS DISTINCT FROM v_channel_ids THEN
      v_hold_reason := 'renewal_contract_invalid';
      v_contract_detail := 'subscription_entitlement_missing_or_invalid';
    END IF;
  END IF;

  IF v_hold_reason IS NULL THEN
    IF v_action.id IS NULL THEN
      IF v_hold_reason IS NULL THEN
        v_payload := pg_catalog.jsonb_build_object(
          'fulfillment_type', 'subscription_renewed',
          'guild_id', p_guild_id,
          'customer_id', p_customer_id,
          'discord_id', v_carrier_discord_id,
          'product_id', p_product_id,
          'product_name', v_carrier_product_name,
          'order_id', p_order_id,
          'order_number', v_order.order_number,
          'plan_id', p_plan_id,
          'paypal_subscription_id', p_paypal_subscription_id,
          'webhook_event_id', v_lifecycle_event.webhook_event_id,
          'provider_event_type', v_lifecycle_event.provider_event_type,
          'provider_occurred_at', v_lifecycle_event.provider_occurred_at,
          'provider_paid_through_at',
            v_lifecycle_event.provider_paid_through_at,
          'lifecycle_generation', v_lifecycle_event.generation,
          'amount_cents', v_order.amount_cents,
          'currency', v_order.currency,
          'granted_role_ids', pg_catalog.to_jsonb(v_role_ids),
          'granted_channel_ids', pg_catalog.to_jsonb(v_channel_ids),
          'entitlement_type', 'subscription',
          'existing_entitlement_id', v_entitlement.id
        ) || CASE
          WHEN v_carrier_paypal_plan_id IS NOT NULL THEN
            pg_catalog.jsonb_build_object(
            'paypal_plan_id', v_carrier_paypal_plan_id
          )
          ELSE '{}'::JSONB
        END;

        INSERT INTO public.bot_action_queue (
          guild_id,
          action,
          payload,
          status,
          lane,
          idempotency_key
        ) VALUES (
          p_guild_id,
          'fulfill_subscription',
          v_payload,
          'pending',
          'commerce',
          v_idempotency_key
        )
        ON CONFLICT (idempotency_key)
          WHERE idempotency_key IS NOT NULL
          DO NOTHING
        RETURNING * INTO v_action;
        v_action_created := FOUND;

        IF NOT v_action_created THEN
          SELECT queue.*
            INTO v_action
            FROM public.bot_action_queue AS queue
           WHERE queue.idempotency_key = v_idempotency_key
           FOR UPDATE;
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_hold_reason IS NULL THEN
    IF v_action.id IS NULL
       OR v_action.guild_id IS DISTINCT FROM p_guild_id
       OR v_action.action IS DISTINCT FROM 'fulfill_subscription'
       OR v_action.lane IS DISTINCT FROM 'commerce'
       OR v_action.status NOT IN (
         'staged', 'pending', 'processing', 'completed', 'failed'
       )
       OR pg_catalog.jsonb_typeof(v_action.payload) IS DISTINCT FROM 'object'
       OR v_action.payload ->> 'fulfillment_type'
            IS DISTINCT FROM 'subscription_renewed'
       OR v_action.payload ->> 'guild_id' IS DISTINCT FROM p_guild_id
       OR v_action.payload ->> 'customer_id'
            IS DISTINCT FROM p_customer_id::TEXT
       OR v_action.payload ->> 'product_id'
            IS DISTINCT FROM p_product_id::TEXT
       OR v_action.payload ->> 'order_id' IS DISTINCT FROM p_order_id::TEXT
       OR v_action.payload ->> 'order_number'
            IS DISTINCT FROM v_order.order_number
       OR v_action.payload ->> 'plan_id' IS DISTINCT FROM p_plan_id::TEXT
       OR v_action.payload ->> 'paypal_subscription_id'
            IS DISTINCT FROM p_paypal_subscription_id
       OR v_action.payload ->> 'webhook_event_id'
            IS DISTINCT FROM v_lifecycle_event.webhook_event_id
       OR v_action.payload ->> 'provider_event_type'
            IS DISTINCT FROM v_lifecycle_event.provider_event_type
       OR (v_action.payload ->> 'provider_occurred_at')::TIMESTAMPTZ
            IS DISTINCT FROM v_lifecycle_event.provider_occurred_at
       OR (v_action.payload ->> 'provider_paid_through_at')::TIMESTAMPTZ
            IS DISTINCT FROM v_lifecycle_event.provider_paid_through_at
       OR pg_catalog.jsonb_typeof(
            v_action.payload -> 'lifecycle_generation'
          ) IS DISTINCT FROM 'number'
       OR (v_action.payload ->> 'lifecycle_generation')::BIGINT
            IS DISTINCT FROM v_lifecycle_event.generation
       OR v_action.payload -> 'amount_cents'
            IS DISTINCT FROM pg_catalog.to_jsonb(v_order.amount_cents)
       OR v_action.payload ->> 'currency' IS DISTINCT FROM v_order.currency
       OR v_action.payload ->> 'entitlement_type'
            IS DISTINCT FROM 'subscription'
       OR v_action.payload ->> 'existing_entitlement_id'
            IS DISTINCT FROM v_entitlement.id::TEXT
       OR v_action.payload ->> 'discord_id' IS NULL
       OR pg_catalog.btrim(v_action.payload ->> 'discord_id') = ''
       OR v_action.payload ->> 'product_name' IS NULL
       OR pg_catalog.btrim(v_action.payload ->> 'product_name') = ''
       OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
         v_action.payload -> 'granted_role_ids',
         v_role_ids
       )
       OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
         v_action.payload -> 'granted_channel_ids',
         v_channel_ids
       )
       OR (
         v_has_legacy
         AND (
           v_action.payload ->> 'discord_id'
             IS DISTINCT FROM v_legacy.discord_id
           OR v_action.payload ->> 'product_name'
             IS DISTINCT FROM v_legacy.product_name
           OR v_action.payload ->> 'paypal_plan_id'
             IS DISTINCT FROM v_legacy.paypal_plan_id
         )
       ) THEN
      IF v_action.id IS NOT NULL
         AND v_action.status IN ('staged', 'pending') THEN
        UPDATE public.bot_action_queue AS queue
           SET status = 'failed',
               error = 'Renewal carrier identity mismatch; payment held for operator review',
               processed_at = pg_catalog.clock_timestamp(),
               next_retry_at = NULL
         WHERE queue.id = v_action.id
           AND queue.status IN ('staged', 'pending')
        RETURNING queue.* INTO v_action;
      END IF;
      v_hold_reason := 'renewal_contract_invalid';
      v_contract_detail := CASE
        WHEN v_action.status IN ('processing', 'completed') THEN
          'renewal_action_identity_mismatch_reconciliation_required_'
            || v_action.status
        ELSE 'renewal_action_identity_mismatch'
      END;
    ELSIF v_entitlement.status IN ('cancelled', 'expired') THEN
      IF v_action.status IN ('staged', 'pending') THEN
        UPDATE public.bot_action_queue AS queue
           SET status = 'failed',
               error = 'Renewal superseded by terminal subscription lifecycle state',
               processed_at = pg_catalog.clock_timestamp(),
               next_retry_at = NULL
         WHERE queue.id = v_action.id
           AND queue.status IN ('staged', 'pending')
        RETURNING queue.* INTO v_action;
      END IF;
      RETURN pg_catalog.jsonb_build_object(
        'disposition', 'superseded_replay',
        'fulfillment_allowed', false,
        'payment_created', v_payment_created,
        'payment_id', v_payment.id,
        'terminal_payment_status', v_payment.status,
        'customer_totals_recorded_at', v_customer_totals_recorded_at,
        'paypal_payment_id', p_paypal_payment_id,
        'paypal_subscription_id', p_paypal_subscription_id,
        'order_id', v_order.id,
        'order_number', v_order.order_number,
        'order_status', v_order.status,
        'guild_id', v_order.guild_id,
        'customer_id', v_order.customer_id,
        'product_id', v_order.product_id,
        'plan_id', v_order.plan_id,
        'stored_order_amount_cents', v_order.amount_cents,
        'stored_order_currency', v_order.currency,
        'provider_payment_amount_cents', p_amount_cents,
        'provider_payment_currency', p_currency,
        'hold_reason', NULL,
        'contract_detail',
          'accepted_sale_action_superseded_by_entitlement_'
            || v_entitlement.status,
        'alert_id', NULL,
        'alert_type', NULL,
        'action_id', v_action.id,
        'action', v_action.action,
        'action_status', v_action.status,
        'idempotency_key', v_action.idempotency_key,
        'payload', v_action.payload
      );
    ELSIF v_action.status = 'failed' THEN
      v_hold_reason := 'renewal_action_failed';
      v_contract_detail := 'renewal_action_already_failed';
    ELSIF v_action.status = 'staged' THEN
      SELECT released.action_status
        INTO v_release_status
        FROM public.bot_action_queue_release_staged(
          v_action.id,
          p_guild_id,
          v_idempotency_key
        ) AS released;
      IF v_release_status NOT IN (
        'pending', 'processing', 'completed', 'failed'
      ) THEN
        v_hold_reason := 'renewal_contract_invalid';
        v_contract_detail := 'staged_renewal_action_release_failed';
      ELSE
        SELECT queue.*
          INTO v_action
          FROM public.bot_action_queue AS queue
         WHERE queue.id = v_action.id
         FOR UPDATE;
        IF v_action.status = 'failed' THEN
          v_hold_reason := 'renewal_action_failed';
          v_contract_detail := 'renewal_action_already_failed';
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_hold_reason IS NULL THEN
    v_disposition := CASE
      WHEN v_action_created THEN 'staged'
      ELSE 'replay'
    END;
    RETURN pg_catalog.jsonb_build_object(
      'disposition', v_disposition,
      'fulfillment_allowed', true,
      'payment_created', v_payment_created,
      'payment_id', v_payment.id,
      'terminal_payment_status', v_payment.status,
      'customer_totals_recorded_at', v_customer_totals_recorded_at,
      'paypal_payment_id', p_paypal_payment_id,
      'paypal_subscription_id', p_paypal_subscription_id,
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'order_status', v_order.status,
      'guild_id', v_order.guild_id,
      'customer_id', v_order.customer_id,
      'product_id', v_order.product_id,
      'plan_id', v_order.plan_id,
      'stored_order_amount_cents', v_order.amount_cents,
      'stored_order_currency', v_order.currency,
      'provider_payment_amount_cents', p_amount_cents,
      'provider_payment_currency', p_currency,
      'hold_reason', NULL,
      'contract_detail', NULL,
      'alert_id', NULL,
      'alert_type', NULL,
      'action_id', v_action.id,
      'action', v_action.action,
      'action_status', v_action.status,
      'idempotency_key', v_action.idempotency_key,
      'payload', v_action.payload
    );
  END IF;

  IF v_order.status = 'pending' THEN
    UPDATE public.orders AS paid_order
       SET status = 'pending_review',
           checkout_active = false,
           updated_at = pg_catalog.clock_timestamp()
     WHERE paid_order.id = v_order.id
       AND paid_order.status = 'pending'
    RETURNING paid_order.* INTO v_order;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'commerce_record_subscription_sale_or_hold: order hold transition raced';
    END IF;
  END IF;

  v_alert_type := CASE v_hold_reason
    WHEN 'financial_mismatch'
      THEN 'commerce_subscription_renewal_financial_mismatch'
    WHEN 'terminal_or_held_order'
      THEN 'commerce_subscription_sale_terminal_order'
    ELSE 'commerce_subscription_sale_contract_invalid'
  END;
  v_alert_title := CASE v_hold_reason
    WHEN 'financial_mismatch'
      THEN 'Subscription renewal charge does not match the stored contract'
    WHEN 'terminal_or_held_order'
      THEN 'Provider charged a terminal or held subscription'
    ELSE 'Provider charged a subscription whose renewal contract is unsafe'
  END;
  v_alert_message := 'PayPal sale ' || p_paypal_payment_id
    || ' charged ' || p_amount_cents::TEXT || ' ' || p_currency
    || ' for subscription ' || p_paypal_subscription_id
    || ', but automatic renewal fulfillment was permanently withheld ('
    || v_contract_detail || '). Reconcile the exact provider payment and '
    || 'stored order; refund or fulfil manually as appropriate.';
  v_alert_metadata := pg_catalog.jsonb_build_object(
    'source', 'paypal_webhook',
    'paypal_payment_id', p_paypal_payment_id,
    'paypal_subscription_id', p_paypal_subscription_id,
    'payment_id', v_payment.id,
    'payment_status', v_payment.status,
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'order_status', v_order.status,
    'guild_id', v_order.guild_id,
    'customer_id', v_order.customer_id,
    'product_id', v_order.product_id,
    'plan_id', v_order.plan_id,
    'stored_order_amount_cents', v_order.amount_cents,
    'stored_order_currency', v_order.currency,
    'provider_payment_amount_cents', p_amount_cents,
    'provider_payment_currency', p_currency,
    'hold_reason', v_hold_reason,
    'contract_detail', v_contract_detail,
    'action_id', v_action.id,
    'required_action', 'reconcile_subscription_sale_then_refund_or_fulfill_manually'
  );

  INSERT INTO public.alerts (
    guild_id,
    alert_type,
    severity,
    title,
    message,
    metadata
  ) VALUES (
    p_guild_id,
    v_alert_type,
    'critical',
    v_alert_title,
    v_alert_message,
    v_alert_metadata
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_alert;
  IF NOT FOUND THEN
    SELECT alert.*
      INTO v_alert
      FROM public.alerts AS alert
     WHERE alert.alert_type IN (
       'commerce_subscription_renewal_financial_mismatch',
       'commerce_subscription_sale_terminal_order',
       'commerce_subscription_sale_contract_invalid'
     )
       AND alert.resolved = false
       AND alert.metadata ->> 'paypal_payment_id' = p_paypal_payment_id
     ORDER BY alert.created_at, alert.id
     LIMIT 1
     FOR UPDATE;
  END IF;
  IF v_alert.id IS NULL
     OR v_alert.guild_id IS DISTINCT FROM p_guild_id
     OR v_alert.alert_type IS DISTINCT FROM v_alert_type
     OR v_alert.severity IS DISTINCT FROM 'critical'
     OR v_alert.metadata ->> 'payment_id' IS DISTINCT FROM v_payment.id::TEXT
     OR v_alert.metadata ->> 'order_id' IS DISTINCT FROM v_order.id::TEXT THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_record_subscription_sale_or_hold: critical sale alert was not persisted exactly';
  END IF;

  INSERT INTO public.commerce_subscription_sale_holds (
    payment_id,
    paypal_payment_id,
    order_id,
    guild_id,
    customer_id,
    product_id,
    plan_id,
    paypal_subscription_id,
    hold_reason,
    contract_detail,
    observed_order_status,
    provider_amount_cents,
    provider_currency,
    stored_order_amount_cents,
    stored_order_currency,
    alert_id,
    action_id
  ) VALUES (
    v_payment.id,
    p_paypal_payment_id,
    v_order.id,
    v_order.guild_id,
    v_order.customer_id,
    v_order.product_id,
    v_order.plan_id,
    p_paypal_subscription_id,
    v_hold_reason,
    v_contract_detail,
    v_order.status,
    p_amount_cents,
    p_currency,
    v_order.amount_cents,
    v_order.currency,
    v_alert.id,
    v_action.id
  )
  ON CONFLICT (payment_id) DO NOTHING
  RETURNING * INTO v_hold;
  IF NOT FOUND THEN
    SELECT held.*
      INTO v_hold
      FROM public.commerce_subscription_sale_holds AS held
     WHERE held.payment_id = v_payment.id
     FOR UPDATE;
  END IF;
  IF v_hold.payment_id IS DISTINCT FROM v_payment.id
     OR v_hold.alert_id IS DISTINCT FROM v_alert.id
     OR v_hold.hold_reason IS DISTINCT FROM v_hold_reason
     OR v_hold.contract_detail IS DISTINCT FROM v_contract_detail
     OR v_hold.paypal_payment_id IS DISTINCT FROM p_paypal_payment_id
     OR v_hold.order_id IS DISTINCT FROM v_order.id THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'commerce_record_subscription_sale_or_hold: durable sale hold was not persisted exactly';
  END IF;

  v_disposition := CASE
    WHEN v_hold_reason = 'financial_mismatch'
      THEN 'held_financial_mismatch'
    WHEN v_hold_reason = 'terminal_or_held_order'
      THEN 'held_terminal_order'
    ELSE 'held_contract_invalid'
  END;
  RETURN pg_catalog.jsonb_build_object(
    'disposition', v_disposition,
    'fulfillment_allowed', false,
    'payment_created', v_payment_created,
    'payment_id', v_payment.id,
    'terminal_payment_status', v_payment.status,
    'customer_totals_recorded_at', v_customer_totals_recorded_at,
    'paypal_payment_id', p_paypal_payment_id,
    'paypal_subscription_id', p_paypal_subscription_id,
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'order_status', v_order.status,
    'guild_id', v_order.guild_id,
    'customer_id', v_order.customer_id,
    'product_id', v_order.product_id,
    'plan_id', v_order.plan_id,
    'stored_order_amount_cents', v_order.amount_cents,
    'stored_order_currency', v_order.currency,
    'provider_payment_amount_cents', p_amount_cents,
    'provider_payment_currency', p_currency,
    'hold_reason', v_hold.hold_reason,
    'contract_detail', v_hold.contract_detail,
    'alert_id', v_alert.id,
    'alert_type', v_alert.alert_type,
    'action_id', v_action.id,
    'action', CASE WHEN v_action.id IS NULL THEN NULL ELSE v_action.action END,
    'action_status',
      CASE WHEN v_action.id IS NULL THEN NULL ELSE v_action.status END,
    'idempotency_key', v_idempotency_key,
    'payload', CASE WHEN v_action.id IS NULL THEN NULL ELSE v_action.payload END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_record_subscription_sale_or_hold(
  TEXT, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT, BIGINT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_record_subscription_sale_or_hold(
  TEXT, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT, BIGINT, INTEGER, TEXT
) TO service_role;

-- Keep the privacy RPC current with every new RESTRICT-backed commerce rail.
CREATE OR REPLACE FUNCTION public.purge_guild_data(p_guild_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_controller_ids UUID[] := '{}'::UUID[];
  v_unresolved_intents INTEGER := 0;
  v_active_temp_grants INTEGER := 0;
  v_active_queue_actions INTEGER := 0;
  v_active_dlq_actions INTEGER := 0;
  v_pending INTEGER := 0;
BEGIN
  IF p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'purge_guild_data: canonical p_guild_id is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-guild-purge:' || p_guild_id,
      0
    )
  );
  PERFORM guild.id
    FROM public.guild AS guild
   WHERE guild.id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'purge_status', 'completed',
      'pending_role_cleanup_count', 0,
      'guild_deleted', 0
    );
  END IF;

  -- Preserve the global parent -> entitlement lock order before cancellation
  -- triggers acquire their per-customer advisory locks. A completed capture
  -- payment has a deferred FK to orders(id, status), so a completed parent
  -- cannot be changed on the pending-return path. Lock the parents now, retire
  -- still-payable pending checkouts immediately, and include pending-review
  -- parents in this first ordered lock set because fulfillment claim/hold
  -- replay accepts and locks them before its hold row. Then transition
  -- completed parents only after exact role cleanup has converged and this
  -- same transaction will delete the payment children.
  PERFORM paid_order.id
    FROM public.orders AS paid_order
   WHERE paid_order.guild_id = p_guild_id
     AND paid_order.status IN ('pending', 'completed', 'pending_review')
   ORDER BY paid_order.id
   FOR UPDATE;
  UPDATE public.orders AS paid_order
     SET status = 'cancelled',
         updated_at = pg_catalog.clock_timestamp()
   WHERE paid_order.guild_id = p_guild_id
     AND paid_order.status = 'pending'
     AND (
       NOT COALESCE(
         paid_order.source = 'purchase' OR paid_order.source IS NULL,
         false
       )
       OR (
         paid_order.paypal_order_id IS NULL
         AND paid_order.paypal_subscription_id IS NULL
       )
       OR EXISTS (
         SELECT 1
           FROM public.commerce_checkout_deactivation_proofs AS proof
          WHERE proof.order_id = paid_order.id
            AND proof.guild_id = paid_order.guild_id
            AND proof.customer_id = paid_order.customer_id
            AND proof.product_id = paid_order.product_id
            AND (
              (
                proof.provider_kind = 'capture'
                AND proof.provider_id = paid_order.paypal_order_id
                AND paid_order.paypal_subscription_id IS NULL
              )
              OR (
                proof.provider_kind = 'subscription'
                AND proof.provider_id = paid_order.paypal_subscription_id
                AND paid_order.paypal_order_id IS NULL
              )
            )
       )
     );
  -- Make every entitlement delivery classifier terminal before touching
  -- retained protocol evidence. Its status trigger signals the exact cleanup
  -- intents idempotently. The deletion phase later removes entitlements before
  -- customers, consistent with the canonical entitlement -> advisory ->
  -- customer order used by every per-customer acquirer (revoke, relink worker,
  -- enqueue triggers, member purge).
  UPDATE public.entitlements AS entitlement
     SET status = 'cancelled',
         cancelled_at = COALESCE(
           entitlement.cancelled_at,
           pg_catalog.clock_timestamp()
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE entitlement.guild_id = p_guild_id
     AND entitlement.status IN (
       'active', 'pending', 'grace_period', 'suspended'
     );
  UPDATE public.license_sessions AS session
     SET active = false,
         deactivated_at = COALESCE(
           session.deactivated_at,
           pg_catalog.clock_timestamp()
         ),
         deactivation_reason = 'entitlement_revoked'
   WHERE session.active = true
     AND EXISTS (
       SELECT 1
         FROM public.license_keys AS license_key
        WHERE license_key.id = session.license_key_id
          AND license_key.guild_id = p_guild_id
     );
  UPDATE public.license_keys AS license_key
     SET status = 'revoked',
         revoked_at = COALESCE(
           license_key.revoked_at,
           pg_catalog.clock_timestamp()
         ),
         revocation_reason = 'guild_data_purge',
         updated_at = pg_catalog.clock_timestamp()
   WHERE license_key.guild_id = p_guild_id
     AND license_key.status <> 'revoked';

  SELECT COALESCE(
           pg_catalog.array_agg(
             controller.action_id ORDER BY controller.action_id
           ),
           '{}'::UUID[]
         )
    INTO v_controller_ids
    FROM (
      SELECT intent.action_id
        FROM public.commerce_role_delivery_intents AS intent
       WHERE intent.guild_id = p_guild_id
      UNION
      SELECT intent.cleanup_action_id
        FROM public.commerce_role_delivery_intents AS intent
       WHERE intent.guild_id = p_guild_id
         AND intent.cleanup_action_id IS NOT NULL
    ) AS controller(action_id);

  UPDATE public.action_queue_dlq AS dlq
     SET retried = true,
         retried_at = COALESCE(
           dlq.retried_at,
           pg_catalog.clock_timestamp()
         ),
         error_message = COALESCE(dlq.error_message || ' | ', '')
           || 'Retired after exact role-delivery controller settled'
   WHERE dlq.guild_id = p_guild_id
     AND (
       dlq.original_id = ANY(v_controller_ids::TEXT[])
       OR EXISTS (
         SELECT 1
           FROM public.bot_action_queue AS queue
          WHERE queue.id::TEXT = dlq.original_id
            AND queue.guild_id = dlq.guild_id
            AND queue.action = dlq.action
            AND queue.lane = dlq.lane
            AND queue.payload = dlq.payload
            AND queue.status = 'completed'
            AND public.commerce_noncommerce_cleanup_carrier_kind(
              queue.guild_id,
              queue.action,
              queue.lane,
              queue.idempotency_key,
              queue.payload
            ) IS NOT NULL
       )
     )
     AND COALESCE(dlq.retried, false) = false
     AND EXISTS (
       SELECT 1
         FROM public.bot_action_queue AS queue
        WHERE queue.id::TEXT = dlq.original_id
          AND queue.status = 'completed'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.commerce_role_delivery_intents AS intent
        WHERE intent.guild_id = p_guild_id
          AND intent.state <> 'settled'
          AND (
            intent.action_id::TEXT = dlq.original_id
            OR intent.cleanup_action_id::TEXT = dlq.original_id
          )
     );

  SELECT pg_catalog.count(*)::INTEGER
    INTO v_unresolved_intents
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.guild_id = p_guild_id
     AND intent.state <> 'settled';
  SELECT pg_catalog.count(*)::INTEGER
    INTO v_active_temp_grants
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.guild_id = p_guild_id
     AND grant_row.remove_on_expiry = true
     AND grant_row.grant_status IN ('pending', 'applied');
  SELECT pg_catalog.count(*)::INTEGER
    INTO v_active_queue_actions
    FROM public.bot_action_queue AS queue
   WHERE queue.guild_id = p_guild_id
     AND (
       queue.status IN ('staged', 'pending', 'processing')
       OR (
         queue.status = 'failed'
         AND public.commerce_noncommerce_cleanup_carrier_kind(
           queue.guild_id,
           queue.action,
           queue.lane,
           queue.idempotency_key,
           queue.payload
         ) IS NOT NULL
       )
     );
  SELECT pg_catalog.count(*)::INTEGER
    INTO v_active_dlq_actions
    FROM public.action_queue_dlq AS dlq
   WHERE dlq.guild_id = p_guild_id
     AND COALESCE(dlq.retried, false) = false
     AND (
       dlq.original_id = ANY(v_controller_ids::TEXT[])
       OR EXISTS (
         SELECT 1
           FROM public.bot_action_queue AS queue
          WHERE queue.id::TEXT = dlq.original_id
            AND queue.guild_id = dlq.guild_id
            AND queue.action = dlq.action
            AND queue.lane = dlq.lane
            AND queue.payload = dlq.payload
            AND public.commerce_noncommerce_cleanup_carrier_kind(
              queue.guild_id,
              queue.action,
              queue.lane,
              queue.idempotency_key,
              queue.payload
            ) IS NOT NULL
       )
     );

  v_pending := v_unresolved_intents
    + v_active_temp_grants
    + v_active_queue_actions
    + v_active_dlq_actions;
  IF v_pending > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'purge_status', 'pending_role_cleanup',
      'pending_role_cleanup_count', v_pending,
      'unresolved_role_delivery_intents', v_unresolved_intents,
      'active_owned_temp_role_grants', v_active_temp_grants,
      'active_queue_actions', v_active_queue_actions,
      'active_commerce_dlq_actions', v_active_dlq_actions,
      'guild_deleted', 0
    );
  END IF;

  -- Exact cleanup has converged, so no pending return can leave the deferred
  -- capture-payment FK inconsistent. The matching child payments are deleted
  -- below before this transaction commits.
  UPDATE public.orders AS paid_order
     SET status = 'cancelled',
         updated_at = pg_catalog.clock_timestamp()
   WHERE paid_order.guild_id = p_guild_id
     AND paid_order.status = 'pending';

  UPDATE public.orders AS paid_order
     SET status = 'cancelled',
         updated_at = pg_catalog.clock_timestamp()
   WHERE paid_order.guild_id = p_guild_id
     AND paid_order.status = 'completed';

  -- Exact cleanup has converged. Remove protocol/controller tombstones before
  -- parents, then execute the established guild purge in dependency order.
  DELETE FROM public.action_queue_dlq WHERE guild_id = p_guild_id;
  DELETE FROM public.commerce_noncommerce_activation_heads
   WHERE guild_id = p_guild_id;
  DELETE FROM public.bot_action_queue WHERE guild_id = p_guild_id;
  DELETE FROM public.dead_letter_queue WHERE guild_id = p_guild_id;
  DELETE FROM public.commerce_role_delivery_intents WHERE guild_id = p_guild_id;
  DELETE FROM public.commerce_legacy_subscription_grant_contracts
   WHERE guild_id = p_guild_id;
  DELETE FROM public.temp_role_grants WHERE guild_id = p_guild_id;

  DELETE FROM public.workflow_events WHERE guild_id = p_guild_id;
  DELETE FROM public.automation_executions WHERE guild_id = p_guild_id;
  DELETE FROM public.sync_actions WHERE guild_id = p_guild_id;
  DELETE FROM public.sync_reports WHERE guild_id = p_guild_id;
  DELETE FROM public.reconciliation_runs WHERE guild_id = p_guild_id;
  DELETE FROM public.webhook_events WHERE guild_id = p_guild_id;
  DELETE FROM public.bot_diagnostics WHERE guild_id = p_guild_id;
  DELETE FROM public.health_metrics WHERE guild_id = p_guild_id;

  DELETE FROM public.commerce_admin_refund_operations WHERE guild_id = p_guild_id;
  DELETE FROM public.payment_refunds WHERE guild_id = p_guild_id;
  DELETE FROM public.commerce_provider_incidents
   WHERE observed_guild_id = p_guild_id
      OR routable_guild_id = p_guild_id;
  DELETE FROM public.portal_sessions WHERE guild_id = p_guild_id;
  DELETE FROM public.fraud_signals WHERE guild_id = p_guild_id;
  DELETE FROM public.license_validations AS validation
   WHERE EXISTS (
     SELECT 1 FROM public.license_keys AS license_key
      WHERE license_key.id = validation.license_key_id
        AND license_key.guild_id = p_guild_id
   ) OR EXISTS (
     SELECT 1 FROM public.products AS product
      WHERE product.id = validation.product_id
        AND product.guild_id = p_guild_id
   );
  DELETE FROM public.license_sessions AS session
   WHERE EXISTS (
     SELECT 1 FROM public.license_keys AS license_key
      WHERE license_key.id = session.license_key_id
        AND license_key.guild_id = p_guild_id
   );
  -- Checkout/payment rails intentionally use RESTRICT FKs so ordinary parent
  -- deletion cannot erase money-path evidence. A completed privacy purge is
  -- the one explicit erasure boundary: lock and delete holds, then claims,
  -- before their entitlement/order parents.
  PERFORM held.payment_id
    FROM public.commerce_subscription_sale_holds AS held
   WHERE held.guild_id = p_guild_id
   ORDER BY held.payment_id
   FOR UPDATE;
  DELETE FROM public.commerce_subscription_sale_holds
   WHERE guild_id = p_guild_id;
  -- Lifecycle receipts reference the immutable money/order carrier with
  -- RESTRICT FKs. The explicit privacy purge removes children before the
  -- serialized head and only then proceeds to entitlement/order parents.
  PERFORM lifecycle_event.webhook_event_id
    FROM public.commerce_subscription_lifecycle_events AS lifecycle_event
   WHERE lifecycle_event.guild_id = p_guild_id
   ORDER BY lifecycle_event.webhook_event_id
   FOR UPDATE;
  DELETE FROM public.commerce_subscription_lifecycle_events
   WHERE guild_id = p_guild_id;
  PERFORM lifecycle_head.paypal_subscription_id
    FROM public.commerce_subscription_lifecycle_heads AS lifecycle_head
   WHERE lifecycle_head.guild_id = p_guild_id
   ORDER BY lifecycle_head.paypal_subscription_id
   FOR UPDATE;
  DELETE FROM public.commerce_subscription_lifecycle_heads
   WHERE guild_id = p_guild_id;
  PERFORM held.order_id
    FROM public.commerce_fulfillment_holds AS held
   WHERE held.guild_id = p_guild_id
   ORDER BY held.order_id
   FOR UPDATE;
  DELETE FROM public.commerce_fulfillment_holds
   WHERE guild_id = p_guild_id;
  PERFORM claim.guild_id, claim.customer_id, claim.product_id
    FROM public.commerce_fulfillment_claims AS claim
   WHERE claim.guild_id = p_guild_id
   ORDER BY claim.guild_id, claim.customer_id, claim.product_id
   FOR UPDATE;
  DELETE FROM public.commerce_fulfillment_claims
   WHERE guild_id = p_guild_id;
  PERFORM intent.order_id, intent.intent_kind
    FROM public.commerce_fulfillment_outward_intents AS intent
   WHERE intent.guild_id = p_guild_id
   ORDER BY intent.order_id, intent.intent_kind
   FOR UPDATE;
  DELETE FROM public.commerce_fulfillment_outward_intents
   WHERE guild_id = p_guild_id;
  PERFORM proof.order_id
    FROM public.commerce_checkout_deactivation_proofs AS proof
   WHERE proof.guild_id = p_guild_id
   ORDER BY proof.order_id
   FOR UPDATE;
  DELETE FROM public.commerce_checkout_deactivation_proofs
   WHERE guild_id = p_guild_id;

  DELETE FROM public.entitlements WHERE guild_id = p_guild_id;
  DELETE FROM public.license_keys WHERE guild_id = p_guild_id;
  DELETE FROM public.payments WHERE guild_id = p_guild_id;
  DELETE FROM public.orders WHERE guild_id = p_guild_id;
  DELETE FROM public.customers WHERE guild_id = p_guild_id;
  DELETE FROM public.giveaways WHERE guild_id = p_guild_id;
  DELETE FROM public.promotions WHERE guild_id = p_guild_id;
  DELETE FROM public.plans WHERE guild_id = p_guild_id;
  DELETE FROM public.product_files WHERE guild_id = p_guild_id;
  DELETE FROM public.commerce_product_temp_role_config WHERE guild_id = p_guild_id;
  DELETE FROM public.commerce_role_metadata_migration_issues WHERE guild_id = p_guild_id;
  DELETE FROM public.commerce_temp_role_migration_issues WHERE guild_id = p_guild_id;
  DELETE FROM public.products WHERE guild_id = p_guild_id;
  DELETE FROM public.fraud_rules WHERE guild_id = p_guild_id;

  DELETE FROM public.economy_role_income_requests WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_role_income_claims WHERE guild_id = p_guild_id;
  DELETE FROM public.prediction_bets WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_lottery_tickets WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_market_listings WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_adventure_sessions WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_fish_catches WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_quest_progress WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_user_achievements WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_heist_participants WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_pet_battles WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_farm_plots WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_inventory WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_transactions WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_daily_losses WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_wallets WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_profiles WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_streaks WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_pets WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_prestige WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_recipes WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_role_income WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_loot_tables WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_lottery_drawings WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_adventures WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_fish_species WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_trivia_questions WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_crops WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_quest_templates WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_achievement_defs WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_heists WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_items WHERE guild_id = p_guild_id;
  DELETE FROM public.predictions WHERE guild_id = p_guild_id;

  DELETE FROM public.poll_votes AS vote
   WHERE EXISTS (
     SELECT 1 FROM public.polls AS poll
      WHERE poll.id = vote.poll_id AND poll.guild_id = p_guild_id
  );
  DELETE FROM public.polls WHERE guild_id = p_guild_id;
  DELETE FROM public.ticket_metrics WHERE guild_id = p_guild_id;
  DELETE FROM public.ticket_transcripts WHERE guild_id = p_guild_id;
  DELETE FROM public.tickets WHERE guild_id = p_guild_id;
  DELETE FROM public.infractions WHERE guild_id = p_guild_id;
  DELETE FROM public.admin_changes WHERE guild_id = p_guild_id;
  DELETE FROM public.incidents WHERE guild_id = p_guild_id;
  DELETE FROM public.alerts WHERE guild_id = p_guild_id;
  -- Audit rows are never deleted (owner decision, 2026-07-18): tenant
  -- deletion scrubs identity — actor/target ids, payload snapshots, error
  -- text, correlation — and detaches the skeleton from the erased guild so
  -- the guild row below can be removed. What survives carries no link to
  -- the tenant or its members; what mattered for security forensics
  -- (action, actor type, time, outcome) survives forever.
  UPDATE public.audit_logs
     SET guild_id = NULL,
         actor_id = 'anonymized',
         target_id = CASE WHEN target_id IS NULL THEN NULL ELSE 'anonymized' END,
         details = pg_catalog.jsonb_build_object('anonymized', true),
         before_state = NULL,
         after_state = NULL,
         error_message = NULL,
         correlation_id = NULL
   WHERE guild_id = p_guild_id;
  DELETE FROM public.message_reports WHERE guild_id = p_guild_id;
  DELETE FROM public.starboard_entries WHERE guild_id = p_guild_id;
  DELETE FROM public.member_feature_unlocks WHERE guild_id = p_guild_id;
  DELETE FROM public.member_levels WHERE guild_id = p_guild_id;
  DELETE FROM public.member_rank_settings WHERE guild_id = p_guild_id;
  DELETE FROM public.level_unlock_configs WHERE guild_id = p_guild_id;
  DELETE FROM public.level_rewards WHERE guild_id = p_guild_id;
  DELETE FROM public.xp_multipliers WHERE guild_id = p_guild_id;
  DELETE FROM public.members WHERE guild_id = p_guild_id;

  DELETE FROM public.dashboard_user_roles WHERE guild_id = p_guild_id;
  DELETE FROM public.dashboard_roles WHERE guild_id = p_guild_id;
  DELETE FROM public.active_temp_channels WHERE guild_id = p_guild_id;
  DELETE FROM public.temp_channel_hubs WHERE guild_id = p_guild_id;
  DELETE FROM public.tutorial_progress WHERE guild_id = p_guild_id;
  DELETE FROM public.tutorial_steps WHERE guild_id = p_guild_id;
  DELETE FROM public.tutorial_configs WHERE guild_id = p_guild_id;
  DELETE FROM public.feature_embed_overrides WHERE guild_id = p_guild_id;
  DELETE FROM public.embed_configs WHERE guild_id = p_guild_id;
  DELETE FROM public.scheduled_messages WHERE guild_id = p_guild_id;
  DELETE FROM public.stats_channels WHERE guild_id = p_guild_id;
  DELETE FROM public.button_roles WHERE guild_id = p_guild_id;
  DELETE FROM public.discord_id_map WHERE guild_id = p_guild_id;
  DELETE FROM public.guild_live_state WHERE guild_id = p_guild_id;
  DELETE FROM public.guild_desired_state WHERE guild_id = p_guild_id;
  DELETE FROM public.role_templates WHERE guild_id = p_guild_id;
  DELETE FROM public.channel_templates WHERE guild_id = p_guild_id;
  -- server_templates was dropped in 20260601000004_v53_dead_table_cleanup;
  -- deleting from it aborted every guild purge at runtime.
  DELETE FROM public.automod_rules WHERE guild_id = p_guild_id;
  DELETE FROM public.reaction_roles WHERE guild_id = p_guild_id;
  DELETE FROM public.ticket_panels WHERE guild_id = p_guild_id;
  DELETE FROM public.automations WHERE guild_id = p_guild_id;
  DELETE FROM public.custom_commands WHERE guild_id = p_guild_id;
  DELETE FROM public.guild_config WHERE guild_id = p_guild_id;

  DELETE FROM public.guild WHERE id = p_guild_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'purge_guild_data: guild deletion race detected';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'purge_status', 'completed',
    'pending_role_cleanup_count', 0,
    'guild_deleted', 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_guild_data(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_guild_data(TEXT)
  TO service_role;

COMMIT;
