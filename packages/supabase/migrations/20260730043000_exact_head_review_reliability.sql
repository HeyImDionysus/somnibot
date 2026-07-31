BEGIN;

-- Record the real deployment cutover for customer-specific download evidence.
-- A migration filename is only an ordering key; now() is the actual instant
-- from which the control room can require ledger evidence without inventing
-- false stuck orders.
INSERT INTO public.instance_settings (key, value, section, updated_at)
VALUES (
  'commerce_download_ledger_available_at',
  pg_catalog.now()::TEXT,
  'commerce',
  pg_catalog.now()
)
ON CONFLICT (key) DO NOTHING;

-- Preserve immutable delivery history when an owner removes a product file.
-- Existing installations of 031000 used ON DELETE CASCADE; fresh installs
-- already receive SET NULL from that migration, so this is idempotent.
ALTER TABLE public.commerce_download_deliveries
  ADD COLUMN IF NOT EXISTS file_name_snapshot TEXT;

UPDATE public.commerce_download_deliveries AS delivery
   SET file_name_snapshot = file.name
  FROM public.product_files AS file
 WHERE delivery.file_id = file.id
   AND delivery.file_name_snapshot IS NULL;

ALTER TABLE public.commerce_download_deliveries
  ALTER COLUMN file_id DROP NOT NULL;
ALTER TABLE public.commerce_download_deliveries
  DROP CONSTRAINT IF EXISTS commerce_download_deliveries_file_id_fkey;
ALTER TABLE public.commerce_download_deliveries
  ADD CONSTRAINT commerce_download_deliveries_file_id_fkey
  FOREIGN KEY (file_id)
  REFERENCES public.product_files(id)
  ON DELETE SET NULL;

-- Reserve a scheduled-message send slot under a row lock. Distinct due
-- occurrences can both own valid Discord fences, so the per-schedule maximum
-- must be enforced against the current row rather than a stale loaded copy.
CREATE OR REPLACE FUNCTION public.claim_scheduled_message_send(
  p_schedule_id UUID,
  p_guild_id TEXT,
  p_occurrence_at TIMESTAMPTZ,
  -- Review 3691834553: the counter reservation and its occurrence marker must
  -- commit ATOMICALLY. A separate best-effort marker write could fail after
  -- the counter committed; the crashed minute then looked unreserved to stale
  -- recovery, which reserved a SECOND slot (inflating current_sends) or, on
  -- an exhausted schedule, skipped a paid-but-undelivered occurrence.
  p_occurrence_id UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claimed_count INTEGER;
BEGIN
  UPDATE public.scheduled_messages
     SET current_sends = current_sends + 1,
         last_sent_at = GREATEST(
           COALESCE(last_sent_at, '-infinity'::TIMESTAMPTZ),
           p_occurrence_at
         )
   WHERE id = p_schedule_id
     AND guild_id = p_guild_id
     AND active = TRUE
     AND status = 'active'
     AND (max_sends IS NULL OR current_sends < max_sends)
  RETURNING current_sends INTO claimed_count;

  IF claimed_count IS NOT NULL AND p_occurrence_id IS NOT NULL THEN
    UPDATE public.discord_operation_occurrences
       SET result = COALESCE(result, '{}'::jsonb)
                    || pg_catalog.jsonb_build_object('counterReserved', true)
     WHERE id = p_occurrence_id
       AND status = 'claimed';
  END IF;

  RETURN claimed_count;
END;
$$;

-- The 3-arg overload from the original definition must not linger: two
-- resolvable signatures make PostgREST RPC dispatch ambiguous.
DROP FUNCTION IF EXISTS public.claim_scheduled_message_send(UUID, TEXT, TIMESTAMPTZ);

REVOKE ALL ON FUNCTION public.claim_scheduled_message_send(UUID, TEXT, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_message_send(UUID, TEXT, TIMESTAMPTZ, UUID)
  TO service_role;

COMMIT;
