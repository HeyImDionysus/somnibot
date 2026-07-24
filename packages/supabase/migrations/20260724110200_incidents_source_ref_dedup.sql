-- =============================================================================
-- One critical alert = at most one linked incident (dedup per source reference).
--
-- Catalog control `auto-create-from-critical-alerts` + permission
-- system-open-incident promise: a critical DIAGNOSTICS alert "automatically
-- opens a LINKED incident with its source reference set to the alert",
-- "deduplicated per alert reference". The incidents table already carries a
-- source_ref_id TEXT column (20260518200000_phase_d_sota), but NOTHING enforced
-- one-incident-per-reference: two concurrent evaluations of the same critical
-- alert (across shards/processes, where the in-memory guard is empty) could both
-- find no linked incident and both INSERT, double-paging the owner for one alert.
--
-- The AlertManager health-alert->incident path (packages/bot/src/features/audit/
-- alert-manager.ts) now stamps source='health_alert', source_ref_id=<alert.id>.
-- This partial unique index is the real fence: at most one incident row per
-- (guild_id, source_ref_id) when source_ref_id is set. The product code tolerates
-- the resulting 23505 as "an incident already exists for this alert" and no-ops
-- the losing racer (no duplicate incident, no double page). NULL source_ref_id
-- rows (manual incidents) are ignored — NULLs are distinct in a unique index.
-- =============================================================================
BEGIN;

-- Collapse any pre-existing duplicate incidents that share a source reference so
-- the partial unique index can be built: keep the earliest per (guild,
-- source_ref_id), resolve the rest.
UPDATE public.incidents f
   SET status = 'resolved',
       resolved_at = pg_catalog.now(),
       updated_at = pg_catalog.now()
 WHERE f.source_ref_id IS NOT NULL
   AND f.status <> 'resolved'
   AND EXISTS (
     SELECT 1 FROM public.incidents g
      WHERE g.guild_id = f.guild_id
        AND g.source_ref_id = f.source_ref_id
        AND g.id <> f.id
        AND (g.created_at < f.created_at
             OR (g.created_at = f.created_at AND g.id < f.id))
   );

-- At most one incident per (guild, source_ref_id). Alert ids are globally unique
-- UUIDs, so this dedupes an alert to exactly one incident regardless of guild.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_incident_source_ref
  ON public.incidents (guild_id, source_ref_id)
  WHERE source_ref_id IS NOT NULL;

COMMIT;
