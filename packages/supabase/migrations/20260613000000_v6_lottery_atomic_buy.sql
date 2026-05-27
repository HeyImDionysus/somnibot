-- V6 Audit §4.2: Atomic lottery ticket purchase
-- Replaces the TOCTOU-vulnerable SELECT-then-INSERT pattern with an
-- atomic RPC that checks existing ticket count, inserts new tickets,
-- and increments the jackpot inside a single transaction. Prevents
-- concurrent buyTickets calls from exceeding the per-user maxTickets
-- limit and ensures ticket-insert + jackpot-update are never split.

CREATE OR REPLACE FUNCTION lottery_buy_tickets(
  p_drawing_id UUID,
  p_guild_id   TEXT,
  p_user_id    TEXT,
  p_count      INT,
  p_max        INT,
  p_cost       BIGINT
)
RETURNS BIGINT  -- returns updated jackpot amount
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing INT;
  v_jackpot  BIGINT;
BEGIN
  IF p_count <= 0 THEN
    RAISE EXCEPTION 'lottery_buy_tickets: count must be positive, got %', p_count;
  END IF;
  IF p_max <= 0 THEN
    RAISE EXCEPTION 'lottery_buy_tickets: max must be positive, got %', p_max;
  END IF;

  -- Lock the drawing row to serialize concurrent ticket purchases
  SELECT jackpot INTO v_jackpot
    FROM public.economy_lottery_drawings
   WHERE id = p_drawing_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lottery_buy_tickets: drawing % not found', p_drawing_id;
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

  -- Insert tickets
  INSERT INTO public.economy_lottery_tickets (drawing_id, guild_id, user_id, ticket_number)
    SELECT p_drawing_id, p_guild_id, p_user_id,
           floor(random() * 10000)::INT
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
