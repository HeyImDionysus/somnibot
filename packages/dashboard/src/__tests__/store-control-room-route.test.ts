import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { GET } from '@/app/api/store/control-room/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { buildRequest, mockAuthSuccess, mockRateLimitPass } from './helpers';

type Result = { data: unknown; error: unknown; count?: number };

function query(result: Result) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.range = vi.fn((from: number, to: number) => Promise.resolve({
    ...result,
    data: Array.isArray(result.data) ? result.data.slice(from, to + 1) : result.data,
  }));
  chain.then = (
    resolve: (value: Result) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const ORDER = '00000000-0000-0000-0000-000000000001';
const CUSTOMER = '00000000-0000-0000-0000-000000000002';
const PRODUCT = '00000000-0000-0000-0000-000000000003';

function setup(overrides: Partial<Record<string, Result>> = {}) {
  const results: Record<string, Result> = {
    orders: {
      data: [{
        id: ORDER,
        order_number: 'ORD-1',
        customer_id: CUSTOMER,
        product_id: PRODUCT,
        status: 'completed',
        delivery_type_snapshot: 'mixed',
        created_at: '2026-07-28T12:00:00.000Z',
      }],
      error: null,
      count: 1,
    },
    license_keys: {
      data: [{
        id: 'key-1',
        order_id: ORDER,
        customer_id: CUSTOMER,
        product_id: PRODUCT,
        status: 'active',
        activated_at: '2026-07-28T12:05:00.000Z',
        created_at: '2026-07-28T12:01:00.000Z',
      }],
      error: null,
    },
    entitlements: {
      data: [{
        id: 'ent-1',
        order_id: ORDER,
        customer_id: CUSTOMER,
        product_id: PRODUCT,
        status: 'active',
        created_at: '2026-07-28T12:01:00.000Z',
      }],
      error: null,
    },
    commerce_download_deliveries: {
      data: [{
        id: 'delivery-1',
        order_id: ORDER,
        customer_id: CUSTOMER,
        product_id: PRODUCT,
        delivered_at: '2026-07-28T12:02:00.000Z',
      }],
      error: null,
    },
    commerce_fulfillment_holds: { data: [], error: null },
    customers: {
      data: [{ id: CUSTOMER, guild_id: 'guild-1', discord_id: '123', discord_username: 'Buyer' }],
      error: null,
    },
    products: {
      data: [{ id: PRODUCT, guild_id: 'guild-1', name: 'Pro Bundle' }],
      error: null,
    },
    instance_settings: {
      data: { value: '2026-07-30T03:10:00.000Z' },
      error: null,
    },
    ...overrides,
  };
  const supabase = {
    from: vi.fn((table: string) => query(results[table])),
    rpc: vi.fn((name: string) => {
      if (name !== 'get_latest_commerce_download_deliveries') {
        throw new Error(`Unexpected RPC ${name}`);
      }
      return Promise.resolve(results.commerce_download_deliveries);
    }),
  };
  vi.mocked(createAdminSupabase).mockReturnValue(supabase as never);
  return supabase;
}

describe('GET /api/store/control-room', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
  });

  it('projects a completed mixed-delivery customer through all four real stages', async () => {
    setup();
    const response = await GET(buildRequest('/api/store/control-room') as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary).toEqual({
      paid: 1,
      licensed: 1,
      downloaded: 1,
      activated: 1,
      stuck: 0,
    });
    expect(body.data.customers[0]).toMatchObject({
      customerName: 'Buyer',
      productName: 'Pro Bundle',
      stages: {
        paid: 'complete',
        licensed: 'complete',
        downloaded: 'complete',
        activated: 'complete',
      },
      stuck: false,
    });
  });

  it('marks missing fulfillment evidence as stuck without using aggregate file counts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
    setup({
      orders: {
        data: [{
          id: ORDER,
          order_number: 'ORD-NEW',
          customer_id: CUSTOMER,
          product_id: PRODUCT,
          status: 'completed',
          delivery_type_snapshot: 'mixed',
          created_at: '2026-07-30T04:00:00.000Z',
        }],
        error: null,
        count: 1,
      },
      license_keys: { data: [], error: null },
      entitlements: { data: [], error: null },
      commerce_download_deliveries: { data: [], error: null },
    });

    const body = await (await GET(buildRequest('/api/store/control-room') as never)).json();
    expect(body.data.summary.stuck).toBe(1);
    expect(body.data.customers[0].reasons).toEqual(expect.arrayContaining([
      'No entitlement was recorded within 15 minutes of payment.',
      'No license key was issued within 15 minutes of payment.',
      'No completed download was recorded within 24 hours.',
    ]));
  });

  it('reports pre-ledger download history as unknown instead of falsely stuck', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
    setup({
      commerce_download_deliveries: { data: [], error: null },
    });

    const body = await (await GET(buildRequest('/api/store/control-room') as never)).json();
    expect(body.data.customers[0].stages.downloaded).toBe('unknown');
    expect(body.data.customers[0].reasons).not.toContain(
      'No completed download was recorded within 24 hours.',
    );
    expect(body.data.customers[0].stuck).toBe(false);
  });

  it('uses the persisted deployment cutover instead of the migration filename time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    setup({
      orders: {
        data: [{
          id: ORDER,
          order_number: 'ORD-BETWEEN-MIGRATION-AND-DEPLOY',
          customer_id: CUSTOMER,
          product_id: PRODUCT,
          status: 'completed',
          delivery_type_snapshot: 'file',
          created_at: '2026-07-30T04:00:00.000Z',
        }],
        error: null,
        count: 1,
      },
      commerce_download_deliveries: { data: [], error: null },
      instance_settings: {
        data: { value: '2026-07-30T08:00:00.000Z' },
        error: null,
      },
    });

    const body = await (await GET(buildRequest('/api/store/control-room') as never)).json();
    expect(body.data.customers[0].stages.downloaded).toBe('unknown');
    expect(body.data.customers[0].reasons).not.toContain(
      'No completed download was recorded within 24 hours.',
    );
  });

  it('fails closed when any required pipeline source errors', async () => {
    setup({
      commerce_download_deliveries: { data: null, error: { message: 'delivery read failed' } },
    });
    const response = await GET(buildRequest('/api/store/control-room') as never);
    expect(response.status).toBe(500);
    expect((await response.json()).success).toBe(false);
  });

  it('uses the bounded latest-delivery RPC for the sampled order set', async () => {
    const supabase = setup();
    const body = await (await GET(buildRequest('/api/store/control-room') as never)).json();
    expect(body.data.customers[0].stages.downloaded).toBe('complete');
    expect(supabase.rpc).toHaveBeenCalledWith('get_latest_commerce_download_deliveries', {
      p_guild_id: 'guild-1',
      p_order_ids: [ORDER],
    });
    expect(supabase.from).not.toHaveBeenCalledWith('commerce_download_deliveries');
  });
});
