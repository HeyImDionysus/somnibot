import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const mocks = vi.hoisted(() => ({
  fork: vi.fn(() => new EventEmitter()),
  getConfig: vi.fn(() => ({
    lastPids: { bot: null, dashboard: null, lavalink: null, valkey: null },
    lastPidStartedAt: { bot: null, dashboard: null, lavalink: null, valkey: null },
  })),
  saveConfig: vi.fn(),
  stopChildProcess: vi.fn(() => Promise.resolve()),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(),
  fork: mocks.fork,
}));

vi.mock('../main/config-store.js', () => ({
  getConfig: mocks.getConfig,
  saveConfig: mocks.saveConfig,
}));

vi.mock('../main/lavalink-manager.js', () => ({
  getLavalinkPid: () => null,
  getLavalinkStatus: () => 'offline',
}));

vi.mock('../main/managed-child-stop.js', () => ({
  stopChildProcess: mocks.stopChildProcess,
}));

import {
  createDashboardSessionTokenFile,
  getStatus,
  onStatusUpdate,
  startAll,
  stopAll,
} from '../main/process-manager.js';

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await stopAll();
  mocks.fork.mockClear();
  mocks.stopChildProcess.mockClear();
});

describe('launcher dashboard session-token transport', () => {
  it('passes only a restrictive, single-use token-file path to the dashboard child', async () => {
    // Given: a local dashboard session token and no token in the service environment.
    const sessionToken = 'token-for-file-transport';

    // When: the launcher starts its services.
    await startAll({ DASHBOARD_SAFE_VALUE: 'safe', SESSION_TOKEN: 'must-not-reach-child' }, sessionToken);

    // Then: the dashboard child gets a unique 0600 token file, never SESSION_TOKEN.
    expect(mocks.fork).toHaveBeenCalledTimes(2);
    const dashboardEnv = mocks.fork.mock.calls[0]?.[2]?.env;
    expect(dashboardEnv).toBeDefined();
    expect(dashboardEnv).not.toHaveProperty('SESSION_TOKEN');
    expect(dashboardEnv).toHaveProperty('SESSION_TOKEN_FILE');
    const botEnv = mocks.fork.mock.calls[1]?.[2]?.env;
    expect(botEnv).not.toHaveProperty('SESSION_TOKEN');

    const tokenFile = dashboardEnv?.SESSION_TOKEN_FILE;
    expect(tokenFile).toBeDefined();
    if (!tokenFile) throw new Error('dashboard token file path was not provided');

    expect(fs.readFileSync(tokenFile, 'utf8')).toBe(sessionToken);
    if (process.platform === 'win32') {
      const accessControlList = execFileSync('icacls', [tokenFile], { encoding: 'utf8' });
      expect(accessControlList).toContain(process.env.USERNAME + ':(R,W)');
    } else {
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    }

    const nextTokenFile = createDashboardSessionTokenFile(sessionToken);
    expect(nextTokenFile).not.toBe(tokenFile);

    fs.rmSync(nextTokenFile, { force: true });
  });

  it('removes the token file when the dashboard exits or is stopped', async () => {
    await startAll({ DASHBOARD_SAFE_VALUE: 'safe' }, 'token-cleanup');
    const tokenFile = mocks.fork.mock.calls[0]?.[2]?.env?.SESSION_TOKEN_FILE;
    expect(tokenFile).toBeDefined();
    if (!tokenFile) throw new Error('dashboard token file path was not provided');

    const dashboard = mocks.fork.mock.results[0]?.value;
    if (!(dashboard instanceof EventEmitter)) throw new Error('dashboard child was not created');
    dashboard.emit('exit', 1, null);

    expect(fs.existsSync(tokenFile)).toBe(false);
    await stopAll();
  });

  it('removes the token file when the dashboard emits an error', async () => {
    await startAll({ DASHBOARD_SAFE_VALUE: 'safe' }, 'token-error-cleanup');
    const tokenFile = mocks.fork.mock.calls[0]?.[2]?.env?.SESSION_TOKEN_FILE;
    expect(tokenFile).toBeDefined();
    if (!tokenFile) throw new Error('dashboard token file path was not provided');

    const dashboard = mocks.fork.mock.results[0]?.value;
    if (!(dashboard instanceof EventEmitter)) throw new Error('dashboard child was not created');
    dashboard.emit('error', new Error('dashboard failed'));

    expect(fs.existsSync(tokenFile)).toBe(false);
    await stopAll();
  });

  it('removes the token file during normal shutdown', async () => {
    await startAll({ DASHBOARD_SAFE_VALUE: 'safe' }, 'token-stop-cleanup');
    const tokenFile = mocks.fork.mock.calls[0]?.[2]?.env?.SESSION_TOKEN_FILE;
    expect(tokenFile).toBeDefined();
    if (!tokenFile) throw new Error('dashboard token file path was not provided');

    await stopAll();

    expect(fs.existsSync(tokenFile)).toBe(false);
  });

  it('removes the token file when dashboard fork throws', async () => {
    const writeFile = vi.spyOn(fs, 'writeFileSync');
    mocks.fork.mockImplementationOnce(() => {
      throw new Error('dashboard fork failed');
    });

    const start = startAll({ DASHBOARD_SAFE_VALUE: 'safe' }, 'fork-failure-token');

    await expect(start).rejects.toThrow('dashboard fork failed');
    const tokenFile = writeFile.mock.calls
      .map(([file]) => file)
      .find((file) => typeof file === 'string' && file.includes('somnibot-launcher'));
    if (typeof tokenFile !== 'string') throw new Error('token file was not created before fork failure');
    expect(fs.existsSync(tokenFile)).toBe(false);
  });

  it('removes the previous token file before replacing the dashboard', async () => {
    await startAll({ DASHBOARD_SAFE_VALUE: 'safe' }, 'first-token');
    const firstTokenFile = mocks.fork.mock.calls[0]?.[2]?.env?.SESSION_TOKEN_FILE;
    expect(firstTokenFile).toBeDefined();
    if (!firstTokenFile) throw new Error('first dashboard token file path was not provided');

    await startAll({ DASHBOARD_SAFE_VALUE: 'safe' }, 'second-token');

    expect(fs.existsSync(firstTokenFile)).toBe(false);
  });

  it('keeps recovery bounded when token-file creation fails', async () => {
    vi.useFakeTimers();
    let lastStatusError: string | undefined;
    onStatusUpdate((status) => {
      lastStatusError = status.error;
    });
    await startAll({ DASHBOARD_SAFE_VALUE: 'safe' }, 'recovery-token');
    const dashboard = mocks.fork.mock.results[0]?.value;
    if (!(dashboard instanceof EventEmitter)) throw new Error('dashboard child was not created');
    dashboard.emit('exit', 1, null);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('temporary directory unavailable');
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocks.fork).toHaveBeenCalledTimes(2);
    expect(getStatus().dashboard).toBe('error');
    expect(lastStatusError).toContain('Dashboard restart failed');
  });

  it('stops and cleans up the dashboard when bot startup throws', async () => {
    mocks.fork.mockImplementationOnce(() => new EventEmitter());
    mocks.fork.mockImplementationOnce(() => {
      throw new Error('bot startup failed');
    });

    const start = startAll({ DASHBOARD_SAFE_VALUE: 'safe' }, 'transaction-token');
    const tokenFile = mocks.fork.mock.calls[0]?.[2]?.env?.SESSION_TOKEN_FILE;
    expect(tokenFile).toBeDefined();
    if (!tokenFile) throw new Error('dashboard token file path was not provided');
    const dashboard = mocks.fork.mock.results[0]?.value;
    if (!(dashboard instanceof EventEmitter)) throw new Error('dashboard child was not created');

    await expect(start).rejects.toThrow('bot startup failed');
    expect(mocks.stopChildProcess).toHaveBeenCalledWith(
      dashboard,
      { serviceName: 'SomniBot bot/dashboard child' },
    );
    expect(fs.existsSync(tokenFile)).toBe(false);
  });

  it('fails closed before spawning a child when token-file creation fails', async () => {
    // Given: the token-file directory cannot be created.
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('temporary directory unavailable');
    });

    // When: the launcher starts its services.
    const start = startAll({ DASHBOARD_SAFE_VALUE: 'safe' }, 'token-that-must-not-fallback');

    // Then: it reports the transport failure and launches no child with an env fallback.
    await expect(start).rejects.toThrow('Dashboard session-token file could not be created');
    expect(mocks.fork).not.toHaveBeenCalled();
  });
});
