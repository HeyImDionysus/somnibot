-- V47 comprehensive audit fixes.
-- 1. Atomic prediction resolve (status guard + total_pool snapshot)
-- 2. Persistent daily-loss tracking for games (replaces in-memory Map)

-- ─── 1. Atomic prediction resolve ───────────────────────────────
-- Locks the prediction row, flips status to 'resolved' only if it is still
-- 'open' or 'locked', and returns the locked total_pool snapshot. Returning
-- NULL signals "already resolved / cancelled / missing" so the caller MUST
-- treat that as a no-op and not pay anyone.
CREATE OR REPLACE FUNCTION predictions_resolve_atomic(
  p_prediction_id UUID,
  p_winning_option_id UUID
)
RETURNS TABLE (
  total_pool INTEGER,
  guild_id   TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total INTEGER;
  v_guild TEXT;
  v_status TEXT;
BEGIN
  SELECT p.total_pool, p.guild_id, p.status
    INTO v_total, v_guild, v_status
  FROM public.predictions p
  WHERE p.id = p_prediction_id
  FOR UPDATE;

  IF NOT FOUND OR v_status NOT IN ('open', 'locked') THEN
    RETURN;  -- nothing to return; caller must skip payouts
  END IF;

  UPDATE public.predictions
     SET status            = 'resolved',
         winning_option_id = p_winning_option_id,
         resolved_at       = now()
   WHERE id = p_prediction_id;

  total_pool := v_total;
  guild_id   := v_guild;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION predictions_resolve_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION predictions_resolve_atomic(UUID, UUID) TO service_role;

-- ─── 2. Persistent daily-loss tracking ─────────────────────────
CREATE TABLE IF NOT EXISTS economy_daily_losses (
  guild_id    TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  loss_date   DATE    NOT NULL,
  amount      INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id, loss_date)
);

CREATE INDEX IF NOT EXISTS idx_economy_daily_losses_date
  ON economy_daily_losses(loss_date);

ALTER TABLE economy_daily_losses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "economy_daily_losses_access" ON economy_daily_losses
  FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT ON economy_daily_losses TO authenticated;

-- Atomic increment + return the new total for "today" in UTC.
CREATE OR REPLACE FUNCTION economy_increment_daily_loss(
  p_guild_id TEXT,
  p_user_id  TEXT,
  p_amount   INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    SELECT COALESCE(amount, 0) INTO v_total
    FROM public.economy_daily_losses
    WHERE guild_id = p_guild_id
      AND user_id  = p_user_id
      AND loss_date = (now() AT TIME ZONE 'UTC')::date;
    RETURN COALESCE(v_total, 0);
  END IF;

  INSERT INTO public.economy_daily_losses (guild_id, user_id, loss_date, amount, updated_at)
  VALUES (p_guild_id, p_user_id, (now() AT TIME ZONE 'UTC')::date, p_amount, now())
  ON CONFLICT (guild_id, user_id, loss_date)
  DO UPDATE SET amount      = public.economy_daily_losses.amount + EXCLUDED.amount,
                updated_at  = now()
  RETURNING amount INTO v_total;

  RETURN COALESCE(v_total, p_amount);
END;
$$;

REVOKE ALL ON FUNCTION economy_increment_daily_loss(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION economy_increment_daily_loss(TEXT, TEXT, INTEGER) TO service_role;
