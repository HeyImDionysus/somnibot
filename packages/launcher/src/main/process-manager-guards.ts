export type ProcessReadyStatus = 'offline' | 'starting' | 'online' | 'error';

export const PROCESS_RESTART_MAX_ATTEMPTS = 5;
export const PROCESS_RESTART_BASE_DELAY_MS = 1_000;
export const PROCESS_RESTART_MAX_DELAY_MS = 30_000;
export const PROCESS_RESTART_STABLE_WINDOW_MS = 5 * 60_000;

export function processRestartDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('Restart attempt must be a positive integer.');
  }
  return Math.min(
    PROCESS_RESTART_BASE_DELAY_MS * (2 ** (attempt - 1)),
    PROCESS_RESTART_MAX_DELAY_MS,
  );
}

export function shouldRecoverManagedProcess(
  desiredRunning: boolean,
  activeProcess: unknown | null,
  eventProcess: unknown,
): boolean {
  return desiredRunning && activeProcess === eventProcess;
}

export function shouldApplyBotReadyTimeout(
  activeProcess: unknown | null,
  timeoutProcess: unknown,
  status: ProcessReadyStatus,
): boolean {
  return activeProcess === timeoutProcess && status === 'starting';
}
