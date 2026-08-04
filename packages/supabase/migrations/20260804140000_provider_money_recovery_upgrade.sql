BEGIN;
ALTER TABLE IF EXISTS public.commerce_provider_money_recovery
  ALTER COLUMN provider_resource_id DROP NOT NULL;
ALTER TABLE IF EXISTS public.commerce_provider_money_recovery
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS public.commerce_provider_money_recovery
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
ALTER TABLE IF EXISTS public.commerce_provider_money_recovery
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;
ALTER TABLE IF EXISTS public.commerce_provider_money_recovery
  ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE IF EXISTS public.commerce_provider_money_recovery
  ADD COLUMN IF NOT EXISTS leased_until timestamptz;
ALTER TABLE IF EXISTS public.commerce_provider_money_recovery
  DROP CONSTRAINT IF EXISTS commerce_provider_money_recovery_status_check;
ALTER TABLE IF EXISTS public.commerce_provider_money_recovery
  ADD CONSTRAINT commerce_provider_money_recovery_status_check
  CHECK (status IN ('pending','processing','refunded','resolved','manual_review'));
CREATE INDEX IF NOT EXISTS idx_provider_money_recovery_pending
  ON public.commerce_provider_money_recovery(status, next_retry_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_provider_money_recovery_leases
  ON public.commerce_provider_money_recovery(status, leased_until)
  WHERE status = 'processing';

CREATE OR REPLACE FUNCTION public.commerce_claim_provider_money_recovery(
  p_webhook_event_id text
)
RETURNS TABLE (
  webhook_event_id text,
  provider_resource_id text,
  provider_parent_id text,
  guild_id text,
  reason text,
  attempts integer,
  max_attempts integer,
  lease_token uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row public.commerce_provider_money_recovery%ROWTYPE;
  v_token uuid;
BEGIN
  IF p_webhook_event_id IS NULL OR p_webhook_event_id = ''
     OR p_webhook_event_id <> pg_catalog.btrim(p_webhook_event_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='provider recovery event id is invalid';
  END IF;
  SELECT recovery.* INTO v_row
    FROM public.commerce_provider_money_recovery AS recovery
   WHERE recovery.webhook_event_id = p_webhook_event_id
     AND (
       (recovery.status = 'pending'
        AND (recovery.next_retry_at IS NULL OR recovery.next_retry_at <= pg_catalog.clock_timestamp()))
       OR (recovery.status = 'processing'
           AND recovery.leased_until IS NOT NULL
           AND recovery.leased_until <= pg_catalog.clock_timestamp())
     )
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  v_token := pg_catalog.gen_random_uuid();
  UPDATE public.commerce_provider_money_recovery
     SET status = 'processing',
         lease_token = v_token,
         leased_until = pg_catalog.clock_timestamp() + interval '5 minutes',
         attempts = COALESCE(attempts, 0) + 1
   WHERE webhook_event_id = v_row.webhook_event_id;
  RETURN QUERY SELECT v_row.webhook_event_id, v_row.provider_resource_id,
    v_row.provider_parent_id, v_row.guild_id, v_row.reason,
    COALESCE(v_row.attempts, 0) + 1, COALESCE(v_row.max_attempts, 5), v_token;
END; $$;
REVOKE ALL ON FUNCTION public.commerce_claim_provider_money_recovery(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_claim_provider_money_recovery(text) TO service_role;
COMMIT;
