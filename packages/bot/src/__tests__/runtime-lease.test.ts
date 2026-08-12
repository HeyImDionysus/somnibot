import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireRuntimeLease, resolveRuntimeHolderId } from '../services/runtime-lease.js';

describe('runtime lease', () => {
  it('exposes only guarded service-role functions, never direct lease-table writes', () => {
    const migration = readFileSync(fileURLToPath(new URL(
      '../../../supabase/migrations/20260802020000_runtime_lease.sql',
      import.meta.url,
    )), 'utf8');
    expect(migration).toContain('REVOKE ALL ON TABLE public.runtime_leases FROM PUBLIC, anon, authenticated, service_role;');
    expect(migration).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL).*runtime_leases\s+TO\s+service_role/i);
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_somnibot_runtime() FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_somnibot_runtime() TO service_role;');
    expect(migration).not.toContain('holder_id AS');
    expect(migration).not.toContain('session_id AS');
    expect(migration.match(/GRANT EXECUTE ON FUNCTION public\.(?:claim|heartbeat|release)_somnibot_runtime/g)).toHaveLength(3);
  });

  it('derives stable host ownership that differs between local and VPS', () => {
    const local = resolveRuntimeHolderId('', 'application-123', 'regular-local');
    const vps = resolveRuntimeHolderId('', 'application-123', 'vps');
    expect(local).toHaveLength(64);
    expect(vps).toHaveLength(64);
    expect(local).not.toBe(vps);
    expect(resolveRuntimeHolderId('', 'application-123', 'regular-local')).toBe(local);
  });

  it('fails closed before Discord can start when another mode owns the lease', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ acquired: false, active_mode: 'vps', lease_expires_at: new Date().toISOString() }],
      error: null,
    });
    await expect(acquireRuntimeLease({
      supabase: { rpc } as never,
      holderId: 'local-holder-identity',
      mode: 'regular-local',
      onLost: vi.fn(),
    })).rejects.toThrow('already active in vps mode');
  });

  it('releases with the exact acquired session and never force-takes over', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ acquired: true, active_mode: 'regular-local', lease_expires_at: new Date().toISOString() }], error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    const clearIntervalFn = vi.fn();
    const controller = await acquireRuntimeLease({
      supabase: { rpc } as never,
      holderId: 'local-holder-identity',
      mode: 'regular-local',
      onLost: vi.fn(),
      setIntervalFn: (() => ({ unref() {} })) as never,
      clearIntervalFn: clearIntervalFn as never,
    });
    await controller.release();
    expect(clearIntervalFn).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]?.[0]).toBe('claim_somnibot_runtime');
    expect(rpc.mock.calls[1]?.[0]).toBe('release_somnibot_runtime');
    expect(rpc.mock.calls[1]?.[1].p_session_id).toBe(rpc.mock.calls[0]?.[1].p_session_id);
    expect(rpc.mock.calls.flatMap(call => Object.keys(call[1]))).not.toContain('p_force');
  });

  it('fails closed before expiry even when a heartbeat request never resolves', async () => {
    let tick = () => {};
    let now = 0;
    const onLost = vi.fn();
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ acquired: true, active_mode: 'regular-local', lease_expires_at: new Date().toISOString() }], error: null })
      .mockReturnValueOnce(new Promise(() => {}));
    await acquireRuntimeLease({
      supabase: { rpc } as never,
      holderId: 'local-holder-identity',
      mode: 'regular-local',
      onLost,
      now: () => now,
      setIntervalFn: ((callback: () => void) => {
        tick = callback;
        return { unref() {} };
      }) as never,
      clearIntervalFn: vi.fn() as never,
    });
    tick();
    now = 36_000;
    tick();
    expect(onLost).toHaveBeenCalledOnce();
  });
});
