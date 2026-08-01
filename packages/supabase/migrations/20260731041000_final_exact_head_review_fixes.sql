-- Final exact-head reliability follow-up:
--   * CAS recovery for stale, unreferenced Discord creation claims.
--   * Freeze whether a sold order actually included a downloadable benefit.

BEGIN;

CREATE OR REPLACE FUNCTION public.reclaim_stale_discord_occurrence(
  p_occurrence_id UUID,
  p_guild_id TEXT,
  p_operation_kind TEXT,
  p_expected_updated_at TIMESTAMPTZ,
  p_stale_before TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reclaimed UUID;
BEGIN
  IF p_occurrence_id IS NULL
     OR p_guild_id IS NULL
     OR pg_catalog.btrim(p_guild_id) = ''
     OR p_operation_kind NOT IN ('scheduled_message', 'temp_channel', 'ticket')
     OR p_expected_updated_at IS NULL
     OR p_stale_before IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'reclaim_stale_discord_occurrence: complete claim identity is required';
  END IF;

  -- Round 22: lock-then-check. A single UPDATE's NOT EXISTS subqueries run
  -- against the statement snapshot, so an ownership insert committing while
  -- this statement waited on the row lock was never seen. Locking the
  -- occurrence row FIRST serializes against the ownership RPCs (which take
  -- the same lock before inserting); the ownership checks then run as NEW
  -- statements whose snapshots postdate any insert that won the lock race.
  SELECT occurrence.id INTO v_reclaimed
    FROM public.discord_operation_occurrences AS occurrence
   WHERE occurrence.id = p_occurrence_id
     AND occurrence.guild_id = p_guild_id
     AND occurrence.operation_kind = p_operation_kind
     AND occurrence.status = 'claimed'
     AND occurrence.updated_at = p_expected_updated_at
     AND occurrence.claimed_at < p_stale_before
   FOR UPDATE;

  IF v_reclaimed IS NULL THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.active_temp_channels AS active
     WHERE active.creation_occurrence_id = v_reclaimed
  ) OR EXISTS (
    SELECT 1
      FROM public.tickets AS ticket
     WHERE ticket.creation_occurrence_id = v_reclaimed
  ) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.discord_operation_occurrences
     SET claimed_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp(),
         last_error = NULL
   WHERE id = v_reclaimed;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.reclaim_stale_discord_occurrence(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_discord_occurrence(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS download_required_snapshot BOOLEAN;

-- Historical file/link contracts are unambiguous. Historical mixed contracts
-- remain unknown because today's mutable file catalog is not order-time
-- evidence. All newly created checkout rows are frozen by the trigger below.
UPDATE public.orders AS sold_order
   SET download_required_snapshot = CASE
     WHEN sold_order.delivery_type_snapshot IN ('file', 'link') THEN true
     WHEN sold_order.delivery_type_snapshot = 'mixed' THEN NULL
     ELSE false
   END
 WHERE sold_order.download_required_snapshot IS NULL;

CREATE OR REPLACE FUNCTION public.commerce_freeze_order_download_requirement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requires_download BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.download_required_snapshot IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'order download contract cannot be supplied by the caller';
    END IF;

    IF NEW.checkout_active THEN
      v_requires_download := CASE
        WHEN NEW.delivery_type_snapshot IN ('file', 'link') THEN true
        WHEN NEW.delivery_type_snapshot = 'mixed' THEN EXISTS (
          SELECT 1
            FROM public.product_files AS product_file
           WHERE product_file.product_id = NEW.product_id
             AND (
               product_file.file_path IS NOT NULL
               OR product_file.external_url IS NOT NULL
             )
        )
        ELSE false
      END;
      NEW.download_required_snapshot := v_requires_download;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.download_required_snapshot IS NOT NULL
     AND NEW.download_required_snapshot IS DISTINCT FROM OLD.download_required_snapshot THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order download contract is immutable after freeze';
  END IF;

  IF OLD.download_required_snapshot IS NULL
     AND NEW.download_required_snapshot IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order download contract cannot be supplied by the caller';
  END IF;

  IF OLD.grant_snapshot_frozen_at IS NULL
     AND NEW.grant_snapshot_frozen_at IS NOT NULL
     AND NEW.download_required_snapshot IS NULL THEN
    v_requires_download := CASE
      WHEN NEW.delivery_type_snapshot IN ('file', 'link') THEN true
      WHEN NEW.delivery_type_snapshot = 'mixed' THEN EXISTS (
        SELECT 1
          FROM public.product_files AS product_file
         WHERE product_file.product_id = NEW.product_id
           AND (
             product_file.file_path IS NOT NULL
             OR product_file.external_url IS NOT NULL
           )
      )
      ELSE false
    END;
    NEW.download_required_snapshot := v_requires_download;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_freeze_order_download_requirement()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS commerce_orders_freeze_download_requirement ON public.orders;
CREATE TRIGGER commerce_orders_freeze_download_requirement
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_freeze_order_download_requirement();

COMMIT;
