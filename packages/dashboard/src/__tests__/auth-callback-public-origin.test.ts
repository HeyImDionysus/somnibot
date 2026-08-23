import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuthCallback = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: { authCallback: mockAuthCallback },
}));

vi.mock('@/lib/api/client-ip', () => ({
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

describe('auth callback public redirect origin', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockAuthCallback.mockResolvedValue({ limited: false });
    delete process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL;
  });

  it('returns callback failures to the configured Funnel origin', async () => {
    process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL = 'https://somni.tailbd9d28.ts.net';
    const { GET } = await import('@/app/api/auth/callback/route');

    const response = await GET(new Request('https://localhost:3456/api/auth/callback', {
      headers: { host: 'somni.tailbd9d28.ts.net' },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://somni.tailbd9d28.ts.net/login?error=auth_callback_error',
    );
  });

  it('does not trust an arbitrary forwarded host', async () => {
    process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL = 'https://somni.tailbd9d28.ts.net';
    const { GET } = await import('@/app/api/auth/callback/route');

    const response = await GET(new Request('http://localhost:3456/api/auth/callback', {
      headers: { host: 'localhost:3456', 'x-forwarded-host': 'attacker.example' },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3456/login?error=auth_callback_error');
  });

  it('does not trust a forwarded-only match for the configured public host', async () => {
    process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL = 'https://somni.tailbd9d28.ts.net';
    const { GET } = await import('@/app/api/auth/callback/route');

    const response = await GET(new Request('http://localhost:3456/api/auth/callback', {
      headers: {
        host: 'localhost:3456',
        'x-forwarded-host': 'somni.tailbd9d28.ts.net',
      },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3456/login?error=auth_callback_error');
  });

  it('rejects an ambiguous comma-separated Host header', async () => {
    process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL = 'https://somni.tailbd9d28.ts.net';
    const { GET } = await import('@/app/api/auth/callback/route');

    const response = await GET(new Request('http://localhost:3456/api/auth/callback', {
      headers: { host: 'somni.tailbd9d28.ts.net, attacker.example' },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3456/login?error=auth_callback_error');
  });
});
