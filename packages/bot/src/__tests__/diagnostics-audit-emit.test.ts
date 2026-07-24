/**
 * Diagnostics audit emit tests
 *
 * Covers the diagnostics observability lane: the AlertManager mirrors alert
 * lifecycle transitions (raised / resolved, including dependency-down) to the
 * platform event bus, and DiagnosticsService emits `diagnostics.snapshot_failed`
 * when a health snapshot write fails. AuditService maps each to an audit_logs row.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { AlertManager, type HealthSnapshot } from '../features/audit/alert-manager.js';
import { DiagnosticsService } from '../features/audit/diagnostics-service.js';

function downValkeySnapshot(): HealthSnapshot {
  return { guild_id: 'guild-1', memory_rss_mb: 10, discord_ws_ping: 10, valkey_connected: false, lavalink_nodes: [] };
}

/** alerts-table stub; insert resolves with the supplied error (null = success). */
function makeSupa(insertError: { code?: string } | null) {
  const insert = vi.fn(() => Promise.resolve({ data: null, error: insertError }));
  const chain: Record<string, unknown> = { insert };
  for (const m of ['select', 'eq', 'update', 'order', 'limit', 'in']) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
  return { from: vi.fn(() => chain) } as any;
}

function makeBus() {
  return { emit: vi.fn() } as any;
}

describe('AlertManager alert-lifecycle audit emits', () => {
  it('emits diagnostics.alert_raised on a fresh alert insert (dependency-down)', async () => {
    const bus = makeBus();
    const mgr = new AlertManager(makeSupa(null), undefined, bus);
    await mgr.evaluate(downValkeySnapshot());
    expect(bus.emit).toHaveBeenCalledWith(
      'diagnostics.alert_raised',
      'guild-1',
      expect.objectContaining({ alertType: 'valkey_disconnected', severity: 'critical' }),
    );
  });

  it('does NOT emit alert_raised when the insert lost the 23505 race', async () => {
    const bus = makeBus();
    const mgr = new AlertManager(makeSupa({ code: '23505' }), undefined, bus);
    await mgr.evaluate(downValkeySnapshot());
    expect(bus.emit).not.toHaveBeenCalledWith('diagnostics.alert_raised', expect.anything(), expect.anything());
  });

  it('emits diagnostics.alert_resolved when an active alert clears', async () => {
    const bus = makeBus();
    const mgr = new AlertManager(makeSupa(null), undefined, bus);
    await mgr.evaluate(downValkeySnapshot()); // raise
    bus.emit.mockClear();
    await mgr.evaluate({ ...downValkeySnapshot(), valkey_connected: true }); // clear
    expect(bus.emit).toHaveBeenCalledWith(
      'diagnostics.alert_resolved',
      'guild-1',
      expect.objectContaining({ alertType: 'valkey_disconnected' }),
    );
  });
});

describe('DiagnosticsService snapshot-failed audit emit', () => {
  function makeClient(bus: any) {
    const chain: any = {};
    for (const m of ['select', 'eq', 'insert', 'update', 'order', 'limit', 'in']) chain[m] = vi.fn(() => chain);
    chain.upsert = vi.fn(() => Promise.resolve({ error: { message: 'db down' } }));
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    chain.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
    const supabase = { from: vi.fn(() => chain), rpc: vi.fn(() => Promise.resolve({ data: null, error: null })) };
    const client = {
      guildId: 'guild-1',
      eventBus: bus,
      shoukaku: { nodes: new Map() },
      valkey: { info: vi.fn().mockResolvedValue('used_memory:1048576'), ping: vi.fn().mockResolvedValue('PONG') },
      guilds: { cache: new Map() },
      ws: { ping: 42 },
    };
    return { client, supabase };
  }

  it('emits diagnostics.snapshot_failed when the snapshot upsert errors', async () => {
    const bus = makeBus();
    const { client, supabase } = makeClient(bus);
    const svc = new DiagnosticsService(client as any, supabase as any, 'guild-1');
    await (svc as any).writeSnapshot();
    expect(bus.emit).toHaveBeenCalledWith(
      'diagnostics.snapshot_failed',
      'guild-1',
      expect.objectContaining({ stage: 'write' }),
    );
  });
});
