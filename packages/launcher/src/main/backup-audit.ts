import type { LauncherAuditEntry } from './audit-log.js';
import type { LocalBackupResult } from './local-backup-manager.js';

export function buildLocalBackupAuditEntry(result: LocalBackupResult): LauncherAuditEntry {
  if (result.ok) {
    return {
      action: 'launcher.backup.valkey_succeeded',
      category: 'infrastructure',
      targetType: 'local_valkey',
      targetId: result.checksumSha256,
      occurrenceKey: `launcher.backup.valkey_succeeded:${result.capturedAt}`,
      details: {
        mode: 'regular-local',
        status: 'current',
        checksumSha256: result.checksumSha256,
        capturedAt: result.capturedAt,
      },
    };
  }
  return {
    action: 'launcher.backup.valkey_failed',
    category: 'infrastructure',
    targetType: 'local_valkey',
    details: { mode: 'regular-local' },
    success: false,
    errorMessage: result.error,
  };
}
