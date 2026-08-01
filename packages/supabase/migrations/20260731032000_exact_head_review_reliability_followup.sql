-- Exact-head reliability follow-up:
--   * lease approved mass-action executions to one live bot process;
--   * expose a bounded latest-download lookup for control-room sampling.
BEGIN;

ALTER TABLE public.automation_mass_action_holds
  ADD COLUMN IF NOT EXISTS execution_owner_token TEXT,
  ADD COLUMN IF NOT EXISTS execution_lease_expires_at TIMESTAMPTZ;

DROP FUNCTION IF EXISTS public.claim_approved_automation_mass_action_hold(UUID, TEXT);

CREATE FUNCTION public.claim_approved_automation_mass_action_hold(
  p_hold_id UUID,
  p_guild_id TEXT,
  p_owner_token TEXT DEFAULT NULL
)
RETURNS SETOF public.automation_mass_action_holds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.automation_mass_action_holds
     SET status = 'executing',
         execution_started_at = pg_catalog.now(),
         execution_owner_token = COALESCE(
           p_owner_token,
           extensions.gen_random_uuid()::TEXT
         ),
         execution_lease_expires_at = pg_catalog.now() + INTERVAL '2 minutes',
         last_error = NULL
   WHERE id = p_hold_id
     AND guild_id = p_guild_id
     AND status = 'approved'
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_approved_automation_mass_action_hold(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_approved_automation_mass_action_hold(UUID, TEXT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.renew_automation_mass_action_hold_lease(
  p_hold_id UUID,
  p_guild_id TEXT,
  p_owner_token TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  renewed BOOLEAN;
BEGIN
  UPDATE public.automation_mass_action_holds
     SET execution_lease_expires_at = pg_catalog.now() + INTERVAL '2 minutes'
   WHERE id = p_hold_id
     AND guild_id = p_guild_id
     AND status = 'executing'
     AND execution_owner_token = p_owner_token
     -- Review 3691834558: never revive an already-expired lease. Once expiry
     -- passes, the periodic recovery path may have failed the hold and another
     -- worker may own the occurrence; renewing here would let the old worker
     -- keep running a destructive bulk action it no longer owns.
     AND execution_lease_expires_at > pg_catalog.now();
  renewed := FOUND;
  RETURN renewed;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_automation_mass_action_hold_lease(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_automation_mass_action_hold_lease(UUID, TEXT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fail_stale_automation_mass_action_executions(
  p_guild_id TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  affected INTEGER;
BEGIN
  -- Round 20: fail the expired holds AND finalize their linked execution
  -- rows in the SAME statement. The engine only finalizes an execution after
  -- every held action completes, so a crash mid-run left the pre-action
  -- defaults and history read 'Conditions not met' for an approved hold that
  -- may already have changed members. The finalize is conditional on those
  -- exact defaults, so an execution finalized before the lease expired is
  -- preserved untouched.
  WITH failed_holds AS (
    UPDATE public.automation_mass_action_holds
       SET status = 'failed',
           completed_at = pg_catalog.now(),
           last_error =
             'Execution lease expired after work started. Some member actions may have completed; inspect the audit log before retrying manually.',
           execution_owner_token = NULL,
           execution_lease_expires_at = NULL
     WHERE guild_id = p_guild_id
       AND status = 'executing'
       AND execution_lease_expires_at IS NOT NULL
       AND execution_lease_expires_at < pg_catalog.now()
    RETURNING id, execution_id
  ), finalized AS (
    UPDATE public.automation_executions AS execution
       SET conditions_passed = TRUE,
           errors =
             '["Execution lease expired after work started; recovery failed the hold. Some member actions may have completed."]'::jsonb
      FROM failed_holds
     WHERE execution.id = failed_holds.execution_id
       AND execution.conditions_passed = FALSE
       AND execution.actions_executed = 0
       AND execution.actions_failed = 0
  )
  SELECT pg_catalog.count(*) INTO affected FROM failed_holds;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_stale_automation_mass_action_executions(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_stale_automation_mass_action_executions(TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_latest_commerce_download_deliveries(
  p_guild_id TEXT,
  p_order_ids UUID[]
)
RETURNS TABLE (
  id UUID,
  order_id UUID,
  customer_id UUID,
  product_id UUID,
  delivered_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT ON (delivery.order_id)
    delivery.id,
    delivery.order_id,
    delivery.customer_id,
    delivery.product_id,
    delivery.delivered_at
  FROM public.commerce_download_deliveries AS delivery
  WHERE delivery.guild_id = p_guild_id
    AND delivery.order_id = ANY(p_order_ids)
  ORDER BY delivery.order_id, delivery.delivered_at DESC, delivery.id DESC;
$$;

REVOKE ALL ON FUNCTION public.get_latest_commerce_download_deliveries(TEXT, UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_latest_commerce_download_deliveries(TEXT, UUID[])
  TO service_role;

COMMIT;
