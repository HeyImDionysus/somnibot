-- ============================================================
-- V9 — Close commerce schema gaps found by integration testing
-- ============================================================
--
-- 1. customers.total_orders  (missing column)
--    Every commerce system needs an order count alongside spend.
--    The column was assumed by the e2e test but never created.
--
-- 2. products.delivery_type  (constraint too narrow)
--    The check only allowed file | link | access_pass | mixed.
--    license_key is a real delivery mechanism used in the codebase
--    (the e2e flow generates and stores license keys), but the
--    constraint rejected it.
--
-- 3. increment_customer_totals  (order-count gap)
--    The RPC updated total_spent_cents and first_purchase_at but
--    never touched total_orders.  Now it increments both in one
--    atomic call.
-- ============================================================

-- ── 1. Add total_orders column ──────────────────────────────
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS total_orders INTEGER NOT NULL DEFAULT 0;

-- ── 2. Widen delivery_type constraint ───────────────────────
-- Drop the old CHECK and add a new one that includes license_key.
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_delivery_type_check;

ALTER TABLE public.products
  ADD CONSTRAINT products_delivery_type_check
  CHECK (delivery_type IN ('file', 'link', 'access_pass', 'license_key', 'mixed'));

-- ── 3. Rebuild increment_customer_totals ────────────────────
-- Drop the legacy INT overload (created in audit_v5_atomic_ops).
-- Having both (UUID, INT) and (UUID, NUMERIC) makes PostgREST
-- return PGRST203 "could not choose the best candidate".
-- We keep only the NUMERIC version.
DROP FUNCTION IF EXISTS public.increment_customer_totals(UUID, INT);

-- Now also bumps total_orders by 1.
CREATE OR REPLACE FUNCTION public.increment_customer_totals(
  p_customer_id UUID,
  p_amount NUMERIC
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'increment_customer_totals: amount must be positive, got %', p_amount;
  END IF;

  UPDATE public.customers
  SET total_spent_cents = COALESCE(total_spent_cents, 0) + p_amount,
      total_orders      = COALESCE(total_orders, 0) + 1,
      first_purchase_at = COALESCE(first_purchase_at, now()),
      updated_at        = now()
  WHERE id = p_customer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_customer_totals(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_customer_totals(UUID, NUMERIC) TO service_role;
