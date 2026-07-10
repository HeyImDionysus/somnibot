-- Heist ONE-SOURCE-OF-TRUTH refactor — derive crew + success_chance from the
-- participant ROWS; drop the denormalized participants[] array and the mutable
-- success_chance counter on economy_heists.
--
-- WHY (owner decision). Heist took nine codex rounds because it stored crew
-- membership TWICE — a denormalized economy_heists.participants text[] AND the
-- economy_heist_participants rows — plus a MUTABLE success_chance counter on the
-- heist row. Every membership change had to keep BOTH in sync:
--   * heist_join array_append + success_chance derive,
--   * heist_undo_join array_remove + success_chance recompute,
--   * heist_settle_missed_join / heist_reconcile_stranded_joins array_remove,
--   * the GDPR/ban purge array_remove (which did NOT recompute success_chance,
--     so the stored counter ALREADY drifted whenever a member was force-removed).
-- Each sync point is where the next bug hid. This migration removes the second
-- representation entirely: the participant ROWS are the single source of truth,
-- and everything the array/counter carried is DERIVED from them.
--
-- WHAT IS DERIVED, and from where:
--   * membership check  = EXISTS a row in economy_heist_participants;
--   * recruiting crew count = COUNT(*) of rows;
--   * frozen crew count = COUNT(*) WHERE claimed_at IS NOT NULL;
--   * success_chance    = LEAST(95, GREATEST(0,
--                            base_success_chance + (member_count - 1) * 7))
--     computed AT THE POINT OF USE. The resolution roll computes it from the
--     FROZEN crew count under the heist-row lock (deterministic); recruiting
--     display computes it from the live recruiting count.
--
-- THE ONLY new stored column is base_success_chance on economy_heists: the
-- single-member (base) chance = economy_heist_success_base_pct + the target's
-- difficulty modifier. It is guild-config + target-derived and IMMUTABLE for the
-- heist's life, set once at creation. It is the derivation anchor — it replaces
-- the mutable success_chance counter, which is deleted.
--
-- MONEY MODEL IS UNCHANGED. This migration changes STORAGE, not money rules.
-- Every property hardened across the prior nine rounds still holds and is
-- re-verified here:
--   * per-participant frozen entry_fee_paid at join; success pays frozen
--     payout_each to the frozen crew; cancel/failed/stranded refund each
--     participant's OWN entry_fee_paid;
--   * two participant classes (frozen crew claimed_at NOT NULL vs stranded
--     late-join claimed_at NULL) and the full settle matrix;
--   * idempotent (paid_at guard), retryable (in-process retry + resume),
--     finalize+announce only after money commits;
--   * crash reconciliation of stranded joins before terminalize;
--   * round-9 SERIALIZATION: join and resolution serialize under the heist-row
--     FOR UPDATE lock; a post-recruiting insert is impossible (heist_join
--     re-checks status='recruiting' under lock, debits nothing if not).
-- The roll's success_chance is now computed from base_success_chance + the
-- FROZEN crew count the claim just counted, INSTEAD of read from a stored column
-- that heist_join happened to have written to the same value — the number the
-- roll compares against is bit-for-bit identical, only its provenance changed
-- (derived under the lock vs. stored-then-read under the lock).
--
-- Forward-only, schema-qualified, SECURITY DEFINER + search_path=''; greenfield
-- DB (no live heist rows) so dropping the columns is safe. Every reader/writer of
-- the two columns is updated in THIS migration BEFORE the columns are dropped, so
-- no function is left referencing a dropped column.

-- ─── 1. The immutable derivation anchor ───────────────────────
-- base_success_chance = economy_heist_success_base_pct + target difficulty mod,
-- the single-member (N=1) chance. Set once at INSERT by the bot; never mutated.
-- Everything that needs success_chance derives it from this + a live/ frozen row
-- COUNT, so there is no counter to keep in sync and nothing to drift.
ALTER TABLE economy_heists
  ADD COLUMN IF NOT EXISTS base_success_chance INTEGER;

-- ─── 1a. BACKFILL the anchor from the stored counter BEFORE the drop ───────────
-- The DB is greenfield in CI, but a real deploy could run this while a heist is
-- mid-recruiting/in_progress. The new base_success_chance starts NULL and the
-- mutable success_chance is dropped in section 10 — so without this backfill an
-- in-flight heist would resolve via heist_claim_for_resolution with the base
-- COALESCEd to 0, recomputing its odds as (crew-1)*7 and LOSING the target/config
-- base chance it was recruiting under. Reverse the derivation to recover the
-- anchor from the stored counter that the old code kept in sync:
--     success_chance = LEAST(95, GREATEST(0, base + (member_count - 1) * 7))
--   ⇒ base           = success_chance - (member_count - 1) * 7
-- member_count is the crew the resolver will actually count: the FROZEN rows
-- (claimed_at IS NOT NULL) for an already-claimed in_progress heist, else the
-- live recruiting rows. Anchor at least the base-only floor via GREATEST so a
-- fully-clamped counter (success_chance = 95) still leaves a sane positive base.
-- Only heists that still resolve (recruiting / in_progress) matter; terminal rows
-- are historical and never re-rolled, but we backfill them too for a faithful
-- dashboard reconstruction. success_chance still exists at this point (dropped in
-- §10), so this reads it directly.
UPDATE economy_heists h
   SET base_success_chance = GREATEST(
         0,
         h.success_chance - (GREATEST(
           (SELECT COUNT(*)
              FROM economy_heist_participants p
             WHERE p.heist_id = h.id
               AND (h.status <> 'in_progress' OR p.claimed_at IS NOT NULL)
           ), 1) - 1) * 7
       )
 WHERE h.base_success_chance IS NULL;

-- ─── 2. heist_join — derive membership + count from rows; no array, no counter ──
-- Same atomic, serialized join under the heist-row FOR UPDATE lock the round-9
-- migration (20260710170000) established — the SAME lock heist_claim_for_resolution
-- takes, so join and resolution still serialize and a post-recruiting insert is
-- still structurally impossible. The only change is the source of truth:
--   * membership check  → EXISTS a participant row (was p_user_id = ANY(array));
--   * crew count / full → COUNT(*) of participant rows (was array_length);
--   * success_chance     → DERIVED and RETURNED (for the reply embed) from the
--     post-join count + p_base_chance, but NO LONGER stored on the heist row and
--     NO array is appended. The participant ROW is the only write.
-- The bot still passes p_base_chance (base pct + difficulty) so the reply can show
-- the derived chance without a follow-up read. Debit + insert commit together or
-- not at all (unchanged), so nothing can be charged without a row, or vice versa.
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
  v_status   TEXT;
  v_guild_id TEXT;
  v_count    INTEGER;
  v_chance   INTEGER;
  v_debited  BOOLEAN;
BEGIN
  -- Lock the heist row: the SAME lock heist_claim_for_resolution takes, so a
  -- concurrent claim and this join serialize. Whichever commits first wins; if
  -- the claim wins, we observe status <> 'recruiting' below and reject BEFORE any
  -- debit, so no fee is ever stranded past the recruiting → resolution edge.
  SELECT h.status, h.guild_id
    INTO v_status, v_guild_id
    FROM public.economy_heists h
   WHERE h.id = p_heist_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_heist'::TEXT, 0, 0, NULL::TEXT;
    RETURN;
  END IF;

  -- The current member count comes from the ROWS, under the heist-row lock. This
  -- is safe against a concurrent join: the two contend for the same FOR UPDATE
  -- lock, so their inserts serialize and neither reads a count that excludes the
  -- other's committed row.
  SELECT COUNT(*)::INTEGER INTO v_count
    FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id;

  -- Not recruiting → the claim already froze the crew (or the heist is gone
  -- terminal). Reject WITHOUT debiting. This is the structural guarantee: a join
  -- can never debit-then-insert after the status flips, because the flip and this
  -- check are gated by the same row lock.
  IF v_status <> 'recruiting' THEN
    RETURN QUERY SELECT 'not_recruiting'::TEXT, v_count, 0, NULL::TEXT;
    RETURN;
  END IF;

  -- Idempotent: already a participant (membership derived from the row, not an
  -- array). Report the DERIVED current chance for the reply.
  IF EXISTS (
    SELECT 1 FROM public.economy_heist_participants p
     WHERE p.heist_id = p_heist_id AND p.user_id = p_user_id
  ) THEN
    v_chance := LEAST(95, GREATEST(0, p_base_chance + (v_count - 1) * 7));
    RETURN QUERY SELECT 'already_joined'::TEXT, v_count, v_chance, NULL::TEXT;
    RETURN;
  END IF;

  -- Crew full — reject WITHOUT debiting.
  IF v_count >= p_max THEN
    v_chance := LEAST(95, GREATEST(0, p_base_chance + (v_count - 1) * 7));
    RETURN QUERY SELECT 'crew_full'::TEXT, v_count, v_chance, NULL::TEXT;
    RETURN;
  END IF;

  -- Debit the entry fee atomically. economy_subtract_balance RAISES on an
  -- insufficient/absent wallet; catch that ONE condition so the whole join rolls
  -- back with nothing charged. Keeping the debit inside this tx is what makes
  -- debit+insert atomic.
  BEGIN
    PERFORM public.economy_subtract_balance(v_guild_id, p_user_id, p_entry_fee);
    v_debited := true;
  EXCEPTION WHEN OTHERS THEN
    v_debited := false;
  END;

  IF NOT v_debited THEN
    v_chance := LEAST(95, GREATEST(0, p_base_chance + (v_count - 1) * 7));
    RETURN QUERY SELECT 'insufficient_funds'::TEXT, v_count, v_chance, NULL::TEXT;
    RETURN;
  END IF;

  -- Insert the participant row with the FROZEN entry fee this member paid. The
  -- UNIQUE (heist_id, user_id) constraint plus the EXISTS check keep this
  -- single-insert-per-user; a would-be duplicate was already returned above.
  -- This ROW is now the only representation of membership — no array to append.
  INSERT INTO public.economy_heist_participants
    (heist_id, guild_id, user_id, role, entry_fee_paid)
  VALUES (p_heist_id, v_guild_id, p_user_id, p_role, p_entry_fee);

  -- DERIVE the new member count + chance from the rows (this insert included);
  -- nothing is written back to the heist row. The roll at resolution re-derives
  -- from the frozen crew count, so this value is display-only.
  v_count  := v_count + 1;
  v_chance := LEAST(95, GREATEST(0, p_base_chance + (v_count - 1) * 7));

  RETURN QUERY SELECT 'joined'::TEXT, v_count, v_chance, p_role;
END;
$$;

REVOKE ALL ON FUNCTION heist_join(UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_join(UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER) TO service_role;

-- ─── 3. heist_claim_for_resolution — roll on the DERIVED chance ────────────────
-- Unchanged money/serialization behavior: locks the heist row FOR UPDATE, freezes
-- the crew by stamping claimed_at, counts the FROZEN rows, and single-shots the
-- outcome (too-few-crew → intermediate in_progress+cancelled; else CSPRNG roll →
-- in_progress+success with frozen payout_each, or in_progress+failed).
--
-- The ONLY change: the success roll no longer reads a stored success_chance
-- column. It reads base_success_chance (the immutable anchor) and DERIVES the
-- chance from the FROZEN crew count it just computed —
--   v_chance := LEAST(95, GREATEST(0, base + (v_count - 1) * 7))
-- — then rolls v_roll < v_chance. This is deterministic (v_count is frozen under
-- the lock) and drift-free: even if a member was force-removed by the GDPR/ban
-- purge mid-recruiting, the chance reflects the ACTUAL frozen crew, never a stale
-- counter. base_success_chance is COALESCEd to 0 defensively (a NULL anchor would
-- otherwise NULL the whole expression); the bot always sets it at INSERT.
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
  v_status        TEXT;
  v_target_payout INTEGER;
  v_base_chance   INTEGER;
  v_count         INTEGER;
  v_chance        INTEGER;
  v_roll          INTEGER;
  v_is_success    BOOLEAN;
  v_payout_each   INTEGER;
BEGIN
  -- Lock the heist row: every resolution path locks this same row, so the
  -- read-decide-write below cannot interleave with another resolver. Read the
  -- immutable base_success_chance anchor instead of a mutable stored counter.
  SELECT h.status, h.target_payout, h.base_success_chance
    INTO v_status, v_target_payout, v_base_chance
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
  -- to terminal 'cancelled' only after all refunds commit.
  IF v_count < p_min_participants THEN
    UPDATE public.economy_heists h
       SET status     = 'in_progress',
           resolution = 'cancelled'
     WHERE h.id = p_heist_id;

    RETURN QUERY SELECT true, 'cancelled'::TEXT, v_count, NULL::INTEGER;
    RETURN;
  END IF;

  -- DERIVE the success chance from the FROZEN crew count + the immutable anchor,
  -- clamped [0, 95] — the exact value heist_join reported per join, recomputed
  -- here from the crew the claim actually froze. Deterministic (v_count is frozen
  -- under the lock) and drift-free.
  v_chance := LEAST(95, GREATEST(0, COALESCE(v_base_chance, 0) + (v_count - 1) * 7));

  -- Roll success server-side with CSPRNG-backed randomness. pgcrypto's
  -- gen_random_bytes is schema-qualified (extensions.) so it resolves under
  -- SET search_path = ''. Two bytes give [0, 65536); bucketed to [0,100).
  v_roll := (get_byte(extensions.gen_random_bytes(2), 0) * 256
             + get_byte(extensions.gen_random_bytes(2), 1)) % 100;
  v_is_success := v_roll < v_chance;

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

-- ─── 4. heist_reconcile_stranded_joins — delete the row; no array_remove ───────
-- Identical sweep + refund + locking + idempotency as 20260710150000, minus the
-- now-impossible array maintenance. Deleting the participant ROW is the whole
-- removal — there is no participants[] slot to strip. Each stranded row is
-- refunded ITS OWN frozen entry_fee_paid (fallback p_refund_amount for a legacy
-- row).
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

    -- Deleting the ROW is the entire removal — the row is the single source of
    -- truth now; there is no participants[] slot to array_remove.
    DELETE FROM public.economy_heist_participants p
     WHERE p.heist_id = p_heist_id
       AND p.user_id  = v_user_id;

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

-- ─── 5. heist_settle_missed_join — TEXT-status contract; no array_remove ───────
-- Same TEXT-status contract and per-row frozen-fee refund as 20260710160000. With
-- the array gone, the 'reconciled' branches no longer need to strip a ghost array
-- slot (the finding-#3 fix existed ONLY to keep participants[] consistent with the
-- rows — there is now nothing to keep consistent). Deleting the row is the whole
-- removal. Kept as crash-window belt-and-braces / defense-in-depth exactly as
-- before; the happy path does not call it (heist_join owns the join).
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
  -- refunded. (No array slot to strip — the row was the only representation.)
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

  -- Raced past the claim: unstamped + unsettled. Delete the stranded row (the
  -- entire removal) and refund the FROZEN entry fee this joiner actually paid
  -- (fallback to the passed amount for a legacy pre-freeze row). Deleting is safe:
  -- an unstamped, unpaid row was never part of any payout/refund decision.
  v_refund := COALESCE(v_frozen_fee, p_refund_amount);

  DELETE FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id;

  IF v_refund > 0 THEN
    PERFORM public.economy_add_balance(v_guild_id, p_user_id, v_refund);
  END IF;

  RETURN 'refunded';
END;
$$;

REVOKE ALL ON FUNCTION heist_settle_missed_join(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_settle_missed_join(UUID, TEXT, INTEGER) TO service_role;

-- ─── 6. heist_undo_join — simplified: no counter to reverse, no array to strip ──
-- With success_chance derived (never stored), an undo has NOTHING to recompute:
-- the next derivation simply reads one fewer row. And with the array gone, there
-- is no participants[] slot to array_remove. The undo therefore collapses to its
-- money essence: for a STILL-RECRUITING, UNSTAMPED (claimed_at IS NULL),
-- UNSETTLED (paid_at IS NULL) participant, refund the frozen entry_fee_paid and
-- DELETE the row. Everything else derives itself.
--
-- The bot does NOT call this at HEAD (serialized join removed the settle/undo
-- dance); it is retained for crash-window belt-and-braces and MUST stay correct.
-- The p_base_chance parameter is now VESTIGIAL (nothing to recompute) but kept in
-- the signature so no caller breaks; it is ignored.
DROP FUNCTION IF EXISTS heist_undo_join(UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS heist_undo_join(UUID, TEXT, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION heist_undo_join(
  p_heist_id      UUID,
  p_user_id       TEXT,
  p_refund_amount INTEGER,
  p_base_chance   INTEGER DEFAULT NULL  -- vestigial: chance is derived, nothing to recompute
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
    RETURN 'gone';  -- row already gone (a concurrent settle/undo removed it)
  END IF;

  -- Defensive: a recruiting heist should never have a stamped participant, but if
  -- it does the crew was frozen — leave it to the settle path.
  IF v_claimed_at IS NOT NULL THEN
    RETURN 'in_crew';
  END IF;

  -- Already settled (paid_at set) → a prior path refunded this row; nothing to do.
  IF v_paid_at IS NOT NULL THEN
    RETURN 'gone';
  END IF;

  -- Undo the join: refund the frozen fee and delete the row. The reduced crew's
  -- success_chance needs no update — it is derived from the row COUNT at the next
  -- point of use, so removing this row lowers it automatically, drift-free,
  -- capped or not.
  v_refund := COALESCE(v_frozen_fee, p_refund_amount);

  DELETE FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id
     AND p.user_id  = p_user_id;

  IF v_refund > 0 THEN
    PERFORM public.economy_add_balance(v_guild_id, p_user_id, v_refund);
  END IF;

  RETURN 'undone';
END;
$$;

REVOKE ALL ON FUNCTION heist_undo_join(UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_undo_join(UUID, TEXT, INTEGER, INTEGER) TO service_role;

-- ─── 7. purge_member_data — drop ONLY the array UPDATE; keep everything else ───
-- The GDPR /forgetme purge already DELETEs the user's economy_heist_participants
-- rows, which — now that the rows are the single source of truth — is the ENTIRE
-- removal from any heist crew. Its trailing `UPDATE public.economy_heists SET
-- participants = array_remove(...)` maintained the redundant array; with the
-- column dropped it must go, or this function would error at call time on a
-- non-existent column. Dropping it also removes a latent drift: that UPDATE never
-- recomputed the stored success_chance, so a force-removed member used to leave
-- the counter overstated — deriving the chance from the (now reduced) row count
-- fixes that automatically.
--
-- IMPORTANT: this is the CURRENT (V9-audit) body from
-- 20260621000000_v9_audit_remediation.sql, re-created VERBATIM with ONLY the
-- economy_heists array UPDATE removed. Every other purge — economy tables,
-- levels, members, license-key REVOCATION (revoked_at + revocation_reason),
-- ENTITLEMENT cancellation, poll_votes, tickets anonymization, audit_logs
-- anonymization, and giveaway-entry removal — is preserved exactly so /forgetme's
-- GDPR guarantees are unchanged. Only the storage of heist crew membership moved.
CREATE OR REPLACE FUNCTION public.purge_member_data(
  p_guild_id text,
  p_user_id  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted jsonb := '{}'::jsonb;
  v_count   int;
BEGIN
  -- ── Economy data ──────────────────────────────────────────

  DELETE FROM public.economy_wallets
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_wallets', v_count);

  DELETE FROM public.economy_transactions
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_transactions', v_count);

  DELETE FROM public.economy_inventory
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_inventory', v_count);

  DELETE FROM public.economy_streaks
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_streaks', v_count);

  DELETE FROM public.economy_market_listings
    WHERE guild_id = p_guild_id AND seller_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_market_listings', v_count);

  DELETE FROM public.economy_farm_plots
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_farm_plots', v_count);

  DELETE FROM public.economy_fish_catches
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_fish_catches', v_count);

  DELETE FROM public.economy_adventure_sessions
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_adventure_sessions', v_count);

  DELETE FROM public.economy_trivia_sessions
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_trivia_sessions', v_count);

  DELETE FROM public.economy_lottery_tickets
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_lottery_tickets', v_count);

  DELETE FROM public.economy_pets
    WHERE guild_id = p_guild_id AND owner_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_pets', v_count);

  DELETE FROM public.economy_quest_progress
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_quest_progress', v_count);

  DELETE FROM public.economy_user_achievements
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_user_achievements', v_count);

  DELETE FROM public.economy_prestige
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_prestige', v_count);

  DELETE FROM public.economy_profiles
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_profiles', v_count);

  -- Deleting the participant rows IS the full removal from every heist crew now
  -- that the rows are the single source of truth (no participants[] array to
  -- maintain, no success_chance counter to recompute — both derive from these
  -- rows). ON DELETE CASCADE from economy_heists also covers rows for a purged
  -- guild; this scopes to the single user across all their heists.
  DELETE FROM public.economy_heist_participants
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_heist_participants', v_count);

  DELETE FROM public.economy_daily_losses
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_daily_losses', v_count);

  -- NOTE: the former `UPDATE public.economy_heists SET participants =
  -- array_remove(participants, p_user_id)` that stood here is intentionally
  -- REMOVED — the DELETE above is the whole removal now that the participant rows
  -- are the single source of truth and the participants[] column no longer exists.

  -- ── Levels data ───────────────────────────────────────────

  DELETE FROM public.member_levels
    WHERE guild_id = p_guild_id AND member_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('member_levels', v_count);

  -- ── Members table ─────────────────────────────────────────

  DELETE FROM public.members
    WHERE guild_id = p_guild_id AND discord_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('members', v_count);

  -- ── License keys — revoke + deactivate sessions ───────────
  -- V9 Audit §8.P3: /forgetme should revoke active license keys bound to this
  -- Discord user. Sessions are cascaded via ON DELETE but we explicitly
  -- deactivate them first for a clean audit trail.

  UPDATE public.license_sessions
  SET active = false,
      deactivated_at = now(),
      deactivation_reason = 'entitlement_revoked'
  WHERE license_key_id IN (
    SELECT id FROM public.license_keys
    WHERE guild_id = p_guild_id AND bound_discord_id = p_user_id
  ) AND active = true;

  UPDATE public.license_keys
  SET status = 'revoked',
      revoked_at = now(),
      revocation_reason = 'user_data_purge'
  WHERE guild_id = p_guild_id
    AND bound_discord_id = p_user_id
    AND status IN ('active', 'pending_activation');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('license_keys_revoked', v_count);

  -- Revoke matching entitlements
  UPDATE public.entitlements
  SET status = 'cancelled',
      cancelled_at = now()
  WHERE guild_id = p_guild_id
    AND customer_id IN (
      SELECT c.id FROM public.customers c
      WHERE c.discord_id = p_user_id AND c.guild_id = p_guild_id
    )
    AND status IN ('active', 'pending', 'grace_period');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('entitlements_revoked', v_count);

  -- ── Poll votes ────────────────────────────────────────────

  DELETE FROM public.poll_votes
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('poll_votes', v_count);

  -- ── Tickets — anonymize, don't delete (operational data) ──

  UPDATE public.tickets
  SET creator_id = 'deleted_user'
  WHERE guild_id = p_guild_id AND creator_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('tickets_anonymized', v_count);

  -- ── Audit logs — anonymize actor/target ───────────────────

  UPDATE public.audit_logs
  SET details = details || '{"anonymized": true}'::jsonb
  WHERE guild_id = p_guild_id
    AND (
      (actor_type = 'user' AND actor_id = p_user_id)
      OR (target_type = 'member' AND target_id = p_user_id)
    );

  -- ── Giveaway entries — remove ─────────────────────────────

  UPDATE public.giveaways
  SET entries = (
    SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
    FROM jsonb_array_elements(entries) elem
    WHERE elem->>'userId' != p_user_id
  )
  WHERE guild_id = p_guild_id
    AND entries @> jsonb_build_array(jsonb_build_object('userId', p_user_id));

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_member_data(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_member_data(text, text) TO service_role;

-- ─── 8. cleanup_member_economy — ban/leave forfeiture: REMOVE from derived crew ─
-- The V53 ban/leave cleanup (20260531000000) forfeits a departing member's active
-- heist participation. It zeroed their payout on the participant rows AND ran a
-- trailing `UPDATE economy_heists SET participants = array_remove(participants,
-- p_user_id)` to strip them from the denormalized crew array. With crew membership
-- now DERIVED from economy_heist_participants rows, `payout = 0` is INERT: the
-- resolver counts every claimed row (inflating the frozen crew size, chance, and
-- split denominator) and heist_credit_participant OVERWRITES payout with the real
-- share on the success path — so a forfeited member would still boost the odds and
-- be PAID. The forfeiture must remove them from the DERIVED crew, i.e. remove their
-- ROW (or make it unpayable), which is exactly what array_remove did for the array.
--
-- Money rule preserved from 20260531000000: forfeiture removes WITHOUT refund (the
-- old code dropped them from the array + zeroed payout and never credited an entry
-- fee back). We keep that: no entry fee is returned on a ban/kick/leave forfeiture.
--
-- Race-correct because it takes the SAME heist-row FOR UPDATE lock the resolver
-- (heist_claim_for_resolution) and the join (heist_join) take, so this serialises
-- against them. Per affected heist, decide by the participant row's freeze/pay
-- state:
--   * recruiting, row unclaimed (claimed_at IS NULL, paid_at IS NULL)
--       → DELETE the row. This is the whole removal from the derived crew before
--         the claim can freeze it — the exact analogue of the old array_remove.
--   * already frozen for resolution (claimed_at IS NOT NULL) but unpaid
--       (paid_at IS NULL)
--       → do NOT delete (the claim already counted this row into the frozen v_count
--         it sized payout_each for; deleting mid-resolution would corrupt that
--         count). Instead stamp paid_at = now(), payout = 0: heist_credit_participant
--         skips any row with paid_at IS NOT NULL, so the resolver never pays them —
--         their share is forfeited to the treasury. Idempotent and never double-pays.
--   * already paid (paid_at IS NOT NULL)
--       → leave it. The payout already settled; a best-effort cleanup does not claw
--         back a completed credit (same best-effort semantics as before).
-- v_heists_forfeited (a log-line count — see cross-feature-bridge.ts) is the number
-- of active-heist rows this forfeiture touched (deleted or paid_at-stamped).
-- search_path, grants, and all other behavior (listing cancel + item refund, wallet
-- suspend, return shape) are unchanged.
CREATE OR REPLACE FUNCTION public.cleanup_member_economy(
  p_guild_id text,
  p_user_id  text,
  p_reason   text DEFAULT 'left'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listings_cancelled int := 0;
  v_heists_forfeited   int := 0;
  v_wallet_suspended   boolean := false;
  v_items_refunded     jsonb := '[]'::jsonb;
  v_listing            record;
  v_heist_id           uuid;
  v_claimed_at         timestamptz;
  v_paid_at            timestamptz;
BEGIN
  -- ── Cancel active market listings and refund items ────────
  FOR v_listing IN
    SELECT id, item_id, remaining
    FROM economy_market_listings
    WHERE guild_id = p_guild_id
      AND seller_id = p_user_id
      AND status = 'active'
  LOOP
    -- Cancel the listing
    UPDATE economy_market_listings
    SET status = 'cancelled'
    WHERE id = v_listing.id;

    -- Return unsold items to inventory
    INSERT INTO economy_inventory (guild_id, user_id, item_id, quantity)
    VALUES (p_guild_id, p_user_id, v_listing.item_id, v_listing.remaining)
    ON CONFLICT (guild_id, user_id, item_id)
    DO UPDATE SET quantity = economy_inventory.quantity + EXCLUDED.quantity,
                  updated_at = now();

    v_listings_cancelled := v_listings_cancelled + 1;
    v_items_refunded := v_items_refunded || jsonb_build_object(
      'item_id', v_listing.item_id,
      'quantity', v_listing.remaining
    );
  END LOOP;

  -- ── Forfeit active heist participation ────────────────────
  -- Remove the member from every DERIVED crew of a still-active heist. Lock each
  -- heist row FOR UPDATE (serialising against heist_join / heist_claim_for_resolution)
  -- so the claimed_at / paid_at we read below reflect a settled freeze decision and
  -- no resolver can interleave with our remove.
  FOR v_heist_id IN
    SELECT p.heist_id
      FROM economy_heist_participants p
      JOIN economy_heists h ON h.id = p.heist_id
     WHERE p.guild_id = p_guild_id
       AND p.user_id  = p_user_id
       AND h.guild_id = p_guild_id
       AND h.status IN ('recruiting', 'in_progress')
  LOOP
    -- Take the heist-row lock (same lock the resolver/join take).
    PERFORM 1 FROM economy_heists h WHERE h.id = v_heist_id FOR UPDATE;

    -- Re-read the participant row under the lock to decide by its freeze/pay state.
    SELECT p.claimed_at, p.paid_at
      INTO v_claimed_at, v_paid_at
      FROM economy_heist_participants p
     WHERE p.heist_id = v_heist_id
       AND p.user_id  = p_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;  -- row already gone (a concurrent settle/purge removed it)
    END IF;

    IF v_paid_at IS NOT NULL THEN
      -- Already settled — do not claw back a completed credit.
      CONTINUE;
    END IF;

    IF v_claimed_at IS NULL THEN
      -- Still recruiting / unclaimed: DELETE the row — the whole removal from the
      -- derived crew, before any claim can freeze it. No refund (forfeiture).
      DELETE FROM economy_heist_participants p
       WHERE p.heist_id = v_heist_id
         AND p.user_id  = p_user_id;
    ELSE
      -- Frozen for resolution but unpaid: mark unpayable (paid_at + payout 0) so
      -- heist_credit_participant skips them; their share is forfeited, not paid.
      UPDATE economy_heist_participants p
         SET paid_at = now(),
             payout  = 0
       WHERE p.heist_id = v_heist_id
         AND p.user_id  = p_user_id;
    END IF;

    v_heists_forfeited := v_heists_forfeited + 1;
  END LOOP;

  -- NOTE: the former `UPDATE economy_heists SET participants =
  -- array_remove(participants, p_user_id)` that stood here is intentionally
  -- REMOVED — crew membership lives only in economy_heist_participants now (and the
  -- participants[] column no longer exists). Deleting / stamping the row above IS
  -- the whole removal from the derived crew.

  -- ── Suspend wallet ────────────────────────────────────────
  UPDATE economy_wallets
  SET suspended = true,
      suspended_at = now(),
      suspended_reason = p_reason,
      updated_at = now()
  WHERE guild_id = p_guild_id
    AND user_id = p_user_id
    AND suspended = false;

  IF FOUND THEN
    v_wallet_suspended := true;
  END IF;

  RETURN jsonb_build_object(
    'listings_cancelled', v_listings_cancelled,
    'heists_forfeited',   v_heists_forfeited,
    'wallet_suspended',   v_wallet_suspended,
    'items_refunded',     v_items_refunded
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_member_economy(text, text, text) TO service_role;

-- ─── 9. Drop the now-dead legacy append RPC ───────────────────
-- array_append_heist_participant only ever appended to participants[] and bumped
-- the success_chance counter. Both are gone; the happy path bypassed it since the
-- round-9 serialized join. Nothing references it — drop it so no path can regress
-- to array-based membership.
DROP FUNCTION IF EXISTS array_append_heist_participant(UUID, TEXT);

-- ─── 10. Drop the denormalized columns — ONE representation remains ────────────
-- Every reader/writer above now uses the participant rows + base_success_chance.
-- Dropping participants[] and the mutable success_chance counter leaves exactly
-- one source of truth for crew membership and one immutable anchor for the chance.
-- Greenfield DB, so no data migration is needed.
ALTER TABLE economy_heists
  DROP COLUMN IF EXISTS participants,
  DROP COLUMN IF EXISTS success_chance;

-- ─── 11. heist_start — insert the heist AND the initiator row ATOMICALLY ────────
-- Now that crew membership is DERIVED from economy_heist_participants rows, the
-- initiator's row MUST exist atomically with (or before) the heist row becomes
-- visible/derivable. The bot previously INSERTed the heist row (committing it,
-- exposing status='recruiting') and THEN inserted the initiator participant row in
-- a second statement. In the gap between them the crew derives with the initiator
-- MISSING: a concurrent /heist join reads the recruiting heist, counts 0 rows, and
-- can fill up to p_max — then the initiator insert adds one more, exceeding max and
-- deriving the wrong crew count/chance; and a resolution that raced the gap would
-- freeze a crew that excludes the initiator.
--
-- This RPC does BOTH inserts in ONE transaction, so the heist row and the
-- initiator participant row commit together — the heist is never derivable without
-- its initiator. The partial unique index uniq_active_heist_per_guild still guards
-- the "one active heist per guild" race: if a concurrent /heist start already
-- committed a recruiting/in_progress heist, THIS insert raises 23505, the whole tx
-- (including the initiator row) rolls back, and we surface 'duplicate_active' so
-- the bot refunds the entry fee — nothing is half-inserted. The fee was already
-- debited by the caller (kept there so an insufficient-funds check short-circuits
-- before we touch heist state); on any failure the bot refunds it, exactly as the
-- two-statement path did.
DROP FUNCTION IF EXISTS heist_start(TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION heist_start(
  p_guild_id    TEXT,
  p_user_id     TEXT,
  p_target_name TEXT,
  p_target_payout INTEGER,
  p_base_chance INTEGER,
  p_expires_at  TEXT,
  p_role        TEXT,
  p_entry_fee   INTEGER
)
RETURNS TABLE (
  status   TEXT,
  heist_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_heist_id UUID;
BEGIN
  -- Insert the heist row. The partial unique index makes this fail with 23505 if
  -- another active heist already exists for the guild; we catch it below.
  INSERT INTO public.economy_heists
    (guild_id, initiator_id, target_name, target_payout, base_success_chance, expires_at)
  VALUES
    (p_guild_id, p_user_id, p_target_name, p_target_payout, p_base_chance, p_expires_at::timestamptz)
  RETURNING id INTO v_heist_id;

  -- Insert the initiator participant row in the SAME transaction with the frozen
  -- entry fee they paid. Committed together with the heist row above, so the crew
  -- is NEVER derived without the initiator.
  INSERT INTO public.economy_heist_participants
    (heist_id, guild_id, user_id, role, entry_fee_paid)
  VALUES
    (v_heist_id, p_guild_id, p_user_id, p_role, p_entry_fee);

  RETURN QUERY SELECT 'started'::TEXT, v_heist_id;
EXCEPTION
  WHEN unique_violation THEN
    -- Another active heist won the race (uniq_active_heist_per_guild) OR a
    -- duplicate initiator row — either way the whole tx rolls back; nothing was
    -- inserted. The bot refunds the entry fee.
    RETURN QUERY SELECT 'duplicate_active'::TEXT, NULL::UUID;
END;
$$;

REVOKE ALL ON FUNCTION heist_start(TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_start(TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, INTEGER) TO service_role;
