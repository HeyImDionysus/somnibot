import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(),
}));

const mockCreateServerClient = vi.mocked(createServerClient);

describe('middleware health access', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.SESSION_TOKEN;
    delete process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-key';

    mockCreateServerClient.mockReturnValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      },
    } as unknown as ReturnType<typeof createServerClient>);
  });

  it('allows unauthenticated platform monitors to reach /api/health', async () => {
    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/api/health'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('does not touch Supabase auth for /api/health', async () => {
    mockCreateServerClient.mockImplementation(() => {
      throw new Error('health checks must not depend on Supabase auth');
    });

    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/api/health'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('does not bypass remote auth for non-GET /api/health requests', async () => {
    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/api/health', { method: 'POST' }));

    expect(mockCreateServerClient).toHaveBeenCalled();
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('still redirects unauthenticated protected routes to /login', async () => {
    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/dashboard', {
      headers: { host: 'localhost:3000' },
    }));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('does not treat SESSION_TOKEN alone as launcher local mode', async () => {
    process.env.SESSION_TOKEN = 'accidental-cloud-token';

    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/dashboard', {
      headers: { host: 'localhost:3000' },
    }));

    expect(mockCreateServerClient).toHaveBeenCalled();
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('allows launcher local mode only with explicit marker and localhost', async () => {
    process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE = '1';
    process.env.SESSION_TOKEN = 'launcher-token';

    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/dashboard', {
      headers: { host: 'localhost:3000' },
    }));

    expect(mockCreateServerClient).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.cookies.get('somnibot-local-session')?.value).toBe('launcher-token');
  });
});
