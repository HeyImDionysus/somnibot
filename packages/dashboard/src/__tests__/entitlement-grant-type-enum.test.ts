/**
 * Tests for the `type` enum on schemas.entitlement.grant and the
 * POST /api/customers/[id]/entitlements route.
 *
 * THE BUG (same class as the `source`-enum fix in PR #291): the zod schema
 * accepted `type: 'free'`, but the entitlements table CHECK only allows
 * `type IN ('one_time', 'subscription')` (initial_schema.sql), which matches
 * EntitlementService.grant's `'one_time' | 'subscription'` union and the
 * DbEntitlement.type source-of-truth. Nothing in the dashboard UI, bot, docs,
 * or tests ever grants a 'free' entitlement — so a 'free' grant passed zod,
 * MANUFACTURED a real order row, then died on a raw DB CHECK violation
 * surfaced as a generic 500 via dbError (leaving an orphan order behind).
 *
 * The schema must therefore only accept the two DB-valid types. Each accepted
 * type round-trips; 'free' is rejected with a `type`-path issue; an omitted
 * type defaults to 'one_time'; and the POST route rejects 'free' with a clean
 * 400 BEFORE any order/entitlement insert is attempted.
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

const PRODUCT_ID = '00000000-0000-4000-a000-0000000000aa';

// The exact set the entitlements table CHECK accepts — must stay in lockstep
// with `CHECK (type IN (...))` in initial_schema.sql and DbEntitlement.type.
const DB_ACCEPTED_TYPES = ['one_time', 'subscription'] as const;

describe('schemas.entitlement.grant — type enum aligned with DB CHECK', () => {
  it.each(DB_ACCEPTED_TYPES)('accepts DB-valid type %s and round-trips it', (type) => {
    const parsed = schemas.entitlement.grant.safeParse({ product_id: PRODUCT_ID, type });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe(type);
  });

  it("rejects type 'free' (ungrantable — no such value in the DB CHECK)", () => {
    const parsed = schemas.entitlement.grant.safeParse({ product_id: PRODUCT_ID, type: 'free' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The rejection must be attributed to the `type` field specifically.
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'type')).toBe(true);
    }
  });

  it("defaults an omitted type to 'one_time'", () => {
    const parsed = schemas.entitlement.grant.safeParse({ product_id: PRODUCT_ID });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe('one_time');
  });
});

describe("POST /api/customers/[id]/entitlements — type 'free' rejected cleanly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  });

  function postReq(body: Record<string, unknown>) {
    return buildRequest('/api/customers/cust-1/entitlements', { method: 'POST', body });
  }

  it("returns 400 (not 500) for type 'free' and attempts NO order/entitlement insert", async () => {
    const mock = createMockSupabase();
    const ordersQuery = registerTable(mock, 'orders');
    const entitlementsQuery = registerTable(mock, 'entitlements');
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const res = await POST(
      postReq({ product_id: PRODUCT_ID, type: 'free' }) as never,
      { params: Promise.resolve({ id: 'cust-1' }) } as never,
    );

    // A validation failure — NOT a raw DB CHECK violation surfaced as a 500.
    expect(res.status).toBe(400);

    // The route must bail at zod, before manufacturing an order or entitlement.
    expect(ordersQuery.insert).not.toHaveBeenCalled();
    expect(entitlementsQuery.insert).not.toHaveBeenCalled();
  });
});
