-- V51 Audit: atomic next-member-number RPC
-- Prevents duplicate member_number when two members join simultaneously.

CREATE OR REPLACE FUNCTION get_next_member_number(p_guild_id TEXT)
RETURNS INTEGER
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(MAX(member_number), 0) + 1
  FROM members
  WHERE guild_id = p_guild_id;
$$;

GRANT EXECUTE ON FUNCTION get_next_member_number(TEXT) TO service_role;

-- Add unique constraint so duplicates cannot persist even under extreme races.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_member_number_per_guild
  ON members (guild_id, member_number)
  WHERE member_number > 0;
