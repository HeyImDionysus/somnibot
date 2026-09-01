/**
 * POST /api/portal/requests — buyer self-service refund/service requests.
 *
 * Filing a request inserts exactly one pending row scoped to the customer's own
 * order and never mutates payments/orders; a duplicate filing dedupes to one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: { portalData: vi.fn(async () => ({ limited: false, remaining: 1, retryAfterMs: 0 })) },
}));

import { POST } from '@/app/api/portal/requests/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';

const SESSION = { customer_id: 'cust-1', guild_id: 'guild-1' };

let requestRows: any[];
let paymentsTouched: boolean;
let insertErrorMessage: string | undefined;

function makeAdmin(opts: { orderExists?: boolean } = {}) {
  const orderExists = opts.orderExists ?? true;
  return {
    from: (table: string) => {
      if (table === 'portal_sessions') {
        const chain: any = { select: () => chain, eq: () => chain, gt: () => chain, single: async () => ({ data: SESSION, error: null }) };
        return chain;
      }
      if (table === 'orders') {
        const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: orderExists ? { id: 'order-1' } : null, error: null }) };
        return chain;
      }
      if (table === 'payments' || table === 'payment_refunds') {
        paymentsTouched = true;
        const chain: any = new Proxy({}, { get: () => () => chain });
        return chain;
      }
      // commerce_portal_requests
      const filters: Record<string, any> = {};
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: any) => { filters[col] = val; return chain; },
        is: (col: string) => { filters[col] = null; return chain; },
        maybeSingle: async () => {
          const found = requestRows.find((r) =>
            r.customer_id === filters.customer_id
            && r.type === filters.type
            && r.status === filters.status
            && ('order_id' in filters ? r.order_id === filters.order_id : true),
          );
          return { data: found ?? null, error: null };
        },
        insert: (row: any) => {
          const insChain: any = {
            select: () => insChain,
            single: async () => {
              if (insertErrorMessage) {
                return { data: null, error: { code: 'XX000', message: insertErrorMessage } };
              }
              const dup = requestRows.find((r) =>
                r.status === 'pending' && r.customer_id === row.customer_id && r.order_id === row.order_id && r.type === row.type,
              );
              if (dup) return { data: null, error: { code: '23505', message: 'duplicate' } };
              const created = { id: `req-${requestRows.length + 1}`, created_at: '2026-07-23T00:00:00Z', ...row };
              requestRows.push(created);
              return { data: created, error: null };
            },
          };
          return insChain;
        },
      };
      return chain;
    },
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('https://dash.example/api/portal/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-portal-token': 'tok-1' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimits.portalData).mockReset().mockResolvedValue({ limited: false, remaining: 1, retryAfterMs: 0 });
  requestRows = [];
  paymentsTouched = false;
  insertErrorMessage = undefined;
  (createAdminSupabase as any).mockReturnValue(makeAdmin());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/portal/requests', () => {
  it('files a refund request: one pending row scoped to the customer order, no payment mutation', async () => {
    const res = await POST(makeRequest({ type: 'refund', order_id: '11111111-1111-1111-1111-111111111111' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.message).toBe('request-received');
    expect(requestRows).toHaveLength(1);
    expect(requestRows[0]).toMatchObject({ customer_id: 'cust-1', guild_id: 'guild-1', type: 'refund', status: 'pending' });
    expect(paymentsTouched).toBe(false);
  });

  it('dedupes a duplicate filing to a single pending entry', async () => {
    const body = { type: 'refund', order_id: '11111111-1111-1111-1111-111111111111' };
    const first = await POST(makeRequest(body));
    expect(first.status).toBe(201);
    const second = await POST(makeRequest(body));
    const secondJson = await second.json();
    expect(secondJson.deduped).toBe(true);
    expect(requestRows).toHaveLength(1);
  });

  it('rejects a request referencing an order the customer does not own', async () => {
    (createAdminSupabase as any).mockReturnValue(makeAdmin({ orderExists: false }));
    const res = await POST(makeRequest({ type: 'refund', order_id: '22222222-2222-2222-2222-222222222222' }));
    expect(res.status).toBe(404);
    expect(requestRows).toHaveLength(0);
  });

  it('requires authentication', async () => {
    const req = new NextRequest('https://dash.example/api/portal/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'service' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('redacts a hostile database insert failure from the customer response', async () => {
    const hostileMessage = 'relation commerce_portal_requests violated secret_token=portal-super-secret';
    insertErrorMessage = hostileMessage;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await POST(makeRequest({ type: 'service' }));

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toMatchObject({
      success: false,
      error: 'An internal error occurred',
      errorDetails: { code: 'internal_error' },
    });
    expect(JSON.stringify(json)).not.toContain(hostileMessage);
    expect(errorSpy).toHaveBeenCalledWith(
      '[POST /api/portal/requests] DB error:',
      hostileMessage,
    );
  });

  it('redacts a hostile runtime failure from the customer response', async () => {
    const hostileMessage = 'upstream failure bearer=portal-runtime-secret';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(rateLimits.portalData).mockRejectedValueOnce(new Error(hostileMessage));

    const res = await POST(makeRequest({ type: 'service' }));

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toMatchObject({
      success: false,
      error: 'An internal error occurred',
      errorDetails: { code: 'internal_error' },
    });
    expect(JSON.stringify(json)).not.toContain(hostileMessage);
    expect(errorSpy).toHaveBeenCalledWith(
      '[POST /api/portal/requests] Server error:',
      hostileMessage,
    );
  });
});
