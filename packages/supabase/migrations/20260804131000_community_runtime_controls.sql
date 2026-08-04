-- Community dashboard controls consumed by the bot at runtime.
-- Every column is additive and keeps the catalog default for existing guilds.
ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS level_curve jsonb NOT NULL DEFAULT '{"base":100,"exponent":1.9}'::jsonb,
  ADD COLUMN IF NOT EXISTS max_poll_options integer NOT NULL DEFAULT 10 CHECK (max_poll_options BETWEEN 2 AND 10),
  ADD COLUMN IF NOT EXISTS allow_multiple_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reaction_roles_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS default_style text NOT NULL DEFAULT 'buttons' CHECK (default_style IN ('reaction','buttons','select-menu')),
  ADD COLUMN IF NOT EXISTS default_max_per_group integer NOT NULL DEFAULT 0 CHECK (default_max_per_group BETWEEN 0 AND 25),
  ADD COLUMN IF NOT EXISTS default_require_level integer NOT NULL DEFAULT 0 CHECK (default_require_level BETWEEN 0 AND 1000),
  ADD COLUMN IF NOT EXISTS default_remove_on_unreact boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_schedules_per_guild integer NOT NULL DEFAULT 25 CHECK (max_schedules_per_guild BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS default_timezone text NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS missed_run_policy text NOT NULL DEFAULT 'skip-missed' CHECK (missed_run_policy IN ('skip-missed','send-latest')),
  ADD COLUMN IF NOT EXISTS allow_embeds boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS variables_enabled boolean NOT NULL DEFAULT true;

-- Keep malformed legacy JSON from breaking runtime parsing.
UPDATE public.guild_config
SET level_curve = '{"base":100,"exponent":1.9}'::jsonb
WHERE jsonb_typeof(level_curve) <> 'object'
   OR CASE
        WHEN (level_curve->>'base') ~ '^[0-9]+(\.[0-9]+)?$'
        THEN (level_curve->>'base')::numeric
        ELSE 0
      END <= 0
   OR CASE
        WHEN (level_curve->>'exponent') ~ '^[0-9]+(\.[0-9]+)?$'
        THEN (level_curve->>'exponent')::numeric
        ELSE 0
      END <= 0;

ALTER TABLE public.guild_config
  DROP CONSTRAINT IF EXISTS guild_config_level_curve_shape_check,
  ADD CONSTRAINT guild_config_level_curve_shape_check CHECK (
    jsonb_typeof(level_curve) = 'object'
    AND (level_curve->>'base') ~ '^[0-9]+(\.[0-9]+)?$'
    AND (level_curve->>'exponent') ~ '^[0-9]+(\.[0-9]+)?$'
    AND (CASE
      WHEN (level_curve->>'base') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (level_curve->>'base')::numeric
      ELSE NULL
    END BETWEEN 1 AND 1000000)
    AND (CASE
      WHEN (level_curve->>'exponent') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (level_curve->>'exponent')::numeric
      ELSE NULL
    END BETWEEN 0.1 AND 5)
  );

-- Dynamic curve helper used by XP writers. The legacy helper remains available
-- for compatibility; guild-scoped writes read the owner curve atomically.
CREATE OR REPLACE FUNCTION public.level_for_guild_xp(p_guild_id text, p_xp integer)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  curve jsonb;
  base numeric := 100;
  exponent numeric := 1.9;
  level integer := 0;
  needed numeric := 0;
BEGIN
  SELECT gc.level_curve INTO curve FROM public.guild_config gc WHERE gc.guild_id = p_guild_id;
  IF curve IS NOT NULL THEN
    base := COALESCE((curve->>'base')::numeric, base);
    exponent := COALESCE((curve->>'exponent')::numeric, exponent);
  END IF;
  IF p_xp IS NULL OR p_xp < 0 THEN RETURN 0; END IF;
  WHILE level < 200 LOOP
    IF base = 100 AND exponent = 1.9 THEN
      needed := needed + (5 * level * level + 50 * level + 100);
    ELSE
      needed := needed + base * power(level + 1, exponent);
    END IF;
    EXIT WHEN p_xp < needed;
    level := level + 1;
  END LOOP;
  RETURN LEAST(200, level);
END;
$$;
REVOKE ALL ON FUNCTION public.level_for_guild_xp(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.level_for_guild_xp(text, integer) TO service_role;

-- Route the two XP writers through the guild-aware helper so a dashboard
-- curve change affects both message/voice accrual and administrative /xp set.
CREATE OR REPLACE FUNCTION public.increment_member_xp(
  p_guild_id text, p_member_id text, p_xp_amount integer,
  p_increment_messages boolean DEFAULT false, p_voice_minutes integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE old_level integer; new_xp integer; new_level integer; total_messages integer;
BEGIN
  IF p_voice_minutes < 0 THEN RAISE EXCEPTION 'voice_minutes cannot be negative'; END IF;
  INSERT INTO public.member_levels(guild_id, member_id, xp, level, total_messages, voice_minutes, last_xp_at, updated_at)
  VALUES (p_guild_id, p_member_id, GREATEST(0,p_xp_amount), 0,
    CASE WHEN p_increment_messages THEN 1 ELSE 0 END, p_voice_minutes, now(), now())
  ON CONFLICT (guild_id, member_id) DO UPDATE SET
    xp = GREATEST(0, public.member_levels.xp + p_xp_amount),
    total_messages = public.member_levels.total_messages + CASE WHEN p_increment_messages THEN 1 ELSE 0 END,
    voice_minutes = public.member_levels.voice_minutes + p_voice_minutes,
    last_xp_at = now(), updated_at = now()
  RETURNING public.member_levels.level, public.member_levels.xp, public.member_levels.total_messages
  INTO old_level, new_xp, total_messages;
  new_level := public.level_for_guild_xp(p_guild_id, new_xp);
  UPDATE public.member_levels SET level = new_level WHERE guild_id = p_guild_id AND member_id = p_member_id;
  RETURN jsonb_build_object('new_xp',new_xp,'old_level',old_level,'new_level',new_level,
    'leveled_up',new_level > old_level,'total_messages',total_messages);
END; $$;
REVOKE ALL ON FUNCTION public.increment_member_xp(text,text,integer,boolean,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_member_xp(text,text,integer,boolean,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.set_member_xp(p_guild_id text, p_member_id text, p_xp integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE old_level integer; new_xp integer; new_level integer;
BEGIN
  SELECT ml.level INTO old_level FROM public.member_levels ml
    WHERE ml.guild_id = p_guild_id AND ml.member_id = p_member_id;
  old_level := COALESCE(old_level, 0);
  new_xp := GREATEST(0, p_xp);
  new_level := public.level_for_guild_xp(p_guild_id, new_xp);
  INSERT INTO public.member_levels(guild_id, member_id, xp, level, total_messages, voice_minutes, updated_at)
  VALUES (p_guild_id,p_member_id,new_xp,new_level,0,0,now())
  ON CONFLICT (guild_id,member_id) DO UPDATE SET xp=EXCLUDED.xp, level=EXCLUDED.level, updated_at=now()
  RETURN jsonb_build_object('new_xp',new_xp,'old_level',old_level,'new_level',new_level,'leveled_up',new_level > old_level);
END; $$;
REVOKE ALL ON FUNCTION public.set_member_xp(text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_member_xp(text,text,integer) TO service_role;
