/**
 * Tests for POST /api/orders/[id]/refund — commerce critical path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalToken: vi.fn(),
  PAYPAL_API_BASE: 'https://api.sandbox.paypal.com',
}));

import { POST } from '@/app/api/orders/[id]/refund/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { NextRequest } from 'next/server';

const mockQuery = {
  select: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  neq: vi.fn().mockReturnThis(),
  in: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
  maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  then: vi.fn().mockImplementation((resolve) => resolve?.({ data: null, error: null })),
};
const mockSupabase = { from: vi.fn(() => ({ ...mockQuery })) };

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
  (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

function makeRefundReq(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest(new URL('http://localhost/api/orders/order-123/refund'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
  });
}

const promiseParams = Promise.resolve({ id: 'order-123' });

describe('POST /api/orders/[id]/refund', () => {
  it('returns 429 when rate limited', async () => {
    const resp429 = new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(resp429);

    const res = await POST(makeRefundReq(), { params: promiseParams });
    expect(res.status).toBe(429);
    expect(checkAdminRateLimit).toHaveBeenCalledWith(expect.anything(), 'write');
  });

  it('returns 401 when not authenticated', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

    const res = await POST(makeRefundReq(), { params: promiseParams });
    expect(res.status).toBe(401);
  });

  it('returns 404 when order not found', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, ctx: { guildId: 'g1', discordId: 'd1', userId: 'u1' },
    });
    mockQuery.single.mockResolvedValue({ data: null });

    const res = await POST(makeRefundReq({ reason: 'test' }), { params: promiseParams });
    expect(res.status).toBe(404);
  });

  it('returns 400 when order already refunded', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, ctx: { guildId: 'g1', discordId: 'd1', userId: 'u1' },
    });
    mockQuery.single.mockResolvedValue({
      data: { id: 'order-123', status: 'refunded', guild_id: 'g1', payments: [] },
    });

    const res = await POST(makeRefundReq({ reason: 'dup' }), { params: promiseParams });
    expect(res.status).toBe(400);
  });
});
