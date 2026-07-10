/**
 * Tests for PUT /api/customers/[id]/entitlements — manual entitlement
 * status transitions (W2 hardening).
 *
 * The migration 20260710030000 adds the CHECK constraint
 * `entitlements_grace_period_has_deadline`: every grace_period row must
 * carry a grace_period_ends_at, because a deadline-less row is invisible to
 * the reconciliation sweep and decays forever. This admin route is a live
 * writer of `status: 'grace_period'` (schemas.entitlement.update permits
 * it), so it must supply the deadline — otherwise every manual transition
 * into grace would fail the constraint at the DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));

import { PUT } from '@/app/api/customers/[id]/entitlements/route';
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

const ENTITLEMENT_ID = '00000000-0000-4000-a000-000000000001';
const NOW = new Date('2026-07-09T12:00:00.000Z');
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function putReq(status: string) {
  return buildRequest('/api/customers/cust-1/entitlements', {
    method: 'PUT',
    body: { entitlement_id: ENTITLEMENT_ID, status },
  });
}

function setup() {
  const mock = createMockSupabase();
  const entitlementsQuery = registerTable(mock, 'entitlements');
  entitlementsQuery.single.mockResolvedValue({
    data: { id: ENTITLEMENT_ID },
    error: null,
  });
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  return { entitlementsQuery };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
  mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PUT /api/customers/[id]/entitlements — grace_period deadline', () => {
  it('sets a grace deadline when manually transitioning into grace_period (CHECK-constraint-safe)', async () => {
    const { entitlementsQuery } = setup();

    const res = await PUT(putReq('grace_period') as never);
    expect(res.status).toBe(200);

    expect(entitlementsQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'grace_period',
        // Same default window as EntitlementService.suspend (3 days).
        grace_period_ends_at: new Date(NOW.getTime() + THREE_DAYS_MS).toISOString(),
      }),
    );
    // Guild-scoped, targeted at the requested entitlement.
    expect(entitlementsQuery.eq).toHaveBeenCalledWith('id', ENTITLEMENT_ID);
    expect(entitlementsQuery.eq).toHaveBeenCalledWith('guild_id', 'guild-1');
  });

  it('does not touch the grace deadline for non-grace transitions', async () => {
    const { entitlementsQuery } = setup();

    const res = await PUT(putReq('active') as never);
    expect(res.status).toBe(200);

    const payload = (entitlementsQuery.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.status).toBe('active');
    expect(payload).not.toHaveProperty('grace_period_ends_at');
  });
});
