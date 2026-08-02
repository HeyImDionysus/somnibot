import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSyncRows,
  maskRestoredCredentials,
  parseSyncRows,
  pullFromSupabase,
  type SyncableCredentials,
} from '../main/supabase-sync.js';

function pushCredentials(overrides: Partial<SyncableCredentials> = {}): SyncableCredentials {
  return {
    discordToken: 'discord-token',
    discordApplicationId: 'discord-app',
    discordClientSecret: 'discord-secret',
    discordGuildId: 'discord-guild',
    supabasePublishableKey: 'supabase-publishable',
    supabaseDbPassword: 'database-password',
    ...overrides,
  };
}

describe('buildSyncRows', () => {
  it('keeps the established launcher write set and canonical bot settings keys', () => {
    const rows = buildSyncRows(pushCredentials(), '2026-08-02T00:00:00.000Z');
    const rowMap = Object.fromEntries(rows.map(row => [row.key, row.value]));

    expect(rowMap).toEqual({
      discord_bot_token: 'discord-token',
      discord_application_id: 'discord-app',
      discord_client_secret: 'discord-secret',
      discord_guild_id: 'discord-guild',
      supabase_publishable_key: 'supabase-publishable',
      supabase_db_password: 'database-password',
    });
    expect(rows.every(row => row.section === 'launcher')).toBe(true);
    expect(rows.every(row => row.updated_at === '2026-08-02T00:00:00.000Z')).toBe(true);
  });

  it('never overwrites durable credentials with blanks from a partial local cache', () => {
    const rows = buildSyncRows(pushCredentials({
      discordClientSecret: '',
      supabaseDbPassword: '',
    }));
    const keys = rows.map(row => row.key);

    expect(keys).not.toContain('discord_client_secret');
    expect(keys).not.toContain('supabase_db_password');
  });
});

describe('parseSyncRows', () => {
  it('restores Supabase and all PayPal connection fields even when Discord is absent', () => {
    const restored = parseSyncRows([
      { key: 'supabase_db_password', value: 'restored-db-password' },
      { key: 'supabase_access_token', value: 'restored-management-token' },
      { key: 'paypal_client_id', value: 'restored-client' },
      { key: 'paypal_client_secret', value: 'restored-secret' },
      { key: 'paypal_webhook_id', value: 'restored-webhook' },
      { key: 'paypal_sandbox', value: 'false' },
    ]);

    expect(restored).toEqual({
      supabaseDbPassword: 'restored-db-password',
      supabaseAccessToken: 'restored-management-token',
      paypalClientId: 'restored-client',
      paypalClientSecret: 'restored-secret',
      paypalWebhookId: 'restored-webhook',
      paypalSandbox: false,
    });
  });

  it('recognizes setup-wizard and legacy launcher connection keys across sections', () => {
    const restored = parseSyncRows([
      { key: 'discord_token', value: 'legacy-discord-token' },
      { key: 'discord_app_id', value: 'legacy-app-id' },
      {
        key: 'supabase_db_url',
        value: 'postgresql://postgres:encoded%20database%20password@db.example.test:5432/postgres',
      },
      { key: 'paypal_client_id', value: 'wizard-paypal-client' },
      { key: 'paypal_client_secret', value: 'wizard-paypal-secret' },
    ]);

    expect(restored).toMatchObject({
      discordToken: 'legacy-discord-token',
      discordApplicationId: 'legacy-app-id',
      supabaseDbPassword: 'encoded database password',
      paypalClientId: 'wizard-paypal-client',
      paypalClientSecret: 'wizard-paypal-secret',
    });
  });

  it('ignores unknown, blank, and malformed boolean rows instead of erasing local state', () => {
    expect(parseSyncRows([
      { key: 'unknown_setting', value: 'ignored' },
      { key: 'supabase_db_password', value: '' },
      { key: 'paypal_sandbox', value: 'not-a-boolean' },
    ])).toEqual({});
  });

  it('round-trips the established launcher write set', () => {
    const original = pushCredentials();
    const rows = buildSyncRows(original);
    expect(parseSyncRows(rows)).toEqual(original);
  });

  it('does not replace an existing password from a connection URL without a password', () => {
    expect(parseSyncRows([
      { key: 'supabase_db_url', value: 'postgresql://postgres@db.example.test:5432/postgres' },
    ])).toEqual({});
  });
});

describe('maskRestoredCredentials', () => {
  it('keeps restored secrets in the main process while preserving non-secret setup values', () => {
    expect(maskRestoredCredentials({
      discordToken: 'restored-token',
      discordApplicationId: 'restored-app-id',
      discordClientSecret: 'restored-discord-secret',
      discordGuildId: 'restored-guild-id',
      supabasePublishableKey: 'restored-publishable-key',
      supabaseDbPassword: 'restored-db-password',
      supabaseAccessToken: 'restored-access-token',
      paypalClientId: 'restored-paypal-client',
      paypalClientSecret: 'restored-paypal-secret',
      paypalWebhookId: 'restored-webhook-id',
      paypalSandbox: false,
    }, 'MASK')).toEqual({
      discordToken: 'MASK',
      discordApplicationId: 'restored-app-id',
      discordClientSecret: 'MASK',
      discordGuildId: 'restored-guild-id',
      supabasePublishableKey: 'restored-publishable-key',
      supabaseDbPassword: 'MASK',
      supabaseAccessToken: 'MASK',
      paypalClientId: 'restored-paypal-client',
      paypalClientSecret: 'MASK',
      paypalWebhookId: 'MASK',
      paypalSandbox: false,
    });
  });
});

describe('pullFromSupabase', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queries known connection keys across bot-owned sections and returns a partial merge', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { key: 'paypal_client_id', value: 'wizard-paypal-client' },
        { key: 'paypal_client_secret', value: 'wizard-paypal-secret' },
        {
          key: 'supabase_db_url',
          value: 'postgresql://postgres:restored-password@db.example.test:5432/postgres',
        },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pullFromSupabase('https://project.example.test/', 'service-role-test-key');

    expect(result).toEqual({
      ok: true,
      credentials: {
        paypalClientId: 'wizard-paypal-client',
        paypalClientSecret: 'wizard-paypal-secret',
        supabaseDbPassword: 'restored-password',
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.has('section')).toBe(false);
    expect(requestUrl.searchParams.get('select')).toBe('key,value');
    expect(requestUrl.searchParams.get('key')).toContain('paypal_client_id');
    expect(requestUrl.searchParams.get('key')).toContain('supabase_db_url');
  });
});
