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
const CUSTOMER_ID = '00000000-0000-4000-a000-000000000002';
const PRODUCT_ID = '00000000-0000-4000-a000-000000000003';
const ORDER_ID = '00000000-0000-4000-a000-000000000004';
const NOW = new Date('2026-07-09T12:00:00.000Z');
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function putReq(status: string) {
  return buildRequest(`/api/customers/${CUSTOMER_ID}/entitlements`, {
    method: 'PUT',
    body: { entitlement_id: ENTITLEMENT_ID, status },
  });
}

function invoke(status: string) {
  return PUT(putReq(status) as never, {
    params: Promise.resolve({ id: CUSTOMER_ID }),
  });
}

function setup() {
  const mock = createMockSupabase();
  mock.rpc.mockImplementation(async (_name: string, params: Record<string, unknown>) => ({
    data: [{
      entitlement_id: ENTITLEMENT_ID,
      customer_id: CUSTOMER_ID,
      product_id: PRODUCT_ID,
      order_id: ORDER_ID,
      status: params.p_status,
      grace_period_ends_at: params.p_grace_period_ends_at,
    }],
    error: null,
  }));
  const alertsQuery = registerTable(mock, 'alerts');
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  return { mock, alertsQuery };
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
    const { mock } = setup();
    mock.rpc.mockResolvedValueOnce({
      data: [{
        entitlement_id: ENTITLEMENT_ID,
        customer_id: CUSTOMER_ID,
        product_id: PRODUCT_ID,
        order_id: ORDER_ID,
        status: 'grace_period',
        grace_period_ends_at: new Date(NOW.getTime() + THREE_DAYS_MS).toISOString(),
      }],
      error: null,
    });

    const res = await invoke('grace_period');
    expect(res.status).toBe(200);

    expect(mock.rpc).toHaveBeenCalledWith(
      'commerce_update_entitlement_status_admin',
      expect.objectContaining({
        p_entitlement_id: ENTITLEMENT_ID,
        p_customer_id: CUSTOMER_ID,
        p_guild_id: 'guild-1',
        p_status: 'grace_period',
        // Same default window as EntitlementService.suspend (3 days).
        p_grace_period_ends_at: new Date(NOW.getTime() + THREE_DAYS_MS).toISOString(),
      }),
    );
  });

  it("honors the guild's configured grace window (guild_config.grace_period_days) instead of hardcoding 3 days", async () => {
    const { mock, alertsQuery } = setup();
    // Codex round-2 finding #1: the manual admin transition must read the
    // guild's configured window via the shared getGracePeriodDays helper — the
    // same source of truth EntitlementService.suspend uses — not a hardcoded 3.
    const guildConfigQuery = registerTable(mock, 'guild_config');
    guildConfigQuery.maybeSingle.mockResolvedValue({
      data: { grace_period_days: 7 },
    });

    const expectedDeadline = new Date(NOW.getTime() + 7 * ONE_DAY_MS).toISOString();
    mock.rpc.mockResolvedValueOnce({
      data: [{
        entitlement_id: ENTITLEMENT_ID,
        customer_id: CUSTOMER_ID,
        product_id: PRODUCT_ID,
        order_id: ORDER_ID,
        status: 'grace_period',
        grace_period_ends_at: expectedDeadline,
      }],
      error: null,
    });

    const res = await invoke('grace_period');
    expect(res.status).toBe(200);

    // Deadline reflects the 7-day configured window, not the 3-day default —
    // a test that only asserted THREE_DAYS_MS would pass even against the
    // hardcoded bug this finding fixes.
    expect(mock.rpc).toHaveBeenCalledWith(
      'commerce_update_entitlement_status_admin',
      expect.objectContaining({
        p_status: 'grace_period',
        p_grace_period_ends_at: expectedDeadline,
      }),
    );
    // The lookup is scoped to the authenticated guild.
    expect(guildConfigQuery.eq).toHaveBeenCalledWith('guild_id', 'guild-1');
    // The raised alert carries the same configured deadline.
    expect(alertsQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ grace_period_ends_at: expectedDeadline }),
      }),
    );
  });

  it('clears the grace deadline on manual reactivation (parity with EntitlementService.reactivate)', async () => {
    const { mock } = setup();

    const res = await invoke('active');
    expect(res.status).toBe(200);

    expect(mock.rpc).toHaveBeenCalledWith(
      'commerce_update_entitlement_status_admin',
      expect.objectContaining({ p_status: 'active', p_grace_period_ends_at: null }),
    );
  });

  it('delegates a terminal transition without supplying a replacement grace deadline', async () => {
    const { mock } = setup();
    mock.rpc.mockResolvedValueOnce({
      data: [{
        entitlement_id: ENTITLEMENT_ID,
        customer_id: CUSTOMER_ID,
        product_id: PRODUCT_ID,
        order_id: ORDER_ID,
        status: 'cancelled',
        grace_period_ends_at: null,
      }],
      error: null,
    });

    const res = await invoke('cancelled');
    expect(res.status).toBe(200);

    expect(mock.rpc).toHaveBeenCalledWith(
      'commerce_update_entitlement_status_admin',
      expect.objectContaining({ p_status: 'cancelled', p_grace_period_ends_at: null }),
    );
  });

  it("normalizes the operator 'revoked' action to the table's terminal expired status", async () => {
    const { mock } = setup();
    mock.rpc.mockResolvedValueOnce({
      data: [{
        entitlement_id: ENTITLEMENT_ID,
        customer_id: CUSTOMER_ID,
        product_id: PRODUCT_ID,
        order_id: ORDER_ID,
        status: 'expired',
        grace_period_ends_at: null,
      }],
      error: null,
    });

    const res = await invoke('revoked');
    expect(res.status).toBe(200);

    expect(mock.rpc).toHaveBeenCalledWith(
      'commerce_update_entitlement_status_admin',
      expect.objectContaining({ p_status: 'expired' }),
    );
  });
});

describe('PUT /api/customers/[id]/entitlements — atomic lifecycle authorization', () => {
  it('returns a safe conflict and performs no alert side effect when the database rejects resurrection', async () => {
    const { mock, alertsQuery } = setup();
    mock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '23514',
        message: 'paid entitlement lifecycle is authoritative',
      },
    });

    const res = await invoke('active');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      error: 'This entitlement transition conflicts with its authoritative lifecycle',
    });
    expect(alertsQuery.insert).not.toHaveBeenCalled();
    expect(alertsQuery.update).not.toHaveBeenCalled();
  });

  it('binds the entitlement transition to the customer id in the URL', async () => {
    const { mock } = setup();

    const res = await invoke('active');
    expect(res.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith(
      'commerce_update_entitlement_status_admin',
      expect.objectContaining({
        p_entitlement_id: ENTITLEMENT_ID,
        p_customer_id: CUSTOMER_ID,
        p_guild_id: 'guild-1',
      }),
    );
  });

  it('fails closed when the status RPC returns cross-linked identity evidence', async () => {
    const { mock, alertsQuery } = setup();
    mock.rpc.mockResolvedValueOnce({
      data: [{
        entitlement_id: ENTITLEMENT_ID,
        customer_id: '00000000-0000-4000-a000-000000000099',
        product_id: PRODUCT_ID,
        order_id: ORDER_ID,
        status: 'active',
        grace_period_ends_at: null,
      }],
      error: null,
    });

    const res = await invoke('active');
    expect(res.status).toBe(500);
    expect(alertsQuery.insert).not.toHaveBeenCalled();
    expect(alertsQuery.update).not.toHaveBeenCalled();
  });
});

describe('PUT /api/customers/[id]/entitlements — grace alert lifecycle (W2 review)', () => {
  it('raises the deduped operator alert when manually entering grace_period', async () => {
    const { alertsQuery } = setup();

    const res = await invoke('grace_period');
    expect(res.status).toBe(200);

    expect(alertsQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: 'guild-1',
        alert_type: 'entitlement_grace_period',
        severity: 'warning',
        title: expect.any(String),
        metadata: expect.objectContaining({
          entitlement_id: ENTITLEMENT_ID,
          customer_id: CUSTOMER_ID,
          product_id: PRODUCT_ID,
          order_id: ORDER_ID,
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

      const res = await invoke(status);
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

    const res = await invoke('grace_period');
    expect(res.status).toBe(200);
  });

  it('refreshes the existing unresolved alert on a 23505 so operators see the new deadline (not the stale one)', async () => {
    // Codex W2: re-entering grace (or racing the bot's suspend) writes a NEW
    // grace_period_ends_at on the entitlement but the alert insert dedupes
    // (23505). The pre-existing alert would keep the OLD deadline in its
    // message/metadata unless we refresh it in place.
    const { alertsQuery } = setup();
    alertsQuery.insert.mockResolvedValue({
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    const res = await invoke('grace_period');
    expect(res.status).toBe(200);

    const newDeadline = new Date(NOW.getTime() + THREE_DAYS_MS).toISOString();
    // The existing alert is refreshed in place with the CURRENT deadline.
    expect(alertsQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(newDeadline),
        metadata: expect.objectContaining({ grace_period_ends_at: newDeadline }),
      }),
    );
    // Same entitlement-scoped, unresolved-only filter as the resolve path.
    expect(alertsQuery.eq).toHaveBeenCalledWith('alert_type', 'entitlement_grace_period');
    expect(alertsQuery.eq).toHaveBeenCalledWith('metadata->>entitlement_id', ENTITLEMENT_ID);
    expect(alertsQuery.eq).toHaveBeenCalledWith('resolved', false);
  });

  it('does NOT refresh (or touch update) when the alert insert succeeds cleanly', async () => {
    const { alertsQuery } = setup();
    alertsQuery.insert.mockResolvedValue({ error: null });

    const res = await invoke('grace_period');
    expect(res.status).toBe(200);
    // A fresh insert means there was no pre-existing alert to refresh.
    expect(alertsQuery.update).not.toHaveBeenCalled();
  });

  it('a genuine alert-insert failure is non-fatal — the committed status change still returns 200', async () => {
    const { alertsQuery } = setup();
    alertsQuery.insert.mockResolvedValue({
      error: { code: '42501', message: 'permission denied' },
    });

    const res = await invoke('grace_period');
    expect(res.status).toBe(200);
  });
});
