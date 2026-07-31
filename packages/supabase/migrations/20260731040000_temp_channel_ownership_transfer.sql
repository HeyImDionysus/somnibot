-- Atomically transfer a temp room's durable owner and retire the creation
-- occurrence that fenced the former owner's member+hub join.
BEGIN;

-- Remove the pre-owner-CAS signature when this migration is repaired and
-- reapplied in a development stack.
DROP FUNCTION IF EXISTS public.transfer_temp_channel_ownership(TEXT, TEXT, TEXT, UUID);

CREATE OR REPLACE FUNCTION public.transfer_temp_channel_ownership(
  p_guild_id TEXT,
  p_channel_id TEXT,
  p_new_owner_id TEXT,
  p_expected_owner_id TEXT,
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
     AND owner_id = p_expected_owner_id
     AND (
       creation_occurrence_id = p_expected_occurrence_id
       OR (creation_occurrence_id IS NULL AND p_expected_occurrence_id IS NULL)
     );
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

CREATE OR REPLACE FUNCTION public.retire_temp_channel(
  p_guild_id TEXT,
  p_channel_id TEXT,
  p_expected_occurrence_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  active_retired BOOLEAN;
  fence_retired BOOLEAN;
BEGIN
  DELETE FROM public.active_temp_channels
   WHERE guild_id = p_guild_id
     AND channel_id = p_channel_id
     AND (
       creation_occurrence_id = p_expected_occurrence_id
       OR (creation_occurrence_id IS NULL AND p_expected_occurrence_id IS NULL)
     );
  active_retired := FOUND;

  IF NOT active_retired THEN
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

REVOKE ALL ON FUNCTION public.transfer_temp_channel_ownership(TEXT, TEXT, TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_temp_channel_ownership(TEXT, TEXT, TEXT, TEXT, UUID)
  TO service_role;

REVOKE ALL ON FUNCTION public.retire_temp_channel(TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retire_temp_channel(TEXT, TEXT, UUID)
  TO service_role;

COMMIT;
