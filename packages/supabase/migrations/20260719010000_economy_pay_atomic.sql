-- =============================================================================
-- Atomic, idempotent player-to-player transfer (/pay).
--
-- The previous bot implementation moved currency in three independent steps:
-- debit the sender, credit the receiver, then write two ledger rows. Each step
-- was a separate round-trip with no shared transaction and no replay key, so:
--   * a crash between debit and credit destroyed the sender's coins (the
--     credit-failure refund only covered a returned error, not a lost process);
--   * a redelivered interaction (Discord can dispatch the same interaction more
--     than once) debited the sender twice — a double-spend.
--
-- This migration collapses balance check, debit, credit, and both ledger rows
-- into one serializable database call keyed on the interaction id. A redelivered
-- interaction returns the first result and moves no currency a second time.
--
-- Idempotency is anchored on the sender's `pay_send` ledger row (carrying the
-- interaction id in metadata) rather than a new table, so the existing
-- member-purge contract already erases it — economy_transactions is deleted in
-- purge_member_data. A partial unique index makes a duplicate `pay_send`
-- physically impossible even outside the advisory-locked path (defense in depth;
-- historical rows have no request id and are excluded).
-- =============================================================================

BEGIN;

-- At most one pay_send ledger row may carry a given interaction id per member.
-- Restricted to rows that actually carry a request id so pre-existing pay_send
-- rows (metadata NULL) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_tx_pay_send_request
  ON public.economy_transactions (guild_id, user_id, (metadata ->> 'request_id'))
  WHERE type = 'pay_send' AND metadata ? 'request_id';

CREATE OR REPLACE FUNCTION public.economy_pay(
  p_guild_id    TEXT,
  p_sender_id   TEXT,
  p_receiver_id TEXT,
  p_amount      BIGINT,
  p_tax_pct     NUMERIC,
  p_request_id  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now              TIMESTAMPTZ := now();
  v_first            TEXT;
  v_second           TEXT;
  v_existing         RECORD;
  v_tax              BIGINT;
  v_received         BIGINT;
  v_sender_balance   BIGINT;
  v_receiver_balance BIGINT;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_pay: p_guild_id is required';
  END IF;
  IF p_sender_id IS NULL OR pg_catalog.btrim(p_sender_id) = '' THEN
    RAISE EXCEPTION 'economy_pay: p_sender_id is required';
  END IF;
  IF p_receiver_id IS NULL OR pg_catalog.btrim(p_receiver_id) = '' THEN
    RAISE EXCEPTION 'economy_pay: p_receiver_id is required';
  END IF;
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_pay: p_request_id is required';
  END IF;
  IF p_sender_id = p_receiver_id THEN
    RAISE EXCEPTION 'economy_pay: sender and receiver must differ';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'economy_pay: p_amount must be positive, got %', p_amount;
  END IF;
  IF p_tax_pct IS NULL OR p_tax_pct < 0 OR p_tax_pct > 100 THEN
    RAISE EXCEPTION 'economy_pay: p_tax_pct must be within [0,100], got %', p_tax_pct;
  END IF;

  -- Serialize the whole transfer for both members. Locks are taken in sorted
  -- order so a concurrent reverse-direction transfer (receiver paying sender)
  -- cannot deadlock, and the namespace matches economy_get_or_create_wallet /
  -- economy_collect_role_income so every wallet mutation for a member is
  -- mutually exclusive.
  IF p_sender_id < p_receiver_id THEN
    v_first := p_sender_id; v_second := p_receiver_id;
  ELSE
    v_first := p_receiver_id; v_second := p_sender_id;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-role-income:' || p_guild_id || ':' || v_first, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-role-income:' || p_guild_id || ':' || v_second, 0)
  );

  -- Idempotent replay: a redelivered interaction already recorded its debit as
  -- a pay_send ledger row. Return the original outcome and move no currency.
  SELECT t.amount, t.balance_after, t.metadata
    INTO v_existing
    FROM public.economy_transactions AS t
   WHERE t.guild_id = p_guild_id
     AND t.user_id = p_sender_id
     AND t.type = 'pay_send'
     AND t.metadata ->> 'request_id' = p_request_id
   LIMIT 1;

  IF FOUND THEN
    v_tax := COALESCE((v_existing.metadata ->> 'tax')::BIGINT, 0);
    RETURN pg_catalog.jsonb_build_object(
      'status', 'sent',
      'replayed', true,
      'amount', -v_existing.amount,
      'tax', v_tax,
      'received', (-v_existing.amount) - v_tax,
      'sender_balance', v_existing.balance_after
    );
  END IF;

  -- The economy sinks the tax (matches the historical debit=amount,
  -- credit=amount-tax behavior): the sender loses the full amount, the receiver
  -- gains the post-tax remainder, and the difference leaves circulation.
  v_tax := CASE WHEN p_tax_pct > 0 THEN pg_catalog.floor(p_amount * p_tax_pct / 100.0)::BIGINT ELSE 0 END;
  v_received := p_amount - v_tax;

  -- Both member locks are already held, so the initializer's own advisory lock
  -- acquisition is a no-op within this transaction.
  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_sender_id);
  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_receiver_id);

  SELECT w.wallet
    INTO v_sender_balance
    FROM public.economy_wallets AS w
   WHERE w.guild_id = p_guild_id AND w.user_id = p_sender_id
   FOR UPDATE;

  IF v_sender_balance < p_amount THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'insufficient_funds',
      'replayed', false,
      'amount', p_amount,
      'tax', v_tax,
      'received', v_received,
      'sender_balance', v_sender_balance
    );
  END IF;

  -- Debit sender (mirror economy_subtract_balance: touches wallet only).
  UPDATE public.economy_wallets
     SET wallet = wallet - p_amount, updated_at = v_now
   WHERE guild_id = p_guild_id AND user_id = p_sender_id
  RETURNING wallet INTO v_sender_balance;

  -- Credit receiver (mirror economy_add_balance: wallet + total_earned).
  UPDATE public.economy_wallets
     SET wallet = wallet + v_received,
         total_earned = total_earned + v_received,
         updated_at = v_now
   WHERE guild_id = p_guild_id AND user_id = p_receiver_id
  RETURNING wallet INTO v_receiver_balance;

  -- Ledger rows. The sender's pay_send carries the interaction id and is the
  -- idempotency anchor (unique index above); writing it in the same transaction
  -- as the debit is what makes the debit exactly-once.
  INSERT INTO public.economy_transactions
    (guild_id, user_id, type, amount, balance_after, description, metadata)
  VALUES
    (p_guild_id, p_sender_id, 'pay_send', -p_amount, v_sender_balance,
     'Paid <@' || p_receiver_id || '>',
     pg_catalog.jsonb_build_object('request_id', p_request_id, 'counterparty', p_receiver_id, 'tax', v_tax)),
    (p_guild_id, p_receiver_id, 'pay_receive', v_received, v_receiver_balance,
     'Received from <@' || p_sender_id || '>',
     pg_catalog.jsonb_build_object('request_id', p_request_id, 'counterparty', p_sender_id));

  RETURN pg_catalog.jsonb_build_object(
    'status', 'sent',
    'replayed', false,
    'amount', p_amount,
    'tax', v_tax,
    'received', v_received,
    'sender_balance', v_sender_balance,
    'receiver_balance', v_receiver_balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.economy_pay(TEXT, TEXT, TEXT, BIGINT, NUMERIC, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_pay(TEXT, TEXT, TEXT, BIGINT, NUMERIC, TEXT)
  TO service_role;

COMMIT;
