-- Fix: lottery_buy_tickets fails at runtime under empty search_path.
--
-- 20260613100000_v7_lottery_crypto_random.sql switched ticket-number
-- generation to gen_random_bytes() (pgcrypto) but left the call
-- UNQUALIFIED inside a SECURITY DEFINER function with SET search_path = ''.
-- On Supabase, pgcrypto is installed in the `extensions` schema (never
-- pg_catalog), so with an empty search_path every call raises
-- "function gen_random_bytes(integer) does not exist" — every ticket
-- purchase fails and bounces through the bot's refund path.
--
-- This migration re-creates the function identically to v7, changing only
-- the randomness resolution: gen_random_bytes() is schema-qualified as
-- extensions.gen_random_bytes(). No other semantics change (row locking,
-- max-ticket guard, jackpot increment, ticket_number in 0..9999).

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
