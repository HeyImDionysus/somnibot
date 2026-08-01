-- =============================================================================
-- PR #408 round 11: durable dedupe for the two owner-alert types this PR
-- introduced, and durable abort-survivor state for stats counter channels.
--
-- 1) message_log_delivery_failed / stats_channel_update_failed alerts were
--    deduped only by process-local sets. Two bot processes overlapping during
--    a rolling deployment both start with empty sets, so the same failure
--    produced duplicate alert rows and duplicate owner pings. Both raisers
--    already branch on insert error 23505 (raiseOwnerAlert reports it as
--    dedupe success) — the partial unique indexes enforcing that contract
--    were missing. Same pattern as
--    20260709170000_fraud_alert_dedupe_unique_index.sql.
--
--    message_log_delivery_failed is one alert per guild. Stats counters are
--    deduped per COUNTER: multiple degraded counters in one guild must stay
--    separately visible, so the index keys on the metadata stats_channel_id
--    the raiser always writes.
--
-- 2) stats_channels.pending_cleanup_channel_ids: when Discord channel
--    creation succeeds but the channel_id identity write fails and the
--    compensating delete also fails, the surviving channel id was only
--    logged. The column is the durable pointer the reconciler recovers from
--    (adopt as the live counter, else delete) instead of leaking one channel
--    per failed interval.
-- =============================================================================

-- Defensive cleanup so the unique indexes can build even if duplicate
-- unresolved rows already exist: keep the newest, resolve the rest. (Both
-- alert types first ship with PR #408, so in practice these are no-ops.)
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY guild_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM alerts
  WHERE alert_type = 'message_log_delivery_failed'
    AND resolved = false
)
UPDATE alerts a
   SET resolved    = true,
       resolved_at = now(),
       updated_at  = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_message_log_delivery_failed
  ON alerts (guild_id)
  WHERE alert_type = 'message_log_delivery_failed' AND resolved = false;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY guild_id, (metadata->>'stats_channel_id')
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM alerts
  WHERE alert_type = 'stats_channel_update_failed'
    AND resolved = false
)
UPDATE alerts a
   SET resolved    = true,
       resolved_at = now(),
       updated_at  = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

-- NULLS NOT DISTINCT: a malformed row missing the metadata key must still
-- dedupe against its twin instead of multiplying.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_stats_channel_update_failed
  ON alerts (guild_id, (metadata->>'stats_channel_id')) NULLS NOT DISTINCT
  WHERE alert_type = 'stats_channel_update_failed' AND resolved = false;

ALTER TABLE public.stats_channels
  ADD COLUMN IF NOT EXISTS pending_cleanup_channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.stats_channels.pending_cleanup_channel_ids IS
  'Discord channel ids created for this counter whose identity write failed; '
  'durable pointers consumed by the bot''s recovery scan (adopt or delete).';
