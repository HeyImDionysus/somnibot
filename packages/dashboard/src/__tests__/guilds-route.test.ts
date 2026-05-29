/**
 * Tests for GET /api/guilds — guild list route.
 * V5 Audit §13.P2a: Dashboard API coverage for guilds endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────
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
    get: vi.fn().mockReturnValue(undefined),
  }),
}));

import { GET } from '@/app/api/guilds/route';
import { requireAuth } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkRateLimit } from '@/lib/api/rate-limit';

const mockFrom = vi.fn();
const mockAdmin = { from: mockFrom };

function makeRequest(headers?: Record<string, string>) {
  return new Request('http://localhost/api/guilds', {
    method: 'GET',
    headers: { 'x-forwarded-for': '1.2.3.4', ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockAdmin);
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
