/**
 * AlertManager health-alert -> incident auto-creation.
 *
 * A CRITICAL diagnostics alert must automatically open a LINKED incident whose
 * source reference points back at the alert (source='health_alert',
 * source_ref_id=<alert.id>), and it must be deduplicated per alert reference so
 * one alert can never open (or re-page for) two incidents. A non-critical alert
 * must open NO incident.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { errorSpy } = vi.hoisted(() => ({ errorSpy: vi.fn() }));
vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: errorSpy, debug: vi.fn(),
  }),
}));

import { AlertManager, type HealthSnapshot } from '../features/audit/alert-manager.js';

// valkey_disconnected → a single CRITICAL alert; nothing else trips.
function criticalSnapshot(): HealthSnapshot {
  return {
    guild_id: 'guild-1',
    memory_rss_mb: 10,
    discord_ws_ping: 10,
    valkey_connected: false,
    lavalink_nodes: [],
  };
}

// lavalink_down → a single WARNING alert; no critical alert at all.
function warningOnlySnapshot(): HealthSnapshot {
  return {
    guild_id: 'guild-1',
    memory_rss_mb: 10,
    discord_ws_ping: 10,
    valkey_connected: true,
    lavalink_nodes: [{ name: 'node-1', connected: false, players: 0 }],
  };
}

/**
 * An in-memory fake of the pieces of the Supabase client AlertManager touches:
 * the alerts + incidents + incident_events tables and nextval_incident. It is
 * table-aware and filter-aware so the read-back-id, dedup-check, and insert
 * paths behave like the real thing.
 */
function makeFakeSupa() {
  const alerts: Array<Record<string, unknown>> = [];
  const incidents: Array<Record<string, unknown>> = [];
  const incidentEvents: Array<Record<string, unknown>> = [];
  let alertSeq = 0;
  let incidentSeq = 100;

  function matches(row: Record<string, unknown>, filters: Record<string, unknown>): boolean {
    return Object.entries(filters).every(([k, v]) => row[k] === v);
  }

  function store(table: string): Array<Record<string, unknown>> {
    if (table === 'alerts') return alerts;
    if (table === 'incidents') return incidents;
    return incidentEvents;
  }

  function from(table: string) {
    const filters: Record<string, unknown> = {};
    let pendingInsert: Record<string, unknown> | null = null;
    let done = false;

    const runInsert = (): Record<string, unknown> => {
      done = true;
      const row = { ...pendingInsert } as Record<string, unknown>;
      if (table === 'alerts') { row.id = `alert-${++alertSeq}`; row.resolved = false; }
      if (table === 'incidents') { row.id = `inc-${++incidentSeq}`; }
      store(table).push(row);
      return row;
    };

    const api: Record<string, unknown> = {};
    Object.assign(api, {
      select: () => api,
      eq: (col: string, val: unknown) => { filters[col] = val; return api; },
      not: () => api,
      gte: () => api,
      order: () => api,
      insert: (row: Record<string, unknown>) => { pendingInsert = row; return api; },
      update: () => { pendingInsert = null; return api; },
      limit: () => Promise.resolve({ data: store(table).filter((r) => matches(r, filters)), error: null }),
      maybeSingle: () => Promise.resolve({ data: store(table).filter((r) => matches(r, filters))[0] ?? null, error: null }),
      single: () => {
        if (pendingInsert && !done) return Promise.resolve({ data: runInsert(), error: null });
        return Promise.resolve({ data: store(table).filter((r) => matches(r, filters))[0] ?? null, error: null });
      },
      // Awaited directly (insert without .select, or update chain).
      then: (resolve: (v: unknown) => void) => {
        if (pendingInsert && !done) runInsert();
        resolve({ data: store(table).filter((r) => matches(r, filters)), error: null });
      },
    });
    return api;
  }

  const rpc = vi.fn(async (name: string) =>
    name === 'nextval_incident' ? { data: ++incidentSeq, error: null } : { data: null, error: null });

  return { supa: { from, rpc } as never, alerts, incidents, incidentEvents };
}

describe('AlertManager health-alert -> incident auto-create', () => {
  beforeEach(() => { errorSpy.mockClear(); });

  it('opens ONE incident linked to a critical alert via source_ref_id', async () => {
    const { supa, alerts, incidents, incidentEvents } = makeFakeSupa();
    const mgr = new AlertManager(supa);

    await mgr.evaluate(criticalSnapshot());

    expect(alerts).toHaveLength(1);
    const alertId = alerts[0]!.id as string;

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      guild_id: 'guild-1',
      severity: 'critical',
      status: 'open',
      source: 'health_alert',
      source_ref_id: alertId,
      created_by: 'system:diagnostics',
    });

    // A timeline event records the auto-creation and back-links the alert id.
    expect(incidentEvents).toHaveLength(1);
    expect(incidentEvents[0]).toMatchObject({
      event_type: 'auto_created',
      metadata: { alert_type: 'valkey_disconnected', alert_id: alertId },
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('dedupes per alert reference — a re-evaluation opens no second incident', async () => {
    const { supa, alerts, incidents } = makeFakeSupa();
    const mgr = new AlertManager(supa);

    await mgr.evaluate(criticalSnapshot());
    // Second evaluation of the still-firing alert: the alert row is reused (no
    // new alert), and the linked incident already exists → no duplicate.
    await mgr.evaluate(criticalSnapshot());

    expect(alerts).toHaveLength(1);
    expect(incidents).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('opens NO incident for a non-critical (warning) alert', async () => {
    const { supa, alerts, incidents } = makeFakeSupa();
    const mgr = new AlertManager(supa);

    await mgr.evaluate(warningOnlySnapshot());

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ alert_type: 'lavalink_down', severity: 'warning' });
    expect(incidents).toHaveLength(0);
  });
});
