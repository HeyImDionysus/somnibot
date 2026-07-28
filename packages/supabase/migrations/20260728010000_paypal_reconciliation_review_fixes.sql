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

-- One database-owned state row serializes every global reconciliation trigger
-- (owner run-now, external scheduler, and in-process scheduler). Application
-- clocks are deliberately absent from this protocol.
CREATE TABLE IF NOT EXISTS public.paypal_reconciliation_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  state TEXT NOT NULL CHECK (state IN ('running', 'completed')),
  owner_token UUID,
  lease_expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT paypal_reconciliation_state_shape CHECK (
    (
      state = 'running'
      AND owner_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'completed'
      AND owner_token IS NULL
      AND lease_expires_at IS NULL
      AND completed_at IS NOT NULL
    )
  )
);

ALTER TABLE public.paypal_reconciliation_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.paypal_reconciliation_state
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.paypal_reconciliation_state TO service_role;

CREATE OR REPLACE FUNCTION public.paypal_reconcile_acquire(
  p_owner_token UUID,
  p_lease_seconds INTEGER,
  p_cooldown_seconds INTEGER,
  p_bypass_cooldown BOOLEAN DEFAULT false
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_state TEXT;
  v_lease_expires_at TIMESTAMPTZ;
  v_completed_at TIMESTAMPTZ;
BEGIN
  IF p_owner_token IS NULL
     OR p_lease_seconds IS NULL
     OR p_lease_seconds < 1
     OR p_lease_seconds > 86400
     OR p_cooldown_seconds IS NULL
     OR p_cooldown_seconds < 0
     OR p_cooldown_seconds > 604800
     OR p_bypass_cooldown IS NULL THEN
    RAISE EXCEPTION 'invalid PayPal reconciliation lease arguments'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.paypal_reconciliation_state (
    singleton,
    state,
    owner_token,
    lease_expires_at,
    completed_at,
    updated_at
  )
  VALUES (
    true,
    'running',
    p_owner_token,
    v_now + pg_catalog.make_interval(secs => p_lease_seconds),
    NULL,
    v_now
  )
  ON CONFLICT (singleton) DO NOTHING;

  IF FOUND THEN
    RETURN 'acquired';
  END IF;

  SELECT state, lease_expires_at, completed_at
    INTO v_state, v_lease_expires_at, v_completed_at
    FROM public.paypal_reconciliation_state
   WHERE singleton = true
   FOR UPDATE;
  -- The insert/select above can wait behind another transaction. Refresh only
  -- after the singleton row is locked so expiry and cooldown use current DB
  -- time rather than the time at which this contender began waiting.
  v_now := pg_catalog.clock_timestamp();

  IF v_state = 'running' AND v_lease_expires_at > v_now THEN
    RETURN 'busy';
  END IF;

  IF v_state = 'completed'
     AND NOT p_bypass_cooldown
     AND v_completed_at + pg_catalog.make_interval(secs => p_cooldown_seconds) > v_now THEN
    RETURN 'cooldown';
  END IF;

  UPDATE public.paypal_reconciliation_state
     SET state = 'running',
         owner_token = p_owner_token,
         lease_expires_at =
           v_now + pg_catalog.make_interval(secs => p_lease_seconds),
         completed_at = NULL,
         updated_at = v_now
   WHERE singleton = true;

  RETURN 'acquired';
END;
$$;

CREATE OR REPLACE FUNCTION public.paypal_reconcile_heartbeat(
  p_owner_token UUID,
  p_lease_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_updated INTEGER;
BEGIN
  IF p_owner_token IS NULL
     OR p_lease_seconds IS NULL
     OR p_lease_seconds < 1
     OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid PayPal reconciliation heartbeat arguments'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM public.paypal_reconciliation_state
   WHERE singleton = true
   FOR UPDATE;
  v_now := pg_catalog.clock_timestamp();

  UPDATE public.paypal_reconciliation_state
     SET lease_expires_at =
           v_now + pg_catalog.make_interval(secs => p_lease_seconds),
         updated_at = v_now
   WHERE singleton = true
     AND state = 'running'
     AND owner_token = p_owner_token
     AND lease_expires_at > v_now;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.paypal_reconcile_finalize(
  p_owner_token UUID,
  p_succeeded BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_updated INTEGER;
BEGIN
  IF p_owner_token IS NULL OR p_succeeded IS NULL THEN
    RAISE EXCEPTION 'invalid PayPal reconciliation finalization arguments'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM public.paypal_reconciliation_state
   WHERE singleton = true
   FOR UPDATE;
  v_now := pg_catalog.clock_timestamp();

  IF p_succeeded THEN
    UPDATE public.paypal_reconciliation_state
       SET state = 'completed',
           owner_token = NULL,
           lease_expires_at = NULL,
           completed_at = v_now,
           updated_at = v_now
     WHERE singleton = true
       AND state = 'running'
       AND owner_token = p_owner_token
       AND lease_expires_at > v_now;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated = 1;
  END IF;

  DELETE FROM public.paypal_reconciliation_state
   WHERE singleton = true
     AND state = 'running'
     AND owner_token = p_owner_token
     AND lease_expires_at > v_now;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.paypal_reconcile_acquire(
  UUID, INTEGER, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.paypal_reconcile_heartbeat(
  UUID, INTEGER
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.paypal_reconcile_finalize(
  UUID, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paypal_reconcile_acquire(
  UUID, INTEGER, INTEGER, BOOLEAN
) TO service_role;
GRANT EXECUTE ON FUNCTION public.paypal_reconcile_heartbeat(
  UUID, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.paypal_reconcile_finalize(
  UUID, BOOLEAN
) TO service_role;

COMMENT ON TABLE public.paypal_reconciliation_state IS
  'Singleton DB-clock owner fence for all global PayPal reconciliation triggers.';

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
