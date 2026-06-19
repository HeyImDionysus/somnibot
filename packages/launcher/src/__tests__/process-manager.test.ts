/**
 * V5 Audit §13.P3b — Launcher process-manager unit tests.
 *
 * Tests the pure utility functions from process-manager logic.
 * The actual ProcessManager class imports electron and cannot run
 * outside an Electron context, so we replicate and test the pure
 * helper logic (env filtering, port checking) independently.
 */

import { describe, it, expect } from 'vitest';
import { shouldApplyBotReadyTimeout } from '../main/process-manager-guards';

// ── Replicated pure functions from process-manager.ts ────────

const SAFE_PARENT_ENV_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'SystemRoot',
  'COMSPEC',
  'SHELL',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
] as const;

function safeParentEnv(env: Record<string, string | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const key of SAFE_PARENT_ENV_KEYS) {
    const val = env[key];
    if (val !== undefined) filtered[key] = val;
  }
  return filtered;
}

type ProcessStatus = 'offline' | 'starting' | 'online' | 'error';

interface StatusUpdate {
  bot: ProcessStatus;
  dashboard: ProcessStatus;
  botPid?: number;
  dashboardPid?: number;
  lastHeartbeat?: number;
  error?: string;
}

function isHealthy(status: StatusUpdate): boolean {
  return status.bot === 'online' && status.dashboard === 'online';
}

function buildEnvVars(
  baseEnv: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  return { ...baseEnv, ...overrides };
}

// ── Tests ────────────────────────────────────────────────────

describe('safeParentEnv', () => {
  it('only forwards allowlisted env vars', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      DISCORD_TOKEN: 'secret-token',
      DATABASE_URL: 'postgres://...',
      AWS_SECRET_KEY: 'aws-secret',
    };

    const filtered = safeParentEnv(env);

    expect(filtered.PATH).toBe('/usr/bin');
    expect(filtered.HOME).toBe('/home/user');
    // Secrets must NOT leak through
    expect(filtered).not.toHaveProperty('DISCORD_TOKEN');
    expect(filtered).not.toHaveProperty('DATABASE_URL');
    expect(filtered).not.toHaveProperty('AWS_SECRET_KEY');
  });

  it('skips undefined env vars', () => {
    const filtered = safeParentEnv({ PATH: '/usr/bin', HOME: undefined as unknown as string });
    expect(filtered).toHaveProperty('PATH');
    expect(filtered).not.toHaveProperty('HOME');
  });

  it('returns empty object for empty env', () => {
    const filtered = safeParentEnv({});
    expect(Object.keys(filtered)).toHaveLength(0);
  });

  it('handles Windows-specific env vars', () => {
    const filtered = safeParentEnv({
      APPDATA: 'C:\\Users\\user\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local',
      SystemRoot: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    });
    expect(filtered.APPDATA).toBe('C:\\Users\\user\\AppData\\Roaming');
    expect(filtered.SystemRoot).toBe('C:\\Windows');
  });
});

describe('StatusUpdate utilities', () => {
  it('isHealthy returns true when both services are online', () => {
    expect(isHealthy({ bot: 'online', dashboard: 'online' })).toBe(true);
  });

  it('isHealthy returns false when bot is starting', () => {
    expect(isHealthy({ bot: 'starting', dashboard: 'online' })).toBe(false);
  });

  it('isHealthy returns false when dashboard is offline', () => {
    expect(isHealthy({ bot: 'online', dashboard: 'offline' })).toBe(false);
  });

  it('isHealthy returns false when bot is in error state', () => {
    expect(isHealthy({ bot: 'error', dashboard: 'online', error: 'crash' })).toBe(false);
  });
});

describe('buildEnvVars', () => {
  it('merges base env with overrides', () => {
    const base = safeParentEnv({ PATH: '/usr/bin', HOME: '/home/user' });
    const overrides = { DISCORD_TOKEN: 'tok', SUPABASE_URL: 'https://...' };
    const result = buildEnvVars(base, overrides);

    expect(result.PATH).toBe('/usr/bin');
    expect(result.DISCORD_TOKEN).toBe('tok');
    expect(result.SUPABASE_URL).toBe('https://...');
  });

  it('overrides take precedence over base', () => {
    const result = buildEnvVars({ PATH: '/old' }, { PATH: '/new' });
    expect(result.PATH).toBe('/new');
  });
});

describe('bot ready timeout guard', () => {
  it('only applies to the bot process that created the timeout', () => {
    const previousProcess = {};
    const replacementProcess = {};

    expect(shouldApplyBotReadyTimeout(replacementProcess, previousProcess, 'starting')).toBe(false);
    expect(shouldApplyBotReadyTimeout(previousProcess, previousProcess, 'starting')).toBe(true);
  });

  it('does not apply after the matching bot is already online', () => {
    const process = {};

    expect(shouldApplyBotReadyTimeout(process, process, 'online')).toBe(false);
  });
});
