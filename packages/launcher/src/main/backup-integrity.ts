export const VALKEY_RDB_HEADER_LENGTH = 9;

export function isValidValkeyRdbHeader(header: Uint8Array): boolean {
  if (header.length < VALKEY_RDB_HEADER_LENGTH) return false;
  const text = Buffer.from(header.subarray(0, VALKEY_RDB_HEADER_LENGTH)).toString('ascii');
  return /^REDIS\d{4}$/.test(text);
}

export function isManagedValkeyBackupName(name: string): boolean {
  return /^valkey-\d{8}T\d{6}Z\.rdb$/.test(name);
}

export function shouldPruneBackup(modifiedAtMs: number, nowMs: number, retentionDays: number): boolean {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('Backup retention must be a positive integer.');
  }
  return modifiedAtMs < nowMs - retentionDays * 24 * 60 * 60 * 1_000;
}
