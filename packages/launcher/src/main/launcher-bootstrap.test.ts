import { describe, expect, it, vi } from 'vitest';
import { bootstrapLauncher, LAUNCHER_APP_NAME } from './launcher-bootstrap.js';

describe('bootstrapLauncher', () => {
  it('sets the stable SomniBot app name before loading the main process', async () => {
    const calls: string[] = [];
    const setAppName = vi.fn((name: string) => {
      calls.push(`name:${name}`);
    });
    const loadMain = vi.fn(async () => {
      calls.push('main');
    });

    await bootstrapLauncher({ setAppName, loadMain });

    expect(setAppName).toHaveBeenCalledWith(LAUNCHER_APP_NAME);
    expect(loadMain).toHaveBeenCalledOnce();
    expect(calls).toEqual([`name:${LAUNCHER_APP_NAME}`, 'main']);
  });
});
