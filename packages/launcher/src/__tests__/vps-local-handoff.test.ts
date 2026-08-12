import { describe, expect, it, vi } from 'vitest';
import { runVpsToLocalHandoff } from '../main/vps-local-handoff.js';

describe('VPS to local runtime handoff', () => {
  it('proves VPS release before starting local', async () => {
    const events: string[] = [];
    const result = await runVpsToLocalHandoff({
      stopVps: async () => { events.push('stop-vps'); return true; },
      waitForVpsStopped: async () => { events.push('prove-release'); },
      startLocal: async () => { events.push('start-local'); return { ok: true }; },
      isLocalReady: (local) => local.ok,
      restoreVps: async () => { events.push('restore-vps'); return { ok: true }; },
    });

    expect(result).toEqual({ state: 'success', localResult: { ok: true } });
    expect(events).toEqual(['stop-vps', 'prove-release', 'start-local']);
  });

  it('never starts local and restores VPS when the stop result is ambiguous', async () => {
    const startLocal = vi.fn();
    const restoreVps = vi.fn().mockResolvedValue({ ok: true });
    const result = await runVpsToLocalHandoff({
      stopVps: async () => false,
      waitForVpsStopped: vi.fn(),
      startLocal,
      isLocalReady: () => true,
      restoreVps,
    });

    expect(result.state).toBe('vps-stop-unproven');
    expect(startLocal).not.toHaveBeenCalled();
    expect(restoreVps).toHaveBeenCalledWith('stop-unproven');
  });

  it('restores VPS without starting local when ownership release is unproven', async () => {
    const startLocal = vi.fn();
    const restoreVps = vi.fn().mockResolvedValue({ ok: true });
    const result = await runVpsToLocalHandoff({
      stopVps: async () => true,
      waitForVpsStopped: async () => { throw new Error('lease still active'); },
      startLocal,
      isLocalReady: () => true,
      restoreVps,
    });

    expect(result.state).toBe('vps-release-unproven');
    expect(startLocal).not.toHaveBeenCalled();
    expect(restoreVps).toHaveBeenCalledWith('release-unproven');
  });

  it('compensates both a failed result and a thrown local startup', async () => {
    const restoreAfterResult = vi.fn().mockResolvedValue({ ok: true });
    const failedResult = await runVpsToLocalHandoff({
      stopVps: async () => true,
      waitForVpsStopped: async () => undefined,
      startLocal: async () => ({ ok: false, stage: 'bot-ready' }),
      isLocalReady: (local) => local.ok,
      restoreVps: restoreAfterResult,
    });
    expect(failedResult.state).toBe('local-failed');
    expect(restoreAfterResult).toHaveBeenCalledWith('local-failed');

    const restoreAfterThrow = vi.fn().mockResolvedValue({ ok: true });
    const thrownResult = await runVpsToLocalHandoff({
      stopVps: async () => true,
      waitForVpsStopped: async () => undefined,
      startLocal: async () => { throw new Error('spawn failed'); },
      isLocalReady: () => true,
      restoreVps: restoreAfterThrow,
    });
    expect(thrownResult.state).toBe('local-failed');
    expect(restoreAfterThrow).toHaveBeenCalledWith('local-failed');
  });
});
