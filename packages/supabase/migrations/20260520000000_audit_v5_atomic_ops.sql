-- ============================================================
-- Audit V5: Atomic operations for XP, download counts, and
-- customer total fallback.
-- ============================================================

-- ── 1. Atomic XP increment RPC ──────────────────────────────
-- Replaces the read-then-write pattern in xp-tracker.ts to
-- prevent race conditions between message XP and voice XP.
--
-- Level formula: XP_FORMULA(level) = 5L² + 50L + 100
-- calculateLevel: sum XP_FORMULA(0..level-1) until totalXp < sum

CREATE OR REPLACE FUNCTION increment_member_xp(
  p_guild_id TEXT,
  p_member_id TEXT,
  p_xp_amount INT,
  p_increment_messages BOOLEAN DEFAULT FALSE,
  p_voice_minutes INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_xp INT;
  v_old_level INT;
  v_new_xp INT;
  v_new_level INT;
  v_xp_needed INT;
  v_level_cursor INT;
BEGIN
  -- Upsert with atomic increment
  INSERT INTO member_levels (guild_id, member_id, xp, level, total_messages, voice_minutes, last_xp_at, updated_at)
  VALUES (
    p_guild_id,
    p_member_id,
    p_xp_amount,
    0,
    CASE WHEN p_increment_messages THEN 1 ELSE 0 END,
    p_voice_minutes,
    now(),
    now()
  )
  ON CONFLICT (guild_id, member_id) DO UPDATE SET
    xp = member_levels.xp + p_xp_amount,
    total_messages = member_levels.total_messages + CASE WHEN p_increment_messages THEN 1 ELSE 0 END,
    voice_minutes = member_levels.voice_minutes + p_voice_minutes,
    last_xp_at = now(),
    updated_at = now()
  RETURNING
    xp - p_xp_amount, level, xp
  INTO v_old_xp, v_old_level, v_new_xp;

  -- Calculate new level: sum of 5L² + 50L + 100 for each level
  v_level_cursor := 0;
  v_xp_needed := 0;
  WHILE v_level_cursor < 200 LOOP
    v_xp_needed := v_xp_needed + (5 * v_level_cursor * v_level_cursor + 50 * v_level_cursor + 100);
    IF v_new_xp < v_xp_needed THEN
      EXIT;
    END IF;
    v_level_cursor := v_level_cursor + 1;
  END LOOP;
  v_new_level := v_level_cursor;

  -- Update level if changed
  IF v_new_level != v_old_level THEN
    UPDATE member_levels
    SET level = v_new_level
    WHERE guild_id = p_guild_id AND member_id = p_member_id;
  END IF;

  RETURN jsonb_build_object(
    'new_xp', v_new_xp,
    'old_level', v_old_level,
    'new_level', v_new_level
  );
END;
$$;


-- ── 2. Atomic download count increment ──────────────────────
CREATE OR REPLACE FUNCTION increment_download_count(p_file_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE product_files
  SET download_count = COALESCE(download_count, 0) + 1
  WHERE id = p_file_id;
$$;


-- ── 3. Ensure increment_customer_totals exists ──────────────
-- If this already exists from a prior migration, this is a no-op
-- thanks to CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION increment_customer_totals(
  p_customer_id UUID,
  p_amount INT
)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE customers
  SET total_spent_cents = COALESCE(total_spent_cents, 0) + p_amount,
      first_purchase_at = COALESCE(first_purchase_at, now()),
      updated_at = now()
  WHERE id = p_customer_id;
$$;
