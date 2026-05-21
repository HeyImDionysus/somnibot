-- V45 audit fix
-- 1. economy_pet_add_xp RPC: also recalculate level column
--    Previously only incremented xp without updating level, so battle XP
--    never triggered level-ups (level only updated on /pet train).
--    Formula matches bot logic: LEAST(50, FLOOR(xp / 100) + 1)

CREATE OR REPLACE FUNCTION economy_pet_add_xp(
  p_guild_id TEXT,
  p_user_id  TEXT,
  p_xp       INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.economy_pets
     SET xp = xp + p_xp,
         level = LEAST(50, FLOOR((xp + p_xp) / 100) + 1),
         updated_at = NOW()
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
END;
$$;

-- REVOKE/GRANT (idempotent — same pattern as V44)
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOR fn IN
    SELECT oid::regprocedure::text FROM pg_proc
    WHERE proname = 'economy_pet_add_xp'
    AND pronamespace = 'public'::regnamespace
  LOOP
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM public', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END $$;
