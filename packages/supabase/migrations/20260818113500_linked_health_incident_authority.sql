-- A linked diagnostics alert is the authority for its incident lifecycle.
-- The earlier bidirectional triggers could lock alerts and incidents in the
-- opposite order, so remove the incident-to-alert writer and guard direct
-- incident changes instead.
DROP TRIGGER IF EXISTS incidents_sync_linked_health_alert ON public.incidents;
DROP FUNCTION IF EXISTS public.sync_health_incident_alert();

CREATE OR REPLACE FUNCTION public.sync_health_alert_incident()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_incident_id UUID;
  v_changed_at TIMESTAMPTZ := pg_catalog.now();
  v_resolved_at TIMESTAMPTZ := COALESCE(NEW.resolved_at, v_changed_at);
BEGIN
  IF NEW.resolved IS TRUE AND OLD.resolved IS DISTINCT FROM TRUE THEN
    UPDATE public.incidents AS incident
    SET
      status = 'resolved',
      resolved_at = v_resolved_at,
      resolved_by = 'system:diagnostics',
      resolution = COALESCE(
        NULLIF(incident.resolution, ''),
        'Automatically resolved when the linked diagnostics alert cleared.'
      ),
      duration_seconds = GREATEST(
        0,
        EXTRACT(
          EPOCH FROM (v_resolved_at - COALESCE(incident.started_at, incident.created_at))
        )::INTEGER
      ),
      updated_at = v_resolved_at
    WHERE incident.guild_id = NEW.guild_id
      AND incident.source = 'health_alert'
      AND incident.source_ref_id = NEW.id::TEXT
      AND incident.status NOT IN ('resolved', 'closed')
    RETURNING incident.id INTO v_incident_id;

    IF v_incident_id IS NOT NULL THEN
      INSERT INTO public.incident_events (
        incident_id,
        event_type,
        actor_id,
        message,
        metadata
      ) VALUES (
        v_incident_id,
        'auto_resolved',
        'system:diagnostics',
        'Automatically resolved when the linked diagnostics alert cleared.',
        pg_catalog.jsonb_build_object('alert_id', NEW.id, 'alert_type', NEW.alert_type)
      );
    END IF;
  ELSIF NEW.resolved IS FALSE AND OLD.resolved IS TRUE THEN
    UPDATE public.incidents AS incident
    SET
      status = 'open',
      resolved_at = NULL,
      resolved_by = NULL,
      duration_seconds = NULL,
      updated_at = v_changed_at
    WHERE incident.guild_id = NEW.guild_id
      AND incident.source = 'health_alert'
      AND incident.source_ref_id = NEW.id::TEXT
      AND incident.status IN ('resolved', 'closed')
    RETURNING incident.id INTO v_incident_id;

    IF v_incident_id IS NOT NULL THEN
      INSERT INTO public.incident_events (
        incident_id,
        event_type,
        actor_id,
        message,
        metadata
      ) VALUES (
        v_incident_id,
        'auto_reopened',
        'system:diagnostics',
        'Reopened because the linked diagnostics alert became active again.',
        pg_catalog.jsonb_build_object('alert_id', NEW.id, 'alert_type', NEW.alert_type)
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_health_alert_incident()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_health_alert_incident_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_alert_resolved BOOLEAN;
  v_terminal_status BOOLEAN;
BEGIN
  IF NEW.source = 'health_alert'
     AND NEW.source_ref_id IS NOT NULL
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT alert.resolved
    INTO v_alert_resolved
    FROM public.alerts AS alert
    WHERE alert.guild_id = NEW.guild_id
      AND alert.id::TEXT = NEW.source_ref_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'health-alert incident status requires its linked alert';
    END IF;

    v_terminal_status := NEW.status IN ('resolved', 'closed');
    IF v_alert_resolved IS DISTINCT FROM v_terminal_status THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'health-alert incident status must follow its linked alert';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_health_alert_incident_status()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS incidents_guard_linked_health_alert ON public.incidents;
CREATE TRIGGER incidents_guard_linked_health_alert
BEFORE UPDATE OF status ON public.incidents
FOR EACH ROW
EXECUTE FUNCTION public.guard_health_alert_incident_status();

-- Reconcile either side after replacing the old bidirectional triggers.
WITH repaired AS (
  UPDATE public.incidents AS incident
  SET
    status = 'resolved',
    resolved_at = COALESCE(alert.resolved_at, pg_catalog.now()),
    resolved_by = 'system:diagnostics',
    resolution = COALESCE(
      NULLIF(incident.resolution, ''),
      'Automatically resolved when the linked diagnostics alert cleared.'
    ),
    duration_seconds = GREATEST(
      0,
      EXTRACT(
        EPOCH FROM (
          COALESCE(alert.resolved_at, pg_catalog.now())
          - COALESCE(incident.started_at, incident.created_at)
        )
      )::INTEGER
    ),
    updated_at = COALESCE(alert.resolved_at, pg_catalog.now())
  FROM public.alerts AS alert
  WHERE incident.guild_id = alert.guild_id
    AND incident.source = 'health_alert'
    AND incident.source_ref_id = alert.id::TEXT
    AND incident.status NOT IN ('resolved', 'closed')
    AND alert.resolved IS TRUE
  RETURNING incident.id
)
INSERT INTO public.incident_events (
  incident_id,
  event_type,
  actor_id,
  message,
  metadata
)
SELECT
  repaired.id,
  'auto_resolved',
  'system:diagnostics',
  'Backfilled resolution from the linked cleared diagnostics alert.',
  pg_catalog.jsonb_build_object('repair', '20260818113500')
FROM repaired;

WITH repaired AS (
  UPDATE public.incidents AS incident
  SET
    status = 'open',
    resolved_at = NULL,
    resolved_by = NULL,
    duration_seconds = NULL,
    updated_at = pg_catalog.now()
  FROM public.alerts AS alert
  WHERE incident.guild_id = alert.guild_id
    AND incident.source = 'health_alert'
    AND incident.source_ref_id = alert.id::TEXT
    AND incident.status IN ('resolved', 'closed')
    AND alert.resolved IS FALSE
  RETURNING incident.id
)
INSERT INTO public.incident_events (
  incident_id,
  event_type,
  actor_id,
  message,
  metadata
)
SELECT
  repaired.id,
  'auto_reopened',
  'system:diagnostics',
  'Backfilled reopening from the linked active diagnostics alert.',
  pg_catalog.jsonb_build_object('repair', '20260818113500')
FROM repaired;
