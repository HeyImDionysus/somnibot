import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureDiscordAuthProvider,
  getDashboardBaseUrl,
  getDashboardCallbackUrls,
  getDiscordAuthProviderStatus,
} from '@/lib/supabase/auto-config';

describe('Supabase Discord auth auto-config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prefers NEXT_PUBLIC_APP_URL for callback allow-listing', () => {
    expect(getDashboardBaseUrl({
      NEXT_PUBLIC_APP_URL: 'https://dashboard.example.com/',
      VERCEL_URL: 'preview.vercel.app',
    })).toBe('https://dashboard.example.com');
  });

  it('prefers the launcher public callback base over public app URL', () => {
    expect(getDashboardBaseUrl({
      SOMNIBOT_PUBLIC_CALLBACK_BASE_URL: 'https://somnibot.tailnet.ts.net/',
      NEXT_PUBLIC_APP_URL: 'https://stale-public.example.com/',
    })).toBe('https://somnibot.tailnet.ts.net');
  });

  it('ignores blank launcher callback base and falls back to public app URL', () => {
    expect(getDashboardBaseUrl({
      SOMNIBOT_PUBLIC_CALLBACK_BASE_URL: '  ',
      NEXT_PUBLIC_APP_URL: 'https://dashboard.example.com/',
    })).toBe('https://dashboard.example.com');
  });

  it('falls back to VERCEL_URL with https when no app URL is configured', () => {
    expect(getDashboardBaseUrl({
      NEXT_PUBLIC_APP_URL: '',
      VERCEL_URL: 'preview.vercel.app/',
    })).toBe('https://preview.vercel.app');
  });

  it('falls back to localhost for local first-run setup', () => {
    expect(getDashboardBaseUrl({})).toBe('http://localhost:3000');
  });

  it('includes both public and local dashboard callbacks for regular local mode', () => {
    expect(getDashboardCallbackUrls({
      NEXT_PUBLIC_APP_URL: 'https://public-callback.example/',
      DASHBOARD_URL: 'http://localhost:3000/',
    })).toEqual([
      'https://public-callback.example/api/auth/callback',
      'http://localhost:3000/api/auth/callback',
    ]);
  });

  it('allow-lists the launcher public callback and local operator callback', () => {
    expect(getDashboardCallbackUrls({
      NEXT_PUBLIC_APP_URL: 'https://somnibot.tailnet.ts.net/',
      DASHBOARD_URL: 'http://localhost:3456/',
    })).toEqual([
      'https://somnibot.tailnet.ts.net/api/auth/callback',
      'http://localhost:3456/api/auth/callback',
    ]);
  });

  it('prioritizes explicit manual Discord auth provider confirmation over a stale token', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    process.env.SUPABASE_ACCESS_TOKEN = 'stale-or-unusable-token';
    process.env.SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED = 'true';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDiscordAuthProvider();

    expect(result).toEqual({ success: true, alreadyConfigured: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a setup-provided management token when env does not have one', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    process.env.DISCORD_APPLICATION_ID = '123456789012345678';
    process.env.DISCORD_CLIENT_SECRET = 'discord-client-secret';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          EXTERNAL_DISCORD_ENABLED: true,
          SITE_URL: 'http://localhost:3000',
          URI_ALLOW_LIST: 'http://localhost:3000/api/auth/callback',
        }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDiscordAuthProvider({ accessToken: 'setup-provided-token' });

    expect(result).toEqual({ success: true, alreadyConfigured: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer setup-provided-token',
        }),
      }),
    );
  });

  it('uses ephemeral submitted Discord credentials without a plaintext database fallback', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    delete process.env.DISCORD_APPLICATION_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ external_discord_enabled: false, site_url: 'http://localhost:3000', uri_allow_list: '' }),
      })
      .mockResolvedValueOnce({ ok: true, text: async () => '' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          external_discord_enabled: true,
          site_url: 'http://localhost:3000',
          uri_allow_list: 'http://localhost:3000/api/auth/callback',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDiscordAuthProvider({
      accessToken: 'setup-provided-token',
      discordClientId: 'submitted-client-id',
      discordClientSecret: 'submitted-client-secret',
    });

    expect(result.success).toBe(true);
    const patchBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(patchBody.external_discord_client_id).toBe('submitted-client-id');
    expect(patchBody.external_discord_secret).toBe('submitted-client-secret');
  });

  it('uses the server Supabase URL project ref when public Supabase env is stale', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://oldpublicproject.supabase.co';
    process.env.SUPABASE_URL = 'https://newserverproject.supabase.co';
    process.env.DISCORD_APPLICATION_ID = '123456789012345678';
    process.env.DISCORD_CLIENT_SECRET = 'discord-client-secret';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          EXTERNAL_DISCORD_ENABLED: true,
          SITE_URL: 'http://localhost:3000',
          URI_ALLOW_LIST: 'http://localhost:3000/api/auth/callback',
        }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDiscordAuthProvider({ accessToken: 'setup-provided-token' });

    expect(result).toEqual({ success: true, alreadyConfigured: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/projects/newserverproject/config/auth',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer setup-provided-token',
        }),
      }),
    );
  });

  it('passes a timeout signal to Supabase Management API status reads', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          EXTERNAL_DISCORD_ENABLED: true,
          SITE_URL: 'http://localhost:3000',
          URI_ALLOW_LIST: 'http://localhost:3000/api/auth/callback',
        }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await getDiscordAuthProviderStatus({
      accessToken: 'setup-provided-token',
      timeoutMs: 3_000,
    });

    expect(result).toMatchObject({
      ready: true,
      providerEnabled: true,
      callbackAllowListReady: true,
      manualConfigured: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('patches a missing dashboard callback when Discord provider is already enabled', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    process.env.SUPABASE_ACCESS_TOKEN = 'supabase-management-token';
    process.env.NEXT_PUBLIC_APP_URL = 'https://dashboard.example.com/';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          external_discord_enabled: true,
          site_url: 'https://dashboard.example.com',
          uri_allow_list: 'https://existing.example.com/api/auth/callback',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          external_discord_enabled: true,
          site_url: 'https://dashboard.example.com',
          uri_allow_list: 'https://existing.example.com/api/auth/callback,https://dashboard.example.com/api/auth/callback',
        }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDiscordAuthProvider();

    expect(result).toEqual({ success: true, alreadyConfigured: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const patchRequest = fetchMock.mock.calls[1];
    expect(patchRequest[0]).toBe(
      'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth',
    );
    expect(patchRequest[1]?.method).toBe('PATCH');

    const body = JSON.parse(String(patchRequest[1]?.body));
    expect(body).toEqual({
      site_url: 'https://dashboard.example.com',
      uri_allow_list: expect.stringContaining('https://dashboard.example.com/api/auth/callback'),
    });
    expect(body.uri_allow_list).toContain('https://existing.example.com/api/auth/callback');
    expect(body.external_discord_client_id).toBeUndefined();
    expect(body.external_discord_secret).toBeUndefined();
  });

  it('replaces a stale Supabase site URL without removing existing callback URLs', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    process.env.SUPABASE_ACCESS_TOKEN = 'supabase-management-token';
    process.env.NEXT_PUBLIC_APP_URL = 'https://dashboard.example.com/';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          external_discord_enabled: true,
          site_url: 'https://old-dashboard.example.com',
          uri_allow_list: 'https://dashboard.example.com/api/auth/callback,https://old-dashboard.example.com/api/auth/callback',
        }),
      })
      .mockResolvedValueOnce({ ok: true, text: async () => '' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          external_discord_enabled: true,
          site_url: 'https://dashboard.example.com',
          uri_allow_list: 'https://dashboard.example.com/api/auth/callback,https://old-dashboard.example.com/api/auth/callback',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDiscordAuthProvider();

    expect(result).toEqual({ success: true, alreadyConfigured: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const patchBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(patchBody).toEqual({
      site_url: 'https://dashboard.example.com',
      uri_allow_list: 'https://dashboard.example.com/api/auth/callback,https://old-dashboard.example.com/api/auth/callback',
    });
  });

  it('patches Supabase auth config with the configured dashboard callback URL', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    process.env.SUPABASE_ACCESS_TOKEN = 'supabase-management-token';
    process.env.DISCORD_APPLICATION_ID = '123456789012345678';
    process.env.DISCORD_CLIENT_SECRET = 'discord-client-secret';
    process.env.NEXT_PUBLIC_APP_URL = 'https://dashboard.example.com/';
    process.env.DASHBOARD_URL = 'http://localhost:3000';
    process.env.VERCEL_URL = 'preview.vercel.app';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          external_discord_enabled: false,
          site_url: 'https://old-dashboard.example.com',
          uri_allow_list: 'https://existing.example.com/api/auth/callback',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          external_discord_enabled: true,
          site_url: 'https://dashboard.example.com',
          uri_allow_list: 'https://existing.example.com/api/auth/callback,https://dashboard.example.com/api/auth/callback,http://localhost:3000/api/auth/callback',
        }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDiscordAuthProvider();

    expect(result).toEqual({ success: true, alreadyConfigured: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const patchRequest = fetchMock.mock.calls[1];
    expect(patchRequest[0]).toBe(
      'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth',
    );
    expect(patchRequest[1]?.method).toBe('PATCH');

    const body = JSON.parse(String(patchRequest[1]?.body));
    expect(body.uri_allow_list).toContain('https://existing.example.com/api/auth/callback');
    expect(body.uri_allow_list).toContain('https://dashboard.example.com/api/auth/callback');
    expect(body.uri_allow_list).toContain('http://localhost:3000/api/auth/callback');
    expect(body.uri_allow_list).not.toContain('https://undefined');
    expect(body.site_url).toBe('https://dashboard.example.com');
    expect(body.external_discord_enabled).toBe(true);
    expect(body.external_discord_client_id).toBe('123456789012345678');
    expect(body.external_discord_secret).toBe('discord-client-secret');
  });

  it('fails closed when a successful PATCH does not persist every runtime callback', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    process.env.SUPABASE_ACCESS_TOKEN = 'supabase-management-token';
    process.env.NEXT_PUBLIC_APP_URL = 'https://dashboard.example.com/';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          external_discord_enabled: true,
          site_url: 'https://dashboard.example.com',
          uri_allow_list: 'https://dashboard.example.com/api/auth/callback',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          external_discord_enabled: true,
          site_url: 'https://dashboard.example.com',
          uri_allow_list: 'https://dashboard.example.com/api/auth/callback',
        }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDiscordAuthProvider({
      callbackUrls: ['http://localhost:3456/api/auth/callback'],
    });

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('verification did not prove Discord auth readiness');
    expect(result.error).toContain('http://localhost:3456/api/auth/callback');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const patchRequest = fetchMock.mock.calls[1];
    expect(JSON.parse(String(patchRequest[1]?.body)).uri_allow_list).toContain(
      'http://localhost:3456/api/auth/callback',
    );
  });
});
