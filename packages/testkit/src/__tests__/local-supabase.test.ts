import { describe, expect, it } from 'vitest';
import {
  cliEnvironment,
  parseCliStatus,
  resolveLocalSupabaseCredentials,
  SUPABASE_CLI_ENTRY,
  type SupabaseStatusRunner,
} from '../local-supabase.js';

const SERVICE_KEY = 'local-shard-service-key';
const ANON_KEY = 'local-shard-anon-key';
const AMBIENT_SERVICE = 'customer-service-key-must-not-be-used';
const AMBIENT_ANON = 'customer-anon-key-must-not-be-used';

describe('resolveLocalSupabaseCredentials', () => {
  it('prefers complete explicit loopback E2E overrides and ignores ambient keys', () => {
    let invoked = false;
    const runStatus: SupabaseStatusRunner = () => {
      invoked = true;
      return { status: 1, stdout: '', stderr: 'not expected' };
    };

    const result = resolveLocalSupabaseCredentials({
      env: {
        SUPABASE_URL: 'https://customer.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: AMBIENT_SERVICE,
        SUPABASE_ANON_KEY: AMBIENT_ANON,
        SOMNIBOT_E2E_SUPABASE_URL: 'http://127.0.0.1:55421',
        SOMNIBOT_E2E_SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
        SOMNIBOT_E2E_SUPABASE_ANON_KEY: ANON_KEY,
      },
      runStatus,
    });

    expect(result).toEqual({
      url: 'http://127.0.0.1:55421',
      serviceRoleKey: SERVICE_KEY,
      anonKey: ANON_KEY,
      source: 'override',
    });
    expect(invoked).toBe(false);
  });

  it('reads local CLI status when overrides are absent and strips ambient SUPABASE_* vars', () => {
    let observed: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | undefined;
    const runStatus: SupabaseStatusRunner = (options) => {
      observed = options;
      return {
        status: 0,
        stdout: JSON.stringify({
          API_URL: 'http://127.0.0.1:54321',
          SERVICE_ROLE_KEY: SERVICE_KEY,
          ANON_KEY,
        }),
        stderr: `service=${SERVICE_KEY} anon=${ANON_KEY}`,
      };
    };

    const result = resolveLocalSupabaseCredentials({
      env: {
        SUPABASE_URL: 'https://customer.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: AMBIENT_SERVICE,
        SUPABASE_ANON_KEY: AMBIENT_ANON,
        PATH: 'safe-path',
      },
      runStatus,
      cwd: 'packages',
    });

    expect(result.source).toBe('cli');
    expect(result.serviceRoleKey).toBe(SERVICE_KEY);
    expect(result.anonKey).toBe(ANON_KEY);
    expect(observed?.command).toBe(process.execPath);
    expect(observed?.args).toEqual([SUPABASE_CLI_ENTRY, 'status', '-o', 'json']);
    expect(observed?.cwd).toBe('packages');
    expect(Object.keys(observed?.env ?? {}).some((key) => /^SUPABASE_/i.test(key))).toBe(false);
    expect(observed?.env.PATH).toBe('safe-path');
    expect(JSON.stringify(result)).not.toContain(AMBIENT_SERVICE);
    expect(JSON.stringify(result)).not.toContain(AMBIENT_ANON);
  });

  it('fails closed for missing CLI/status output without echoing command output or keys', () => {
    const hostileOutput = `status failed service=${AMBIENT_SERVICE} anon=${AMBIENT_ANON}`;
    const missingCli = () => resolveLocalSupabaseCredentials({
      env: { SUPABASE_SERVICE_ROLE_KEY: AMBIENT_SERVICE },
      runStatus: () => ({ status: null, stdout: hostileOutput, stderr: hostileOutput }),
    });
    expect(missingCli).toThrow('Local Supabase credentials unavailable');
    expect(String(viableError(missingCli))).not.toContain(AMBIENT_SERVICE);
    expect(String(viableError(missingCli))).not.toContain(AMBIENT_ANON);

    const unavailable = () => resolveLocalSupabaseCredentials({
      env: {},
      runStatus: () => ({ status: 1, stdout: hostileOutput, stderr: hostileOutput }),
    });
    expect(unavailable).toThrow('Local Supabase credentials unavailable');
    expect(String(viableError(unavailable))).not.toContain(AMBIENT_SERVICE);
    expect(String(viableError(unavailable))).not.toContain(AMBIENT_ANON);
  });

  it('rejects a remote explicit URL rather than falling back to another target', () => {
    expect(() => resolveLocalSupabaseCredentials({
      env: {
        SOMNIBOT_E2E_SUPABASE_URL: 'https://customer.supabase.co',
        SOMNIBOT_E2E_SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
        SOMNIBOT_E2E_SUPABASE_ANON_KEY: ANON_KEY,
      },
      runStatus: () => ({ status: 0, stdout: '{}' }),
    })).toThrow(/not local/);
  });

  it('fails closed when any explicit E2E override is partial', () => {
    const runStatus: SupabaseStatusRunner = () => ({
      status: 0,
      stdout: JSON.stringify({ API_URL: 'http://127.0.0.1:54321', SERVICE_ROLE_KEY: SERVICE_KEY, ANON_KEY }),
    });
    for (const env of [
      { SOMNIBOT_E2E_SUPABASE_URL: 'http://127.0.0.1:54321' },
      { SOMNIBOT_E2E_SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY },
      { SOMNIBOT_E2E_SUPABASE_ANON_KEY: ANON_KEY },
      {
        SOMNIBOT_E2E_SUPABASE_URL: 'http://127.0.0.1:54321',
        SOMNIBOT_E2E_SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      },
    ]) {
      expect(() => resolveLocalSupabaseCredentials({ env, runStatus })).toThrow(/E2E overrides must provide/);
    }
  });
});

function viableError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('Supabase status parsing', () => {
  it('accepts the CLI field names without exposing values in failure paths', () => {
    expect(parseCliStatus(JSON.stringify({
      API_URL: 'http://127.0.0.1:54321',
      SERVICE_ROLE_KEY: SERVICE_KEY,
      ANON_KEY,
    }))).toEqual({
      url: 'http://127.0.0.1:54321',
      serviceRoleKey: SERVICE_KEY,
      anonKey: ANON_KEY,
      source: 'cli',
    });
    expect(parseCliStatus('not-json')).toBeNull();
  });

  it('does not retain ambient SUPABASE names in the CLI environment', () => {
    const env = cliEnvironment({
      SUPABASE_ACCESS_TOKEN: 'customer-token',
      SUPABASE_URL: 'https://customer.supabase.co',
      SOMNIBOT_E2E_SUPABASE_URL: 'http://127.0.0.1:54321',
      PATH: 'safe-path',
    });
    expect(env).toEqual({
      SOMNIBOT_E2E_SUPABASE_URL: 'http://127.0.0.1:54321',
      PATH: 'safe-path',
    });
  });
});
