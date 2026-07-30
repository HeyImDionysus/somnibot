/**
 * Tests for GET /api/guilds — guild list route.
 * V5 Audit §13.P2a: Dashboard API coverage for guilds endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────
const { mockCookieGet } = vi.hoisted(() => ({
  mockCookieGet: vi.fn(),
}));

vi.mock('@/lib/api/require-owner', () => ({
  requireAuth: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(),
}));
vi.mock('@/lib/api/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ limited: false, remaining: 30, retryAfterMs: 0 }),
}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: mockCookieGet,
  }),
}));

import { GET } from '@/app/api/guilds/route';
import { requireAuth } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { TRUSTED_PROXY_HOPS_ENV } from '@/lib/api/client-ip';
import { cookies } from 'next/headers';

const mockFrom = vi.fn();
const mockAdmin = { from: mockFrom };
const originalHops = process.env[TRUSTED_PROXY_HOPS_ENV];

function makeRequest(headers?: Record<string, string>) {
  return new Request('http://localhost/api/guilds', {
    method: 'GET',
    headers: { 'x-forwarded-for': '1.2.3.4', ...headers },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockCookieGet.mockReturnValue(undefined);
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockAdmin);
  vi.mocked(cookies).mockResolvedValue({ get: mockCookieGet } as never);
  (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
    limited: false,
    remaining: 30,
    retryAfterMs: 0,
  });
  process.env[TRUSTED_PROXY_HOPS_ENV] = '1';
});

afterEach(() => {
  if (originalHops === undefined) delete process.env[TRUSTED_PROXY_HOPS_ENV];
  else process.env[TRUSTED_PROXY_HOPS_ENV] = originalHops;
});

describe('GET /api/guilds', () => {
  it('returns 401 when requireAuth fails', async () => {
    (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    });

    const res = await GET(makeRequest() as never);
    expect(res.status).toBe(401);
  });

  it('returns 401 when discordId is null', async () => {
    (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      userId: 'user-1',
      discordId: null,
    });

    const res = await GET(makeRequest() as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('No Discord identity');
  });

  it('returns guilds on success', async () => {
    (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      userId: 'user-1',
      discordId: 'discord-123',
    });

    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ id: 'g1', name: 'Test Guild' }],
        error: null,
      }),
    };
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.guilds).toEqual([{ id: 'g1', name: 'Test Guild' }]);
    expect(body.active_guild_id).toBe('g1');
  });

  it('normalizes a stale active guild cookie to the first owned guild', async () => {
    (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      userId: 'user-1',
      discordId: 'discord-123',
    });
    mockCookieGet.mockImplementation((name: string) =>
      name === 'active_guild_id' ? { value: 'stale-guild' } : undefined,
    );

    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          { id: 'g1', name: 'Guild One' },
          { id: 'g2', name: 'Guild Two' },
        ],
        error: null,
      }),
    };
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active_guild_id).toBe('g1');
    expect(res.headers.get('set-cookie')).toContain('active_guild_id=g1');
  });

  it('returns 429 when rate-limited', async () => {
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      limited: true,
      remaining: 0,
      retryAfterMs: 30000,
    });

    const res = await GET(makeRequest() as never);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  it('returns 500 when DB query fails', async () => {
    // Ensure rate limit passes for this test
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      limited: false, remaining: 30, retryAfterMs: 0,
    });
    (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      userId: 'user-1',
      discordId: 'discord-123',
    });

    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'DB down' },
      }),
    };
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest() as never);
    expect(res.status).toBe(500);
  });
});

/**
 * The guild list is 30/min per IP. Before the shared helper, the route read
 * index 0 of X-Forwarded-For — the value the CLIENT supplied — and fell back to
 * `x-real-ip`, which a client can also send when the proxy does not set it. So
 * the limit was defeated by rotating one header.
 */
describe('GET /api/guilds — rate-limit bucket cannot be spoofed', () => {
  /** The bucket key the route handed the limiter on its most recent call. */
  function lastKey(): string {
    const calls = (checkRateLimit as ReturnType<typeof vi.fn>).mock.calls;
    return String(calls.at(-1)?.[0]);
  }

  beforeEach(() => {
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      limited: false,
      remaining: 30,
      retryAfterMs: 0,
    });
    (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      userId: 'user-1',
      discordId: 'discord-123',
    });
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    });
  });

  it('keys on the proxy-observed address, not the caller-supplied prefix', async () => {
    await GET(makeRequest({ 'x-forwarded-for': '9.9.9.9, 198.51.100.2' }) as never);
    expect(lastKey()).toBe('guilds:list:198.51.100.2');
  });

  it('gives a rotating forged prefix the same bucket every time', async () => {
    const keys = new Set<string>();
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      await GET(makeRequest({ 'x-forwarded-for': `${forged}, 198.51.100.2` }) as never);
      keys.add(lastKey());
    }
    expect(keys.size, 'rotating the forged prefix must not split the bucket').toBe(1);
  });

  it('ignores x-real-ip rather than trusting a header Caddy never sets', async () => {
    // makeRequest always sets x-forwarded-for, so override it away explicitly.
    const req = new Request('http://localhost/api/guilds', {
      method: 'GET',
      headers: { 'x-real-ip': '203.0.113.9' },
    });
    await GET(req as never);
    expect(lastKey()).toBe('guilds:list:unknown');
    expect(lastKey()).not.toContain('203.0.113.9');
  });
});
