import { describe, expect, it, vi } from 'vitest';
import {
  runLocalToVpsHandoff,
  waitForFreshLocalBotReady,
  waitForProcessIdsToExit,
} from '../main/local-vps-handoff.js';
import type { VpsDeploymentExecutionResult } from '../main/vps-deployment-executor.js';

function result(state: VpsDeploymentExecutionResult['state']): VpsDeploymentExecutionResult {
  return {
    state,
    planStatus: 'ready',
    canRetry: state !== 'success',
    commandStates: [],
    logs: [],
    manualBlockReasons: [],
  };
}

describe('local to VPS runtime handoff', () => {
  it('requires a new bot process and a fresh Discord-ready IPC signal', async () => {
    let now = 2_000;
    const statuses = [
      { bot: 'online', botPid: 10, lastHeartbeat: 1_900 },
      { bot: 'online', botPid: 20, lastHeartbeat: 1_900 },
      { bot: 'online', botPid: 20, lastHeartbeat: 2_000 },
    ];
    let statusIndex = 0;

    await waitForFreshLocalBotReady({
      readStatus: () => statuses[Math.min(statusIndex++, statuses.length - 1)]!,
      startedAfter: 2_000,
      previousBotPid: 10,
      now: () => now,
      wait: async () => { now += 100; },
    });

    expect(statusIndex).toBe(3);
  });

  it('rejects stale online state instead of treating it as a restored bot', async () => {
    let now = 2_000;
    await expect(waitForFreshLocalBotReady({
      readStatus: () => ({ bot: 'online', botPid: 10, lastHeartbeat: 1_999 }),
      startedAfter: 2_000,
      previousBotPid: 10,
      timeoutMs: 200,
      now: () => now,
      wait: async () => { now += 100; },
    })).rejects.toThrow('fresh Discord-ready signal');
  });

  it('waits until every managed local process has exited', async () => {
    let now = 0;
    let checks = 0;
    await waitForProcessIdsToExit([10, 20], {
      now: () => now,
      isAlive: () => checks++ < 3,
      wait: async () => { now += 100; },
    });
    expect(checks).toBeGreaterThanOrEqual(4);
  });

  it('stops local before VPS execution and leaves it stopped after success', async () => {
    const events: string[] = [];
    const output = await runLocalToVpsHandoff({
      localWasRunning: true,
      stopLocal: async () => { events.push('stop-local'); },
      quiesceVpsAfterFailure: async () => true,
      restoreLocal: async () => { events.push('restore-local'); },
      executeDeployment: async () => { events.push('start-vps'); return result('success'); },
    });
    expect(output.state).toBe('success');
    expect(events).toEqual(['stop-local', 'start-vps']);
  });

  it('restores the prior local runtime when VPS deployment fails', async () => {
    const restoreLocal = vi.fn().mockResolvedValue(undefined);
    const output = await runLocalToVpsHandoff({
      localWasRunning: true,
      stopLocal: vi.fn().mockResolvedValue(undefined),
      quiesceVpsAfterFailure: vi.fn().mockResolvedValue(true),
      restoreLocal,
      executeDeployment: async () => result('failure'),
    });
    expect(restoreLocal).toHaveBeenCalledOnce();
    expect(output.logs.at(-1)?.code).toBe('local-runtime-restored');
  });

  it('attempts to restore local when stopping it only partially succeeds', async () => {
    const restoreLocal = vi.fn().mockResolvedValue(undefined);
    const executeDeployment = vi.fn();
    await expect(runLocalToVpsHandoff({
      localWasRunning: true,
      stopLocal: vi.fn().mockRejectedValue(new Error('shutdown deadline exceeded')),
      quiesceVpsAfterFailure: vi.fn().mockResolvedValue(true),
      restoreLocal,
      executeDeployment,
    })).rejects.toThrow('shutdown deadline exceeded');
    expect(restoreLocal).toHaveBeenCalledOnce();
    expect(executeDeployment).not.toHaveBeenCalled();
  });

  it('fails closed without restoring local when a partial VPS stack cannot be stopped', async () => {
    const restoreLocal = vi.fn();
    const output = await runLocalToVpsHandoff({
      localWasRunning: true,
      stopLocal: vi.fn().mockResolvedValue(undefined),
      quiesceVpsAfterFailure: vi.fn().mockResolvedValue(false),
      restoreLocal,
      executeDeployment: async () => result('failure'),
    });
    expect(output.state).toBe('failure');
    expect(output.canRetry).toBe(false);
    expect(output.blockedReason).toContain('could not be proven stopped');
    expect(restoreLocal).not.toHaveBeenCalled();
  });

  it('does not restore local when failed-stack cleanup itself errors', async () => {
    const restoreLocal = vi.fn();
    const output = await runLocalToVpsHandoff({
      localWasRunning: true,
      stopLocal: vi.fn().mockResolvedValue(undefined),
      quiesceVpsAfterFailure: vi.fn().mockRejectedValue(new Error('SSH unavailable')),
      restoreLocal,
      executeDeployment: async () => result('failure'),
    });
    expect(output.blockedReason).toContain('could not be proven stopped');
    expect(restoreLocal).not.toHaveBeenCalled();
  });
});
