-- Reject ticket purchases for a drawing that is no longer active.
--
-- Defect (codex review, PR #266): lottery_buy_tickets locks the drawing
-- row (FOR UPDATE) but never re-checks status after acquiring the lock.
-- A /lottery buy blocked on the row lock while the scheduler's
-- lottery_claim_drawing claims the drawing (status 'active' → 'drawing')
-- resumes after the claim commits and inserts tickets + increments the
-- jackpot AFTER the winner was already selected — charging the buyer for
-- tickets that can never win.
--
-- Fix: re-check status after FOR UPDATE. FOR UPDATE under READ COMMITTED
-- re-reads the latest committed row version, so a buy that waited out a
-- concurrent claim sees status='drawing' and aborts. The 'is not active'
-- marker in the error message is the typed contract the bot maps to a
-- refund + "drawing just closed" reply (see lottery-manager.ts).
--
-- DEPENDENCY: this re-creates lottery_buy_tickets from the definition in
-- 20260709160000_fix_lottery_buy_tickets_search_path (PR #267), which
-- schema-qualified pgcrypto's gen_random_bytes() as
-- extensions.gen_random_bytes() so it resolves under SET search_path = ''.
-- That fix is preserved verbatim here; only the status guard is added.
-- This file's later timestamp guarantees the composed definition wins in
-- any merge order of the two PRs, and it is self-contained (CREATE OR
-- REPLACE of the full body) so it also stands alone if #267 lands later.

CREATE OR REPLACE FUNCTION lottery_buy_tickets(
  p_drawing_id UUID,
  p_guild_id   TEXT,
  p_user_id    TEXT,
  p_count      INT,
  p_max        INT,
  p_cost       BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing INT;
  v_jackpot  BIGINT;
  v_status   TEXT;
BEGIN
  IF p_count <= 0 THEN
    RAISE EXCEPTION 'lottery_buy_tickets: count must be positive, got %', p_count;
  END IF;
  IF p_max <= 0 THEN
    RAISE EXCEPTION 'lottery_buy_tickets: max must be positive, got %', p_max;
  END IF;

  -- Lock the drawing row to serialize concurrent ticket purchases — and
  -- concurrent claim attempts: lottery_claim_drawing locks this same row.
  SELECT jackpot, status INTO v_jackpot, v_status
    FROM public.economy_lottery_drawings
   WHERE id = p_drawing_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lottery_buy_tickets: drawing % not found', p_drawing_id;
  END IF;

  -- Status guard AFTER the lock: a purchase that waited on the row lock
  -- while the drawing was claimed ('drawing'), finalised ('drawn') or
  -- cancelled must not append unwinnable tickets or inflate the jackpot.
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'lottery_buy_tickets: drawing % is not active (status=%)', p_drawing_id, v_status;
  END IF;

  -- Count existing tickets for this user+drawing
  SELECT COUNT(*)::INT INTO v_existing
    FROM public.economy_lottery_tickets
   WHERE drawing_id = p_drawing_id
     AND guild_id   = p_guild_id
     AND user_id    = p_user_id;

  IF v_existing + p_count > p_max THEN
    RAISE EXCEPTION 'lottery_buy_tickets: would exceed max tickets (existing=%, requested=%, max=%)',
      v_existing, p_count, p_max;
  END IF;

  -- Insert tickets using cryptographic random. Schema-qualified so the
  -- pgcrypto function resolves under SET search_path = ''.
  INSERT INTO public.economy_lottery_tickets (drawing_id, guild_id, user_id, ticket_number)
    SELECT p_drawing_id, p_guild_id, p_user_id,
           (get_byte(extensions.gen_random_bytes(2), 0) * 256 + get_byte(extensions.gen_random_bytes(2), 1)) % 10000
      FROM generate_series(1, p_count);

  -- Increment jackpot atomically within the same transaction
  UPDATE public.economy_lottery_drawings
     SET jackpot = jackpot + p_cost
   WHERE id = p_drawing_id
  RETURNING jackpot INTO v_jackpot;

  RETURN v_jackpot;
END;
$$;

REVOKE ALL ON FUNCTION lottery_buy_tickets(UUID, TEXT, TEXT, INT, INT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION lottery_buy_tickets(UUID, TEXT, TEXT, INT, INT, BIGINT) TO service_role;
