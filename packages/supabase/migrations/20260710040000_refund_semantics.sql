-- =============================================================================
-- W2 [commerce]: differentiated refund semantics for the PayPal webhook.
--
-- 1. payment_refunds — one row per PayPal refund/reversal event applied to a
--    payment. The unique index on paypal_refund_id makes refund processing
--    idempotent at the database across replayed webhooks, resumed failed
--    retries, and concurrent instances (insert + tolerate 23505 — same
--    pattern as uniq_alerts_unresolved_fraud_check_failure, 20260709170000).
--    SUM(amount_cents) per payment is the locally recorded cumulative
--    refunded total used to distinguish PARTIAL refunds (flag for operator
--    review, keep access) from FULL refunds (revoke entitlements, license
--    keys, sessions, Discord roles).
--
-- 2. Partial unique index on alerts for the partial-refund review alert:
--    at most one alert per PayPal refund id, so a replayed/resumed webhook
--    cannot spam the operator (the losing INSERT gets 23505 = dedupe
--    success).
--
-- RLS posture mirrors 20260709230000_bot_action_queue_rls_lockdown.sql:
-- deny by default, service_role only. The only reader/writer is the
-- dashboard PayPal webhook route via createAdminSupabase (service key);
-- no browser or bot access exists. Forward-only.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.payment_refunds (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id       UUID NOT NULL REFERENCES public.payments(id),
  order_id         UUID REFERENCES public.orders(id),
  guild_id         TEXT REFERENCES public.guild(id),
  paypal_refund_id TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  -- NULL = the refund amount was missing/unparseable in the webhook payload
  -- (the handler treats that case as a FULL refund, fail-safe).
  amount_cents     INTEGER,
  currency         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payment_refunds_paypal_refund_id
  ON public.payment_refunds (paypal_refund_id);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_payment
  ON public.payment_refunds (payment_id);

ALTER TABLE public.payment_refunds ENABLE ROW LEVEL SECURITY;

-- Deny by default: no client-facing role gets table privileges.
REVOKE ALL ON public.payment_refunds FROM PUBLIC, anon, authenticated;

-- Explicit service_role-only policy. service_role bypasses RLS in Supabase,
-- but the explicit policy documents intent and keeps the table usable if
-- BYPASSRLS were ever removed from the role.
DROP POLICY IF EXISTS "service_role_full_access" ON public.payment_refunds;
CREATE POLICY "service_role_full_access" ON public.payment_refunds
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON public.payment_refunds TO service_role;

-- At most one partial-refund review alert per PayPal refund id. Replayed or
-- resumed webhook deliveries re-attempt the INSERT and are deduped by 23505.
-- (NULL refund ids — a defensive case for payloads missing resource.id — are
-- not deduped by this index; the route-level webhook_events dedup still
-- covers PayPal-originated redeliveries for those.)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_partial_refund_review_refund_id
  ON public.alerts ((metadata->>'paypal_refund_id'))
  WHERE alert_type = 'partial_refund_review';
