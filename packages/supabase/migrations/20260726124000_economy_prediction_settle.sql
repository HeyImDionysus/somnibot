-- =============================================================================
-- Atomic, idempotent prediction settlement (the #58 prediction-ledger gap)
-- + the closed-state bet fence (money-layer review, 2026-07-26).
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
-- the two partial UNIQUE indexes below. The existing member-purge contract
-- already erases economy_transactions, so no new PII surface.
--
-- prediction_place_bet is the closed-state fence at the money layer: the
-- prediction_bets INSERT and the total_pool increment land in ONE
-- transaction, conditional on the prediction still being 'open' under the
-- same row lock predictions_resolve_atomic takes — so a bet row can never
-- slip in after resolve reads the bets, and the pool snapshot resolve pays
-- from always includes every bet row it saw.
-- =============================================================================
BEGIN;

-- Replay fences. Two DELIBERATELY separate keyspaces:
--   1. The bet DEBIT — at most one prediction_bet ledger row per
--      (guild, member, request id). Independent of the credit fence below
--      because one bet row id is reused across its lifecycle: first for the
--      debit, later for the settlement credit that closes it out.
--   2. The settlement CREDIT — prediction_payout and prediction_refund share
--      ONE key WITHOUT type, so a bet is either paid out OR refunded, never
--      both: the losing side of a refund-vs-payout race hits
--      unique_violation, which economy_prediction_settle converts into a
--      clean 'conflicting_settlement' status instead of a raw 23505.
CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_tx_prediction_bet_request
  ON public.economy_transactions (guild_id, user_id, (metadata ->> 'request_id'))
  WHERE type = 'prediction_bet' AND metadata ? 'request_id';

CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_tx_prediction_credit_request
  ON public.economy_transactions (guild_id, user_id, (metadata ->> 'request_id'))
  WHERE type IN ('prediction_payout', 'prediction_refund')
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

  -- Only the three prediction settlement types are legal: the debit is
  -- covered by uq_economy_tx_prediction_bet_request, the two credits by
  -- uq_economy_tx_prediction_credit_request. Any new type MUST extend the
  -- fences in the same migration that adds it here.
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

  IF p_type = 'prediction_bet' THEN
    -- Idempotent replay: this debit already landed.
    SELECT t.type, t.amount, t.balance_after
      INTO v_existing
      FROM public.economy_transactions AS t
     WHERE t.guild_id = p_guild_id
       AND t.user_id = p_user_id
       AND t.type = 'prediction_bet'
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
  ELSE
    -- Credits share one keyspace: a row of EITHER credit type closes this
    -- request id. Same type → idempotent replay; the OTHER type → the bet was
    -- already settled the opposite way (refunded vs paid) — report a clean
    -- 'conflicting_settlement' so the caller can skip instead of eating 23505.
    SELECT t.type, t.amount, t.balance_after
      INTO v_existing
      FROM public.economy_transactions AS t
     WHERE t.guild_id = p_guild_id
       AND t.user_id = p_user_id
       AND t.type IN ('prediction_payout', 'prediction_refund')
       AND t.metadata ->> 'request_id' = p_request_id
     LIMIT 1;
    IF FOUND THEN
      IF v_existing.type = p_type THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'settled',
          'replayed', true,
          'amount', v_existing.amount,
          'wallet_balance', v_existing.balance_after
        );
      END IF;
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflicting_settlement',
        'replayed', false,
        'existing_type', v_existing.type,
        'amount', v_existing.amount,
        'wallet_balance', v_existing.balance_after
      );
    END IF;
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

  -- Apply the signed wallet delta + write the ledger row as ONE protected
  -- unit: the EXCEPTION handler's subtransaction rollback undoes the wallet
  -- delta too, so a fence conflict can never leave a credit without its row.
  BEGIN
    -- Credits accrue to total_earned (mirrors economy_add_balance, which the
    -- payout/refund paths used before); debits only reduce the wallet
    -- (mirrors economy_subtract_balance, which never counted wagers as
    -- total_spent).
    UPDATE public.economy_wallets
       SET wallet = wallet + p_amount,
           total_earned = total_earned + CASE WHEN p_amount > 0 THEN p_amount ELSE 0 END,
           updated_at = v_now
     WHERE guild_id = p_guild_id AND user_id = p_user_id
    RETURNING wallet INTO v_balance;

    -- Ledger row (folds the missing prediction audit-ledger row). The partial
    -- unique indexes above are the hard replay/exclusion fences backing the
    -- member advisory lock.
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
  EXCEPTION WHEN unique_violation THEN
    -- Backstop for the pre-checks above (the member advisory lock makes this
    -- reachable only if a conflicting settlement landed outside it): the
    -- subtransaction rolled the wallet delta back, so nothing moved.
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflicting_settlement',
      'replayed', false,
      'amount', p_amount,
      'wallet_balance', v_balance - p_amount
    );
  END;

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

-- =============================================================================
-- prediction_place_bet — the closed-state fence.
--
-- PollsManager settles the debit FIRST (economy_prediction_settle above,
-- request_id = the client-generated bet id), then calls this to land the bet
-- row. Locking the predictions row FOR UPDATE — the same lock
-- predictions_resolve_atomic takes — makes the open-check, the bet INSERT,
-- and the total_pool increment one atomic unit relative to resolve: either
-- this bet commits while the prediction is still open (and resolve's later
-- pool snapshot + bets read both include it), or the fence reports 'closed'
-- and the caller refunds the debit through the keyed refund.
--
-- Idempotent on p_bet_id: a retried call whose first attempt committed
-- returns replayed=true and moves nothing, so a transport error is safely
-- probed by re-calling with identical arguments.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.prediction_place_bet(
  p_bet_id        UUID,
  p_prediction_id UUID,
  p_option_id     UUID,
  p_guild_id      TEXT,
  p_user_id       TEXT,
  p_amount        INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status      TEXT;
  v_pool        INTEGER;
  v_existing_id UUID;
BEGIN
  IF p_bet_id IS NULL THEN
    RAISE EXCEPTION 'prediction_place_bet: p_bet_id is required';
  END IF;
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'prediction_place_bet: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'prediction_place_bet: p_user_id is required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'prediction_place_bet: p_amount must be positive, got %', p_amount;
  END IF;

  -- Idempotent replay: OUR insert already landed (retry after a transport
  -- error). The pool increment committed in the same transaction as that
  -- insert, so nothing more to do — report the current pool.
  SELECT b.id INTO v_existing_id
    FROM public.prediction_bets AS b
   WHERE b.id = p_bet_id;
  IF FOUND THEN
    SELECT p.total_pool INTO v_pool
      FROM public.predictions AS p
     WHERE p.id = p_prediction_id;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'inserted',
      'replayed', true,
      'new_pool', v_pool
    );
  END IF;

  -- The fence: FOR UPDATE serializes against predictions_resolve_atomic's
  -- own FOR UPDATE, so the status this call sees is the status this bet
  -- commits under.
  SELECT p.status INTO v_status
    FROM public.predictions AS p
   WHERE p.id = p_prediction_id AND p.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'replayed', false);
  END IF;
  IF v_status <> 'open' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'closed', 'replayed', false);
  END IF;

  BEGIN
    INSERT INTO public.prediction_bets
      (id, prediction_id, option_id, guild_id, user_id, amount)
    VALUES
      (p_bet_id, p_prediction_id, p_option_id, p_guild_id, p_user_id, p_amount);
  EXCEPTION WHEN unique_violation THEN
    -- UNIQUE(prediction_id, user_id) or the id PK fired. Distinguish a race
    -- with OUR OWN retry (same bet id — treat as the replay above) from a
    -- genuine second bet by this member.
    SELECT b.id INTO v_existing_id
      FROM public.prediction_bets AS b
     WHERE b.prediction_id = p_prediction_id AND b.user_id = p_user_id;
    IF v_existing_id = p_bet_id THEN
      SELECT p.total_pool INTO v_pool
        FROM public.predictions AS p
       WHERE p.id = p_prediction_id;
      RETURN pg_catalog.jsonb_build_object(
        'status', 'inserted',
        'replayed', true,
        'new_pool', v_pool
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'duplicate', 'replayed', false);
  END;

  UPDATE public.predictions
     SET total_pool = total_pool + p_amount
   WHERE id = p_prediction_id
  RETURNING total_pool INTO v_pool;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'inserted',
    'replayed', false,
    'new_pool', v_pool
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prediction_place_bet(UUID, UUID, UUID, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prediction_place_bet(UUID, UUID, UUID, TEXT, TEXT, INTEGER)
  TO service_role;

-- =============================================================================
-- prediction_unplace_bet — keyed compensation for an UNCONFIRMED
-- prediction_place_bet (adversarial re-verification, 2026-07-26).
--
-- When prediction_place_bet's response is lost, PollsManager cannot tell
-- whether the bet row + total_pool increment committed. The old compensation
-- (raw DELETE of the bet row + keyed refund) had a mint window: a committed
-- place left total_pool inflated by the deleted stake, so winners later split
-- coins whose owner had already been refunded — the guild minted the stake.
--
-- This function resolves the ambiguity ATOMICALLY under the SAME predictions
-- row lock prediction_place_bet and predictions_resolve_atomic take, so the
-- status it sees is the status its compensation commits under:
--
--   'removed'   — status is still 'open' and the bet row existed: the row is
--                 deleted AND total_pool is decremented by its RETURNING'd
--                 amount in ONE transaction. The pool can never keep a stake
--                 whose row is gone, so the caller's keyed refund is clean.
--   'not_found' — no bet row with this id (the insert never committed, or a
--                 retried compensation already removed it). Nothing touched —
--                 idempotent, so re-calling after a transport error is safe.
--                 Also returned when the predictions row itself is gone:
--                 prediction_bets cascades on prediction delete, so there is
--                 no row and no pool left to correct.
--   'closed'    — status left 'open' (locked/resolved/cancelled) AND the bet
--                 row still exists. The row could only have been inserted
--                 while 'open' (prediction_place_bet's fence), and whoever
--                 flipped the status serialized AFTER that commit on this
--                 row's FOR UPDATE — so a resolve's total_pool snapshot
--                 INCLUDES this stake and its settlement loop will settle the
--                 bet row like any other (payout if it won, face-value refund
--                 if nobody won, stake-funds-the-winners if it lost). The
--                 pool is NOT decremented and the row is NOT deleted, and the
--                 caller MUST NOT refund: a compensation refund next to the
--                 resolver's winner split of a pool still containing this
--                 stake would mint exactly the stake. 'locked' is treated the
--                 same way deliberately — betting is frozen for everyone, the
--                 row is a legitimate frozen bet, and the eventual resolve
--                 settles it; mutating the pool outside 'open' is never this
--                 function's business.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.prediction_unplace_bet(
  p_guild_id      TEXT,
  p_prediction_id UUID,
  p_bet_id        UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status TEXT;
  v_amount INTEGER;
  v_pool   INTEGER;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'prediction_unplace_bet: p_guild_id is required';
  END IF;
  IF p_prediction_id IS NULL THEN
    RAISE EXCEPTION 'prediction_unplace_bet: p_prediction_id is required';
  END IF;
  IF p_bet_id IS NULL THEN
    RAISE EXCEPTION 'prediction_unplace_bet: p_bet_id is required';
  END IF;

  -- The fence: same FOR UPDATE as prediction_place_bet and
  -- predictions_resolve_atomic. A concurrent resolve either finishes first
  -- (we report 'closed' and touch nothing) or waits until the row + pool
  -- decrement are committed (it never sees the removed stake).
  SELECT p.status INTO v_status
    FROM public.predictions AS p
   WHERE p.id = p_prediction_id AND p.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND THEN
    -- Prediction gone entirely; prediction_bets cascaded with it. No pool
    -- exists to correct — the caller falls back to the keyed refund, whose
    -- credit fence still refuses a double-settle.
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_status <> 'open' THEN
    IF EXISTS (
      SELECT 1
        FROM public.prediction_bets AS b
       WHERE b.id = p_bet_id
         AND b.prediction_id = p_prediction_id
         AND b.guild_id = p_guild_id
    ) THEN
      -- The stake is IN the pot and the row will be settled by the resolver.
      -- Hands off: no delete, no pool decrement, and the caller must not
      -- refund.
      RETURN pg_catalog.jsonb_build_object('status', 'closed');
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Still open: remove the row and its pool contribution as ONE unit.
  DELETE FROM public.prediction_bets AS b
   WHERE b.id = p_bet_id
     AND b.prediction_id = p_prediction_id
     AND b.guild_id = p_guild_id
  RETURNING b.amount INTO v_amount;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Exact inverse of prediction_place_bet's increment, under the same lock —
  -- the pool always equals the sum of live bet rows, so no clamping: a
  -- negative result would be a real corruption and should surface loudly in
  -- reconciliation, not be papered over with GREATEST(0, ...).
  UPDATE public.predictions
     SET total_pool = total_pool - v_amount
   WHERE id = p_prediction_id
  RETURNING total_pool INTO v_pool;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'removed',
    'amount', v_amount,
    'new_pool', v_pool
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prediction_unplace_bet(TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prediction_unplace_bet(TEXT, UUID, UUID)
  TO service_role;

COMMIT;
