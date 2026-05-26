/**
 * Tests for /api/server-setup — V5 Audit Fix #1 (rate limiting).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));

import { GET, POST } from '@/app/api/server-setup/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { NextRequest } from 'next/server';

const mockQuery = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
  maybeSingle: vi.fn().mockResolvedValue({ data: null }),
};
const mockSupabase = { from: vi.fn(() => ({ ...mockQuery })) };

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
  (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

describe('GET /api/server-setup', () => {
  it('returns 429 when rate limited', async () => {
    const resp429 = new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(resp429);

    const req = new NextRequest(new URL('http://localhost/api/server-setup'), {
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    const res = await GET(req);
    expect(res.status).toBe(429);
    expect(checkAdminRateLimit).toHaveBeenCalledWith(expect.anything(), 'standard');
  });

  it('returns 401 when not authenticated', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

    const req = new NextRequest(new URL('http://localhost/api/server-setup'), {
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/server-setup', () => {
  it('returns 429 when rate limited', async () => {
    const resp429 = new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(resp429);

    const req = new NextRequest(new URL('http://localhost/api/server-setup'), {
      method: 'POST',
      body: JSON.stringify({ action: 'confirm' }),
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(checkAdminRateLimit).toHaveBeenCalledWith(expect.anything(), 'write');
  });

  it('returns 401 when not authenticated', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

    const req = new NextRequest(new URL('http://localhost/api/server-setup'), {
      method: 'POST',
      body: JSON.stringify({ action: 'confirm' }),
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when deployment not completed', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, ctx: { guildId: 'g1', discordId: 'd1', userId: 'u1' },
    });

    // guild_desired_state returns no applied_at
    mockQuery.single.mockResolvedValue({ data: { applied_at: null } });

    const req = new NextRequest(new URL('http://localhost/api/server-setup'), {
      method: 'POST',
      body: JSON.stringify({ action: 'confirm' }),
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
