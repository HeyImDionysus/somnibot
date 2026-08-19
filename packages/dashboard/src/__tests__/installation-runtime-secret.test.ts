import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { encryptCloudCredential } from '@/lib/cloud-credential-crypto';
import { getInstallationRuntimeSecret } from '@/lib/installation-runtime-secret';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createMockSupabase, registerTable } from './helpers';

let admin: ReturnType<typeof createMockSupabase>;

beforeEach(() => {
  vi.resetAllMocks();
  admin = createMockSupabase();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getInstallationRuntimeSecret', () => {
  it('uses a saved encrypted override instead of the deployment fallback', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'service-role-test-key');
    vi.stubEnv('VALKEY_URL', 'redis://environment:6379');
    const encrypted = encryptCloudCredential(
      'redis://saved:6379',
      'valkey_url',
      'service-role-test-key',
      'https://project.supabase.co',
    );
    registerTable(admin, 'instance_settings').maybeSingle.mockResolvedValue({ data: encrypted, error: null });

    await expect(getInstallationRuntimeSecret('valkey_url', ['VALKEY_URL'])).resolves.toBe(
      'redis://saved:6379',
    );
  });

  it('uses the deployment fallback when no saved override exists', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'service-role-test-key');
    vi.stubEnv('VALKEY_URL', 'redis://environment:6379');
    registerTable(admin, 'instance_settings').maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(getInstallationRuntimeSecret('valkey_url', ['VALKEY_URL'])).resolves.toBe(
      'redis://environment:6379',
    );
  });
});
