-- =============================================================================
-- Finding 1: atomic dedupe for paypal_reconciliation_mismatch operator alerts.
--
-- Nothing ever compared PayPal's records to ours. The bot's reconciliation
-- service reconciles entitlements against Discord roles, grace expiry, and
-- stale license sessions — it never touches PayPal — and POST
-- /api/reconciliation only enqueues a bot_action_queue row, which does nothing
-- when the bot is the broken thing. So a payment that succeeded at PayPal but
-- never landed in `payments` was invisible until a customer emailed.
--
-- A PayPal-truth pass now diffs the provider's transaction ledger against
-- `payments.paypal_payment_id` in both directions and raises this alert on any
-- divergence.
--
-- Unlike the per-event dispute/webhook alerts, this one is a STANDING
-- statement about the ledger as a whole, so the fence is per guild: each pass
-- refreshes the single open alert in place with the current divergence set,
-- and a clean pass resolves it. Without the index, two dashboard replicas
-- passing at the same instant could each insert one.
--
-- Same pattern as uniq_alerts_unresolved_paypal_webhook_verify_failure
-- (20260709240000): the racing loser's INSERT fails with 23505, which the
-- dashboard treats as dedupe success. Forward-only.
-- =============================================================================

-- Defensive cleanup so the unique index can build even if duplicate unresolved
-- rows already exist: keep the newest, resolve the rest. (This alert type first
-- ships with this change, so in practice it is a no-op.)
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY guild_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM public.alerts
  WHERE alert_type = 'paypal_reconciliation_mismatch'
    AND resolved = false
)
UPDATE public.alerts a
   SET resolved    = true,
       resolved_at = now(),
       updated_at  = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_paypal_reconciliation_mismatch
  ON public.alerts (guild_id)
  WHERE alert_type = 'paypal_reconciliation_mismatch' AND resolved = false;

-- The pass scans payments and completed orders over a rolling time window.
-- `payments` had no index on created_at at all, so that scan was a seq scan on
-- the money table on every pass.
CREATE INDEX IF NOT EXISTS idx_payments_created_at
  ON public.payments (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_status_created_at
  ON public.orders (status, created_at DESC);
