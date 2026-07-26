-- =============================================================================
-- Atomic, idempotent prediction settlement (the #58 prediction-ledger gap).
--
-- PollsManager moved prediction money with the raw wallet RPCs
-- (economy_subtract_balance on bet, economy_add_balance on payout/refund),
-- which touch ONLY economy_wallets — no economy_transactions row was ever
-- written for a prediction bet, payout, or refund, so /mydata exports and the
-- analytics ledger under-report every prediction participant.
--
-- economy_prediction_settle is modeled on economy_resolve_bet
-- (20260724110100): ONE serializable, member-locked call that applies the
-- signed wallet delta AND writes the ledger row atomically, keyed on the
-- prediction_bets row id. A redelivered interaction (or a re-run
-- payout/refund loop after a crash) returns the first settlement and moves no
-- money a second time — a durable replay fence anchored on the ledger row +
-- a partial UNIQUE index. The existing member-purge contract already erases
-- economy_transactions, so no new PII surface.
-- =============================================================================
BEGIN;

-- At most one prediction ledger row may carry a given request id per member
-- and settlement type. `type` is part of the key because one bet row id is
-- deliberately reused across its lifecycle (prediction_bet debit, then
-- prediction_payout OR prediction_refund credit for the same bet).
CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_tx_prediction_request
  ON public.economy_transactions (guild_id, user_id, type, (metadata ->> 'request_id'))
  WHERE type IN ('prediction_bet', 'prediction_payout', 'prediction_refund')
    AND metadata ? 'request_id';

CREATE OR REPLACE FUNCTION public.economy_prediction_settle(
  p_guild_id    TEXT,
  p_user_id     TEXT,
  p_amount      BIGINT,
  p_type        TEXT,
  p_request_id  TEXT,
  p_description TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now      TIMESTAMPTZ := now();
  v_existing RECORD;
  v_balance  BIGINT;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_prediction_settle: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'economy_prediction_settle: p_user_id is required';
  END IF;
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_prediction_settle: p_request_id is required';
  END IF;
  IF p_amount IS NULL THEN
    RAISE EXCEPTION 'economy_prediction_settle: p_amount is required';
  END IF;

  -- Only the three prediction settlement types are legal: each is covered by
  -- the uq_economy_tx_prediction_request replay fence above. Any new type MUST
  -- extend that partial index in the same migration that adds it here.
  IF p_type NOT IN ('prediction_bet', 'prediction_payout', 'prediction_refund') THEN
    RAISE EXCEPTION 'economy_prediction_settle: unknown p_type %', p_type;
  END IF;

  -- Sign discipline: a bet debits, a payout/refund credits. A wrong-signed
  -- call is a caller bug — fail loudly instead of silently minting/burning.
  IF p_type = 'prediction_bet' AND p_amount >= 0 THEN
    RAISE EXCEPTION 'economy_prediction_settle: prediction_bet requires a negative amount, got %', p_amount;
  END IF;
  IF p_type IN ('prediction_payout', 'prediction_refund') AND p_amount < 0 THEN
    RAISE EXCEPTION 'economy_prediction_settle: % requires a non-negative amount, got %', p_type, p_amount;
  END IF;

  -- Serialize the whole settlement for this member (same advisory-lock namespace
  -- as wallet init / pay / buy / economy_resolve_bet, so the wallet delta +
  -- ledger write are mutually exclusive with every other money mutation for
  -- this member).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-role-income:' || p_guild_id || ':' || p_user_id, 0)
  );

  -- Idempotent replay: this settlement already landed.
  SELECT t.amount, t.balance_after
    INTO v_existing
    FROM public.economy_transactions AS t
   WHERE t.guild_id = p_guild_id
     AND t.user_id = p_user_id
     AND t.type = p_type
     AND t.metadata ->> 'request_id' = p_request_id
   LIMIT 1;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'settled',
      'replayed', true,
      'amount', v_existing.amount,
      'wallet_balance', v_existing.balance_after
    );
  END IF;

  -- Ensure a wallet exists and lock it (the re-entrant advisory lock is a no-op).
  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_user_id);
  SELECT w.wallet
    INTO v_balance
    FROM public.economy_wallets AS w
   WHERE w.guild_id = p_guild_id AND w.user_id = p_user_id
   FOR UPDATE;

  -- A bet may never overdraw the wallet.
  IF p_amount < 0 AND v_balance < -p_amount THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'insufficient_funds',
      'replayed', false,
      'amount', p_amount,
      'wallet_balance', v_balance
    );
  END IF;

  -- Apply the signed wallet delta. Credits accrue to total_earned (mirrors
  -- economy_add_balance, which the payout/refund paths used before); debits
  -- only reduce the wallet (mirrors economy_subtract_balance, which never
  -- counted wagers as total_spent).
  UPDATE public.economy_wallets
     SET wallet = wallet + p_amount,
         total_earned = total_earned + CASE WHEN p_amount > 0 THEN p_amount ELSE 0 END,
         updated_at = v_now
   WHERE guild_id = p_guild_id AND user_id = p_user_id
  RETURNING wallet INTO v_balance;

  -- Ledger row (folds the missing prediction audit-ledger row). The partial
  -- unique index uq_economy_tx_prediction_request is the hard replay fence
  -- backing the member advisory lock above.
  INSERT INTO public.economy_transactions
    (guild_id, user_id, type, amount, balance_after, description, metadata)
  VALUES (
    p_guild_id, p_user_id, p_type, p_amount, v_balance,
    COALESCE(p_description,
      CASE p_type
        WHEN 'prediction_bet'    THEN 'Prediction bet'
        WHEN 'prediction_payout' THEN 'Prediction payout'
        ELSE                          'Prediction refund'
      END),
    pg_catalog.jsonb_build_object('request_id', p_request_id)
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'settled',
    'replayed', false,
    'amount', p_amount,
    'wallet_balance', v_balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.economy_prediction_settle(TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_prediction_settle(TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT)
  TO service_role;

COMMIT;
