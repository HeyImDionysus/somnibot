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
  p_occurrence_id UUID DEFAULT NULL,
  -- Round 30: the caller's claim-generation snapshot. A worker that stalled
  -- past the stale threshold can resume AFTER recovery reclaimed, reserved,
  -- sent, and settled this very occurrence; the idempotent marker fast-path
  -- then told it "your slot is paid" and it posted the SAME due minute a
  -- second time. When provided, the occurrence must still be 'claimed' with
  -- a MATCHING updated_at or the call returns -1: you no longer own this
  -- minute; do not send.
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claimed_count INTEGER;
  occ_result JSONB;
  occ_status TEXT;
  occ_updated_at TIMESTAMPTZ;
BEGIN
  IF p_occurrence_id IS NOT NULL THEN
    -- Serialize per occurrence: a sender that stalls past the stale
    -- threshold can resume AFTER recovery reclaimed this same occurrence and
    -- reserved its slot. Lock the occurrence row first; the marker check is
    -- then race-free with the marker write below, so one occurrence can
    -- never pay for two slots however many workers ask.
    SELECT o.result, o.status, o.updated_at
      INTO occ_result, occ_status, occ_updated_at
      FROM public.discord_operation_occurrences o
     WHERE o.id = p_occurrence_id
       FOR UPDATE;
    IF p_expected_updated_at IS NOT NULL
       AND (NOT FOUND
            OR occ_status IS DISTINCT FROM 'claimed'
            OR occ_updated_at IS DISTINCT FROM p_expected_updated_at) THEN
      -- Ownership check FIRST — before the marker fast-path can bless a
      -- stalled worker whose minute was reclaimed and already delivered.
      RETURN -1;
    END IF;
    IF FOUND AND COALESCE(occ_result->>'counterReserved', 'false') = 'true' THEN
      -- Idempotent success: THIS occurrence already owns a counter slot.
      SELECT s.current_sends INTO claimed_count
        FROM public.scheduled_messages s
       WHERE s.id = p_schedule_id
         AND s.guild_id = p_guild_id;
      RETURN claimed_count;
    END IF;
  END IF;

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
    -- Stamp unconditionally (the row is locked above): gating on
    -- status = 'claimed' could skip the marker after the counter committed,
    -- recreating the unmarked-slot corner this function exists to close.
    UPDATE public.discord_operation_occurrences
       SET result = COALESCE(result, '{}'::jsonb)
                    || pg_catalog.jsonb_build_object('counterReserved', true)
     WHERE id = p_occurrence_id;
  END IF;

  RETURN claimed_count;
END;
$$;

-- Older overloads must not linger: two resolvable signatures make
-- PostgREST RPC dispatch ambiguous.
DROP FUNCTION IF EXISTS public.claim_scheduled_message_send(UUID, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.claim_scheduled_message_send(UUID, TEXT, TIMESTAMPTZ, UUID);

REVOKE ALL ON FUNCTION public.claim_scheduled_message_send(UUID, TEXT, TIMESTAMPTZ, UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_message_send(UUID, TEXT, TIMESTAMPTZ, UUID, TIMESTAMPTZ)
  TO service_role;

COMMIT;
