-- =============================================================================
-- Atomic, idempotent casino bet settlement.
--
-- GamesManager settled every bet in TWO unsynchronized RPCs: the wallet delta
-- (economy_add_balance / economy_subtract_balance) and the daily-loss increment
-- (economy_increment_daily_loss), with a separate best-effort call each. A crash
-- or transient error between them left the wallet debited but the daily-loss
-- counter un-incremented (loss-cap bypass) or vice-versa, and no economy_transactions
-- ledger row was ever written for a casino bet (the casino audit-ledger gap).
-- The interaction.id Valkey fence (games-manager.ts) blocks a re-delivered
-- INTERACTION_CREATE, but it is Valkey-only and evaporates on cache loss.
--
-- economy_resolve_bet folds the debit/credit + daily-loss increment + ledger
-- row into ONE serializable, member-locked call keyed on the interaction id.
-- A redelivered interaction returns the first settlement and moves no money a
-- second time — a durable, cache-independent replay fence anchored on the
-- casino_bet ledger row + a partial UNIQUE index (the existing member-purge
-- contract already erases economy_transactions, so no new PII surface).
-- =============================================================================
BEGIN;

-- At most one casino_bet ledger row may carry a given interaction id per member.
-- Restricted to rows that actually carry a request id so any pre-existing
-- casino_bet rows (none today) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_tx_casino_bet_request
  ON public.economy_transactions (guild_id, user_id, (metadata ->> 'request_id'))
  WHERE type = 'casino_bet' AND metadata ? 'request_id';

CREATE OR REPLACE FUNCTION public.economy_resolve_bet(
  p_guild_id        TEXT,
  p_user_id         TEXT,
  p_net             BIGINT,
  p_loss            BIGINT,
  p_game            TEXT,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now        TIMESTAMPTZ := now();
  v_existing   RECORD;
  v_balance    BIGINT;
  v_loss       BIGINT;
  v_loss_total BIGINT := 0;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_resolve_bet: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'economy_resolve_bet: p_user_id is required';
  END IF;
  IF p_idempotency_key IS NULL OR pg_catalog.btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'economy_resolve_bet: p_idempotency_key is required';
  END IF;

  -- Daily-loss amount to record. When the caller passes NULL, default to the
  -- magnitude of a net debit (a win records no loss). A caller may pass an
  -- explicit non-negative loss (e.g. a partial-loss game where the stake and
  -- the net differ), but it may never be negative.
  v_loss := COALESCE(p_loss, CASE WHEN p_net < 0 THEN -p_net ELSE 0 END);
  IF v_loss < 0 THEN
    RAISE EXCEPTION 'economy_resolve_bet: p_loss must be non-negative, got %', v_loss;
  END IF;

  -- Serialize the whole settlement for this member (same advisory-lock namespace
  -- as wallet init / pay / buy, so the debit/credit + loss + ledger write are
  -- mutually exclusive with every other money mutation for this member).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-role-income:' || p_guild_id || ':' || p_user_id, 0)
  );

  -- Idempotent replay: a redelivered interaction already settled this bet.
  SELECT t.amount, t.balance_after, t.metadata
    INTO v_existing
    FROM public.economy_transactions AS t
   WHERE t.guild_id = p_guild_id
     AND t.user_id = p_user_id
     AND t.type = 'casino_bet'
     AND t.metadata ->> 'request_id' = p_idempotency_key
   LIMIT 1;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'settled',
      'replayed', true,
      'net', v_existing.amount,
      'wallet_balance', v_existing.balance_after,
      'daily_loss', COALESCE((v_existing.metadata ->> 'daily_loss')::BIGINT, 0)
    );
  END IF;

  -- Ensure a wallet exists and lock it (the re-entrant advisory lock is a no-op).
  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_user_id);
  SELECT w.wallet
    INTO v_balance
    FROM public.economy_wallets AS w
   WHERE w.guild_id = p_guild_id AND w.user_id = p_user_id
   FOR UPDATE;

  -- A net debit may never overdraw the wallet.
  IF p_net < 0 AND v_balance < -p_net THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'insufficient_funds',
      'replayed', false,
      'net', p_net,
      'wallet_balance', v_balance
    );
  END IF;

  -- Apply the net wallet delta. Credits accrue to total_earned (mirrors
  -- economy_add_balance); debits only reduce the wallet (mirrors
  -- economy_subtract_balance, which never counted wagers as total_spent).
  UPDATE public.economy_wallets
     SET wallet = wallet + p_net,
         total_earned = total_earned + CASE WHEN p_net > 0 THEN p_net ELSE 0 END,
         updated_at = v_now
   WHERE guild_id = p_guild_id AND user_id = p_user_id
  RETURNING wallet INTO v_balance;

  -- Record the daily loss (UTC day) when this bet lost money — same shape as
  -- economy_increment_daily_loss so the loss cap sees a single source of truth.
  IF v_loss > 0 THEN
    INSERT INTO public.economy_daily_losses (guild_id, user_id, loss_date, amount, updated_at)
    VALUES (p_guild_id, p_user_id, (v_now AT TIME ZONE 'UTC')::date, v_loss, v_now)
    ON CONFLICT (guild_id, user_id, loss_date)
    DO UPDATE SET amount     = public.economy_daily_losses.amount + EXCLUDED.amount,
                  updated_at = v_now
    RETURNING amount INTO v_loss_total;
  ELSE
    SELECT COALESCE(dl.amount, 0)
      INTO v_loss_total
      FROM public.economy_daily_losses AS dl
     WHERE dl.guild_id = p_guild_id
       AND dl.user_id = p_user_id
       AND dl.loss_date = (v_now AT TIME ZONE 'UTC')::date;
    v_loss_total := COALESCE(v_loss_total, 0);
  END IF;

  -- Ledger row (folds the missing casino audit-ledger row). The partial unique
  -- index uq_economy_tx_casino_bet_request is the hard replay fence backing the
  -- member advisory lock above.
  INSERT INTO public.economy_transactions
    (guild_id, user_id, type, amount, balance_after, description, metadata)
  VALUES (
    p_guild_id, p_user_id, 'casino_bet', p_net, v_balance,
    (CASE WHEN p_net >= 0 THEN 'Casino win' ELSE 'Casino loss' END)
      || COALESCE(' (' || p_game || ')', ''),
    pg_catalog.jsonb_build_object(
      'request_id', p_idempotency_key,
      'game', p_game,
      'daily_loss', v_loss
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'settled',
    'replayed', false,
    'net', p_net,
    'wallet_balance', v_balance,
    'daily_loss', v_loss_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.economy_resolve_bet(TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_resolve_bet(TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT)
  TO service_role;

COMMIT;
