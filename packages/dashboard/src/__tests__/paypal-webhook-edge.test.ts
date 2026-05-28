/**
 * Edge-case tests for POST /api/paypal/webhook.
 *
 * V5 Audit §13.P2a: Covers missing custom_id, refund flow,
 * subscription lifecycle, and unhandled event types.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalToken: vi.fn().mockResolvedValue('test-token'),
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
}));

process.env.NEXTAUTH_SECRET = 'test-secret-edge';
process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';

import { POST } from '@/app/api/paypal/webhook/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHmac } from 'crypto';

const replaySecret = createHmac('sha256', 'test-secret-edge')
  .update('webhook-replay-secret')
  .digest('hex');

function makeReplay(body: unknown) {
  return new Request('http://localhost/api/paypal/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-replay-secret': replaySecret,
    },
    body: JSON.stringify(body),
  });
}

function makeMockSupabase() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    insert: vi.fn().mockReturnValue({ error: null, select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: null }) }) }),
    upsert: vi.fn().mockReturnValue({ data: [{ event_id: 'EVT-1' }], error: null, select: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [{ event_id: 'EVT-1' }], error: null }) }) }),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    then: vi.fn(),
  };
  const from = vi.fn().mockReturnValue(chain);
  const rpc = vi.fn().mockResolvedValue({ error: null });
  return { from, rpc, chain };
}

let mockSb: ReturnType<typeof makeMockSupabase>;

beforeEach(() => {
  vi.clearAllMocks();
  mockSb = makeMockSupabase();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSb);
});

describe('PayPal webhook — edge cases', () => {
  it('capture without custom_id throws (returns 500 for retry)', async () => {
    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAP-NO-META', amount: { value: '10.00', currency_code: 'USD' } },
      id: 'EVT-NO-META',
    });

    const res = await POST(req as never);
    // Should be 500 because handlePaymentCaptured throws on missing custom_id
    expect(res.status).toBe(500);
  });

  it('empty event_type is rejected by Zod (min 1)', async () => {
    const req = makeReplay({
      event_type: '',
      resource: {},
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it('subscription cancelled with unknown subscription ID does not crash', async () => {
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
      resource: { id: 'SUB-NONEXISTENT' },
      id: 'EVT-CANCEL-MISS',
    });

    const res = await POST(req as never);
    // handler exits early when order is not found
    expect(res.status).toBe(200);
  });

  it('subscription suspended with unknown subscription ID does not crash', async () => {
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
      resource: { id: 'SUB-NONEXISTENT-2' },
      id: 'EVT-SUSPEND-MISS',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
  });

  it('refund event without recoverable capture_id returns 200 (logged, not retried)', async () => {
    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'REFUND-1' },
      id: 'EVT-REFUND-NO-CAPTURE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
  });

  it('CHECKOUT.ORDER.APPROVED calls PayPal capture API', async () => {
    const origFetch = global.fetch;
    const captureCall = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'ORDER-1', status: 'COMPLETED' }), { status: 200 }),
    );
    global.fetch = captureCall;

    try {
      const req = makeReplay({
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { id: 'ORDER-CAPTURE-1' },
        id: 'EVT-ORDER-1',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(captureCall).toHaveBeenCalledWith(
        expect.stringContaining('/v2/checkout/orders/ORDER-CAPTURE-1/capture'),
        expect.any(Object),
      );
    } finally {
      global.fetch = origFetch;
    }
  });

  it('unhandled event type returns 200 without error', async () => {
    const req = makeReplay({
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      resource: { id: 'DISPUTE-1' },
      id: 'EVT-UNHANDLED',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });
});
