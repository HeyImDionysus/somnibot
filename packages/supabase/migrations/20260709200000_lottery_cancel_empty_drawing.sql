-- Atomic "no entries" cancellation, serialized with ticket sales.
--
-- Defect (codex review round 2, PR #266): the scheduler's no-entries reset
-- was a bot-side two-step — probe economy_lottery_tickets for emptiness,
-- then UPDATE the drawing to 'cancelled' in a separate statement. A
-- /lottery buy could acquire the drawing row lock AFTER the probe returned
-- zero rows but BEFORE the cancel committed: lottery_buy_tickets still saw
-- status='active', inserted tickets and charged coins into a drawing that
-- was cancelled an instant later — the buyer lost coins with no refund path.
--
-- Fix: perform the status check, the emptiness check and the cancellation
-- in ONE transaction under SELECT ... FOR UPDATE on the drawing row. That
-- serialises the reset against lottery_buy_tickets (which locks the same
-- row): either the buy commits first and this function sees the tickets
-- ('has_tickets' — the scheduler leaves the drawing for the next draw
-- tick), or the cancel commits first and the buy's post-lock status guard
-- (20260709190000) rejects with 'is not active' and the bot refunds.
--
-- Returns a typed outcome the bot maps explicitly:
--   'cancelled'   — this call cancelled the (empty, active) drawing;
--                   the caller may announce the reset.
--   'has_tickets' — the drawing is active but has entries; never cancel.
--   'not_active'  — missing, claimed ('drawing'), finalised ('drawn') or
--                   already cancelled; another path owns this row.

CREATE OR REPLACE FUNCTION lottery_cancel_drawing_if_empty(
  p_drawing_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status TEXT;
  v_has_tickets BOOLEAN;
BEGIN
  -- Lock the drawing row: lottery_buy_tickets and lottery_claim_drawing
  -- take FOR UPDATE on this same row, so the checks below cannot interleave
  -- with a concurrent purchase or claim.
  SELECT d.status INTO v_status
    FROM public.economy_lottery_drawings d
   WHERE d.id = p_drawing_id
     FOR UPDATE;

  IF NOT FOUND OR v_status <> 'active' THEN
    RETURN 'not_active';
  END IF;

  -- Emptiness check under the lock: a buy that already committed is visible
  -- here; a buy still waiting on the row lock will re-check status after we
  -- commit and be rejected by the 20260709190000 guard.
  SELECT EXISTS (
    SELECT 1
      FROM public.economy_lottery_tickets t
     WHERE t.drawing_id = p_drawing_id
  ) INTO v_has_tickets;

  IF v_has_tickets THEN
    RETURN 'has_tickets';
  END IF;

  UPDATE public.economy_lottery_drawings d
     SET status   = 'cancelled',
         drawn_at = now()
   WHERE d.id = p_drawing_id;

  RETURN 'cancelled';
END;
$$;

REVOKE ALL ON FUNCTION lottery_cancel_drawing_if_empty(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION lottery_cancel_drawing_if_empty(UUID) TO service_role;
