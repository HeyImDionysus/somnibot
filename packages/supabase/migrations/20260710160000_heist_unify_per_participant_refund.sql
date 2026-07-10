-- Heist refund UNIFICATION — one frozen per-participant fee for every refund path.
--
-- Prior migrations froze money incrementally but left TWO refund mechanisms in
-- play, and codex found the per-participant insight (20260710150000) was applied
-- non-uniformly:
--
--   * 20260710130000 froze a single per-heist refund amount (economy_heists
--     .refund_each) at claim time, used to refund the CANCELLED frozen crew.
--   * 20260710150000 froze each participant's OWN debited fee
--     (economy_heist_participants.entry_fee_paid) and used it only for the
--     STRANDED late-join refund.
--
-- Non-uniformity (codex heist-manager.ts:777): when an admin edits the entry fee
-- during an open recruiting window, frozen crew members can have DIFFERENT
-- entry_fee_paid values (initiator paid 100, a later joiner paid 200 after the
-- edit). refund_each is a SINGLE value captured at claim time, so the cancel path
-- over- or under-refunds a crew that paid heterogeneous fees — even though each
-- participant row already stores the exact amount that member paid.
--
-- Unification: EVERY refund, for EVERY participant class, on EVERY outcome, is
-- that participant's OWN frozen entry_fee_paid (fallback to the passed legacy
-- amount only for a pre-freeze row whose entry_fee_paid is NULL):
--   * frozen crew, cancelled heist  → each member's entry_fee_paid;
--   * stranded late join, any outcome → its own entry_fee_paid.
-- The ONLY per-heist money amount is the SUCCESS payout (payout_each), which is
-- correct as a single value: a success payout is a split of the loot the whole
-- frozen crew shares, not a return of a fee each member paid individually.
--
-- Consequence: economy_heists.refund_each is now REDUNDANT. Nothing reads it
-- authoritatively — the cancel refund reads entry_fee_paid off each participant
-- row, and the legacy fallback (config entry fee) is identical to what the
-- stranded path already uses. A per-heist frozen refund that nothing reads is
-- exactly the "second mechanism" that caused this defect, so this migration
-- REMOVES it: heist_claim_for_resolution reverts to its 2-arg (no p_entry_fee)
-- signature and stops writing refund_each, and the column is dropped. The whole
-- money model collapses to: freeze each participant's fee at join → success pays
-- payout_each (frozen, per-heist) to the crew → every other terminal path refunds
-- each participant's OWN frozen entry_fee_paid → all idempotent, all retryable.
--
-- Also fixes two join-path half-commit defects codex flagged:
--   * heist_settle_missed_join's already-reconciled branches now array_remove the
--     joiner from economy_heists.participants before returning 'reconciled', so a
--     joinHeist that appended before calling this RPC cannot leave a ghost
--     participant in the array (codex migration:114 / heist-manager.ts append).
--   * heist_undo_join (NEW) lets joinHeist fully undo a still-recruiting join —
--     refund the frozen fee, delete the row, drop the participants[] slot, and
--     decrement success_chance — when heist_settle_missed_join fails transiently,
--     so a just-joined member is never left fee-debited but neither in the crew
--     nor refunded (codex heist-manager.ts:491).
--
-- Forward-only, schema-qualified, SECURITY DEFINER + search_path=''; greenfield
-- DB (no live heist rows) so dropping refund_each is safe.

-- ─── 1. Drop the now-redundant per-heist frozen refund column ─────
-- refund_each was only ever read by the cancel refund, which now reads each
-- participant's entry_fee_paid instead. Dropping it removes the second refund
-- mechanism so no path can regress to a per-heist refund amount.
ALTER TABLE economy_heists
  DROP COLUMN IF EXISTS refund_each;

-- ─── 2. heist_claim_for_resolution — revert to 2-arg, no frozen refund ─────
-- The 3-arg form (p_entry_fee) existed only to freeze refund_each on the
-- under-crewed branch. With the cancel refund now per-participant, the claim no
-- longer needs the entry fee and no longer writes a per-heist refund. The
-- under-crewed branch still flips to the INTERMEDIATE in_progress + resolution
-- 'cancelled' (retryable until every refund commits), exactly as before — it
-- just stops stamping refund_each. Everything else (crew freeze via claimed_at,
-- CSPRNG success roll, payout_each freeze) is unchanged.
--
-- Drop BOTH prior signatures so no caller can invoke a stale form:
DROP FUNCTION IF EXISTS heist_claim_for_resolution(UUID, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS heist_claim_for_resolution(UUID, INTEGER);

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
  v_status         TEXT;
  v_target_payout  INTEGER;
  v_success_chance INTEGER;
  v_count          INTEGER;
  v_roll           INTEGER;
  v_is_success     BOOLEAN;
  v_payout_each    INTEGER;
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
  -- count exactly those stamped rows. Both run under the heist-row lock, so a
  -- /heist join whose participant insert lands after this claim is neither
  -- stamped nor counted — the bot settles only claimed_at IS NOT NULL rows.
  UPDATE public.economy_heist_participants p
     SET claimed_at = now()
   WHERE p.heist_id = p_heist_id
     AND p.claimed_at IS NULL;

  SELECT COUNT(*)::INTEGER INTO v_count
    FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.claimed_at IS NOT NULL;

  -- Too few crew — flip to the INTERMEDIATE in_progress with resolution
  -- 'cancelled' (NOT terminal). The caller refunds each frozen crew member their
  -- OWN entry_fee_paid idempotently, and heist_finalize_resolution moves the row
  -- to terminal 'cancelled' only after all refunds commit. No per-heist refund is
  -- frozen here anymore: the amount lives on each participant row.
  IF v_count < p_min_participants THEN
    UPDATE public.economy_heists h
       SET status     = 'in_progress',
           resolution = 'cancelled'
     WHERE h.id = p_heist_id;

    RETURN QUERY SELECT true, 'cancelled'::TEXT, v_count, NULL::INTEGER;
    RETURN;
  END IF;

  -- Roll success server-side with CSPRNG-backed randomness. pgcrypto's
  -- gen_random_bytes is schema-qualified (extensions.) so it resolves under
  -- SET search_path = ''. Two bytes give [0, 65536); bucketed to [0,100).
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

-- ─── 3. heist_settle_missed_join — array_remove on the reconciled branches ─────
-- Same TEXT-status contract as 20260710150000, with the finding-#3 fix: every
-- branch that returns 'reconciled' (the row was already deleted by a concurrent
-- bulk reconcile, OR was already settled) now array_removes p_user_id from
-- economy_heists.participants first. joinHeist appends to participants[] via
-- array_append_heist_participant BEFORE it calls this RPC, and that append has no
-- status/row guard — so if the resolver's bulk heist_reconcile_stranded_joins
-- deleted+refunded this joiner between the append and this call, the array would
-- keep a ghost entry (refunded, non-crew, but shown in /heist view and bumping
-- success_chance) unless we strip it here. array_remove is idempotent, so calling
-- it when the user is already absent is a harmless no-op.
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
  -- refunded. The bulk reconcile array_removed the user when it deleted the row,
  -- but joinHeist may have appended AFTER that delete and BEFORE this call, so
  -- re-strip the array slot to guarantee no ghost participant remains.
  IF NOT FOUND THEN
    UPDATE public.economy_heists h
       SET participants = array_remove(h.participants, p_user_id)
     WHERE h.id = p_heist_id;
    RETURN 'reconciled';
  END IF;

  -- Frozen into the crew (claimed_at set) → settle normally on the payout path.
  IF v_claimed_at IS NOT NULL THEN
    RETURN 'in_crew';
  END IF;

  -- Unstamped but already settled (paid_at set) → a prior reconcile/settle already
  -- refunded this exact row; do not refund again. Ensure the array slot is gone
  -- too (a settle that raced an append could otherwise leave a ghost).
  IF v_paid_at IS NOT NULL THEN
    UPDATE public.economy_heists h
       SET participants = array_remove(h.participants, p_user_id)
     WHERE h.id = p_heist_id;
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

-- ─── 4. heist_undo_join (NEW) — fully undo a still-recruiting join ─────
-- Fixes the half-commit codex flagged (heist-manager.ts:491): if
-- heist_settle_missed_join exhausts its retries after a transient failure while
-- the heist is STILL recruiting (fee debited, participant row inserted, array
-- appended, but the settle RPC never committed), joinHeist previously left the
-- member fully joined yet told them the heist got underway and their refund could
-- not be processed — a later claim could then stamp + settle them as crew even
-- though they were told they did not join.
--
-- This RPC lets the join path cleanly UNDO that join under the heist-row lock,
-- but ONLY while the heist is still recruiting and this participant is NOT frozen
-- (claimed_at IS NULL) and NOT settled (paid_at IS NULL). It:
--   * deletes the participant row,
--   * removes the user from participants[],
--   * decrements success_chance by 7 (reversing array_append_heist_participant's
--     +7, floored so it never underflows the base chance below 0), and
--   * refunds the frozen entry_fee_paid (fallback p_refund_amount for a legacy row).
-- All in one transaction, so a member is never left fee-debited-but-unjoined.
--
-- Returns a TEXT status:
--   'undone'      — the join was rolled back and the fee refunded here.
--   'in_crew'     — the participant is already frozen into the crew (claimed_at
--                   set); the caller must NOT undo — the normal settle path pays
--                   or refunds them.
--   'not_recruiting' — the heist already left recruiting; undo is unsafe (the
--                   claim may have frozen the crew). The caller falls back to the
--                   honest "contact an admin" message; the resolver's bulk
--                   reconcile sweep will settle the stranded row.
--   'gone'        — heist or participant row already gone; nothing to undo.
-- Idempotent: a second call after 'undone' finds the row gone and returns 'gone'.
CREATE OR REPLACE FUNCTION heist_undo_join(
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
  v_guild_id   TEXT;
  v_claimed_at TIMESTAMPTZ;
  v_paid_at    TIMESTAMPTZ;
  v_frozen_fee INTEGER;
  v_refund     INTEGER;
BEGIN
  -- Lock the heist row: serialises against heist_claim_for_resolution so the
  -- status/claimed_at we read reflect whether the crew was already frozen.
  SELECT h.status, h.guild_id INTO v_status, v_guild_id
    FROM public.economy_heists h
   WHERE h.id = p_heist_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'gone';  -- heist already gone; nothing to undo
  END IF;

  -- The claim may have run between joinHeist's read and this call. Only a still
  -- recruiting heist is safe to undo: once claimed, a frozen crew member must be
  -- settled by the normal path, and a stranded row is reconciled by the sweep.
  IF v_status <> 'recruiting' THEN
    RETURN 'not_recruiting';
  END IF;

  SELECT p.claimed_at, p.paid_at, p.entry_fee_paid
    INTO v_claimed_at, v_paid_at, v_frozen_fee
    FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    -- Row already gone (a concurrent settle/undo removed it); ensure no ghost
    -- array slot survives, then report nothing to undo.
    UPDATE public.economy_heists h
       SET participants = array_remove(h.participants, p_user_id)
     WHERE h.id = p_heist_id;
    RETURN 'gone';
  END IF;

  -- Defensive: a recruiting heist should never have a stamped participant, but if
  -- it does the crew was frozen — leave it to the settle path.
  IF v_claimed_at IS NOT NULL THEN
    RETURN 'in_crew';
  END IF;

  -- Already settled (paid_at set) → a prior path refunded this row; just make sure
  -- the array slot is gone and report it as effectively undone.
  IF v_paid_at IS NOT NULL THEN
    UPDATE public.economy_heists h
       SET participants = array_remove(h.participants, p_user_id)
     WHERE h.id = p_heist_id;
    RETURN 'gone';
  END IF;

  -- Undo the join: refund the frozen fee, delete the row, drop the array slot,
  -- and reverse the +7 success_chance bump the append applied.
  v_refund := COALESCE(v_frozen_fee, p_refund_amount);

  DELETE FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id;

  UPDATE public.economy_heists h
     SET participants   = array_remove(h.participants, p_user_id),
         success_chance = GREATEST(0, h.success_chance - 7)
   WHERE h.id = p_heist_id;

  IF v_refund > 0 THEN
    PERFORM public.economy_add_balance(v_guild_id, p_user_id, v_refund);
  END IF;

  RETURN 'undone';
END;
$$;

REVOKE ALL ON FUNCTION heist_undo_join(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_undo_join(UUID, TEXT, INTEGER) TO service_role;
