-- =============================================================================
-- Atomic, idempotent /lottery buy and /prestige.
--
-- Both moved money without an idempotency key, so a redelivered interaction
-- applied twice (surfaced by the domain proofs in #302):
--   * /lottery buy debited the wallet (a separate economy_subtract_balance) and
--     then inserted tickets — a replay charged again and bought more tickets.
--   * /prestige reset the wallet and bumped prestige_level + the earning
--     multiplier in separate writes — a replay reset again and DOUBLE-bumped the
--     level and multiplier from one command.
--
-- Each is now one serializable call keyed on the interaction id. The debit is
-- folded into the RPC (no separate debit/refund dance), and idempotency anchors
-- on a request-id column on the row the purchase already writes — economy_
-- lottery_tickets and economy_prestige are both erased by purge_member_data, so
-- no new PII table is introduced.
-- =============================================================================

BEGIN;

ALTER TABLE public.economy_lottery_tickets ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_lottery_tickets_request
  ON public.economy_lottery_tickets (guild_id, user_id, request_id)
  WHERE request_id IS NOT NULL;

ALTER TABLE public.economy_prestige ADD COLUMN IF NOT EXISTS last_request_id TEXT;

-- ── /lottery buy ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lottery_buy_tickets_atomic(
  p_drawing_id UUID,
  p_guild_id   TEXT,
  p_user_id    TEXT,
  p_count      INT,
  p_max        INT,
  p_cost       BIGINT,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status   TEXT;
  v_existing INT;
  v_replayed INT;
  v_balance  BIGINT;
  v_jackpot  BIGINT;
BEGIN
  IF p_count <= 0 THEN RAISE EXCEPTION 'lottery_buy_tickets_atomic: count must be positive, got %', p_count; END IF;
  IF p_max <= 0 THEN RAISE EXCEPTION 'lottery_buy_tickets_atomic: max must be positive, got %', p_max; END IF;
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'lottery_buy_tickets_atomic: p_request_id is required';
  END IF;

  -- Serialize this member's wallet mutations (shared namespace with economy_pay
  -- / economy_buy_item) AND lock the drawing row (serializes concurrent buys +
  -- the draw claim).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-role-income:' || p_guild_id || ':' || p_user_id, 0));

  SELECT status, jackpot INTO v_status, v_jackpot
    FROM public.economy_lottery_drawings WHERE id = p_drawing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lottery_buy_tickets_atomic: drawing % not found', p_drawing_id;
  END IF;

  -- Idempotent replay: this interaction already bought its tickets.
  SELECT COUNT(*)::INT INTO v_replayed
    FROM public.economy_lottery_tickets
   WHERE drawing_id = p_drawing_id AND guild_id = p_guild_id
     AND user_id = p_user_id AND request_id = p_request_id;
  IF v_replayed > 0 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'purchased', 'replayed', true,
      'tickets', v_replayed, 'jackpot', v_jackpot);
  END IF;

  IF v_status <> 'active' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'drawing_closed', 'replayed', false);
  END IF;

  SELECT COUNT(*)::INT INTO v_existing
    FROM public.economy_lottery_tickets
   WHERE drawing_id = p_drawing_id AND guild_id = p_guild_id AND user_id = p_user_id;
  IF v_existing + p_count > p_max THEN
    RETURN pg_catalog.jsonb_build_object('status', 'max_tickets', 'replayed', false,
      'existing', v_existing, 'max', p_max);
  END IF;

  -- Funds check + debit, under the member lock (no separate refund needed —
  -- everything rolls back together on any failure).
  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_user_id);
  SELECT wallet INTO v_balance
    FROM public.economy_wallets
   WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  IF v_balance < p_cost THEN
    RETURN pg_catalog.jsonb_build_object('status', 'insufficient_funds', 'replayed', false,
      'cost', p_cost, 'wallet_balance', v_balance);
  END IF;

  UPDATE public.economy_wallets
     SET wallet = wallet - p_cost, total_spent = total_spent + p_cost, updated_at = now()
   WHERE guild_id = p_guild_id AND user_id = p_user_id;

  INSERT INTO public.economy_lottery_tickets (drawing_id, guild_id, user_id, ticket_number, request_id)
    SELECT p_drawing_id, p_guild_id, p_user_id,
           (pg_catalog.get_byte(extensions.gen_random_bytes(2), 0) * 256
             + pg_catalog.get_byte(extensions.gen_random_bytes(2), 1)) % 10000,
           p_request_id
      FROM pg_catalog.generate_series(1, p_count);

  UPDATE public.economy_lottery_drawings
     SET jackpot = jackpot + p_cost
   WHERE id = p_drawing_id
  RETURNING jackpot INTO v_jackpot;

  RETURN pg_catalog.jsonb_build_object('status', 'purchased', 'replayed', false,
    'tickets', p_count, 'jackpot', v_jackpot);
END;
$$;

REVOKE ALL ON FUNCTION public.lottery_buy_tickets_atomic(UUID, TEXT, TEXT, INT, INT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_buy_tickets_atomic(UUID, TEXT, TEXT, INT, INT, BIGINT, TEXT)
  TO service_role;

-- ── /prestige ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.economy_prestige_apply(
  p_guild_id        TEXT,
  p_user_id         TEXT,
  p_min_level       INT,
  p_min_net_worth   BIGINT,
  p_multiplier_gain INT,
  p_request_id      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prestige  public.economy_prestige%ROWTYPE;
  v_wallet    BIGINT;
  v_bank      BIGINT;
  v_net_worth BIGINT;
  v_level     INT;
  v_new_level INT;
  v_new_mult  INT;
BEGIN
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_prestige_apply: p_request_id is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-role-income:' || p_guild_id || ':' || p_user_id, 0));

  SELECT * INTO v_prestige
    FROM public.economy_prestige
   WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;

  -- Idempotent replay: this interaction already prestiged this member.
  IF FOUND AND v_prestige.last_request_id = p_request_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'prestiged', 'replayed', true,
      'new_level', v_prestige.prestige_level, 'new_multiplier', v_prestige.multiplier_pct);
  END IF;

  SELECT wallet, bank INTO v_wallet, v_bank
    FROM public.economy_wallets
   WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  v_net_worth := COALESCE(v_wallet, 0) + COALESCE(v_bank, 0);

  SELECT level INTO v_level
    FROM public.member_levels
   WHERE guild_id = p_guild_id AND member_id = p_user_id;
  v_level := COALESCE(v_level, 0);

  IF v_level < p_min_level THEN
    RETURN pg_catalog.jsonb_build_object('status', 'level_too_low', 'replayed', false, 'level', v_level);
  END IF;
  IF v_net_worth < p_min_net_worth THEN
    RETURN pg_catalog.jsonb_build_object('status', 'net_worth_too_low', 'replayed', false, 'net_worth', v_net_worth);
  END IF;

  v_new_level := COALESCE(v_prestige.prestige_level, 0) + 1;
  v_new_mult  := COALESCE(v_prestige.multiplier_pct, 0) + p_multiplier_gain;

  -- Reset wallet + bank (get_or_create so a member who never had a wallet row
  -- still lands one at zero, matching the prior upsert-nothing behavior).
  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_user_id);
  UPDATE public.economy_wallets
     SET wallet = 0, bank = 0, updated_at = now()
   WHERE guild_id = p_guild_id AND user_id = p_user_id;

  INSERT INTO public.economy_prestige
    (guild_id, user_id, prestige_level, total_resets, multiplier_pct, last_prestige, last_request_id)
  VALUES (p_guild_id, p_user_id, v_new_level, 1, v_new_mult, now(), p_request_id)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    prestige_level  = v_new_level,
    total_resets    = public.economy_prestige.total_resets + 1,
    multiplier_pct  = v_new_mult,
    last_prestige   = now(),
    last_request_id = p_request_id;

  RETURN pg_catalog.jsonb_build_object('status', 'prestiged', 'replayed', false,
    'new_level', v_new_level, 'new_multiplier', v_new_mult);
END;
$$;

REVOKE ALL ON FUNCTION public.economy_prestige_apply(TEXT, TEXT, INT, BIGINT, INT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_prestige_apply(TEXT, TEXT, INT, BIGINT, INT, TEXT)
  TO service_role;

COMMIT;
