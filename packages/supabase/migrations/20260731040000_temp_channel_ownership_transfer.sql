-- Atomically transfer a temp room's durable owner and retire the creation
-- occurrence that fenced the former owner's member+hub join.
BEGIN;

CREATE OR REPLACE FUNCTION public.transfer_temp_channel_ownership(
  p_guild_id TEXT,
  p_channel_id TEXT,
  p_new_owner_id TEXT,
  p_expected_occurrence_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  transferred BOOLEAN;
  fence_retired BOOLEAN;
BEGIN
  UPDATE public.active_temp_channels
     SET owner_id = p_new_owner_id,
         creation_occurrence_id = NULL
   WHERE guild_id = p_guild_id
     AND channel_id = p_channel_id
     AND creation_occurrence_id IS NOT DISTINCT FROM p_expected_occurrence_id;
  transferred := FOUND;

  IF NOT transferred THEN
    RETURN FALSE;
  END IF;

  IF p_expected_occurrence_id IS NOT NULL THEN
    DELETE FROM public.discord_operation_occurrences
     WHERE id = p_expected_occurrence_id
       AND guild_id = p_guild_id
       AND operation_kind = 'temp_channel';
    fence_retired := FOUND;
    IF NOT fence_retired THEN
      RAISE EXCEPTION 'Expected temp-channel creation fence was not retired';
    END IF;
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_temp_channel_ownership(TEXT, TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_temp_channel_ownership(TEXT, TEXT, TEXT, UUID)
  TO service_role;

COMMIT;
