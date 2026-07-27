-- =============================================================================
-- Finding 2: atomic dedupe for paypal_webhook_processing_error operator alerts.
--
-- POST /api/paypal/webhook now raises an operator alert (alert_type =
-- 'paypal_webhook_processing_error') on every path that writes
-- webhook_events.result = 'error'. Before this, a failed event was silent:
-- PayPal's redelivery of a non-resumable failed event gets HTTP 200
-- ('failed_requires_manual_replay'), so PayPal stops retrying and nobody is
-- told the payment never landed.
--
-- The dedupe fence is per FAILING EVENT, not per guild: two different stuck
-- events are two different stuck payments and the operator must see both.
-- Repeated failures of the SAME event (PayPal redelivery, dashboard replay)
-- refresh the one open alert in place.
--
-- Racing dashboard instances can hit this concurrently, so the dedupe cannot
-- be check-then-insert in application code. Partial unique index — at most ONE
-- unresolved paypal_webhook_processing_error alert per (guild, event_id).
-- Scoped to this alert type and resolved = false, so other alert types and
-- resolved history rows are unaffected. Same pattern as
-- uniq_alerts_unresolved_paypal_webhook_verify_failure (20260709240000): the
-- racing loser's INSERT fails with 23505, which the dashboard treats as dedupe
-- success. Forward-only.
-- =============================================================================

-- Defensive cleanup so the unique index can build even if duplicate unresolved
-- rows already exist: keep the newest, resolve the rest. (alert_type
-- 'paypal_webhook_processing_error' first ships with this change, so in
-- practice this is a no-op.)
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY guild_id, (metadata->>'event_id')
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM public.alerts
  WHERE alert_type = 'paypal_webhook_processing_error'
    AND resolved = false
    AND metadata->>'event_id' IS NOT NULL
)
UPDATE public.alerts a
   SET resolved    = true,
       resolved_at = now(),
       updated_at  = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_paypal_webhook_processing_error
  ON public.alerts (guild_id, (metadata->>'event_id'))
  WHERE alert_type = 'paypal_webhook_processing_error'
    AND resolved = false
    AND metadata->>'event_id' IS NOT NULL;
