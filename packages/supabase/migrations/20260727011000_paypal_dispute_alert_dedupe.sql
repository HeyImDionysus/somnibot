-- =============================================================================
-- Finding 9: atomic dedupe for dispute / denied-capture operator alerts.
--
-- CUSTOMER.DISPUTE.* used to fall through the webhook route's `default:`
-- branch, log "Unhandled event", and then take the SUCCESS path — a chargeback
-- was literally recorded as webhook_events.result = 'success'. Meanwhile
-- orders.status has always allowed 'disputed' and nothing ever set it, and
-- PAYMENT.CAPTURE.DENIED was not in the handled-event catalog at all, so a
-- denied capture left the order 'pending' forever with no alert.
--
-- The route now handles both and raises operator alerts. The dedupe fence is
-- per DISPUTE and per CAPTURE, not per guild: two chargebacks are two separate
-- amounts of money at risk and the operator must see both. Repeated deliveries
-- of the same dispute (CREATED -> UPDATED -> UPDATED ...) refresh the single
-- open alert in place, so a long-running case is one row, not a stream.
--
-- Racing dashboard instances can process a redelivery concurrently, so the
-- dedupe cannot be check-then-insert in application code. Partial unique
-- indexes, scoped to the alert type and resolved = false, so other alert types
-- and resolved history rows are unaffected. Same pattern as
-- uniq_alerts_unresolved_paypal_webhook_verify_failure (20260709240000): the
-- racing loser's INSERT fails with 23505, which the dashboard treats as dedupe
-- success. Forward-only.
-- =============================================================================

-- Defensive cleanup so the unique indexes can build even if duplicate
-- unresolved rows already exist: keep the newest, resolve the rest. Both alert
-- types first ship with this change, so in practice these are no-ops.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY guild_id, (metadata->>'dispute_id')
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM public.alerts
  WHERE alert_type = 'paypal_dispute'
    AND resolved = false
    AND metadata->>'dispute_id' IS NOT NULL
)
UPDATE public.alerts a
   SET resolved    = true,
       resolved_at = now(),
       updated_at  = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_paypal_dispute
  ON public.alerts (guild_id, (metadata->>'dispute_id'))
  WHERE alert_type = 'paypal_dispute'
    AND resolved = false
    AND metadata->>'dispute_id' IS NOT NULL;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY guild_id, (metadata->>'capture_id')
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM public.alerts
  WHERE alert_type = 'paypal_capture_denied'
    AND resolved = false
    AND metadata->>'capture_id' IS NOT NULL
)
UPDATE public.alerts a
   SET resolved    = true,
       resolved_at = now(),
       updated_at  = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_paypal_capture_denied
  ON public.alerts (guild_id, (metadata->>'capture_id'))
  WHERE alert_type = 'paypal_capture_denied'
    AND resolved = false
    AND metadata->>'capture_id' IS NOT NULL;
