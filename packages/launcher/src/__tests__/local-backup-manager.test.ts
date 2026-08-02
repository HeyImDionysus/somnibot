import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({ userDataPath: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => testState.userDataPath },
}));

import { backupLocalValkeySnapshot } from '../main/local-backup-manager';

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
});
