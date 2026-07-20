-- =============================================================================
-- Fix the increment_member_xp signature so member XP is actually earned.
--
-- Every production XP write calls:
--     increment_member_xp(p_guild_id, p_member_id, p_xp_amount,
--                         p_increment_messages, p_voice_minutes)
--   - message XP  : xp-tracker.ts (p_increment_messages = true)
--   - voice XP    : xp-tracker.ts (p_voice_minutes = interval)
--   - /xp add|rm  : levels/admin-commands.ts (p_xp_amount can be NEGATIVE)
-- and reads back { new_xp, old_level, new_level } as a single object.
--
-- A prior migration narrowed the function to
--     increment_member_xp(p_guild_id, p_member_id, p_xp_gain, p_username, p_avatar)
-- — xp-only, positive-only, with p_username/p_avatar accepted but NEVER used, and
-- returning a TABLE. PostgREST resolves overloads by argument NAME, so every real
-- call (p_xp_amount / p_increment_messages / p_voice_minutes) matched no function
-- and failed with PGRST202 → the bot logged the error and granted no XP. Result:
-- message XP, voice XP, and /xp add|remove were ALL dead — leveling never worked.
-- (member_levels already carries total_messages + voice_minutes to track, which
-- the narrowed function never touched.) Surfaced by the community-levels domain
-- proof.
--
-- Restore the canonical contract the bot calls: fold the xp delta, the optional
-- message tick, and the voice minutes into one atomic upsert (serializing
-- concurrent message-XP vs voice-XP for the member), floor the wallet at zero so
-- an /xp remove can't drive XP negative, recompute the level, and return the
-- single { new_xp, old_level, new_level, leveled_up } object the callers read.
-- =============================================================================

BEGIN;

-- Drop the broken, unused (p_xp_gain, p_username, p_avatar) overload so only the
-- canonical signature resolves (avoids an ambiguous-overload gateway error).
DROP FUNCTION IF EXISTS public.increment_member_xp(text, text, integer, text, text);

CREATE OR REPLACE FUNCTION public.increment_member_xp(
  p_guild_id           text,
  p_member_id          text,
  p_xp_amount          integer,
  p_increment_messages boolean DEFAULT false,
  p_voice_minutes      integer DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_level INT;
  v_new_xp    INT;
  v_new_level INT;
  v_xp_per_level CONSTANT INT := 100;
BEGIN
  IF p_voice_minutes < 0 THEN
    RAISE EXCEPTION 'increment_member_xp: voice_minutes cannot be negative, got %', p_voice_minutes;
  END IF;

  -- One atomic upsert: the ON CONFLICT row lock serializes concurrent message-XP
  -- and voice-XP grants for the same member (the race the callers rely on this RPC
  -- to close). RETURNING yields the POST-update xp and the level as it stood
  -- BEFORE we recompute it below (ON CONFLICT does not touch level).
  INSERT INTO public.member_levels (
    guild_id, member_id, xp, level, total_messages, voice_minutes, last_xp_at, updated_at
  )
  VALUES (
    p_guild_id, p_member_id,
    GREATEST(0, p_xp_amount),
    0,
    (CASE WHEN p_increment_messages THEN 1 ELSE 0 END),
    p_voice_minutes,
    now(), now()
  )
  ON CONFLICT (guild_id, member_id) DO UPDATE SET
    xp             = GREATEST(0, public.member_levels.xp + p_xp_amount),
    total_messages = public.member_levels.total_messages + (CASE WHEN p_increment_messages THEN 1 ELSE 0 END),
    voice_minutes  = public.member_levels.voice_minutes + p_voice_minutes,
    last_xp_at     = now(),
    updated_at     = now()
  RETURNING public.member_levels.xp, public.member_levels.level
  INTO v_new_xp, v_old_level;

  v_new_level := FLOOR(v_new_xp::numeric / v_xp_per_level);

  IF v_new_level <> v_old_level THEN
    UPDATE public.member_levels
       SET level = v_new_level
     WHERE guild_id = p_guild_id AND member_id = p_member_id;
  END IF;

  RETURN jsonb_build_object(
    'new_xp',     v_new_xp,
    'old_level',  v_old_level,
    'new_level',  v_new_level,
    'leveled_up', (v_new_level > v_old_level)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.increment_member_xp(text, text, integer, boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_member_xp(text, text, integer, boolean, integer)
  TO service_role;

COMMIT;
