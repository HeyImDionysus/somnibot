-- V48 comprehensive audit fixes.
--
-- 1. Atomic claim for bot_action_queue (prevents double-processing on
--    Realtime + pending-sweep races; surfaces stuck rows).
-- 2. Stale claim recovery RPC for bot_action_queue (DLQ-equivalent — flips
--    rows stuck in 'processing' for more than the timeout back to 'pending').
-- 3. Partial unique index for active heists (prevents concurrent
--    /heist start from creating two heists for the same guild).
-- 4. Atomic claim for lottery drawings (prevents double-drawing and
--    silent payout-on-failure when status was already flipped).

-- ─── 1. Atomic claim for bot_action_queue ─────────────────────
-- Flips status='pending' → 'processing' iff the row is still pending.
-- Returns the row exactly when this caller successfully claimed it; no
-- rows means another worker (or a duplicate Realtime delivery) already
-- claimed it and we must NOT process it again.
CREATE OR REPLACE FUNCTION bot_action_queue_claim(
  p_action_id UUID
)
RETURNS TABLE (
  id          UUID,
  guild_id    TEXT,
  action      TEXT,
  payload     JSONB,
  status      TEXT,
  retry_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.bot_action_queue q
     SET status      = 'processing',
         started_at  = now()
   WHERE q.id = p_action_id
     AND q.status = 'pending'
   RETURNING q.id, q.guild_id, q.action, q.payload, q.status, q.retry_count;
END;
$$;

REVOKE ALL ON FUNCTION bot_action_queue_claim(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bot_action_queue_claim(UUID) TO service_role;


-- ─── 2. Stale 'processing' recovery (DLQ-equivalent) ──────────
-- Picks every action stuck in 'processing' for longer than
-- p_timeout_seconds and either (a) flips it back to 'pending' if the
-- retry budget is not exhausted so the worker can pick it up again,
-- or (b) flips it to 'failed' with a stale-recovery error message.
-- Returns the rows that were re-queued so the bot can re-fan-out
-- Realtime processing immediately.
CREATE OR REPLACE FUNCTION bot_action_queue_recover_stale(
  p_guild_id        TEXT,
  p_timeout_seconds INTEGER,
  p_max_retries     INTEGER DEFAULT 5
)
RETURNS TABLE (
  id          UUID,
  action      TEXT,
  was_failed  BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Step 1: fail the ones over the retry budget.
  RETURN QUERY
  UPDATE public.bot_action_queue q
     SET status        = 'failed',
         completed_at  = now(),
         error_message = COALESCE(q.error_message, '') ||
                         CASE WHEN q.error_message IS NULL OR q.error_message = ''
                              THEN 'Stale processing recovery: retry budget exhausted'
                              ELSE ' | Stale processing recovery: retry budget exhausted'
                         END
   WHERE q.guild_id = p_guild_id
     AND q.status = 'processing'
     AND q.started_at < now() - (p_timeout_seconds || ' seconds')::INTERVAL
     AND COALESCE(q.retry_count, 0) >= p_max_retries
   RETURNING q.id, q.action, true AS was_failed;

  -- Step 2: re-queue the ones that still have retries left.
  RETURN QUERY
  UPDATE public.bot_action_queue q
     SET status      = 'pending',
         started_at  = NULL,
         retry_count = COALESCE(q.retry_count, 0) + 1
   WHERE q.guild_id = p_guild_id
     AND q.status = 'processing'
     AND q.started_at < now() - (p_timeout_seconds || ' seconds')::INTERVAL
     AND COALESCE(q.retry_count, 0) < p_max_retries
   RETURNING q.id, q.action, false AS was_failed;
END;
$$;

REVOKE ALL ON FUNCTION bot_action_queue_recover_stale(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bot_action_queue_recover_stale(TEXT, INTEGER, INTEGER) TO service_role;

-- bot_action_queue.retry_count is optional in V47; add it if missing.
ALTER TABLE bot_action_queue
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;


-- ─── 3. Atomic claim for lottery drawings ─────────────────────
-- Returns the drawing exactly once. The bot must payout iff this returns
-- a row; otherwise another scheduled tick (or a manual /lottery draw)
-- already paid the same winner.
CREATE OR REPLACE FUNCTION lottery_claim_drawing(
  p_drawing_id UUID
)
RETURNS TABLE (
  id       UUID,
  guild_id TEXT,
  jackpot  INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.economy_lottery_drawings d
     SET status   = 'drawing'  -- intermediate state; only winner finalisation flips to 'drawn'
   WHERE d.id = p_drawing_id
     AND d.status = 'active'
   RETURNING d.id, d.guild_id, d.jackpot;
END;
$$;

REVOKE ALL ON FUNCTION lottery_claim_drawing(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION lottery_claim_drawing(UUID) TO service_role;


-- ─── 4. Partial unique index for active heists ───────────────
-- Guarantees at most one 'recruiting' OR 'in_progress' heist per guild.
-- A concurrent /heist start race will see the second INSERT fail with
-- a 23505 unique-violation and the bot will refund the entry fee.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_heist_per_guild
  ON economy_heists (guild_id)
  WHERE status IN ('recruiting', 'in_progress');
