import { createHash, randomUUID } from 'node:crypto';
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

export type LocalBackupResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly checksumSha256: string;
      readonly capturedAt: string;
    }
  | { readonly ok: false; readonly error: string };

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

export async function validateRdbFile(filePath: string): Promise<boolean> {
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

export async function prepareIncomingLocalValkeySnapshotPath(): Promise<string> {
  const directory = path.join(app.getPath('userData'), '.runtime-handoff');
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700);
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^vps-valkey-[0-9a-f-]+\.rdb\.partial$/i.test(entry.name)) {
      await fsp.rm(path.join(directory, entry.name), { force: true });
    }
  }
  return path.join(directory, `vps-valkey-${randomUUID()}.rdb.partial`);
}

export async function discardIncomingLocalValkeySnapshot(filePath: string): Promise<void> {
  await fsp.rm(filePath, { force: true });
  await fsp.rmdir(path.dirname(filePath)).catch(() => undefined);
}

export async function installIncomingLocalValkeySnapshot(
  incomingPath: string,
  validate = validateRdbFile,
): Promise<LocalBackupResult> {
  const finalPath = valkeySnapshotPath();
  const dataDirectory = path.dirname(finalPath);
  const transferId = randomUUID();
  const partialPath = path.join(dataDirectory, `.dump-${transferId}.rdb.partial`);
  const previousPath = path.join(dataDirectory, `.dump-${transferId}.rdb.previous`);
  let movedPrevious = false;
  let previousWasValid = false;

  try {
    if (!await validate(incomingPath)) {
      return { ok: false, error: 'Transferred VPS Valkey snapshot failed local RDB validation.' };
    }
    await fsp.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await fsp.copyFile(incomingPath, partialPath);
    await fsp.chmod(partialPath, 0o600);
    if (!await validate(partialPath)) {
      return { ok: false, error: 'Copied VPS Valkey snapshot failed local RDB validation.' };
    }

    try {
      await fsp.access(finalPath);
      previousWasValid = await validate(finalPath);
      if (previousWasValid) {
        const backup = await backupLocalValkeySnapshot(new Date(), validate);
        if (!backup.ok) {
          return { ok: false, error: backup.error || 'Existing local Valkey state could not be backed up before handoff.' };
        }
      }
      await fsp.rename(finalPath, previousPath);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    try {
      await fsp.rename(partialPath, finalPath);
    } catch (error) {
      if (movedPrevious) await fsp.rename(previousPath, finalPath).catch(() => undefined);
      throw error;
    }
    await fsp.chmod(finalPath, 0o600);
    const installedChecksum = createHash('sha256').update(await fsp.readFile(finalPath)).digest('hex');
    if (movedPrevious && previousWasValid) await fsp.rm(previousPath, { force: true });
    await discardIncomingLocalValkeySnapshot(incomingPath);
    return {
      ok: true,
      path: finalPath,
      checksumSha256: installedChecksum,
      capturedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await fsp.rm(partialPath, { force: true }).catch(() => undefined);
  }
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
    return {
      ok: true,
      path: finalPath,
      checksumSha256: checksum,
      capturedAt: now.toISOString(),
    };
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
