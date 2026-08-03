export type VpsToLocalHandoffResult<LocalResult, RecoveryResult> =
  | { state: 'success'; localResult: LocalResult }
  | { state: 'vps-stop-failed' }
  | { state: 'vps-release-unproven'; error: unknown; recovery: RecoveryResult }
  | { state: 'local-failed'; localResult?: LocalResult; error?: unknown; recovery: RecoveryResult };

export async function runVpsToLocalHandoff<LocalResult, RecoveryResult>(options: {
  stopVps: () => Promise<boolean>;
  waitForVpsStopped: () => Promise<void>;
  startLocal: () => Promise<LocalResult>;
  isLocalReady: (result: LocalResult) => boolean;
  restoreVps: () => Promise<RecoveryResult>;
}): Promise<VpsToLocalHandoffResult<LocalResult, RecoveryResult>> {
  const stopped = await options.stopVps();
  if (!stopped) return { state: 'vps-stop-failed' };

  try {
    await options.waitForVpsStopped();
  } catch (error) {
    return {
      state: 'vps-release-unproven',
      error,
      recovery: await options.restoreVps(),
    };
  }

  try {
    const localResult = await options.startLocal();
    if (options.isLocalReady(localResult)) {
      return { state: 'success', localResult };
    }
    return {
      state: 'local-failed',
      localResult,
      recovery: await options.restoreVps(),
    };
  } catch (error) {
    return {
      state: 'local-failed',
      error,
      recovery: await options.restoreVps(),
    };
  }
}
