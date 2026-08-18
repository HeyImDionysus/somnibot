-- Fail closed before adding the uniqueness backstop. Historical transcript
-- rows are release evidence and must never be silently deleted or overwritten.
DO $$
DECLARE
  duplicate_summary TEXT;
BEGIN
  SELECT string_agg(
    format(
      'guild_id=%s ticket_id=%s count=%s',
      quote_nullable(guild_id),
      quote_nullable(ticket_id),
      duplicate_count
    ),
    '; ' ORDER BY guild_id NULLS FIRST, ticket_id NULLS FIRST
  )
  INTO duplicate_summary
  FROM (
    SELECT guild_id, ticket_id, count(*) AS duplicate_count
    FROM public.ticket_transcripts
    GROUP BY guild_id, ticket_id
    HAVING count(*) > 1
  ) AS duplicate_rows;

  IF duplicate_summary IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'ticket_transcripts duplicate preflight failed',
      DETAIL = duplicate_summary,
      HINT = 'Resolve the listed duplicate rows before retrying; this migration deleted no rows.';
  END IF;
END
$$;

ALTER TABLE public.ticket_transcripts
  ADD CONSTRAINT ticket_transcripts_guild_ticket_key
  UNIQUE NULLS NOT DISTINCT (guild_id, ticket_id);
