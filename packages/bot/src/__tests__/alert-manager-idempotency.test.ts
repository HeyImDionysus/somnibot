/**
 * AlertManager idempotency: a concurrent opener losing the race on the
 * uniq_alerts_unresolved_diagnostics partial unique index (23505) must be a
 * silent no-op — the alert is treated as open, not re-inserted and not logged
 * as an error. Any OTHER insert error must still surface (logged).
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

// A snapshot that trips exactly one diagnostic alert: valkey_disconnected.
function downValkeySnapshot(): HealthSnapshot {
  return {
    guild_id: 'guild-1',
    memory_rss_mb: 10,
    discord_ws_ping: 10,
    valkey_connected: false,
    lavalink_nodes: [],
  };
}

/**
 * Supabase stub for the alerts table.
 * - the "existing unresolved?" select → maybeSingle resolves { data: null }
 * - the insert → resolves { error } (caller passes the 23505 / other error)
 */
function makeSupa(insertError: { code?: string; message?: string } | null) {
  const insert = vi.fn(() => Promise.resolve({ data: null, error: insertError }));
  const chain: Record<string, unknown> = { insert };
  for (const m of ['select', 'eq', 'update', 'order', 'limit', 'in']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
  return { from: vi.fn(() => chain) } as any;
}

describe('AlertManager diagnostic-alert idempotency', () => {
  beforeEach(() => { errorSpy.mockClear(); });

  it('treats a 23505 on insert as already-open (no throw, no error log)', async () => {
    const mgr = new AlertManager(makeSupa({ code: '23505', message: 'unique violation' }));
    await expect(mgr.evaluate(downValkeySnapshot())).resolves.toBeUndefined();
    // The concurrent-loser insert must not be logged as a failure.
    expect(errorSpy).not.toHaveBeenCalled();
    // The alert is considered open (tracked in the in-memory set).
    expect((mgr as any).activeAlerts.has('valkey_disconnected')).toBe(true);
  });

  it('still surfaces a non-23505 insert error', async () => {
    const mgr = new AlertManager(makeSupa({ code: '23514', message: 'check violation' }));
    await mgr.evaluate(downValkeySnapshot());
    // A genuine failure is logged (via the per-alert catch).
    expect(errorSpy).toHaveBeenCalled();
    // And the alert is NOT marked open, since the insert did not succeed.
    expect((mgr as any).activeAlerts.has('valkey_disconnected')).toBe(false);
  });
});
