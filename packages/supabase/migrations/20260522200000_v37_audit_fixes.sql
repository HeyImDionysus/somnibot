-- V37 Audit Fixes
-- 1. Add lottery_increment_jackpot RPC to prevent TOCTOU race on jackpot updates
-- 2. Fix economy_weekly_quest_count default (1 → 5 to match code/dashboard)

-- ── lottery_increment_jackpot ───────────────────────────────────────
-- Atomically adds amount to the jackpot of a lottery drawing.
-- Prevents concurrent ticket purchases from losing jackpot contributions.
CREATE OR REPLACE FUNCTION lottery_increment_jackpot(
  p_drawing_id UUID,
  p_amount     INTEGER
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_jackpot INTEGER;
BEGIN
  UPDATE public.economy_lottery_drawings
  SET jackpot = jackpot + p_amount
  WHERE id = p_drawing_id
  RETURNING jackpot INTO new_jackpot;

  RETURN COALESCE(new_jackpot, 0);
END;
$$;

-- ── Fix weekly quest count default ──────────────────────────────────
-- DB default was 1, but code/dashboard both default to 5.
ALTER TABLE guild_config
  ALTER COLUMN economy_weekly_quest_count SET DEFAULT 5;
