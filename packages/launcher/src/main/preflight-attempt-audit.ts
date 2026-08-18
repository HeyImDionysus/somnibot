import {
  buildLauncherAttemptAuditEntry,
  LauncherAttemptTracker,
  type LauncherAttemptCode,
  type LauncherAttemptResult,
  type LauncherAuditEntry,
} from './audit-log.js';

export interface PreflightAttemptAuditOptions {
  readonly createOperationId: () => string;
  readonly now: () => string;
  readonly recordAudit: (entry: LauncherAuditEntry) => void;
}

export interface PreflightAttemptAudit {
  record(result: LauncherAttemptResult, code: LauncherAttemptCode): void;
}

export function createPreflightAttemptAudit(options: PreflightAttemptAuditOptions): PreflightAttemptAudit {
  const tracker = new LauncherAttemptTracker(options.createOperationId);

  return {
    record(result, code): void {
      const identity = tracker.next('vps-preflight');
      options.recordAudit(buildLauncherAttemptAuditEntry({
        operationId: identity.operationId,
        attempt: identity.attempt,
        phase: 'vps-preflight',
        result,
        code,
        message: '',
        timestamp: options.now(),
      }));
      tracker.finish('vps-preflight', result);
    },
  };
}
