-- =============================================================================
-- Atomic, idempotent player-market purchase.
--
-- MarketManager.buy performed the buy as FOUR separate, non-idempotent RPCs
-- (economy_market_buy listing decrement, economy_subtract_balance buyer debit,
-- economy_add_balance seller credit, economy_upsert_inventory delivery) with a
-- hand-rolled compensation dance and NO idempotency key. A redelivered /market
-- buy interaction therefore decremented the listing again, debited the buyer
-- again, credited the seller again and delivered again → duplicate market sale /
-- double-spend. (The shop /buy fix in #303 was never extended to the market.)
--
-- Fold the whole purchase into one serializable call keyed on the interaction id,
-- mirroring economy_buy_item (#303): advisory-lock the buyer, replay-check a
-- market_buy ledger row carrying the request id, then in ONE transaction decrement
-- the listing (FOR UPDATE), debit the buyer, credit the seller net of fee, deliver
-- the inventory, and write the buyer + seller ledger rows.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.economy_market_settle_buy(
  p_guild_id   text,
  p_listing_id uuid,
  p_buyer_id   text,
  p_quantity   integer,
  p_fee_pct    integer,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now        TIMESTAMPTZ := now();
  v_existing   RECORD;
  v_listing    public.economy_market_listings%ROWTYPE;
  v_buy_qty    INT;
  v_total      BIGINT;
  v_fee        BIGINT;
  v_earn       BIGINT;
  v_balance    BIGINT;
  v_seller_bal BIGINT;
  v_new_status TEXT;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN RAISE EXCEPTION 'economy_market_settle_buy: p_guild_id is required'; END IF;
  IF p_buyer_id IS NULL OR pg_catalog.btrim(p_buyer_id) = '' THEN RAISE EXCEPTION 'economy_market_settle_buy: p_buyer_id is required'; END IF;
  IF p_listing_id IS NULL THEN RAISE EXCEPTION 'economy_market_settle_buy: p_listing_id is required'; END IF;
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN RAISE EXCEPTION 'economy_market_settle_buy: p_request_id is required'; END IF;
  IF p_quantity <= 0 THEN RAISE EXCEPTION 'economy_market_settle_buy: p_quantity must be positive, got %', p_quantity; END IF;
  IF p_fee_pct < 0 OR p_fee_pct > 100 THEN RAISE EXCEPTION 'economy_market_settle_buy: p_fee_pct out of range, got %', p_fee_pct; END IF;

  -- Serialize this buyer's wallet mutations (same namespace as economy_pay /
  -- economy_buy_item).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-role-income:' || p_guild_id || ':' || p_buyer_id, 0));

  -- Idempotent replay: this interaction already settled its buy (anchor = the
  -- buyer's market_buy ledger row carrying the request id).
  SELECT t.amount, t.metadata
    INTO v_existing
    FROM public.economy_transactions AS t
   WHERE t.guild_id = p_guild_id
     AND t.user_id = p_buyer_id
     AND t.type = 'market_buy'
     AND t.metadata ->> 'request_id' = p_request_id
   LIMIT 1;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'purchased', 'replayed', true,
      'item_id', v_existing.metadata ->> 'item_id',
      'item_name', v_existing.metadata ->> 'item_name',
      'quantity', (v_existing.metadata ->> 'quantity')::INT,
      'total_cost', -v_existing.amount,
      'fee', (v_existing.metadata ->> 'fee')::BIGINT);
  END IF;

  -- Lock the listing (active, this guild, in stock).
  SELECT * INTO v_listing
    FROM public.economy_market_listings
   WHERE id = p_listing_id AND guild_id = p_guild_id AND status = 'active' AND remaining > 0
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'listing_unavailable', 'replayed', false);
  END IF;

  IF v_listing.seller_id = p_buyer_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'own_listing', 'replayed', false);
  END IF;

  v_buy_qty := LEAST(p_quantity, v_listing.remaining);
  v_total   := v_listing.price_per_unit::BIGINT * v_buy_qty;
  v_fee     := pg_catalog.floor(v_total * p_fee_pct / 100.0)::BIGINT;
  v_earn    := v_total - v_fee;

  -- Buyer funds (under the member lock).
  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_buyer_id);
  SELECT wallet INTO v_balance
    FROM public.economy_wallets
   WHERE guild_id = p_guild_id AND user_id = p_buyer_id
   FOR UPDATE;
  IF v_balance < v_total THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'insufficient_funds', 'replayed', false,
      'total_cost', v_total, 'wallet_balance', v_balance);
  END IF;

  -- Debit buyer.
  UPDATE public.economy_wallets
     SET wallet = wallet - v_total, total_spent = total_spent + v_total, updated_at = v_now
   WHERE guild_id = p_guild_id AND user_id = p_buyer_id
  RETURNING wallet INTO v_balance;

  -- Credit seller (net of fee).
  PERFORM public.economy_get_or_create_wallet(p_guild_id, v_listing.seller_id);
  UPDATE public.economy_wallets
     SET wallet = wallet + v_earn, total_earned = total_earned + v_earn, updated_at = v_now
   WHERE guild_id = p_guild_id AND user_id = v_listing.seller_id
  RETURNING wallet INTO v_seller_bal;

  -- Decrement listing (mark sold when it empties).
  v_new_status := CASE WHEN v_listing.remaining - v_buy_qty <= 0 THEN 'sold' ELSE 'active' END;
  UPDATE public.economy_market_listings
     SET remaining = remaining - v_buy_qty, status = v_new_status, updated_at = v_now
   WHERE id = p_listing_id;

  -- Deliver to buyer inventory.
  INSERT INTO public.economy_inventory (guild_id, user_id, item_id, quantity, updated_at)
  VALUES (p_guild_id, p_buyer_id, v_listing.item_id, v_buy_qty, v_now)
  ON CONFLICT (guild_id, user_id, item_id)
  DO UPDATE SET quantity = public.economy_inventory.quantity + v_buy_qty, updated_at = v_now;

  -- Ledger: buyer market_buy (the replay anchor) + seller market_sale.
  INSERT INTO public.economy_transactions (guild_id, user_id, type, amount, balance_after, description, metadata)
  VALUES (
    p_guild_id, p_buyer_id, 'market_buy', -v_total, v_balance,
    'Bought ' || v_buy_qty || 'x ' || v_listing.item_name || ' on the market',
    pg_catalog.jsonb_build_object(
      'request_id', p_request_id, 'listing_id', p_listing_id::TEXT,
      'item_id', v_listing.item_id::TEXT, 'item_name', v_listing.item_name,
      'quantity', v_buy_qty, 'fee', v_fee, 'seller_id', v_listing.seller_id));

  INSERT INTO public.economy_transactions (guild_id, user_id, type, amount, balance_after, description, metadata)
  VALUES (
    p_guild_id, v_listing.seller_id, 'market_sale', v_earn, v_seller_bal,
    'Sold ' || v_buy_qty || 'x ' || v_listing.item_name || ' on the market',
    pg_catalog.jsonb_build_object(
      'request_id', p_request_id, 'listing_id', p_listing_id::TEXT,
      'item_id', v_listing.item_id::TEXT, 'item_name', v_listing.item_name,
      'quantity', v_buy_qty, 'fee', v_fee, 'buyer_id', p_buyer_id));

  RETURN pg_catalog.jsonb_build_object(
    'status', 'purchased', 'replayed', false,
    'item_id', v_listing.item_id::TEXT, 'item_name', v_listing.item_name,
    'quantity', v_buy_qty, 'requested_qty', p_quantity,
    'total_cost', v_total, 'fee', v_fee, 'seller_earnings', v_earn,
    'wallet_balance', v_balance, 'listing_status', v_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.economy_market_settle_buy(text, uuid, text, integer, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_market_settle_buy(text, uuid, text, integer, integer, text)
  TO service_role;

COMMIT;
