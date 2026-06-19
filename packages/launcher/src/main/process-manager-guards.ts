export type ProcessReadyStatus = 'offline' | 'starting' | 'online' | 'error';

export function shouldApplyBotReadyTimeout(
  activeProcess: unknown | null,
  timeoutProcess: unknown,
  status: ProcessReadyStatus,
): boolean {
  return activeProcess === timeoutProcess && status === 'starting';
}
