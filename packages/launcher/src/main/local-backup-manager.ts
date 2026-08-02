import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import {
  isManagedValkeyBackupName,
  isValidValkeyRdbHeader,
  shouldPruneBackup,
  VALKEY_RDB_HEADER_LENGTH,
} from './backup-integrity.js';

const LOCAL_BACKUP_RETENTION_DAYS = 14;
const LOCAL_BACKUP_INITIAL_DELAY_MS = 5 * 60_000;
const LOCAL_BACKUP_INTERVAL_MS = 24 * 60 * 60_000;
const execFileAsync = promisify(execFile);

export interface LocalBackupResult {
  ok: boolean;
  path?: string;
  error?: string;
}

let backupTimer: ReturnType<typeof setTimeout> | null = null;

function valkeySnapshotPath(): string {
  return path.join(app.getPath('userData'), 'valkey', 'data', 'dump.rdb');
}

function backupDirectory(): string {
  return path.join(app.getPath('userData'), 'backups', 'valkey');
}

function backupTimestamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function hasValidRdbHeader(filePath: string): Promise<boolean> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(VALKEY_RDB_HEADER_LENGTH);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && isValidValkeyRdbHeader(header);
  } finally {
    await handle.close();
  }
}

async function validateRdbFile(filePath: string): Promise<boolean> {
  if (!await hasValidRdbHeader(filePath)) return false;
  const candidates = process.platform === 'win32'
    ? [
        path.join(app.getPath('userData'), 'valkey', 'valkey-check-rdb.exe'),
        path.join(app.getPath('userData'), 'valkey', 'redis-check-rdb.exe'),
      ]
    : ['valkey-check-rdb', 'redis-check-rdb'];

  for (const checker of candidates) {
    try {
      await execFileAsync(checker, [filePath], { timeout: 15_000, windowsHide: true });
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      return false;
    }
  }
  return false;
}

async function pruneExpiredBackups(directory: string, nowMs: number): Promise<void> {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !isManagedValkeyBackupName(entry.name)) continue;
    const backupPath = path.join(directory, entry.name);
    const stat = await fsp.stat(backupPath);
    if (!shouldPruneBackup(stat.mtimeMs, nowMs, LOCAL_BACKUP_RETENTION_DAYS)) continue;
    await fsp.rm(backupPath, { force: true });
    await fsp.rm(`${backupPath}.sha256`, { force: true });
  }
}

export async function backupLocalValkeySnapshot(
  now = new Date(),
  validate = validateRdbFile,
): Promise<LocalBackupResult> {
  const sourcePath = valkeySnapshotPath();
  const directory = backupDirectory();
  const fileName = `valkey-${backupTimestamp(now)}.rdb`;
  const finalPath = path.join(directory, fileName);
  const partialPath = `${finalPath}.partial`;

  try {
    if (!await validate(sourcePath)) {
      return { ok: false, error: 'Local Valkey snapshot is missing or failed RDB validation.' };
    }

    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsp.copyFile(sourcePath, partialPath);
    if (!await validate(partialPath)) {
      await fsp.rm(partialPath, { force: true });
      return { ok: false, error: 'Copied local Valkey backup failed RDB header validation.' };
    }

    const checksum = createHash('sha256').update(await fsp.readFile(partialPath)).digest('hex');
    await fsp.rename(partialPath, finalPath);
    await fsp.chmod(finalPath, 0o600);
    await fsp.writeFile(`${finalPath}.sha256`, `${checksum}  ${fileName}\n`, { mode: 0o600 });
    await pruneExpiredBackups(directory, now.getTime());
    return { ok: true, path: finalPath };
  } catch (error) {
    await fsp.rm(partialPath, { force: true }).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function startLocalValkeyBackupSchedule(
  onResult?: (result: LocalBackupResult) => void,
): void {
  stopLocalValkeyBackupSchedule();
  const runAndSchedule = () => {
    void backupLocalValkeySnapshot().then((result) => onResult?.(result));
    backupTimer = setTimeout(runAndSchedule, LOCAL_BACKUP_INTERVAL_MS);
    backupTimer.unref?.();
  };
  backupTimer = setTimeout(runAndSchedule, LOCAL_BACKUP_INITIAL_DELAY_MS);
  backupTimer.unref?.();
}

export function stopLocalValkeyBackupSchedule(): void {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = null;
}
