-- =============================================================================
-- PR #408 round 22: serialized occurrence-ownership inserts + per-guild
-- runtime feature state.
--
-- 1) A slow worker could insert its active_temp_channels/tickets ownership
--    row AFTER stale recovery had read "no owner" and reclaimed the
--    occurrence — recovery then deleted a channel the durable row now owns.
--    Ownership inserts move into definer-rights functions that lock the
--    occurrence row FOR UPDATE and verify the worker's claim identity
--    (updated_at snapshot) before inserting, in one transaction. Combined
--    with the lock-then-check reclaim (20260731041000), whoever locks first
--    wins and the loser SEES it: a reclaimed occurrence makes the worker's
--    insert return nothing, and a committed insert makes the reclaim refuse.
--
-- 2) guild_runtime_features records which per-guild managers THIS boot
--    actually constructed. A feature enabled after boot has no manager until
--    restart; the dashboard read a current global heartbeat as "enabled and
--    reachable" anyway. guild-init rewrites the guild's rows each boot.
--
-- Both functions: definer-rights, empty search_path, service_role only.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.guild_runtime_features (
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, feature)
);

ALTER TABLE public.guild_runtime_features ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full_access" ON public.guild_runtime_features;
CREATE POLICY "service_role_full_access"
  ON public.guild_runtime_features
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.insert_owned_temp_channel(
  p_occurrence_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_channel_id TEXT,
  p_text_channel_id TEXT,
  p_guild_id TEXT,
  p_hub_id UUID,
  p_owner_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_occurrence UUID;
BEGIN
  SELECT occurrence.id INTO v_occurrence
    FROM public.discord_operation_occurrences AS occurrence
   WHERE occurrence.id = p_occurrence_id
     AND occurrence.guild_id = p_guild_id
     AND occurrence.status = 'claimed'
     AND occurrence.updated_at = p_expected_updated_at
   FOR UPDATE;
  IF v_occurrence IS NULL THEN
    RETURN FALSE;
  END IF;
  INSERT INTO public.active_temp_channels
    (channel_id, text_channel_id, guild_id, hub_id, owner_id, creation_occurrence_id)
  VALUES
    (p_channel_id, p_text_channel_id, p_guild_id, p_hub_id, p_owner_id, p_occurrence_id);
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.insert_owned_ticket(
  p_occurrence_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_guild_id TEXT,
  p_panel_id UUID,
  p_channel_id TEXT,
  p_ticket_number INTEGER,
  p_creator_id TEXT,
  p_type TEXT
) RETURNS SETOF public.tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_occurrence UUID;
BEGIN
  SELECT occurrence.id INTO v_occurrence
    FROM public.discord_operation_occurrences AS occurrence
   WHERE occurrence.id = p_occurrence_id
     AND occurrence.guild_id = p_guild_id
     AND occurrence.status = 'claimed'
     AND occurrence.updated_at = p_expected_updated_at
   FOR UPDATE;
  IF v_occurrence IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  INSERT INTO public.tickets
    (guild_id, panel_id, channel_id, ticket_number, creator_id, type, status, message_count, creation_occurrence_id)
  VALUES
    (p_guild_id, p_panel_id, p_channel_id, p_ticket_number, p_creator_id, p_type, 'open', 0, p_occurrence_id)
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_owned_temp_channel(UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_owned_temp_channel(UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT)
  TO service_role;
REVOKE ALL ON FUNCTION public.insert_owned_ticket(UUID, TIMESTAMPTZ, TEXT, UUID, TEXT, INTEGER, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_owned_ticket(UUID, TIMESTAMPTZ, TEXT, UUID, TEXT, INTEGER, TEXT, TEXT)
  TO service_role;
