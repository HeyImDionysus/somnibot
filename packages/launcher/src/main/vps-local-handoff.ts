export type VpsToLocalHandoffResult<LocalResult, RecoveryResult> =
  | { state: 'success'; localResult: LocalResult }
  | { state: 'vps-stop-unproven'; recovery: RecoveryResult }
  | { state: 'vps-release-unproven'; error: unknown; recovery: RecoveryResult }
  | { state: 'local-failed'; localResult?: LocalResult; error?: unknown; recovery: RecoveryResult };

export async function runVpsToLocalHandoff<LocalResult, RecoveryResult>(options: {
  stopVps: () => Promise<boolean>;
  waitForVpsStopped: () => Promise<void>;
  startLocal: () => Promise<LocalResult>;
  isLocalReady: (result: LocalResult) => boolean;
  restoreVps: (reason: 'stop-unproven' | 'release-unproven' | 'local-failed') => Promise<RecoveryResult>;
}): Promise<VpsToLocalHandoffResult<LocalResult, RecoveryResult>> {
  const stopped = await options.stopVps();
  if (!stopped) {
    return {
      state: 'vps-stop-unproven',
      recovery: await options.restoreVps('stop-unproven'),
    };
  }

  try {
    await options.waitForVpsStopped();
  } catch (error) {
    return {
      state: 'vps-release-unproven',
      error,
      recovery: await options.restoreVps('release-unproven'),
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
      recovery: await options.restoreVps('local-failed'),
    };
  } catch (error) {
    return {
      state: 'local-failed',
      error,
      recovery: await options.restoreVps('local-failed'),
    };
  }
}
