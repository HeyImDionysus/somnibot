-- =============================================================================
-- [game-economy-shop-market] Make the per-unit listing ceiling owner-configurable.
--
-- The bot previously rejected prices above a process-local 1,000,000,000 cap.
-- Persist the ceiling in guild_config so dashboard saves are validated,
-- hot-reloaded by the bot, and enforced again inside the atomic listing RPC.
-- =============================================================================

BEGIN;

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS economy_market_max_price_per_unit integer NOT NULL DEFAULT 1000000000;

UPDATE public.guild_config
   SET economy_market_max_price_per_unit = 1000000000
 WHERE economy_market_max_price_per_unit < 1
    OR economy_market_max_price_per_unit > 2147483647;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guild_config_market_max_price_per_unit_check'
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_market_max_price_per_unit_check
      CHECK (economy_market_max_price_per_unit BETWEEN 1 AND 2147483647);
  END IF;
END $$;

-- Defense-in-depth for callers that bypass the bot/dashboard. The guild's
-- persisted ceiling is read while the listing transaction is open, before the
-- seller inventory row is locked or changed.
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
  v_max_price INT;
  v_listing public.economy_market_listings%ROWTYPE;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'economy_market_atomic_create_listing: quantity must be positive (got %)', p_quantity;
  END IF;
  IF p_price_per_unit <= 0 THEN
    RAISE EXCEPTION 'economy_market_atomic_create_listing: price must be positive (got %)', p_price_per_unit;
  END IF;

  SELECT economy_market_max_price_per_unit
    INTO v_max_price
    FROM public.guild_config
   WHERE guild_id = p_guild_id;
  v_max_price := COALESCE(v_max_price, 1000000000);
  IF p_price_per_unit > v_max_price THEN
    RAISE EXCEPTION 'economy_market_atomic_create_listing: price exceeds guild maximum (got %, max %)', p_price_per_unit, v_max_price;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.economy_items
    WHERE id = p_item_id AND guild_id = p_guild_id AND tradeable = false
  ) THEN
    RETURN jsonb_build_object('error', 'not_tradeable');
  END IF;

  SELECT quantity INTO v_current
  FROM public.economy_inventory
  WHERE guild_id = p_guild_id AND user_id = p_seller_id AND item_id = p_item_id
  FOR UPDATE;

  IF v_current IS NULL OR v_current < p_quantity THEN
    RETURN jsonb_build_object('error', 'insufficient_inventory');
  END IF;

  IF v_current - p_quantity <= 0 THEN
    DELETE FROM public.economy_inventory
    WHERE guild_id = p_guild_id AND user_id = p_seller_id AND item_id = p_item_id;
  ELSE
    UPDATE public.economy_inventory
       SET quantity = quantity - p_quantity, updated_at = now()
     WHERE guild_id = p_guild_id AND user_id = p_seller_id AND item_id = p_item_id;
  END IF;

  INSERT INTO public.economy_market_listings
    (guild_id, seller_id, item_id, item_name, quantity, remaining, price_per_unit, status, expires_at)
  VALUES
    (p_guild_id, p_seller_id, p_item_id, p_item_name, p_quantity, p_quantity, p_price_per_unit, 'active', p_expires_at)
  RETURNING * INTO v_listing;

  RETURN jsonb_build_object('listing', to_jsonb(v_listing));
END;
$function$;

COMMIT;
