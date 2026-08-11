import { describe, expect, it } from 'vitest';
import { lavalinkHealthFromDiagnostics } from '@/lib/lavalink-health';

const NOW = Date.parse('2026-08-10T20:00:00.000Z');

function diagnostics(staleSecs: number, snapshotAt: string, nodes: readonly { readonly connected: boolean }[]) {
  return {
    success: true,
    data: {
      bot: { staleSecs, snapshotAt },
      lavalink: { nodes },
    },
  };
}

describe('lavalinkHealthFromDiagnostics', () => {
  it('reports connected only from a fresh health snapshot', () => {
    const health = lavalinkHealthFromDiagnostics(
      diagnostics(30, '2026-08-10T19:59:30.000Z', [{ connected: false }, { connected: true }]),
      NOW,
    );

    expect(health).toEqual({ state: 'connected', snapshotAt: '2026-08-10T19:59:30.000Z' });
  });

  it('reports disconnected from fresh nodes that are all disconnected', () => {
    const health = lavalinkHealthFromDiagnostics(
      diagnostics(119, '2026-08-10T19:58:01.000Z', [{ connected: false }]),
      NOW,
    );

    expect(health).toEqual({ state: 'disconnected', snapshotAt: '2026-08-10T19:58:01.000Z' });
  });

  it('marks the exact 120-second heartbeat boundary stale', () => {
    const health = lavalinkHealthFromDiagnostics(
      diagnostics(120, '2026-08-10T19:59:30.000Z', [{ connected: true }]),
      NOW,
    );

    expect(health).toEqual({ state: 'stale', snapshotAt: '2026-08-10T19:59:30.000Z' });
  });

  it('marks a stale health snapshot unverified even when the heartbeat is fresh', () => {
    const health = lavalinkHealthFromDiagnostics(
      diagnostics(5, '2026-08-10T19:57:59.000Z', [{ connected: true }]),
      NOW,
    );

    expect(health).toEqual({ state: 'stale', snapshotAt: '2026-08-10T19:57:59.000Z' });
  });

  it('returns unavailable when a fresh snapshot has no configured nodes', () => {
    const health = lavalinkHealthFromDiagnostics(
      diagnostics(0, '2026-08-10T20:00:00.000Z', []),
      NOW,
    );

    expect(health).toEqual({ state: 'unavailable', snapshotAt: '2026-08-10T20:00:00.000Z' });
  });

  it('returns unknown when freshness metadata is missing or malformed', () => {
    expect(lavalinkHealthFromDiagnostics({
      success: true,
      data: { bot: { staleSecs: 0 }, lavalink: { nodes: [{ connected: true }] } },
    }, NOW)).toEqual({ state: 'unknown' });
    expect(lavalinkHealthFromDiagnostics({ success: false }, NOW)).toEqual({ state: 'unknown' });
  });
});
