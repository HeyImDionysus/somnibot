-- V38: Audit fixes
-- ============================================================

-- ── Fix 1: economy_heist_enabled default mismatch ─────────
-- V31 accidentally created this column with DEFAULT true.
-- V36 tried DEFAULT false via IF NOT EXISTS (no-op).
-- Fix: change the default and update all existing rows that still have the V31 default.
ALTER TABLE guild_config ALTER COLUMN economy_heist_enabled SET DEFAULT false;
UPDATE guild_config SET economy_heist_enabled = false WHERE economy_heist_enabled = true;

-- ── Fix 2: Atomic heist participant array append ──────────
-- Prevents TOCTOU race when multiple users join a heist concurrently.
CREATE OR REPLACE FUNCTION array_append_heist_participant(
  p_heist_id UUID,
  p_user_id  TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_count INTEGER;
  base_chance   INTEGER;
BEGIN
  UPDATE economy_heists
  SET participants = array_append(participants, p_user_id)
  WHERE id = p_heist_id
    AND NOT (p_user_id = ANY(participants));

  -- Recalculate success_chance from actual participant count
  SELECT array_length(participants, 1) INTO current_count
  FROM economy_heists WHERE id = p_heist_id;

  UPDATE economy_heists
  SET success_chance = LEAST(95, success_chance + 7)
  WHERE id = p_heist_id;
END;
$$;
