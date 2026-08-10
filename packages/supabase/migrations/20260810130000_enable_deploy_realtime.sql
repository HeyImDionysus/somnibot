DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'guild_desired_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.guild_desired_state;
  END IF;
END
$$;
