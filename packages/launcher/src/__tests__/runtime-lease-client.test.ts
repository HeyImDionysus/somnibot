import { describe, expect, it, vi } from 'vitest';
import {
  readRuntimeLeaseStatus,
  RuntimeLeaseStatusUnavailableError,
  waitForRuntimeLease,
} from '../main/runtime-lease-client.js';

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('launcher runtime lease client', () => {
  it('reads only the active runtime mode and expiry through the guarded RPC', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([{
      active: true,
      active_mode: 'vps',
      lease_expires_at: '2026-08-03T00:00:00.000Z',
    }]));

    await expect(readRuntimeLeaseStatus('https://example.supabase.co/', 'service-key', {
      fetch: fetchImpl,
    })).resolves.toEqual({
      active: true,
      activeMode: 'vps',
      leaseExpiresAt: '2026-08-03T00:00:00.000Z',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.supabase.co/rest/v1/rpc/get_somnibot_runtime',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('reports no active runtime without returning stale lease details', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([{
      active: false,
      active_mode: null,
      lease_expires_at: null,
    }]));

    await expect(readRuntimeLeaseStatus('https://example.supabase.co', 'service-key', {
      fetch: fetchImpl,
    })).resolves.toEqual({ active: false });
  });

  it('fails closed on malformed or unauthorized responses', async () => {
    const malformedFetch = vi.fn().mockResolvedValue(response([{ active: true, active_mode: 'unknown' }]));
    await expect(readRuntimeLeaseStatus('https://example.supabase.co', 'service-key', {
      fetch: malformedFetch,
    })).rejects.toThrow('invalid active runtime mode');

    const deniedFetch = vi.fn().mockResolvedValue(response({ message: 'denied' }, 403));
    await expect(readRuntimeLeaseStatus('https://example.supabase.co', 'service-key', {
      fetch: deniedFetch,
    })).rejects.toMatchObject({
      name: 'RuntimeLeaseStatusUnavailableError',
      reason: 'unavailable',
    });

    const missingFetch = vi.fn().mockResolvedValue(response({ code: 'PGRST202' }, 404));
    await expect(readRuntimeLeaseStatus('https://example.supabase.co', 'service-key', {
      fetch: missingFetch,
    })).rejects.toEqual(expect.objectContaining<Partial<RuntimeLeaseStatusUnavailableError>>({
      reason: 'not-installed',
    }));
  });

  it('never sends the service key to an untrusted renderer-supplied URL', async () => {
    const fetchImpl = vi.fn();
    await expect(readRuntimeLeaseStatus('https://attacker.example', 'stored-service-key', {
      fetch: fetchImpl,
    })).rejects.toThrow('must be a *.supabase.co domain');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never sends the service key to a renderer-selected loopback URL', async () => {
    const fetchImpl = vi.fn();
    await expect(readRuntimeLeaseStatus('http://127.0.0.1:54321', 'stored-service-key', {
      fetch: fetchImpl,
    })).rejects.toThrow('require an HTTPS Supabase project domain');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('waits for the requested ownership state and times out closed', async () => {
    let now = 0;
    const states = [
      { active: true, activeMode: 'vps' as const },
      { active: false },
    ];
    let index = 0;
    await expect(waitForRuntimeLease(
      async () => states[Math.min(index++, states.length - 1)]!,
      (status) => !status.active,
      { now: () => now, wait: async () => { now += 500; } },
    )).resolves.toEqual({ active: false });

    await expect(waitForRuntimeLease(
      async () => ({ active: true, activeMode: 'vps' }),
      (status) => !status.active,
      {
        now: () => now,
        wait: async () => { now += 500; },
        timeoutMs: 500,
        timeoutMessage: 'VPS ownership was not released.',
      },
    )).rejects.toThrow('VPS ownership was not released.');
  });
});
