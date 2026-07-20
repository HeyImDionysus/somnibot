-- =============================================================================
-- Fix get_next_member_number: it read a non-existent relation.
--
-- The function (20260529000000_v53_postfix_audit.sql) does
-- `SELECT COALESCE(MAX(member_number),0)+1 FROM public.guild_members` — but no
-- guild_members table exists (only public.members). With `SET search_path = ''`
-- and the fully-qualified name, EVERY call raises 42P01, so the advisory-lock
-- atomic numbering path never runs. getNextMemberNumber (member-service.ts)
-- catches the error and falls back to a NON-atomic MAX-read on members, so two
-- concurrent joins compute the same N; the partial unique index
-- uniq_member_number_per_guild then rejects the loser's upsert (23505) and
-- recordMemberJoin returns null — that member's row is never created and they get
-- no member number and no welcome. Point the function at the real table.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_next_member_number(p_guild_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_next INT;
BEGIN
  -- Serialize concurrent calls for the same guild so two joins never draw the
  -- same number (the whole point of the RPC over a bare MAX-read).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_guild_id));

  SELECT COALESCE(pg_catalog.max(member_number), 0) + 1
    INTO v_next
    FROM public.members
   WHERE guild_id = p_guild_id;

  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.get_next_member_number(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_member_number(text) TO service_role;

COMMIT;
