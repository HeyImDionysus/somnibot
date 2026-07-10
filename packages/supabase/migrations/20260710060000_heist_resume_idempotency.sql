-- Heist resume idempotency — atomic, single-shot resolution.
--
-- Defect (WAVE 2B): heist resolution was a bot-side check-then-act. The
-- resolve-timer (or resumePendingHeists after a crash) SELECTed the heist,
-- checked `status = 'recruiting'` in JS, then flipped the status and paid out
-- in separate statements. Two resolutions of the same heist could interleave:
--   * the in-memory timer fires while a restart's resumePendingHeists also
--     resolves the same 'recruiting' heist, or
--   * the bot crashes mid-payout leaving status='in_progress' with only some
--     participants credited — a re-resolve re-rolled the outcome and re-paid
--     participants who were already paid (entry-fee refund / payout double).
-- The JS `status !== 'recruiting'` guard could not prevent this: both callers
-- read 'recruiting' before either wrote.
--
-- Fix (mirrors lottery_claim_drawing / lottery_award_jackpot, 20260709130000):
--   1. heist_claim_for_resolution — under FOR UPDATE on the heist row, decide
--      the ENTIRE outcome exactly once: too-few-crew ⇒ flip recruiting→cancelled;
--      otherwise roll success server-side (CSPRNG), store the decision and the
--      per-person payout on the row, and flip recruiting→in_progress. It also
--      FREEZES the crew set by stamping claimed_at on the participants it counts
--      (same heist lock), so a late /heist join whose insert races past the
--      claim is neither counted nor paid. Only the caller that observes
--      'recruiting' wins; every other concurrent or post-crash caller gets
--      claimed=false and must NOT re-decide or re-pay.
--   2. Per-participant credit idempotency via economy_heist_participants.paid_at:
--      heist_credit_participant pays a participant iff paid_at IS NULL and stamps
--      it in the SAME transaction, so a retry after a crash pays each crew member
--      exactly once (success payout AND cancel refund share this guard). If any
--      credit errors, the bot leaves the heist in_progress (unfinalised) so a
--      later resume retries the unpaid member — a payout is never dropped.
--   3. heist_finalize_resolution — flips in_progress→success/failed exactly once,
--      guarded on the current status so a second finalize is a no-op. It refuses
--      to finalize a legacy in_progress heist with a NULL resolution (from the
--      old resolver) rather than defaulting it to 'failed'.
-- Participant JOINs are already deduped by the UNIQUE (heist_id, user_id) on
-- economy_heist_participants (v36), so no participant can be double-counted.

-- ─── 1. Outcome + payout state carried on the heist row ───────
-- payout_each: the per-person success payout, computed and frozen at claim
-- time so a resumed finalize pays the SAME amount the claim decided (never a
-- fresh split over a changed crew). NULL until a success is claimed.
ALTER TABLE economy_heists
  ADD COLUMN IF NOT EXISTS payout_each INTEGER;

-- resolution: the decision frozen at claim time. NULL while recruiting;
-- 'success' | 'failed' | 'cancelled' once claimed. Distinct from `status`
-- so the intermediate 'in_progress' row still carries the eventual verdict
-- across a crash/resume.
ALTER TABLE economy_heists
  ADD COLUMN IF NOT EXISTS resolution TEXT
    CHECK (resolution IN ('success', 'failed', 'cancelled'));

-- ─── 2. Per-participant payout idempotency marker ─────────────
-- Set (with the wallet credit) the first time a participant is paid or
-- refunded. A NULL means "not yet credited"; a retry sees it non-NULL and
-- skips, so no crew member is ever paid twice.
ALTER TABLE economy_heist_participants
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- payout_failed: preserved for reconciliation (the bot marks a participant
-- whose credit RPC errored). Additive; independent of paid_at.
ALTER TABLE economy_heist_participants
  ADD COLUMN IF NOT EXISTS payout_failed BOOLEAN NOT NULL DEFAULT false;

-- claimed_at: freezes the crew set at claim time. heist_claim_for_resolution
-- stamps every participant it counted under the heist-row lock; the bot then
-- settles ONLY stamped participants. This closes a TOCTOU: a /heist join that
-- read the heist as 'recruiting' just before expiry can still insert its
-- participant row after the claim commits (the insert takes no heist-row lock),
-- and that late row would otherwise be paid target_payout/old_count even though
-- it was never part of the frozen v_count. A late row has claimed_at = NULL and
-- is excluded from settlement. NULL until claimed; persists across crash/resume
-- so a resumed in_progress heist settles the same frozen crew.
ALTER TABLE economy_heist_participants
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- ─── 3. Atomic single-shot claim ─────────────────────────────
-- Decides the whole outcome under the heist row lock. Returns exactly one
-- row; `claimed` is true only for the caller that observed status='recruiting'
-- and performed the transition. Every other caller (concurrent timer, a
-- resume after crash, a duplicate resume) gets claimed=false and must treat
-- the heist as already owned.
--
-- outcome values:
--   'cancelled' — fewer than p_min_participants joined; row flipped to
--                 'cancelled'. The caller refunds entry fees idempotently.
--   'success'   — roll succeeded; row flipped to 'in_progress' with
--                 payout_each stored. The caller credits payouts idempotently
--                 then finalises to 'success'.
--   'failed'    — roll failed; row flipped to 'in_progress', payout_each=0.
--                 The caller finalises to 'failed' (entry fees are forfeit).
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

  -- Too few crew — cancel and let the caller refund entry fees.
  IF v_count < p_min_participants THEN
    UPDATE public.economy_heists h
       SET status      = 'cancelled',
           resolution  = 'cancelled',
           resolved_at = now()
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

-- ─── 4. Idempotent per-participant credit ────────────────────
-- Credits p_amount to a single crew member iff they have not been credited
-- yet (paid_at IS NULL), stamping paid_at in the SAME transaction as the
-- wallet write so "credited" and "paid" can never diverge. Used for BOTH the
-- success payout and the cancel refund. Returns true iff this call performed
-- the credit; false means it was already credited (a retry) — never pay twice.
-- p_amount = 0 is allowed (a stamped no-op), so a failed heist can mark its
-- crew settled without a wallet write.
CREATE OR REPLACE FUNCTION heist_credit_participant(
  p_heist_id UUID,
  p_guild_id TEXT,
  p_user_id  TEXT,
  p_amount   INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_paid_at TIMESTAMPTZ;
BEGIN
  -- Lock the participant row so concurrent credit attempts serialise.
  SELECT p.paid_at INTO v_paid_at
    FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id
     FOR UPDATE;

  IF NOT FOUND OR v_paid_at IS NOT NULL THEN
    RETURN false;  -- unknown participant or already credited — no double pay
  END IF;

  IF p_amount > 0 THEN
    PERFORM public.economy_add_balance(p_guild_id, p_user_id, p_amount);
  END IF;

  UPDATE public.economy_heist_participants p
     SET paid_at       = now(),
         payout        = p_amount,
         payout_failed = false
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION heist_credit_participant(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_credit_participant(UUID, TEXT, TEXT, INTEGER) TO service_role;

-- ─── 5. Single-shot finalisation ─────────────────────────────
-- Flips a claimed, in-progress heist to its stored resolution ('success' or
-- 'failed') exactly once. Guarded on status='in_progress' so a second
-- finalise (concurrent or post-crash) is a no-op. Returns true iff this call
-- performed the transition. A 'cancelled' heist is already terminal and is
-- reported as not-finalised-here (false).
CREATE OR REPLACE FUNCTION heist_finalize_resolution(
  p_heist_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status     TEXT;
  v_resolution TEXT;
BEGIN
  SELECT h.status, h.resolution INTO v_status, v_resolution
    FROM public.economy_heists h
   WHERE h.id = p_heist_id
     FOR UPDATE;

  IF NOT FOUND OR v_status <> 'in_progress' THEN
    RETURN false;  -- not claimed-in-progress (already finalised or cancelled)
  END IF;

  -- A legacy in_progress heist from the OLD (pre-atomic) resolver has no frozen
  -- resolution. Never guess: coercing NULL to 'failed' would terminally fail —
  -- and announce a loss for — a heist that may have actually succeeded and paid
  -- out under the old code. Leave it in_progress for a dedicated backfill.
  IF v_resolution IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.economy_heists h
     SET status      = v_resolution,
         resolved_at = now()
   WHERE h.id = p_heist_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION heist_finalize_resolution(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_finalize_resolution(UUID) TO service_role;

-- ─── 6. Reconcile a join that raced past the claim ───────────
-- Closes the OTHER side of the freeze TOCTOU. Freezing the crew at claim time
-- (§3) means a /heist join that read the heist as 'recruiting' but whose
-- participant insert commits AFTER heist_claim_for_resolution stamped the crew
-- lands with claimed_at IS NULL. Settlement (which reads only claimed_at IS NOT
-- NULL rows) then excludes that row from BOTH the success payout and the cancel
-- refund — the joiner was charged the entry fee, saw "Joined", yet is never
-- settled and silently loses the fee.
--
-- After its insert, the join path calls this under the heist-row lock. Three
-- outcomes:
--   * heist still 'recruiting' — the claim has not run; the joiner is in the
--     crew and will be frozen by the claim. Nothing to do (refunded=false).
--   * heist claimed AND this participant is stamped (claimed_at set) — the join
--     made it into the frozen crew and will be settled normally (refunded=false).
--   * heist claimed AND this participant is UNSTAMPED and unsettled (paid_at
--     NULL) — it raced past the claim and can never be settled. Delete the
--     stranded row and its slot in economy_heists.participants, and return
--     refunded=true so the caller returns the entry fee. Deleting is safe: an
--     unstamped, unpaid row was never part of any payout/refund decision.
-- Locking the heist row makes this race-free: by the time the claim's stamp is
-- committed and visible here, we either observe our row stamped (in the crew)
-- or observe the heist claimed with our row unstamped (refund) — never both.
CREATE OR REPLACE FUNCTION heist_settle_missed_join(
  p_heist_id UUID,
  p_user_id  TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status     TEXT;
  v_claimed_at TIMESTAMPTZ;
  v_paid_at    TIMESTAMPTZ;
BEGIN
  -- Lock the heist row: serialises against heist_claim_for_resolution, so the
  -- status/claimed_at we read below reflect a settled claim decision.
  SELECT h.status INTO v_status
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
  -- its participants[] slot so it is neither counted nor displayed, then tell
  -- the caller to refund the entry fee.
  DELETE FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id;

  UPDATE public.economy_heists h
     SET participants = array_remove(h.participants, p_user_id)
   WHERE h.id = p_heist_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION heist_settle_missed_join(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_settle_missed_join(UUID, TEXT) TO service_role;
