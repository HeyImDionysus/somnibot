-- =============================================================================
-- Level-curve parity: one level formula everywhere.
--
-- Two different formulas wrote member_levels.level:
--   * increment_member_xp (20260721000000) used FLOOR(xp / 100);
--   * ALL display code and /xp set used the designed cumulative quadratic
--     curve from packages/shared/src/constants/levels.ts
--     (XP to advance FROM level L: 5*L^2 + 50*L + 100, capped at level 200).
-- At 1000 XP the SQL said level 10 while the display math said level 4, so
-- /rank contradicted its own progress bar, /xp set wrote a quadratic level the
-- next message-XP RPC recomputed flat (phantom multi-level jump -> the
-- level-announcer granted EVERY role reward in between), {nextLevelXp} in
-- announcements was wrong, and pacing ran ~4.7x faster than designed with no
-- MAX_LEVEL cap.
--
-- The quadratic wins (it is the designed curve). This migration:
--   1. adds public.level_for_xp — the exact SQL port of calculateLevel();
--   2. re-creates increment_member_xp with the body copied verbatim from
--      20260721000000, changing ONLY the level computation to level_for_xp;
--   3. adds set_member_xp so /xp set goes through the same single writer of
--      member_levels.level semantics instead of hand-computing in TS;
--   4. backfills member_levels.level from xp (pure DB write — no events fire;
--      most stored levels DROP: that is the correction, XP is untouched).
-- =============================================================================

BEGIN;

-- ── 1. level_for_xp ──────────────────────────────────────────────────────────
-- Exact port of calculateLevel() in packages/shared/src/constants/levels.ts:
--   level = 0; xpNeeded = 0;
--   while (level < MAX_LEVEL) { xpNeeded += 5*level^2 + 50*level + 100;
--                               if (totalXp < xpNeeded) break; level++; }
-- MAX_LEVEL = 200. Negative (or NULL) XP yields level 0, same as the TS
-- function's behavior for totalXp < 100.

CREATE OR REPLACE FUNCTION public.level_for_xp(p_xp integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_level     integer := 0;
  v_xp_needed bigint  := 0;
BEGIN
  IF p_xp IS NULL OR p_xp < 100 THEN
    RETURN 0;
  END IF;

  WHILE v_level < 200 LOOP
    v_xp_needed := v_xp_needed + (5 * v_level * v_level + 50 * v_level + 100);
    EXIT WHEN p_xp < v_xp_needed;
    v_level := v_level + 1;
  END LOOP;

  RETURN LEAST(200, v_level);
END;
$$;

REVOKE ALL ON FUNCTION public.level_for_xp(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.level_for_xp(integer)
  TO service_role;

-- ── 2. increment_member_xp ───────────────────────────────────────────────────
-- Body copied verbatim from 20260721000000_increment_member_xp_return_total_
-- messages.sql (the current definition — no later migration replaces it), with
-- ONLY the level computation changed: FLOOR(new_xp / 100) [and its
-- v_xp_per_level constant] -> public.level_for_xp(new_xp). Signature, JSONB
-- return shape, SECURITY DEFINER, search_path and grants are preserved.

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

  v_new_level := public.level_for_xp(v_new_xp);

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

-- ── 3. set_member_xp ─────────────────────────────────────────────────────────
-- Single writer for /xp set: the bot passes the target XP and the DB computes
-- the level with the same level_for_xp used by increment_member_xp, so an
-- admin set can never write a level the next message-XP RPC would contradict
-- (previously that mismatch caused phantom multi-level jumps and mass
-- role-reward grants). Same JSONB shape family as increment_member_xp.

CREATE OR REPLACE FUNCTION public.set_member_xp(
  p_guild_id  text,
  p_member_id text,
  p_xp        integer
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
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'set_member_xp: p_guild_id is required';
  END IF;
  IF p_member_id IS NULL OR pg_catalog.btrim(p_member_id) = '' THEN
    RAISE EXCEPTION 'set_member_xp: p_member_id is required';
  END IF;
  IF p_xp IS NULL THEN
    RAISE EXCEPTION 'set_member_xp: p_xp is required';
  END IF;

  v_new_xp    := GREATEST(0, p_xp);
  v_new_level := public.level_for_xp(v_new_xp);

  -- Upsert xp only; RETURNING captures the pre-correction level so the caller
  -- sees old_level/new_level, mirroring increment_member_xp's two-step shape.
  INSERT INTO public.member_levels (
    guild_id, member_id, xp, level, total_messages, voice_minutes, updated_at
  )
  VALUES (p_guild_id, p_member_id, v_new_xp, v_new_level, 0, 0, now())
  ON CONFLICT (guild_id, member_id) DO UPDATE SET
    xp         = GREATEST(0, EXCLUDED.xp),
    updated_at = now()
  RETURNING public.member_levels.level
  INTO v_old_level;

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

REVOKE ALL ON FUNCTION public.set_member_xp(text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_member_xp(text, text, integer)
  TO service_role;

-- ── 4. Backfill ──────────────────────────────────────────────────────────────
-- Correct every stored level to the designed curve. Pure DB write: no events,
-- no announcements, no role churn — the level-announcer only reacts to live
-- level-up results returned by the RPCs. XP is untouched. Idempotent: rows
-- already on the quadratic curve match the predicate and are skipped.

UPDATE public.member_levels
   SET level = public.level_for_xp(xp)
 WHERE level IS DISTINCT FROM public.level_for_xp(xp);

COMMIT;
