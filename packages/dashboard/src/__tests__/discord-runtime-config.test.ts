import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { encryptCloudCredential } from '@/lib/cloud-credential-crypto';
import { getDiscordRuntimeConfig } from '@/lib/discord-runtime-config';
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
        encryptedSecret,
      ],
      error: null,
    });

    await expect(getDiscordRuntimeConfig()).resolves.toEqual({
      applicationId: '222222222222222222',
      clientSecret: 'saved-secret',
      sources: { applicationId: 'saved', clientSecret: 'saved' },
    });
  });

  it('fails closed when the saved settings query fails', async () => {
    registerTable(mock, 'instance_settings').limit.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(getDiscordRuntimeConfig()).rejects.toThrow('saved Discord settings query failed');
  });
});
