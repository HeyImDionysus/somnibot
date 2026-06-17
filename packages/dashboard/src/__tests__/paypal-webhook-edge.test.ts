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

function makeReplay(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/paypal/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-replay-secret': replaySecret,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function makeSignedWebhook(body: unknown) {
  return new Request('http://localhost/api/paypal/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://example.com/cert',
      'paypal-transmission-id': 'transmission-1',
      'paypal-transmission-sig': 'sig-1',
      'paypal-transmission-time': new Date().toISOString(),
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
  onUpdate?: (payload: unknown) => void,
  onIn?: (column: string, values: unknown[]) => void,
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
    'is',
    'lt',
    'contains',
  ];

  for (const method of chainMethods) {
    chain[method] = vi.fn(() => chain);
  }

  chain.eq = vi.fn((column: string, value: unknown) => {
    onEq?.(column, value);
    return chain;
  });
  chain.in = vi.fn((column: string, values: unknown[]) => {
    onIn?.(column, values);
    return chain;
  });

  chain.insert = vi.fn((payload: unknown) => {
    onInsert?.(payload);
    return chain;
  });
  chain.update = vi.fn((payload: unknown) => {
    onUpdate?.(payload);
    return chain;
  });
  chain.upsert = vi.fn(() => chain);
  chain.then = (
    resolve: (v: unknown) => void,
    reject?: (reason: unknown) => void,
  ) => Promise.resolve(resolvedValue).then(resolve, reject);

  return chain;
}

type MockRowResult = { data: unknown; error: unknown };

function useWebhookRows(rows: Record<string, MockRowResult | MockRowResult[]>) {
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];
  const updates: Array<{ table: string; payload: unknown }> = [];
  const inCalls: Array<{ table: string; column: string; values: unknown[] }> = [];
  const tableCallCounts = new Map<string, number>();
  mockSb.from.mockImplementation((table: string) => {
    const callCount = tableCallCounts.get(table) ?? 0;
    tableCallCounts.set(table, callCount + 1);
    const tableRows = rows[table] ?? { data: null, error: null };
    const resolved = Array.isArray(tableRows)
      ? tableRows[Math.min(callCount, tableRows.length - 1)]
      : tableRows;

    return makeResolvedChain(
      resolved,
      (payload) => {
        inserts.push({ table, payload });
      },
      (column, value) => {
        eqCalls.push({ table, column, value });
      },
      (payload) => {
        updates.push({ table, payload });
      },
      (column, values) => {
        inCalls.push({ table, column, values });
      },
    );
  });

  return { inserts, eqCalls, updates, inCalls };
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

  it('subscription expiry expires only the matching product access without grace-period fulfillment', async () => {
    const { inserts, eqCalls, updates, inCalls } = useWebhookRows({
      orders: {
        data: {
          id: 'order-expired',
          order_number: 'ORD-EXPIRED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
        },
        error: null,
      },
      entitlements: [
        {
          data: [
            {
              id: 'entitlement-1',
              customer_id: 'customer-1',
              granted_role_ids: ['role-1', 'role-2'],
              license_key_id: 'license-1',
            },
          ],
          error: null,
        },
        { data: [], error: null },
      ],
      license_keys: { data: [{ id: 'license-1' }], error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      audit_logs: { data: null, error: null },
    });
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      resource: { id: 'SUB-EXPIRED' },
      id: 'EVT-SUB-EXPIRED',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual({
      table: 'orders',
      column: 'paypal_subscription_id',
      value: 'SUB-EXPIRED',
    });
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        { table: 'entitlements', column: 'order_id', value: 'order-expired' },
        { table: 'entitlements', column: 'guild_id', value: 'guild-1' },
        { table: 'entitlements', column: 'product_id', value: 'product-1' },
        { table: 'license_keys', column: 'order_id', value: 'order-expired' },
        { table: 'license_keys', column: 'guild_id', value: 'guild-1' },
        { table: 'license_keys', column: 'product_id', value: 'product-1' },
      ]),
    );
    expect(inCalls).toEqual(
      expect.arrayContaining([
        {
          table: 'entitlements',
          column: 'status',
          values: ['active', 'pending', 'grace_period', 'suspended'],
        },
        {
          table: 'license_keys',
          column: 'status',
          values: ['pending_activation', 'active', 'suspended'],
        },
        {
          table: 'license_sessions',
          column: 'license_key_id',
          values: ['license-1'],
        },
      ]),
    );
    expect(updates).toEqual(
      expect.arrayContaining([
        {
          table: 'entitlements',
          payload: expect.objectContaining({ status: 'expired' }),
        },
        {
          table: 'license_keys',
          payload: expect.objectContaining({ status: 'expired' }),
        },
        {
          table: 'license_sessions',
          payload: expect.objectContaining({
            active: false,
            deactivation_reason: 'entitlement_revoked',
          }),
        },
      ]),
    );
    expect(inserts).toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        action: 'revoke_roles',
        payload: expect.objectContaining({
          discord_id: 'discord-1',
          role_ids: ['role-1', 'role-2'],
          reason: 'subscription_expired',
          order_id: 'order-expired',
          product_id: 'product-1',
        }),
        status: 'pending',
      }),
    });
    expect(inserts).toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        action: 'emit_audit_event',
        payload: expect.objectContaining({
          event_type: 'subscription.expired',
          event_data: {
            discordId: 'discord-1',
            productId: 'product-1',
            planId: 'plan-1',
            status: 'expired',
          },
        }),
        status: 'pending',
      }),
    });
    expect(inserts).toContainEqual({
      table: 'audit_logs',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        actor_id: 'paypal_webhook',
        action: 'subscription.expired',
        target_type: 'order',
        target_id: 'order-expired',
        details: expect.objectContaining({
          event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
          paypal_subscription_id: 'SUB-EXPIRED',
          product_id: 'product-1',
        }),
      }),
    });
    expect(inserts).not.toContainEqual(
      expect.objectContaining({
        table: 'bot_action_queue',
        payload: expect.objectContaining({ action: 'fulfill_suspension' }),
      }),
    );
  });

  it('subscription expiry preserves roles still granted by other active entitlements', async () => {
    const { inserts } = useWebhookRows({
      orders: {
        data: {
          id: 'order-expired',
          order_number: 'ORD-EXPIRED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
        },
        error: null,
      },
      entitlements: [
        {
          data: [
            {
              id: 'entitlement-1',
              customer_id: 'customer-1',
              granted_role_ids: ['role-1', 'role-shared'],
              license_key_id: 'license-1',
            },
          ],
          error: null,
        },
        {
          data: [
            {
              id: 'entitlement-2',
              granted_role_ids: ['role-shared', 'role-other'],
            },
          ],
          error: null,
        },
      ],
      license_keys: { data: [{ id: 'license-1' }], error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      audit_logs: { data: null, error: null },
    });
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      resource: { id: 'SUB-EXPIRED' },
      id: 'EVT-SUB-EXPIRED-SHARED-ROLE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inserts).toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        action: 'revoke_roles',
        payload: expect.objectContaining({
          discord_id: 'discord-1',
          role_ids: ['role-1'],
          reason: 'subscription_expired',
          order_id: 'order-expired',
          product_id: 'product-1',
        }),
        status: 'pending',
      }),
    });
  });

  it('subscription expiry uses the completed subscription order when PayPal also has a pending attempt row', async () => {
    const { eqCalls, inserts } = useWebhookRows({
      orders: {
        data: [
          {
            id: 'order-pending-attempt',
            order_number: 'ORD-PENDING',
            guild_id: 'guild-1',
            customer_id: 'customer-1',
            product_id: 'product-1',
            plan_id: 'plan-1',
            status: 'pending',
            created_at: '2026-06-17T15:00:00.000Z',
          },
          {
            id: 'order-completed-activation',
            order_number: 'ORD-COMPLETED',
            guild_id: 'guild-1',
            customer_id: 'customer-1',
            product_id: 'product-1',
            plan_id: 'plan-1',
            status: 'completed',
            created_at: '2026-06-17T14:00:00.000Z',
          },
        ],
        error: null,
      },
      entitlements: [
        {
          data: [
            {
              id: 'entitlement-1',
              customer_id: 'customer-1',
              granted_role_ids: ['role-1'],
              license_key_id: null,
            },
          ],
          error: null,
        },
        { data: [], error: null },
      ],
      license_keys: { data: [], error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: { data: null, error: null },
      audit_logs: { data: null, error: null },
    });
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      resource: { id: 'SUB-DUPLICATE-ORDERS' },
      id: 'EVT-SUB-DUPLICATE-ORDERS',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual({
      table: 'entitlements',
      column: 'order_id',
      value: 'order-completed-activation',
    });
    expect(inserts).toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({
        action: 'revoke_roles',
        payload: expect.objectContaining({
          order_id: 'order-completed-activation',
        }),
      }),
    });
  });

  it('repeated subscription expiry does not queue duplicate role revocation', async () => {
    const { inserts } = useWebhookRows({
      orders: {
        data: {
          id: 'order-already-expired',
          order_number: 'ORD-ALREADY-EXPIRED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
        },
        error: null,
      },
      entitlements: [
        { data: [], error: null },
        { data: [], error: null },
      ],
      license_keys: { data: [], error: null },
      audit_logs: { data: null, error: null },
    });
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      resource: { id: 'SUB-ALREADY-EXPIRED' },
      id: 'EVT-SUB-EXPIRED-AGAIN',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inserts).not.toContainEqual(
      expect.objectContaining({
        table: 'bot_action_queue',
        payload: expect.objectContaining({ action: 'revoke_roles' }),
      }),
    );
  });

  it('subscription expiry returns 500 when critical entitlement expiry writes fail', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useWebhookRows({
      orders: {
        data: {
          id: 'order-expired',
          order_number: 'ORD-EXPIRED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
        },
        error: null,
      },
      entitlements: [
        {
          data: [
            {
              id: 'entitlement-1',
              customer_id: 'customer-1',
              granted_role_ids: ['role-1'],
              license_key_id: null,
            },
          ],
          error: null,
        },
        { data: [], error: null },
        { data: null, error: { message: 'entitlement update failed' } },
      ],
      license_keys: { data: [], error: null },
    });
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      resource: { id: 'SUB-EXPIRED' },
      id: 'EVT-SUB-EXPIRED-WRITE-FAIL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    const routeError = errorSpy.mock.calls.find(
      ([message]) => message === '[Webhook] Error processing BILLING.SUBSCRIPTION.EXPIRED:',
    )?.[1] as Error | undefined;
    expect(routeError?.message).toContain(
      'Failed to expire entitlements for subscription expiry',
    );
    errorSpy.mockRestore();
  });

  it('subscription expiry returns 500 when role revocation cannot be queued', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useWebhookRows({
      orders: {
        data: {
          id: 'order-expired',
          order_number: 'ORD-EXPIRED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
        },
        error: null,
      },
      entitlements: [
        {
          data: [
            {
              id: 'entitlement-1',
              customer_id: 'customer-1',
              granted_role_ids: ['role-1'],
              license_key_id: null,
            },
          ],
          error: null,
        },
        { data: [], error: null },
      ],
      license_keys: { data: [], error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: { data: null, error: { message: 'queue insert failed' } },
    });
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      resource: { id: 'SUB-EXPIRED' },
      id: 'EVT-SUB-EXPIRED-QUEUE-FAIL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      '[Webhook] Failed to queue revoke_roles:',
      'queue insert failed',
    );
    const routeError = errorSpy.mock.calls.find(
      ([message]) => message === '[Webhook] Error processing BILLING.SUBSCRIPTION.EXPIRED:',
    )?.[1] as Error | undefined;
    expect(routeError?.message).toContain(
      'Failed to queue role revocation for subscription expiry',
    );
    errorSpy.mockRestore();
  });

  it('subscription expiry retry can requeue roles after a previous failed queue insert', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { inserts, inCalls, updates } = useWebhookRows({
        webhook_events: [
          { data: [], error: null },
          { data: { result: 'error', processed_at: new Date().toISOString() }, error: null },
          { data: { event_id: 'EVT-SUB-EXPIRED-RETRY' }, error: null },
          { data: null, error: null },
        ],
        orders: {
          data: {
            id: 'order-expired',
            order_number: 'ORD-EXPIRED',
            guild_id: 'guild-1',
            customer_id: 'customer-1',
            product_id: 'product-1',
            plan_id: 'plan-1',
          },
          error: null,
        },
        entitlements: [
          {
            data: [
              {
                id: 'entitlement-1',
                customer_id: 'customer-1',
                granted_role_ids: ['role-1'],
                license_key_id: 'license-1',
              },
            ],
            error: null,
          },
          { data: [], error: null },
          { data: null, error: null },
        ],
        license_keys: { data: [{ id: 'license-1' }], error: null },
        license_sessions: { data: null, error: null },
        customers: { data: { discord_id: 'discord-1' }, error: null },
        bot_action_queue: { data: null, error: null },
        audit_logs: { data: null, error: null },
      });
      const req = makeSignedWebhook({
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-EXPIRED' },
        id: 'EVT-SUB-EXPIRED-RETRY',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(inCalls).toContainEqual({
        table: 'entitlements',
        column: 'status',
        values: ['active', 'pending', 'grace_period', 'suspended', 'expired'],
      });
      expect(inCalls).toContainEqual({
        table: 'license_keys',
        column: 'status',
        values: ['pending_activation', 'active', 'suspended', 'expired'],
      });
      expect(inserts).toContainEqual({
        table: 'bot_action_queue',
        payload: expect.objectContaining({
          guild_id: 'guild-1',
          action: 'revoke_roles',
          payload: expect.objectContaining({
            discord_id: 'discord-1',
            role_ids: ['role-1'],
            reason: 'subscription_expired',
            order_id: 'order-expired',
            product_id: 'product-1',
          }),
          status: 'pending',
        }),
      });
      expect(updates).toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({ result: null, error_details: null }),
      });
      expect(updates).toContainEqual({
        table: 'webhook_events',
        payload: { result: 'success', error_details: null },
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('subscription expiry internal replay can requeue roles when marked as a failed retry', async () => {
    const { inserts, inCalls } = useWebhookRows({
      orders: {
        data: {
          id: 'order-expired',
          order_number: 'ORD-EXPIRED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
        },
        error: null,
      },
      entitlements: [
        {
          data: [
            {
              id: 'entitlement-1',
              customer_id: 'customer-1',
              granted_role_ids: ['role-1'],
              license_key_id: 'license-1',
            },
          ],
          error: null,
        },
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: { data: [{ id: 'license-1' }], error: null },
      license_sessions: { data: null, error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: { data: null, error: null },
      audit_logs: { data: null, error: null },
    });
    const req = makeReplay(
      {
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-EXPIRED' },
        id: 'EVT-SUB-EXPIRED-REPLAY',
      },
      { 'x-webhook-retrying-failed-event': '1' },
    );

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inCalls).toContainEqual({
      table: 'entitlements',
      column: 'status',
      values: ['active', 'pending', 'grace_period', 'suspended', 'expired'],
    });
    expect(inserts).toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        action: 'revoke_roles',
        payload: expect.objectContaining({ role_ids: ['role-1'] }),
      }),
    });
  });

  it('subscription expiry retry does not duplicate an already queued role revocation', async () => {
    const { inserts, inCalls } = useWebhookRows({
      orders: {
        data: {
          id: 'order-expired',
          order_number: 'ORD-EXPIRED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
        },
        error: null,
      },
      entitlements: [
        {
          data: [
            {
              id: 'entitlement-1',
              customer_id: 'customer-1',
              granted_role_ids: ['role-1'],
              license_key_id: 'license-1',
            },
          ],
          error: null,
        },
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: { data: [{ id: 'license-1' }], error: null },
      license_sessions: { data: null, error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: [
        { data: [{ id: 'queued-revoke', status: 'completed', result: { failed: [] } }], error: null },
        { data: null, error: null },
      ],
      audit_logs: { data: null, error: null },
    });
    const req = makeReplay(
      {
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-EXPIRED' },
        id: 'EVT-SUB-EXPIRED-REPLAY',
      },
      { 'x-webhook-retrying-failed-event': '1' },
    );

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inCalls).toContainEqual({
      table: 'bot_action_queue',
      column: 'status',
      values: ['pending', 'processing', 'completed'],
    });
    expect(inserts).not.toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({ action: 'revoke_roles' }),
    });
    expect(inserts).toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        action: 'emit_audit_event',
        payload: expect.objectContaining({
          event_type: 'subscription.expired',
        }),
      }),
    });
  });

  it('subscription expiry retry requeues roles when the previous completed revocation failed roles', async () => {
    const { inserts } = useWebhookRows({
      orders: {
        data: {
          id: 'order-expired',
          order_number: 'ORD-EXPIRED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
        },
        error: null,
      },
      entitlements: [
        {
          data: [
            {
              id: 'entitlement-1',
              customer_id: 'customer-1',
              granted_role_ids: ['role-1'],
              license_key_id: 'license-1',
            },
          ],
          error: null,
        },
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: { data: [{ id: 'license-1' }], error: null },
      license_sessions: { data: null, error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: [
        {
          data: [{ id: 'queued-revoke', status: 'completed', result: { failed: ['role-1'] } }],
          error: null,
        },
        { data: null, error: null },
        { data: null, error: null },
      ],
      audit_logs: { data: null, error: null },
    });
    const req = makeReplay(
      {
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-EXPIRED' },
        id: 'EVT-SUB-EXPIRED-REPLAY-FAILED-ROLES',
      },
      { 'x-webhook-retrying-failed-event': '1' },
    );

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inserts).toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        action: 'revoke_roles',
        payload: expect.objectContaining({
          role_ids: ['role-1'],
        }),
      }),
    });
  });

  it('subscription expiry retry does not duplicate roles when a pending retry exists after a failed completed revoke', async () => {
    const { inserts, inCalls } = useWebhookRows({
      orders: {
        data: {
          id: 'order-expired',
          order_number: 'ORD-EXPIRED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
        },
        error: null,
      },
      entitlements: [
        {
          data: [
            {
              id: 'entitlement-1',
              customer_id: 'customer-1',
              granted_role_ids: ['role-1'],
              license_key_id: 'license-1',
            },
          ],
          error: null,
        },
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: { data: [{ id: 'license-1' }], error: null },
      license_sessions: { data: null, error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: [
        {
          data: [
            { id: 'queued-revoke-failed', status: 'completed', result: { failed: ['role-1'] } },
            { id: 'queued-revoke-pending', status: 'pending', result: null },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      audit_logs: { data: null, error: null },
    });
    const req = makeReplay(
      {
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-EXPIRED' },
        id: 'EVT-SUB-EXPIRED-REPLAY-PENDING-RETRY',
      },
      { 'x-webhook-retrying-failed-event': '1' },
    );

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inCalls).toContainEqual({
      table: 'bot_action_queue',
      column: 'status',
      values: ['pending', 'processing', 'completed'],
    });
    expect(inserts).not.toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({ action: 'revoke_roles' }),
    });
  });

  it('subscription expiry recovers stale in-progress webhook rows', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { inserts, updates } = useWebhookRows({
        webhook_events: [
          { data: [], error: null },
          {
            data: {
              result: null,
              processed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
            },
            error: null,
          },
          { data: { event_id: 'EVT-SUB-EXPIRED-STALE' }, error: null },
          { data: null, error: null },
        ],
        orders: {
          data: {
            id: 'order-expired',
            order_number: 'ORD-EXPIRED',
            guild_id: 'guild-1',
            customer_id: 'customer-1',
            product_id: 'product-1',
            plan_id: 'plan-1',
          },
          error: null,
        },
        entitlements: [
          {
            data: [
              {
                id: 'entitlement-1',
                customer_id: 'customer-1',
                granted_role_ids: ['role-1'],
                license_key_id: null,
              },
            ],
            error: null,
          },
          { data: [], error: null },
          { data: null, error: null },
        ],
        license_keys: { data: [], error: null },
        customers: { data: { discord_id: 'discord-1' }, error: null },
        bot_action_queue: { data: null, error: null },
        audit_logs: { data: null, error: null },
      });
      const req = makeSignedWebhook({
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-EXPIRED' },
        id: 'EVT-SUB-EXPIRED-STALE',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(updates).toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({ error_details: null }),
      });
      expect(inserts).toContainEqual({
        table: 'bot_action_queue',
        payload: expect.objectContaining({
          guild_id: 'guild-1',
          action: 'revoke_roles',
        }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not blindly retry non-resumable failed duplicate webhooks', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { updates } = useWebhookRows({
        webhook_events: [
          { data: [], error: null },
          { data: { result: 'error', processed_at: new Date().toISOString() }, error: null },
        ],
      });
      const req = makeSignedWebhook({
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: 'CAPTURE-FAILED-RETRY' },
        id: 'EVT-CAPTURE-FAILED-RETRY',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: 'failed_requires_manual_replay',
      });
      expect(updates).not.toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({ result: null }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not auto-retry stale non-resumable webhook rows', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { updates, inserts } = useWebhookRows({
        webhook_events: [
          { data: [], error: null },
          {
            data: {
              result: null,
              processed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
            },
            error: null,
          },
          { data: null, error: null },
        ],
      });
      const req = makeSignedWebhook({
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: 'CAPTURE-STALE-NON-RESUMABLE' },
        id: 'EVT-CAPTURE-STALE-NON-RESUMABLE',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: 'stale_requires_manual_replay',
      });
      expect(updates).toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({
          result: 'error',
          error_details: 'Stale webhook requires manual replay',
        }),
      });
      expect(inserts).toEqual([]);
    } finally {
      global.fetch = originalFetch;
    }
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
