/**
 * POST /api/portal/cancel — buyer self-service subscription cancellation.
 *
 * Scheduling cancellation sets the entitlement's cancelled_at, keeps status
 * 'active' until the term end (expires_at), cancels the PayPal subscription so
 * it stops renewing, and is idempotent: a second confirm resolves to the single
 * scheduled cancellation with exactly one provider call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: { portalData: vi.fn(async () => ({ limited: false, retryAfterMs: 0 })) },
}));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn(async () => ({ apiBase: 'https://paypal.example' })),
  getPayPalToken: vi.fn(async () => 'tok'),
}));

import { POST } from '@/app/api/portal/cancel/route';
import { createAdminSupabase } from '@/lib/supabase/admin';

const SESSION = { customer_id: 'cust-1', guild_id: 'guild-1' };
const ENT_ID = '11111111-1111-1111-1111-111111111111';

let entitlement: any;
let paypalCancelCalls: number;
let orderResult: any;
let orderError: any;
let entitlementReadError: any;
let entitlementUpdateError: any;
let suppressEntitlementUpdate: boolean;
let currentReadError: any;
let entitlementSelectCalls: number;
let portalConfig: {
  self_service_cancellation: boolean;
  cancellation_timing: 'end-of-term' | 'immediate';
};
let portalConfigError: unknown;

function makeAdmin() {
  return {
    from: (table: string) => {
      if (table === 'portal_sessions') {
        const chain: any = { select: () => chain, eq: () => chain, gt: () => chain, single: async () => ({ data: SESSION, error: null }) };
        return chain;
      }
      if (table === 'orders') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: orderResult, error: orderError }),
        };
        return chain;
      }
      if (table === 'guild_config') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: portalConfig, error: portalConfigError }),
        };
        return chain;
      }
      // entitlements
      let mode: 'select' | 'update' = 'select';
      let updateObj: any = null;
      const equalityGuards = new Map<string, unknown>();
      const nullGuards = new Set<string>();
      const chain: any = {
        select: () => chain,
        update: (obj: any) => { mode = 'update'; updateObj = obj; return chain; },
        eq: (col: string, value: unknown) => {
          if (mode === 'update') equalityGuards.set(col, value);
          return chain;
        },
        is: (col: string, value: unknown) => {
          if (mode === 'update' && value === null) nullGuards.add(col);
          return chain;
        },
        maybeSingle: async () => {
          if (mode === 'update') {
            if (entitlementUpdateError) {
              return { data: null, error: entitlementUpdateError };
            }
            if (suppressEntitlementUpdate) {
              return { data: null, error: null };
            }
            if (
              [...equalityGuards].some(([column, value]) => entitlement[column] !== value)
              || [...nullGuards].some((column) => entitlement[column] !== null)
            ) {
              return { data: null, error: null };
            }
            entitlement = { ...entitlement, ...updateObj };
            return {
              data: {
                id: entitlement.id,
                status: entitlement.status,
                expires_at: entitlement.expires_at,
                grace_period_ends_at: entitlement.grace_period_ends_at,
                cancelled_at: entitlement.cancelled_at,
                portal_cancellation_timing: entitlement.portal_cancellation_timing,
                portal_cancellation_access_until: entitlement.portal_cancellation_access_until,
              },
              error: null,
            };
          }
          entitlementSelectCalls += 1;
          if (entitlementSelectCalls > 1 && currentReadError) {
            return { data: null, error: currentReadError };
          }
          return {
            data: entitlementReadError ? null : { ...entitlement },
            error: entitlementReadError,
          };
        },
      };
      return chain;
    },
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('https://dash.example/api/portal/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-portal-token': 'tok-1' },
    body: JSON.stringify({ cancellation_timing: 'end-of-term', ...body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  paypalCancelCalls = 0;
  orderResult = {
    id: 'order-1',
    guild_id: 'guild-1',
    customer_id: 'cust-1',
    paypal_subscription_id: 'SUB-123',
  };
  orderError = null;
  entitlementReadError = null;
  entitlementUpdateError = null;
  suppressEntitlementUpdate = false;
  currentReadError = null;
  entitlementSelectCalls = 0;
  portalConfig = {
    self_service_cancellation: true,
    cancellation_timing: 'end-of-term',
  };
  portalConfigError = null;
  entitlement = {
    id: ENT_ID,
    customer_id: SESSION.customer_id,
    guild_id: SESSION.guild_id,
    status: 'active',
    type: 'subscription',
    expires_at: '2026-08-23T00:00:00.000Z',
    grace_period_ends_at: null,
    cancelled_at: null,
    portal_cancellation_timing: null,
    portal_cancellation_access_until: null,
    order_id: 'order-1',
  };
  (createAdminSupabase as any).mockReturnValue(makeAdmin());
  global.fetch = vi.fn(async (url: any) => {
    if (String(url).includes('/cancel')) { paypalCancelCalls++; return { ok: true, status: 204 } as any; }
    return { ok: false, status: 500 } as any;
  }) as any;
});

describe('POST /api/portal/cancel', () => {
  it('schedules cancellation: keeps status active, keeps term-end expiry, cancels the provider sub', async () => {
    const res = await POST(makeRequest({ entitlement_id: ENT_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toBe('cancellation-scheduled');
    expect(json.data.status).toBe('active');
    expect(json.data.cancellation_timing).toBe('end-of-term');
    expect(json.data.access_until).toBe('2026-08-23T00:00:00.000Z');
    expect(json.data.cancellation_scheduled_at).toBeTruthy();
    expect(entitlement.status).toBe('active'); // not revoked immediately
    expect(entitlement.cancelled_at).toBeTruthy();
    expect(entitlement.portal_cancellation_timing).toBe('end-of-term');
    expect(entitlement.portal_cancellation_access_until).toBe('2026-08-23T00:00:00.000Z');
    expect(paypalCancelCalls).toBe(1);
  });

  it('is idempotent: a second confirm stays one scheduled cancellation with one provider call', async () => {
    await POST(makeRequest({ entitlement_id: ENT_ID }));
    const res2 = await POST(makeRequest({ entitlement_id: ENT_ID }));
    const json2 = await res2.json();
    expect(json2.message).toBe('cancellation-scheduled');
    expect(json2.deduped).toBe(true);
    expect(paypalCancelCalls).toBe(1); // no second provider call
  });

  it('reports the persisted end-of-term timing when policy changes before a replay', async () => {
    await POST(makeRequest({ entitlement_id: ENT_ID }));
    portalConfig.cancellation_timing = 'immediate';

    const replay = await POST(makeRequest({
      entitlement_id: ENT_ID,
    }));
    const body = await replay.json();

    expect(replay.status).toBe(200);
    expect(body.deduped).toBe(true);
    expect(body.data.cancellation_timing).toBe('end-of-term');
    expect(body.data.access_until).toBe('2026-08-23T00:00:00.000Z');
    expect(paypalCancelCalls).toBe(1);
  });

  it('keeps the persisted end-of-term timing after scheduled fulfillment makes status terminal', async () => {
    await POST(makeRequest({ entitlement_id: ENT_ID }));
    entitlement.status = 'cancelled';

    const replay = await POST(makeRequest({ entitlement_id: ENT_ID }));
    const body = await replay.json();

    expect(replay.status).toBe(200);
    expect(body.deduped).toBe(true);
    expect(body.data.cancellation_timing).toBe('end-of-term');
    expect(body.data.access_until).toBe('2026-08-23T00:00:00.000Z');
    expect(paypalCancelCalls).toBe(1);
  });

  it('does not classify a provider-side cancellation as a portal replay', async () => {
    entitlement.status = 'cancelled';
    entitlement.cancelled_at = '2026-08-18T00:00:00.000Z';

    const response = await POST(makeRequest({ entitlement_id: ENT_ID }));

    expect(response.status).toBe(409);
    expect(paypalCancelCalls).toBe(0);
  });

  it('404s a non-subscription or foreign entitlement', async () => {
    entitlement.type = 'one_time';
    const res = await POST(makeRequest({ entitlement_id: ENT_ID }));
    expect(res.status).toBe(404);
    expect(paypalCancelCalls).toBe(0);
  });

  it('requires authentication', async () => {
    const req = new NextRequest('https://dash.example/api/portal/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entitlement_id: ENT_ID }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('fails closed when the billing-order lookup errors', async () => {
    orderError = { message: 'database unavailable' };

    const res = await POST(makeRequest({ entitlement_id: ENT_ID }));

    expect(res.status).toBe(503);
    expect(paypalCancelCalls).toBe(0);
    expect(entitlement.cancelled_at).toBeNull();
  });

  it('accepts PayPal 422 only after GET proves the exact subscription is cancelled', async () => {
    global.fetch = vi.fn(async (url: any, init?: any) => {
      if (String(url).endsWith('/cancel')) {
        paypalCancelCalls += 1;
        return { ok: false, status: 422 } as any;
      }
      expect(init?.method).toBeUndefined();
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'SUB-123', status: 'CANCELLED' }),
      } as any;
    }) as any;

    const res = await POST(makeRequest({ entitlement_id: ENT_ID }));

    expect(res.status).toBe(200);
    expect(entitlement.cancelled_at).toBeTruthy();
  });

  it('rejects generic PayPal 422 when reconciliation does not prove cancellation', async () => {
    global.fetch = vi.fn(async (url: any) => {
      if (String(url).endsWith('/cancel')) {
        paypalCancelCalls += 1;
        return { ok: false, status: 422 } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'SUB-123', status: 'ACTIVE' }),
      } as any;
    }) as any;

    const res = await POST(makeRequest({ entitlement_id: ENT_ID }));

    expect(res.status).toBe(502);
    expect(entitlement.cancelled_at).toBeNull();
  });

  it('does not fabricate success when the local schedule update fails', async () => {
    entitlementUpdateError = { message: 'write failed' };

    const res = await POST(makeRequest({ entitlement_id: ENT_ID }));

    expect(res.status).toBe(503);
    expect(entitlement.cancelled_at).toBeNull();
  });

  it('does not fabricate a concurrent winner when the guarded update and reread are empty', async () => {
    suppressEntitlementUpdate = true;

    const res = await POST(makeRequest({ entitlement_id: ENT_ID }));

    expect(res.status).toBe(503);
    expect(entitlement.cancelled_at).toBeNull();
  });

  it('requires a finite paid-through boundary before cancelling the provider', async () => {
    entitlement.expires_at = null;

    const res = await POST(makeRequest({ entitlement_id: ENT_ID }));

    expect(res.status).toBe(409);
    expect(paypalCancelCalls).toBe(0);
  });

  it('fails closed when the store cancellation policy cannot be loaded', async () => {
    portalConfigError = { message: 'database unavailable' };

    const res = await POST(makeRequest({ entitlement_id: ENT_ID }));

    expect(res.status).toBe(503);
    expect(paypalCancelCalls).toBe(0);
    expect(entitlement.cancelled_at).toBeNull();
  });

  it('allows immediate cancellation without a paid-through boundary and reports immediate access loss', async () => {
    portalConfig.cancellation_timing = 'immediate';
    entitlement.expires_at = null;

    const res = await POST(makeRequest({ entitlement_id: ENT_ID, cancellation_timing: 'immediate' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.status).toBe('cancelled');
    expect(json.data.cancellation_timing).toBe('immediate');
    expect(json.data.access_until).toBeTruthy();
    expect(entitlement.status).toBe('cancelled');
    expect(entitlement.portal_cancellation_timing).toBe('immediate');
    expect(paypalCancelCalls).toBe(1);
  });

  it('does not overwrite a concurrent lifecycle expiry after the provider cancellation', async () => {
    portalConfig.cancellation_timing = 'immediate';
    global.fetch = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).endsWith('/cancel')) {
        paypalCancelCalls += 1;
        entitlement.status = 'expired';
        entitlement.expires_at = '2026-08-17T23:59:59.000Z';
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 500 });
    });

    const response = await POST(makeRequest({
      entitlement_id: ENT_ID,
      cancellation_timing: 'immediate',
    }));

    expect(response.status).toBe(503);
    expect(entitlement.status).toBe('expired');
    expect(entitlement.cancelled_at).toBeNull();
    expect(entitlement.portal_cancellation_timing).toBeNull();
    expect(entitlement.portal_cancellation_access_until).toBeNull();
    expect(paypalCancelCalls).toBe(1);
  });

  it('uses the grace deadline as the access boundary for a grace-period cancellation', async () => {
    entitlement.status = 'grace_period';
    entitlement.expires_at = '2026-08-01T00:00:00.000Z';
    entitlement.grace_period_ends_at = '2026-08-26T00:00:00.000Z';

    const res = await POST(makeRequest({ entitlement_id: ENT_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.status).toBe('grace_period');
    expect(json.data.access_until).toBe('2026-08-26T00:00:00.000Z');
  });

  it('keeps the grace access boundary after scheduled fulfillment makes status terminal', async () => {
    entitlement.status = 'grace_period';
    entitlement.expires_at = '2026-08-01T00:00:00.000Z';
    entitlement.grace_period_ends_at = '2026-08-26T00:00:00.000Z';
    await POST(makeRequest({ entitlement_id: ENT_ID }));
    entitlement.status = 'cancelled';

    const replay = await POST(makeRequest({ entitlement_id: ENT_ID }));
    const body = await replay.json();

    expect(replay.status).toBe(200);
    expect(body.deduped).toBe(true);
    expect(body.data.cancellation_timing).toBe('end-of-term');
    expect(body.data.access_until).toBe('2026-08-26T00:00:00.000Z');
    expect(paypalCancelCalls).toBe(1);
  });

  it('rejects cancellation when the confirmed timing no longer matches the store policy', async () => {
    portalConfig.cancellation_timing = 'immediate';

    const res = await POST(makeRequest({ entitlement_id: ENT_ID }));

    expect(res.status).toBe(409);
    expect(paypalCancelCalls).toBe(0);
    expect(entitlement.cancelled_at).toBeNull();
  });
});
