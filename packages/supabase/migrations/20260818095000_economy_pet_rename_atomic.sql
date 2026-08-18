BEGIN;

CREATE OR REPLACE FUNCTION public.economy_pet_rename_atomic(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_new_name TEXT,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pet public.economy_pets%ROWTYPE;
  v_result JSONB;
  v_new_name TEXT;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_rename_atomic: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_rename_atomic: p_user_id is required';
  END IF;
  IF p_new_name IS NULL OR pg_catalog.btrim(p_new_name) = '' THEN
    RAISE EXCEPTION 'economy_pet_rename_atomic: p_new_name is required';
  END IF;
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_pet_rename_atomic: p_request_id is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-pet-rename:' || p_guild_id || ':' || p_user_id, 0)
  );

  SELECT result INTO v_result
    FROM public.economy_pet_operations
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id
     AND operation = 'rename'
     AND request_id = p_request_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN v_result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_pet
    FROM public.economy_pets
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'no_pet', 'applied', false, 'replayed', false
    );
  END IF;

  UPDATE public.economy_pets
     SET name = p_new_name,
         updated_at = pg_catalog.now()
   WHERE id = v_pet.id
     AND guild_id = p_guild_id
     AND user_id = p_user_id
   RETURNING name INTO v_new_name;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'mutation_not_applied', 'applied', false, 'replayed', false
    );
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'status', 'renamed', 'applied', true, 'replayed', false,
    'old_name', v_pet.name, 'new_name', v_new_name
  );
  INSERT INTO public.economy_pet_operations
    (guild_id, user_id, pet_id, operation, request_id, result)
  VALUES (p_guild_id, p_user_id, v_pet.id, 'rename', p_request_id, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_pet_rename_atomic(TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_pet_rename_atomic(TEXT, TEXT, TEXT, TEXT)
  TO service_role;

COMMIT;
