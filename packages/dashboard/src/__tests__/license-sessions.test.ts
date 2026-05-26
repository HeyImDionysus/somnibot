/**
 * Tests for GET /api/license/sessions — V5 Audit Fix #1 (rate limiting).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));

import { GET } from '@/app/api/license/sessions/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { NextRequest } from 'next/server';

const mockQuery = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
  maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  single: vi.fn().mockResolvedValue({ data: null }),
};
const mockSupabase = { from: vi.fn(() => ({ ...mockQuery })) };

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
  (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

function makeReq(keyId?: string): NextRequest {
  const url = keyId
    ? `http://localhost/api/license/sessions?key_id=${keyId}`
    : 'http://localhost/api/license/sessions';
  return new NextRequest(new URL(url), {
    headers: { 'x-forwarded-for': '127.0.0.1' },
  });
}

describe('GET /api/license/sessions', () => {
  it('returns 429 when rate limited', async () => {
    const rateLimitResponse = new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(rateLimitResponse);

    const res = await GET(makeReq('key-1'));
    expect(res.status).toBe(429);
    expect(checkAdminRateLimit).toHaveBeenCalledWith(expect.anything(), 'standard');
  });

  it('returns 401 when not authenticated', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

    const res = await GET(makeReq('key-1'));
    expect(res.status).toBe(401);
  });

  it('returns 400 when key_id is missing', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, ctx: { guildId: 'guild-1', discordId: 'disc-1', userId: 'u1' },
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(400);
  });

  it('returns sessions on success', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, ctx: { guildId: 'guild-1', discordId: 'disc-1', userId: 'u1' },
    });

    const keyQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { product_id: 'prod-1' } }),
    };
    const configQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { max_devices: 5 } }),
    };
    const sessionsQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ id: 's1', active: true }, { id: 's2', active: false }],
        error: null,
      }),
    };

    let callCount = 0;
    mockSupabase.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return keyQuery;        // license_keys
      if (callCount === 2) return configQuery;      // product_license_config
      return sessionsQuery;                          // license_sessions
    });

    const res = await GET(makeReq('key-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.sessions).toHaveLength(2);
    expect(body.data.max_devices).toBe(5);
    expect(body.data.active_count).toBe(1);
  });
});
