-- Extend increment_member_xp to also return the member's post-update
-- total_messages, so the message-XP path can drive the 'messages_sent'
-- achievement without a second read. Backward-compatible: the return stays a
-- JSONB object and only gains a key; existing callers that read
-- new_xp/old_level/new_level/leveled_up are unaffected.

BEGIN;

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
  v_old_level      INT;
  v_new_xp         INT;
  v_new_level      INT;
  v_total_messages INT;
  v_xp_per_level CONSTANT INT := 100;
BEGIN
  IF p_voice_minutes < 0 THEN
    RAISE EXCEPTION 'increment_member_xp: voice_minutes cannot be negative, got %', p_voice_minutes;
  END IF;

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
  RETURNING public.member_levels.xp, public.member_levels.level, public.member_levels.total_messages
  INTO v_new_xp, v_old_level, v_total_messages;

  v_new_level := FLOOR(v_new_xp::numeric / v_xp_per_level);

  IF v_new_level <> v_old_level THEN
    UPDATE public.member_levels
       SET level = v_new_level
     WHERE guild_id = p_guild_id AND member_id = p_member_id;
  END IF;

  RETURN jsonb_build_object(
    'new_xp',         v_new_xp,
    'old_level',      v_old_level,
    'new_level',      v_new_level,
    'leveled_up',     (v_new_level > v_old_level),
    'total_messages', v_total_messages
  );
END;
$$;

REVOKE ALL ON FUNCTION public.increment_member_xp(text, text, integer, boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_member_xp(text, text, integer, boolean, integer)
  TO service_role;

COMMIT;
