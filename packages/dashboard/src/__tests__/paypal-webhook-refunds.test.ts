/**
 * Refund / reversal semantics for POST /api/paypal/webhook.
 *
 * W2 hardening — differentiated refund handling:
 *  (a) FULL refund  → revoke entitlements + license keys + license sessions,
 *      queue Discord role revocation, write a reliable audit trail.
 *  (b) PARTIAL refund → do NOT auto-revoke; record the refund, raise an
 *      operator-review alert, and audit the decision.
 *  (c) Idempotency → replayed refund events must not double-process
 *      (payments.status commit marker + payment_refunds unique refund id).
 *  (d) Ordering → a refund arriving before its capture/sale-completed event
 *      must fail (500) so PayPal retries it, instead of being silently
 *      dropped while the customer keeps access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { replaySecret } = vi.hoisted(() => {
  const secret = 'test-refund-webhook-replay-secret';
  process.env.NEXTAUTH_SECRET = 'test-secret-refunds';
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
      'paypal-transmission-id': 'transmission-refund-1',
      'paypal-transmission-sig': 'sig-1',
      'paypal-transmission-time': new Date().toISOString(),
    },
    body: JSON.stringify(body),
  });
}

function makeMockSupabase() {
  const fromFn = vi.fn();
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

  function makeChain(resolvedValue?: { data: unknown; error: unknown }) {
    const defaultResolved = resolvedValue ?? { data: null, error: null };
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(defaultResolved);
        }
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
  onUpsert?: (payload: unknown) => void,
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
  chain.upsert = vi.fn((payload: unknown) => {
    onUpsert?.(payload);
    return chain;
  });
  chain.then = (
    resolve: (v: unknown) => void,
    reject?: (reason: unknown) => void,
  ) => Promise.resolve(resolvedValue).then(resolve, reject);

  return chain;
}

type MockRowResult = { data: unknown; error: unknown };

function useWebhookRows(rows: Record<string, MockRowResult | MockRowResult[]>) {
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const upserts: Array<{ table: string; payload: unknown }> = [];
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
      (payload) => {
        upserts.push({ table, payload });
      },
    );
  });

  return { inserts, upserts, eqCalls, updates, inCalls };
}

let mockSb: ReturnType<typeof makeMockSupabase>;

beforeEach(() => {
  vi.clearAllMocks();
  mockSb = makeMockSupabase();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSb);
});

/** Payment row as returned by the payments lookup. */
const basePayment = {
  id: 'payment-row-1',
  order_id: 'order-1',
  customer_id: 'customer-1',
  guild_id: 'guild-1',
  status: 'completed',
  amount_cents: 1000,
  currency: 'USD',
};

describe('PayPal webhook — full refund semantics', () => {
  it('full capture refund revokes entitlements, license keys, sessions and queues role revocation', async () => {
    const { inserts, updates, inCalls } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 1000 }], error: null },
      ],
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
        { data: [], error: null }, // role-preservation lookup (other orders)
        { data: null, error: null }, // revocation update
      ],
      license_keys: [
        { data: [{ id: 'license-1' }, { id: 'license-2' }], error: null },
        { data: null, error: null },
      ],
      license_sessions: { data: null, error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: { data: null, error: null },
      audit_logs: { data: null, error: null },
      orders: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-FULL-1',
        amount: { value: '10.00', currency_code: 'USD' },
        seller_payable_breakdown: {
          total_refunded_amount: { value: '10.00', currency_code: 'USD' },
        },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REFUND-FULL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    // Refund recorded for idempotency + cumulative tracking
    expect(inserts).toContainEqual({
      table: 'payment_refunds',
      payload: expect.objectContaining({
        payment_id: 'payment-row-1',
        order_id: 'order-1',
        guild_id: 'guild-1',
        paypal_refund_id: 'REFUND-FULL-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 1000,
        currency: 'USD',
      }),
    });

    // Entitlements + license keys revoked, sessions deactivated
    expect(updates).toEqual(
      expect.arrayContaining([
        {
          table: 'entitlements',
          payload: expect.objectContaining({ status: 'expired' }),
        },
        {
          table: 'license_keys',
          payload: expect.objectContaining({
            status: 'revoked',
            revocation_reason: 'refunded',
          }),
        },
        {
          table: 'license_sessions',
          payload: expect.objectContaining({
            active: false,
            deactivation_reason: 'entitlement_revoked',
          }),
        },
        {
          table: 'orders',
          payload: expect.objectContaining({ status: 'refunded' }),
        },
        {
          table: 'payments',
          payload: expect.objectContaining({ status: 'refunded' }),
        },
      ]),
    );
    expect(inCalls).toContainEqual({
      table: 'license_sessions',
      column: 'license_key_id',
      values: ['license-1', 'license-2'],
    });

    // Role revocation queued for the bot
    expect(inserts).toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        action: 'revoke_roles',
        payload: expect.objectContaining({
          discord_id: 'discord-1',
          role_ids: ['role-1', 'role-2'],
          reason: 'refunded',
          order_id: 'order-1',
        }),
        status: 'pending',
      }),
    });

    // Audit trail with refund details
    expect(inserts).toContainEqual({
      table: 'audit_logs',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        actor_type: 'system',
        actor_id: 'paypal_webhook',
        action: 'order.refunded_external',
        target_type: 'order',
        target_id: 'order-1',
        details: expect.objectContaining({
          event_type: 'PAYMENT.CAPTURE.REFUNDED',
          paypal_refund_id: 'REFUND-FULL-1',
          refund_scope: 'full',
          refund_amount_cents: 1000,
          payment_amount_cents: 1000,
          entitlement_ids: ['entitlement-1'],
          license_key_ids: ['license-1', 'license-2'],
          role_ids: ['role-1', 'role-2'],
        }),
      }),
    });
  });

  it('full refund preserves roles still granted by other active entitlements', async () => {
    const { inserts } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 1000 }], error: null },
      ],
      entitlements: [
        {
          data: [
            {
              id: 'entitlement-1',
              customer_id: 'customer-1',
              granted_role_ids: ['role-1', 'role-shared'],
              license_key_id: null,
            },
          ],
          error: null,
        },
        {
          data: [{ granted_role_ids: ['role-shared', 'role-other'] }],
          error: null,
        },
        { data: null, error: null },
      ],
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: { data: null, error: null },
      audit_logs: { data: null, error: null },
      orders: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-SHARED-ROLE',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REFUND-SHARED-ROLE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inserts).toContainEqual({
      table: 'bot_action_queue',
      payload: expect.objectContaining({
        action: 'revoke_roles',
        payload: expect.objectContaining({ role_ids: ['role-1'] }),
      }),
    });
  });

  it('capture reversal (chargeback) always revokes in full even with a partial amount', async () => {
    const { updates } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 250 }], error: null },
      ],
      entitlements: [
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
      audit_logs: { data: null, error: null },
      orders: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REVERSED',
      resource: {
        id: 'REVERSAL-1',
        amount: { value: '2.50', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REVERSAL-PARTIAL-AMOUNT',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(updates).toEqual(
      expect.arrayContaining([
        {
          table: 'license_keys',
          payload: expect.objectContaining({
            status: 'revoked',
            revocation_reason: 'reversed',
          }),
        },
        {
          table: 'payments',
          payload: expect.objectContaining({ status: 'reversed' }),
        },
      ]),
    );
  });

  it('refund in a different currency is treated as full (comparison impossible, fail safe)', async () => {
    const { updates, inserts } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 250 }], error: null },
      ],
      entitlements: [
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
      audit_logs: { data: null, error: null },
      orders: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-EUR-1',
        amount: { value: '2.50', currency_code: 'EUR' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REFUND-CURRENCY-MISMATCH',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(updates).toContainEqual({
      table: 'payments',
      payload: expect.objectContaining({ status: 'refunded' }),
    });
    expect(inserts).not.toContainEqual(
      expect.objectContaining({ table: 'alerts' }),
    );
  });

  it('partial refund becomes full once PayPal cumulative total covers the payment', async () => {
    const { updates } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 250 }], error: null },
      ],
      entitlements: [
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
      audit_logs: { data: null, error: null },
      orders: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-CUMULATIVE',
        amount: { value: '2.50', currency_code: 'USD' },
        seller_payable_breakdown: {
          total_refunded_amount: { value: '10.00', currency_code: 'USD' },
        },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REFUND-CUMULATIVE-FULL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(updates).toContainEqual({
      table: 'payments',
      payload: expect.objectContaining({ status: 'refunded' }),
    });
  });

  it('full refund does not mark the payment refunded when entitlement revocation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { updates } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 1000 }], error: null },
      ],
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
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-WRITE-FAIL',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REFUND-WRITE-FAIL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    // The commit marker must not flip while revocation is incomplete —
    // otherwise the replay guard would skip the retry forever.
    expect(updates).not.toContainEqual({
      table: 'payments',
      payload: expect.objectContaining({ status: 'refunded' }),
    });
    errorSpy.mockRestore();
  });

  it('full refund returns 500 when role revocation cannot be queued', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { updates } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 1000 }], error: null },
      ],
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
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: { data: null, error: { message: 'queue insert failed' } },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-QUEUE-FAIL',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REFUND-QUEUE-FAIL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    expect(updates).not.toContainEqual({
      table: 'payments',
      payload: expect.objectContaining({ status: 'refunded' }),
    });
    errorSpy.mockRestore();
  });
});

describe('PayPal webhook — partial refund semantics', () => {
  it('partial capture refund keeps access and raises an operator-review alert', async () => {
    const { inserts, updates } = useWebhookRows({
      payments: { data: basePayment, error: null },
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 250 }], error: null },
      ],
      alerts: { data: null, error: null },
      audit_logs: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-PARTIAL-1',
        amount: { value: '2.50', currency_code: 'USD' },
        seller_payable_breakdown: {
          total_refunded_amount: { value: '2.50', currency_code: 'USD' },
        },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REFUND-PARTIAL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    // Nothing is revoked (webhook_events bookkeeping is the only update)
    expect(updates.filter((u) => u.table !== 'webhook_events')).toEqual([]);
    expect(inserts).not.toContainEqual(
      expect.objectContaining({ table: 'bot_action_queue' }),
    );

    // Refund recorded
    expect(inserts).toContainEqual({
      table: 'payment_refunds',
      payload: expect.objectContaining({
        paypal_refund_id: 'REFUND-PARTIAL-1',
        amount_cents: 250,
      }),
    });

    // Operator-review alert
    expect(inserts).toContainEqual({
      table: 'alerts',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        alert_type: 'partial_refund_review',
        severity: 'warning',
        metadata: expect.objectContaining({
          paypal_refund_id: 'REFUND-PARTIAL-1',
          order_id: 'order-1',
          refund_amount_cents: 250,
          payment_amount_cents: 1000,
        }),
      }),
    });

    // Audit trail records the retained-access decision
    expect(inserts).toContainEqual({
      table: 'audit_logs',
      payload: expect.objectContaining({
        action: 'order.refund_partial',
        target_id: 'order-1',
        details: expect.objectContaining({
          paypal_refund_id: 'REFUND-PARTIAL-1',
          refund_amount_cents: 250,
          payment_amount_cents: 1000,
          decision: 'access_retained_pending_review',
        }),
      }),
    });
  });

  it('sale refund with negative amount is treated as partial by absolute value', async () => {
    const { inserts, updates } = useWebhookRows({
      payments: { data: basePayment, error: null },
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 500 }], error: null },
      ],
      alerts: { data: null, error: null },
      audit_logs: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REFUNDED',
      resource: {
        id: 'REFUND-SALE-NEG',
        sale_id: 'SALE-1',
        amount: { total: '-5.00', currency: 'USD' },
      },
      id: 'EVT-SALE-REFUND-NEGATIVE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(updates.filter((u) => u.table !== 'webhook_events')).toEqual([]);
    expect(inserts).toContainEqual({
      table: 'payment_refunds',
      payload: expect.objectContaining({
        paypal_refund_id: 'REFUND-SALE-NEG',
        amount_cents: 500,
      }),
    });
    expect(inserts).toContainEqual({
      table: 'alerts',
      payload: expect.objectContaining({ alert_type: 'partial_refund_review' }),
    });
  });

  it('duplicate partial-refund alert (23505) is tolerated as dedupe success', async () => {
    const { inserts } = useWebhookRows({
      payments: { data: basePayment, error: null },
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 250 }], error: null },
      ],
      alerts: {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      },
      audit_logs: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-PARTIAL-DUP-ALERT',
        amount: { value: '2.50', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REFUND-PARTIAL-DUP-ALERT',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inserts).toContainEqual({
      table: 'audit_logs',
      payload: expect.objectContaining({ action: 'order.refund_partial' }),
    });
  });
});

describe('PayPal webhook — refund idempotency', () => {
  it('replayed refund for an already-refunded payment is skipped entirely', async () => {
    const { inserts, updates } = useWebhookRows({
      payments: { data: { ...basePayment, status: 'refunded' }, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-REPLAY',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REFUND-ALREADY-DONE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inserts).toEqual([]);
    expect(updates.filter((u) => u.table !== 'webhook_events')).toEqual([]);
  });

  it('replayed partial refund with an already-recorded refund id does not double-process', async () => {
    const { inserts, updates } = useWebhookRows({
      payments: { data: basePayment, error: null },
      payment_refunds: [
        {
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        },
        { data: [{ amount_cents: 250 }], error: null },
      ],
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-PARTIAL-REPLAY',
        amount: { value: '2.50', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REFUND-PARTIAL-REPLAY',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(updates.filter((u) => u.table !== 'webhook_events')).toEqual([]);
    // No duplicate alert or audit row for a replayed, already-processed refund
    expect(inserts.filter((i) => i.table === 'alerts')).toEqual([]);
    expect(inserts.filter((i) => i.table === 'audit_logs')).toEqual([]);
  });
});

describe('PayPal webhook — refund ordering (out-of-order webhooks)', () => {
  it('refund arriving before capture-completed fails (500) so PayPal retries it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { inserts, updates } = useWebhookRows({
      payments: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-EARLY',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-NOT-YET' } },
      },
      id: 'EVT-REFUND-BEFORE-CAPTURE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    expect(inserts).toEqual([]);
    expect(updates.filter((u) => u.table !== 'webhook_events')).toEqual([]);
    errorSpy.mockRestore();
  });

  it('failed refund events are resumable — the PayPal retry re-processes them', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { inserts, updates } = useWebhookRows({
        webhook_events: [
          { data: [], error: null }, // upsert conflicts (row already exists)
          { data: { result: 'error', processed_at: new Date().toISOString() }, error: null },
          { data: { event_id: 'EVT-REFUND-RETRY' }, error: null }, // claim
          { data: null, error: null },
        ],
        payments: [
          { data: { guild_id: 'guild-1' }, error: null }, // guild resolution
          { data: basePayment, error: null },
          { data: null, error: null },
        ],
        payment_refunds: [
          { data: null, error: null },
          { data: [{ amount_cents: 1000 }], error: null },
        ],
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
        license_keys: [{ data: [], error: null }, { data: null, error: null }],
        customers: { data: { discord_id: 'discord-1' }, error: null },
        bot_action_queue: [
          { data: [], error: null }, // retry dedupe probe: nothing queued yet
          { data: null, error: null },
        ],
        audit_logs: { data: null, error: null },
        orders: { data: null, error: null },
      });

      const req = makeSignedWebhook({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: 'REFUND-RETRY',
          amount: { value: '10.00', currency_code: 'USD' },
          supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
        },
        id: 'EVT-REFUND-RETRY',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(inserts).toContainEqual({
        table: 'bot_action_queue',
        payload: expect.objectContaining({
          action: 'revoke_roles',
          payload: expect.objectContaining({
            role_ids: ['role-1'],
            reason: 'refunded',
          }),
        }),
      });
      expect(updates).toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({ result: 'success' }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('refund retry does not queue duplicate role revocation already queued by the failed attempt', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { inserts } = useWebhookRows({
        webhook_events: [
          { data: [], error: null },
          { data: { result: 'error', processed_at: new Date().toISOString() }, error: null },
          { data: { event_id: 'EVT-REFUND-RETRY-DEDUPE' }, error: null },
          { data: null, error: null },
        ],
        payments: [
          { data: { guild_id: 'guild-1' }, error: null },
          { data: basePayment, error: null },
          { data: null, error: null },
        ],
        payment_refunds: [
          {
            data: null,
            error: { code: '23505', message: 'duplicate key' },
          },
          { data: [{ amount_cents: 1000 }], error: null },
        ],
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
        license_keys: [{ data: [], error: null }, { data: null, error: null }],
        customers: { data: { discord_id: 'discord-1' }, error: null },
        bot_action_queue: [
          {
            data: [{ id: 'queued-revoke', status: 'pending', result: null }],
            error: null,
          },
          { data: null, error: null },
        ],
        audit_logs: { data: null, error: null },
        orders: { data: null, error: null },
      });

      const req = makeSignedWebhook({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: 'REFUND-RETRY-DEDUPE',
          amount: { value: '10.00', currency_code: 'USD' },
          supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
        },
        id: 'EVT-REFUND-RETRY-DEDUPE',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(inserts).not.toContainEqual(
        expect.objectContaining({
          table: 'bot_action_queue',
          payload: expect.objectContaining({ action: 'revoke_roles' }),
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('PayPal webhook — refund currency semantics (legacy USD-labeled sale payments)', () => {
  it('PAYMENT.SALE.COMPLETED persists the sale currency instead of hardcoded USD', async () => {
    const { inserts } = useWebhookRows({
      orders: {
        data: { id: 'order-sub-eur', customer_id: 'customer-1', guild_id: 'guild-1' },
        error: null,
      },
      payments: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.SALE.COMPLETED',
      resource: {
        id: 'SALE-EUR-1',
        billing_agreement_id: 'SUB-EUR-1',
        amount: { total: '9.99', currency: 'EUR' },
      },
      id: 'EVT-SALE-COMPLETED-EUR',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inserts).toContainEqual({
      table: 'payments',
      payload: expect.objectContaining({
        paypal_payment_id: 'SALE-EUR-1',
        amount_cents: 999,
        currency: 'EUR',
        status: 'completed',
      }),
    });
  });

  it('partial sale refund on a legacy USD-labeled payment stays partial when the payload confirms the sale currency', async () => {
    const { inserts, updates } = useWebhookRows({
      // Legacy row: amount_cents parsed from the EUR sale payload, but the
      // currency label was persisted as hardcoded 'USD'.
      payments: { data: basePayment, error: null },
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 250 }], error: null },
      ],
      alerts: { data: null, error: null },
      audit_logs: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REFUNDED',
      resource: {
        id: 'REFUND-SALE-EUR-PARTIAL',
        sale_id: 'SALE-1',
        amount: { total: '2.50', currency: 'EUR' },
        total_refunded_amount: { value: '2.50', currency: 'EUR' },
      },
      id: 'EVT-SALE-REFUND-EUR-PARTIAL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    // Access retained: no revocations, operator review raised instead
    expect(updates.filter((u) => u.table !== 'webhook_events')).toEqual([]);
    expect(inserts).not.toContainEqual(
      expect.objectContaining({ table: 'bot_action_queue' }),
    );
    expect(inserts).toContainEqual({
      table: 'alerts',
      payload: expect.objectContaining({ alert_type: 'partial_refund_review' }),
    });
    expect(inserts).toContainEqual({
      table: 'audit_logs',
      payload: expect.objectContaining({
        action: 'order.refund_partial',
        details: expect.objectContaining({
          decision: 'access_retained_pending_review',
        }),
      }),
    });
  });

  it('sale refund in a different currency WITHOUT payload confirmation is still treated as full', async () => {
    const { updates, inserts } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 250 }], error: null },
      ],
      entitlements: [
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
      audit_logs: { data: null, error: null },
      orders: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REFUNDED',
      resource: {
        id: 'REFUND-SALE-EUR-NOCONF',
        sale_id: 'SALE-1',
        amount: { total: '2.50', currency: 'EUR' },
        // no total_refunded_amount → the payload does not confirm the sale
        // currency, so the mismatch stays a fail-safe full revocation
      },
      id: 'EVT-SALE-REFUND-EUR-NOCONF',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(updates).toContainEqual({
      table: 'payments',
      payload: expect.objectContaining({ status: 'refunded' }),
    });
    expect(inserts).not.toContainEqual(
      expect.objectContaining({ table: 'alerts' }),
    );
  });

  it('capture refund keeps the strict currency fail-safe even when the payload self-confirms its currency', async () => {
    const { updates, inserts } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 250 }], error: null },
      ],
      entitlements: [
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
      audit_logs: { data: null, error: null },
      orders: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-CAPTURE-EUR-CONF',
        amount: { value: '2.50', currency_code: 'EUR' },
        seller_payable_breakdown: {
          total_refunded_amount: { value: '2.50', currency_code: 'EUR' },
        },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-CAPTURE-REFUND-EUR-CONF',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    // Capture payments always persisted the checkout currency — the legacy
    // tolerance is sale-only, so this stays a full revocation.
    expect(updates).toContainEqual({
      table: 'payments',
      payload: expect.objectContaining({ status: 'refunded' }),
    });
    expect(inserts).not.toContainEqual(
      expect.objectContaining({ table: 'alerts' }),
    );
  });
});

describe('PayPal webhook — subscription cancellation/suspension queue reliability', () => {
  it('subscription cancellation returns 500 when the bot fulfillment cannot be queued', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useWebhookRows({
      orders: {
        data: {
          id: 'order-cancelled',
          order_number: 'ORD-CANCELLED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
        },
        error: null,
      },
      products: { data: { name: 'Subscription' }, error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: { data: null, error: { message: 'queue insert failed' } },
    });

    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
      resource: { id: 'SUB-CANCEL-QUEUE-FAIL' },
      id: 'EVT-SUB-CANCEL-QUEUE-FAIL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    errorSpy.mockRestore();
  });

  it('subscription suspension returns 500 when the bot fulfillment cannot be queued', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useWebhookRows({
      orders: {
        data: {
          id: 'order-suspended',
          order_number: 'ORD-SUSPENDED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
        },
        error: null,
      },
      products: { data: { name: 'Subscription' }, error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: { data: null, error: { message: 'queue insert failed' } },
    });

    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
      resource: { id: 'SUB-SUSPEND-QUEUE-FAIL' },
      id: 'EVT-SUB-SUSPEND-QUEUE-FAIL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    errorSpy.mockRestore();
  });

  function useResumedSubscriptionRows(input: {
    eventId: string;
    orderId: string;
    queueProbe: MockRowResult;
  }) {
    return useWebhookRows({
      webhook_events: [
        { data: [], error: null }, // upsert conflicts (row already exists)
        { data: { result: 'error', processed_at: new Date().toISOString() }, error: null },
        { data: { event_id: input.eventId }, error: null }, // claim
        { data: null, error: null },
      ],
      orders: [
        {
          // guild resolution lookup (list shape)
          data: [
            { guild_id: 'guild-1', status: 'completed', created_at: '2026-07-01T00:00:00.000Z' },
          ],
          error: null,
        },
        {
          // handler order lookup
          data: {
            id: input.orderId,
            order_number: `ORD-${input.orderId}`,
            guild_id: 'guild-1',
            customer_id: 'customer-1',
            product_id: 'product-1',
          },
          error: null,
        },
      ],
      products: { data: { name: 'Subscription' }, error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: [
        input.queueProbe, // retry dedupe probe
        { data: null, error: null }, // fulfillment insert
      ],
    });
  }

  it('errored BILLING.SUBSCRIPTION.CANCELLED is resumable — redelivery queues the fulfillment exactly once', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { inserts, updates } = useResumedSubscriptionRows({
        eventId: 'EVT-SUB-CANCEL-RETRY',
        orderId: 'order-cancel-retry',
        queueProbe: { data: [], error: null }, // failed attempt queued nothing
      });

      const req = makeSignedWebhook({
        event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
        resource: { id: 'SUB-CANCEL-RETRY' },
        id: 'EVT-SUB-CANCEL-RETRY',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      const fulfillmentInserts = inserts.filter(
        (i) =>
          i.table === 'bot_action_queue' &&
          (i.payload as { action?: string }).action === 'fulfill_cancellation',
      );
      expect(fulfillmentInserts).toHaveLength(1);
      expect(fulfillmentInserts[0]!.payload).toEqual(
        expect.objectContaining({
          guild_id: 'guild-1',
          action: 'fulfill_cancellation',
          payload: expect.objectContaining({
            fulfillment_type: 'subscription_cancelled',
            order_id: 'order-cancel-retry',
            discord_id: 'discord-1',
            webhook_event_id: 'EVT-SUB-CANCEL-RETRY',
          }),
          status: 'pending',
        }),
      );
      expect(updates).toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({ result: 'success' }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('resumed cancellation retry does not queue a duplicate fulfillment already queued by the failed attempt', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { inserts, updates } = useResumedSubscriptionRows({
        eventId: 'EVT-SUB-CANCEL-RETRY-DUP',
        orderId: 'order-cancel-retry-dup',
        queueProbe: { data: [{ id: 'queued-cancel-1' }], error: null },
      });

      const req = makeSignedWebhook({
        event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
        resource: { id: 'SUB-CANCEL-RETRY-DUP' },
        id: 'EVT-SUB-CANCEL-RETRY-DUP',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(inserts).not.toContainEqual(
        expect.objectContaining({
          table: 'bot_action_queue',
          payload: expect.objectContaining({ action: 'fulfill_cancellation' }),
        }),
      );
      expect(updates).toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({ result: 'success' }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('errored BILLING.SUBSCRIPTION.SUSPENDED is resumable — redelivery queues the suspension fulfillment', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { inserts } = useResumedSubscriptionRows({
        eventId: 'EVT-SUB-SUSPEND-RETRY',
        orderId: 'order-suspend-retry',
        queueProbe: { data: [], error: null },
      });

      const req = makeSignedWebhook({
        event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
        resource: { id: 'SUB-SUSPEND-RETRY' },
        id: 'EVT-SUB-SUSPEND-RETRY',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(inserts).toContainEqual({
        table: 'bot_action_queue',
        payload: expect.objectContaining({
          action: 'fulfill_suspension',
          payload: expect.objectContaining({
            fulfillment_type: 'subscription_suspended',
            order_id: 'order-suspend-retry',
            webhook_event_id: 'EVT-SUB-SUSPEND-RETRY',
          }),
        }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('errored BILLING.SUBSCRIPTION.PAYMENT.FAILED is resumable — redelivery queues the suspension fulfillment', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { inserts } = useResumedSubscriptionRows({
        eventId: 'EVT-SUB-PAYFAIL-RETRY',
        orderId: 'order-payfail-retry',
        queueProbe: { data: [], error: null },
      });

      const req = makeSignedWebhook({
        event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
        resource: { id: 'SUB-PAYFAIL-RETRY' },
        id: 'EVT-SUB-PAYFAIL-RETRY',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(inserts).toContainEqual({
        table: 'bot_action_queue',
        payload: expect.objectContaining({
          action: 'fulfill_suspension',
          payload: expect.objectContaining({
            fulfillment_type: 'subscription_suspended',
            order_id: 'order-payfail-retry',
            webhook_event_id: 'EVT-SUB-PAYFAIL-RETRY',
          }),
        }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
