-- Heist crash-stranded late-join reconciliation — the last unsettled-fee gap.
--
-- Defect (codex, money-integrity crash-recovery): heist_settle_missed_join is
-- the ONLY thing that reconciles a /heist join whose participant row raced past
-- the atomic claim (claimed_at IS NULL, entry fee already debited), and it is
-- called ONLY inline from joinHeist AFTER the debit + insert. If the bot crashes
-- in that window — the fee is charged and the row is inserted, but joinHeist
-- never reaches its heist_settle_missed_join call — the stranded row survives
-- with claimed_at = NULL and paid_at = NULL. On restart resumePendingHeists →
-- resolveHeist settles ONLY the frozen crew (claimed_at IS NOT NULL), so that
-- row is invisible: the heist finalizes success/failed/cancelled and the late
-- joiner is neither paid nor refunded — the entry fee is stranded forever (no
-- terminal heist is ever revisited).
--
-- Fix: a bulk, idempotent reconciliation the bot runs under the heist-row lock
-- BEFORE terminalizing ANY heist (on resume-on-boot AND on the normal
-- resolve/finalize paths). It finds every stranded row (claimed_at IS NULL AND
-- paid_at IS NULL), deletes it + its participants[] slot, and refunds the frozen
-- per-member entry fee — all in one transaction per call. This is the same
-- delete+refund heist_settle_missed_join performs for a single racing joiner,
-- generalised to sweep every stranded row a crash could have left behind.
--
-- Idempotency + composition with the freeze/finalize state machine:
--   * A frozen crew member (claimed_at IS NOT NULL) is NEVER touched — the WHERE
--     excludes it, so it cannot be double-refunded or have its payout deleted.
--   * An already-settled missed join is gone (heist_settle_missed_join deleted
--     it), so it cannot be reconciled twice.
--   * Re-running the sweep after it committed finds no stranded rows and credits
--     nothing (returns 0) — safe to call on every resolve, retry, and resume.
--   * It runs BEFORE the settle/finalize pass, and money commits before the
--     heist is terminalized, exactly like every other heist credit — so no fee
--     is ever stranded past a terminal flip.
-- The refund amount is the frozen per-member value the caller passes (refund_each
-- off the row for a cancelled heist, else the entry fee), consistent with the
-- frozen-amount design in 20260710130000: a config edit after the claim cannot
-- change what a stranded joiner gets back.

CREATE OR REPLACE FUNCTION heist_reconcile_stranded_joins(
  p_heist_id      UUID,
  p_refund_amount INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_guild_id TEXT;
  v_user_id  TEXT;
  v_count    INTEGER := 0;
BEGIN
  -- Lock the heist row: serialises against heist_claim_for_resolution and
  -- heist_settle_missed_join, so the claimed_at / paid_at we read below reflect a
  -- settled claim decision and no concurrent settle can race this sweep.
  SELECT h.guild_id INTO v_guild_id
    FROM public.economy_heists h
   WHERE h.id = p_heist_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 0;  -- heist gone; nothing to reconcile
  END IF;

  -- Sweep every stranded late-join row: inserted after the crew freeze
  -- (claimed_at IS NULL) and never settled (paid_at IS NULL). Lock the rows so a
  -- concurrent heist_settle_missed_join for the same user serialises behind us —
  -- whichever commits first deletes the row; the other observes NOT FOUND and is
  -- a no-op, so the fee is refunded exactly once. A frozen crew member
  -- (claimed_at IS NOT NULL) is excluded and can never be swept.
  FOR v_user_id IN
    SELECT p.user_id
      FROM public.economy_heist_participants p
     WHERE p.heist_id = p_heist_id
       AND p.claimed_at IS NULL
       AND p.paid_at IS NULL
     FOR UPDATE
  LOOP
    DELETE FROM public.economy_heist_participants p
     WHERE p.heist_id = p_heist_id
       AND p.user_id  = v_user_id;

    UPDATE public.economy_heists h
       SET participants = array_remove(h.participants, v_user_id)
     WHERE h.id = p_heist_id;

    IF p_refund_amount > 0 THEN
      PERFORM public.economy_add_balance(v_guild_id, v_user_id, p_refund_amount);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;  -- number of stranded joins refunded by THIS call
END;
$$;

REVOKE ALL ON FUNCTION heist_reconcile_stranded_joins(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_reconcile_stranded_joins(UUID, INTEGER) TO service_role;
