import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: { portalData: vi.fn(async () => ({ limited: false })) },
}));

import { GET as getOrders } from '@/app/api/portal/orders/route';
import { GET as getLicenses } from '@/app/api/portal/licenses/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';

const SESSION = { customer_id: 'customer-1', guild_id: 'guild-1' };
const eqCalls: Array<[table: string, column: string, value: unknown]> = [];

type QueryChain = {
  select: () => QueryChain;
  eq: (column: string, value: unknown) => QueryChain;
  gt: () => QueryChain;
  order: () => QueryChain;
  single: () => Promise<{ data: typeof SESSION | null; error: null }>;
  maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: null }>;
  limit: () => Promise<{ data: never[]; error: null }>;
};

function makeChain(table: string): QueryChain {
  const chain: QueryChain = {
    select: () => chain,
    eq: (column, value) => {
      eqCalls.push([table, column, value]);
      return chain;
    },
    gt: () => chain,
    order: () => chain,
    single: async () => ({ data: table === 'portal_sessions' ? SESSION : null, error: null }),
    maybeSingle: async () => ({
      data: table === 'guild_config'
        ? {
            self_service_cancellation: true,
            cancellation_timing: 'end-of-term',
            refund_requests_enabled: true,
            service_requests_enabled: true,
          }
        : null,
      error: null,
    }),
    limit: async () => ({ data: [], error: null }),
  };
  return chain;
}

function request(path: string): NextRequest {
  return new NextRequest(`https://dashboard.example${path}`, {
    headers: { 'x-portal-token': 'portal-token' },
  });
}

beforeEach(() => {
  eqCalls.length = 0;
  vi.clearAllMocks();
  vi.mocked(rateLimits.portalData).mockResolvedValue({ limited: false } as never);
  vi.mocked(createAdminSupabase).mockReturnValue({
    from: (table: string) => makeChain(table),
  } as never);
});

describe('portal list tenant scope', () => {
  it('scopes orders to both the portal customer and guild', async () => {
    const response = await getOrders(request('/api/portal/orders'));

    expect(response.status).toBe(200);
    expect(eqCalls).toContainEqual(['orders', 'customer_id', SESSION.customer_id]);
    expect(eqCalls).toContainEqual(['orders', 'guild_id', SESSION.guild_id]);
    expect((await response.json()).controls).toEqual({
      self_service_cancellation: true,
      cancellation_timing: 'end-of-term',
      refund_requests_enabled: true,
      service_requests_enabled: true,
    });
  });

  it('scopes licenses to both the portal customer and guild', async () => {
    const response = await getLicenses(request('/api/portal/licenses'));

    expect(response.status).toBe(200);
    expect(eqCalls).toContainEqual(['license_keys', 'customer_id', SESSION.customer_id]);
    expect(eqCalls).toContainEqual(['license_keys', 'guild_id', SESSION.guild_id]);
  });
});
