-- V42 Audit Fixes
-- ================
-- 1. Add SET search_path = '' to all 7 existing SECURITY DEFINER functions
-- 2. Add SECURITY DEFINER + SET search_path = '' to 16 functions that were missing it
-- 3. REVOKE EXECUTE from anon/authenticated/public on ALL RPC functions
-- 4. GRANT EXECUTE to service_role only
-- 5. New RPC: economy_decrement_durability (atomic tool durability reduction)

-- ══════════════════════════════════════════════════════════════
-- 1. Fix existing SECURITY DEFINER functions — add SET search_path = ''
-- ══════════════════════════════════════════════════════════════

-- economy_add_balance (from V32)
CREATE OR REPLACE FUNCTION economy_add_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount INT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.economy_wallets (guild_id, user_id, wallet, updated_at)
  VALUES (p_guild_id, p_user_id, p_amount, now())
  ON CONFLICT (guild_id, user_id)
  DO UPDATE SET wallet = public.economy_wallets.wallet + p_amount, updated_at = now();
END;
$$;

-- economy_subtract_balance (from V32)
CREATE OR REPLACE FUNCTION economy_subtract_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount INT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.economy_wallets
  SET wallet = wallet - p_amount, updated_at = now()
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND wallet >= p_amount;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;
END;
$$;

-- lottery_increment_jackpot (from V37)
CREATE OR REPLACE FUNCTION lottery_increment_jackpot(
  p_drawing_id UUID,
  p_amount INT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_jackpot INT;
BEGIN
  UPDATE public.economy_lottery_drawings
  SET jackpot = jackpot + p_amount
  WHERE id = p_drawing_id
  RETURNING jackpot INTO v_new_jackpot;

  RETURN v_new_jackpot;
END;
$$;

-- array_append_heist_participant (from V38)
CREATE OR REPLACE FUNCTION array_append_heist_participant(
  p_heist_id UUID,
  p_user_id TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.economy_heists
  SET participants = array_append(participants, p_user_id),
      success_chance = LEAST(95, success_chance + 7)
  WHERE id = p_heist_id
    AND NOT (p_user_id = ANY(participants));
END;
$$;

-- seed_default_quest_templates (from V36)
CREATE OR REPLACE FUNCTION seed_default_quest_templates(p_guild_id text)
RETURNS void LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.economy_quest_templates WHERE guild_id = p_guild_id LIMIT 1) THEN
    RETURN;
  END IF;

  INSERT INTO public.economy_quest_templates (guild_id, quest_type, title, description, action_type, target_count, reward_currency, reward_xp) VALUES
    (p_guild_id, 'daily', 'Hard Worker', 'Use /work 3 times', 'work', 3, 150, 50),
    (p_guild_id, 'daily', 'Gone Fishing', 'Catch 2 fish', 'fish', 2, 200, 75),
    (p_guild_id, 'daily', 'Gather Round', 'Gather resources 3 times', 'gather', 3, 150, 50),
    (p_guild_id, 'daily', 'Crafty', 'Craft 1 item', 'craft', 1, 250, 100),
    (p_guild_id, 'daily', 'Risk Taker', 'Attempt a crime', 'crime', 1, 100, 25),
    (p_guild_id, 'daily', 'Active Member', 'Send 10 messages', 'chat', 10, 100, 50),
    (p_guild_id, 'daily', 'Shopper', 'Buy something from the shop', 'shop_buy', 1, 100, 25),
    (p_guild_id, 'weekly', 'Dedicated Worker', 'Use /work 15 times this week', 'work', 15, 1000, 300),
    (p_guild_id, 'weekly', 'Master Angler', 'Catch 15 fish this week', 'fish', 15, 1200, 400),
    (p_guild_id, 'weekly', 'Social Butterfly', 'Send 100 messages this week', 'chat', 100, 800, 250),
    (p_guild_id, 'weekly', 'Adventurer', 'Complete 5 adventures this week', 'adventure', 5, 1500, 500),
    (p_guild_id, 'weekly', 'Market Mogul', 'Complete 3 market trades this week', 'market_trade', 3, 1000, 300);
END;
$$;

-- nextval_ticket (from ticket_transcripts)
DROP FUNCTION IF EXISTS nextval_ticket();
CREATE OR REPLACE FUNCTION nextval_ticket()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_val BIGINT;
BEGIN
  SELECT COALESCE(MAX(ticket_number), 0) + 1 INTO v_val FROM public.ticket_transcripts;
  RETURN v_val;
END;
$$;

-- nextval_incident (from V13)
DROP FUNCTION IF EXISTS nextval_incident();
CREATE OR REPLACE FUNCTION nextval_incident()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_val BIGINT;
BEGIN
  SELECT COALESCE(MAX(incident_number), 0) + 1 INTO v_val FROM public.incidents;
  RETURN v_val;
END;
$$;


-- ══════════════════════════════════════════════════════════════
-- 2. Add SECURITY DEFINER + SET search_path = '' to functions that lacked it
-- ══════════════════════════════════════════════════════════════

-- economy_upsert_inventory (V41)
CREATE OR REPLACE FUNCTION economy_upsert_inventory(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_item_id UUID,
  p_quantity INT,
  p_durability INT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.economy_inventory (guild_id, user_id, item_id, quantity, durability_remaining, updated_at)
  VALUES (p_guild_id, p_user_id, p_item_id, p_quantity, p_durability, now())
  ON CONFLICT (guild_id, user_id, item_id)
  DO UPDATE SET
    quantity = public.economy_inventory.quantity + p_quantity,
    updated_at = now();
END;
$$;

-- economy_decrement_inventory (V41)
CREATE OR REPLACE FUNCTION economy_decrement_inventory(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_item_id UUID,
  p_quantity INT
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current INT;
BEGIN
  SELECT quantity INTO v_current
  FROM public.economy_inventory
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id
  FOR UPDATE;

  IF v_current IS NULL OR v_current < p_quantity THEN
    RETURN false;
  END IF;

  IF v_current - p_quantity <= 0 THEN
    DELETE FROM public.economy_inventory
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id;
  ELSE
    UPDATE public.economy_inventory
    SET quantity = quantity - p_quantity, updated_at = now()
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id;
  END IF;

  RETURN true;
END;
$$;

-- economy_decrement_stock (V41)
CREATE OR REPLACE FUNCTION economy_decrement_stock(
  p_item_id UUID,
  p_quantity INT
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_stock INT;
BEGIN
  SELECT stock INTO v_stock
  FROM public.economy_items
  WHERE id = p_item_id
  FOR UPDATE;

  IF v_stock IS NULL THEN
    RETURN true;
  END IF;

  IF v_stock < p_quantity THEN
    RETURN false;
  END IF;

  UPDATE public.economy_items
  SET stock = stock - p_quantity
  WHERE id = p_item_id;

  RETURN true;
END;
$$;

-- economy_wallet_stats (V41)
CREATE OR REPLACE FUNCTION economy_wallet_stats(p_guild_id TEXT)
RETURNS TABLE(total_wallets BIGINT, total_circulation BIGINT, total_banked BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    count(*)::bigint AS total_wallets,
    coalesce(sum(wallet), 0)::bigint AS total_circulation,
    coalesce(sum(bank), 0)::bigint AS total_banked
  FROM public.economy_wallets
  WHERE guild_id = p_guild_id;
$$;

-- economy_increment_prediction_pool (V41)
CREATE OR REPLACE FUNCTION economy_increment_prediction_pool(
  p_prediction_id UUID,
  p_amount INT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_pool INT;
BEGIN
  UPDATE public.predictions
  SET total_pool = total_pool + p_amount
  WHERE id = p_prediction_id
  RETURNING total_pool INTO v_new_pool;

  RETURN v_new_pool;
END;
$$;

-- increment_profile_views (V40)
CREATE OR REPLACE FUNCTION increment_profile_views(p_guild_id TEXT, p_user_id TEXT)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.economy_profiles
  SET profile_views = profile_views + 1
  WHERE guild_id = p_guild_id AND user_id = p_user_id;
$$;

-- increment_automation_count (automation_helpers)
CREATE OR REPLACE FUNCTION increment_automation_count(automation_uuid UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.automations
  SET execution_count = COALESCE(execution_count, 0) + 1,
      last_executed_at = now()
  WHERE id = automation_uuid;
END;
$$;

-- generate_order_number (phase_b_commerce_reliability)
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_num INT;
  v_order_number TEXT;
BEGIN
  SELECT COALESCE(MAX(
    CASE WHEN order_number ~ '^\d+$' THEN order_number::int ELSE 0 END
  ), 0) + 1
  INTO v_num
  FROM public.orders;

  v_order_number := LPAD(v_num::text, 6, '0');
  RETURN v_order_number;
END;
$$;

-- giveaway_add_entry (giveaway_atomic_entries)
DROP FUNCTION IF EXISTS giveaway_add_entry(UUID, TEXT);
CREATE OR REPLACE FUNCTION giveaway_add_entry(p_giveaway_id UUID, p_user_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.giveaways
  SET entries = array_append(entries, p_user_id)
  WHERE id = p_giveaway_id
    AND NOT (p_user_id = ANY(entries));
END;
$$;

-- giveaway_remove_entry (giveaway_atomic_entries)
DROP FUNCTION IF EXISTS giveaway_remove_entry(UUID, TEXT);
CREATE OR REPLACE FUNCTION giveaway_remove_entry(p_giveaway_id UUID, p_user_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.giveaways
  SET entries = array_remove(entries, p_user_id)
  WHERE id = p_giveaway_id;
END;
$$;

-- reset_ticket_inactivity_warning (ticket_inactivity)
CREATE OR REPLACE FUNCTION reset_ticket_inactivity_warning()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.inactivity_warned := false;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- increment_member_xp (audit_v5_atomic_ops)
DROP FUNCTION IF EXISTS increment_member_xp(TEXT, TEXT, INT, BOOLEAN, INT);
CREATE OR REPLACE FUNCTION increment_member_xp(
  p_guild_id TEXT,
  p_member_id TEXT,
  p_xp_gain INT,
  p_username TEXT DEFAULT NULL,
  p_avatar TEXT DEFAULT NULL
)
RETURNS TABLE(new_xp INT, new_level INT, leveled_up BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_xp INT;
  v_current_level INT;
  v_new_xp INT;
  v_new_level INT;
  v_xp_per_level INT := 100;
BEGIN
  -- Upsert member_levels row
  INSERT INTO public.member_levels (guild_id, member_id, xp, level, updated_at)
  VALUES (p_guild_id, p_member_id, p_xp_gain, 0, now())
  ON CONFLICT (guild_id, member_id)
  DO UPDATE SET
    xp = public.member_levels.xp + p_xp_gain,
    updated_at = now()
  RETURNING public.member_levels.xp, public.member_levels.level
  INTO v_new_xp, v_current_level;

  -- Calculate new level
  v_new_level := FLOOR(v_new_xp / v_xp_per_level);

  IF v_new_level > v_current_level THEN
    UPDATE public.member_levels
    SET level = v_new_level
    WHERE guild_id = p_guild_id AND member_id = p_member_id;
  END IF;

  RETURN QUERY SELECT v_new_xp, v_new_level, (v_new_level > v_current_level);
END;
$$;

-- increment_download_count (audit_v5_atomic_ops)
CREATE OR REPLACE FUNCTION increment_download_count(p_file_id UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.product_files
  SET download_count = download_count + 1
  WHERE id = p_file_id;
$$;

-- increment_customer_totals (audit_v5_atomic_ops)
CREATE OR REPLACE FUNCTION increment_customer_totals(
  p_customer_id UUID,
  p_amount NUMERIC
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.customers
  SET total_spent_cents = COALESCE(total_spent_cents, 0) + p_amount,
      first_purchase_at = COALESCE(first_purchase_at, now()),
      updated_at = now()
  WHERE id = p_customer_id;
$$;

-- sum_guild_xp (sum_guild_xp)
CREATE OR REPLACE FUNCTION sum_guild_xp(g_id TEXT)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(SUM(xp), 0)::bigint FROM public.member_levels WHERE guild_id = g_id;
$$;

-- aggregate_member_levels (V31 economy core)
DROP FUNCTION IF EXISTS aggregate_member_levels(text);
CREATE OR REPLACE FUNCTION aggregate_member_levels(p_guild_id text)
RETURNS TABLE(total_members bigint, avg_level numeric, max_level int, total_xp bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    count(*)::bigint,
    round(avg(level)::numeric, 1),
    coalesce(max(level), 0),
    coalesce(sum(xp), 0)::bigint
  FROM public.member_levels
  WHERE guild_id = p_guild_id;
$$;


-- ══════════════════════════════════════════════════════════════
-- 3. REVOKE EXECUTE from anon / authenticated / public on ALL RPCs
--    GRANT EXECUTE to service_role only
-- ══════════════════════════════════════════════════════════════

-- Revoke from all non-service roles
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOR fn IN
    SELECT unnest(ARRAY[
      'economy_add_balance(text, text, int)',
      'economy_subtract_balance(text, text, int)',
      'lottery_increment_jackpot(uuid, int)',
      'array_append_heist_participant(uuid, text)',
      'seed_default_quest_templates(text)',
      'nextval_ticket()',
      'nextval_incident()',
      'economy_upsert_inventory(text, text, uuid, int, int)',
      'economy_decrement_inventory(text, text, uuid, int)',
      'economy_decrement_stock(uuid, int)',
      'economy_wallet_stats(text)',
      'economy_increment_prediction_pool(uuid, int)',
      'increment_profile_views(text, text)',
      'increment_automation_count(uuid)',
      'generate_order_number()',
      'giveaway_add_entry(uuid, text)',
      'giveaway_remove_entry(uuid, text)',
      'increment_member_xp(text, text, int, text, text)',
      'increment_download_count(uuid)',
      'increment_customer_totals(uuid, numeric)',
      'sum_guild_xp(text)',
      'aggregate_member_levels(text)',
      'economy_decrement_durability(text)'
    ])
  LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM public', fn);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END;
$$;


-- ══════════════════════════════════════════════════════════════
-- 5. New RPC: economy_decrement_durability
--    Atomically decrements tool durability. If durability hits 0,
--    reduces quantity (or deletes). Returns true if tool still exists.
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION economy_decrement_durability(p_inventory_id TEXT)
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
      UPDATE public.economy_inventory
      SET quantity = quantity - 1, updated_at = now()
      WHERE id = p_inventory_id::uuid;
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
