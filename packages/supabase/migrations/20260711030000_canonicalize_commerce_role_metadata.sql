-- =============================================================================
-- Remove the accidental products.metadata role-grant side channel.
--
-- Permanent one-time role configuration moves to products.granted_role_ids.
-- Temporary configuration moves to a typed table and is snapshotted into the
-- durable fulfillment queue.  Ambiguous historical metadata is quarantined;
-- it is never fabricated into a buyer's entitlement snapshot or used as sale
-- evidence.  New temporary grants commit an idempotent pending provenance row
-- before Discord is mutated.
-- =============================================================================

-- Deployment fence for the lossless metadata rewrite. EXCLUSIVE blocks table
-- writers and row-locking SELECTs while still allowing plain AccessShare
-- readers. Taking the final mode up front avoids a later ALTER TABLE lock
-- upgrade cycle with a live RPC that entered under ROW SHARE.
-- The expanded fence also makes legacy queue classification lossless while
-- terminal-entitlement replacements are inserted. Operational impact:
-- commerce, entitlement, and action-queue writers wait for this entire
-- migration file, so deploy during a low-write window and monitor lock wait
-- and transaction duration.
BEGIN;

-- EXCLUSIVE is compatible with plain readers, but later ALTER statements may
-- need ACCESS EXCLUSIVE. Bound that upgrade wait so the deployment retries
-- instead of remaining indefinitely behind a long-lived read transaction.
SET LOCAL lock_timeout = '5s';

-- Acquire every pre-existing table mutated later in one canonical parent ->
-- financial-child -> access-child order. Some predeployment RPCs historically
-- used opposite child orders, so waiting on any individual table could still
-- complete a live migration/runtime cycle. NOWAIT makes deployment retry the
-- whole transaction after workers drain instead of participating in one.
LOCK TABLE
  public.orders,
  public.products,
  public.plans,
  public.payments,
  public.payment_refunds,
  public.customers,
  public.temp_role_grants,
  public.entitlements,
  public.license_keys,
  public.license_sessions,
  public.bot_action_queue,
  public.action_queue_dlq
IN EXCLUSIVE MODE NOWAIT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.bot_action_queue AS queue
     WHERE queue.status = 'processing'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'commerce role-delivery protocol deploy requires a drained action queue',
      HINT = 'Stop old workers, resolve or recover every processing action, then retry the whole migration.';
  END IF;
END;
$$;

-- temp_role_grants provenance columns must exist before any LANGUAGE sql
-- function below references them (sql-language bodies are validated at
-- creation time, unlike plpgsql). Existing rows were written after Discord
-- mutation, so they are known-applied. New fulfillment explicitly inserts
-- pending through the provenance RPC defined later in this file.
ALTER TABLE public.temp_role_grants
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.orders(id),
  ADD COLUMN IF NOT EXISTS grant_status TEXT NOT NULL DEFAULT 'applied'
    CHECK (grant_status IN ('pending', 'applied', 'removed')),
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER
    CHECK (
      duration_seconds IS NULL
      OR (duration_seconds > 0 AND duration_seconds <= 315360000)
    ),
  ADD COLUMN IF NOT EXISTS remove_on_expiry BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Persist the PayPal resource family instead of guessing from the shape of an
-- opaque provider id.  Historical rows remain nullable and therefore require
-- an exact capture/sale webhook replay before a lifecycle RPC may adopt them.
-- Added here (not beside its constraints below) because LANGUAGE sql
-- lifecycle functions later in this file reference it at creation time.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS paypal_resource_type TEXT;

-- Keep the database classifier in lock-step with the bot's commerce lane.
-- CREATE OR REPLACE preserves the existing insert-trigger dependency while
-- making the durable reconciliation action commerce-priority at deploy time.
CREATE OR REPLACE FUNCTION public.bot_action_queue_lane_for_action(p_action TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_action IN (
      'fulfill_purchase',
      'fulfill_subscription',
      'fulfill_cancellation',
      'fulfill_suspension',
      'fulfill_giveaway_prize',
      'notify_giveaway_winner',
      'deliver_receipt',
      'revoke_roles',
      'reconcile_entitlement_roles'
    ) THEN 'commerce'
    ELSE 'game'
  END;
$$;

ALTER TABLE public.bot_action_queue
  ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT 'game'
    CHECK (lane IN ('commerce', 'game')),
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE public.action_queue_dlq
  ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT 'game'
    CHECK (lane IN ('commerce', 'game'));

UPDATE public.bot_action_queue
   SET lane = public.bot_action_queue_lane_for_action(action)
 WHERE lane IS DISTINCT FROM public.bot_action_queue_lane_for_action(action);
UPDATE public.action_queue_dlq
   SET lane = public.bot_action_queue_lane_for_action(action)
 WHERE lane IS DISTINCT FROM public.bot_action_queue_lane_for_action(action);

-- One queue carrier may fail, be explicitly retried, and fail again. Preserve
-- every resolved generation as audit history, but expose exactly one current
-- (unretried) generation to operators. Historical duplicate current rows are
-- deterministically converged before the partial uniqueness invariant lands.
WITH ranked_current AS (
  SELECT dlq.id,
         pg_catalog.row_number() OVER (
           PARTITION BY dlq.original_id
           ORDER BY dlq.failed_at DESC NULLS LAST,
                    dlq.created_at DESC NULLS LAST,
                    dlq.id DESC
         ) AS generation_rank
    FROM public.action_queue_dlq AS dlq
   WHERE dlq.original_id IS NOT NULL
     AND dlq.retried IS NOT TRUE
)
UPDATE public.action_queue_dlq AS dlq
   SET retried = true,
       retried_at = COALESCE(dlq.retried_at, pg_catalog.clock_timestamp()),
       error_message = COALESCE(dlq.error_message || ' | ', '')
         || 'Superseded by canonical unresolved DLQ generation during migration'
  FROM ranked_current AS ranked
 WHERE dlq.id = ranked.id
   AND ranked.generation_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_action_queue_dlq_unretried_original
  ON public.action_queue_dlq (original_id)
  WHERE original_id IS NOT NULL AND retried IS NOT TRUE;

-- A composite key keeps typed temporary-role config guild-consistent without
-- trusting writers to duplicate products.guild_id correctly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_id_guild_id
  ON public.products (id, guild_id);

CREATE OR REPLACE FUNCTION public.commerce_valid_snowflake_snapshot(
  p_values TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_values IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(p_values) AS value(item)
        WHERE value.item IS NULL
           OR value.item !~ '^[0-9]{17,20}$'
     )
     AND pg_catalog.cardinality(p_values) = (
       SELECT pg_catalog.count(DISTINCT value.item)
         FROM pg_catalog.unnest(p_values) AS value(item)
     );
$$;

CREATE OR REPLACE FUNCTION public.commerce_valid_temp_role_snapshot(
  p_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_snapshot IS NOT NULL
     AND pg_catalog.jsonb_typeof(p_snapshot) = 'array'
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(
           CASE
             WHEN pg_catalog.jsonb_typeof(p_snapshot) = 'array' THEN p_snapshot
             ELSE '[]'::JSONB
           END
         ) AS grant_row(value)
        WHERE CASE
          WHEN pg_catalog.jsonb_typeof(grant_row.value) IS DISTINCT FROM 'object'
            THEN true
          ELSE grant_row.value - 'role_id' - 'duration_seconds' <> '{}'::JSONB
            OR pg_catalog.jsonb_typeof(grant_row.value -> 'role_id') IS DISTINCT FROM 'string'
            OR COALESCE(grant_row.value ->> 'role_id', '') !~ '^[0-9]{17,20}$'
            OR CASE
                 WHEN pg_catalog.jsonb_typeof(grant_row.value -> 'duration_seconds') = 'number'
                   THEN (grant_row.value ->> 'duration_seconds')::NUMERIC <= 0
                     OR (grant_row.value ->> 'duration_seconds')::NUMERIC > 315360000
                     OR pg_catalog.trunc(
                       (grant_row.value ->> 'duration_seconds')::NUMERIC
                     ) <> (grant_row.value ->> 'duration_seconds')::NUMERIC
                 ELSE true
               END
        END
     )
     AND (
       SELECT pg_catalog.count(*) = pg_catalog.count(
         DISTINCT grant_row.value ->> 'role_id'
       )
         FROM pg_catalog.jsonb_array_elements(
           CASE
             WHEN pg_catalog.jsonb_typeof(p_snapshot) = 'array' THEN p_snapshot
             ELSE '[]'::JSONB
           END
         ) AS grant_row(value)
     );
$$;

REVOKE ALL ON FUNCTION public.commerce_valid_snowflake_snapshot(TEXT[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_valid_snowflake_snapshot(TEXT[])
  TO service_role;
REVOKE ALL ON FUNCTION public.commerce_valid_temp_role_snapshot(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_valid_temp_role_snapshot(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_valid_uuid_snapshot(p_values UUID[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_values IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(p_values) AS value(item)
        WHERE value.item IS NULL
     )
     AND pg_catalog.cardinality(p_values) = (
       SELECT pg_catalog.count(DISTINCT value.item)
         FROM pg_catalog.unnest(p_values) AS value(item)
     );
$$;

REVOKE ALL ON FUNCTION public.commerce_valid_uuid_snapshot(UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_valid_uuid_snapshot(UUID[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_canonical_snowflake_snapshot(
  p_values TEXT[]
)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    pg_catalog.array_agg(value.item ORDER BY value.item),
    '{}'::TEXT[]
  )
    FROM pg_catalog.unnest(COALESCE(p_values, '{}'::TEXT[])) AS value(item);
$$;

CREATE OR REPLACE FUNCTION public.commerce_jsonb_snowflake_snapshot_matches(
  p_value JSONB,
  p_expected TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_typeof(p_value) = 'array'
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(
           CASE WHEN pg_catalog.jsonb_typeof(p_value) = 'array'
             THEN p_value ELSE '[]'::JSONB END
         ) AS item(value)
        WHERE pg_catalog.jsonb_typeof(item.value) IS DISTINCT FROM 'string'
           OR COALESCE(item.value #>> '{}', '') !~ '^[0-9]{17,20}$'
     )
     AND (
       SELECT pg_catalog.count(*) = pg_catalog.count(
         DISTINCT item.value #>> '{}'
       )
         FROM pg_catalog.jsonb_array_elements(
           CASE WHEN pg_catalog.jsonb_typeof(p_value) = 'array'
             THEN p_value ELSE '[]'::JSONB END
         ) AS item(value)
     )
     AND (
       SELECT COALESCE(
         pg_catalog.array_agg(item.value #>> '{}' ORDER BY item.value #>> '{}'),
         '{}'::TEXT[]
       )
         FROM pg_catalog.jsonb_array_elements(
           CASE WHEN pg_catalog.jsonb_typeof(p_value) = 'array'
             THEN p_value ELSE '[]'::JSONB END
         ) AS item(value)
     ) = public.commerce_canonical_snowflake_snapshot(p_expected);
$$;

REVOKE ALL ON FUNCTION public.commerce_canonical_snowflake_snapshot(TEXT[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_jsonb_snowflake_snapshot_matches(JSONB, TEXT[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_canonical_snowflake_snapshot(TEXT[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_jsonb_snowflake_snapshot_matches(JSONB, TEXT[])
  TO service_role;

-- Freeze the exact role/channel/temp-role configuration sold with an order.
-- These columns must exist before the delivery-contract functions below are
-- parsed; PostgreSQL resolves %ROWTYPE fields when each function is created.
-- The timestamp distinguishes a legitimately empty snapshot from a legacy row
-- that has never been frozen.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS granted_role_ids_snapshot TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS granted_channel_ids_snapshot TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS temporary_role_grants_snapshot JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS grant_snapshot_frozen_at TIMESTAMPTZ,
  ADD CONSTRAINT orders_granted_role_ids_snapshot_valid
    CHECK (public.commerce_valid_snowflake_snapshot(granted_role_ids_snapshot)),
  ADD CONSTRAINT orders_granted_channel_ids_snapshot_valid
    CHECK (public.commerce_valid_snowflake_snapshot(granted_channel_ids_snapshot)),
  ADD CONSTRAINT orders_temporary_role_grants_snapshot_valid
    CHECK (public.commerce_valid_temp_role_snapshot(temporary_role_grants_snapshot));

-- A narrow compatibility boundary for completed subscription orders that
-- predate order-level grant snapshots but already have an exact staged outbox
-- payload. This table likewise precedes every function that queries it.
CREATE TABLE IF NOT EXISTS public.commerce_legacy_subscription_grant_contracts (
  order_id UUID PRIMARY KEY
    REFERENCES public.orders(id) ON DELETE CASCADE,
  source_queue_id UUID NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  customer_id UUID NOT NULL,
  discord_id TEXT NOT NULL,
  product_id UUID NOT NULL,
  product_name TEXT NOT NULL,
  order_number TEXT NOT NULL,
  plan_id UUID NOT NULL,
  paypal_subscription_id TEXT NOT NULL,
  paypal_plan_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  granted_role_ids_snapshot TEXT[] NOT NULL,
  granted_channel_ids_snapshot TEXT[] NOT NULL,
  persisted_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT commerce_legacy_subscription_contract_roles_valid
    CHECK (public.commerce_valid_snowflake_snapshot(granted_role_ids_snapshot)),
  CONSTRAINT commerce_legacy_subscription_contract_channels_valid
    CHECK (public.commerce_valid_snowflake_snapshot(granted_channel_ids_snapshot)),
  CONSTRAINT commerce_legacy_subscription_contract_text_identity_valid
    CHECK (
      guild_id = pg_catalog.btrim(guild_id) AND guild_id <> ''
      AND discord_id = pg_catalog.btrim(discord_id) AND discord_id <> ''
      AND product_name = pg_catalog.btrim(product_name) AND product_name <> ''
      AND order_number = pg_catalog.btrim(order_number) AND order_number <> ''
      AND paypal_subscription_id = pg_catalog.btrim(paypal_subscription_id)
      AND paypal_subscription_id <> ''
      AND paypal_plan_id = pg_catalog.btrim(paypal_plan_id)
      AND paypal_plan_id <> ''
    )
);

ALTER TABLE public.commerce_legacy_subscription_grant_contracts
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_legacy_subscription_grant_contracts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.commerce_legacy_subscription_grant_contracts
  TO service_role;

-- Durable evidence around every Discord role-delivery attempt. action_id is
-- intentionally not a foreign key: ordinary queue retention must not erase
-- unresolved mutation evidence. Parent identifiers are likewise retained as
-- immutable evidence until explicit safe settlement.
CREATE TABLE public.commerce_role_delivery_intents (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_kind           TEXT        NOT NULL DEFAULT 'paid',
  entitlement_source      TEXT,
  activation_generation   UUID,
  action_id               UUID        NOT NULL UNIQUE,
  origin_claim_token      UUID        NOT NULL,
  delivery_claim_token    UUID        NOT NULL,
  guild_id                TEXT        NOT NULL,
  entitlement_id          UUID        NOT NULL,
  customer_id             UUID        NOT NULL,
  discord_id              TEXT        NOT NULL,
  order_id                UUID        NOT NULL,
  product_id              UUID        NOT NULL,
  plan_id                 UUID,
  entitlement_type        TEXT        NOT NULL,
  permanent_role_ids      TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],
  completed_role_ids      TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],
  reserved_role_ids       TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],
  owned_role_ids          TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],
  reserved_temp_role_grant_ids UUID[] NOT NULL DEFAULT '{}'::UUID[],
  temporary_role_grant_ids UUID[]     NOT NULL DEFAULT '{}'::UUID[],
  state                   TEXT        NOT NULL DEFAULT 'open',
  mutation_token          UUID,
  last_delivery_mutation_token UUID,
  last_delivery_outcome   TEXT,
  cleanup_action_id       UUID,
  cleanup_claim_token     UUID,
  cleanup_mutation_token  UUID,
  last_cleanup_mutation_token UUID,
  last_cleanup_outcome    TEXT,
  recovery_generation     INTEGER     NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  settled_at              TIMESTAMPTZ,
  delivery_confirmed_at   TIMESTAMPTZ,
  mutation_started_at     TIMESTAMPTZ,
  cleanup_mutation_started_at TIMESTAMPTZ,
  last_error              TEXT,
  CONSTRAINT commerce_role_delivery_intents_identity_text
    CHECK (
      guild_id = pg_catalog.btrim(guild_id) AND guild_id <> ''
      AND discord_id = pg_catalog.btrim(discord_id) AND discord_id <> ''
    ),
  CONSTRAINT commerce_role_delivery_intents_type_known
    CHECK (entitlement_type IN ('one_time', 'subscription')),
  CONSTRAINT commerce_role_delivery_intents_contract_kind_known
    CHECK (contract_kind IN ('paid', 'noncommerce')),
  CONSTRAINT commerce_role_delivery_intents_state_known
    CHECK (state IN ('open', 'cleanup_required', 'operator_required', 'settled')),
  CONSTRAINT commerce_role_delivery_intents_roles_valid
    CHECK (
      public.commerce_valid_snowflake_snapshot(permanent_role_ids)
      AND public.commerce_valid_snowflake_snapshot(completed_role_ids)
      AND public.commerce_valid_snowflake_snapshot(reserved_role_ids)
      AND public.commerce_valid_snowflake_snapshot(owned_role_ids)
      AND permanent_role_ids
        = public.commerce_canonical_snowflake_snapshot(permanent_role_ids)
      AND completed_role_ids
        = public.commerce_canonical_snowflake_snapshot(completed_role_ids)
      AND reserved_role_ids
        = public.commerce_canonical_snowflake_snapshot(reserved_role_ids)
      AND owned_role_ids
        = public.commerce_canonical_snowflake_snapshot(owned_role_ids)
      AND reserved_role_ids <@ permanent_role_ids
      AND owned_role_ids <@ permanent_role_ids
      AND completed_role_ids <@ permanent_role_ids
      AND owned_role_ids <@ completed_role_ids
      AND NOT (reserved_role_ids && owned_role_ids)
    ),
  CONSTRAINT commerce_role_delivery_intents_temp_grants_valid
    CHECK (
      public.commerce_valid_uuid_snapshot(reserved_temp_role_grant_ids)
      AND public.commerce_valid_uuid_snapshot(temporary_role_grant_ids)
      AND NOT (reserved_temp_role_grant_ids && temporary_role_grant_ids)
    ),
  CONSTRAINT commerce_role_delivery_intents_plan_shape
    CHECK (
      contract_kind = 'noncommerce'
      OR (entitlement_type = 'one_time' AND plan_id IS NULL)
      OR (entitlement_type = 'subscription' AND plan_id IS NOT NULL)
    ),
  CONSTRAINT commerce_role_delivery_intents_contract_shape
    CHECK (
      (
        contract_kind = 'paid'
        AND entitlement_source IS NULL
        AND activation_generation IS NULL
      )
      OR (
        contract_kind = 'noncommerce'
        AND entitlement_source IN ('manual', 'giveaway', 'automation')
        AND activation_generation IS NOT NULL
        AND pg_catalog.cardinality(reserved_temp_role_grant_ids) = 0
        AND pg_catalog.cardinality(temporary_role_grant_ids) = 0
      )
    ),
  CONSTRAINT commerce_role_delivery_intents_mutation_shape
    CHECK (
      (mutation_token IS NULL AND mutation_started_at IS NULL)
      OR (mutation_token IS NOT NULL AND mutation_started_at IS NOT NULL)
    ),
  CONSTRAINT commerce_role_delivery_intents_delivery_result_shape
    CHECK (
      (
        last_delivery_mutation_token IS NULL
        AND last_delivery_outcome IS NULL
      )
      OR (
        last_delivery_mutation_token IS NOT NULL
        AND last_delivery_outcome IN ('live', 'compensated', 'retry')
      )
    ),
  CONSTRAINT commerce_role_delivery_intents_cleanup_controller_shape
    CHECK (
      (cleanup_action_id IS NULL AND cleanup_claim_token IS NULL)
      OR (
        cleanup_action_id IS NOT NULL
        AND cleanup_claim_token IS NOT NULL
        AND state IN ('cleanup_required', 'operator_required', 'settled')
      )
    ),
  CONSTRAINT commerce_role_delivery_intents_cleanup_mutation_shape
    CHECK (
      (
        cleanup_mutation_token IS NULL
        AND cleanup_mutation_started_at IS NULL
      )
      OR (
        cleanup_mutation_token IS NOT NULL
        AND cleanup_mutation_started_at IS NOT NULL
        AND cleanup_action_id IS NOT NULL
        AND cleanup_claim_token IS NOT NULL
        AND state IN ('cleanup_required', 'operator_required')
      )
    ),
  CONSTRAINT commerce_role_delivery_intents_cleanup_result_shape
    CHECK (
      (
        last_cleanup_mutation_token IS NULL
        AND last_cleanup_outcome IS NULL
      )
      OR (
        last_cleanup_mutation_token IS NOT NULL
        AND last_cleanup_outcome IN ('cleaned', 'retry')
      )
    ),
  CONSTRAINT commerce_role_delivery_intents_settlement_shape
    CHECK (
      (
        state = 'settled'
        AND settled_at IS NOT NULL
        AND mutation_token IS NULL
        AND mutation_started_at IS NULL
        AND cleanup_mutation_token IS NULL
        AND cleanup_mutation_started_at IS NULL
        AND pg_catalog.cardinality(reserved_role_ids) = 0
        AND pg_catalog.cardinality(owned_role_ids) = 0
        AND pg_catalog.cardinality(reserved_temp_role_grant_ids) = 0
        AND pg_catalog.cardinality(temporary_role_grant_ids) = 0
      )
      OR (state <> 'settled' AND settled_at IS NULL)
    ),
  CONSTRAINT commerce_role_delivery_intents_confirmation_shape
    CHECK (
      delivery_confirmed_at IS NULL
      OR delivery_confirmed_at >= created_at
    ),
  CONSTRAINT commerce_role_delivery_intents_recovery_generation
    CHECK (recovery_generation >= 0)
);

CREATE INDEX commerce_role_delivery_intents_unresolved
  ON public.commerce_role_delivery_intents (guild_id, state, id)
  WHERE state <> 'settled';
CREATE INDEX commerce_role_delivery_intents_order
  ON public.commerce_role_delivery_intents (order_id, state, id);
CREATE INDEX commerce_role_delivery_intents_entitlement
  ON public.commerce_role_delivery_intents (entitlement_id, state, id);
CREATE UNIQUE INDEX commerce_role_delivery_intents_cleanup_action
  ON public.commerce_role_delivery_intents (cleanup_action_id)
  WHERE cleanup_action_id IS NOT NULL;
CREATE UNIQUE INDEX commerce_role_delivery_intents_noncommerce_generation
  ON public.commerce_role_delivery_intents (
    entitlement_id, discord_id, activation_generation
  )
  WHERE contract_kind = 'noncommerce';

ALTER TABLE public.commerce_role_delivery_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_role_delivery_intents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_role_delivery_intents
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.commerce_role_delivery_intents TO service_role;

-- Exact current-generation fence for noncommerce activation carriers. The
-- entitlement row remains the business contract; this pointer prevents an
-- older completed/reopened carrier from becoming current after reactivation
-- or A -> B -> A relinks. It is not removal authority.
CREATE TABLE public.commerce_noncommerce_activation_heads (
  entitlement_id        UUID        PRIMARY KEY
    REFERENCES public.entitlements(id) ON DELETE CASCADE,
  guild_id               TEXT        NOT NULL,
  customer_id            UUID        NOT NULL
    REFERENCES public.customers(id) ON DELETE CASCADE,
  discord_id             TEXT        NOT NULL,
  order_id               UUID
    REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id             UUID        NOT NULL
    REFERENCES public.products(id) ON DELETE CASCADE,
  entitlement_source     TEXT        NOT NULL,
  entitlement_type       TEXT        NOT NULL,
  plan_id                UUID,
  activation_generation  UUID        NOT NULL,
  action_id               UUID        NOT NULL UNIQUE
    REFERENCES public.bot_action_queue(id) ON DELETE RESTRICT,
  role_ids                TEXT[]      NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT commerce_noncommerce_activation_heads_identity
    CHECK (
      guild_id = pg_catalog.btrim(guild_id) AND guild_id <> ''
      AND discord_id ~ '^[0-9]{17,20}$'
      AND entitlement_source IN ('manual', 'giveaway', 'automation')
      AND entitlement_type IN ('one_time', 'subscription')
      AND public.commerce_valid_snowflake_snapshot(role_ids)
      AND role_ids = public.commerce_canonical_snowflake_snapshot(role_ids)
      AND pg_catalog.cardinality(role_ids) > 0
    )
);

CREATE INDEX commerce_noncommerce_activation_heads_customer
  ON public.commerce_noncommerce_activation_heads (customer_id, entitlement_id);
ALTER TABLE public.commerce_noncommerce_activation_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_noncommerce_activation_heads FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_noncommerce_activation_heads
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.commerce_noncommerce_activation_heads TO service_role;

-- Exact no-mutation proof for a single processing generation. A current
-- activation carrier may never be completed merely because a handler returned
-- success; only begin/prepare can attest a superseded, legacy-unproven, or
-- settled-noop outcome for the exact claim token.
CREATE TABLE public.commerce_noncommerce_action_outcomes (
  action_id     UUID        NOT NULL
    REFERENCES public.bot_action_queue(id) ON DELETE CASCADE,
  claim_token   UUID        NOT NULL,
  outcome       TEXT        NOT NULL CHECK (
    outcome IN ('superseded', 'unproven', 'settled_noop')
  ),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (action_id, claim_token)
);
ALTER TABLE public.commerce_noncommerce_action_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_noncommerce_action_outcomes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_noncommerce_action_outcomes
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.commerce_noncommerce_action_outcomes TO service_role;

-- The queue finalizer resolves one intent per action. Serialize action binding
-- changes and reject both same-column duplicates and origin/cleanup cross-column
-- collisions across different intents. The same action may control both phases
-- of one intent.
CREATE OR REPLACE FUNCTION public.commerce_guard_role_delivery_action_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action_id UUID;
BEGIN
  FOR v_action_id IN
    SELECT binding.action_id
      FROM (
        SELECT NEW.action_id AS action_id
        UNION
        SELECT NEW.cleanup_action_id
      ) AS binding
     WHERE binding.action_id IS NOT NULL
     ORDER BY binding.action_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'commerce-role-delivery-action:' || v_action_id::TEXT,
        0
      )
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM public.commerce_role_delivery_intents AS other_intent
     WHERE other_intent.id IS DISTINCT FROM NEW.id
       AND (
         other_intent.action_id IN (NEW.action_id, NEW.cleanup_action_id)
         OR other_intent.cleanup_action_id IN (NEW.action_id, NEW.cleanup_action_id)
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'commerce role-delivery action is already bound to another intent';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_guard_role_delivery_action_binding()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_commerce_guard_role_delivery_action_binding
  BEFORE INSERT OR UPDATE OF action_id, cleanup_action_id
  ON public.commerce_role_delivery_intents
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_role_delivery_action_binding();

CREATE OR REPLACE FUNCTION public.commerce_guard_role_delivery_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_safe_recovery BOOLEAN := false;
  v_recovery_owner NAME;
  v_recovery_scope TEXT;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contract_kind IS DISTINCT FROM OLD.contract_kind
     OR NEW.entitlement_source IS DISTINCT FROM OLD.entitlement_source
     OR NEW.activation_generation IS DISTINCT FROM OLD.activation_generation
     OR NEW.action_id IS DISTINCT FROM OLD.action_id
     OR NEW.origin_claim_token IS DISTINCT FROM OLD.origin_claim_token
     OR NEW.guild_id IS DISTINCT FROM OLD.guild_id
     OR NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.discord_id IS DISTINCT FROM OLD.discord_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.entitlement_type IS DISTINCT FROM OLD.entitlement_type
     OR NEW.permanent_role_ids IS DISTINCT FROM OLD.permanent_role_ids
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery durable identity is immutable';
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery timestamps are not monotonic';
  END IF;

  -- The only non-monotonic state edge is an exact same-carrier operator retry.
  -- Encode its complete truth-table here so no future caller can smuggle an
  -- authority, completion, controller, or token mutation through the exception.
  -- This trigger intentionally runs as invoker: an UPDATE queued inside the
  -- SECURITY DEFINER recovery RPC runs as that function's owner, while raw
  -- service-role DML does not. The exact transaction-local intent scope then
  -- prevents another owner-context UPDATE from borrowing the exception.
  SELECT pg_catalog.pg_get_userbyid(proc.proowner)
    INTO v_recovery_owner
    FROM pg_catalog.pg_proc AS proc
   WHERE proc.oid = pg_catalog.to_regprocedure(
     'public.commerce_retry_role_delivery_dlq(uuid,text)'
   );
  v_recovery_scope := pg_catalog.current_setting(
    'somnibot.commerce_role_delivery_recovery_intent_id', true
  );
  v_safe_recovery :=
    v_recovery_owner IS NOT NULL
    AND current_user IS NOT DISTINCT FROM v_recovery_owner
    AND v_recovery_scope IS NOT DISTINCT FROM NEW.id::TEXT
    AND OLD.state = 'operator_required'
    AND NEW.state = 'open'
    AND NEW.recovery_generation = OLD.recovery_generation + 1
    AND OLD.delivery_confirmed_at IS NULL
    AND NEW.delivery_confirmed_at IS NULL
    AND OLD.mutation_token IS NULL
    AND NEW.mutation_token IS NULL
    AND OLD.mutation_started_at IS NULL
    AND NEW.mutation_started_at IS NULL
    AND OLD.cleanup_action_id IS NULL
    AND NEW.cleanup_action_id IS NULL
    AND OLD.cleanup_claim_token IS NULL
    AND NEW.cleanup_claim_token IS NULL
    AND OLD.cleanup_mutation_token IS NULL
    AND NEW.cleanup_mutation_token IS NULL
    AND OLD.cleanup_mutation_started_at IS NULL
    AND NEW.cleanup_mutation_started_at IS NULL
    AND pg_catalog.cardinality(OLD.reserved_role_ids) = 0
    AND pg_catalog.cardinality(NEW.reserved_role_ids) = 0
    AND pg_catalog.cardinality(OLD.reserved_temp_role_grant_ids) = 0
    AND pg_catalog.cardinality(NEW.reserved_temp_role_grant_ids) = 0
    AND OLD.last_delivery_mutation_token IS NOT NULL
    AND OLD.last_delivery_outcome = 'retry'
    AND NEW.last_delivery_outcome = 'retry'
    AND NEW.delivery_claim_token IS NOT DISTINCT FROM OLD.delivery_claim_token
    AND NEW.completed_role_ids IS NOT DISTINCT FROM OLD.completed_role_ids
    AND NEW.reserved_role_ids IS NOT DISTINCT FROM OLD.reserved_role_ids
    AND NEW.owned_role_ids IS NOT DISTINCT FROM OLD.owned_role_ids
    AND NEW.reserved_temp_role_grant_ids
      IS NOT DISTINCT FROM OLD.reserved_temp_role_grant_ids
    AND NEW.temporary_role_grant_ids
      IS NOT DISTINCT FROM OLD.temporary_role_grant_ids
    AND NEW.last_delivery_mutation_token
      IS NOT DISTINCT FROM OLD.last_delivery_mutation_token
    AND NEW.cleanup_action_id IS NOT DISTINCT FROM OLD.cleanup_action_id
    AND NEW.cleanup_claim_token IS NOT DISTINCT FROM OLD.cleanup_claim_token
    AND NEW.cleanup_mutation_token IS NOT DISTINCT FROM OLD.cleanup_mutation_token
    AND NEW.last_cleanup_mutation_token
      IS NOT DISTINCT FROM OLD.last_cleanup_mutation_token
    AND NEW.last_cleanup_outcome IS NOT DISTINCT FROM OLD.last_cleanup_outcome
    AND NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at
    AND NEW.mutation_started_at IS NOT DISTINCT FROM OLD.mutation_started_at
    AND NEW.cleanup_mutation_started_at
      IS NOT DISTINCT FROM OLD.cleanup_mutation_started_at;

  IF NEW.recovery_generation IS DISTINCT FROM OLD.recovery_generation
     AND NOT v_safe_recovery THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery recovery generation is invalid';
  END IF;

  IF (OLD.state = 'open' AND NEW.state NOT IN (
        'open', 'cleanup_required', 'operator_required', 'settled'
      ))
     OR (OLD.state = 'cleanup_required' AND NEW.state NOT IN (
        'cleanup_required', 'operator_required', 'settled'
      ))
     OR (
       OLD.state = 'operator_required'
       AND NEW.state NOT IN ('operator_required', 'settled')
       AND NOT v_safe_recovery
     )
     OR (OLD.state = 'settled' AND NEW.state <> 'settled') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery state transition is not monotonic';
  END IF;

  IF OLD.settled_at IS NOT NULL
     AND NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery settlement evidence is immutable';
  END IF;

  IF OLD.delivery_confirmed_at IS NOT NULL
     AND NEW.delivery_confirmed_at IS DISTINCT FROM OLD.delivery_confirmed_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery confirmation evidence is immutable';
  END IF;

  IF NEW.delivery_claim_token IS DISTINCT FROM OLD.delivery_claim_token
     AND NOT (
       OLD.state = 'open'
       AND OLD.mutation_token IS NULL
       AND OLD.delivery_confirmed_at IS NULL
       AND OLD.cleanup_action_id IS NULL
       AND OLD.cleanup_claim_token IS NULL
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery claim generation cannot be rebound';
  END IF;

  IF NEW.cleanup_action_id IS DISTINCT FROM OLD.cleanup_action_id
     AND NOT (
       NEW.cleanup_action_id IS NOT NULL
       AND OLD.cleanup_mutation_token IS NULL
       AND OLD.state IN ('cleanup_required', 'operator_required')
       AND (
         OLD.cleanup_action_id IS NULL
         OR (
           OLD.cleanup_action_id = OLD.action_id
           AND OLD.mutation_token IS NULL
         )
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery cleanup action cannot be rebound';
  END IF;

  IF NEW.cleanup_claim_token IS DISTINCT FROM OLD.cleanup_claim_token
     AND NOT (
       NEW.cleanup_action_id IS NOT NULL
       AND OLD.cleanup_mutation_token IS NULL
       AND OLD.state IN ('cleanup_required', 'operator_required')
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery cleanup claim cannot be rebound';
  END IF;

  IF OLD.cleanup_mutation_token IS NOT NULL
     AND NEW.cleanup_mutation_token IS NOT NULL
     AND NEW.cleanup_mutation_token IS DISTINCT FROM OLD.cleanup_mutation_token THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery cleanup mutation token is immutable while active';
  END IF;

  IF (
       OLD.delivery_confirmed_at IS NOT NULL
       OR OLD.cleanup_action_id IS NOT NULL
       OR OLD.state = 'settled'
     )
     AND (
       NOT (NEW.completed_role_ids <@ OLD.completed_role_ids)
       OR NOT (NEW.reserved_role_ids <@ OLD.reserved_role_ids)
       OR NOT (NEW.reserved_temp_role_grant_ids <@ OLD.reserved_temp_role_grant_ids)
       OR NOT (NEW.owned_role_ids <@ OLD.owned_role_ids)
       OR NOT (NEW.temporary_role_grant_ids <@ OLD.temporary_role_grant_ids)
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery authority cannot expand after handoff';
  END IF;

  IF OLD.state = 'settled'
     AND (
       NEW.mutation_token IS NOT NULL
       OR NEW.mutation_started_at IS NOT NULL
       OR NEW.cleanup_mutation_token IS NOT NULL
       OR NEW.cleanup_mutation_started_at IS NOT NULL
       OR NEW.reserved_role_ids <> '{}'::TEXT[]
       OR NEW.owned_role_ids <> '{}'::TEXT[]
       OR NEW.reserved_temp_role_grant_ids <> '{}'::UUID[]
       OR NEW.temporary_role_grant_ids <> '{}'::UUID[]
       OR NEW.delivery_confirmed_at IS DISTINCT FROM OLD.delivery_confirmed_at
       OR NEW.completed_role_ids IS DISTINCT FROM OLD.completed_role_ids
       OR NEW.cleanup_action_id IS DISTINCT FROM OLD.cleanup_action_id
       OR NEW.cleanup_claim_token IS DISTINCT FROM OLD.cleanup_claim_token
       OR NEW.last_delivery_mutation_token IS DISTINCT FROM OLD.last_delivery_mutation_token
       OR NEW.last_delivery_outcome IS DISTINCT FROM OLD.last_delivery_outcome
       OR NEW.last_cleanup_mutation_token IS DISTINCT FROM OLD.last_cleanup_mutation_token
       OR NEW.last_cleanup_outcome IS DISTINCT FROM OLD.last_cleanup_outcome
       OR NEW.recovery_generation IS DISTINCT FROM OLD.recovery_generation
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery settled tombstone is immutable';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_guard_role_delivery_intent()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_commerce_guard_role_delivery_intent
  BEFORE UPDATE ON public.commerce_role_delivery_intents
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_role_delivery_intent();

CREATE OR REPLACE FUNCTION public.commerce_ensure_role_delivery_cleanup_action(
  p_intent_id UUID
)
RETURNS TABLE (action_id UUID, action_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_action_id UUID;
  v_idempotency_key TEXT;
  v_payload JSONB;
BEGIN
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  IF NOT FOUND OR v_intent.state = 'settled' THEN
    RETURN;
  END IF;
  IF v_intent.state NOT IN ('cleanup_required', 'operator_required') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce cleanup carrier requires an unresolved intent';
  END IF;
  IF pg_catalog.cardinality(v_intent.reserved_role_ids) > 0
     OR pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) > 0 THEN
    -- Provisional external mutations are deliberately operator-preserved. No
    -- automatic carrier may turn them into removal authority.
    RETURN;
  END IF;

  v_idempotency_key := 'commerce-role-delivery-cleanup:' || v_intent.id::TEXT;
  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.idempotency_key = v_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    v_payload := pg_catalog.jsonb_build_object(
      'mode', 'cleanup',
      'action_id', v_action.id,
      'target_delivery_intent_id', v_intent.id,
      'guild_id', v_intent.guild_id
    );
    IF v_action.guild_id IS DISTINCT FROM v_intent.guild_id
       OR v_action.action IS DISTINCT FROM 'reconcile_entitlement_roles'
       OR v_action.payload IS DISTINCT FROM v_payload
       OR v_action.lane IS DISTINCT FROM 'commerce' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce cleanup carrier identity is cross-linked';
    END IF;

    IF v_action.status IN ('staged', 'completed', 'failed') THEN
      UPDATE public.bot_action_queue AS queue
         SET status = 'pending',
             started_at = NULL,
             completed_at = NULL,
             error_message = NULL,
             next_retry_at = NULL,
             retry_count = queue.retry_count + 1
       WHERE queue.id = v_action.id
         AND queue.status = v_action.status
       RETURNING queue.* INTO v_action;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001',
          MESSAGE = 'commerce cleanup carrier recovery raced';
      END IF;
    END IF;
    RETURN QUERY SELECT v_action.id, v_action.status;
    RETURN;
  END IF;

  v_action_id := gen_random_uuid();
  v_payload := pg_catalog.jsonb_build_object(
    'mode', 'cleanup',
    'action_id', v_action_id,
    'target_delivery_intent_id', v_intent.id,
    'guild_id', v_intent.guild_id
  );
  INSERT INTO public.bot_action_queue (
    id, guild_id, action, payload, status, lane, idempotency_key
  ) VALUES (
    v_action_id,
    v_intent.guild_id,
    'reconcile_entitlement_roles',
    v_payload,
    'pending',
    'commerce',
    v_idempotency_key
  );
  RETURN QUERY SELECT v_action_id, 'pending'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_ensure_role_delivery_cleanup_action(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commerce_ensure_role_delivery_cleanup_action(UUID)
  TO service_role;

-- One open operator alert per exact intent. Settling the intent resolves only
-- its own alert; no payload or payment/license secret is copied into metadata.
CREATE UNIQUE INDEX commerce_role_delivery_intent_alert_open
  ON public.alerts (guild_id, ((metadata ->> 'intent_id')))
  WHERE alert_type = 'commerce_role_delivery_intent_unresolved'
    AND resolved = false;

CREATE UNIQUE INDEX commerce_receipt_delivery_alert_action_open
  ON public.alerts (guild_id, ((metadata ->> 'action_id')))
  WHERE alert_type = 'receipt_delivery_failed'
    AND resolved = false
    AND metadata ->> 'action_id' IS NOT NULL;

-- Legacy noncommerce metadata can describe desired roles without proving that
-- SomniBot added them. Keep one durable, explicitly resolved critical alert per
-- exact target/reason; retries and lifecycle generations must not spam alerts
-- or silently turn desired metadata into deletion authority.
CREATE UNIQUE INDEX commerce_noncommerce_role_cleanup_unproven_open
  ON public.alerts (
    guild_id,
    ((metadata ->> 'entitlement_id')),
    ((metadata ->> 'customer_id')),
    ((metadata ->> 'discord_id')),
    ((metadata ->> 'reason'))
  )
  WHERE alert_type = 'commerce_noncommerce_role_cleanup_unproven'
    AND resolved = false;

CREATE OR REPLACE FUNCTION public.commerce_signal_role_delivery_intent(
  p_intent_id UUID,
  p_error TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
BEGIN
  SELECT intent.*
    INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  IF NOT FOUND OR v_intent.state = 'settled' THEN
    RETURN;
  END IF;

  IF v_intent.state IN ('cleanup_required', 'operator_required')
     AND pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
     AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0 THEN
    PERFORM public.commerce_ensure_role_delivery_cleanup_action(v_intent.id);
  END IF;

  INSERT INTO public.alerts (
    guild_id, alert_type, severity, title, message, metadata, resolved
  ) VALUES (
    v_intent.guild_id,
    'commerce_role_delivery_intent_unresolved',
    'critical',
    'Commerce role delivery requires reconciliation',
    'Do not manually clear this evidence. Run the exact intent cleanup and confirm Discord state before settlement.',
    pg_catalog.jsonb_build_object(
      'intent_id', v_intent.id,
      'action_id', v_intent.action_id,
      'order_id', v_intent.order_id,
      'entitlement_id', v_intent.entitlement_id,
      'discord_id', v_intent.discord_id,
      'reserved_role_ids', pg_catalog.to_jsonb(v_intent.reserved_role_ids),
      'owned_role_ids', pg_catalog.to_jsonb(v_intent.owned_role_ids),
      'reserved_temp_role_grant_ids',
        pg_catalog.to_jsonb(v_intent.reserved_temp_role_grant_ids),
      'next_step', CASE
        WHEN pg_catalog.cardinality(v_intent.reserved_role_ids) > 0
          OR pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) > 0
          THEN 'inspect_provisional_role_delivery_without_removal'
        ELSE 'run_exact_role_delivery_cleanup'
      END
    ),
    false
  ) ON CONFLICT DO NOTHING;

  UPDATE public.alerts AS alert
     SET severity = 'critical',
         title = 'Commerce role delivery requires reconciliation',
         message = 'Do not manually clear this evidence. Run the exact intent cleanup and confirm Discord state before settlement.',
         metadata = pg_catalog.jsonb_build_object(
           'intent_id', v_intent.id,
           'action_id', v_intent.action_id,
           'order_id', v_intent.order_id,
           'entitlement_id', v_intent.entitlement_id,
           'discord_id', v_intent.discord_id,
           'reserved_role_ids', pg_catalog.to_jsonb(v_intent.reserved_role_ids),
           'owned_role_ids', pg_catalog.to_jsonb(v_intent.owned_role_ids),
           'reserved_temp_role_grant_ids',
             pg_catalog.to_jsonb(v_intent.reserved_temp_role_grant_ids),
           'next_step', CASE
             WHEN pg_catalog.cardinality(v_intent.reserved_role_ids) > 0
               OR pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) > 0
               THEN 'inspect_provisional_role_delivery_without_removal'
             ELSE 'run_exact_role_delivery_cleanup'
           END
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.guild_id = v_intent.guild_id
     AND alert.alert_type = 'commerce_role_delivery_intent_unresolved'
     AND alert.resolved = false
     AND alert.metadata ->> 'intent_id' = v_intent.id::TEXT;

  IF p_error IS NOT NULL THEN
    UPDATE public.commerce_role_delivery_intents
       SET last_error = pg_catalog.left(p_error, 4000),
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_resolve_role_delivery_alert(
  p_intent_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_guild_id TEXT;
BEGIN
  SELECT intent.guild_id
    INTO v_guild_id
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
     AND intent.state = 'settled'
     AND intent.settled_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.alerts AS alert
     SET resolved = true,
         resolved_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.alert_type = 'commerce_role_delivery_intent_unresolved'
     AND alert.guild_id = v_guild_id
     AND alert.resolved = false
     AND alert.metadata ->> 'intent_id' = p_intent_id::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_signal_role_delivery_intent(UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_resolve_role_delivery_alert(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.bot_action_queue_claim(UUID);
CREATE FUNCTION public.bot_action_queue_claim(
  p_action_id UUID,
  p_protocol_version INTEGER
)
RETURNS TABLE (
  id UUID,
  guild_id TEXT,
  action TEXT,
  payload JSONB,
  status TEXT,
  retry_count INTEGER,
  lane TEXT,
  claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_protocol_version IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'bot_action_queue_claim: unsupported worker protocol';
  END IF;

  RETURN QUERY
  UPDATE public.bot_action_queue AS queue
     SET status = 'processing',
         claim_token = gen_random_uuid(),
         started_at = pg_catalog.clock_timestamp(),
         completed_at = NULL,
         error_message = NULL,
         next_retry_at = NULL
   WHERE queue.id = p_action_id
     AND queue.status = 'pending'
     AND (queue.next_retry_at IS NULL
       OR queue.next_retry_at <= pg_catalog.clock_timestamp())
     AND queue.lane = public.bot_action_queue_lane_for_action(queue.action)
     AND pg_catalog.jsonb_typeof(queue.payload) = 'object'
   RETURNING queue.id,
             queue.guild_id,
             queue.action,
             queue.payload,
             queue.status,
             queue.retry_count,
             queue.lane,
             queue.claim_token;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_claim(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_action_queue_claim(UUID, INTEGER)
  TO service_role;

DROP FUNCTION IF EXISTS public.bot_action_queue_retry_claim(
  UUID, UUID, TEXT, TIMESTAMPTZ
);
CREATE FUNCTION public.bot_action_queue_retry_claim(
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
  v_observed_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_applied BOOLEAN := false;
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL
     OR p_next_retry_at IS NULL
     OR NOT pg_catalog.isfinite(p_next_retry_at) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'bot_action_queue_retry_claim: exact finite claim identity is required';
  END IF;

  SELECT intent.*
    INTO v_observed_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.action_id = p_action_id
      OR intent.cleanup_action_id = p_action_id;

  IF v_observed_intent.id IS NOT NULL THEN
    PERFORM 1
      FROM public.orders AS paid_order
     WHERE paid_order.id = v_observed_intent.order_id
     FOR SHARE;
    PERFORM 1
      FROM public.customers AS customer
     WHERE customer.id = v_observed_intent.customer_id
     FOR SHARE;
    PERFORM 1
      FROM public.entitlements AS entitlement
     WHERE entitlement.id = v_observed_intent.entitlement_id
     FOR SHARE;

    SELECT intent.*
      INTO v_intent
     FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.id = v_observed_intent.id
       AND (
         intent.action_id = p_action_id
         OR intent.cleanup_action_id = p_action_id
       )
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'stale_claim'::TEXT;
      RETURN;
    END IF;

    SELECT queue.* INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'stale_claim'::TEXT;
      RETURN;
    END IF;

    IF v_intent.action_id = p_action_id AND (
      (
        v_intent.state = 'open'
        AND v_intent.delivery_confirmed_at IS NOT NULL
        AND v_intent.mutation_token IS NULL
        AND v_intent.last_delivery_outcome = 'live'
      )
      OR v_intent.state = 'settled'
    ) THEN
      UPDATE public.bot_action_queue
         SET status = 'completed', completed_at = pg_catalog.clock_timestamp(),
             error_message = NULL
       WHERE id = p_action_id AND status = 'processing'
         AND claim_token = p_claim_token;
      RETURN QUERY SELECT false, 'completed'::TEXT;
      RETURN;
    END IF;
    IF v_intent.cleanup_action_id = p_action_id
       AND v_intent.state = 'settled'
       AND v_intent.cleanup_mutation_token IS NULL THEN
      UPDATE public.bot_action_queue
         SET status = 'completed', completed_at = pg_catalog.clock_timestamp(),
             error_message = NULL
       WHERE id = p_action_id AND status = 'processing'
         AND claim_token = p_claim_token;
      RETURN QUERY SELECT false, 'completed'::TEXT;
      RETURN;
    END IF;

    IF (
         v_intent.action_id = p_action_id
         AND (
           v_intent.state NOT IN ('open', 'settled')
           OR v_intent.mutation_token IS NOT NULL
           OR v_intent.delivery_confirmed_at IS NOT NULL
           OR pg_catalog.cardinality(v_intent.reserved_role_ids) > 0
           OR pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) > 0
           OR (
             (
               pg_catalog.cardinality(v_intent.owned_role_ids) > 0
               OR pg_catalog.cardinality(v_intent.temporary_role_grant_ids) > 0
             )
             AND NOT (
               v_intent.state = 'open'
               AND v_intent.delivery_confirmed_at IS NULL
               AND v_intent.mutation_token IS NULL
               AND v_intent.last_delivery_outcome = 'retry'
               AND public.commerce_role_delivery_contract_state(v_intent.id) = 'live'
             )
           )
         )
       )
       OR (
         v_intent.cleanup_action_id = p_action_id
         AND v_intent.cleanup_mutation_token IS NOT NULL
       ) THEN
      UPDATE public.commerce_role_delivery_intents
         SET state = 'operator_required',
             last_delivery_mutation_token = CASE
               WHEN action_id = p_action_id AND mutation_token IS NOT NULL
                 THEN mutation_token ELSE last_delivery_mutation_token END,
             last_delivery_outcome = CASE
               WHEN action_id = p_action_id AND mutation_token IS NOT NULL
                 THEN 'retry' ELSE last_delivery_outcome END,
             mutation_token = CASE
               WHEN action_id = p_action_id THEN NULL ELSE mutation_token END,
             mutation_started_at = CASE
               WHEN action_id = p_action_id THEN NULL ELSE mutation_started_at END,
             last_cleanup_mutation_token = CASE
               WHEN cleanup_action_id = p_action_id
                 AND cleanup_mutation_token IS NOT NULL
                 THEN cleanup_mutation_token ELSE last_cleanup_mutation_token END,
             last_cleanup_outcome = CASE
               WHEN cleanup_action_id = p_action_id
                 AND cleanup_mutation_token IS NOT NULL
                 THEN 'retry' ELSE last_cleanup_outcome END,
             cleanup_mutation_token = CASE
               WHEN cleanup_action_id = p_action_id THEN NULL
               ELSE cleanup_mutation_token END,
             cleanup_mutation_started_at = CASE
               WHEN cleanup_action_id = p_action_id THEN NULL
               ELSE cleanup_mutation_started_at END,
             last_error = pg_catalog.left(
               COALESCE(p_error, 'unsafe retry requested with unresolved role mutation'),
               4000
             ),
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
         AND state <> 'settled';
      PERFORM public.commerce_signal_role_delivery_intent(
        v_intent.id,
        COALESCE(p_error, 'unsafe retry requested with unresolved role mutation')
      );
      UPDATE public.bot_action_queue
         SET status = 'failed', completed_at = pg_catalog.clock_timestamp(),
             error_message = COALESCE(
               p_error, 'unsafe retry requested with unresolved role mutation'
             )
       WHERE id = p_action_id AND status = 'processing'
         AND claim_token = p_claim_token;
      INSERT INTO public.action_queue_dlq (
        guild_id, action, payload, error_message, retry_count, max_retries,
        original_id, failed_at, lane
      )
      SELECT v_action.guild_id, v_action.action, v_action.payload,
             COALESCE(p_error, 'unsafe retry requested with unresolved role mutation'),
             v_action.retry_count, 5, v_action.id::TEXT,
             pg_catalog.clock_timestamp(), v_action.lane
       WHERE NOT EXISTS (
         SELECT 1 FROM public.action_queue_dlq AS dlq
          WHERE dlq.original_id = v_action.id::TEXT
            AND dlq.retried IS NOT TRUE
       )
       ON CONFLICT DO NOTHING;
      RETURN QUERY SELECT false, 'operator_held'::TEXT;
      RETURN;
    END IF;
  ELSE
    PERFORM 1
      FROM public.bot_action_queue AS queue
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'stale_claim'::TEXT;
      RETURN;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'commerce-role-delivery-action:' || p_action_id::TEXT,
        0
      )
    );
    -- This must be a new READ COMMITTED statement after the action lock was
    -- acquired. If a concurrent begin inserted while holding that lock, its
    -- commit is now visible; an old statement snapshot/EPQ recheck is not.
    PERFORM 1
       FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.action_id = p_action_id
        OR intent.cleanup_action_id = p_action_id;
    IF FOUND THEN
      RETURN QUERY SELECT false, 'intent_raced'::TEXT;
      RETURN;
    END IF;
  END IF;

  UPDATE public.bot_action_queue AS queue
     SET status = 'pending',
         retry_count = queue.retry_count + 1,
         error_message = p_error,
         next_retry_at = p_next_retry_at,
         started_at = NULL
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token;
  v_applied := FOUND;
  RETURN QUERY SELECT v_applied, CASE WHEN v_applied
    THEN 'requeued' ELSE 'stale_claim' END;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_retry_claim(
  UUID, UUID, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_action_queue_retry_claim(
  UUID, UUID, TEXT, TIMESTAMPTZ
) TO service_role;

-- Caller-owned locks make this a pure immutable business-contract classifier.
-- It validates the exact queue payload, frozen parents, paid evidence, and
-- current financial access, but deliberately does not treat the carrier's
-- transient queue status/claim generation as part of that business truth.
-- `invalid` means the durable identity/vector is malformed or cross-linked;
-- `terminal` means the once-valid target lost access and needs cleanup.
CREATE OR REPLACE FUNCTION public.commerce_paid_role_delivery_business_contract_state(
  p_intent_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_legacy RECORD;
  v_snapshot_valid BOOLEAN := false;
  v_paid_valid BOOLEAN := false;
  v_payment_terminal BOOLEAN := false;
BEGIN
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RETURN 'invalid';
  END IF;

  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = v_intent.action_id;
  IF NOT FOUND THEN
    RETURN 'claim_lost';
  END IF;

  IF v_action.guild_id IS DISTINCT FROM v_intent.guild_id
     OR pg_catalog.jsonb_typeof(v_action.payload) IS DISTINCT FROM 'object'
     OR v_action.payload ->> 'guild_id' IS DISTINCT FROM v_intent.guild_id
     OR v_action.payload ->> 'customer_id' IS DISTINCT FROM v_intent.customer_id::TEXT
     OR v_action.payload ->> 'discord_id' IS DISTINCT FROM v_intent.discord_id
     OR v_action.payload ->> 'order_id' IS DISTINCT FROM v_intent.order_id::TEXT
     OR v_action.payload ->> 'product_id' IS DISTINCT FROM v_intent.product_id::TEXT
     OR v_action.payload ->> 'entitlement_type' IS DISTINCT FROM v_intent.entitlement_type
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_action.payload -> 'granted_role_ids',
       v_intent.permanent_role_ids
     )
     OR NOT (
       (
         v_action.action = 'fulfill_purchase'
         AND v_intent.entitlement_type = 'one_time'
         AND v_action.payload ->> 'fulfillment_type' = 'one_time_purchase'
         AND v_action.payload ->> 'plan_id' IS NULL
       )
       OR (
         v_action.action = 'fulfill_subscription'
         AND v_intent.entitlement_type = 'subscription'
         AND v_action.payload ->> 'fulfillment_type' IN (
           'subscription_activated', 'subscription_renewed'
         )
         AND v_action.payload ->> 'plan_id' = v_intent.plan_id::TEXT
         AND (
           v_action.payload ->> 'fulfillment_type' <> 'subscription_renewed'
           OR v_action.payload ->> 'existing_entitlement_id'
             = v_intent.entitlement_id::TEXT
         )
       )
       OR (
         v_action.action = 'reconcile_entitlement_roles'
         AND v_action.payload ->> 'mode' = 'ensure_live'
         AND v_action.payload ->> 'action_id' = v_action.id::TEXT
         AND (
           (v_intent.entitlement_type = 'one_time'
             AND v_action.payload ->> 'plan_id' IS NULL)
           OR (v_intent.entitlement_type = 'subscription'
             AND v_action.payload ->> 'plan_id' = v_intent.plan_id::TEXT)
         )
       )
     ) THEN
    RETURN 'invalid';
  END IF;

  SELECT paid_order.* INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = v_intent.order_id;
  SELECT customer.* INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = v_intent.customer_id;
  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_intent.entitlement_id;
  IF v_order.id IS NULL OR v_customer.id IS NULL OR v_entitlement.id IS NULL THEN
    RETURN 'invalid';
  END IF;

  IF v_order.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_order.customer_id IS DISTINCT FROM v_intent.customer_id
     OR v_order.product_id IS DISTINCT FROM v_intent.product_id
     OR v_order.plan_id IS DISTINCT FROM v_intent.plan_id
     OR NOT COALESCE(v_order.source IN ('purchase'), v_order.source IS NULL)
     OR (
       v_action.action <> 'reconcile_entitlement_roles'
       AND (
         v_action.payload ->> 'order_number' IS DISTINCT FROM v_order.order_number
         OR v_action.payload -> 'amount_cents'
           IS DISTINCT FROM pg_catalog.to_jsonb(v_order.amount_cents)
         OR v_action.payload ->> 'currency' IS DISTINCT FROM v_order.currency
       )
     )
     OR v_customer.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_entitlement.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_entitlement.customer_id IS DISTINCT FROM v_intent.customer_id
     OR v_entitlement.order_id IS DISTINCT FROM v_intent.order_id
     OR v_entitlement.product_id IS DISTINCT FROM v_intent.product_id
     OR v_entitlement.plan_id IS DISTINCT FROM v_intent.plan_id
     OR v_entitlement.type IS DISTINCT FROM v_intent.entitlement_type
     OR NOT COALESCE(
       v_entitlement.source = 'purchase' OR v_entitlement.source IS NULL,
       false
     )
     OR public.commerce_canonical_snowflake_snapshot(
       v_entitlement.granted_role_ids
     ) IS DISTINCT FROM v_intent.permanent_role_ids THEN
    RETURN 'invalid';
  END IF;

  IF v_intent.entitlement_type = 'one_time' THEN
    v_snapshot_valid :=
      v_order.plan_id IS NULL
      AND v_order.paypal_subscription_id IS NULL
      AND v_order.amount_cents > 0
      AND v_order.grant_snapshot_frozen_at IS NOT NULL
      AND public.commerce_valid_snowflake_snapshot(
        v_order.granted_role_ids_snapshot
      )
      AND public.commerce_canonical_snowflake_snapshot(
        v_order.granted_role_ids_snapshot
      ) IS NOT DISTINCT FROM v_intent.permanent_role_ids;
  ELSE
    IF v_order.plan_id IS NULL
       OR v_order.paypal_subscription_id IS NULL
       OR v_order.paypal_subscription_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
       OR (
         v_action.action <> 'reconcile_entitlement_roles'
         AND v_action.payload ->> 'paypal_subscription_id'
           IS DISTINCT FROM v_order.paypal_subscription_id
       ) THEN
      RETURN 'invalid';
    END IF;

    IF v_order.grant_snapshot_frozen_at IS NOT NULL THEN
      v_snapshot_valid := public.commerce_valid_snowflake_snapshot(
        v_order.granted_role_ids_snapshot
      ) AND public.commerce_canonical_snowflake_snapshot(
        v_order.granted_role_ids_snapshot
      ) IS NOT DISTINCT FROM v_intent.permanent_role_ids;
    ELSE
      SELECT legacy.* INTO v_legacy
        FROM public.commerce_legacy_subscription_grant_contracts AS legacy
       WHERE legacy.order_id = v_order.id;
      v_snapshot_valid := FOUND
        AND v_legacy.source_queue_id IS NOT NULL
        AND v_legacy.guild_id IS NOT DISTINCT FROM v_intent.guild_id
        AND v_legacy.customer_id IS NOT DISTINCT FROM v_intent.customer_id
        AND v_legacy.discord_id IS NOT DISTINCT FROM v_intent.discord_id
        AND v_legacy.product_id IS NOT DISTINCT FROM v_intent.product_id
        AND v_legacy.plan_id IS NOT DISTINCT FROM v_intent.plan_id
        AND public.commerce_canonical_snowflake_snapshot(
          v_legacy.granted_role_ids_snapshot
        ) IS NOT DISTINCT FROM v_intent.permanent_role_ids;
    END IF;
  END IF;
  IF NOT COALESCE(v_snapshot_valid, false) THEN
    RETURN 'invalid';
  END IF;

  v_paid_valid := v_order.source = 'purchase' OR (
    v_order.source IS NULL
    AND EXISTS (
      SELECT 1
        FROM public.payments AS payment
       WHERE payment.order_id = v_order.id
         AND payment.customer_id = v_order.customer_id
         AND payment.guild_id = v_order.guild_id
         AND payment.amount_cents = v_order.amount_cents
         AND payment.currency IS NOT NULL
         AND payment.currency = pg_catalog.btrim(payment.currency)
         AND pg_catalog.upper(payment.currency) ~ '^[A-Z]{3}$'
         AND pg_catalog.upper(payment.currency) = v_order.currency
         AND payment.provider = 'paypal'
         AND payment.paypal_resource_type IS NOT DISTINCT FROM CASE
           WHEN v_intent.entitlement_type = 'subscription' THEN 'sale'
           ELSE 'capture'
         END
         AND payment.status IN ('completed', 'refunded', 'reversed')
         AND payment.paypal_payment_id
           ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
    )
  );
  IF NOT COALESCE(v_paid_valid, false) THEN
    RETURN 'invalid';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.payments AS payment
     WHERE payment.order_id = v_order.id
       AND payment.customer_id = v_order.customer_id
       AND payment.guild_id = v_order.guild_id
       AND payment.amount_cents = v_order.amount_cents
       AND payment.currency IS NOT NULL
       AND payment.currency = pg_catalog.btrim(payment.currency)
       AND pg_catalog.upper(payment.currency) ~ '^[A-Z]{3}$'
       AND pg_catalog.upper(payment.currency) = v_order.currency
       AND payment.provider = 'paypal'
       AND payment.paypal_resource_type IS NOT DISTINCT FROM CASE
         WHEN v_intent.entitlement_type = 'subscription' THEN 'sale'
         ELSE 'capture'
       END
       AND payment.status IN ('refunded', 'reversed')
       AND payment.paypal_payment_id
         ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
  ) INTO v_payment_terminal;

  IF v_order.status IS DISTINCT FROM 'completed'
     OR v_entitlement.status NOT IN (
       'active', 'pending', 'grace_period', 'suspended'
     )
     OR v_customer.discord_id IS DISTINCT FROM v_intent.discord_id
     OR v_payment_terminal THEN
    RETURN 'terminal';
  END IF;

  RETURN 'live';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_paid_role_delivery_business_contract_state(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

-- The noncommerce branch is installed after its exact carrier validator is
-- defined. Until then this discriminator keeps all pre-existing callers on
-- the paid contract and fails closed for any impossible early noncommerce row.
CREATE OR REPLACE FUNCTION public.commerce_role_delivery_business_contract_state(
  p_intent_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_contract_kind TEXT;
BEGIN
  SELECT intent.contract_kind INTO v_contract_kind
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF v_contract_kind IS DISTINCT FROM 'paid' THEN
    RETURN 'invalid';
  END IF;
  RETURN public.commerce_paid_role_delivery_business_contract_state(p_intent_id);
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_role_delivery_business_contract_state(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

-- Runtime mutation authority additionally requires the exact live claim
-- generation (or immutable completed-delivery evidence). DLQ recovery calls
-- the business classifier above while holding the failed queue/DLQ rows, then
-- reopens the same carrier; it never broadens this runtime classifier.
CREATE OR REPLACE FUNCTION public.commerce_role_delivery_contract_state(
  p_intent_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_business_state TEXT;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
BEGIN
  v_business_state :=
    public.commerce_role_delivery_business_contract_state(p_intent_id);
  IF v_business_state <> 'live' THEN
    RETURN v_business_state;
  END IF;

  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = v_intent.action_id;
  IF v_intent.id IS NULL OR v_action.id IS NULL THEN
    RETURN 'claim_lost';
  END IF;

  IF v_action.status = 'processing'
     AND v_action.claim_token IS NOT DISTINCT FROM v_intent.delivery_claim_token THEN
    RETURN 'live';
  END IF;

  IF v_action.status = 'processing'
     AND v_action.claim_token IS NOT NULL
     AND v_intent.state = 'open'
     AND v_intent.delivery_confirmed_at IS NOT NULL
     AND v_intent.mutation_token IS NULL
     AND v_intent.last_delivery_mutation_token IS NOT NULL
     AND v_intent.last_delivery_outcome = 'live' THEN
    RETURN 'live';
  END IF;

  -- Successful delivery provenance intentionally outlives queue retention as
  -- an open, idle intent. Once the exact origin action has completed, its claim
  -- token is cleared by the queue state machine; the immutable payload plus the
  -- delivery-confirmation/finalizer evidence is the long-lived proof. An
  -- unconfirmed or mutation-active completed action is never accepted here.
  IF v_action.status = 'completed'
     AND v_action.claim_token IS NULL
     AND v_action.completed_at IS NOT NULL
     AND v_intent.state = 'open'
     AND v_intent.delivery_confirmed_at IS NOT NULL
     AND v_intent.mutation_token IS NULL
     AND v_intent.last_delivery_mutation_token IS NOT NULL
     AND v_intent.last_delivery_outcome = 'live' THEN
    RETURN 'live';
  END IF;

  RETURN 'claim_lost';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_role_delivery_contract_state(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_has_other_live_role_owner(
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_role_id TEXT,
  p_exclude_intent_id UUID,
  p_exclude_entitlement_id UUID,
  p_exclude_grant_ids UUID[]
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
      FROM public.commerce_role_delivery_intents AS other_intent
     WHERE other_intent.guild_id = p_guild_id
       AND other_intent.discord_id = p_discord_id
       AND other_intent.id IS DISTINCT FROM p_exclude_intent_id
       AND other_intent.state = 'open'
       AND other_intent.delivery_confirmed_at IS NOT NULL
       AND other_intent.mutation_token IS NULL
       AND (
         p_role_id = ANY(other_intent.owned_role_ids)
         OR EXISTS (
           SELECT 1
             FROM public.temp_role_grants AS intent_grant
            WHERE intent_grant.id = ANY(other_intent.temporary_role_grant_ids)
              AND intent_grant.guild_id = other_intent.guild_id
              AND intent_grant.user_id = other_intent.discord_id
              AND intent_grant.role_id = p_role_id
              AND intent_grant.remove_on_expiry = true
              AND (
                intent_grant.grant_status = 'pending'
                OR (
                  intent_grant.grant_status = 'applied'
                  AND intent_grant.expires_at > pg_catalog.clock_timestamp()
                )
              )
         )
       )
       AND public.commerce_role_delivery_contract_state(other_intent.id) = 'live'
  ) OR EXISTS (
    SELECT 1
      FROM public.entitlements AS entitlement
      JOIN public.customers AS customer
        ON customer.id = entitlement.customer_id
       AND customer.guild_id = entitlement.guild_id
     WHERE entitlement.guild_id = p_guild_id
       AND customer.discord_id = p_discord_id
       AND entitlement.id IS DISTINCT FROM p_exclude_entitlement_id
       AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
       AND entitlement.source IN ('giveaway', 'manual', 'automation')
       AND p_role_id = ANY(COALESCE(entitlement.granted_role_ids, '{}'::TEXT[]))
  ) OR EXISTS (
    SELECT 1
      FROM public.entitlements AS entitlement
      JOIN public.customers AS customer
        ON customer.id = entitlement.customer_id
       AND customer.guild_id = entitlement.guild_id
      JOIN public.orders AS paid_order
        ON paid_order.id = entitlement.order_id
       AND paid_order.guild_id = entitlement.guild_id
       AND paid_order.customer_id = entitlement.customer_id
       AND paid_order.product_id = entitlement.product_id
     WHERE entitlement.guild_id = p_guild_id
       AND customer.discord_id = p_discord_id
       AND entitlement.id IS DISTINCT FROM p_exclude_entitlement_id
       AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
       AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
       AND p_role_id = ANY(COALESCE(entitlement.granted_role_ids, '{}'::TEXT[]))
       AND paid_order.status = 'completed'
       AND (
         (
           paid_order.grant_snapshot_frozen_at IS NOT NULL
           AND p_role_id = ANY(paid_order.granted_role_ids_snapshot)
         )
         OR (
           entitlement.type = 'subscription'
           AND paid_order.grant_snapshot_frozen_at IS NULL
           AND EXISTS (
             SELECT 1
               FROM public.commerce_legacy_subscription_grant_contracts AS legacy
              WHERE legacy.order_id = paid_order.id
                AND p_role_id = ANY(legacy.granted_role_ids_snapshot)
           )
         )
       )
       AND (
         paid_order.source = 'purchase'
         OR (
           paid_order.source IS NULL
           AND EXISTS (
             SELECT 1
               FROM public.payments AS payment
              WHERE payment.order_id = paid_order.id
                AND payment.customer_id = paid_order.customer_id
                AND payment.guild_id = paid_order.guild_id
                AND payment.amount_cents = paid_order.amount_cents
                AND payment.currency IS NOT NULL
                AND payment.currency = pg_catalog.btrim(payment.currency)
                AND pg_catalog.upper(payment.currency) = paid_order.currency
                AND payment.provider = 'paypal'
                AND payment.paypal_resource_type IS NOT DISTINCT FROM CASE
                  WHEN entitlement.type = 'subscription' THEN 'sale'
                  ELSE 'capture'
                END
                AND payment.status = 'completed'
                AND payment.paypal_payment_id
                  ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
           )
         )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.payments AS terminal_payment
          WHERE terminal_payment.order_id = paid_order.id
            AND terminal_payment.customer_id = paid_order.customer_id
            AND terminal_payment.guild_id = paid_order.guild_id
            AND terminal_payment.amount_cents = paid_order.amount_cents
            AND terminal_payment.currency IS NOT NULL
            AND terminal_payment.currency = pg_catalog.btrim(
              terminal_payment.currency
            )
            AND pg_catalog.upper(terminal_payment.currency) = paid_order.currency
            AND terminal_payment.provider = 'paypal'
            AND terminal_payment.paypal_resource_type IS NOT DISTINCT FROM CASE
              WHEN entitlement.type = 'subscription' THEN 'sale'
              ELSE 'capture'
            END
            AND terminal_payment.status IN ('refunded', 'reversed')
            AND terminal_payment.paypal_payment_id
              ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.temp_role_grants AS grant_row
      JOIN public.orders AS paid_order
        ON paid_order.id = grant_row.order_id
       AND paid_order.guild_id = grant_row.guild_id
      JOIN public.customers AS customer
        ON customer.id = paid_order.customer_id
       AND customer.guild_id = paid_order.guild_id
     WHERE grant_row.guild_id = p_guild_id
       AND grant_row.user_id = p_discord_id
       AND grant_row.role_id = p_role_id
       AND NOT (
         grant_row.id = ANY(COALESCE(p_exclude_grant_ids, '{}'::UUID[]))
       )
       AND grant_row.source = 'commerce_purchase'
       AND grant_row.source_id = paid_order.product_id::TEXT
       AND grant_row.grant_status IN ('pending', 'applied')
       AND grant_row.remove_on_expiry = true
       AND (
         grant_row.grant_status = 'pending'
         OR (
           grant_row.grant_status = 'applied'
           AND grant_row.expires_at > pg_catalog.clock_timestamp()
         )
       )
       AND paid_order.status = 'completed'
       AND paid_order.amount_cents > 0
       AND paid_order.grant_snapshot_frozen_at IS NOT NULL
       AND paid_order.paypal_subscription_id IS NULL
       AND paid_order.plan_id IS NULL
       AND customer.discord_id = grant_row.user_id
       AND public.commerce_valid_temp_role_snapshot(
         paid_order.temporary_role_grants_snapshot
       )
       AND EXISTS (
         SELECT 1
           FROM pg_catalog.jsonb_array_elements(
             paid_order.temporary_role_grants_snapshot
           ) AS frozen_grant(value)
          WHERE frozen_grant.value ->> 'role_id' = grant_row.role_id
            AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
              = grant_row.duration_seconds
       )
       AND (
         paid_order.source = 'purchase'
         OR (
           paid_order.source IS NULL
           AND EXISTS (
             SELECT 1
               FROM public.payments AS payment
              WHERE payment.order_id = paid_order.id
                AND payment.customer_id = paid_order.customer_id
                AND payment.guild_id = paid_order.guild_id
                AND payment.amount_cents = paid_order.amount_cents
                AND payment.currency IS NOT NULL
                AND payment.currency = pg_catalog.btrim(payment.currency)
                AND pg_catalog.upper(payment.currency) ~ '^[A-Z]{3}$'
                AND pg_catalog.upper(payment.currency) = paid_order.currency
                AND payment.provider = 'paypal'
                AND payment.paypal_resource_type IS NOT DISTINCT FROM 'capture'
                AND payment.status = 'completed'
                AND payment.paypal_payment_id
                  ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
           )
         )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.payments AS terminal_payment
          WHERE terminal_payment.order_id = paid_order.id
            AND terminal_payment.customer_id = paid_order.customer_id
            AND terminal_payment.guild_id = paid_order.guild_id
            AND terminal_payment.amount_cents = paid_order.amount_cents
            AND terminal_payment.currency IS NOT NULL
            AND terminal_payment.currency = pg_catalog.btrim(
              terminal_payment.currency
            )
            AND pg_catalog.upper(terminal_payment.currency) = paid_order.currency
            AND terminal_payment.provider = 'paypal'
            AND terminal_payment.paypal_resource_type IS NOT DISTINCT FROM 'capture'
            AND terminal_payment.status IN ('refunded', 'reversed')
            AND terminal_payment.paypal_payment_id
              ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
       )
       AND EXISTS (
         SELECT 1
           FROM public.entitlements AS entitlement
          WHERE entitlement.order_id = paid_order.id
            AND entitlement.guild_id = paid_order.guild_id
            AND entitlement.customer_id = paid_order.customer_id
            AND entitlement.product_id = paid_order.product_id
            AND entitlement.plan_id IS NULL
            AND entitlement.type = 'one_time'
            AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
            AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
       )
  ), false);
$$;

REVOKE ALL ON FUNCTION public.commerce_has_other_live_role_owner(
  TEXT, TEXT, TEXT, UUID, UUID, UUID[]
) FROM PUBLIC, anon, authenticated, service_role;

-- Classify only durable delivery-intent lineage. A present Discord role may be
-- inherited from a confirmed/open exact owner; unresolved ownership forces a
-- retry; absence of either is a manual/unowned baseline. Paid entitlement
-- metadata and unattached temp-grant rows are intentionally not ownership.
CREATE OR REPLACE FUNCTION public.commerce_role_delivery_owner_state(
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_role_id TEXT,
  p_exclude_intent_id UUID,
  p_exclude_grant_ids UUID[]
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_has_pending BOOLEAN := false;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_discord_id IS NULL OR pg_catalog.btrim(p_discord_id) = ''
     OR p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$'
     OR NOT public.commerce_valid_uuid_snapshot(
       COALESCE(p_exclude_grant_ids, '{}'::UUID[])
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_role_delivery_owner_state: exact identity is required';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.commerce_role_delivery_intents AS owner_intent
     WHERE owner_intent.guild_id = p_guild_id
       AND owner_intent.discord_id = p_discord_id
       AND owner_intent.id IS DISTINCT FROM p_exclude_intent_id
       AND owner_intent.state = 'open'
       AND owner_intent.delivery_confirmed_at IS NOT NULL
       AND owner_intent.mutation_token IS NULL
       AND owner_intent.cleanup_action_id IS NULL
       AND (
         p_role_id = ANY(owner_intent.owned_role_ids)
         OR EXISTS (
           SELECT 1
             FROM public.temp_role_grants AS owner_grant
             WHERE owner_grant.id = ANY(owner_intent.temporary_role_grant_ids)
                AND NOT (
                 owner_grant.id = ANY(
                   COALESCE(p_exclude_grant_ids, '{}'::UUID[])
                 )
               )
               AND owner_grant.guild_id = owner_intent.guild_id
               AND owner_grant.user_id = owner_intent.discord_id
               AND owner_grant.role_id = p_role_id
               AND owner_grant.source = 'commerce_purchase'
               AND owner_grant.order_id = owner_intent.order_id
               AND owner_grant.source_id = owner_intent.product_id::TEXT
               AND owner_grant.grant_status = 'applied'
              AND owner_grant.remove_on_expiry = true
              AND owner_grant.expires_at > pg_catalog.clock_timestamp()
         )
       )
       AND public.commerce_role_delivery_contract_state(owner_intent.id) = 'live'
  ) THEN
    RETURN 'confirmed';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.commerce_role_delivery_intents AS owner_intent
     WHERE owner_intent.guild_id = p_guild_id
       AND owner_intent.discord_id = p_discord_id
       AND owner_intent.id IS DISTINCT FROM p_exclude_intent_id
       AND owner_intent.state IN ('open', 'operator_required')
       AND owner_intent.delivery_confirmed_at IS NULL
       AND public.commerce_role_delivery_business_contract_state(
         owner_intent.id
       ) = 'live'
       AND (
         p_role_id = ANY(owner_intent.reserved_role_ids)
         OR p_role_id = ANY(owner_intent.owned_role_ids)
         OR EXISTS (
           SELECT 1
             FROM public.temp_role_grants AS owner_grant
             WHERE owner_grant.id = ANY(
                     owner_intent.reserved_temp_role_grant_ids
                     || owner_intent.temporary_role_grant_ids
                   )
               AND (
                 -- Exclusion retires only confirmed ownership for the exact
                 -- grant. A still-provisional reservation must remain visible
                 -- as pending so the sweeper never races an in-flight add.
                 owner_grant.id = ANY(owner_intent.reserved_temp_role_grant_ids)
                 OR NOT (
                   owner_grant.id = ANY(
                     COALESCE(p_exclude_grant_ids, '{}'::UUID[])
                   )
                 )
               )
               AND owner_grant.guild_id = owner_intent.guild_id
               AND owner_grant.user_id = owner_intent.discord_id
               AND owner_grant.role_id = p_role_id
               AND owner_grant.source = 'commerce_purchase'
               AND owner_grant.order_id = owner_intent.order_id
               AND owner_grant.source_id = owner_intent.product_id::TEXT
              AND (
                (
                  owner_grant.id = ANY(owner_intent.reserved_temp_role_grant_ids)
                  AND owner_grant.grant_status = 'pending'
                  AND owner_grant.applied_at IS NULL
                  AND owner_grant.remove_on_expiry = false
                )
                OR (
                  owner_grant.id = ANY(owner_intent.temporary_role_grant_ids)
                  AND owner_grant.grant_status = 'applied'
                  AND owner_grant.remove_on_expiry = true
                  AND owner_grant.expires_at > pg_catalog.clock_timestamp()
                )
              )
         )
       )
  ) INTO v_has_pending;

  RETURN CASE WHEN v_has_pending THEN 'pending' ELSE 'none' END;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_role_delivery_owner_state(
  TEXT, TEXT, TEXT, UUID, UUID[]
) FROM PUBLIC, anon, authenticated, service_role;

-- Replace the broad compatibility predicate above with the authoritative
-- removal-safety predicate. Paid metadata or a free-standing order-backed
-- temp row cannot prove Discord delivery; only an exact confirmed intent can.
-- Nonpurchase desired state is not delivery evidence. Noncommerce ownership
-- participates through the same confirmed intent rows as paid ownership;
-- only legacy applied temporary grants remain independent owners.
CREATE OR REPLACE FUNCTION public.commerce_has_other_live_role_owner(
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_role_id TEXT,
  p_exclude_intent_id UUID,
  p_exclude_entitlement_id UUID,
  p_exclude_grant_ids UUID[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.commerce_role_delivery_owner_state(
       p_guild_id,
       p_discord_id,
       p_role_id,
       p_exclude_intent_id,
       COALESCE(p_exclude_grant_ids, '{}'::UUID[])
     ) = 'confirmed' THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.temp_role_grants AS grant_row
     WHERE grant_row.order_id IS NULL
       AND grant_row.guild_id = p_guild_id
       AND grant_row.user_id = p_discord_id
       AND grant_row.role_id = p_role_id
       AND NOT (
         grant_row.id = ANY(COALESCE(p_exclude_grant_ids, '{}'::UUID[]))
       )
       AND grant_row.grant_status = 'applied'
       AND grant_row.expires_at > pg_catalog.clock_timestamp()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_has_other_live_role_owner(
  TEXT, TEXT, TEXT, UUID, UUID, UUID[]
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_has_live_role_owner(
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_role_id TEXT,
  p_exclude_intent_id UUID,
  p_exclude_entitlement_id UUID,
  p_exclude_grant_ids UUID[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_discord_id IS NULL OR pg_catalog.btrim(p_discord_id) = ''
     OR p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$'
     OR NOT public.commerce_valid_uuid_snapshot(
       COALESCE(p_exclude_grant_ids, '{}'::UUID[])
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_has_live_role_owner: exact identity is required';
  END IF;
  RETURN public.commerce_has_other_live_role_owner(
    p_guild_id,
    p_discord_id,
    p_role_id,
    p_exclude_intent_id,
    p_exclude_entitlement_id,
    COALESCE(p_exclude_grant_ids, '{}'::UUID[])
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_has_live_role_owner(
  TEXT, TEXT, TEXT, UUID, UUID, UUID[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_has_live_role_owner(
  TEXT, TEXT, TEXT, UUID, UUID, UUID[]
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_classify_live_role_owner(
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_role_id TEXT,
  p_exclude_intent_id UUID,
  p_exclude_entitlement_id UUID,
  p_exclude_grant_ids UUID[]
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state TEXT;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_discord_id IS NULL OR pg_catalog.btrim(p_discord_id) = ''
     OR p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$'
     OR NOT public.commerce_valid_uuid_snapshot(
       COALESCE(p_exclude_grant_ids, '{}'::UUID[])
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_classify_live_role_owner: exact identity is required';
  END IF;
  v_state := public.commerce_role_delivery_owner_state(
    p_guild_id,
    p_discord_id,
    p_role_id,
    p_exclude_intent_id,
    COALESCE(p_exclude_grant_ids, '{}'::UUID[])
  );
  IF v_state = 'confirmed' THEN
    RETURN 'confirmed';
  END IF;
  IF public.commerce_has_other_live_role_owner(
    p_guild_id,
    p_discord_id,
    p_role_id,
    p_exclude_intent_id,
    p_exclude_entitlement_id,
    COALESCE(p_exclude_grant_ids, '{}'::UUID[])
  ) THEN
    RETURN 'confirmed';
  END IF;
  IF v_state = 'pending' THEN
    RETURN 'pending';
  END IF;
  RETURN 'none';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_classify_live_role_owner(
  TEXT, TEXT, TEXT, UUID, UUID, UUID[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_classify_live_role_owner(
  TEXT, TEXT, TEXT, UUID, UUID, UUID[]
) TO service_role;

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
  cleanup_needed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_contract_state TEXT;
  v_mutation_token UUID;
  v_permanent_role_ids TEXT[];
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL
     OR p_entitlement_id IS NULL OR p_customer_id IS NULL
     OR p_order_id IS NULL OR p_product_id IS NULL
     OR p_guild_id IS NULL OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = ''
     OR p_discord_id IS NULL OR p_discord_id <> pg_catalog.btrim(p_discord_id)
     OR p_discord_id = ''
     OR p_entitlement_type NOT IN ('one_time', 'subscription')
     OR NOT public.commerce_valid_snowflake_snapshot(p_permanent_role_ids)
     OR (p_entitlement_type = 'one_time' AND p_plan_id IS NOT NULL)
     OR (p_entitlement_type = 'subscription' AND p_plan_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_attempt: exact identity is required';
  END IF;
  v_permanent_role_ids := public.commerce_canonical_snowflake_snapshot(
    p_permanent_role_ids
  );

  -- Canonical blocking order: order -> customer -> entitlement -> existing
  -- intent -> action. With no existing intent, the action row is the gap lock;
  -- the insert occurs only while it is held, so retry/finalization can recheck
  -- absence in a fresh statement without an uncommitted-intent race.
  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_attempt: order is unavailable';
  END IF;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = p_customer_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_attempt: customer is unavailable';
  END IF;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_attempt: entitlement is unavailable';
  END IF;

  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.action_id = p_action_id
   FOR UPDATE;

  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
   FOR UPDATE;
  IF NOT FOUND OR v_action.status IS DISTINCT FROM 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_claim_token THEN
    IF v_intent.id IS NOT NULL AND v_intent.state <> 'settled' THEN
      UPDATE public.commerce_role_delivery_intents
         SET state = 'operator_required',
             last_error = 'delivery action claim was lost before begin',
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id;
      PERFORM public.commerce_signal_role_delivery_intent(
        v_intent.id,
        'delivery action claim was lost before begin'
      );
      RETURN QUERY SELECT v_intent.id, NULL::UUID, 'operator_required',
        false, false, v_intent.delivery_confirmed_at IS NOT NULL, true;
      RETURN;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_attempt: action claim is not current';
  END IF;

  IF v_intent.id IS NULL THEN
    -- A second statement after the action lock observes any inserter that
    -- committed while this caller waited.
    SELECT intent.* INTO v_intent
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.action_id = p_action_id
     FOR UPDATE;
  END IF;

  IF v_intent.id IS NULL THEN
    INSERT INTO public.commerce_role_delivery_intents (
      action_id, origin_claim_token, delivery_claim_token,
      guild_id, entitlement_id, customer_id, discord_id, order_id,
      product_id, plan_id, entitlement_type, permanent_role_ids,
      owned_role_ids, temporary_role_grant_ids, state
    ) VALUES (
      p_action_id, p_claim_token, p_claim_token,
      p_guild_id, p_entitlement_id, p_customer_id, p_discord_id, p_order_id,
      p_product_id, p_plan_id, p_entitlement_type, v_permanent_role_ids,
      '{}'::TEXT[], '{}'::UUID[], 'open'
    ) RETURNING * INTO v_intent;
  ELSIF v_intent.guild_id IS DISTINCT FROM p_guild_id
        OR v_intent.entitlement_id IS DISTINCT FROM p_entitlement_id
        OR v_intent.customer_id IS DISTINCT FROM p_customer_id
        OR v_intent.discord_id IS DISTINCT FROM p_discord_id
        OR v_intent.order_id IS DISTINCT FROM p_order_id
        OR v_intent.product_id IS DISTINCT FROM p_product_id
        OR v_intent.plan_id IS DISTINCT FROM p_plan_id
        OR v_intent.entitlement_type IS DISTINCT FROM p_entitlement_type
        OR v_intent.permanent_role_ids IS DISTINCT FROM v_permanent_role_ids THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_attempt: durable intent identity mismatch';
  ELSIF v_intent.state = 'open'
        AND v_intent.mutation_token IS NULL
        AND v_intent.delivery_confirmed_at IS NULL THEN
    UPDATE public.commerce_role_delivery_intents
       SET delivery_claim_token = p_claim_token,
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
     RETURNING * INTO v_intent;
  ELSIF v_intent.state = 'open'
        AND v_intent.mutation_token IS NULL
        AND v_intent.delivery_confirmed_at IS NOT NULL
        AND v_intent.last_delivery_outcome = 'live' THEN
    -- A finish response may be lost and the same durable action can be claimed
    -- under a new queue generation. Confirmed long-lived provenance is replayed
    -- read-only; its original delivery claim token never changes.
    NULL;
  ELSIF v_intent.delivery_claim_token IS DISTINCT FROM p_claim_token
        AND v_intent.state <> 'settled' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = 'operator_required',
           last_error = 'a new claim generation found an inflight role mutation',
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
    RETURNING * INTO v_intent;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'a new claim generation found an inflight role mutation'
    );
  END IF;

  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state = 'invalid' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_attempt: contract identity is invalid';
  ELSIF v_contract_state = 'claim_lost' THEN
    IF v_intent.state <> 'settled' THEN
      UPDATE public.commerce_role_delivery_intents
         SET state = 'operator_required',
             last_error = 'delivery action claim was lost during begin',
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
      RETURNING * INTO v_intent;
      PERFORM public.commerce_signal_role_delivery_intent(
        v_intent.id,
        'delivery action claim was lost during begin'
      );
    END IF;
    RETURN QUERY SELECT v_intent.id, NULL::UUID, v_intent.state,
      false, false, v_intent.delivery_confirmed_at IS NOT NULL,
      v_intent.state <> 'settled';
    RETURN;
  ELSIF v_contract_state = 'terminal' THEN
    IF v_intent.state <> 'settled' THEN
      UPDATE public.commerce_role_delivery_intents
         SET state = CASE
               WHEN pg_catalog.cardinality(reserved_role_ids) > 0
                 OR pg_catalog.cardinality(reserved_temp_role_grant_ids) > 0
                 THEN 'operator_required'
               WHEN mutation_token IS NULL
                AND pg_catalog.cardinality(reserved_role_ids) = 0
                AND pg_catalog.cardinality(owned_role_ids) = 0
                AND pg_catalog.cardinality(reserved_temp_role_grant_ids) = 0
                AND pg_catalog.cardinality(temporary_role_grant_ids) = 0
                 THEN 'settled'
               WHEN state = 'operator_required' THEN 'operator_required'
               ELSE 'cleanup_required'
             END,
             settled_at = CASE
               WHEN mutation_token IS NULL
                AND pg_catalog.cardinality(reserved_role_ids) = 0
                AND pg_catalog.cardinality(owned_role_ids) = 0
                AND pg_catalog.cardinality(reserved_temp_role_grant_ids) = 0
                AND pg_catalog.cardinality(temporary_role_grant_ids) = 0
                 THEN pg_catalog.clock_timestamp()
               ELSE NULL
             END,
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
      RETURNING * INTO v_intent;
    END IF;
    IF v_intent.state = 'settled' THEN
      PERFORM public.commerce_resolve_role_delivery_alert(v_intent.id);
    ELSE
      PERFORM public.commerce_signal_role_delivery_intent(
        v_intent.id,
        'paid role delivery contract became terminal before delivery completed'
      );
    END IF;
    RETURN QUERY SELECT v_intent.id, NULL::UUID, v_intent.state,
      false, false, v_intent.delivery_confirmed_at IS NOT NULL,
      v_intent.state <> 'settled';
    RETURN;
  END IF;

  IF v_intent.state = 'settled'
     OR v_intent.delivery_confirmed_at IS NOT NULL
     OR v_intent.state <> 'open'
     OR v_intent.mutation_token IS NOT NULL THEN
    RETURN QUERY SELECT v_intent.id, v_intent.mutation_token, v_intent.state,
      false, true, v_intent.delivery_confirmed_at IS NOT NULL, false;
    RETURN;
  END IF;

  v_mutation_token := gen_random_uuid();
  UPDATE public.commerce_role_delivery_intents
     SET mutation_token = v_mutation_token,
         mutation_started_at = pg_catalog.clock_timestamp(),
         last_error = NULL,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND state = 'open'
     AND mutation_token IS NULL
  RETURNING * INTO v_intent;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT v_intent.id, v_mutation_token, v_intent.state,
    true, true, false, false;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_begin_role_delivery_attempt(
  UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_begin_role_delivery_attempt(
  UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT[]
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_assert_role_delivery_attempt_live(
  p_intent_id UUID,
  p_mutation_token UUID
)
RETURNS TABLE (intent_state TEXT, may_mutate BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_contract_state TEXT;
BEGIN
  IF p_intent_id IS NULL OR p_mutation_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_assert_role_delivery_attempt_live: exact token is required';
  END IF;

  SELECT intent.* INTO v_observed
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_assert_role_delivery_attempt_live: intent is unavailable';
  END IF;

  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id FOR SHARE;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_observed.entitlement_id FOR SHARE;
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_intent.action_id IS DISTINCT FROM v_observed.action_id
     OR v_intent.order_id IS DISTINCT FROM v_observed.order_id
     OR v_intent.entitlement_id IS DISTINCT FROM v_observed.entitlement_id
     OR v_intent.mutation_token IS DISTINCT FROM p_mutation_token THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_assert_role_delivery_attempt_live: mutation identity mismatch';
  END IF;

  PERFORM 1 FROM public.bot_action_queue AS queue
   WHERE queue.id = v_intent.action_id FOR UPDATE;
  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state = 'invalid' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_assert_role_delivery_attempt_live: contract identity is invalid';
  ELSIF v_contract_state = 'terminal' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = CASE WHEN state = 'operator_required'
             THEN 'operator_required' ELSE 'cleanup_required' END,
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
     RETURNING * INTO v_intent;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'paid role delivery contract became terminal during delivery'
    );
    RETURN QUERY SELECT v_intent.state, false;
    RETURN;
  ELSIF v_contract_state = 'claim_lost' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = 'operator_required',
           last_error = 'delivery action claim was lost with a mutation inflight',
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
       AND state <> 'settled'
    RETURNING * INTO v_intent;
    PERFORM public.commerce_signal_role_delivery_intent(
      p_intent_id,
      'delivery action claim was lost with a mutation inflight'
    );
    RETURN QUERY SELECT COALESCE(v_intent.state, 'operator_required'), false;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_intent.state,
    v_intent.state = 'open'
    AND v_intent.delivery_confirmed_at IS NULL
    AND v_intent.mutation_token = p_mutation_token;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_assert_role_delivery_attempt_live(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_assert_role_delivery_attempt_live(UUID, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_claim_permanent_role_delivery(
  p_intent_id UUID,
  p_mutation_token UUID,
  p_role_id TEXT
)
RETURNS TABLE (intent_state TEXT, may_mutate BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_assert RECORD;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
BEGIN
  IF p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_claim_permanent_role_delivery: role is invalid';
  END IF;

  SELECT asserted.* INTO v_assert
    FROM public.commerce_assert_role_delivery_attempt_live(
      p_intent_id, p_mutation_token
    ) AS asserted;
  IF NOT COALESCE(v_assert.may_mutate, false) THEN
    RETURN QUERY SELECT COALESCE(v_assert.intent_state, 'operator_required'), false;
    RETURN;
  END IF;

  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
     AND intent.state = 'open'
     AND intent.mutation_token = p_mutation_token
   FOR UPDATE;
  IF NOT FOUND OR NOT (p_role_id = ANY(v_intent.permanent_role_ids)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_claim_permanent_role_delivery: role is outside the frozen contract';
  END IF;

  UPDATE public.commerce_role_delivery_intents
     SET reserved_role_ids = public.commerce_canonical_snowflake_snapshot(
           pg_catalog.array_append(reserved_role_ids, p_role_id)
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND NOT (p_role_id = ANY(reserved_role_ids))
     AND NOT (p_role_id = ANY(owned_role_ids));

  RETURN QUERY SELECT 'open'::TEXT, true;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_release_unconsumed_permanent_role_claim(
  p_intent_id UUID,
  p_mutation_token UUID,
  p_role_id TEXT
)
RETURNS TABLE (
  intent_state TEXT,
  released BOOLEAN,
  cleanup_needed BOOLEAN,
  settled BOOLEAN,
  may_mutate BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_contract_state TEXT;
BEGIN
  IF p_intent_id IS NULL OR p_mutation_token IS NULL
     OR p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_release_unconsumed_permanent_role_claim: exact claim identity is required';
  END IF;

  SELECT intent.* INTO v_observed
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_release_unconsumed_permanent_role_claim: intent is unavailable';
  END IF;

  -- A release is an authority-reducing compensation step. It deliberately
  -- remains available after the paid contract terminalizes, but only to the
  -- exact still-unconfirmed delivery mutation and before cleanup ownership is
  -- handed to another action.
  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id FOR SHARE;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_observed.entitlement_id FOR SHARE;
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  PERFORM 1 FROM public.bot_action_queue AS queue
   WHERE queue.id = v_observed.action_id FOR UPDATE;

  IF v_intent.id IS NULL
     OR v_intent.action_id IS DISTINCT FROM v_observed.action_id
     OR v_intent.order_id IS DISTINCT FROM v_observed.order_id
     OR v_intent.entitlement_id IS DISTINCT FROM v_observed.entitlement_id
     OR v_intent.mutation_token IS DISTINCT FROM p_mutation_token
     OR v_intent.delivery_confirmed_at IS NOT NULL
     OR v_intent.state = 'settled'
     OR v_intent.cleanup_action_id IS NOT NULL
     OR v_intent.cleanup_claim_token IS NOT NULL
     OR NOT (p_role_id = ANY(v_intent.reserved_role_ids)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_release_unconsumed_permanent_role_claim: claim is no longer releasable';
  END IF;

  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state = 'invalid' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_release_unconsumed_permanent_role_claim: contract identity is invalid';
  ELSIF v_contract_state = 'terminal' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = CASE WHEN state = 'operator_required'
             THEN 'operator_required' ELSE 'cleanup_required' END,
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
     RETURNING * INTO v_intent;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'paid role contract terminalized before an unconsumed permanent-role claim was released'
    );
  ELSIF v_contract_state = 'claim_lost' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = 'operator_required',
           last_error = 'delivery claim was lost before an unconsumed permanent-role claim was released',
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
     RETURNING * INTO v_intent;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'delivery claim was lost before an unconsumed permanent-role claim was released'
    );
  END IF;

  UPDATE public.commerce_role_delivery_intents
     SET reserved_role_ids = pg_catalog.array_remove(
           reserved_role_ids, p_role_id
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = p_intent_id
     AND mutation_token = p_mutation_token
     AND delivery_confirmed_at IS NULL
     AND state <> 'settled'
     AND cleanup_action_id IS NULL
     AND cleanup_claim_token IS NULL
     AND p_role_id = ANY(reserved_role_ids)
  RETURNING * INTO v_intent;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_release_unconsumed_permanent_role_claim: release CAS failed';
  END IF;

  RETURN QUERY SELECT
    v_intent.state,
    true,
    v_intent.state <> 'open',
    false,
    v_intent.state = 'open';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_claim_permanent_role_delivery(
  UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_claim_permanent_role_delivery(
  UUID, UUID, TEXT
) TO service_role;
REVOKE ALL ON FUNCTION public.commerce_release_unconsumed_permanent_role_claim(
  UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_release_unconsumed_permanent_role_claim(
  UUID, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_attach_permanent_role_delivery(
  p_intent_id UUID,
  p_mutation_token UUID,
  p_role_id TEXT,
  p_role_was_present BOOLEAN
)
RETURNS TABLE (
  intent_state TEXT,
  may_mutate BOOLEAN,
  owns_removal BOOLEAN,
  claim_newly_acquired BOOLEAN,
  disposition TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_contract_state TEXT;
  v_owner_state TEXT;
  v_preexisting BOOLEAN := false;
  v_reserved BOOLEAN := false;
  v_claim_new BOOLEAN := false;
BEGIN
  IF p_intent_id IS NULL OR p_mutation_token IS NULL
     OR p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$'
     OR p_role_was_present IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_attach_permanent_role_delivery: exact role identity is required';
  END IF;

  SELECT intent.* INTO v_observed
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_attach_permanent_role_delivery: intent is unavailable';
  END IF;

  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id FOR SHARE;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_observed.entitlement_id FOR SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-role-owner:' || v_observed.guild_id || ':'
        || v_observed.discord_id || ':' || p_role_id,
      0
    )
  );
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  PERFORM 1 FROM public.bot_action_queue AS queue
   WHERE queue.id = v_observed.action_id FOR UPDATE;

  IF v_intent.id IS NULL
     OR v_intent.action_id IS DISTINCT FROM v_observed.action_id
     OR v_intent.order_id IS DISTINCT FROM v_observed.order_id
     OR v_intent.entitlement_id IS DISTINCT FROM v_observed.entitlement_id
     OR v_intent.mutation_token IS DISTINCT FROM p_mutation_token
     OR v_intent.state IS DISTINCT FROM 'open'
     OR v_intent.delivery_confirmed_at IS NOT NULL
     OR NOT (p_role_id = ANY(v_intent.permanent_role_ids)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_attach_permanent_role_delivery: intent identity changed';
  END IF;

  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state = 'invalid' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_attach_permanent_role_delivery: contract identity is invalid';
  ELSIF v_contract_state = 'terminal' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = 'cleanup_required', updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'paid role contract terminalized before permanent-role attachment'
    );
    RETURN QUERY SELECT 'cleanup_required'::TEXT, false, false, false,
      'terminal'::TEXT;
    RETURN;
  ELSIF v_contract_state = 'claim_lost' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = 'operator_required',
           last_error = 'delivery claim was lost before permanent-role attachment',
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'delivery claim was lost before permanent-role attachment'
    );
    RETURN QUERY SELECT 'operator_required'::TEXT, false, false, false,
      'operator_held'::TEXT;
    RETURN;
  END IF;

  v_preexisting := p_role_id = ANY(v_intent.owned_role_ids);
  IF v_preexisting THEN
    RETURN QUERY SELECT 'open'::TEXT, true, true, false, 'owned_replay'::TEXT;
    RETURN;
  END IF;
  v_reserved := p_role_id = ANY(v_intent.reserved_role_ids);
  IF v_reserved THEN
    RETURN QUERY SELECT 'open'::TEXT, true, false, false,
      'reserved_replay'::TEXT;
    RETURN;
  END IF;

  IF p_role_was_present THEN
    v_owner_state := public.commerce_classify_live_role_owner(
      v_intent.guild_id,
      v_intent.discord_id,
      p_role_id,
      v_intent.id,
      NULL,
      '{}'::UUID[]
    );
    IF v_owner_state = 'pending' THEN
      RETURN QUERY SELECT 'open'::TEXT, true, false, false,
        'dependency_pending'::TEXT;
      RETURN;
    ELSIF v_owner_state = 'none' THEN
      RETURN QUERY SELECT 'open'::TEXT, true, false, false,
        'manual_baseline'::TEXT;
      RETURN;
    END IF;
  END IF;

  v_claim_new := NOT p_role_was_present;
  UPDATE public.commerce_role_delivery_intents
     SET reserved_role_ids = public.commerce_canonical_snowflake_snapshot(
           pg_catalog.array_append(reserved_role_ids, p_role_id)
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND state = 'open'
     AND mutation_token = p_mutation_token
     AND delivery_confirmed_at IS NULL
     AND NOT (p_role_id = ANY(reserved_role_ids))
     AND NOT (p_role_id = ANY(owned_role_ids));
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_attach_permanent_role_delivery: ownership CAS failed';
  END IF;

  RETURN QUERY SELECT 'open'::TEXT, true, false, v_claim_new,
    CASE WHEN v_claim_new THEN 'reserve_add'
      ELSE 'reserve_inherited' END::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_attach_permanent_role_delivery(
  UUID, UUID, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_attach_permanent_role_delivery(
  UUID, UUID, TEXT, BOOLEAN
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_confirm_permanent_role_delivery(
  p_intent_id UUID,
  p_mutation_token UUID,
  p_role_id TEXT
)
RETURNS TABLE (intent_state TEXT, promoted BOOLEAN, owns_removal BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_contract_state TEXT;
BEGIN
  IF p_intent_id IS NULL OR p_mutation_token IS NULL
     OR p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_permanent_role_delivery: exact role identity is required';
  END IF;
  SELECT intent.* INTO v_observed
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_permanent_role_delivery: intent is unavailable';
  END IF;

  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id FOR SHARE;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_observed.entitlement_id FOR SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-role-owner:' || v_observed.guild_id || ':'
        || v_observed.discord_id || ':' || p_role_id,
      0
    )
  );
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  PERFORM 1 FROM public.bot_action_queue AS queue
   WHERE queue.id = v_observed.action_id FOR UPDATE;

  IF v_intent.id IS NULL
     OR v_intent.action_id IS DISTINCT FROM v_observed.action_id
     OR v_intent.mutation_token IS DISTINCT FROM p_mutation_token
     OR v_intent.state <> 'open'
     OR v_intent.delivery_confirmed_at IS NOT NULL
     OR NOT (p_role_id = ANY(v_intent.permanent_role_ids)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_permanent_role_delivery: intent identity changed';
  END IF;

  IF p_role_id = ANY(v_intent.owned_role_ids)
     AND NOT (p_role_id = ANY(v_intent.reserved_role_ids)) THEN
    RETURN QUERY SELECT 'open'::TEXT, false, true;
    RETURN;
  END IF;
  IF NOT (p_role_id = ANY(v_intent.reserved_role_ids)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_permanent_role_delivery: reservation is unavailable';
  END IF;

  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state <> 'live' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = 'operator_required',
           last_error = 'provisional permanent role could not be promoted under a live contract',
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'provisional permanent role could not be promoted under a live contract'
    );
    RETURN QUERY SELECT 'operator_required'::TEXT, false, false;
    RETURN;
  END IF;

  UPDATE public.commerce_role_delivery_intents
     SET reserved_role_ids = pg_catalog.array_remove(reserved_role_ids, p_role_id),
         completed_role_ids = public.commerce_canonical_snowflake_snapshot(
           pg_catalog.array_append(completed_role_ids, p_role_id)
         ),
         owned_role_ids = public.commerce_canonical_snowflake_snapshot(
           pg_catalog.array_append(owned_role_ids, p_role_id)
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND mutation_token = p_mutation_token
     AND p_role_id = ANY(reserved_role_ids)
     AND NOT (p_role_id = ANY(owned_role_ids));
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_permanent_role_delivery: promotion CAS failed';
  END IF;
  RETURN QUERY SELECT 'open'::TEXT, true, true;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_confirm_permanent_role_delivery(
  UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_confirm_permanent_role_delivery(
  UUID, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_confirm_permanent_role_baseline(
  p_intent_id UUID,
  p_mutation_token UUID,
  p_role_id TEXT
)
RETURNS TABLE (intent_state TEXT, confirmed BOOLEAN, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_owner_state TEXT;
BEGIN
  IF p_intent_id IS NULL OR p_mutation_token IS NULL
     OR p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_permanent_role_baseline: exact role identity is required';
  END IF;
  SELECT intent.* INTO v_observed
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_permanent_role_baseline: intent is unavailable';
  END IF;
  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id FOR SHARE;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_observed.entitlement_id FOR SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-role-owner:' || v_observed.guild_id || ':'
        || v_observed.discord_id || ':' || p_role_id,
      0
    )
  );
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  PERFORM 1 FROM public.bot_action_queue AS queue
   WHERE queue.id = v_observed.action_id FOR UPDATE;
  IF v_intent.id IS NULL
     OR v_intent.mutation_token IS DISTINCT FROM p_mutation_token
     OR v_intent.state <> 'open'
     OR v_intent.delivery_confirmed_at IS NOT NULL
     OR NOT (p_role_id = ANY(v_intent.permanent_role_ids))
     OR p_role_id = ANY(v_intent.reserved_role_ids)
     OR p_role_id = ANY(v_intent.owned_role_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_permanent_role_baseline: intent identity changed';
  END IF;
  IF p_role_id = ANY(v_intent.completed_role_ids) THEN
    RETURN QUERY SELECT 'open'::TEXT, true, 'baseline_replay'::TEXT;
    RETURN;
  END IF;
  IF public.commerce_role_delivery_contract_state(v_intent.id) <> 'live' THEN
    RETURN QUERY SELECT 'open'::TEXT, false, 'contract_changed'::TEXT;
    RETURN;
  END IF;
  v_owner_state := public.commerce_classify_live_role_owner(
    v_intent.guild_id,
    v_intent.discord_id,
    p_role_id,
    v_intent.id,
    NULL,
    '{}'::UUID[]
  );
  IF v_owner_state <> 'none' THEN
    RETURN QUERY SELECT 'open'::TEXT, false,
      CASE WHEN v_owner_state = 'pending'
        THEN 'dependency_pending' ELSE 'owner_changed' END::TEXT;
    RETURN;
  END IF;
  UPDATE public.commerce_role_delivery_intents
     SET completed_role_ids = public.commerce_canonical_snowflake_snapshot(
           pg_catalog.array_append(completed_role_ids, p_role_id)
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND mutation_token = p_mutation_token
     AND NOT (p_role_id = ANY(completed_role_ids));
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_permanent_role_baseline: completion CAS failed';
  END IF;
  RETURN QUERY SELECT 'open'::TEXT, true, 'manual_baseline'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_confirm_permanent_role_baseline(
  UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_confirm_permanent_role_baseline(
  UUID, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_attach_temp_role_delivery(
  p_intent_id UUID,
  p_mutation_token UUID,
  p_grant_id UUID,
  p_role_id TEXT,
  p_duration_seconds INTEGER,
  p_role_was_present BOOLEAN
)
RETURNS TABLE (
  intent_state TEXT,
  may_mutate BOOLEAN,
  owns_removal BOOLEAN,
  claim_newly_acquired BOOLEAN,
  disposition TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_grant public.temp_role_grants%ROWTYPE;
  v_contract_state TEXT;
  v_owner_state TEXT;
  v_owns_removal BOOLEAN := false;
  v_ownership_preexisting BOOLEAN := false;
  v_reservation_preexisting BOOLEAN := false;
  v_claim_newly_acquired BOOLEAN := false;
BEGIN
  IF p_intent_id IS NULL OR p_mutation_token IS NULL OR p_grant_id IS NULL
     OR p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$'
     OR p_duration_seconds IS NULL OR p_duration_seconds <= 0
     OR p_duration_seconds > 315360000 OR p_role_was_present IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_attach_temp_role_delivery: exact grant identity is required';
  END IF;

  SELECT intent.* INTO v_observed
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_attach_temp_role_delivery: intent is unavailable';
  END IF;

  -- Canonical blocking order includes the exact temp grant before entitlement.
  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id FOR SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-role-owner:' || v_observed.guild_id || ':'
        || v_observed.discord_id || ':' || p_role_id,
      0
    )
  );
  SELECT grant_row.* INTO v_grant
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = p_grant_id
   FOR UPDATE;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_observed.entitlement_id FOR SHARE;
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  PERFORM 1 FROM public.bot_action_queue AS queue
   WHERE queue.id = v_observed.action_id FOR UPDATE;

  IF v_intent.id IS NULL
     OR v_intent.mutation_token IS DISTINCT FROM p_mutation_token
     OR v_intent.state IS DISTINCT FROM 'open'
     OR v_intent.delivery_confirmed_at IS NOT NULL
     OR v_grant.id IS NULL
     OR v_grant.order_id IS DISTINCT FROM v_intent.order_id
     OR v_grant.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_grant.user_id IS DISTINCT FROM v_intent.discord_id
     OR v_grant.role_id IS DISTINCT FROM p_role_id
     OR v_grant.source IS DISTINCT FROM 'commerce_purchase'
     OR v_grant.source_id IS DISTINCT FROM v_intent.product_id::TEXT
     OR v_grant.duration_seconds IS DISTINCT FROM p_duration_seconds
     OR v_grant.grant_status NOT IN ('pending', 'applied')
     OR (
       v_grant.grant_status = 'pending' AND v_grant.applied_at IS NOT NULL
     )
     OR (
       v_grant.grant_status = 'applied'
       AND (
         v_grant.applied_at IS NULL
         OR v_grant.expires_at IS DISTINCT FROM v_grant.applied_at
           + (v_grant.duration_seconds * interval '1 second')
       )
     )
     OR NOT EXISTS (
       SELECT 1
         FROM public.orders AS paid_order,
              LATERAL pg_catalog.jsonb_array_elements(
                paid_order.temporary_role_grants_snapshot
              ) AS frozen_grant(value)
        WHERE paid_order.id = v_intent.order_id
          AND public.commerce_valid_temp_role_snapshot(
            paid_order.temporary_role_grants_snapshot
          )
          AND frozen_grant.value ->> 'role_id' = p_role_id
          AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
            = p_duration_seconds
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_attach_temp_role_delivery: grant identity mismatch';
  END IF;

  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state = 'invalid' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_attach_temp_role_delivery: contract identity is invalid';
  ELSIF v_contract_state = 'terminal' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = 'cleanup_required',
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'paid role contract terminalized before temporary-role attachment'
    );
    RETURN QUERY SELECT 'cleanup_required'::TEXT, false, false, false,
      'terminal'::TEXT;
    RETURN;
  ELSIF v_contract_state = 'claim_lost' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = 'operator_required',
           last_error = 'delivery claim was lost before temporary-role mutation',
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'delivery claim was lost before temporary-role mutation'
    );
    RETURN QUERY SELECT 'operator_required'::TEXT, false, false, false,
      'operator_held'::TEXT;
    RETURN;
  END IF;

  IF v_grant.grant_status = 'applied'
     AND v_grant.remove_on_expiry = false THEN
    IF p_role_was_present THEN
      RETURN QUERY SELECT 'open'::TEXT, true, false, false,
        'manual_baseline'::TEXT;
      RETURN;
    END IF;
    UPDATE public.commerce_role_delivery_intents
       SET state = 'operator_required',
           last_error = 'applied unowned temporary role is absent and cannot be promoted safely',
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
       AND mutation_token = p_mutation_token
     RETURNING * INTO v_intent;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'applied unowned temporary role is absent and cannot be promoted safely'
    );
    RETURN QUERY SELECT 'operator_required'::TEXT, false, false, false,
      'operator_held'::TEXT;
    RETURN;
  END IF;

  -- A present role inherits removal authority only from a confirmed/open exact
  -- delivery intent. Unresolved lineage is a retry cell; no lineage is a manual
  -- baseline. This avoids both orphaned shared roles and chain-deleting a role
  -- that was manual all along.
  v_ownership_preexisting := (
    p_grant_id = ANY(v_intent.temporary_role_grant_ids)
    AND v_grant.remove_on_expiry
  );
  IF v_ownership_preexisting THEN
    RETURN QUERY SELECT 'open'::TEXT, true, true, false,
      'owned_replay'::TEXT;
    RETURN;
  END IF;
  v_reservation_preexisting := p_grant_id = ANY(
    v_intent.reserved_temp_role_grant_ids
  );
  IF v_reservation_preexisting THEN
    RETURN QUERY SELECT 'open'::TEXT, true, false, false,
      'reserved_replay'::TEXT;
    RETURN;
  END IF;

  IF p_role_was_present THEN
    v_owner_state := public.commerce_classify_live_role_owner(
      v_intent.guild_id,
      v_intent.discord_id,
      p_role_id,
      v_intent.id,
      NULL,
      '{}'::UUID[]
    );
    IF v_owner_state = 'pending' THEN
      RETURN QUERY SELECT 'open'::TEXT, true, false, false,
        'dependency_pending'::TEXT;
      RETURN;
    ELSIF v_owner_state = 'none' THEN
      RETURN QUERY SELECT 'open'::TEXT, true, false, false,
        'manual_baseline'::TEXT;
      RETURN;
    END IF;
  END IF;

  v_claim_newly_acquired := NOT p_role_was_present;
  IF v_grant.remove_on_expiry THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_attach_temp_role_delivery: provisional grant already owns removal';
  END IF;
  UPDATE public.commerce_role_delivery_intents
     SET reserved_temp_role_grant_ids = pg_catalog.array_append(
           reserved_temp_role_grant_ids, p_grant_id
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND state = 'open'
     AND mutation_token = p_mutation_token
     AND NOT (p_grant_id = ANY(reserved_temp_role_grant_ids))
     AND NOT (p_grant_id = ANY(temporary_role_grant_ids));
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_attach_temp_role_delivery: reservation CAS failed';
  END IF;

  -- may_mutate describes contract liveness, not ownership. A manual baseline
  -- (owns_removal=false) is a successful no-op cell, not a retry condition.
  RETURN QUERY SELECT
    'open'::TEXT,
    true,
    false,
    v_claim_newly_acquired,
    CASE WHEN v_claim_newly_acquired THEN 'reserve_add'
      ELSE 'reserve_inherited' END::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_attach_temp_role_delivery(
  UUID, UUID, UUID, TEXT, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_attach_temp_role_delivery(
  UUID, UUID, UUID, TEXT, INTEGER, BOOLEAN
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_confirm_temp_role_delivery(
  p_intent_id UUID,
  p_mutation_token UUID,
  p_grant_id UUID,
  p_role_id TEXT
)
RETURNS TABLE (
  intent_state TEXT,
  promoted BOOLEAN,
  owns_removal BOOLEAN,
  grant_status TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_observed public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_grant public.temp_role_grants%ROWTYPE;
  v_contract_state TEXT;
  v_applied_at TIMESTAMPTZ;
  v_grant_promoted BOOLEAN := false;
BEGIN
  IF p_intent_id IS NULL OR p_mutation_token IS NULL OR p_grant_id IS NULL
     OR p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_temp_role_delivery: exact grant identity is required';
  END IF;
  SELECT intent.* INTO v_observed
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_temp_role_delivery: intent is unavailable';
  END IF;

  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id FOR SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-role-owner:' || v_observed.guild_id || ':'
        || v_observed.discord_id || ':' || p_role_id,
      0
    )
  );
  SELECT grant_row.* INTO v_grant
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = p_grant_id
   FOR UPDATE;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_observed.entitlement_id FOR SHARE;
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  PERFORM 1 FROM public.bot_action_queue AS queue
   WHERE queue.id = v_observed.action_id FOR UPDATE;

  IF v_intent.id IS NULL
     OR v_intent.action_id IS DISTINCT FROM v_observed.action_id
     OR v_intent.mutation_token IS DISTINCT FROM p_mutation_token
     OR v_intent.state <> 'open'
     OR v_intent.delivery_confirmed_at IS NOT NULL
     OR v_grant.id IS NULL
     OR v_grant.order_id IS DISTINCT FROM v_intent.order_id
     OR v_grant.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_grant.user_id IS DISTINCT FROM v_intent.discord_id
     OR v_grant.role_id IS DISTINCT FROM p_role_id
     OR v_grant.source IS DISTINCT FROM 'commerce_purchase'
     OR v_grant.source_id IS DISTINCT FROM v_intent.product_id::TEXT THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_temp_role_delivery: durable identity changed';
  END IF;

  IF p_grant_id = ANY(v_intent.temporary_role_grant_ids)
     AND NOT (p_grant_id = ANY(v_intent.reserved_temp_role_grant_ids))
     AND v_grant.grant_status = 'applied'
     AND v_grant.remove_on_expiry = true THEN
    RETURN QUERY SELECT 'open'::TEXT, false, true,
      v_grant.grant_status, v_grant.expires_at;
    RETURN;
  END IF;
  IF NOT (p_grant_id = ANY(v_intent.reserved_temp_role_grant_ids))
     OR v_grant.remove_on_expiry
     OR v_grant.grant_status <> 'pending'
     OR v_grant.applied_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_temp_role_delivery: reservation is unavailable';
  END IF;

  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state <> 'live' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = 'operator_required',
           last_error = 'provisional temporary role could not be promoted under a live contract',
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'provisional temporary role could not be promoted under a live contract'
    );
    RETURN QUERY SELECT 'operator_required'::TEXT, false, false,
      v_grant.grant_status, v_grant.expires_at;
    RETURN;
  END IF;

  v_applied_at := pg_catalog.clock_timestamp();
  PERFORM pg_catalog.set_config(
    'somnibot.commerce_temp_confirmation_grant_id', p_grant_id::TEXT, true
  );
  PERFORM pg_catalog.set_config(
    'somnibot.commerce_temp_confirmation_intent_id', p_intent_id::TEXT, true
  );
  PERFORM pg_catalog.set_config(
    'somnibot.commerce_temp_confirmation_mutation_token',
    p_mutation_token::TEXT,
    true
  );
  UPDATE public.temp_role_grants
     SET grant_status = 'applied',
         applied_at = v_applied_at,
         expires_at = v_applied_at + (duration_seconds * interval '1 second'),
         remove_on_expiry = true,
         last_error = NULL,
         updated_at = v_applied_at
   WHERE id = p_grant_id
     AND grant_status = 'pending'
     AND applied_at IS NULL
     AND remove_on_expiry = false
   RETURNING * INTO v_grant;
  v_grant_promoted := FOUND;
  PERFORM pg_catalog.set_config(
    'somnibot.commerce_temp_confirmation_grant_id', '', true
  );
  PERFORM pg_catalog.set_config(
    'somnibot.commerce_temp_confirmation_intent_id', '', true
  );
  PERFORM pg_catalog.set_config(
    'somnibot.commerce_temp_confirmation_mutation_token', '', true
  );
  IF NOT v_grant_promoted THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_temp_role_delivery: grant promotion CAS failed';
  END IF;

  UPDATE public.commerce_role_delivery_intents
     SET reserved_temp_role_grant_ids = pg_catalog.array_remove(
           reserved_temp_role_grant_ids, p_grant_id
         ),
         temporary_role_grant_ids = pg_catalog.array_append(
           temporary_role_grant_ids, p_grant_id
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND mutation_token = p_mutation_token
     AND p_grant_id = ANY(reserved_temp_role_grant_ids)
     AND NOT (p_grant_id = ANY(temporary_role_grant_ids));
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_confirm_temp_role_delivery: intent promotion CAS failed';
  END IF;
  RETURN QUERY SELECT 'open'::TEXT, true, true,
    v_grant.grant_status, v_grant.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_confirm_temp_role_delivery(
  UUID, UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_confirm_temp_role_delivery(
  UUID, UUID, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_release_unconsumed_temp_role_claim(
  p_intent_id UUID,
  p_mutation_token UUID,
  p_grant_id UUID,
  p_role_id TEXT
)
RETURNS TABLE (
  intent_state TEXT,
  released BOOLEAN,
  cleanup_needed BOOLEAN,
  settled BOOLEAN,
  may_mutate BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_grant public.temp_role_grants%ROWTYPE;
  v_contract_state TEXT;
BEGIN
  IF p_intent_id IS NULL OR p_mutation_token IS NULL OR p_grant_id IS NULL
     OR p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_release_unconsumed_temp_role_claim: exact claim identity is required';
  END IF;

  SELECT intent.* INTO v_observed
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_release_unconsumed_temp_role_claim: intent is unavailable';
  END IF;

  -- Preserve the global order -> customer -> temp grant -> entitlement ->
  -- delivery intent -> action order. Like permanent release, this
  -- authority-reducing compensation remains valid after terminalization but
  -- not after delivery confirmation or cleanup-controller acquisition.
  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id FOR SHARE;
  SELECT grant_row.* INTO v_grant
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = p_grant_id
   FOR UPDATE;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_observed.entitlement_id FOR SHARE;
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  PERFORM 1 FROM public.bot_action_queue AS queue
   WHERE queue.id = v_observed.action_id FOR UPDATE;

  IF v_intent.id IS NULL
     OR v_intent.action_id IS DISTINCT FROM v_observed.action_id
     OR v_intent.order_id IS DISTINCT FROM v_observed.order_id
     OR v_intent.entitlement_id IS DISTINCT FROM v_observed.entitlement_id
     OR v_intent.mutation_token IS DISTINCT FROM p_mutation_token
     OR v_intent.delivery_confirmed_at IS NOT NULL
     OR v_intent.state = 'settled'
     OR v_intent.cleanup_action_id IS NOT NULL
     OR v_intent.cleanup_claim_token IS NOT NULL
     OR v_grant.id IS NULL
     OR v_grant.order_id IS DISTINCT FROM v_intent.order_id
     OR v_grant.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_grant.user_id IS DISTINCT FROM v_intent.discord_id
     OR v_grant.role_id IS DISTINCT FROM p_role_id
     OR v_grant.source IS DISTINCT FROM 'commerce_purchase'
     OR v_grant.source_id IS DISTINCT FROM v_intent.product_id::TEXT
     OR v_grant.grant_status NOT IN ('pending', 'applied')
     OR v_grant.remove_on_expiry
     OR NOT (p_grant_id = ANY(v_intent.reserved_temp_role_grant_ids)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_release_unconsumed_temp_role_claim: claim is no longer releasable';
  END IF;

  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state = 'invalid' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_release_unconsumed_temp_role_claim: contract identity is invalid';
  ELSIF v_contract_state = 'terminal' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = CASE WHEN state = 'operator_required'
             THEN 'operator_required' ELSE 'cleanup_required' END,
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
     RETURNING * INTO v_intent;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'paid role contract terminalized before an unconsumed temporary-role claim was released'
    );
  ELSIF v_contract_state = 'claim_lost' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = 'operator_required',
           last_error = 'delivery claim was lost before an unconsumed temporary-role claim was released',
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
     RETURNING * INTO v_intent;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'delivery claim was lost before an unconsumed temporary-role claim was released'
    );
  END IF;

  UPDATE public.commerce_role_delivery_intents
     SET reserved_temp_role_grant_ids = pg_catalog.array_remove(
           reserved_temp_role_grant_ids, p_grant_id
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = p_intent_id
     AND mutation_token = p_mutation_token
     AND delivery_confirmed_at IS NULL
     AND state <> 'settled'
     AND cleanup_action_id IS NULL
     AND cleanup_claim_token IS NULL
     AND p_grant_id = ANY(reserved_temp_role_grant_ids)
  RETURNING * INTO v_intent;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_release_unconsumed_temp_role_claim: intent release CAS failed';
  END IF;

  RETURN QUERY SELECT
    v_intent.state,
    true,
    v_intent.state <> 'open',
    false,
    v_intent.state = 'open';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_release_unconsumed_temp_role_claim(
  UUID, UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_release_unconsumed_temp_role_claim(
  UUID, UUID, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_finish_role_delivery_attempt(
  p_intent_id UUID,
  p_mutation_token UUID,
  p_outcome TEXT,
  p_error TEXT DEFAULT NULL
)
RETURNS TABLE (
  intent_state TEXT,
  settled BOOLEAN,
  authority_empty BOOLEAN,
  disposition TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_contract_state TEXT;
  v_authority_empty BOOLEAN;
BEGIN
  IF p_intent_id IS NULL OR p_mutation_token IS NULL
     OR p_outcome NOT IN ('live', 'compensated', 'retry') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_attempt: exact outcome identity is required';
  END IF;

  SELECT intent.* INTO v_observed
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_attempt: intent is unavailable';
  END IF;

  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id FOR SHARE;
  PERFORM 1
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = ANY(
     v_observed.reserved_temp_role_grant_ids
       || v_observed.temporary_role_grant_ids
   )
   ORDER BY grant_row.id
   FOR UPDATE;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_observed.entitlement_id FOR SHARE;
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  PERFORM 1 FROM public.bot_action_queue AS queue
   WHERE queue.id = v_observed.action_id FOR UPDATE;

  IF v_intent.id IS NULL
     OR v_intent.action_id IS DISTINCT FROM v_observed.action_id
     OR v_intent.order_id IS DISTINCT FROM v_observed.order_id
     OR v_intent.entitlement_id IS DISTINCT FROM v_observed.entitlement_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_attempt: durable identity changed';
  END IF;

  -- A committed response may be lost. The last exact token/outcome pair makes
  -- every accepted finalization replay-safe without reopening authority.
  IF v_intent.mutation_token IS DISTINCT FROM p_mutation_token THEN
    IF v_intent.mutation_token IS NULL
       AND v_intent.last_delivery_mutation_token = p_mutation_token
       AND (
         v_intent.last_delivery_outcome = p_outcome
         OR (p_outcome = 'retry' AND v_intent.last_delivery_outcome = 'live')
       ) THEN
      RETURN QUERY SELECT
        v_intent.state,
        v_intent.state = 'settled',
        pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
          AND pg_catalog.cardinality(v_intent.owned_role_ids) = 0
          AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0
          AND pg_catalog.cardinality(v_intent.temporary_role_grant_ids) = 0,
        CASE
          WHEN v_intent.state = 'settled' THEN 'settled'
          WHEN v_intent.last_delivery_outcome = 'live'
            THEN 'confirmed_open'
          WHEN v_intent.last_delivery_outcome = 'retry'
            AND v_intent.state = 'open'
            AND pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
            AND pg_catalog.cardinality(v_intent.owned_role_ids) = 0
            AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0
            AND pg_catalog.cardinality(v_intent.temporary_role_grant_ids) = 0
            THEN 'safe_retry'
          WHEN v_intent.last_delivery_outcome = 'retry'
            AND v_intent.state = 'open'
            AND v_intent.delivery_confirmed_at IS NULL
            AND pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
            AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0
            AND (
              pg_catalog.cardinality(v_intent.owned_role_ids) > 0
              OR pg_catalog.cardinality(v_intent.temporary_role_grant_ids) > 0
            )
            AND public.commerce_role_delivery_contract_state(v_intent.id) = 'live'
            THEN 'safe_retry_owned'
          WHEN v_intent.last_delivery_outcome = 'retry'
            AND (
              pg_catalog.cardinality(v_intent.owned_role_ids) > 0
              OR pg_catalog.cardinality(v_intent.temporary_role_grant_ids) > 0
            ) THEN 'run_origin_cleanup'
          ELSE 'operator_held'
        END;
      RETURN;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_attempt: mutation token is stale';
  END IF;

  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state = 'invalid' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_attempt: contract identity is invalid';
  END IF;
  v_authority_empty := pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
    AND pg_catalog.cardinality(v_intent.owned_role_ids) = 0
    AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0
    AND pg_catalog.cardinality(v_intent.temporary_role_grant_ids) = 0;

  IF p_outcome = 'live' THEN
    IF v_contract_state <> 'live'
       OR v_intent.state <> 'open'
       OR v_intent.delivery_confirmed_at IS NOT NULL
       OR v_intent.cleanup_action_id IS NOT NULL
       OR v_intent.cleanup_mutation_token IS NOT NULL
       OR pg_catalog.cardinality(v_intent.reserved_role_ids) > 0
       OR pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finish_role_delivery_attempt: live confirmation is not permitted';
    END IF;

    IF v_intent.completed_role_ids IS DISTINCT FROM v_intent.permanent_role_ids THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finish_role_delivery_attempt: permanent-role completion is incomplete';
    END IF;

    -- Every frozen temporary grant must have one exact applied provenance row,
    -- including manual-baseline deliveries that deliberately own no removal.
    -- Checking only the intent-owned subset would allow a partial action to be
    -- marked live after permanent roles succeeded but temp preparation failed.
    IF EXISTS (
      SELECT 1
        FROM public.orders AS paid_order,
             LATERAL pg_catalog.jsonb_array_elements(
               paid_order.temporary_role_grants_snapshot
             ) AS frozen_grant(value)
       WHERE paid_order.id = v_intent.order_id
         AND NOT EXISTS (
           SELECT 1
             FROM public.temp_role_grants AS grant_row
            WHERE grant_row.order_id = paid_order.id
              AND grant_row.guild_id = v_intent.guild_id
              AND grant_row.user_id = v_intent.discord_id
              AND grant_row.role_id = frozen_grant.value ->> 'role_id'
              AND grant_row.source = 'commerce_purchase'
              AND grant_row.source_id = v_intent.product_id::TEXT
              AND grant_row.duration_seconds =
                (frozen_grant.value ->> 'duration_seconds')::INTEGER
              AND grant_row.grant_status = 'applied'
              AND grant_row.applied_at IS NOT NULL
              AND grant_row.expires_at IS NOT DISTINCT FROM grant_row.applied_at
                + (grant_row.duration_seconds * interval '1 second')
         )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finish_role_delivery_attempt: temporary-role completion is incomplete';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.unnest(v_intent.temporary_role_grant_ids) AS owned(grant_id)
        LEFT JOIN public.temp_role_grants AS grant_row
          ON grant_row.id = owned.grant_id
         AND grant_row.order_id = v_intent.order_id
         AND grant_row.guild_id = v_intent.guild_id
         AND grant_row.user_id = v_intent.discord_id
         AND grant_row.source = 'commerce_purchase'
         AND grant_row.source_id = v_intent.product_id::TEXT
         AND grant_row.grant_status = 'applied'
         AND grant_row.remove_on_expiry = true
         AND grant_row.applied_at IS NOT NULL
         AND grant_row.duration_seconds IS NOT NULL
         AND grant_row.expires_at IS NOT DISTINCT FROM grant_row.applied_at
           + (grant_row.duration_seconds * interval '1 second')
       WHERE grant_row.id IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finish_role_delivery_attempt: temporary-role acknowledgement is incomplete';
    END IF;

    UPDATE public.commerce_role_delivery_intents
       SET state = CASE WHEN v_authority_empty THEN 'settled' ELSE 'open' END,
           mutation_token = NULL,
           mutation_started_at = NULL,
           last_delivery_mutation_token = p_mutation_token,
           last_delivery_outcome = 'live',
           delivery_confirmed_at = pg_catalog.clock_timestamp(),
           settled_at = CASE WHEN v_authority_empty
             THEN pg_catalog.clock_timestamp() ELSE NULL END,
           last_error = NULL,
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
       AND state = 'open'
       AND mutation_token = p_mutation_token
       AND delivery_confirmed_at IS NULL
     RETURNING * INTO v_intent;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finish_role_delivery_attempt: live confirmation CAS failed';
    END IF;
    IF v_intent.state = 'settled' THEN
      PERFORM public.commerce_resolve_role_delivery_alert(v_intent.id);
    END IF;
    IF v_intent.contract_kind = 'noncommerce' THEN
      PERFORM public.commerce_wake_noncommerce_relink_cleanups(
        v_intent.entitlement_id
      );
    END IF;
    RETURN QUERY SELECT
      v_intent.state,
      v_intent.state = 'settled',
      v_authority_empty,
      CASE WHEN v_intent.state = 'settled'
        THEN 'settled' ELSE 'confirmed_open' END;
    RETURN;
  END IF;

  IF p_outcome = 'retry' THEN
    IF pg_catalog.cardinality(v_intent.reserved_role_ids) > 0
       OR pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) > 0 THEN
      UPDATE public.commerce_role_delivery_intents
         SET state = 'operator_required',
             mutation_token = NULL,
             mutation_started_at = NULL,
             last_delivery_mutation_token = p_mutation_token,
             last_delivery_outcome = 'retry',
             last_error = pg_catalog.left(COALESCE(
               p_error,
               'provisional Discord role outcome is ambiguous; preserve without removal'
             ), 4000),
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
         AND mutation_token = p_mutation_token
       RETURNING * INTO v_intent;
      PERFORM public.commerce_signal_role_delivery_intent(
        v_intent.id,
        COALESCE(
          p_error,
          'provisional Discord role outcome is ambiguous; preserve without removal'
        )
      );
      RETURN QUERY SELECT v_intent.state, false, false,
        'operator_held'::TEXT;
      RETURN;
    END IF;

    IF pg_catalog.cardinality(v_intent.owned_role_ids) > 0
       OR pg_catalog.cardinality(v_intent.temporary_role_grant_ids) > 0 THEN
      IF v_contract_state = 'live' AND v_intent.state = 'open' THEN
        UPDATE public.commerce_role_delivery_intents
           SET mutation_token = NULL,
               mutation_started_at = NULL,
               last_delivery_mutation_token = p_mutation_token,
               last_delivery_outcome = 'retry',
               last_error = pg_catalog.left(p_error, 4000),
               updated_at = pg_catalog.clock_timestamp()
         WHERE id = v_intent.id
           AND mutation_token = p_mutation_token
           AND delivery_confirmed_at IS NULL
         RETURNING * INTO v_intent;
        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'commerce_finish_role_delivery_attempt: owned retry CAS failed';
        END IF;
        RETURN QUERY SELECT v_intent.state, false, false,
          'safe_retry_owned'::TEXT;
        RETURN;
      END IF;
      UPDATE public.commerce_role_delivery_intents
         SET state = 'operator_required',
             mutation_token = NULL,
             mutation_started_at = NULL,
             last_delivery_mutation_token = p_mutation_token,
             last_delivery_outcome = 'retry',
             last_error = pg_catalog.left(COALESCE(
               p_error,
               'delivery outcome is ambiguous while exact Discord role authority remains'
             ), 4000),
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
         AND mutation_token = p_mutation_token
       RETURNING * INTO v_intent;
      PERFORM public.commerce_signal_role_delivery_intent(
        v_intent.id,
        COALESCE(
          p_error,
          'delivery outcome is ambiguous while exact Discord role authority remains'
        )
      );
      RETURN QUERY SELECT v_intent.state, false, false, 'run_origin_cleanup'::TEXT;
      RETURN;
    END IF;

    IF v_contract_state = 'live' AND v_intent.state = 'open' THEN
      UPDATE public.commerce_role_delivery_intents
         SET mutation_token = NULL,
             mutation_started_at = NULL,
             last_delivery_mutation_token = p_mutation_token,
             last_delivery_outcome = 'retry',
             last_error = pg_catalog.left(p_error, 4000),
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
         AND mutation_token = p_mutation_token
       RETURNING * INTO v_intent;
      RETURN QUERY SELECT v_intent.state, false, true, 'safe_retry'::TEXT;
      RETURN;
    ELSIF v_contract_state = 'terminal' THEN
      UPDATE public.commerce_role_delivery_intents
         SET state = 'settled',
             mutation_token = NULL,
             mutation_started_at = NULL,
             last_delivery_mutation_token = p_mutation_token,
             last_delivery_outcome = 'retry',
             settled_at = pg_catalog.clock_timestamp(),
             last_error = pg_catalog.left(p_error, 4000),
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
         AND mutation_token = p_mutation_token
         AND cleanup_mutation_token IS NULL
       RETURNING * INTO v_intent;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce_finish_role_delivery_attempt: terminal retry CAS failed';
      END IF;
      PERFORM public.commerce_resolve_role_delivery_alert(v_intent.id);
      RETURN QUERY SELECT v_intent.state, true, true, 'settled'::TEXT;
      RETURN;
    END IF;

    UPDATE public.commerce_role_delivery_intents
       SET state = 'operator_required',
           mutation_token = NULL,
           mutation_started_at = NULL,
           last_delivery_mutation_token = p_mutation_token,
           last_delivery_outcome = 'retry',
           last_error = pg_catalog.left(COALESCE(
             p_error, 'delivery claim was lost before a safe retry'
           ), 4000),
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
       AND mutation_token = p_mutation_token
     RETURNING * INTO v_intent;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      COALESCE(p_error, 'delivery claim was lost before a safe retry')
    );
    RETURN QUERY SELECT v_intent.state, false, true, 'operator_held'::TEXT;
    RETURN;
  END IF;

  -- `compensated` is the terminal delivery-controller release. Exact cleanup
  -- must already have emptied every authority vector and completed its own
  -- mutation before this token can settle the tombstone.
  IF v_contract_state <> 'terminal'
     OR pg_catalog.cardinality(v_intent.reserved_role_ids) <> 0
     OR pg_catalog.cardinality(v_intent.owned_role_ids) <> 0
     OR pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) <> 0
     OR pg_catalog.cardinality(v_intent.temporary_role_grant_ids) <> 0
     OR v_intent.cleanup_mutation_token IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_attempt: terminal compensation is incomplete';
  END IF;

  UPDATE public.commerce_role_delivery_intents
     SET state = 'settled',
         mutation_token = NULL,
         mutation_started_at = NULL,
         last_delivery_mutation_token = p_mutation_token,
         last_delivery_outcome = 'compensated',
         settled_at = pg_catalog.clock_timestamp(),
         last_error = NULL,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND mutation_token = p_mutation_token
   RETURNING * INTO v_intent;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_attempt: compensation CAS failed';
  END IF;
  PERFORM public.commerce_resolve_role_delivery_alert(v_intent.id);
  RETURN QUERY SELECT v_intent.state, true, true, 'settled'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_finish_role_delivery_attempt(
  UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_finish_role_delivery_attempt(
  UUID, UUID, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_ensure_live_role_delivery_action(
  p_entitlement_id UUID
)
RETURNS TABLE (action_id UUID, action_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed public.entitlements%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_latest_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_action_id UUID;
  v_roles TEXT[];
  v_payload JSONB;
  v_key TEXT;
  v_paid_origin BOOLEAN := false;
  v_payment_terminal BOOLEAN := false;
  v_snapshot_valid BOOLEAN := false;
BEGIN
  IF p_entitlement_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_ensure_live_role_delivery_action: entitlement is required';
  END IF;

  -- One entitlement generation may be planned at a time. This lock also
  -- closes the gap where an older ensure carrier is still pending while a
  -- different action creates and settles a newer intent generation.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-role-delivery-ensure:' || p_entitlement_id::TEXT,
      0
    )
  );

  SELECT entitlement.* INTO v_observed
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT paid_order.* INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Financial evidence is locked after its parent and before identity/access.
  SELECT EXISTS (
    SELECT 1
      FROM public.payments AS payment
     WHERE payment.order_id = v_order.id
       AND payment.customer_id = v_order.customer_id
       AND payment.guild_id = v_order.guild_id
       AND payment.amount_cents = v_order.amount_cents
       AND payment.currency IS NOT NULL
       AND payment.currency = pg_catalog.btrim(payment.currency)
       AND pg_catalog.upper(payment.currency) ~ '^[A-Z]{3}$'
       AND pg_catalog.upper(payment.currency) = v_order.currency
       AND payment.provider = 'paypal'
       AND payment.paypal_resource_type IS NOT DISTINCT FROM CASE
         WHEN v_observed.type = 'subscription' THEN 'sale' ELSE 'capture' END
       AND payment.status IN ('refunded', 'reversed')
       AND payment.paypal_payment_id
         ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
  ) INTO v_payment_terminal;

  IF v_order.source = 'purchase' THEN
    v_paid_origin := true;
  ELSIF v_order.source IS NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.payments AS payment
       WHERE payment.order_id = v_order.id
         AND payment.customer_id = v_order.customer_id
         AND payment.guild_id = v_order.guild_id
         AND payment.amount_cents = v_order.amount_cents
         AND payment.currency IS NOT NULL
         AND payment.currency = pg_catalog.btrim(payment.currency)
         AND pg_catalog.upper(payment.currency) ~ '^[A-Z]{3}$'
         AND pg_catalog.upper(payment.currency) = v_order.currency
         AND payment.provider = 'paypal'
         AND payment.paypal_resource_type IS NOT DISTINCT FROM CASE
           WHEN v_observed.type = 'subscription' THEN 'sale' ELSE 'capture' END
         AND payment.status = 'completed'
         AND payment.paypal_payment_id
           ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
    ) INTO v_paid_origin;
  END IF;

  SELECT customer.* INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id
   FOR SHARE;
  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
   FOR SHARE;
  IF v_customer.id IS NULL OR v_entitlement.id IS NULL THEN
    RETURN;
  END IF;

  v_roles := public.commerce_canonical_snowflake_snapshot(
    v_entitlement.granted_role_ids
  );
  IF v_entitlement.guild_id IS DISTINCT FROM v_order.guild_id
     OR v_entitlement.customer_id IS DISTINCT FROM v_order.customer_id
     OR v_entitlement.product_id IS DISTINCT FROM v_order.product_id
     OR v_entitlement.plan_id IS DISTINCT FROM v_order.plan_id
     OR v_entitlement.type NOT IN ('one_time', 'subscription')
     OR v_entitlement.status NOT IN ('active', 'pending', 'grace_period', 'suspended')
     OR NOT COALESCE(
       v_entitlement.source = 'purchase' OR v_entitlement.source IS NULL,
       false
     )
     OR v_order.status IS DISTINCT FROM 'completed'
     OR v_order.amount_cents <= 0
     OR v_order.currency !~ '^[A-Z]{3}$'
     OR v_customer.guild_id IS DISTINCT FROM v_order.guild_id
     OR v_customer.discord_id IS NULL
     OR pg_catalog.btrim(v_customer.discord_id) = ''
     OR NOT v_paid_origin
     OR v_payment_terminal THEN
    RETURN;
  END IF;

  IF v_entitlement.type = 'one_time' THEN
    v_snapshot_valid := v_order.plan_id IS NULL
      AND v_order.paypal_subscription_id IS NULL
      AND v_order.grant_snapshot_frozen_at IS NOT NULL
      AND public.commerce_valid_snowflake_snapshot(v_order.granted_role_ids_snapshot)
      AND public.commerce_canonical_snowflake_snapshot(
        v_order.granted_role_ids_snapshot
      ) IS NOT DISTINCT FROM v_roles;
  ELSE
    v_snapshot_valid := v_order.plan_id IS NOT NULL
      AND v_order.paypal_subscription_id
        ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
      AND (
        (
          v_order.grant_snapshot_frozen_at IS NOT NULL
          AND public.commerce_valid_snowflake_snapshot(
            v_order.granted_role_ids_snapshot
          )
          AND public.commerce_canonical_snowflake_snapshot(
            v_order.granted_role_ids_snapshot
          ) IS NOT DISTINCT FROM v_roles
        )
        OR (
          v_order.grant_snapshot_frozen_at IS NULL
          AND EXISTS (
            SELECT 1
              FROM public.commerce_legacy_subscription_grant_contracts AS legacy
             WHERE legacy.order_id = v_order.id
               AND legacy.guild_id = v_order.guild_id
               AND legacy.customer_id = v_order.customer_id
               AND legacy.discord_id = v_customer.discord_id
               AND legacy.product_id = v_order.product_id
               AND legacy.plan_id = v_order.plan_id
               AND public.commerce_canonical_snowflake_snapshot(
                 legacy.granted_role_ids_snapshot
               ) IS NOT DISTINCT FROM v_roles
          )
        )
      );
  END IF;
  IF NOT COALESCE(v_snapshot_valid, false) THEN
    RETURN;
  END IF;

  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.action = 'reconcile_entitlement_roles'
     AND queue.lane = 'commerce'
     AND queue.status IN ('staged', 'pending', 'processing')
     AND pg_catalog.jsonb_typeof(queue.payload) = 'object'
     AND queue.payload ->> 'mode' = 'ensure_live'
     AND queue.payload ->> 'entitlement_id' = v_entitlement.id::TEXT
   ORDER BY queue.created_at, queue.id
   LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    v_payload := pg_catalog.jsonb_build_object(
      'mode', 'ensure_live',
      'action_id', v_action.id,
      'guild_id', v_entitlement.guild_id,
      'entitlement_id', v_entitlement.id,
      'customer_id', v_entitlement.customer_id,
      'discord_id', v_customer.discord_id,
      'order_id', v_entitlement.order_id,
      'product_id', v_entitlement.product_id,
      'plan_id', v_entitlement.plan_id,
      'entitlement_type', v_entitlement.type,
      'source', v_entitlement.source,
      'entitlement_status', v_entitlement.status,
      'granted_role_ids', pg_catalog.to_jsonb(v_roles)
    );
    IF v_action.guild_id IS DISTINCT FROM v_entitlement.guild_id
       OR v_action.payload IS DISTINCT FROM v_payload
       OR v_action.idempotency_key IS NULL
       OR v_action.idempotency_key NOT LIKE
         'commerce-role-delivery-ensure:' || v_entitlement.id::TEXT || ':%' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce active ensure-live carrier identity is cross-linked';
    END IF;
    IF v_action.status = 'staged' THEN
      UPDATE public.bot_action_queue AS queue
         SET status = 'pending',
             started_at = NULL,
             completed_at = NULL,
             error_message = NULL,
             next_retry_at = NULL
       WHERE queue.id = v_action.id
         AND queue.status = 'staged'
       RETURNING queue.* INTO v_action;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001',
          MESSAGE = 'commerce active ensure-live carrier promotion raced';
      END IF;
    END IF;
    RETURN QUERY SELECT v_action.id, v_action.status;
    RETURN;
  END IF;

  SELECT intent.* INTO v_latest_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.entitlement_id = v_entitlement.id
   ORDER BY intent.created_at DESC, intent.id DESC
   LIMIT 1
   FOR UPDATE;
  IF FOUND AND v_latest_intent.state <> 'settled' THEN
    IF NOT (
      v_latest_intent.state = 'open'
      AND v_latest_intent.delivery_confirmed_at IS NOT NULL
      AND v_latest_intent.mutation_token IS NULL
      AND v_latest_intent.cleanup_action_id IS NULL
      AND v_latest_intent.cleanup_mutation_token IS NULL
      AND pg_catalog.cardinality(v_latest_intent.reserved_role_ids) = 0
      AND pg_catalog.cardinality(v_latest_intent.reserved_temp_role_grant_ids) = 0
      AND public.commerce_role_delivery_contract_state(v_latest_intent.id) = 'live'
    ) THEN
      RETURN;
    END IF;
  END IF;

  v_key := 'commerce-role-delivery-ensure:' || v_entitlement.id::TEXT || ':'
    || COALESCE(v_latest_intent.id::TEXT, 'initial');
  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.idempotency_key = v_key
   FOR UPDATE;

  IF v_action.id IS NULL THEN
    v_action_id := gen_random_uuid();
  ELSE
    v_action_id := v_action.id;
  END IF;
  v_payload := pg_catalog.jsonb_build_object(
    'mode', 'ensure_live',
    'action_id', v_action_id,
    'guild_id', v_entitlement.guild_id,
    'entitlement_id', v_entitlement.id,
    'customer_id', v_entitlement.customer_id,
    'discord_id', v_customer.discord_id,
    'order_id', v_entitlement.order_id,
    'product_id', v_entitlement.product_id,
    'plan_id', v_entitlement.plan_id,
    'entitlement_type', v_entitlement.type,
    'source', v_entitlement.source,
    'entitlement_status', v_entitlement.status,
    'granted_role_ids', pg_catalog.to_jsonb(v_roles)
  );

  IF v_action.id IS NOT NULL THEN
    IF v_action.guild_id IS DISTINCT FROM v_entitlement.guild_id
       OR v_action.action IS DISTINCT FROM 'reconcile_entitlement_roles'
       OR v_action.payload IS DISTINCT FROM v_payload
       OR v_action.lane IS DISTINCT FROM 'commerce' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce ensure-live carrier identity is cross-linked';
    END IF;
    IF v_action.status IN ('staged', 'completed', 'failed') THEN
      UPDATE public.bot_action_queue AS queue
         SET status = 'pending', started_at = NULL, completed_at = NULL,
             error_message = NULL, next_retry_at = NULL,
             retry_count = queue.retry_count + 1
       WHERE queue.id = v_action.id
         AND queue.status = v_action.status
       RETURNING queue.* INTO v_action;
    END IF;
    RETURN QUERY SELECT v_action.id, v_action.status;
    RETURN;
  END IF;

  INSERT INTO public.bot_action_queue (
    id, guild_id, action, payload, status, lane, idempotency_key
  ) VALUES (
    v_action_id, v_entitlement.guild_id, 'reconcile_entitlement_roles',
    v_payload, 'pending', 'commerce', v_key
  );
  RETURN QUERY SELECT v_action_id, 'pending'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_ensure_live_role_delivery_action(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_ensure_live_role_delivery_action(UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_begin_role_delivery_cleanup(
  p_intent_id UUID,
  p_cleanup_action_id UUID,
  p_cleanup_claim_token UUID
)
RETURNS TABLE (
  intent_state TEXT,
  cleanup_mutation_token UUID,
  may_mutate BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_observed public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_contract_state TEXT;
  v_cleanup_token UUID;
  v_is_origin_controller BOOLEAN := false;
  v_is_carrier_controller BOOLEAN := false;
  v_is_noncommerce_controller BOOLEAN := false;
  v_noncommerce_kind TEXT;
BEGIN
  IF p_intent_id IS NULL OR p_cleanup_action_id IS NULL
     OR p_cleanup_claim_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_cleanup: exact controller identity is required';
  END IF;

  SELECT intent.* INTO v_observed
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_cleanup: intent is unavailable';
  END IF;

  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id FOR SHARE;
  PERFORM 1
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = ANY(v_observed.temporary_role_grant_ids)
   ORDER BY grant_row.id
   FOR UPDATE;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_observed.entitlement_id FOR SHARE;
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_cleanup_action_id
   FOR UPDATE;

  IF v_intent.id IS NULL
     OR v_action.id IS NULL
     OR v_action.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_action.status IS DISTINCT FROM 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_cleanup_claim_token THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_cleanup: action claim is not current';
  END IF;

  v_is_origin_controller := v_action.id = v_intent.action_id
    AND p_cleanup_claim_token = v_intent.delivery_claim_token;
  v_is_carrier_controller := v_action.action = 'reconcile_entitlement_roles'
    AND v_action.idempotency_key =
      'commerce-role-delivery-cleanup:' || v_intent.id::TEXT
    AND v_action.payload IS NOT DISTINCT FROM pg_catalog.jsonb_build_object(
      'mode', 'cleanup',
      'action_id', v_action.id,
      'target_delivery_intent_id', v_intent.id,
      'guild_id', v_intent.guild_id
    );
  v_noncommerce_kind := public.commerce_noncommerce_cleanup_carrier_kind(
    v_action.guild_id,
    v_action.action,
    v_action.lane,
    v_action.idempotency_key,
    v_action.payload
  );
  v_is_noncommerce_controller := v_intent.contract_kind = 'noncommerce'
    AND v_noncommerce_kind IN ('terminal', 'relink')
    AND v_action.payload ->> 'entitlement_id' = v_intent.entitlement_id::TEXT
    AND v_action.payload ->> 'customer_id' = v_intent.customer_id::TEXT
    AND v_action.payload ->> 'order_id' IS NOT DISTINCT FROM
      v_intent.order_id::TEXT
    AND v_action.payload ->> 'product_id' = v_intent.product_id::TEXT
    AND v_action.payload ->> 'entitlement_source' = v_intent.entitlement_source
    AND v_action.payload ->> 'entitlement_type' = v_intent.entitlement_type
    AND v_action.payload ->> 'plan_id' IS NOT DISTINCT FROM v_intent.plan_id::TEXT
    AND public.commerce_jsonb_snowflake_snapshot_matches(
      v_action.payload -> 'role_ids', v_intent.permanent_role_ids
    )
    AND CASE WHEN v_noncommerce_kind = 'relink'
      THEN v_action.payload ->> 'old_discord_id' = v_intent.discord_id
      ELSE v_action.payload ->> 'discord_id' = v_intent.discord_id
    END;
  IF NOT v_is_origin_controller
     AND NOT v_is_carrier_controller
     AND NOT v_is_noncommerce_controller THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_cleanup: action is not the exact cleanup controller';
  END IF;

  IF v_intent.state = 'settled' THEN
    RETURN QUERY SELECT 'settled'::TEXT, NULL::UUID, false;
    RETURN;
  END IF;
  IF pg_catalog.cardinality(v_intent.reserved_role_ids) > 0
     OR pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) > 0 THEN
    RETURN QUERY SELECT v_intent.state, NULL::UUID, false;
    RETURN;
  END IF;
  IF v_intent.state NOT IN ('cleanup_required', 'operator_required') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_cleanup: intent is not cleanup eligible';
  END IF;

  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state = 'invalid' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_cleanup: durable contract is invalid';
  END IF;
  IF v_intent.state = 'cleanup_required' AND v_contract_state <> 'terminal' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_cleanup: terminal cleanup contract is not proven';
  END IF;
  IF v_intent.state = 'operator_required'
     AND v_contract_state NOT IN ('terminal', 'claim_lost')
     AND NOT (
       v_contract_state = 'live'
       AND v_intent.delivery_confirmed_at IS NULL
       AND v_intent.mutation_token IS NULL
       AND v_intent.last_delivery_outcome = 'retry'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_role_delivery_cleanup: operator cleanup is not fenced';
  END IF;

  -- The exact origin action may compensate while its delivery mutation is
  -- active. A distinct carrier may acquire only after stale recovery or the
  -- origin finalizer has cleared that token.
  IF (v_is_carrier_controller OR v_is_noncommerce_controller)
     AND NOT v_is_origin_controller
     AND v_intent.mutation_token IS NOT NULL THEN
    RETURN QUERY SELECT v_intent.state, NULL::UUID, false;
    RETURN;
  END IF;

  IF v_intent.cleanup_mutation_token IS NOT NULL THEN
    IF v_intent.cleanup_action_id = p_cleanup_action_id
       AND v_intent.cleanup_claim_token = p_cleanup_claim_token THEN
      RETURN QUERY SELECT
        v_intent.state, v_intent.cleanup_mutation_token, true;
    ELSE
      RETURN QUERY SELECT v_intent.state, NULL::UUID, false;
    END IF;
    RETURN;
  END IF;

  IF v_intent.cleanup_action_id IS NOT NULL
     AND v_intent.cleanup_action_id <> p_cleanup_action_id
      AND NOT (
        v_intent.cleanup_action_id = v_intent.action_id
        AND v_intent.mutation_token IS NULL
      )
     AND NOT (
       v_is_noncommerce_controller
       AND v_intent.cleanup_mutation_token IS NULL
      ) THEN
    RETURN QUERY SELECT v_intent.state, NULL::UUID, false;
    RETURN;
  END IF;

  v_cleanup_token := gen_random_uuid();
  UPDATE public.commerce_role_delivery_intents
     SET cleanup_action_id = p_cleanup_action_id,
         cleanup_claim_token = p_cleanup_claim_token,
         cleanup_mutation_token = v_cleanup_token,
         cleanup_mutation_started_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND state IN ('cleanup_required', 'operator_required')
     AND cleanup_mutation_token IS NULL
   RETURNING * INTO v_intent;
  IF NOT FOUND THEN
    RETURN QUERY SELECT v_intent.state, NULL::UUID, false;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_intent.state, v_cleanup_token, true;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_begin_role_delivery_cleanup(
  UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_begin_role_delivery_cleanup(
  UUID, UUID, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_get_role_delivery_cleanup(
  p_intent_id UUID,
  p_cleanup_action_id UUID,
  p_cleanup_claim_token UUID,
  p_cleanup_mutation_token UUID
)
RETURNS TABLE (
  intent_id UUID,
  guild_id TEXT,
  entitlement_id UUID,
  customer_id UUID,
  discord_id TEXT,
  owned_role_ids TEXT[],
  temporary_role_grant_ids UUID[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_temp_count INTEGER;
  v_temp_roles TEXT[];
  v_cleanup_roles TEXT[];
BEGIN
  IF p_intent_id IS NULL OR p_cleanup_action_id IS NULL
     OR p_cleanup_claim_token IS NULL OR p_cleanup_mutation_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_get_role_delivery_cleanup: exact controller identity is required';
  END IF;

  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_cleanup_action_id;
  IF v_intent.id IS NULL
     OR v_intent.state NOT IN ('cleanup_required', 'operator_required')
     OR v_intent.cleanup_action_id IS DISTINCT FROM p_cleanup_action_id
     OR v_intent.cleanup_claim_token IS DISTINCT FROM p_cleanup_claim_token
     OR v_intent.cleanup_mutation_token IS DISTINCT FROM p_cleanup_mutation_token
     OR v_action.id IS NULL
     OR v_action.status IS DISTINCT FROM 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_cleanup_claim_token
     OR v_action.guild_id IS DISTINCT FROM v_intent.guild_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_get_role_delivery_cleanup: cleanup claim is stale';
  END IF;

  SELECT pg_catalog.count(*)::INTEGER,
         COALESCE(
           pg_catalog.array_agg(grant_row.role_id ORDER BY grant_row.role_id),
           '{}'::TEXT[]
         )
    INTO v_temp_count, v_temp_roles
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = ANY(v_intent.temporary_role_grant_ids)
     AND grant_row.order_id = v_intent.order_id
     AND grant_row.guild_id = v_intent.guild_id
     AND grant_row.user_id = v_intent.discord_id
     AND grant_row.source = 'commerce_purchase'
     AND grant_row.source_id = v_intent.product_id::TEXT
     AND grant_row.grant_status IN ('pending', 'applied')
     AND grant_row.remove_on_expiry = true;
  IF v_temp_count <> pg_catalog.cardinality(v_intent.temporary_role_grant_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_get_role_delivery_cleanup: temporary-role authority is malformed';
  END IF;

  v_cleanup_roles := public.commerce_canonical_snowflake_snapshot(
    v_intent.owned_role_ids || v_temp_roles
  );
  RETURN QUERY SELECT
    v_intent.id,
    v_intent.guild_id,
    v_intent.entitlement_id,
    v_intent.customer_id,
    v_intent.discord_id,
    v_cleanup_roles,
    v_intent.temporary_role_grant_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_get_role_delivery_cleanup(
  UUID, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_get_role_delivery_cleanup(
  UUID, UUID, UUID, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_finish_role_delivery_cleanup(
  p_intent_id UUID,
  p_cleanup_action_id UUID,
  p_cleanup_claim_token UUID,
  p_cleanup_mutation_token UUID,
  p_outcome TEXT,
  p_error TEXT,
  p_removed_role_ids TEXT[],
  p_absent_role_ids TEXT[],
  p_retained_role_ids TEXT[]
)
RETURNS TABLE (intent_state TEXT, settled BOOLEAN, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_temp_count INTEGER;
  v_updated_temp_count INTEGER;
  v_temp_roles TEXT[];
  v_cleanup_roles TEXT[];
  v_removed TEXT[];
  v_absent TEXT[];
  v_retained TEXT[];
  v_role_id TEXT;
  v_temp_grant_id UUID;
  v_temp_grant_retired BOOLEAN := false;
  v_owner_state TEXT;
BEGIN
  IF p_intent_id IS NULL OR p_cleanup_action_id IS NULL
     OR p_cleanup_claim_token IS NULL OR p_cleanup_mutation_token IS NULL
     OR p_outcome NOT IN ('cleaned', 'retry') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_cleanup: exact outcome identity is required';
  END IF;

  SELECT intent.* INTO v_observed
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_cleanup: intent is unavailable';
  END IF;

  PERFORM 1 FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers AS customer
   WHERE customer.id = v_observed.customer_id FOR SHARE;
  PERFORM 1
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = ANY(v_observed.temporary_role_grant_ids)
   ORDER BY grant_row.id
   FOR UPDATE;
  PERFORM 1 FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_observed.entitlement_id FOR SHARE;
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_cleanup_action_id
   FOR UPDATE;

  IF v_intent.id IS NULL
     OR v_intent.action_id IS DISTINCT FROM v_observed.action_id
     OR v_intent.order_id IS DISTINCT FROM v_observed.order_id
     OR v_intent.entitlement_id IS DISTINCT FROM v_observed.entitlement_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_cleanup: durable identity changed';
  END IF;

  IF v_intent.cleanup_mutation_token IS DISTINCT FROM p_cleanup_mutation_token THEN
    IF v_intent.cleanup_mutation_token IS NULL
       AND v_intent.last_cleanup_mutation_token = p_cleanup_mutation_token
       AND v_intent.last_cleanup_outcome = p_outcome THEN
      RETURN QUERY SELECT v_intent.state, v_intent.state = 'settled',
        CASE WHEN v_intent.state = 'settled'
          THEN 'settled' ELSE 'retry' END::TEXT;
      RETURN;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_cleanup: cleanup token is stale';
  END IF;

  IF v_intent.state NOT IN ('cleanup_required', 'operator_required')
     OR v_intent.cleanup_action_id IS DISTINCT FROM p_cleanup_action_id
     OR v_intent.cleanup_claim_token IS DISTINCT FROM p_cleanup_claim_token
     OR v_action.id IS NULL
     OR v_action.status IS DISTINCT FROM 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_cleanup_claim_token
     OR v_action.guild_id IS DISTINCT FROM v_intent.guild_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_cleanup: cleanup claim is stale';
  END IF;

  IF p_outcome = 'retry' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = 'operator_required',
           cleanup_mutation_token = NULL,
           cleanup_mutation_started_at = NULL,
           last_cleanup_mutation_token = p_cleanup_mutation_token,
           last_cleanup_outcome = 'retry',
           last_error = pg_catalog.left(COALESCE(
             p_error, 'role cleanup outcome is ambiguous'
           ), 4000),
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
       AND cleanup_mutation_token = p_cleanup_mutation_token
     RETURNING * INTO v_intent;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      COALESCE(p_error, 'role cleanup outcome is ambiguous')
    );
    RETURN QUERY SELECT v_intent.state, false, 'retry'::TEXT;
    RETURN;
  END IF;

  IF NOT public.commerce_valid_snowflake_snapshot(
       COALESCE(p_removed_role_ids, '{}'::TEXT[])
     )
     OR NOT public.commerce_valid_snowflake_snapshot(
       COALESCE(p_absent_role_ids, '{}'::TEXT[])
     )
     OR NOT public.commerce_valid_snowflake_snapshot(
       COALESCE(p_retained_role_ids, '{}'::TEXT[])
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_cleanup: outcome vectors are malformed';
  END IF;
  v_removed := public.commerce_canonical_snowflake_snapshot(
    COALESCE(p_removed_role_ids, '{}'::TEXT[])
  );
  v_absent := public.commerce_canonical_snowflake_snapshot(
    COALESCE(p_absent_role_ids, '{}'::TEXT[])
  );
  v_retained := public.commerce_canonical_snowflake_snapshot(
    COALESCE(p_retained_role_ids, '{}'::TEXT[])
  );
  IF v_removed && v_absent OR v_removed && v_retained OR v_absent && v_retained THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_cleanup: outcome vectors overlap';
  END IF;

  SELECT pg_catalog.count(*)::INTEGER,
         COALESCE(
           pg_catalog.array_agg(grant_row.role_id ORDER BY grant_row.role_id),
           '{}'::TEXT[]
         )
    INTO v_temp_count, v_temp_roles
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = ANY(v_intent.temporary_role_grant_ids)
     AND grant_row.order_id = v_intent.order_id
     AND grant_row.guild_id = v_intent.guild_id
     AND grant_row.user_id = v_intent.discord_id
     AND grant_row.source = 'commerce_purchase'
     AND grant_row.source_id = v_intent.product_id::TEXT
     AND grant_row.grant_status IN ('pending', 'applied')
     AND grant_row.remove_on_expiry = true;
  IF v_temp_count <> pg_catalog.cardinality(v_intent.temporary_role_grant_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_cleanup: temporary-role authority is malformed';
  END IF;
  v_cleanup_roles := public.commerce_canonical_snowflake_snapshot(
    v_intent.owned_role_ids || v_temp_roles
  );
  IF public.commerce_canonical_snowflake_snapshot(
       v_removed || v_absent || v_retained
     ) IS DISTINCT FROM v_cleanup_roles THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_cleanup: outcome is not an exact partition';
  END IF;

  FOREACH v_role_id IN ARRAY v_retained LOOP
    v_owner_state := public.commerce_classify_live_role_owner(
      v_intent.guild_id,
      v_intent.discord_id,
      v_role_id,
      v_intent.id,
      v_intent.entitlement_id,
      '{}'::UUID[]
    );
    IF v_owner_state = 'pending' THEN
      UPDATE public.commerce_role_delivery_intents
         SET cleanup_mutation_token = NULL,
             cleanup_mutation_started_at = NULL,
             last_cleanup_mutation_token = p_cleanup_mutation_token,
             last_cleanup_outcome = 'retry',
             last_error = 'retained role ownership is still resolving',
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
         AND cleanup_action_id = p_cleanup_action_id
         AND cleanup_claim_token = p_cleanup_claim_token
         AND cleanup_mutation_token = p_cleanup_mutation_token
       RETURNING * INTO v_intent;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce_finish_role_delivery_cleanup: dependency release CAS failed';
      END IF;
      RETURN QUERY SELECT v_intent.state, false, 'dependency_pending'::TEXT;
      RETURN;
    END IF;
    IF NOT public.commerce_has_other_live_role_owner(
      v_intent.guild_id,
      v_intent.discord_id,
      v_role_id,
      v_intent.id,
      v_intent.entitlement_id,
      v_intent.temporary_role_grant_ids
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finish_role_delivery_cleanup: retained role has no fresh owner';
    END IF;
  END LOOP;

  v_updated_temp_count := 0;
  FOREACH v_temp_grant_id IN ARRAY v_intent.temporary_role_grant_ids LOOP
    PERFORM pg_catalog.set_config(
      'somnibot.commerce_cleanup_retirement_grant_id',
      v_temp_grant_id::TEXT,
      true
    );
    PERFORM pg_catalog.set_config(
      'somnibot.commerce_cleanup_retirement_intent_id',
      v_intent.id::TEXT,
      true
    );
    PERFORM pg_catalog.set_config(
      'somnibot.commerce_cleanup_retirement_mutation_token',
      p_cleanup_mutation_token::TEXT,
      true
    );
    UPDATE public.temp_role_grants AS grant_row
       SET grant_status = 'removed',
           source = 'commerce_reconciled',
           last_error = NULL,
           updated_at = pg_catalog.clock_timestamp()
     WHERE grant_row.id = v_temp_grant_id
       AND grant_row.order_id = v_intent.order_id
       AND grant_row.guild_id = v_intent.guild_id
       AND grant_row.user_id = v_intent.discord_id
       AND grant_row.source_id = v_intent.product_id::TEXT
       AND grant_row.source = 'commerce_purchase'
       AND grant_row.grant_status IN ('pending', 'applied')
       AND grant_row.remove_on_expiry = true;
    v_temp_grant_retired := FOUND;
    PERFORM pg_catalog.set_config(
      'somnibot.commerce_cleanup_retirement_grant_id', '', true
    );
    PERFORM pg_catalog.set_config(
      'somnibot.commerce_cleanup_retirement_intent_id', '', true
    );
    PERFORM pg_catalog.set_config(
      'somnibot.commerce_cleanup_retirement_mutation_token', '', true
    );
    IF NOT v_temp_grant_retired THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finish_role_delivery_cleanup: temporary-role retirement CAS failed';
    END IF;
    v_updated_temp_count := v_updated_temp_count + 1;
  END LOOP;
  IF v_updated_temp_count <> v_temp_count THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_cleanup: temporary-role retirement CAS failed';
  END IF;

  UPDATE public.commerce_role_delivery_intents
     SET state = CASE
           WHEN mutation_token IS NULL THEN 'settled'
           WHEN state = 'operator_required' THEN 'operator_required'
           ELSE 'cleanup_required'
         END,
         owned_role_ids = '{}'::TEXT[],
         temporary_role_grant_ids = '{}'::UUID[],
         cleanup_mutation_token = NULL,
         cleanup_mutation_started_at = NULL,
         last_cleanup_mutation_token = p_cleanup_mutation_token,
         last_cleanup_outcome = 'cleaned',
         settled_at = CASE WHEN mutation_token IS NULL
           THEN pg_catalog.clock_timestamp() ELSE NULL END,
         last_error = NULL,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND cleanup_action_id = p_cleanup_action_id
     AND cleanup_claim_token = p_cleanup_claim_token
     AND cleanup_mutation_token = p_cleanup_mutation_token
   RETURNING * INTO v_intent;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finish_role_delivery_cleanup: cleanup CAS failed';
  END IF;

  IF v_intent.state = 'settled' THEN
    PERFORM public.commerce_resolve_role_delivery_alert(v_intent.id);
    -- If this was an ambiguity rollback while the paid entitlement remains
    -- live, the authoritative ensure helper emits exactly one fresh/read-only
    -- reconciliation carrier. Terminal contracts simply return no row.
    IF v_intent.contract_kind = 'paid' THEN
      PERFORM * FROM public.commerce_ensure_live_role_delivery_action(
        v_intent.entitlement_id
      );
    END IF;
  ELSE
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      'role cleanup completed; original delivery controller must finalize compensation'
    );
  END IF;
  RETURN QUERY SELECT v_intent.state, v_intent.state = 'settled',
    CASE WHEN v_intent.state = 'settled'
      THEN 'settled' ELSE 'cleanup_continues' END::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_finish_role_delivery_cleanup(
  UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT[], TEXT[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_finish_role_delivery_cleanup(
  UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT[], TEXT[]
) TO service_role;

-- A staged outbox row is durable but deliberately invisible to workers until
-- its producer has completed all payload assembly and releases it to pending.
ALTER TABLE public.bot_action_queue
  DROP CONSTRAINT IF EXISTS bot_action_queue_status_check;
ALTER TABLE public.bot_action_queue
  ADD CONSTRAINT bot_action_queue_status_check
    CHECK (status IN ('staged', 'pending', 'processing', 'completed', 'failed')),
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE public.bot_action_queue
  DROP CONSTRAINT IF EXISTS bot_action_queue_claim_token_shape;
ALTER TABLE public.bot_action_queue
  ADD CONSTRAINT bot_action_queue_claim_token_shape
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL)
    OR (status <> 'processing' AND claim_token IS NULL)
  ) NOT VALID;

-- Deployment contract: queue workers are paused/drained while this migration
-- installs protocol v2. An extant processing row receives an unreachable claim
-- generation; the v2 stale-recovery RPC, not an old worker, deterministically
-- resolves it after the timeout. Non-processing rows cannot retain old tokens.
UPDATE public.bot_action_queue AS queue
   SET claim_token = COALESCE(queue.claim_token, gen_random_uuid()),
       started_at = COALESCE(queue.started_at, queue.created_at,
         pg_catalog.clock_timestamp())
 WHERE queue.status = 'processing'
   AND (queue.claim_token IS NULL OR queue.started_at IS NULL);

UPDATE public.bot_action_queue AS queue
   SET claim_token = NULL
 WHERE queue.status <> 'processing'
   AND queue.claim_token IS NOT NULL;

ALTER TABLE public.bot_action_queue
  VALIDATE CONSTRAINT bot_action_queue_claim_token_shape;

-- Processing generations are created and retired only by the SECURITY
-- DEFINER CAS RPCs below. The trigger rotates the token on every successful
-- pending -> processing transition and prevents a service-role table UPDATE
-- from completing/re-pending a generation without its exact token predicate.
CREATE OR REPLACE FUNCTION public.bot_action_queue_guard_claim_generation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_noncommerce_owner NAME;
  v_protocol_owner NAME;
  v_noncommerce_scope TEXT;
  v_expected_scope TEXT;
  v_expected_key TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'processing' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'bot action queue processing rows must be atomically claimed';
    END IF;

    -- These payloads are exact Discord role authority.  In particular,
    -- old_discord_id cannot be reconstructed after a customer relink, so a
    -- syntactically convincing direct INSERT must never be able to choose its
    -- target.  Only the SECURITY DEFINER snapshot helpers may mint the exact
    -- row, and their one-row transaction-local scope binds UUID, key, and the
    -- complete canonical JSONB payload.
     IF NEW.payload ->> 'source' IN (
          'noncommerce_entitlement_status_trigger',
          'noncommerce_entitlement_customer_relink_trigger',
          'noncommerce_entitlement_activation_trigger'
        ) THEN
      SELECT pg_catalog.pg_get_userbyid(proc.proowner)
        INTO v_noncommerce_owner
        FROM pg_catalog.pg_proc AS proc
       WHERE proc.oid = CASE NEW.payload ->> 'source'
         WHEN 'noncommerce_entitlement_status_trigger' THEN
           pg_catalog.to_regprocedure(
             'public.commerce_enqueue_noncommerce_terminal_entitlement(uuid,text,boolean)'
           )
          WHEN 'noncommerce_entitlement_activation_trigger' THEN
            pg_catalog.to_regprocedure(
              'public.commerce_enqueue_noncommerce_activation_entitlement(uuid,text,uuid,uuid,text)'
            )
         ELSE pg_catalog.to_regprocedure(
           'public.commerce_signal_customer_role_delivery_relink()'
         )
       END;
      v_noncommerce_scope := pg_catalog.current_setting(
        'somnibot.noncommerce_cleanup_carrier_insert', true
      );
      v_expected_scope := NEW.id::TEXT || ':'
        || COALESCE(NEW.idempotency_key, '') || ':'
        || pg_catalog.md5(NEW.payload::TEXT);
      v_expected_key := CASE NEW.payload ->> 'source'
         WHEN 'noncommerce_entitlement_status_trigger' THEN
           'noncommerce:terminal-entitlement:'
            || COALESCE(NEW.payload ->> 'entitlement_id', '') || ':'
            || COALESCE(NEW.payload ->> 'discord_id', '') || ':'
            || COALESCE(NEW.payload ->> 'entitlement_status', '') || ':'
            || pg_catalog.md5(NEW.payload::TEXT) || ':v1'
         WHEN 'noncommerce_entitlement_customer_relink_trigger' THEN
           'noncommerce:customer-relink:'
            || COALESCE(NEW.payload ->> 'entitlement_id', '') || ':'
            || COALESCE(NEW.payload ->> 'old_discord_id', '') || ':'
             || COALESCE(NEW.payload ->> 'discord_id', '') || ':'
             || pg_catalog.md5(NEW.payload::TEXT) || ':v1'
         ELSE
           'noncommerce:activation-entitlement:'
             || COALESCE(NEW.payload ->> 'entitlement_id', '') || ':'
             || COALESCE(NEW.payload ->> 'discord_id', '') || ':'
             || COALESCE(NEW.payload ->> 'activation_generation', '') || ':'
             || pg_catalog.md5(NEW.payload::TEXT) || ':v1'
       END;
      IF v_noncommerce_owner IS NULL
         OR current_user IS DISTINCT FROM v_noncommerce_owner
         OR NEW.action IS DISTINCT FROM 'revoke_roles'
         OR NEW.lane IS DISTINCT FROM 'commerce'
         OR NEW.idempotency_key IS DISTINCT FROM v_expected_key
         OR v_noncommerce_scope IS DISTINCT FROM v_expected_scope THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'noncommerce cleanup carriers require an exact snapshot helper token';
      END IF;
    END IF;
    NEW.claim_token := NULL;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.guild_id IS DISTINCT FROM OLD.guild_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.lane IS DISTINCT FROM OLD.lane
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'bot action queue durable identity and payload are immutable';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT pg_catalog.pg_get_userbyid(proc.proowner)
      INTO v_protocol_owner
      FROM pg_catalog.pg_proc AS proc
     WHERE proc.oid = pg_catalog.to_regprocedure(
       'public.bot_action_queue_claim(uuid,integer)'
     );
    IF v_protocol_owner IS NULL
       OR current_user IS DISTINCT FROM v_protocol_owner THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'bot action queue status transitions require an exact CAS RPC';
    END IF;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'processing' THEN
    NEW.claim_token := COALESCE(NEW.claim_token, gen_random_uuid());
    NEW.started_at := COALESCE(NEW.started_at, pg_catalog.clock_timestamp());
  ELSIF OLD.status = 'processing' AND NEW.status = 'processing' THEN
    IF NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'bot action queue claim token is immutable while processing';
    END IF;
  ELSIF NEW.status <> 'processing' THEN
    NEW.claim_token := NULL;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'bot action queue processing transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_guard_claim_generation()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_bot_action_queue_guard_claim_generation
  ON public.bot_action_queue;
CREATE TRIGGER trg_bot_action_queue_guard_claim_generation
  BEFORE INSERT OR UPDATE ON public.bot_action_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.bot_action_queue_guard_claim_generation();

-- Staged fulfillment rows are deliberately invisible to workers until the
-- provider/order transaction has durably completed. Release is an exact,
-- replay-safe CAS instead of a service-role table UPDATE, keeping every queue
-- status transition behind the same definer-owner boundary as claim/finish.
CREATE OR REPLACE FUNCTION public.bot_action_queue_release_staged(
  p_action_id UUID,
  p_guild_id TEXT,
  p_idempotency_key TEXT
)
RETURNS TABLE (action_id UUID, action_status TEXT, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
BEGIN
  IF p_action_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = ''
     OR p_idempotency_key IS NULL
     OR p_idempotency_key <> pg_catalog.btrim(p_idempotency_key)
     OR p_idempotency_key = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'bot_action_queue_release_staged: exact identity is required';
  END IF;

  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
     AND queue.guild_id = p_guild_id
     AND queue.idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF pg_catalog.jsonb_typeof(v_action.payload) IS DISTINCT FROM 'object'
     OR v_action.lane IS DISTINCT FROM
       public.bot_action_queue_lane_for_action(v_action.action) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'bot_action_queue_release_staged: carrier contract is invalid';
  END IF;

  IF v_action.status = 'staged' THEN
    UPDATE public.bot_action_queue AS queue
       SET status = 'pending',
           claim_token = NULL,
           started_at = NULL,
           completed_at = NULL,
           error = NULL,
           error_message = NULL,
           next_retry_at = NULL
     WHERE queue.id = v_action.id
       AND queue.status = 'staged'
     RETURNING queue.* INTO v_action;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'bot_action_queue_release_staged: release raced';
    END IF;
    RETURN QUERY SELECT v_action.id, v_action.status, 'released'::TEXT;
    RETURN;
  END IF;
  IF v_action.status IN ('pending', 'processing', 'completed', 'failed') THEN
    RETURN QUERY SELECT
      v_action.id,
      v_action.status,
      'already_released'::TEXT;
    RETURN;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'bot_action_queue_release_staged: status is invalid';
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_release_staged(
  UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_action_queue_release_staged(
  UUID, TEXT, TEXT
) TO service_role;

DO $$
DECLARE
  v_bad_key TEXT;
BEGIN
  SELECT queue.idempotency_key
    INTO v_bad_key
    FROM public.bot_action_queue AS queue
   WHERE queue.idempotency_key IS NOT NULL
     AND (
       queue.idempotency_key <> pg_catalog.btrim(queue.idempotency_key)
       OR pg_catalog.btrim(queue.idempotency_key) = ''
       OR pg_catalog.length(queue.idempotency_key) > 255
     )
   ORDER BY queue.idempotency_key
   LIMIT 1;

  IF v_bad_key IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'bot_action_queue idempotency_key migration check failed';
  END IF;

  SELECT duplicate.idempotency_key
    INTO v_bad_key
    FROM (
      SELECT queue.idempotency_key
        FROM public.bot_action_queue AS queue
       WHERE queue.idempotency_key IS NOT NULL
       GROUP BY queue.idempotency_key
      HAVING pg_catalog.count(*) > 1
       ORDER BY queue.idempotency_key
       LIMIT 1
    ) AS duplicate;

  IF v_bad_key IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'bot_action_queue idempotency_key duplicate migration check failed',
      DETAIL = 'idempotency_key=' || v_bad_key;
  END IF;
END;
$$;

ALTER TABLE public.bot_action_queue
  ADD CONSTRAINT bot_action_queue_idempotency_key_canonical
  CHECK (
    idempotency_key IS NULL
    OR (
      idempotency_key = pg_catalog.btrim(idempotency_key)
      AND pg_catalog.length(idempotency_key) BETWEEN 1 AND 255
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_bot_action_queue_idempotency_key
  ON public.bot_action_queue (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

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
  v_observed_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_is_origin BOOLEAN := false;
  v_is_cleanup BOOLEAN := false;
  v_success_allowed BOOLEAN := true;
  v_completed_from_evidence BOOLEAN := false;
  v_noncommerce_kind TEXT;
  v_no_intent_outcome TEXT;
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL OR p_success IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'bot_action_queue_finish_claim: exact claim outcome is required';
  END IF;

  SELECT intent.* INTO v_observed_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.action_id = p_action_id
      OR intent.cleanup_action_id = p_action_id
   ORDER BY CASE WHEN intent.action_id = p_action_id THEN 0 ELSE 1 END
   LIMIT 1;

  IF v_observed_intent.id IS NOT NULL THEN
    PERFORM 1 FROM public.orders AS paid_order
     WHERE paid_order.id = v_observed_intent.order_id FOR SHARE;
    PERFORM 1 FROM public.customers AS customer
     WHERE customer.id = v_observed_intent.customer_id FOR SHARE;
    PERFORM 1
      FROM public.temp_role_grants AS grant_row
     WHERE grant_row.id = ANY(
       v_observed_intent.reserved_temp_role_grant_ids
         || v_observed_intent.temporary_role_grant_ids
     )
     ORDER BY grant_row.id FOR UPDATE;
    PERFORM 1 FROM public.entitlements AS entitlement
     WHERE entitlement.id = v_observed_intent.entitlement_id FOR SHARE;
    SELECT intent.* INTO v_intent
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.id = v_observed_intent.id
     FOR UPDATE;
  END IF;

  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
   FOR UPDATE;
  IF NOT FOUND OR v_action.status <> 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN QUERY SELECT false, 'stale_claim'::TEXT;
    RETURN;
  END IF;

  IF v_intent.id IS NULL THEN
    -- Every legitimate binder owns the action row before its binding trigger
    -- takes this advisory lock. Taking both in the same order closes the
    -- observe-no-intent gap, including raw writes that reach the binding guard.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'commerce-role-delivery-action:' || p_action_id::TEXT,
        0
      )
    );
    PERFORM 1
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.action_id = p_action_id
        OR intent.cleanup_action_id = p_action_id;
    IF FOUND THEN
      RETURN QUERY SELECT false, 'intent_raced'::TEXT;
      RETURN;
    END IF;
  END IF;

  v_noncommerce_kind := public.commerce_noncommerce_cleanup_carrier_kind(
    v_action.guild_id,
    v_action.action,
    v_action.lane,
    v_action.idempotency_key,
    v_action.payload
  );
  IF p_success AND v_intent.id IS NULL AND v_noncommerce_kind IS NOT NULL THEN
    SELECT outcome.outcome INTO v_no_intent_outcome
      FROM public.commerce_noncommerce_action_outcomes AS outcome
     WHERE outcome.action_id = p_action_id
       AND outcome.claim_token = p_claim_token;
    v_success_allowed := v_no_intent_outcome IN (
      'superseded', 'unproven', 'settled_noop'
    );
  END IF;

  IF v_intent.id IS NOT NULL THEN
    v_is_origin := v_intent.action_id = p_action_id;
    v_is_cleanup := v_intent.cleanup_action_id = p_action_id;
    v_completed_from_evidence := (
      v_is_origin
      AND v_intent.mutation_token IS NULL
      AND v_intent.cleanup_mutation_token IS NULL
      AND (
        (
          v_intent.state = 'open'
          AND v_intent.delivery_confirmed_at IS NOT NULL
          AND v_intent.last_delivery_mutation_token IS NOT NULL
          AND v_intent.last_delivery_outcome = 'live'
        )
        OR (
          v_intent.state = 'settled'
          AND v_intent.last_delivery_mutation_token IS NOT NULL
          AND v_intent.last_delivery_outcome IN ('live', 'compensated')
          AND pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
          AND pg_catalog.cardinality(v_intent.owned_role_ids) = 0
          AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0
          AND pg_catalog.cardinality(v_intent.temporary_role_grant_ids) = 0
        )
      )
    ) OR (
      v_is_cleanup
      AND v_intent.state = 'settled'
      AND v_intent.mutation_token IS NULL
      AND v_intent.cleanup_mutation_token IS NULL
      AND v_intent.last_cleanup_mutation_token IS NOT NULL
      AND v_intent.last_cleanup_outcome = 'cleaned'
      AND pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
      AND pg_catalog.cardinality(v_intent.owned_role_ids) = 0
      AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0
      AND pg_catalog.cardinality(v_intent.temporary_role_grant_ids) = 0
    );
    IF p_success AND v_is_origin THEN
      v_success_allowed := (
        v_intent.state = 'open'
        AND v_intent.delivery_confirmed_at IS NOT NULL
        AND v_intent.mutation_token IS NULL
        AND v_intent.cleanup_mutation_token IS NULL
        AND v_intent.last_delivery_outcome = 'live'
      ) OR (
        v_intent.state = 'settled'
        AND v_intent.mutation_token IS NULL
        AND v_intent.cleanup_mutation_token IS NULL
        AND pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
        AND pg_catalog.cardinality(v_intent.owned_role_ids) = 0
        AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0
        AND pg_catalog.cardinality(v_intent.temporary_role_grant_ids) = 0
      );
    ELSIF p_success AND v_is_cleanup THEN
      v_success_allowed := v_intent.state = 'settled'
        AND v_intent.mutation_token IS NULL
        AND v_intent.cleanup_mutation_token IS NULL
        AND pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
        AND pg_catalog.cardinality(v_intent.owned_role_ids) = 0
        AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0
        AND pg_catalog.cardinality(v_intent.temporary_role_grant_ids) = 0;
    END IF;
  END IF;

  IF p_success AND NOT v_success_allowed THEN
    RETURN QUERY SELECT false, 'intent_unresolved'::TEXT;
    RETURN;
  END IF;

  -- The handler result can be lost or pessimistic after the database already
  -- committed the exact intent outcome. Durable intent evidence wins over a
  -- late failure report; never demote confirmed access into cleanup merely
  -- because the response path failed after commit.
  IF NOT p_success AND v_completed_from_evidence THEN
    UPDATE public.bot_action_queue AS queue
       SET status = 'completed',
           result = p_result,
           error_message = NULL,
           completed_at = pg_catalog.clock_timestamp()
     WHERE queue.id = p_action_id
       AND queue.status = 'processing'
       AND queue.claim_token = p_claim_token;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'stale_claim'::TEXT;
      RETURN;
    END IF;
    RETURN QUERY SELECT true, 'completed_from_evidence'::TEXT;
    RETURN;
  END IF;

  IF NOT p_success AND v_intent.id IS NOT NULL
     AND v_intent.state <> 'settled' THEN
    IF v_is_origin AND v_intent.mutation_token IS NOT NULL THEN
      UPDATE public.commerce_role_delivery_intents
         SET state = 'operator_required',
             last_delivery_mutation_token = mutation_token,
             last_delivery_outcome = 'retry',
             mutation_token = NULL,
             mutation_started_at = NULL,
             last_error = pg_catalog.left(COALESCE(
               p_error, 'origin action failed with delivery authority unresolved'
             ), 4000),
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
       RETURNING * INTO v_intent;
    ELSIF v_is_cleanup AND v_intent.cleanup_mutation_token IS NOT NULL THEN
      UPDATE public.commerce_role_delivery_intents
         SET state = 'operator_required',
             last_cleanup_mutation_token = cleanup_mutation_token,
             last_cleanup_outcome = 'retry',
             cleanup_mutation_token = NULL,
             cleanup_mutation_started_at = NULL,
             last_error = pg_catalog.left(COALESCE(
               p_error, 'cleanup action failed with Discord outcome unresolved'
             ), 4000),
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
       RETURNING * INTO v_intent;
    ELSE
      UPDATE public.commerce_role_delivery_intents
         SET state = 'operator_required',
             last_error = pg_catalog.left(COALESCE(
               p_error, 'role-delivery action failed before safe settlement'
             ), 4000),
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
         AND state <> 'settled'
       RETURNING * INTO v_intent;
    END IF;
    PERFORM public.commerce_signal_role_delivery_intent(
      v_intent.id,
      COALESCE(p_error, 'role-delivery action failed before safe settlement')
    );
  END IF;

  UPDATE public.bot_action_queue AS queue
     SET status = CASE WHEN p_success THEN 'completed' ELSE 'failed' END,
         result = CASE WHEN p_success THEN p_result ELSE NULL END,
         error_message = CASE WHEN p_success THEN NULL ELSE p_error END,
         completed_at = pg_catalog.clock_timestamp()
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'stale_claim'::TEXT;
    RETURN;
  END IF;

  IF NOT p_success THEN
    INSERT INTO public.action_queue_dlq (
      guild_id, action, payload, error_message, retry_count, max_retries,
      original_id, failed_at, lane
    )
    SELECT
      v_action.guild_id,
      v_action.action,
      v_action.payload,
      p_error,
      v_action.retry_count,
      5,
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

    IF v_action.action = 'deliver_receipt' THEN
      INSERT INTO public.alerts (
        guild_id, alert_type, severity, title, message, metadata, resolved
      ) VALUES (
        v_action.guild_id,
        'receipt_delivery_failed',
        'critical',
        'Paid receipt delivery failed',
        'A paid receipt action exhausted its retry budget. Inspect the dead-letter queue and retry the exact action.',
        pg_catalog.jsonb_build_object(
          'action_id', v_action.id,
          'next_step', 'inspect_action_queue_dlq'
        ),
        false
      ) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  RETURN QUERY SELECT true, CASE
    WHEN p_success THEN 'completed' ELSE 'failed' END;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_finish_claim(
  UUID, UUID, BOOLEAN, JSONB, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_action_queue_finish_claim(
  UUID, UUID, BOOLEAN, JSONB, TEXT
) TO service_role;

DROP FUNCTION IF EXISTS public.bot_action_queue_recover_stale(TEXT, INTEGER, INTEGER);
CREATE FUNCTION public.bot_action_queue_recover_stale(
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
  v_observed_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_is_origin BOOLEAN;
  v_is_cleanup BOOLEAN;
  v_disposition TEXT;
  v_failure TEXT;
  v_business_state TEXT;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_timeout_seconds IS NULL OR p_timeout_seconds <= 0
     OR p_max_retries IS NULL OR p_max_retries < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'bot_action_queue_recover_stale: valid recovery bounds are required';
  END IF;

  FOR v_candidate IN
    SELECT queue.id
      FROM public.bot_action_queue AS queue
     WHERE queue.guild_id = p_guild_id
       AND queue.status = 'processing'
       AND queue.started_at < pg_catalog.clock_timestamp()
         - pg_catalog.make_interval(secs => p_timeout_seconds)
     ORDER BY queue.id
  LOOP
    v_observed_intent := NULL;
    v_intent := NULL;
    SELECT intent.* INTO v_observed_intent
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.action_id = v_candidate.id
        OR intent.cleanup_action_id = v_candidate.id
     ORDER BY CASE WHEN intent.action_id = v_candidate.id THEN 0 ELSE 1 END
     LIMIT 1;

    IF v_observed_intent.id IS NOT NULL THEN
      PERFORM 1 FROM public.orders AS paid_order
       WHERE paid_order.id = v_observed_intent.order_id FOR SHARE;
      PERFORM 1 FROM public.customers AS customer
       WHERE customer.id = v_observed_intent.customer_id FOR SHARE;
      PERFORM 1 FROM public.temp_role_grants AS grant_row
       WHERE grant_row.id = ANY(
         v_observed_intent.reserved_temp_role_grant_ids
           || v_observed_intent.temporary_role_grant_ids
       )
       ORDER BY grant_row.id FOR UPDATE;
      PERFORM 1 FROM public.entitlements AS entitlement
       WHERE entitlement.id = v_observed_intent.entitlement_id FOR SHARE;
      SELECT intent.* INTO v_intent
        FROM public.commerce_role_delivery_intents AS intent
       WHERE intent.id = v_observed_intent.id
       FOR UPDATE;
    END IF;

    SELECT queue.* INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.id = v_candidate.id
       AND queue.guild_id = p_guild_id
       AND queue.status = 'processing'
       AND queue.started_at < pg_catalog.clock_timestamp()
         - pg_catalog.make_interval(secs => p_timeout_seconds)
     FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF v_intent.id IS NULL THEN
      -- The action row is the gap lock. Serialize against the cross-column
      -- binding trigger, then use a fresh READ COMMITTED statement. If a begin
      -- committed while this sweep waited, defer without fencing or requeueing.
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'commerce-role-delivery-action:' || v_action.id::TEXT,
          0
        )
      );
      PERFORM 1
        FROM public.commerce_role_delivery_intents AS intent
       WHERE intent.action_id = v_action.id
          OR intent.cleanup_action_id = v_action.id;
      IF FOUND THEN
        CONTINUE;
      END IF;
    END IF;

    v_is_origin := v_intent.id IS NOT NULL AND v_intent.action_id = v_action.id;
    v_is_cleanup := v_intent.id IS NOT NULL
      AND v_intent.cleanup_action_id = v_action.id;
    v_disposition := NULL;
    v_business_state := NULL;

    IF v_is_origin
       AND v_intent.state = 'open'
       AND v_intent.delivery_confirmed_at IS NULL
       AND v_intent.mutation_token IS NOT NULL
       AND pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
       AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0 THEN
      v_business_state :=
        public.commerce_role_delivery_business_contract_state(v_intent.id);
    END IF;

    IF v_is_origin AND (
      (
        v_intent.state = 'open'
        AND v_intent.delivery_confirmed_at IS NOT NULL
        AND v_intent.mutation_token IS NULL
        AND v_intent.last_delivery_outcome = 'live'
      )
      OR v_intent.state = 'settled'
    ) THEN
      UPDATE public.bot_action_queue
         SET status = 'completed', completed_at = pg_catalog.clock_timestamp(),
             error_message = NULL
       WHERE id = v_action.id AND status = 'processing'
         AND claim_token = v_action.claim_token;
      v_disposition := 'completed';
    ELSIF v_is_cleanup AND v_intent.state = 'settled'
          AND v_intent.cleanup_mutation_token IS NULL THEN
      UPDATE public.bot_action_queue
         SET status = 'completed', completed_at = pg_catalog.clock_timestamp(),
             error_message = NULL
       WHERE id = v_action.id AND status = 'processing'
         AND claim_token = v_action.claim_token;
      v_disposition := 'completed';
    ELSIF v_is_origin
          AND v_intent.state = 'open'
          AND v_intent.delivery_confirmed_at IS NULL
          AND v_intent.mutation_token IS NOT NULL
          AND pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
          AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0
          AND v_business_state = 'live' THEN
      -- Every Discord write must first create a provisional reservation. With
      -- no reservations, fencing the stale mutation generation proves that the
      -- old worker has no unrecorded removal authority, even when prior roles
      -- were already promoted into confirmed ownership.
      v_failure := 'Stale role-delivery mutation generation fenced';
      UPDATE public.commerce_role_delivery_intents
         SET state = CASE WHEN v_action.retry_count < p_max_retries
               THEN 'open' ELSE 'operator_required' END,
             last_delivery_mutation_token = mutation_token,
             last_delivery_outcome = 'retry',
             mutation_token = NULL,
             mutation_started_at = NULL,
             last_error = CASE WHEN v_action.retry_count < p_max_retries
               THEN v_failure
               ELSE 'Stale processing recovery: retry budget exhausted' END,
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
         AND state = 'open'
         AND mutation_token IS NOT NULL
         AND pg_catalog.cardinality(reserved_role_ids) = 0
         AND pg_catalog.cardinality(reserved_temp_role_grant_ids) = 0
       RETURNING * INTO v_intent;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001',
          MESSAGE = 'bot_action_queue_recover_stale: mutation fence raced';
      END IF;

      IF v_action.retry_count < p_max_retries THEN
        UPDATE public.bot_action_queue
           SET status = 'pending', started_at = NULL,
               retry_count = retry_count + 1,
               error_message = v_failure,
               next_retry_at = NULL
         WHERE id = v_action.id AND status = 'processing'
           AND claim_token = v_action.claim_token;
        v_disposition := 'requeued';
      ELSE
        UPDATE public.bot_action_queue
           SET status = 'failed', completed_at = pg_catalog.clock_timestamp(),
               error_message = 'Stale processing recovery: retry budget exhausted'
         WHERE id = v_action.id AND status = 'processing'
           AND claim_token = v_action.claim_token;
        PERFORM public.commerce_signal_role_delivery_intent(
          v_intent.id,
          'Stale processing recovery: retry budget exhausted'
        );
        v_failure := 'Stale processing recovery: retry budget exhausted';
        v_disposition := 'operator_held';
      END IF;
    ELSIF v_is_origin
          AND v_intent.state = 'open'
          AND v_intent.delivery_confirmed_at IS NULL
          AND v_intent.mutation_token IS NOT NULL
          AND pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
          AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0
          AND v_business_state = 'terminal'
          AND (
            pg_catalog.cardinality(v_intent.owned_role_ids) > 0
            OR pg_catalog.cardinality(v_intent.temporary_role_grant_ids) > 0
          ) THEN
      v_failure := 'Stale role-delivery claim became terminal with confirmed authority';
      UPDATE public.commerce_role_delivery_intents
         SET state = 'cleanup_required',
             last_delivery_mutation_token = mutation_token,
             last_delivery_outcome = 'retry',
             mutation_token = NULL,
             mutation_started_at = NULL,
             last_error = v_failure,
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
       RETURNING * INTO v_intent;
      UPDATE public.bot_action_queue
         SET status = 'failed', completed_at = pg_catalog.clock_timestamp(),
             error_message = v_failure
       WHERE id = v_action.id AND status = 'processing'
         AND claim_token = v_action.claim_token;
      PERFORM public.commerce_signal_role_delivery_intent(v_intent.id, v_failure);
      v_disposition := 'operator_held';
    ELSIF v_is_origin
          AND v_intent.state = 'open'
          AND v_intent.delivery_confirmed_at IS NULL
          AND v_intent.mutation_token IS NOT NULL
          AND pg_catalog.cardinality(v_intent.reserved_role_ids) = 0
          AND pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) = 0
          AND v_business_state = 'terminal'
          AND pg_catalog.cardinality(v_intent.owned_role_ids) = 0
          AND pg_catalog.cardinality(v_intent.temporary_role_grant_ids) = 0 THEN
      UPDATE public.commerce_role_delivery_intents
         SET state = 'settled',
             settled_at = pg_catalog.clock_timestamp(),
             last_delivery_mutation_token = mutation_token,
             last_delivery_outcome = 'compensated',
             mutation_token = NULL,
             mutation_started_at = NULL,
             last_error = NULL,
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
       RETURNING * INTO v_intent;
      UPDATE public.bot_action_queue
         SET status = 'completed', completed_at = pg_catalog.clock_timestamp(),
             error_message = NULL
       WHERE id = v_action.id AND status = 'processing'
         AND claim_token = v_action.claim_token;
      v_disposition := 'completed';
    ELSIF v_intent.id IS NOT NULL AND (
      (
        v_is_origin
        AND (
          v_intent.mutation_token IS NOT NULL
          OR v_intent.state NOT IN ('open', 'settled')
          OR (
            v_intent.delivery_confirmed_at IS NULL
            AND (
              pg_catalog.cardinality(v_intent.reserved_role_ids) > 0
              OR pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) > 0
              OR (
                (
                  pg_catalog.cardinality(v_intent.owned_role_ids) > 0
                  OR pg_catalog.cardinality(v_intent.temporary_role_grant_ids) > 0
                )
                AND NOT (
                  v_intent.state = 'open'
                  AND v_intent.mutation_token IS NULL
                  AND v_intent.last_delivery_outcome = 'retry'
                  AND public.commerce_role_delivery_contract_state(v_intent.id) = 'live'
                )
              )
            )
          )
        )
      )
      OR (v_is_cleanup AND v_intent.cleanup_mutation_token IS NOT NULL)
    ) THEN
      v_failure := 'Stale role-delivery claim requires exact operator cleanup';
      UPDATE public.commerce_role_delivery_intents
         SET state = 'operator_required',
             last_delivery_mutation_token = CASE
               WHEN v_is_origin AND mutation_token IS NOT NULL
                 THEN mutation_token ELSE last_delivery_mutation_token END,
             last_delivery_outcome = CASE
               WHEN v_is_origin AND mutation_token IS NOT NULL
                 THEN 'retry' ELSE last_delivery_outcome END,
             mutation_token = CASE WHEN v_is_origin THEN NULL ELSE mutation_token END,
             mutation_started_at = CASE
               WHEN v_is_origin THEN NULL ELSE mutation_started_at END,
             last_cleanup_mutation_token = CASE
               WHEN v_is_cleanup AND cleanup_mutation_token IS NOT NULL
                 THEN cleanup_mutation_token ELSE last_cleanup_mutation_token END,
             last_cleanup_outcome = CASE
               WHEN v_is_cleanup AND cleanup_mutation_token IS NOT NULL
                 THEN 'retry' ELSE last_cleanup_outcome END,
             cleanup_mutation_token = CASE
               WHEN v_is_cleanup THEN NULL ELSE cleanup_mutation_token END,
             cleanup_mutation_started_at = CASE
               WHEN v_is_cleanup THEN NULL ELSE cleanup_mutation_started_at END,
             last_error = v_failure,
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
       RETURNING * INTO v_intent;
      UPDATE public.bot_action_queue
         SET status = 'failed', completed_at = pg_catalog.clock_timestamp(),
             error_message = v_failure
       WHERE id = v_action.id AND status = 'processing'
         AND claim_token = v_action.claim_token;
      PERFORM public.commerce_signal_role_delivery_intent(v_intent.id, v_failure);
      v_disposition := 'operator_held';
    ELSIF v_action.retry_count < p_max_retries THEN
      UPDATE public.bot_action_queue
         SET status = 'pending', started_at = NULL,
             retry_count = retry_count + 1,
             error_message = 'Stale processing recovery: requeued',
             next_retry_at = NULL
       WHERE id = v_action.id AND status = 'processing'
         AND claim_token = v_action.claim_token;
      v_disposition := 'requeued';
    ELSE
      v_failure := 'Stale processing recovery: retry budget exhausted';
      UPDATE public.bot_action_queue
         SET status = 'failed', completed_at = pg_catalog.clock_timestamp(),
             error_message = v_failure
       WHERE id = v_action.id AND status = 'processing'
         AND claim_token = v_action.claim_token;
      v_disposition := 'failed';
    END IF;

    IF v_disposition IN ('failed', 'operator_held') THEN
      INSERT INTO public.action_queue_dlq (
        guild_id, action, payload, error_message, retry_count, max_retries,
        original_id, failed_at, lane
      )
      SELECT v_action.guild_id, v_action.action, v_action.payload,
             COALESCE(v_failure, v_action.error_message), v_action.retry_count,
             p_max_retries, v_action.id::TEXT, pg_catalog.clock_timestamp(),
             v_action.lane
      WHERE NOT EXISTS (
        SELECT 1 FROM public.action_queue_dlq AS dlq
         WHERE dlq.original_id = v_action.id::TEXT
           AND dlq.retried IS NOT TRUE
      )
      ON CONFLICT DO NOTHING;
      IF v_action.action = 'deliver_receipt' THEN
        INSERT INTO public.alerts (
          guild_id, alert_type, severity, title, message, metadata, resolved
        ) VALUES (
          v_action.guild_id, 'receipt_delivery_failed', 'critical',
          'Paid receipt delivery failed',
          'A paid receipt action exhausted its retry budget. Inspect the dead-letter queue and retry the exact action.',
          pg_catalog.jsonb_build_object(
            'action_id', v_action.id,
            'next_step', 'inspect_action_queue_dlq'
          ), false
        ) ON CONFLICT DO NOTHING;
      END IF;
    END IF;

    RETURN QUERY SELECT v_action.id, v_action.action, v_disposition;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_recover_stale(
  TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_action_queue_recover_stale(
  TEXT, INTEGER, INTEGER
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_retry_role_delivery_dlq(
  p_dlq_id UUID,
  p_guild_id TEXT
)
RETURNS TABLE (action_id UUID, action_status TEXT, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed_dlq public.action_queue_dlq%ROWTYPE;
  v_dlq public.action_queue_dlq%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_observed_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_action_id UUID;
  v_binding_count INTEGER := 0;
  v_is_origin BOOLEAN := false;
  v_is_cleanup BOOLEAN := false;
  v_contract_state TEXT;
  v_unbound_valid BOOLEAN := false;
  v_intent_recovered BOOLEAN := false;
BEGIN
  IF p_dlq_id IS NULL OR p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_retry_role_delivery_dlq: exact guild/DLQ identity is required';
  END IF;
  SELECT dlq.* INTO v_observed_dlq
    FROM public.action_queue_dlq AS dlq
   WHERE dlq.id = p_dlq_id;
  IF NOT FOUND
     OR v_observed_dlq.guild_id IS DISTINCT FROM p_guild_id
     OR v_observed_dlq.original_id IS NULL
     OR v_observed_dlq.original_id !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_retry_role_delivery_dlq: DLQ is not an exact carrier';
  END IF;
  v_action_id := v_observed_dlq.original_id::UUID;

  SELECT pg_catalog.count(*)::INTEGER
    INTO v_binding_count
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.action_id = v_action_id
      OR intent.cleanup_action_id = v_action_id;
  IF v_binding_count > 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_retry_role_delivery_dlq: carrier binding is cross-linked';
  END IF;
  IF v_binding_count = 1 THEN
    SELECT intent.* INTO v_observed_intent
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.action_id = v_action_id
        OR intent.cleanup_action_id = v_action_id;
  END IF;

  IF v_observed_intent.id IS NOT NULL THEN
    PERFORM 1 FROM public.orders AS paid_order
     WHERE paid_order.id = v_observed_intent.order_id FOR SHARE;
    PERFORM 1 FROM public.customers AS customer
     WHERE customer.id = v_observed_intent.customer_id FOR SHARE;
    PERFORM 1 FROM public.temp_role_grants AS grant_row
     WHERE grant_row.id = ANY(
       v_observed_intent.reserved_temp_role_grant_ids
         || v_observed_intent.temporary_role_grant_ids
     )
     ORDER BY grant_row.id FOR UPDATE;
    PERFORM 1 FROM public.entitlements AS entitlement
     WHERE entitlement.id = v_observed_intent.entitlement_id FOR SHARE;
    SELECT intent.* INTO v_intent
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.id = v_observed_intent.id
       AND (intent.action_id = v_action_id OR intent.cleanup_action_id = v_action_id)
     FOR UPDATE;
  END IF;
  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = v_action_id
   FOR UPDATE;

  -- With no observed binding, the action row is the same gap lock used by
  -- begin-delivery. Serialize the cross-column binding trigger only after that
  -- row lock, then recheck in a fresh statement. A concurrent begin either
  -- commits first and makes this retry stale, or waits until this transaction
  -- has reopened the same carrier; stale binding=0 evidence is never used.
  IF v_observed_intent.id IS NULL AND v_action.id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'commerce-role-delivery-action:' || v_action.id::TEXT,
        0
      )
    );
    SELECT pg_catalog.count(*)::INTEGER
      INTO v_binding_count
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.action_id = v_action.id
        OR intent.cleanup_action_id = v_action.id;
    IF v_binding_count <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'commerce_retry_role_delivery_dlq: carrier binding changed concurrently';
    END IF;
  ELSIF v_observed_intent.id IS NOT NULL THEN
    SELECT pg_catalog.count(*)::INTEGER
      INTO v_binding_count
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.action_id = v_action_id
        OR intent.cleanup_action_id = v_action_id;
    IF v_binding_count <> 1 OR v_intent.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'commerce_retry_role_delivery_dlq: carrier binding changed concurrently';
    END IF;
  END IF;

  SELECT dlq.* INTO v_dlq
    FROM public.action_queue_dlq AS dlq
   WHERE dlq.id = p_dlq_id
   FOR UPDATE;

  IF v_action.id IS NULL OR v_dlq.id IS NULL
     OR v_action.guild_id IS DISTINCT FROM p_guild_id
     OR v_dlq.guild_id IS DISTINCT FROM p_guild_id
     OR v_dlq.original_id IS DISTINCT FROM v_action.id::TEXT
     OR v_dlq.action IS DISTINCT FROM v_action.action
     OR v_dlq.payload IS DISTINCT FROM v_action.payload
     OR v_dlq.lane IS DISTINCT FROM v_action.lane
     OR v_action.lane <> 'commerce'
     OR v_action.action NOT IN (
       'fulfill_purchase', 'fulfill_subscription', 'reconcile_entitlement_roles'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_retry_role_delivery_dlq: carrier identity is cross-linked';
  END IF;

  IF v_intent.id IS NOT NULL
     AND v_intent.guild_id IS DISTINCT FROM p_guild_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_retry_role_delivery_dlq: intent guild is cross-linked';
  END IF;

  IF v_intent.id IS NULL THEN
    v_unbound_valid :=
      pg_catalog.jsonb_typeof(v_action.payload) = 'object'
      AND v_action.payload ->> 'guild_id' = v_action.guild_id
      AND (
        (
          v_action.action = 'fulfill_purchase'
          AND v_action.payload ->> 'fulfillment_type' = 'one_time_purchase'
          AND v_action.payload ->> 'entitlement_type' = 'one_time'
          AND v_action.payload ->> 'customer_id' ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          AND v_action.payload ->> 'product_id' ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          AND v_action.payload ->> 'order_id' ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          AND v_action.payload ->> 'discord_id' ~ '^[0-9]{17,20}$'
          AND v_action.payload ->> 'product_name' = pg_catalog.btrim(
            v_action.payload ->> 'product_name'
          )
          AND v_action.payload ->> 'product_name' <> ''
          AND v_action.payload ->> 'order_number' = pg_catalog.btrim(
            v_action.payload ->> 'order_number'
          )
          AND v_action.payload ->> 'order_number' <> ''
          AND pg_catalog.jsonb_typeof(v_action.payload -> 'amount_cents') = 'number'
          AND v_action.payload ->> 'amount_cents' ~ '^[1-9][0-9]*$'
          AND v_action.payload ->> 'currency' ~ '^[A-Z]{3}$'
          AND (
            NOT (v_action.payload ? 'plan_id')
            OR v_action.payload -> 'plan_id' = 'null'::JSONB
          )
          AND (
            NOT (v_action.payload ? 'paypal_subscription_id')
            OR v_action.payload -> 'paypal_subscription_id' = 'null'::JSONB
          )
          AND CASE
            WHEN pg_catalog.jsonb_typeof(
              v_action.payload -> 'granted_role_ids'
            ) = 'array' THEN
              public.commerce_valid_snowflake_snapshot(ARRAY(
                SELECT role_value
                  FROM pg_catalog.jsonb_array_elements_text(
                    v_action.payload -> 'granted_role_ids'
                  ) AS role(role_value)
              ))
              AND v_action.payload -> 'granted_role_ids' = pg_catalog.to_jsonb(
                public.commerce_canonical_snowflake_snapshot(ARRAY(
                  SELECT role_value
                    FROM pg_catalog.jsonb_array_elements_text(
                      v_action.payload -> 'granted_role_ids'
                    ) AS role(role_value)
                ))
              )
            ELSE false
          END
          AND CASE
            WHEN pg_catalog.jsonb_typeof(
              v_action.payload -> 'granted_channel_ids'
            ) = 'array' THEN
              public.commerce_valid_snowflake_snapshot(ARRAY(
                SELECT channel_value
                  FROM pg_catalog.jsonb_array_elements_text(
                    v_action.payload -> 'granted_channel_ids'
                  ) AS channel(channel_value)
              ))
              AND v_action.payload -> 'granted_channel_ids' = pg_catalog.to_jsonb(
                public.commerce_canonical_snowflake_snapshot(ARRAY(
                  SELECT channel_value
                    FROM pg_catalog.jsonb_array_elements_text(
                      v_action.payload -> 'granted_channel_ids'
                    ) AS channel(channel_value)
                ))
              )
            ELSE false
          END
          AND CASE
            WHEN NOT (v_action.payload ? 'temporary_role_grants')
              OR v_action.payload -> 'temporary_role_grants' = 'null'::JSONB
              THEN true
            ELSE public.commerce_valid_temp_role_snapshot(
              v_action.payload -> 'temporary_role_grants'
            )
          END
        )
        OR (
          v_action.action = 'fulfill_subscription'
          AND v_action.payload ->> 'fulfillment_type' IN (
            'subscription_activated', 'subscription_renewed'
          )
          AND v_action.payload ->> 'entitlement_type' = 'subscription'
          AND v_action.payload ->> 'customer_id' ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          AND v_action.payload ->> 'product_id' ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          AND v_action.payload ->> 'order_id' ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          AND v_action.payload ->> 'plan_id' ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          AND v_action.payload ->> 'discord_id' ~ '^[0-9]{17,20}$'
          AND v_action.payload ->> 'paypal_subscription_id'
            ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
          AND v_action.payload ->> 'product_name' = pg_catalog.btrim(
            v_action.payload ->> 'product_name'
          )
          AND v_action.payload ->> 'product_name' <> ''
          AND v_action.payload ->> 'order_number' = pg_catalog.btrim(
            v_action.payload ->> 'order_number'
          )
          AND v_action.payload ->> 'order_number' <> ''
          AND pg_catalog.jsonb_typeof(v_action.payload -> 'amount_cents') = 'number'
          AND v_action.payload ->> 'amount_cents' ~ '^[1-9][0-9]*$'
          AND v_action.payload ->> 'currency' ~ '^[A-Z]{3}$'
          AND (
            v_action.payload ->> 'fulfillment_type' <> 'subscription_renewed'
            OR v_action.payload ->> 'existing_entitlement_id' ~
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          )
          AND CASE
            WHEN pg_catalog.jsonb_typeof(
              v_action.payload -> 'granted_role_ids'
            ) = 'array' THEN
              public.commerce_valid_snowflake_snapshot(ARRAY(
                SELECT role_value
                  FROM pg_catalog.jsonb_array_elements_text(
                    v_action.payload -> 'granted_role_ids'
                  ) AS role(role_value)
              ))
              AND v_action.payload -> 'granted_role_ids' = pg_catalog.to_jsonb(
                public.commerce_canonical_snowflake_snapshot(ARRAY(
                  SELECT role_value
                    FROM pg_catalog.jsonb_array_elements_text(
                      v_action.payload -> 'granted_role_ids'
                    ) AS role(role_value)
                ))
              )
            ELSE false
          END
          AND CASE
            WHEN pg_catalog.jsonb_typeof(
              v_action.payload -> 'granted_channel_ids'
            ) = 'array' THEN
              public.commerce_valid_snowflake_snapshot(ARRAY(
                SELECT channel_value
                  FROM pg_catalog.jsonb_array_elements_text(
                    v_action.payload -> 'granted_channel_ids'
                  ) AS channel(channel_value)
              ))
              AND v_action.payload -> 'granted_channel_ids' = pg_catalog.to_jsonb(
                public.commerce_canonical_snowflake_snapshot(ARRAY(
                  SELECT channel_value
                    FROM pg_catalog.jsonb_array_elements_text(
                      v_action.payload -> 'granted_channel_ids'
                    ) AS channel(channel_value)
                ))
              )
            ELSE false
          END
          AND (
            NOT (v_action.payload ? 'temporary_role_grants')
            OR v_action.payload -> 'temporary_role_grants' IN (
              'null'::JSONB, '[]'::JSONB
            )
          )
        )
        OR (
          v_action.action = 'reconcile_entitlement_roles'
          AND (
            (
              v_action.payload ->> 'mode' = 'ensure_live_request'
              AND v_action.payload ->> 'action_id' = v_action.id::TEXT
              AND v_action.payload ->> 'entitlement_id' ~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              AND v_action.payload ->> 'customer_id' ~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              AND v_action.payload ->> 'old_discord_id' ~ '^[0-9]{17,20}$'
              AND v_action.payload ->> 'discord_id' ~ '^[0-9]{17,20}$'
              AND v_action.idempotency_key =
                'commerce-role-delivery-relink:'
                || (v_action.payload ->> 'customer_id') || ':'
                || (v_action.payload ->> 'old_discord_id') || ':'
                || (v_action.payload ->> 'discord_id') || ':'
                || (v_action.payload ->> 'entitlement_id')
              AND v_action.payload = pg_catalog.jsonb_build_object(
                'mode', 'ensure_live_request',
                'action_id', v_action.id,
                'guild_id', v_action.guild_id,
                'entitlement_id', v_action.payload -> 'entitlement_id',
                'customer_id', v_action.payload -> 'customer_id',
                'old_discord_id', v_action.payload -> 'old_discord_id',
                'discord_id', v_action.payload -> 'discord_id'
              )
            )
            OR (
              v_action.payload ->> 'mode' = 'ensure_live'
              AND v_action.payload ->> 'action_id' = v_action.id::TEXT
              AND v_action.payload ->> 'entitlement_id' ~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              AND v_action.payload ->> 'customer_id' ~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              AND v_action.payload ->> 'order_id' ~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              AND v_action.payload ->> 'product_id' ~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              AND v_action.payload ->> 'discord_id' ~ '^[0-9]{17,20}$'
              AND v_action.payload ->> 'entitlement_type'
                IN ('one_time', 'subscription')
              AND v_action.payload ->> 'entitlement_status'
                IN ('active', 'pending', 'grace_period', 'suspended')
              AND (
                v_action.payload ->> 'source' = 'purchase'
                OR v_action.payload -> 'source' = 'null'::JSONB
              )
              AND CASE
                WHEN pg_catalog.jsonb_typeof(
                  v_action.payload -> 'granted_role_ids'
                ) = 'array' THEN
                  public.commerce_valid_snowflake_snapshot(ARRAY(
                    SELECT role_value
                      FROM pg_catalog.jsonb_array_elements_text(
                        v_action.payload -> 'granted_role_ids'
                      ) AS role(role_value)
                  ))
                  AND v_action.payload -> 'granted_role_ids'
                    = pg_catalog.to_jsonb(
                    public.commerce_canonical_snowflake_snapshot(ARRAY(
                      SELECT role_value
                        FROM pg_catalog.jsonb_array_elements_text(
                          v_action.payload -> 'granted_role_ids'
                        ) AS role(role_value)
                    ))
                  )
                ELSE false
              END
              AND (
                (
                  v_action.payload ->> 'entitlement_type' = 'one_time'
                  AND v_action.payload -> 'plan_id' = 'null'::JSONB
                )
                OR (
                  v_action.payload ->> 'entitlement_type' = 'subscription'
                  AND v_action.payload ->> 'plan_id' ~
                    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
                )
              )
              AND v_action.idempotency_key LIKE
                'commerce-role-delivery-ensure:'
                || (v_action.payload ->> 'entitlement_id') || ':%'
              AND v_action.payload = pg_catalog.jsonb_build_object(
                'mode', 'ensure_live',
                'action_id', v_action.id,
                'guild_id', v_action.guild_id,
                'entitlement_id', v_action.payload -> 'entitlement_id',
                'customer_id', v_action.payload -> 'customer_id',
                'discord_id', v_action.payload -> 'discord_id',
                'order_id', v_action.payload -> 'order_id',
                'product_id', v_action.payload -> 'product_id',
                'plan_id', v_action.payload -> 'plan_id',
                'entitlement_type', v_action.payload -> 'entitlement_type',
                'source', v_action.payload -> 'source',
                'entitlement_status', v_action.payload -> 'entitlement_status',
                'granted_role_ids', v_action.payload -> 'granted_role_ids'
              )
            )
          )
        )
      );
    IF NOT COALESCE(v_unbound_valid, false) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_retry_role_delivery_dlq: unbound carrier is not recoverable';
    END IF;
  END IF;

  -- The selected row, not merely some historical sibling, must still represent
  -- the current failed generation before state or retry counters can change.
  -- A concurrent duplicate retry therefore becomes a read-only idempotent hit.
  IF v_dlq.retried IS TRUE THEN
    RETURN QUERY SELECT v_action.id, v_action.status, CASE
      WHEN v_action.status IN ('pending', 'processing') THEN 'already_active'
      WHEN v_action.status = 'completed' THEN 'completed_from_evidence'
      ELSE 'operator_held'
    END::TEXT;
    RETURN;
  END IF;

  IF v_intent.id IS NULL AND v_action.status = 'completed' THEN
    UPDATE public.action_queue_dlq AS dlq
       SET retried = true,
           retried_at = COALESCE(dlq.retried_at, pg_catalog.clock_timestamp()),
           error_message = COALESCE(dlq.error_message || ' | ', '')
             || 'Converged from completed exact queue carrier'
     WHERE dlq.original_id = v_action.id::TEXT
       AND dlq.retried IS NOT TRUE;
    RETURN QUERY SELECT v_action.id, 'completed'::TEXT,
      'completed_from_evidence'::TEXT;
    RETURN;
  END IF;

  -- NULL-safe: cleanup_action_id is NULL for pure origin carriers; plain
  -- equality made v_is_cleanup NULL, so three-valued logic skipped every
  -- branch below and collapsed bound origin recovery into operator_held.
  v_is_origin := v_intent.action_id IS NOT DISTINCT FROM v_action.id;
  v_is_cleanup := v_intent.cleanup_action_id IS NOT DISTINCT FROM v_action.id;
  IF pg_catalog.cardinality(v_intent.reserved_role_ids) > 0
     OR pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) > 0
     OR v_intent.mutation_token IS NOT NULL
     OR v_intent.cleanup_mutation_token IS NOT NULL THEN
    RETURN QUERY SELECT v_action.id, v_action.status, 'operator_held'::TEXT;
    RETURN;
  END IF;

  IF (
       v_is_origin
       AND (
         (
           v_intent.state = 'open'
           AND v_intent.delivery_confirmed_at IS NOT NULL
           AND v_intent.last_delivery_outcome = 'live'
         )
         OR v_intent.state = 'settled'
       )
     ) OR (v_is_cleanup AND v_intent.state = 'settled') THEN
    UPDATE public.bot_action_queue
       SET status = 'completed',
           claim_token = NULL,
           completed_at = COALESCE(completed_at, pg_catalog.clock_timestamp()),
           error_message = NULL,
           next_retry_at = NULL
     WHERE id = v_action.id;
    UPDATE public.action_queue_dlq AS dlq
       SET retried = true,
           retried_at = COALESCE(dlq.retried_at, pg_catalog.clock_timestamp()),
           error_message = COALESCE(dlq.error_message || ' | ', '')
             || 'Converged from exact durable role-delivery evidence'
     WHERE dlq.original_id = v_action.id::TEXT
       AND dlq.retried IS NOT TRUE;
    RETURN QUERY SELECT v_action.id, 'completed'::TEXT,
      'completed_from_evidence'::TEXT;
    RETURN;
  END IF;

  IF v_is_origin AND NOT v_is_cleanup THEN
    IF v_intent.state <> 'operator_required'
       OR v_intent.delivery_confirmed_at IS NOT NULL
       OR v_intent.cleanup_action_id IS NOT NULL
       OR v_intent.cleanup_claim_token IS NOT NULL
       OR v_intent.last_delivery_mutation_token IS NULL
       OR v_intent.last_delivery_outcome <> 'retry'
       OR v_action.status NOT IN ('failed', 'staged', 'pending', 'processing') THEN
      RETURN QUERY SELECT v_action.id, v_action.status, 'operator_held'::TEXT;
      RETURN;
    END IF;
    v_contract_state :=
      public.commerce_role_delivery_business_contract_state(v_intent.id);
    IF v_contract_state <> 'live' THEN
      RETURN QUERY SELECT v_action.id, v_action.status, 'operator_held'::TEXT;
      RETURN;
    END IF;
    PERFORM pg_catalog.set_config(
      'somnibot.commerce_role_delivery_recovery_intent_id',
      v_intent.id::TEXT,
      true
    );
    UPDATE public.commerce_role_delivery_intents
       SET state = 'open',
           recovery_generation = recovery_generation + 1,
           last_error = NULL,
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
        AND state = 'operator_required'
        AND delivery_confirmed_at IS NULL
        AND mutation_token IS NULL
        AND mutation_started_at IS NULL
        AND cleanup_action_id IS NULL
        AND cleanup_claim_token IS NULL
        AND cleanup_mutation_token IS NULL
        AND cleanup_mutation_started_at IS NULL
         AND pg_catalog.cardinality(reserved_role_ids) = 0
         AND pg_catalog.cardinality(reserved_temp_role_grant_ids) = 0
         AND last_delivery_mutation_token IS NOT NULL
         AND last_delivery_outcome = 'retry'
      RETURNING * INTO v_intent;
    v_intent_recovered := FOUND;
    PERFORM pg_catalog.set_config(
      'somnibot.commerce_role_delivery_recovery_intent_id', '', true
    );
    IF NOT v_intent_recovered THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'commerce_retry_role_delivery_dlq: intent recovery raced';
    END IF;
  ELSIF v_is_cleanup THEN
    IF v_intent.state NOT IN ('cleanup_required', 'operator_required')
       OR v_intent.cleanup_action_id IS DISTINCT FROM v_action.id
       OR v_action.status NOT IN ('failed', 'staged', 'pending', 'processing') THEN
      RETURN QUERY SELECT v_action.id, v_action.status, 'operator_held'::TEXT;
      RETURN;
    END IF;
  ELSIF v_intent.id IS NULL THEN
    IF v_action.status NOT IN ('failed', 'staged', 'pending', 'processing') THEN
      RETURN QUERY SELECT v_action.id, v_action.status, 'operator_held'::TEXT;
      RETURN;
    END IF;
  ELSE
    RETURN QUERY SELECT v_action.id, v_action.status, 'operator_held'::TEXT;
    RETURN;
  END IF;

  IF v_action.status IN ('failed', 'staged') THEN
    UPDATE public.bot_action_queue AS queue
       SET status = 'pending',
           claim_token = NULL,
           started_at = NULL,
           completed_at = NULL,
           error_message = NULL,
           next_retry_at = NULL,
           retry_count = queue.retry_count + 1
     WHERE queue.id = v_action.id
       AND queue.status = v_action.status
     RETURNING queue.* INTO v_action;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'commerce_retry_role_delivery_dlq: queue recovery raced';
    END IF;
  END IF;

  UPDATE public.action_queue_dlq AS dlq
     SET retried = true,
         retried_at = COALESCE(dlq.retried_at, pg_catalog.clock_timestamp()),
         error_message = COALESCE(dlq.error_message || ' | ', '')
           || 'Reopened exact same role-delivery carrier'
   WHERE dlq.original_id = v_action.id::TEXT
     AND dlq.retried IS NOT TRUE;

  RETURN QUERY SELECT v_action.id, v_action.status,
    CASE WHEN v_action.status = 'processing'
      THEN 'already_active' ELSE 'reopened' END::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_retry_role_delivery_dlq(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_retry_role_delivery_dlq(UUID, TEXT)
  TO service_role;

-- Generic DLQ replay is an atomic clone-and-retire operation. Exact commerce
-- role-delivery carriers are excluded because their queue UUID is protocol
-- identity and must be reopened in place by commerce_retry_role_delivery_dlq.
-- Missing, wrong-guild, and already-retried rows deliberately share one opaque
-- no-op result so cross-tenant identity is not disclosed.
CREATE OR REPLACE FUNCTION public.bot_action_queue_retry_dlq(
  p_dlq_id UUID,
  p_guild_id TEXT
)
RETURNS TABLE (action_id UUID, action_status TEXT, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dlq public.action_queue_dlq%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_action_id UUID;
  v_noncommerce_kind TEXT;
  v_disposition TEXT;
BEGIN
  IF p_dlq_id IS NULL OR p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'bot_action_queue_retry_dlq: exact retry identity is required';
  END IF;

  SELECT dlq.* INTO v_dlq
    FROM public.action_queue_dlq AS dlq
   WHERE dlq.id = p_dlq_id
     AND dlq.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND OR v_dlq.retried IS TRUE THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, 'already_retried'::TEXT;
    RETURN;
  END IF;

  -- Historical-target non-commerce revocations share the same queue UUID for
  -- every retry. Generic clone-and-retire would create an unkeyed forged
  -- removal path and sever the delete/purge proof from its original carrier.
   IF v_dlq.payload ->> 'source' IN (
        'noncommerce_entitlement_status_trigger',
        'noncommerce_entitlement_customer_relink_trigger',
        'noncommerce_entitlement_activation_trigger'
      ) THEN
    IF v_dlq.original_id IS NULL OR v_dlq.original_id !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'bot_action_queue_retry_dlq: noncommerce carrier identity is malformed';
    END IF;
    SELECT queue.* INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.id = v_dlq.original_id::UUID
     FOR UPDATE;
    v_noncommerce_kind := public.commerce_noncommerce_cleanup_carrier_kind(
      v_action.guild_id,
      v_action.action,
      v_action.lane,
      v_action.idempotency_key,
      v_action.payload
    );
    IF v_action.id IS NULL
       OR v_noncommerce_kind IS NULL
       OR v_action.guild_id IS DISTINCT FROM v_dlq.guild_id
       OR v_action.action IS DISTINCT FROM v_dlq.action
       OR v_action.lane IS DISTINCT FROM v_dlq.lane
       OR v_action.payload IS DISTINCT FROM v_dlq.payload THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'bot_action_queue_retry_dlq: noncommerce carrier is cross-linked';
    END IF;

    IF v_action.status IN ('failed', 'staged') THEN
      UPDATE public.bot_action_queue AS queue
         SET status = 'pending',
             claim_token = NULL,
             started_at = NULL,
             completed_at = NULL,
             error_message = NULL,
             next_retry_at = NULL,
             retry_count = queue.retry_count + 1
       WHERE queue.id = v_action.id
         AND queue.status = v_action.status
       RETURNING queue.* INTO v_action;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001',
          MESSAGE = 'bot_action_queue_retry_dlq: noncommerce retry raced';
      END IF;
      v_disposition := 'reopened';
    ELSIF v_action.status = 'completed' THEN
      v_disposition := 'already_completed';
    ELSIF v_action.status IN ('pending', 'processing') THEN
      v_disposition := 'already_active';
    ELSE
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'bot_action_queue_retry_dlq: noncommerce status is invalid';
    END IF;

    UPDATE public.action_queue_dlq AS dlq
       SET retried = true,
           retried_at = COALESCE(
             dlq.retried_at,
             pg_catalog.clock_timestamp()
           ),
           error_message = COALESCE(dlq.error_message || ' | ', '')
             || CASE v_disposition
               WHEN 'already_completed' THEN
                 'Retired after exact noncommerce cleanup completed'
               ELSE 'Reopened exact same noncommerce cleanup carrier'
             END
     WHERE dlq.original_id = v_action.id::TEXT
       AND dlq.guild_id = v_action.guild_id
       AND dlq.action = v_action.action
       AND dlq.lane = v_action.lane
       AND dlq.payload = v_action.payload
       AND dlq.retried IS NOT TRUE;

    RETURN QUERY SELECT v_action.id, v_action.status, v_disposition;
    RETURN;
  END IF;

  IF v_dlq.action IN (
       'fulfill_purchase', 'fulfill_subscription', 'reconcile_entitlement_roles'
     ) THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, 'exact_carrier_required'::TEXT;
    RETURN;
  END IF;
  IF v_dlq.action IS NULL OR v_dlq.action = ''
     OR v_dlq.payload IS NULL
     OR v_dlq.lane IS DISTINCT FROM
       public.bot_action_queue_lane_for_action(v_dlq.action) THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, 'invalid_carrier'::TEXT;
    RETURN;
  END IF;

  v_action_id := gen_random_uuid();
  INSERT INTO public.bot_action_queue (
    id, guild_id, action, payload, status, retry_count, lane
  ) VALUES (
    v_action_id,
    v_dlq.guild_id,
    v_dlq.action,
    v_dlq.payload,
    'pending',
    0,
    v_dlq.lane
  );

  UPDATE public.action_queue_dlq AS dlq
     SET retried = true,
         retried_at = COALESCE(dlq.retried_at, pg_catalog.clock_timestamp())
   WHERE dlq.id = v_dlq.id
     AND dlq.guild_id = p_guild_id
     AND dlq.retried IS NOT TRUE;
  IF NOT FOUND THEN
    -- This should be unreachable while the row lock is held. Raising rolls the
    -- replacement insert back instead of orphaning a duplicate carrier.
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'bot_action_queue_retry_dlq: retry generation changed concurrently';
  END IF;

  RETURN QUERY SELECT v_action_id, 'pending'::TEXT, 'requeued'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_retry_dlq(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_action_queue_retry_dlq(UUID, TEXT)
  TO service_role;

CREATE TABLE IF NOT EXISTS public.commerce_product_temp_role_config (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       UUID        NOT NULL,
  guild_id         TEXT        NOT NULL,
  role_id          TEXT        NOT NULL,
  duration_seconds INTEGER     NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commerce_product_temp_role_config_product_role_unique
    UNIQUE (product_id, role_id),
  CONSTRAINT commerce_product_temp_role_config_role_snowflake
    CHECK (role_id ~ '^[0-9]{17,20}$'),
  CONSTRAINT commerce_product_temp_role_config_duration_bounds
    CHECK (duration_seconds > 0 AND duration_seconds <= 315360000),
  CONSTRAINT commerce_product_temp_role_config_product_guild_fk
    FOREIGN KEY (product_id, guild_id)
    REFERENCES public.products (id, guild_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_commerce_product_temp_role_config_guild
  ON public.commerce_product_temp_role_config (guild_id, product_id, role_id);

-- Typed-config inserts lock their exact parent before the income-wall trigger
-- takes a guild advisory lock. This gives inserts the same parent -> advisory
-- order as product movement, including the otherwise invisible-uncommitted-
-- child case. Direct identity updates are forbidden: only the nested product
-- movement trigger below may carry an existing config row to the product's
-- new guild. Duration/role edits keep their child -> advisory order and never
-- need the parent FK key, so they cannot complete the opposite side of a
-- parent/child cycle.
CREATE OR REPLACE FUNCTION public.commerce_guard_temp_role_config_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM public.products AS product
     WHERE product.id = NEW.product_id
       AND product.guild_id = NEW.guild_id
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'commerce temporary-role config product identity mismatch';
    END IF;
  ELSIF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce temporary-role config product identity is immutable';
  ELSIF NEW.guild_id IS DISTINCT FROM OLD.guild_id
        AND pg_catalog.pg_trigger_depth() <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce temporary-role config guild follows its product';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_guard_temp_role_config_identity()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_00a_guard_temp_role_config_insert
  ON public.commerce_product_temp_role_config;
CREATE TRIGGER commerce_00a_guard_temp_role_config_insert
  BEFORE INSERT ON public.commerce_product_temp_role_config
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_temp_role_config_identity();

DROP TRIGGER IF EXISTS commerce_00b_guard_temp_role_config_update
  ON public.commerce_product_temp_role_config;
CREATE TRIGGER commerce_00b_guard_temp_role_config_update
  BEFORE UPDATE OF product_id, guild_id ON public.commerce_product_temp_role_config
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_temp_role_config_identity();

-- Preserve product/config tenant identity without the mixed lock inversion of
-- a referential ON UPDATE CASCADE. PostgreSQL locks the product tuple before
-- BEFORE ROW triggers; this trigger then locks every child row in UUID order
-- before child wall triggers acquire guild advisory locks. A concurrent child
-- writer can therefore finish and release its advisory lock without waiting
-- on the product row, while the deferred FK validates the final parent/child
-- guild pair at commit.
CREATE OR REPLACE FUNCTION public.commerce_move_product_temp_role_config()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.guild_id IS DISTINCT FROM OLD.guild_id THEN
    PERFORM 1
      FROM public.commerce_product_temp_role_config AS temporary
     WHERE temporary.product_id = OLD.id
       AND temporary.guild_id = OLD.guild_id
     ORDER BY temporary.id
     FOR UPDATE;

    UPDATE public.commerce_product_temp_role_config AS temporary
       SET guild_id = NEW.guild_id,
           updated_at = pg_catalog.now()
     WHERE temporary.product_id = OLD.id
       AND temporary.guild_id = OLD.guild_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_move_product_temp_role_config()
  FROM PUBLIC, anon, authenticated, service_role;

-- PostgreSQL orders same-event triggers by name. The 00 prefix guarantees the
-- child rows are locked before commerce_income_wall_products_lock acquires the
-- old/new guild advisory locks.
DROP TRIGGER IF EXISTS commerce_00_move_product_temp_role_config
  ON public.products;
CREATE TRIGGER commerce_00_move_product_temp_role_config
  BEFORE UPDATE OF guild_id ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_move_product_temp_role_config();

CREATE TABLE IF NOT EXISTS public.commerce_role_metadata_migration_issues (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID        NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  guild_id    TEXT        NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  role_id     TEXT,
  issue_type  TEXT        NOT NULL CHECK (issue_type IN (
     'invalid_role_id',
     'invalid_duration',
     'orphan_duration',
     'unsupported_product_type',
    'ambiguous_permanent_history',
    'ambiguous_historical_role',
    'invalid_historical_roles'
  )),
  details     JSONB       NOT NULL DEFAULT '{}'::JSONB,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_commerce_role_metadata_migration_issue
  ON public.commerce_role_metadata_migration_issues (
    product_id,
    issue_type,
    COALESCE(role_id, '')
  );

CREATE INDEX IF NOT EXISTS idx_commerce_role_metadata_migration_issues_open
  ON public.commerce_role_metadata_migration_issues (guild_id, created_at)
  WHERE resolved_at IS NULL;

ALTER TABLE public.commerce_product_temp_role_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_role_metadata_migration_issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_all ON public.commerce_product_temp_role_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON public.commerce_role_metadata_migration_issues
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.commerce_product_temp_role_config
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.commerce_role_metadata_migration_issues
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.commerce_product_temp_role_config
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.commerce_role_metadata_migration_issues
  TO service_role;

-- (temp_role_grants provenance columns are added near the top of this file:
-- the LANGUAGE sql owner/lifecycle functions above validate their bodies at
-- creation time, so the columns must exist before those definitions run.)

-- IF NOT EXISTS may have preserved the earlier two-state check from a partial
-- migration attempt. Normalize it before any sweeper writes tombstones.
ALTER TABLE public.temp_role_grants
  DROP CONSTRAINT IF EXISTS temp_role_grants_grant_status_check;
ALTER TABLE public.temp_role_grants
  ADD CONSTRAINT temp_role_grants_grant_status_check
  CHECK (grant_status IN ('pending', 'applied', 'removed'));

UPDATE public.temp_role_grants
   SET applied_at = COALESCE(applied_at, created_at),
       updated_at = COALESCE(updated_at, created_at)
 WHERE grant_status = 'applied';

ALTER TABLE public.temp_role_grants
  DROP CONSTRAINT IF EXISTS temp_role_grants_commerce_lifecycle_check;
ALTER TABLE public.temp_role_grants
  ADD CONSTRAINT temp_role_grants_commerce_lifecycle_check
  CHECK (
    order_id IS NULL
    OR (
      order_id IS NOT NULL
      AND source_id IS NOT NULL
      AND pg_catalog.btrim(source_id) <> ''
      AND duration_seconds IS NOT NULL
      AND duration_seconds > 0
      AND duration_seconds <= 315360000
      AND (
        (
          source IS NOT DISTINCT FROM 'commerce_purchase'
          AND grant_status IS NOT DISTINCT FROM 'pending'
          AND applied_at IS NULL
        )
        OR (
          source IS NOT DISTINCT FROM 'commerce_purchase'
          AND grant_status IS NOT DISTINCT FROM 'applied'
          AND applied_at IS NOT NULL
          AND expires_at = applied_at + (duration_seconds * interval '1 second')
        )
        OR (
          source IS NOT DISTINCT FROM 'commerce_reconciled'
          AND grant_status IS NOT DISTINCT FROM 'removed'
          AND (
            applied_at IS NULL
            OR expires_at = applied_at + (duration_seconds * interval '1 second')
          )
        )
      )
    )
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_temp_role_grants_commerce_order_role
  ON public.temp_role_grants (order_id, role_id)
  WHERE order_id IS NOT NULL;

-- Order-backed temporary-role provenance is a state machine, not a mutable
-- service-role scratch row. Inserts prove the exact paid parent before the row
-- exists; updates keep identity immutable and permit only bookkeeping,
-- acknowledgement, or retirement transitions used below. The UPDATE path uses
-- MVCC parent reads (not parent row locks) because PostgreSQL has already
-- locked the child before a BEFORE UPDATE trigger; refund finalizers then lock
-- order -> child and independently revalidate the row after any wait.
CREATE OR REPLACE FUNCTION public.commerce_guard_order_backed_temp_role_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_discord_id TEXT;
  v_reference_count INTEGER := 0;
  v_reservation_count INTEGER := 0;
  v_retirement_owner NAME;
  v_retirement_scope TEXT;
  v_cleanup_retirement_owner NAME;
  v_cleanup_retirement_grant_scope TEXT;
  v_cleanup_retirement_intent_scope TEXT;
  v_cleanup_retirement_mutation_scope TEXT;
  v_authority_reference_count INTEGER := 0;
  v_confirmation_owner NAME;
  v_confirmation_grant_scope TEXT;
  v_confirmation_intent_scope TEXT;
  v_confirmation_mutation_scope TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (OLD.order_id IS NOT NULL OR NEW.order_id IS NOT NULL)
     AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce temporary-role provenance order identity is immutable';
  END IF;

  IF NEW.order_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.order_id IS NULL
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.guild_id IS DISTINCT FROM OLD.guild_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.role_id IS DISTINCT FROM OLD.role_id
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce temporary-role provenance identity is immutable';
    END IF;

    -- remove_on_expiry is confirmed removal authority. It can only be minted
    -- by the pending -> applied promotion while one exact live delivery intent
    -- owns the matching provisional reservation. Manual-baseline ACK remains
    -- false; applied -> applied escalation and true -> false authority release
    -- are both forbidden to raw service-role DML.
    IF NOT OLD.remove_on_expiry AND NEW.remove_on_expiry THEN
      SELECT pg_catalog.pg_get_userbyid(proc.proowner)
        INTO v_confirmation_owner
        FROM pg_catalog.pg_proc AS proc
       WHERE proc.oid = pg_catalog.to_regprocedure(
         'public.commerce_confirm_temp_role_delivery(uuid,uuid,uuid,text)'
       );
      v_confirmation_grant_scope := pg_catalog.current_setting(
        'somnibot.commerce_temp_confirmation_grant_id', true
      );
      v_confirmation_intent_scope := pg_catalog.current_setting(
        'somnibot.commerce_temp_confirmation_intent_id', true
      );
      v_confirmation_mutation_scope := pg_catalog.current_setting(
        'somnibot.commerce_temp_confirmation_mutation_token', true
      );
      IF OLD.grant_status <> 'pending'
         OR OLD.source <> 'commerce_purchase'
         OR NEW.grant_status <> 'applied'
         OR NEW.source <> 'commerce_purchase'
         OR v_confirmation_owner IS NULL
         OR current_user IS DISTINCT FROM v_confirmation_owner
         OR v_confirmation_grant_scope IS DISTINCT FROM NEW.id::TEXT THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce temporary-role removal authority requires the confirmation RPC';
      END IF;

      SELECT pg_catalog.count(*)::INTEGER,
             pg_catalog.count(*) FILTER (
               WHERE NEW.id = ANY(intent.reserved_temp_role_grant_ids)
                 AND intent.order_id = NEW.order_id
                 AND intent.guild_id = NEW.guild_id
                 AND intent.discord_id = NEW.user_id
                 AND intent.product_id::TEXT = NEW.source_id
                 AND intent.state = 'open'
                 AND intent.mutation_token IS NOT NULL
                 AND intent.id::TEXT = v_confirmation_intent_scope
                 AND intent.mutation_token::TEXT = v_confirmation_mutation_scope
                 AND intent.delivery_confirmed_at IS NULL
                 AND intent.cleanup_action_id IS NULL
                 AND intent.cleanup_claim_token IS NULL
                 AND intent.cleanup_mutation_token IS NULL
             )::INTEGER
        INTO v_reference_count, v_reservation_count
        FROM public.commerce_role_delivery_intents AS intent
       WHERE NEW.id = ANY(intent.reserved_temp_role_grant_ids)
          OR NEW.id = ANY(intent.temporary_role_grant_ids);
      IF v_reference_count <> 1 OR v_reservation_count <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce temporary-role removal authority lacks an exact reservation';
      END IF;
    ELSIF OLD.remove_on_expiry AND NOT NEW.remove_on_expiry THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce temporary-role confirmed removal authority is immutable';
    END IF;

    IF NEW.attempts < OLD.attempts
       OR NEW.attempts > OLD.attempts + 1
       OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce temporary-role provenance bookkeeping is not monotonic';
    END IF;

    IF OLD.grant_status = 'pending'
       AND OLD.source = 'commerce_purchase'
       AND NEW.grant_status = 'pending'
       AND NEW.source = 'commerce_purchase' THEN
      IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce temporary-role pending provenance is immutable';
      END IF;
    ELSIF OLD.grant_status = 'pending'
          AND OLD.source = 'commerce_purchase'
          AND NEW.grant_status = 'applied'
          AND NEW.source = 'commerce_purchase' THEN
      IF NEW.attempts IS DISTINCT FROM OLD.attempts
         OR NEW.applied_at IS NULL
         OR NEW.expires_at IS DISTINCT FROM NEW.applied_at
           + (NEW.duration_seconds * interval '1 second')
         OR NEW.last_error IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce temporary-role acknowledgement transition is invalid';
      END IF;
    ELSIF OLD.grant_status = 'applied'
          AND OLD.source = 'commerce_purchase'
          AND NEW.grant_status = 'applied'
          AND NEW.source = 'commerce_purchase' THEN
      IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
         OR NEW.last_error IS DISTINCT FROM OLD.last_error THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce temporary-role applied provenance is immutable';
      END IF;
    ELSIF OLD.grant_status IN ('pending', 'applied')
          AND OLD.source = 'commerce_purchase'
          AND NEW.grant_status = 'removed'
          AND NEW.source = 'commerce_reconciled' THEN
      SELECT pg_catalog.pg_get_userbyid(proc.proowner)
        INTO v_retirement_owner
        FROM pg_catalog.pg_proc AS proc
       WHERE proc.oid = pg_catalog.to_regprocedure(
         'public.commerce_retire_temp_role_grant(uuid,text,timestamp with time zone,boolean)'
       );
      v_retirement_scope := pg_catalog.current_setting(
        'somnibot.commerce_temp_retirement_grant_id', true
      );
      SELECT pg_catalog.pg_get_userbyid(proc.proowner)
        INTO v_cleanup_retirement_owner
        FROM pg_catalog.pg_proc AS proc
       WHERE proc.oid = pg_catalog.to_regprocedure(
         'public.commerce_finish_role_delivery_cleanup(uuid,uuid,uuid,uuid,text,text,text[],text[],text[])'
       );
      v_cleanup_retirement_grant_scope := pg_catalog.current_setting(
        'somnibot.commerce_cleanup_retirement_grant_id', true
      );
      v_cleanup_retirement_intent_scope := pg_catalog.current_setting(
        'somnibot.commerce_cleanup_retirement_intent_id', true
      );
      v_cleanup_retirement_mutation_scope := pg_catalog.current_setting(
        'somnibot.commerce_cleanup_retirement_mutation_token', true
      );
      SELECT pg_catalog.count(*)::INTEGER
        INTO v_authority_reference_count
        FROM public.commerce_role_delivery_intents AS intent
       WHERE NEW.id = ANY(intent.reserved_temp_role_grant_ids)
          OR NEW.id = ANY(intent.temporary_role_grant_ids);
      IF EXISTS (
           SELECT 1
             FROM public.commerce_role_delivery_intents AS intent
            WHERE NEW.id = ANY(intent.reserved_temp_role_grant_ids)
         ) OR NOT (
           (
             v_retirement_owner IS NOT NULL
             AND current_user IS NOT DISTINCT FROM v_retirement_owner
             AND v_retirement_scope IS NOT DISTINCT FROM NEW.id::TEXT
           )
           OR (
             v_cleanup_retirement_owner IS NOT NULL
             AND current_user IS NOT DISTINCT FROM v_cleanup_retirement_owner
             AND v_cleanup_retirement_grant_scope IS NOT DISTINCT FROM NEW.id::TEXT
             AND v_authority_reference_count = 1
             AND EXISTS (
               SELECT 1
                 FROM public.commerce_role_delivery_intents AS intent
                WHERE intent.id::TEXT = v_cleanup_retirement_intent_scope
                  AND intent.cleanup_mutation_token::TEXT
                    = v_cleanup_retirement_mutation_scope
                  AND intent.state IN ('cleanup_required', 'operator_required')
                  AND intent.cleanup_action_id IS NOT NULL
                  AND intent.cleanup_claim_token IS NOT NULL
                  AND NEW.id = ANY(intent.temporary_role_grant_ids)
                  AND NOT (NEW.id = ANY(intent.reserved_temp_role_grant_ids))
                  AND intent.order_id = NEW.order_id
                  AND intent.guild_id = NEW.guild_id
                  AND intent.discord_id = NEW.user_id
                  AND intent.product_id::TEXT = NEW.source_id
             )
           )
         ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'commerce temporary-role retirement requires an exact safe controller';
      END IF;
      IF NEW.attempts IS DISTINCT FROM OLD.attempts
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
         OR NEW.remove_on_expiry IS DISTINCT FROM OLD.remove_on_expiry
         OR NEW.last_error IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce temporary-role retirement transition is invalid';
      END IF;
    ELSIF OLD.grant_status = 'removed'
          AND OLD.source = 'commerce_reconciled'
          AND NEW.grant_status = 'removed'
          AND NEW.source = 'commerce_reconciled' THEN
      IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
         OR NEW.remove_on_expiry IS DISTINCT FROM OLD.remove_on_expiry
         OR NEW.last_error IS DISTINCT FROM OLD.last_error THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce temporary-role tombstone is immutable';
      END IF;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce temporary-role lifecycle transition is invalid';
    END IF;

    SELECT paid_order.*
      INTO v_order
      FROM public.orders AS paid_order
     WHERE paid_order.id = NEW.order_id;
  ELSE
    IF NEW.source IS DISTINCT FROM 'commerce_purchase'
       OR NEW.grant_status IS DISTINCT FROM 'pending'
       OR NEW.applied_at IS NOT NULL
       OR NEW.remove_on_expiry
       OR NEW.attempts IS DISTINCT FROM 1
       OR NEW.last_error IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce temporary-role initial lifecycle is invalid';
    END IF;

    SELECT paid_order.*
      INTO v_order
      FROM public.orders AS paid_order
     WHERE paid_order.id = NEW.order_id
     FOR SHARE;
  END IF;

  IF NOT FOUND
     OR NEW.guild_id IS DISTINCT FROM v_order.guild_id
     OR NEW.source_id IS DISTINCT FROM v_order.product_id::TEXT
     OR NEW.role_id !~ '^[0-9]{17,20}$'
     OR NEW.duration_seconds IS NULL
     OR NEW.duration_seconds <= 0
     OR NEW.duration_seconds > 315360000
     OR v_order.plan_id IS NOT NULL
     OR v_order.paypal_subscription_id IS NOT NULL
     OR v_order.grant_snapshot_frozen_at IS NULL
     OR NOT public.commerce_valid_temp_role_snapshot(
       v_order.temporary_role_grants_snapshot
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(
           v_order.temporary_role_grants_snapshot
         ) AS frozen_grant(value)
        WHERE frozen_grant.value ->> 'role_id' = NEW.role_id
          AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
            = NEW.duration_seconds
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce temporary-role parent identity is invalid';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT customer.discord_id
      INTO v_discord_id
      FROM public.customers AS customer
     WHERE customer.id = v_order.customer_id
       AND customer.guild_id = v_order.guild_id
     FOR SHARE;
  ELSE
    SELECT customer.discord_id
      INTO v_discord_id
      FROM public.customers AS customer
     WHERE customer.id = v_order.customer_id
       AND customer.guild_id = v_order.guild_id;
  END IF;

  IF NOT FOUND OR NEW.user_id IS DISTINCT FROM v_discord_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce temporary-role customer identity is invalid';
  END IF;

  IF TG_OP = 'INSERT'
     AND (
       v_order.status IS DISTINCT FROM 'completed'
       OR v_order.amount_cents IS NULL
       OR v_order.amount_cents <= 0
       OR NOT COALESCE((
         v_order.source = 'purchase'
         OR (
           v_order.source IS NULL
           AND EXISTS (
             SELECT 1
               FROM public.payments AS payment
              WHERE payment.order_id = v_order.id
                AND payment.customer_id = v_order.customer_id
                AND payment.guild_id = v_order.guild_id
                AND payment.amount_cents = v_order.amount_cents
                AND payment.currency IS NOT NULL
                AND payment.currency = pg_catalog.btrim(payment.currency)
                AND pg_catalog.upper(payment.currency) ~ '^[A-Z]{3}$'
                AND pg_catalog.upper(payment.currency) = v_order.currency
                AND payment.provider = 'paypal'
                AND payment.paypal_resource_type IS NOT DISTINCT FROM 'capture'
                AND payment.status = 'completed'
                AND payment.paypal_payment_id
                  ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
           )
         )
       ), false)
       OR NOT EXISTS (
         SELECT 1
           FROM public.entitlements AS entitlement
          WHERE entitlement.order_id = v_order.id
            AND entitlement.guild_id = v_order.guild_id
            AND entitlement.customer_id = v_order.customer_id
            AND entitlement.product_id = v_order.product_id
            AND entitlement.type = 'one_time'
            AND entitlement.status IN (
              'active', 'pending', 'grace_period', 'suspended'
            )
            AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce temporary-role paid parent is not live';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_guard_order_backed_temp_role_grant()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_00_guard_order_backed_temp_role_grant
  ON public.temp_role_grants;
CREATE TRIGGER commerce_00_guard_order_backed_temp_role_grant
  BEFORE INSERT OR UPDATE ON public.temp_role_grants
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_order_backed_temp_role_grant();

-- Legacy rows predate order-scoped, pre-mutation provenance.  Preserve them
-- and make the reconciliation requirement explicit; never guess whether the
-- bot added a role that may also have existed independently.
CREATE TABLE IF NOT EXISTS public.commerce_temp_role_migration_issues (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  temp_role_grant_id UUID        NOT NULL UNIQUE
    REFERENCES public.temp_role_grants(id) ON DELETE CASCADE,
  guild_id           TEXT        NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  user_id            TEXT        NOT NULL,
  role_id            TEXT        NOT NULL,
  source             TEXT,
  source_id          TEXT,
  issue_type         TEXT        NOT NULL DEFAULT 'missing_order_provenance'
    CHECK (issue_type = 'missing_order_provenance'),
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commerce_temp_role_migration_issues_open
  ON public.commerce_temp_role_migration_issues (guild_id, created_at)
  WHERE resolved_at IS NULL;

ALTER TABLE public.commerce_temp_role_migration_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_all ON public.commerce_temp_role_migration_issues
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.commerce_temp_role_migration_issues
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.commerce_temp_role_migration_issues
  TO service_role;

INSERT INTO public.commerce_temp_role_migration_issues (
  temp_role_grant_id,
  guild_id,
  user_id,
  role_id,
  source,
  source_id
)
SELECT legacy.id,
       legacy.guild_id,
       legacy.user_id,
       legacy.role_id,
       legacy.source,
       legacy.source_id
  FROM public.temp_role_grants AS legacy
 WHERE legacy.order_id IS NULL
ON CONFLICT (temp_role_grant_id) DO NOTHING;

-- Invalid grant_role_id values are preserved as operator-visible issues, not
-- coerced into canonical role arrays.
INSERT INTO public.commerce_role_metadata_migration_issues (
  product_id,
  guild_id,
  issue_type,
  details
)
SELECT product.id,
       product.guild_id,
       'invalid_role_id',
       jsonb_build_object(
         'source', 'metadata.grant_role_id',
         'raw_grant_role_id', product.metadata -> 'grant_role_id',
         'raw_reserved_metadata', (
           SELECT COALESCE(
                    pg_catalog.jsonb_object_agg(raw.key, raw.value ORDER BY raw.key),
                    '{}'::JSONB
                  )
             FROM pg_catalog.jsonb_each(product.metadata) AS raw(key, value)
            WHERE raw.key IN (
              'grant_role_id',
              'historical_grant_role_ids',
              'role_duration_hours'
            )
         )
       )
  FROM public.products AS product
 WHERE jsonb_typeof(product.metadata) = 'object'
   AND product.metadata ? 'grant_role_id'
   AND (
     jsonb_typeof(product.metadata -> 'grant_role_id') IS DISTINCT FROM 'string'
     OR COALESCE(product.metadata ->> 'grant_role_id', '') !~ '^[0-9]{17,20}$'
   )
ON CONFLICT DO NOTHING;

-- The legacy runtime only consumed metadata roles for one-time purchase
-- events.  Moving subscription/free metadata into granted_role_ids would
-- create a new grant path, so quarantine it instead.
INSERT INTO public.commerce_role_metadata_migration_issues (
  product_id,
  guild_id,
  role_id,
  issue_type,
  details
)
SELECT product.id,
       product.guild_id,
       product.metadata ->> 'grant_role_id',
       'unsupported_product_type',
       jsonb_build_object(
         'source', 'metadata.grant_role_id',
         'product_type', product.type,
         'raw_reserved_metadata', (
           SELECT COALESCE(
                    pg_catalog.jsonb_object_agg(raw.key, raw.value ORDER BY raw.key),
                    '{}'::JSONB
                  )
             FROM pg_catalog.jsonb_each(product.metadata) AS raw(key, value)
            WHERE raw.key IN (
              'grant_role_id',
              'historical_grant_role_ids',
              'role_duration_hours'
            )
         )
       )
  FROM public.products AS product
 WHERE jsonb_typeof(product.metadata) = 'object'
   AND jsonb_typeof(product.metadata -> 'grant_role_id') = 'string'
   AND product.metadata ->> 'grant_role_id' ~ '^[0-9]{17,20}$'
   AND product.type <> 'one_time'
ON CONFLICT DO NOTHING;

-- A valid duration is a whole number of hours from 1 through ten years.  Any
-- other truthy/negative/fractional value is quarantined rather than silently
-- becoming a permanent grant.
INSERT INTO public.commerce_role_metadata_migration_issues (
  product_id,
  guild_id,
  role_id,
  issue_type,
  details
)
SELECT product.id,
       product.guild_id,
       CASE
         WHEN jsonb_typeof(product.metadata -> 'grant_role_id') = 'string'
           THEN product.metadata ->> 'grant_role_id'
         ELSE NULL
       END,
       'invalid_duration',
       jsonb_build_object(
         'source', 'metadata.role_duration_hours',
         'raw_role_duration_hours', product.metadata -> 'role_duration_hours',
         'raw_grant_role_id', product.metadata -> 'grant_role_id',
         'raw_reserved_metadata', (
           SELECT COALESCE(
                    pg_catalog.jsonb_object_agg(raw.key, raw.value ORDER BY raw.key),
                    '{}'::JSONB
                  )
             FROM pg_catalog.jsonb_each(product.metadata) AS raw(key, value)
            WHERE raw.key IN (
              'grant_role_id',
              'historical_grant_role_ids',
              'role_duration_hours'
            )
         )
       )
  FROM public.products AS product
 WHERE jsonb_typeof(product.metadata) = 'object'
   AND product.metadata ? 'role_duration_hours'
   AND jsonb_typeof(product.metadata -> 'role_duration_hours') IS DISTINCT FROM 'null'
   AND NOT (
     CASE
       WHEN jsonb_typeof(product.metadata -> 'role_duration_hours') = 'number'
         THEN (product.metadata ->> 'role_duration_hours')::NUMERIC >= 0
          AND (product.metadata ->> 'role_duration_hours')::NUMERIC <= 87600
          AND trunc((product.metadata ->> 'role_duration_hours')::NUMERIC)
            = (product.metadata ->> 'role_duration_hours')::NUMERIC
       ELSE false
     END
   )
ON CONFLICT DO NOTHING;

-- A duration key without any grant_role_id has no canonical destination. It is
-- neither a permanent nor a temporary role configuration, so preserve its
-- complete reserved-key object before the final metadata strip.
INSERT INTO public.commerce_role_metadata_migration_issues (
  product_id,
  guild_id,
  issue_type,
  details
)
SELECT product.id,
       product.guild_id,
       'orphan_duration',
       pg_catalog.jsonb_build_object(
         'source', 'metadata.role_duration_hours_without_grant_role_id',
         'raw_role_duration_hours', product.metadata -> 'role_duration_hours',
         'raw_reserved_metadata', (
           SELECT COALESCE(
                    pg_catalog.jsonb_object_agg(raw.key, raw.value ORDER BY raw.key),
                    '{}'::JSONB
                  )
             FROM pg_catalog.jsonb_each(product.metadata) AS raw(key, value)
            WHERE raw.key IN (
              'grant_role_id',
              'historical_grant_role_ids',
              'role_duration_hours'
            )
         )
       )
  FROM public.products AS product
 WHERE pg_catalog.jsonb_typeof(product.metadata) = 'object'
   AND product.metadata ? 'role_duration_hours'
   AND NOT (product.metadata ? 'grant_role_id')
ON CONFLICT DO NOTHING;

-- Typed temporary configuration.  Duration zero follows the old runtime's
-- permanent behavior; positive whole durations remain temporary.
INSERT INTO public.commerce_product_temp_role_config (
  product_id,
  guild_id,
  role_id,
  duration_seconds
)
SELECT product.id,
       product.guild_id,
       product.metadata ->> 'grant_role_id',
       (
         CASE
           WHEN jsonb_typeof(product.metadata -> 'role_duration_hours') = 'number'
             THEN (product.metadata ->> 'role_duration_hours')::INTEGER
           ELSE NULL
         END * 3600
       )
  FROM public.products AS product
 WHERE product.type = 'one_time'
   AND jsonb_typeof(product.metadata) = 'object'
   AND jsonb_typeof(product.metadata -> 'grant_role_id') = 'string'
   AND product.metadata ->> 'grant_role_id' ~ '^[0-9]{17,20}$'
   AND CASE
     WHEN jsonb_typeof(product.metadata -> 'role_duration_hours') = 'number'
       THEN (product.metadata ->> 'role_duration_hours')::NUMERIC > 0
        AND (product.metadata ->> 'role_duration_hours')::NUMERIC <= 87600
        AND trunc((product.metadata ->> 'role_duration_hours')::NUMERIC)
          = (product.metadata ->> 'role_duration_hours')::NUMERIC
     ELSE false
   END
ON CONFLICT (product_id, role_id) DO NOTHING;

-- Current valid permanent one-time configuration becomes canonical for future
-- fulfillments.  It is NOT copied blindly into old buyer entitlements: the
-- mutable product row cannot prove which historic sale saw this configuration.
WITH permanent_config AS (
  SELECT product.id,
         product.metadata ->> 'grant_role_id' AS role_id
    FROM public.products AS product
   WHERE product.type = 'one_time'
     AND jsonb_typeof(product.metadata) = 'object'
     AND jsonb_typeof(product.metadata -> 'grant_role_id') = 'string'
     AND product.metadata ->> 'grant_role_id' ~ '^[0-9]{17,20}$'
     AND (
       NOT (product.metadata ? 'role_duration_hours')
       OR jsonb_typeof(product.metadata -> 'role_duration_hours') = 'null'
       OR (
         CASE
           WHEN jsonb_typeof(product.metadata -> 'role_duration_hours') = 'number'
             THEN (product.metadata ->> 'role_duration_hours')::NUMERIC = 0
           ELSE false
         END
       )
     )
)
UPDATE public.products AS product
   SET granted_role_ids = ARRAY(
         SELECT DISTINCT role.role_id
           FROM unnest(
             COALESCE(product.granted_role_ids, ARRAY[]::TEXT[])
             || ARRAY[permanent.role_id]
           ) AS role(role_id)
          ORDER BY role.role_id
       ),
       updated_at = now()
  FROM permanent_config AS permanent
 WHERE product.id = permanent.id;

-- A current permanent config plus an old paid entitlement that lacks the role
-- is ambiguous history.  Preserve the discrepancy for explicit reconciliation
-- instead of falsely claiming the buyer received it.
INSERT INTO public.commerce_role_metadata_migration_issues (
  product_id,
  guild_id,
  role_id,
  issue_type,
  details
)
SELECT DISTINCT product.id,
       product.guild_id,
       product.metadata ->> 'grant_role_id',
       'ambiguous_permanent_history',
       jsonb_build_object('source', 'legacy purchase entitlement without role snapshot')
  FROM public.products AS product
  JOIN public.entitlements AS entitlement
    ON entitlement.product_id = product.id
   AND entitlement.guild_id = product.guild_id
 WHERE product.type = 'one_time'
   AND jsonb_typeof(product.metadata) = 'object'
   AND jsonb_typeof(product.metadata -> 'grant_role_id') = 'string'
   AND product.metadata ->> 'grant_role_id' ~ '^[0-9]{17,20}$'
   AND (
     NOT (product.metadata ? 'role_duration_hours')
     OR jsonb_typeof(product.metadata -> 'role_duration_hours') = 'null'
     OR (
       CASE
         WHEN jsonb_typeof(product.metadata -> 'role_duration_hours') = 'number'
           THEN (product.metadata ->> 'role_duration_hours')::NUMERIC = 0
         ELSE false
       END
     )
   )
   AND (
     entitlement.source IS NULL
     OR entitlement.source NOT IN ('giveaway', 'manual', 'automation')
   )
   AND NOT (
     (product.metadata ->> 'grant_role_id')
       = ANY(COALESCE(entitlement.granted_role_ids, ARRAY[]::TEXT[]))
   )
ON CONFLICT DO NOTHING;

-- A completed order without an exact role-bearing entitlement is likewise
-- unresolved history; product-global sale evidence must not be projected onto
-- an arbitrary current role holder.
INSERT INTO public.commerce_role_metadata_migration_issues (
  product_id,
  guild_id,
  role_id,
  issue_type,
  details
)
SELECT DISTINCT product.id,
       product.guild_id,
       product.metadata ->> 'grant_role_id',
       'ambiguous_permanent_history',
       jsonb_build_object('source', 'completed paid order without exact role snapshot')
  FROM public.products AS product
  JOIN public.orders AS paid_order
    ON paid_order.product_id = product.id
   AND paid_order.guild_id = product.guild_id
   AND paid_order.status = 'completed'
   AND paid_order.amount_cents > 0
   AND paid_order.paypal_subscription_id IS NULL
   AND (paid_order.source IS NULL OR paid_order.source = 'purchase')
 WHERE product.type = 'one_time'
   AND jsonb_typeof(product.metadata) = 'object'
   AND jsonb_typeof(product.metadata -> 'grant_role_id') = 'string'
   AND product.metadata ->> 'grant_role_id' ~ '^[0-9]{17,20}$'
   AND (
     NOT (product.metadata ? 'role_duration_hours')
     OR jsonb_typeof(product.metadata -> 'role_duration_hours') = 'null'
     OR (
       CASE
         WHEN jsonb_typeof(product.metadata -> 'role_duration_hours') = 'number'
           THEN (product.metadata ->> 'role_duration_hours')::NUMERIC = 0
         ELSE false
       END
     )
   )
   AND NOT EXISTS (
     SELECT 1
       FROM public.entitlements AS entitlement
      WHERE entitlement.order_id = paid_order.id
        AND entitlement.guild_id = paid_order.guild_id
        AND (product.metadata ->> 'grant_role_id')
          = ANY(COALESCE(entitlement.granted_role_ids, ARRAY[]::TEXT[]))
   )
ON CONFLICT DO NOTHING;

-- historical_grant_role_ids has no sale-time or buyer identity.  Every valid
-- entry is quarantined and never copied to every entitlement/product.
INSERT INTO public.commerce_role_metadata_migration_issues (
  product_id,
  guild_id,
  role_id,
  issue_type,
  details
)
SELECT product.id,
       product.guild_id,
       historical.role_id,
       'ambiguous_historical_role',
       pg_catalog.jsonb_build_object(
         'source', 'metadata.historical_grant_role_ids',
         'raw_reserved_metadata', (
           SELECT COALESCE(
                    pg_catalog.jsonb_object_agg(raw.key, raw.value ORDER BY raw.key),
                    '{}'::JSONB
                  )
             FROM pg_catalog.jsonb_each(product.metadata) AS raw(key, value)
            WHERE raw.key IN (
              'grant_role_id',
              'historical_grant_role_ids',
              'role_duration_hours'
            )
         )
       )
  FROM public.products AS product
 CROSS JOIN LATERAL jsonb_array_elements_text(
   CASE
     WHEN jsonb_typeof(product.metadata -> 'historical_grant_role_ids') = 'array'
       THEN product.metadata -> 'historical_grant_role_ids'
     ELSE '[]'::JSONB
   END
 ) AS historical(role_id)
 WHERE pg_catalog.jsonb_typeof(product.metadata) = 'object'
   AND historical.role_id ~ '^[0-9]{17,20}$'
ON CONFLICT DO NOTHING;

INSERT INTO public.commerce_role_metadata_migration_issues (
  product_id,
  guild_id,
  issue_type,
  details
)
SELECT product.id,
       product.guild_id,
       'invalid_historical_roles',
       jsonb_build_object(
         'source', 'metadata.historical_grant_role_ids',
         'raw', product.metadata -> 'historical_grant_role_ids',
         'raw_reserved_metadata', (
           SELECT COALESCE(
                    pg_catalog.jsonb_object_agg(raw.key, raw.value ORDER BY raw.key),
                    '{}'::JSONB
                  )
             FROM pg_catalog.jsonb_each(product.metadata) AS raw(key, value)
            WHERE raw.key IN (
              'grant_role_id',
              'historical_grant_role_ids',
              'role_duration_hours'
            )
         )
       )
  FROM public.products AS product
 WHERE jsonb_typeof(product.metadata) = 'object'
   AND product.metadata ? 'historical_grant_role_ids'
   AND (
     jsonb_typeof(product.metadata -> 'historical_grant_role_ids') IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(product.metadata -> 'historical_grant_role_ids') = 'array'
               THEN product.metadata -> 'historical_grant_role_ids'
             ELSE '[]'::JSONB
           END
         ) AS historical(value)
        WHERE jsonb_typeof(historical.value) IS DISTINCT FROM 'string'
           OR COALESCE(historical.value #>> '{}', '') !~ '^[0-9]{17,20}$'
     )
   )
ON CONFLICT DO NOTHING;

-- Remove every reserved side-channel key only after typed/canonical/quarantine
-- state has been committed in this same transaction.
UPDATE public.products
   SET metadata = COALESCE(metadata, '{}'::JSONB)
                    - 'grant_role_id'
                    - 'historical_grant_role_ids'
                    - 'role_duration_hours',
       updated_at = now()
 WHERE jsonb_typeof(metadata) = 'object'
   AND (
     metadata ? 'grant_role_id'
     OR metadata ? 'historical_grant_role_ids'
     OR metadata ? 'role_duration_hours'
   );

ALTER TABLE public.products
  ADD CONSTRAINT products_no_legacy_role_metadata
  CHECK (
    NOT (
      COALESCE(metadata, '{}'::JSONB)
        ?| ARRAY[
          'grant_role_id',
          'historical_grant_role_ids',
          'role_duration_hours'
        ]
    )
  );

-- Extend the authoritative DB wall to the typed temporary grant vector.
CREATE OR REPLACE FUNCTION public.commerce_assert_income_wall_guild(
  p_guild_id TEXT
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_product_id UUID;
  v_role_id TEXT;
BEGIN
  IF p_guild_id IS NULL OR p_guild_id = '' THEN
    RETURN;
  END IF;

  PERFORM public.commerce_income_wall_lock_guild(p_guild_id);

  SELECT product.id, income.role_id
    INTO v_product_id, v_role_id
    FROM public.products AS product
    JOIN public.economy_role_income AS income
      ON income.guild_id = product.guild_id
     AND income.amount > 0
     AND (
       income.role_id = ANY(COALESCE(product.granted_role_ids, ARRAY[]::TEXT[]))
       OR EXISTS (
         SELECT 1
           FROM public.commerce_product_temp_role_config AS temporary
          WHERE temporary.guild_id = product.guild_id
            AND temporary.product_id = product.id
            AND temporary.role_id = income.role_id
       )
     )
   WHERE product.guild_id = p_guild_id
     AND product.active IS TRUE
     AND (
       (product.type = 'one_time' AND product.price_cents > 0)
       OR (
         product.type = 'subscription'
         AND EXISTS (
           SELECT 1
             FROM public.commerce_select_checkout_plan(p_guild_id, product.id)
         )
       )
     )
   ORDER BY product.id, income.role_id
   LIMIT 1;

  IF v_product_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'COMMERCE_INCOME_WALL_CONFLICT: guild=' || p_guild_id
        || ' product=' || v_product_id::TEXT
        || ' role=' || v_role_id,
      DETAIL = 'An active real-money purchase path grants a role that also earns wagerable currency.',
      HINT = 'Remove the role-income row or close the purchase path before retrying.';
  END IF;
END;
$$;

CREATE TRIGGER commerce_income_wall_temp_role_config_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.commerce_product_temp_role_config
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_income_wall_lock_row();

CREATE CONSTRAINT TRIGGER commerce_income_wall_temp_role_config_validate
  AFTER INSERT OR UPDATE OR DELETE ON public.commerce_product_temp_role_config
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_income_wall_validate_row();

DO $$
DECLARE
  v_guild_id TEXT;
BEGIN
  FOR v_guild_id IN
    SELECT DISTINCT product.guild_id
      FROM public.products AS product
     WHERE product.guild_id IS NOT NULL
     ORDER BY product.guild_id
  LOOP
    PERFORM public.commerce_assert_income_wall_guild(v_guild_id);
  END LOOP;
END;
$$;

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
       OR v_product.active IS DISTINCT FROM true
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
        FROM public.commerce_select_checkout_plan(OLD.guild_id, OLD.product_id) AS selected;

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

CREATE TRIGGER commerce_orders_protect_grant_snapshot
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_protect_order_grant_snapshot();

REVOKE ALL ON FUNCTION public.commerce_protect_order_grant_snapshot()
  FROM PUBLIC, anon, authenticated, service_role;

-- Freeze sale-time grant configuration exactly once. Product and typed-temp
-- mutations take the same guild advisory lock through their wall triggers, so
-- no writer can race between these reads and the order snapshot update.
CREATE OR REPLACE FUNCTION public.commerce_freeze_order_grant_snapshot(
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_plan public.plans%ROWTYPE;
  v_temp_snapshot JSONB := '[]'::JSONB;
  v_frozen_at TIMESTAMPTZ;
BEGIN
  IF p_order_id IS NULL OR p_customer_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: order, customer, and product are required';
  END IF;
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: guild is required';
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
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: order identity mismatch';
  END IF;

  IF v_order.grant_snapshot_frozen_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_order.id,
      'granted_role_ids_snapshot', pg_catalog.to_jsonb(v_order.granted_role_ids_snapshot),
      'granted_channel_ids_snapshot', pg_catalog.to_jsonb(v_order.granted_channel_ids_snapshot),
      'temporary_role_grants_snapshot', v_order.temporary_role_grants_snapshot,
      'grant_snapshot_frozen_at', v_order.grant_snapshot_frozen_at
    );
  END IF;

  IF v_order.status <> 'pending' THEN
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: unfrozen order is no longer pending';
  END IF;

  IF NOT COALESCE((
    v_order.source = 'purchase'
    OR (
      v_order.source IS NULL
      AND v_order.paypal_order_id IS NOT NULL
      AND v_order.paypal_order_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
    )
  ), false) THEN
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: order is not a paid purchase';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.customers AS customer
     WHERE customer.id = p_customer_id
       AND customer.guild_id = p_guild_id
  ) THEN
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: customer identity mismatch';
  END IF;

  SELECT product.*
    INTO v_product
    FROM public.products AS product
   WHERE product.id = p_product_id
     AND product.guild_id = p_guild_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: product identity mismatch';
  END IF;

  IF v_product.type = 'subscription' THEN
    PERFORM 1
      FROM public.plans AS plan
     WHERE plan.product_id = p_product_id
       AND plan.guild_id = p_guild_id
     ORDER BY plan.id
     FOR SHARE;
  END IF;

  -- Match the row-before-advisory order used by table writers. FOR SHARE makes
  -- the product and existing plan contracts stable first; then the guild lock
  -- serializes plan inserts/moves, typed temporary config, and income-wall
  -- mutations. The selection below is deliberately repeated under the lock.
  PERFORM public.commerce_income_wall_lock_guild(p_guild_id);

  -- This is the checkout-time compare-and-freeze boundary. Product and plan
  -- writers use the same guild advisory lock, so the provider contract read by
  -- the caller cannot be silently replaced with a different live contract
  -- before its order snapshot is frozen.
  IF v_product.active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: product is not active';
  END IF;

  IF v_product.type = 'one_time' THEN
    IF v_product.price_cents IS NULL
       OR v_product.price_cents <= 0
       OR v_order.amount_cents IS DISTINCT FROM v_product.price_cents
       OR v_order.currency IS DISTINCT FROM v_product.currency
       OR v_order.paypal_order_id IS NULL
       OR v_order.paypal_order_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
       OR v_order.paypal_subscription_id IS NOT NULL
       OR v_order.plan_id IS NOT NULL THEN
      RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: one-time sale contract mismatch';
    END IF;
  ELSIF v_product.type = 'subscription' THEN
    IF v_order.paypal_subscription_id IS NULL
       OR pg_catalog.btrim(v_order.paypal_subscription_id) = '' THEN
      RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: subscription id is required';
    END IF;

    SELECT selected.*
      INTO v_plan
      FROM public.commerce_select_checkout_plan(p_guild_id, p_product_id) AS selected;

    IF NOT FOUND
       OR v_order.plan_id IS DISTINCT FROM v_plan.id
       OR v_order.amount_cents IS DISTINCT FROM v_plan.price_cents
       OR v_order.currency IS DISTINCT FROM v_plan.currency THEN
      RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: subscription sale contract mismatch';
    END IF;
  ELSE
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: unsupported product type';
  END IF;

  IF NOT public.commerce_valid_snowflake_snapshot(
    COALESCE(v_product.granted_role_ids, '{}'::TEXT[])
  ) OR NOT public.commerce_valid_snowflake_snapshot(
    COALESCE(v_product.granted_channel_ids, '{}'::TEXT[])
  ) THEN
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: product grant configuration is malformed';
  END IF;

  IF v_product.type = 'one_time' THEN
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
      INTO v_temp_snapshot
      FROM public.commerce_product_temp_role_config AS temporary
     WHERE temporary.guild_id = p_guild_id
       AND temporary.product_id = p_product_id;
  END IF;

  IF NOT public.commerce_valid_temp_role_snapshot(v_temp_snapshot) THEN
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: temporary grant configuration is malformed';
  END IF;

  v_frozen_at := pg_catalog.clock_timestamp();
  UPDATE public.orders
     SET granted_role_ids_snapshot = COALESCE(v_product.granted_role_ids, '{}'::TEXT[]),
         granted_channel_ids_snapshot = COALESCE(v_product.granted_channel_ids, '{}'::TEXT[]),
         temporary_role_grants_snapshot = v_temp_snapshot,
         grant_snapshot_frozen_at = v_frozen_at,
         updated_at = v_frozen_at
   WHERE id = p_order_id
     AND grant_snapshot_frozen_at IS NULL
  RETURNING * INTO v_order;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_freeze_order_grant_snapshot: snapshot race detected';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_order.id,
    'granted_role_ids_snapshot', pg_catalog.to_jsonb(v_order.granted_role_ids_snapshot),
    'granted_channel_ids_snapshot', pg_catalog.to_jsonb(v_order.granted_channel_ids_snapshot),
    'temporary_role_grants_snapshot', v_order.temporary_role_grants_snapshot,
    'grant_snapshot_frozen_at', v_order.grant_snapshot_frozen_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_freeze_order_grant_snapshot(UUID, TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_freeze_order_grant_snapshot(UUID, TEXT, UUID, UUID)
  TO service_role;

-- Persist the only safe recovery contract for a completed legacy
-- subscription: an exact staged outbox payload written before the order lost
-- its normal freeze transition. This never reads today's product or plan grant
-- configuration. The order and queue are locked together, every payload field
-- is checked against the paid order/customer identity, and replay may only
-- return the same immutable row.
CREATE OR REPLACE FUNCTION public.commerce_adopt_legacy_subscription_grant_contract(
  p_order_id UUID,
  p_source_queue_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_queue public.bot_action_queue%ROWTYPE;
  v_contract public.commerce_legacy_subscription_grant_contracts%ROWTYPE;
  v_roles TEXT[] := '{}'::TEXT[];
  v_channels TEXT[] := '{}'::TEXT[];
  v_had_contract BOOLEAN := false;
BEGIN
  IF p_order_id IS NULL OR p_source_queue_id IS NULL THEN
    RAISE EXCEPTION 'commerce_adopt_legacy_subscription_grant_contract: order and queue are required';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR UPDATE;

  IF v_order.id IS NULL
     OR v_order.status <> 'completed'
     OR v_order.grant_snapshot_frozen_at IS NOT NULL
     OR v_order.guild_id IS NULL
     OR v_order.customer_id IS NULL
     OR v_order.product_id IS NULL
     OR v_order.plan_id IS NULL
     OR v_order.paypal_subscription_id IS NULL
     OR pg_catalog.btrim(v_order.paypal_subscription_id) = ''
     OR NOT COALESCE((v_order.source = 'purchase' OR v_order.source IS NULL), false) THEN
    RAISE EXCEPTION 'commerce_adopt_legacy_subscription_grant_contract: legacy order identity mismatch';
  END IF;

  SELECT contract.*
    INTO v_contract
    FROM public.commerce_legacy_subscription_grant_contracts AS contract
   WHERE contract.order_id = v_order.id
   FOR SHARE;
  v_had_contract := v_contract.order_id IS NOT NULL;

  SELECT queue.*
    INTO v_queue
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_source_queue_id
   FOR SHARE;

  IF v_queue.id IS NULL
     OR v_queue.guild_id <> v_order.guild_id
     OR v_queue.action <> 'fulfill_subscription'
     OR v_queue.lane <> 'commerce'
     OR v_queue.idempotency_key IS DISTINCT FROM (
       'paypal:subscription:' || v_order.paypal_subscription_id || ':fulfill_subscription'
     )
     OR (
       NOT v_had_contract
       AND v_queue.status <> 'staged'
     )
     OR (
       v_had_contract
       AND v_queue.status NOT IN ('staged', 'pending', 'processing', 'completed', 'failed')
     ) THEN
    RAISE EXCEPTION 'commerce_adopt_legacy_subscription_grant_contract: staged queue identity mismatch';
  END IF;

  IF pg_catalog.jsonb_typeof(v_queue.payload) IS DISTINCT FROM 'object'
     OR v_queue.payload ->> 'fulfillment_type' IS DISTINCT FROM 'subscription_activated'
     OR v_queue.payload ->> 'entitlement_type' IS DISTINCT FROM 'subscription'
     OR v_queue.payload ->> 'guild_id' IS DISTINCT FROM v_order.guild_id
     OR v_queue.payload ->> 'customer_id' IS DISTINCT FROM v_order.customer_id::TEXT
     OR v_queue.payload ->> 'product_id' IS DISTINCT FROM v_order.product_id::TEXT
     OR v_queue.payload ->> 'order_id' IS DISTINCT FROM v_order.id::TEXT
     OR v_queue.payload ->> 'order_number' IS DISTINCT FROM v_order.order_number
     OR v_queue.payload ->> 'plan_id' IS DISTINCT FROM v_order.plan_id::TEXT
     OR v_queue.payload ->> 'paypal_subscription_id'
          IS DISTINCT FROM v_order.paypal_subscription_id
     OR pg_catalog.jsonb_typeof(v_queue.payload -> 'amount_cents') IS DISTINCT FROM 'number'
     OR (v_queue.payload ->> 'amount_cents')::NUMERIC
          IS DISTINCT FROM v_order.amount_cents::NUMERIC
     OR v_queue.payload ->> 'currency' IS DISTINCT FROM v_order.currency
     OR v_queue.payload ->> 'discord_id' IS NULL
     OR pg_catalog.btrim(v_queue.payload ->> 'discord_id') = ''
     OR v_queue.payload ->> 'product_name' IS NULL
     OR pg_catalog.btrim(v_queue.payload ->> 'product_name') = ''
     OR v_queue.payload ->> 'paypal_plan_id' IS NULL
     OR pg_catalog.btrim(v_queue.payload ->> 'paypal_plan_id') = ''
     OR pg_catalog.jsonb_typeof(v_queue.payload -> 'granted_role_ids') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_queue.payload -> 'granted_channel_ids') IS DISTINCT FROM 'array'
     OR COALESCE(v_queue.payload -> 'temporary_role_grants', '[]'::JSONB) <> '[]'::JSONB
     OR v_queue.payload ? 'license_key_id'
     OR v_queue.payload ? 'license_key_plaintext' THEN
    RAISE EXCEPTION 'commerce_adopt_legacy_subscription_grant_contract: staged payload mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.customers AS customer
     WHERE customer.id = v_order.customer_id
       AND customer.guild_id = v_order.guild_id
       AND customer.discord_id = v_queue.payload ->> 'discord_id'
  ) THEN
    RAISE EXCEPTION 'commerce_adopt_legacy_subscription_grant_contract: customer identity mismatch';
  END IF;

  SELECT COALESCE(
           pg_catalog.array_agg(role_row.value ORDER BY role_row.ordinality),
           '{}'::TEXT[]
         )
    INTO v_roles
    FROM pg_catalog.jsonb_array_elements_text(
      v_queue.payload -> 'granted_role_ids'
    ) WITH ORDINALITY AS role_row(value, ordinality);

  SELECT COALESCE(
           pg_catalog.array_agg(channel_row.value ORDER BY channel_row.ordinality),
           '{}'::TEXT[]
         )
    INTO v_channels
    FROM pg_catalog.jsonb_array_elements_text(
      v_queue.payload -> 'granted_channel_ids'
    ) WITH ORDINALITY AS channel_row(value, ordinality);

  IF NOT public.commerce_valid_snowflake_snapshot(v_roles)
     OR NOT public.commerce_valid_snowflake_snapshot(v_channels) THEN
    RAISE EXCEPTION 'commerce_adopt_legacy_subscription_grant_contract: staged grant snapshot is malformed';
  END IF;

  IF NOT v_had_contract THEN
    INSERT INTO public.commerce_legacy_subscription_grant_contracts (
      order_id,
      source_queue_id,
      guild_id,
      customer_id,
      discord_id,
      product_id,
      product_name,
      order_number,
      plan_id,
      paypal_subscription_id,
      paypal_plan_id,
      amount_cents,
      currency,
      granted_role_ids_snapshot,
      granted_channel_ids_snapshot
    ) VALUES (
      v_order.id,
      v_queue.id,
      v_order.guild_id,
      v_order.customer_id,
      v_queue.payload ->> 'discord_id',
      v_order.product_id,
      v_queue.payload ->> 'product_name',
      v_order.order_number,
      v_order.plan_id,
      v_order.paypal_subscription_id,
      v_queue.payload ->> 'paypal_plan_id',
      v_order.amount_cents,
      v_order.currency,
      v_roles,
      v_channels
    )
    RETURNING * INTO v_contract;
  END IF;

  IF v_contract.source_queue_id <> v_queue.id
     OR v_contract.guild_id <> v_order.guild_id
     OR v_contract.customer_id <> v_order.customer_id
     OR v_contract.discord_id <> v_queue.payload ->> 'discord_id'
     OR v_contract.product_id <> v_order.product_id
     OR v_contract.product_name <> v_queue.payload ->> 'product_name'
     OR v_contract.order_number <> v_order.order_number
     OR v_contract.plan_id <> v_order.plan_id
     OR v_contract.paypal_subscription_id <> v_order.paypal_subscription_id
     OR v_contract.paypal_plan_id <> v_queue.payload ->> 'paypal_plan_id'
     OR v_contract.amount_cents <> v_order.amount_cents
     OR v_contract.currency <> v_order.currency
     OR v_contract.granted_role_ids_snapshot IS DISTINCT FROM v_roles
     OR v_contract.granted_channel_ids_snapshot IS DISTINCT FROM v_channels
     OR NOT pg_catalog.isfinite(v_contract.persisted_at) THEN
    RAISE EXCEPTION 'commerce_adopt_legacy_subscription_grant_contract: immutable replay mismatch';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_contract.order_id,
    'source_queue_id', v_contract.source_queue_id,
    'granted_role_ids_snapshot', pg_catalog.to_jsonb(v_contract.granted_role_ids_snapshot),
    'granted_channel_ids_snapshot', pg_catalog.to_jsonb(v_contract.granted_channel_ids_snapshot),
    'persisted_at', v_contract.persisted_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_adopt_legacy_subscription_grant_contract(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_adopt_legacy_subscription_grant_contract(UUID, UUID)
  TO service_role;

-- (payments.paypal_resource_type is added near the top of this file: the
-- LANGUAGE sql lifecycle functions above validate their bodies at creation
-- time, so the column must exist before those definitions run.)
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_resource_type_valid;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_resource_type_valid
  CHECK (paypal_resource_type IN ('capture', 'sale')) NOT VALID;

CREATE OR REPLACE FUNCTION public.commerce_assign_sale_payment_resource_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF NEW.paypal_resource_type IS NOT NULL OR NEW.order_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = NEW.order_id;

  IF FOUND
     AND (v_order.paypal_subscription_id IS NOT NULL OR v_order.plan_id IS NOT NULL) THEN
    NEW.paypal_resource_type := 'sale';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_payments_assign_sale_resource_type
  ON public.payments;
CREATE TRIGGER commerce_payments_assign_sale_resource_type
  BEFORE INSERT OR UPDATE OF order_id, paypal_resource_type ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_assign_sale_payment_resource_type();

REVOKE ALL ON FUNCTION public.commerce_assign_sale_payment_resource_type()
  FROM PUBLIC, anon, authenticated, service_role;

-- Exact subscription identities are sufficient proof that historical payment
-- children are PayPal sale resources.  One-time rows are deliberately not
-- backfilled: only a capture-specific provider event/RPC may prove them.
UPDATE public.payments AS payment
   SET paypal_resource_type = 'sale'
  FROM public.orders AS paid_order
 WHERE payment.order_id = paid_order.id
   AND payment.paypal_resource_type IS NULL
   AND (paid_order.paypal_subscription_id IS NOT NULL OR paid_order.plan_id IS NOT NULL);

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_resource_type_required;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_resource_type_required
  CHECK (paypal_resource_type IS NOT NULL) NOT VALID;

-- A one-time order has one settled capture.  The generated parent-state key
-- also prevents a pending/failed capture from becoming completed after the
-- order was refunded.  The FK is deferred because capture completion and
-- refund finalization move the payment and order together in one transaction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_id_status
  ON public.orders (id, status);

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS commerce_required_order_status TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN paypal_resource_type = 'capture' AND status = 'completed'
        THEN 'completed'::TEXT
      WHEN paypal_resource_type = 'capture' AND status IN ('refunded', 'reversed')
        THEN 'refunded'::TEXT
      ELSE NULL::TEXT
    END
  ) STORED;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS commerce_settled_capture_order_id UUID
  GENERATED ALWAYS AS (
    CASE
      WHEN paypal_resource_type = 'capture'
       AND status IN ('completed', 'refunded', 'reversed')
        THEN order_id
      ELSE NULL::UUID
    END
  ) STORED;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS commerce_capture_payment_identity_complete;
ALTER TABLE public.payments
  ADD CONSTRAINT commerce_capture_payment_identity_complete
  CHECK (
    commerce_required_order_status IS NULL
    OR (
      order_id IS NOT NULL
      AND customer_id IS NOT NULL
      AND guild_id IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS commerce_capture_payment_order_fk;
ALTER TABLE public.payments
  ADD CONSTRAINT commerce_capture_payment_order_fk
  FOREIGN KEY (order_id, commerce_required_order_status)
  REFERENCES public.orders (id, status)
  DEFERRABLE INITIALLY DEFERRED
  NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_commerce_settled_capture_per_order
  ON public.payments (commerce_settled_capture_order_id)
  WHERE commerce_settled_capture_order_id IS NOT NULL;

-- A cumulative total alone cannot identify which webhook was authorized to
-- drive the terminal status: replaying an old partial after a later full row
-- would otherwise reinterpret that partial as the full-refund event. The
-- insert guard below owns this immutable witness bit. A reversal is a terminal
-- witness when it consumes the remaining balance, including the supported
-- zero-remaining reversal after a prior full REFUNDED row.
ALTER TABLE public.payment_refunds
  ADD COLUMN IF NOT EXISTS is_terminal_event_witness BOOLEAN NOT NULL DEFAULT false;

-- Preserve exact terminal events applied by the pre-RPC webhook only when its
-- full audit witness and terminal payment state agree. Ambiguous crash states
-- (full ledger without the matching full audit/status) deliberately remain
-- false and require operator reconciliation rather than guessed recovery.
WITH terminal_candidate AS (
  SELECT refund.id,
         pg_catalog.count(*) OVER (PARTITION BY payment.id) AS candidate_count
    FROM public.payment_refunds AS refund
    JOIN public.payments AS payment ON payment.id = refund.payment_id
    JOIN public.orders AS paid_order
      ON paid_order.id = payment.order_id
     AND paid_order.id = refund.order_id
     AND paid_order.guild_id = payment.guild_id
     AND paid_order.guild_id = refund.guild_id
   WHERE payment.status IN ('refunded', 'reversed')
     AND payment.paypal_payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     AND refund.paypal_refund_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     AND payment.amount_cents = paid_order.amount_cents
     AND paid_order.amount_cents > 0
     AND payment.currency = pg_catalog.btrim(payment.currency)
     AND pg_catalog.upper(payment.currency) = paid_order.currency
     AND paid_order.currency ~ '^[A-Z]{3}$'
     AND paid_order.status = 'refunded'
     AND (
       (
         refund.event_type IN (
           'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'
         )
         AND paid_order.plan_id IS NULL
         AND paid_order.paypal_subscription_id IS NULL
         AND (
           paid_order.paypal_order_id IS NULL
           OR paid_order.paypal_order_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
         )
       )
       OR (
         refund.event_type IN (
           'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED'
         )
         AND paid_order.plan_id IS NOT NULL
         AND paid_order.paypal_subscription_id IS NOT NULL
       )
     )
     AND (
       (
         payment.status = 'refunded'
         AND refund.event_type IN (
           'PAYMENT.CAPTURE.REFUNDED',
           'PAYMENT.SALE.REFUNDED'
         )
       )
       OR (
         payment.status = 'reversed'
         AND refund.event_type IN (
           'PAYMENT.CAPTURE.REVERSED',
           'PAYMENT.SALE.REVERSED'
         )
       )
     )
     AND EXISTS (
       SELECT 1
         FROM public.audit_logs AS audit
        WHERE audit.guild_id = refund.guild_id
          AND audit.actor_type = 'system'
          AND audit.actor_id = 'paypal_webhook'
          AND audit.target_type = 'order'
          AND audit.target_id = refund.order_id::TEXT
          AND audit.action = CASE payment.status
            WHEN 'reversed' THEN 'order.reversed'
            ELSE 'order.refunded_external'
          END
          AND audit.details ->> 'paypal_refund_id' = refund.paypal_refund_id
          AND audit.details ->> 'event_type' = refund.event_type
          AND audit.details ->> 'refund_scope' = 'full'
     )
     AND (
       SELECT COALESCE(pg_catalog.sum(ledger.amount_cents), 0)
         FROM public.payment_refunds AS ledger
        WHERE ledger.payment_id = payment.id
     ) = payment.amount_cents
)
UPDATE public.payment_refunds AS refund
   SET is_terminal_event_witness = true
  FROM terminal_candidate AS candidate
 WHERE candidate.id = refund.id
   AND candidate.candidate_count = 1;

-- Serialize external PayPal refund ledger writes on the exact payment. This
-- closes the read-remaining/insert race for signed reversal events and gives
-- the webhook a durable idempotency witness before it performs access effects.
CREATE OR REPLACE FUNCTION public.commerce_record_paypal_refund_event(
  p_payment_id UUID,
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_paypal_payment_id TEXT,
  p_resource_type TEXT,
  p_paypal_refund_id TEXT,
  p_event_type TEXT,
  p_refund_amount_cents INTEGER,
  p_currency TEXT,
  p_audit_details JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_existing_refund public.payment_refunds%ROWTYPE;
  v_discord_id TEXT;
  v_resource_type TEXT := pg_catalog.lower(pg_catalog.btrim(p_resource_type));
  v_event_type TEXT := pg_catalog.upper(pg_catalog.btrim(p_event_type));
  v_currency TEXT;
  v_payment_currency TEXT;
  v_amount_cents INTEGER;
  v_refunded_cents BIGINT := 0;
  v_invalid_refund_count INTEGER := 0;
  v_remaining_cents INTEGER;
  v_already_recorded BOOLEAN := false;
  v_full_refund BOOLEAN := false;
  v_terminal_witness BOOLEAN := false;
  v_terminal_history_consistent BOOLEAN := true;
  v_terminal_history_replay BOOLEAN := false;
  v_has_refund_terminal_witness BOOLEAN := false;
  v_has_reversal_terminal_witness BOOLEAN := false;
  v_partial_audit_recorded BOOLEAN := false;
  v_partial_alert_recorded BOOLEAN := false;
  v_partial_audit_details JSONB;
  v_rows_changed INTEGER := 0;
BEGIN
  IF p_payment_id IS NULL OR p_order_id IS NULL OR p_customer_id IS NULL
     OR p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_paypal_payment_id IS NULL
     OR p_paypal_payment_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR p_paypal_refund_id IS NULL
     OR p_paypal_refund_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR pg_catalog.jsonb_typeof(p_audit_details) IS DISTINCT FROM 'object'
     OR NOT (
       (v_resource_type = 'capture' AND v_event_type IN (
         'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'
       ))
       OR (v_resource_type = 'sale' AND v_event_type IN (
         'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED'
       ))
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_paypal_refund_event: canonical identity and event are required';
  END IF;

  SELECT paid_order.* INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
   FOR UPDATE;
  IF NOT FOUND OR v_order.status NOT IN ('completed', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_paypal_refund_event: order identity or state mismatch';
  END IF;

  SELECT payment.* INTO v_payment
    FROM public.payments AS payment
   WHERE payment.id = p_payment_id
     AND payment.order_id = p_order_id
     AND payment.guild_id = p_guild_id
     AND payment.customer_id = p_customer_id
     AND payment.paypal_payment_id = p_paypal_payment_id
     AND payment.provider = 'paypal'
     AND (payment.paypal_resource_type = v_resource_type
       OR payment.paypal_resource_type IS NULL)
   FOR UPDATE;
  IF NOT FOUND OR v_payment.status NOT IN ('completed', 'refunded', 'reversed')
     OR v_payment.amount_cents IS NULL OR v_payment.amount_cents <= 0
     OR v_order.amount_cents IS NULL OR v_order.amount_cents <= 0
     OR v_payment.amount_cents IS DISTINCT FROM v_order.amount_cents
     OR v_payment.currency IS NULL
     OR v_payment.currency <> pg_catalog.btrim(v_payment.currency)
     OR pg_catalog.upper(v_payment.currency) !~ '^[A-Z]{3}$'
     OR v_order.currency IS NULL OR v_order.currency !~ '^[A-Z]{3}$'
     OR pg_catalog.upper(v_payment.currency) IS DISTINCT FROM v_order.currency
     OR (
       v_resource_type = 'capture'
       AND (
         v_order.plan_id IS NOT NULL
         OR v_order.paypal_subscription_id IS NOT NULL
         OR (
           v_order.paypal_order_id IS NOT NULL
           AND v_order.paypal_order_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
         )
       )
     )
     OR (
       v_resource_type = 'sale'
       AND (v_order.plan_id IS NULL OR v_order.paypal_subscription_id IS NULL)
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_paypal_refund_event: payment identity or state mismatch';
  END IF;
  IF v_payment.paypal_resource_type IS NULL THEN
    UPDATE public.payments AS payment
       SET paypal_resource_type = v_resource_type
     WHERE payment.id = v_payment.id
       AND payment.paypal_resource_type IS NULL
    RETURNING payment.* INTO v_payment;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_record_paypal_refund_event: payment resource adoption race';
    END IF;
  END IF;
  v_payment_currency := pg_catalog.upper(v_payment.currency);

  PERFORM 1
    FROM public.payment_refunds AS refund
   WHERE refund.payment_id = v_payment.id
   ORDER BY refund.id
   FOR UPDATE;

  -- NOT VALID historical child constraints deliberately preserve inspectable
  -- legacy rows. Before accepting a signed refund, independently prove that
  -- every order-linked access child is in the exact financial/resource scope
  -- the handler will revoke; otherwise terminalizing the parent could strand
  -- live access outside the handler's canonical filters.
  SELECT customer.discord_id
    INTO v_discord_id
    FROM public.customers AS customer
   WHERE customer.id = v_order.customer_id
     AND customer.guild_id = v_order.guild_id
   FOR SHARE;
  IF NOT FOUND OR v_discord_id IS NULL OR pg_catalog.btrim(v_discord_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_paypal_refund_event: access provenance requires operator remediation';
  END IF;
  PERFORM grant_row.id
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.order_id = v_order.id
   ORDER BY grant_row.id
   FOR SHARE;
  IF EXISTS (
    SELECT 1
      FROM public.temp_role_grants AS grant_row
     WHERE grant_row.order_id = v_order.id
       AND grant_row.grant_status IN ('pending', 'applied')
       AND (
         grant_row.guild_id IS DISTINCT FROM v_order.guild_id
         OR grant_row.user_id IS DISTINCT FROM v_discord_id
         OR grant_row.source IS DISTINCT FROM 'commerce_purchase'
         OR grant_row.source_id IS DISTINCT FROM v_order.product_id::TEXT
         OR grant_row.duration_seconds IS NULL
         OR grant_row.duration_seconds <= 0
         OR grant_row.duration_seconds > 315360000
         OR v_order.paypal_subscription_id IS NOT NULL
         OR v_order.plan_id IS NOT NULL
         OR v_order.grant_snapshot_frozen_at IS NULL
         OR NOT public.commerce_valid_temp_role_snapshot(
           v_order.temporary_role_grants_snapshot
         )
         OR NOT EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(
               v_order.temporary_role_grants_snapshot
             ) AS frozen_grant(value)
            WHERE frozen_grant.value ->> 'role_id' = grant_row.role_id
              AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
                = grant_row.duration_seconds
         )
         OR (
           grant_row.grant_status = 'pending'
           AND grant_row.applied_at IS NOT NULL
         )
         OR (
           grant_row.grant_status = 'applied'
           AND (
             grant_row.applied_at IS NULL
             OR grant_row.expires_at IS DISTINCT FROM grant_row.applied_at
               + (grant_row.duration_seconds * interval '1 second')
           )
         )
         OR NOT EXISTS (
           SELECT 1
             FROM public.entitlements AS entitlement
            WHERE entitlement.order_id = v_order.id
              AND entitlement.guild_id = v_order.guild_id
              AND entitlement.customer_id = v_order.customer_id
              AND entitlement.product_id = v_order.product_id
              AND entitlement.type = 'one_time'
              AND entitlement.status IN (
                'active', 'pending', 'grace_period', 'suspended'
              )
              AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
         )
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_paypal_refund_event: access provenance requires operator remediation';
  END IF;
  PERFORM entitlement.id
    FROM public.entitlements AS entitlement
   WHERE entitlement.order_id = v_order.id
      OR EXISTS (
        SELECT 1 FROM public.license_keys AS license_key
         WHERE license_key.id = entitlement.license_key_id
           AND license_key.order_id = v_order.id
      )
   ORDER BY entitlement.id
   FOR SHARE;
  PERFORM license_key.id
    FROM public.license_keys AS license_key
   WHERE license_key.order_id = v_order.id
      OR EXISTS (
        SELECT 1 FROM public.entitlements AS entitlement
         WHERE entitlement.license_key_id = license_key.id
           AND entitlement.order_id = v_order.id
      )
   ORDER BY license_key.id
   FOR SHARE;
  IF EXISTS (
    SELECT 1 FROM public.entitlements AS entitlement
     WHERE entitlement.order_id = v_order.id
       AND (
         entitlement.guild_id IS DISTINCT FROM v_order.guild_id
         OR entitlement.customer_id IS DISTINCT FROM v_order.customer_id
         OR entitlement.product_id IS DISTINCT FROM v_order.product_id
         OR COALESCE(entitlement.source, 'purchase')
           IS DISTINCT FROM COALESCE(v_order.source, 'purchase')
         OR (
           v_resource_type = 'capture'
           AND (
             entitlement.plan_id IS NOT NULL
             OR entitlement.type IS DISTINCT FROM 'one_time'
           )
         )
         OR (
           v_resource_type = 'sale'
           AND (
             entitlement.plan_id IS DISTINCT FROM v_order.plan_id
             OR entitlement.type IS DISTINCT FROM 'subscription'
           )
         )
       )
  ) OR EXISTS (
    SELECT 1 FROM public.license_keys AS license_key
     WHERE license_key.order_id = v_order.id
       AND (
         license_key.guild_id IS DISTINCT FROM v_order.guild_id
         OR license_key.customer_id IS DISTINCT FROM v_order.customer_id
         OR license_key.product_id IS DISTINCT FROM v_order.product_id
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.entitlements AS entitlement
      JOIN public.license_keys AS license_key
        ON license_key.id = entitlement.license_key_id
     WHERE (entitlement.order_id = v_order.id OR license_key.order_id = v_order.id)
       AND (
         entitlement.order_id IS DISTINCT FROM v_order.id
         OR license_key.order_id IS DISTINCT FROM v_order.id
         OR entitlement.guild_id IS DISTINCT FROM v_order.guild_id
         OR license_key.guild_id IS DISTINCT FROM v_order.guild_id
         OR entitlement.customer_id IS DISTINCT FROM v_order.customer_id
         OR license_key.customer_id IS DISTINCT FROM v_order.customer_id
         OR entitlement.product_id IS DISTINCT FROM v_order.product_id
         OR license_key.product_id IS DISTINCT FROM v_order.product_id
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_paypal_refund_event: access provenance requires operator remediation';
  END IF;

  SELECT COALESCE(pg_catalog.sum(refund.amount_cents), 0),
         pg_catalog.count(*) FILTER (
           WHERE refund.order_id IS DISTINCT FROM v_order.id
              OR refund.guild_id IS DISTINCT FROM v_order.guild_id
              OR refund.paypal_refund_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
              OR refund.amount_cents IS NULL OR refund.amount_cents < 0
               OR (
                 refund.event_type IN (
                   'ADMIN.REFUND',
                   'PAYMENT.CAPTURE.REFUNDED',
                   'PAYMENT.SALE.REFUNDED'
                 )
                 AND refund.amount_cents <= 0
               )
               OR (
                 refund.event_type IN (
                   'PAYMENT.CAPTURE.REVERSED',
                   'PAYMENT.SALE.REVERSED'
                 )
                 AND NOT refund.is_terminal_event_witness
               )
               OR pg_catalog.upper(refund.currency) IS DISTINCT FROM v_payment_currency
              OR refund.paypal_resource_type IS DISTINCT FROM v_resource_type
              OR (
                v_resource_type = 'capture'
                AND refund.event_type NOT IN (
                  'ADMIN.REFUND', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'
                )
              )
              OR (
                v_resource_type = 'sale'
                AND refund.event_type NOT IN ('PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED')
              )
         )::INTEGER
    INTO v_refunded_cents, v_invalid_refund_count
    FROM public.payment_refunds AS refund
   WHERE refund.payment_id = v_payment.id;
  IF v_invalid_refund_count > 0 OR v_refunded_cents > v_payment.amount_cents THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_paypal_refund_event: refund ledger requires operator remediation';
  END IF;

  SELECT refund.* INTO v_existing_refund
    FROM public.payment_refunds AS refund
   WHERE refund.paypal_refund_id = p_paypal_refund_id;
  -- Rows for this payment were locked above. A provider id already attached to
  -- another payment is only an immutable identity witness, so do not lock that
  -- foreign row after taking this payment's locks: two cross-wired deliveries
  -- must fail closed rather than deadlock each other.
  IF FOUND THEN
    IF v_existing_refund.payment_id IS DISTINCT FROM v_payment.id
       OR v_existing_refund.order_id IS DISTINCT FROM v_order.id
       OR v_existing_refund.guild_id IS DISTINCT FROM v_order.guild_id
       OR NOT (
         v_existing_refund.event_type = v_event_type
         OR (
           v_resource_type = 'capture'
           AND v_event_type = 'PAYMENT.CAPTURE.REFUNDED'
           AND v_existing_refund.event_type = 'ADMIN.REFUND'
           AND v_existing_refund.is_terminal_event_witness
         )
       )
       OR v_existing_refund.paypal_resource_type IS DISTINCT FROM v_resource_type
       OR (
         pg_catalog.right(v_event_type, 9) <> '.REVERSED'
         AND (p_refund_amount_cents IS NULL OR p_currency IS NULL)
       )
       OR (p_refund_amount_cents IS NOT NULL
         AND v_existing_refund.amount_cents IS DISTINCT FROM p_refund_amount_cents)
       OR (p_currency IS NOT NULL
         AND pg_catalog.upper(v_existing_refund.currency)
           IS DISTINCT FROM pg_catalog.upper(pg_catalog.btrim(p_currency))) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_record_paypal_refund_event: refund replay identity mismatch';
    END IF;
    v_amount_cents := v_existing_refund.amount_cents;
    v_currency := pg_catalog.upper(v_existing_refund.currency);
    v_already_recorded := true;
  ELSE
    IF v_payment.status IN ('refunded', 'reversed') THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_record_paypal_refund_event: terminal payment accepts exact recorded history only';
    END IF;
    v_remaining_cents := v_payment.amount_cents - v_refunded_cents::INTEGER;
    IF pg_catalog.right(v_event_type, 9) = '.REVERSED' THEN
      IF EXISTS (
        SELECT 1 FROM public.payment_refunds AS refund
         WHERE refund.payment_id = v_payment.id
           AND refund.event_type IN ('PAYMENT.CAPTURE.REVERSED', 'PAYMENT.SALE.REVERSED')
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce_record_paypal_refund_event: a different reversal witness already exists';
      END IF;
      IF p_refund_amount_cents IS NOT NULL
         AND p_refund_amount_cents IS DISTINCT FROM v_remaining_cents THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce_record_paypal_refund_event: reversal amount must equal the remaining balance';
      END IF;
      IF p_currency IS NOT NULL
         AND pg_catalog.upper(pg_catalog.btrim(p_currency)) IS DISTINCT FROM v_payment_currency THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce_record_paypal_refund_event: reversal currency mismatch';
      END IF;
      v_amount_cents := v_remaining_cents;
      v_currency := v_payment_currency;
    ELSE
      v_currency := pg_catalog.upper(pg_catalog.btrim(p_currency));
      IF p_refund_amount_cents IS NULL OR p_refund_amount_cents <= 0
         OR p_refund_amount_cents > v_remaining_cents
         OR v_currency IS DISTINCT FROM v_payment_currency THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce_record_paypal_refund_event: refund money is ambiguous or exceeds the remaining balance';
      END IF;
      v_amount_cents := p_refund_amount_cents;
    END IF;

    INSERT INTO public.payment_refunds (
      payment_id, order_id, guild_id, paypal_refund_id,
      event_type, amount_cents, currency
    ) VALUES (
      v_payment.id, v_order.id, v_order.guild_id, p_paypal_refund_id,
      v_event_type, v_amount_cents, v_currency
    ) RETURNING * INTO v_existing_refund;
    v_refunded_cents := v_refunded_cents + v_amount_cents;
  END IF;

  v_full_refund := v_refunded_cents = v_payment.amount_cents;
  SELECT
    COALESCE(pg_catalog.bool_or(
      refund.is_terminal_event_witness
      AND refund.event_type IN (
        'ADMIN.REFUND',
        'PAYMENT.CAPTURE.REFUNDED',
        'PAYMENT.SALE.REFUNDED'
      )
    ), false),
    COALESCE(pg_catalog.bool_or(
      refund.is_terminal_event_witness
      AND refund.event_type IN (
        'PAYMENT.CAPTURE.REVERSED',
        'PAYMENT.SALE.REVERSED'
      )
    ), false)
    INTO v_has_refund_terminal_witness, v_has_reversal_terminal_witness
    FROM public.payment_refunds AS refund
   WHERE refund.payment_id = v_payment.id;

  -- A reversal witness supersedes an earlier full-refund witness while the
  -- payment is still nonterminal. This makes a delayed old REFUNDED replay
  -- known history, never a new authorization to finalize as refunded.
  v_terminal_witness := COALESCE(v_existing_refund.is_terminal_event_witness, false)
    AND (
      pg_catalog.right(v_event_type, 9) = '.REVERSED'
      OR NOT v_has_reversal_terminal_witness
    );
  IF v_payment.status = 'refunded' THEN
    v_terminal_history_consistent :=
      v_has_refund_terminal_witness AND NOT v_has_reversal_terminal_witness;
  ELSIF v_payment.status = 'reversed' THEN
    v_terminal_history_consistent := v_has_reversal_terminal_witness;
  END IF;
  IF v_payment.status = 'completed'
     AND v_full_refund
     AND NOT (
       v_has_refund_terminal_witness OR v_has_reversal_terminal_witness
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_paypal_refund_event: full refund ledger lacks an authorized terminal witness';
  END IF;
  IF NOT v_terminal_history_consistent THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_paypal_refund_event: terminal payment ledger requires operator remediation';
  END IF;
  v_terminal_history_replay := v_payment.status IN ('refunded', 'reversed');

  IF NOT v_full_refund THEN
    v_partial_audit_details := p_audit_details || pg_catalog.jsonb_build_object(
      'event_type', v_event_type,
      'paypal_refund_id', p_paypal_refund_id,
      'refund_scope', 'partial',
      CASE v_resource_type WHEN 'capture' THEN 'capture_id' ELSE 'sale_id' END,
      p_paypal_payment_id,
      'refund_amount_cents', v_amount_cents,
      'payment_amount_cents', v_payment.amount_cents,
      'cumulative_refunded_cents', v_refunded_cents,
      'currency', v_currency,
      'decision', 'access_retained_pending_review'
    );
    IF NOT EXISTS (
      SELECT 1
        FROM public.audit_logs AS audit
       WHERE audit.guild_id = v_order.guild_id
         AND audit.actor_type = 'system'
         AND audit.actor_id = 'paypal_webhook'
         AND audit.action = 'order.refund_partial'
         AND audit.target_type = 'order'
         AND audit.target_id = v_order.id::TEXT
         AND audit.details ->> 'paypal_refund_id' = p_paypal_refund_id
    ) THEN
      INSERT INTO public.audit_logs (
        guild_id, actor_type, actor_id, action, target_type, target_id, details
      ) VALUES (
        v_order.guild_id, 'system', 'paypal_webhook', 'order.refund_partial',
        'order', v_order.id::TEXT, v_partial_audit_details
      );
      v_partial_audit_recorded := true;
    END IF;
    INSERT INTO public.alerts (
      guild_id, alert_type, severity, title, message, metadata, resolved
    ) VALUES (
      v_order.guild_id,
      'partial_refund_review',
      'warning',
      'Partial PayPal refund - review required',
      'PayPal reported a partial refund; access was retained pending operator review.',
      pg_catalog.jsonb_build_object(
        'source', 'paypal_webhook',
        'event_type', v_event_type,
        'paypal_refund_id', p_paypal_refund_id,
        CASE v_resource_type WHEN 'capture' THEN 'capture_id' ELSE 'sale_id' END,
        p_paypal_payment_id,
        'order_id', v_order.id,
        'payment_id', v_payment.id,
        'refund_amount_cents', v_amount_cents,
        'payment_amount_cents', v_payment.amount_cents,
        'cumulative_refunded_cents', v_refunded_cents,
        'currency', v_currency
      ),
      false
    ) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows_changed = ROW_COUNT;
    v_partial_alert_recorded := v_rows_changed = 1;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'payment_id', v_payment.id,
    'order_id', v_order.id,
    'paypal_refund_id', p_paypal_refund_id,
    'event_type', v_event_type,
    'refund_amount_cents', v_amount_cents,
    'currency', v_currency,
    'cumulative_refunded_cents', v_refunded_cents,
    'full_refund', v_full_refund,
    'terminal_witness', v_terminal_witness,
    'terminal_history_consistent', v_terminal_history_consistent,
    'terminal_history_replay', v_terminal_history_replay,
    'terminal_payment_status', v_payment.status,
    'already_recorded', v_already_recorded,
    'partial_audit_recorded', v_partial_audit_recorded,
    'partial_alert_recorded', v_partial_alert_recorded
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_record_paypal_refund_event(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_record_paypal_refund_event(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB
) TO service_role;

-- External PayPal refund/reversal webhooks must move the payment child and
-- its order parent in one database transaction. Separate PostgREST updates
-- cannot satisfy the deferred capture/order invariant at either commit.
CREATE OR REPLACE FUNCTION public.commerce_finalize_paypal_refund_status(
  p_payment_id UUID,
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_paypal_payment_id TEXT,
  p_resource_type TEXT,
  p_payment_status TEXT,
  p_paypal_refund_id TEXT,
  p_event_type TEXT,
  p_audit_details JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_discord_id TEXT;
  v_resource_type TEXT := pg_catalog.lower(pg_catalog.btrim(p_resource_type));
  v_target_status TEXT := pg_catalog.lower(pg_catalog.btrim(p_payment_status));
  v_event_type TEXT := pg_catalog.upper(pg_catalog.btrim(p_event_type));
  v_actual_status TEXT;
  v_already_terminal BOOLEAN := false;
  v_audit_recorded BOOLEAN := false;
  v_audit_action TEXT;
  v_audit_details JSONB;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_refunded_cents BIGINT := 0;
  v_invalid_refund_count INTEGER := 0;
  v_partial_alerts_resolved INTEGER := 0;
BEGIN
  IF p_payment_id IS NULL OR p_order_id IS NULL OR p_customer_id IS NULL
     OR p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_paypal_payment_id IS NULL
     OR p_paypal_payment_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR p_paypal_refund_id IS NULL
     OR p_paypal_refund_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR v_resource_type NOT IN ('capture', 'sale')
     OR v_target_status NOT IN ('refunded', 'reversed')
     OR pg_catalog.jsonb_typeof(p_audit_details) IS DISTINCT FROM 'object'
     OR NOT (
       (v_resource_type = 'capture' AND v_event_type IN (
         'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'
       ))
       OR (v_resource_type = 'sale' AND v_event_type IN (
         'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED'
       ))
     )
     OR (v_target_status = 'reversed') IS DISTINCT FROM
        (pg_catalog.right(v_event_type, 9) = '.REVERSED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_paypal_refund_status: canonical identity and target are required';
  END IF;

  SELECT paid_order.* INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.customer_id = p_customer_id
   FOR UPDATE;
  IF NOT FOUND OR v_order.status NOT IN ('completed', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_paypal_refund_status: order identity or state mismatch';
  END IF;

  SELECT payment.* INTO v_payment
    FROM public.payments AS payment
   WHERE payment.id = p_payment_id
     AND payment.order_id = p_order_id
     AND payment.guild_id = p_guild_id
     AND payment.customer_id = p_customer_id
     AND payment.paypal_payment_id = p_paypal_payment_id
     AND payment.paypal_resource_type = v_resource_type
     AND payment.provider = 'paypal'
   FOR UPDATE;
  IF NOT FOUND OR v_payment.status NOT IN ('completed', 'refunded', 'reversed')
     OR v_payment.amount_cents IS NULL OR v_payment.amount_cents <= 0
     OR v_order.amount_cents IS NULL OR v_order.amount_cents <= 0
     OR v_payment.amount_cents IS DISTINCT FROM v_order.amount_cents
     OR v_payment.currency IS NULL
     OR v_payment.currency <> pg_catalog.btrim(v_payment.currency)
     OR pg_catalog.upper(v_payment.currency) !~ '^[A-Z]{3}$'
     OR v_order.currency IS NULL OR v_order.currency !~ '^[A-Z]{3}$'
     OR pg_catalog.upper(v_payment.currency) IS DISTINCT FROM v_order.currency
     OR (
       v_resource_type = 'capture'
       AND (
         v_order.plan_id IS NOT NULL
         OR v_order.paypal_subscription_id IS NOT NULL
         OR (
           v_order.paypal_order_id IS NOT NULL
           AND v_order.paypal_order_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
         )
       )
     )
     OR (
       v_resource_type = 'sale'
       AND (v_order.plan_id IS NULL OR v_order.paypal_subscription_id IS NULL)
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_paypal_refund_status: payment identity or state mismatch';
  END IF;

  IF v_payment.status IN ('refunded', 'reversed')
     AND v_payment.status IS DISTINCT FROM v_target_status THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_paypal_refund_status: terminal payment status conflicts with event';
  END IF;

  PERFORM 1
    FROM public.payment_refunds AS refund
   WHERE refund.payment_id = v_payment.id
   ORDER BY refund.id
   FOR UPDATE;

  -- Repeat the complete legacy-child proof here rather than trusting the
  -- earlier record RPC. Finalization can be retried independently after a
  -- crash, and the terminal parent marker must never outrun hidden live access.
  SELECT customer.discord_id
    INTO v_discord_id
    FROM public.customers AS customer
   WHERE customer.id = v_order.customer_id
     AND customer.guild_id = v_order.guild_id
   FOR SHARE;
  IF NOT FOUND OR v_discord_id IS NULL OR pg_catalog.btrim(v_discord_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_paypal_refund_status: access provenance requires operator remediation';
  END IF;
  PERFORM grant_row.id
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.order_id = v_order.id
   ORDER BY grant_row.id
   FOR SHARE;
  IF EXISTS (
    SELECT 1
      FROM public.temp_role_grants AS grant_row
     WHERE grant_row.order_id = v_order.id
       AND grant_row.grant_status IN ('pending', 'applied')
       AND (
         grant_row.guild_id IS DISTINCT FROM v_order.guild_id
         OR grant_row.user_id IS DISTINCT FROM v_discord_id
         OR grant_row.source IS DISTINCT FROM 'commerce_purchase'
         OR grant_row.source_id IS DISTINCT FROM v_order.product_id::TEXT
         OR grant_row.duration_seconds IS NULL
         OR grant_row.duration_seconds <= 0
         OR grant_row.duration_seconds > 315360000
         OR v_order.paypal_subscription_id IS NOT NULL
         OR v_order.plan_id IS NOT NULL
         OR v_order.grant_snapshot_frozen_at IS NULL
         OR NOT public.commerce_valid_temp_role_snapshot(
           v_order.temporary_role_grants_snapshot
         )
         OR NOT EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(
               v_order.temporary_role_grants_snapshot
             ) AS frozen_grant(value)
            WHERE frozen_grant.value ->> 'role_id' = grant_row.role_id
              AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
                = grant_row.duration_seconds
         )
         OR (
           grant_row.grant_status = 'pending'
           AND grant_row.applied_at IS NOT NULL
         )
         OR (
           grant_row.grant_status = 'applied'
           AND (
             grant_row.applied_at IS NULL
             OR grant_row.expires_at IS DISTINCT FROM grant_row.applied_at
               + (grant_row.duration_seconds * interval '1 second')
           )
         )
         OR NOT EXISTS (
           SELECT 1
             FROM public.entitlements AS entitlement
            WHERE entitlement.order_id = v_order.id
              AND entitlement.guild_id = v_order.guild_id
              AND entitlement.customer_id = v_order.customer_id
              AND entitlement.product_id = v_order.product_id
              AND entitlement.type = 'one_time'
              AND entitlement.status IN (
                'active', 'pending', 'grace_period', 'suspended'
              )
              AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
         )
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_paypal_refund_status: access provenance requires operator remediation';
  END IF;
  PERFORM entitlement.id
    FROM public.entitlements AS entitlement
   WHERE entitlement.order_id = v_order.id
      OR EXISTS (
        SELECT 1 FROM public.license_keys AS license_key
         WHERE license_key.id = entitlement.license_key_id
           AND license_key.order_id = v_order.id
      )
   ORDER BY entitlement.id
   FOR SHARE;
  PERFORM license_key.id
    FROM public.license_keys AS license_key
   WHERE license_key.order_id = v_order.id
      OR EXISTS (
        SELECT 1 FROM public.entitlements AS entitlement
         WHERE entitlement.license_key_id = license_key.id
           AND entitlement.order_id = v_order.id
      )
   ORDER BY license_key.id
   FOR SHARE;
  IF EXISTS (
    SELECT 1 FROM public.entitlements AS entitlement
     WHERE entitlement.order_id = v_order.id
       AND (
         entitlement.guild_id IS DISTINCT FROM v_order.guild_id
         OR entitlement.customer_id IS DISTINCT FROM v_order.customer_id
         OR entitlement.product_id IS DISTINCT FROM v_order.product_id
         OR COALESCE(entitlement.source, 'purchase')
           IS DISTINCT FROM COALESCE(v_order.source, 'purchase')
         OR (
           v_resource_type = 'capture'
           AND (
             entitlement.plan_id IS NOT NULL
             OR entitlement.type IS DISTINCT FROM 'one_time'
           )
         )
         OR (
           v_resource_type = 'sale'
           AND (
             entitlement.plan_id IS DISTINCT FROM v_order.plan_id
             OR entitlement.type IS DISTINCT FROM 'subscription'
           )
         )
       )
  ) OR EXISTS (
    SELECT 1 FROM public.license_keys AS license_key
     WHERE license_key.order_id = v_order.id
       AND (
         license_key.guild_id IS DISTINCT FROM v_order.guild_id
         OR license_key.customer_id IS DISTINCT FROM v_order.customer_id
         OR license_key.product_id IS DISTINCT FROM v_order.product_id
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.entitlements AS entitlement
      JOIN public.license_keys AS license_key
        ON license_key.id = entitlement.license_key_id
     WHERE (entitlement.order_id = v_order.id OR license_key.order_id = v_order.id)
       AND (
         entitlement.order_id IS DISTINCT FROM v_order.id
         OR license_key.order_id IS DISTINCT FROM v_order.id
         OR entitlement.guild_id IS DISTINCT FROM v_order.guild_id
         OR license_key.guild_id IS DISTINCT FROM v_order.guild_id
         OR entitlement.customer_id IS DISTINCT FROM v_order.customer_id
         OR license_key.customer_id IS DISTINCT FROM v_order.customer_id
         OR entitlement.product_id IS DISTINCT FROM v_order.product_id
         OR license_key.product_id IS DISTINCT FROM v_order.product_id
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_paypal_refund_status: access provenance requires operator remediation';
  END IF;

  SELECT COALESCE(pg_catalog.sum(refund.amount_cents), 0),
         pg_catalog.count(*) FILTER (
           WHERE refund.order_id IS DISTINCT FROM v_order.id
              OR refund.guild_id IS DISTINCT FROM v_order.guild_id
              OR refund.paypal_refund_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
              OR refund.amount_cents IS NULL OR refund.amount_cents < 0
               OR (
                 refund.event_type IN (
                   'ADMIN.REFUND',
                   'PAYMENT.CAPTURE.REFUNDED',
                   'PAYMENT.SALE.REFUNDED'
                 )
                 AND refund.amount_cents <= 0
               )
               OR (
                 refund.event_type IN (
                   'PAYMENT.CAPTURE.REVERSED',
                   'PAYMENT.SALE.REVERSED'
                 )
                 AND NOT refund.is_terminal_event_witness
               )
               OR pg_catalog.upper(refund.currency)
                IS DISTINCT FROM pg_catalog.upper(v_payment.currency)
              OR refund.paypal_resource_type IS DISTINCT FROM v_resource_type
              OR (
                v_resource_type = 'capture'
                AND refund.event_type NOT IN (
                  'ADMIN.REFUND', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'
                )
              )
              OR (
                v_resource_type = 'sale'
                AND refund.event_type NOT IN ('PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED')
              )
         )::INTEGER
    INTO v_refunded_cents, v_invalid_refund_count
    FROM public.payment_refunds AS refund
   WHERE refund.payment_id = v_payment.id;
  IF v_invalid_refund_count > 0
     OR v_payment.amount_cents IS NULL
     OR v_refunded_cents IS DISTINCT FROM v_payment.amount_cents::BIGINT THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_paypal_refund_status: full durable refund proof is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.payment_refunds AS refund
     WHERE refund.payment_id = v_payment.id
       AND refund.order_id = v_order.id
       AND refund.guild_id = v_order.guild_id
        AND refund.paypal_refund_id = p_paypal_refund_id
        AND refund.event_type = v_event_type
        AND refund.paypal_resource_type = v_resource_type
        AND refund.is_terminal_event_witness
        AND (
          v_target_status = 'reversed'
          OR NOT EXISTS (
            SELECT 1
              FROM public.payment_refunds AS reversal
             WHERE reversal.payment_id = v_payment.id
               AND reversal.is_terminal_event_witness
               AND reversal.event_type IN (
                 'PAYMENT.CAPTURE.REVERSED',
                 'PAYMENT.SALE.REVERSED'
               )
          )
        )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_paypal_refund_status: exact terminal refund witness is required';
  END IF;

  IF v_payment.status IN ('refunded', 'reversed') THEN
    v_actual_status := v_payment.status;
    v_already_terminal := true;
  ELSE
    v_actual_status := v_target_status;
  END IF;

  UPDATE public.orders AS paid_order
     SET status = 'refunded', updated_at = v_now
   WHERE paid_order.id = v_order.id
     AND paid_order.status = 'completed';
  -- payments has no updated_at column (unlike orders/alerts); the admin
  -- finalize path makes the same status-only flip.
  UPDATE public.payments AS payment
     SET status = v_actual_status
   WHERE payment.id = v_payment.id
     AND payment.status = 'completed';

  UPDATE public.alerts AS alert
     SET resolved = true,
         resolved_at = COALESCE(alert.resolved_at, v_now),
         updated_at = v_now
   WHERE alert.guild_id = v_order.guild_id
     AND alert.alert_type = 'partial_refund_review'
     AND alert.resolved = false
     AND alert.metadata ->> 'order_id' = v_order.id::TEXT
     AND alert.metadata ->> 'payment_id' = v_payment.id::TEXT;
  GET DIAGNOSTICS v_partial_alerts_resolved = ROW_COUNT;

  -- The webhook expires this order's entitlements before it commits this
  -- terminal marker, and the delivery protocol terminal-signals any exact
  -- role-delivery intents through that status change. As in
  -- commerce_finalize_admin_refund, a legacy entitlement that granted roles
  -- but has no intent leaves Discord cleanup unproven: the provider refund
  -- proves money moved, not that Somnibot owns the Discord role, and only an
  -- operator can resolve the member's baseline. Replays converge on the one
  -- unresolved alert per entitlement.
  INSERT INTO public.alerts (
    guild_id, alert_type, severity, title, message, metadata, resolved
  )
  SELECT entitlement.guild_id,
         'commerce_role_cleanup_unproven',
         'critical',
         'Role cleanup ownership is unproven',
         'A refund revoked this access, but no exact role-delivery intent proves which Discord roles Somnibot owns.',
         pg_catalog.jsonb_build_object(
           'entitlement_id', entitlement.id,
           'customer_id', entitlement.customer_id,
           'order_id', entitlement.order_id,
           'product_id', entitlement.product_id,
           'next_step', 'inspect_member_baseline_and_resolve_manually'
         ),
         false
    FROM public.entitlements AS entitlement
   WHERE entitlement.order_id = v_order.id
     AND pg_catalog.cardinality(
           COALESCE(entitlement.granted_role_ids, '{}'::TEXT[])
         ) > 0
     AND NOT EXISTS (
       SELECT 1
         FROM public.commerce_role_delivery_intents AS intent
        WHERE intent.entitlement_id = entitlement.id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.alerts AS alert
        WHERE alert.guild_id = entitlement.guild_id
          AND alert.alert_type = 'commerce_role_cleanup_unproven'
          AND alert.resolved = false
          AND alert.metadata ->> 'entitlement_id' = entitlement.id::TEXT
     );

  v_audit_action := CASE v_target_status
    WHEN 'reversed' THEN 'order.reversed'
    ELSE 'order.refunded_external'
  END;
  v_audit_details := p_audit_details || pg_catalog.jsonb_build_object(
    'event_type', v_event_type,
    'paypal_refund_id', p_paypal_refund_id,
    'refund_scope', 'full',
    CASE v_resource_type WHEN 'capture' THEN 'capture_id' ELSE 'sale_id' END,
    p_paypal_payment_id
  );
  IF NOT EXISTS (
    SELECT 1
      FROM public.audit_logs AS audit
     WHERE audit.guild_id = v_order.guild_id
       AND audit.actor_type = 'system'
       AND audit.actor_id = 'paypal_webhook'
       AND audit.action = v_audit_action
       AND audit.target_type = 'order'
       AND audit.target_id = v_order.id::TEXT
       AND audit.details ->> 'paypal_refund_id' = p_paypal_refund_id
  ) THEN
    INSERT INTO public.audit_logs (
      guild_id, actor_type, actor_id, action, target_type, target_id, details
    ) VALUES (
      v_order.guild_id, 'system', 'paypal_webhook', v_audit_action,
      'order', v_order.id::TEXT, v_audit_details
    );
    v_audit_recorded := true;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_order.id,
    'payment_id', v_payment.id,
    'order_status', 'refunded',
    'payment_status', v_actual_status,
    'already_terminal', v_already_terminal,
    'audit_recorded', v_audit_recorded,
    'partial_alerts_resolved', v_partial_alerts_resolved
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_finalize_paypal_refund_status(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_finalize_paypal_refund_status(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;

-- Record a PayPal capture, customer totals, and the exact order transition in
-- one transaction. A repeated capture validates identity and returns the
-- existing result without incrementing totals again.
CREATE OR REPLACE FUNCTION public.commerce_finalize_paypal_capture(
  p_order_id UUID,
  p_guild_id TEXT,
  p_customer_id UUID,
  p_product_id UUID,
  p_paypal_order_id TEXT,
  p_paypal_capture_id TEXT,
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
  v_target_status TEXT;
  v_payment_created BOOLEAN := false;
  v_replay_state_valid BOOLEAN := false;
  v_customer_count INTEGER;
BEGIN
  IF p_order_id IS NULL OR p_customer_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: order, customer, and product are required';
  END IF;
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: guild is required';
  END IF;
  IF p_paypal_capture_id IS NULL
     OR p_paypal_capture_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$' THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: capture id is required';
  END IF;
  IF p_paypal_order_id IS NULL
     OR p_paypal_order_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$' THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: PayPal order id is required';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: amount must be positive';
  END IF;
  IF p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: currency must be a three-letter uppercase code';
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
     OR v_order.paypal_order_id IS DISTINCT FROM p_paypal_order_id
     OR v_order.amount_cents <= 0 THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: order identity mismatch';
  END IF;

  -- Customer identity remains live because completed capture updates its
  -- totals. Do not join the mutable products catalog here: the locked order's
  -- frozen product/guild identity remains authoritative after catalog moves.
  IF NOT EXISTS (
    SELECT 1
      FROM public.customers AS customer
     WHERE customer.id = p_customer_id
       AND customer.guild_id = p_guild_id
  ) THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: customer identity mismatch';
  END IF;

  IF v_order.paypal_subscription_id IS NOT NULL OR v_order.plan_id IS NOT NULL THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: subscription order is not a capture order';
  END IF;

  IF NOT (v_order.source = 'purchase' OR v_order.source IS NULL) THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: order is not a purchase';
  END IF;

  v_target_status := CASE
    WHEN p_amount_cents = v_order.amount_cents
     -- Provider input is canonical uppercase. Historical orders predate that
     -- contract, so normalize only the stored value's case for comparison;
     -- malformed whitespace or other currency text still cannot compare.
     AND p_currency = pg_catalog.upper(v_order.currency)
      THEN 'completed'
    ELSE 'pending_review'
  END;

  SELECT payment.*
    INTO v_payment
    FROM public.payments AS payment
   WHERE payment.paypal_payment_id = p_paypal_capture_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_payment.order_id IS DISTINCT FROM p_order_id
       OR v_payment.customer_id IS DISTINCT FROM p_customer_id
       OR v_payment.guild_id IS DISTINCT FROM p_guild_id
       OR v_payment.amount_cents IS DISTINCT FROM p_amount_cents
       -- Legacy capture writers copied the order currency verbatim, before
       -- provider currency was canonicalized. Normalize stored case only;
       -- whitespace, malformed text, and a different code still fail closed.
       OR pg_catalog.upper(v_payment.currency) IS DISTINCT FROM p_currency
       OR v_payment.provider IS DISTINCT FROM 'paypal'
       OR (
         v_payment.paypal_resource_type IS NOT NULL
         AND v_payment.paypal_resource_type IS DISTINCT FROM 'capture'
       ) THEN
      RAISE EXCEPTION 'commerce_finalize_paypal_capture: existing capture identity mismatch';
    END IF;

    IF v_payment.paypal_resource_type IS NULL THEN
      UPDATE public.payments AS payment
         SET paypal_resource_type = 'capture'
       WHERE payment.id = v_payment.id
         AND payment.paypal_resource_type IS NULL
      RETURNING payment.* INTO v_payment;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'commerce_finalize_paypal_capture: capture resource adoption race';
      END IF;
    END IF;

    IF v_target_status = 'completed' THEN
      -- Capture replay is observation-only after a valid downstream lifecycle
      -- transition. The refund pipeline marks the order first and payment last,
      -- so completed/refunded is also a legitimate crash-recovery state.
      v_replay_state_valid := (
        v_payment.status = 'completed'
        AND v_order.status IN ('completed', 'refunded', 'disputed')
      ) OR (
        v_payment.status = 'refunded'
        AND v_order.status = 'refunded'
      ) OR (
        v_payment.status = 'reversed'
        AND v_order.status IN ('refunded', 'disputed')
      );
    ELSIF v_target_status = 'pending_review' THEN
      -- There is no automated pending-review resolution workflow today. Exact
      -- pending-review replay is safe; an independently mutated pair is not.
      v_replay_state_valid := v_payment.status = 'pending_review'
        AND v_order.status = 'pending_review';
    END IF;

    IF NOT v_replay_state_valid THEN
      RAISE EXCEPTION 'commerce_finalize_paypal_capture: existing capture/order successor state mismatch';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_order.id,
      'order_status', v_order.status,
      'payment_id', v_payment.id,
      'payment_created', false
    );
  END IF;

  -- Existing provider proof is replay-only and can safely predate the grant
  -- snapshot migration after its full identity and successor state validate
  -- above. A new capture (matching or pending-review) still requires the
  -- immutable sale contract so it cannot bless a rewritten legacy order.
  IF v_order.grant_snapshot_frozen_at IS NULL THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: order grant snapshot is not frozen';
  END IF;

  IF v_order.status <> 'pending' THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: order is not pending and capture is unknown';
  END IF;

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
    p_paypal_capture_id,
    p_amount_cents,
    p_currency,
    v_target_status,
    'paypal',
    'capture'
  )
  ON CONFLICT (paypal_payment_id) DO NOTHING
  RETURNING * INTO v_payment;

  v_payment_created := FOUND;
  IF NOT v_payment_created THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: capture was claimed concurrently';
  END IF;

  IF v_target_status = 'completed' THEN
    UPDATE public.customers
       SET total_spent_cents = COALESCE(total_spent_cents, 0) + p_amount_cents,
           total_orders = COALESCE(total_orders, 0) + 1,
           first_purchase_at = COALESCE(first_purchase_at, pg_catalog.clock_timestamp()),
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = p_customer_id
       AND guild_id = p_guild_id;
    GET DIAGNOSTICS v_customer_count = ROW_COUNT;
    IF v_customer_count <> 1 THEN
      RAISE EXCEPTION 'commerce_finalize_paypal_capture: customer total update failed';
    END IF;
  END IF;

  UPDATE public.orders
     SET status = v_target_status,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = p_order_id
     AND status = 'pending'
  RETURNING * INTO v_order;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: order transition race detected';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_order.id,
    'order_status', v_order.status,
    'payment_id', v_payment.id,
    'payment_created', v_payment_created
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_finalize_paypal_capture(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_finalize_paypal_capture(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) TO service_role;

-- A paid live entitlement is a child of one exact completed order identity.
-- The generated parent-state key turns that lifecycle rule into a real FK:
-- fulfillment holds a key-share lock while inserting access, and a refund
-- cannot move the order away from completed until every visible paid child is
-- terminal. Conversely, once a refund commits, no concurrent worker can
-- insert or reactivate access against that order. NOT VALID preserves
-- inspectable pre-migration legacy rows, while PostgreSQL enforces both
-- constraints for every new insert/update and every parent state transition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_commerce_live_entitlement_identity
  ON public.orders (id, guild_id, customer_id, product_id, status);

ALTER TABLE public.entitlements
  ADD COLUMN IF NOT EXISTS commerce_required_order_status TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN (source = 'purchase' OR source IS NULL)
       AND status IN ('active', 'pending', 'grace_period', 'suspended')
        THEN 'completed'::TEXT
      ELSE NULL::TEXT
    END
  ) STORED;

ALTER TABLE public.entitlements
  ADD CONSTRAINT commerce_paid_live_entitlement_identity_complete
  CHECK (
    commerce_required_order_status IS NULL
    OR (
      order_id IS NOT NULL
      AND guild_id IS NOT NULL
      AND customer_id IS NOT NULL
      AND product_id IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE public.entitlements
  ADD CONSTRAINT commerce_paid_live_entitlement_order_fk
  FOREIGN KEY (
    order_id,
    guild_id,
    customer_id,
    product_id,
    commerce_required_order_status
  )
  REFERENCES public.orders (id, guild_id, customer_id, product_id, status)
  DEFERRABLE INITIALLY IMMEDIATE
  NOT VALID;

-- A license-bearing entitlement must reference a key owned by the exact same
-- order/customer/guild/product tuple.  The composite FK prevents both static
-- cross-order aliases and an alias inserted while a refund is revoking a key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_license_keys_commerce_identity
  ON public.license_keys (id, order_id, guild_id, customer_id, product_id);

ALTER TABLE public.entitlements
  DROP CONSTRAINT IF EXISTS commerce_entitlement_license_identity_complete;
ALTER TABLE public.entitlements
  ADD CONSTRAINT commerce_entitlement_license_identity_complete
  CHECK (
    license_key_id IS NULL
    OR (
      order_id IS NOT NULL
      AND guild_id IS NOT NULL
      AND customer_id IS NOT NULL
      AND product_id IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE public.entitlements
  DROP CONSTRAINT IF EXISTS commerce_entitlement_license_identity_fk;
ALTER TABLE public.entitlements
  ADD CONSTRAINT commerce_entitlement_license_identity_fk
  FOREIGN KEY (license_key_id, order_id, guild_id, customer_id, product_id)
  REFERENCES public.license_keys (id, order_id, guild_id, customer_id, product_id)
  DEFERRABLE INITIALLY IMMEDIATE
  NOT VALID;

-- Live license keys remain children of a completed order.  A refund must make
-- the key terminal before moving the order, and no later writer can resurrect
-- it under the refunded parent.
ALTER TABLE public.license_keys
  ADD COLUMN IF NOT EXISTS commerce_required_order_status TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN status IN ('pending_activation', 'active', 'suspended')
        THEN 'completed'::TEXT
      ELSE NULL::TEXT
    END
  ) STORED;

ALTER TABLE public.license_keys
  DROP CONSTRAINT IF EXISTS commerce_live_license_identity_complete;
ALTER TABLE public.license_keys
  ADD CONSTRAINT commerce_live_license_identity_complete
  CHECK (
    commerce_required_order_status IS NULL
    OR (
      order_id IS NOT NULL
      AND guild_id IS NOT NULL
      AND customer_id IS NOT NULL
      AND product_id IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE public.license_keys
  DROP CONSTRAINT IF EXISTS commerce_live_license_order_fk;
ALTER TABLE public.license_keys
  ADD CONSTRAINT commerce_live_license_order_fk
  FOREIGN KEY (
    order_id,
    guild_id,
    customer_id,
    product_id,
    commerce_required_order_status
  )
  REFERENCES public.orders (id, guild_id, customer_id, product_id, status)
  DEFERRABLE INITIALLY IMMEDIATE
  NOT VALID;

-- Active sessions are children of an active key.  The key transition trigger
-- drains sessions first so direct webhook/admin key revocations remain atomic
-- even when they are issued as separate API statements.
CREATE UNIQUE INDEX IF NOT EXISTS idx_license_keys_id_status
  ON public.license_keys (id, status);

ALTER TABLE public.license_sessions
  ADD COLUMN IF NOT EXISTS commerce_required_license_status TEXT
  GENERATED ALWAYS AS (
    CASE WHEN active = true THEN 'active'::TEXT ELSE NULL::TEXT END
  ) STORED;

ALTER TABLE public.license_sessions
  DROP CONSTRAINT IF EXISTS commerce_active_session_license_fk;
ALTER TABLE public.license_sessions
  ADD CONSTRAINT commerce_active_session_license_fk
  FOREIGN KEY (license_key_id, commerce_required_license_status)
  REFERENCES public.license_keys (id, status)
  DEFERRABLE INITIALLY IMMEDIATE
  NOT VALID;

CREATE OR REPLACE FUNCTION public.commerce_deactivate_sessions_before_license_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status <> 'active' THEN
    UPDATE public.license_sessions AS session
       SET active = false,
           deactivated_at = COALESCE(session.deactivated_at, pg_catalog.clock_timestamp()),
           deactivation_reason = COALESCE(
             session.deactivation_reason,
             'entitlement_revoked'
           )
     WHERE session.license_key_id = OLD.id
       AND session.active = true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_license_terminal_deactivates_sessions
  ON public.license_keys;
CREATE TRIGGER commerce_license_terminal_deactivates_sessions
  BEFORE UPDATE OF status ON public.license_keys
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.commerce_deactivate_sessions_before_license_terminal();

REVOKE ALL ON FUNCTION public.commerce_deactivate_sessions_before_license_terminal()
  FROM PUBLIC, anon, authenticated, service_role;

-- Discord deletion authority lives only in the exact role-delivery intent.
-- Entitlement metadata describes desired access, but cannot prove whether a
-- role predated fulfillment. Terminal parent transitions therefore move every
-- exact unresolved intent into its deterministic cleanup carrier instead of
-- constructing a broad revoke_roles payload from entitlement snapshots.
DROP TRIGGER IF EXISTS commerce_entitlements_enqueue_role_revocation
  ON public.entitlements;
DROP FUNCTION IF EXISTS public.commerce_enqueue_entitlement_role_revocation();

CREATE OR REPLACE FUNCTION public.commerce_mark_role_delivery_intent_terminal(
  p_intent_id UUID,
  p_reason TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_contract_state TEXT;
BEGIN
  IF p_intent_id IS NULL
     OR p_reason IS NULL
     OR p_reason <> pg_catalog.btrim(p_reason)
     OR p_reason = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_mark_role_delivery_intent_terminal: exact intent and reason are required';
  END IF;

  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id
   FOR UPDATE;
  IF NOT FOUND OR v_intent.state = 'settled' THEN
    RETURN COALESCE(v_intent.state, 'missing');
  END IF;

  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state = 'live' THEN
    RETURN v_intent.state;
  END IF;

  UPDATE public.commerce_role_delivery_intents
     SET state = CASE
           WHEN state = 'operator_required' THEN 'operator_required'
           WHEN v_contract_state = 'terminal' THEN 'cleanup_required'
           ELSE 'operator_required'
         END,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND state <> 'settled'
   RETURNING * INTO v_intent;
  IF NOT FOUND THEN
    RETURN 'settled';
  END IF;

  PERFORM public.commerce_signal_role_delivery_intent(
    v_intent.id,
    p_reason || CASE
      WHEN v_contract_state = 'terminal' THEN ''
      ELSE ' (' || v_contract_state || ' contract evidence)'
    END
  );
  RETURN v_intent.state;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_signal_entitlement_role_delivery_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent_id UUID;
BEGIN
  IF NEW.status IN ('active', 'pending', 'grace_period', 'suspended') THEN
    RETURN NEW;
  END IF;

  FOR v_intent_id IN
    SELECT intent.id
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.entitlement_id = NEW.id
       AND intent.state <> 'settled'
     ORDER BY intent.id
  LOOP
    PERFORM public.commerce_mark_role_delivery_intent_terminal(
      v_intent_id,
      'entitlement became terminal: ' || NEW.status
    );
  END LOOP;
  RETURN NEW;
END;
$$;

-- A non-commerce role carrier must remain recognizable after its source row
-- is reactivated, relinked, terminalized, or eventually deleted. Validate only its immutable,
-- canonical ABI and whole-payload key;
-- never ask mutable current entitlement state to authenticate historical
-- Discord removal authority.
CREATE OR REPLACE FUNCTION public.commerce_noncommerce_cleanup_carrier_kind(
  p_guild_id TEXT,
  p_action TEXT,
  p_lane TEXT,
  p_idempotency_key TEXT,
  p_payload JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_source TEXT;
  v_roles TEXT[];
  v_expected_key TEXT;
  v_uuid_pattern CONSTANT TEXT :=
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
BEGIN
  IF p_action IS DISTINCT FROM 'revoke_roles'
     OR p_lane IS DISTINCT FROM 'commerce'
     OR p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = ''
     OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR p_payload ->> 'guild_id' IS DISTINCT FROM p_guild_id THEN
    RETURN NULL;
  END IF;
  v_source := p_payload ->> 'source';
  IF NOT COALESCE(
       v_source IN (
         'noncommerce_entitlement_status_trigger',
         'noncommerce_entitlement_customer_relink_trigger',
         'noncommerce_entitlement_activation_trigger'
       ),
       false
     ) THEN
    RETURN NULL;
  END IF;

  IF v_source = 'noncommerce_entitlement_status_trigger' THEN
    IF NOT p_payload ?& ARRAY[
         'source', 'guild_id', 'discord_id', 'entitlement_id',
         'customer_id', 'order_id', 'product_id', 'entitlement_source',
         'entitlement_status', 'entitlement_type', 'plan_id', 'role_ids',
         'temporary_role_grant_ids', 'reason'
       ]::TEXT[]
       OR p_payload - ARRAY[
         'source', 'guild_id', 'discord_id', 'entitlement_id',
         'customer_id', 'order_id', 'product_id', 'entitlement_source',
         'entitlement_status', 'entitlement_type', 'plan_id', 'role_ids',
         'temporary_role_grant_ids', 'reason'
       ]::TEXT[] <> '{}'::JSONB
       OR NOT COALESCE(
         p_payload ->> 'entitlement_status' IN ('expired', 'cancelled'),
         false
       )
       -- Parenthesized: plpgsql cuts an IF condition at the first depth-0
       -- THEN, so a bare CASE ... THEN here truncates the expression.
       OR p_payload ->> 'reason' IS DISTINCT FROM (CASE
         WHEN p_payload ->> 'entitlement_status' = 'cancelled'
           THEN 'entitlement_cancelled'
         ELSE 'entitlement_expired'
       END) THEN
      RETURN NULL;
    END IF;
    v_expected_key := 'noncommerce:terminal-entitlement:'
      || COALESCE(p_payload ->> 'entitlement_id', '') || ':'
      || COALESCE(p_payload ->> 'discord_id', '') || ':'
      || COALESCE(p_payload ->> 'entitlement_status', '') || ':'
      || pg_catalog.md5(p_payload::TEXT) || ':v1';
  ELSIF v_source = 'noncommerce_entitlement_activation_trigger' THEN
    IF NOT p_payload ?& ARRAY[
         'source', 'guild_id', 'discord_id', 'entitlement_id',
         'customer_id', 'order_id', 'product_id', 'entitlement_source',
         'entitlement_status', 'entitlement_type', 'plan_id', 'role_ids',
         'temporary_role_grant_ids', 'reason', 'activation_generation'
       ]::TEXT[]
       OR p_payload - ARRAY[
         'source', 'guild_id', 'discord_id', 'entitlement_id',
         'customer_id', 'order_id', 'product_id', 'entitlement_source',
         'entitlement_status', 'entitlement_type', 'plan_id', 'role_ids',
         'temporary_role_grant_ids', 'reason', 'activation_generation'
       ]::TEXT[] <> '{}'::JSONB
       OR NOT COALESCE(
         p_payload ->> 'entitlement_status' IN (
           'active', 'pending', 'grace_period', 'suspended'
         ),
         false
       )
       OR p_payload ->> 'reason' IS DISTINCT FROM 'entitlement_activated'
       OR NOT COALESCE(
         p_payload ->> 'activation_generation' ~ v_uuid_pattern,
         false
       ) THEN
      RETURN NULL;
    END IF;
    v_expected_key := 'noncommerce:activation-entitlement:'
      || COALESCE(p_payload ->> 'entitlement_id', '') || ':'
      || COALESCE(p_payload ->> 'discord_id', '') || ':'
      || COALESCE(p_payload ->> 'activation_generation', '') || ':'
      || pg_catalog.md5(p_payload::TEXT) || ':v1';
  ELSE
    IF NOT p_payload ?& ARRAY[
         'source', 'guild_id', 'old_discord_id', 'discord_id',
         'entitlement_id', 'customer_id', 'order_id', 'product_id',
         'entitlement_source', 'entitlement_status', 'entitlement_type',
         'plan_id', 'role_ids', 'temporary_role_grant_ids', 'reason',
         'relink_generation', 'previous_activation_generation'
       ]::TEXT[]
       OR p_payload - ARRAY[
         'source', 'guild_id', 'old_discord_id', 'discord_id',
         'entitlement_id', 'customer_id', 'order_id', 'product_id',
         'entitlement_source', 'entitlement_status', 'entitlement_type',
         'plan_id', 'role_ids', 'temporary_role_grant_ids', 'reason',
         'relink_generation', 'previous_activation_generation'
       ]::TEXT[] <> '{}'::JSONB
       OR NOT COALESCE(
         p_payload ->> 'entitlement_status' IN (
           'active', 'pending', 'grace_period', 'suspended'
         ),
         false
       )
       OR p_payload ->> 'reason'
         IS DISTINCT FROM 'entitlement_customer_relinked'
       OR p_payload ->> 'old_discord_id' IS NOT DISTINCT FROM
          p_payload ->> 'discord_id'
       OR NOT COALESCE(
         p_payload ->> 'old_discord_id' ~ '^[0-9]{17,20}$',
         false
       )
        OR NOT COALESCE(
          p_payload ->> 'relink_generation' ~ v_uuid_pattern,
          false
        )
       OR NOT (
         p_payload -> 'previous_activation_generation' = 'null'::JSONB
         OR p_payload ->> 'previous_activation_generation' ~ v_uuid_pattern
        ) THEN
      RETURN NULL;
    END IF;
    v_expected_key := 'noncommerce:customer-relink:'
      || COALESCE(p_payload ->> 'entitlement_id', '') || ':'
      || COALESCE(p_payload ->> 'old_discord_id', '') || ':'
      || COALESCE(p_payload ->> 'discord_id', '') || ':'
      || pg_catalog.md5(p_payload::TEXT) || ':v1';
  END IF;

  IF p_idempotency_key IS DISTINCT FROM v_expected_key
     OR NOT COALESCE(
       p_payload ->> 'discord_id' ~ '^[0-9]{17,20}$',
       false
     )
     OR NOT COALESCE(
       p_payload ->> 'entitlement_id' ~ v_uuid_pattern,
       false
     )
     OR NOT COALESCE(
       p_payload ->> 'customer_id' ~ v_uuid_pattern,
       false
     )
     OR NOT COALESCE(
       p_payload ->> 'product_id' ~ v_uuid_pattern,
       false
     )
     OR NOT COALESCE(
       p_payload ->> 'entitlement_source' IN (
         'manual', 'giveaway', 'automation'
       ),
       false
     )
     OR NOT COALESCE(
       p_payload ->> 'entitlement_type' IN ('one_time', 'subscription'),
       false
     )
     OR NOT (
       p_payload -> 'order_id' = 'null'::JSONB
       OR p_payload ->> 'order_id' ~ v_uuid_pattern
     )
     OR NOT (
       p_payload -> 'plan_id' = 'null'::JSONB
       OR p_payload ->> 'plan_id' ~ v_uuid_pattern
     )
     OR p_payload -> 'temporary_role_grant_ids' <> '[]'::JSONB
     OR pg_catalog.jsonb_typeof(p_payload -> 'role_ids')
       IS DISTINCT FROM 'array' THEN
    RETURN NULL;
  END IF;

  BEGIN
    SELECT ARRAY(
      SELECT role.value
        FROM pg_catalog.jsonb_array_elements_text(
          p_payload -> 'role_ids'
        ) AS role(value)
    ) INTO v_roles;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  IF pg_catalog.cardinality(v_roles) = 0
     OR NOT public.commerce_valid_snowflake_snapshot(v_roles)
     OR p_payload -> 'role_ids' IS DISTINCT FROM pg_catalog.to_jsonb(
       public.commerce_canonical_snowflake_snapshot(v_roles)
     ) THEN
    RETURN NULL;
  END IF;
  RETURN CASE v_source
    WHEN 'noncommerce_entitlement_status_trigger' THEN 'terminal'
    WHEN 'noncommerce_entitlement_customer_relink_trigger' THEN 'relink'
    ELSE 'activation'
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_noncommerce_cleanup_carrier_kind(
  TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_signal_noncommerce_cleanup_unproven(
  p_action_id UUID,
  p_claim_token UUID,
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
  v_kind TEXT;
  v_discord_id TEXT;
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL
     OR p_reason NOT IN (
       'activation_provenance_unavailable',
       'cleanup_ownership_unproven',
       'relink_destination_unproven'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_signal_noncommerce_cleanup_unproven: exact evidence is required';
  END IF;
  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_action.status IS DISTINCT FROM 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_signal_noncommerce_cleanup_unproven: claim is stale';
  END IF;
  v_kind := public.commerce_noncommerce_cleanup_carrier_kind(
    v_action.guild_id,
    v_action.action,
    v_action.lane,
    v_action.idempotency_key,
    v_action.payload
  );
  IF v_kind IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_signal_noncommerce_cleanup_unproven: carrier is invalid';
  END IF;
  v_discord_id := CASE WHEN v_kind = 'relink'
    THEN v_action.payload ->> 'old_discord_id'
    ELSE v_action.payload ->> 'discord_id' END;

  INSERT INTO public.alerts (
    guild_id, alert_type, severity, title, message, metadata, resolved
  ) VALUES (
    v_action.guild_id,
    'commerce_noncommerce_role_cleanup_unproven',
    'critical',
    'Noncommerce role ownership is unproven',
    CASE WHEN p_reason = 'relink_destination_unproven'
      THEN 'SomniBot preserved the source roles because current destination delivery is unresolved. Recover or reconcile the destination activation before cleanup.'
      ELSE 'SomniBot did not mutate Discord because no exact zero-dollar delivery intent proves role ownership. Inspect the member baseline and resolve this alert explicitly.'
    END,
    pg_catalog.jsonb_build_object(
      'action_id', v_action.id,
      'carrier_kind', v_kind,
      'entitlement_id', v_action.payload ->> 'entitlement_id',
      'customer_id', v_action.payload ->> 'customer_id',
      'discord_id', v_discord_id,
      'order_id', v_action.payload -> 'order_id',
      'product_id', v_action.payload ->> 'product_id',
      'reason', p_reason,
      'next_step', 'inspect_member_baseline_and_resolve_manually'
    ),
    false
  ) ON CONFLICT DO NOTHING;

  UPDATE public.alerts AS alert
     SET severity = 'critical',
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.guild_id = v_action.guild_id
     AND alert.alert_type = 'commerce_noncommerce_role_cleanup_unproven'
     AND alert.resolved = false
     AND alert.metadata ->> 'entitlement_id' =
       v_action.payload ->> 'entitlement_id'
     AND alert.metadata ->> 'customer_id' =
       v_action.payload ->> 'customer_id'
     AND alert.metadata ->> 'discord_id' = v_discord_id
     AND alert.metadata ->> 'reason' = p_reason;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_signal_noncommerce_cleanup_unproven(
  UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_record_noncommerce_action_outcome(
  p_action_id UUID,
  p_claim_token UUID,
  p_outcome TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL
     OR p_outcome NOT IN ('superseded', 'unproven', 'settled_noop') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_noncommerce_action_outcome: exact outcome is required';
  END IF;
  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_action.status IS DISTINCT FROM 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_claim_token
     OR public.commerce_noncommerce_cleanup_carrier_kind(
       v_action.guild_id,
       v_action.action,
       v_action.lane,
       v_action.idempotency_key,
       v_action.payload
     ) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_noncommerce_action_outcome: claim is cross-linked';
  END IF;
  INSERT INTO public.commerce_noncommerce_action_outcomes (
    action_id, claim_token, outcome
  ) VALUES (
    p_action_id, p_claim_token, p_outcome
  ) ON CONFLICT (action_id, claim_token) DO UPDATE
       SET outcome = EXCLUDED.outcome
     WHERE public.commerce_noncommerce_action_outcomes.outcome = EXCLUDED.outcome;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_noncommerce_action_outcome: outcome changed within one claim';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_record_noncommerce_action_outcome(
  UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_wake_noncommerce_relink_cleanups(
  p_entitlement_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_head public.commerce_noncommerce_activation_heads%ROWTYPE;
BEGIN
  SELECT head.* INTO v_head
    FROM public.commerce_noncommerce_activation_heads AS head
   WHERE head.entitlement_id = p_entitlement_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.contract_kind = 'noncommerce'
       AND intent.action_id = v_head.action_id
       AND intent.entitlement_id = v_head.entitlement_id
       AND intent.activation_generation = v_head.activation_generation
       AND intent.discord_id = v_head.discord_id
       AND intent.state IN ('open', 'settled')
       AND intent.delivery_confirmed_at IS NOT NULL
       AND intent.mutation_token IS NULL
       AND intent.last_delivery_outcome = 'live'
       AND intent.completed_role_ids @> intent.permanent_role_ids
  ) THEN
    RETURN;
  END IF;

  UPDATE public.action_queue_dlq AS dlq
     SET retried = true,
         retried_at = COALESCE(dlq.retried_at, pg_catalog.clock_timestamp()),
         error_message = COALESCE(dlq.error_message || ' | ', '')
           || 'Reopened after current noncommerce destination confirmed'
   WHERE dlq.retried IS NOT TRUE
     AND EXISTS (
       SELECT 1
         FROM public.bot_action_queue AS queue
        WHERE queue.id::TEXT = dlq.original_id
          AND queue.guild_id = dlq.guild_id
          AND queue.action = dlq.action
          AND queue.lane = dlq.lane
          AND queue.payload = dlq.payload
          AND queue.payload ->> 'entitlement_id' = p_entitlement_id::TEXT
          AND public.commerce_noncommerce_cleanup_carrier_kind(
            queue.guild_id,
            queue.action,
            queue.lane,
            queue.idempotency_key,
            queue.payload
          ) = 'relink'
     );

  UPDATE public.bot_action_queue AS queue
     SET status = CASE WHEN queue.status = 'failed' THEN 'pending'
           ELSE queue.status END,
         retry_count = CASE WHEN queue.status = 'failed' THEN 0
           ELSE queue.retry_count END,
         started_at = CASE WHEN queue.status = 'failed' THEN NULL
           ELSE queue.started_at END,
         completed_at = CASE WHEN queue.status = 'failed' THEN NULL
           ELSE queue.completed_at END,
         error_message = NULL,
         next_retry_at = NULL
   WHERE queue.payload ->> 'entitlement_id' = p_entitlement_id::TEXT
     AND queue.status IN ('pending', 'failed')
     AND public.commerce_noncommerce_cleanup_carrier_kind(
       queue.guild_id,
       queue.action,
       queue.lane,
       queue.idempotency_key,
       queue.payload
     ) = 'relink';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_wake_noncommerce_relink_cleanups(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

-- Noncommerce mutation authority is not inferred from entitlement metadata.
-- It exists only for an exact activation carrier backed by the atomic $0
-- provenance order created with the same manual/giveaway/automation source.
CREATE OR REPLACE FUNCTION public.commerce_noncommerce_role_delivery_business_contract_state(
  p_intent_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_head public.commerce_noncommerce_activation_heads%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
BEGIN
  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF NOT FOUND OR v_intent.contract_kind IS DISTINCT FROM 'noncommerce'
     OR v_intent.entitlement_source NOT IN ('manual', 'giveaway', 'automation')
     OR v_intent.activation_generation IS NULL THEN
    RETURN 'invalid';
  END IF;

  SELECT head.* INTO v_head
    FROM public.commerce_noncommerce_activation_heads AS head
   WHERE head.entitlement_id = v_intent.entitlement_id;
  IF NOT FOUND
     OR v_head.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_head.customer_id IS DISTINCT FROM v_intent.customer_id
     OR v_head.discord_id IS DISTINCT FROM v_intent.discord_id
     OR v_head.order_id IS DISTINCT FROM v_intent.order_id
     OR v_head.product_id IS DISTINCT FROM v_intent.product_id
     OR v_head.entitlement_source IS DISTINCT FROM v_intent.entitlement_source
     OR v_head.entitlement_type IS DISTINCT FROM v_intent.entitlement_type
     OR v_head.plan_id IS DISTINCT FROM v_intent.plan_id
     OR v_head.activation_generation IS DISTINCT FROM v_intent.activation_generation
     OR v_head.action_id IS DISTINCT FROM v_intent.action_id
     OR v_head.role_ids IS DISTINCT FROM v_intent.permanent_role_ids THEN
    RETURN 'terminal';
  END IF;

  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = v_intent.action_id;
  IF NOT FOUND THEN
    RETURN 'claim_lost';
  END IF;
  IF public.commerce_noncommerce_cleanup_carrier_kind(
       v_action.guild_id,
       v_action.action,
       v_action.lane,
       v_action.idempotency_key,
       v_action.payload
     ) IS DISTINCT FROM 'activation'
     OR v_action.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_action.payload ->> 'entitlement_id'
       IS DISTINCT FROM v_intent.entitlement_id::TEXT
     OR v_action.payload ->> 'customer_id'
       IS DISTINCT FROM v_intent.customer_id::TEXT
     OR v_action.payload ->> 'discord_id' IS DISTINCT FROM v_intent.discord_id
     OR v_action.payload ->> 'order_id' IS DISTINCT FROM v_intent.order_id::TEXT
     OR v_action.payload ->> 'product_id'
       IS DISTINCT FROM v_intent.product_id::TEXT
     OR v_action.payload ->> 'entitlement_source'
       IS DISTINCT FROM v_intent.entitlement_source
     OR v_action.payload ->> 'entitlement_type'
       IS DISTINCT FROM v_intent.entitlement_type
     OR v_action.payload ->> 'activation_generation'
       IS DISTINCT FROM v_intent.activation_generation::TEXT
     OR (v_action.payload ->> 'plan_id')
       IS DISTINCT FROM v_intent.plan_id::TEXT
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_action.payload -> 'role_ids',
       v_intent.permanent_role_ids
     ) THEN
    RETURN 'invalid';
  END IF;

  SELECT paid_order.* INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = v_intent.order_id;
  SELECT customer.* INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = v_intent.customer_id;
  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = v_intent.entitlement_id;
  IF v_order.id IS NULL OR v_customer.id IS NULL OR v_entitlement.id IS NULL THEN
    RETURN 'invalid';
  END IF;

  IF v_order.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_order.customer_id IS DISTINCT FROM v_intent.customer_id
     OR v_order.product_id IS DISTINCT FROM v_intent.product_id
     OR v_order.plan_id IS DISTINCT FROM v_intent.plan_id
     OR v_order.source IS DISTINCT FROM v_intent.entitlement_source
     OR v_order.order_number IS DISTINCT FROM 'ORD-NC-' || pg_catalog.upper(
       pg_catalog.replace(v_order.id::TEXT, '-', '')
     )
     OR v_order.amount_cents IS DISTINCT FROM 0
     OR v_order.discount_cents IS DISTINCT FROM 0
     OR v_order.currency IS DISTINCT FROM 'USD'
     OR v_order.paypal_order_id IS NOT NULL
     OR v_order.paypal_subscription_id IS NOT NULL
     OR v_order.grant_snapshot_frozen_at IS NOT NULL
     OR public.commerce_canonical_snowflake_snapshot(
       v_order.granted_role_ids_snapshot
     ) IS DISTINCT FROM v_intent.permanent_role_ids
     OR v_order.temporary_role_grants_snapshot IS DISTINCT FROM '[]'::JSONB
     OR EXISTS (
       SELECT 1
         FROM public.payments AS payment
        WHERE payment.order_id = v_order.id
     )
     OR v_customer.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_entitlement.guild_id IS DISTINCT FROM v_intent.guild_id
     OR v_entitlement.customer_id IS DISTINCT FROM v_intent.customer_id
     OR v_entitlement.order_id IS DISTINCT FROM v_intent.order_id
     OR v_entitlement.product_id IS DISTINCT FROM v_intent.product_id
     OR v_entitlement.plan_id IS DISTINCT FROM v_intent.plan_id
     OR v_entitlement.type IS DISTINCT FROM v_intent.entitlement_type
     OR v_entitlement.source IS DISTINCT FROM v_intent.entitlement_source
     OR public.commerce_canonical_snowflake_snapshot(
       v_entitlement.granted_role_ids
     ) IS DISTINCT FROM v_intent.permanent_role_ids
     OR v_order.granted_channel_ids_snapshot IS DISTINCT FROM
       public.commerce_canonical_snowflake_snapshot(
         COALESCE(v_entitlement.granted_channel_ids, '{}'::TEXT[])
       ) THEN
    RETURN 'invalid';
  END IF;

  IF v_order.status IS DISTINCT FROM 'completed'
     OR v_entitlement.status NOT IN (
       'active', 'pending', 'grace_period', 'suspended'
     )
     OR v_customer.discord_id IS DISTINCT FROM v_intent.discord_id THEN
    RETURN 'terminal';
  END IF;
  RETURN 'live';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_noncommerce_role_delivery_business_contract_state(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_role_delivery_business_contract_state(
  p_intent_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_contract_kind TEXT;
BEGIN
  SELECT intent.contract_kind INTO v_contract_kind
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.id = p_intent_id;
  IF v_contract_kind = 'paid' THEN
    RETURN public.commerce_paid_role_delivery_business_contract_state(p_intent_id);
  ELSIF v_contract_kind = 'noncommerce' THEN
    RETURN public.commerce_noncommerce_role_delivery_business_contract_state(
      p_intent_id
    );
  END IF;
  RETURN 'invalid';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_role_delivery_business_contract_state(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_has_pending_noncommerce_activation_role(
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_role_id TEXT,
  p_exclude_intent_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_guild_id IS NULL OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = ''
     OR p_discord_id IS NULL OR p_discord_id !~ '^[0-9]{17,20}$'
     OR p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_has_pending_noncommerce_activation_role: exact identity is required';
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.bot_action_queue AS queue
      JOIN public.commerce_noncommerce_activation_heads AS head
        ON head.action_id = queue.id
      JOIN public.entitlements AS entitlement
        ON entitlement.id = head.entitlement_id
       AND entitlement.id::TEXT = queue.payload ->> 'entitlement_id'
       AND entitlement.guild_id = queue.guild_id
      JOIN public.customers AS customer
        ON customer.id = entitlement.customer_id
       AND customer.guild_id = entitlement.guild_id
      JOIN public.orders AS provenance_order
        ON provenance_order.id = entitlement.order_id
       AND provenance_order.guild_id = entitlement.guild_id
       AND provenance_order.customer_id = entitlement.customer_id
       AND provenance_order.product_id = entitlement.product_id
      LEFT JOIN public.commerce_role_delivery_intents AS intent
        ON intent.action_id = queue.id
     WHERE queue.guild_id = p_guild_id
       AND customer.discord_id = p_discord_id
       AND entitlement.status IN (
         'active', 'pending', 'grace_period', 'suspended'
       )
       AND entitlement.source IN ('manual', 'giveaway', 'automation')
       AND head.guild_id = entitlement.guild_id
       AND head.customer_id = entitlement.customer_id
       AND head.discord_id = customer.discord_id
       AND head.order_id = entitlement.order_id
       AND head.product_id = entitlement.product_id
       AND head.entitlement_source = entitlement.source
       AND head.entitlement_type = entitlement.type
       AND head.plan_id IS NOT DISTINCT FROM entitlement.plan_id
       AND head.role_ids = public.commerce_canonical_snowflake_snapshot(
         entitlement.granted_role_ids
       )
       AND public.commerce_noncommerce_cleanup_carrier_kind(
         queue.guild_id,
         queue.action,
         queue.lane,
         queue.idempotency_key,
         queue.payload
       ) = 'activation'
       AND queue.payload ->> 'customer_id' = entitlement.customer_id::TEXT
       AND queue.payload ->> 'discord_id' = customer.discord_id
       AND queue.payload ->> 'order_id' = provenance_order.id::TEXT
       AND queue.payload ->> 'product_id' = entitlement.product_id::TEXT
       AND queue.payload ->> 'entitlement_source' = entitlement.source
       AND queue.payload ->> 'entitlement_type' = entitlement.type
       AND queue.payload ->> 'activation_generation' =
         head.activation_generation::TEXT
       AND (queue.payload ->> 'plan_id') IS NOT DISTINCT FROM entitlement.plan_id::TEXT
       AND public.commerce_jsonb_snowflake_snapshot_matches(
         queue.payload -> 'role_ids',
         public.commerce_canonical_snowflake_snapshot(
           entitlement.granted_role_ids
         )
       )
       AND p_role_id = ANY(
         public.commerce_canonical_snowflake_snapshot(
           entitlement.granted_role_ids
         )
       )
       AND provenance_order.order_number = 'ORD-NC-' || pg_catalog.upper(
         pg_catalog.replace(provenance_order.id::TEXT, '-', '')
       )
       AND provenance_order.plan_id IS NOT DISTINCT FROM entitlement.plan_id
       AND provenance_order.source = entitlement.source
       AND provenance_order.status = 'completed'
       AND provenance_order.amount_cents = 0
       AND provenance_order.discount_cents = 0
       AND provenance_order.currency = 'USD'
       AND provenance_order.paypal_order_id IS NULL
       AND provenance_order.paypal_subscription_id IS NULL
       AND provenance_order.grant_snapshot_frozen_at IS NULL
       AND provenance_order.granted_role_ids_snapshot =
         public.commerce_canonical_snowflake_snapshot(
           entitlement.granted_role_ids
         )
       AND provenance_order.granted_channel_ids_snapshot =
         public.commerce_canonical_snowflake_snapshot(
           COALESCE(entitlement.granted_channel_ids, '{}'::TEXT[])
         )
       AND provenance_order.temporary_role_grants_snapshot = '[]'::JSONB
       AND NOT EXISTS (
         SELECT 1 FROM public.payments AS payment
          WHERE payment.order_id = provenance_order.id
       )
       AND (
         intent.id IS NULL
         OR (
           intent.id IS DISTINCT FROM p_exclude_intent_id
           AND intent.state <> 'settled'
           AND NOT (
               intent.state = 'open'
               AND intent.delivery_confirmed_at IS NOT NULL
               AND intent.mutation_token IS NULL
               AND intent.last_delivery_outcome = 'live'
           )
         )
       )
       AND (
         queue.status IN ('staged', 'pending', 'processing', 'failed')
         OR EXISTS (
           SELECT 1
             FROM public.action_queue_dlq AS dlq
            WHERE dlq.original_id = queue.id::TEXT
              AND dlq.guild_id = queue.guild_id
              AND dlq.action = queue.action
              AND dlq.lane = queue.lane
              AND dlq.payload = queue.payload
              AND dlq.retried IS NOT TRUE
         )
       )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_has_pending_noncommerce_activation_role(
  TEXT, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;

-- Reinstall the public classifier after the strict activation-carrier helper
-- exists. A desired entitlement is never confirmed ownership; a valid
-- zero-dollar activation without a settled intent is pending only.
CREATE OR REPLACE FUNCTION public.commerce_classify_live_role_owner(
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_role_id TEXT,
  p_exclude_intent_id UUID,
  p_exclude_entitlement_id UUID,
  p_exclude_grant_ids UUID[]
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state TEXT;
BEGIN
  v_state := public.commerce_role_delivery_owner_state(
    p_guild_id,
    p_discord_id,
    p_role_id,
    p_exclude_intent_id,
    COALESCE(p_exclude_grant_ids, '{}'::UUID[])
  );
  IF v_state = 'confirmed' OR public.commerce_has_other_live_role_owner(
       p_guild_id,
       p_discord_id,
       p_role_id,
       p_exclude_intent_id,
       p_exclude_entitlement_id,
       COALESCE(p_exclude_grant_ids, '{}'::UUID[])
     ) THEN
    RETURN 'confirmed';
  END IF;
  IF v_state = 'pending' OR public.commerce_has_pending_noncommerce_activation_role(
       p_guild_id,
       p_discord_id,
       p_role_id,
       p_exclude_intent_id
     ) THEN
    RETURN 'pending';
  END IF;
  RETURN 'none';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_classify_live_role_owner(
  TEXT, TEXT, TEXT, UUID, UUID, UUID[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_classify_live_role_owner(
  TEXT, TEXT, TEXT, UUID, UUID, UUID[]
) TO service_role;

-- A live-role worker must not authorize a Discord add from an MVCC snapshot that
-- predates an in-flight terminal entitlement write.  Lock the immutable grant
-- row before returning it together with the current customer identity.  The
-- short RPC transaction releases both SHARE locks before Discord I/O; worker
-- pre/post observations and compensation then close changes that start after
-- this fence without holding a database transaction across the network call.
CREATE OR REPLACE FUNCTION public.commerce_observe_noncommerce_live_origin(
  p_entitlement_id UUID,
  p_customer_id UUID,
  p_guild_id TEXT
)
RETURNS TABLE (
  entitlement_id UUID,
  guild_id TEXT,
  customer_id UUID,
  order_id UUID,
  product_id UUID,
  plan_id UUID,
  entitlement_type TEXT,
  entitlement_status TEXT,
  entitlement_source TEXT,
  granted_role_ids TEXT[],
  current_discord_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_entitlement public.entitlements%ROWTYPE;
  v_customer public.customers%ROWTYPE;
BEGIN
  IF p_entitlement_id IS NULL
     OR p_customer_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_observe_noncommerce_live_origin: exact identity is required';
  END IF;

  -- Customer before entitlement is the global commerce identity order used by
  -- privacy purge and relink writers. It prevents an observer from holding an
  -- entitlement SHARE lock while waiting on a purge's customer lock. Terminal
  -- entitlement writers do not row-lock the customer, so the second FOR SHARE
  -- still waits for an uncommitted terminal UPDATE and re-evaluates that tuple.
  SELECT customer.* INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = p_customer_id
     AND customer.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
     AND entitlement.customer_id = p_customer_id
     AND entitlement.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_entitlement.id,
    v_entitlement.guild_id,
    v_entitlement.customer_id,
    v_entitlement.order_id,
    v_entitlement.product_id,
    v_entitlement.plan_id,
    v_entitlement.type,
    v_entitlement.status,
    v_entitlement.source,
    v_entitlement.granted_role_ids,
    v_customer.discord_id;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_observe_noncommerce_live_origin(
  UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_observe_noncommerce_live_origin(
  UUID, UUID, TEXT
) TO service_role;

-- One transition UUID owns one immutable lifecycle audit event. The grant or
-- revoke transaction records this row before it can return success; using the
-- transition UUID as the audit primary key makes lost-response replays exact
-- and prevents the former event-bus path from duplicating lifecycle history.
CREATE OR REPLACE FUNCTION public.commerce_record_entitlement_lifecycle_event(
  p_transition_id UUID,
  p_event_type TEXT,
  p_entitlement_id UUID,
  p_guild_id TEXT,
  p_discord_id TEXT,
  p_product_id UUID,
  p_product_name TEXT,
  p_role_ids TEXT[],
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_details JSONB;
  v_before JSONB;
  v_after JSONB;
  v_roles TEXT[];
  v_audit public.audit_logs%ROWTYPE;
  v_correlation TEXT;
BEGIN
  IF p_transition_id IS NULL
     OR NOT COALESCE(
       p_event_type IN ('entitlement.granted', 'entitlement.revoked'),
       false
     )
     OR p_entitlement_id IS NULL
     OR p_guild_id IS NULL OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = ''
     OR p_discord_id IS NULL OR p_discord_id !~ '^[0-9]{17,20}$'
     OR p_product_id IS NULL
     OR p_product_name IS NULL
     OR p_product_name <> pg_catalog.btrim(p_product_name)
     OR p_product_name = ''
     OR NOT public.commerce_valid_snowflake_snapshot(p_role_ids)
     OR (p_event_type = 'entitlement.granted' AND p_reason IS NOT NULL)
     OR (
       p_event_type = 'entitlement.revoked'
       AND (
         p_reason IS NULL OR p_reason <> pg_catalog.btrim(p_reason)
         OR p_reason = ''
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_entitlement_lifecycle_event: exact event identity is required';
  END IF;
  v_roles := public.commerce_canonical_snowflake_snapshot(p_role_ids);
  v_correlation := 'commerce-entitlement-transition:' || p_transition_id::TEXT;
  v_details := CASE WHEN p_event_type = 'entitlement.granted'
    THEN pg_catalog.jsonb_build_object(
      'productId', p_product_id,
      'productName', p_product_name,
      'roleIds', pg_catalog.to_jsonb(v_roles)
    )
    ELSE pg_catalog.jsonb_build_object(
      'productId', p_product_id,
      'productName', p_product_name,
      'roleIds', pg_catalog.to_jsonb(v_roles),
      'reason', p_reason
    )
  END;
  v_before := CASE WHEN p_event_type = 'entitlement.granted'
    THEN pg_catalog.jsonb_build_object('entitled', false)
    ELSE pg_catalog.jsonb_build_object(
      'entitled', true,
      'productId', p_product_id
    )
  END;
  v_after := CASE WHEN p_event_type = 'entitlement.granted'
    THEN pg_catalog.jsonb_build_object(
      'entitled', true,
      'productId', p_product_id,
      'roleIds', pg_catalog.to_jsonb(v_roles)
    )
    ELSE pg_catalog.jsonb_build_object(
      'entitled', false,
      'reason', p_reason
    )
  END;

  INSERT INTO public.audit_logs (
    id, guild_id, actor_type, actor_id, action, category,
    target_type, target_id, details, before_state, after_state,
    correlation_id, success
  ) VALUES (
    p_transition_id,
    p_guild_id,
    'system',
    p_discord_id,
    p_event_type,
    'commerce',
    'entitlement',
    p_entitlement_id::TEXT,
    v_details,
    v_before,
    v_after,
    v_correlation,
    true
  ) ON CONFLICT (id) DO NOTHING;

  SELECT audit.* INTO v_audit
    FROM public.audit_logs AS audit
   WHERE audit.id = p_transition_id;
  -- Cross-link detection binds the transition to its IDENTITY tuple only:
  -- guild, action, category, target. Actor id, details, and state snapshots
  -- are evidence FROZEN at transition time — the stored row is authoritative
  -- for them. Re-deriving them from live state here would poison legitimate
  -- replays after any sanctioned mutation (customer relink changes
  -- discord_id, product rename changes the details name); the caller's
  -- replay contract already pins the immutable request shape exactly.
  IF NOT FOUND
     OR v_audit.guild_id IS DISTINCT FROM p_guild_id
     OR v_audit.actor_type IS DISTINCT FROM 'system'
     OR v_audit.action IS DISTINCT FROM p_event_type
     OR v_audit.category IS DISTINCT FROM 'commerce'
     OR v_audit.target_type IS DISTINCT FROM 'entitlement'
     OR v_audit.target_id IS DISTINCT FROM p_entitlement_id::TEXT
     OR v_audit.success IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_entitlement_lifecycle_event: transition is cross-linked';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_record_entitlement_lifecycle_event(
  UUID, TEXT, UUID, TEXT, TEXT, UUID, TEXT, TEXT[], TEXT
) FROM PUBLIC, anon, authenticated, service_role;

-- Owner-created manual/giveaway/automation grants are one atomic, replayable
-- unit.  The request UUID is also the zero-dollar order UUID, so a lost HTTP
-- response can retry without manufacturing an orphan order or a second grant.
-- The entitlement lifecycle may evolve after creation, but every immutable
-- request field must still match before an existing row is returned.
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
#variable_conflict use_column
DECLARE
  v_order public.orders%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_plan public.plans%ROWTYPE;
  v_roles TEXT[];
  v_channels TEXT[];
  v_order_number TEXT;
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
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_create_noncommerce_entitlement: request contract is invalid';
  END IF;
  v_roles := public.commerce_canonical_snowflake_snapshot(
    p_granted_role_ids
  );
  v_channels := public.commerce_canonical_snowflake_snapshot(
    p_granted_channel_ids
  );
  v_order_number := 'ORD-NC-' || pg_catalog.upper(
    pg_catalog.replace(p_request_id::TEXT, '-', '')
  );

  SELECT customer.* INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = p_customer_id
     AND customer.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_create_noncommerce_entitlement: customer identity mismatch';
  END IF;
  SELECT product.* INTO v_product
    FROM public.products AS product
   WHERE product.id = p_product_id
     AND product.guild_id = p_guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_create_noncommerce_entitlement: product identity mismatch';
  END IF;
  IF v_product.type IS DISTINCT FROM p_type
     OR NOT public.commerce_valid_snowflake_snapshot(
       COALESCE(v_product.granted_role_ids, '{}'::TEXT[])
     )
     OR NOT public.commerce_valid_snowflake_snapshot(
       COALESCE(v_product.granted_channel_ids, '{}'::TEXT[])
     )
     OR public.commerce_canonical_snowflake_snapshot(
       COALESCE(v_product.granted_role_ids, '{}'::TEXT[])
     ) IS DISTINCT FROM v_roles
     OR public.commerce_canonical_snowflake_snapshot(
       COALESCE(v_product.granted_channel_ids, '{}'::TEXT[])
     ) IS DISTINCT FROM v_channels
     OR (p_type = 'one_time' AND p_plan_id IS NOT NULL)
     OR (p_type = 'subscription' AND p_plan_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_create_noncommerce_entitlement: requested grant exceeds product authority';
  END IF;
  IF p_plan_id IS NOT NULL THEN
    SELECT plan.* INTO v_plan
      FROM public.plans AS plan
     WHERE plan.id = p_plan_id
       AND plan.product_id = p_product_id
       AND plan.guild_id = p_guild_id
       AND plan.active IS TRUE
     FOR SHARE;
    IF NOT FOUND OR p_type IS DISTINCT FROM 'subscription' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_create_noncommerce_entitlement: plan identity mismatch';
    END IF;
  END IF;

  INSERT INTO public.orders (
    id,
    order_number,
    customer_id,
    guild_id,
    product_id,
    plan_id,
    amount_cents,
    currency,
    discount_cents,
    source,
    status,
    granted_role_ids_snapshot,
    granted_channel_ids_snapshot,
    temporary_role_grants_snapshot
  ) VALUES (
    p_request_id,
    v_order_number,
    p_customer_id,
    p_guild_id,
    p_product_id,
    p_plan_id,
    0,
    'USD',
    0,
    p_source,
    'completed',
    v_roles,
    v_channels,
    '[]'::JSONB
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT paid_order.* INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_request_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_order.order_number IS DISTINCT FROM v_order_number
     OR v_order.customer_id IS DISTINCT FROM p_customer_id
     OR v_order.guild_id IS DISTINCT FROM p_guild_id
     OR v_order.product_id IS DISTINCT FROM p_product_id
     OR v_order.plan_id IS DISTINCT FROM p_plan_id
     OR v_order.amount_cents IS DISTINCT FROM 0
     OR v_order.currency IS DISTINCT FROM 'USD'
     OR v_order.discount_cents IS DISTINCT FROM 0
     OR v_order.source IS DISTINCT FROM p_source
     OR v_order.status IS DISTINCT FROM 'completed'
     OR v_order.paypal_order_id IS NOT NULL
     OR v_order.paypal_subscription_id IS NOT NULL
     OR v_order.granted_role_ids_snapshot IS DISTINCT FROM v_roles
     OR v_order.granted_channel_ids_snapshot IS DISTINCT FROM v_channels
     OR v_order.temporary_role_grants_snapshot IS DISTINCT FROM '[]'::JSONB
     OR v_order.grant_snapshot_frozen_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_create_noncommerce_entitlement: request id is cross-linked';
  END IF;

  INSERT INTO public.entitlements (
    customer_id,
    guild_id,
    product_id,
    plan_id,
    license_key_id,
    order_id,
    type,
    status,
    source,
    granted_role_ids,
    granted_channel_ids,
    starts_at,
    expires_at
  ) VALUES (
    p_customer_id,
    p_guild_id,
    p_product_id,
    p_plan_id,
    NULL,
    p_request_id,
    p_type,
    'active',
    p_source,
    v_roles,
    v_channels,
    pg_catalog.clock_timestamp(),
    p_expires_at
  )
  ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING;

  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.order_id = p_request_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_entitlement.customer_id IS DISTINCT FROM p_customer_id
     OR v_entitlement.guild_id IS DISTINCT FROM p_guild_id
     OR v_entitlement.product_id IS DISTINCT FROM p_product_id
     OR v_entitlement.plan_id IS DISTINCT FROM p_plan_id
     OR v_entitlement.license_key_id IS NOT NULL
     OR v_entitlement.type IS DISTINCT FROM p_type
     OR v_entitlement.source IS DISTINCT FROM p_source
     OR v_entitlement.granted_role_ids IS DISTINCT FROM v_roles
     OR v_entitlement.granted_channel_ids IS DISTINCT FROM v_channels
     OR v_entitlement.expires_at IS DISTINCT FROM p_expires_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_create_noncommerce_entitlement: replay contract is cross-linked';
  END IF;

  PERFORM public.commerce_record_entitlement_lifecycle_event(
    p_request_id,
    'entitlement.granted',
    v_entitlement.id,
    p_guild_id,
    v_customer.discord_id,
    p_product_id,
    v_product.name,
    v_roles,
    NULL
  );

  -- The entitlement UUID is the deterministic initial activation generation.
  -- A lost-response replay therefore validates/recreates/reopens that exact
  -- durable ensure before this RPC returns success again. A later terminal
  -- lifecycle state is never resurrected by replaying the creation request.
  IF v_entitlement.status IN (
       'active', 'pending', 'grace_period', 'suspended'
     ) THEN
    PERFORM public.commerce_enqueue_noncommerce_activation_entitlement(
      v_entitlement.id,
      v_entitlement.status,
      v_entitlement.id,
      NULL,
      NULL
    );
  END IF;

  RETURN QUERY SELECT v_entitlement.id, v_order.id, p_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_create_noncommerce_entitlement(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, TEXT[], TEXT[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_create_noncommerce_entitlement(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, TEXT[], TEXT[]
) TO service_role;

-- Owner status changes use one locked database decision. A paid entitlement
-- may be made terminal, but an owner surface cannot resurrect or move it into
-- another access-bearing state while its completed order/license evidence is
-- retained. Provider reconciliation owns any legitimate paid recovery.
CREATE OR REPLACE FUNCTION public.commerce_update_entitlement_status_admin(
  p_entitlement_id UUID,
  p_customer_id UUID,
  p_guild_id TEXT,
  p_status TEXT,
  p_grace_period_ends_at TIMESTAMPTZ
)
RETURNS TABLE (
  entitlement_id UUID,
  customer_id UUID,
  product_id UUID,
  order_id UUID,
  status TEXT,
  grace_period_ends_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_entitlement public.entitlements%ROWTYPE;
BEGIN
  IF p_entitlement_id IS NULL
     OR p_customer_id IS NULL
     OR p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = ''
     OR NOT COALESCE(
       p_status IN (
         'active', 'expired', 'suspended', 'cancelled', 'pending', 'grace_period'
       ),
       false
     )
     OR (
       p_status = 'grace_period'
       AND (
         p_grace_period_ends_at IS NULL
         OR NOT pg_catalog.isfinite(p_grace_period_ends_at)
         OR p_grace_period_ends_at <= pg_catalog.clock_timestamp()
       )
     )
     OR (
       p_status <> 'grace_period'
       AND p_grace_period_ends_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_update_entitlement_status_admin: request contract is invalid';
  END IF;

  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_entitlement.guild_id IS DISTINCT FROM p_guild_id
     OR v_entitlement.customer_id IS DISTINCT FROM p_customer_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_update_entitlement_status_admin: entitlement identity mismatch';
  END IF;
  IF NOT COALESCE(
       v_entitlement.source IN (
         'purchase', 'manual', 'giveaway', 'automation'
       ),
       v_entitlement.source IS NULL
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_update_entitlement_status_admin: entitlement source is invalid';
  END IF;

  IF (v_entitlement.source = 'purchase' OR v_entitlement.source IS NULL)
     AND p_status IN ('active', 'pending', 'grace_period', 'suspended')
     AND (
       v_entitlement.status IS DISTINCT FROM p_status
       OR (
         p_status = 'grace_period'
         AND v_entitlement.grace_period_ends_at
           IS DISTINCT FROM p_grace_period_ends_at
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_update_entitlement_status_admin: paid access cannot be restored by an owner status change';
  END IF;

  UPDATE public.entitlements AS entitlement
     SET status = p_status,
         grace_period_ends_at = CASE
           WHEN p_status = 'grace_period' THEN p_grace_period_ends_at
           WHEN p_status = 'active' THEN NULL
           ELSE entitlement.grace_period_ends_at
         END,
         cancelled_at = CASE
           WHEN p_status = 'cancelled' THEN COALESCE(
             entitlement.cancelled_at,
             pg_catalog.clock_timestamp()
           )
           WHEN p_status = 'active' THEN NULL
           ELSE entitlement.cancelled_at
         END,
         updated_at = pg_catalog.clock_timestamp()
   WHERE entitlement.id = v_entitlement.id
   RETURNING entitlement.* INTO v_entitlement;

  RETURN QUERY SELECT
    v_entitlement.id,
    v_entitlement.customer_id,
    v_entitlement.product_id,
    v_entitlement.order_id,
    v_entitlement.status,
    v_entitlement.grace_period_ends_at;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_update_entitlement_status_admin(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_update_entitlement_status_admin(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ
) TO service_role;

-- Non-purchase entitlements have no paid delivery intent, so their explicit
-- entitlement role vector is the only durable revocation authority. Snapshot
-- the exact terminal row and current Discord identity into one deterministic
-- carrier. A conflicting key must describe the same action byte-for-byte;
-- silently accepting a poisoned carrier would lose the only cleanup request.
CREATE OR REPLACE FUNCTION public.commerce_enqueue_noncommerce_terminal_entitlement(
  p_entitlement_id UUID,
  p_expected_status TEXT,
  p_requeue_terminal BOOLEAN DEFAULT false
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_entitlement public.entitlements%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_action_id UUID := gen_random_uuid();
  v_roles TEXT[];
  v_key TEXT;
  v_payload JSONB;
  v_reason TEXT;
BEGIN
  IF p_entitlement_id IS NULL
     OR p_expected_status IS NULL
     OR p_expected_status NOT IN ('expired', 'cancelled')
     OR p_requeue_terminal IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce terminal cleanup requires an exact entitlement and status';
  END IF;

  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
   FOR SHARE;
  IF NOT FOUND
     OR v_entitlement.status IS DISTINCT FROM p_expected_status
     OR NOT COALESCE(
       v_entitlement.source IN ('manual', 'giveaway', 'automation'),
       false
     )
     OR v_entitlement.guild_id IS NULL
     OR v_entitlement.guild_id <> pg_catalog.btrim(v_entitlement.guild_id)
     OR v_entitlement.guild_id = ''
     OR v_entitlement.customer_id IS NULL
     OR v_entitlement.product_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce terminal entitlement identity is malformed';
  END IF;

  IF NOT public.commerce_valid_snowflake_snapshot(
       COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[])
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce terminal entitlement role snapshot is malformed';
  END IF;
  v_roles := public.commerce_canonical_snowflake_snapshot(
    COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[])
  );
  IF pg_catalog.cardinality(v_roles) = 0 THEN
    RETURN NULL;
  END IF;

  -- Serialize the transition snapshot with Discord relinks without taking the
  -- customer row after the entitlement row and creating a row-lock cycle.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'noncommerce-entitlement-customer:' || v_entitlement.customer_id::TEXT,
      0
    )
  );
  SELECT customer.* INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = v_entitlement.customer_id;
  IF NOT FOUND
     OR v_customer.guild_id IS DISTINCT FROM v_entitlement.guild_id
     OR v_customer.discord_id IS NULL
     OR v_customer.discord_id <> pg_catalog.btrim(v_customer.discord_id)
     OR v_customer.discord_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce terminal entitlement customer identity is malformed';
  END IF;

  v_reason := CASE v_entitlement.status
    WHEN 'cancelled' THEN 'entitlement_cancelled'
    ELSE 'entitlement_expired'
  END;
  v_payload := pg_catalog.jsonb_build_object(
    'source', 'noncommerce_entitlement_status_trigger',
    'guild_id', v_entitlement.guild_id,
    'discord_id', v_customer.discord_id,
    'entitlement_id', v_entitlement.id,
    'customer_id', v_entitlement.customer_id,
    'order_id', v_entitlement.order_id,
    'product_id', v_entitlement.product_id,
    'entitlement_source', v_entitlement.source,
    'entitlement_status', v_entitlement.status,
    'entitlement_type', v_entitlement.type,
    'plan_id', v_entitlement.plan_id,
    'role_ids', pg_catalog.to_jsonb(v_roles),
    'temporary_role_grant_ids', '[]'::JSONB,
    'reason', v_reason
  );
  v_key := 'noncommerce:terminal-entitlement:'
    || v_entitlement.id::TEXT || ':' || v_customer.discord_id || ':'
    || v_entitlement.status || ':' || pg_catalog.md5(v_payload::TEXT) || ':v1';
  IF public.commerce_noncommerce_cleanup_carrier_kind(
       v_entitlement.guild_id,
       'revoke_roles',
       'commerce',
       v_key,
       v_payload
     ) IS DISTINCT FROM 'terminal' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce terminal cleanup carrier snapshot is invalid';
  END IF;

  PERFORM pg_catalog.set_config(
    'somnibot.noncommerce_cleanup_carrier_insert',
    v_action_id::TEXT || ':' || v_key || ':'
      || pg_catalog.md5(v_payload::TEXT),
    true
  );
  INSERT INTO public.bot_action_queue (
    id, guild_id, action, payload, status, lane, idempotency_key
  ) VALUES (
    v_action_id,
    v_entitlement.guild_id,
    'revoke_roles',
    v_payload,
    'pending',
    'commerce',
    v_key
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  PERFORM pg_catalog.set_config(
    'somnibot.noncommerce_cleanup_carrier_insert', '', true
  );

  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.idempotency_key = v_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'noncommerce terminal cleanup carrier disappeared';
  END IF;
  IF v_action.guild_id IS DISTINCT FROM v_entitlement.guild_id
     OR v_action.action IS DISTINCT FROM 'revoke_roles'
     OR v_action.lane IS DISTINCT FROM 'commerce'
     OR v_action.payload IS DISTINCT FROM v_payload THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce terminal cleanup carrier identity is cross-linked';
  END IF;

  IF p_requeue_terminal
     AND v_action.status IN ('completed', 'failed') THEN
    -- A successful generation is positive proof that every older DLQ copy is
    -- stale.  A failed generation is about to be reopened in place, so retire
    -- the old failure witness atomically with that same-carrier transition.
    UPDATE public.action_queue_dlq AS dlq
       SET retried = true,
           retried_at = COALESCE(
             dlq.retried_at,
             pg_catalog.clock_timestamp()
           ),
           error_message = COALESCE(dlq.error_message || ' | ', '')
             || CASE v_action.status
               WHEN 'completed' THEN
                 'Retired after exact noncommerce cleanup completed'
               ELSE 'Retired while exact noncommerce cleanup was reopened'
             END
     WHERE dlq.original_id = v_action.id::TEXT
       AND dlq.guild_id = v_action.guild_id
       AND dlq.action = v_action.action
       AND dlq.lane = v_action.lane
       AND dlq.payload = v_action.payload
       AND dlq.retried IS NOT TRUE;
  END IF;

  IF v_action.status = 'staged'
     OR (
       p_requeue_terminal
       AND v_action.status IN ('completed', 'failed')
     ) THEN
    UPDATE public.bot_action_queue AS queue
       SET status = 'pending',
           started_at = NULL,
           completed_at = NULL,
           error_message = NULL,
           next_retry_at = NULL,
           retry_count = queue.retry_count + 1
     WHERE queue.id = v_action.id
       AND queue.status = v_action.status
     RETURNING queue.* INTO v_action;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'noncommerce terminal cleanup carrier requeue raced';
    END IF;
  END IF;

  RETURN v_action.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_enqueue_noncommerce_terminal_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
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

-- Initial non-commerce grants and every later terminal -> live transition must
-- return with a durable Discord ensure generation in the same transaction.
-- A fresh generation prevents an older processing worker from swallowing a
-- later activation; replay of that exact generation still resolves to one
-- immutable carrier and one queue UUID.
CREATE OR REPLACE FUNCTION public.commerce_enqueue_noncommerce_activation_entitlement(
  p_entitlement_id UUID,
  p_expected_status TEXT,
  p_activation_generation UUID,
  p_expected_activation_generation UUID,
  p_expected_discord_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_entitlement public.entitlements%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_head public.commerce_noncommerce_activation_heads%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_action_id UUID := gen_random_uuid();
  v_roles TEXT[];
  v_key TEXT;
  v_payload JSONB;
BEGIN
  IF p_entitlement_id IS NULL
     OR p_expected_status IS NULL
     OR p_expected_status NOT IN (
       'active', 'pending', 'grace_period', 'suspended'
     )
     OR p_activation_generation IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce activation requires an exact entitlement, status, and generation';
  END IF;

  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
   FOR SHARE;
  IF NOT FOUND
     OR v_entitlement.status IS DISTINCT FROM p_expected_status
     OR NOT COALESCE(
       v_entitlement.source IN ('manual', 'giveaway', 'automation'),
       false
     )
     OR v_entitlement.guild_id IS NULL
     OR v_entitlement.guild_id <> pg_catalog.btrim(v_entitlement.guild_id)
     OR v_entitlement.guild_id = ''
     OR v_entitlement.customer_id IS NULL
     OR v_entitlement.product_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce activation entitlement identity is malformed';
  END IF;

  IF NOT public.commerce_valid_snowflake_snapshot(
       COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[])
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce activation entitlement role snapshot is malformed';
  END IF;
  v_roles := public.commerce_canonical_snowflake_snapshot(
    COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[])
  );
  IF pg_catalog.cardinality(v_roles) = 0 THEN
    RETURN NULL;
  END IF;

  -- Serialize every activation generation for this customer, then key-share
  -- lock the customer row. A concurrent relink finishes its lightweight
  -- historical-carrier trigger first; only the committed current Discord
  -- identity can be committed into this activation generation.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'noncommerce-entitlement-customer:' || v_entitlement.customer_id::TEXT,
      0
    )
  );
  SELECT customer.* INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = v_entitlement.customer_id
   FOR SHARE;
  IF NOT FOUND
     OR v_customer.guild_id IS DISTINCT FROM v_entitlement.guild_id
     OR v_customer.discord_id IS NULL
     OR v_customer.discord_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce activation customer identity is malformed';
  END IF;
  IF p_expected_discord_id IS NOT NULL
     AND v_customer.discord_id IS DISTINCT FROM p_expected_discord_id THEN
    -- A deferred relink request is historical once the customer has advanced
    -- again. It must not retarget its generation to the newest identity.
    RETURN NULL;
  END IF;

  SELECT head.* INTO v_head
    FROM public.commerce_noncommerce_activation_heads AS head
   WHERE head.entitlement_id = v_entitlement.id
   FOR UPDATE;
  IF FOUND
     AND p_activation_generation = v_entitlement.id
     AND v_head.activation_generation IS DISTINCT FROM p_activation_generation THEN
    -- A lost-response replay of the initial create may validate its immutable
    -- rows, but it cannot reopen G1 after a later activation/relink advanced
    -- the entitlement head.
    RETURN v_head.action_id;
  END IF;
  IF FOUND
     AND v_head.activation_generation IS DISTINCT FROM p_activation_generation
     AND v_head.activation_generation
       IS DISTINCT FROM p_expected_activation_generation THEN
    -- Every non-initial generation is a compare-and-swap from the exact head
    -- observed by its lifecycle transaction. A replay of G2 after G3/G4 can
    -- validate its old carrier, but cannot move the current pointer backward.
    RETURN v_head.action_id;
  END IF;
  IF NOT FOUND AND p_expected_activation_generation IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'noncommerce activation head disappeared before compare-and-swap';
  END IF;

  v_payload := pg_catalog.jsonb_build_object(
    'source', 'noncommerce_entitlement_activation_trigger',
    'guild_id', v_entitlement.guild_id,
    'discord_id', v_customer.discord_id,
    'entitlement_id', v_entitlement.id,
    'customer_id', v_entitlement.customer_id,
    'order_id', v_entitlement.order_id,
    'product_id', v_entitlement.product_id,
    'entitlement_source', v_entitlement.source,
    'entitlement_status', v_entitlement.status,
    'entitlement_type', v_entitlement.type,
    'plan_id', v_entitlement.plan_id,
    'role_ids', pg_catalog.to_jsonb(v_roles),
    'temporary_role_grant_ids', '[]'::JSONB,
    'reason', 'entitlement_activated',
    'activation_generation', p_activation_generation
  );
  v_key := 'noncommerce:activation-entitlement:'
    || v_entitlement.id::TEXT || ':' || v_customer.discord_id || ':'
    || p_activation_generation::TEXT || ':'
    || pg_catalog.md5(v_payload::TEXT) || ':v1';
  IF public.commerce_noncommerce_cleanup_carrier_kind(
       v_entitlement.guild_id,
       'revoke_roles',
       'commerce',
       v_key,
       v_payload
     ) IS DISTINCT FROM 'activation' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce activation carrier snapshot is invalid';
  END IF;

  PERFORM pg_catalog.set_config(
    'somnibot.noncommerce_cleanup_carrier_insert',
    v_action_id::TEXT || ':' || v_key || ':'
      || pg_catalog.md5(v_payload::TEXT),
    true
  );
  INSERT INTO public.bot_action_queue (
    id, guild_id, action, payload, status, lane, idempotency_key
  ) VALUES (
    v_action_id,
    v_entitlement.guild_id,
    'revoke_roles',
    v_payload,
    'pending',
    'commerce',
    v_key
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  PERFORM pg_catalog.set_config(
    'somnibot.noncommerce_cleanup_carrier_insert', '', true
  );

  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.idempotency_key = v_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'noncommerce activation carrier disappeared';
  END IF;
  IF v_action.guild_id IS DISTINCT FROM v_entitlement.guild_id
     OR v_action.action IS DISTINCT FROM 'revoke_roles'
     OR v_action.lane IS DISTINCT FROM 'commerce'
     OR v_action.payload IS DISTINCT FROM v_payload
     OR public.commerce_noncommerce_cleanup_carrier_kind(
       v_action.guild_id,
       v_action.action,
       v_action.lane,
       v_action.idempotency_key,
       v_action.payload
     ) IS DISTINCT FROM 'activation' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'noncommerce activation carrier identity is cross-linked';
  END IF;

  -- A completed carrier with exact durable live evidence is already delivered;
  -- request replays must not manufacture a duplicate Discord ensure. Failed,
  -- staged, or completed-without-evidence carriers still reopen in place.
  IF NOT (
    v_action.status = 'completed'
    AND EXISTS (
      SELECT 1
        FROM public.commerce_role_delivery_intents AS intent
       WHERE intent.contract_kind = 'noncommerce'
         AND intent.action_id = v_action.id
         AND intent.entitlement_id = v_entitlement.id
         AND intent.customer_id = v_entitlement.customer_id
         AND intent.guild_id = v_entitlement.guild_id
         AND intent.discord_id = v_customer.discord_id
         AND intent.order_id IS NOT DISTINCT FROM v_entitlement.order_id
         AND intent.product_id = v_entitlement.product_id
         AND intent.plan_id IS NOT DISTINCT FROM v_entitlement.plan_id
         AND intent.entitlement_type = v_entitlement.type
         AND intent.entitlement_source = v_entitlement.source
         AND intent.activation_generation = p_activation_generation
         AND intent.permanent_role_ids = v_roles
         AND intent.state IN ('open', 'settled')
         AND intent.delivery_confirmed_at IS NOT NULL
         AND intent.mutation_token IS NULL
         AND intent.cleanup_mutation_token IS NULL
         AND intent.last_delivery_outcome = 'live'
         AND intent.completed_role_ids @> intent.permanent_role_ids
    )
  ) THEN
    IF v_action.status IN ('completed', 'failed') THEN
      UPDATE public.action_queue_dlq AS dlq
         SET retried = true,
             retried_at = COALESCE(
               dlq.retried_at,
               pg_catalog.clock_timestamp()
             ),
             error_message = COALESCE(dlq.error_message || ' | ', '')
               || 'Retired while exact noncommerce activation was reopened'
       WHERE dlq.original_id = v_action.id::TEXT
         AND dlq.guild_id = v_action.guild_id
         AND dlq.action = v_action.action
         AND dlq.lane = v_action.lane
         AND dlq.payload = v_action.payload
         AND dlq.retried IS NOT TRUE;
    END IF;

    IF v_action.status IN ('staged', 'completed', 'failed') THEN
      UPDATE public.bot_action_queue AS queue
         SET status = 'pending',
             started_at = NULL,
             completed_at = NULL,
             error_message = NULL,
             next_retry_at = NULL,
             retry_count = queue.retry_count + 1
       WHERE queue.id = v_action.id
         AND queue.status = v_action.status
       RETURNING queue.* INTO v_action;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001',
          MESSAGE = 'noncommerce activation carrier requeue raced';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.commerce_noncommerce_activation_heads (
    entitlement_id, guild_id, customer_id, discord_id, order_id, product_id,
    entitlement_source, entitlement_type, plan_id, activation_generation,
    action_id, role_ids
  ) VALUES (
    v_entitlement.id,
    v_entitlement.guild_id,
    v_entitlement.customer_id,
    v_customer.discord_id,
    v_entitlement.order_id,
    v_entitlement.product_id,
    v_entitlement.source,
    v_entitlement.type,
    v_entitlement.plan_id,
    p_activation_generation,
    v_action.id,
    v_roles
  )
  ON CONFLICT (entitlement_id) DO UPDATE
     SET guild_id = EXCLUDED.guild_id,
         customer_id = EXCLUDED.customer_id,
         discord_id = EXCLUDED.discord_id,
         order_id = EXCLUDED.order_id,
         product_id = EXCLUDED.product_id,
         entitlement_source = EXCLUDED.entitlement_source,
         entitlement_type = EXCLUDED.entitlement_type,
         plan_id = EXCLUDED.plan_id,
         activation_generation = EXCLUDED.activation_generation,
         action_id = EXCLUDED.action_id,
         role_ids = EXCLUDED.role_ids,
         updated_at = pg_catalog.clock_timestamp();

  RETURN v_action.id;
END;
$$;

-- Customer relink triggers cannot synchronously call the activation helper:
-- they already own the customer row, while the canonical lifecycle order is
-- entitlement -> advisory -> customer. The claimed historical relink carrier
-- asks for B after commit. Its immutable previous-generation snapshot makes
-- the enqueue a CAS, and expected_discord_id prevents an old A -> B request
-- from being silently retargeted after B -> C or A -> B -> A.
CREATE OR REPLACE FUNCTION public.commerce_request_noncommerce_relink_activation(
  p_action_id UUID,
  p_claim_token UUID
)
RETURNS TABLE (activation_action_id UUID, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_head public.commerce_noncommerce_activation_heads%ROWTYPE;
  v_activation_action_id UUID;
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_request_noncommerce_relink_activation: exact claim is required';
  END IF;

  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_action.status IS DISTINCT FROM 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_claim_token
     OR public.commerce_noncommerce_cleanup_carrier_kind(
       v_action.guild_id,
       v_action.action,
       v_action.lane,
       v_action.idempotency_key,
       v_action.payload
     ) IS DISTINCT FROM 'relink' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_request_noncommerce_relink_activation: claim is cross-linked';
  END IF;

  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = (v_action.payload ->> 'entitlement_id')::UUID
   FOR SHARE;
  IF NOT FOUND THEN
    PERFORM public.commerce_record_noncommerce_action_outcome(
      p_action_id, p_claim_token, 'superseded'
    );
    RETURN QUERY SELECT NULL::UUID, 'superseded'::TEXT;
    RETURN;
  END IF;
  IF v_entitlement.guild_id IS DISTINCT FROM v_action.guild_id
     OR v_entitlement.customer_id::TEXT IS DISTINCT FROM
       v_action.payload ->> 'customer_id'
     OR v_entitlement.order_id::TEXT IS DISTINCT FROM
       v_action.payload ->> 'order_id'
     OR v_entitlement.product_id::TEXT IS DISTINCT FROM
       v_action.payload ->> 'product_id'
     OR v_entitlement.plan_id::TEXT IS DISTINCT FROM
       v_action.payload ->> 'plan_id'
     OR v_entitlement.type IS DISTINCT FROM
       v_action.payload ->> 'entitlement_type'
     OR v_entitlement.source IS DISTINCT FROM
       v_action.payload ->> 'entitlement_source'
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_action.payload -> 'role_ids',
       public.commerce_canonical_snowflake_snapshot(
         v_entitlement.granted_role_ids
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_request_noncommerce_relink_activation: origin identity changed';
  END IF;
  IF v_entitlement.status IS DISTINCT FROM
       v_action.payload ->> 'entitlement_status'
     OR v_entitlement.status NOT IN (
       'active', 'pending', 'grace_period', 'suspended'
     ) THEN
    PERFORM public.commerce_record_noncommerce_action_outcome(
      p_action_id, p_claim_token, 'superseded'
    );
    RETURN QUERY SELECT NULL::UUID, 'superseded'::TEXT;
    RETURN;
  END IF;

  v_activation_action_id :=
    public.commerce_enqueue_noncommerce_activation_entitlement(
      v_entitlement.id,
      v_entitlement.status,
      (v_action.payload ->> 'relink_generation')::UUID,
      (v_action.payload ->> 'previous_activation_generation')::UUID,
      v_action.payload ->> 'discord_id'
    );
  IF v_activation_action_id IS NULL THEN
    PERFORM public.commerce_record_noncommerce_action_outcome(
      p_action_id, p_claim_token, 'superseded'
    );
    RETURN QUERY SELECT NULL::UUID, 'superseded'::TEXT;
    RETURN;
  END IF;

  SELECT head.* INTO v_head
    FROM public.commerce_noncommerce_activation_heads AS head
   WHERE head.entitlement_id = v_entitlement.id;
  IF NOT FOUND
     OR v_head.activation_generation IS DISTINCT FROM
       (v_action.payload ->> 'relink_generation')::UUID
     OR v_head.action_id IS DISTINCT FROM v_activation_action_id
     OR v_head.discord_id IS DISTINCT FROM v_action.payload ->> 'discord_id' THEN
    PERFORM public.commerce_record_noncommerce_action_outcome(
      p_action_id, p_claim_token, 'superseded'
    );
    RETURN QUERY SELECT v_activation_action_id, 'superseded'::TEXT;
    RETURN;
  END IF;
  RETURN QUERY SELECT v_activation_action_id, 'enqueued'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_request_noncommerce_relink_activation(
  UUID, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_request_noncommerce_relink_activation(
  UUID, UUID
) TO service_role;

-- Select cleanup authority from a durable owned intent, never from desired
-- entitlement role metadata. Relinks additionally wait until the current
-- destination generation is fully confirmed; final per-role owner checks in
-- the shared cleanup state machine close later lifecycle races.
CREATE OR REPLACE FUNCTION public.commerce_prepare_noncommerce_role_delivery_cleanup(
  p_action_id UUID,
  p_claim_token UUID
)
RETURNS TABLE (intent_id UUID, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
  v_kind TEXT;
  v_target_discord_id TEXT;
  v_roles TEXT[];
  v_entitlement public.entitlements%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_head public.commerce_noncommerce_activation_heads%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_destination_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_destination_action public.bot_action_queue%ROWTYPE;
  v_matching_unresolved INTEGER := 0;
  v_has_matching_contract BOOLEAN := false;
  v_destination_confirmed BOOLEAN := false;
  v_mark_state TEXT;
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_noncommerce_role_delivery_cleanup: exact claim is required';
  END IF;
  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id;
  IF NOT FOUND
     OR v_action.status IS DISTINCT FROM 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_noncommerce_role_delivery_cleanup: claim is stale';
  END IF;
  v_kind := public.commerce_noncommerce_cleanup_carrier_kind(
    v_action.guild_id,
    v_action.action,
    v_action.lane,
    v_action.idempotency_key,
    v_action.payload
  );
  IF v_kind NOT IN ('terminal', 'relink') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_noncommerce_role_delivery_cleanup: cleanup carrier is invalid';
  END IF;
  v_target_discord_id := CASE WHEN v_kind = 'relink'
    THEN v_action.payload ->> 'old_discord_id'
    ELSE v_action.payload ->> 'discord_id' END;
  SELECT ARRAY(
    SELECT role.value
      FROM pg_catalog.jsonb_array_elements_text(
        v_action.payload -> 'role_ids'
      ) AS role(value)
  ) INTO v_roles;
  v_roles := public.commerce_canonical_snowflake_snapshot(v_roles);

  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = (v_action.payload ->> 'entitlement_id')::UUID;
  IF FOUND THEN
    SELECT customer.* INTO v_customer
      FROM public.customers AS customer
     WHERE customer.id = v_entitlement.customer_id;
  END IF;

  IF v_kind = 'terminal'
     AND v_entitlement.id IS NOT NULL
     AND (
       v_entitlement.status IS DISTINCT FROM
         v_action.payload ->> 'entitlement_status'
       OR v_entitlement.status IN (
         'active', 'pending', 'grace_period', 'suspended'
       )
     ) THEN
    -- A delayed/reopened T1 cannot clean the live G2 generation. If the same
    -- deterministic terminal carrier is reused by a later equal-status cycle,
    -- the current status matches and the newest exact owned intent is eligible.
    PERFORM public.commerce_record_noncommerce_action_outcome(
      p_action_id, p_claim_token, 'superseded'
    );
    RETURN QUERY SELECT NULL::UUID, 'superseded'::TEXT;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.contract_kind = 'noncommerce'
       AND intent.entitlement_id = (v_action.payload ->> 'entitlement_id')::UUID
       AND intent.customer_id = (v_action.payload ->> 'customer_id')::UUID
       AND intent.guild_id = v_action.guild_id
       AND intent.discord_id = v_target_discord_id
       AND intent.order_id::TEXT IS NOT DISTINCT FROM
         v_action.payload ->> 'order_id'
       AND intent.product_id = (v_action.payload ->> 'product_id')::UUID
       AND intent.plan_id::TEXT IS NOT DISTINCT FROM
         v_action.payload ->> 'plan_id'
       AND intent.entitlement_type = v_action.payload ->> 'entitlement_type'
       AND intent.entitlement_source = v_action.payload ->> 'entitlement_source'
       AND intent.permanent_role_ids = v_roles
  ) INTO v_has_matching_contract;
  IF NOT v_has_matching_contract THEN
    PERFORM public.commerce_signal_noncommerce_cleanup_unproven(
      p_action_id, p_claim_token, 'cleanup_ownership_unproven'
    );
    PERFORM public.commerce_record_noncommerce_action_outcome(
      p_action_id, p_claim_token, 'unproven'
    );
    RETURN QUERY SELECT NULL::UUID, 'unproven'::TEXT;
    RETURN;
  END IF;

  IF v_kind = 'relink'
     AND v_entitlement.id IS NOT NULL
     AND v_entitlement.status IN (
       'active', 'pending', 'grace_period', 'suspended'
     ) THEN
    IF v_customer.discord_id IS NOT DISTINCT FROM v_target_discord_id THEN
      -- A -> B -> A: the historical cleanup target is desired again. The
      -- current activation transfers any idle owned intent instead of deleting.
      PERFORM public.commerce_record_noncommerce_action_outcome(
        p_action_id, p_claim_token, 'superseded'
      );
      RETURN QUERY SELECT NULL::UUID, 'superseded'::TEXT;
      RETURN;
    END IF;
    SELECT head.* INTO v_head
      FROM public.commerce_noncommerce_activation_heads AS head
     WHERE head.entitlement_id = v_entitlement.id;
    SELECT destination.* INTO v_destination_intent
      FROM public.commerce_role_delivery_intents AS destination
     WHERE destination.action_id = v_head.action_id;
    SELECT queue.* INTO v_destination_action
      FROM public.bot_action_queue AS queue
     WHERE queue.id = v_head.action_id;
    IF (
         v_destination_intent.id IS NOT NULL
         AND v_destination_intent.discord_id
           IS NOT DISTINCT FROM v_customer.discord_id
         AND v_destination_intent.state IN (
           'cleanup_required', 'operator_required'
         )
       )
       OR (
         v_head.discord_id IS NOT DISTINCT FROM v_customer.discord_id
         AND v_destination_action.status = 'failed'
       ) THEN
      IF v_destination_intent.id IS NOT NULL THEN
        PERFORM public.commerce_signal_role_delivery_intent(
          v_destination_intent.id,
          'current noncommerce relink destination requires recovery'
        );
      END IF;
      PERFORM public.commerce_signal_noncommerce_cleanup_unproven(
        p_action_id, p_claim_token, 'relink_destination_unproven'
      );
      -- Retrying the historical source carrier cannot heal a failed/operator
      -- destination and would hot-loop forever. Preserve the old authority,
      -- retain both critical alerts, and durably finalize this exact claim as
      -- an unproven no-mutation outcome.
      PERFORM public.commerce_record_noncommerce_action_outcome(
        p_action_id, p_claim_token, 'unproven'
      );
      RETURN QUERY SELECT NULL::UUID, 'destination_unproven'::TEXT;
      RETURN;
    END IF;
    SELECT EXISTS (
      SELECT 1
        FROM public.commerce_role_delivery_intents AS destination
       WHERE destination.contract_kind = 'noncommerce'
         AND destination.action_id = v_head.action_id
         AND destination.entitlement_id = v_entitlement.id
         AND destination.customer_id = v_entitlement.customer_id
         AND destination.guild_id = v_entitlement.guild_id
         AND destination.discord_id = v_customer.discord_id
         AND destination.order_id IS NOT DISTINCT FROM v_entitlement.order_id
         AND destination.product_id = v_entitlement.product_id
         AND destination.plan_id IS NOT DISTINCT FROM v_entitlement.plan_id
         AND destination.entitlement_type = v_entitlement.type
         AND destination.entitlement_source = v_entitlement.source
         AND destination.activation_generation = v_head.activation_generation
         AND destination.permanent_role_ids = v_head.role_ids
         AND destination.state IN ('open', 'settled')
         AND destination.delivery_confirmed_at IS NOT NULL
         AND destination.mutation_token IS NULL
         AND destination.last_delivery_outcome = 'live'
         AND destination.completed_role_ids @> destination.permanent_role_ids
    ) INTO v_destination_confirmed;
    IF v_head.entitlement_id IS NULL
       OR v_head.guild_id IS DISTINCT FROM v_entitlement.guild_id
       OR v_head.customer_id IS DISTINCT FROM v_entitlement.customer_id
       OR v_head.discord_id IS DISTINCT FROM v_customer.discord_id
       OR v_head.order_id IS DISTINCT FROM v_entitlement.order_id
       OR v_head.product_id IS DISTINCT FROM v_entitlement.product_id
       OR v_head.entitlement_source IS DISTINCT FROM v_entitlement.source
       OR v_head.entitlement_type IS DISTINCT FROM v_entitlement.type
       OR v_head.plan_id IS DISTINCT FROM v_entitlement.plan_id
       OR v_head.role_ids IS DISTINCT FROM
         public.commerce_canonical_snowflake_snapshot(
           v_entitlement.granted_role_ids
         )
       OR NOT v_destination_confirmed THEN
      RETURN QUERY SELECT NULL::UUID, 'destination_pending'::TEXT;
      RETURN;
    END IF;
  END IF;

  SELECT pg_catalog.count(*)::INTEGER
    INTO v_matching_unresolved
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.contract_kind = 'noncommerce'
     AND intent.entitlement_id = (v_action.payload ->> 'entitlement_id')::UUID
     AND intent.customer_id = (v_action.payload ->> 'customer_id')::UUID
     AND intent.guild_id = v_action.guild_id
     AND intent.discord_id = v_target_discord_id
     AND intent.order_id::TEXT IS NOT DISTINCT FROM
       v_action.payload ->> 'order_id'
     AND intent.product_id = (v_action.payload ->> 'product_id')::UUID
     AND intent.plan_id::TEXT IS NOT DISTINCT FROM
       v_action.payload ->> 'plan_id'
     AND intent.entitlement_type = v_action.payload ->> 'entitlement_type'
     AND intent.entitlement_source = v_action.payload ->> 'entitlement_source'
     AND intent.permanent_role_ids = v_roles
     AND intent.state <> 'settled';
  IF v_matching_unresolved > 1 THEN
    PERFORM public.commerce_signal_noncommerce_cleanup_unproven(
      p_action_id, p_claim_token, 'cleanup_ownership_unproven'
    );
    PERFORM public.commerce_record_noncommerce_action_outcome(
      p_action_id, p_claim_token, 'unproven'
    );
    RETURN QUERY SELECT NULL::UUID, 'unproven'::TEXT;
    RETURN;
  END IF;

  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.contract_kind = 'noncommerce'
     AND intent.entitlement_id = (v_action.payload ->> 'entitlement_id')::UUID
     AND intent.customer_id = (v_action.payload ->> 'customer_id')::UUID
     AND intent.guild_id = v_action.guild_id
     AND intent.discord_id = v_target_discord_id
     AND intent.order_id::TEXT IS NOT DISTINCT FROM
       v_action.payload ->> 'order_id'
     AND intent.product_id = (v_action.payload ->> 'product_id')::UUID
     AND intent.plan_id::TEXT IS NOT DISTINCT FROM
       v_action.payload ->> 'plan_id'
     AND intent.entitlement_type = v_action.payload ->> 'entitlement_type'
     AND intent.entitlement_source = v_action.payload ->> 'entitlement_source'
     AND intent.permanent_role_ids = v_roles
   ORDER BY CASE WHEN intent.state = 'settled' THEN 1 ELSE 0 END,
            intent.created_at DESC,
            intent.id
   LIMIT 1;
  IF NOT FOUND THEN
    PERFORM public.commerce_signal_noncommerce_cleanup_unproven(
      p_action_id, p_claim_token, 'cleanup_ownership_unproven'
    );
    PERFORM public.commerce_record_noncommerce_action_outcome(
      p_action_id, p_claim_token, 'unproven'
    );
    RETURN QUERY SELECT NULL::UUID, 'unproven'::TEXT;
    RETURN;
  END IF;
  IF v_intent.state = 'settled' THEN
    PERFORM public.commerce_record_noncommerce_action_outcome(
      p_action_id, p_claim_token, 'settled_noop'
    );
    RETURN QUERY SELECT v_intent.id, 'settled_noop'::TEXT;
    RETURN;
  END IF;
  IF v_intent.state = 'operator_required'
     OR v_intent.mutation_token IS NOT NULL
     OR v_intent.cleanup_mutation_token IS NOT NULL
     OR pg_catalog.cardinality(v_intent.reserved_role_ids) > 0
     OR pg_catalog.cardinality(v_intent.reserved_temp_role_grant_ids) > 0 THEN
    RETURN QUERY SELECT v_intent.id, 'operator_held'::TEXT;
    RETURN;
  END IF;
  IF v_intent.state = 'open' THEN
    v_mark_state := public.commerce_mark_role_delivery_intent_terminal(
      v_intent.id,
      'exact noncommerce cleanup carrier observed a terminal origin'
    );
    IF v_mark_state NOT IN ('cleanup_required', 'operator_required', 'settled') THEN
      PERFORM public.commerce_record_noncommerce_action_outcome(
        p_action_id, p_claim_token, 'superseded'
      );
      RETURN QUERY SELECT v_intent.id, 'superseded'::TEXT;
      RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT v_intent.id, 'ready'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_prepare_noncommerce_role_delivery_cleanup(
  UUID, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_prepare_noncommerce_role_delivery_cleanup(
  UUID, UUID
) TO service_role;

-- Destination activation is a dependency wait, not a failed cleanup attempt.
-- Requeue the exact relink claim without consuming retry_count so a final-retry
-- B activation can still wake/converge A cleanup after a process restart.
CREATE OR REPLACE FUNCTION public.commerce_defer_noncommerce_relink_cleanup(
  p_action_id UUID,
  p_claim_token UUID
)
RETURNS TABLE (applied BOOLEAN, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_defer_noncommerce_relink_cleanup: exact claim is required';
  END IF;
  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_action.status IS DISTINCT FROM 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN QUERY SELECT false, 'stale_claim'::TEXT;
    RETURN;
  END IF;
  IF public.commerce_noncommerce_cleanup_carrier_kind(
       v_action.guild_id,
       v_action.action,
       v_action.lane,
       v_action.idempotency_key,
       v_action.payload
     ) IS DISTINCT FROM 'relink' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_defer_noncommerce_relink_cleanup: carrier is cross-linked';
  END IF;
  UPDATE public.bot_action_queue AS queue
     SET status = 'pending',
         started_at = NULL,
         completed_at = NULL,
         next_retry_at = pg_catalog.clock_timestamp() + INTERVAL '15 seconds',
         error_message = 'Waiting for current noncommerce destination activation'
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token;
  RETURN QUERY SELECT FOUND, CASE WHEN FOUND
    THEN 'deferred' ELSE 'stale_claim' END::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_defer_noncommerce_relink_cleanup(
  UUID, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_defer_noncommerce_relink_cleanup(
  UUID, UUID
) TO service_role;

-- Bind a claimed activation carrier to the shared role-delivery state
-- machine. A same-target reactivation transfers only already-owned roles from
-- an idle prior noncommerce generation; manual baselines are reclassified.
CREATE OR REPLACE FUNCTION public.commerce_begin_noncommerce_role_delivery_attempt(
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
  p_entitlement_source TEXT,
  p_activation_generation UUID,
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
  disposition TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
  v_head public.commerce_noncommerce_activation_heads%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_previous public.commerce_role_delivery_intents%ROWTYPE;
  v_roles TEXT[];
  v_transfer_roles TEXT[];
  v_contract_state TEXT;
  v_mutation_token UUID;
  v_role_id TEXT;
  v_provenance_valid BOOLEAN := false;
  v_head_current BOOLEAN := false;
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL
     OR p_entitlement_id IS NULL OR p_customer_id IS NULL
     OR p_product_id IS NULL
     OR p_activation_generation IS NULL
     OR p_guild_id IS NULL OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = ''
     OR p_discord_id IS NULL OR p_discord_id !~ '^[0-9]{17,20}$'
     OR p_entitlement_type NOT IN ('one_time', 'subscription')
     OR p_entitlement_source NOT IN ('manual', 'giveaway', 'automation')
     OR NOT public.commerce_valid_snowflake_snapshot(p_permanent_role_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_noncommerce_role_delivery_attempt: exact identity is required';
  END IF;
  v_roles := public.commerce_canonical_snowflake_snapshot(p_permanent_role_ids);
  IF pg_catalog.cardinality(v_roles) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_noncommerce_role_delivery_attempt: role vector is empty';
  END IF;

  -- Match the paid lock order before the shared per-role advisory locks.
  SELECT paid_order.* INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
   FOR SHARE;
  SELECT customer.* INTO v_customer
    FROM public.customers AS customer
   WHERE customer.id = p_customer_id
   FOR SHARE;
  SELECT entitlement.* INTO v_entitlement
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = p_entitlement_id
   FOR SHARE;
  IF v_customer.id IS NULL OR v_entitlement.id IS NULL
     OR v_customer.guild_id IS DISTINCT FROM p_guild_id
     OR v_entitlement.guild_id IS DISTINCT FROM p_guild_id
     OR v_entitlement.customer_id IS DISTINCT FROM p_customer_id
     OR v_entitlement.order_id IS DISTINCT FROM p_order_id
     OR v_entitlement.product_id IS DISTINCT FROM p_product_id
     OR v_entitlement.plan_id IS DISTINCT FROM p_plan_id
     OR v_entitlement.type IS DISTINCT FROM p_entitlement_type
     OR v_entitlement.source IS DISTINCT FROM p_entitlement_source
     OR public.commerce_canonical_snowflake_snapshot(
       v_entitlement.granted_role_ids
     ) IS DISTINCT FROM v_roles THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_noncommerce_role_delivery_attempt: origin identity is cross-linked';
  END IF;

  v_provenance_valid := v_order.id IS NOT NULL
    AND v_order.order_number IS NOT DISTINCT FROM
      'ORD-NC-' || pg_catalog.upper(
        pg_catalog.replace(p_order_id::TEXT, '-', '')
      )
    AND v_order.guild_id IS NOT DISTINCT FROM p_guild_id
    AND v_order.customer_id IS NOT DISTINCT FROM p_customer_id
    AND v_order.product_id IS NOT DISTINCT FROM p_product_id
    AND v_order.plan_id IS NOT DISTINCT FROM p_plan_id
    AND v_order.source IS NOT DISTINCT FROM p_entitlement_source
    AND v_order.amount_cents IS NOT DISTINCT FROM 0
    AND v_order.discount_cents IS NOT DISTINCT FROM 0
    AND v_order.currency IS NOT DISTINCT FROM 'USD'
    AND v_order.paypal_order_id IS NULL
    AND v_order.paypal_subscription_id IS NULL
    AND v_order.grant_snapshot_frozen_at IS NULL
    AND v_order.granted_role_ids_snapshot IS NOT DISTINCT FROM v_roles
    AND v_order.granted_channel_ids_snapshot IS NOT DISTINCT FROM
      public.commerce_canonical_snowflake_snapshot(
        COALESCE(v_entitlement.granted_channel_ids, '{}'::TEXT[])
      )
    AND v_order.temporary_role_grants_snapshot IS NOT DISTINCT FROM '[]'::JSONB
    AND NOT EXISTS (
      SELECT 1 FROM public.payments AS payment
       WHERE payment.order_id = v_order.id
    );

  FOREACH v_role_id IN ARRAY v_roles LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'commerce-role-owner:' || p_guild_id || ':' || p_discord_id || ':'
          || v_role_id,
        0
      )
    );
  END LOOP;

  -- Canonical lock order is parents -> role-owner advisory keys -> activation
  -- head -> queue action -> intent. Enqueue uses the same head-before-action
  -- order, so a lifecycle transition cannot deadlock a claimed worker.
  SELECT head.* INTO v_head
    FROM public.commerce_noncommerce_activation_heads AS head
   WHERE head.entitlement_id = p_entitlement_id
   FOR SHARE;
  v_head_current := FOUND
    AND v_head.guild_id IS NOT DISTINCT FROM p_guild_id
    AND v_head.customer_id IS NOT DISTINCT FROM p_customer_id
    AND v_head.discord_id IS NOT DISTINCT FROM p_discord_id
    AND v_head.order_id IS NOT DISTINCT FROM p_order_id
    AND v_head.product_id IS NOT DISTINCT FROM p_product_id
    AND v_head.entitlement_source IS NOT DISTINCT FROM p_entitlement_source
    AND v_head.entitlement_type IS NOT DISTINCT FROM p_entitlement_type
    AND v_head.plan_id IS NOT DISTINCT FROM p_plan_id
    AND v_head.activation_generation IS NOT DISTINCT FROM p_activation_generation
    AND v_head.action_id IS NOT DISTINCT FROM p_action_id
    AND v_head.role_ids IS NOT DISTINCT FROM v_roles;

  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
   FOR UPDATE;
  IF NOT FOUND OR v_action.status IS DISTINCT FROM 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_claim_token
     OR public.commerce_noncommerce_cleanup_carrier_kind(
       v_action.guild_id,
       v_action.action,
       v_action.lane,
       v_action.idempotency_key,
       v_action.payload
     ) IS DISTINCT FROM 'activation'
     OR v_action.payload ->> 'entitlement_id' IS DISTINCT FROM p_entitlement_id::TEXT
     OR v_action.payload ->> 'customer_id' IS DISTINCT FROM p_customer_id::TEXT
     OR v_action.payload ->> 'discord_id' IS DISTINCT FROM p_discord_id
     OR v_action.payload ->> 'order_id' IS DISTINCT FROM p_order_id::TEXT
     OR v_action.payload ->> 'product_id' IS DISTINCT FROM p_product_id::TEXT
     OR v_action.payload ->> 'entitlement_source' IS DISTINCT FROM p_entitlement_source
     OR v_action.payload ->> 'entitlement_type' IS DISTINCT FROM p_entitlement_type
     OR (v_action.payload ->> 'plan_id') IS DISTINCT FROM p_plan_id::TEXT
     OR v_action.payload ->> 'activation_generation'
       IS DISTINCT FROM p_activation_generation::TEXT
     OR NOT public.commerce_jsonb_snowflake_snapshot_matches(
       v_action.payload -> 'role_ids', v_roles
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_noncommerce_role_delivery_attempt: action claim is cross-linked';
  END IF;

  IF NOT v_head_current THEN
    PERFORM public.commerce_record_noncommerce_action_outcome(
      p_action_id, p_claim_token, 'superseded'
    );
    RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::TEXT,
      false, false, false, false, 'superseded'::TEXT;
    RETURN;
  END IF;

  IF NOT v_provenance_valid THEN
    PERFORM public.commerce_signal_noncommerce_cleanup_unproven(
      p_action_id,
      p_claim_token,
      'activation_provenance_unavailable'
    );
    PERFORM public.commerce_record_noncommerce_action_outcome(
      p_action_id, p_claim_token, 'unproven'
    );
    RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::TEXT,
      false, false, false, false, 'unproven'::TEXT;
    RETURN;
  END IF;

  SELECT intent.* INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.action_id = p_action_id
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.commerce_role_delivery_intents (
      contract_kind, entitlement_source, activation_generation,
      action_id, origin_claim_token, delivery_claim_token,
      guild_id, entitlement_id, customer_id, discord_id, order_id,
      product_id, plan_id, entitlement_type, permanent_role_ids, state
    ) VALUES (
      'noncommerce', p_entitlement_source, p_activation_generation,
      p_action_id, p_claim_token, p_claim_token,
      p_guild_id, p_entitlement_id, p_customer_id, p_discord_id, p_order_id,
      p_product_id, p_plan_id, p_entitlement_type, v_roles, 'open'
    ) RETURNING * INTO v_intent;
  ELSIF v_intent.contract_kind IS DISTINCT FROM 'noncommerce'
        OR v_intent.entitlement_source IS DISTINCT FROM p_entitlement_source
        OR v_intent.activation_generation IS DISTINCT FROM p_activation_generation
        OR v_intent.guild_id IS DISTINCT FROM p_guild_id
        OR v_intent.entitlement_id IS DISTINCT FROM p_entitlement_id
        OR v_intent.customer_id IS DISTINCT FROM p_customer_id
        OR v_intent.discord_id IS DISTINCT FROM p_discord_id
        OR v_intent.order_id IS DISTINCT FROM p_order_id
        OR v_intent.product_id IS DISTINCT FROM p_product_id
        OR v_intent.plan_id IS DISTINCT FROM p_plan_id
        OR v_intent.entitlement_type IS DISTINCT FROM p_entitlement_type
        OR v_intent.permanent_role_ids IS DISTINCT FROM v_roles THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_begin_noncommerce_role_delivery_attempt: intent identity changed';
  END IF;

  IF v_intent.state = 'settled' THEN
    RETURN QUERY SELECT v_intent.id, NULL::UUID, 'settled'::TEXT,
      false, false, false, false, 'superseded'::TEXT;
    RETURN;
  END IF;

  -- Transfer only exact, idle same-target ownership. Any provisional or
  -- cleanup-active generation stays operator-visible and blocks the new add.
  FOR v_previous IN
    SELECT previous.*
      FROM public.commerce_role_delivery_intents AS previous
     WHERE previous.contract_kind = 'noncommerce'
       AND previous.entitlement_id = p_entitlement_id
       AND previous.discord_id = p_discord_id
       AND previous.id <> v_intent.id
       AND previous.state <> 'settled'
     ORDER BY previous.id
     FOR UPDATE
  LOOP
    IF v_previous.permanent_role_ids IS DISTINCT FROM v_roles
       OR v_previous.state = 'operator_required'
       OR v_previous.mutation_token IS NOT NULL
       OR v_previous.cleanup_mutation_token IS NOT NULL
       OR pg_catalog.cardinality(v_previous.reserved_role_ids) > 0
       OR pg_catalog.cardinality(v_previous.reserved_temp_role_grant_ids) > 0
       OR pg_catalog.cardinality(v_previous.temporary_role_grant_ids) > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'noncommerce prior delivery generation is not transfer-safe';
    END IF;
    v_transfer_roles := v_previous.owned_role_ids;
    UPDATE public.commerce_role_delivery_intents
       SET owned_role_ids = '{}'::TEXT[],
           state = 'settled',
           settled_at = pg_catalog.clock_timestamp(),
           last_error = NULL,
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_previous.id
       AND state <> 'settled'
       AND mutation_token IS NULL
       AND cleanup_mutation_token IS NULL
     RETURNING * INTO v_previous;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'noncommerce prior delivery transfer raced';
    END IF;
    IF pg_catalog.cardinality(v_transfer_roles) > 0 THEN
      UPDATE public.commerce_role_delivery_intents
         SET completed_role_ids = public.commerce_canonical_snowflake_snapshot(
               completed_role_ids || v_transfer_roles
             ),
             owned_role_ids = public.commerce_canonical_snowflake_snapshot(
               owned_role_ids || v_transfer_roles
             ),
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = v_intent.id
       RETURNING * INTO v_intent;
    END IF;
    PERFORM public.commerce_resolve_role_delivery_alert(v_previous.id);
  END LOOP;

  IF v_intent.state = 'open'
     AND v_intent.mutation_token IS NULL
     AND v_intent.delivery_confirmed_at IS NOT NULL
     AND v_intent.last_delivery_outcome = 'live' THEN
    RETURN QUERY SELECT v_intent.id, NULL::UUID, v_intent.state,
      false, true, true, false, 'confirmed_replay'::TEXT;
    RETURN;
  END IF;
  IF v_intent.state <> 'open' OR v_intent.mutation_token IS NOT NULL THEN
    RETURN QUERY SELECT v_intent.id, v_intent.mutation_token, v_intent.state,
      false, false, v_intent.delivery_confirmed_at IS NOT NULL, true,
      'operator_held'::TEXT;
    RETURN;
  END IF;

  v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
  IF v_contract_state <> 'live' THEN
    UPDATE public.commerce_role_delivery_intents
       SET state = CASE
             WHEN pg_catalog.cardinality(owned_role_ids) = 0 THEN 'settled'
             ELSE 'cleanup_required'
           END,
           settled_at = CASE WHEN pg_catalog.cardinality(owned_role_ids) = 0
             THEN pg_catalog.clock_timestamp() ELSE NULL END,
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
     RETURNING * INTO v_intent;
    RETURN QUERY SELECT v_intent.id, NULL::UUID, v_intent.state,
      false, false, false, v_intent.state <> 'settled', 'terminal'::TEXT;
    RETURN;
  END IF;

  v_mutation_token := gen_random_uuid();
  UPDATE public.commerce_role_delivery_intents
     SET delivery_claim_token = p_claim_token,
         mutation_token = v_mutation_token,
         mutation_started_at = pg_catalog.clock_timestamp(),
         last_error = NULL,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_intent.id
     AND state = 'open'
     AND mutation_token IS NULL
   RETURNING * INTO v_intent;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'noncommerce delivery begin raced';
  END IF;
  RETURN QUERY SELECT v_intent.id, v_mutation_token, v_intent.state,
    true, true, false, false, 'live_mutation'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_begin_noncommerce_role_delivery_attempt(
  UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_begin_noncommerce_role_delivery_attempt(
  UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT[]
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_enqueue_noncommerce_activation_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_activation BOOLEAN := false;
  v_expected_activation_generation UUID;
BEGIN
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
      CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE gen_random_uuid() END,
      v_expected_activation_generation,
      NULL
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_signal_order_role_delivery_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent_id UUID;
BEGIN
  IF NEW.status = 'completed' THEN
    RETURN NEW;
  END IF;

  FOR v_intent_id IN
    SELECT intent.id
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.order_id = NEW.id
       AND intent.state <> 'settled'
     ORDER BY intent.id
  LOOP
    PERFORM public.commerce_mark_role_delivery_intent_terminal(
      v_intent_id,
      'order became terminal: ' || NEW.status
    );
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_signal_customer_role_delivery_relink()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent_id UUID;
  v_entitlement RECORD;
  v_action public.bot_action_queue%ROWTYPE;
  v_action_id UUID;
  v_key TEXT;
  v_payload JSONB;
  v_roles TEXT[];
  v_relink_generation UUID := gen_random_uuid();
  v_expected_activation_generation UUID;
  v_purge_owner NAME;
  v_purge_scope TEXT;
BEGIN
  -- The customer UPDATE already serializes relinks. Do not acquire the
  -- activation advisory key from this row trigger: an entitlement lifecycle
  -- transaction owns the inverse entitlement -> advisory -> customer order.
  -- Destination activation is requested by the post-commit queue worker.
  IF NEW.discord_id = 'deleted-' || NEW.id::TEXT THEN
    SELECT pg_catalog.pg_get_userbyid(proc.proowner)
      INTO v_purge_owner
      FROM pg_catalog.pg_proc AS proc
     WHERE proc.oid = pg_catalog.to_regprocedure(
       'public.purge_member_data(text,text)'
     );
    v_purge_scope := pg_catalog.current_setting(
      'somnibot.commerce_member_purge_identity', true
    );
    IF v_purge_owner IS NULL
       OR current_user IS DISTINCT FROM v_purge_owner
       OR pg_catalog.split_part(v_purge_scope, '|', 1)
         IS DISTINCT FROM NEW.guild_id
       OR NOT (
         NEW.id::TEXT = ANY(pg_catalog.string_to_array(
           pg_catalog.split_part(v_purge_scope, '|', 2),
           ','
         ))
       )
       OR EXISTS (
         SELECT 1
           FROM public.entitlements AS entitlement
          WHERE entitlement.customer_id = NEW.id
            AND entitlement.status IN (
              'active', 'pending', 'grace_period', 'suspended'
            )
       )
       OR EXISTS (
         SELECT 1
           FROM public.commerce_role_delivery_intents AS intent
          WHERE intent.customer_id = NEW.id
            AND intent.state <> 'settled'
       )
       OR EXISTS (
         SELECT 1
           FROM public.bot_action_queue AS queue
          WHERE queue.payload ->> 'customer_id' = NEW.id::TEXT
            AND public.commerce_noncommerce_cleanup_carrier_kind(
              queue.guild_id,
              queue.action,
              queue.lane,
              queue.idempotency_key,
              queue.payload
            ) IS NOT NULL
            AND (
              queue.status IS DISTINCT FROM 'completed'
              OR EXISTS (
                SELECT 1
                  FROM public.action_queue_dlq AS dlq
                 WHERE dlq.original_id = queue.id::TEXT
                   AND dlq.guild_id = queue.guild_id
                   AND dlq.action = queue.action
                   AND dlq.lane = queue.lane
                   AND dlq.payload = queue.payload
                   AND dlq.retried IS NOT TRUE
              )
            )
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce customer privacy tombstone lacks settled cleanup proof';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.discord_id IS NULL
     OR OLD.discord_id !~ '^[0-9]{17,20}$'
     OR NEW.discord_id IS NULL
     OR NEW.discord_id <> pg_catalog.btrim(NEW.discord_id)
     OR NEW.discord_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce customer relink requires exact canonical Discord identities';
  END IF;

  FOR v_intent_id IN
    SELECT intent.id
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.customer_id = NEW.id
       AND intent.discord_id = OLD.discord_id
       AND intent.state <> 'settled'
     ORDER BY intent.id
  LOOP
    PERFORM public.commerce_mark_role_delivery_intent_terminal(
      v_intent_id,
      'customer Discord identity changed; clean the exact previous identity'
    );
  END LOOP;

  -- The row trigger already owns the customer tuple, so synchronously calling
  -- commerce_ensure_live_role_delivery_action here would invert its canonical
  -- order -> customer lock order. Emit a deterministic, non-mutating request
  -- carrier instead. After commit the bot asks the authoritative database
  -- helper to create (or reuse) the full ensure-live action. If an old intent
  -- is still cleaning, that helper no-ops and cleanup settlement performs the
  -- same ensure; the request never grants or removes a Discord role itself.
  FOR v_entitlement IN
    SELECT entitlement.id, entitlement.guild_id
      FROM public.entitlements AS entitlement
     WHERE entitlement.customer_id = NEW.id
       AND entitlement.guild_id = NEW.guild_id
       AND entitlement.status IN (
         'active', 'pending', 'grace_period', 'suspended'
       )
       AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
       AND pg_catalog.cardinality(
             COALESCE(entitlement.granted_role_ids, '{}'::TEXT[])
           ) > 0
     ORDER BY entitlement.id
  LOOP
    v_key := 'commerce-role-delivery-relink:' || NEW.id::TEXT || ':'
      || OLD.discord_id || ':' || NEW.discord_id || ':'
      || v_entitlement.id::TEXT;
    v_action := NULL;
    SELECT queue.* INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.idempotency_key = v_key
     FOR UPDATE;
    v_action_id := COALESCE(v_action.id, gen_random_uuid());
    v_payload := pg_catalog.jsonb_build_object(
      'mode', 'ensure_live_request',
      'action_id', v_action_id,
      'guild_id', v_entitlement.guild_id,
      'entitlement_id', v_entitlement.id,
      'customer_id', NEW.id,
      'old_discord_id', OLD.discord_id,
      'discord_id', NEW.discord_id
    );

    IF v_action.id IS NULL THEN
      INSERT INTO public.bot_action_queue (
        id, guild_id, action, payload, status, lane, idempotency_key
      ) VALUES (
        v_action_id, v_entitlement.guild_id,
        'reconcile_entitlement_roles', v_payload,
        'pending', 'commerce', v_key
      );
    ELSE
      IF v_action.guild_id IS DISTINCT FROM v_entitlement.guild_id
         OR v_action.action IS DISTINCT FROM 'reconcile_entitlement_roles'
         OR v_action.lane IS DISTINCT FROM 'commerce'
         OR v_action.payload IS DISTINCT FROM v_payload THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce customer relink request carrier is cross-linked';
      END IF;
      IF v_action.status IN ('staged', 'completed', 'failed') THEN
        UPDATE public.bot_action_queue AS queue
           SET status = 'pending',
               started_at = NULL,
               completed_at = NULL,
               error_message = NULL,
               next_retry_at = NULL,
               retry_count = queue.retry_count + 1
         WHERE queue.id = v_action.id
           AND queue.status = v_action.status;
        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = '40001',
            MESSAGE = 'commerce customer relink request carrier changed concurrently';
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Manual, giveaway, and automation entitlements have no paid intent.  Their
  -- current role vector therefore owns a separate durable A -> B carrier: the
  -- worker removes only the exact historical A snapshot, then revalidates the
  -- live entitlement/customer mapping before ensuring B. One generation is
  -- shared by every entitlement observed in this customer-row transition.
  FOR v_entitlement IN
    SELECT entitlement.id,
           entitlement.guild_id,
           entitlement.customer_id,
           entitlement.order_id,
           entitlement.product_id,
           entitlement.source,
           entitlement.status,
           entitlement.type,
           entitlement.plan_id,
           entitlement.granted_role_ids
      FROM public.entitlements AS entitlement
     WHERE entitlement.customer_id = NEW.id
       AND entitlement.guild_id = NEW.guild_id
       AND entitlement.status IN (
         'active', 'pending', 'grace_period', 'suspended'
       )
       AND entitlement.source IN ('manual', 'giveaway', 'automation')
     ORDER BY entitlement.id
  LOOP
    IF NOT public.commerce_valid_snowflake_snapshot(
         COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[])
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'noncommerce relink entitlement role snapshot is malformed';
    END IF;
    v_roles := public.commerce_canonical_snowflake_snapshot(
      COALESCE(v_entitlement.granted_role_ids, '{}'::TEXT[])
    );
    IF pg_catalog.cardinality(v_roles) = 0 THEN
      CONTINUE;
    END IF;

    SELECT head.activation_generation
      INTO v_expected_activation_generation
      FROM public.commerce_noncommerce_activation_heads AS head
     WHERE head.entitlement_id = v_entitlement.id;

    v_payload := pg_catalog.jsonb_build_object(
      'source', 'noncommerce_entitlement_customer_relink_trigger',
      'guild_id', v_entitlement.guild_id,
      'old_discord_id', OLD.discord_id,
      'discord_id', NEW.discord_id,
      'entitlement_id', v_entitlement.id,
      'customer_id', v_entitlement.customer_id,
      'order_id', v_entitlement.order_id,
      'product_id', v_entitlement.product_id,
      'entitlement_source', v_entitlement.source,
      'entitlement_status', v_entitlement.status,
      'entitlement_type', v_entitlement.type,
      'plan_id', v_entitlement.plan_id,
      'role_ids', pg_catalog.to_jsonb(v_roles),
      'temporary_role_grant_ids', '[]'::JSONB,
      'reason', 'entitlement_customer_relinked',
      'relink_generation', v_relink_generation,
      'previous_activation_generation', v_expected_activation_generation
    );
    v_key := 'noncommerce:customer-relink:'
      || v_entitlement.id::TEXT || ':' || OLD.discord_id || ':'
      || NEW.discord_id || ':' || pg_catalog.md5(v_payload::TEXT) || ':v1';
    IF public.commerce_noncommerce_cleanup_carrier_kind(
         v_entitlement.guild_id,
         'revoke_roles',
         'commerce',
         v_key,
         v_payload
       ) IS DISTINCT FROM 'relink' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'noncommerce relink cleanup carrier snapshot is invalid';
    END IF;

    v_action_id := gen_random_uuid();
    PERFORM pg_catalog.set_config(
      'somnibot.noncommerce_cleanup_carrier_insert',
      v_action_id::TEXT || ':' || v_key || ':'
        || pg_catalog.md5(v_payload::TEXT),
      true
    );
    INSERT INTO public.bot_action_queue (
      id, guild_id, action, payload, status, lane, idempotency_key
    ) VALUES (
      v_action_id,
      v_entitlement.guild_id,
      'revoke_roles',
      v_payload,
      'pending',
      'commerce',
      v_key
    )
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    PERFORM pg_catalog.set_config(
      'somnibot.noncommerce_cleanup_carrier_insert', '', true
    );

    SELECT queue.* INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.idempotency_key = v_key
     FOR UPDATE;
    IF NOT FOUND
       OR v_action.guild_id IS DISTINCT FROM v_entitlement.guild_id
       OR v_action.action IS DISTINCT FROM 'revoke_roles'
       OR v_action.lane IS DISTINCT FROM 'commerce'
       OR v_action.payload IS DISTINCT FROM v_payload
       OR public.commerce_noncommerce_cleanup_carrier_kind(
         v_action.guild_id,
         v_action.action,
         v_action.lane,
         v_action.idempotency_key,
         v_action.payload
       ) IS DISTINCT FROM 'relink' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'noncommerce customer relink carrier is cross-linked';
    END IF;
    IF v_action.status = 'staged' THEN
      UPDATE public.bot_action_queue AS queue
         SET status = 'pending',
             started_at = NULL,
             completed_at = NULL,
             error_message = NULL,
             next_retry_at = NULL,
             retry_count = queue.retry_count + 1
       WHERE queue.id = v_action.id
         AND queue.status = 'staged';
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001',
          MESSAGE = 'noncommerce customer relink carrier changed concurrently';
      END IF;
    END IF;

  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_guard_noncommerce_cleanup_carrier_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_unresolved_dlq BOOLEAN := false;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.state <> 'settled'
       AND (intent.action_id = OLD.id OR intent.cleanup_action_id = OLD.id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'role-delivery carrier cannot be deleted while its intent is unresolved';
  END IF;

  IF public.commerce_noncommerce_cleanup_carrier_kind(
       OLD.guild_id,
       OLD.action,
       OLD.lane,
       OLD.idempotency_key,
       OLD.payload
     ) IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.action_queue_dlq AS dlq
     WHERE dlq.original_id = OLD.id::TEXT
       AND dlq.guild_id = OLD.guild_id
       AND dlq.action = OLD.action
       AND dlq.lane = OLD.lane
       AND dlq.payload = OLD.payload
       AND dlq.retried IS NOT TRUE
  ) INTO v_unresolved_dlq;

  IF OLD.status IS DISTINCT FROM 'completed' OR v_unresolved_dlq THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'noncommerce cleanup carrier cannot be deleted before resolution';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_guard_role_delivery_parent_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_has_unresolved BOOLEAN := false;
BEGIN
  IF TG_TABLE_NAME = 'entitlements' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.commerce_role_delivery_intents AS intent
       WHERE intent.entitlement_id = OLD.id AND intent.state <> 'settled'
    ) OR EXISTS (
      SELECT 1
        FROM public.bot_action_queue AS queue
       WHERE queue.payload ->> 'entitlement_id' = OLD.id::TEXT
         AND public.commerce_noncommerce_cleanup_carrier_kind(
           queue.guild_id,
           queue.action,
           queue.lane,
           queue.idempotency_key,
           queue.payload
         ) IS NOT NULL
         AND (
           queue.status IS DISTINCT FROM 'completed'
           OR EXISTS (
             SELECT 1
               FROM public.action_queue_dlq AS dlq
              WHERE dlq.original_id = queue.id::TEXT
                AND dlq.guild_id = queue.guild_id
                AND dlq.action = queue.action
                AND dlq.lane = queue.lane
                AND dlq.payload = queue.payload
                AND dlq.retried IS NOT TRUE
           )
         )
    ) INTO v_has_unresolved;
  ELSIF TG_TABLE_NAME = 'orders' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.commerce_role_delivery_intents AS intent
       WHERE intent.order_id = OLD.id AND intent.state <> 'settled'
    ) INTO v_has_unresolved;
  ELSIF TG_TABLE_NAME = 'customers' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.commerce_role_delivery_intents AS intent
       WHERE intent.customer_id = OLD.id AND intent.state <> 'settled'
    ) OR EXISTS (
      SELECT 1
        FROM public.bot_action_queue AS queue
       WHERE queue.payload ->> 'customer_id' = OLD.id::TEXT
         AND public.commerce_noncommerce_cleanup_carrier_kind(
           queue.guild_id,
           queue.action,
           queue.lane,
           queue.idempotency_key,
           queue.payload
         ) IS NOT NULL
         AND (
           queue.status IS DISTINCT FROM 'completed'
           OR EXISTS (
             SELECT 1
               FROM public.action_queue_dlq AS dlq
              WHERE dlq.original_id = queue.id::TEXT
                AND dlq.guild_id = queue.guild_id
                AND dlq.action = queue.action
                AND dlq.lane = queue.lane
                AND dlq.payload = queue.payload
                AND dlq.retried IS NOT TRUE
           )
         )
    ) INTO v_has_unresolved;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce role-delivery parent guard is installed on an unsupported table';
  END IF;

  IF v_has_unresolved THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'commerce role-delivery parent cannot be deleted before exact cleanup settles';
  END IF;
  RETURN OLD;
END;
$$;

-- The worker revalidates these origin fields before acting, so a grant's
-- identity and snapshots remain immutable for its lifetime. Status-only
-- lifecycle transitions remain legal. A materially different grant must be a
-- new entitlement rather than rewriting historical delivery authority.
CREATE OR REPLACE FUNCTION public.commerce_guard_noncommerce_origin_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.guild_id IS NOT DISTINCT FROM OLD.guild_id
     AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
     AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.license_key_id IS NOT DISTINCT FROM OLD.license_key_id
     AND NEW.source IS NOT DISTINCT FROM OLD.source
     AND NEW.type IS NOT DISTINCT FROM OLD.type
     AND NEW.plan_id IS NOT DISTINCT FROM OLD.plan_id
     AND NEW.granted_role_ids IS NOT DISTINCT FROM OLD.granted_role_ids
     AND NEW.granted_channel_ids IS NOT DISTINCT FROM OLD.granted_channel_ids THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'entitlement grant identity and snapshots are lifetime-immutable';
END;
$$;

DROP TRIGGER IF EXISTS commerce_entitlements_enqueue_noncommerce_terminal
  ON public.entitlements;
DROP TRIGGER IF EXISTS commerce_entitlements_enqueue_noncommerce_activation_insert
  ON public.entitlements;
DROP TRIGGER IF EXISTS commerce_entitlements_enqueue_noncommerce_activation_update
  ON public.entitlements;
DROP TRIGGER IF EXISTS commerce_entitlements_guard_noncommerce_origin_update
  ON public.entitlements;
CREATE TRIGGER commerce_entitlements_guard_noncommerce_origin_update
  BEFORE UPDATE OF id, guild_id, customer_id, order_id, product_id,
    license_key_id, source, type, plan_id, granted_role_ids,
    granted_channel_ids
  ON public.entitlements
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_noncommerce_origin_update();

CREATE TRIGGER commerce_entitlements_enqueue_noncommerce_terminal
  AFTER UPDATE OF status ON public.entitlements
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.commerce_enqueue_noncommerce_terminal_transition();

CREATE TRIGGER commerce_entitlements_enqueue_noncommerce_activation_insert
  AFTER INSERT ON public.entitlements
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_enqueue_noncommerce_activation_transition();

CREATE TRIGGER commerce_entitlements_enqueue_noncommerce_activation_update
  AFTER UPDATE OF status ON public.entitlements
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.commerce_enqueue_noncommerce_activation_transition();

CREATE TRIGGER commerce_entitlements_signal_role_delivery_terminal
  AFTER UPDATE OF status ON public.entitlements
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.commerce_signal_entitlement_role_delivery_terminal();

CREATE TRIGGER commerce_orders_signal_role_delivery_terminal
  AFTER UPDATE OF status ON public.orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.commerce_signal_order_role_delivery_terminal();

CREATE TRIGGER commerce_customers_signal_role_delivery_relink
  AFTER UPDATE OF discord_id ON public.customers
  FOR EACH ROW
  WHEN (OLD.discord_id IS DISTINCT FROM NEW.discord_id)
  EXECUTE FUNCTION public.commerce_signal_customer_role_delivery_relink();

DROP TRIGGER IF EXISTS commerce_queue_guard_noncommerce_cleanup_delete
  ON public.bot_action_queue;
CREATE TRIGGER commerce_queue_guard_noncommerce_cleanup_delete
  BEFORE DELETE ON public.bot_action_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_noncommerce_cleanup_carrier_delete();

CREATE TRIGGER commerce_entitlements_guard_unresolved_role_delivery_delete
  BEFORE DELETE ON public.entitlements
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_role_delivery_parent_delete();

CREATE TRIGGER commerce_orders_guard_unresolved_role_delivery_delete
  BEFORE DELETE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_role_delivery_parent_delete();

CREATE TRIGGER commerce_customers_guard_unresolved_role_delivery_delete
  BEFORE DELETE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_role_delivery_parent_delete();

REVOKE ALL ON FUNCTION public.commerce_mark_role_delivery_intent_terminal(UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_signal_entitlement_role_delivery_terminal()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_enqueue_noncommerce_terminal_entitlement(
  UUID, TEXT, BOOLEAN
)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_enqueue_noncommerce_terminal_transition()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_enqueue_noncommerce_activation_entitlement(
  UUID, TEXT, UUID, UUID, TEXT
)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_enqueue_noncommerce_activation_transition()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_signal_order_role_delivery_terminal()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_signal_customer_role_delivery_relink()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_guard_noncommerce_cleanup_carrier_delete()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_guard_noncommerce_origin_update()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_guard_role_delivery_parent_delete()
  FROM PUBLIC, anon, authenticated, service_role;

-- Partial migration retries or a deployment that began while an old worker was
-- draining may already contain exact intents. Reclassify every unresolved
-- non-live contract through the same helper; no role vector is reconstructed.
DO $$
DECLARE
  v_intent RECORD;
BEGIN
  FOR v_intent IN
    SELECT intent.id,
           public.commerce_role_delivery_contract_state(intent.id) AS contract_state
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.state <> 'settled'
     ORDER BY intent.id
  LOOP
    IF v_intent.contract_state <> 'live' THEN
      PERFORM public.commerce_mark_role_delivery_intent_terminal(
        v_intent.id,
        'migration catch-up found unresolved ' || v_intent.contract_state || ' role delivery'
      );
    END IF;
  END LOOP;
END;
$$;

-- Old broad revoke payloads cannot be upgraded into exact removal authority.
-- Quarantine them and their retry buttons; the exact-intent alerts/carriers
-- above are the only automated Discord cleanup path after this migration.
INSERT INTO public.alerts (
  guild_id, alert_type, severity, title, message, metadata, resolved
)
SELECT queue.guild_id,
       'commerce_legacy_role_revoke_quarantined',
       'critical',
       'Legacy commerce role revoke requires review',
       'The action was quarantined because entitlement metadata is not exact Discord removal authority.',
       pg_catalog.jsonb_build_object(
         'action_id', queue.id,
         'next_step', 'inspect_exact_role_delivery_intent'
       ),
       false
  FROM public.bot_action_queue AS queue
 WHERE queue.action = 'revoke_roles'
   AND queue.status IN ('pending', 'processing', 'failed')
   AND NOT EXISTS (
     SELECT 1 FROM public.alerts AS alert
      WHERE alert.guild_id = queue.guild_id
        AND alert.alert_type = 'commerce_legacy_role_revoke_quarantined'
        AND alert.resolved = false
        AND alert.metadata ->> 'action_id' = queue.id::TEXT
   );

UPDATE public.bot_action_queue AS queue
   SET status = 'failed',
       started_at = NULL,
       completed_at = COALESCE(queue.completed_at, pg_catalog.clock_timestamp()),
       next_retry_at = NULL,
       error_message = 'Quarantined: exact role-delivery intent is required for Discord cleanup'
 WHERE queue.action = 'revoke_roles'
   AND queue.status IN ('pending', 'processing', 'failed');

UPDATE public.action_queue_dlq AS dlq
   SET retried = true,
       retried_at = COALESCE(dlq.retried_at, pg_catalog.clock_timestamp()),
       error_message = COALESCE(dlq.error_message || ' | ', '')
         || 'Quarantined: exact role-delivery intent is required for Discord cleanup'
 WHERE dlq.action = 'revoke_roles'
   AND COALESCE(dlq.retried, false) = false;

-- Rehydrate exact carriers only after every pre-protocol broad revoke row has
-- been quarantined. This ordering prevents the migration's own non-commerce
-- backfill from being mistaken for legacy metadata-derived authority.
DO $$
DECLARE
  v_entitlement RECORD;
BEGIN
  FOR v_entitlement IN
    SELECT entitlement.id, entitlement.status
      FROM public.entitlements AS entitlement
     WHERE entitlement.source IN ('manual', 'giveaway', 'automation')
       AND entitlement.status IN ('expired', 'cancelled')
     ORDER BY entitlement.id
  LOOP
    PERFORM public.commerce_enqueue_noncommerce_terminal_entitlement(
      v_entitlement.id,
      v_entitlement.status
    );
  END LOOP;
END;
$$;

-- Existing live non-commerce grants predate the activation trigger. Give every
-- role-bearing row one fresh exact generation so migration success does not
-- preserve the former six-hour-only delivery contract.
DO $$
DECLARE
  v_entitlement RECORD;
BEGIN
  FOR v_entitlement IN
    SELECT entitlement.id,
           entitlement.status,
           head.activation_generation AS expected_activation_generation
      FROM public.entitlements AS entitlement
      LEFT JOIN public.commerce_noncommerce_activation_heads AS head
        ON head.entitlement_id = entitlement.id
     WHERE entitlement.source IN ('manual', 'giveaway', 'automation')
       AND entitlement.status IN (
         'active', 'pending', 'grace_period', 'suspended'
       )
     ORDER BY entitlement.id
  LOOP
    PERFORM public.commerce_enqueue_noncommerce_activation_entitlement(
      v_entitlement.id,
      v_entitlement.status,
      gen_random_uuid(),
      v_entitlement.expected_activation_generation,
      NULL
    );
  END LOOP;
END;
$$;

-- Privacy deletion is two phase for commerce identities. The pre-existing
-- member purge revokes the durable entitlement first, which synchronously
-- signals every exact role-delivery intent above. It must not then erase the
-- Discord/customer evidence those cleanup carriers need. Preserve the old
-- implementation behind a private name and expose a wrapper that returns an
-- explicit pending state until Discord cleanup and its queue controller have
-- both settled. A later retry removes the settled protocol tombstones and
-- anonymizes the retained commerce identity.
ALTER FUNCTION public.purge_member_data(TEXT, TEXT)
  RENAME TO commerce_purge_member_data_base;
REVOKE ALL ON FUNCTION public.commerce_purge_member_data_base(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.purge_member_data(
  p_guild_id TEXT,
  p_user_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted JSONB;
  v_customer_ids UUID[] := '{}'::UUID[];
  v_action_ids UUID[] := '{}'::UUID[];
  v_unresolved_intents INTEGER := 0;
  v_active_temp_grants INTEGER := 0;
  v_active_queue_actions INTEGER := 0;
  v_active_dlq_actions INTEGER := 0;
  v_pending INTEGER := 0;
  v_count INTEGER := 0;
BEGIN
  IF p_guild_id IS NULL
     OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_guild_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'purge_member_data: canonical p_guild_id is required';
  END IF;
  IF p_user_id IS NULL
     OR p_user_id <> pg_catalog.btrim(p_user_id)
     OR p_user_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'purge_member_data: canonical p_user_id is required';
  END IF;

  -- A two-phase retry must retain the customer captured by phase one even if
  -- that row was relinked from A to B while Discord cleanup was pending.
  -- Reconstruct the exact identity set from current rows plus immutable paid
  -- intents and authenticated non-commerce carriers, then lock those rows.
  SELECT COALESCE(
           pg_catalog.array_agg(candidate.customer_id ORDER BY candidate.customer_id),
           '{}'::UUID[]
         )
    INTO v_customer_ids
    FROM (
      SELECT customer.id AS customer_id
        FROM public.customers AS customer
       WHERE customer.guild_id = p_guild_id
         AND customer.discord_id = p_user_id
      UNION
      SELECT intent.customer_id
        FROM public.commerce_role_delivery_intents AS intent
       WHERE intent.guild_id = p_guild_id
         AND intent.discord_id = p_user_id
      UNION
      SELECT (queue.payload ->> 'customer_id')::UUID
        FROM public.bot_action_queue AS queue
       WHERE queue.guild_id = p_guild_id
         AND (
           queue.payload ->> 'discord_id' = p_user_id
           OR queue.payload ->> 'old_discord_id' = p_user_id
         )
         AND public.commerce_noncommerce_cleanup_carrier_kind(
           queue.guild_id,
           queue.action,
           queue.lane,
           queue.idempotency_key,
           queue.payload
         ) IS NOT NULL
    ) AS candidate;
  PERFORM customer.id
    FROM public.customers AS customer
   WHERE customer.id = ANY(v_customer_ids)
     AND customer.guild_id = p_guild_id
   ORDER BY customer.id
   FOR UPDATE;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'economy-role-income:' || p_guild_id || ':' || p_user_id,
      0
    )
  );

  v_deleted := public.commerce_purge_member_data_base(
    p_guild_id,
    p_user_id
  );

  -- The customer may have committed A -> B after the identity candidates were
  -- captured (or before this retry, with A retained only by an authenticated
  -- carrier). The base implementation scopes revocation through the current
  -- Discord id and would therefore miss that now-locked customer. Revoke every
  -- still-live entitlement in the captured identity set while its customer row
  -- is locked; terminal triggers snapshot the current B identity atomically.
  UPDATE public.entitlements AS entitlement
     SET status = 'cancelled',
         cancelled_at = COALESCE(
           entitlement.cancelled_at,
           pg_catalog.clock_timestamp()
         )
   WHERE entitlement.customer_id = ANY(v_customer_ids)
     AND entitlement.guild_id = p_guild_id
     AND entitlement.status IN (
       'active', 'pending', 'grace_period', 'suspended'
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'entitlements_revoked',
    COALESCE((v_deleted ->> 'entitlements_revoked')::INTEGER, 0) + v_count
  );

  UPDATE public.alerts AS alert
     SET resolved = true,
         resolved_at = COALESCE(
           alert.resolved_at,
           pg_catalog.clock_timestamp()
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE alert.guild_id = p_guild_id
     AND alert.alert_type = 'entitlement_grace_period'
     AND alert.resolved = false
     AND alert.metadata ->> 'entitlement_id' IN (
       SELECT entitlement.id::TEXT
         FROM public.entitlements AS entitlement
        WHERE entitlement.guild_id = p_guild_id
          AND entitlement.customer_id = ANY(v_customer_ids)
     );

  SELECT COALESCE(
           pg_catalog.array_agg(
             controller.action_id ORDER BY controller.action_id
           ),
           '{}'::UUID[]
         )
    INTO v_action_ids
    FROM (
      SELECT intent.action_id
        FROM public.commerce_role_delivery_intents AS intent
       WHERE intent.customer_id = ANY(v_customer_ids)
         AND intent.guild_id = p_guild_id
      UNION
      SELECT intent.cleanup_action_id
        FROM public.commerce_role_delivery_intents AS intent
       WHERE intent.customer_id = ANY(v_customer_ids)
         AND intent.guild_id = p_guild_id
         AND intent.cleanup_action_id IS NOT NULL
      UNION
      SELECT head.action_id
        FROM public.commerce_noncommerce_activation_heads AS head
       WHERE head.customer_id = ANY(v_customer_ids)
         AND head.guild_id = p_guild_id
    ) AS controller(action_id);

  -- A completed exact controller is stronger evidence than a stale DLQ copy
  -- left by an earlier failed generation of that same carrier. Retire every
  -- such sibling before deciding whether privacy cleanup is still blocked.
  -- Direct identity matching remains active even after a customer relink, when
  -- the former Discord id may survive only in an immutable queue payload.
  UPDATE public.action_queue_dlq AS dlq
     SET retried = true,
         retried_at = COALESCE(
           dlq.retried_at,
           pg_catalog.clock_timestamp()
         ),
         error_message = COALESCE(dlq.error_message || ' | ', '')
           || 'Retired after exact role-delivery controller settled'
   WHERE (
       dlq.original_id = ANY(v_action_ids::TEXT[])
       OR dlq.payload ->> 'discord_id' = p_user_id
       OR dlq.payload ->> 'old_discord_id' = p_user_id
       OR dlq.payload ->> 'customer_id' = ANY(v_customer_ids::TEXT[])
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
        WHERE intent.customer_id = ANY(v_customer_ids)
          AND intent.state <> 'settled'
          AND (
            intent.action_id::TEXT = dlq.original_id
            OR intent.cleanup_action_id::TEXT = dlq.original_id
          )
     );

  SELECT pg_catalog.count(*)::INTEGER
    INTO v_unresolved_intents
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.customer_id = ANY(v_customer_ids)
     AND intent.guild_id = p_guild_id
     AND intent.state <> 'settled';

  SELECT pg_catalog.count(*)::INTEGER
    INTO v_active_temp_grants
    FROM public.temp_role_grants AS grant_row
    JOIN public.orders AS paid_order
      ON paid_order.id = grant_row.order_id
     AND paid_order.guild_id = grant_row.guild_id
   WHERE paid_order.customer_id = ANY(v_customer_ids)
     AND grant_row.guild_id = p_guild_id
     AND grant_row.remove_on_expiry = true
     AND grant_row.grant_status IN ('pending', 'applied');

  SELECT pg_catalog.count(*)::INTEGER
    INTO v_active_queue_actions
    FROM public.bot_action_queue AS queue
   WHERE queue.lane = 'commerce'
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
     )
     AND (
       queue.payload ->> 'discord_id' = p_user_id
       OR queue.payload ->> 'old_discord_id' = p_user_id
       OR queue.payload ->> 'customer_id' = ANY(
         v_customer_ids::TEXT[]
       )
       OR queue.id = ANY(v_action_ids)
     );

  SELECT pg_catalog.count(*)::INTEGER
    INTO v_active_dlq_actions
    FROM public.action_queue_dlq AS dlq
   WHERE dlq.lane = 'commerce'
     AND COALESCE(dlq.retried, false) = false
     AND (
       dlq.payload ->> 'discord_id' = p_user_id
       OR dlq.payload ->> 'old_discord_id' = p_user_id
       OR dlq.payload ->> 'customer_id' = ANY(
         v_customer_ids::TEXT[]
       )
       OR dlq.original_id = ANY(v_action_ids::TEXT[])
     );

  v_pending := v_unresolved_intents
    + v_active_temp_grants
    + v_active_queue_actions
    + v_active_dlq_actions;
  IF v_pending > 0 THEN
    RETURN v_deleted || pg_catalog.jsonb_build_object(
      'purge_status', 'pending_role_cleanup',
      'pending_role_cleanup_count', v_pending,
      'unresolved_role_delivery_intents', v_unresolved_intents,
      'active_owned_temp_role_grants', v_active_temp_grants,
      'active_commerce_queue_actions', v_active_queue_actions,
      'active_commerce_dlq_actions', v_active_dlq_actions
    );
  END IF;

  -- Relink ensure-request carriers deliberately never become role-delivery
  -- intent controllers. Include them, receipts, and any other terminal
  -- customer-scoped commerce row by exact payload identity so their payload
  -- and idempotency-key PII are not left behind after the protocol tombstones
  -- are gone.
  SELECT COALESCE(
           pg_catalog.array_agg(scoped.action_id ORDER BY scoped.action_id),
           '{}'::UUID[]
         )
    INTO v_action_ids
    FROM (
      SELECT controller.action_id
        FROM pg_catalog.unnest(v_action_ids) AS controller(action_id)
      UNION
      SELECT queue.id
        FROM public.bot_action_queue AS queue
       WHERE queue.lane = 'commerce'
         AND queue.status IN ('completed', 'failed')
         AND (
           queue.payload ->> 'discord_id' = p_user_id
           OR queue.payload ->> 'old_discord_id' = p_user_id
           OR queue.payload ->> 'customer_id' = ANY(v_customer_ids::TEXT[])
         )
    ) AS scoped(action_id);

  DELETE FROM public.portal_sessions AS session
   WHERE session.guild_id = p_guild_id
     AND session.customer_id = ANY(v_customer_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'portal_sessions', v_count
  );

  DELETE FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.customer_id = ANY(v_customer_ids)
     AND intent.guild_id = p_guild_id
     AND intent.state = 'settled';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'commerce_role_delivery_intents', v_count
  );

  -- Activation heads are current-generation routing pointers, not durable
  -- removal evidence. Once every controller and intent for the identity is
  -- resolved, erase their retained Discord/customer snapshot before the
  -- customer is anonymized. Parent FKs provide the same guarantee for direct
  -- entitlement/customer/order/product deletion paths.
  DELETE FROM public.commerce_noncommerce_activation_heads AS head
   WHERE head.customer_id = ANY(v_customer_ids)
     AND head.guild_id = p_guild_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'commerce_noncommerce_activation_heads', v_count
  );

  DELETE FROM public.commerce_legacy_subscription_grant_contracts AS legacy
   WHERE legacy.customer_id = ANY(v_customer_ids)
     AND legacy.guild_id = p_guild_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'commerce_legacy_subscription_grant_contracts', v_count
  );

  DELETE FROM public.temp_role_grants AS grant_row
   WHERE grant_row.guild_id = p_guild_id
     AND grant_row.order_id IN (
       SELECT paid_order.id
         FROM public.orders AS paid_order
        WHERE paid_order.customer_id = ANY(v_customer_ids)
          AND paid_order.guild_id = p_guild_id
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'commerce_temp_role_grants', v_count
  );

  -- Queue payloads are immutable in every status. Once the exact intents and
  -- any retained legacy contract are gone, delete their terminal controllers
  -- and resolved DLQ copies instead of weakening or bypassing that invariant.
  DELETE FROM public.action_queue_dlq AS dlq
   WHERE COALESCE(dlq.retried, false) = true
     AND (
       dlq.original_id = ANY(v_action_ids::TEXT[])
       OR dlq.payload ->> 'discord_id' = p_user_id
       OR dlq.payload ->> 'old_discord_id' = p_user_id
       OR dlq.payload ->> 'customer_id' = ANY(v_customer_ids::TEXT[])
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'commerce_dlq_tombstones', v_count
  );

  DELETE FROM public.bot_action_queue AS queue
   WHERE queue.id = ANY(v_action_ids)
     AND queue.status IN ('completed', 'failed');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'commerce_queue_tombstones', v_count
  );

  UPDATE public.license_keys AS license_key
     SET bound_discord_id = 'deleted-' || license_key.id::TEXT,
         updated_at = pg_catalog.clock_timestamp()
   WHERE license_key.customer_id = ANY(v_customer_ids)
     AND license_key.guild_id = p_guild_id
     AND license_key.status = 'revoked';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'license_key_identities_anonymized', v_count
  );

  PERFORM pg_catalog.set_config(
    'somnibot.commerce_member_purge_identity',
    p_guild_id || '|' || pg_catalog.array_to_string(v_customer_ids, ','),
    true
  );
  UPDATE public.customers AS customer
     SET user_id = NULL,
         discord_id = 'deleted-' || customer.id::TEXT,
         discord_username = 'deleted_user',
         paypal_customer_id = NULL,
         email = NULL,
         notes = NULL,
         updated_at = pg_catalog.clock_timestamp()
   WHERE customer.id = ANY(v_customer_ids)
     AND customer.guild_id = p_guild_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM pg_catalog.set_config(
    'somnibot.commerce_member_purge_identity', '', true
  );
  IF v_count IS DISTINCT FROM pg_catalog.cardinality(v_customer_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'purge_member_data: captured commerce identity set changed concurrently';
  END IF;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'commerce_customers_anonymized', v_count,
    'purge_status', 'completed',
    'pending_role_cleanup_count', 0
  );

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_member_data(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_member_data(TEXT, TEXT)
  TO service_role;

-- The legacy guild purge returned VOID, so it could not commit role-cleanup
-- carriers and tell its caller to retry: raising would roll the carriers back,
-- while returning looked like a completed deletion. There are no SQL object
-- dependencies on this service-role-only RPC (DROP remains RESTRICT), so move
-- it to the same explicit two-phase JSONB contract as member privacy deletion.
DROP FUNCTION public.purge_guild_data(TEXT);

CREATE FUNCTION public.purge_guild_data(p_guild_id TEXT)
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

  -- Make every future delivery classifier terminal before touching retained
  -- protocol evidence. Order first preserves the global parent -> entitlement
  -- lock order; both status triggers signal the same exact intents idempotently.
  UPDATE public.orders AS paid_order
     SET status = 'cancelled',
         updated_at = pg_catalog.clock_timestamp()
   WHERE paid_order.guild_id = p_guild_id
     AND paid_order.status IN ('pending', 'completed');
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

-- PayPal resource ids are opaque but their transport grammar is not. Install
-- these NOT VALID fences only after every legacy payment/order normalization
-- above: historical noncanonical rows remain inspectable, while all subsequent
-- inserts/updates and every lifecycle RPC fail closed on the shared grammar.
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_paypal_payment_id_canonical;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_paypal_payment_id_canonical
  CHECK (
    paypal_payment_id IS NULL
    OR paypal_payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
  ) NOT VALID;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_paypal_order_id_canonical;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_paypal_order_id_canonical
  CHECK (
    paypal_order_id IS NULL
    OR paypal_order_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
  ) NOT VALID;

-- Refund ledger rows carry their provider resource family as a generated,
-- immutable fact.  New rows must have a canonical provider id and one of the
-- exact PayPal event families understood by the lifecycle state machines.
ALTER TABLE public.payment_refunds
  ADD COLUMN IF NOT EXISTS paypal_resource_type TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN event_type = 'ADMIN.REFUND'
        OR event_type IN ('PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED')
        THEN 'capture'::TEXT
      WHEN event_type IN ('PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED')
        THEN 'sale'::TEXT
      ELSE NULL::TEXT
    END
  ) STORED;

ALTER TABLE public.payment_refunds
  DROP CONSTRAINT IF EXISTS payment_refunds_provider_id_canonical;
ALTER TABLE public.payment_refunds
  ADD CONSTRAINT payment_refunds_provider_id_canonical
  CHECK (
    paypal_refund_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
  ) NOT VALID;

ALTER TABLE public.payment_refunds
  DROP CONSTRAINT IF EXISTS payment_refunds_resource_type_known;
ALTER TABLE public.payment_refunds
  ADD CONSTRAINT payment_refunds_resource_type_known
  CHECK (
    paypal_resource_type IS NOT NULL
    AND paypal_resource_type IN ('capture', 'sale')
  ) NOT VALID;

CREATE OR REPLACE FUNCTION public.commerce_adopt_payment_resource_from_refund()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_resource_type TEXT;
  v_refunded_before BIGINT := 0;
  v_invalid_refund_count INTEGER := 0;
  v_reversal_count INTEGER := 0;
BEGIN
  v_resource_type := CASE
    WHEN NEW.event_type = 'ADMIN.REFUND'
      OR NEW.event_type IN ('PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED')
      THEN 'capture'
    WHEN NEW.event_type IN ('PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED')
      THEN 'sale'
    ELSE NULL
  END;
  IF v_resource_type IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce refund ledger: provider event type is unsupported';
  END IF;

  -- Match every refund state machine's order -> payment lock order so a
  -- direct ledger insert cannot deadlock with canonical refund processing.
  SELECT paid_order.* INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = NEW.order_id
     AND paid_order.guild_id = NEW.guild_id
     AND paid_order.status IN ('completed', 'refunded')
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce refund ledger: order identity or state is unavailable';
  END IF;

  SELECT payment.*
    INTO v_payment
    FROM public.payments AS payment
   WHERE payment.id = NEW.payment_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce refund ledger: payment identity is unavailable';
  END IF;
  IF v_payment.order_id IS DISTINCT FROM NEW.order_id
     OR v_payment.guild_id IS DISTINCT FROM NEW.guild_id
     OR v_payment.provider IS DISTINCT FROM 'paypal'
     OR v_payment.status NOT IN ('completed', 'refunded', 'reversed')
     OR v_payment.paypal_payment_id IS NULL
     OR v_payment.paypal_payment_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR v_payment.amount_cents IS NULL OR v_payment.amount_cents <= 0
     OR v_order.amount_cents IS NULL OR v_order.amount_cents <= 0
     OR v_payment.amount_cents IS DISTINCT FROM v_order.amount_cents
     OR v_payment.currency IS NULL
     OR v_payment.currency <> pg_catalog.btrim(v_payment.currency)
     OR pg_catalog.upper(v_payment.currency) !~ '^[A-Z]{3}$'
     OR pg_catalog.upper(v_payment.currency) IS DISTINCT FROM v_order.currency
     OR v_order.currency IS NULL OR v_order.currency !~ '^[A-Z]{3}$'
     OR (
       v_resource_type = 'capture'
       AND (
         v_order.plan_id IS NOT NULL
         OR v_order.paypal_subscription_id IS NOT NULL
         OR (
           v_order.paypal_order_id IS NOT NULL
           AND v_order.paypal_order_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
         )
       )
     )
     OR (
       v_resource_type = 'sale'
       AND (v_order.plan_id IS NULL OR v_order.paypal_subscription_id IS NULL)
     )
     OR NEW.amount_cents IS NULL OR NEW.amount_cents < 0
     OR (
       NEW.event_type IN (
         'ADMIN.REFUND',
         'PAYMENT.CAPTURE.REFUNDED',
         'PAYMENT.SALE.REFUNDED'
       )
       AND NEW.amount_cents <= 0
     )
     OR v_payment.amount_cents IS NULL OR NEW.amount_cents > v_payment.amount_cents
     OR NEW.currency IS NULL OR NEW.currency !~ '^[A-Z]{3}$'
     OR v_payment.currency IS NULL
     OR v_payment.currency <> pg_catalog.btrim(v_payment.currency)
     OR pg_catalog.upper(v_payment.currency) !~ '^[A-Z]{3}$'
     OR NEW.currency IS DISTINCT FROM pg_catalog.upper(v_payment.currency) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce refund ledger: payment contract mismatch';
  END IF;

  IF v_payment.paypal_resource_type IS NULL THEN
    UPDATE public.payments AS payment
       SET paypal_resource_type = v_resource_type
     WHERE payment.id = v_payment.id
       AND payment.paypal_resource_type IS NULL;
  ELSIF v_payment.paypal_resource_type IS DISTINCT FROM v_resource_type THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce refund ledger: provider resource identity mismatch';
  END IF;

  IF v_payment.status IN ('refunded', 'reversed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce refund ledger: terminal payment accepts no new events';
  END IF;

  PERFORM 1
    FROM public.payment_refunds AS refund
   WHERE refund.payment_id = v_payment.id
   ORDER BY refund.id
   FOR UPDATE;
  SELECT COALESCE(pg_catalog.sum(refund.amount_cents), 0),
         pg_catalog.count(*) FILTER (
           WHERE refund.order_id IS DISTINCT FROM v_payment.order_id
              OR refund.guild_id IS DISTINCT FROM v_payment.guild_id
              OR refund.paypal_refund_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
              OR refund.amount_cents IS NULL OR refund.amount_cents < 0
              OR (
                refund.event_type IN (
                  'ADMIN.REFUND',
                  'PAYMENT.CAPTURE.REFUNDED',
                  'PAYMENT.SALE.REFUNDED'
                )
                AND refund.amount_cents <= 0
              )
              OR (
                refund.event_type IN (
                  'PAYMENT.CAPTURE.REVERSED',
                  'PAYMENT.SALE.REVERSED'
                )
                AND NOT refund.is_terminal_event_witness
              )
              OR pg_catalog.upper(refund.currency)
                IS DISTINCT FROM pg_catalog.upper(v_payment.currency)
              OR refund.paypal_resource_type IS DISTINCT FROM v_resource_type
         )::INTEGER,
         pg_catalog.count(*) FILTER (
           WHERE refund.event_type IN (
             'PAYMENT.CAPTURE.REVERSED',
             'PAYMENT.SALE.REVERSED'
           )
         )::INTEGER
    INTO v_refunded_before, v_invalid_refund_count, v_reversal_count
    FROM public.payment_refunds AS refund
   WHERE refund.payment_id = v_payment.id;
  IF v_invalid_refund_count > 0
     OR v_refunded_before > v_payment.amount_cents
     OR v_refunded_before + NEW.amount_cents > v_payment.amount_cents THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce refund ledger: cumulative balance requires operator remediation';
  END IF;
  IF NEW.event_type IN ('PAYMENT.CAPTURE.REVERSED', 'PAYMENT.SALE.REVERSED') THEN
    IF v_reversal_count > 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce refund ledger: a reversal witness already exists';
    END IF;
    IF NEW.amount_cents IS DISTINCT FROM
       (v_payment.amount_cents - v_refunded_before)::INTEGER THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'commerce refund ledger: reversal must consume the remaining balance';
    END IF;
  ELSIF NEW.event_type = 'ADMIN.REFUND'
        AND NEW.amount_cents IS DISTINCT FROM
          (v_payment.amount_cents - v_refunded_before)::INTEGER THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce refund ledger: admin refund must consume the remaining balance';
  END IF;

  NEW.is_terminal_event_witness :=
    v_refunded_before + NEW.amount_cents = v_payment.amount_cents
    AND (
      NEW.event_type IN ('PAYMENT.CAPTURE.REVERSED', 'PAYMENT.SALE.REVERSED')
      OR v_refunded_before < v_payment.amount_cents
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_refund_adopts_payment_resource
  ON public.payment_refunds;
CREATE TRIGGER commerce_refund_adopts_payment_resource
  BEFORE INSERT ON public.payment_refunds
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_adopt_payment_resource_from_refund();

CREATE OR REPLACE FUNCTION public.commerce_guard_refund_ledger_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'commerce refund ledger rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS commerce_refund_ledger_immutable
  ON public.payment_refunds;
CREATE TRIGGER commerce_refund_ledger_immutable
  BEFORE UPDATE ON public.payment_refunds
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_refund_ledger_immutable();

REVOKE ALL ON FUNCTION public.commerce_adopt_payment_resource_from_refund()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commerce_guard_refund_ledger_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

-- Application service clients may inspect provider evidence, but canonical
-- SECURITY DEFINER state machines own every append so direct writes cannot
-- bypass refund amount, alert/audit, or terminal-witness contracts. They also
-- cannot rewrite or erase the durable proof. Table-owner SECURITY DEFINER
-- retention and guild-purge routines retain their authority; this narrows only
-- the broad GRANT ALL issued by the original ledger migration.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.payment_refunds FROM service_role;
GRANT SELECT ON public.payment_refunds TO service_role;

-- An admin refund is an append-only sequence of provider attempts.  Each
-- attempt owns a unique PayPal-Request-Id (the attempt UUID), retains terminal
-- failures, and freezes the exact unrefunded baseline.  Only one nonterminal
-- attempt may exist for an order, while a completed attempt is retained as the
-- durable idempotency witness.
CREATE TABLE public.commerce_admin_refund_operations (
  attempt_id                       UUID        PRIMARY KEY,
  request_id                       UUID        NOT NULL UNIQUE,
  order_id                         UUID        NOT NULL REFERENCES public.orders(id),
  guild_id                         TEXT        NOT NULL REFERENCES public.guild(id),
  customer_id                      UUID        NOT NULL REFERENCES public.customers(id),
  product_id                       UUID        NOT NULL REFERENCES public.products(id),
  plan_id                          UUID        REFERENCES public.plans(id),
  actor_id                         TEXT        NOT NULL CHECK (
    actor_id = pg_catalog.btrim(actor_id)
    AND pg_catalog.length(actor_id) BETWEEN 1 AND 255
  ),
  paypal_order_id                  TEXT,
  payment_id                       UUID        REFERENCES public.payments(id),
  paypal_payment_id                TEXT,
  resource_type                    TEXT        CHECK (resource_type IN ('capture')),
  order_amount_cents               INTEGER     NOT NULL CHECK (order_amount_cents >= 0),
  existing_refunded_cents          INTEGER     NOT NULL CHECK (existing_refunded_cents >= 0),
  refund_amount_cents              INTEGER     NOT NULL CHECK (refund_amount_cents >= 0),
  currency                         TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason                           TEXT        NOT NULL CHECK (
    reason = pg_catalog.btrim(reason)
    AND pg_catalog.length(reason) BETWEEN 1 AND 255
  ),
  provider_required                BOOLEAN     NOT NULL,
  status                           TEXT        NOT NULL DEFAULT 'prepared' CHECK (
    status IN ('prepared', 'pending', 'provider_completed', 'failed', 'cancelled', 'completed')
  ),
  provider_status                  TEXT        CHECK (
    provider_status IN ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED')
  ),
  paypal_refund_id                 TEXT,
  provider_reported_amount_cents   INTEGER,
  provider_reported_currency       TEXT,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_outcome_at              TIMESTAMPTZ,
  completed_at                     TIMESTAMPTZ,
  CONSTRAINT commerce_admin_refund_attempt_request_identity CHECK (
    request_id = attempt_id
  ),
  CONSTRAINT commerce_admin_refund_attempt_amounts_valid CHECK (
    existing_refunded_cents <= order_amount_cents
    AND refund_amount_cents = order_amount_cents - existing_refunded_cents
    AND provider_required = (refund_amount_cents > 0 AND payment_id IS NOT NULL)
  ),
  CONSTRAINT commerce_admin_refund_attempt_payment_shape CHECK (
    (
      payment_id IS NULL
      AND paypal_order_id IS NULL
      AND paypal_payment_id IS NULL
      AND resource_type IS NULL
    )
    OR (
      payment_id IS NOT NULL
      AND (
        paypal_order_id IS NULL
        OR paypal_order_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
      )
      AND paypal_payment_id IS NOT NULL
      AND paypal_payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
      AND resource_type IS NOT NULL
      AND resource_type IS NOT DISTINCT FROM 'capture'
    )
  ),
  CONSTRAINT commerce_admin_refund_attempt_provider_shape CHECK (
    (
      paypal_refund_id IS NULL
      OR paypal_refund_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
    )
    AND (provider_reported_amount_cents IS NULL OR provider_reported_amount_cents >= 0)
    AND (provider_reported_currency IS NULL OR provider_reported_currency ~ '^[A-Z]{3}$')
    AND (
      (
        status = 'prepared'
        AND provider_status IS NULL
        AND paypal_refund_id IS NULL
        AND provider_reported_amount_cents IS NULL
        AND provider_reported_currency IS NULL
        AND provider_outcome_at IS NULL
        AND completed_at IS NULL
      )
      OR (
        status = 'pending'
        AND provider_required
        AND provider_status IS NOT DISTINCT FROM 'PENDING'
        AND paypal_refund_id IS NOT NULL
        AND provider_reported_amount_cents IS NOT DISTINCT FROM refund_amount_cents
        AND provider_reported_currency IS NOT DISTINCT FROM currency
        AND provider_outcome_at IS NOT NULL
        AND completed_at IS NULL
      )
      OR (
        status = 'provider_completed'
        AND provider_required
        AND provider_status IS NOT DISTINCT FROM 'COMPLETED'
        AND paypal_refund_id IS NOT NULL
        AND provider_reported_amount_cents IS NOT DISTINCT FROM refund_amount_cents
        AND provider_reported_currency IS NOT DISTINCT FROM currency
        AND provider_outcome_at IS NOT NULL
        AND completed_at IS NULL
      )
      OR (
        status IN ('failed', 'cancelled')
        AND provider_status IS NOT DISTINCT FROM
          CASE status WHEN 'failed' THEN 'FAILED' ELSE 'CANCELLED' END
        AND provider_outcome_at IS NOT NULL
        AND completed_at IS NULL
        AND (
          (
            paypal_refund_id IS NULL
            AND provider_reported_amount_cents IS NULL
            AND provider_reported_currency IS NULL
          )
          OR (
            paypal_refund_id IS NOT NULL
            AND provider_reported_amount_cents IS NOT DISTINCT FROM refund_amount_cents
            AND provider_reported_currency IS NOT DISTINCT FROM currency
          )
        )
      )
      OR (
        status = 'completed'
        AND completed_at IS NOT NULL
        AND (
          (
            provider_required
            AND provider_status IS NOT DISTINCT FROM 'COMPLETED'
            AND paypal_refund_id IS NOT NULL
            AND provider_reported_amount_cents IS NOT DISTINCT FROM refund_amount_cents
            AND provider_reported_currency IS NOT DISTINCT FROM currency
            AND provider_outcome_at IS NOT NULL
          )
          OR (
            NOT provider_required
            AND provider_status IS NULL
            AND paypal_refund_id IS NULL
            AND provider_reported_amount_cents IS NULL
            AND provider_reported_currency IS NULL
            AND provider_outcome_at IS NULL
          )
        )
      )
    )
  ),
  CONSTRAINT commerce_admin_refund_attempt_capture_only CHECK (plan_id IS NULL)
);

CREATE UNIQUE INDEX uniq_commerce_admin_refund_active_order
  ON public.commerce_admin_refund_operations (order_id)
  WHERE status IN ('prepared', 'pending', 'provider_completed');
CREATE UNIQUE INDEX uniq_commerce_admin_refund_completed_order
  ON public.commerce_admin_refund_operations (order_id)
  WHERE status = 'completed';
CREATE UNIQUE INDEX uniq_commerce_admin_refund_provider_result
  ON public.commerce_admin_refund_operations (paypal_refund_id)
  WHERE paypal_refund_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.commerce_protect_admin_refund_operation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.guild_id IS DISTINCT FROM OLD.guild_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.paypal_order_id IS DISTINCT FROM OLD.paypal_order_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.paypal_payment_id IS DISTINCT FROM OLD.paypal_payment_id
     OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
     OR NEW.order_amount_cents IS DISTINCT FROM OLD.order_amount_cents
     OR NEW.existing_refunded_cents IS DISTINCT FROM OLD.existing_refunded_cents
     OR NEW.refund_amount_cents IS DISTINCT FROM OLD.refund_amount_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.provider_required IS DISTINCT FROM OLD.provider_required
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce refund attempt: prepared contract is immutable';
  END IF;

  IF OLD.paypal_refund_id IS NOT NULL
     AND NEW.paypal_refund_id IS DISTINCT FROM OLD.paypal_refund_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce refund attempt: provider identity is immutable';
  END IF;
  IF OLD.provider_reported_amount_cents IS NOT NULL
     AND NEW.provider_reported_amount_cents IS DISTINCT FROM OLD.provider_reported_amount_cents THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce refund attempt: provider amount is immutable';
  END IF;
  IF OLD.provider_reported_currency IS NOT NULL
     AND NEW.provider_reported_currency IS DISTINCT FROM OLD.provider_reported_currency THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce refund attempt: provider currency is immutable';
  END IF;

  IF NOT (
    (OLD.status = 'prepared' AND NEW.status IN ('pending', 'provider_completed', 'failed', 'cancelled'))
    OR (OLD.status = 'prepared' AND NOT OLD.provider_required AND NEW.status = 'completed')
    OR (OLD.status = 'pending' AND NEW.status IN ('provider_completed', 'failed', 'cancelled'))
    OR (OLD.status = 'provider_completed' AND NEW.status = 'completed')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce refund attempt: invalid state transition';
  END IF;

  IF NEW.updated_at IS NULL OR NOT pg_catalog.isfinite(NEW.updated_at)
     OR (NEW.provider_outcome_at IS NOT NULL AND NOT pg_catalog.isfinite(NEW.provider_outcome_at))
     OR (NEW.completed_at IS NOT NULL AND NOT pg_catalog.isfinite(NEW.completed_at)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce refund attempt: transition timestamp is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commerce_admin_refund_operation_immutable
  BEFORE UPDATE ON public.commerce_admin_refund_operations
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_protect_admin_refund_operation();

REVOKE ALL ON FUNCTION public.commerce_protect_admin_refund_operation()
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.commerce_admin_refund_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_admin_refund_operations
  FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY service_role_all ON public.commerce_admin_refund_operations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
-- The owner-only order list projects the retained attempt state through its
-- service-role client. Mutations remain RPC-only; grant exactly the read
-- privilege that projection needs after the blanket revoke above.
GRANT SELECT ON public.commerce_admin_refund_operations TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_admin_refund_attempt_json(
  p_attempt public.commerce_admin_refund_operations
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'order_id', p_attempt.order_id,
    'attempt_id', p_attempt.attempt_id,
    'request_id', p_attempt.request_id,
    'status', p_attempt.status,
    'provider_action', CASE p_attempt.status
      WHEN 'prepared' THEN CASE WHEN p_attempt.provider_required THEN 'create' ELSE 'finalize' END
      WHEN 'pending' THEN 'poll'
      WHEN 'provider_completed' THEN 'finalize'
      ELSE 'none'
    END,
    'resource_type', p_attempt.resource_type,
    'paypal_payment_id', p_attempt.paypal_payment_id,
    'paypal_refund_id', p_attempt.paypal_refund_id,
    'refund_amount_cents', p_attempt.refund_amount_cents,
    'currency', p_attempt.currency,
    'reason', p_attempt.reason,
    'actor_id', p_attempt.actor_id
  );
$$;

REVOKE ALL ON FUNCTION public.commerce_admin_refund_attempt_json(
  public.commerce_admin_refund_operations
) FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.commerce_prepare_admin_refund(UUID, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.commerce_prepare_admin_refund(
  p_order_id UUID,
  p_guild_id TEXT,
  p_actor_id TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_attempt public.commerce_admin_refund_operations%ROWTYPE;
  v_discord_id TEXT;
  v_reason TEXT;
  v_actor_id TEXT;
  v_attempt_id UUID;
  v_payment_count INTEGER := 0;
  v_candidate_count INTEGER := 0;
  v_settled_count INTEGER := 0;
  v_invalid_payment_count INTEGER := 0;
  v_refunded_cents BIGINT := 0;
  v_invalid_refund_count INTEGER := 0;
  v_exact_attempt_refund BOOLEAN := false;
  v_unbound_post_attempt_refund BOOLEAN := false;
BEGIN
  IF p_order_id IS NULL
     OR p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: order and guild are required';
  END IF;
  v_actor_id := pg_catalog.btrim(p_actor_id);
  IF v_actor_id IS NULL OR pg_catalog.length(v_actor_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: actor is required';
  END IF;
  v_reason := COALESCE(NULLIF(pg_catalog.btrim(p_reason), ''), 'Admin refund');
  IF pg_catalog.length(v_reason) > 255 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: reason exceeds 255 characters';
  END IF;

  -- Existing attempts lock attempt -> order, matching record/finalize.  A new
  -- order has no attempt lock and serializes on the order before rechecking.
  SELECT operation.*
    INTO v_attempt
    FROM public.commerce_admin_refund_operations AS operation
   WHERE operation.order_id = p_order_id
     AND operation.guild_id = p_guild_id
     AND operation.status IN ('prepared', 'pending', 'provider_completed', 'completed')
   ORDER BY CASE WHEN operation.status = 'completed' THEN 1 ELSE 0 END, operation.created_at DESC
   LIMIT 1
   FOR UPDATE;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: order identity mismatch';
  END IF;

  IF v_attempt.attempt_id IS NULL THEN
    SELECT operation.*
      INTO v_attempt
      FROM public.commerce_admin_refund_operations AS operation
     WHERE operation.order_id = p_order_id
       AND operation.guild_id = p_guild_id
       AND operation.status IN ('prepared', 'pending', 'provider_completed', 'completed')
     ORDER BY CASE WHEN operation.status = 'completed' THEN 1 ELSE 0 END, operation.created_at DESC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF v_order.status NOT IN ('completed', 'refunded')
     OR v_order.customer_id IS NULL
     OR v_order.product_id IS NULL
     OR v_order.amount_cents < 0
     OR v_order.currency !~ '^[A-Z]{3}$'
     OR (
       v_order.paypal_order_id IS NOT NULL
       AND v_order.paypal_order_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: order is not refundable';
  END IF;

  -- Historical order/provider identity is authoritative. The catalog product
  -- may legitimately be moved or retyped after the frozen one-time sale.
  IF v_order.paypal_subscription_id IS NOT NULL OR v_order.plan_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: subscription refunds require the policy-driven subscription workflow';
  END IF;

  PERFORM 1 FROM public.payments AS payment
   WHERE payment.order_id = v_order.id ORDER BY payment.id FOR UPDATE;
  SELECT pg_catalog.count(*)::INTEGER,
         pg_catalog.count(*) FILTER (
           WHERE payment.status IN ('completed', 'refunded')
         )::INTEGER,
         pg_catalog.count(*) FILTER (
           WHERE payment.status IN ('completed', 'refunded', 'reversed')
         )::INTEGER,
         pg_catalog.count(*) FILTER (
           WHERE payment.customer_id IS DISTINCT FROM v_order.customer_id
              OR payment.guild_id IS DISTINCT FROM v_order.guild_id
              OR payment.amount_cents IS NULL
              OR payment.amount_cents <= 0
              OR payment.amount_cents IS DISTINCT FROM v_order.amount_cents
              OR payment.currency IS NULL
              OR payment.currency <> pg_catalog.btrim(payment.currency)
              OR pg_catalog.upper(payment.currency) !~ '^[A-Z]{3}$'
              OR pg_catalog.upper(payment.currency) IS DISTINCT FROM v_order.currency
              OR payment.provider IS DISTINCT FROM 'paypal'
              OR payment.paypal_resource_type IS DISTINCT FROM 'capture'
              OR payment.paypal_payment_id IS NULL
              OR payment.paypal_payment_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
         )::INTEGER
    INTO v_payment_count, v_candidate_count, v_settled_count, v_invalid_payment_count
    FROM public.payments AS payment
   WHERE payment.order_id = v_order.id;

  IF v_invalid_payment_count > 0
     OR v_payment_count <> v_candidate_count
     OR v_settled_count <> v_candidate_count
     OR v_candidate_count > 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: payment capture set requires operator remediation';
  END IF;
  IF v_candidate_count = 1 THEN
    SELECT payment.* INTO v_payment
      FROM public.payments AS payment
     WHERE payment.order_id = v_order.id
       AND payment.status IN ('completed', 'refunded');
  ELSIF v_payment_count <> 0
        OR v_order.amount_cents <> 0
        OR v_order.paypal_order_id IS NOT NULL
        OR NOT COALESCE(v_order.source IN ('manual', 'giveaway', 'automation'), false) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: refundable payment proof is unavailable';
  END IF;

  IF v_payment.id IS NOT NULL THEN
    PERFORM 1 FROM public.payment_refunds AS refund
     WHERE refund.payment_id = v_payment.id ORDER BY refund.id FOR UPDATE;
    SELECT COALESCE(pg_catalog.sum(refund.amount_cents), 0),
           pg_catalog.count(*) FILTER (
             WHERE refund.amount_cents IS NULL OR refund.amount_cents < 0
                OR refund.paypal_refund_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
                OR (
                  refund.event_type IN (
                    'ADMIN.REFUND',
                    'PAYMENT.CAPTURE.REFUNDED',
                    'PAYMENT.SALE.REFUNDED'
                  )
                  AND refund.amount_cents <= 0
                )
                OR (
                  refund.event_type IN (
                    'PAYMENT.CAPTURE.REVERSED',
                    'PAYMENT.SALE.REVERSED'
                  )
                  AND NOT refund.is_terminal_event_witness
                )
                OR refund.currency IS NULL OR pg_catalog.upper(refund.currency) <> v_order.currency
                OR refund.order_id IS DISTINCT FROM v_order.id
                OR refund.guild_id IS DISTINCT FROM v_order.guild_id
                OR refund.paypal_resource_type IS DISTINCT FROM 'capture'
                OR refund.event_type NOT IN ('ADMIN.REFUND', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED')
           )::INTEGER
      INTO v_refunded_cents, v_invalid_refund_count
      FROM public.payment_refunds AS refund
     WHERE refund.payment_id = v_payment.id;
    IF v_invalid_refund_count > 0 OR v_refunded_cents < 0
       OR v_refunded_cents > v_order.amount_cents THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_prepare_admin_refund: refund ledger requires operator remediation';
    END IF;
  END IF;

  -- Refuse to let a delayed completion from a retained terminal attempt become
  -- the baseline for a newer provider request.
  IF EXISTS (
    SELECT 1
      FROM public.commerce_admin_refund_operations AS terminal_attempt
      JOIN public.payment_refunds AS refund
        ON refund.paypal_refund_id = terminal_attempt.paypal_refund_id
       AND refund.payment_id = terminal_attempt.payment_id
     WHERE terminal_attempt.order_id = v_order.id
       AND terminal_attempt.status IN ('failed', 'cancelled')
       AND refund.order_id = terminal_attempt.order_id
       AND refund.guild_id = terminal_attempt.guild_id
       AND refund.amount_cents = terminal_attempt.refund_amount_cents
       AND pg_catalog.upper(refund.currency) = terminal_attempt.currency
       AND refund.paypal_resource_type = 'capture'
       AND refund.event_type IN ('ADMIN.REFUND', 'PAYMENT.CAPTURE.REFUNDED')
       AND refund.is_terminal_event_witness
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: terminal attempt has completed provider evidence; operator reconciliation is required';
  END IF;

  SELECT customer.discord_id
    INTO v_discord_id
    FROM public.customers AS customer
   WHERE customer.id = v_order.customer_id
     AND customer.guild_id = v_order.guild_id
   FOR SHARE;
  IF NOT FOUND OR v_discord_id IS NULL OR pg_catalog.btrim(v_discord_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: access provenance mismatch';
  END IF;
  PERFORM grant_row.id
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.order_id = v_order.id
   ORDER BY grant_row.id
   FOR SHARE;
  IF EXISTS (
    SELECT 1
      FROM public.temp_role_grants AS grant_row
     WHERE grant_row.order_id = v_order.id
       AND grant_row.grant_status IN ('pending', 'applied')
       AND (
         grant_row.guild_id IS DISTINCT FROM v_order.guild_id
         OR grant_row.user_id IS DISTINCT FROM v_discord_id
         OR grant_row.source IS DISTINCT FROM 'commerce_purchase'
         OR grant_row.source_id IS DISTINCT FROM v_order.product_id::TEXT
         OR grant_row.duration_seconds IS NULL
         OR grant_row.duration_seconds <= 0
         OR grant_row.duration_seconds > 315360000
         OR v_order.paypal_subscription_id IS NOT NULL
         OR v_order.plan_id IS NOT NULL
         OR v_order.grant_snapshot_frozen_at IS NULL
         OR NOT public.commerce_valid_temp_role_snapshot(
           v_order.temporary_role_grants_snapshot
         )
         OR NOT EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(
               v_order.temporary_role_grants_snapshot
             ) AS frozen_grant(value)
            WHERE frozen_grant.value ->> 'role_id' = grant_row.role_id
              AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
                = grant_row.duration_seconds
         )
         OR (
           grant_row.grant_status = 'pending'
           AND grant_row.applied_at IS NOT NULL
         )
         OR (
           grant_row.grant_status = 'applied'
           AND (
             grant_row.applied_at IS NULL
             OR grant_row.expires_at IS DISTINCT FROM grant_row.applied_at
               + (grant_row.duration_seconds * interval '1 second')
           )
         )
         OR NOT EXISTS (
           SELECT 1
             FROM public.entitlements AS entitlement
            WHERE entitlement.order_id = v_order.id
              AND entitlement.guild_id = v_order.guild_id
              AND entitlement.customer_id = v_order.customer_id
              AND entitlement.product_id = v_order.product_id
              AND entitlement.type = 'one_time'
              AND entitlement.status IN (
                'active', 'pending', 'grace_period', 'suspended'
              )
              AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
         )
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: access provenance mismatch';
  END IF;
  PERFORM entitlement.id
    FROM public.entitlements AS entitlement
   WHERE entitlement.order_id = v_order.id
      OR EXISTS (
        SELECT 1 FROM public.license_keys AS license_key
         WHERE license_key.id = entitlement.license_key_id
           AND license_key.order_id = v_order.id
      )
   ORDER BY entitlement.id
   FOR SHARE;
  PERFORM license_key.id
    FROM public.license_keys AS license_key
   WHERE license_key.order_id = v_order.id
      OR EXISTS (
        SELECT 1 FROM public.entitlements AS entitlement
         WHERE entitlement.license_key_id = license_key.id
           AND entitlement.order_id = v_order.id
      )
   ORDER BY license_key.id
   FOR SHARE;
  IF EXISTS (
    SELECT 1 FROM public.entitlements AS entitlement
     WHERE entitlement.order_id = v_order.id
       AND (entitlement.guild_id IS DISTINCT FROM v_order.guild_id
         OR entitlement.customer_id IS DISTINCT FROM v_order.customer_id
         OR entitlement.product_id IS DISTINCT FROM v_order.product_id
         OR entitlement.plan_id IS NOT NULL
         OR entitlement.type IS DISTINCT FROM 'one_time'
         OR COALESCE(entitlement.source, 'purchase') IS DISTINCT FROM COALESCE(v_order.source, 'purchase'))
  ) OR EXISTS (
    SELECT 1 FROM public.license_keys AS license_key
     WHERE license_key.order_id = v_order.id
       AND (license_key.guild_id IS DISTINCT FROM v_order.guild_id
         OR license_key.customer_id IS DISTINCT FROM v_order.customer_id
         OR license_key.product_id IS DISTINCT FROM v_order.product_id)
  ) OR EXISTS (
    SELECT 1
      FROM public.entitlements AS entitlement
      JOIN public.license_keys AS license_key
        ON license_key.id = entitlement.license_key_id
     WHERE (entitlement.order_id = v_order.id OR license_key.order_id = v_order.id)
       AND (entitlement.order_id IS DISTINCT FROM v_order.id
         OR license_key.order_id IS DISTINCT FROM v_order.id
         OR entitlement.guild_id IS DISTINCT FROM v_order.guild_id
         OR license_key.guild_id IS DISTINCT FROM v_order.guild_id
         OR entitlement.customer_id IS DISTINCT FROM v_order.customer_id
         OR license_key.customer_id IS DISTINCT FROM v_order.customer_id
         OR entitlement.product_id IS DISTINCT FROM v_order.product_id
         OR license_key.product_id IS DISTINCT FROM v_order.product_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: access provenance mismatch';
  END IF;

  IF v_attempt.attempt_id IS NOT NULL THEN
    IF v_attempt.customer_id IS DISTINCT FROM v_order.customer_id
       OR v_attempt.product_id IS DISTINCT FROM v_order.product_id
       OR v_attempt.payment_id IS DISTINCT FROM v_payment.id
       OR v_attempt.paypal_payment_id IS DISTINCT FROM v_payment.paypal_payment_id
       OR v_attempt.order_amount_cents IS DISTINCT FROM v_order.amount_cents
       OR v_attempt.currency IS DISTINCT FROM v_order.currency THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_prepare_admin_refund: attempt replay identity mismatch';
    END IF;

    IF v_attempt.status = 'completed' THEN
      IF v_order.status IS DISTINCT FROM 'refunded'
         OR (v_attempt.payment_id IS NOT NULL AND (
           v_payment.status IS DISTINCT FROM 'refunded'
           OR v_refunded_cents IS DISTINCT FROM v_order.amount_cents::BIGINT
         )) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce_prepare_admin_refund: completed refund proof mismatch';
      END IF;
      RETURN public.commerce_admin_refund_attempt_json(v_attempt);
    END IF;

    IF v_attempt.paypal_refund_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.payment_refunds AS refund
         WHERE refund.payment_id = v_attempt.payment_id
           AND refund.paypal_refund_id = v_attempt.paypal_refund_id
           AND refund.amount_cents = v_attempt.refund_amount_cents
           AND pg_catalog.upper(refund.currency) = v_attempt.currency
           AND refund.paypal_resource_type = 'capture'
           AND refund.event_type IN ('ADMIN.REFUND', 'PAYMENT.CAPTURE.REFUNDED')
           AND refund.is_terminal_event_witness
      ) INTO v_exact_attempt_refund;
    ELSIF v_attempt.status = 'prepared' AND v_attempt.provider_required THEN
      -- The provider may have accepted the frozen request and delivered its
      -- webhook before this attempt stored the response. Do not guess or bind
      -- that refund id here. Permit only the one exact post-attempt terminal
      -- capture row so the route can replay the same PayPal-Request-Id and use
      -- the provider's idempotent response as the identity oracle.
      SELECT pg_catalog.count(*) = 1
             AND NOT EXISTS (
               SELECT 1 FROM public.payment_refunds AS reversal
                WHERE reversal.payment_id = v_attempt.payment_id
                  AND reversal.event_type IN (
                    'PAYMENT.CAPTURE.REVERSED', 'PAYMENT.SALE.REVERSED'
                  )
             )
        INTO v_unbound_post_attempt_refund
        FROM public.payment_refunds AS refund
       WHERE refund.payment_id = v_attempt.payment_id
         AND refund.order_id = v_attempt.order_id
         AND refund.guild_id = v_attempt.guild_id
         AND refund.event_type = 'PAYMENT.CAPTURE.REFUNDED'
         AND refund.paypal_resource_type = 'capture'
         AND refund.amount_cents = v_attempt.refund_amount_cents
         AND pg_catalog.upper(refund.currency) = v_attempt.currency
         AND refund.is_terminal_event_witness
         AND refund.created_at >= v_attempt.created_at;
      v_unbound_post_attempt_refund :=
        COALESCE(v_unbound_post_attempt_refund, false)
        AND v_refunded_cents = v_attempt.order_amount_cents::BIGINT;
    END IF;

    IF v_refunded_cents IS DISTINCT FROM v_attempt.existing_refunded_cents::BIGINT THEN
      IF v_exact_attempt_refund
         AND v_refunded_cents = v_attempt.order_amount_cents::BIGINT
         AND v_attempt.status IN ('pending', 'provider_completed') THEN
        IF v_attempt.status = 'pending' THEN
          UPDATE public.commerce_admin_refund_operations
             SET status = 'provider_completed', provider_status = 'COMPLETED',
                 updated_at = pg_catalog.clock_timestamp(),
                 provider_outcome_at = pg_catalog.clock_timestamp()
           WHERE attempt_id = v_attempt.attempt_id
          RETURNING * INTO v_attempt;
        END IF;
      ELSIF v_unbound_post_attempt_refund THEN
        NULL;
      ELSE
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce_prepare_admin_refund: attempt ledger is stale; operator reconciliation is required';
      END IF;
    END IF;
    IF v_order.status = 'refunded'
       AND v_attempt.status <> 'provider_completed'
       AND NOT v_unbound_post_attempt_refund THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_prepare_admin_refund: order state advanced without exact attempt evidence';
    END IF;
    RETURN public.commerce_admin_refund_attempt_json(v_attempt);
  END IF;

  IF v_order.status IS DISTINCT FROM 'completed'
     OR (v_payment.id IS NOT NULL AND (
       v_payment.status IS DISTINCT FROM 'completed'
       OR v_refunded_cents >= v_order.amount_cents
     )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_prepare_admin_refund: prior terminal refund lacks a completed admin attempt';
  END IF;

  v_attempt_id := gen_random_uuid();
  INSERT INTO public.commerce_admin_refund_operations (
    attempt_id, request_id, order_id, guild_id, customer_id, product_id, plan_id,
    actor_id, paypal_order_id, payment_id, paypal_payment_id, resource_type,
    order_amount_cents, existing_refunded_cents, refund_amount_cents,
    currency, reason, provider_required
  ) VALUES (
    v_attempt_id, v_attempt_id, v_order.id, v_order.guild_id, v_order.customer_id,
    v_order.product_id, v_order.plan_id, v_actor_id, v_order.paypal_order_id,
    v_payment.id, v_payment.paypal_payment_id,
    CASE WHEN v_payment.id IS NULL THEN NULL ELSE 'capture' END,
    v_order.amount_cents, v_refunded_cents::INTEGER,
    (v_order.amount_cents - v_refunded_cents)::INTEGER,
    v_order.currency, v_reason,
    v_payment.id IS NOT NULL AND v_refunded_cents < v_order.amount_cents
  ) RETURNING * INTO v_attempt;
  RETURN public.commerce_admin_refund_attempt_json(v_attempt);
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_prepare_admin_refund(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_prepare_admin_refund(UUID, TEXT, TEXT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_record_admin_refund_outcome(
  p_attempt_id UUID,
  p_guild_id TEXT,
  p_provider_status TEXT,
  p_paypal_refund_id TEXT,
  p_refund_amount_cents INTEGER,
  p_currency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.commerce_admin_refund_operations%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_status TEXT := pg_catalog.upper(pg_catalog.btrim(p_provider_status));
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_refunded_cents BIGINT := 0;
  v_invalid_refund_count INTEGER := 0;
  v_exact_refund BOOLEAN := false;
BEGIN
  SELECT operation.* INTO v_attempt
    FROM public.commerce_admin_refund_operations AS operation
   WHERE operation.attempt_id = p_attempt_id
     AND operation.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND OR NOT v_attempt.provider_required THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_admin_refund_outcome: provider attempt is required';
  END IF;

  SELECT paid_order.* INTO v_order FROM public.orders AS paid_order
   WHERE paid_order.id = v_attempt.order_id
     AND paid_order.guild_id = v_attempt.guild_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_admin_refund_outcome: order identity mismatch';
  END IF;
  PERFORM 1 FROM public.payments AS payment
   WHERE payment.order_id = v_attempt.order_id ORDER BY payment.id FOR UPDATE;
  PERFORM 1 FROM public.payment_refunds AS refund
   WHERE refund.payment_id = v_attempt.payment_id ORDER BY refund.id FOR UPDATE;

  SELECT COALESCE(pg_catalog.sum(refund.amount_cents), 0),
         pg_catalog.count(*) FILTER (
            WHERE refund.amount_cents IS NULL OR refund.amount_cents < 0
               OR refund.paypal_refund_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
                OR (
                refund.event_type IN (
                  'ADMIN.REFUND',
                  'PAYMENT.CAPTURE.REFUNDED',
                  'PAYMENT.SALE.REFUNDED'
                )
                AND refund.amount_cents <= 0
              )
              OR (
                refund.event_type IN (
                  'PAYMENT.CAPTURE.REVERSED',
                  'PAYMENT.SALE.REVERSED'
                )
                AND NOT refund.is_terminal_event_witness
              )
              OR refund.order_id IS DISTINCT FROM v_attempt.order_id
              OR refund.guild_id IS DISTINCT FROM v_attempt.guild_id
              OR refund.currency IS NULL OR pg_catalog.upper(refund.currency) <> v_attempt.currency
              OR refund.paypal_resource_type IS DISTINCT FROM 'capture'
         )::INTEGER
    INTO v_refunded_cents, v_invalid_refund_count
    FROM public.payment_refunds AS refund
   WHERE refund.payment_id = v_attempt.payment_id;
  IF v_invalid_refund_count > 0 OR v_refunded_cents > v_attempt.order_amount_cents THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_admin_refund_outcome: refund ledger requires operator remediation';
  END IF;

  IF p_paypal_refund_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.payment_refunds AS refund
       WHERE refund.payment_id = v_attempt.payment_id
         AND refund.paypal_refund_id = p_paypal_refund_id
         AND refund.amount_cents = v_attempt.refund_amount_cents
         AND pg_catalog.upper(refund.currency) = v_attempt.currency
         AND refund.paypal_resource_type = 'capture'
         AND refund.event_type IN ('ADMIN.REFUND', 'PAYMENT.CAPTURE.REFUNDED')
         AND refund.is_terminal_event_witness
    ) INTO v_exact_refund;
  END IF;

  IF v_status NOT IN ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_admin_refund_outcome: provider status is unsupported';
  END IF;

  -- A terminal row is an authoritative monotonic successor.  An exact retry,
  -- or a delayed PENDING observation for the same attempt, returns that row;
  -- it never reopens or mutates the retained attempt.
  IF v_attempt.status IN ('failed', 'cancelled', 'completed') THEN
    IF v_attempt.status = 'completed' THEN
      IF v_status NOT IN ('PENDING', 'COMPLETED')
         OR p_paypal_refund_id IS DISTINCT FROM v_attempt.paypal_refund_id
         OR p_refund_amount_cents IS DISTINCT FROM v_attempt.refund_amount_cents
         OR p_currency IS DISTINCT FROM v_attempt.currency THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce_record_admin_refund_outcome: terminal outcome replay mismatch';
      END IF;
    ELSIF v_status NOT IN (
      'PENDING', CASE v_attempt.status WHEN 'failed' THEN 'FAILED' ELSE 'CANCELLED' END
    ) OR NOT (
      (
        v_attempt.paypal_refund_id IS NULL
        AND (
          (
            v_status = CASE v_attempt.status WHEN 'failed' THEN 'FAILED' ELSE 'CANCELLED' END
            AND p_paypal_refund_id IS NULL
            AND p_refund_amount_cents IS NULL
            AND p_currency IS NULL
          )
          OR (
            v_status = 'PENDING'
            AND p_paypal_refund_id IS NOT NULL
            AND p_paypal_refund_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
            AND p_refund_amount_cents = v_attempt.refund_amount_cents
            AND p_currency = v_attempt.currency
          )
        )
      )
      OR (
        v_attempt.paypal_refund_id IS NOT NULL
        AND p_paypal_refund_id = v_attempt.paypal_refund_id
        AND p_refund_amount_cents = v_attempt.refund_amount_cents
        AND p_currency = v_attempt.currency
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_record_admin_refund_outcome: terminal outcome replay mismatch';
    END IF;
    RETURN public.commerce_admin_refund_attempt_json(v_attempt);
  END IF;
  IF v_status IN ('PENDING', 'COMPLETED') AND (
    p_paypal_refund_id IS NULL
    OR p_paypal_refund_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
    OR p_refund_amount_cents IS DISTINCT FROM v_attempt.refund_amount_cents
    OR p_currency IS DISTINCT FROM v_attempt.currency
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_admin_refund_outcome: provider result mismatch';
  END IF;
  IF v_attempt.paypal_refund_id IS NOT NULL
     AND p_paypal_refund_id IS DISTINCT FROM v_attempt.paypal_refund_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_admin_refund_outcome: provider identity mismatch';
  END IF;
  IF p_refund_amount_cents IS NOT NULL
     AND p_refund_amount_cents IS DISTINCT FROM v_attempt.refund_amount_cents THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_admin_refund_outcome: provider amount mismatch';
  END IF;
  IF p_currency IS NOT NULL AND p_currency IS DISTINCT FROM v_attempt.currency THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_admin_refund_outcome: provider currency mismatch';
  END IF;
  IF v_status IN ('FAILED', 'CANCELLED') THEN
    IF v_attempt.status = 'pending' AND (
      p_paypal_refund_id IS DISTINCT FROM v_attempt.paypal_refund_id
      OR p_refund_amount_cents IS DISTINCT FROM v_attempt.provider_reported_amount_cents
      OR p_currency IS DISTINCT FROM v_attempt.provider_reported_currency
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_record_admin_refund_outcome: pending attempt terminal result mismatch';
    ELSIF v_attempt.status = 'prepared' AND NOT (
      (p_paypal_refund_id IS NULL AND p_refund_amount_cents IS NULL AND p_currency IS NULL)
      OR (
        p_paypal_refund_id IS NOT NULL
        AND p_paypal_refund_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
        AND p_refund_amount_cents = v_attempt.refund_amount_cents
        AND p_currency = v_attempt.currency
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_record_admin_refund_outcome: terminal provider result is incomplete';
    END IF;
  END IF;

  IF v_refunded_cents IS DISTINCT FROM v_attempt.existing_refunded_cents::BIGINT
     AND NOT (
       v_exact_refund
       AND v_refunded_cents = v_attempt.order_amount_cents::BIGINT
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_admin_refund_outcome: ledger advanced for a different attempt';
  END IF;
  IF v_status IN ('FAILED', 'CANCELLED')
     AND v_refunded_cents IS DISTINCT FROM v_attempt.existing_refunded_cents::BIGINT THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_admin_refund_outcome: terminal failure conflicts with refund evidence';
  END IF;

  IF v_attempt.status = 'provider_completed' THEN
    IF v_status IN ('PENDING', 'COMPLETED')
       AND p_paypal_refund_id = v_attempt.paypal_refund_id THEN
      RETURN public.commerce_admin_refund_attempt_json(v_attempt);
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_record_admin_refund_outcome: completed provider outcome cannot be downgraded';
  END IF;

  IF v_attempt.status = 'pending' AND v_status = 'PENDING' AND NOT v_exact_refund THEN
    RETURN public.commerce_admin_refund_attempt_json(v_attempt);
  END IF;

  UPDATE public.commerce_admin_refund_operations
     SET status = CASE
           WHEN v_exact_refund OR v_status = 'COMPLETED' THEN 'provider_completed'
           WHEN v_status = 'PENDING' THEN 'pending'
           WHEN v_status = 'FAILED' THEN 'failed'
           ELSE 'cancelled'
         END,
         provider_status = CASE WHEN v_exact_refund THEN 'COMPLETED' ELSE v_status END,
         paypal_refund_id = p_paypal_refund_id,
         provider_reported_amount_cents = p_refund_amount_cents,
         provider_reported_currency = p_currency,
         provider_outcome_at = v_now,
         updated_at = v_now
   WHERE attempt_id = v_attempt.attempt_id
  RETURNING * INTO v_attempt;
  RETURN public.commerce_admin_refund_attempt_json(v_attempt);
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_record_admin_refund_outcome(
  UUID, TEXT, TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_record_admin_refund_outcome(
  UUID, TEXT, TEXT, TEXT, INTEGER, TEXT
) TO service_role;

DROP FUNCTION IF EXISTS public.commerce_finalize_admin_refund(UUID, TEXT, TEXT, INTEGER, TEXT);
CREATE OR REPLACE FUNCTION public.commerce_finalize_admin_refund(
  p_attempt_id UUID,
  p_guild_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.commerce_admin_refund_operations%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_recorded_refund public.payment_refunds%ROWTYPE;
  v_discord_id TEXT;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_payment_count INTEGER := 0;
  v_settled_count INTEGER := 0;
  v_invalid_payment_count INTEGER := 0;
  v_refunded_cents BIGINT := 0;
  v_invalid_refund_count INTEGER := 0;
  v_exact_refund BOOLEAN := false;
  v_entitlement_ids UUID[] := '{}'::UUID[];
  v_license_key_ids UUID[] := '{}'::UUID[];
  v_entitlements_changed INTEGER := 0;
  v_licenses_changed INTEGER := 0;
  v_sessions_changed INTEGER := 0;
  v_rows_changed INTEGER := 0;
BEGIN
  SELECT operation.* INTO v_attempt
    FROM public.commerce_admin_refund_operations AS operation
   WHERE operation.attempt_id = p_attempt_id
     AND operation.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_admin_refund: prepared attempt is required';
  END IF;

  SELECT paid_order.* INTO v_order FROM public.orders AS paid_order
   WHERE paid_order.id = v_attempt.order_id
     AND paid_order.guild_id = v_attempt.guild_id
     AND paid_order.customer_id = v_attempt.customer_id
     AND paid_order.product_id = v_attempt.product_id
   FOR UPDATE;
  IF NOT FOUND OR v_order.plan_id IS DISTINCT FROM v_attempt.plan_id
     OR v_order.amount_cents IS DISTINCT FROM v_attempt.order_amount_cents
     OR v_order.currency IS DISTINCT FROM v_attempt.currency
     OR v_order.paypal_order_id IS DISTINCT FROM v_attempt.paypal_order_id
     OR v_order.paypal_subscription_id IS NOT NULL
     OR v_order.status NOT IN ('completed', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_admin_refund: order identity mismatch';
  END IF;

  PERFORM 1 FROM public.payments AS payment
   WHERE payment.order_id = v_order.id ORDER BY payment.id FOR UPDATE;
  SELECT pg_catalog.count(*)::INTEGER,
         pg_catalog.count(*) FILTER (
           WHERE payment.status IN ('completed', 'refunded', 'reversed')
         )::INTEGER,
         pg_catalog.count(*) FILTER (
           WHERE payment.customer_id IS DISTINCT FROM v_order.customer_id
              OR payment.guild_id IS DISTINCT FROM v_order.guild_id
              OR payment.amount_cents IS NULL
              OR payment.amount_cents <= 0
              OR payment.amount_cents IS DISTINCT FROM v_order.amount_cents
              OR payment.currency IS NULL
              OR payment.currency <> pg_catalog.btrim(payment.currency)
              OR pg_catalog.upper(payment.currency) !~ '^[A-Z]{3}$'
              OR pg_catalog.upper(payment.currency) IS DISTINCT FROM v_order.currency
              OR payment.provider IS DISTINCT FROM 'paypal'
              OR payment.paypal_resource_type IS DISTINCT FROM 'capture'
              OR payment.paypal_payment_id IS NULL
              OR payment.paypal_payment_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
          )::INTEGER
    INTO v_payment_count, v_settled_count, v_invalid_payment_count
    FROM public.payments AS payment
   WHERE payment.order_id = v_order.id;
  IF v_invalid_payment_count > 0
     OR (v_attempt.payment_id IS NULL AND v_payment_count <> 0)
     OR (
       v_attempt.payment_id IS NOT NULL
       AND (v_payment_count <> 1 OR v_settled_count <> 1)
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_admin_refund: payment capture set changed';
  END IF;

  IF v_attempt.payment_id IS NOT NULL THEN
    SELECT payment.* INTO v_payment FROM public.payments AS payment
     WHERE payment.id = v_attempt.payment_id
       AND payment.order_id = v_order.id
       AND payment.paypal_payment_id = v_attempt.paypal_payment_id
       AND payment.paypal_resource_type = 'capture'
       AND payment.status IN ('completed', 'refunded')
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finalize_admin_refund: selected capture identity mismatch';
    END IF;
    PERFORM 1 FROM public.payment_refunds AS refund
     WHERE refund.payment_id = v_payment.id ORDER BY refund.id FOR UPDATE;
    SELECT COALESCE(pg_catalog.sum(refund.amount_cents), 0),
           pg_catalog.count(*) FILTER (
             WHERE refund.amount_cents IS NULL OR refund.amount_cents < 0
                OR (
                  refund.event_type IN (
                    'ADMIN.REFUND',
                    'PAYMENT.CAPTURE.REFUNDED',
                    'PAYMENT.SALE.REFUNDED'
                  )
                  AND refund.amount_cents <= 0
                )
                OR (
                  refund.event_type IN (
                    'PAYMENT.CAPTURE.REVERSED',
                    'PAYMENT.SALE.REVERSED'
                  )
                  AND NOT refund.is_terminal_event_witness
                )
              OR refund.order_id IS DISTINCT FROM v_order.id
              OR refund.guild_id IS DISTINCT FROM v_order.guild_id
              OR refund.currency IS NULL OR pg_catalog.upper(refund.currency) <> v_attempt.currency
              OR refund.paypal_refund_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
              OR refund.paypal_resource_type IS DISTINCT FROM 'capture'
                OR refund.event_type NOT IN ('ADMIN.REFUND', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED')
           )::INTEGER
      INTO v_refunded_cents, v_invalid_refund_count
      FROM public.payment_refunds AS refund
     WHERE refund.payment_id = v_payment.id;
    SELECT EXISTS (
      SELECT 1 FROM public.payment_refunds AS refund
       WHERE refund.payment_id = v_payment.id
         AND refund.paypal_refund_id = v_attempt.paypal_refund_id
          AND refund.amount_cents = v_attempt.refund_amount_cents
          AND pg_catalog.upper(refund.currency) = v_attempt.currency
          AND refund.paypal_resource_type = 'capture'
          AND refund.event_type IN ('ADMIN.REFUND', 'PAYMENT.CAPTURE.REFUNDED')
          AND refund.is_terminal_event_witness
    ) INTO v_exact_refund;
    IF v_invalid_refund_count > 0 OR v_refunded_cents > v_attempt.order_amount_cents THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finalize_admin_refund: refund ledger requires operator remediation';
    END IF;
  END IF;

  SELECT customer.discord_id
    INTO v_discord_id
    FROM public.customers AS customer
   WHERE customer.id = v_order.customer_id
     AND customer.guild_id = v_order.guild_id
   FOR SHARE;
  IF NOT FOUND OR v_discord_id IS NULL OR pg_catalog.btrim(v_discord_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_admin_refund: access provenance mismatch';
  END IF;
  PERFORM grant_row.id
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.order_id = v_order.id
   ORDER BY grant_row.id
   FOR UPDATE;
  IF EXISTS (
    SELECT 1
      FROM public.temp_role_grants AS grant_row
     WHERE grant_row.order_id = v_order.id
       AND grant_row.grant_status IN ('pending', 'applied')
       AND (
         grant_row.guild_id IS DISTINCT FROM v_order.guild_id
         OR grant_row.user_id IS DISTINCT FROM v_discord_id
         OR grant_row.source IS DISTINCT FROM 'commerce_purchase'
         OR grant_row.source_id IS DISTINCT FROM v_order.product_id::TEXT
         OR grant_row.duration_seconds IS NULL
         OR grant_row.duration_seconds <= 0
         OR grant_row.duration_seconds > 315360000
         OR v_order.paypal_subscription_id IS NOT NULL
         OR v_order.plan_id IS NOT NULL
         OR v_order.grant_snapshot_frozen_at IS NULL
         OR NOT public.commerce_valid_temp_role_snapshot(
           v_order.temporary_role_grants_snapshot
         )
         OR NOT EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(
               v_order.temporary_role_grants_snapshot
             ) AS frozen_grant(value)
            WHERE frozen_grant.value ->> 'role_id' = grant_row.role_id
              AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
                = grant_row.duration_seconds
         )
         OR (
           grant_row.grant_status = 'pending'
           AND grant_row.applied_at IS NOT NULL
         )
         OR (
           grant_row.grant_status = 'applied'
           AND (
             grant_row.applied_at IS NULL
             OR grant_row.expires_at IS DISTINCT FROM grant_row.applied_at
               + (grant_row.duration_seconds * interval '1 second')
           )
         )
         OR NOT EXISTS (
           SELECT 1
             FROM public.entitlements AS entitlement
            WHERE entitlement.order_id = v_order.id
              AND entitlement.guild_id = v_order.guild_id
              AND entitlement.customer_id = v_order.customer_id
              AND entitlement.product_id = v_order.product_id
              AND entitlement.type = 'one_time'
              AND entitlement.status IN (
                'active', 'pending', 'grace_period', 'suspended'
              )
              AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
         )
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_admin_refund: access provenance mismatch';
  END IF;
  PERFORM entitlement.id
    FROM public.entitlements AS entitlement
   WHERE entitlement.order_id = v_order.id
      OR EXISTS (
        SELECT 1 FROM public.license_keys AS license_key
         WHERE license_key.id = entitlement.license_key_id
           AND license_key.order_id = v_order.id
      )
   ORDER BY entitlement.id
   FOR UPDATE;
  PERFORM license_key.id
    FROM public.license_keys AS license_key
   WHERE license_key.order_id = v_order.id
      OR EXISTS (
        SELECT 1 FROM public.entitlements AS entitlement
         WHERE entitlement.license_key_id = license_key.id
           AND entitlement.order_id = v_order.id
      )
   ORDER BY license_key.id
   FOR UPDATE;
  PERFORM session.id FROM public.license_sessions AS session
    JOIN public.license_keys AS license_key ON license_key.id = session.license_key_id
   WHERE license_key.order_id = v_order.id
      OR EXISTS (
        SELECT 1 FROM public.entitlements AS entitlement
         WHERE entitlement.license_key_id = license_key.id
           AND entitlement.order_id = v_order.id
      )
   ORDER BY session.id
   FOR UPDATE OF session;

  IF EXISTS (
    SELECT 1 FROM public.entitlements AS entitlement
     WHERE entitlement.order_id = v_order.id
       AND (entitlement.guild_id IS DISTINCT FROM v_order.guild_id
         OR entitlement.customer_id IS DISTINCT FROM v_order.customer_id
         OR entitlement.product_id IS DISTINCT FROM v_order.product_id
         OR entitlement.plan_id IS NOT NULL OR entitlement.type IS DISTINCT FROM 'one_time'
         OR COALESCE(entitlement.source, 'purchase') IS DISTINCT FROM COALESCE(v_order.source, 'purchase'))
  ) OR EXISTS (
    SELECT 1 FROM public.license_keys AS key WHERE key.order_id = v_order.id
      AND (key.guild_id IS DISTINCT FROM v_order.guild_id
        OR key.customer_id IS DISTINCT FROM v_order.customer_id
        OR key.product_id IS DISTINCT FROM v_order.product_id)
  ) OR EXISTS (
    SELECT 1
      FROM public.entitlements AS entitlement
      JOIN public.license_keys AS license_key
        ON license_key.id = entitlement.license_key_id
     WHERE (entitlement.order_id = v_order.id OR license_key.order_id = v_order.id)
       AND (entitlement.order_id IS DISTINCT FROM v_order.id
         OR license_key.order_id IS DISTINCT FROM v_order.id
         OR entitlement.guild_id IS DISTINCT FROM v_order.guild_id
         OR license_key.guild_id IS DISTINCT FROM v_order.guild_id
         OR entitlement.customer_id IS DISTINCT FROM v_order.customer_id
         OR license_key.customer_id IS DISTINCT FROM v_order.customer_id
         OR entitlement.product_id IS DISTINCT FROM v_order.product_id
         OR license_key.product_id IS DISTINCT FROM v_order.product_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_admin_refund: access provenance mismatch';
  END IF;

  IF v_attempt.status = 'completed' THEN
    IF v_order.status IS DISTINCT FROM 'refunded'
       OR (v_attempt.payment_id IS NOT NULL AND (
         v_payment.status IS DISTINCT FROM 'refunded'
         OR v_refunded_cents IS DISTINCT FROM v_attempt.order_amount_cents::BIGINT
         OR NOT v_exact_refund
       ))
       OR EXISTS (SELECT 1 FROM public.entitlements AS entitlement
         WHERE entitlement.order_id = v_order.id
           AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended'))
       OR EXISTS (SELECT 1 FROM public.license_keys AS key
         WHERE key.order_id = v_order.id AND key.status <> 'revoked')
       OR EXISTS (SELECT 1 FROM public.license_sessions AS session
         JOIN public.license_keys AS key ON key.id = session.license_key_id
         WHERE key.order_id = v_order.id AND session.active = true) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finalize_admin_refund: completed state proof mismatch';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'order_id', v_order.id, 'attempt_id', v_attempt.attempt_id,
      'status', 'completed', 'order_status', 'refunded', 'already_refunded', true,
      'entitlements_changed', 0, 'licenses_changed', 0, 'sessions_changed', 0,
      'paypal_refund_id', v_attempt.paypal_refund_id
    );
  END IF;

  IF v_attempt.provider_required THEN
    IF v_attempt.status IS DISTINCT FROM 'provider_completed'
       OR v_attempt.provider_status IS DISTINCT FROM 'COMPLETED'
       OR v_attempt.paypal_refund_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finalize_admin_refund: completed provider outcome is required';
    END IF;
    IF v_refunded_cents IS DISTINCT FROM v_attempt.existing_refunded_cents::BIGINT
       AND NOT (v_exact_refund AND v_refunded_cents = v_attempt.order_amount_cents::BIGINT) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finalize_admin_refund: ledger advanced for a different attempt';
    END IF;
    IF NOT v_exact_refund THEN
      INSERT INTO public.payment_refunds (
        payment_id, order_id, guild_id, paypal_refund_id,
        event_type, amount_cents, currency
      ) VALUES (
        v_payment.id, v_order.id, v_order.guild_id, v_attempt.paypal_refund_id,
        'ADMIN.REFUND', v_attempt.refund_amount_cents, v_attempt.currency
      ) ON CONFLICT (paypal_refund_id) DO NOTHING;
      SELECT recorded.* INTO v_recorded_refund FROM public.payment_refunds AS recorded
       WHERE recorded.paypal_refund_id = v_attempt.paypal_refund_id;
      IF NOT FOUND OR v_recorded_refund.payment_id IS DISTINCT FROM v_payment.id
         OR v_recorded_refund.order_id IS DISTINCT FROM v_order.id
         OR v_recorded_refund.guild_id IS DISTINCT FROM v_order.guild_id
         OR v_recorded_refund.amount_cents IS DISTINCT FROM v_attempt.refund_amount_cents
         OR pg_catalog.upper(v_recorded_refund.currency) IS DISTINCT FROM v_attempt.currency
         OR v_recorded_refund.paypal_resource_type IS DISTINCT FROM 'capture'
         OR v_recorded_refund.event_type NOT IN (
           'ADMIN.REFUND', 'PAYMENT.CAPTURE.REFUNDED'
         )
         OR NOT v_recorded_refund.is_terminal_event_witness THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'commerce_finalize_admin_refund: provider refund identity mismatch';
      END IF;
    END IF;
    SELECT COALESCE(pg_catalog.sum(refund.amount_cents), 0) INTO v_refunded_cents
      FROM public.payment_refunds AS refund WHERE refund.payment_id = v_payment.id;
    IF v_refunded_cents IS DISTINCT FROM v_attempt.order_amount_cents::BIGINT THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_finalize_admin_refund: full durable refund proof is incomplete';
    END IF;
  ELSIF v_attempt.status IS DISTINCT FROM 'prepared'
        OR v_attempt.payment_id IS NOT NULL OR v_attempt.order_amount_cents <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_finalize_admin_refund: local reversal contract mismatch';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(entitlement.id ORDER BY entitlement.id), '{}'::UUID[])
    INTO v_entitlement_ids FROM public.entitlements AS entitlement
   WHERE entitlement.order_id = v_order.id
     AND entitlement.guild_id = v_order.guild_id
     AND entitlement.customer_id = v_order.customer_id
     AND entitlement.product_id = v_order.product_id;
  UPDATE public.entitlements AS entitlement
     SET status = 'expired', cancelled_at = COALESCE(entitlement.cancelled_at, v_now), updated_at = v_now
   WHERE entitlement.id = ANY(v_entitlement_ids)
     AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended');
  GET DIAGNOSTICS v_entitlements_changed = ROW_COUNT;

  -- granted_role_ids is desired-access metadata, not proof that Somnibot added
  -- a role which did not predate the entitlement. Exact role-delivery intents
  -- created by the delivery protocol were terminal-signalled by the status
  -- update above. A historical/manual entitlement without such an intent must
  -- remain an operator-visible exception on every refund path: a completed
  -- provider refund proves money moved, not that Somnibot owns the Discord
  -- role. Manufacturing a broad revoke_roles row here could strip a member's
  -- independent baseline role.
  INSERT INTO public.alerts (
    guild_id, alert_type, severity, title, message, metadata, resolved
  )
  SELECT entitlement.guild_id,
         'commerce_role_cleanup_unproven',
         'critical',
         'Role cleanup ownership is unproven',
         'A refund revoked this access, but no exact role-delivery intent proves which Discord roles Somnibot owns.',
         pg_catalog.jsonb_build_object(
           'entitlement_id', entitlement.id,
           'customer_id', entitlement.customer_id,
           'order_id', entitlement.order_id,
           'product_id', entitlement.product_id,
           'next_step', 'inspect_member_baseline_and_resolve_manually'
         ),
         false
    FROM public.entitlements AS entitlement
   WHERE entitlement.id = ANY(v_entitlement_ids)
     AND pg_catalog.cardinality(
           COALESCE(entitlement.granted_role_ids, '{}'::TEXT[])
         ) > 0
     AND NOT EXISTS (
       SELECT 1
         FROM public.commerce_role_delivery_intents AS intent
        WHERE intent.entitlement_id = entitlement.id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.alerts AS alert
        WHERE alert.guild_id = entitlement.guild_id
          AND alert.alert_type = 'commerce_role_cleanup_unproven'
          AND alert.resolved = false
          AND alert.metadata ->> 'entitlement_id' = entitlement.id::TEXT
     );

  UPDATE public.alerts AS alert
     SET resolved = true, resolved_at = COALESCE(alert.resolved_at, v_now), updated_at = v_now
   WHERE alert.guild_id = v_order.guild_id
     AND alert.alert_type = 'entitlement_grace_period' AND alert.resolved = false
     AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_entitlement_ids) AS id(value)
       WHERE id.value::TEXT = alert.metadata ->> 'entitlement_id');

  IF v_payment.id IS NOT NULL THEN
    UPDATE public.alerts AS alert
       SET resolved = true,
           resolved_at = COALESCE(alert.resolved_at, v_now),
           updated_at = v_now
     WHERE alert.guild_id = v_order.guild_id
       AND alert.alert_type = 'partial_refund_review'
       AND alert.resolved = false
       AND alert.metadata ->> 'order_id' = v_order.id::TEXT
       AND alert.metadata ->> 'payment_id' = v_payment.id::TEXT;
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(key.id ORDER BY key.id), '{}'::UUID[])
    INTO v_license_key_ids FROM public.license_keys AS key
   WHERE key.order_id = v_order.id AND key.guild_id = v_order.guild_id
     AND key.customer_id = v_order.customer_id AND key.product_id = v_order.product_id;
  UPDATE public.license_sessions AS session
     SET active = false, deactivated_at = COALESCE(session.deactivated_at, v_now),
         deactivation_reason = 'entitlement_revoked'
   WHERE session.license_key_id = ANY(v_license_key_ids) AND session.active = true;
  GET DIAGNOSTICS v_sessions_changed = ROW_COUNT;
  UPDATE public.license_keys AS key
     SET status = 'revoked', revoked_at = COALESCE(key.revoked_at, v_now),
         revocation_reason = 'refund', updated_at = v_now
   WHERE key.id = ANY(v_license_key_ids) AND key.status <> 'revoked';
  GET DIAGNOSTICS v_licenses_changed = ROW_COUNT;

  IF v_order.status = 'completed' THEN
    UPDATE public.orders SET status = 'refunded', updated_at = v_now
     WHERE id = v_order.id AND status = 'completed';
    GET DIAGNOSTICS v_rows_changed = ROW_COUNT;
    IF v_rows_changed <> 1 THEN
      RAISE EXCEPTION 'commerce_finalize_admin_refund: order transition race detected';
    END IF;
  END IF;
  IF v_attempt.payment_id IS NOT NULL AND v_payment.status = 'completed' THEN
    UPDATE public.payments SET status = 'refunded'
     WHERE id = v_payment.id AND status = 'completed'
       AND paypal_resource_type = 'capture';
    GET DIAGNOSTICS v_rows_changed = ROW_COUNT;
    IF v_rows_changed <> 1 THEN
      RAISE EXCEPTION 'commerce_finalize_admin_refund: payment transition race detected';
    END IF;
  END IF;

  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, target_type, target_id, details
  ) VALUES (
    v_order.guild_id, 'user', v_attempt.actor_id, 'order.refunded', 'order', v_order.id::TEXT,
    pg_catalog.jsonb_build_object(
      'source', 'commerce_finalize_admin_refund', 'attempt_id', v_attempt.attempt_id,
      'request_id', v_attempt.request_id, 'reason', v_attempt.reason,
      'actor_id', v_attempt.actor_id, 'product_id', v_attempt.product_id,
      'plan_id', v_attempt.plan_id, 'resource_type', v_attempt.resource_type,
      'order_amount_cents', v_attempt.order_amount_cents,
      'existing_refunded_cents', v_attempt.existing_refunded_cents,
      'refund_amount_cents', v_attempt.refund_amount_cents,
      'cumulative_refunded_cents', v_refunded_cents,
      'paypal_order_id', v_attempt.paypal_order_id,
      'paypal_payment_id', v_attempt.paypal_payment_id,
      'paypal_refund_id', v_attempt.paypal_refund_id,
      'provider_status', v_attempt.provider_status
    )
  );

  UPDATE public.commerce_admin_refund_operations
     SET status = 'completed', completed_at = v_now, updated_at = v_now
   WHERE attempt_id = v_attempt.attempt_id
     AND status = CASE WHEN v_attempt.provider_required THEN 'provider_completed' ELSE 'prepared' END
  RETURNING * INTO v_attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_finalize_admin_refund: attempt transition race detected';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order_id', v_order.id, 'attempt_id', v_attempt.attempt_id,
    'status', 'completed', 'order_status', 'refunded', 'already_refunded', false,
    'entitlements_changed', v_entitlements_changed,
    'licenses_changed', v_licenses_changed, 'sessions_changed', v_sessions_changed,
    'paypal_refund_id', v_attempt.paypal_refund_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_finalize_admin_refund(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_finalize_admin_refund(UUID, TEXT)
  TO service_role;

-- Prepare or replay one temporary-role provenance row.  The exact paid order,
-- buyer, product, and guild must agree before any row is returned to the bot.
CREATE OR REPLACE FUNCTION public.commerce_prepare_temp_role_grant(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_role_id TEXT,
  p_order_id UUID,
  p_product_id UUID,
  p_duration_seconds INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_grant public.temp_role_grants%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_observed_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_discord_id TEXT;
  v_intent_count INTEGER := 0;
  v_contract_state TEXT;
  v_prepared_at TIMESTAMPTZ;
BEGIN
  IF p_duration_seconds IS NULL OR p_duration_seconds <= 0 THEN
    RAISE EXCEPTION 'commerce_prepare_temp_role_grant: duration must be positive';
  END IF;
  IF p_duration_seconds > 315360000 THEN
    RAISE EXCEPTION 'commerce_prepare_temp_role_grant: duration exceeds ten years';
  END IF;
  IF p_role_id IS NULL OR p_role_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION 'commerce_prepare_temp_role_grant: role must be a Discord snowflake';
  END IF;
  IF p_order_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'commerce_prepare_temp_role_grant: order and product are required';
  END IF;
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'commerce_prepare_temp_role_grant: guild is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'commerce_prepare_temp_role_grant: user is required';
  END IF;

  -- Share the collection RPC's lock namespace.  Once this transaction commits,
  -- no concurrent collection can observe the Discord role without its paid
  -- provenance; a collection that acquired the lock first completes before
  -- the paid grant starts.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'economy-role-income:' || p_guild_id || ':' || p_user_id,
      0
    )
  );

  -- Every temp-role mutator takes the parent before the grant row. Refunds use
  -- the same order -> temp-grant order, so acknowledgement/retirement cannot
  -- form the old temp-grant -> order cycle. The parent lock also fences a new
  -- grant insert after a refund has begun.
  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = p_order_id
     AND paid_order.guild_id = p_guild_id
     AND paid_order.product_id = p_product_id
   FOR SHARE;
  IF NOT FOUND
     OR v_order.status IS DISTINCT FROM 'completed'
     OR v_order.amount_cents IS NULL OR v_order.amount_cents <= 0
     OR v_order.paypal_subscription_id IS NOT NULL
     OR v_order.grant_snapshot_frozen_at IS NULL
     OR NOT public.commerce_valid_temp_role_snapshot(
       v_order.temporary_role_grants_snapshot
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(
           v_order.temporary_role_grants_snapshot
         ) AS frozen_grant(value)
        WHERE frozen_grant.value ->> 'role_id' = p_role_id
          AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
            = p_duration_seconds
     )
     OR NOT COALESCE((
       v_order.source = 'purchase'
       OR (
         v_order.source IS NULL
         AND EXISTS (
           SELECT 1
             FROM public.payments AS payment
            WHERE payment.order_id = v_order.id
              AND payment.customer_id = v_order.customer_id
              AND payment.guild_id = v_order.guild_id
              AND payment.amount_cents = v_order.amount_cents
              AND payment.currency IS NOT NULL
              AND payment.currency = pg_catalog.btrim(payment.currency)
              AND pg_catalog.upper(payment.currency) ~ '^[A-Z]{3}$'
              AND pg_catalog.upper(payment.currency) = v_order.currency
              AND payment.provider = 'paypal'
              AND payment.paypal_resource_type IS NOT DISTINCT FROM 'capture'
              AND payment.status = 'completed'
              AND payment.paypal_payment_id
                ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
         )
       )
     ), false) THEN
    RAISE EXCEPTION 'commerce_prepare_temp_role_grant: paid order identity mismatch';
  END IF;

  SELECT customer.discord_id
    INTO v_discord_id
    FROM public.customers AS customer
   WHERE customer.id = v_order.customer_id
     AND customer.guild_id = v_order.guild_id
   FOR SHARE;
  IF NOT FOUND OR v_discord_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'commerce_prepare_temp_role_grant: paid order identity mismatch';
  END IF;

  PERFORM grant_row.id
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.order_id = v_order.id
     AND grant_row.role_id = p_role_id
   ORDER BY grant_row.id
   FOR UPDATE;

  PERFORM entitlement.id
    FROM public.entitlements AS entitlement
   WHERE entitlement.order_id = v_order.id
     AND entitlement.guild_id = v_order.guild_id
     AND entitlement.customer_id = v_order.customer_id
     AND entitlement.product_id = v_order.product_id
     AND entitlement.type = 'one_time'
     AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
     AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
   ORDER BY entitlement.id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_prepare_temp_role_grant: paid order identity mismatch';
  END IF;

  v_prepared_at := pg_catalog.clock_timestamp();

  INSERT INTO public.temp_role_grants AS existing (
    guild_id,
    user_id,
    role_id,
    expires_at,
    source,
    source_id,
    order_id,
    duration_seconds,
    grant_status,
    attempts,
    updated_at
  ) VALUES (
    p_guild_id,
    p_user_id,
    p_role_id,
    v_prepared_at + (p_duration_seconds * interval '1 second'),
    'commerce_purchase',
    p_product_id::TEXT,
    p_order_id,
    p_duration_seconds,
    'pending',
    1,
    v_prepared_at
  )
  ON CONFLICT (order_id, role_id) WHERE order_id IS NOT NULL
  DO UPDATE SET
    attempts = existing.attempts + 1,
    updated_at = v_prepared_at
  WHERE existing.guild_id = EXCLUDED.guild_id
    AND existing.user_id = EXCLUDED.user_id
    AND existing.source_id = EXCLUDED.source_id
    AND existing.duration_seconds = EXCLUDED.duration_seconds
    AND (
      (
        existing.grant_status IN ('pending', 'applied')
        AND existing.source = 'commerce_purchase'
      )
      OR (
        existing.grant_status = 'removed'
        AND existing.source = 'commerce_reconciled'
      )
    )
  RETURNING * INTO v_grant;

  IF v_grant.id IS NULL THEN
    RAISE EXCEPTION 'commerce_prepare_temp_role_grant: idempotency identity mismatch';
  END IF;

  RETURN jsonb_build_object(
    'id', v_grant.id,
    'grant_status', v_grant.grant_status,
    'remove_on_expiry', v_grant.remove_on_expiry,
    'expires_at', v_grant.expires_at
  );
END;
$$;

-- Resolve one authoritative live temporary-role owner. Order-backed commerce
-- rows are live only while their exact paid parent order remains completed;
-- terminal/refunded/cancelled parents must never retain or resurrect access.
-- Legacy/non-commerce rows have no parent order and keep their historical
-- applied-until-expires behavior. The optional order exclusion prevents a
-- revocation action from treating the order being revoked as its own owner.
CREATE OR REPLACE FUNCTION public.commerce_find_live_temp_role_owner(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_role_id TEXT,
  p_exclude_grant_ids UUID[],
  p_exclude_order_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_grant public.temp_role_grants%ROWTYPE;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = ''
     OR p_role_id IS NULL OR pg_catalog.btrim(p_role_id) = ''
     OR NOT public.commerce_valid_uuid_snapshot(
       COALESCE(p_exclude_grant_ids, '{}'::UUID[])
     ) THEN
    RAISE EXCEPTION 'commerce_find_live_temp_role_owner: identity is required';
  END IF;

  SELECT grant_row.*
    INTO v_grant
    FROM public.temp_role_grants AS grant_row
    LEFT JOIN public.orders AS paid_order
      ON paid_order.id = grant_row.order_id
     AND paid_order.guild_id = grant_row.guild_id
    LEFT JOIN public.customers AS customer
      ON customer.id = paid_order.customer_id
     AND customer.guild_id = paid_order.guild_id
   WHERE grant_row.guild_id = p_guild_id
     AND grant_row.user_id = p_user_id
     AND grant_row.role_id = p_role_id
     AND NOT (
       grant_row.id = ANY(COALESCE(p_exclude_grant_ids, '{}'::UUID[]))
     )
     AND (
       p_exclude_order_id IS NULL
       OR grant_row.order_id IS NULL
       OR grant_row.order_id <> p_exclude_order_id
     )
     AND (
       (
         grant_row.order_id IS NULL
         AND grant_row.grant_status = 'applied'
         AND grant_row.expires_at > v_now
       )
       OR (
         grant_row.order_id IS NOT NULL
         AND grant_row.source = 'commerce_purchase'
         AND grant_row.duration_seconds IS NOT NULL
         AND grant_row.duration_seconds > 0
         AND grant_row.duration_seconds <= 315360000
         AND paid_order.status = 'completed'
         AND paid_order.amount_cents > 0
         AND paid_order.paypal_subscription_id IS NULL
         AND paid_order.product_id::TEXT = grant_row.source_id
         AND paid_order.grant_snapshot_frozen_at IS NOT NULL
         AND customer.discord_id = grant_row.user_id
         AND (
           paid_order.source = 'purchase'
           OR (
             paid_order.source IS NULL
          AND EXISTS (
               SELECT 1
                 FROM public.payments AS payment
                WHERE payment.order_id = paid_order.id
                  AND payment.customer_id = paid_order.customer_id
                  AND payment.guild_id = paid_order.guild_id
                  AND payment.amount_cents = paid_order.amount_cents
                  AND payment.currency IS NOT NULL
                  AND payment.currency = pg_catalog.btrim(payment.currency)
                  AND pg_catalog.upper(payment.currency) ~ '^[A-Z]{3}$'
                  AND pg_catalog.upper(payment.currency) = paid_order.currency
                  AND payment.provider = 'paypal'
                  AND payment.paypal_resource_type IS NOT DISTINCT FROM 'capture'
                  AND payment.status = 'completed'
                  AND payment.paypal_payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
             )
           )
         )
         AND public.commerce_valid_temp_role_snapshot(
           paid_order.temporary_role_grants_snapshot
         )
         AND EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(
               paid_order.temporary_role_grants_snapshot
             ) AS frozen_grant(value)
            WHERE frozen_grant.value ->> 'role_id' = grant_row.role_id
              AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
                = grant_row.duration_seconds
          )
          AND EXISTS (
            SELECT 1
              FROM public.entitlements AS entitlement
             WHERE entitlement.order_id = paid_order.id
               AND entitlement.guild_id = paid_order.guild_id
               AND entitlement.customer_id = paid_order.customer_id
               AND entitlement.product_id = paid_order.product_id
               AND entitlement.type = 'one_time'
               AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
               AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
          )
          AND (
           grant_row.grant_status = 'pending'
           OR (
             grant_row.grant_status = 'applied'
             AND grant_row.expires_at > v_now
           )
         )
       )
     )
   ORDER BY grant_row.id ASC
   LIMIT 1;

  IF v_grant.id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_grant.id,
    'guild_id', v_grant.guild_id,
    'user_id', v_grant.user_id,
    'role_id', v_grant.role_id,
    'expires_at', v_grant.expires_at,
    'grant_status', v_grant.grant_status,
    'remove_on_expiry', v_grant.remove_on_expiry,
    'order_id', v_grant.order_id
  );
END;
$$;

-- Compatibility wrapper for callers that exclude at most one grant. New
-- cleanup callers use the UUID[] overload so their entire intent-owned vector
-- is excluded from successor-owner evidence.
CREATE OR REPLACE FUNCTION public.commerce_find_live_temp_role_owner(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_role_id TEXT,
  p_exclude_grant_id UUID,
  p_exclude_order_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.commerce_find_live_temp_role_owner(
    p_guild_id,
    p_user_id,
    p_role_id,
    CASE WHEN p_exclude_grant_id IS NULL THEN '{}'::UUID[]
      ELSE ARRAY[p_exclude_grant_id] END,
    p_exclude_order_id
  );
$$;

-- Inspect an exact order-backed grant after an ambiguous acknowledgement
-- outcome. This is read-only evidence: callers use it to distinguish a lost
-- successful response from a still-pending or terminal grant before touching
-- Discord again.
CREATE OR REPLACE FUNCTION public.commerce_inspect_temp_role_grant(
  p_grant_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inspection RECORD;
BEGIN
  IF p_grant_id IS NULL THEN
    RAISE EXCEPTION 'commerce_inspect_temp_role_grant: grant is required';
  END IF;

  SELECT grant_row.*,
         paid_order.status AS parent_order_status,
         EXISTS (
           SELECT 1
             FROM public.entitlements AS entitlement
            WHERE entitlement.order_id = paid_order.id
              AND entitlement.guild_id = paid_order.guild_id
              AND entitlement.customer_id = paid_order.customer_id
              AND entitlement.product_id = paid_order.product_id
              AND entitlement.type = 'one_time'
              AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
              AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
         ) AS entitlement_is_live
    INTO v_inspection
    FROM public.temp_role_grants AS grant_row
    JOIN public.orders AS paid_order
      ON paid_order.id = grant_row.order_id
     AND paid_order.guild_id = grant_row.guild_id
    JOIN public.customers AS customer
      ON customer.id = paid_order.customer_id
     AND customer.guild_id = paid_order.guild_id
   WHERE grant_row.id = p_grant_id
     AND grant_row.source = 'commerce_purchase'
     AND grant_row.order_id IS NOT NULL
     AND grant_row.duration_seconds IS NOT NULL
     AND grant_row.duration_seconds > 0
     AND grant_row.duration_seconds <= 315360000
     AND (
       (
         grant_row.grant_status = 'pending'
         AND grant_row.applied_at IS NULL
       )
       OR (
         grant_row.grant_status = 'applied'
         AND grant_row.applied_at IS NOT NULL
         AND grant_row.expires_at = grant_row.applied_at
           + (grant_row.duration_seconds * interval '1 second')
       )
     )
     AND paid_order.amount_cents > 0
     AND paid_order.paypal_subscription_id IS NULL
     AND paid_order.product_id::TEXT = grant_row.source_id
     AND paid_order.grant_snapshot_frozen_at IS NOT NULL
     AND customer.discord_id = grant_row.user_id
     AND (
       paid_order.source = 'purchase'
       OR (
         paid_order.source IS NULL
         AND EXISTS (
           SELECT 1
             FROM public.payments AS payment
            WHERE payment.order_id = paid_order.id
              AND payment.customer_id = paid_order.customer_id
              AND payment.guild_id = paid_order.guild_id
              AND payment.amount_cents = paid_order.amount_cents
              AND payment.currency IS NOT NULL
              AND payment.currency = pg_catalog.btrim(payment.currency)
              AND pg_catalog.upper(payment.currency) ~ '^[A-Z]{3}$'
              AND pg_catalog.upper(payment.currency) = paid_order.currency
              AND payment.provider = 'paypal'
              AND payment.paypal_resource_type IS NOT DISTINCT FROM 'capture'
              AND payment.status IN ('completed', 'refunded', 'reversed')
              AND payment.paypal_payment_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
         )
       )
     )
     AND public.commerce_valid_temp_role_snapshot(
       paid_order.temporary_role_grants_snapshot
     )
     AND EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(
           paid_order.temporary_role_grants_snapshot
         ) AS frozen_grant(value)
        WHERE frozen_grant.value ->> 'role_id' = grant_row.role_id
          AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
            = grant_row.duration_seconds
     );

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_inspection.id,
    'guild_id', v_inspection.guild_id,
    'user_id', v_inspection.user_id,
    'role_id', v_inspection.role_id,
    'expires_at', v_inspection.expires_at,
    'duration_seconds', v_inspection.duration_seconds,
    'grant_status', v_inspection.grant_status,
    'remove_on_expiry', v_inspection.remove_on_expiry,
    'applied_at', v_inspection.applied_at,
    'order_id', v_inspection.order_id,
    'parent_order_status', v_inspection.parent_order_status,
    'entitlement_is_live', v_inspection.entitlement_is_live
  );
END;
$$;

-- A pending row proves paid ownership before Discord mutation, but its
-- provisional expires_at must not consume the purchased duration while the
-- queue waits or retries.  This acknowledgement is the single idempotent
-- transition that starts the clock after Discord has positively confirmed the
-- role.  Replays return the original applied_at/expires_at without extension.
CREATE OR REPLACE FUNCTION public.commerce_acknowledge_temp_role_grant(
  p_grant_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed_grant public.temp_role_grants%ROWTYPE;
  v_grant public.temp_role_grants%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_discord_id TEXT;
  v_applied_at TIMESTAMPTZ;
BEGIN
  IF p_grant_id IS NULL THEN
    RAISE EXCEPTION 'commerce_acknowledge_temp_role_grant: grant is required';
  END IF;

  -- Read the immutable parent identity without taking the child lock, then
  -- acquire parent -> child in the same order as refund finalization. The exact
  -- row is re-read under lock so a mutation while the parent lock was pending
  -- cannot be acknowledged under stale identity.
  SELECT grant_row.*
    INTO v_observed_grant
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = p_grant_id;

  IF v_observed_grant.id IS NULL OR v_observed_grant.order_id IS NULL THEN
    RAISE EXCEPTION 'commerce_acknowledge_temp_role_grant: provenance identity mismatch';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed_grant.order_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_acknowledge_temp_role_grant: parent order is not live';
  END IF;

  SELECT customer.discord_id
    INTO v_discord_id
    FROM public.customers AS customer
   WHERE customer.id = v_order.customer_id
     AND customer.guild_id = v_order.guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_acknowledge_temp_role_grant: parent order is not live';
  END IF;

  SELECT grant_row.*
    INTO v_grant
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = p_grant_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_grant.id IS DISTINCT FROM v_observed_grant.id
     OR v_grant.order_id IS DISTINCT FROM v_observed_grant.order_id
     OR v_grant.guild_id IS DISTINCT FROM v_observed_grant.guild_id
     OR v_grant.user_id IS DISTINCT FROM v_observed_grant.user_id
     OR v_grant.role_id IS DISTINCT FROM v_observed_grant.role_id
     OR v_grant.source_id IS DISTINCT FROM v_observed_grant.source_id
     OR v_grant.duration_seconds IS DISTINCT FROM v_observed_grant.duration_seconds
     OR v_grant.created_at IS DISTINCT FROM v_observed_grant.created_at
     OR v_grant.source IS DISTINCT FROM 'commerce_purchase'
     OR v_grant.order_id IS DISTINCT FROM v_order.id
     OR v_grant.guild_id IS DISTINCT FROM v_order.guild_id
     OR v_grant.user_id IS DISTINCT FROM v_discord_id
     OR v_grant.source_id IS DISTINCT FROM v_order.product_id::TEXT
     OR v_grant.duration_seconds IS NULL
     OR v_grant.duration_seconds <= 0
     OR v_grant.duration_seconds > 315360000
     OR v_grant.grant_status NOT IN ('pending', 'applied')
     OR (
       v_grant.grant_status = 'pending'
       AND v_grant.applied_at IS NOT NULL
     )
     OR (
       v_grant.grant_status = 'applied'
       AND (
         v_grant.applied_at IS NULL
         OR v_grant.expires_at IS DISTINCT FROM v_grant.applied_at
           + (v_grant.duration_seconds * interval '1 second')
       )
     )
     OR v_order.status IS DISTINCT FROM 'completed'
     OR v_order.amount_cents IS NULL OR v_order.amount_cents <= 0
     OR v_order.paypal_subscription_id IS NOT NULL
     OR v_order.grant_snapshot_frozen_at IS NULL
     OR NOT public.commerce_valid_temp_role_snapshot(
       v_order.temporary_role_grants_snapshot
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(
           v_order.temporary_role_grants_snapshot
         ) AS frozen_grant(value)
        WHERE frozen_grant.value ->> 'role_id' = v_grant.role_id
          AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
            = v_grant.duration_seconds
     )
     OR NOT COALESCE((
       v_order.source = 'purchase'
       OR (
         v_order.source IS NULL
         AND EXISTS (
           SELECT 1
             FROM public.payments AS payment
            WHERE payment.order_id = v_order.id
              AND payment.customer_id = v_order.customer_id
              AND payment.guild_id = v_order.guild_id
              AND payment.amount_cents = v_order.amount_cents
              AND payment.currency IS NOT NULL
              AND payment.currency = pg_catalog.btrim(payment.currency)
              AND pg_catalog.upper(payment.currency) ~ '^[A-Z]{3}$'
              AND pg_catalog.upper(payment.currency) = v_order.currency
              AND payment.provider = 'paypal'
              AND payment.paypal_resource_type IS NOT DISTINCT FROM 'capture'
              AND payment.status = 'completed'
              AND payment.paypal_payment_id
                ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
         )
       )
     ), false) THEN
    RAISE EXCEPTION 'commerce_acknowledge_temp_role_grant: provenance identity mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.commerce_role_delivery_intents AS intent
     WHERE p_grant_id = ANY(intent.reserved_temp_role_grant_ids)
        OR p_grant_id = ANY(intent.temporary_role_grant_ids)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_acknowledge_temp_role_grant: attached grant requires exact intent promotion';
  END IF;

  PERFORM entitlement.id
    FROM public.entitlements AS entitlement
   WHERE entitlement.order_id = v_order.id
     AND entitlement.guild_id = v_order.guild_id
     AND entitlement.customer_id = v_order.customer_id
     AND entitlement.product_id = v_order.product_id
     AND entitlement.type = 'one_time'
     AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
     AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
   ORDER BY entitlement.id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_acknowledge_temp_role_grant: parent order is not live';
  END IF;

  IF v_grant.grant_status = 'pending' THEN
    v_applied_at := pg_catalog.clock_timestamp();

    UPDATE public.temp_role_grants
       SET grant_status = 'applied',
           applied_at = v_applied_at,
           expires_at = v_applied_at
             + (v_grant.duration_seconds * interval '1 second'),
           last_error = NULL,
           updated_at = v_applied_at
     WHERE id = v_grant.id
       AND grant_status = 'pending'
    RETURNING * INTO v_grant;
  ELSIF v_grant.grant_status <> 'applied'
        OR v_grant.applied_at IS NULL THEN
    RAISE EXCEPTION 'commerce_acknowledge_temp_role_grant: lifecycle state mismatch';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_grant.id,
    'grant_status', v_grant.grant_status,
    'applied_at', v_grant.applied_at,
    'expires_at', v_grant.expires_at
  );
END;
$$;

-- Atomically retire an expired or terminal order-backed grant. The final
-- live-parent recheck shares locks with acknowledgement and entitlement
-- transitions, closing the reactivation window between Discord cleanup and
-- preservation of the durable revocation tombstone.
CREATE OR REPLACE FUNCTION public.commerce_retire_temp_role_grant(
  p_grant_id UUID,
  p_expected_grant_status TEXT,
  p_expected_expires_at TIMESTAMPTZ,
  p_expected_remove_on_expiry BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_observed_grant public.temp_role_grants%ROWTYPE;
  v_grant public.temp_role_grants%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_discord_id TEXT;
  v_has_live_entitlement BOOLEAN := false;
  v_has_processing_fulfillment BOOLEAN := false;
  v_has_malformed_processing_fulfillment BOOLEAN := false;
  v_intent_count INTEGER := 0;
  v_reserved_intent_count INTEGER := 0;
  v_confirmed_intent_count INTEGER := 0;
  v_observed_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_contract_state TEXT;
  v_grant_retired BOOLEAN := false;
BEGIN
  SELECT grant_row.*
    INTO v_observed_grant
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = p_grant_id;

  IF v_observed_grant.id IS NULL OR v_observed_grant.order_id IS NULL THEN
    RAISE EXCEPTION 'commerce_retire_temp_role_grant: provenance identity mismatch';
  END IF;

  SELECT paid_order.*
    INTO v_order
    FROM public.orders AS paid_order
   WHERE paid_order.id = v_observed_grant.order_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_retire_temp_role_grant: provenance identity mismatch';
  END IF;

  SELECT customer.discord_id
    INTO v_discord_id
    FROM public.customers AS customer
   WHERE customer.id = v_order.customer_id
     AND customer.guild_id = v_order.guild_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_retire_temp_role_grant: provenance identity mismatch';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-role-owner:' || v_observed_grant.guild_id || ':'
        || v_observed_grant.user_id || ':' || v_observed_grant.role_id,
      0
    )
  );

  SELECT grant_row.*
    INTO v_grant
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = p_grant_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_grant.id IS DISTINCT FROM v_observed_grant.id
     OR v_grant.order_id IS DISTINCT FROM v_observed_grant.order_id
     OR v_grant.guild_id IS DISTINCT FROM v_observed_grant.guild_id
     OR v_grant.user_id IS DISTINCT FROM v_observed_grant.user_id
     OR v_grant.role_id IS DISTINCT FROM v_observed_grant.role_id
     OR v_grant.source_id IS DISTINCT FROM v_observed_grant.source_id
     OR v_grant.duration_seconds IS DISTINCT FROM v_observed_grant.duration_seconds
     OR v_grant.created_at IS DISTINCT FROM v_observed_grant.created_at
     OR v_grant.expires_at IS DISTINCT FROM p_expected_expires_at
     OR v_grant.remove_on_expiry IS DISTINCT FROM p_expected_remove_on_expiry THEN
    RAISE EXCEPTION 'commerce_retire_temp_role_grant: provenance identity mismatch';
  END IF;

  SELECT pg_catalog.count(*)::INTEGER,
         pg_catalog.count(*) FILTER (
           WHERE p_grant_id = ANY(intent.reserved_temp_role_grant_ids)
         )::INTEGER,
         pg_catalog.count(*) FILTER (
           WHERE p_grant_id = ANY(intent.temporary_role_grant_ids)
         )::INTEGER
    INTO v_intent_count, v_reserved_intent_count, v_confirmed_intent_count
    FROM public.commerce_role_delivery_intents AS intent
   WHERE p_grant_id = ANY(intent.reserved_temp_role_grant_ids)
      OR p_grant_id = ANY(intent.temporary_role_grant_ids);
  IF v_intent_count > 1
     OR v_reserved_intent_count + v_confirmed_intent_count <> v_intent_count THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce_retire_temp_role_grant: grant is bound to multiple intents';
  END IF;
  IF v_intent_count = 1 THEN
    SELECT intent.* INTO v_observed_intent
      FROM public.commerce_role_delivery_intents AS intent
     WHERE p_grant_id = ANY(intent.reserved_temp_role_grant_ids)
        OR p_grant_id = ANY(intent.temporary_role_grant_ids);
  END IF;

  IF v_grant.grant_status = 'removed'
     AND v_grant.source = 'commerce_reconciled' THEN
    IF v_intent_count > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_retire_temp_role_grant: tombstone still has intent authority';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'id', v_grant.id,
      'retired', true,
      'grant_status', v_grant.grant_status,
      'source', v_grant.source,
      'intent_id', NULL,
      'intent_state', NULL,
      'disposition', 'already_retired'
    );
  END IF;

  IF v_grant.grant_status IS DISTINCT FROM p_expected_grant_status
     OR v_grant.grant_status NOT IN ('pending', 'applied')
     OR v_grant.source IS DISTINCT FROM 'commerce_purchase'
     OR v_grant.order_id IS DISTINCT FROM v_order.id
     OR v_grant.guild_id IS DISTINCT FROM v_order.guild_id
     OR v_grant.user_id IS DISTINCT FROM COALESCE(
       v_observed_intent.discord_id, v_discord_id
     )
     OR v_grant.source_id IS DISTINCT FROM v_order.product_id::TEXT
     OR v_grant.duration_seconds IS NULL
     OR v_grant.duration_seconds <= 0
     OR v_grant.duration_seconds > 315360000
     OR (
       v_grant.grant_status = 'pending'
       AND v_grant.applied_at IS NOT NULL
     )
     OR (
       v_grant.grant_status = 'applied'
       AND (
         v_grant.applied_at IS NULL
         OR v_grant.expires_at IS DISTINCT FROM v_grant.applied_at
           + (v_grant.duration_seconds * interval '1 second')
       )
     )
     OR v_order.amount_cents IS NULL OR v_order.amount_cents <= 0
     OR v_order.paypal_subscription_id IS NOT NULL
     OR v_order.grant_snapshot_frozen_at IS NULL
     OR NOT public.commerce_valid_temp_role_snapshot(
       v_order.temporary_role_grants_snapshot
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(
           v_order.temporary_role_grants_snapshot
         ) AS frozen_grant(value)
        WHERE frozen_grant.value ->> 'role_id' = v_grant.role_id
          AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
            = v_grant.duration_seconds
     )
     OR NOT COALESCE((
       v_order.source = 'purchase'
       OR (
         v_order.source IS NULL
         AND EXISTS (
           SELECT 1
             FROM public.payments AS payment
            WHERE payment.order_id = v_order.id
              AND payment.customer_id = v_order.customer_id
              AND payment.guild_id = v_order.guild_id
              AND payment.amount_cents = v_order.amount_cents
              AND payment.currency IS NOT NULL
              AND payment.currency = pg_catalog.btrim(payment.currency)
              AND pg_catalog.upper(payment.currency) ~ '^[A-Z]{3}$'
              AND pg_catalog.upper(payment.currency) = v_order.currency
              AND payment.provider = 'paypal'
              AND payment.paypal_resource_type IS NOT DISTINCT FROM 'capture'
              AND payment.status IN ('completed', 'refunded', 'reversed')
              AND payment.paypal_payment_id
                ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
         )
       )
     ), false) THEN
    RAISE EXCEPTION 'commerce_retire_temp_role_grant: lifecycle identity mismatch';
  END IF;

  PERFORM entitlement.id
    FROM public.entitlements AS entitlement
   WHERE entitlement.order_id = v_order.id
     AND entitlement.guild_id = v_order.guild_id
     AND entitlement.customer_id = v_order.customer_id
     AND entitlement.product_id = v_order.product_id
     AND entitlement.type = 'one_time'
     AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
     AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
   ORDER BY entitlement.id
   FOR SHARE;
  v_has_live_entitlement := FOUND;

  IF v_observed_intent.id IS NOT NULL THEN
    SELECT intent.* INTO v_intent
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.id = v_observed_intent.id
       AND (
         p_grant_id = ANY(intent.reserved_temp_role_grant_ids)
         OR p_grant_id = ANY(intent.temporary_role_grant_ids)
       )
     FOR UPDATE;
    IF NOT FOUND
       OR v_intent.order_id IS DISTINCT FROM v_grant.order_id
       OR v_intent.guild_id IS DISTINCT FROM v_grant.guild_id
       OR v_intent.discord_id IS DISTINCT FROM v_grant.user_id
       OR v_intent.product_id::TEXT IS DISTINCT FROM v_grant.source_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_retire_temp_role_grant: intent identity changed';
    END IF;

    IF p_grant_id = ANY(v_intent.reserved_temp_role_grant_ids) THEN
      RETURN pg_catalog.jsonb_build_object(
        'id', v_grant.id,
        'retired', false,
        'grant_status', v_grant.grant_status,
        'source', v_grant.source,
        'intent_id', v_intent.id,
        'intent_state', v_intent.state,
        'disposition', 'provisional_reservation'
      );
    END IF;

    IF v_intent.state <> 'open'
       OR v_intent.delivery_confirmed_at IS NULL
       OR v_intent.mutation_token IS NOT NULL
       OR v_intent.cleanup_mutation_token IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'id', v_grant.id,
        'retired', false,
        'grant_status', v_grant.grant_status,
        'source', v_grant.source,
        'intent_id', v_intent.id,
        'intent_state', v_intent.state,
        'disposition', 'intent_unresolved'
      );
    END IF;
    v_contract_state := public.commerce_role_delivery_contract_state(v_intent.id);
    IF v_contract_state = 'invalid' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_retire_temp_role_grant: intent contract is invalid';
    END IF;
  END IF;

  IF v_order.status = 'completed'
     AND v_has_live_entitlement
     AND (
       v_grant.grant_status = 'pending'
       OR v_grant.expires_at > pg_catalog.clock_timestamp()
     ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'id', v_grant.id,
      'retired', false,
      'grant_status', v_grant.grant_status,
      'source', v_grant.source
    );
  END IF;

  -- A worker may have claimed fulfillment immediately before the parent
  -- became terminal. Keep a still-pending provenance row until that exact
  -- in-flight intent resolves, otherwise the worker could add the Discord
  -- role after its durable row was retired. This is intentionally a plain
  -- MVCC read: queue workers lock queue -> order, so taking a queue row lock
  -- here while holding order -> grant would introduce a cycle.
  IF v_grant.grant_status = 'pending' THEN
    SELECT COALESCE(pg_catalog.bool_or(
             queue.payload ->> 'guild_id' IS NOT DISTINCT FROM v_order.guild_id
             AND queue.payload ->> 'customer_id'
               IS NOT DISTINCT FROM v_order.customer_id::TEXT
             AND queue.payload ->> 'product_id'
               IS NOT DISTINCT FROM v_order.product_id::TEXT
             AND queue.payload ->> 'discord_id'
               IS NOT DISTINCT FROM v_grant.user_id
           ), false),
           COALESCE(pg_catalog.bool_or(NOT (
             queue.payload ->> 'guild_id' IS NOT DISTINCT FROM v_order.guild_id
             AND queue.payload ->> 'customer_id'
               IS NOT DISTINCT FROM v_order.customer_id::TEXT
             AND queue.payload ->> 'product_id'
               IS NOT DISTINCT FROM v_order.product_id::TEXT
             AND queue.payload ->> 'discord_id'
               IS NOT DISTINCT FROM v_grant.user_id
           )), false)
      INTO v_has_processing_fulfillment,
           v_has_malformed_processing_fulfillment
      FROM public.bot_action_queue AS queue
     WHERE queue.status = 'processing'
       AND queue.action IN ('fulfill_purchase', 'fulfill_subscription')
       AND pg_catalog.jsonb_typeof(queue.payload) = 'object'
       AND queue.payload ->> 'order_id' = v_order.id::TEXT;

    IF v_has_malformed_processing_fulfillment THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_retire_temp_role_grant: processing fulfillment identity mismatch';
    END IF;

    IF v_has_processing_fulfillment THEN
      RETURN pg_catalog.jsonb_build_object(
        'id', v_grant.id,
        'retired', false,
        'grant_status', v_grant.grant_status,
        'source', v_grant.source
      );
    END IF;
  END IF;

  PERFORM pg_catalog.set_config(
    'somnibot.commerce_temp_retirement_grant_id', v_grant.id::TEXT, true
  );
  UPDATE public.temp_role_grants
     SET grant_status = 'removed',
         source = 'commerce_reconciled',
         last_error = NULL,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_grant.id
   RETURNING * INTO v_grant;
  v_grant_retired := FOUND;
  PERFORM pg_catalog.set_config(
    'somnibot.commerce_temp_retirement_grant_id', '', true
  );
  IF NOT v_grant_retired THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'commerce_retire_temp_role_grant: grant retirement raced';
  END IF;

  IF v_intent.id IS NOT NULL THEN
    UPDATE public.commerce_role_delivery_intents
       SET temporary_role_grant_ids = pg_catalog.array_remove(
             temporary_role_grant_ids, p_grant_id
           ),
           state = CASE
             WHEN pg_catalog.cardinality(owned_role_ids) = 0
               AND pg_catalog.cardinality(reserved_role_ids) = 0
               AND pg_catalog.cardinality(reserved_temp_role_grant_ids) = 0
               AND pg_catalog.cardinality(temporary_role_grant_ids) = 1
               AND mutation_token IS NULL
               AND cleanup_mutation_token IS NULL
               THEN 'settled'
             WHEN v_contract_state = 'terminal' THEN 'cleanup_required'
             ELSE state
           END,
           settled_at = CASE
             WHEN pg_catalog.cardinality(owned_role_ids) = 0
               AND pg_catalog.cardinality(reserved_role_ids) = 0
               AND pg_catalog.cardinality(reserved_temp_role_grant_ids) = 0
               AND pg_catalog.cardinality(temporary_role_grant_ids) = 1
               AND mutation_token IS NULL
               AND cleanup_mutation_token IS NULL
               THEN pg_catalog.clock_timestamp()
             ELSE NULL
           END,
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_intent.id
       AND p_grant_id = ANY(temporary_role_grant_ids)
       AND mutation_token IS NULL
       AND cleanup_mutation_token IS NULL
     RETURNING * INTO v_intent;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'commerce_retire_temp_role_grant: intent detach CAS failed';
    END IF;
    IF v_intent.state = 'settled' THEN
      PERFORM public.commerce_resolve_role_delivery_alert(v_intent.id);
    ELSIF v_intent.state = 'cleanup_required' THEN
      PERFORM public.commerce_signal_role_delivery_intent(
        v_intent.id,
        'temporary-role authority retired while terminal permanent authority remains'
      );
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_grant.id,
    'retired', true,
    'grant_status', v_grant.grant_status,
    'source', v_grant.source,
    'intent_id', v_intent.id,
    'intent_state', v_intent.state,
    'disposition', 'retired'
  );
END;
$$;

-- Database retention must not erase role provenance merely because its clock
-- expired.  Only the Discord-aware bot sweeper may delete a row after it has
-- positively confirmed role absence/removal.
CREATE OR REPLACE FUNCTION public.prune_expired_data(p_guild_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result JSONB := '{}'::JSONB;
  cnt INTEGER;
BEGIN
  DELETE FROM public.infractions
   WHERE guild_id = p_guild_id AND active = true AND expires_at < now();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('expired_infractions', cnt);

  -- No mutes table has ever existed: mutes are infractions rows with
  -- type='mute' and are already covered by the expired_infractions delete
  -- above. The result key stays for API compatibility (same pattern as
  -- expired_temp_roles below).
  result := result || jsonb_build_object('expired_mutes', 0);

  -- Retention scrubs, never deletes (owner decision, 2026-07-18): identity
  -- and payloads leave at the retention boundary, the forensic skeleton
  -- stays. The actor_id guard keeps repeat prune runs from recounting
  -- already-scrubbed rows.
  UPDATE public.audit_logs
     SET actor_id = 'anonymized',
         target_id = CASE WHEN target_id IS NULL THEN NULL ELSE 'anonymized' END,
         details = pg_catalog.jsonb_build_object('anonymized', true),
         before_state = NULL,
         after_state = NULL,
         error_message = NULL,
         correlation_id = NULL
   WHERE guild_id = p_guild_id
     AND timestamp < now() - interval '90 days'
     AND actor_id IS DISTINCT FROM 'anonymized';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('old_audit_logs', cnt);

  result := result || jsonb_build_object('expired_temp_roles', 0);

  DELETE FROM public.webhook_events
   WHERE (guild_id = p_guild_id OR guild_id IS NULL)
     AND processed_at < now() - interval '90 days';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('old_webhook_events', cnt);

  DELETE FROM public.license_validations
   WHERE product_id IN (
     SELECT product.id
       FROM public.products AS product
      WHERE product.guild_id = p_guild_id
   )
     AND created_at < now() - interval '180 days';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('old_license_validations', cnt);

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_prepare_temp_role_grant(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_prepare_temp_role_grant(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION public.commerce_find_live_temp_role_owner(
  TEXT, TEXT, TEXT, UUID[], UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_find_live_temp_role_owner(
  TEXT, TEXT, TEXT, UUID[], UUID
) TO service_role;
REVOKE ALL ON FUNCTION public.commerce_find_live_temp_role_owner(
  TEXT, TEXT, TEXT, UUID, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_find_live_temp_role_owner(
  TEXT, TEXT, TEXT, UUID, UUID
) TO service_role;

REVOKE ALL ON FUNCTION public.commerce_inspect_temp_role_grant(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_inspect_temp_role_grant(UUID)
  TO service_role;

REVOKE ALL ON FUNCTION public.commerce_acknowledge_temp_role_grant(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_acknowledge_temp_role_grant(UUID)
  TO service_role;

REVOKE ALL ON FUNCTION public.commerce_retire_temp_role_grant(
  UUID, TEXT, TIMESTAMPTZ, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_retire_temp_role_grant(
  UUID, TEXT, TIMESTAMPTZ, BOOLEAN
) TO service_role;

REVOKE ALL ON FUNCTION public.prune_expired_data(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_expired_data(TEXT)
  TO service_role;

-- Product-prize fulfillment is a transactional outbox owned by the giveaway
-- state transition. The manager's in-memory event is notification/fallback
-- only: a process crash after either RPC commits cannot lose a winner grant.
CREATE OR REPLACE FUNCTION public.giveaway_atomic_end(
  p_giveaway_id UUID,
  p_winners TEXT[],
  p_ended_at TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE(id UUID, entries TEXT[], winner_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_giveaway public.giveaways%ROWTYPE;
  v_winners TEXT[];
  v_entry_count INTEGER;
  v_winner_id TEXT;
  v_action_id UUID;
  v_key TEXT;
  v_payload JSONB;
  v_action public.bot_action_queue%ROWTYPE;
BEGIN
  IF p_giveaway_id IS NULL OR p_ended_at IS NULL
     OR NOT pg_catalog.isfinite(p_ended_at)
     OR p_winners IS NULL
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(p_winners) AS winner(value)
        WHERE winner.value IS NULL
           OR winner.value !~ '^[0-9]{17,20}$'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'giveaway_atomic_end: exact canonical winner identity is required';
  END IF;
  SELECT COALESCE(
           pg_catalog.array_agg(dedup.value ORDER BY dedup.first_ordinal),
           '{}'::TEXT[]
         )
    INTO v_winners
    FROM (
      SELECT winner.value, pg_catalog.min(winner.ordinality) AS first_ordinal
        FROM pg_catalog.unnest(p_winners) WITH ORDINALITY AS winner(value, ordinality)
       GROUP BY winner.value
    ) AS dedup;

  SELECT giveaway.* INTO v_giveaway
    FROM public.giveaways AS giveaway
   WHERE giveaway.id = p_giveaway_id
     AND giveaway.status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT pg_catalog.count(DISTINCT entry.value)::INTEGER
    INTO v_entry_count
    FROM pg_catalog.unnest(
      COALESCE(v_giveaway.entries, '{}'::TEXT[])
    ) AS entry(value);
  IF v_giveaway.winner_count IS NULL
     OR v_giveaway.winner_count < 1
     OR pg_catalog.cardinality(v_winners) IS DISTINCT FROM
       LEAST(v_giveaway.winner_count, v_entry_count)
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(v_winners) AS winner(value)
        WHERE NOT (
          winner.value = ANY(COALESCE(v_giveaway.entries, '{}'::TEXT[]))
        )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'giveaway_atomic_end: winners exceed the locked entrant contract';
  END IF;

  UPDATE public.giveaways AS giveaway
     SET status = 'ended',
         winners = v_winners,
         ended_at = p_ended_at
   WHERE giveaway.id = p_giveaway_id
     AND giveaway.status = 'active'
  RETURNING giveaway.* INTO v_giveaway;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'giveaway_atomic_end: giveaway changed concurrently';
  END IF;

  IF v_giveaway.prize_product_id IS NOT NULL THEN
    IF v_giveaway.guild_id IS NULL
       OR v_giveaway.guild_id !~ '^[0-9]{17,20}$' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'giveaway_atomic_end: product prize guild identity is malformed';
    END IF;
    FOREACH v_winner_id IN ARRAY v_winners LOOP
      v_action_id := gen_random_uuid();
      v_payload := pg_catalog.jsonb_build_object(
        'source', 'giveaway_atomic_end',
        'guild_id', v_giveaway.guild_id,
        'giveaway_id', v_giveaway.id,
        'winner_id', v_winner_id,
        'product_id', v_giveaway.prize_product_id
      );
      v_key := 'giveaway:fulfill-product:' || v_giveaway.guild_id || ':'
        || v_giveaway.id::TEXT || ':' || v_winner_id || ':'
        || v_giveaway.prize_product_id::TEXT || ':v1';
      INSERT INTO public.bot_action_queue (
        id, guild_id, action, payload, status, lane, idempotency_key
      ) VALUES (
        v_action_id,
        v_giveaway.guild_id,
        'fulfill_giveaway_prize',
        v_payload,
        'pending',
        'commerce',
        v_key
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
      SELECT queue.* INTO v_action
        FROM public.bot_action_queue AS queue
       WHERE queue.idempotency_key = v_key;
      IF NOT FOUND
         OR v_action.guild_id IS DISTINCT FROM v_giveaway.guild_id
         OR v_action.action IS DISTINCT FROM 'fulfill_giveaway_prize'
         OR v_action.lane IS DISTINCT FROM 'commerce'
         OR v_action.payload IS DISTINCT FROM v_payload THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'giveaway_atomic_end: fulfillment carrier is cross-linked';
      END IF;
    END LOOP;
  END IF;

  -- Winner communication is a separate durable effect. Product notifications
  -- may wait for their deterministic entitlement, while manual prizes can be
  -- sent immediately; either way the exact prize snapshot is immutable.
  FOREACH v_winner_id IN ARRAY v_winners LOOP
    v_action_id := gen_random_uuid();
    v_payload := pg_catalog.jsonb_build_object(
      'source', 'giveaway_atomic_end',
      'guild_id', v_giveaway.guild_id,
      'giveaway_id', v_giveaway.id,
      'winner_id', v_winner_id,
      'product_id', v_giveaway.prize_product_id,
      'delivery_kind', CASE WHEN v_giveaway.prize_product_id IS NULL
        THEN 'manual' ELSE 'product' END,
      -- The queue ABI requires a trimmed, bounded snapshot. Canonicalize at
      -- snapshot time so the durable payload and every replay's exact-match
      -- proof compare normalized to normalized, whatever the stored prize is.
      'prize_snapshot', pg_catalog.btrim(
        pg_catalog.left(pg_catalog.btrim(v_giveaway.prize), 1000)
      )
    );
    v_key := 'giveaway:notify-winner:' || v_giveaway.guild_id || ':'
      || v_giveaway.id::TEXT || ':' || v_winner_id || ':v1';
    INSERT INTO public.bot_action_queue (
      id, guild_id, action, payload, status, lane, idempotency_key
    ) VALUES (
      v_action_id,
      v_giveaway.guild_id,
      'notify_giveaway_winner',
      v_payload,
      'pending',
      'commerce',
      v_key
    )
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    SELECT queue.* INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.idempotency_key = v_key;
    IF NOT FOUND
       OR v_action.guild_id IS DISTINCT FROM v_giveaway.guild_id
       OR v_action.action IS DISTINCT FROM 'notify_giveaway_winner'
       OR v_action.lane IS DISTINCT FROM 'commerce'
       OR v_action.payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'giveaway_atomic_end: notification carrier is cross-linked';
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_giveaway.id, v_giveaway.entries, v_giveaway.winner_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.giveaway_atomic_reroll(
  p_giveaway_id UUID,
  p_new_winners TEXT[]
)
RETURNS TABLE(winners TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_giveaway public.giveaways%ROWTYPE;
  v_new_winners TEXT[];
  v_winner_id TEXT;
  v_action_id UUID;
  v_key TEXT;
  v_payload JSONB;
  v_action public.bot_action_queue%ROWTYPE;
BEGIN
  IF p_giveaway_id IS NULL OR p_new_winners IS NULL
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(p_new_winners) AS winner(value)
        WHERE winner.value IS NULL
           OR winner.value !~ '^[0-9]{17,20}$'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'giveaway_atomic_reroll: exact canonical winner identity is required';
  END IF;
  SELECT giveaway.* INTO v_giveaway
    FROM public.giveaways AS giveaway
   WHERE giveaway.id = p_giveaway_id
     AND giveaway.status = 'ended'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT COALESCE(
           pg_catalog.array_agg(dedup.value ORDER BY dedup.first_ordinal),
           '{}'::TEXT[]
         )
    INTO v_new_winners
    FROM (
      SELECT winner.value, pg_catalog.min(winner.ordinality) AS first_ordinal
        FROM pg_catalog.unnest(p_new_winners) WITH ORDINALITY AS winner(value, ordinality)
       WHERE NOT (winner.value = ANY(COALESCE(v_giveaway.winners, '{}'::TEXT[])))
       GROUP BY winner.value
    ) AS dedup;

  IF v_giveaway.winner_count IS NULL
     OR v_giveaway.winner_count < 1
     OR pg_catalog.cardinality(v_new_winners) > v_giveaway.winner_count
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(p_new_winners) AS winner(value)
        WHERE NOT (
          winner.value = ANY(COALESCE(v_giveaway.entries, '{}'::TEXT[]))
        )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'giveaway_atomic_reroll: winners exceed the locked entrant contract';
  END IF;

  UPDATE public.giveaways AS giveaway
     SET winners = COALESCE(giveaway.winners, '{}'::TEXT[]) || v_new_winners
   WHERE giveaway.id = v_giveaway.id
     AND giveaway.status = 'ended'
  RETURNING giveaway.* INTO v_giveaway;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'giveaway_atomic_reroll: giveaway changed concurrently';
  END IF;

  IF v_giveaway.prize_product_id IS NOT NULL THEN
    IF v_giveaway.guild_id IS NULL
       OR v_giveaway.guild_id !~ '^[0-9]{17,20}$' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'giveaway_atomic_reroll: product prize guild identity is malformed';
    END IF;
    FOREACH v_winner_id IN ARRAY v_new_winners LOOP
      v_action_id := gen_random_uuid();
      v_payload := pg_catalog.jsonb_build_object(
        'source', 'giveaway_atomic_reroll',
        'guild_id', v_giveaway.guild_id,
        'giveaway_id', v_giveaway.id,
        'winner_id', v_winner_id,
        'product_id', v_giveaway.prize_product_id
      );
      v_key := 'giveaway:fulfill-product:' || v_giveaway.guild_id || ':'
        || v_giveaway.id::TEXT || ':' || v_winner_id || ':'
        || v_giveaway.prize_product_id::TEXT || ':v1';
      INSERT INTO public.bot_action_queue (
        id, guild_id, action, payload, status, lane, idempotency_key
      ) VALUES (
        v_action_id,
        v_giveaway.guild_id,
        'fulfill_giveaway_prize',
        v_payload,
        'pending',
        'commerce',
        v_key
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
      SELECT queue.* INTO v_action
        FROM public.bot_action_queue AS queue
       WHERE queue.idempotency_key = v_key;
      IF NOT FOUND
         OR v_action.guild_id IS DISTINCT FROM v_giveaway.guild_id
         OR v_action.action IS DISTINCT FROM 'fulfill_giveaway_prize'
         OR v_action.lane IS DISTINCT FROM 'commerce'
         OR v_action.payload IS DISTINCT FROM v_payload THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'giveaway_atomic_reroll: fulfillment carrier is cross-linked';
      END IF;
    END LOOP;
  END IF;
  FOREACH v_winner_id IN ARRAY v_new_winners LOOP
    v_action_id := gen_random_uuid();
    v_payload := pg_catalog.jsonb_build_object(
      'source', 'giveaway_atomic_reroll',
      'guild_id', v_giveaway.guild_id,
      'giveaway_id', v_giveaway.id,
      'winner_id', v_winner_id,
      'product_id', v_giveaway.prize_product_id,
      'delivery_kind', CASE WHEN v_giveaway.prize_product_id IS NULL
        THEN 'manual' ELSE 'product' END,
      -- The queue ABI requires a trimmed, bounded snapshot. Canonicalize at
      -- snapshot time so the durable payload and every replay's exact-match
      -- proof compare normalized to normalized, whatever the stored prize is.
      'prize_snapshot', pg_catalog.btrim(
        pg_catalog.left(pg_catalog.btrim(v_giveaway.prize), 1000)
      )
    );
    v_key := 'giveaway:notify-winner:' || v_giveaway.guild_id || ':'
      || v_giveaway.id::TEXT || ':' || v_winner_id || ':v1';
    INSERT INTO public.bot_action_queue (
      id, guild_id, action, payload, status, lane, idempotency_key
    ) VALUES (
      v_action_id,
      v_giveaway.guild_id,
      'notify_giveaway_winner',
      v_payload,
      'pending',
      'commerce',
      v_key
    )
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    SELECT queue.* INTO v_action
      FROM public.bot_action_queue AS queue
     WHERE queue.idempotency_key = v_key;
    IF NOT FOUND
       OR v_action.guild_id IS DISTINCT FROM v_giveaway.guild_id
       OR v_action.action IS DISTINCT FROM 'notify_giveaway_winner'
       OR v_action.lane IS DISTINCT FROM 'commerce'
       OR v_action.payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'giveaway_atomic_reroll: notification carrier is cross-linked';
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_giveaway.winners;
END;
$$;

REVOKE ALL ON FUNCTION public.giveaway_atomic_end(UUID, TEXT[], TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.giveaway_atomic_end(UUID, TEXT[], TIMESTAMPTZ)
  TO service_role;
REVOKE ALL ON FUNCTION public.giveaway_atomic_reroll(UUID, TEXT[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.giveaway_atomic_reroll(UUID, TEXT[])
  TO service_role;

-- Restate trigger-helper lockdown after replacing the assertion function.
REVOKE ALL ON FUNCTION public.commerce_assert_income_wall_guild(TEXT)
  FROM PUBLIC, anon, authenticated;

COMMIT;
