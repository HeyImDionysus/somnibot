/**
 * Tests for /api/setup first-run finalization behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/auto-config', () => ({
  ensureDiscordAuthProvider: vi.fn(),
  getDiscordAuthProviderStatus: vi.fn(),
}));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));

import { createClient } from '@supabase/supabase-js';
import { GET, POST } from '@/app/api/setup/route';
import { ensureDiscordAuthProvider, getDiscordAuthProviderStatus } from '@/lib/supabase/auto-config';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

import {
  buildRequest,
  createMockSupabase,
  mockRateLimitPass,
  registerTable,
} from './helpers';

function configureReadyPayPalEnv() {
  process.env.PAYPAL_CLIENT_ID = 'paypal-client-id';
  process.env['PAYPAL_CLIENT_SECRET'] = 'paypal-client-secret';
  process.env.PAYPAL_WEBHOOK_ID = 'WH-123';
  process.env.PAYPAL_WEBHOOK_URL = 'https://dashboard.example.com/api/paypal/webhook';
  process.env.PAYPAL_SANDBOX = 'true';
}

function configureFinalizeOwnerProof(mock: ReturnType<typeof createMockSupabase>, options: {
  guildDetected?: boolean;
  botOnline?: boolean;
} = {}) {
  const guildTable = registerTable(mock, 'guild');
  guildTable.limit.mockReturnThis();
  guildTable.maybeSingle.mockResolvedValue({
    data: options.guildDetected === false ? null : { id: 'guild-1', name: 'Somni Guild' },
    error: null,
  });

  const diagnosticsTable = registerTable(mock, 'bot_diagnostics');
  diagnosticsTable.limit.mockReturnThis();
  diagnosticsTable.order.mockReturnThis();
  diagnosticsTable.maybeSingle.mockResolvedValue({
    data: options.botOnline === false ? null : { snapshot_at: new Date().toISOString() },
    error: null,
  });
}

describe('POST /api/setup finalize', () => {
  const originalEnv = { ...process.env };
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    };
    delete process.env.DASHBOARD_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.PAYPAL_WEBHOOK_URL;
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_WEBHOOK_ID;
    delete process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL;
    delete process.env.SOMNIBOT_PUBLIC_CALLBACK_REQUIRED;
    mock = createMockSupabase();
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    (getDiscordAuthProviderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ready: false,
      providerEnabled: false,
      callbackAllowListReady: false,
      missingCallbackUrls: ['http://localhost:3000/api/auth/callback'],
      manualConfigured: false,
    });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('does not lock setup when Discord auth auto-config fails', async () => {
    configureReadyPayPalEnv();
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'SUPABASE_ACCESS_TOKEN not set',
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'finalize' },
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: 'SUPABASE_ACCESS_TOKEN not set',
      authConfigured: false,
      authError: 'SUPABASE_ACCESS_TOKEN not set',
      setupLocked: false,
    });
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });

  it('locks setup only after Discord auth is configured', async () => {
    configureReadyPayPalEnv();
    configureFinalizeOwnerProof(mock);
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: true,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'finalize' },
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      authConfigured: true,
      authError: null,
      setupLocked: true,
    });
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'setup_completed_at',
        section: 'system',
      }),
      { onConflict: 'key' },
    );
    expect(mock._tables.bot_diagnostics.eq).toHaveBeenCalledWith('guild_id', 'guild-1');
    expect(mock._tables.bot_diagnostics.eq).toHaveBeenCalledWith('type', 'health');
  });

  it('does not lock setup when Discord provider is enabled without the dashboard callback allow-list', async () => {
    configureReadyPayPalEnv();
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'Discord auth provider is enabled, but the dashboard callback URL is missing from Supabase URI_ALLOW_LIST.',
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'finalize' },
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: 'Discord auth provider is enabled, but the dashboard callback URL is missing from Supabase URI_ALLOW_LIST.',
      authConfigured: false,
      authError: 'Discord auth provider is enabled, but the dashboard callback URL is missing from Supabase URI_ALLOW_LIST.',
      setupLocked: false,
    });
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });

  it('passes a submitted Supabase access token into auth auto-config before locking setup', async () => {
    configureReadyPayPalEnv();
    configureFinalizeOwnerProof(mock);
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: false,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: {
        action: 'finalize',
        credentials: {
          supabase_access_token: 'setup-provided-token',
        },
      },
    }));

    expect(res.status).toBe(200);
    expect(ensureDiscordAuthProvider).toHaveBeenCalledWith({
      accessToken: 'setup-provided-token',
    });
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'supabase_access_token',
        value: 'setup-provided-token',
        section: 'supabase',
      }),
      { onConflict: 'key' },
    );
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'setup_completed_at',
        section: 'system',
      }),
      { onConflict: 'key' },
    );
  });

  it('saves submitted PayPal config and applies it to runtime env before locking setup', async () => {
    const paypalClientSecretKey = 'PAYPAL_CLIENT_SECRET';
    process.env.PAYPAL_CLIENT_ID = 'old-paypal-client-id';
    process.env[paypalClientSecretKey] = 'old-paypal-client-secret';
    process.env.PAYPAL_WEBHOOK_ID = 'OLD-WH';
    process.env.PAYPAL_WEBHOOK_URL = 'https://old.example.com/api/paypal/webhook';
    process.env.PAYPAL_SANDBOX = 'true';
    configureFinalizeOwnerProof(mock);
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: false,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: {
        action: 'finalize',
        credentials: {
          paypal_client_id: 'paypal-client-id',
          paypal_client_secret: 'paypal-client-secret',
          paypal_webhook_id: 'WH-123',
          paypal_webhook_url: 'https://dashboard.example.com/api/paypal/webhook',
          paypal_sandbox: 'false',
        },
      },
    }));

    expect(res.status).toBe(200);
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'paypal_client_id',
        value: 'paypal-client-id',
        section: 'paypal',
      }),
      { onConflict: 'key' },
    );
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'paypal_sandbox',
        value: 'false',
        section: 'paypal',
      }),
      { onConflict: 'key' },
    );
    expect(process.env.PAYPAL_CLIENT_ID).toBe('paypal-client-id');
    expect(process.env[paypalClientSecretKey]).toBe('paypal-client-secret');
    expect(process.env.PAYPAL_WEBHOOK_ID).toBe('WH-123');
    expect(process.env.PAYPAL_WEBHOOK_URL).toBe('https://dashboard.example.com/api/paypal/webhook');
    expect(process.env.PAYPAL_SANDBOX).toBe('false');
  });

  it('stores launcher-derived public callback and PayPal webhook values before locking setup', async () => {
    vi.stubEnv('DASHBOARD_URL', 'http://localhost:3456');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_BASE_URL', 'https://somnibot.tailnet.ts.net/');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://somnibot.tailnet.ts.net/');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_REQUIRED', 'true');
    vi.stubEnv('PAYPAL_WEBHOOK_URL', 'https://old.example.com/api/paypal/webhook');
    vi.stubEnv('PAYPAL_CLIENT_ID', 'paypal-client-id');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'paypal-client-secret');
    vi.stubEnv('PAYPAL_WEBHOOK_ID', 'WH-123');
    configureFinalizeOwnerProof(mock);
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: false,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: {
        action: 'finalize',
        credentials: {
          paypal_webhook_url: 'https://old.example.com/api/paypal/webhook',
        },
      },
    }));

    expect(res.status).toBe(200);
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'dashboard_url',
        value: 'https://somnibot.tailnet.ts.net',
        section: 'deployment',
      }),
      { onConflict: 'key' },
    );
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'paypal_webhook_url',
        value: 'https://somnibot.tailnet.ts.net/api/paypal/webhook',
        section: 'paypal',
      }),
      { onConflict: 'key' },
    );
    expect(process.env.PAYPAL_WEBHOOK_URL).toBe('https://somnibot.tailnet.ts.net/api/paypal/webhook');
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'setup_completed_at',
        section: 'system',
      }),
      { onConflict: 'key' },
    );
  });

  it('stores VPS public callback and PayPal webhook values before locking setup', async () => {
    vi.stubEnv('DASHBOARD_URL', 'https://somnibot.example.com/');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_BASE_URL', 'https://somnibot.example.com/');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://somnibot.example.com/');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_REQUIRED', 'true');
    vi.stubEnv('PAYPAL_CLIENT_ID', 'paypal-client-id');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'paypal-client-secret');
    vi.stubEnv('PAYPAL_WEBHOOK_ID', 'WH-123');
    configureFinalizeOwnerProof(mock);
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: false,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'finalize' },
    }));

    expect(res.status).toBe(200);
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'dashboard_url',
        value: 'https://somnibot.example.com',
        section: 'deployment',
      }),
      { onConflict: 'key' },
    );
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'paypal_webhook_url',
        value: 'https://somnibot.example.com/api/paypal/webhook',
        section: 'paypal',
      }),
      { onConflict: 'key' },
    );
    expect(process.env.PAYPAL_WEBHOOK_URL).toBe('https://somnibot.example.com/api/paypal/webhook');
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'setup_completed_at',
        section: 'system',
      }),
      { onConflict: 'key' },
    );
  });

  it('does not lock setup when the PayPal webhook ID is missing', async () => {
    process.env.PAYPAL_CLIENT_ID = 'paypal-client-id';
    process.env['PAYPAL_CLIENT_SECRET'] = 'paypal-client-secret';
    process.env.PAYPAL_WEBHOOK_URL = 'https://dashboard.example.com/api/paypal/webhook';
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: true,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'finalize' },
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: 'PayPal Webhook ID is required before setup can finalize.',
      setupLocked: false,
    });
    expect(ensureDiscordAuthProvider).not.toHaveBeenCalled();
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });

  it('locks setup with previously saved PayPal values after a blocked retry or restart', async () => {
    const instanceSettingsTable = registerTable(mock, 'instance_settings');
    instanceSettingsTable.maybeSingle.mockResolvedValue({ data: null, error: null });
    instanceSettingsTable.limit.mockResolvedValueOnce({
      data: [
        { key: 'paypal_client_id', value: 'saved-paypal-client-id' },
        { key: 'paypal_client_secret', value: 'saved-paypal-client-secret' },
        { key: 'paypal_webhook_id', value: 'WH-SAVED' },
        { key: 'paypal_webhook_url', value: 'https://dashboard.example.com/api/paypal/webhook' },
      ],
      error: null,
    });
    configureFinalizeOwnerProof(mock);
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: true,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'finalize' },
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      authConfigured: true,
      authError: null,
      setupLocked: true,
    });
    expect(instanceSettingsTable.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'setup_completed_at',
        section: 'system',
      }),
      { onConflict: 'key' },
    );
  });

  it('does not lock setup when no Discord guild is detected', async () => {
    configureReadyPayPalEnv();
    configureFinalizeOwnerProof(mock, { guildDetected: false });
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: true,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'finalize' },
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: 'Invite SomniBot to a Discord server before setup can finalize.',
      setupLocked: false,
    });
    expect(mock._query.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'setup_completed_at' }),
      { onConflict: 'key' },
    );
    expect(mock._tables.bot_diagnostics.maybeSingle).not.toHaveBeenCalled();
  });

  it('does not lock setup when the bot health heartbeat is missing', async () => {
    configureReadyPayPalEnv();
    configureFinalizeOwnerProof(mock, { botOnline: false });
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: true,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'finalize' },
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: 'Start SomniBot and wait for a fresh bot health heartbeat before setup can finalize.',
      setupLocked: false,
    });
    expect(mock._query.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'setup_completed_at' }),
      { onConflict: 'key' },
    );
  });

  it('does not lock setup with an invalid submitted PayPal webhook URL', async () => {
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: false,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: {
        action: 'finalize',
        credentials: {
          paypal_webhook_url: 'http://localhost:3456/api/paypal/webhook',
        },
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: 'PayPal webhook URL must use HTTPS before it can be marked ready.',
      setupLocked: false,
    });
    expect(ensureDiscordAuthProvider).not.toHaveBeenCalled();
    expect(mock._query.upsert).not.toHaveBeenCalled();
    expect(process.env.PAYPAL_WEBHOOK_URL).toBeUndefined();
  });

  it('does not lock setup when a required public callback URL is still local', async () => {
    vi.stubEnv('DASHBOARD_URL', 'http://localhost:3456');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_BASE_URL', 'http://localhost:3456');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3456');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_REQUIRED', 'true');
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: false,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'finalize' },
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: 'Public callback URL must use HTTPS before setup can finalize.',
      publicCallbackReady: false,
      setupLocked: false,
    });
    expect(ensureDiscordAuthProvider).not.toHaveBeenCalled();
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });

  it('blocks configure-auth before provider mutation when a required public callback is not ready', async () => {
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_BASE_URL', 'http://localhost:3456');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_REQUIRED', 'true');
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: false,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'configure-auth' },
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: 'Public callback URL must use HTTPS before setup can finalize.',
      publicCallbackReady: false,
      setupLocked: false,
    });
    expect(ensureDiscordAuthProvider).not.toHaveBeenCalled();
  });

  it('blocks verify-discord auth auto-config before Discord or Supabase provider calls when callback is not ready', async () => {
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_BASE_URL', 'http://localhost:3456');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_REQUIRED', 'true');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: false,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: {
        action: 'verify-discord',
        token: 'discord-bot-token',
        clientId: '123456789012345678',
        clientSecret: 'discord-client-secret',
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: 'Public callback URL must use HTTPS before setup can finalize.',
      publicCallbackReady: false,
      setupLocked: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ensureDiscordAuthProvider).not.toHaveBeenCalled();
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });
});

describe('GET /api/setup status', () => {
  const originalEnv = { ...process.env };
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    };
    delete process.env.DASHBOARD_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.PAYPAL_WEBHOOK_URL;
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_WEBHOOK_ID;
    delete process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL;
    delete process.env.SOMNIBOT_PUBLIC_CALLBACK_REQUIRED;
    delete process.env.DISCORD_APPLICATION_ID;
    delete process.env.DISCORD_CLIENT_SECRET;

    mock = createMockSupabase();
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    (getDiscordAuthProviderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ready: false,
      providerEnabled: true,
      callbackAllowListReady: false,
      missingCallbackUrls: ['http://localhost:3000/api/auth/callback'],
      manualConfigured: false,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('reports saved Discord credentials separately from auth provider readiness', async () => {
    const guildTable = registerTable(mock, 'guild');
    guildTable.limit
      .mockResolvedValueOnce({ error: null })
      .mockReturnThis();

    const instanceSettingsTable = registerTable(mock, 'instance_settings');
    instanceSettingsTable.maybeSingle.mockResolvedValue({ data: null });
    instanceSettingsTable.limit.mockResolvedValueOnce({
      data: [
        { key: 'discord_application_id', value: '123456789012345678' },
        { key: 'discord_client_secret', value: 'discord-client-secret' },
      ],
    });

    const res = await GET(buildRequest('/api/setup'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.supabaseProjectRef).toBe('abcdefghijklmnopqrst');
    expect(body.discordCredentialsPresent).toBe(true);
    expect(body.discordClientId).toBe('123456789012345678');
    expect(body.discordAuthProviderReady).toBe(false);
    expect(body.discordAuthConfigured).toBe(false);
    expect(body.discordAuthProviderStatus).toMatchObject({
      ready: false,
      providerEnabled: true,
      callbackAllowListReady: false,
      missingCallbackUrls: ['http://localhost:3000/api/auth/callback'],
      manualConfigured: false,
      statusReason: 'callback-allow-list-missing',
    });
    expect(body.discordAuthProviderStatus.statusDetail).toContain('allow-list is missing');
    expect(body.discordAuthProviderStatus).not.toHaveProperty('error');
  });

  it('reports a sanitized auth-provider setup wall when the Management API token is missing', async () => {
    (getDiscordAuthProviderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ready: false,
      providerEnabled: false,
      callbackAllowListReady: false,
      missingCallbackUrls: ['https://somnibot.tailnet.ts.net/api/auth/callback'],
      manualConfigured: false,
      error: 'SUPABASE_ACCESS_TOKEN not set',
    });

    const res = await GET(buildRequest('/api/setup'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.discordAuthProviderStatus).toMatchObject({
      ready: false,
      providerEnabled: false,
      callbackAllowListReady: false,
      missingCallbackUrls: ['https://somnibot.tailnet.ts.net/api/auth/callback'],
      manualConfigured: false,
      statusReason: 'management-token-missing',
    });
    expect(body.discordAuthProviderStatus.statusDetail).toContain('Management API token');
    expect(body.discordAuthProviderStatus.statusDetail).toContain('confirm');
    expect(body.discordAuthProviderStatus).not.toHaveProperty('error');
  });

  it('bounds auth-provider status checks on setup status reads', async () => {
    await GET(buildRequest('/api/setup'));

    expect(getDiscordAuthProviderStatus).toHaveBeenCalledWith({
      timeoutMs: 3_000,
    });
  });

  it('does not report unknown auth-provider check failures as a disabled provider', async () => {
    (getDiscordAuthProviderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ready: false,
      providerEnabled: false,
      callbackAllowListReady: false,
      missingCallbackUrls: ['https://somnibot.tailnet.ts.net/api/auth/callback'],
      manualConfigured: false,
      error: 'Failed to check Discord auth provider: TypeError: fetch failed',
    });

    const res = await GET(buildRequest('/api/setup'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.discordAuthProviderStatus).toMatchObject({
      ready: false,
      providerEnabled: false,
      callbackAllowListReady: false,
      statusReason: 'unknown',
    });
    expect(body.discordAuthProviderStatus.statusDetail).toContain('could not be verified');
    expect(body.discordAuthProviderStatus).not.toHaveProperty('error');
  });

  it('reports launcher-derived callback and webhook URLs for the setup wizard', async () => {
    vi.stubEnv('DASHBOARD_URL', 'http://localhost:3456/');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_BASE_URL', 'https://somnibot.tailnet.ts.net/');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://somnibot.tailnet.ts.net/');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_REQUIRED', 'true');
    vi.stubEnv('PAYPAL_WEBHOOK_URL', 'https://old.example.com/api/paypal/webhook');
    vi.stubEnv('PAYPAL_CLIENT_ID', 'paypal-client-id');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'paypal-client-secret');
    vi.stubEnv('PAYPAL_WEBHOOK_ID', 'WH-123');

    const res = await GET(buildRequest('/api/setup'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.dashboardUrl).toBe('https://somnibot.tailnet.ts.net');
    expect(body.operatorDashboardUrl).toBe('http://localhost:3456');
    expect(body.publicCallbackBaseUrl).toBe('https://somnibot.tailnet.ts.net');
    expect(body.supabaseProjectRef).toBe('abcdefghijklmnopqrst');
    expect(body.paypalWebhookUrl).toBe('https://somnibot.tailnet.ts.net/api/paypal/webhook');
    expect(body.paypalWebhookUrlReady).toBe(true);
    expect(body.paypalWebhookReady).toBe(true);
    expect(body.paypalWebhookError).toBeNull();
    expect(body.publicCallbackRequired).toBe(true);
    expect(body.publicCallbackReady).toBe(true);
    expect(body.publicCallbackError).toBeNull();
  });

  it('derives setup PayPal webhook readiness from the current callback base instead of stale env', async () => {
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_BASE_URL', 'https://somnibot.tailnet.ts.net/');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://somnibot.tailnet.ts.net/');
    vi.stubEnv('PAYPAL_WEBHOOK_URL', 'https://old.example.com/api/paypal/webhook');
    vi.stubEnv('PAYPAL_CLIENT_ID', 'paypal-client-id');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'paypal-client-secret');
    vi.stubEnv('PAYPAL_WEBHOOK_ID', 'WH-123');

    const res = await GET(buildRequest('/api/setup'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.publicCallbackBaseUrl).toBe('https://somnibot.tailnet.ts.net');
    expect(body.paypalWebhookUrl).toBe('https://somnibot.tailnet.ts.net/api/paypal/webhook');
    expect(body.paypalWebhookUrlReady).toBe(true);
    expect(body.paypalWebhookReady).toBe(true);
    expect(body.paypalWebhookError).toBeNull();
  });

  it('does not report a local explicit PayPal webhook URL as ready', async () => {
    vi.stubEnv('PAYPAL_WEBHOOK_URL', 'http://localhost:3456/api/paypal/webhook');

    const res = await GET(buildRequest('/api/setup'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.paypalWebhookUrl).toBeNull();
    expect(body.paypalWebhookUrlReady).toBe(false);
    expect(body.paypalWebhookReady).toBe(false);
    expect(body.paypalWebhookError).toBe('PayPal webhook URL must use HTTPS before it can be marked ready.');
  });

  it('uses a valid explicit PayPal webhook URL when the optional app URL is local', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
    vi.stubEnv('PAYPAL_WEBHOOK_URL', 'https://webhooks.example.com/api/paypal/webhook');
    vi.stubEnv('PAYPAL_CLIENT_ID', 'paypal-client-id');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'paypal-client-secret');
    vi.stubEnv('PAYPAL_WEBHOOK_ID', 'WH-123');

    const res = await GET(buildRequest('/api/setup'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.publicCallbackRequired).toBe(false);
    expect(body.publicCallbackBaseUrl).toBe('http://localhost:3000');
    expect(body.paypalWebhookUrl).toBe('https://webhooks.example.com/api/paypal/webhook');
    expect(body.paypalWebhookUrlReady).toBe(true);
    expect(body.paypalWebhookReady).toBe(true);
    expect(body.paypalWebhookError).toBeNull();
  });

  it('reports a valid PayPal webhook URL as incomplete until PayPal credentials and webhook ID are configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
    vi.stubEnv('PAYPAL_WEBHOOK_URL', 'https://webhooks.example.com/api/paypal/webhook');

    const res = await GET(buildRequest('/api/setup'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.paypalWebhookUrl).toBe('https://webhooks.example.com/api/paypal/webhook');
    expect(body.paypalWebhookUrlReady).toBe(true);
    expect(body.paypalWebhookReady).toBe(false);
    expect(body.paypalWebhookError).toBe('PayPal Client ID and Client Secret are required before setup can finalize.');
  });

  it('reports saved PayPal values as ready after a setup retry or restart', async () => {
    const guildTable = registerTable(mock, 'guild');
    guildTable.limit
      .mockResolvedValueOnce({ error: null })
      .mockReturnThis();
    guildTable.maybeSingle.mockResolvedValue({
      data: { id: 'guild-1', name: 'Somni Guild' },
      error: null,
    });

    const diagnosticsTable = registerTable(mock, 'bot_diagnostics');
    diagnosticsTable.maybeSingle.mockResolvedValue({
      data: { snapshot_at: new Date().toISOString() },
      error: null,
    });

    const instanceSettingsTable = registerTable(mock, 'instance_settings');
    instanceSettingsTable.maybeSingle.mockResolvedValue({ data: null, error: null });
    instanceSettingsTable.limit.mockResolvedValueOnce({
      data: [
        { key: 'paypal_client_id', value: 'saved-paypal-client-id' },
        { key: 'paypal_client_secret', value: 'saved-paypal-client-secret' },
        { key: 'paypal_webhook_id', value: 'WH-SAVED' },
        { key: 'paypal_webhook_url', value: 'https://dashboard.example.com/api/paypal/webhook' },
      ],
      error: null,
    });

    const res = await GET(buildRequest('/api/setup'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.paypalWebhookUrl).toBe('https://dashboard.example.com/api/paypal/webhook');
    expect(body.paypalWebhookUrlReady).toBe(true);
    expect(body.paypalCredentialsConfigured).toBe(true);
    expect(body.paypalWebhookIdConfigured).toBe(true);
    expect(body.paypalWebhookReady).toBe(true);
    expect(body.paypalWebhookError).toBeNull();
    expect(diagnosticsTable.eq).toHaveBeenCalledWith('guild_id', 'guild-1');
    expect(diagnosticsTable.eq).toHaveBeenCalledWith('type', 'health');
  });

  it('reports VPS callback and webhook URLs for the setup wizard', async () => {
    vi.stubEnv('DASHBOARD_URL', 'https://somnibot.example.com/');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_BASE_URL', 'https://somnibot.example.com/');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://somnibot.example.com/');
    vi.stubEnv('SOMNIBOT_PUBLIC_CALLBACK_REQUIRED', 'true');
    vi.stubEnv('PAYPAL_CLIENT_ID', 'paypal-client-id');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'paypal-client-secret');
    vi.stubEnv('PAYPAL_WEBHOOK_ID', 'WH-123');

    const res = await GET(buildRequest('/api/setup'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.dashboardUrl).toBe('https://somnibot.example.com');
    expect(body.operatorDashboardUrl).toBe('https://somnibot.example.com');
    expect(body.publicCallbackBaseUrl).toBe('https://somnibot.example.com');
    expect(body.paypalWebhookUrl).toBe('https://somnibot.example.com/api/paypal/webhook');
    expect(body.paypalWebhookUrlReady).toBe(true);
    expect(body.paypalWebhookReady).toBe(true);
    expect(body.paypalWebhookError).toBeNull();
    expect(body.publicCallbackRequired).toBe(true);
    expect(body.publicCallbackReady).toBe(true);
    expect(body.publicCallbackError).toBeNull();
  });
});

describe('POST /api/setup verify-supabase', () => {
  const originalEnv = { ...process.env };
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mock = createMockSupabase();
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('saves publishable key separately from the server-only secret key', async () => {
    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: {
        action: 'verify-supabase',
        url: 'https://abcdefghijklmnopqrst.supabase.co',
        publishableKey: 'sb_publishable_test',
        serviceRoleKey: 'sb_secret_test',
      },
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      valid: true,
      initialized: true,
      credentialsSaved: true,
    });
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'supabase_anon_key',
        value: 'sb_publishable_test',
        section: 'supabase',
      }),
      { onConflict: 'key' },
    );
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'supabase_secret_key',
        value: 'sb_secret_test',
        section: 'supabase',
      }),
      { onConflict: 'key' },
    );
    expect(process.env.SUPABASE_PUBLISHABLE_KEY).toBe('sb_publishable_test');
    expect(process.env.SUPABASE_SECRET_KEY).toBe('sb_secret_test');
    expect(fetch).toHaveBeenCalledWith(
      'https://abcdefghijklmnopqrst.supabase.co/auth/v1/settings',
      expect.objectContaining({
        headers: {
          apikey: 'sb_publishable_test',
          Authorization: 'Bearer sb_publishable_test',
        },
      }),
    );
  });

  it('rejects invalid publishable keys before saving credentials', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: {
        action: 'verify-supabase',
        url: 'https://abcdefghijklmnopqrst.supabase.co',
        publishableKey: 'bad-publishable-key',
        serviceRoleKey: 'sb_secret_test',
      },
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      valid: false,
      error: 'Could not validate Supabase publishable key — check your credentials',
    });
    expect(mock._query.upsert).not.toHaveBeenCalled();
    expect(process.env.SUPABASE_PUBLISHABLE_KEY).toBeUndefined();
    expect(process.env.SUPABASE_SECRET_KEY).toBeUndefined();
  });
});
