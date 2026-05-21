-- V40 Audit Fixes
-- 1. Atomic profile view increment RPC

CREATE OR REPLACE FUNCTION increment_profile_views(p_guild_id TEXT, p_user_id TEXT)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE economy_profiles
  SET profile_views = profile_views + 1
  WHERE guild_id = p_guild_id AND user_id = p_user_id;
$$;
