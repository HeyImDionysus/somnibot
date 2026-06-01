/**
 * Coverage tests for src/utils/db-helpers.ts and src/config.ts.
 * Targets the ~0.04% gap to reach the 70% statement threshold.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { joinField, joinProp, walletBalance, hasErrorCode } from '../utils/db-helpers.js';

describe('db-helpers', () => {
  describe('joinField', () => {
    it('returns nested value when key exists', () => {
      const row = { profile: { name: 'Alice' } };
      expect(joinField<{ name: string }>(row, 'profile')).toEqual({ name: 'Alice' });
    });

    it('returns undefined for missing key', () => {
      expect(joinField({}, 'missing')).toBeUndefined();
    });

    it('returns undefined for null row', () => {
      expect(joinField(null, 'key')).toBeUndefined();
    });

    it('returns undefined for non-object row', () => {
      expect(joinField('string', 'key')).toBeUndefined();
    });

    it('returns undefined for undefined row', () => {
      expect(joinField(undefined, 'key')).toBeUndefined();
    });
  });

  describe('joinProp', () => {
    it('returns nested property', () => {
      const row = { guild: { name: 'Test', id: '123' } };
      expect(joinProp(row, 'guild', 'name')).toBe('Test');
    });

    it('returns undefined when join is missing', () => {
      expect(joinProp({}, 'guild', 'name')).toBeUndefined();
    });

    it('returns undefined when prop is missing', () => {
      const row = { guild: { name: 'Test' } };
      expect(joinProp(row, 'guild', 'missing')).toBeUndefined();
    });
  });

  describe('walletBalance', () => {
    it('returns wallet value', () => {
      expect(walletBalance({ wallet: 500 })).toBe(500);
    });

    it('returns 0 for null wallet', () => {
      expect(walletBalance({ wallet: null })).toBe(0);
    });

    it('returns 0 for missing wallet field', () => {
      expect(walletBalance({ balance: 100 })).toBe(0);
    });

    it('returns 0 for null row', () => {
      expect(walletBalance(null)).toBe(0);
    });

    it('returns 0 for non-object', () => {
      expect(walletBalance(42)).toBe(0);
    });
  });

  describe('hasErrorCode', () => {
    it('returns true for error object', () => {
      expect(hasErrorCode({ code: '23505', message: 'duplicate' })).toBe(true);
    });

    it('returns false for null', () => {
      expect(hasErrorCode(null)).toBe(false);
    });

    it('returns false for string', () => {
      expect(hasErrorCode('error')).toBe(false);
    });

    it('returns false for object without code', () => {
      expect(hasErrorCode({ message: 'oops' })).toBe(false);
    });
  });
});

describe('config', () => {
  const ENV_BACKUP: Record<string, string | undefined> = {};
  const CONFIG_KEYS = [
    'DISCORD_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_CLIENT_SECRET',
    'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'LAVALINK_PASSWORD',
  ];

  beforeEach(() => {
    vi.resetModules();
    // Backup & clear env vars that affect config
    for (const key of CONFIG_KEYS) {
      ENV_BACKUP[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const key of CONFIG_KEYS) {
      if (ENV_BACKUP[key] !== undefined) {
        process.env[key] = ENV_BACKUP[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('getConfig throws if loadConfig was not called', async () => {
    const { getConfig } = await import('../config.js');
    expect(() => getConfig()).toThrow('Config not loaded');
  });

  it('loadConfig succeeds with valid env vars and getConfig returns the result', async () => {
    // Set all required env vars (including LAVALINK_PASSWORD which has min 8)
    process.env.DISCORD_TOKEN = 'test-token-for-config';
    process.env.DISCORD_APPLICATION_ID = '123456789012345678';
    process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
    process.env.SUPABASE_URL = 'https://test-project.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'eyJ-test-secret-key';
    process.env.LAVALINK_PASSWORD = 'test-secure-password-1234';

    const { loadConfig, getConfig } = await import('../config.js');
    const config = loadConfig();
    expect(config).toBeDefined();
    expect(config.DISCORD_TOKEN).toBe('test-token-for-config');
    expect(config.SUPABASE_URL).toBe('https://test-project.supabase.co');

    // Calling again returns cached result
    const config2 = loadConfig();
    expect(config2).toBe(config);

    // getConfig now works
    const config3 = getConfig();
    expect(config3).toBe(config);
  });

  it('loadConfig exits on invalid env', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // Don't set any env vars — validation should fail
    const { loadConfig } = await import('../config.js');
    loadConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
