import { describe, expect, it, vi } from 'vitest';
import { runLocalToVpsHandoff, waitForProcessIdsToExit } from '../main/local-vps-handoff.js';
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
      restoreLocal,
      executeDeployment: async () => result('failure'),
    });
    expect(restoreLocal).toHaveBeenCalledOnce();
    expect(output.logs.at(-1)?.code).toBe('local-runtime-restored');
  });
});
