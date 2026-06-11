/**
 * Tests for POST /api/orders/[id]/refund — commerce critical path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn().mockResolvedValue({
    apiBase: 'https://api.sandbox.paypal.com',
  }),
  getPayPalToken: vi.fn(),
  PAYPAL_API_BASE: 'https://api.sandbox.paypal.com',
}));

import { POST } from '@/app/api/orders/[id]/refund/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

import {
  createMockSupabase,
  buildRequest,
  mockAuthSuccess,
  mockAuthUnauthorized,
  mockRateLimited,
  mockRateLimitPass,
} from './helpers';

const mock = createMockSupabase();
const refundReq = (body: Record<string, unknown> = {}) =>
  buildRequest('/api/orders/order-123/refund', { method: 'POST', body });
const params = Promise.resolve({ id: 'order-123' });

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
});

describe('POST /api/orders/[id]/refund', () => {
  it('returns 429 when rate limited', async () => {
    mockRateLimited(checkAdminRateLimit as ReturnType<typeof vi.fn>);

    const res = await POST(refundReq(), { params });
    expect(res.status).toBe(429);
    expect(checkAdminRateLimit).toHaveBeenCalledWith(expect.anything(), 'write');
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthUnauthorized(requireGuildOwner as ReturnType<typeof vi.fn>);

    const res = await POST(refundReq(), { params });
    expect(res.status).toBe(401);
  });

  it('returns 404 when order not found', async () => {
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mock._query.single.mockResolvedValue({ data: null });

    const res = await POST(refundReq({ reason: 'test' }), { params });
    expect(res.status).toBe(404);
  });

  it('returns 400 when order already refunded', async () => {
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mock._query.single.mockResolvedValue({
      data: { id: 'order-123', status: 'refunded', guild_id: 'guild-123', payments: [] },
    });

    const res = await POST(refundReq({ reason: 'dup' }), { params });
    expect(res.status).toBe(400);
  });
});
