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
 *
 * W2 review: the route must also replicate the EntitlementService
 * suspend/reactivate ALERT lifecycle — entering grace raises the deduped
 * 'entitlement_grace_period' operator alert, any other transition resolves
 * it — or manual reactivations strand the alert unresolved forever.
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
    data: {
      id: ENTITLEMENT_ID,
      customer_id: 'cust-1',
      product_id: 'prod-1',
      order_id: 'ord-1',
    },
    error: null,
  });
  const alertsQuery = registerTable(mock, 'alerts');
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  return { entitlementsQuery, alertsQuery };
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

  it('clears the grace deadline on manual reactivation (parity with EntitlementService.reactivate)', async () => {
    const { entitlementsQuery } = setup();

    const res = await PUT(putReq('active') as never);
    expect(res.status).toBe(200);

    const payload = (entitlementsQuery.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.status).toBe('active');
    expect(payload.grace_period_ends_at).toBeNull();
  });

  it('leaves the grace deadline untouched for terminal transitions (trace of when the window lapsed)', async () => {
    const { entitlementsQuery } = setup();

    const res = await PUT(putReq('cancelled') as never);
    expect(res.status).toBe(200);

    const payload = (entitlementsQuery.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.status).toBe('cancelled');
    expect(payload).not.toHaveProperty('grace_period_ends_at');
  });
});

describe('PUT /api/customers/[id]/entitlements — grace alert lifecycle (W2 review)', () => {
  it('raises the deduped operator alert when manually entering grace_period', async () => {
    const { alertsQuery } = setup();

    const res = await PUT(putReq('grace_period') as never);
    expect(res.status).toBe(200);

    expect(alertsQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: 'guild-1',
        alert_type: 'entitlement_grace_period',
        severity: 'warning',
        title: expect.any(String),
        metadata: expect.objectContaining({
          entitlement_id: ENTITLEMENT_ID,
          customer_id: 'cust-1',
          product_id: 'prod-1',
          order_id: 'ord-1',
          grace_period_ends_at: new Date(NOW.getTime() + THREE_DAYS_MS).toISOString(),
          source: 'dashboard.entitlements.update',
        }),
      }),
    );
    // Entering grace must not also resolve the alert it just raised.
    expect(alertsQuery.update).not.toHaveBeenCalled();
  });

  // Every non-grace status this route can set means "no longer in grace" —
  // each must resolve any outstanding grace alert (a no-op when none exists).
  it.each(['active', 'cancelled', 'expired', 'revoked', 'pending'])(
    'resolves the outstanding grace alert when transitioning to %s',
    async (status) => {
      const { alertsQuery } = setup();

      const res = await PUT(putReq(status) as never);
      expect(res.status).toBe(200);

      expect(alertsQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          resolved: true,
          resolved_at: NOW.toISOString(),
        }),
      );
      // Entitlement-scoped, unresolved-only — same filters as
      // EntitlementService.reactivate/revoke and the reconciliation sweep.
      expect(alertsQuery.eq).toHaveBeenCalledWith('guild_id', 'guild-1');
      expect(alertsQuery.eq).toHaveBeenCalledWith('alert_type', 'entitlement_grace_period');
      expect(alertsQuery.eq).toHaveBeenCalledWith('metadata->>entitlement_id', ENTITLEMENT_ID);
      expect(alertsQuery.eq).toHaveBeenCalledWith('resolved', false);
      expect(alertsQuery.insert).not.toHaveBeenCalled();
    },
  );

  it('treats a 23505 on the alert insert as dedupe success (still 200)', async () => {
    const { alertsQuery } = setup();
    alertsQuery.insert.mockResolvedValue({
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    const res = await PUT(putReq('grace_period') as never);
    expect(res.status).toBe(200);
  });

  it('a genuine alert-insert failure is non-fatal — the committed status change still returns 200', async () => {
    const { alertsQuery } = setup();
    alertsQuery.insert.mockResolvedValue({
      error: { code: '42501', message: 'permission denied' },
    });

    const res = await PUT(putReq('grace_period') as never);
    expect(res.status).toBe(200);
  });
});
