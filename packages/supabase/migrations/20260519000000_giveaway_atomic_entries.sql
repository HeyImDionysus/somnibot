-- Atomic giveaway entry operations to prevent race conditions
-- When two users click the enter button simultaneously, array read-modify-write
-- can cause one entry to be lost. These RPCs use array_append/array_remove
-- which are atomic at the database level.

CREATE OR REPLACE FUNCTION giveaway_add_entry(p_giveaway_id UUID, p_user_id TEXT)
RETURNS TABLE(entries TEXT[]) AS $$
BEGIN
  RETURN QUERY
  UPDATE giveaways
  SET entries = array_append(giveaways.entries, p_user_id)
  WHERE id = p_giveaway_id
    AND NOT (p_user_id = ANY(giveaways.entries))
  RETURNING giveaways.entries;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION giveaway_remove_entry(p_giveaway_id UUID, p_user_id TEXT)
RETURNS TABLE(entries TEXT[]) AS $$
BEGIN
  RETURN QUERY
  UPDATE giveaways
  SET entries = array_remove(giveaways.entries, p_user_id)
  WHERE id = p_giveaway_id
  RETURNING giveaways.entries;
END;
$$ LANGUAGE plpgsql;
