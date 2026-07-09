-- Lottery stable winner + idempotent payout.
--
-- Defect: lottery_claim_drawing (V48) atomically claimed a drawing, but the
-- winning ticket was picked bot-side AFTER the claim and the jackpot payout
-- was a separate economy_add_balance call. When the payout failed the bot
-- flipped the drawing back to 'active' so the next tick would retry — and the
-- retry re-picked a winner from scratch, so a DIFFERENT user could win. If
-- the "failed" payout had actually landed server-side (e.g. the response was
-- lost), the retry double-paid. The v31 status CHECK was also never widened
-- to allow the 'drawing' intermediate state V48 introduced, so the claim
-- UPDATE violated the constraint on a fresh schema.
--
-- Fix:
--   1. Widen the status CHECK to include 'drawing' (claimed, payout pending).
--   2. Track payout state on the drawing row (winner_paid_at).
--   3. lottery_claim_drawing now selects AND stores the winning ticket inside
--      the same atomic claim, so the winner is decided exactly once.
--   4. New lottery_award_jackpot pays the STORED winner and finalises the
--      drawing (status='drawn', winner_paid_at) in the same transaction — a
--      payout can never land without the row being marked paid, so retries
--      are idempotent and always pay the same winner.

-- ─── 1. Allow the 'drawing' intermediate status ───────────────
-- V48 sets status='drawing' during the claim, but the v31 CHECK only allowed
-- ('active', 'drawn', 'cancelled').
ALTER TABLE economy_lottery_drawings
  DROP CONSTRAINT IF EXISTS economy_lottery_drawings_status_check;
ALTER TABLE economy_lottery_drawings
  ADD CONSTRAINT economy_lottery_drawings_status_check
  CHECK (status IN ('active', 'drawing', 'drawn', 'cancelled'));

-- ─── 2. Payout state on the drawing row ───────────────────────
-- NULL while the payout is pending; set (with status='drawn') in the same
-- transaction as the wallet credit, so "paid" and "credited" can never
-- diverge.
ALTER TABLE economy_lottery_drawings
  ADD COLUMN IF NOT EXISTS winner_paid_at TIMESTAMPTZ;

-- ─── 3. Claim + winner selection in one transaction ───────────
-- Flips status 'active' → 'drawing' iff the row is still active, and stores
-- the winning ticket on the row in the same statement. Returns the drawing
-- exactly when this caller claimed it; no rows means another worker already
-- claimed it, or the drawing has no tickets (left 'active' so the scheduler's
-- "no entries" path can cancel/reset it).
-- We must DROP first because the return type gains the winner columns and
-- Postgres cannot ALTER a function's return type via CREATE OR REPLACE.
DROP FUNCTION IF EXISTS lottery_claim_drawing(UUID);

CREATE OR REPLACE FUNCTION lottery_claim_drawing(
  p_drawing_id UUID
)
RETURNS TABLE (
  id             UUID,
  guild_id       TEXT,
  jackpot        INTEGER,
  winner_user_id TEXT,
  winning_number INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status TEXT;
  v_winner RECORD;
BEGIN
  -- Lock the drawing row to serialise concurrent claim attempts.
  SELECT d.status INTO v_status
    FROM public.economy_lottery_drawings d
   WHERE d.id = p_drawing_id
     FOR UPDATE;

  IF NOT FOUND OR v_status <> 'active' THEN
    RETURN;  -- already claimed / drawn / cancelled — caller must not draw
  END IF;

  -- Pick the winning ticket. gen_random_uuid() is pg_catalog-resident (safe
  -- with the empty search_path) and CSPRNG-backed, matching the crypto
  -- random policy (V7 Audit §4.P3b).
  SELECT t.user_id, t.ticket_number INTO v_winner
    FROM public.economy_lottery_tickets t
   WHERE t.drawing_id = p_drawing_id
   ORDER BY gen_random_uuid()
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;  -- no tickets — leave 'active' for the scheduler's reset path
  END IF;

  RETURN QUERY
  UPDATE public.economy_lottery_drawings d
     SET status         = 'drawing',  -- intermediate state; lottery_award_jackpot flips to 'drawn'
         winner_user_id = v_winner.user_id,
         winning_number = v_winner.ticket_number
   WHERE d.id = p_drawing_id
  RETURNING d.id, d.guild_id, d.jackpot, d.winner_user_id, d.winning_number;
END;
$$;

REVOKE ALL ON FUNCTION lottery_claim_drawing(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION lottery_claim_drawing(UUID) TO service_role;

-- ─── 4. Idempotent payout of the stored winner ────────────────
-- Credits the jackpot to the winner stored at claim time and finalises the
-- drawing in ONE transaction. Returns the drawing exactly when this call
-- performed the payout; no rows means the drawing is not claimed or the
-- payout already happened — the caller must NOT pay again. A retry after a
-- failed call therefore pays the same stored winner exactly once.
CREATE OR REPLACE FUNCTION lottery_award_jackpot(
  p_drawing_id UUID
)
RETURNS TABLE (
  id             UUID,
  guild_id       TEXT,
  jackpot        INTEGER,
  winner_user_id TEXT,
  winning_number INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_drawing RECORD;
BEGIN
  SELECT d.guild_id, d.jackpot, d.status, d.winner_user_id, d.winner_paid_at
    INTO v_drawing
    FROM public.economy_lottery_drawings d
   WHERE d.id = p_drawing_id
     FOR UPDATE;

  IF NOT FOUND
     OR v_drawing.status <> 'drawing'
     OR v_drawing.winner_user_id IS NULL
     OR v_drawing.winner_paid_at IS NOT NULL THEN
    RETURN;  -- not claimed with a stored winner, or already paid — never pay twice
  END IF;

  -- Wallet credit and finalisation share this transaction: a payout can
  -- never land without the row being marked paid (and vice versa).
  IF v_drawing.jackpot > 0 THEN
    PERFORM public.economy_add_balance(
      v_drawing.guild_id,
      v_drawing.winner_user_id,
      v_drawing.jackpot::BIGINT
    );
  END IF;

  RETURN QUERY
  UPDATE public.economy_lottery_drawings d
     SET status         = 'drawn',
         winner_paid_at = now(),
         drawn_at       = now()
   WHERE d.id = p_drawing_id
  RETURNING d.id, d.guild_id, d.jackpot, d.winner_user_id, d.winning_number;
END;
$$;

REVOKE ALL ON FUNCTION lottery_award_jackpot(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION lottery_award_jackpot(UUID) TO service_role;
