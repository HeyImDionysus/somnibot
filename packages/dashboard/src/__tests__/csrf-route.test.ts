import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabase } from '@/lib/supabase/server';
import { GET } from '@/app/api/csrf/route';

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: vi.fn(),
}));

const mockCreateServerSupabase = vi.mocked(createServerSupabase);

describe('GET /api/csrf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SESSION_TOKEN;
    delete process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE;
    process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';

    mockCreateServerSupabase.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-id-1234567890abcdef' } },
        }),
      },
    } as unknown as Awaited<ReturnType<typeof createServerSupabase>>);
  });

  it('does not use local fixed session when SESSION_TOKEN lacks launcher marker', async () => {
    process.env.SESSION_TOKEN = 'accidental-cloud-token';

    const response = await GET();

    expect(mockCreateServerSupabase).toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('1234567890abcdef');
  });

  it('uses local fixed session only with explicit launcher marker', async () => {
    process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE = '1';
    process.env.SESSION_TOKEN = 'launcher-token';

    const response = await GET();

    expect(mockCreateServerSupabase).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('local-session');
  });
});
