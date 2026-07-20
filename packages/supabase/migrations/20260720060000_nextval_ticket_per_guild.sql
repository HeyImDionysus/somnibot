-- =============================================================================
-- Make ticket numbering per-guild.
--
-- nextval_ticket() computed MAX(ticket_number)+1 over the ENTIRE ticket_transcripts
-- table — a single GLOBAL counter shared by every guild. So a second guild's first
-- ticket was numbered from the first guild's transcripts (e.g. guild B's "#1"
-- became "#48" because guild A had 47 closed tickets): the catalog's "each guild's
-- ticket numbering advances independently" was not met, and numbers leaked one
-- guild's activity volume to another. It also read ONLY closed transcripts, so a
-- guild with open-but-not-yet-closed tickets could re-issue a live number.
--
-- Replace it with a per-guild counter that considers BOTH open tickets and closed
-- transcripts for the given guild. Existing numbers were globally unique (hence
-- per-guild unique too), and a per-guild MAX+1 is strictly greater than every
-- existing number for that guild, so no historical row collides.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.nextval_ticket();

CREATE OR REPLACE FUNCTION public.nextval_ticket(p_guild_id text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_val BIGINT;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'nextval_ticket: p_guild_id is required';
  END IF;

  SELECT COALESCE(pg_catalog.max(n), 0) + 1
    INTO v_val
    FROM (
      SELECT pg_catalog.max(ticket_number) AS n
        FROM public.tickets WHERE guild_id = p_guild_id
      UNION ALL
      SELECT pg_catalog.max(ticket_number) AS n
        FROM public.ticket_transcripts WHERE guild_id = p_guild_id
    ) AS m;

  RETURN v_val;
END;
$$;

REVOKE ALL ON FUNCTION public.nextval_ticket(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nextval_ticket(text) TO service_role;

COMMIT;
