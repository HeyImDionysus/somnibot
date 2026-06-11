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
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('does not lock setup when Discord auth auto-config fails', async () => {
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
  });

  it('does not lock setup when Discord provider is enabled without the dashboard callback allow-list', async () => {
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
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_WEBHOOK_ID;
    delete process.env.PAYPAL_WEBHOOK_URL;
    delete process.env.PAYPAL_SANDBOX;
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
    expect(process.env.PAYPAL_CLIENT_SECRET).toBe('paypal-client-secret');
    expect(process.env.PAYPAL_WEBHOOK_ID).toBe('WH-123');
    expect(process.env.PAYPAL_WEBHOOK_URL).toBe('https://dashboard.example.com/api/paypal/webhook');
    expect(process.env.PAYPAL_SANDBOX).toBe('false');
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
    expect(body.discordCredentialsPresent).toBe(true);
    expect(body.discordClientId).toBe('123456789012345678');
    expect(body.discordAuthProviderReady).toBe(false);
    expect(body.discordAuthConfigured).toBe(false);
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
    vi.spyOn(console, 'log').mockImplementation(() => {});
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
  });
});
