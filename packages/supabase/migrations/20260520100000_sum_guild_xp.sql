-- ============================================================
-- Audit V7: Add missing sum_guild_xp RPC used by stats-manager.
-- Without this, the "Total XP Earned" stats channel always shows 0.
-- ============================================================

CREATE OR REPLACE FUNCTION sum_guild_xp(g_id TEXT)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(xp)::BIGINT, 0)
  FROM member_levels
  WHERE guild_id = g_id;
$$;
