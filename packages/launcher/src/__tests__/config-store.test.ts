/**
 * V5 Audit §13.P3b — Launcher unit tests for config-store logic.
 *
 * Tests the pure-function parts of config-store (validation, defaults,
 * sensitive field masking). Full E2E tests with Electron + Playwright
 * will be added once the CI Electron runner is available.
 */

import { describe, it, expect } from 'vitest';

// The config shape from config-store.ts (replicated here since the
// module imports electron-store which isn't available outside Electron).
const SENSITIVE_KEYS = [
  'discordToken',
  'discordClientSecret',
  'supabaseSecretKey',
] as const;

const REQUIRED_FOR_LAUNCH = [
  'discordToken',
  'supabaseUrl',
  'supabaseSecretKey',
] as const;

interface LauncherConfig {
  discordToken: string;
  discordApplicationId: string;
  discordClientSecret: string;
  discordGuildId: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  supabasePublishableKey: string;
  lavalinkEnabled: boolean;
}

function isReadyToLaunch(config: LauncherConfig): boolean {
  return REQUIRED_FOR_LAUNCH.every((key) => {
    const val = config[key as keyof LauncherConfig];
    return typeof val === 'string' && val.length > 0;
  });
}

function maskSensitive(config: LauncherConfig): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...config };
  for (const key of SENSITIVE_KEYS) {
    if (typeof masked[key] === 'string' && (masked[key] as string).length > 0) {
      masked[key] = '••••••••';
    }
  }
  return masked;
}

describe('Launcher Config', () => {
  const validConfig: LauncherConfig = {
    discordToken: 'my-token',
    discordApplicationId: '12345',
    discordClientSecret: 'secret123',
    discordGuildId: '67890',
    supabaseUrl: 'https://my-project.supabase.co',
    supabaseSecretKey: 'eyJhbGciOiJIUzI1NiJ9',
    supabasePublishableKey: 'eyJhbGciOiJIUzI1NiJ9.pub',
    lavalinkEnabled: true,
  };

  it('detects ready-to-launch config', () => {
    expect(isReadyToLaunch(validConfig)).toBe(true);
  });

  it('rejects config missing discordToken', () => {
    expect(isReadyToLaunch({ ...validConfig, discordToken: '' })).toBe(false);
  });

  it('rejects config missing supabaseUrl', () => {
    expect(isReadyToLaunch({ ...validConfig, supabaseUrl: '' })).toBe(false);
  });

  it('rejects config missing supabaseSecretKey', () => {
    expect(isReadyToLaunch({ ...validConfig, supabaseSecretKey: '' })).toBe(false);
  });

  it('masks sensitive fields for display', () => {
    const masked = maskSensitive(validConfig);
    expect(masked.discordToken).toBe('••••••••');
    expect(masked.discordClientSecret).toBe('••••••••');
    expect(masked.supabaseSecretKey).toBe('••••••••');
    // Non-sensitive fields are preserved
    expect(masked.supabaseUrl).toBe(validConfig.supabaseUrl);
    expect(masked.discordGuildId).toBe(validConfig.discordGuildId);
  });

  it('does not mask empty sensitive fields', () => {
    const emptyConfig = { ...validConfig, discordToken: '', discordClientSecret: '' };
    const masked = maskSensitive(emptyConfig);
    expect(masked.discordToken).toBe('');
    expect(masked.discordClientSecret).toBe('');
  });
});
