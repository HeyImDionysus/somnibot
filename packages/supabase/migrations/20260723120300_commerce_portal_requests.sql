-- =============================================================================
-- Fix: buyers have no self-service refund/service request path.
--
-- The commerce-portal catalog ships refund-requests-enabled and
-- service-requests-enabled (both default true), but there was no /api/portal
-- endpoint and no customer-facing request table — only the owner-driven
-- commerce_admin_refund_operations / payment_refunds state machines. Add a
-- customer-owned request queue the portal writes and the owner dashboard reads.
-- Filing a request NEVER mutates payments / orders / entitlements; it only
-- queues an owner decision.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.commerce_portal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('refund','service')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewing','resolved','rejected')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dedupe: at most one pending request per (customer, order, type) so a repeated
-- filing resolves to a single queued entry.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_portal_request
  ON public.commerce_portal_requests (customer_id, order_id, type)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_portal_requests_guild
  ON public.commerce_portal_requests (guild_id, status);

-- Owner-only, mirroring the v6 hardening on the other commerce tables: the
-- portal and dashboard reach this table only through the service-role admin
-- client. Direct anon/authenticated access is revoked.
ALTER TABLE public.commerce_portal_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_portal_requests FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY service_role_all ON public.commerce_portal_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public.commerce_portal_requests TO service_role;
