-- =============================================================================
-- Fix: concurrent critical fraud bursts open DUPLICATE fraud_auto incidents.
--
-- checkCriticalThreshold (packages/bot/src/services/fraud-detection.ts) opens an
-- auto-incident via check-then-insert: SELECT any open fraud_auto incident, and
-- if none, INSERT. There is NO row lock, no upsert, and NO DB uniqueness on
-- incidents beyond incidents_pkey(id) — the only indexes are the non-unique
-- idx_incidents_guild / idx_incidents_guild_status. Two concurrent critical
-- bursts both read zero open incidents in the check window and both INSERT,
-- producing two fraud_auto incidents for one burst (and, combined with the
-- restored atomic incident numbering, the owner is paged twice).
--
-- Fence with two partial unique indexes:
--   (a) at most one incident row per (guild, incident_number)
--   (b) at most one LIVE (non-resolved) fraud_auto incident per guild
-- The product code (fraud-detection.ts) tolerates the resulting 23505 as
-- "an incident already exists for this burst" and no-ops the losing racer.
-- =============================================================================

BEGIN;

-- Collapse any pre-existing duplicate LIVE fraud_auto incidents so the partial
-- unique index (b) can be built: keep the earliest per guild, resolve the rest.
UPDATE public.incidents f
   SET status = 'resolved',
       resolved_at = pg_catalog.now(),
       updated_at = pg_catalog.now()
 WHERE f.source = 'fraud_auto'
   AND f.status <> 'resolved'
   AND EXISTS (
     SELECT 1 FROM public.incidents g
      WHERE g.guild_id = f.guild_id
        AND g.source = 'fraud_auto'
        AND g.status <> 'resolved'
        AND (g.created_at < f.created_at
             OR (g.created_at = f.created_at AND g.id < f.id))
   );

-- (a) One incident row per (guild, incident_number). NULL incident_number rows
--     are ignored (NULLs are distinct in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_incident_guild_number
  ON public.incidents (guild_id, incident_number)
  WHERE incident_number IS NOT NULL;

-- (b) At most one live auto-incident per guild — dedupes the fraud burst.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_fraud_auto_incident
  ON public.incidents (guild_id)
  WHERE source = 'fraud_auto' AND status <> 'resolved';

COMMIT;
