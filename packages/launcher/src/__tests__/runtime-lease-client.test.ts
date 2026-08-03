import { describe, expect, it, vi } from 'vitest';
import {
  canonicalSupabaseProjectOrigin,
  hasSupabaseProjectOriginChanged,
  readRuntimeLeaseStatus,
  RuntimeLeaseStatusUnavailableError,
  validateSupabaseCredentialPairing,
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
    })).rejects.toThrow('canonical HTTPS Supabase project origin');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects Supabase-domain URLs with credential-routing components', async () => {
    const fetchImpl = vi.fn();
    for (const url of [
      'https://attacker.supabase.co/functions/v1/collector?x=',
      'https://attacker.supabase.co:444',
      'https://user@attacker.supabase.co',
      'https://attacker.supabase.co/#fragment',
    ]) {
      await expect(readRuntimeLeaseStatus(url, 'stored-service-key', {
        fetch: fetchImpl,
      })).rejects.toThrow('canonical HTTPS Supabase project origin');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(canonicalSupabaseProjectOrigin('https://example.supabase.co/'))
      .toBe('https://example.supabase.co');
  });

  it('requires a matching new secret key when the renderer changes Supabase projects', () => {
    expect(validateSupabaseCredentialPairing(
      'https://first.supabase.co',
      { supabaseUrl: 'https://second.supabase.co' },
    )).toContain('matching secret key');
    expect(validateSupabaseCredentialPairing(
      'https://first.supabase.co',
      { supabaseUrl: 'https://second.supabase.co', supabaseSecretKey: 'new-project-key' },
    )).toBeUndefined();
    expect(validateSupabaseCredentialPairing(
      'https://first.supabase.co',
      { supabaseUrl: 'https://first.supabase.co/' },
    )).toBeUndefined();
    expect(hasSupabaseProjectOriginChanged(
      'https://first.supabase.co',
      'https://first.supabase.co/',
    )).toBe(false);
    expect(hasSupabaseProjectOriginChanged(
      'https://first.supabase.co',
      'https://second.supabase.co',
    )).toBe(true);
  });

  it('allows an empty first-run form to autosave without accepting an orphaned secret', () => {
    expect(validateSupabaseCredentialPairing('', { supabaseUrl: '' })).toBeUndefined();
    expect(validateSupabaseCredentialPairing('', { supabaseUrl: '   ' })).toBeUndefined();
    expect(validateSupabaseCredentialPairing('', {
      supabaseUrl: '',
      supabaseSecretKey: 'service-key',
    })).toContain('URL is required');
    expect(hasSupabaseProjectOriginChanged('', '')).toBe(false);
    expect(hasSupabaseProjectOriginChanged('https://saved.supabase.co', '')).toBe(true);
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
