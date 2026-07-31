-- =============================================================================
-- PR #408 round 13: atomic append/remove for stats abort-survivor pointers.
--
-- pending_cleanup_channel_ids was maintained by application-side
-- read-merge-write. Two processes losing the same identity race (or an
-- append racing the reconciler's trim) could each read the same array and
-- overwrite it with only their own view — the last write dropped the other
-- duplicate's SOLE durable pointer, so that channel was never reconciled
-- after a restart. Both mutations move into single-statement SQL:
--
--   append_stats_pending_cleanup  — idempotent append of one channel id
--   remove_stats_pending_cleanup  — removes exactly the RESOLVED ids,
--                                    preserving concurrent appends
--
-- Both return TRUE when the config row matched (the caller's read-back) and
-- NULL row-absence otherwise. Definer-rights with an empty search_path,
-- service_role only — the same conventions as
-- reclaim_stale_automation_execution (20260731050000).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.append_stats_pending_cleanup(
  p_config_id UUID,
  p_channel_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.stats_channels
     SET pending_cleanup_channel_ids =
       CASE
         WHEN pending_cleanup_channel_ids @> pg_catalog.to_jsonb(p_channel_id)
           THEN pending_cleanup_channel_ids
         ELSE pending_cleanup_channel_ids || pg_catalog.to_jsonb(p_channel_id)
       END
   WHERE id = p_config_id
  RETURNING TRUE;
$$;

CREATE OR REPLACE FUNCTION public.remove_stats_pending_cleanup(
  p_config_id UUID,
  p_channel_ids TEXT[]
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.stats_channels
     SET pending_cleanup_channel_ids = (
       SELECT COALESCE(pg_catalog.jsonb_agg(entries.elem), '[]'::jsonb)
         FROM pg_catalog.jsonb_array_elements_text(pending_cleanup_channel_ids)
              AS entries(elem)
        WHERE entries.elem <> ALL (p_channel_ids)
     )
   WHERE id = p_config_id
  RETURNING TRUE;
$$;

REVOKE ALL ON FUNCTION public.append_stats_pending_cleanup(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_stats_pending_cleanup(UUID, TEXT)
  TO service_role;
REVOKE ALL ON FUNCTION public.remove_stats_pending_cleanup(UUID, TEXT[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_stats_pending_cleanup(UUID, TEXT[])
  TO service_role;
