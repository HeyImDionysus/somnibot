import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const permissionMigration = readFileSync(
  new URL(
    '../../../supabase/migrations/20260818113000_release_runtime_readback_repairs.sql',
    import.meta.url,
  ),
  'utf8',
);

const lifecycleMigration = readFileSync(
  new URL(
    '../../../supabase/migrations/20260818113500_linked_health_incident_authority.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('release runtime readback migration', () => {
  it('exposes fulfillment holds only to the server-side service role', () => {
    expect(permissionMigration).toMatch(
      /REVOKE ALL ON TABLE public\.commerce_fulfillment_holds\s+FROM PUBLIC, anon, authenticated/i,
    );
    expect(permissionMigration).toMatch(
      /GRANT SELECT ON TABLE public\.commerce_fulfillment_holds TO service_role/i,
    );
    expect(permissionMigration).not.toMatch(
      /GRANT\s+(?:SELECT|ALL)[^;]+commerce_fulfillment_holds[^;]+(?:anon|authenticated)/i,
    );
  });

  it('atomically resolves linked health incidents and repairs cleared history', () => {
    expect(permissionMigration).toMatch(
      /CREATE TRIGGER alerts_resolve_linked_health_incident\s+AFTER UPDATE OF resolved ON public\.alerts/i,
    );
    expect(lifecycleMigration).toContain("incident.source = 'health_alert'");
    expect(lifecycleMigration).toContain('incident.source_ref_id = NEW.id::TEXT');
    expect(lifecycleMigration).toMatch(/event_type,\s+actor_id,\s+message,\s+metadata/i);
    expect(lifecycleMigration).toContain("'auto_resolved'");
    expect(lifecycleMigration).toContain('OLD.resolved IS TRUE');
    expect(lifecycleMigration).toContain("'auto_reopened'");
    expect(lifecycleMigration).toMatch(/status = 'open',[\s\S]+resolved_at = NULL,[\s\S]+resolved_by = NULL,[\s\S]+duration_seconds = NULL/i);
    expect(lifecycleMigration).not.toMatch(/status = 'open',[\s\S]+resolution = NULL,[\s\S]+duration_seconds = NULL/i);
    expect(lifecycleMigration).toMatch(
      /CREATE TRIGGER incidents_guard_linked_health_alert\s+BEFORE UPDATE OF status ON public\.incidents/i,
    );
    expect(lifecycleMigration).toContain("v_terminal_status := NEW.status IN ('resolved', 'closed')");
    expect(lifecycleMigration).toContain('v_alert_resolved IS DISTINCT FROM v_terminal_status');
    expect(lifecycleMigration).toContain('DROP FUNCTION IF EXISTS public.sync_health_incident_alert()');
    expect(lifecycleMigration).toContain("incident.status IN ('resolved', 'closed')");
    expect(lifecycleMigration).toMatch(
      /FROM public\.alerts AS alert[\s\S]+incident\.source_ref_id = alert\.id::TEXT[\s\S]+incident\.status NOT IN \('resolved', 'closed'\)[\s\S]+alert\.resolved IS TRUE/i,
    );
    expect(lifecycleMigration).toMatch(
      /FROM public\.alerts AS alert[\s\S]+incident\.source_ref_id = alert\.id::TEXT[\s\S]+incident\.status IN \('resolved', 'closed'\)[\s\S]+alert\.resolved IS FALSE/i,
    );
    expect(lifecycleMigration).not.toMatch(/DELETE FROM public\.(?:alerts|incidents|incident_events)/i);
  });
});
