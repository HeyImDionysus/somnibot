CREATE OR REPLACE FUNCTION public.upsert_economy_adventure_graph(
  p_guild_id TEXT,
  p_adventure JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_scene JSONB;
  v_index INTEGER;
  v_scene_count INTEGER;
BEGIN
  IF p_guild_id IS NULL OR p_guild_id = '' THEN
    RAISE EXCEPTION 'guild_id_required' USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_adventure) <> 'object' THEN
    RAISE EXCEPTION 'adventure_object_required' USING ERRCODE = '22023';
  END IF;

  v_scene_count := jsonb_array_length(COALESCE(p_adventure->'scenes', '[]'::jsonb));
  IF v_scene_count < 2 OR v_scene_count > 30 THEN
    RAISE EXCEPTION 'adventure_requires_2_to_30_scenes' USING ERRCODE = '22023';
  END IF;

  IF NULLIF(p_adventure->>'id', '') IS NOT NULL THEN
    v_id := (p_adventure->>'id')::UUID;

    PERFORM 1
      FROM public.economy_adventures
     WHERE id = v_id AND guild_id = p_guild_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'adventure_not_found' USING ERRCODE = 'P0002';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.economy_adventure_sessions
       WHERE adventure_id = v_id
         AND guild_id = p_guild_id
         AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'adventure_has_active_sessions' USING ERRCODE = '55006';
    END IF;

    UPDATE public.economy_adventures
       SET name = p_adventure->>'name',
           emoji = COALESCE(NULLIF(p_adventure->>'emoji', ''), '⚔️'),
           description = NULLIF(p_adventure->>'description', ''),
           adventure_type = COALESCE(p_adventure->>'adventure_type', 'dungeon'),
           difficulty = COALESCE(p_adventure->>'difficulty', 'normal'),
           min_scenes = v_scene_count,
           max_scenes = v_scene_count,
           active = COALESCE((p_adventure->>'active')::BOOLEAN, TRUE),
           updated_at = NOW()
     WHERE id = v_id AND guild_id = p_guild_id;
    DELETE FROM public.economy_adventure_scenes WHERE adventure_id = v_id;
  ELSE
    INSERT INTO public.economy_adventures (
      guild_id, name, emoji, description, adventure_type, difficulty,
      min_scenes, max_scenes, active
    ) VALUES (
      p_guild_id,
      p_adventure->>'name',
      COALESCE(NULLIF(p_adventure->>'emoji', ''), '⚔️'),
      NULLIF(p_adventure->>'description', ''),
      COALESCE(p_adventure->>'adventure_type', 'dungeon'),
      COALESCE(p_adventure->>'difficulty', 'normal'),
      v_scene_count,
      v_scene_count,
      COALESCE((p_adventure->>'active')::BOOLEAN, TRUE)
    ) RETURNING id INTO v_id;
  END IF;

  v_index := 0;
  FOR v_scene IN SELECT value FROM jsonb_array_elements(p_adventure->'scenes')
  LOOP
    INSERT INTO public.economy_adventure_scenes (
      adventure_id, scene_index, text, image_url, choices, loot, is_ending, ending_type
    ) VALUES (
      v_id,
      v_index,
      v_scene->>'text',
      NULLIF(v_scene->>'image_url', ''),
      COALESCE(v_scene->'choices', '[]'::jsonb),
      COALESCE(v_scene->'loot', '[]'::jsonb),
      COALESCE((v_scene->>'is_ending')::BOOLEAN, FALSE),
      NULLIF(v_scene->>'ending_type', '')
    );
    v_index := v_index + 1;
  END LOOP;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_economy_adventure_graph(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_economy_adventure_graph(TEXT, JSONB) TO service_role;
