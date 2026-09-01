/**
 * V5 Audit §13.P3b — Launcher process-manager unit tests.
 *
 * Tests the pure utility functions from process-manager logic.
 * The actual ProcessManager class imports electron and cannot run
 * outside an Electron context, so we replicate and test the pure
 * helper logic (env filtering, port checking) independently.
 */

import { describe, it, expect } from 'vitest';
import {
  PROCESS_RESTART_MAX_ATTEMPTS,
  processRestartDelayMs,
  shouldApplyBotReadyTimeout,
  shouldRecoverManagedProcess,
} from '../main/process-manager-guards';
import { buildManagedChildEnvironment } from '../main/child-environment.js';

const TEST_RELEASE_IDENTITY = {
  exactSha: 'a'.repeat(40),
  migrationHead: '20260831135500_adoption_recovery_proof.sql',
  configurationGeneration: 20260831135500,
} as const;

function safeParentEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  return buildManagedChildEnvironment({
    parentEnv,
    serviceEnv: {},
    isPackaged: false,
    releaseIdentity: TEST_RELEASE_IDENTITY,
  });
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
    const filtered = safeParentEnv({ PATH: '/usr/bin', HOME: undefined });
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

describe('managed process recovery policy', () => {
  it('uses bounded exponential backoff for every automatic restart attempt', () => {
    expect(PROCESS_RESTART_MAX_ATTEMPTS).toBe(5);
    expect(Array.from({ length: 5 }, (_, index) => processRestartDelayMs(index + 1)))
      .toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(processRestartDelayMs(10)).toBe(30_000);
  });

  it('rejects invalid restart attempt numbers', () => {
    expect(() => processRestartDelayMs(0)).toThrow('positive integer');
    expect(() => processRestartDelayMs(1.5)).toThrow('positive integer');
  });

  it('only recovers the current child while the owner wants services running', () => {
    const currentProcess = {};
    const staleProcess = {};

    expect(shouldRecoverManagedProcess(true, currentProcess, currentProcess)).toBe(true);
    expect(shouldRecoverManagedProcess(false, currentProcess, currentProcess)).toBe(false);
    expect(shouldRecoverManagedProcess(true, currentProcess, staleProcess)).toBe(false);
    expect(shouldRecoverManagedProcess(true, null, currentProcess)).toBe(false);
  });
});
