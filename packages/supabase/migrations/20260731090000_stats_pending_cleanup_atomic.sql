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

-- ── Round 15 additions ──────────────────────────────────────────────────────

-- One ENABLED velocity rule per guild. The bot's loadFraudThresholds reduces
-- every enabled velocity_limit row to a single threshold/window pair, so a
-- second enabled row silently picked an arbitrary winner while the dashboard
-- showed all of them active. Keep the newest enabled row, disable the rest,
-- then enforce at the database so racing creates cannot reintroduce it.
UPDATE fraud_rules AS rule
   SET enabled = false
  FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY guild_id
             ORDER BY created_at DESC, id DESC
           ) AS rn
      FROM fraud_rules
     WHERE rule_type = 'velocity_limit'
       AND enabled = true
  ) ranked
 WHERE rule.id = ranked.id
   AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_fraud_rules_enabled_velocity
  ON fraud_rules (guild_id)
  WHERE rule_type = 'velocity_limit' AND enabled = true;

-- ticket_create_failed alerts flooded one row per member click on a broken
-- panel. Dedupe unresolved rows per (guild, panel) — the per-attempt audit
-- events already preserve each failure — following the round-11 pattern
-- (keep newest, NULLS NOT DISTINCT for keyless twins).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY guild_id, (metadata->>'panel_id')
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM alerts
  WHERE alert_type = 'ticket_create_failed'
    AND resolved = false
)
UPDATE alerts a
   SET resolved    = true,
       resolved_at = now(),
       updated_at  = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_ticket_create_failed
  ON alerts (guild_id, (metadata->>'panel_id')) NULLS NOT DISTINCT
  WHERE alert_type = 'ticket_create_failed' AND resolved = false;
