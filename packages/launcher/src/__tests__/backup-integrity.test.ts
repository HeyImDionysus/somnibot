import { describe, expect, it } from 'vitest';
import {
  isManagedValkeyBackupName,
  isValidValkeyRdbHeader,
  shouldPruneBackup,
} from '../main/backup-integrity';

describe('local Valkey backup integrity policy', () => {
  it('accepts only a versioned Redis RDB header', () => {
    expect(isValidValkeyRdbHeader(Buffer.from('REDIS0011payload'))).toBe(true);
    expect(isValidValkeyRdbHeader(Buffer.from('not-an-rdb'))).toBe(false);
    expect(isValidValkeyRdbHeader(Buffer.from('REDIS123'))).toBe(false);
  });

  it('only manages SomniBot timestamped Valkey backup files', () => {
    expect(isManagedValkeyBackupName('valkey-20260802T150000Z.rdb')).toBe(true);
    expect(isManagedValkeyBackupName('../dump.rdb')).toBe(false);
    expect(isManagedValkeyBackupName('valkey-latest.rdb')).toBe(false);
  });

  it('prunes files older than the retention window and rejects invalid policy', () => {
    const now = Date.UTC(2026, 7, 20);
    expect(shouldPruneBackup(now - 15 * 86_400_000, now, 14)).toBe(true);
    expect(shouldPruneBackup(now - 13 * 86_400_000, now, 14)).toBe(false);
    expect(() => shouldPruneBackup(now, now, 0)).toThrow('positive integer');
  });
});
