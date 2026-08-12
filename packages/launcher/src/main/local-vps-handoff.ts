import type { VpsDeploymentExecutionResult } from './vps-deployment-executor.js';

interface LocalBotStatus {
  bot: string;
  botPid?: number;
  lastHeartbeat?: number;
}

export function shouldTransferLocalValkeyState(
  localWasRunning: boolean,
  lastSuccessfulRuntimeMode: 'regular-local' | 'vps' | undefined,
): boolean {
  return localWasRunning || lastSuccessfulRuntimeMode === 'regular-local';
}

export async function waitForFreshLocalBotReady(
  options: {
    readStatus: () => LocalBotStatus;
    startedAfter: number;
    previousBotPid?: number;
    wait?: (delayMs: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  },
): Promise<void> {
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 65_000);

  while (true) {
    const status = options.readStatus();
    const hasFreshProcess = Number.isInteger(status.botPid)
      && status.botPid !== undefined
      && (options.previousBotPid === undefined || status.botPid !== options.previousBotPid);
    const hasFreshReadySignal = status.lastHeartbeat !== undefined
      && status.lastHeartbeat >= options.startedAfter;
    if (status.bot === 'online' && hasFreshProcess && hasFreshReadySignal) return;

    if (now() >= deadline) {
      throw new Error('The restored local bot did not report a fresh Discord-ready signal before the recovery deadline.');
    }
    await wait(100);
  }
}

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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      // EPERM and unknown probe failures cannot prove the process exited.
      // Keep waiting and fail closed at the handoff deadline.
      return true;
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
  prepareVpsState?: () => Promise<void>;
  quiesceVpsAfterFailure: (result?: VpsDeploymentExecutionResult) => Promise<boolean>;
  restoreLocal: () => Promise<void>;
  executeDeployment: () => Promise<VpsDeploymentExecutionResult>;
}): Promise<VpsDeploymentExecutionResult> {
  if (!options.localWasRunning) {
    await options.prepareVpsState?.();

    // A first deployment can still leave a partially-started VPS stack behind
    // (for example after Valkey restore or compose startup).  The local
    // runtime was not active, so there is nothing to restore, but the remote
    // owner must be quiesced before returning a retryable result.  Without
    // this branch a stopped launcher can orphan the remote runtime and its
    // maintenance lock indefinitely.
    let result: VpsDeploymentExecutionResult;
    try {
      result = await options.executeDeployment();
    } catch (error) {
      const remoteQuiesced = await options.quiesceVpsAfterFailure().catch(() => false);
      if (!remoteQuiesced) {
        throw new AggregateError(
          [error, new Error('The failed VPS stack could not be proven stopped.')],
          'VPS deployment failed and remote cleanup was not proven.',
        );
      }
      throw error;
    }
    if (result.state === 'success') return result;

    const remoteQuiesced = await options.quiesceVpsAfterFailure(result).catch(() => false);
    if (remoteQuiesced) return result;

    return {
      ...result,
      state: 'failure',
      canRetry: false,
      blockedReason: 'The failed VPS stack could not be proven stopped. No local runtime was active, so the remote runtime remains blocked until an operator verifies cleanup.',
      logs: [
        ...result.logs,
        {
          level: 'error',
          code: 'vps-runtime-quiesce-unproven',
          message: 'The failed VPS runtime may still be active; no local runtime was restarted.',
        },
      ],
    };
  }

  try {
    await options.stopLocal();
    await options.prepareVpsState?.();
  } catch (error) {
    // A failed stop may be partial. Starting another local stack here could
    // duplicate an orphaned bot, so leave recovery blocked until the operator
    // can prove the original process set is quiescent.
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
