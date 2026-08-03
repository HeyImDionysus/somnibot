import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({ userDataPath: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => testState.userDataPath },
}));

import {
  backupLocalValkeySnapshot,
  installIncomingLocalValkeySnapshot,
  prepareIncomingLocalValkeySnapshotPath,
} from '../main/local-backup-manager';

describe('local Valkey backup manager', () => {
  beforeEach(async () => {
    testState.userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'somnibot-local-backup-'));
  });

  afterEach(async () => {
    await fsp.rm(testState.userDataPath, { recursive: true, force: true });
  });

  it('copies a valid persistent snapshot and writes a matching checksum', async () => {
    const dataDir = path.join(testState.userDataPath, 'valkey', 'data');
    await fsp.mkdir(dataDir, { recursive: true });
    const source = Buffer.from('REDIS0011synthetic-test-payload');
    await fsp.writeFile(path.join(dataDir, 'dump.rdb'), source);

    const result = await backupLocalValkeySnapshot(
      new Date('2026-08-02T15:00:00Z'),
      async () => true,
    );

    expect(result).toEqual({
      ok: true,
      path: path.join(testState.userDataPath, 'backups', 'valkey', 'valkey-20260802T150000Z.rdb'),
    });
    const copied = await fsp.readFile(result.path!);
    expect(copied).toEqual(source);
    const checksum = createHash('sha256').update(source).digest('hex');
    expect(await fsp.readFile(`${result.path}.sha256`, 'utf8'))
      .toBe(`${checksum}  valkey-20260802T150000Z.rdb\n`);
  });

  it('fails without creating a backup when the source is absent', async () => {
    const result = await backupLocalValkeySnapshot(
      new Date('2026-08-02T15:00:00Z'),
      async (filePath) => fsp.access(filePath).then(() => true, () => false),
    );

    expect(result.ok).toBe(false);
    await expect(fsp.access(path.join(testState.userDataPath, 'backups'))).rejects.toThrow();
  });

  it('validates and atomically installs VPS state while backing up existing local state', async () => {
    const dataDir = path.join(testState.userDataPath, 'valkey', 'data');
    await fsp.mkdir(dataDir, { recursive: true });
    const oldSnapshot = Buffer.from('REDIS0011old-local-state');
    const vpsSnapshot = Buffer.from('REDIS0011current-vps-state');
    await fsp.writeFile(path.join(dataDir, 'dump.rdb'), oldSnapshot);
    const incomingPath = await prepareIncomingLocalValkeySnapshotPath();
    await fsp.writeFile(incomingPath, vpsSnapshot);
    const validate = async (filePath: string) => (await fsp.readFile(filePath)).subarray(0, 5).toString() === 'REDIS';

    const result = await installIncomingLocalValkeySnapshot(incomingPath, validate);

    expect(result.ok).toBe(true);
    expect(await fsp.readFile(path.join(dataDir, 'dump.rdb'))).toEqual(vpsSnapshot);
    await expect(fsp.access(incomingPath)).rejects.toThrow();
    const backups = await fsp.readdir(path.join(testState.userDataPath, 'backups', 'valkey'));
    const backupFile = backups.find((name) => name.endsWith('.rdb'))!;
    expect(await fsp.readFile(path.join(testState.userDataPath, 'backups', 'valkey', backupFile))).toEqual(oldSnapshot);
  });

  it('removes only managed orphaned handoff files before reserving a new transfer path', async () => {
    const directory = path.join(testState.userDataPath, '.runtime-handoff');
    await fsp.mkdir(directory, { recursive: true });
    const orphan = path.join(directory, 'vps-valkey-11111111-1111-4111-8111-111111111111.rdb.partial');
    const unrelated = path.join(directory, 'owner-note.txt');
    await fsp.writeFile(orphan, 'stale');
    await fsp.writeFile(unrelated, 'preserve');

    const reserved = await prepareIncomingLocalValkeySnapshotPath();

    await expect(fsp.access(orphan)).rejects.toThrow();
    expect(await fsp.readFile(unrelated, 'utf8')).toBe('preserve');
    expect(path.dirname(reserved)).toBe(directory);
  });

  it('refuses an invalid VPS snapshot without changing the existing local state', async () => {
    const dataDir = path.join(testState.userDataPath, 'valkey', 'data');
    await fsp.mkdir(dataDir, { recursive: true });
    const oldSnapshot = Buffer.from('REDIS0011old-local-state');
    await fsp.writeFile(path.join(dataDir, 'dump.rdb'), oldSnapshot);
    const incomingPath = await prepareIncomingLocalValkeySnapshotPath();
    await fsp.writeFile(incomingPath, 'not-an-rdb');
    const validate = async (filePath: string) => (await fsp.readFile(filePath)).subarray(0, 5).toString() === 'REDIS';

    const result = await installIncomingLocalValkeySnapshot(incomingPath, validate);

    expect(result.ok).toBe(false);
    expect(await fsp.readFile(path.join(dataDir, 'dump.rdb'))).toEqual(oldSnapshot);
  });
});
