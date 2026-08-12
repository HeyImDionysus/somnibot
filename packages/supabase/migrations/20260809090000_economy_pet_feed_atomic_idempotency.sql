-- Atomic, idempotent pet feeding.
--
-- The bot previously debited the wallet and mutated pet state in separate RPC
-- calls. A redelivered interaction could therefore charge twice (and a
-- timeout after commit could not safely be retried). Keep the request ledger
-- tied to the pet row so GDPR/member and guild purges remove it through the
-- existing foreign keys.

BEGIN;

CREATE TABLE IF NOT EXISTS public.economy_pet_operations (
  guild_id   TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  pet_id     UUID NOT NULL REFERENCES public.economy_pets(id) ON DELETE CASCADE,
  operation  TEXT NOT NULL,
  request_id TEXT NOT NULL,
  result     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (guild_id, user_id, operation, request_id)
);

CREATE INDEX IF NOT EXISTS idx_economy_pet_operations_created
  ON public.economy_pet_operations (created_at);

ALTER TABLE public.economy_pet_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON public.economy_pet_operations;
CREATE POLICY service_role_all ON public.economy_pet_operations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.economy_pet_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.economy_pet_operations TO service_role;

CREATE OR REPLACE FUNCTION public.economy_pet_feed_atomic(
  p_guild_id   TEXT,
  p_user_id    TEXT,
  p_amount     INT,
  p_cost       BIGINT,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pet       public.economy_pets%ROWTYPE;
  v_wallet    BIGINT;
  v_new_hunger INT;
  v_new_status TEXT;
  v_result    JSONB;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_feed_atomic: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_feed_atomic: p_user_id is required';
  END IF;
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_feed_atomic: p_request_id is required';
  END IF;
  IF p_amount < 0 THEN
    RAISE EXCEPTION 'economy_pet_feed_atomic: p_amount must be non-negative';
  END IF;
  IF p_cost < 0 THEN
    RAISE EXCEPTION 'economy_pet_feed_atomic: p_cost must be non-negative';
  END IF;

  -- Serialize every wallet/pet mutation for this member.  This also makes a
  -- concurrent duplicate wait for the first call to commit before replaying.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-pet-feed:' || p_guild_id || ':' || p_user_id, 0)
  );

  SELECT result INTO v_result
    FROM public.economy_pet_operations
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id
     AND operation = 'feed'
     AND request_id = p_request_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN v_result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;
  SELECT metadata -> 'result' INTO v_result
   FROM public.economy_transactions
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id
     AND idempotency_key = 'pet:feed:' || p_request_id
   LIMIT 1;
  IF FOUND THEN
    RETURN v_result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_pet
    FROM public.economy_pets
   WHERE guild_id = p_guild_id AND user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    v_result := pg_catalog.jsonb_build_object(
      'status', 'no_pet', 'applied', false, 'replayed', false
    );
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_feed_result', 0, 0, 'Pet feed not applied',
      pg_catalog.jsonb_build_object('result', v_result), 'pet:feed:' || p_request_id);
    RETURN v_result;
  END IF;

  IF v_pet.hunger >= 100 THEN
    v_result := pg_catalog.jsonb_build_object(
      'status', 'already_full', 'applied', false, 'replayed', false,
      'old_hunger', v_pet.hunger, 'new_hunger', v_pet.hunger
    );
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_feed_result', 0, 0, 'Pet feed not applied',
      pg_catalog.jsonb_build_object('result', v_result), 'pet:feed:' || p_request_id);
    RETURN v_result;
  END IF;

  SELECT wallet INTO v_wallet
    FROM public.economy_wallets
   WHERE guild_id = p_guild_id AND user_id = p_user_id
   FOR UPDATE;
  v_wallet := COALESCE(v_wallet, 0);
  IF v_wallet < p_cost THEN
    v_result := pg_catalog.jsonb_build_object(
      'status', 'insufficient_balance', 'applied', false, 'replayed', false,
      'wallet_balance', v_wallet, 'cost', p_cost
    );
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_feed_result', 0, v_wallet, 'Pet feed not applied',
      pg_catalog.jsonb_build_object('result', v_result), 'pet:feed:' || p_request_id);
    RETURN v_result;
  END IF;

  -- Debit and hunger update are in this transaction.  economy_subtract_balance
  -- intentionally did not update total_spent, so preserve that behavior.
  IF p_cost > 0 THEN
    UPDATE public.economy_wallets
       SET wallet = wallet - p_cost,
           updated_at = pg_catalog.now()
     WHERE guild_id = p_guild_id AND user_id = p_user_id;
  END IF;

  v_new_hunger := LEAST(100, v_pet.hunger + p_amount);
  v_new_status := CASE
    WHEN v_new_hunger > 30 AND v_pet.happiness > 30 THEN 'happy'
    ELSE 'sad'
  END;

  UPDATE public.economy_pets
     SET hunger = v_new_hunger,
         status = v_new_status,
         updated_at = pg_catalog.now()
   WHERE id = v_pet.id;

  v_result := pg_catalog.jsonb_build_object(
    'status', 'fed', 'applied', true, 'replayed', false,
    'old_hunger', v_pet.hunger, 'new_hunger', v_new_hunger,
    'pet_name', v_pet.name
  );
  IF p_cost > 0 THEN
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_feed', -p_cost,
      v_wallet - p_cost, 'Pet feed debit',
      pg_catalog.jsonb_build_object('result', v_result), 'pet:feed:' || p_request_id);
  END IF;
  INSERT INTO public.economy_pet_operations
    (guild_id, user_id, pet_id, operation, request_id, result)
  VALUES (p_guild_id, p_user_id, v_pet.id, 'feed', p_request_id, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_pet_feed_atomic(TEXT, TEXT, INT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_pet_feed_atomic(TEXT, TEXT, INT, BIGINT, TEXT)
  TO service_role;

-- ── Atomic /pet buy ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.economy_pet_buy_atomic(
  p_guild_id   TEXT,
  p_user_id    TEXT,
  p_pet_type   TEXT,
  p_pet_name   TEXT,
  p_price      BIGINT,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pet    public.economy_pets%ROWTYPE;
  v_wallet BIGINT;
  v_result JSONB;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_buy_atomic: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_buy_atomic: p_user_id is required';
  END IF;
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_buy_atomic: p_request_id is required';
  END IF;
  IF p_price < 0 THEN
    RAISE EXCEPTION 'economy_pet_buy_atomic: p_price must be non-negative';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-pet-buy:' || p_guild_id || ':' || p_user_id, 0)
  );

  SELECT result INTO v_result FROM public.economy_pet_operations
   WHERE guild_id = p_guild_id AND user_id = p_user_id
     AND operation = 'buy' AND request_id = p_request_id FOR UPDATE;
  IF FOUND THEN RETURN v_result || pg_catalog.jsonb_build_object('replayed', true); END IF;
  SELECT metadata -> 'result' INTO v_result FROM public.economy_transactions
   WHERE guild_id = p_guild_id AND user_id = p_user_id
     AND idempotency_key = 'pet:buy:' || p_request_id LIMIT 1;
  IF FOUND THEN RETURN v_result || pg_catalog.jsonb_build_object('replayed', true); END IF;

  SELECT * INTO v_pet FROM public.economy_pets
   WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  IF FOUND THEN
    v_result := pg_catalog.jsonb_build_object('status', 'already_has_pet', 'applied', false, 'replayed', false);
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_buy_result', 0, 0, 'Pet purchase not applied',
      pg_catalog.jsonb_build_object('result', v_result), 'pet:buy:' || p_request_id);
    RETURN v_result;
  END IF;

  SELECT wallet INTO v_wallet FROM public.economy_wallets
   WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  v_wallet := COALESCE(v_wallet, 0);
  IF v_wallet < p_price THEN
    v_result := pg_catalog.jsonb_build_object(
      'status', 'insufficient_balance', 'applied', false, 'replayed', false,
      'wallet_balance', v_wallet, 'cost', p_price
    );
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_buy_result', 0, v_wallet, 'Pet purchase not applied',
      pg_catalog.jsonb_build_object('result', v_result), 'pet:buy:' || p_request_id);
    RETURN v_result;
  END IF;

  IF p_price > 0 THEN
    UPDATE public.economy_wallets SET wallet = wallet - p_price, updated_at = pg_catalog.now()
     WHERE guild_id = p_guild_id AND user_id = p_user_id;
  END IF;
  INSERT INTO public.economy_pets (guild_id, user_id, pet_type, name)
    VALUES (p_guild_id, p_user_id, p_pet_type, COALESCE(NULLIF(p_pet_name, ''), '🐾 Pet'))
    RETURNING * INTO v_pet;

  v_result := pg_catalog.jsonb_build_object(
    'status', 'purchased', 'applied', true, 'replayed', false,
    'pet_type', p_pet_type, 'pet_name', v_pet.name, 'cost', p_price
  );
  IF p_price > 0 THEN
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_buy', -p_price, v_wallet - p_price,
      'Pet purchase debit', pg_catalog.jsonb_build_object('result', v_result),
      'pet:buy:' || p_request_id);
  END IF;
  INSERT INTO public.economy_pet_operations
    (guild_id, user_id, pet_id, operation, request_id, result)
  VALUES (p_guild_id, p_user_id, v_pet.id, 'buy', p_request_id, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_pet_buy_atomic(TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_pet_buy_atomic(TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT)
  TO service_role;

-- ── Atomic /pet train ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.economy_pet_train_atomic(
  p_guild_id    TEXT,
  p_user_id     TEXT,
  p_xp_gain     INT,
  p_energy_cost INT,
  p_cost        BIGINT,
  p_request_id  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pet         public.economy_pets%ROWTYPE;
  v_wallet      BIGINT;
  v_new_xp      INT;
  v_new_level   INT;
  v_new_energy  INT;
  v_leveled_up  BOOLEAN;
  v_stat_bonus  TEXT;
  v_result      JSONB;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_train_atomic: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_train_atomic: p_user_id is required';
  END IF;
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_train_atomic: p_request_id is required';
  END IF;
  IF p_xp_gain < 0 OR p_energy_cost < 0 OR p_cost < 0 THEN
    RAISE EXCEPTION 'economy_pet_train_atomic: gains, costs, and energy must be non-negative';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-pet-train:' || p_guild_id || ':' || p_user_id, 0)
  );

  SELECT result INTO v_result FROM public.economy_pet_operations
   WHERE guild_id = p_guild_id AND user_id = p_user_id
     AND operation = 'train' AND request_id = p_request_id FOR UPDATE;
  IF FOUND THEN RETURN v_result || pg_catalog.jsonb_build_object('replayed', true); END IF;
  SELECT metadata -> 'result' INTO v_result FROM public.economy_transactions
   WHERE guild_id = p_guild_id AND user_id = p_user_id
     AND idempotency_key = 'pet:train:' || p_request_id LIMIT 1;
  IF FOUND THEN RETURN v_result || pg_catalog.jsonb_build_object('replayed', true); END IF;

  SELECT * INTO v_pet FROM public.economy_pets
   WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    v_result := pg_catalog.jsonb_build_object('status', 'no_pet', 'applied', false, 'replayed', false);
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_train_result', 0, 0, 'Pet training not applied',
      pg_catalog.jsonb_build_object('result', v_result), 'pet:train:' || p_request_id);
    RETURN v_result;
  END IF;
  IF v_pet.energy < p_energy_cost THEN
    v_result := pg_catalog.jsonb_build_object('status', 'low_energy', 'applied', false, 'replayed', false);
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_train_result', 0, 0, 'Pet training not applied',
      pg_catalog.jsonb_build_object('result', v_result), 'pet:train:' || p_request_id);
    RETURN v_result;
  END IF;
  IF v_pet.level >= 50 THEN
    v_result := pg_catalog.jsonb_build_object('status', 'max_level', 'applied', false, 'replayed', false);
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_train_result', 0, 0, 'Pet training not applied',
      pg_catalog.jsonb_build_object('result', v_result), 'pet:train:' || p_request_id);
    RETURN v_result;
  END IF;

  SELECT wallet INTO v_wallet FROM public.economy_wallets
   WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  v_wallet := COALESCE(v_wallet, 0);
  IF v_wallet < p_cost THEN
    v_result := pg_catalog.jsonb_build_object(
      'status', 'insufficient_balance', 'applied', false, 'replayed', false,
      'wallet_balance', v_wallet, 'cost', p_cost
    );
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_train_result', 0, v_wallet, 'Pet training not applied',
      pg_catalog.jsonb_build_object('result', v_result), 'pet:train:' || p_request_id);
    RETURN v_result;
  END IF;
  IF p_cost > 0 THEN
    UPDATE public.economy_wallets SET wallet = wallet - p_cost, updated_at = pg_catalog.now()
     WHERE guild_id = p_guild_id AND user_id = p_user_id;
  END IF;

  v_new_xp := v_pet.xp + p_xp_gain;
  v_new_level := LEAST(50, pg_catalog.floor(v_new_xp / 100.0)::INT + 1);
  v_new_energy := GREATEST(0, v_pet.energy - p_energy_cost);
  v_leveled_up := v_new_level > v_pet.level;
  v_stat_bonus := NULL;
  IF v_leveled_up AND v_new_level % 5 = 0 THEN
    v_stat_bonus := (ARRAY['attack','defense','speed','health'])[1 + pg_catalog.floor(pg_catalog.random() * 4)::INT];
  END IF;

  UPDATE public.economy_pets SET
    xp = v_new_xp, level = v_new_level, energy = v_new_energy,
    attack = CASE WHEN v_stat_bonus = 'attack' THEN attack + 1 ELSE attack END,
    defense = CASE WHEN v_stat_bonus = 'defense' THEN defense + 1 ELSE defense END,
    speed = CASE WHEN v_stat_bonus = 'speed' THEN speed + 1 ELSE speed END,
    health = CASE WHEN v_stat_bonus = 'health' THEN health + 1 ELSE health END,
    updated_at = pg_catalog.now()
   WHERE id = v_pet.id;

  v_result := pg_catalog.jsonb_build_object(
    'status', 'trained', 'applied', true, 'replayed', false,
    'new_xp', v_new_xp, 'new_level', v_new_level,
    'leveled_up', v_leveled_up, 'new_energy', v_new_energy,
    'stat_bonus', v_stat_bonus, 'cost', p_cost,
    'xp_gain', p_xp_gain, 'pet_name', v_pet.name
  );
  IF p_cost > 0 THEN
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_train', -p_cost, v_wallet - p_cost,
      'Pet training debit', pg_catalog.jsonb_build_object('result', v_result),
      'pet:train:' || p_request_id);
  END IF;
  INSERT INTO public.economy_pet_operations
    (guild_id, user_id, pet_id, operation, request_id, result)
  VALUES (p_guild_id, p_user_id, v_pet.id, 'train', p_request_id, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_pet_train_atomic(TEXT, TEXT, INT, INT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_pet_train_atomic(TEXT, TEXT, INT, INT, BIGINT, TEXT)
  TO service_role;

-- ── Atomic /pet play fence ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.economy_pet_play_atomic(
  p_guild_id       TEXT,
  p_user_id        TEXT,
  p_happiness_gain INT,
  p_energy_cost    INT,
  p_request_id     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pet    public.economy_pets%ROWTYPE;
  v_new_happiness INT;
  v_new_energy INT;
  v_new_status TEXT;
  v_result JSONB;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_play_atomic: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_play_atomic: p_user_id is required';
  END IF;
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_play_atomic: p_request_id is required';
  END IF;
  IF p_happiness_gain < 0 OR p_energy_cost < 0 THEN
    RAISE EXCEPTION 'economy_pet_play_atomic: gains and costs must be non-negative';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-pet-play:' || p_guild_id || ':' || p_user_id, 0)
  );
  SELECT result INTO v_result FROM public.economy_pet_operations
   WHERE guild_id = p_guild_id AND user_id = p_user_id
     AND operation = 'play' AND request_id = p_request_id FOR UPDATE;
  IF FOUND THEN RETURN v_result || pg_catalog.jsonb_build_object('replayed', true); END IF;
  SELECT metadata -> 'result' INTO v_result FROM public.economy_transactions
   WHERE guild_id = p_guild_id AND user_id = p_user_id
     AND idempotency_key = 'pet:play:' || p_request_id LIMIT 1;
  IF FOUND THEN RETURN v_result || pg_catalog.jsonb_build_object('replayed', true); END IF;

  SELECT * INTO v_pet FROM public.economy_pets
   WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    v_result := pg_catalog.jsonb_build_object('status', 'no_pet', 'applied', false, 'replayed', false);
    INSERT INTO public.economy_transactions
      (guild_id, user_id, type, amount, balance_after, description, metadata, idempotency_key)
    VALUES (p_guild_id, p_user_id, 'pet_play_result', 0, 0, 'Pet play not applied',
      pg_catalog.jsonb_build_object('result', v_result), 'pet:play:' || p_request_id);
    RETURN v_result;
  END IF;

  v_new_happiness := LEAST(100, v_pet.happiness + p_happiness_gain);
  v_new_energy := GREATEST(0, v_pet.energy - p_energy_cost);
  v_new_status := CASE WHEN v_pet.hunger > 30 AND v_new_happiness > 30 THEN 'happy' ELSE 'sad' END;
  UPDATE public.economy_pets SET happiness = v_new_happiness, energy = v_new_energy,
    status = v_new_status, updated_at = pg_catalog.now() WHERE id = v_pet.id;
  v_result := pg_catalog.jsonb_build_object(
    'status', 'played', 'applied', true, 'replayed', false,
    'old_happiness', v_pet.happiness, 'new_happiness', v_new_happiness,
    'new_energy', v_new_energy, 'pet_name', v_pet.name
  );
  INSERT INTO public.economy_pet_operations
    (guild_id, user_id, pet_id, operation, request_id, result)
  VALUES (p_guild_id, p_user_id, v_pet.id, 'play', p_request_id, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_pet_play_atomic(TEXT, TEXT, INT, INT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_pet_play_atomic(TEXT, TEXT, INT, INT, TEXT)
  TO service_role;

COMMIT;
