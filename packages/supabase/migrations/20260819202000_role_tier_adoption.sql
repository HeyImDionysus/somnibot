CREATE OR REPLACE FUNCTION public.desired_state_upsert_role(
  p_guild_id text,
  p_role jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_roles jsonb;
  v_index integer;
  v_key text := p_role ->> 'key';
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR v_key IS NULL OR pg_catalog.btrim(v_key) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'desired_state_upsert_role: guild and role key are required';
  END IF;

  INSERT INTO public.guild_desired_state (guild_id, roles)
  VALUES (p_guild_id, '[]'::jsonb)
  ON CONFLICT (guild_id) DO NOTHING;

  SELECT roles
  INTO v_roles
  FROM public.guild_desired_state
  WHERE guild_id = p_guild_id
  FOR UPDATE;

  SELECT (entry.ordinality - 1)::integer
  INTO v_index
  FROM pg_catalog.jsonb_array_elements(COALESCE(v_roles, '[]'::jsonb)) WITH ORDINALITY AS entry(value, ordinality)
  WHERE entry.value ->> 'key' = v_key
  LIMIT 1;

  IF v_index IS NULL THEN
    IF p_role ->> 'tier' IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'desired_state_upsert_role: a new role requires a tier';
    END IF;
    v_roles := COALESCE(v_roles, '[]'::jsonb) || pg_catalog.jsonb_build_array(p_role);
  ELSE
    v_roles := pg_catalog.jsonb_set(
      v_roles,
      ARRAY[v_index::text],
      (v_roles -> v_index) || p_role
    );
  END IF;

  UPDATE public.guild_desired_state
  SET roles = v_roles,
      updated_at = pg_catalog.now()
  WHERE guild_id = p_guild_id;
END;
$$;

REVOKE ALL ON FUNCTION public.desired_state_upsert_role(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.desired_state_upsert_role(text, jsonb) TO service_role;
