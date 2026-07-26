-- =============================================================================
-- Idempotent economy_add_balance (X2/39 — trivia payout dead letter, M4 family).
--
-- economy_add_balance had no idempotency key: a retry issued after a partial
-- success (the credit committed but the caller never saw the response — crash,
-- network drop, PostgREST timeout) credited the wallet a SECOND time. The
-- trivia payout retry lane (bot_action_queue action 'trivia_payout_retry')
-- needs exactly-once semantics: the primary payout and the retry both call
-- this RPC with the SAME key (trivia:<roundId>:<userId>), so whichever lands
-- second is a no-op.
--
-- economy_resolve_bet (20260724110100) fenced casino settlements with
-- metadata->>'request_id' scoped to type='casino_bet'; there is no shared
-- idempotency_key column on economy_transactions yet, so this migration adds
-- the general-purpose column + guild-scoped partial unique index that later
-- keyed-credit consumers (fishing/pets/crafting/adventures — M4) reuse.
--
-- The function body is the 20260711020000 version verbatim, plus only:
--   * an optional p_idempotency_key parameter (DEFAULT NULL — every existing
--     3-argument caller is unchanged),
--   * the member advisory lock (same 'economy-role-income' namespace as
--     economy_get_or_create_wallet / economy_resolve_bet) so the key check
--     and the credit are atomic per member,
--   * the keyed replay fence: a prior ledger row with this key returns the
--     prior result (the credit already happened) and moves no money,
--   * the keyed ledger row recording the credit (unkeyed calls write no
--     ledger row — exactly as before).
--
-- The 3-argument signature is dropped: keeping it alongside a 4-argument
-- overload with a defaulted parameter would make every 3-argument call
-- ambiguous ("function is not unique") under PostgreSQL overload resolution.
-- =============================================================================
BEGIN;

ALTER TABLE public.economy_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- At most one ledger row may carry a given idempotency key per guild. Partial:
-- the untold existing keyless rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_tx_guild_idempotency_key
  ON public.economy_transactions (guild_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP FUNCTION IF EXISTS public.economy_add_balance(TEXT, TEXT, BIGINT);

CREATE OR REPLACE FUNCTION public.economy_add_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount BIGINT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_balance BIGINT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive, got %', p_amount;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    -- Serialize with every other money mutation for this member (same
    -- advisory-lock namespace as wallet init / pay / buy / resolve_bet) so the
    -- replay check below and the credit are atomic — two concurrent calls with
    -- the same key cannot both pass the check. The unique index
    -- uq_economy_tx_guild_idempotency_key is the durable cross-key belt.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('economy-role-income:' || p_guild_id || ':' || p_user_id, 0)
    );

    -- Keyed replay: this credit already landed — return the prior result
    -- (RETURNS void, so "prior result" is simply success with no second move).
    PERFORM 1
      FROM public.economy_transactions AS t
     WHERE t.guild_id = p_guild_id
       AND t.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_user_id);

  UPDATE public.economy_wallets
     SET wallet = wallet + p_amount,
         total_earned = total_earned + p_amount,
         updated_at = now()
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id
  RETURNING wallet INTO v_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'economy_add_balance: wallet initialization returned no row';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    -- Durable replay fence for this key. Under the member advisory lock a
    -- same-member replay never reaches this insert twice; the unique index
    -- backstops writers outside the lock namespace.
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, idempotency_key)
    VALUES
      (p_guild_id, p_user_id, 'credit', p_amount, v_balance,
       'Idempotent credit (economy_add_balance)', p_idempotency_key);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_add_balance(TEXT, TEXT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_add_balance(TEXT, TEXT, BIGINT, TEXT)
  TO service_role;

COMMIT;
