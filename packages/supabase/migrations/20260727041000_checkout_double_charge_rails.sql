-- =============================================================================
-- Finding 10 — a customer must not be able to pay twice for the same product.
--
-- Double-click "Buy" and each click created a separate PayPal order with its
-- own approval link. The already-purchased guard in the bot runs at click time
-- only. If the customer completed both PayPal flows, both captures succeeded:
-- the unique index is `idx_entitlements_order_id` on `order_id` (partial), NOT
-- on (customer_id, product_id), so two orders produced two entitlements, and
-- `handlePaymentCaptured` never re-checked for an existing entitlement.
--
-- This migration adds the first of the two rails: at most ONE in-flight
-- one-time checkout per (customer, product). The second click's order insert
-- fails with 23505 and the bot never exposes an approval link for it, so the
-- second PayPal order can never be approved.
--
-- ── Why the predicate is narrowed to `paypal_order_id IS NOT NULL` ───────────
-- Subscription activation has a RECOVERY path: when no order exists for a
-- PayPal subscription id, `handleSubscriptionActivated` inserts a pending order
-- itself (handlers.ts). That insert sets `paypal_subscription_id` and leaves
-- `paypal_order_id` NULL. Covering it here would mean a stale unrelated pending
-- order could make a REAL subscription activation fail with 23505 — turning a
-- captured payment into a hard webhook error. Never add a way for a real
-- capture to fail. One-time checkout — the exact path in this finding, where
-- `handlePaymentCaptured` mints the second entitlement — always sets
-- `paypal_order_id`, so the predicate covers it precisely.
--
-- Subscriptions are covered by the checkout-time pre-flight check in the bot
-- and by the capture-time entitlement re-check in the webhook.
--
-- Forward-only. Idempotent.
-- =============================================================================

BEGIN;

-- Defensive cleanup so the unique index can build on a database that already
-- carries duplicates: keep the NEWEST pending checkout per (customer, product)
-- and cancel the rest. The newest carries the freshest approval link; the older
-- ones are the hazard this index exists to prevent. If PayPal did somehow still
-- capture a cancelled order, `commerce_finalize_paypal_capture` raises
-- ('order is not pending and capture is unknown') and the event lands in the
-- failed-event table for operator retry — loud, never a silent mis-delivery.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY customer_id, product_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
    FROM public.orders
   WHERE status = 'pending'
     AND paypal_order_id IS NOT NULL
     AND customer_id IS NOT NULL
     AND product_id IS NOT NULL
)
UPDATE public.orders AS o
   SET status = 'cancelled',
       updated_at = now()
  FROM ranked AS r
 WHERE o.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_pending_one_time_checkout
  ON public.orders (customer_id, product_id)
  WHERE status = 'pending' AND paypal_order_id IS NOT NULL;

COMMIT;
