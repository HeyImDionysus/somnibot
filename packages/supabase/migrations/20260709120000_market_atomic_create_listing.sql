-- Market: atomic listing creation.
--
-- listItem previously decremented inventory via economy_decrement_inventory,
-- then INSERTed the listing row in a separate statement. If the insert failed,
-- the bot attempted a compensating economy_upsert_inventory refund — and if
-- THAT also failed, the seller's items were permanently destroyed.
--
-- economy_market_atomic_create_listing performs verify + decrement + insert in
-- ONE transaction with the inventory row locked (FOR UPDATE): either the
-- listing exists and the items are escrowed in it, or nothing changed at all.
-- Concurrent listings of the same stack serialize on the row lock, so a
-- double-listing can never oversell.
--
-- Returns jsonb:
--   { "listing": { ...created row... } }     on success
--   { "error": "insufficient_inventory" }    when the locked stack is too small
--                                            (or the seller has no stack at all)

CREATE OR REPLACE FUNCTION economy_market_atomic_create_listing(
  p_guild_id       TEXT,
  p_seller_id      TEXT,
  p_item_id        UUID,
  p_quantity       INT,
  p_price_per_unit INT,
  p_item_name      TEXT,
  p_expires_at     TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current INT;
  v_listing public.economy_market_listings%ROWTYPE;
BEGIN
  -- Defense-in-depth: Discord command validation also enforces these.
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'economy_market_atomic_create_listing: quantity must be positive (got %)', p_quantity;
  END IF;
  IF p_price_per_unit <= 0 THEN
    RAISE EXCEPTION 'economy_market_atomic_create_listing: price must be positive (got %)', p_price_per_unit;
  END IF;

  -- Lock the seller's stack so concurrent listings serialize.
  SELECT quantity INTO v_current
  FROM public.economy_inventory
  WHERE guild_id = p_guild_id AND user_id = p_seller_id AND item_id = p_item_id
  FOR UPDATE;

  IF v_current IS NULL OR v_current < p_quantity THEN
    RETURN jsonb_build_object('error', 'insufficient_inventory');
  END IF;

  -- Mirror economy_decrement_inventory semantics: drop the row at zero.
  IF v_current - p_quantity <= 0 THEN
    DELETE FROM public.economy_inventory
    WHERE guild_id = p_guild_id AND user_id = p_seller_id AND item_id = p_item_id;
  ELSE
    UPDATE public.economy_inventory
    SET quantity = quantity - p_quantity, updated_at = now()
    WHERE guild_id = p_guild_id AND user_id = p_seller_id AND item_id = p_item_id;
  END IF;

  -- Same transaction: if this insert fails, the decrement above rolls back
  -- with it and the seller keeps their items. No compensating refund needed.
  INSERT INTO public.economy_market_listings
    (guild_id, seller_id, item_id, item_name, quantity, remaining, price_per_unit, status, expires_at)
  VALUES
    (p_guild_id, p_seller_id, p_item_id, p_item_name, p_quantity, p_quantity, p_price_per_unit, 'active', p_expires_at)
  RETURNING * INTO v_listing;

  RETURN jsonb_build_object('listing', to_jsonb(v_listing));
END;
$$;

REVOKE ALL ON FUNCTION economy_market_atomic_create_listing(TEXT, TEXT, UUID, INT, INT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION economy_market_atomic_create_listing(TEXT, TEXT, UUID, INT, INT, TEXT, TIMESTAMPTZ) TO service_role;
