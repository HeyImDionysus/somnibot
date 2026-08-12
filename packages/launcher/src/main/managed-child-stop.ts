import type { ChildProcess } from 'node:child_process';

export interface ManagedChildStopOptions {
  graceMs?: number;
  forceExitMs?: number;
  serviceName?: string;
}

/** Stop a child and resolve only after Node observes its close event. */
export function stopChildProcess(
  child: ChildProcess | null,
  options: ManagedChildStopOptions = {},
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  const graceMs = options.graceMs ?? 5_000;
  const forceExitMs = options.forceExitMs ?? 5_000;
  const serviceName = options.serviceName ?? 'managed child';

  // Normal lifecycle listeners can schedule a restart. Shutdown owns the child
  // from this point forward and installs its own close/error observers.
  child.removeAllListeners();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let forceExitTimer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      clearTimeout(forceKillTimer);
      if (forceExitTimer) clearTimeout(forceExitTimer);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onClose = () => finish();
    const onError = (error: Error) => fail(new Error(`${serviceName} shutdown failed: ${error.message}`));
    const processAlreadyExited = () => child.exitCode !== null || child.signalCode !== null;
    const signal = (name: NodeJS.Signals): boolean => {
      try {
        return child.kill(name);
      } catch (error) {
        if (processAlreadyExited()) {
          finish();
          return true;
        }
        fail(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    };
    const forceKillTimer = setTimeout(() => {
      if (!signal('SIGKILL')) {
        if (!processAlreadyExited()) fail(new Error(`${serviceName} rejected SIGKILL.`));
        return;
      }
      forceExitTimer = setTimeout(() => {
        fail(new Error(`${serviceName} did not exit after SIGKILL.`));
      }, forceExitMs);
      forceExitTimer.unref?.();
    }, graceMs);

    forceKillTimer.unref?.();
    child.once('close', onClose);
    child.once('error', onError);
    if (!signal('SIGTERM') && !processAlreadyExited()) {
      fail(new Error(`${serviceName} rejected SIGTERM.`));
    }
  });
}
