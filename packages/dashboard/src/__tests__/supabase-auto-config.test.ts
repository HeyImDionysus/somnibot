import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureDiscordAuthProvider,
  getDashboardBaseUrl,
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

  it('falls back to VERCEL_URL with https when no app URL is configured', () => {
    expect(getDashboardBaseUrl({
      NEXT_PUBLIC_APP_URL: '',
      VERCEL_URL: 'preview.vercel.app/',
    })).toBe('https://preview.vercel.app');
  });

  it('falls back to localhost for local first-run setup', () => {
    expect(getDashboardBaseUrl({})).toBe('http://localhost:3000');
  });

  it('patches Supabase auth config with the configured dashboard callback URL', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    process.env.SUPABASE_ACCESS_TOKEN = 'supabase-management-token';
    process.env.DISCORD_APPLICATION_ID = '123456789012345678';
    process.env.DISCORD_CLIENT_SECRET = 'discord-client-secret';
    process.env.NEXT_PUBLIC_APP_URL = 'https://dashboard.example.com/';
    process.env.VERCEL_URL = 'preview.vercel.app';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          EXTERNAL_DISCORD_ENABLED: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
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
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const patchRequest = fetchMock.mock.calls[2];
    expect(patchRequest[0]).toBe(
      'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth',
    );
    expect(patchRequest[1]?.method).toBe('PATCH');

    const body = JSON.parse(String(patchRequest[1]?.body));
    expect(body.URI_ALLOW_LIST).toContain('https://existing.example.com/api/auth/callback');
    expect(body.URI_ALLOW_LIST).toContain('https://dashboard.example.com/api/auth/callback');
    expect(body.URI_ALLOW_LIST).not.toContain('https://undefined');
  });
});
