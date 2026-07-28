-- =============================================================================
-- PayPal review fixes: disputed-order compatibility and scheduler visibility.
--
-- A dispute is an operator/risk state, not a second settlement event. The
-- capture remains completed and live access remains intact until a refund or
-- reversal actually moves money. Three existing deferred child invariants,
-- however, referenced raw orders.status='completed', so changing the order to
-- 'disputed' could not commit once a capture, entitlement, or license existed.
--
-- Give those child constraints one stable parent-state key:
--   completed/disputed -> completed (settled money + live access compatible)
--   refunded           -> refunded  (terminal settlement compatible)
--
-- Existing rows are validated before commit. The table lock prevents a write
-- from entering between old-FK removal and new-FK installation.
-- =============================================================================

BEGIN;

LOCK TABLE
  public.orders,
  public.payments,
  public.entitlements,
  public.license_keys,
  public.alerts
IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS commerce_compatible_child_status TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN status IN ('completed', 'disputed') THEN 'completed'::TEXT
      WHEN status = 'refunded' THEN 'refunded'::TEXT
      ELSE NULL::TEXT
    END
  ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_commerce_payment_compatible_status
  ON public.orders (id, commerce_compatible_child_status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_commerce_access_compatible_status
  ON public.orders (
    id,
    guild_id,
    customer_id,
    product_id,
    commerce_compatible_child_status
  );

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS commerce_capture_payment_order_fk;
ALTER TABLE public.payments
  ADD CONSTRAINT commerce_capture_payment_order_fk
  FOREIGN KEY (order_id, commerce_required_order_status)
  REFERENCES public.orders (id, commerce_compatible_child_status)
  DEFERRABLE INITIALLY DEFERRED
  NOT VALID;

ALTER TABLE public.entitlements
  DROP CONSTRAINT IF EXISTS commerce_paid_live_entitlement_order_fk;
ALTER TABLE public.entitlements
  ADD CONSTRAINT commerce_paid_live_entitlement_order_fk
  FOREIGN KEY (
    order_id,
    guild_id,
    customer_id,
    product_id,
    commerce_required_order_status
  )
  REFERENCES public.orders (
    id,
    guild_id,
    customer_id,
    product_id,
    commerce_compatible_child_status
  )
  DEFERRABLE INITIALLY IMMEDIATE
  NOT VALID;

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
  REFERENCES public.orders (
    id,
    guild_id,
    customer_id,
    product_id,
    commerce_compatible_child_status
  )
  DEFERRABLE INITIALLY IMMEDIATE
  NOT VALID;

-- Do not ship an inspect-only NOT VALID fence. The migration must refuse to
-- commit if any pre-existing money/access child is incompatible.
ALTER TABLE public.payments
  VALIDATE CONSTRAINT commerce_capture_payment_order_fk;
ALTER TABLE public.entitlements
  VALIDATE CONSTRAINT commerce_paid_live_entitlement_order_fk;
ALTER TABLE public.license_keys
  VALIDATE CONSTRAINT commerce_live_license_order_fk;

-- Scheduler failures are standing per-guild alerts, just like ledger
-- divergences. Collapse any pre-index race duplicates before adding the fence.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY guild_id
           ORDER BY created_at DESC, id DESC
         ) AS row_rank
    FROM public.alerts
   WHERE alert_type = 'paypal_reconciliation_failure'
     AND resolved = false
)
UPDATE public.alerts AS alert
   SET resolved = true,
       resolved_at = now(),
       updated_at = now()
  FROM ranked
 WHERE alert.id = ranked.id
   AND ranked.row_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_paypal_reconciliation_failure
  ON public.alerts (guild_id)
  WHERE alert_type = 'paypal_reconciliation_failure' AND resolved = false;

COMMENT ON COLUMN public.orders.commerce_compatible_child_status IS
  'Stable parent key for settled capture and live-access FKs; disputes preserve completed compatibility until money is refunded/reversed.';

COMMIT;
