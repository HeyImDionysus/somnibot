BEGIN;

ALTER TABLE public.discord_operation_occurrences
  DROP CONSTRAINT IF EXISTS discord_operation_occurrences_operation_kind_check;

ALTER TABLE public.discord_operation_occurrences
  ADD CONSTRAINT discord_operation_occurrences_operation_kind_check
  CHECK (
    operation_kind IN ('scheduled_message', 'temp_channel', 'ticket', 'music_interaction')
  ) NOT VALID;

ALTER TABLE public.discord_operation_occurrences
  VALIDATE CONSTRAINT discord_operation_occurrences_operation_kind_check;

CREATE OR REPLACE FUNCTION public.begin_music_interaction_mutation(
  p_occurrence_id UUID,
  p_guild_id TEXT,
  p_occurrence_key TEXT,
  p_action TEXT,
  p_user_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_occurrence_id IS NULL
     OR p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_occurrence_key IS NULL OR pg_catalog.btrim(p_occurrence_key) = ''
     OR p_action IS NULL OR pg_catalog.btrim(p_action) = ''
     OR p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'begin_music_interaction_mutation: all claim fields are required';
  END IF;

  UPDATE public.discord_operation_occurrences
     SET result = COALESCE(result, '{}'::jsonb) || pg_catalog.jsonb_build_object(
       'state', 'in_progress',
       'action', p_action,
       'userId', p_user_id
     )
   WHERE id = p_occurrence_id
     AND guild_id = p_guild_id
     AND operation_kind = 'music_interaction'
     AND occurrence_key = p_occurrence_key
     AND status = 'claimed'
     AND result ->> 'state' = 'claimed'
     AND result ->> 'action' = p_action
     AND result ->> 'userId' = p_user_id;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_music_interaction_mutation(UUID, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_music_interaction_mutation(UUID, TEXT, TEXT, TEXT, TEXT)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
