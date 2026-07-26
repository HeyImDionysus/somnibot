-- =============================================================================
-- Economy RPC fixes: zero-price purchase rejection + durability reset on
-- stack break.
--
-- 1. economy_buy_item (from 20260720010000_economy_buy_item_atomic.sql):
--    crafting seeds its recipe outputs as ACTIVE price-0 economy_items rows
--    (other systems reference them by id, so they must stay active), and the
--    RPC accepted price 0 — members could /buy craft-only outputs for free.
--    The bot now filters price <= 0 out of the shop listing; this adds the
--    server-side rejection (belt + braces). Body is copied verbatim from the
--    original with ONLY the not_purchasable check added after the item load.
--
-- 2. economy_decrement_durability (from 20260522600000_v42_audit_fixes.sql):
--    when a tool broke inside a stack of >1, the old body decremented
--    quantity but left durability_remaining at <=1, so every subsequent tool
--    in the stack broke after a single use. The stack-break branch now resets
--    durability_remaining to the item's base durability (economy_items
--    .durability) — the next tool starts fresh. Body otherwise verbatim.
-- =============================================================================

BEGIN;

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

  -- Zero/negative price = not a purchasable product. Crafting seeds its
  -- recipe outputs as active price-0 rows (kept active because inventory,
  -- crafting and gathering reference them); the shop must never sell them.
  IF v_item.price <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_purchasable', 'replayed', false);
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

CREATE OR REPLACE FUNCTION public.economy_decrement_durability(p_inventory_id TEXT)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_durability INT;
  v_quantity INT;
BEGIN
  SELECT durability_remaining, quantity INTO v_durability, v_quantity
  FROM public.economy_inventory
  WHERE id = p_inventory_id::uuid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- If no durability tracking, nothing to decrement
  IF v_durability IS NULL THEN
    RETURN true;
  END IF;

  IF v_durability <= 1 THEN
    -- Tool broke — reduce quantity or delete
    IF v_quantity <= 1 THEN
      DELETE FROM public.economy_inventory WHERE id = p_inventory_id::uuid;
      RETURN false; -- item gone
    ELSE
      -- Stack break: consume the broken tool and start the next one FRESH.
      -- Previously durability_remaining stayed at <=1 here, so every
      -- remaining tool in the stack broke after a single use regardless of
      -- how it was acquired (buy/craft/reward).
      UPDATE public.economy_inventory AS inv
      SET quantity = inv.quantity - 1,
          durability_remaining = it.durability,
          updated_at = now()
      FROM public.economy_items AS it
      WHERE inv.id = p_inventory_id::uuid
        AND it.id = inv.item_id;
      RETURN true;
    END IF;
  ELSE
    UPDATE public.economy_inventory
    SET durability_remaining = durability_remaining - 1, updated_at = now()
    WHERE id = p_inventory_id::uuid;
    RETURN true;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_decrement_durability(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_decrement_durability(TEXT)
  TO service_role;

COMMIT;
