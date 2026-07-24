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

function makeAdmin() {
  return {
    from: (table: string) => {
      if (table === 'portal_sessions') {
        const chain: any = { select: () => chain, eq: () => chain, gt: () => chain, single: async () => ({ data: SESSION, error: null }) };
        return chain;
      }
      if (table === 'orders') {
        const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { paypal_subscription_id: 'SUB-123' }, error: null }) };
        return chain;
      }
      // entitlements
      let mode: 'select' | 'update' = 'select';
      let updateObj: any = null;
      let guardCancelledNull = false;
      const chain: any = {
        select: () => chain,
        update: (obj: any) => { mode = 'update'; updateObj = obj; return chain; },
        eq: () => chain,
        is: (col: string) => { if (col === 'cancelled_at') guardCancelledNull = true; return chain; },
        maybeSingle: async () => {
          if (mode === 'update') {
            if (guardCancelledNull && entitlement.cancelled_at) {
              return { data: null, error: null };
            }
            entitlement = { ...entitlement, ...updateObj };
            return {
              data: { id: entitlement.id, status: entitlement.status, expires_at: entitlement.expires_at, cancelled_at: entitlement.cancelled_at },
              error: null,
            };
          }
          return { data: { ...entitlement }, error: null };
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
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  paypalCancelCalls = 0;
  entitlement = {
    id: ENT_ID,
    status: 'active',
    type: 'subscription',
    expires_at: '2026-08-23T00:00:00.000Z',
    cancelled_at: null,
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
    expect(json.data.access_until).toBe('2026-08-23T00:00:00.000Z');
    expect(json.data.cancellation_scheduled_at).toBeTruthy();
    expect(entitlement.status).toBe('active'); // not revoked immediately
    expect(entitlement.cancelled_at).toBeTruthy();
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
});
