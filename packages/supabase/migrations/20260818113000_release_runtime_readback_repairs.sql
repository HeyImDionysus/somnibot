-- Restore the server-only delivery readback used by the Store control room.
-- The checkout rails intentionally deny direct writes to this table; the
-- dashboard only needs a scoped SELECT through its service-role client.
REVOKE ALL ON TABLE public.commerce_fulfillment_holds
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.commerce_fulfillment_holds TO service_role;

-- A diagnostics alert and its auto-created incident are one operational
-- episode. Keep their terminal state atomic so the Incidents page cannot keep
-- advertising an outage after the authoritative alert has cleared.
CREATE OR REPLACE FUNCTION public.sync_health_alert_incident()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_incident_id UUID;
  v_resolved_at TIMESTAMPTZ := COALESCE(NEW.resolved_at, pg_catalog.now());
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
      AND incident.status <> 'resolved'
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
      updated_at = pg_catalog.now()
    WHERE incident.guild_id = NEW.guild_id
      AND incident.source = 'health_alert'
      AND incident.source_ref_id = NEW.id::TEXT
      AND incident.status = 'resolved'
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

DROP TRIGGER IF EXISTS alerts_resolve_linked_health_incident ON public.alerts;
CREATE TRIGGER alerts_resolve_linked_health_incident
AFTER UPDATE OF resolved ON public.alerts
FOR EACH ROW
EXECUTE FUNCTION public.sync_health_alert_incident();

CREATE OR REPLACE FUNCTION public.sync_health_incident_alert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_changed_at TIMESTAMPTZ := pg_catalog.now();
BEGIN
  IF NEW.source = 'health_alert'
     AND NEW.source_ref_id IS NOT NULL
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'resolved' THEN
      UPDATE public.alerts AS alert
      SET
        resolved = TRUE,
        resolved_at = COALESCE(NEW.resolved_at, v_changed_at),
        updated_at = v_changed_at
      WHERE alert.guild_id = NEW.guild_id
        AND alert.id::TEXT = NEW.source_ref_id
        AND alert.resolved IS FALSE;
    ELSIF OLD.status = 'resolved' THEN
      UPDATE public.alerts AS alert
      SET
        resolved = FALSE,
        resolved_at = NULL,
        updated_at = v_changed_at
      WHERE alert.guild_id = NEW.guild_id
        AND alert.id::TEXT = NEW.source_ref_id
        AND alert.resolved IS TRUE;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_health_incident_alert()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS incidents_sync_linked_health_alert ON public.incidents;
CREATE TRIGGER incidents_sync_linked_health_alert
AFTER UPDATE OF status ON public.incidents
FOR EACH ROW
EXECUTE FUNCTION public.sync_health_incident_alert();

-- Repair already-cleared diagnostic episodes from earlier deployments. Only
-- unresolved health-alert incidents are changed; manual incidents and active
-- alerts remain untouched.
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
    AND incident.status <> 'resolved'
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
  pg_catalog.jsonb_build_object('repair', '20260818113000')
FROM repaired;
