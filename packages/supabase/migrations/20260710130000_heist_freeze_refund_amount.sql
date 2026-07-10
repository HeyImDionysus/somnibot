-- Heist refund-amount freeze — the last money-integrity gap in resolution.
--
-- Recurring class (codex, multiple rounds): heist money must be FROZEN at claim
-- time, RETRIED until it commits, and the heist FINALIZED only after every
-- credit/refund lands. 20260710060000 froze the SUCCESS payout (payout_each) on
-- the row at claim time, and 20260710120000 made the cancel path retryable. But
-- the CANCEL refund amount was still re-derived from guild_config
-- (economy_heist_entry_fee) on every resolve/retry. If an operator edits the
-- entry fee between the claim and a later in-process retry or resumePendingHeists
-- resume, the frozen crew would be refunded the NEW fee, not what they were
-- charged — a refund that can double or lose value exactly as the success payout
-- once could before payout_each was frozen.
--
-- Fix: freeze the per-member refund on the heist row at claim time, symmetric
-- with payout_each. heist_claim_for_resolution now takes the entry fee and, on
-- the under-crewed branch, stores it in economy_heists.refund_each. The bot reads
-- the refund amount from the frozen row for BOTH the fresh-claim path and every
-- resume/retry — config is never consulted for a refund again. This closes the
-- "re-read amount on retry" defect on the last remaining money path.
--
-- refund_each is set ONLY on the cancelled branch (success/failed carry
-- payout_each instead); NULL otherwise. A resumed cancelled heist reads
-- refund_each off the row, so a fee edit after the claim can neither inflate nor
-- shrink an in-flight refund.

-- ─── 1. Frozen per-member refund carried on the heist row ─────
ALTER TABLE economy_heists
  ADD COLUMN IF NOT EXISTS refund_each INTEGER;

-- ─── 2. Claim freezes the refund amount alongside the cancel decision ───
-- Signature change (added p_entry_fee + refund_each in the result), so the old
-- 2-arg form must be dropped before recreation. Every caller passes the entry
-- fee that was charged, and the under-crewed branch persists it as refund_each
-- so all later refund retries read a frozen value, never guild_config.
DROP FUNCTION IF EXISTS heist_claim_for_resolution(UUID, INTEGER);

CREATE OR REPLACE FUNCTION heist_claim_for_resolution(
  p_heist_id          UUID,
  p_min_participants  INTEGER,
  p_entry_fee         INTEGER
)
RETURNS TABLE (
  claimed           BOOLEAN,
  outcome           TEXT,
  participant_count INTEGER,
  payout_each       INTEGER,
  refund_each       INTEGER
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
    RETURN QUERY SELECT false, NULL::TEXT, 0, NULL::INTEGER, NULL::INTEGER;
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
  -- 'cancelled' (NOT terminal). Freeze the per-member refund (p_entry_fee) on
  -- the row so every later refund retry reads the SAME amount that was charged,
  -- never a mutated guild_config value. The caller refunds idempotently and
  -- heist_finalize_resolution moves the row to terminal 'cancelled' only after
  -- all refunds succeed; a failed refund leaves it in_progress and retryable.
  IF v_count < p_min_participants THEN
    UPDATE public.economy_heists h
       SET status      = 'in_progress',
           resolution  = 'cancelled',
           refund_each = p_entry_fee
     WHERE h.id = p_heist_id;

    RETURN QUERY SELECT true, 'cancelled'::TEXT, v_count, NULL::INTEGER, p_entry_fee;
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

    RETURN QUERY SELECT true, 'success'::TEXT, v_count, v_payout_each, NULL::INTEGER;
  ELSE
    UPDATE public.economy_heists h
       SET status      = 'in_progress',
           resolution  = 'failed',
           payout_each = 0
     WHERE h.id = p_heist_id;

    RETURN QUERY SELECT true, 'failed'::TEXT, v_count, 0, NULL::INTEGER;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION heist_claim_for_resolution(UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heist_claim_for_resolution(UUID, INTEGER, INTEGER) TO service_role;
