-- Phase B: Commerce Reliability
-- Adds idempotency constraints, provider ID indexes, and reconciliation support.

-- ============================================================
-- B.1 — Unique provider ID indexes on orders
-- ============================================================
-- Prevent duplicate orders for the same PayPal order or subscription.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_paypal_order_id
  ON orders (paypal_order_id)
  WHERE paypal_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_paypal_subscription_id
  ON orders (paypal_subscription_id)
  WHERE paypal_subscription_id IS NOT NULL;

-- ============================================================
-- B.2 — Idempotency constraints
-- ============================================================
-- One entitlement per order (prevent duplicate fulfillment).
CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_order_id
  ON entitlements (order_id)
  WHERE order_id IS NOT NULL;

-- One license key per order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_license_keys_order_id
  ON license_keys (order_id)
  WHERE order_id IS NOT NULL;

-- Index for fast entitlement lookups by status (reconciliation).
CREATE INDEX IF NOT EXISTS idx_entitlements_status
  ON entitlements (status)
  WHERE status IN ('active', 'grace_period', 'pending');

-- Index for license session cleanup.
CREATE INDEX IF NOT EXISTS idx_license_sessions_active
  ON license_sessions (active, last_seen_at)
  WHERE active = true;

-- ============================================================
-- B.4 — Reconciliation tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'startup')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  findings JSONB DEFAULT '{}',
  fixes_applied JSONB DEFAULT '{}',
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_status
  ON reconciliation_runs (status, started_at DESC);

-- ============================================================
-- B.5 — License abuse tracking
-- ============================================================
-- Track failed validation attempts for abuse detection.
-- We use the existing license_validations table but add an index
-- for fast lookups of recent failures.
CREATE INDEX IF NOT EXISTS idx_license_validations_recent_failures
  ON license_validations (ip_address, created_at DESC)
  WHERE result != 'valid';

-- Add a column to track failed attempt counts on the key itself.
ALTER TABLE license_keys
  ADD COLUMN IF NOT EXISTS failed_attempts INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failed_at TIMESTAMPTZ;

-- Add device_policy to product_license_config.
-- 'evict_oldest' = current behavior, 'reject' = deny new device when at limit.
ALTER TABLE product_license_config
  ADD COLUMN IF NOT EXISTS device_policy TEXT DEFAULT 'evict_oldest'
    CHECK (device_policy IN ('evict_oldest', 'reject'));

-- ============================================================
-- Helper: generate order numbers from sequence
-- ============================================================
-- The sequence already exists from the initial schema.
-- Create a function to generate order numbers safely.
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TEXT AS $$
BEGIN
  RETURN 'ORD-' || LPAD(nextval('order_number_seq')::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;
