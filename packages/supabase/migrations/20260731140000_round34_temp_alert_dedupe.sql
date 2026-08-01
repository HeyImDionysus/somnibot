-- Round 34: one unresolved creation-failure alert per hub.
--
-- A hub that stays broken (Manage Channels revoked, category deleted) fires
-- temp_channel_creation_failed on EVERY member join. raiseOwnerAlert
-- throttles only the Discord ping, so a busy hub flooded the alerts table
-- and dashboard with duplicate unresolved rows. Same discipline as the
-- ticket/panel and stats-channel alert indexes: the insert's 23505 becomes
-- the dedupe signal the caller already tolerates.

BEGIN;

-- Collapse any existing duplicates first (keep the newest per hub).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY guild_id, (metadata->>'hub_id')
           ORDER BY created_at DESC, id DESC
         ) AS rn
    FROM alerts
   WHERE alert_type = 'temp_channel_creation_failed'
     AND resolved = false
)
UPDATE alerts a
   SET resolved = true,
       resolved_at = now(),
       updated_at  = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_temp_channel_creation_failed
  ON alerts (guild_id, (metadata->>'hub_id')) NULLS NOT DISTINCT
  WHERE alert_type = 'temp_channel_creation_failed' AND resolved = false;

COMMIT;
