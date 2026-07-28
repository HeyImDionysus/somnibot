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

-- Keep the flag structurally honest and automatically retire it with every
-- terminal/non-pending order transition. This trigger performs no privileged
-- reads, so it remains SECURITY INVOKER.
CREATE OR REPLACE FUNCTION public.commerce_normalize_checkout_active()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
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
  BEFORE INSERT OR UPDATE OF
    status,
    source,
    guild_id,
    customer_id,
    product_id,
    paypal_order_id,
    paypal_subscription_id,
    checkout_active
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
      ORDER BY paid_order.created_at DESC, paid_order.id DESC
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
  held_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.commerce_fulfillment_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_fulfillment_holds ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.commerce_fulfillment_claims
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.commerce_fulfillment_holds
  FROM PUBLIC, anon, authenticated, service_role;

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
      provider_id
    ) VALUES (
      v_hold.order_id,
      v_hold.guild_id,
      v_hold.customer_id,
      v_hold.product_id,
      v_hold.winning_order_id,
      v_hold.conflicting_entitlement_id,
      v_hold.provider_kind,
      v_hold.provider_id
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

  v_alert_type := CASE p_provider_kind
    WHEN 'capture' THEN 'commerce_duplicate_purchase_capture'
    ELSE 'commerce_duplicate_subscription_activation'
  END;
  v_alert_title := CASE p_provider_kind
    WHEN 'capture' THEN 'Customer charged twice for the same product'
    ELSE 'Customer activated a duplicate paid subscription'
  END;
  v_message := 'Paid order ' || v_order.order_number
    || ' lost the atomic fulfillment claim for this customer and product. '
    || 'The provider ' || p_provider_kind || ' ' || p_provider_id
    || ' for ' || p_amount_cents || ' cents ' || p_currency
    || ' remains financially visible, but no second entitlement, role set, '
    || 'or licence key was released. Review and refund/cancel this exact order.';
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
    'required_action', 'refund_or_cancel_duplicate'
  ) || CASE p_provider_kind
    WHEN 'capture' THEN pg_catalog.jsonb_build_object(
      'paypal_capture_id', p_provider_id
    )
    ELSE pg_catalog.jsonb_build_object(
      'paypal_subscription_id', p_provider_id
    )
  END;

  UPDATE public.alerts AS alert
     SET message = v_message,
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

COMMIT;
