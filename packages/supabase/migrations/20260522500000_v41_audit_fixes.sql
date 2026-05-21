-- V41 Audit Fixes
-- 1. economy_upsert_inventory RPC — atomic add-to-inventory (INSERT or increment)
-- 2. economy_decrement_inventory RPC — atomic subtract-from-inventory (returns false if insufficient)
-- 3. economy_decrement_stock RPC — atomic shop item stock reduction
-- 4. economy_wallet_stats RPC — aggregate wallet/bank totals without limit(10000)
-- 5. economy_increment_prediction_pool RPC — atomic prediction pool increment

-- ── economy_upsert_inventory ────────────────────────────────────────
-- Atomically adds quantity to an inventory row, inserting if not exists.

CREATE OR REPLACE FUNCTION economy_upsert_inventory(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_item_id UUID,
  p_quantity INT,
  p_durability INT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO economy_inventory (guild_id, user_id, item_id, quantity, durability_remaining, updated_at)
  VALUES (p_guild_id, p_user_id, p_item_id, p_quantity, p_durability, now())
  ON CONFLICT (guild_id, user_id, item_id)
  DO UPDATE SET
    quantity = economy_inventory.quantity + p_quantity,
    updated_at = now();
END;
$$;

-- ── economy_decrement_inventory ─────────────────────────────────────
-- Atomically decrements inventory quantity. Returns true if successful,
-- false if insufficient quantity. Deletes row if quantity reaches 0.

CREATE OR REPLACE FUNCTION economy_decrement_inventory(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_item_id UUID,
  p_quantity INT
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_current INT;
BEGIN
  SELECT quantity INTO v_current
  FROM economy_inventory
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id
  FOR UPDATE;

  IF v_current IS NULL OR v_current < p_quantity THEN
    RETURN false;
  END IF;

  IF v_current - p_quantity <= 0 THEN
    DELETE FROM economy_inventory
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id;
  ELSE
    UPDATE economy_inventory
    SET quantity = quantity - p_quantity, updated_at = now()
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id;
  END IF;

  RETURN true;
END;
$$;

-- ── economy_decrement_stock ─────────────────────────────────────────
-- Atomically decrements shop item stock. Returns false if insufficient.

CREATE OR REPLACE FUNCTION economy_decrement_stock(
  p_item_id UUID,
  p_quantity INT
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_stock INT;
BEGIN
  SELECT stock INTO v_stock
  FROM economy_items
  WHERE id = p_item_id
  FOR UPDATE;

  -- NULL stock means unlimited
  IF v_stock IS NULL THEN
    RETURN true;
  END IF;

  IF v_stock < p_quantity THEN
    RETURN false;
  END IF;

  UPDATE economy_items
  SET stock = stock - p_quantity
  WHERE id = p_item_id;

  RETURN true;
END;
$$;

-- ── economy_wallet_stats ────────────────────────────────────────────
-- Returns aggregate wallet stats for a guild without loading all rows.

CREATE OR REPLACE FUNCTION economy_wallet_stats(p_guild_id TEXT)
RETURNS TABLE(total_wallets BIGINT, total_circulation BIGINT, total_banked BIGINT)
LANGUAGE sql
STABLE
AS $$
  SELECT
    count(*)::bigint AS total_wallets,
    coalesce(sum(wallet), 0)::bigint AS total_circulation,
    coalesce(sum(bank), 0)::bigint AS total_banked
  FROM economy_wallets
  WHERE guild_id = p_guild_id;
$$;

-- ── economy_increment_prediction_pool ───────────────────────────────
-- Atomically increments a prediction's total_pool.

CREATE OR REPLACE FUNCTION economy_increment_prediction_pool(
  p_prediction_id UUID,
  p_amount INT
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_pool INT;
BEGIN
  UPDATE predictions
  SET total_pool = total_pool + p_amount
  WHERE id = p_prediction_id
  RETURNING total_pool INTO v_new_pool;

  RETURN v_new_pool;
END;
$$;
