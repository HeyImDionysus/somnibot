/**
 * Tests for the entitlement-grant `source` enum alignment.
 *
 * The entitlements table CHECK (initial schema, entitlements.source) only
 * allows ('purchase', 'giveaway', 'manual', 'automation') — the same union
 * as EntitlementService.grant's `source` type. The dashboard's
 * schemas.entitlement.grant zod enum previously allowed 'gift' and
 * 'promotion' (which the DB rejects at insert with a raw CHECK violation)
 * and was missing 'giveaway' (which the DB allows).
 *
 * COMPLIANCE: do NOT add new source values here — the bot's
 * commerce-role-guard deny-lists non-purchase sources ('giveaway',
 * 'manual', 'automation'); any NEW source requires a real-money-or-not
 * decision there first. This suite pins the zod enum to the existing DB
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

// The exact set the DB CHECK accepts — keep in lockstep with
// entitlements.source in the initial schema and EntitlementService.grant.
const DB_ALLOWED_SOURCES = ['purchase', 'giveaway', 'manual', 'automation'] as const;
const DB_REJECTED_SOURCES = ['gift', 'promotion'] as const;

describe('schemas.entitlement.grant — source enum matches the DB CHECK', () => {
  it.each(DB_ALLOWED_SOURCES)(
    "accepts and round-trips source '%s' (DB CHECK allows it)",
    (source) => {
      const result = schemas.entitlement.grant.safeParse({
        product_id: PRODUCT_ID,
        source,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.source).toBe(source);
      }
    },
  );

  it.each(DB_REJECTED_SOURCES)(
    "rejects source '%s' (DB CHECK would refuse the insert)",
    (source) => {
      const result = schemas.entitlement.grant.safeParse({
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
    const result = schemas.entitlement.grant.safeParse({ product_id: PRODUCT_ID });
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
    ordersQuery.insert.mockReturnValue(ordersQuery);
    ordersQuery.single.mockResolvedValue({ data: { id: 'ord-1' }, error: null });

    const entitlementsQuery = registerTable(mock, 'entitlements');
    entitlementsQuery.insert.mockReturnValue(entitlementsQuery);
    entitlementsQuery.single.mockResolvedValue({
      data: { id: 'ent-1', source: 'manual' },
      error: null,
    });

    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    return { mock, ordersQuery, entitlementsQuery };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  });

  it.each(DB_REJECTED_SOURCES)(
    "returns a clean 400 (not a raw DB CHECK violation) for source '%s' and never touches the DB",
    async (source) => {
      const { ordersQuery, entitlementsQuery } = setup();

      const res = await invoke({ product_id: PRODUCT_ID, source });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe('Validation failed');
      expect(json.details.some((d: { path: string }) => d.path === 'source')).toBe(true);

      // Rejected at validation — no order or entitlement row is ever attempted,
      // so the CHECK constraint can no longer be the first line of defense.
      expect(ordersQuery.insert).not.toHaveBeenCalled();
      expect(entitlementsQuery.insert).not.toHaveBeenCalled();
    },
  );

  it.each(DB_ALLOWED_SOURCES)(
    "passes source '%s' through to both the order and entitlement inserts",
    async (source) => {
      const { ordersQuery, entitlementsQuery } = setup();

      const res = await invoke({ product_id: PRODUCT_ID, source });
      expect(res.status).toBe(200);

      // Both inserts share the same source column CHECK set in the schema —
      // the validated value must reach each of them unchanged.
      expect(ordersQuery.insert).toHaveBeenCalledWith(
        expect.objectContaining({ source }),
      );
      expect(entitlementsQuery.insert).toHaveBeenCalledWith(
        expect.objectContaining({ source }),
      );
    },
  );
});
