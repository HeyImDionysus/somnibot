import { describe, expect, it, vi } from 'vitest';
import { bootstrapLauncher, LAUNCHER_APP_NAME } from './launcher-bootstrap.js';

describe('bootstrapLauncher', () => {
  it('sets the stable SomniBot app name before loading the main process', async () => {
    const calls: string[] = [];
    const setAppName = vi.fn((name: string) => {
      calls.push(`name:${name}`);
    });
    const setUserDataPath = vi.fn((userDataPath: string) => {
      calls.push(`userData:${userDataPath}`);
    });
    const getAppDataPath = vi.fn(() => 'C:\\Users\\test\\AppData\\Roaming');
    const getUserDataPath = vi.fn(() => 'C:\\Users\\test\\AppData\\Roaming\\Electron');
    const loadMain = vi.fn(async () => {
      calls.push('main');
    });

    await bootstrapLauncher({ setAppName, setUserDataPath, getAppDataPath, getUserDataPath, loadMain });

    expect(setAppName).toHaveBeenCalledWith(LAUNCHER_APP_NAME);
    expect(setUserDataPath).toHaveBeenCalledWith('C:\\Users\\test\\AppData\\Roaming\\@somnibot\\launcher');
    expect(loadMain).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      `name:${LAUNCHER_APP_NAME}`,
      'userData:C:\\Users\\test\\AppData\\Roaming\\@somnibot\\launcher',
      'main',
    ]);
  });

  it('preserves an explicit user-data directory for isolated runs', async () => {
    const setUserDataPath = vi.fn();
    const loadMain = vi.fn(async () => undefined);

    await bootstrapLauncher({
      setAppName: vi.fn(),
      setUserDataPath,
      getAppDataPath: () => 'C:\\Users\\test\\AppData\\Roaming',
      getUserDataPath: () => 'C:\\Users\\test\\AppData\\Local\\somnibot-smoke',
      loadMain,
    });

    expect(setUserDataPath).not.toHaveBeenCalled();
    expect(loadMain).toHaveBeenCalledOnce();
  });
});
