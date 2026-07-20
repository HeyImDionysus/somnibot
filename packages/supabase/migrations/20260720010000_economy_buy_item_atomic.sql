-- =============================================================================
-- Atomic, idempotent shop purchase (/buy).
--
-- EconomyManager.buyItem moved money in separate, unsynchronized steps — debit
-- the wallet, decrement stock, upsert inventory, write the ledger row — with no
-- shared transaction and no replay key. A redelivered /buy interaction ran the
-- whole sequence again: the member was charged twice and received the item
-- twice (a money-path double-spend, the same class as the pre-#301 /pay bug).
--
-- This collapses the funds check, debit, atomic stock decrement, inventory
-- grant, and ledger row into one serializable call keyed on the interaction id.
-- A redelivered interaction returns the first result and charges nothing more.
-- Idempotency is anchored on the buyer's shop_buy ledger row (interaction id in
-- metadata) + a partial UNIQUE index, so the existing member-purge contract
-- already erases it (economy_transactions is purged) and no new PII table is
-- introduced. Role-requirement checks stay in the bot (they need the live
-- Discord member); everything that moves money/stock/inventory is atomic here.
-- =============================================================================

BEGIN;

-- At most one shop_buy ledger row may carry a given interaction id per member.
-- Restricted to rows that actually carry a request id, so pre-existing shop_buy
-- rows (metadata without a request_id) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_tx_shop_buy_request
  ON public.economy_transactions (guild_id, user_id, (metadata ->> 'request_id'))
  WHERE type = 'shop_buy' AND metadata ? 'request_id';

CREATE OR REPLACE FUNCTION public.economy_buy_item(
  p_guild_id   TEXT,
  p_user_id    TEXT,
  p_item_id    UUID,
  p_quantity   INT,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now        TIMESTAMPTZ := now();
  v_existing   RECORD;
  v_item       public.economy_items%ROWTYPE;
  v_total_cost BIGINT;
  v_owned      INT;
  v_balance    BIGINT;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_buy_item: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'economy_buy_item: p_user_id is required';
  END IF;
  IF p_item_id IS NULL THEN
    RAISE EXCEPTION 'economy_buy_item: p_item_id is required';
  END IF;
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_buy_item: p_request_id is required';
  END IF;
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'economy_buy_item: p_quantity must be positive, got %', p_quantity;
  END IF;

  -- Serialize the whole purchase for this member (same namespace as
  -- economy_get_or_create_wallet / economy_pay so wallet mutations are mutually
  -- exclusive).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-role-income:' || p_guild_id || ':' || p_user_id, 0)
  );

  -- Idempotent replay: a redelivered interaction already recorded its purchase.
  SELECT t.amount, t.metadata
    INTO v_existing
    FROM public.economy_transactions AS t
   WHERE t.guild_id = p_guild_id
     AND t.user_id = p_user_id
     AND t.type = 'shop_buy'
     AND t.metadata ->> 'request_id' = p_request_id
   LIMIT 1;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'purchased',
      'replayed', true,
      'item_id', v_existing.metadata ->> 'item_id',
      'item_name', v_existing.metadata ->> 'item_name',
      'quantity', (v_existing.metadata ->> 'quantity')::INT,
      'total_cost', -v_existing.amount
    );
  END IF;

  -- Load + lock the item (active, this guild). FOR UPDATE serializes stock.
  SELECT i.*
    INTO v_item
    FROM public.economy_items AS i
   WHERE i.id = p_item_id
     AND i.guild_id = p_guild_id
     AND i.active = true
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'item_not_found', 'replayed', false);
  END IF;

  -- Max-per-user (checked under the lock so a race cannot exceed the cap).
  IF v_item.max_per_user IS NOT NULL THEN
    SELECT COALESCE(inv.quantity, 0)
      INTO v_owned
      FROM public.economy_inventory AS inv
     WHERE inv.guild_id = p_guild_id
       AND inv.user_id = p_user_id
       AND inv.item_id = p_item_id;
    v_owned := COALESCE(v_owned, 0);
    IF v_owned + p_quantity > v_item.max_per_user THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'max_per_user', 'replayed', false,
        'max_per_user', v_item.max_per_user, 'owned', v_owned);
    END IF;
  END IF;

  -- Stock (NULL stock = unlimited).
  IF v_item.stock IS NOT NULL AND v_item.stock < p_quantity THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'out_of_stock', 'replayed', false, 'stock', v_item.stock);
  END IF;

  v_total_cost := v_item.price::BIGINT * p_quantity;

  -- Funds (under the member lock; get_or_create's own lock is a re-entrant no-op).
  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_user_id);
  SELECT w.wallet
    INTO v_balance
    FROM public.economy_wallets AS w
   WHERE w.guild_id = p_guild_id AND w.user_id = p_user_id
   FOR UPDATE;
  IF v_balance < v_total_cost THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'insufficient_funds', 'replayed', false,
      'total_cost', v_total_cost, 'wallet_balance', v_balance);
  END IF;

  -- Commit the purchase: debit, decrement stock, grant inventory, ledger row.
  UPDATE public.economy_wallets
     SET wallet = wallet - v_total_cost,
         total_spent = total_spent + v_total_cost,
         updated_at = v_now
   WHERE guild_id = p_guild_id AND user_id = p_user_id
  RETURNING wallet INTO v_balance;

  IF v_item.stock IS NOT NULL THEN
    UPDATE public.economy_items
       SET stock = stock - p_quantity
     WHERE id = p_item_id;
  END IF;

  INSERT INTO public.economy_inventory (guild_id, user_id, item_id, quantity, durability_remaining, updated_at)
  VALUES (p_guild_id, p_user_id, p_item_id, p_quantity, v_item.durability, v_now)
  ON CONFLICT (guild_id, user_id, item_id)
  DO UPDATE SET quantity = public.economy_inventory.quantity + p_quantity, updated_at = v_now;

  INSERT INTO public.economy_transactions
    (guild_id, user_id, type, amount, balance_after, description, metadata)
  VALUES (
    p_guild_id, p_user_id, 'shop_buy', -v_total_cost, v_balance,
    'Bought ' || p_quantity || 'x ' || v_item.name,
    pg_catalog.jsonb_build_object(
      'request_id', p_request_id, 'item_id', p_item_id::TEXT,
      'item_name', v_item.name, 'quantity', p_quantity));

  RETURN pg_catalog.jsonb_build_object(
    'status', 'purchased', 'replayed', false,
    'item_id', p_item_id::TEXT, 'item_name', v_item.name,
    'quantity', p_quantity, 'total_cost', v_total_cost, 'wallet_balance', v_balance);
END;
$$;

REVOKE ALL ON FUNCTION public.economy_buy_item(TEXT, TEXT, UUID, INT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_buy_item(TEXT, TEXT, UUID, INT, TEXT)
  TO service_role;

COMMIT;
