import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureDiscordAuthProvider,
  getDashboardBaseUrl,
  getDashboardCallbackUrls,
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

  it('patches a missing dashboard callback when Discord provider is already enabled', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    process.env.SUPABASE_ACCESS_TOKEN = 'supabase-management-token';
    process.env.NEXT_PUBLIC_APP_URL = 'https://dashboard.example.com/';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          EXTERNAL_DISCORD_ENABLED: true,
          URI_ALLOW_LIST: 'https://existing.example.com/api/auth/callback',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDiscordAuthProvider();

    expect(result).toEqual({ success: true, alreadyConfigured: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const patchRequest = fetchMock.mock.calls[1];
    expect(patchRequest[0]).toBe(
      'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth',
    );
    expect(patchRequest[1]?.method).toBe('PATCH');

    const body = JSON.parse(String(patchRequest[1]?.body));
    expect(body).toEqual({
      URI_ALLOW_LIST: expect.stringContaining('https://dashboard.example.com/api/auth/callback'),
    });
    expect(body.URI_ALLOW_LIST).toContain('https://existing.example.com/api/auth/callback');
    expect(body.EXTERNAL_DISCORD_CLIENT_ID).toBeUndefined();
    expect(body.EXTERNAL_DISCORD_SECRET).toBeUndefined();
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
          EXTERNAL_DISCORD_ENABLED: false,
          URI_ALLOW_LIST: 'https://existing.example.com/api/auth/callback',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureDiscordAuthProvider();

    expect(result).toEqual({ success: true, alreadyConfigured: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const patchRequest = fetchMock.mock.calls[1];
    expect(patchRequest[0]).toBe(
      'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth',
    );
    expect(patchRequest[1]?.method).toBe('PATCH');

    const body = JSON.parse(String(patchRequest[1]?.body));
    expect(body.URI_ALLOW_LIST).toContain('https://existing.example.com/api/auth/callback');
    expect(body.URI_ALLOW_LIST).toContain('https://dashboard.example.com/api/auth/callback');
    expect(body.URI_ALLOW_LIST).toContain('http://localhost:3000/api/auth/callback');
    expect(body.URI_ALLOW_LIST).not.toContain('https://undefined');
  });
});
