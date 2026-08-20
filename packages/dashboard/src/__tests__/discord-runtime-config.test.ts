import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { encryptCloudCredential } from '@/lib/cloud-credential-crypto';
import {
  getDiscordBotRuntimeConfig,
  getDiscordOAuthRuntimeConfig,
  getDiscordRuntimeConfig,
} from '@/lib/discord-runtime-config';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createMockSupabase, registerTable } from './helpers';

let mock: ReturnType<typeof createMockSupabase>;

beforeEach(() => {
  vi.resetAllMocks();
  mock = createMockSupabase();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getDiscordRuntimeConfig', () => {
  it('uses saved application and secret overrides over environment fallbacks', async () => {
    vi.stubEnv('DISCORD_APPLICATION_ID', '111111111111111111');
    vi.stubEnv('DISCORD_TOKEN', 'environment-token');
    vi.stubEnv('DISCORD_CLIENT_SECRET', 'environment-secret');
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'service-role-test-key');
    const encryptedSecret = encryptCloudCredential(
      'saved-secret',
      'discord_client_secret',
      'service-role-test-key',
      'https://project.supabase.co',
    );
    const encryptedToken = encryptCloudCredential(
      'saved-token',
      'discord_bot_token',
      'service-role-test-key',
      'https://project.supabase.co',
    );
    registerTable(mock, 'instance_settings').limit.mockResolvedValue({
      data: [
        { key: 'discord_application_id', value: '222222222222222222' },
        encryptedToken,
        encryptedSecret,
      ],
      error: null,
    });

    await expect(getDiscordRuntimeConfig()).resolves.toEqual({
      applicationId: '222222222222222222',
      botToken: 'saved-token',
      clientSecret: 'saved-secret',
      sources: { applicationId: 'saved', botToken: 'saved', clientSecret: 'saved' },
    });
  });

  it('fails closed when the saved settings query fails', async () => {
    registerTable(mock, 'instance_settings').limit.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(getDiscordRuntimeConfig()).rejects.toThrow('saved Discord settings query failed');
  });

  it('loads portal OAuth credentials even when the unrelated saved bot token cannot be decrypted', async () => {
    vi.stubEnv('DISCORD_APPLICATION_ID', '111111111111111111');
    vi.stubEnv('DISCORD_CLIENT_SECRET', 'environment-secret');
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'service-role-test-key');
    const encryptedSecret = encryptCloudCredential(
      'saved-secret',
      'discord_client_secret',
      'service-role-test-key',
      'https://project.supabase.co',
    );
    registerTable(mock, 'instance_settings').limit.mockResolvedValue({
      data: [
        { key: 'discord_application_id', value: '222222222222222222' },
        { key: 'discord_bot_token_encrypted', value: 'invalid-ciphertext' },
        encryptedSecret,
      ],
      error: null,
    });

    await expect(getDiscordOAuthRuntimeConfig()).resolves.toEqual({
      applicationId: '222222222222222222',
      clientSecret: 'saved-secret',
      sources: { applicationId: 'saved', clientSecret: 'saved' },
    });
  });

  it('loads the bot token even when the unrelated saved OAuth secret cannot be decrypted', async () => {
    vi.stubEnv('DISCORD_TOKEN', 'environment-token');
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'service-role-test-key');
    const encryptedToken = encryptCloudCredential(
      'saved-token',
      'discord_bot_token',
      'service-role-test-key',
      'https://project.supabase.co',
    );
    registerTable(mock, 'instance_settings').limit.mockResolvedValue({
      data: [
        encryptedToken,
        { key: 'discord_client_secret_encrypted', value: 'invalid-ciphertext' },
      ],
      error: null,
    });

    await expect(getDiscordBotRuntimeConfig()).resolves.toEqual({
      botToken: 'saved-token',
      sources: { botToken: 'saved' },
    });
  });
});
