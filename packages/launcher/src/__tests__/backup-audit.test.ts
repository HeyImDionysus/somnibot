import { describe, expect, it } from 'vitest';
import { buildLocalBackupAuditEntry } from '../main/backup-audit.js';

describe('local backup audit evidence', () => {
  it('records checksum evidence without recording the local backup path', () => {
    const entry = buildLocalBackupAuditEntry({
      ok: true,
      path: 'C:\\private\\backup.rdb',
      checksumSha256: 'a'.repeat(64),
      capturedAt: '2026-08-23T04:00:00.000Z',
    });

    expect(entry).toMatchObject({
      action: 'launcher.backup.valkey_succeeded',
      targetId: 'a'.repeat(64),
      details: { status: 'current', capturedAt: '2026-08-23T04:00:00.000Z' },
    });
    expect(JSON.stringify(entry)).not.toContain('private');
  });

  it('records failed backup evidence for guided recovery', () => {
    expect(buildLocalBackupAuditEntry({ ok: false, error: 'RDB validation failed' })).toMatchObject({
      action: 'launcher.backup.valkey_failed',
      success: false,
      errorMessage: 'RDB validation failed',
    });
  });
});
