/**
 * Tests for POST /api/customers/[id]/entitlements — manual entitlement
 * grants against the atomic commerce_create_noncommerce_entitlement RPC.
 *
 * The RPC requires the request's granted_role_ids/granted_channel_ids to
 * exactly equal the product's canonical sets, but the grant schema defaults
 * omitted lists to []. The route must therefore resolve omitted lists to the
 * product's canonical sets (the documented minimal body
 * {request_id, product_id} must work for role-bearing products), forward
 * explicit lists verbatim, and surface the RPC's 23514 authority rejection
 * as a conflict rather than a generic 500.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

afterEach(() => vi.restoreAllMocks());

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));

import { POST } from '@/app/api/customers/[id]/entitlements/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

import {
  createMockSupabase,
  registerTable,
  buildRequest,
  mockAuthSuccess,
  mockRateLimitPass,
} from './helpers';

const CUSTOMER_ID = '00000000-0000-4000-a000-000000000002';
const PRODUCT_ID = '00000000-0000-4000-a000-000000000003';
const REQUEST_ID = '00000000-0000-4000-a000-000000000010';
const ENTITLEMENT_ID = '00000000-0000-4000-a000-000000000011';
const PRODUCT_ROLE_IDS = ['111111111111111111', '222222222222222222'];
const PRODUCT_CHANNEL_IDS = ['333333333333333333'];

function invoke(body: Record<string, unknown>) {
  const req = buildRequest(`/api/customers/${CUSTOMER_ID}/entitlements`, {
    method: 'POST',
    body,
  });
  return POST(req as never, {
    params: Promise.resolve({ id: CUSTOMER_ID }),
  });
}

function setup() {
  const mock = createMockSupabase();
  const customersQuery = registerTable(mock, 'customers');
  customersQuery.maybeSingle.mockResolvedValue({ data: { id: CUSTOMER_ID } });
  const productsQuery = registerTable(mock, 'products');
  productsQuery.maybeSingle.mockResolvedValue({
    data: {
      id: PRODUCT_ID,
      granted_role_ids: PRODUCT_ROLE_IDS,
      granted_channel_ids: PRODUCT_CHANNEL_IDS,
    },
  });
  mock.rpc.mockImplementation(async (_name: string, params: Record<string, unknown>) => ({
    data: [{
      entitlement_id: ENTITLEMENT_ID,
      order_id: params.p_request_id,
      request_id: params.p_request_id,
    }],
    error: null,
  }));
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  return { mock, customersQuery, productsQuery };
}

beforeEach(() => {
    vi.resetAllMocks();
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
  mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
});

describe('POST /api/customers/[id]/entitlements — canonical set resolution', () => {
  it('the documented minimal body grants a role-bearing product with its canonical sets', async () => {
    const { mock } = setup();

    const res = await invoke({ request_id: REQUEST_ID, product_id: PRODUCT_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: {
        id: ENTITLEMENT_ID,
        order_id: REQUEST_ID,
        request_id: REQUEST_ID,
      },
    });

    // Omitted lists resolve to the product's canonical sets — never to the
    // schema-defaulted [] that the RPC's authority check would reject.
    expect(mock.rpc).toHaveBeenCalledWith(
      'commerce_create_noncommerce_entitlement',
      expect.objectContaining({
        p_request_id: REQUEST_ID,
        p_guild_id: 'guild-1',
        p_customer_id: CUSTOMER_ID,
        p_product_id: PRODUCT_ID,
        p_granted_role_ids: PRODUCT_ROLE_IDS,
        p_granted_channel_ids: PRODUCT_CHANNEL_IDS,
      }),
    );
  });

  it('resolves omitted lists to [] for a product without canonical sets', async () => {
    const { mock, productsQuery } = setup();
    productsQuery.maybeSingle.mockResolvedValue({
      data: { id: PRODUCT_ID, granted_role_ids: null, granted_channel_ids: null },
    });

    const res = await invoke({ request_id: REQUEST_ID, product_id: PRODUCT_ID });
    expect(res.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith(
      'commerce_create_noncommerce_entitlement',
      expect.objectContaining({
        p_granted_role_ids: [],
        p_granted_channel_ids: [],
      }),
    );
  });

  it('forwards explicitly supplied lists verbatim so the RPC stays the authority judge', async () => {
    const { mock } = setup();

    const res = await invoke({
      request_id: REQUEST_ID,
      product_id: PRODUCT_ID,
      granted_role_ids: ['999999999999999999'],
      granted_channel_ids: [],
    });
    expect(res.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith(
      'commerce_create_noncommerce_entitlement',
      expect.objectContaining({
        p_granted_role_ids: ['999999999999999999'],
        p_granted_channel_ids: [],
      }),
    );
  });

  it('resolves each omitted list independently of the other', async () => {
    const { mock } = setup();

    const res = await invoke({
      request_id: REQUEST_ID,
      product_id: PRODUCT_ID,
      granted_channel_ids: PRODUCT_CHANNEL_IDS,
    });
    expect(res.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith(
      'commerce_create_noncommerce_entitlement',
      expect.objectContaining({
        p_granted_role_ids: PRODUCT_ROLE_IDS,
        p_granted_channel_ids: PRODUCT_CHANNEL_IDS,
      }),
    );
  });
});

describe('POST /api/customers/[id]/entitlements — RPC authority rejection', () => {
  it('surfaces the RPC 23514 authority rejection as a conflict, not a generic 500', async () => {
    const { mock } = setup();
    mock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '23514',
        message: 'commerce_create_noncommerce_entitlement: requested grant exceeds product authority',
      },
    });

    const res = await invoke({
      request_id: REQUEST_ID,
      product_id: PRODUCT_ID,
      granted_role_ids: [],
      granted_channel_ids: [],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      error: "This grant conflicts with the product's canonical access contract",
    });
  });

  it('keeps the generic safe 500 for non-contract RPC failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { mock } = setup();
      mock.rpc.mockResolvedValueOnce({
        data: null,
        error: { code: '08006', message: 'connection failure' },
      });

      const res = await invoke({ request_id: REQUEST_ID, product_id: PRODUCT_ID });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        success: false,
        error: 'An internal error occurred',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
