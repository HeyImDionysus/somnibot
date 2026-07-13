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

-- Deployment fence for the lossless metadata rewrite. SHARE ROW EXCLUSIVE
-- blocks INSERT/UPDATE/DELETE while allowing readers, and transactional DDL
-- holds it through classification, canonical/typed conversion, quarantine,
-- reserved-key stripping, and installation of the no-legacy-key constraint.
-- Operational impact: product writers wait for this entire migration file, so
-- deploy during a low-write window and monitor lock wait/transaction duration.
BEGIN;

LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;

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

-- Freeze the exact role/channel/temp-role configuration sold with an order.
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

-- A staged outbox row is durable but deliberately invisible to workers until
-- its producer has completed all payload assembly and releases it to pending.
ALTER TABLE public.bot_action_queue
  DROP CONSTRAINT IF EXISTS bot_action_queue_status_check;
ALTER TABLE public.bot_action_queue
  ADD CONSTRAINT bot_action_queue_status_check
    CHECK (status IN ('staged', 'pending', 'processing', 'completed', 'failed')),
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

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

-- A narrow compatibility boundary for completed subscription orders that
-- predate order-level grant snapshots but already have an exact staged outbox
-- payload. The queue id is intentionally an immutable UUID marker rather than
-- a foreign key: normal queue retention must not erase or block this contract.
-- Only the privileged validation RPC below may insert a row; workers get
-- read-only access so a null order snapshot is trusted only with this evidence.
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
);

CREATE INDEX IF NOT EXISTS idx_commerce_product_temp_role_config_guild
  ON public.commerce_product_temp_role_config (guild_id, product_id, role_id);

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

-- Existing rows were written after Discord mutation, so they are known-applied.
-- New fulfillment explicitly inserts pending through the RPC below.
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

CREATE UNIQUE INDEX IF NOT EXISTS uniq_temp_role_grants_commerce_order_role
  ON public.temp_role_grants (order_id, role_id)
  WHERE order_id IS NOT NULL;

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

    PERFORM public.commerce_income_wall_lock_guild(OLD.guild_id);

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

    IF NOT COALESCE((
      OLD.source = 'purchase'
      OR (
        OLD.source IS NULL
        AND OLD.paypal_order_id IS NOT NULL
        AND pg_catalog.btrim(OLD.paypal_order_id) <> ''
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
         OR pg_catalog.btrim(OLD.paypal_order_id) = ''
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

  PERFORM public.commerce_income_wall_lock_guild(p_guild_id);

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
      AND pg_catalog.btrim(v_order.paypal_order_id) <> ''
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
       OR pg_catalog.btrim(v_order.paypal_order_id) = ''
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
  IF p_paypal_capture_id IS NULL OR pg_catalog.btrim(p_paypal_capture_id) = '' THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: capture id is required';
  END IF;
  IF p_paypal_order_id IS NULL OR pg_catalog.btrim(p_paypal_order_id) = '' THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: PayPal order id is required';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents < 0 THEN
    RAISE EXCEPTION 'commerce_finalize_paypal_capture: amount must be non-negative';
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
     OR v_order.paypal_order_id IS DISTINCT FROM p_paypal_order_id THEN
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

  IF v_order.paypal_subscription_id IS NOT NULL THEN
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
   WHERE payment.paypal_payment_id = p_paypal_capture_id;

  IF FOUND THEN
    IF v_payment.order_id IS DISTINCT FROM p_order_id
       OR v_payment.customer_id IS DISTINCT FROM p_customer_id
       OR v_payment.guild_id IS DISTINCT FROM p_guild_id
       OR v_payment.amount_cents IS DISTINCT FROM p_amount_cents
       -- Legacy capture writers copied the order currency verbatim, before
       -- provider currency was canonicalized. Normalize stored case only;
       -- whitespace, malformed text, and a different code still fail closed.
       OR pg_catalog.upper(v_payment.currency) IS DISTINCT FROM p_currency
       OR v_payment.provider IS DISTINCT FROM 'paypal' THEN
      RAISE EXCEPTION 'commerce_finalize_paypal_capture: existing capture identity mismatch';
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
    provider
  ) VALUES (
    p_order_id,
    p_customer_id,
    p_guild_id,
    p_paypal_capture_id,
    p_amount_cents,
    p_currency,
    v_target_status,
    'paypal'
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

-- A terminal paid-entitlement transition and its Discord revocation intent
-- commit together. The action handler performs shared-owner filtering against
-- other live entitlements before it removes any role.
CREATE OR REPLACE FUNCTION public.commerce_enqueue_entitlement_role_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_discord_id TEXT;
  v_is_paid BOOLEAN := false;
  v_role_ids TEXT[];
  v_temp_role_grant_ids UUID[] := '{}'::UUID[];
BEGIN
  IF OLD.status NOT IN ('active', 'pending', 'grace_period', 'suspended')
     OR NEW.status NOT IN ('cancelled', 'expired', 'revoked') THEN
    RETURN NEW;
  END IF;

  IF OLD.source = 'purchase' OR OLD.source IS NULL THEN
    IF OLD.order_id IS NULL
       OR OLD.customer_id IS NULL
       OR OLD.product_id IS NULL
       OR OLD.guild_id IS NULL THEN
      RAISE EXCEPTION 'commerce entitlement revocation: paid identity is incomplete';
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM public.orders AS paid_order
       WHERE paid_order.id = OLD.order_id
         AND paid_order.guild_id = OLD.guild_id
         AND paid_order.customer_id = OLD.customer_id
         AND paid_order.product_id = OLD.product_id
         AND (
           (OLD.type = 'one_time' AND paid_order.amount_cents > 0)
           OR (
             OLD.type = 'subscription'
             AND
             paid_order.paypal_subscription_id IS NOT NULL
             AND pg_catalog.btrim(paid_order.paypal_subscription_id) <> ''
           )
         )
         AND (
           OLD.source = 'purchase'
           OR EXISTS (
             SELECT 1
               FROM public.payments AS payment
              WHERE payment.order_id = paid_order.id
                 AND payment.customer_id = paid_order.customer_id
                 AND payment.guild_id = paid_order.guild_id
                 AND payment.amount_cents = paid_order.amount_cents
                 AND payment.currency = paid_order.currency
                 AND payment.status IN ('completed', 'refunded', 'reversed')
                AND payment.paypal_payment_id IS NOT NULL
                AND pg_catalog.btrim(payment.paypal_payment_id) <> ''
           )
         )
    ) INTO v_is_paid;

    IF NOT v_is_paid THEN
      RAISE EXCEPTION 'commerce entitlement revocation: paid identity is not verifiable';
    END IF;
  END IF;

  IF NOT v_is_paid THEN
    RETURN NEW;
  END IF;

  SELECT customer.discord_id
    INTO v_discord_id
    FROM public.customers AS customer
   WHERE customer.id = OLD.customer_id
     AND customer.guild_id = OLD.guild_id;

  IF v_discord_id IS NULL OR pg_catalog.btrim(v_discord_id) = '' THEN
    RAISE EXCEPTION 'commerce entitlement revocation: customer identity is unavailable';
  END IF;

  -- Permanent entitlement roles are always owned by this entitlement. A
  -- temporary role is owned only when an exact order-backed provenance row
  -- says this fulfillment established removal responsibility. This preserves
  -- roles that existed manually before fulfillment (remove_on_expiry=false).
  WITH exact_temp_grants AS MATERIALIZED (
    SELECT grant_row.id, grant_row.role_id
      FROM public.temp_role_grants AS grant_row
      JOIN public.orders AS paid_order
        ON paid_order.id = OLD.order_id
       AND paid_order.guild_id = OLD.guild_id
       AND paid_order.customer_id = OLD.customer_id
       AND paid_order.product_id = OLD.product_id
     WHERE grant_row.order_id = OLD.order_id
       AND grant_row.guild_id = OLD.guild_id
       AND grant_row.user_id = v_discord_id
       AND grant_row.source = 'commerce_purchase'
       AND grant_row.source_id = OLD.product_id::TEXT
       AND grant_row.grant_status IN ('pending', 'applied')
       AND grant_row.remove_on_expiry = true
       AND grant_row.duration_seconds IS NOT NULL
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
  ), role_values AS (
    SELECT permanent_role.value
      FROM pg_catalog.unnest(
        COALESCE(OLD.granted_role_ids, '{}'::TEXT[])
      ) AS permanent_role(value)
     WHERE permanent_role.value IS NOT NULL
       AND pg_catalog.btrim(permanent_role.value) <> ''
    UNION ALL
    SELECT exact_temp_grants.role_id
      FROM exact_temp_grants
  )
  SELECT COALESCE(
           (SELECT pg_catalog.array_agg(DISTINCT role_values.value ORDER BY role_values.value)
              FROM role_values),
           '{}'::TEXT[]
         ),
         COALESCE(
           (SELECT pg_catalog.array_agg(exact_temp_grants.id ORDER BY exact_temp_grants.id)
              FROM exact_temp_grants),
           '{}'::UUID[]
         )
    INTO v_role_ids, v_temp_role_grant_ids;

  IF pg_catalog.cardinality(v_role_ids) = 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.bot_action_queue (
    guild_id,
    action,
    payload,
    status
  ) VALUES (
    OLD.guild_id,
    'revoke_roles',
    pg_catalog.jsonb_build_object(
      'guild_id', OLD.guild_id,
      'discord_id', v_discord_id,
      'role_ids', pg_catalog.to_jsonb(v_role_ids),
      'temporary_role_grant_ids', pg_catalog.to_jsonb(v_temp_role_grant_ids),
      'reason', 'entitlement_' || NEW.status,
      'entitlement_id', OLD.id,
      'customer_id', OLD.customer_id,
      'order_id', OLD.order_id,
      'product_id', OLD.product_id,
      'source', 'entitlement_status_trigger'
    ),
    'pending'
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER commerce_entitlements_enqueue_role_revocation
  AFTER UPDATE OF status ON public.entitlements
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.commerce_enqueue_entitlement_role_revocation();

REVOKE ALL ON FUNCTION public.commerce_enqueue_entitlement_role_revocation()
  FROM PUBLIC, anon, authenticated, service_role;

-- The trigger above protects future live-to-terminal transitions. Seed a
-- durable revoke intent for exact paid entitlements that were already terminal
-- when this migration began; otherwise the application now correctly avoiding
-- direct Discord mutation would leave that legacy role without an outbox row.
-- A migration-scoped idempotency key makes an operator replay harmless, while
-- future reactivation/termination cycles still use ordinary NULL-key rows from
-- the trigger and are never suppressed by this one-time backfill.
INSERT INTO public.bot_action_queue (
  guild_id,
  action,
  payload,
  status,
  idempotency_key
)
SELECT entitlement.guild_id,
       'revoke_roles',
       pg_catalog.jsonb_build_object(
         'guild_id', entitlement.guild_id,
         'discord_id', customer.discord_id,
         'role_ids', pg_catalog.to_jsonb(grants.role_ids),
         'temporary_role_grant_ids', pg_catalog.to_jsonb(temp_grants.grant_ids),
         'reason', 'entitlement_' || entitlement.status,
         'entitlement_id', entitlement.id,
         'customer_id', entitlement.customer_id,
         'order_id', entitlement.order_id,
         'product_id', entitlement.product_id,
         'source', 'entitlement_terminal_migration_backfill'
       ),
       'pending',
       'commerce:terminal-entitlement:' || entitlement.id::TEXT || ':revoke_roles'
  FROM public.entitlements AS entitlement
  JOIN public.orders AS paid_order
    ON paid_order.id = entitlement.order_id
   AND paid_order.guild_id = entitlement.guild_id
   AND paid_order.customer_id = entitlement.customer_id
   AND paid_order.product_id = entitlement.product_id
  JOIN public.customers AS customer
    ON customer.id = entitlement.customer_id
   AND customer.guild_id = entitlement.guild_id
  CROSS JOIN LATERAL (
    SELECT pg_catalog.array_agg(DISTINCT role.value ORDER BY role.value) AS role_ids
      FROM (
        SELECT permanent_role.value
          FROM pg_catalog.unnest(
            COALESCE(entitlement.granted_role_ids, '{}'::TEXT[])
          ) AS permanent_role(value)
         WHERE permanent_role.value IS NOT NULL
           AND pg_catalog.btrim(permanent_role.value) <> ''
        UNION ALL
        SELECT grant_row.role_id
          FROM public.temp_role_grants AS grant_row
         WHERE grant_row.order_id = entitlement.order_id
           AND grant_row.guild_id = entitlement.guild_id
           AND grant_row.user_id = customer.discord_id
           AND grant_row.source = 'commerce_purchase'
           AND grant_row.source_id = entitlement.product_id::TEXT
           AND grant_row.grant_status IN ('pending', 'applied')
           AND grant_row.remove_on_expiry = true
           AND grant_row.duration_seconds IS NOT NULL
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
      ) AS role(value)
  ) AS grants
  CROSS JOIN LATERAL (
    SELECT COALESCE(
             pg_catalog.array_agg(grant_row.id ORDER BY grant_row.id),
             '{}'::UUID[]
           ) AS grant_ids
      FROM public.temp_role_grants AS grant_row
     WHERE grant_row.order_id = entitlement.order_id
       AND grant_row.guild_id = entitlement.guild_id
       AND grant_row.user_id = customer.discord_id
       AND grant_row.source = 'commerce_purchase'
       AND grant_row.source_id = entitlement.product_id::TEXT
       AND grant_row.grant_status IN ('pending', 'applied')
       AND grant_row.remove_on_expiry = true
       AND grant_row.duration_seconds IS NOT NULL
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
  ) AS temp_grants
 WHERE entitlement.status IN ('cancelled', 'expired', 'revoked')
   AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
   AND entitlement.guild_id IS NOT NULL
   AND entitlement.customer_id IS NOT NULL
   AND entitlement.order_id IS NOT NULL
   AND entitlement.product_id IS NOT NULL
   AND customer.discord_id IS NOT NULL
   AND pg_catalog.btrim(customer.discord_id) <> ''
   AND pg_catalog.cardinality(grants.role_ids) > 0
   AND (
     (entitlement.type = 'one_time' AND paid_order.amount_cents > 0)
     OR (
       entitlement.type = 'subscription'
       AND paid_order.paypal_subscription_id IS NOT NULL
       AND pg_catalog.btrim(paid_order.paypal_subscription_id) <> ''
     )
   )
   AND (
     entitlement.source = 'purchase'
     OR EXISTS (
       SELECT 1
         FROM public.payments AS payment
        WHERE payment.order_id = paid_order.id
           AND payment.customer_id = paid_order.customer_id
           AND payment.guild_id = paid_order.guild_id
           AND payment.amount_cents = paid_order.amount_cents
           AND payment.currency = paid_order.currency
           AND payment.status IN ('completed', 'refunded', 'reversed')
          AND payment.paypal_payment_id IS NOT NULL
          AND pg_catalog.btrim(payment.paypal_payment_id) <> ''
     )
   )
ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

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
  v_paid_order_id UUID;
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

  SELECT paid_order.id
    INTO v_paid_order_id
      FROM public.orders AS paid_order
      JOIN public.customers AS customer
        ON customer.id = paid_order.customer_id
       AND customer.guild_id = paid_order.guild_id
      JOIN public.entitlements AS entitlement
        ON entitlement.order_id = paid_order.id
       AND entitlement.guild_id = paid_order.guild_id
       AND entitlement.customer_id = paid_order.customer_id
       AND entitlement.product_id = paid_order.product_id
       AND entitlement.type = 'one_time'
       AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
       AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
     WHERE paid_order.id = p_order_id
       AND paid_order.guild_id = p_guild_id
       AND paid_order.product_id = p_product_id
       AND paid_order.status = 'completed'
       AND paid_order.amount_cents > 0
       AND paid_order.paypal_subscription_id IS NULL
       AND customer.discord_id = p_user_id
       AND paid_order.grant_snapshot_frozen_at IS NOT NULL
       AND public.commerce_valid_temp_role_snapshot(
         paid_order.temporary_role_grants_snapshot
       )
       AND EXISTS (
         SELECT 1
           FROM pg_catalog.jsonb_array_elements(
             paid_order.temporary_role_grants_snapshot
           ) AS frozen_grant(value)
          WHERE frozen_grant.value ->> 'role_id' = p_role_id
            AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
              = p_duration_seconds
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
                AND payment.currency = paid_order.currency
                AND payment.status = 'completed'
                AND payment.paypal_payment_id IS NOT NULL
                AND pg_catalog.btrim(payment.paypal_payment_id) <> ''
           )
         )
       )
     FOR SHARE OF paid_order, entitlement;

  IF v_paid_order_id IS NULL THEN
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
  p_exclude_grant_id UUID,
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
     OR p_role_id IS NULL OR pg_catalog.btrim(p_role_id) = '' THEN
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
     AND (p_exclude_grant_id IS NULL OR grant_row.id <> p_exclude_grant_id)
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
                  AND payment.currency = paid_order.currency
                  AND payment.status = 'completed'
                  AND payment.paypal_payment_id IS NOT NULL
                  AND pg_catalog.btrim(payment.paypal_payment_id) <> ''
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
  v_grant public.temp_role_grants%ROWTYPE;
  v_parent_status TEXT;
  v_entitlement_is_live BOOLEAN := false;
BEGIN
  IF p_grant_id IS NULL THEN
    RAISE EXCEPTION 'commerce_inspect_temp_role_grant: grant is required';
  END IF;

  SELECT grant_row,
         paid_order.status,
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
         )
    INTO v_grant, v_parent_status, v_entitlement_is_live
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
              AND payment.currency = paid_order.currency
              AND payment.status IN ('completed', 'refunded', 'reversed')
              AND payment.paypal_payment_id IS NOT NULL
              AND pg_catalog.btrim(payment.paypal_payment_id) <> ''
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

  IF v_grant.id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_grant.id,
    'guild_id', v_grant.guild_id,
    'user_id', v_grant.user_id,
    'role_id', v_grant.role_id,
    'expires_at', v_grant.expires_at,
    'duration_seconds', v_grant.duration_seconds,
    'grant_status', v_grant.grant_status,
    'remove_on_expiry', v_grant.remove_on_expiry,
    'applied_at', v_grant.applied_at,
    'order_id', v_grant.order_id,
    'parent_order_status', v_parent_status,
    'entitlement_is_live', v_entitlement_is_live
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
  v_grant public.temp_role_grants%ROWTYPE;
  v_applied_at TIMESTAMPTZ;
  v_paid_order_id UUID;
BEGIN
  IF p_grant_id IS NULL THEN
    RAISE EXCEPTION 'commerce_acknowledge_temp_role_grant: grant is required';
  END IF;

  SELECT grant_row.*
    INTO v_grant
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = p_grant_id
   FOR UPDATE;

  IF v_grant.id IS NULL
     OR v_grant.source <> 'commerce_purchase'
     OR v_grant.order_id IS NULL
     OR v_grant.duration_seconds IS NULL
     OR v_grant.duration_seconds <= 0
     OR v_grant.duration_seconds > 315360000 THEN
    RAISE EXCEPTION 'commerce_acknowledge_temp_role_grant: provenance identity mismatch';
  END IF;

  -- Lock and revalidate the exact paid parent before starting (or replaying)
  -- access. A refund/cancellation racing this transition either commits first
  -- and rejects acknowledgement, or waits for this transaction and then owns
  -- the subsequent revocation of the now-applied row.
  SELECT paid_order.id
    INTO v_paid_order_id
    FROM public.orders AS paid_order
    JOIN public.customers AS customer
      ON customer.id = paid_order.customer_id
     AND customer.guild_id = paid_order.guild_id
    JOIN public.entitlements AS entitlement
      ON entitlement.order_id = paid_order.id
     AND entitlement.guild_id = paid_order.guild_id
     AND entitlement.customer_id = paid_order.customer_id
     AND entitlement.product_id = paid_order.product_id
     AND entitlement.type = 'one_time'
     AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
     AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
   WHERE paid_order.id = v_grant.order_id
     AND paid_order.guild_id = v_grant.guild_id
     AND paid_order.product_id::TEXT = v_grant.source_id
     AND paid_order.status = 'completed'
     AND paid_order.amount_cents > 0
     AND paid_order.paypal_subscription_id IS NULL
     AND customer.discord_id = v_grant.user_id
     AND paid_order.grant_snapshot_frozen_at IS NOT NULL
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
              AND payment.currency = paid_order.currency
              AND payment.status = 'completed'
              AND payment.paypal_payment_id IS NOT NULL
              AND pg_catalog.btrim(payment.paypal_payment_id) <> ''
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
        WHERE frozen_grant.value ->> 'role_id' = v_grant.role_id
          AND (frozen_grant.value ->> 'duration_seconds')::INTEGER
            = v_grant.duration_seconds
     )
   FOR SHARE OF paid_order, entitlement;

  IF v_paid_order_id IS NULL THEN
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
  v_grant public.temp_role_grants%ROWTYPE;
  v_live_order_id UUID;
BEGIN
  SELECT grant_row.*
    INTO v_grant
    FROM public.temp_role_grants AS grant_row
   WHERE grant_row.id = p_grant_id
   FOR UPDATE;

  IF v_grant.id IS NULL
     OR v_grant.order_id IS NULL
     OR v_grant.expires_at IS DISTINCT FROM p_expected_expires_at
     OR v_grant.remove_on_expiry IS DISTINCT FROM p_expected_remove_on_expiry THEN
    RAISE EXCEPTION 'commerce_retire_temp_role_grant: provenance identity mismatch';
  END IF;

  IF v_grant.grant_status = 'removed'
     AND v_grant.source = 'commerce_reconciled' THEN
    RETURN pg_catalog.jsonb_build_object(
      'id', v_grant.id,
      'retired', true,
      'grant_status', v_grant.grant_status,
      'source', v_grant.source
    );
  END IF;

  IF v_grant.grant_status IS DISTINCT FROM p_expected_grant_status
     OR v_grant.grant_status NOT IN ('pending', 'applied')
     OR v_grant.source <> 'commerce_purchase' THEN
    RAISE EXCEPTION 'commerce_retire_temp_role_grant: lifecycle identity mismatch';
  END IF;

  SELECT paid_order.id
    INTO v_live_order_id
    FROM public.orders AS paid_order
    JOIN public.entitlements AS entitlement
      ON entitlement.order_id = paid_order.id
     AND entitlement.guild_id = paid_order.guild_id
     AND entitlement.customer_id = paid_order.customer_id
     AND entitlement.product_id = paid_order.product_id
     AND entitlement.type = 'one_time'
     AND entitlement.status IN ('active', 'pending', 'grace_period', 'suspended')
     AND (entitlement.source = 'purchase' OR entitlement.source IS NULL)
   WHERE paid_order.id = v_grant.order_id
     AND paid_order.guild_id = v_grant.guild_id
     AND paid_order.status = 'completed'
     AND (
       v_grant.grant_status = 'pending'
       OR v_grant.expires_at > pg_catalog.clock_timestamp()
     )
   FOR SHARE OF paid_order, entitlement;

  IF v_live_order_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'id', v_grant.id,
      'retired', false,
      'grant_status', v_grant.grant_status,
      'source', v_grant.source
    );
  END IF;

  UPDATE public.temp_role_grants
     SET grant_status = 'removed',
         source = 'commerce_reconciled',
         last_error = NULL,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_grant.id
  RETURNING * INTO v_grant;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_grant.id,
    'retired', true,
    'grant_status', v_grant.grant_status,
    'source', v_grant.source
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

  DELETE FROM public.mutes
   WHERE guild_id = p_guild_id AND active = true AND expires_at < now();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  result := result || jsonb_build_object('expired_mutes', cnt);

  DELETE FROM public.audit_logs
   WHERE guild_id = p_guild_id AND timestamp < now() - interval '90 days';
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

-- Restate trigger-helper lockdown after replacing the assertion function.
REVOKE ALL ON FUNCTION public.commerce_assert_income_wall_guild(TEXT)
  FROM PUBLIC, anon, authenticated;

COMMIT;
