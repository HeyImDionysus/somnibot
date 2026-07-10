-- Heist join SERIALIZATION — close the join-vs-resolution race at its source.
--
-- Prior migrations (up to 20260710160000) chased the "stranded late-join fee"
-- defect with cleanup mechanisms AFTER the fact: heist_settle_missed_join,
-- heist_reconcile_stranded_joins, and heist_undo_join. Every one of them exists
-- because /heist join performed its debit, participant insert, and array append
-- as SEPARATE, unlocked statements, so heist_claim_for_resolution (which locks
-- the heist row FOR UPDATE) could slip between the join's status read and its
-- insert — stranding a fee for a seat that never joins the frozen crew. codex
-- (heist-manager.ts:797) showed the residual gap: a join can still insert AFTER
-- heist_reconcile_stranded_joins sweeps but BEFORE the heist terminalizes, so a
-- sweep can never fully close the window — it only races it.
--
-- This migration removes the window instead of sweeping it. It adds ONE atomic
-- RPC, heist_join, that does the whole join — re-check status, debit, insert,
-- append, bump success_chance — inside a SINGLE transaction under the SAME
-- heist-row lock (FOR UPDATE) that heist_claim_for_resolution takes. The two
-- now serialize at the row lock:
--   * If the join commits first, its participant row exists and is stamped by
--     the later claim's `UPDATE ... SET claimed_at WHERE claimed_at IS NULL`, so
--     the member is in the frozen crew — no strand.
--   * If the claim commits first, the join's FOR UPDATE blocks until the claim
--     releases the lock, then observes status <> 'recruiting' and REJECTS before
--     any debit — nothing is charged, so there is nothing to strand or refund.
-- A post-recruiting insert is now STRUCTURALLY IMPOSSIBLE: no join can debit-then-
-- insert once the heist has left 'recruiting', because the same lock that flips
-- the status also gates the join's status check. No sweep-timing gap can exist.
--
-- It ALSO fixes the success_chance-undo drift codex flagged (migration
-- 20260710160000:385): the old heist_undo_join reversed the join's
-- `success_chance = LEAST(95, chance + 7)` with a naive `chance - 7`. When the
-- +7 bump was CAPPED at join (a high-base or large crew already at 95), no 7 was
-- actually added, so subtracting 7 on undo permanently lowered the remaining
-- crew's chance below its true value. The fix here is to stop treating
-- success_chance as a reversible mutable counter on the join/undo paths and
-- instead DERIVE it from the participant count every time, clamped to [0, 95]:
--     success_chance = LEAST(95, GREATEST(0, base_chance + (member_count - 1) * 7))
-- where base_chance is the single-member chance (base success pct + the target's
-- difficulty modifier) the bot passes in. Deriving from count is drift-free: an
-- undo simply recomputes for member_count - 1, and a capped value is recomputed,
-- never under/over-corrected. (array_append_heist_participant's counter bump is
-- now bypassed by the join path entirely — heist_join owns the value.)
--
-- Forward-only, schema-qualified, SECURITY DEFINER + search_path=''; greenfield
-- DB. The legacy cleanup RPCs (heist_settle_missed_join,
-- heist_reconcile_stranded_joins, heist_undo_join) are kept as crash-window
-- belt-and-braces (a bot crash BETWEEN the RPC commit and joinHeist reading its
-- result cannot strand a fee — the debit+insert are one commit — but the sweep
-- is harmless and idempotent, so it stays as defense-in-depth for any pre-
-- migration row or unforeseen path).

-- ─── heist_join — atomic, serialized join under the heist-row lock ─────
-- Returns a single row describing the outcome so the bot can render the right
-- reply without any follow-up settle/undo call on the happy path:
--   status            TEXT — one of:
--     'joined'        the member joined; row inserted, fee debited, array +
--                     success_chance updated, ALL in this transaction.
--     'not_recruiting' the heist already left 'recruiting' (claim won the lock
--                     first, or it expired/terminalized). NOTHING was debited.
--     'already_joined' the user is already a participant (idempotent no-op).
--     'crew_full'     participants already at p_max. NOTHING was debited.
--     'insufficient_funds' the debit found wallet < fee. NOTHING was inserted.
--     'no_heist'      no such heist row.
--   member_count      INTEGER — participant count AFTER a successful join (for
--                     'joined'); the current count otherwise. 0 when no heist.
--   success_chance    INTEGER — the heist's success_chance AFTER a successful
--                     join (derived, clamped); current value otherwise.
--   role              TEXT — the role assigned to the joiner ('joined' only).
--
-- The bot passes p_role (it owns role randomization) and p_base_chance (base
-- success pct + this target's difficulty modifier, i.e. the 1-member chance) so
-- the RPC can DERIVE success_chance from the post-join count rather than mutate a
-- counter. All money and row mutations commit together or not at all.
DROP FUNCTION IF EXISTS heist_join(UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION heist_join(
  p_heist_id     UUID,
  p_user_id      TEXT,
  p_role         TEXT,
  p_entry_fee    INTEGER,
  p_max          INTEGER,
  p_base_chance  INTEGER
)
RETURNS TABLE (
  status         TEXT,
  member_count   INTEGER,
  success_chance INTEGER,
  role           TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status       TEXT;
  v_guild_id     TEXT;
  v_participants TEXT[];
  v_count        INTEGER;
  v_chance       INTEGER;
  v_debited      BOOLEAN;
BEGIN
  -- Lock the heist row: this is the SAME lock heist_claim_for_resolution takes,
  -- so a concurrent claim and this join serialize. Whichever commits first wins;
  -- if the claim wins, we observe status <> 'recruiting' below and reject BEFORE
  -- any debit, so no fee is ever stranded past the recruiting → resolution edge.
  SELECT h.status, h.guild_id, h.participants
    INTO v_status, v_guild_id, v_participants
    FROM public.economy_heists h
   WHERE h.id = p_heist_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_heist'::TEXT, 0, 0, NULL::TEXT;
    RETURN;
  END IF;

  -- Not recruiting → the claim already froze the crew (or the heist is gone
  -- terminal). Reject WITHOUT debiting. This is the structural guarantee: a join
  -- can never debit-then-insert after the status flips, because the flip and this
  -- check are gated by the same row lock.
  IF v_status <> 'recruiting' THEN
    RETURN QUERY SELECT 'not_recruiting'::TEXT,
                        COALESCE(array_length(v_participants, 1), 0),
                        0, NULL::TEXT;
    RETURN;
  END IF;

  -- Idempotent: already a participant.
  IF p_user_id = ANY(COALESCE(v_participants, ARRAY[]::TEXT[])) THEN
    SELECT h.success_chance INTO v_chance
      FROM public.economy_heists h WHERE h.id = p_heist_id;
    RETURN QUERY SELECT 'already_joined'::TEXT,
                        COALESCE(array_length(v_participants, 1), 0),
                        v_chance, NULL::TEXT;
    RETURN;
  END IF;

  -- Crew full — reject WITHOUT debiting.
  IF COALESCE(array_length(v_participants, 1), 0) >= p_max THEN
    SELECT h.success_chance INTO v_chance
      FROM public.economy_heists h WHERE h.id = p_heist_id;
    RETURN QUERY SELECT 'crew_full'::TEXT,
                        COALESCE(array_length(v_participants, 1), 0),
                        v_chance, NULL::TEXT;
    RETURN;
  END IF;

  -- Debit the entry fee atomically. economy_subtract_balance RAISES on an
  -- insufficient/absent wallet; catch that ONE condition and report it cleanly so
  -- the whole join rolls back with nothing charged. (A defensive guard — the bot
  -- checks the wallet before calling — but keeping the debit inside this tx is
  -- what makes debit+insert atomic.)
  BEGIN
    PERFORM public.economy_subtract_balance(v_guild_id, p_user_id, p_entry_fee);
    v_debited := true;
  EXCEPTION WHEN OTHERS THEN
    v_debited := false;
  END;

  IF NOT v_debited THEN
    SELECT h.success_chance INTO v_chance
      FROM public.economy_heists h WHERE h.id = p_heist_id;
    RETURN QUERY SELECT 'insufficient_funds'::TEXT,
                        COALESCE(array_length(v_participants, 1), 0),
                        v_chance, NULL::TEXT;
    RETURN;
  END IF;

  -- Insert the participant row with the FROZEN entry fee this member paid. The
  -- UNIQUE (heist_id, user_id) constraint plus the earlier ANY() check keep this
  -- single-insert-per-user; a would-be duplicate was already returned above.
  INSERT INTO public.economy_heist_participants
    (heist_id, guild_id, user_id, role, entry_fee_paid)
  VALUES (p_heist_id, v_guild_id, p_user_id, p_role, p_entry_fee);

  -- Append to participants[] and DERIVE success_chance from the new member count
  -- (drift-free; never a mutable +7 counter). member_count = old length + 1.
  v_count := COALESCE(array_length(v_participants, 1), 0) + 1;
  v_chance := LEAST(95, GREATEST(0, p_base_chance + (v_count - 1) * 7));

  UPDATE public.economy_heists h
     SET participants   = array_append(h.participants, p_user_id),
         success_chance = v_chance
   WHERE h.id = p_heist_id;

  RETURN QUERY SELECT 'joined'::TEXT, v_count, v_chance, p_role;
END;
$$;

REVOKE ALL ON FUNCTION heist_join(UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_join(UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER) TO service_role;

-- ─── heist_undo_join — recompute success_chance from count, not a -7 delta ─────
-- codex (migration 20260710160000:385): the old undo reversed a possibly-CAPPED
-- +7 with a naive `success_chance - 7`, permanently mis-lowering a crew whose
-- join bump had been capped at 95. With serialized joins the undo path is now
-- effectively unreachable on the happy path (heist_join no longer needs a
-- separate settle call, so there is no "settle failed, undo the join" branch for
-- a fresh join), but the RPC is retained for the crash-window belt-and-braces and
-- MUST be correct if ever invoked. Rewrite it to DERIVE success_chance from the
-- post-removal member count, clamped to [0, 95], exactly like heist_join — so an
-- undo restores the precise value a crew of (count - 1) should have, capped or
-- not, with zero drift. The bot passes p_base_chance (the 1-member chance) as the
-- derivation anchor; a NULL falls back to the old floored decrement for any
-- legacy caller that cannot supply it.
DROP FUNCTION IF EXISTS heist_undo_join(UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS heist_undo_join(UUID, TEXT, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION heist_undo_join(
  p_heist_id      UUID,
  p_user_id       TEXT,
  p_refund_amount INTEGER,
  p_base_chance   INTEGER DEFAULT NULL
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
  v_new_count  INTEGER;
  v_chance     INTEGER;
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

  -- Only a still-recruiting heist is safe to undo: once claimed, a frozen crew
  -- member must be settled by the normal path, and a stranded row is reconciled
  -- by the sweep.
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
  -- and RECOMPUTE success_chance for the reduced crew — derived from the post-
  -- removal count and clamped, never a naive -7 that would drift a capped value.
  v_refund := COALESCE(v_frozen_fee, p_refund_amount);

  DELETE FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id;

  UPDATE public.economy_heists h
     SET participants = array_remove(h.participants, p_user_id)
   WHERE h.id = p_heist_id
   RETURNING COALESCE(array_length(h.participants, 1), 0) INTO v_new_count;

  IF p_base_chance IS NOT NULL THEN
    -- Drift-free: the correct chance for a crew of v_new_count, capped/floored.
    v_chance := LEAST(95, GREATEST(0, p_base_chance + (v_new_count - 1) * 7));
    UPDATE public.economy_heists h
       SET success_chance = v_chance
     WHERE h.id = p_heist_id;
  ELSE
    -- Legacy fallback (no anchor supplied): floored decrement. Kept only so an
    -- old caller cannot error; new callers always pass p_base_chance.
    UPDATE public.economy_heists h
       SET success_chance = GREATEST(0, h.success_chance - 7)
     WHERE h.id = p_heist_id;
  END IF;

  IF v_refund > 0 THEN
    PERFORM public.economy_add_balance(v_guild_id, p_user_id, v_refund);
  END IF;

  RETURN 'undone';
END;
$$;

REVOKE ALL ON FUNCTION heist_undo_join(UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_undo_join(UUID, TEXT, INTEGER, INTEGER) TO service_role;
