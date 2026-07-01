import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}));

describe('Supabase admin client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  it('recreates the cached admin client when Supabase URL or secret env changes', async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const createClientMock = vi.mocked(createClient);
    createClientMock.mockImplementation((url, key) => ({ url, key }) as never);
    const { createAdminSupabase } = await import('@/lib/supabase/admin');

    process.env.SUPABASE_URL = 'https://oldproject.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'old-secret-value';

    const oldClient = createAdminSupabase();
    const cachedOldClient = createAdminSupabase();

    expect(cachedOldClient).toBe(oldClient);
    expect(createClientMock).toHaveBeenCalledTimes(1);

    process.env.SUPABASE_URL = 'https://newproject.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'new-secret-value';

    const newClient = createAdminSupabase();

    expect(newClient).not.toBe(oldClient);
    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(createClientMock).toHaveBeenNthCalledWith(1, 'https://oldproject.supabase.co', 'old-secret-value', {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    expect(createClientMock).toHaveBeenNthCalledWith(2, 'https://newproject.supabase.co', 'new-secret-value', {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });
});
