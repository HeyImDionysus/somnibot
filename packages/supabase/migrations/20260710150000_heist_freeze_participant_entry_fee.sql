-- Heist per-participant entry-fee freeze — completes the settle matrix.
--
-- Recurring class (codex, many rounds): every heist money amount must be FROZEN
-- at the moment it is charged, RETRIED until it commits, and read back from the
-- frozen source on every resume/retry — never re-derived from mutable
-- guild_config. Prior migrations froze the success payout (payout_each,
-- 20260710060000) and the cancel refund (refund_each, 20260710130000) on the
-- HEIST row. Both are per-heist single values, correct because a frozen crew all
-- share one outcome.
--
-- The last un-frozen amount is the STRANDED late-join refund. A /heist join that
-- raced past the atomic claim (claimed_at IS NULL, fee already debited) must be
-- refunded THE FEE IT ACTUALLY PAID, on ANY terminal outcome — including a
-- SUCCESS or FAILED heist, where refund_each is NULL. The bot previously fell
-- back to the guild_config entry fee read during THIS resolve attempt
-- (heist.refund_each ?? entryFee), so:
--   * on success/failed heists the stranded refund used a live config value, and
--   * if an admin edited economy_heist_entry_fee between the debit and the
--     resume/retry, the stranded joiner was over- or under-refunded.
-- The refund amount for a stranded row therefore cannot be a per-heist value at
-- all: different rows may have been charged different fees (a config edit during
-- an open join window), so the frozen amount must live on the PARTICIPANT row.
--
-- Fix: freeze the debited entry fee per participant in
-- economy_heist_participants.entry_fee_paid at insert time (startHeist +
-- joinHeist). Every refund of a NON-frozen-crew row (stranded late join, on any
-- outcome) reads that per-row frozen fee. The frozen CREW still uses the
-- per-heist payout_each / refund_each (they all share the claim's single
-- decision). This closes the "refund stranded joins with the debited entry fee"
-- defect on the last remaining money path.
--
-- Also: heist_settle_missed_join / heist_reconcile_stranded_joins now refund from
-- the frozen entry_fee_paid on the row (falling back to the passed amount only
-- for legacy pre-freeze rows), and heist_settle_missed_join returns a STATUS so
-- the join command can distinguish "you were reconciled/refunded by the resolver"
-- from "you are still in the frozen crew" — the latter previously both returned
-- false and the command mis-announced "Joined the Heist!" to an already-refunded,
-- removed user.

-- ─── 1. Frozen per-participant entry fee ─────────────────────
-- The exact amount debited from this participant when they joined. Set at insert
-- time; immutable thereafter. A stranded late-join is always refunded this value,
-- regardless of the heist outcome or any later config edit. NULL only on legacy
-- rows inserted before this migration (callers fall back to the passed amount).
ALTER TABLE economy_heist_participants
  ADD COLUMN IF NOT EXISTS entry_fee_paid INTEGER;

-- ─── 2. heist_settle_missed_join — frozen-fee refund + status result ─────
-- Two changes vs 20260710060000:
--   (a) Refund the frozen entry_fee_paid on the row (fallback p_refund_amount for
--       legacy rows), so the amount is exactly what THIS joiner was charged.
--   (b) Return a TEXT status instead of a bare boolean so the join command can
--       tell three outcomes apart:
--         'recruiting'  — claim has not run; joiner is in the crew (was false).
--         'in_crew'     — joiner is in the FROZEN crew; settle normally (was false).
--         'reconciled'  — the joiner's row was already deleted (a concurrent bulk
--                         heist_reconcile_stranded_joins won the race and already
--                         refunded them); the command must NOT say "Joined" — the
--                         user was removed + refunded (was false, mis-handled).
--         'refunded'    — THIS call deleted the stranded row and refunded the fee.
--       The previous boolean collapsed 'recruiting'/'in_crew'/'reconciled' all to
--       false, so after a resolver-vs-join race the command fell through to the
--       "Joined the Heist!" success embed for a user who was actually refunded and
--       removed from the crew (codex :482).
-- The signature changes (return type), so the old form is dropped first.
DROP FUNCTION IF EXISTS heist_settle_missed_join(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION heist_settle_missed_join(
  p_heist_id      UUID,
  p_user_id       TEXT,
  p_refund_amount INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status     TEXT;
  v_claimed_at TIMESTAMPTZ;
  v_paid_at    TIMESTAMPTZ;
  v_frozen_fee INTEGER;
  v_guild_id   TEXT;
  v_refund     INTEGER;
BEGIN
  -- Lock the heist row: serialises against heist_claim_for_resolution and the
  -- bulk heist_reconcile_stranded_joins, so the status / claimed_at / row
  -- presence we read below reflect a settled claim + any concurrent reconcile.
  SELECT h.status, h.guild_id INTO v_status, v_guild_id
    FROM public.economy_heists h
   WHERE h.id = p_heist_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'reconciled';  -- heist gone; treat as already settled (do not claim "Joined")
  END IF;

  -- Still recruiting → the claim has not frozen the crew yet; this joiner is in.
  IF v_status = 'recruiting' THEN
    RETURN 'recruiting';
  END IF;

  SELECT p.claimed_at, p.paid_at, p.entry_fee_paid
    INTO v_claimed_at, v_paid_at, v_frozen_fee
    FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id
     FOR UPDATE;

  -- Row is gone → a concurrent bulk reconcile already deleted + refunded it. The
  -- caller must NOT announce "Joined": the user was removed from the crew and
  -- refunded. This is the case the old boolean could not express (codex :482).
  IF NOT FOUND THEN
    RETURN 'reconciled';
  END IF;

  -- Frozen into the crew (claimed_at set) → settle normally on the payout path.
  IF v_claimed_at IS NOT NULL THEN
    RETURN 'in_crew';
  END IF;

  -- Unstamped but already settled (paid_at set) → a prior reconcile/settle already
  -- refunded this exact row; do not refund again.
  IF v_paid_at IS NOT NULL THEN
    RETURN 'reconciled';
  END IF;

  -- Raced past the claim: unstamped + unsettled. Remove the stranded row and its
  -- participants[] slot, then refund the FROZEN entry fee this joiner actually
  -- paid (fallback to the passed amount for a legacy pre-freeze row). Deleting is
  -- safe: an unstamped, unpaid row was never part of any payout/refund decision.
  v_refund := COALESCE(v_frozen_fee, p_refund_amount);

  DELETE FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id;

  UPDATE public.economy_heists h
     SET participants = array_remove(h.participants, p_user_id)
   WHERE h.id = p_heist_id;

  IF v_refund > 0 THEN
    PERFORM public.economy_add_balance(v_guild_id, p_user_id, v_refund);
  END IF;

  RETURN 'refunded';
END;
$$;

REVOKE ALL ON FUNCTION heist_settle_missed_join(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_settle_missed_join(UUID, TEXT, INTEGER) TO service_role;

-- ─── 3. heist_reconcile_stranded_joins — refund each row's frozen fee ─────
-- Same sweep as 20260710140000, but each stranded row is refunded ITS OWN frozen
-- entry_fee_paid (fallback p_refund_amount for legacy rows) instead of a single
-- per-heist value. This is what makes the stranded refund correct on a SUCCESS or
-- FAILED heist (where the per-heist refund_each is NULL) and immune to a config
-- edit after the debit: different rows charged different fees are each refunded
-- exactly what they paid. Idempotency + locking are unchanged.
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
  v_guild_id   TEXT;
  v_user_id    TEXT;
  v_frozen_fee INTEGER;
  v_refund     INTEGER;
  v_count      INTEGER := 0;
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
  FOR v_user_id, v_frozen_fee IN
    SELECT p.user_id, p.entry_fee_paid
      FROM public.economy_heist_participants p
     WHERE p.heist_id = p_heist_id
       AND p.claimed_at IS NULL
       AND p.paid_at IS NULL
     FOR UPDATE
  LOOP
    -- Refund the fee THIS row actually paid (frozen), not a per-heist value.
    v_refund := COALESCE(v_frozen_fee, p_refund_amount);

    DELETE FROM public.economy_heist_participants p
     WHERE p.heist_id = p_heist_id
       AND p.user_id  = v_user_id;

    UPDATE public.economy_heists h
       SET participants = array_remove(h.participants, v_user_id)
     WHERE h.id = p_heist_id;

    IF v_refund > 0 THEN
      PERFORM public.economy_add_balance(v_guild_id, v_user_id, v_refund);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;  -- number of stranded joins refunded by THIS call
END;
$$;

REVOKE ALL ON FUNCTION heist_reconcile_stranded_joins(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_reconcile_stranded_joins(UUID, INTEGER) TO service_role;
