-- =============================================================================
-- Finding 6 — a licence-key product must always be able to deliver a key.
--
-- `POST /api/store/products` requires only (name, type, delivery_type,
-- price_cents) and never created a `product_license_config` row. The capture
-- webhook mints a key ONLY when that row exists:
--
--     const license = licenseConfig ? generateLicenseKey() : null;
--     (packages/dashboard/src/app/api/paypal/webhook/handlers.ts)
--
-- so a product with delivery_type = 'license_key' and no config row charged the
-- customer, granted the entitlement and the roles, and delivered no key. The
-- receipt DM then rendered `licenseKey: null` — a paid-for product silently
-- missing the only thing the customer bought.
--
-- The rail lives in the database rather than in the create route so the bad
-- state is UNREPRESENTABLE regardless of which writer creates the product:
-- the dashboard API, the bot, seed data, a future import path, or manual SQL.
-- An operator cannot end up selling a key-delivered product that cannot
-- deliver a key.
--
-- Three parts:
--   1. Auto-provision trigger on `products` — any row that is (or becomes)
--      delivery_type = 'license_key' gets a default `product_license_config`.
--      Every column of that table except the PK has a sane default
--      (portal_only, 3 devices, 300s heartbeat, 24h offline grace), so the
--      provisioned row is immediately deliverable.
--   2. Delete guard on `product_license_config` — the config cannot be removed
--      out from under a live licence-key product. (The FK cascade from a
--      product hard-delete still works: by then the parent row is gone.)
--   3. Backfill + operator alert — existing products already in the broken
--      state are repaired with those same defaults AND surfaced as a warning
--      alert per guild, listing the products, so the owner reviews the licence
--      settings instead of the fix happening silently.
--
-- Forward-only. Idempotent: re-running backfills nothing and raises no alert.
-- =============================================================================

BEGIN;

-- ── 0. Freeze the delivery decision with the sold order contract ────────────
--
-- product_license_config is mutable catalog state. Its mere continued
-- existence can never authorize a future key mint: a product may have changed
-- from license_key to file/link while the stale config row remained. The
-- delivery type is therefore copied onto the order at the exact null -> frozen
-- grant-snapshot transition, while commerce_freeze_order_grant_snapshot already
-- holds the product row/share lock and guild commerce lock.
--
-- Existing orders remain NULL deliberately. Reconstructing a historical sale
-- from today's product row would recreate the same stale-config bug in a
-- different column. Webhook code treats a NULL unstaged contract as manual
-- review, never as permission to mint.

-- checkout_active is fully populated/constrained by the next migration. It is
-- introduced here so this earlier trigger can distinguish a newly-created,
-- locally-recorded approval link from provider activation recovery. Recovery
-- rows deliberately remain false/NULL because today's catalog cannot recreate
-- an older provider sale.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS checkout_active BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_type_snapshot TEXT;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_delivery_type_snapshot_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_delivery_type_snapshot_check
  CHECK (
    delivery_type_snapshot IS NULL
    OR delivery_type_snapshot IN (
      'file',
      'link',
      'access_pass',
      'license_key',
      'mixed'
    )
  );

CREATE OR REPLACE FUNCTION public.commerce_freeze_order_delivery_contract()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery_type public.products.delivery_type%TYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.delivery_type_snapshot IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'order delivery contract can only be frozen after insert';
    END IF;

    IF NEW.checkout_active THEN
      SELECT product.delivery_type
        INTO v_delivery_type
        FROM public.products AS product
       WHERE product.id = NEW.product_id
         AND product.guild_id = NEW.guild_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'order delivery contract product identity mismatch';
      END IF;

      NEW.delivery_type_snapshot := v_delivery_type;
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.delivery_type_snapshot IS NOT NULL
     AND NEW.delivery_type_snapshot IS DISTINCT FROM OLD.delivery_type_snapshot THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order delivery contract is immutable after freeze';
  END IF;

  IF OLD.delivery_type_snapshot IS NULL
     AND NEW.delivery_type_snapshot IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order delivery contract cannot be supplied by the caller';
  END IF;

  IF OLD.grant_snapshot_frozen_at IS NULL
     AND NEW.grant_snapshot_frozen_at IS NOT NULL THEN
    SELECT product.delivery_type
      INTO v_delivery_type
      FROM public.products AS product
     WHERE product.id = NEW.product_id
       AND product.guild_id = NEW.guild_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'order delivery contract product identity mismatch';
    END IF;

    -- A NULL snapshot is the explicit legacy/manual-review contract: the
    -- checkout predates this column, so today's catalog must not reconstruct
    -- what it sold. New active checkouts cannot reach this state because the
    -- INSERT branch above always snapshots their delivery type.
    IF OLD.checkout_active
       AND OLD.delivery_type_snapshot IS NOT NULL
       AND OLD.delivery_type_snapshot IS DISTINCT FROM v_delivery_type THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'order delivery contract changed before grant freeze';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_freeze_order_delivery_contract()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_orders_freeze_delivery_contract ON public.orders;
CREATE TRIGGER commerce_orders_freeze_delivery_contract
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_freeze_order_delivery_contract();

-- ── 1. Auto-provision ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.commerce_provision_license_delivery_config()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.delivery_type = 'license_key' THEN
    INSERT INTO public.product_license_config (product_id)
    VALUES (NEW.id)
    ON CONFLICT (product_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_provision_license_delivery_config()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_products_provision_license_config ON public.products;
CREATE TRIGGER commerce_products_provision_license_config
  AFTER INSERT OR UPDATE OF delivery_type ON public.products
  FOR EACH ROW
  WHEN (NEW.delivery_type = 'license_key')
  EXECUTE FUNCTION public.commerce_provision_license_delivery_config();

-- ── 2. Delete guard ──────────────────────────────────────────────────────────
-- Deleting the config for a still-licence-key product would silently recreate
-- exactly the broken state this migration closes.

CREATE OR REPLACE FUNCTION public.commerce_protect_license_delivery_config()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- During a product hard-delete the FK cascade fires this AFTER the parent row
  -- is gone, so the EXISTS is false and the cascade proceeds normally.
  IF EXISTS (
    SELECT 1
      FROM public.products AS product
     WHERE product.id = OLD.product_id
       AND product.delivery_type = 'license_key'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'product_license_config cannot be removed while the product '
        || 'still delivers a licence key; change delivery_type first';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_protect_license_delivery_config()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_license_config_protect_delete ON public.product_license_config;
CREATE TRIGGER commerce_license_config_protect_delete
  BEFORE DELETE ON public.product_license_config
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_protect_license_delivery_config();

-- ── 3. Backfill already-broken products + surface them ───────────────────────
-- Repairing is the safe default (the alternative — leaving them unsellable —
-- breaks live commerce), but it must never be silent: every affected guild gets
-- a warning alert naming the products so the owner reviews device limits,
-- licence mode, and tier rather than inheriting defaults unknowingly.

WITH backfilled AS (
  INSERT INTO public.product_license_config (product_id)
  SELECT product.id
    FROM public.products AS product
   WHERE product.delivery_type = 'license_key'
     AND NOT EXISTS (
       SELECT 1
         FROM public.product_license_config AS config
        WHERE config.product_id = product.id
     )
  RETURNING product_id
), affected AS (
  SELECT product.guild_id AS guild_id,
         count(*) AS product_count,
         jsonb_agg(
           jsonb_build_object(
             'product_id', product.id,
             'product_name', product.name,
             'active', product.active
           )
           ORDER BY product.name, product.id
         ) AS products
    FROM backfilled
    JOIN public.products AS product
      ON product.id = backfilled.product_id
   WHERE product.guild_id IS NOT NULL
   GROUP BY product.guild_id
)
INSERT INTO public.alerts (guild_id, alert_type, severity, title, message, metadata)
SELECT affected.guild_id,
       'commerce_license_config_backfilled',
       'warning',
       'Licence-key products were missing licence settings',
       affected.product_count
         || ' product(s) set to deliver a licence key had no licence '
         || 'configuration, so a purchase could charge the customer and '
         || 'deliver no key. Default licence settings (portal-only, 3 '
         || 'devices) have been applied so they now deliver — review them in '
         || 'Store → Products.',
       jsonb_build_object(
         'source', 'migration:20260727040000',
         'product_count', affected.product_count,
         'products', affected.products
       )
  FROM affected;

-- ── 4. Surface every already-missed paid key ─────────────────────────────────
--
-- SQL cannot safely regenerate the plaintext: license_keys intentionally stores
-- only hash/prefix/suffix, while the durable fulfillment queue is the sole
-- at-rest carrier of plaintext for delivery. Minting here would create a key the
-- customer can never receive. Instead, create one exact critical work item per
-- affected paid order, requiring manual fulfillment or refund.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_missing_license_delivery
  ON public.alerts (guild_id, ((metadata ->> 'order_id')))
  WHERE alert_type = 'commerce_missing_license_delivery'
    AND resolved = false;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_unknown_delivery_contract
  ON public.alerts (guild_id, ((metadata ->> 'order_id')))
  WHERE alert_type = 'commerce_unknown_delivery_contract'
    AND resolved = false;

WITH affected_order AS (
  SELECT DISTINCT ON (paid_order.id)
         paid_order.id AS order_id,
         paid_order.order_number,
         paid_order.guild_id,
         paid_order.customer_id,
         paid_order.product_id,
         product.name AS product_name,
         entitlement.id AS entitlement_id
    FROM public.orders AS paid_order
    JOIN public.products AS product
      ON product.id = paid_order.product_id
     AND product.guild_id = paid_order.guild_id
    JOIN public.entitlements AS entitlement
      ON entitlement.order_id = paid_order.id
     AND entitlement.guild_id = paid_order.guild_id
     AND entitlement.customer_id = paid_order.customer_id
     AND entitlement.product_id = paid_order.product_id
   WHERE paid_order.status = 'completed'
     AND paid_order.guild_id IS NOT NULL
     AND paid_order.customer_id IS NOT NULL
     AND paid_order.product_id IS NOT NULL
     AND product.delivery_type = 'license_key'
     AND entitlement.status IN ('active', 'pending', 'grace_period')
     AND entitlement.license_key_id IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.license_keys AS license_key
        WHERE license_key.order_id = paid_order.id
     )
   ORDER BY paid_order.id, entitlement.created_at ASC, entitlement.id ASC
)
INSERT INTO public.alerts (
  guild_id,
  alert_type,
  severity,
  title,
  message,
  metadata
)
SELECT affected_order.guild_id,
       'commerce_missing_license_delivery',
       'critical',
       'Paid licence purchase is missing its key',
       'Completed order ' || affected_order.order_number || ' for '
         || affected_order.product_name || ' has live access but no licence '
         || 'key. Adding product settings now does not repair this purchase. '
         || 'Manually fulfil the exact order or refund the customer.',
       jsonb_build_object(
         'source', 'migration:20260727040000',
         'order_id', affected_order.order_id,
         'order_number', affected_order.order_number,
         'customer_id', affected_order.customer_id,
         'product_id', affected_order.product_id,
         'product_name', affected_order.product_name,
         'entitlement_id', affected_order.entitlement_id,
         'required_action', 'manual_fulfillment_or_refund'
       )
  FROM affected_order
 WHERE NOT EXISTS (
   SELECT 1
     FROM public.alerts AS existing_alert
    WHERE existing_alert.guild_id = affected_order.guild_id
      AND existing_alert.alert_type = 'commerce_missing_license_delivery'
      AND existing_alert.metadata ->> 'order_id' = affected_order.order_id::TEXT
 )
ON CONFLICT DO NOTHING;

COMMIT;
