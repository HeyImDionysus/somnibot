-- =============================================================================
-- Make ticket numbering atomic + collision-proof (per-guild).
--
-- 20260720060000_nextval_ticket_per_guild.sql already scoped nextval_ticket to a
-- single guild, but it still computed MAX(ticket_number)+1 over tickets +
-- ticket_transcripts. That read is NOT atomic and there is NO unique backstop on
-- tickets(guild_id, ticket_number): two tickets opened in the same guild before
-- either row is committed both read the same MAX and get the SAME ticket_number,
-- and nothing rejects the duplicate.
--
-- Replace the MAX+1 read with a durable per-guild counter table and an atomic
-- INSERT ... ON CONFLICT DO UPDATE draw, and add a unique index so a duplicate
-- number can never persist. The counter is seeded from the current per-guild max
-- across BOTH open tickets and closed transcripts so live numbers never regress.
-- =============================================================================

BEGIN;

-- Durable per-guild counter.
CREATE TABLE IF NOT EXISTS public.guild_ticket_counters (
  guild_id    text PRIMARY KEY,
  last_number bigint NOT NULL DEFAULT 0
);

-- Seed from the highest existing number per guild (open tickets + transcripts).
INSERT INTO public.guild_ticket_counters (guild_id, last_number)
SELECT gid, pg_catalog.max(n)
FROM (
  SELECT guild_id AS gid, ticket_number AS n FROM public.tickets
  UNION ALL
  SELECT guild_id AS gid, ticket_number AS n FROM public.ticket_transcripts
) s
WHERE gid IS NOT NULL AND n IS NOT NULL
GROUP BY gid
ON CONFLICT (guild_id)
  DO UPDATE SET last_number = GREATEST(
    public.guild_ticket_counters.last_number, EXCLUDED.last_number);

-- Atomic per-guild draw.
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

  INSERT INTO public.guild_ticket_counters (guild_id, last_number)
  VALUES (p_guild_id, 1)
  ON CONFLICT (guild_id)
    DO UPDATE SET last_number = public.guild_ticket_counters.last_number + 1
  RETURNING last_number INTO v_val;

  RETURN v_val;
END;
$$;

REVOKE ALL ON FUNCTION public.nextval_ticket(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nextval_ticket(text) TO service_role;

-- Uniqueness backstop: a duplicate (guild_id, ticket_number) can never persist.
CREATE UNIQUE INDEX IF NOT EXISTS tickets_guild_number_uniq
  ON public.tickets (guild_id, ticket_number);

COMMIT;
