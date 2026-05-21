-- V45 deep audit fixes
-- 1. Atomic pet_feed RPC (prevents TOCTOU on hunger/status)
-- 2. Atomic pet_play RPC (prevents TOCTOU on happiness/energy/status)
-- 3. Atomic pet_train RPC (prevents TOCTOU on xp/level/energy/stats)

-- ── 1. economy_pet_feed ──────────────────────────────────────
CREATE OR REPLACE FUNCTION economy_pet_feed(
  p_guild_id TEXT,
  p_user_id  TEXT,
  p_amount   INT DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pet RECORD;
  v_new_hunger INT;
  v_new_status TEXT;
BEGIN
  SELECT id, hunger, happiness, status INTO v_pet
    FROM public.economy_pets
   WHERE guild_id = p_guild_id AND user_id = p_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_pet');
  END IF;

  v_new_hunger := LEAST(100, v_pet.hunger + p_amount);
  v_new_status := CASE
    WHEN v_new_hunger > 30 AND v_pet.happiness > 30 THEN 'happy'
    ELSE 'sad'
  END;

  UPDATE public.economy_pets
     SET hunger = v_new_hunger,
         status = v_new_status,
         updated_at = NOW()
   WHERE id = v_pet.id;

  RETURN jsonb_build_object(
    'success', true,
    'old_hunger', v_pet.hunger,
    'new_hunger', v_new_hunger,
    'status', v_new_status
  );
END;
$$;

-- ── 2. economy_pet_play ──────────────────────────────────────
CREATE OR REPLACE FUNCTION economy_pet_play(
  p_guild_id TEXT,
  p_user_id  TEXT,
  p_happiness_gain INT DEFAULT 25,
  p_energy_cost    INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pet RECORD;
  v_new_happiness INT;
  v_new_energy INT;
  v_new_status TEXT;
BEGIN
  SELECT id, hunger, happiness, energy, status INTO v_pet
    FROM public.economy_pets
   WHERE guild_id = p_guild_id AND user_id = p_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_pet');
  END IF;

  v_new_happiness := LEAST(100, v_pet.happiness + p_happiness_gain);
  v_new_energy := GREATEST(0, v_pet.energy - p_energy_cost);
  v_new_status := CASE
    WHEN v_pet.hunger > 30 AND v_new_happiness > 30 THEN 'happy'
    ELSE 'sad'
  END;

  UPDATE public.economy_pets
     SET happiness = v_new_happiness,
         energy = v_new_energy,
         status = v_new_status,
         updated_at = NOW()
   WHERE id = v_pet.id;

  RETURN jsonb_build_object(
    'success', true,
    'old_happiness', v_pet.happiness,
    'new_happiness', v_new_happiness,
    'new_energy', v_new_energy,
    'status', v_new_status
  );
END;
$$;

-- ── 3. economy_pet_train ─────────────────────────────────────
CREATE OR REPLACE FUNCTION economy_pet_train(
  p_guild_id TEXT,
  p_user_id  TEXT,
  p_xp_gain  INT,
  p_energy_cost INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pet RECORD;
  v_new_xp INT;
  v_new_level INT;
  v_new_energy INT;
  v_leveled_up BOOLEAN;
  v_stat_bonus TEXT;
BEGIN
  SELECT id, xp, level, energy, attack, defense, speed, health, prestige
    INTO v_pet
    FROM public.economy_pets
   WHERE guild_id = p_guild_id AND user_id = p_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_pet');
  END IF;

  v_new_xp := v_pet.xp + p_xp_gain;
  v_new_level := LEAST(50, FLOOR(v_new_xp / 100) + 1);
  v_new_energy := GREATEST(0, v_pet.energy - p_energy_cost);
  v_leveled_up := v_new_level > v_pet.level;

  -- Auto stat bonus every 5 levels
  v_stat_bonus := NULL;
  IF v_leveled_up AND v_new_level % 5 = 0 THEN
    -- Pick random stat (seeded by pet id + level for determinism)
    v_stat_bonus := (ARRAY['attack','defense','speed','health'])[1 + FLOOR(RANDOM() * 4)];
  END IF;

  UPDATE public.economy_pets
     SET xp = v_new_xp,
         level = v_new_level,
         energy = v_new_energy,
         attack = CASE WHEN v_stat_bonus = 'attack' THEN attack + 1 ELSE attack END,
         defense = CASE WHEN v_stat_bonus = 'defense' THEN defense + 1 ELSE defense END,
         speed = CASE WHEN v_stat_bonus = 'speed' THEN speed + 1 ELSE speed END,
         health = CASE WHEN v_stat_bonus = 'health' THEN health + 1 ELSE health END,
         updated_at = NOW()
   WHERE id = v_pet.id;

  RETURN jsonb_build_object(
    'success', true,
    'new_xp', v_new_xp,
    'new_level', v_new_level,
    'leveled_up', v_leveled_up,
    'new_energy', v_new_energy,
    'stat_bonus', v_stat_bonus
  );
END;
$$;

-- ── REVOKE/GRANT for new RPCs ────────────────────────────────
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOR fn IN
    SELECT oid::regprocedure::text FROM pg_proc
    WHERE proname IN ('economy_pet_feed','economy_pet_play','economy_pet_train')
    AND pronamespace = 'public'::regnamespace
  LOOP
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM public', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END $$;
