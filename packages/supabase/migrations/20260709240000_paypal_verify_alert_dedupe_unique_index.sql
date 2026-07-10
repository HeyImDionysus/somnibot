-- =============================================================================
-- W2: atomic dedupe for paypal_webhook_verify_failure operator alerts.
--
-- POST /api/paypal/webhook now raises an operator alert (alert_type =
-- 'paypal_webhook_verify_failure') when signature-verification
-- INFRASTRUCTURE (PayPal token fetch / verify-webhook-signature API) keeps
-- failing after in-request retries and the route responds 503 so PayPal
-- redelivers. During a PayPal outage every delivery attempt hits this path
-- concurrently across dashboard instances, so the dedupe cannot be
-- check-then-insert in application code.
--
-- Fix: partial unique index — at most ONE unresolved
-- paypal_webhook_verify_failure alert per guild, enforced by the database.
-- Scoped to this alert type and resolved = false, so other alert types and
-- resolved history rows are unaffected. Same pattern as
-- uniq_alerts_unresolved_fraud_check_failure (20260709170000): the racing
-- loser's INSERT fails with 23505, which the dashboard treats as dedupe
-- success. Forward-only.
-- =============================================================================

-- Defensive cleanup so the unique index can build even if duplicate
-- unresolved rows already exist: keep the newest, resolve the rest.
-- (alert_type 'paypal_webhook_verify_failure' first ships with this PR,
-- so in practice this is a no-op.)
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY guild_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM public.alerts
  WHERE alert_type = 'paypal_webhook_verify_failure'
    AND resolved = false
)
UPDATE public.alerts a
   SET resolved    = true,
       resolved_at = now(),
       updated_at  = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_paypal_webhook_verify_failure
  ON public.alerts (guild_id)
  WHERE alert_type = 'paypal_webhook_verify_failure' AND resolved = false;
