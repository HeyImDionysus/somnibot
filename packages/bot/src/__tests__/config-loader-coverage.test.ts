/**
 * config-loader — coverage tests
 *
 * Tests loadConfigFromDatabase and syncConfigToDatabase with REAL imports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Supabase createClient
const mockFrom = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({
    from: (...args: any[]) => mockFrom(...args),
  }),
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { loadConfigFromDatabase, syncConfigToDatabase } from '../services/config-loader.js';
import { createClient } from '@supabase/supabase-js';

function rearmCreateClient(): void {
  vi.mocked(createClient).mockReturnValue({
    from: (...args: any[]) => mockFrom(...args),
  } as never);
}

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'in', 'limit', 'upsert']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

describe('loadConfigFromDatabase', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    rearmCreateClient();
    // Set up required env vars
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'test-key';
    // Clear all mappable env vars
    delete process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_APPLICATION_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    delete process.env.DISCORD_GUILD_ID;
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_WEBHOOK_URL;
    delete process.env.LAVALINK_HOST;
    delete process.env.VALKEY_URL;
    delete process.env.DASHBOARD_URL;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns 0 when no Supabase credentials', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    const result = await loadConfigFromDatabase();
    expect(result).toBe(0);
  });

  it('still checks for saved overrides when all env vars are already set', async () => {
    // Set all mapped env vars so there are no missing keys
    process.env.DISCORD_TOKEN = 'set';
    process.env.DISCORD_APPLICATION_ID = 'set';
    process.env.DISCORD_CLIENT_SECRET = 'set';
    process.env.DISCORD_GUILD_ID = 'set';
    process.env.PAYPAL_CLIENT_ID = 'set';
    process.env.PAYPAL_CLIENT_SECRET = '_test_';
    process.env.PAYPAL_WEBHOOK_ID = 'set';
    process.env.PAYPAL_WEBHOOK_URL = 'set';
    process.env.PAYPAL_SANDBOX = 'set';
    process.env.LAVALINK_HOST = 'set';
    process.env.LAVALINK_PORT = 'set';
    process.env.LAVALINK_PASSWORD = 'set';
    process.env.VALKEY_URL = 'set';
    process.env.SUPABASE_ACCESS_TOKEN = 'set';
    process.env.SUPABASE_DB_URL = 'set';
    process.env.DASHBOARD_URL = 'set';

    mockFrom.mockReturnValue(chainBuilder({ data: [], error: null }));

    const result = await loadConfigFromDatabase();
    expect(result).toBe(0);
    expect(mockFrom).toHaveBeenCalledWith('instance_settings');
  });

  it('loads a saved operator override over an environment fallback', async () => {
    process.env.DISCORD_APPLICATION_ID = 'env-application-id';
    mockFrom.mockReturnValue(chainBuilder({
      data: [{ key: 'discord_application_id', value: 'saved-application-id', section: 'discord' }],
      error: null,
    }));

    const result = await loadConfigFromDatabase();

    expect(result).toBe(1);
    expect(process.env.DISCORD_APPLICATION_ID).toBe('saved-application-id');
  });

  it('normalizes saved PayPal mode and ignores invalid overrides', async () => {
    process.env.PAYPAL_SANDBOX = 'true';
    mockFrom.mockReturnValue(chainBuilder({
      data: [{ key: 'paypal_sandbox', value: 'no', section: 'paypal' }],
      error: null,
    }));

    await expect(loadConfigFromDatabase()).resolves.toBe(1);
    expect(process.env.PAYPAL_SANDBOX).toBe('false');

    process.env.PAYPAL_SANDBOX = 'true';
    mockFrom.mockReturnValue(chainBuilder({
      data: [{ key: 'paypal_sandbox', value: 'definitely', section: 'paypal' }],
      error: null,
    }));

    await expect(loadConfigFromDatabase()).resolves.toBe(0);
    expect(process.env.PAYPAL_SANDBOX).toBe('true');
  });

  it('loads missing non-secret config values but ignores legacy raw secrets', async () => {
    mockFrom.mockReturnValue(
      chainBuilder({
        data: [
          { key: 'discord_bot_token', value: 'loaded-token' },
          { key: 'lavalink_host', value: 'localhost' },
        ],
        error: null,
      }),
    );

    const result = await loadConfigFromDatabase();
    expect(result).toBe(1);
    expect(process.env.DISCORD_TOKEN).toBeUndefined();
    expect(process.env.LAVALINK_HOST).toBe('localhost');
  });

  it('handles table not found (42P01)', async () => {
    mockFrom.mockReturnValue(
      chainBuilder({ data: null, error: { code: '42P01', message: 'not found' } }),
    );

    const result = await loadConfigFromDatabase();
    expect(result).toBe(0);
  });

  it('rejects other DB errors instead of booting with deployment fallbacks', async () => {
    mockFrom.mockReturnValue(
      chainBuilder({ data: null, error: { code: '500', message: 'server error' } }),
    );

    await expect(loadConfigFromDatabase()).rejects.toThrow('Failed to read authoritative instance_settings');
  });

  it('rejects an invalid saved encrypted secret instead of using an environment fallback', async () => {
    process.env.PAYPAL_CLIENT_SECRET = 'environment-fallback';
    mockFrom.mockReturnValue(chainBuilder({
      data: [{ key: 'paypal_client_secret_encrypted', value: 'not-valid-ciphertext', section: 'paypal' }],
      error: null,
    }));
    await expect(loadConfigFromDatabase()).rejects.toThrow('failed validation');
    expect(process.env.PAYPAL_CLIENT_SECRET).toBe('environment-fallback');
  });

  it('rejects connection exceptions instead of booting with deployment fallbacks', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('connection failed');
    });

    await expect(loadConfigFromDatabase()).rejects.toThrow('connection failed');
  });

  it('skips rows with empty values', async () => {
    mockFrom.mockReturnValue(
      chainBuilder({
        data: [
          { key: 'discord_bot_token', value: '' },
          { key: 'lavalink_host', value: 'localhost' },
        ],
        error: null,
      }),
    );

    const result = await loadConfigFromDatabase();
    expect(result).toBe(1);
  });

  it('uses NEXT_PUBLIC_SUPABASE_URL fallback', async () => {
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://public.supabase.co';

    mockFrom.mockReturnValue(
      chainBuilder({ data: [], error: null }),
    );

    const result = await loadConfigFromDatabase();
    expect(result).toBe(0);
  });

  it('uses SUPABASE_SERVICE_ROLE_KEY fallback', async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'role-key';

    mockFrom.mockReturnValue(
      chainBuilder({ data: [], error: null }),
    );

    const result = await loadConfigFromDatabase();
    expect(result).toBe(0);
  });
});

describe('syncConfigToDatabase', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    rearmCreateClient();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'test-key';
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns 0 when no Supabase credentials', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    const result = await syncConfigToDatabase();
    expect(result).toBe(0);
  });

  it('returns 0 when no env vars to sync', async () => {
    // Clear all mapped env vars
    delete process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_APPLICATION_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    delete process.env.DISCORD_GUILD_ID;
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_WEBHOOK_ID;
    delete process.env.PAYPAL_WEBHOOK_URL;
    delete process.env.PAYPAL_SANDBOX;
    delete process.env.LAVALINK_HOST;
    delete process.env.LAVALINK_PORT;
    delete process.env.LAVALINK_PASSWORD;
    delete process.env.VALKEY_URL;
    delete process.env.SUPABASE_ACCESS_TOKEN;
    delete process.env.SUPABASE_DB_URL;
    delete process.env.DASHBOARD_URL;

    const result = await syncConfigToDatabase();
    expect(result).toBe(0);
  });

  it('syncs env vars to database', async () => {
    process.env.DISCORD_TOKEN = 'my-token';
    process.env.DISCORD_GUILD_ID = 'g123';

    mockFrom.mockReturnValue(chainBuilder({ error: null }));

    const result = await syncConfigToDatabase();
    expect(result).toBeGreaterThan(0);
  });

  it('does not persist non-secret env fallbacks as saved overrides', async () => {
    for (const envVar of [
      'DISCORD_TOKEN',
      'DISCORD_CLIENT_SECRET',
      'PAYPAL_CLIENT_SECRET',
      'PAYPAL_WEBHOOK_ID',
      'LAVALINK_PASSWORD',
      'VALKEY_URL',
      'SUPABASE_ACCESS_TOKEN',
      'SUPABASE_DB_URL',
    ]) {
      delete process.env[envVar];
    }
    process.env.DISCORD_GUILD_ID = 'environment-guild';
    const builder = chainBuilder({ error: null });
    mockFrom.mockReturnValue(builder);

    const result = await syncConfigToDatabase();

    expect(result).toBe(0);
    expect(builder.upsert).not.toHaveBeenCalled();
  });

  it('handles table not found error', async () => {
    process.env.DISCORD_TOKEN = 'my-token';

    mockFrom.mockReturnValue(
      chainBuilder({ error: { code: '42P01', message: 'not found' } }),
    );

    const result = await syncConfigToDatabase();
    expect(result).toBe(0);
  });

  it('handles DB error on sync', async () => {
    process.env.DISCORD_TOKEN = 'my-token';

    mockFrom.mockReturnValue(
      chainBuilder({ error: { code: '500', message: 'error' } }),
    );

    const result = await syncConfigToDatabase();
    expect(result).toBe(0);
  });

  it('handles exception during sync', async () => {
    process.env.DISCORD_TOKEN = 'my-token';

    mockFrom.mockImplementation(() => {
      throw new Error('connection failed');
    });

    const result = await syncConfigToDatabase();
    expect(result).toBe(0);
  });
});
