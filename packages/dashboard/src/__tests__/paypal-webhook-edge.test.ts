/**
 * Edge-case tests for POST /api/paypal/webhook.
 *
 * V5 Audit §13.P2a: Covers missing custom_id, refund flow,
 * subscription lifecycle, and unhandled event types.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { replaySecret } = vi.hoisted(() => {
  const secret = 'test-edge-webhook-replay-secret';
  process.env.NEXTAUTH_SECRET = 'test-secret-edge';
  process.env.WEBHOOK_REPLAY_SECRET = secret;
  process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
  return { replaySecret: secret };
});

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn().mockResolvedValue({
    apiBase: 'https://api-m.sandbox.paypal.com',
    webhookId: 'test-webhook-id',
  }),
  getPayPalToken: vi.fn().mockResolvedValue('test-token'),
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
}));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    paypalWebhook: vi.fn().mockResolvedValue({ limited: false, remaining: 1, retryAfterMs: 0 }),
  },
}));

import { POST } from '@/app/api/paypal/webhook/route';
import { createAdminSupabase } from '@/lib/supabase/admin';

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

/**
 * Build a fully chainable mock Supabase client.
 * Every method returns the chain object itself (for .from().select().eq()...),
 * and the chain is also a thenable that resolves to { data: null, error: null }
 * so awaiting any chain position works.
 */
function makeMockSupabase() {
  const fromFn = vi.fn();
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

  function makeChain(resolvedValue?: { data: unknown; error: unknown }) {
    const defaultResolved = resolvedValue ?? { data: null, error: null };

    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop) {
        // Make the chain thenable — when awaited, resolve with data
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(defaultResolved);
        }
        // Any chained method returns a new chain proxy
        return (..._args: unknown[]) => new Proxy({}, handler);
      },
    };
    return new Proxy({}, handler);
  }

  fromFn.mockImplementation(() => makeChain());

  return { from: fromFn, rpc };
}

function makeResolvedChain(
  resolvedValue: { data: unknown; error: unknown },
  onInsert?: (payload: unknown) => void,
  onEq?: (column: string, value: unknown) => void,
) {
  const chain: Record<string, unknown> = {};
  const chainMethods = [
    'select',
    'eq',
    'order',
    'limit',
    'single',
    'maybeSingle',
    'in',
    'neq',
  ];

  for (const method of chainMethods) {
    chain[method] = vi.fn(() => chain);
  }

  chain.eq = vi.fn((column: string, value: unknown) => {
    onEq?.(column, value);
    return chain;
  });

  chain.insert = vi.fn((payload: unknown) => {
    onInsert?.(payload);
    return chain;
  });
  chain.update = vi.fn(() => chain);
  chain.upsert = vi.fn(() => chain);
  chain.then = (
    resolve: (v: unknown) => void,
    reject?: (reason: unknown) => void,
  ) => Promise.resolve(resolvedValue).then(resolve, reject);

  return chain;
}

function useWebhookRows(rows: Record<string, { data: unknown; error: unknown }>) {
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];
  mockSb.from.mockImplementation((table: string) =>
    makeResolvedChain(
      rows[table] ?? { data: null, error: null },
      (payload) => {
        inserts.push({ table, payload });
      },
      (column, value) => {
        eqCalls.push({ table, column, value });
      },
    ),
  );

  return { inserts, eqCalls };
}

let mockSb: ReturnType<typeof makeMockSupabase>;

beforeEach(() => {
  vi.clearAllMocks();
  mockSb = makeMockSupabase();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSb);
});

describe('PayPal webhook — edge cases', () => {
  it('capture without custom_id throws (returns 500 for retry)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAP-NO-META', amount: { value: '10.00', currency_code: 'USD' } },
      id: 'EVT-NO-META',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Payment captured but custom_id is missing or malformed'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[Webhook] Error processing PAYMENT.CAPTURE.COMPLETED:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
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

  it('subscription payment failure queues grace-period suspension fulfillment', async () => {
    const { inserts } = useWebhookRows({
      orders: {
        data: {
          id: 'order-payment-failed',
          order_number: 'ORD-PAYMENT-FAILED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
        },
        error: null,
      },
      products: { data: { name: 'Subscription' }, error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
    });
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
      resource: { id: 'SUB-FAILED-PAYMENT' },
      id: 'EVT-PAYMENT-FAILED',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inserts).toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        action: 'fulfill_suspension',
        payload: expect.objectContaining({
          fulfillment_type: 'subscription_suspended',
          discord_id: 'discord-1',
          order_id: 'order-payment-failed',
        }),
        status: 'pending',
      }),
    });
  });

  it('refund event without recoverable capture_id returns 200 (logged, not retried)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'REFUND-1' },
      id: 'EVT-REFUND-NO-CAPTURE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      '[Webhook] PAYMENT.CAPTURE.REFUNDED arrived without a recoverable capture_id — payload:',
      expect.stringContaining('"REFUND-1"'),
    );
    errorSpy.mockRestore();
  });

  it('subscription sale refund revokes access through the external refund path', async () => {
    const { inserts, eqCalls } = useWebhookRows({
      payments: {
        data: {
          id: 'payment-row-1',
          order_id: 'order-subscription-1',
          customer_id: 'customer-1',
          guild_id: 'guild-1',
          status: 'completed',
        },
        error: null,
      },
      entitlements: {
        data: [
          {
            id: 'entitlement-1',
            customer_id: 'customer-1',
            granted_role_ids: ['role-1', 'role-2'],
          },
        ],
        error: null,
      },
      customers: { data: { discord_id: 'discord-1' }, error: null },
    });
    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REFUNDED',
      resource: { id: 'REFUND-1', sale_id: 'SALE-SUBSCRIPTION-1' },
      id: 'EVT-SALE-REFUND',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual({
      table: 'payments',
      column: 'paypal_payment_id',
      value: 'SALE-SUBSCRIPTION-1',
    });
    expect(inserts).toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        action: 'revoke_roles',
        payload: expect.objectContaining({
          discord_id: 'discord-1',
          role_ids: ['role-1', 'role-2'],
          reason: 'refunded',
          order_id: 'order-subscription-1',
        }),
        status: 'pending',
      }),
    });
  });

  it('subscription sale reversal uses the sale id as the local payment id', async () => {
    const { eqCalls } = useWebhookRows({
      payments: {
        data: {
          id: 'payment-row-2',
          order_id: 'order-subscription-2',
          customer_id: 'customer-2',
          guild_id: 'guild-1',
          status: 'completed',
        },
        error: null,
      },
      entitlements: { data: [], error: null },
    });
    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REVERSED',
      resource: { id: 'SALE-SUBSCRIPTION-2' },
      id: 'EVT-SALE-REVERSAL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual({
      table: 'payments',
      column: 'paypal_payment_id',
      value: 'SALE-SUBSCRIPTION-2',
    });
  });

  it('CHECKOUT.ORDER.APPROVED calls PayPal capture API', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
      expect(logSpy).toHaveBeenCalledWith('[Webhook] Captured PayPal order: ORDER-CAPTURE-1');
    } finally {
      global.fetch = origFetch;
      logSpy.mockRestore();
    }
  });

  it('unhandled event type returns 200 without error', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = makeReplay({
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      resource: { id: 'DISPUTE-1' },
      id: 'EVT-UNHANDLED',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(logSpy).toHaveBeenCalledWith('[Webhook] Unhandled event: CUSTOMER.DISPUTE.CREATED');
    logSpy.mockRestore();
  });
});
