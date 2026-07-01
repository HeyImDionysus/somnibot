import { afterEach, describe, expect, it } from 'vitest';
import {
  readEnvSupabaseConfig,
  requireAdminSupabaseConfig,
  requireBrowserSupabaseConfig,
  SupabaseRuntimeConfigError,
} from '@/lib/supabase/runtime-config';

describe('Supabase runtime config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reads browser-safe Supabase config from public env only', () => {
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    };

    expect(requireBrowserSupabaseConfig()).toEqual({
      url: 'https://abcdefghijklmnopqrst.supabase.co',
      publishableKey: 'sb_publishable_test',
      sources: { url: 'env', publishableKey: 'env' },
    });
  });

  it('does not rely on server-only Supabase env for browser auth', () => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'https://serveronly.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_server_only',
      SUPABASE_ANON_KEY: 'sb_publishable_anon_only',
    };
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    expect(() => requireBrowserSupabaseConfig()).toThrow(SupabaseRuntimeConfigError);
  });

  it('throws a clear browser-auth block when public env is missing', () => {
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;

    expect(() => requireBrowserSupabaseConfig()).toThrow(SupabaseRuntimeConfigError);
    expect(() => requireBrowserSupabaseConfig()).toThrow('Saved setup values stay server-side');
  });

  it('keeps admin secret config server-only', () => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    };

    expect(requireAdminSupabaseConfig()).toEqual({
      url: 'https://abcdefghijklmnopqrst.supabase.co',
      secretKey: 'sb_secret_test',
      sources: { url: 'env', secretKey: 'env' },
    });
  });

  it('can apply setup-verified Supabase config to the current server process', async () => {
    const { applyRuntimeSupabaseEnv } = await import('@/lib/supabase/runtime-config');

    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_SECRET_KEY;

    applyRuntimeSupabaseEnv({
      url: 'https://savedproject.supabase.co',
      publishableKey: 'sb_publishable_saved',
      secretKey: 'sb_secret_saved',
    });

    expect(readEnvSupabaseConfig()).toEqual({
      url: 'https://savedproject.supabase.co',
      publishableKey: 'sb_publishable_saved',
      secretKey: 'sb_secret_saved',
      sources: { url: 'env', publishableKey: 'env', secretKey: 'env' },
    });
  });
});
