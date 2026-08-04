import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSyncRows,
  maskRestoredCredentials,
  parseSyncRows,
  pullFromSupabase,
  pushToSupabaseWithRetry,
  type SyncableCredentials,
} from '../main/supabase-sync.js';

const SYNC_SECRET = 'service-role-test-key';
const PROJECT_ORIGIN = 'https://project.supabase.co';

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
    const rows = buildSyncRows(pushCredentials(), SYNC_SECRET, PROJECT_ORIGIN, '2026-08-02T00:00:00.000Z');
    const rowMap = Object.fromEntries(rows.map(row => [row.key, row.value]));

    expect(rowMap).toMatchObject({
      discord_application_id: 'discord-app',
      discord_guild_id: 'discord-guild',
      supabase_url: 'https://project.supabase.co',
      supabase_publishable_key: 'supabase-publishable',
      supabase_discord_auth_provider_configured: 'true',
      paypal_client_id: 'paypal-client',
      paypal_sandbox: 'true',
      lavalink_enabled: 'true',
      local_public_callback_base_url: 'https://somnibot-laptop.tailnet.ts.net',
      vps_domain: 'somnibot.example.com',
      vps_ssh_host: '203.0.113.10',
      vps_ssh_user: 'somnibot',
      vps_deploy_path: '/opt/somnibot',
    });
    const encryptedKeys = [
      'discord_bot_token_encrypted', 'discord_client_secret_encrypted',
      'supabase_secret_key_encrypted', 'supabase_db_password_encrypted',
      'supabase_access_token_encrypted', 'paypal_client_secret_encrypted',
      'paypal_webhook_id_encrypted', 'paypal_webhook_proof_key_encrypted',
      'tailscale_auth_key_encrypted', 'vps_csrf_secret_encrypted',
      'vps_nextauth_secret_encrypted', 'vps_webhook_replay_secret_encrypted',
      'vps_valkey_password_encrypted', 'vps_lavalink_password_encrypted',
    ];
    for (const key of encryptedKeys) {
      expect(rowMap[key]).toMatch(/^somnibot-cloud-v1:/);
    }
    expect(JSON.stringify(rows)).not.toContain('discord-token');
    expect(JSON.stringify(rows)).not.toContain('paypal-secret');
    expect(rows.every(row => row.section === 'launcher')).toBe(true);
    expect(rows.every(row => row.updated_at === '2026-08-02T00:00:00.000Z')).toBe(true);
  });

  it('never overwrites durable credentials with blanks from a partial local cache', () => {
    const rows = buildSyncRows(pushCredentials({
      discordClientSecret: '',
      supabaseDbPassword: '   ',
      publicCallbackBaseUrl: '\t',
    }), SYNC_SECRET, PROJECT_ORIGIN);
    const keys = rows.map(row => row.key);

    expect(keys).not.toContain('discord_client_secret_encrypted');
    expect(keys).not.toContain('supabase_db_password_encrypted');
    expect(keys).not.toContain('local_public_callback_base_url');
  });
});

describe('parseSyncRows', () => {
  it('restores Supabase and all PayPal connection fields even when Discord is absent', () => {
    const source = pushCredentials({
      discordToken: '', discordApplicationId: '', discordClientSecret: '', discordGuildId: '',
      supabaseDbPassword: 'restored-db-password',
      supabaseAccessToken: 'restored-management-token',
      paypalClientId: 'restored-client', paypalClientSecret: 'restored-secret',
      paypalWebhookId: 'restored-webhook', paypalSandbox: false,
      tailscaleAuthKey: 'restored-tailscale-auth-key',
    });
    const restored = parseSyncRows(buildSyncRows(source, SYNC_SECRET, PROJECT_ORIGIN), SYNC_SECRET, PROJECT_ORIGIN);

    expect(restored).toEqual({
      supabaseDbPassword: 'restored-db-password',
      supabaseAccessToken: 'restored-management-token',
      supabaseDiscordAuthProviderConfigured: true,
      paypalClientId: 'restored-client',
      paypalClientSecret: 'restored-secret',
      paypalWebhookId: 'restored-webhook',
      paypalWebhookProofKey: 'paypal-webhook-proof',
      paypalSandbox: false,
      lavalinkEnabled: true,
      tailscaleAuthKey: 'restored-tailscale-auth-key',
      supabaseUrl: 'https://project.supabase.co',
      supabaseSecretKey: 'supabase-secret',
      supabasePublishableKey: 'supabase-publishable',
      publicCallbackBaseUrl: 'https://somnibot-laptop.tailnet.ts.net',
      vpsDomain: 'somnibot.example.com', vpsSshHost: '203.0.113.10',
      vpsSshUser: 'somnibot', vpsDeployPath: '/opt/somnibot',
      vpsCsrfSecret: 'vps-csrf', vpsNextAuthSecret: 'vps-nextauth',
      vpsWebhookReplaySecret: 'vps-replay', vpsValkeyPassword: 'vps-valkey',
      vpsLavalinkPassword: 'vps-lavalink',
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
      { key: 'paypal_webhook_url', value: 'https://somni.tailnet.ts.net/api/paypal/webhook' },
    ], SYNC_SECRET, PROJECT_ORIGIN);

    expect(restored).toMatchObject({
      discordApplicationId: 'legacy-app-id',
      paypalClientId: 'wizard-paypal-client',
      publicCallbackBaseUrl: 'https://somni.tailnet.ts.net',
    });
  });

  it('ignores unknown, blank, and malformed boolean rows instead of erasing local state', () => {
    expect(parseSyncRows([
      { key: 'unknown_setting', value: 'ignored' },
      { key: 'supabase_db_password', value: '' },
      { key: 'paypal_sandbox', value: 'not-a-boolean' },
      { key: 'lavalink_enabled', value: 'not-a-boolean' },
    ], SYNC_SECRET, PROJECT_ORIGIN)).toEqual({});
  });

  it('round-trips the complete launcher connection set', () => {
    const original = pushCredentials();
    const rows = buildSyncRows(original, SYNC_SECRET, PROJECT_ORIGIN);
    expect(parseSyncRows(rows, SYNC_SECRET, PROJECT_ORIGIN)).toEqual(original);
  });

  it('does not replace an existing password from a connection URL without a password', () => {
    expect(parseSyncRows([
      { key: 'supabase_db_url', value: 'postgresql://postgres@db.example.test:5432/postgres' },
    ], SYNC_SECRET, PROJECT_ORIGIN)).toEqual({});
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
    const cloudRows = buildSyncRows(pushCredentials(), SYNC_SECRET, PROJECT_ORIGIN)
      .filter(row => ['paypal_client_id', 'paypal_client_secret_encrypted', 'supabase_db_password_encrypted'].includes(row.key));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => cloudRows,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pullFromSupabase('https://project.supabase.co/', 'service-role-test-key');

    expect(result).toEqual({
      ok: true,
      credentials: {
        paypalClientId: 'paypal-client',
        paypalClientSecret: 'paypal-secret',
        supabaseDbPassword: 'database-password',
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.has('section')).toBe(false);
    expect(requestUrl.searchParams.get('select')).toBe('key,value');
    expect(requestUrl.searchParams.get('key')).toContain('paypal_client_id');
    expect(requestUrl.searchParams.get('key')).not.toContain('supabase_db_url,');
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
      'https://project.supabase.co',
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
      'https://project.supabase.co',
      'service-role-test-key',
      pushCredentials(),
      { maxAttempts: 2, wait: async () => undefined },
    );

    expect(result).toMatchObject({ ok: false, attempts: 2 });
    expect(result.error).toContain('network down');
  });

  it('never sends credentials or synchronized rows to a custom Supabase-domain path', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const pushResult = await pushToSupabaseWithRetry(
      'https://project.supabase.co/functions/v1/collector?x=',
      'stored-service-key',
      pushCredentials(),
      { maxAttempts: 1 },
    );
    const pullResult = await pullFromSupabase(
      'https://project.supabase.co/functions/v1/collector?x=',
      'stored-service-key',
    );

    expect(pushResult.ok).toBe(false);
    expect(pullResult.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
