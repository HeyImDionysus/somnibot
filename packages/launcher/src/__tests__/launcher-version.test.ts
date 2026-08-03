import { describe, expect, it } from 'vitest';
import {
  readDeclaredLauncherVersion,
  resolveLauncherDisplayVersion,
} from '../main/launcher-version.js';

describe('launcher version display', () => {
  it('uses the declared SomniBot version instead of the Electron runtime version', () => {
    expect(resolveLauncherDisplayVersion({
      appVersion: '33.4.11',
      declaredVersion: '1.0.0',
    })).toBe('1.0.0');
  });

  it('reads the current launcher package version', () => {
    expect(readDeclaredLauncherVersion()).toBe('1.0.0');
  });

  it('falls back to app metadata only if declared metadata is unavailable', () => {
    expect(resolveLauncherDisplayVersion({
      appVersion: '1.0.0',
      declaredVersion: '',
    })).toBe('1.0.0');
  });
});
