BEGIN;

CREATE OR REPLACE FUNCTION public.audit_economy_pet_operation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action TEXT;
BEGIN
  IF COALESCE((NEW.result ->> 'applied')::BOOLEAN, false) IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  v_action := CASE NEW.operation
    WHEN 'buy' THEN 'pet.acquired'
    WHEN 'feed' THEN 'pets.fed'
    WHEN 'train' THEN 'pets.trained'
    WHEN 'play' THEN 'pets.played'
    WHEN 'rename' THEN 'pets.renamed'
    ELSE NULL
  END;
  IF v_action IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, category, target_type, target_id,
    details, correlation_id, occurrence_key, success
  ) VALUES (
    NEW.guild_id, 'user', NEW.user_id, v_action, 'economy', 'member', NEW.user_id,
    NEW.result, NEW.request_id, v_action || ':' || NEW.request_id, true
  ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS economy_pet_operation_audit ON public.economy_pet_operations;
CREATE TRIGGER economy_pet_operation_audit
AFTER INSERT ON public.economy_pet_operations
FOR EACH ROW EXECUTE FUNCTION public.audit_economy_pet_operation();

ALTER TABLE public.economy_pet_battles
  ADD COLUMN IF NOT EXISTS operation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_pet_battles_operation
  ON public.economy_pet_battles (guild_id, operation_id)
  WHERE operation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.economy_pet_battle_atomic(
  p_guild_id TEXT,
  p_challenger_id TEXT,
  p_defender_id TEXT,
  p_winner_id TEXT,
  p_challenger_dmg INT,
  p_defender_dmg INT,
  p_reward BIGINT,
  p_operation_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_battle_id UUID;
BEGIN
  IF p_operation_id IS NULL OR pg_catalog.btrim(p_operation_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_battle_atomic: p_operation_id is required';
  END IF;
  IF p_reward <= 0 THEN
    RAISE EXCEPTION 'economy_pet_battle_atomic: p_reward must be positive';
  END IF;
  IF p_winner_id NOT IN (p_challenger_id, p_defender_id) THEN
    RAISE EXCEPTION 'economy_pet_battle_atomic: winner must be a participant';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-pet-battle:' || p_guild_id || ':' || p_operation_id, 0)
  );

  SELECT id INTO v_battle_id
    FROM public.economy_pet_battles
   WHERE guild_id = p_guild_id AND operation_id = p_operation_id;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'resolved', 'replayed', true, 'battle_id', v_battle_id
    );
  END IF;

  INSERT INTO public.economy_pet_battles (
    guild_id, challenger_id, defender_id, winner_id, challenger_dmg,
    defender_dmg, reward, operation_id
  ) VALUES (
    p_guild_id, p_challenger_id, p_defender_id, p_winner_id, p_challenger_dmg,
    p_defender_dmg, p_reward, p_operation_id
  ) RETURNING id INTO v_battle_id;

  PERFORM public.economy_add_balance(
    p_guild_id, p_winner_id, p_reward,
    'pet:battle:' || p_operation_id || ':payout'
  );

  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, category, target_type, target_id,
    details, correlation_id, occurrence_key, success
  ) VALUES (
    p_guild_id, 'user', p_challenger_id, 'pet.battle_resolved', 'economy',
    'member', p_winner_id,
    pg_catalog.jsonb_build_object(
      'battleId', v_battle_id,
      'challengerId', p_challenger_id,
      'defenderId', p_defender_id,
      'winnerId', p_winner_id,
      'reward', p_reward,
      'payoutFailed', false
    ),
    p_operation_id, 'pet.battle_resolved:' || p_operation_id, true
  ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'resolved', 'replayed', false, 'battle_id', v_battle_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.economy_pet_battle_atomic(
  TEXT, TEXT, TEXT, TEXT, INT, INT, BIGINT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_pet_battle_atomic(
  TEXT, TEXT, TEXT, TEXT, INT, INT, BIGINT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.economy_pet_atomic_prestige_audited(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_max_level INT,
  p_request_id TEXT
)
RETURNS TABLE(
  success BOOLEAN,
  replayed BOOLEAN,
  new_prestige INT,
  new_attack INT,
  new_defense INT,
  new_speed INT,
  new_health INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSONB;
  v_pet public.economy_pets%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_atomic_prestige_audited: p_request_id is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-pet-prestige:' || p_guild_id || ':' || p_user_id, 0)
  );

  SELECT result INTO v_result
    FROM public.economy_pet_operations
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id
     AND operation = 'prestige'
     AND request_id = p_request_id;
  IF FOUND THEN
    RETURN QUERY SELECT
      true,
      true,
      (v_result ->> 'new_prestige')::INT,
      (v_result ->> 'new_attack')::INT,
      (v_result ->> 'new_defense')::INT,
      (v_result ->> 'new_speed')::INT,
      (v_result ->> 'new_health')::INT;
    RETURN;
  END IF;

  SELECT * INTO v_pet
    FROM public.economy_pets
   WHERE guild_id = p_guild_id AND user_id = p_user_id AND level >= p_max_level
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.economy_pets
     SET prestige = prestige + 1,
         level = 1,
         xp = 0,
         attack = attack + 1,
         defense = defense + 1,
         speed = speed + 1,
         health = health + 2,
         updated_at = pg_catalog.now()
   WHERE id = v_pet.id
   RETURNING * INTO v_pet;

  v_result := pg_catalog.jsonb_build_object(
    'status', 'prestiged',
    'applied', true,
    'replayed', false,
    'new_prestige', v_pet.prestige,
    'new_attack', v_pet.attack,
    'new_defense', v_pet.defense,
    'new_speed', v_pet.speed,
    'new_health', v_pet.health
  );

  INSERT INTO public.economy_pet_operations (
    guild_id, user_id, pet_id, operation, request_id, result
  ) VALUES (
    p_guild_id, p_user_id, v_pet.id, 'prestige', p_request_id, v_result
  );

  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, category, target_type, target_id,
    details, correlation_id, occurrence_key, success
  ) VALUES (
    p_guild_id, 'user', p_user_id, 'pet.prestiged', 'economy', 'member', p_user_id,
    v_result, p_request_id, 'pet.prestiged:' || p_request_id, true
  ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

  RETURN QUERY SELECT
    true, false, v_pet.prestige, v_pet.attack, v_pet.defense, v_pet.speed, v_pet.health;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_pet_atomic_prestige_audited(TEXT, TEXT, INT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_pet_atomic_prestige_audited(TEXT, TEXT, INT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.economy_prestige_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.last_request_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.last_request_id IS NOT DISTINCT FROM OLD.last_request_id) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, category, target_type, target_id,
    details, correlation_id, occurrence_key, success
  ) VALUES (
    NEW.guild_id, 'user', NEW.user_id, 'prestige.performed', 'economy', 'member', NEW.user_id,
    pg_catalog.jsonb_build_object(
      'newLevel', NEW.prestige_level,
      'newMultiplier', NEW.multiplier_pct
    ),
    NEW.last_request_id, 'prestige.performed:' || NEW.last_request_id, true
  ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS economy_prestige_audit ON public.economy_prestige;
CREATE TRIGGER economy_prestige_audit
AFTER INSERT OR UPDATE OF last_request_id ON public.economy_prestige
FOR EACH ROW EXECUTE FUNCTION public.economy_prestige_audit();

COMMIT;
