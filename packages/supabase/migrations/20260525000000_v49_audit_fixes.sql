-- V49 Audit Fixes
-- 7 CRITICAL, 7 MEDIUM, 4 LOW findings across quests, market, adventures,
-- crafting, gathering, pets, games, and farming.

-- ════════════════════════════════════════════════════════════════════
-- C-1 / C-2: Quests — atomic claim + atomic progress increment
-- ════════════════════════════════════════════════════════════════════

-- Atomic claim: flips claimed=true for all completed-but-unclaimed quests
-- belonging to a user. Returns only the rows it actually flipped (prevents
-- double-claim from concurrent calls).
CREATE OR REPLACE FUNCTION economy_quest_atomic_claim(
  p_guild_id TEXT,
  p_user_id  TEXT
)
RETURNS TABLE(
  id           uuid,
  template_id  uuid,
  reward_currency bigint,
  reward_xp    integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE public.economy_quest_progress qp
    SET    claimed = true
    WHERE  qp.guild_id  = p_guild_id
      AND  qp.user_id   = p_user_id
      AND  qp.completed  = true
      AND  qp.claimed    = false
    RETURNING qp.id, qp.template_id
  )
  SELECT c.id,
         c.template_id,
         COALESCE(t.reward_currency, 0)::bigint AS reward_currency,
         COALESCE(t.reward_xp, 0)::integer       AS reward_xp
  FROM   claimed c
  JOIN   public.economy_quest_templates t ON t.id = c.template_id;
END;
$$;

REVOKE ALL ON FUNCTION economy_quest_atomic_claim(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION economy_quest_atomic_claim(TEXT, TEXT) TO service_role;

-- Atomic progress increment: increments progress, auto-sets completed when
-- target_count is reached. Returns the updated row.  Prevents two concurrent
-- actions from both reading the same stale progress.
CREATE OR REPLACE FUNCTION economy_quest_increment_progress(
  p_id     UUID,
  p_amount INTEGER DEFAULT 1
)
RETURNS TABLE(
  id           uuid,
  new_progress integer,
  completed    boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target integer;
BEGIN
  -- Read target_count from the template
  SELECT t.target_count INTO v_target
  FROM   public.economy_quest_progress qp
  JOIN   public.economy_quest_templates t ON t.id = qp.template_id
  WHERE  qp.id = p_id;

  IF v_target IS NULL THEN
    RETURN;  -- quest not found
  END IF;

  RETURN QUERY
  UPDATE public.economy_quest_progress qp
  SET    progress     = LEAST(qp.progress + p_amount, v_target),
         completed    = (LEAST(qp.progress + p_amount, v_target) >= v_target),
         completed_at = CASE
                          WHEN LEAST(qp.progress + p_amount, v_target) >= v_target
                               AND qp.completed = false
                          THEN now()
                          ELSE qp.completed_at
                        END
  WHERE  qp.id        = p_id
    AND  qp.completed  = false
  RETURNING qp.id,
            qp.progress   AS new_progress,
            qp.completed;
END;
$$;

REVOKE ALL ON FUNCTION economy_quest_increment_progress(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION economy_quest_increment_progress(UUID, INTEGER) TO service_role;


-- ════════════════════════════════════════════════════════════════════
-- C-3: Market — atomic cancel listing
-- ════════════════════════════════════════════════════════════════════

-- Atomically flips status to 'cancelled' only if still 'active'.
-- Returns the listing row so the caller can refund items only once.
CREATE OR REPLACE FUNCTION economy_market_atomic_cancel(
  p_listing_id UUID,
  p_seller_id  TEXT
)
RETURNS TABLE(
  id        uuid,
  item_id   uuid,
  item_name text,
  remaining integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.economy_market_listings ml
  SET    status     = 'cancelled',
         updated_at = now()
  WHERE  ml.id        = p_listing_id
    AND  ml.seller_id = p_seller_id
    AND  ml.status    = 'active'
  RETURNING ml.id, ml.item_id, ml.item_name, ml.remaining;
END;
$$;

REVOKE ALL ON FUNCTION economy_market_atomic_cancel(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION economy_market_atomic_cancel(UUID, TEXT) TO service_role;


-- ════════════════════════════════════════════════════════════════════
-- C-6: Adventures — unique partial index prevents double active session
-- ════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_adventure_session_per_user
  ON economy_adventure_sessions (guild_id, user_id)
  WHERE status = 'active';


-- ════════════════════════════════════════════════════════════════════
-- M-4: Games — daily-loss TOCTOU fixed via in-process per-user game
-- lock (Set<string> in GamesManager).  No DB-level change needed.
-- ════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════
-- M-7: Pets — atomic prestige
-- ════════════════════════════════════════════════════════════════════

-- Only prestiges if pet.level >= p_max_level. Returns the updated row.
-- Prevents two concurrent prestige calls both applying stat bonuses.
CREATE OR REPLACE FUNCTION economy_pet_atomic_prestige(
  p_guild_id  TEXT,
  p_user_id   TEXT,
  p_max_level INTEGER DEFAULT 50
)
RETURNS TABLE(
  success      boolean,
  new_prestige integer,
  new_attack   integer,
  new_defense  integer,
  new_speed    integer,
  new_health   integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.economy_pets p
  SET    prestige   = p.prestige + 1,
         level      = 1,
         xp         = 0,
         attack     = p.attack + 1,
         defense    = p.defense + 1,
         speed      = p.speed + 1,
         health     = p.health + 2,
         updated_at = now()
  WHERE  p.guild_id = p_guild_id
    AND  p.user_id  = p_user_id
    AND  p.level    >= p_max_level
  RETURNING
    true             AS success,
    p.prestige       AS new_prestige,
    p.attack         AS new_attack,
    p.defense        AS new_defense,
    p.speed          AS new_speed,
    p.health         AS new_health;
END;
$$;

REVOKE ALL ON FUNCTION economy_pet_atomic_prestige(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION economy_pet_atomic_prestige(TEXT, TEXT, INTEGER) TO service_role;


-- ════════════════════════════════════════════════════════════════════
-- M-5: Quests — add unique constraint for idempotent assignment
-- ════════════════════════════════════════════════════════════════════

-- Prevent duplicate quest assignments: same user+template on the same day
-- (daily) or same ISO week (weekly). We use (guild_id, user_id, template_id,
-- assigned_date) where assigned_date is the date portion of assigned_at.
-- This allows ON CONFLICT DO NOTHING during concurrent assignment.
DO $$
BEGIN
  -- Add a computed column for the assignment date if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'economy_quest_progress' AND column_name = 'assigned_date'
  ) THEN
    ALTER TABLE economy_quest_progress
      ADD COLUMN assigned_date date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_quest_assignment_per_user_template_date
  ON economy_quest_progress (guild_id, user_id, template_id, assigned_date);


-- ════════════════════════════════════════════════════════════════════
-- Grant summary — register new RPCs with PostgREST
-- ════════════════════════════════════════════════════════════════════
-- New RPCs: 4  (economy_quest_atomic_claim, economy_quest_increment_progress,
--               economy_market_atomic_cancel, economy_pet_atomic_prestige)
-- New indexes: 2  (uniq_active_adventure_session_per_user,
--                   uniq_quest_assignment_per_user_template_date)
-- New columns: 1  (economy_quest_progress.assigned_date)
