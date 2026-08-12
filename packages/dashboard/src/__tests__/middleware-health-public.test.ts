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
    delete process.env.SOMNIBOT_CSP_INLINE_COMPAT;
    delete process.env.PAYPAL_RECONCILE_SECRET;
    delete process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-key';

    mockCreateServerClient.mockReturnValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      },
    } as unknown as ReturnType<typeof createServerClient>);
  });

  async function runWithoutPublicSupabaseEnv(path: string, init?: RequestInit) {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;

    mockCreateServerClient.mockImplementation(() => {
      throw new Error('public setup routes must not depend on Supabase auth');
    });

    const { middleware } = await import('../middleware');
    return middleware(new NextRequest(
      `http://localhost:3000${path}`,
      init as ConstructorParameters<typeof NextRequest>[1],
    ));
  }

  it('allows unauthenticated platform monitors to reach /api/health', async () => {
    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/api/health'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('allows launcher health probes in local mode without a session cookie', async () => {
    process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE = '1';
    process.env.SESSION_TOKEN = 'launcher-session-token';

    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/api/health'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('allows unauthenticated container supervision to reach /api/health/live', async () => {
    mockCreateServerClient.mockImplementation(() => {
      throw new Error('liveness checks must not depend on Supabase auth');
    });

    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/api/health/live'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
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
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(res.headers.get('content-security-policy')).not.toContain("'unsafe-inline'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('only allows unsafe inline CSP in explicit standalone compatibility mode', async () => {
    process.env.SOMNIBOT_CSP_INLINE_COMPAT = '1';
    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/api/health'));

    expect(res.headers.get('content-security-policy')).toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers.get('content-security-policy')).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('allows development tooling without weakening the production policy', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/api/health'));
    const csp = res.headers.get('content-security-policy');

    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'strict-dynamic' 'unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    vi.unstubAllEnvs();
  });

  it('allows first-run setup page without public Supabase env', async () => {
    const res = await runWithoutPublicSupabaseEnv('/setup');

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('allows setup status reads without public Supabase env', async () => {
    const res = await runWithoutPublicSupabaseEnv('/api/setup');

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('allows first-run CSRF token reads without public Supabase env', async () => {
    const res = await runWithoutPublicSupabaseEnv('/api/csrf');

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('keeps setup writes fail-closed on CSRF without public Supabase env', async () => {
    const res = await runWithoutPublicSupabaseEnv('/api/setup', { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Missing CSRF token' });
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('allows PayPal webhooks without public Supabase env', async () => {
    const res = await runWithoutPublicSupabaseEnv('/api/paypal/webhook', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('allows token-authenticated external webhook receivers without public Supabase env or a session', async () => {
    const res = await runWithoutPublicSupabaseEnv(`/api/inbound-webhooks/${'a'.repeat(43)}`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('lets an exact valid scheduler secret reach the reconcile handler without Supabase or CSRF', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'scheduler-secret-value';

    const res = await runWithoutPublicSupabaseEnv('/api/paypal/reconcile', {
      method: 'POST',
      headers: { 'x-reconcile-secret': 'scheduler-secret-value' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('lets the exact PayPal recovery secret reach its route without Supabase or CSRF', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'recovery-secret-value';

    const res = await runWithoutPublicSupabaseEnv('/api/paypal/recovery', {
      method: 'POST',
      headers: { 'x-paypal-reconcile-secret': 'recovery-secret-value' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('does not bypass owner auth when the scheduler secret is wrong', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'scheduler-secret-value';

    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/api/paypal/reconcile', {
      method: 'POST',
      headers: { 'x-reconcile-secret': 'wrong-secret-value' },
    }));

    expect(mockCreateServerClient).toHaveBeenCalled();
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('keeps authenticated owner reconcile requests behind CSRF', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'scheduler-secret-value';
    mockCreateServerClient.mockReturnValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: '00000000-0000-4000-8000-000000000001' } },
        }),
      },
    } as unknown as ReturnType<typeof createServerClient>);

    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3000/api/paypal/reconcile', {
      method: 'POST',
    }));

    expect(mockCreateServerClient).toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Missing CSRF token' });
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

  it('keeps Funnel redirects on the configured public host', async () => {
    process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL = 'https://somni.tailbd9d28.ts.net';

    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('https://localhost:3456/dashboard', {
      headers: { host: 'somni.tailbd9d28.ts.net' },
    }));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://somni.tailbd9d28.ts.net/login');
  });

  it('keeps direct local operator redirects on localhost when Funnel is configured', async () => {
    process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL = 'https://somni.tailbd9d28.ts.net';

    const { middleware } = await import('../middleware');
    const res = await middleware(new NextRequest('http://localhost:3456/dashboard', {
      headers: { host: 'localhost:3456' },
    }));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3456/login');
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
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard');
    expect(res.cookies.get('somnibot-local-session')?.value).toBe('launcher-token');

    const bound = await middleware(new NextRequest('http://localhost:3000/dashboard', {
      headers: {
        host: 'localhost:3000',
        cookie: 'somnibot-local-session=launcher-token',
      },
    }));
    expect(bound.status).toBe(200);
  });
});
