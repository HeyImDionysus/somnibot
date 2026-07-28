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

  IF TG_OP = 'DELETE' THEN
    IF v_old_protected_payment
       AND CURRENT_USER IN ('anon', 'authenticated') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'authenticated callers cannot delete a provider-payable checkout';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND v_old_protected_payment
     AND CURRENT_USER IN ('anon', 'authenticated') THEN
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

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_outward_uncertain
  ON public.alerts (
    guild_id,
    ((metadata ->> 'order_id')),
    ((metadata ->> 'intent_kind'))
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
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL,
  intent_kind TEXT NOT NULL CHECK (
    intent_kind IN (
      'purchase_completed_event',
      'subscription_activated_event',
      'receipt_dm'
    )
  ),
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'uncertain')),
  attempt_token UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  sent_at TIMESTAMPTZ,
  uncertain_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (order_id, intent_kind),
  CHECK (
    (state = 'sending' AND attempt_token IS NOT NULL AND sent_at IS NULL AND uncertain_at IS NULL)
    OR (state = 'sent' AND attempt_token IS NULL AND sent_at IS NOT NULL AND uncertain_at IS NULL)
    OR (state = 'uncertain' AND attempt_token IS NULL AND sent_at IS NULL AND uncertain_at IS NOT NULL)
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

  IF NOT EXISTS (
    SELECT 1
      FROM public.customers AS customer
     WHERE customer.id = p_customer_id
       AND customer.guild_id = p_guild_id
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.products AS product
     WHERE product.id = p_product_id
       AND product.guild_id = p_guild_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce_find_checkout_blocker: checkout identity mismatch';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_guild_id || E'\x1f'
        || p_customer_id::TEXT || E'\x1f'
        || p_product_id::TEXT,
      0
    )
  );

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
      'order_number', v_order.order_number
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
      'order_number', v_order.order_number
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
      'order_number', v_order.order_number
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
      'order_number', v_order.order_number
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
        'order_number', v_prior_order.order_number
      );
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'disposition', 'clear',
    'reason', NULL,
    'order_id', NULL,
    'order_number', NULL
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
  ON CONFLICT (order_id, intent_kind) DO NOTHING
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

  IF v_claim ->> 'disposition' = 'held' THEN
    RETURN v_claim;
  END IF;
  IF v_claim ->> 'disposition' IS DISTINCT FROM 'winner'
     OR v_claim ->> 'order_id' IS DISTINCT FROM p_order_id::TEXT
     OR v_claim ->> 'winning_order_id' IS DISTINCT FROM p_order_id::TEXT THEN
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
     AND paid_order.status = 'pending';
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
