-- =============================================================================
-- Owner review for customer portal requests.
--
-- `commerce_portal_requests` (20260723120300) gave buyers a self-service way to
-- ask for a refund or support. Customers could file; **nothing ever read the
-- queue.** Every request has sat at status 'pending' since the table shipped,
-- with no owner surface, no decision, and no way to tell the buyer anything.
-- A request queue nobody reads is worse than no queue: it looks like asking
-- works.
--
-- These columns are what a decision needs to be reviewable and communicable:
--   * who decided, when, and why (reviewer_id / decided_at / resolution_note);
--   * whether the buyer has actually been TOLD (customer_notified), as a latch,
--     following the appeals table's decision_notified discipline — so a
--     redelivered notifier cannot DM twice, and a failed DM stays visible as
--     undelivered work rather than being silently lost.
--
-- A decision NEVER mutates payments, orders or entitlements. Refunds run
-- through the existing commerce_admin_refund_operations state machine; this
-- queue records the human decision and nothing else.
-- =============================================================================

BEGIN;

ALTER TABLE public.commerce_portal_requests
  ADD COLUMN IF NOT EXISTS reviewer_id       text,
  ADD COLUMN IF NOT EXISTS resolution_note   text,
  ADD COLUMN IF NOT EXISTS decided_at        timestamptz,
  ADD COLUMN IF NOT EXISTS customer_notified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.commerce_portal_requests.reviewer_id IS
  'Discord id of the owner/staff member who decided this request.';
COMMENT ON COLUMN public.commerce_portal_requests.resolution_note IS
  'Owner-written explanation shown to the customer with the decision.';
COMMENT ON COLUMN public.commerce_portal_requests.decided_at IS
  'When the request left pending/reviewing. NULL while still undecided.';
COMMENT ON COLUMN public.commerce_portal_requests.customer_notified IS
  'Latch: true once the decision has actually been delivered to the buyer. '
  'Prevents a redelivered notifier from DMing twice, and keeps a failed '
  'delivery visible as outstanding work.';

-- The notifier sweeps for decided-but-undelivered requests. Partial so the
-- index stays small no matter how much history accumulates.
CREATE INDEX IF NOT EXISTS idx_portal_requests_undelivered
  ON public.commerce_portal_requests (guild_id, decided_at)
  WHERE customer_notified = false AND decided_at IS NOT NULL;

-- A decided request must carry its decision metadata, and an undecided one must
-- not pretend to have any. NOT VALID + VALIDATE keeps the lock short; existing
-- rows are all 'pending' with NULL decided_at, so they satisfy it already.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'portal_requests_decision_coherent'
  ) THEN
    ALTER TABLE public.commerce_portal_requests
      ADD CONSTRAINT portal_requests_decision_coherent
      CHECK (
        (status IN ('pending', 'reviewing') AND decided_at IS NULL)
        OR (status IN ('resolved', 'rejected') AND decided_at IS NOT NULL)
      ) NOT VALID;
    ALTER TABLE public.commerce_portal_requests
      VALIDATE CONSTRAINT portal_requests_decision_coherent;
  END IF;
END $$;

COMMIT;
