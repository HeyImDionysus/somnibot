/**
 * Tests for the entitlement-grant `source` enum alignment.
 *
 * The table also supports `purchase`, but this owner-only route does not run a
 * payment finalizer or create paid role-delivery provenance. It must therefore
 * accept only the explicit non-purchase grant sources. Otherwise it can return
 * success for a zero-dollar pseudo-purchase that the paid classifier refuses
 * to grant or repair.
 *
 * COMPLIANCE: do NOT add new source values here — the atomic role-income RPC
 * classifies ('giveaway', 'manual', 'automation') as non-purchase sources;
 * any NEW source requires a real-money-or-not decision in that DB invariant
 * first. This suite pins the zod enum to the existing DB
 * CHECK values so invalid sources die as clean 400s at validation instead
 * of surfacing as DB errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));

import { schemas } from '@/lib/api/validation';
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

const CUSTOMER_ID = '00000000-0000-4000-a000-000000000001';
const PRODUCT_ID = '00000000-0000-4000-a000-000000000002';
const REQUEST_ID = '00000000-0000-4000-a000-000000000003';
const ENTITLEMENT_ID = '00000000-0000-4000-a000-000000000004';

const ADMIN_GRANT_SOURCES = ['giveaway', 'manual', 'automation'] as const;
const ROUTE_REJECTED_SOURCES = ['purchase', 'gift', 'promotion'] as const;

describe('schemas.entitlement.grant — source enum preserves manual-grant provenance', () => {
  it.each(ADMIN_GRANT_SOURCES)(
    "accepts and round-trips admin-grant source '%s'",
    (source) => {
      const result = schemas.entitlement.grant.safeParse({
        request_id: REQUEST_ID,
        product_id: PRODUCT_ID,
        source,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.source).toBe(source);
      }
    },
  );

  it.each(ROUTE_REJECTED_SOURCES)(
    "rejects source '%s' because this route cannot prove paid delivery",
    (source) => {
      const result = schemas.entitlement.grant.safeParse({
        request_id: REQUEST_ID,
        product_id: PRODUCT_ID,
        source,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.join('.') === 'source')).toBe(true);
      }
    },
  );

  it("defaults source to 'manual' when omitted (an admin grant is manual by nature)", () => {
    const result = schemas.entitlement.grant.safeParse({
      request_id: REQUEST_ID,
      product_id: PRODUCT_ID,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('manual');
    }
  });
});

describe('POST /api/customers/[id]/entitlements — source handling at the route', () => {
  function postReq(body: Record<string, unknown>) {
    return buildRequest(`/api/customers/${CUSTOMER_ID}/entitlements`, {
      method: 'POST',
      body,
    });
  }

  function invoke(body: Record<string, unknown>) {
    return POST(postReq(body) as never, {
      params: Promise.resolve({ id: CUSTOMER_ID }),
    });
  }

  function setup() {
    const mock = createMockSupabase();

    const customersQuery = registerTable(mock, 'customers');
    customersQuery.maybeSingle.mockResolvedValue({ data: { id: CUSTOMER_ID } });

    const productsQuery = registerTable(mock, 'products');
    productsQuery.maybeSingle.mockResolvedValue({ data: { id: PRODUCT_ID } });

    const ordersQuery = registerTable(mock, 'orders');
    const entitlementsQuery = registerTable(mock, 'entitlements');
    mock.rpc.mockImplementation(async (_name: string, params: Record<string, unknown>) => ({
      data: [{
        entitlement_id: ENTITLEMENT_ID,
        order_id: params.p_request_id,
        request_id: params.p_request_id,
      }],
      error: null,
    }));

    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    return { mock, ordersQuery, entitlementsQuery };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  });

  it.each(ROUTE_REJECTED_SOURCES)(
    "returns a clean 400 for unsupported source '%s' and never touches the DB",
    async (source) => {
      const { mock, ordersQuery, entitlementsQuery } = setup();

      const res = await invoke({ request_id: REQUEST_ID, product_id: PRODUCT_ID, source });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe('Validation failed');
      expect(json.details.some((d: { path: string }) => d.path === 'source')).toBe(true);

      // Rejected at validation — no order or entitlement row is ever attempted,
      // so the CHECK constraint can no longer be the first line of defense.
      expect(ordersQuery.insert).not.toHaveBeenCalled();
      expect(entitlementsQuery.insert).not.toHaveBeenCalled();
      expect(mock.rpc).not.toHaveBeenCalled();
    },
  );

  it.each(ADMIN_GRANT_SOURCES)(
    "passes source '%s' through the atomic, replay-safe grant RPC",
    async (source) => {
      const { mock, ordersQuery, entitlementsQuery } = setup();

      const res = await invoke({ request_id: REQUEST_ID, product_id: PRODUCT_ID, source });
      expect(res.status).toBe(200);

      expect(mock.rpc).toHaveBeenCalledTimes(1);
      expect(mock.rpc).toHaveBeenCalledWith(
        'commerce_create_noncommerce_entitlement',
        expect.objectContaining({
          p_request_id: REQUEST_ID,
          p_guild_id: 'guild-1',
          p_customer_id: CUSTOMER_ID,
          p_product_id: PRODUCT_ID,
          p_source: source,
        }),
      );
      // The route cannot reintroduce the original two-commit orphan window.
      expect(ordersQuery.insert).not.toHaveBeenCalled();
      expect(entitlementsQuery.insert).not.toHaveBeenCalled();
      expect(await res.json()).toEqual({
        success: true,
        data: {
          id: ENTITLEMENT_ID,
          order_id: REQUEST_ID,
          request_id: REQUEST_ID,
        },
      });
    },
  );

  it('replays the same request UUID through the same atomic database identity', async () => {
    const { mock } = setup();
    const body = { request_id: REQUEST_ID, product_id: PRODUCT_ID, source: 'manual' };

    const first = await invoke(body);
    const second = await invoke(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledTimes(2);
    expect(mock.rpc.mock.calls[0][1]).toEqual(mock.rpc.mock.calls[1][1]);
    expect((await first.json()).data).toEqual((await second.json()).data);
  });

  it('requires a caller-held request UUID before any database work', async () => {
    const { mock } = setup();

    const res = await invoke({ product_id: PRODUCT_ID, source: 'manual' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.details.some((d: { path: string }) => d.path === 'request_id')).toBe(true);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('canonicalizes an uppercase request UUID before the atomic replay comparison', async () => {
    const { mock } = setup();

    const res = await invoke({
      request_id: REQUEST_ID.toUpperCase(),
      product_id: PRODUCT_ID,
      source: 'manual',
    });

    expect(res.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith(
      'commerce_create_noncommerce_entitlement',
      expect.objectContaining({ p_request_id: REQUEST_ID }),
    );
    expect((await res.json()).data.request_id).toBe(REQUEST_ID);
  });

  it('returns 500 without attempting direct writes when the atomic RPC fails', async () => {
    const { mock, ordersQuery, entitlementsQuery } = setup();
    mock.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'atomic grant rejected' },
    });

    const res = await invoke({ request_id: REQUEST_ID, product_id: PRODUCT_ID });
    expect(res.status).toBe(500);
    expect(ordersQuery.insert).not.toHaveBeenCalled();
    expect(entitlementsQuery.insert).not.toHaveBeenCalled();
  });

  it.each(['granted_role_ids', 'granted_channel_ids'] as const)(
    'rejects duplicate IDs in %s before invoking the atomic RPC',
    async (field) => {
      const { mock } = setup();
      const duplicate = '12345678901234567';

      const res = await invoke({
        request_id: REQUEST_ID,
        product_id: PRODUCT_ID,
        [field]: [duplicate, duplicate],
      });

      expect(res.status).toBe(400);
      expect(mock.rpc).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the atomic RPC returns a different request identity', async () => {
    const { mock } = setup();
    mock.rpc.mockResolvedValueOnce({
      data: [{
        entitlement_id: ENTITLEMENT_ID,
        order_id: REQUEST_ID,
        request_id: '00000000-0000-4000-a000-000000000099',
      }],
      error: null,
    });

    const res = await invoke({ request_id: REQUEST_ID, product_id: PRODUCT_ID });
    expect(res.status).toBe(500);
  });

  it.each([
    ['a different order identity', {
      entitlement_id: ENTITLEMENT_ID,
      order_id: '00000000-0000-4000-a000-000000000098',
      request_id: REQUEST_ID,
    }],
    ['a malformed entitlement identity', {
      entitlement_id: 'not-a-uuid',
      order_id: REQUEST_ID,
      request_id: REQUEST_ID,
    }],
  ])('fails closed when the atomic RPC returns %s', async (_label, row) => {
    const { mock } = setup();
    mock.rpc.mockResolvedValueOnce({ data: [row], error: null });

    const res = await invoke({ request_id: REQUEST_ID, product_id: PRODUCT_ID });

    expect(res.status).toBe(500);
  });

  it.each([
    ['no rows', []],
    ['multiple rows', [
      { entitlement_id: ENTITLEMENT_ID, order_id: REQUEST_ID, request_id: REQUEST_ID },
      { entitlement_id: ENTITLEMENT_ID, order_id: REQUEST_ID, request_id: REQUEST_ID },
    ]],
  ])('fails closed when the atomic RPC returns %s', async (_label, data) => {
    const { mock } = setup();
    mock.rpc.mockResolvedValueOnce({ data, error: null });

    const res = await invoke({ request_id: REQUEST_ID, product_id: PRODUCT_ID });

    expect(res.status).toBe(500);
  });
});
