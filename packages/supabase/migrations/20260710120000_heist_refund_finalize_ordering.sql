-- Heist refund/finalize ordering — never acknowledge a credit before it commits,
-- never mark a heist terminal while a refund/payout is still outstanding.
--
-- Two payout-integrity gaps remained after 20260710060000 made resolution
-- atomic and single-shot:
--
--   A. Missed-join refund acknowledged before it succeeds.
--      heist_settle_missed_join deleted the stranded (race-past-claim)
--      participant row and removed its participants[] slot, then RETURNed true.
--      The bot then issued the entry-fee refund as a SEPARATE economy_add_balance
--      call and, on RPC failure, only logged before still telling the user
--      "your entry fee was refunded". Because the row was already deleted, no
--      later resume/retry could rediscover the unpaid entry fee — the user
--      permanently lost the charge. Fix: fold the refund INTO the RPC so the
--      delete and the credit commit in the SAME transaction. A true return now
--      means the fee is actually back in the wallet; anything else rolls back
--      the delete, leaving the row for the caller to retry.
--
--   B. Cancelled heists went terminal before their refunds finished.
--      heist_claim_for_resolution flipped an under-crewed heist straight to the
--      TERMINAL status='cancelled'. The bot then refunded each frozen crew
--      member with heist_credit_participant; a transient error there was only
--      logged, yet resumePendingHeists only revisits 'recruiting'/'in_progress'
--      rows and resolveHeist returns early for terminal statuses — so a failed
--      cancel refund was never retried while the channel was already told all
--      fees were returned. Fix: make the under-crewed branch flip to the
--      intermediate status='in_progress' with resolution='cancelled' (mirroring
--      the success/failed branches). The bot refunds idempotently and only
--      heist_finalize_resolution moves the row to terminal 'cancelled' — AFTER
--      every refund has committed. A failed refund leaves the row 'in_progress'
--      and retryable (in-process retry now, resumePendingHeists on restart),
--      exactly like a failed success payout.

-- ─── A. Fold the missed-join refund into the reconciliation RPC ───
-- Replace the 2-arg heist_settle_missed_join with a 3-arg form that performs
-- the entry-fee refund inside the same transaction as the delete. The old
-- signature is dropped so no caller can invoke the non-atomic version.
DROP FUNCTION IF EXISTS heist_settle_missed_join(UUID, TEXT);

-- Reconcile a join that raced past the atomic claim, atomically refunding the
-- entry fee. Freezing the crew at claim time (20260710060000 §3) means a
-- /heist join that read the heist as 'recruiting' but whose participant insert
-- commits AFTER heist_claim_for_resolution stamped the crew lands with
-- claimed_at IS NULL. Settlement (which reads only claimed_at IS NOT NULL rows)
-- then excludes that row from BOTH the success payout and the cancel refund —
-- the joiner was charged the entry fee, saw "Joined", yet is never settled.
--
-- After its insert, the join path calls this under the heist-row lock. Three
-- outcomes:
--   * heist still 'recruiting' — the claim has not run; the joiner is in the
--     crew and will be frozen by the claim. Nothing to do (refunded=false).
--   * heist claimed AND this participant is stamped (claimed_at set) — the join
--     made it into the frozen crew and will be settled normally (refunded=false).
--   * heist claimed AND this participant is UNSTAMPED and unsettled (paid_at
--     NULL) — it raced past the claim and can never be settled. Delete the
--     stranded row and its participants[] slot, credit the entry fee back in the
--     SAME transaction, and return refunded=true. Because the delete and the
--     wallet credit commit together, a true return guarantees the fee actually
--     landed — the caller may safely tell the user it was refunded. If anything
--     in this transaction errors, the whole thing rolls back (the row is NOT
--     deleted, no partial credit), so the caller can retry without the user
--     having silently lost the fee.
-- Locking the heist row makes this race-free: by the time the claim's stamp is
-- committed and visible here, we either observe our row stamped (in the crew)
-- or observe the heist claimed with our row unstamped (refund) — never both.
CREATE OR REPLACE FUNCTION heist_settle_missed_join(
  p_heist_id       UUID,
  p_user_id        TEXT,
  p_refund_amount  INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status     TEXT;
  v_guild_id   TEXT;
  v_claimed_at TIMESTAMPTZ;
  v_paid_at    TIMESTAMPTZ;
BEGIN
  -- Lock the heist row: serialises against heist_claim_for_resolution, so the
  -- status/claimed_at we read below reflect a settled claim decision.
  SELECT h.status, h.guild_id INTO v_status, v_guild_id
    FROM public.economy_heists h
   WHERE h.id = p_heist_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;  -- heist gone; nothing to reconcile
  END IF;

  -- Still recruiting → the claim has not frozen the crew yet; this joiner is in.
  IF v_status = 'recruiting' THEN
    RETURN false;
  END IF;

  SELECT p.claimed_at, p.paid_at INTO v_claimed_at, v_paid_at
    FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id
     FOR UPDATE;

  -- No row, already frozen into the crew, or already settled → leave it to the
  -- normal settle path; do not refund (would double-pay a settled member).
  IF NOT FOUND OR v_claimed_at IS NOT NULL OR v_paid_at IS NOT NULL THEN
    RETURN false;
  END IF;

  -- Raced past the claim: unstamped + unsettled. Remove the stranded row and
  -- its participants[] slot so it is neither counted nor displayed, and refund
  -- the entry fee — all in this one transaction. If the credit raises, the
  -- delete rolls back too, so we never lose the row without refunding.
  DELETE FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id;

  UPDATE public.economy_heists h
     SET participants = array_remove(h.participants, p_user_id)
   WHERE h.id = p_heist_id;

  IF p_refund_amount > 0 THEN
    PERFORM public.economy_add_balance(v_guild_id, p_user_id, p_refund_amount);
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION heist_settle_missed_join(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_settle_missed_join(UUID, TEXT, INTEGER) TO service_role;

-- ─── B. Keep an under-crewed heist retryable until refunds finish ───
-- Redefine heist_claim_for_resolution so the too-few-crew branch flips the row
-- to the INTERMEDIATE status='in_progress' with resolution='cancelled' instead
-- of straight to terminal 'cancelled'. The caller refunds the frozen crew
-- idempotently and only heist_finalize_resolution (which already maps a stored
-- resolution of 'cancelled' onto the terminal status) moves the row terminal —
-- after every refund committed. This makes the cancel path symmetric with the
-- success path: a failed refund leaves the heist 'in_progress' and retryable
-- (resumePendingHeists revisits 'in_progress'; resolveHeist re-runs the frozen
-- 'cancelled' decision), so no refund is announced-then-dropped.
--
-- Everything else (crew freeze, CSPRNG success roll, per-person payout freeze)
-- is unchanged from 20260710060000 §3.
CREATE OR REPLACE FUNCTION heist_claim_for_resolution(
  p_heist_id          UUID,
  p_min_participants  INTEGER
)
RETURNS TABLE (
  claimed           BOOLEAN,
  outcome           TEXT,
  participant_count INTEGER,
  payout_each       INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status        TEXT;
  v_target_payout INTEGER;
  v_success_chance INTEGER;
  v_count         INTEGER;
  v_roll          INTEGER;
  v_is_success    BOOLEAN;
  v_payout_each   INTEGER;
BEGIN
  -- Lock the heist row: every resolution path locks this same row, so the
  -- read-decide-write below cannot interleave with another resolver.
  SELECT h.status, h.target_payout, h.success_chance
    INTO v_status, v_target_payout, v_success_chance
    FROM public.economy_heists h
   WHERE h.id = p_heist_id
     FOR UPDATE;

  -- Already claimed / resolved / cancelled by another caller, or gone.
  IF NOT FOUND OR v_status <> 'recruiting' THEN
    RETURN QUERY SELECT false, NULL::TEXT, 0, NULL::INTEGER;
    RETURN;
  END IF;

  -- Freeze the crew set: stamp claimed_at on every current participant, then
  -- count exactly those stamped rows. Both the stamp and the count run under
  -- the heist-row lock held above, so a /heist join whose participant insert
  -- lands after this claim (its insert takes no heist-row lock) is neither
  -- stamped nor counted — the bot settles only claimed_at IS NOT NULL rows, so
  -- that late joiner is never paid a share sized for the frozen v_count.
  UPDATE public.economy_heist_participants p
     SET claimed_at = now()
   WHERE p.heist_id = p_heist_id
     AND p.claimed_at IS NULL;

  SELECT COUNT(*)::INTEGER INTO v_count
    FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.claimed_at IS NOT NULL;

  -- Too few crew — flip to the INTERMEDIATE in_progress with resolution
  -- 'cancelled' (NOT terminal). The caller refunds entry fees idempotently and
  -- heist_finalize_resolution moves the row to terminal 'cancelled' only after
  -- all refunds succeed; a failed refund leaves it in_progress and retryable.
  IF v_count < p_min_participants THEN
    UPDATE public.economy_heists h
       SET status      = 'in_progress',
           resolution  = 'cancelled'
     WHERE h.id = p_heist_id;

    RETURN QUERY SELECT true, 'cancelled'::TEXT, v_count, NULL::INTEGER;
    RETURN;
  END IF;

  -- Roll success server-side with CSPRNG-backed randomness. pgcrypto's
  -- gen_random_bytes is schema-qualified (extensions.) so it resolves under
  -- SET search_path = '' — the same crypto-random idiom lottery_buy_tickets
  -- uses (V7 Audit §4). Two bytes give [0, 65536); bucketed to [0,100) to
  -- compare against the integer success_chance percentage.
  v_roll := (get_byte(extensions.gen_random_bytes(2), 0) * 256
             + get_byte(extensions.gen_random_bytes(2), 1)) % 100;
  v_is_success := v_roll < v_success_chance;

  IF v_is_success THEN
    v_payout_each := (v_target_payout / v_count)::INTEGER;  -- floor split
    UPDATE public.economy_heists h
       SET status      = 'in_progress',
           resolution  = 'success',
           payout_each = v_payout_each
     WHERE h.id = p_heist_id;

    RETURN QUERY SELECT true, 'success'::TEXT, v_count, v_payout_each;
  ELSE
    UPDATE public.economy_heists h
       SET status      = 'in_progress',
           resolution  = 'failed',
           payout_each = 0
     WHERE h.id = p_heist_id;

    RETURN QUERY SELECT true, 'failed'::TEXT, v_count, 0;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION heist_claim_for_resolution(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_claim_for_resolution(UUID, INTEGER) TO service_role;

-- Note: heist_finalize_resolution (20260710060000 §5) already flips
-- status='in_progress' → its stored resolution, and resolution may be
-- 'cancelled' (the CHECK on economy_heists.resolution permits it), so a
-- resolution='cancelled' row finalizes to the terminal 'cancelled' status
-- unchanged — no edit needed there.
