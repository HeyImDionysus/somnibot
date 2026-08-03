import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSyncRows,
  maskRestoredCredentials,
  parseSyncRows,
  pullFromSupabase,
  pushToSupabaseWithRetry,
  type SyncableCredentials,
} from '../main/supabase-sync.js';

function pushCredentials(overrides: Partial<SyncableCredentials> = {}): SyncableCredentials {
  return {
    discordToken: 'discord-token',
    discordApplicationId: 'discord-app',
    discordClientSecret: 'discord-secret',
    discordGuildId: 'discord-guild',
    supabaseUrl: 'https://project.supabase.co',
    supabaseSecretKey: 'supabase-secret',
    supabasePublishableKey: 'supabase-publishable',
    supabaseDbPassword: 'database-password',
    supabaseAccessToken: 'supabase-access-token',
    supabaseDiscordAuthProviderConfigured: true,
    paypalClientId: 'paypal-client',
    paypalClientSecret: 'paypal-secret',
    paypalWebhookId: 'paypal-webhook',
    paypalWebhookProofKey: 'paypal-webhook-proof',
    paypalSandbox: true,
    lavalinkEnabled: true,
    publicCallbackBaseUrl: 'https://somnibot-laptop.tailnet.ts.net',
    vpsDomain: 'somnibot.example.com',
    vpsSshHost: '203.0.113.10',
    vpsSshUser: 'somnibot',
    vpsDeployPath: '/opt/somnibot',
    tailscaleAuthKey: 'tskey-auth-portable',
    vpsCsrfSecret: 'vps-csrf',
    vpsNextAuthSecret: 'vps-nextauth',
    vpsWebhookReplaySecret: 'vps-replay',
    vpsValkeyPassword: 'vps-valkey',
    vpsLavalinkPassword: 'vps-lavalink',
    ...overrides,
  };
}

describe('buildSyncRows', () => {
  it('writes the complete cross-surface credential set with canonical settings keys', () => {
    const rows = buildSyncRows(pushCredentials(), '2026-08-02T00:00:00.000Z');
    const rowMap = Object.fromEntries(rows.map(row => [row.key, row.value]));

    expect(rowMap).toEqual({
      discord_bot_token: 'discord-token',
      discord_application_id: 'discord-app',
      discord_client_secret: 'discord-secret',
      discord_guild_id: 'discord-guild',
      supabase_url: 'https://project.supabase.co',
      supabase_secret_key: 'supabase-secret',
      supabase_publishable_key: 'supabase-publishable',
      supabase_db_password: 'database-password',
      supabase_access_token: 'supabase-access-token',
      supabase_discord_auth_provider_configured: 'true',
      paypal_client_id: 'paypal-client',
      paypal_client_secret: 'paypal-secret',
      paypal_webhook_id: 'paypal-webhook',
      paypal_webhook_proof_key: 'paypal-webhook-proof',
      paypal_sandbox: 'true',
      lavalink_enabled: 'true',
      local_public_callback_base_url: 'https://somnibot-laptop.tailnet.ts.net',
      vps_domain: 'somnibot.example.com',
      vps_ssh_host: '203.0.113.10',
      vps_ssh_user: 'somnibot',
      vps_deploy_path: '/opt/somnibot',
      tailscale_auth_key: 'tskey-auth-portable',
      vps_csrf_secret: 'vps-csrf',
      vps_nextauth_secret: 'vps-nextauth',
      vps_webhook_replay_secret: 'vps-replay',
      vps_valkey_password: 'vps-valkey',
      vps_lavalink_password: 'vps-lavalink',
    });
    expect(rows.every(row => row.section === 'launcher')).toBe(true);
    expect(rows.every(row => row.updated_at === '2026-08-02T00:00:00.000Z')).toBe(true);
  });

  it('never overwrites durable credentials with blanks from a partial local cache', () => {
    const rows = buildSyncRows(pushCredentials({
      discordClientSecret: '',
      supabaseDbPassword: '   ',
      publicCallbackBaseUrl: '\t',
    }));
    const keys = rows.map(row => row.key);

    expect(keys).not.toContain('discord_client_secret');
    expect(keys).not.toContain('supabase_db_password');
    expect(keys).not.toContain('local_public_callback_base_url');
  });
});

describe('parseSyncRows', () => {
  it('restores Supabase and all PayPal connection fields even when Discord is absent', () => {
    const restored = parseSyncRows([
      { key: 'supabase_db_password', value: 'restored-db-password' },
      { key: 'supabase_access_token', value: 'restored-management-token' },
      { key: 'supabase_discord_auth_provider_configured', value: 'true' },
      { key: 'paypal_client_id', value: 'restored-client' },
      { key: 'paypal_client_secret', value: 'restored-secret' },
      { key: 'paypal_webhook_id', value: 'restored-webhook' },
      { key: 'paypal_sandbox', value: 'false' },
      { key: 'lavalink_enabled', value: 'true' },
      { key: 'tailscale_auth_key', value: 'restored-tailscale-auth-key' },
    ]);

    expect(restored).toEqual({
      supabaseDbPassword: 'restored-db-password',
      supabaseAccessToken: 'restored-management-token',
      supabaseDiscordAuthProviderConfigured: true,
      paypalClientId: 'restored-client',
      paypalClientSecret: 'restored-secret',
      paypalWebhookId: 'restored-webhook',
      paypalSandbox: false,
      lavalinkEnabled: true,
      tailscaleAuthKey: 'restored-tailscale-auth-key',
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
      { key: 'lavalink_enabled', value: 'not-a-boolean' },
    ])).toEqual({});
  });

  it('round-trips the complete launcher connection set', () => {
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
      supabaseSecretKey: 'restored-supabase-secret',
      supabaseUrl: 'https://restored.supabase.co',
      supabaseDiscordAuthProviderConfigured: true,
      paypalClientId: 'restored-paypal-client',
      paypalClientSecret: 'restored-paypal-secret',
      paypalWebhookId: 'restored-webhook-id',
      paypalWebhookProofKey: 'restored-webhook-proof',
      paypalSandbox: false,
      lavalinkEnabled: true,
      tailscaleAuthKey: 'restored-tailscale-auth-key',
    }, 'MASK')).toEqual({
      discordToken: 'MASK',
      discordApplicationId: 'restored-app-id',
      discordClientSecret: 'MASK',
      discordGuildId: 'restored-guild-id',
      supabasePublishableKey: 'restored-publishable-key',
      supabaseDbPassword: 'MASK',
      supabaseAccessToken: 'MASK',
      supabaseSecretKey: 'MASK',
      supabaseUrl: 'https://restored.supabase.co',
      supabaseDiscordAuthProviderConfigured: true,
      paypalClientId: 'restored-paypal-client',
      paypalClientSecret: 'MASK',
      paypalWebhookId: 'MASK',
      paypalWebhookProofKey: 'MASK',
      paypalSandbox: false,
      lavalinkEnabled: true,
      tailscaleAuthKey: 'MASK',
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

describe('pushToSupabaseWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries transient failures with bounded exponential delays', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const delays: number[] = [];

    const result = await pushToSupabaseWithRetry(
      'https://project.example.test',
      'service-role-test-key',
      pushCredentials(),
      { wait: async (delayMs) => { delays.push(delayMs); } },
    );

    expect(result).toEqual({ ok: true, attempts: 3 });
    expect(delays).toEqual([1_000, 2_000]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('surfaces the final failure after the bounded attempt count', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await pushToSupabaseWithRetry(
      'https://project.example.test',
      'service-role-test-key',
      pushCredentials(),
      { maxAttempts: 2, wait: async () => undefined },
    );

    expect(result).toMatchObject({ ok: false, attempts: 2 });
    expect(result.error).toContain('network down');
  });
});
