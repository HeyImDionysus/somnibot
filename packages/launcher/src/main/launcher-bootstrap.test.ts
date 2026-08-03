import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapLauncher, LAUNCHER_APP_NAME } from './launcher-bootstrap.js';

describe('bootstrapLauncher', () => {
  it('sets the stable SomniBot app name before loading the main process', async () => {
    const calls: string[] = [];
    const appDataPath = path.join('test-app-data');
    const stableUserDataPath = path.join(appDataPath, LAUNCHER_APP_NAME);
    const setAppName = vi.fn((name: string) => {
      calls.push(`name:${name}`);
    });
    const setUserDataPath = vi.fn((userDataPath: string) => {
      calls.push(`userData:${userDataPath}`);
    });
    const getAppDataPath = vi.fn(() => appDataPath);
    const getUserDataPath = vi.fn(() => path.join(appDataPath, 'Electron'));
    const loadMain = vi.fn(async () => {
      calls.push('main');
    });

    await bootstrapLauncher({ setAppName, setUserDataPath, getAppDataPath, getUserDataPath, loadMain });

    expect(setAppName).toHaveBeenCalledWith(LAUNCHER_APP_NAME);
    expect(setUserDataPath).toHaveBeenCalledWith(stableUserDataPath);
    expect(loadMain).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      `name:${LAUNCHER_APP_NAME}`,
      `userData:${stableUserDataPath}`,
      'main',
    ]);
  });

  it('preserves an explicit user-data directory for isolated runs', async () => {
    const setUserDataPath = vi.fn();
    const loadMain = vi.fn(async () => undefined);

    await bootstrapLauncher({
      setAppName: vi.fn(),
      setUserDataPath,
      getAppDataPath: () => path.join('test-app-data'),
      getUserDataPath: () => path.join('test-local-data', 'somnibot-smoke'),
      loadMain,
    });

    expect(setUserDataPath).not.toHaveBeenCalled();
    expect(loadMain).toHaveBeenCalledOnce();
  });
});
