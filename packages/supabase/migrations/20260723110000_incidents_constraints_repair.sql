-- =============================================================================
-- Repair the incidents table: the intended Phase-D constraints never applied.
--
-- 20260518000001_missing_tables.sql created a barebones `incidents` FIRST (no
-- incident_number, no CHECKs, no UNIQUE, severity DEFAULT 'medium'). The later
-- 20260518200000_phase_d_sota.sql carried the INTENDED schema inside a
-- `CREATE TABLE IF NOT EXISTS`, so it was a no-op (the table already existed);
-- its follow-up ADD COLUMN IF NOT EXISTS added incident_number etc. as NULLABLE
-- with NO constraints. Live schema confirmed only incidents_pkey exists,
-- incident_number is nullable, and severity default is 'medium' (not a valid
-- enum member at any layer).
--
-- This migration reconciles the table to the intended contract:
--   * severity ∈ (info, warning, critical, outage), default 'warning'
--   * status   ∈ (open, investigating, identified, monitoring, resolved, closed)
--   * incident_number NOT NULL + UNIQUE (guild_id, incident_number)
-- Data is normalized/backfilled first so the constraints can be enforced.
-- =============================================================================
BEGIN;

-- 1. Normalize legacy severity values ('medium' default, or any stray) to the
--    intended vocabulary before adding the CHECK.
UPDATE public.incidents
   SET severity = 'warning'
 WHERE severity IS NULL
    OR severity NOT IN ('info', 'warning', 'critical', 'outage');

-- 2. Normalize legacy status values.
UPDATE public.incidents
   SET status = 'open'
 WHERE status IS NULL
    OR status NOT IN ('open', 'investigating', 'identified', 'monitoring', 'resolved', 'closed');

-- 3. Backfill NULL incident_number per guild, continuing after each guild's
--    current max so existing numbered rows keep their numbers.
WITH numbered AS (
  SELECT a.id,
         COALESCE(
           (SELECT pg_catalog.max(b.incident_number)
              FROM public.incidents b
             WHERE b.guild_id = a.guild_id),
           0
         )
         + row_number() OVER (PARTITION BY a.guild_id ORDER BY a.created_at, a.id)
           AS new_number
    FROM public.incidents a
   WHERE a.incident_number IS NULL
)
UPDATE public.incidents i
   SET incident_number = numbered.new_number
  FROM numbered
 WHERE i.id = numbered.id;

-- 4. Realign the global incident_number sequence above the new max so future
--    nextval_incident() draws never collide with backfilled per-guild numbers.
SELECT pg_catalog.setval(
  'public.incident_number_seq',
  GREATEST((SELECT pg_catalog.max(incident_number) FROM public.incidents), 1),
  true
);

-- 5. severity: valid default + CHECK.
ALTER TABLE public.incidents ALTER COLUMN severity SET DEFAULT 'warning';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'incidents_severity_check'
       AND conrelid = 'public.incidents'::regclass
  ) THEN
    ALTER TABLE public.incidents
      ADD CONSTRAINT incidents_severity_check
      CHECK (severity IN ('info', 'warning', 'critical', 'outage'));
  END IF;
END $$;

-- 6. status CHECK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'incidents_status_check'
       AND conrelid = 'public.incidents'::regclass
  ) THEN
    ALTER TABLE public.incidents
      ADD CONSTRAINT incidents_status_check
      CHECK (status IN ('open', 'investigating', 'identified', 'monitoring', 'resolved', 'closed'));
  END IF;
END $$;

-- 7. incident_number NOT NULL + UNIQUE (guild_id, incident_number).
ALTER TABLE public.incidents ALTER COLUMN incident_number SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'incidents_guild_number_uniq'
       AND conrelid = 'public.incidents'::regclass
  ) THEN
    ALTER TABLE public.incidents
      ADD CONSTRAINT incidents_guild_number_uniq UNIQUE (guild_id, incident_number);
  END IF;
END $$;

COMMIT;
