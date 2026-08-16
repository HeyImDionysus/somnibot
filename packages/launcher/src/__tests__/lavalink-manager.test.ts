import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({ userDataPath: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => testState.userDataPath },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../main/config-store.js', () => ({
  getConfig: () => ({}),
  saveConfig: vi.fn(),
}));

import {
  ensureCurrentLavalinkJar,
  isLavalinkJarPresent,
} from '../main/lavalink-manager';

describe('launcher-managed Lavalink artifact', () => {
  beforeEach(async () => {
    testState.userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'somnibot-lavalink-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fsp.rm(testState.userDataPath, { recursive: true, force: true });
  });

  it('treats an existing jar without a current-version receipt as stale', async () => {
    // Given a jar downloaded by an older launcher without a version receipt.
    const directory = path.join(testState.userDataPath, 'lavalink');
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'Lavalink.jar'), 'legacy-jar');

    // When launcher readiness checks the managed artifact.
    const isCurrent = isLavalinkJarPresent();

    // Then the stale jar is not accepted as the supported runtime.
    expect(isCurrent).toBe(false);
  });

  it('replaces an already-downloaded stale jar before launcher startup', async () => {
    // Given an installed Lavalink 4.0.8 jar and a successful 4.2.2 download.
    const directory = path.join(testState.userDataPath, 'lavalink');
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'Lavalink.jar'), 'legacy-jar');
    await fsp.writeFile(path.join(directory, 'Lavalink.version'), '4.0.8\n');
    const currentJar = Buffer.from('dave-capable-jar');
    const fetchMock = vi.fn(async () => new Response(currentJar, {
      status: 200,
      headers: { 'content-length': String(currentJar.length) },
    }));
    vi.stubGlobal('fetch', fetchMock);

    // When startup ensures the managed artifact is current.
    const result = await ensureCurrentLavalinkJar();

    // Then the stale jar is atomically replaced and stamped with the supported version.
    expect(result).toEqual({ ok: true });
    expect(await fsp.readFile(path.join(directory, 'Lavalink.jar'))).toEqual(currentJar);
    expect(await fsp.readFile(path.join(directory, 'Lavalink.version'), 'utf8')).toBe('4.2.2\n');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar',
      { redirect: 'follow' },
    );
  });
});
