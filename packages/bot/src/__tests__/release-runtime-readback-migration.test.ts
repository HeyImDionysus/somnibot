import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../supabase/migrations/20260818113000_release_runtime_readback_repairs.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('release runtime readback migration', () => {
  it('exposes fulfillment holds only to the server-side service role', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.commerce_fulfillment_holds\s+FROM PUBLIC, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT SELECT ON TABLE public\.commerce_fulfillment_holds TO service_role/i,
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|ALL)[^;]+commerce_fulfillment_holds[^;]+(?:anon|authenticated)/i,
    );
  });

  it('atomically resolves linked health incidents and repairs cleared history', () => {
    expect(migration).toMatch(
      /CREATE TRIGGER alerts_resolve_linked_health_incident\s+AFTER UPDATE OF resolved ON public\.alerts/i,
    );
    expect(migration).toContain("incident.source = 'health_alert'");
    expect(migration).toContain('incident.source_ref_id = NEW.id::TEXT');
    expect(migration).toMatch(/event_type,\s+actor_id,\s+message,\s+metadata/i);
    expect(migration).toContain("'auto_resolved'");
    expect(migration).toContain('OLD.resolved IS TRUE');
    expect(migration).toContain("'auto_reopened'");
    expect(migration).toMatch(/status = 'open',[\s\S]+resolved_at = NULL,[\s\S]+duration_seconds = NULL/i);
    expect(migration).not.toMatch(/status = 'open',[\s\S]+resolution = NULL,[\s\S]+duration_seconds = NULL/i);
    expect(migration).toMatch(
      /CREATE TRIGGER incidents_guard_linked_health_alert\s+BEFORE UPDATE OF status ON public\.incidents/i,
    );
    expect(migration).toContain("v_terminal_status := NEW.status IN ('resolved', 'closed')");
    expect(migration).toContain('v_alert_resolved IS DISTINCT FROM v_terminal_status');
    expect(migration).not.toContain('sync_health_incident_alert');
    expect(migration).toMatch(
      /FROM public\.alerts AS alert[\s\S]+incident\.source_ref_id = alert\.id::TEXT[\s\S]+incident\.status NOT IN \('resolved', 'closed'\)[\s\S]+alert\.resolved IS TRUE/i,
    );
    expect(migration).not.toMatch(/DELETE FROM public\.(?:alerts|incidents|incident_events)/i);
  });
});
