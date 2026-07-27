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
         || 'configuration, so every purchase charged the customer and '
         || 'delivered no key. Default licence settings (portal-only, 3 '
         || 'devices) have been applied so they now deliver — review them in '
         || 'Store → Products.',
       jsonb_build_object(
         'source', 'migration:20260727010000',
         'product_count', affected.product_count,
         'products', affected.products
       )
  FROM affected;

COMMIT;
