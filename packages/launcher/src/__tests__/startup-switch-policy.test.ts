import { describe, expect, it } from 'vitest';
import { HOST_DEBUG_SWITCHES, removeHostDebugSwitches } from '../main/startup-switch-policy.js';

describe('removeHostDebugSwitches', () => {
  it('removes every host-controlled Chromium debugging switch before startup', () => {
    const removed: string[] = [];
    removeHostDebugSwitches({ removeSwitch: (name) => removed.push(name) });
    expect(removed).toEqual([...HOST_DEBUG_SWITCHES]);
  });
});
