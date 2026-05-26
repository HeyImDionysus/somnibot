/**
 * Tests for POST /api/license/validate — License key validation.
 * V5 Audit §13.3: Core payment/licensing path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    licenseValidate: vi.fn().mockResolvedValue({ limited: false, remaining: 29, retryAfterMs: 0 }),
    licensePerKey: vi.fn().mockResolvedValue({ limited: false, remaining: 59, retryAfterMs: 0 }),
    licenseFailedAttempt: vi.fn().mockResolvedValue({ limited: false, remaining: 4, retryAfterMs: 0 }),
  },
}));

import { POST } from '@/app/api/license/validate/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';

const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

function mockTable(resolveValue: unknown) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(resolveValue),
    single: vi.fn().mockResolvedValue(resolveValue),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockResolvedValue({ error: null }),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
  };
  mockFrom.mockReturnValue(chain);
  return chain;
}

function makeReq(body: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/license/validate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '1.2.3.4',
    },
    body: JSON.stringify({
      license_key: 'SOMNI-TEST-1234-ABCD',
      product_id: '00000000-0000-4000-a000-000000000001',
      ...body,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
});

describe('POST /api/license/validate', () => {
  it('returns 429 when IP rate limited', async () => {
    (rateLimits.licenseValidate as ReturnType<typeof vi.fn>).mockResolvedValue({
      limited: true, remaining: 0, retryAfterMs: 30000,
    });

    const res = await POST(makeReq() as any);
    expect(res.status).toBe(429);
  });

  it('returns invalid for non-existent key', async () => {
    mockTable({ data: null, error: null });

    const res = await POST(makeReq() as any);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it('returns invalid for suspended key', async () => {
    mockTable({
      data: {
        id: 'key-1',
        status: 'suspended',
        product_id: '00000000-0000-4000-a000-000000000001',
        failed_attempts: 0,
      },
      error: null,
    });

    const res = await POST(makeReq() as any);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });
});
