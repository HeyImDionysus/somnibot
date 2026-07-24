-- =============================================================================
-- [game-economy-shop-market] Enforce the anti-laundering tradeable wall in the
-- atomic listing RPC (defense-in-depth behind the bot-side check).
--
-- economy_items.tradeable (default true) is the intended gate keeping
-- non-tradeable, commerce-granted items out of the player market, but the
-- listing path never inspected it. MarketManager.listItem now rejects
-- tradeable=false before any decrement; this migration makes the RPC refuse as
-- well, so a non-tradeable item can never be laundered onto the market even if a
-- caller bypasses the bot-side check. Returns a typed 'not_tradeable' error
-- (mirroring the existing 'insufficient_inventory' shape) and mutates nothing.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.economy_market_atomic_create_listing(
  p_guild_id text,
  p_seller_id text,
  p_item_id uuid,
  p_quantity integer,
  p_price_per_unit integer,
  p_item_name text,
  p_expires_at timestamp with time zone
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $function$
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

  -- [game-economy-shop-market] Anti-laundering wall: refuse non-tradeable items
  -- (e.g. commerce-granted goods) before touching inventory. tradeable defaults
  -- to true, so only items explicitly flagged tradeable=false are rejected.
  IF EXISTS (
    SELECT 1 FROM public.economy_items
    WHERE id = p_item_id AND guild_id = p_guild_id AND tradeable = false
  ) THEN
    RETURN jsonb_build_object('error', 'not_tradeable');
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
$function$;

COMMIT;
