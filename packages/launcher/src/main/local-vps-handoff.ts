import type { VpsDeploymentExecutionResult } from './vps-deployment-executor.js';

export async function waitForProcessIdsToExit(
  processIds: Array<number | undefined>,
  options: {
    isAlive?: (pid: number) => boolean;
    wait?: (delayMs: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const ids = processIds.filter((pid): pid is number => Number.isInteger(pid) && Number(pid) > 0);
  if (ids.length === 0) return;
  const isAlive = options.isAlive ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 8_000);

  while (ids.some(isAlive)) {
    if (now() >= deadline) throw new Error('Local SomniBot processes did not stop before the VPS handoff deadline.');
    await wait(100);
  }
}

export async function runLocalToVpsHandoff(options: {
  localWasRunning: boolean;
  stopLocal: () => Promise<void>;
  quiesceVpsAfterFailure: (result?: VpsDeploymentExecutionResult) => Promise<boolean>;
  restoreLocal: () => Promise<void>;
  executeDeployment: () => Promise<VpsDeploymentExecutionResult>;
}): Promise<VpsDeploymentExecutionResult> {
  if (!options.localWasRunning) return options.executeDeployment();

  try {
    await options.stopLocal();
  } catch (error) {
    await options.restoreLocal();
    throw error;
  }

  let result: VpsDeploymentExecutionResult;
  try {
    result = await options.executeDeployment();
  } catch (error) {
    const remoteQuiesced = await options.quiesceVpsAfterFailure().catch(() => false);
    if (remoteQuiesced) await options.restoreLocal();
    throw error;
  }
  if (result.state === 'success') return result;

  const remoteQuiesced = await options.quiesceVpsAfterFailure(result).catch(() => false);
  if (!remoteQuiesced) {
    return {
      ...result,
      state: 'failure',
      canRetry: false,
      blockedReason: 'The failed VPS stack could not be proven stopped. Local SomniBot was not restarted to prevent duplicate runtimes.',
      logs: [
        ...result.logs,
        {
          level: 'error',
          code: 'vps-runtime-quiesce-unproven',
          message: 'The failed VPS runtime may still be active; local restoration was blocked.',
        },
      ],
    };
  }

  await options.restoreLocal();
  return {
    ...result,
    logs: [
      ...result.logs,
      {
        level: 'warn',
        code: 'local-runtime-restored',
        message: 'Local SomniBot was restored after the VPS deployment did not complete.',
      },
    ],
  };
}
