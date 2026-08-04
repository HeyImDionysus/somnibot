/**
 * Finding 9 — chargebacks and declined captures must not be swallowed as
 * success.
 *
 * Before this change:
 *  - `CUSTOMER.DISPUTE.CREATED` fell to the route's `default:` branch, logged
 *    "Unhandled event", and then took the SUCCESS path — a chargeback was
 *    literally recorded as `webhook_events.result = 'success'`.
 *  - `orders.status` has allowed `'disputed'` since the initial schema and
 *    nothing ever set it.
 *  - `PAYMENT.CAPTURE.DENIED` was not in `PAYPAL_HANDLED_WEBHOOK_EVENTS`, so
 *    the webhook was never subscribed to it; a denied capture left the order
 *    `pending` forever with no alert.
 *
 * Settlement is intentionally NOT re-done here: PAYMENT.CAPTURE.REVERSED /
 * .REFUNDED already revoke access when money actually moves. This is about
 * awareness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { replaySecret } = vi.hoisted(() => {
  const secret = 'test-disputes-replay-secret';
  process.env.NEXTAUTH_SECRET = 'test-secret-disputes';
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
  getPayPalTokenResult: vi.fn().mockResolvedValue({ ok: true, token: 'test-token' }),
  getSubscriptionAmount: vi.fn(),
  isRetriablePayPalStatus: (s: number) => s >= 500 || s === 429 || s === 408,
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
}));
vi.mock('@/lib/paypal-policy', () => ({
  loadPayPalPolicy: vi.fn().mockResolvedValue({ environment: 'sandbox' }),
  applyPayPalPolicyEnvironment: (config: Record<string, unknown>, environment: string) => ({
    ...config,
    apiBase: environment === 'live' && config.sandbox !== true
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com',
    sandbox: environment !== 'live' || config.sandbox === true,
  }),
  paypalApiBaseForEnvironment: (environment: string) =>
    environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
}));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    paypalWebhook: vi.fn().mockResolvedValue({ limited: false, remaining: 1, retryAfterMs: 0 }),
  },
}));

import { POST } from '@/app/api/paypal/webhook/route';
import {
  handleDisputeEvent,
  handleCaptureDenied,
  resolveDisputeId,
  resolveDisputedTransactionIds,
  resolveStrictDisputedTransactionIds,
  executeProviderMoneyRecovery,
} from '@/app/api/paypal/webhook/handlers';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { loadPayPalPolicy } from '@/lib/paypal-policy';
import {
  PAYPAL_HANDLED_WEBHOOK_EVENT_TYPES,
  PAYPAL_INTENTIONALLY_EXCLUDED_WEBHOOK_EVENTS,
} from '@/lib/paypal-webhook-events';

const GUILD_ID = '111111111111111111';
const SECOND_GUILD_ID = '222222222222222222';
const CAPTURE_ID = 'CAPTURE-DISPUTED-1';
const ORDER_UUID = '00000000-0000-4000-8000-000000000001';
const REPLAY_CLAIM_TOKEN = '11111111-1111-4111-8111-111111111111';

// ── Recording Supabase double ───────────────────────────────────────────────

interface RecordedOp {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: Record<string, unknown>;
  filters: Array<{ method: string; args: unknown[] }>;
}

type Resolver = (op: RecordedOp) => { data: unknown; error: unknown };

let ops: RecordedOp[] = [];
let resolvers: Record<string, Resolver> = {};
let rpcResolvers: Record<
  string,
  (args: Record<string, unknown>) => { data: unknown; error: unknown }
> = {};

const CHAIN_METHODS = [
  'select', 'eq', 'is', 'in', 'neq', 'gt', 'lt', 'gte', 'lte',
  'or', 'not', 'order', 'limit', 'range', 'match', 'filter',
];

function makeSupabase() {
  const from = (table: string) => {
    const op: RecordedOp = { table, op: 'select', filters: [] };

    const resolve = () => {
      const resolver = resolvers[`${table}.${op.op}`] ?? resolvers[table];
      return resolver ? resolver(op) : { data: null, error: null };
    };

    const chain: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      chain[method] = (...args: unknown[]) => {
        if (method !== 'select') op.filters.push({ method, args });
        return chain;
      };
    }
    for (const method of ['insert', 'update', 'upsert'] as const) {
      chain[method] = (payload: Record<string, unknown>) => {
        op.op = method;
        op.payload = payload;
        return chain;
      };
    }
    chain.delete = () => { op.op = 'delete'; return chain; };

    const settle = () => { ops.push(op); return resolve(); };

    chain.maybeSingle = () => {
      const result = settle();
      const data = Array.isArray(result.data) ? result.data[0] ?? null : result.data;
      return Promise.resolve({ data, error: result.error });
    };
    chain.single = chain.maybeSingle;
    chain.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(settle()).then(onFulfilled ?? undefined, onRejected ?? undefined);

    return chain;
  };

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'webhooks_replay_claim_is_current') {
      return { data: true, error: null };
    }
    if (name === 'webhooks_finish_replay_claim') {
      return { data: true, error: null };
    }
    const resolver = rpcResolvers[name];
    return resolver ? resolver(args) : { data: null, error: null };
  });
  return { from: vi.fn(from), rpc };
}

function opsFor(table: string, op?: RecordedOp['op']) {
  return ops.filter((o) => o.table === table && (op ? o.op === op : true));
}

function filterArgs(op: RecordedOp, method: string) {
  return op.filters.filter((f) => f.method === method).map((f) => f.args);
}

let supabase: ReturnType<typeof makeSupabase>;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

// ── Fixtures ────────────────────────────────────────────────────────────────

function disputeResource(overrides: Record<string, unknown> = {}) {
  return {
    dispute_id: 'PP-D-27803',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    dispute_amount: { currency_code: 'USD', value: '9.99' },
    dispute_life_cycle_stage: 'CHARGEBACK',
    disputed_transactions: [{ seller_transaction_id: CAPTURE_ID }],
    ...overrides,
  };
}

function deniedCaptureResource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'CAPTURE-DENIED-1',
    status: 'DECLINED',
    amount: { currency_code: 'USD', value: '19.99' },
    custom_id: JSON.stringify({
      g: GUILD_ID,
      p: 'product-1',
      c: 'customer-1',
      d: '222222222222222222',
    }),
    supplementary_data: { related_ids: { order_id: 'PAYPAL-ORDER-1' } },
    ...overrides,
  };
}

function makeReplay(body: unknown) {
  return new Request('http://localhost/api/paypal/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-replay-secret': replaySecret,
      'x-replay-claim-token': REPLAY_CLAIM_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

/** Payments lookup resolves the disputed capture to a local order + guild. */
function withMatchedPayment() {
  resolvers['payments'] = () => ({ data: { guild_id: GUILD_ID }, error: null });
  rpcResolvers.commerce_apply_paypal_dispute = () => ({
    data: [{ order_id: ORDER_UUID, guild_id: GUILD_ID, marked_disputed: true }],
    error: null,
  });
}

function withDeniedOrder(
  guildId = GUILD_ID,
  orderCancelled = true,
  previousStatus = orderCancelled ? 'pending' : 'completed',
) {
  rpcResolvers.commerce_apply_capture_denied = () => ({
    data: [{
      order_id: ORDER_UUID,
      guild_id: guildId,
      previous_status: previousStatus,
      order_cancelled: orderCancelled,
    }],
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ops = [];
  rpcResolvers = {};
  resolvers = {
    'webhook_events.upsert': () => ({ data: [{ event_id: 'inserted' }], error: null }),
    'alerts.update': () => ({ data: [], error: null }),
  };
  supabase = makeSupabase();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);
  delete process.env.DISCORD_GUILD_ID;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

// ── Catalog wiring ──────────────────────────────────────────────────────────

describe('handled-event catalog', () => {
  it('subscribes to the dispute and denied-capture events', () => {
    for (const eventType of [
      'PAYMENT.CAPTURE.DENIED',
      'CUSTOMER.DISPUTE.CREATED',
      'CUSTOMER.DISPUTE.UPDATED',
      'CUSTOMER.DISPUTE.RESOLVED',
    ]) {
      expect(PAYPAL_HANDLED_WEBHOOK_EVENT_TYPES).toContain(eventType);
    }
    // Nothing is deliberately excluded, so nothing is silently dropped.
    expect(PAYPAL_INTENTIONALLY_EXCLUDED_WEBHOOK_EVENTS).toEqual([]);
  });
});

// ── Resource parsing ────────────────────────────────────────────────────────

describe('dispute resource parsing', () => {
  it('reads the dispute id from dispute_id, not id', () => {
    expect(resolveDisputeId(disputeResource())).toBe('PP-D-27803');
  });

  it('falls back to id when dispute_id is absent', () => {
    expect(resolveDisputeId({ id: 'PP-D-9' })).toBe('PP-D-9');
  });

  it('returns null for a dispute with no usable id', () => {
    expect(resolveDisputeId({})).toBeNull();
    expect(resolveDisputeId({ dispute_id: 123 })).toBeNull();
  });

  it('extracts seller_transaction_id from disputed_transactions', () => {
    expect(resolveDisputedTransactionIds(disputeResource())).toEqual([CAPTURE_ID]);
  });

  it('ignores malformed or non-canonical transaction entries', () => {
    const ids = resolveDisputedTransactionIds({
      disputed_transactions: [
        null,
        'nope',
        { seller_transaction_id: '' },
        { seller_transaction_id: 'has spaces' },
        { seller_transaction_id: CAPTURE_ID },
        { seller_transaction_id: CAPTURE_ID },
      ],
    });
    expect(ids).toEqual([CAPTURE_ID]);
  });

  it('returns nothing when disputed_transactions is missing', () => {
    expect(resolveDisputedTransactionIds({})).toEqual([]);
  });

  it('invalidates the full strict identity set when any entry is malformed', () => {
    expect(resolveStrictDisputedTransactionIds({
      disputed_transactions: [
        { seller_transaction_id: CAPTURE_ID },
        { seller_transaction_id: 'has spaces' },
      ],
    })).toEqual({ ids: [], valid: false });
  });
});

// ── Dispute handling ────────────────────────────────────────────────────────

describe('handleDisputeEvent', () => {
  it('marks the matched order disputed and alerts, without revoking access', async () => {
    withMatchedPayment();

    await handleDisputeEvent(supabase as never, disputeResource(), 'CUSTOMER.DISPUTE.CREATED');

    expect(supabase.rpc).toHaveBeenCalledWith('commerce_apply_paypal_dispute', {
      p_paypal_payment_ids: [CAPTURE_ID],
      p_mark_disputed: true,
    });
    expect(opsFor('orders', 'update')).toHaveLength(0);

    const alert = opsFor('alerts', 'insert')[0];
    expect(alert!.payload).toMatchObject({
      guild_id: GUILD_ID,
      alert_type: 'paypal_dispute',
      severity: 'critical',
    });

    // Settlement is NOT re-done here.
    expect(opsFor('entitlements')).toHaveLength(0);
    expect(opsFor('license_keys')).toHaveLength(0);
  });

  it('records the dispute amount as integer cents, never a float', async () => {
    withMatchedPayment();

    await handleDisputeEvent(
      supabase as never,
      disputeResource({ dispute_amount: { currency_code: 'USD', value: '192.35' } }),
      'CUSTOMER.DISPUTE.CREATED',
    );

    const metadata = (opsFor('alerts', 'insert')[0]!.payload as {
      metadata: Record<string, unknown>;
    }).metadata;
    expect(metadata.dispute_amount_cents).toBe(19235);
    expect(Number.isInteger(metadata.dispute_amount_cents)).toBe(true);
    expect(metadata.currency).toBe('USD');
  });

  it('does not flip order status for CUSTOMER.DISPUTE.RESOLVED', async () => {
    withMatchedPayment();

    await handleDisputeEvent(supabase as never, disputeResource(), 'CUSTOMER.DISPUTE.RESOLVED');

    expect(supabase.rpc).toHaveBeenCalledWith('commerce_apply_paypal_dispute', {
      p_paypal_payment_ids: [CAPTURE_ID],
      p_mark_disputed: false,
    });
    expect(opsFor('orders', 'update')).toHaveLength(0);
    // Resolved is informational, so it is a warning rather than critical.
    expect(opsFor('alerts', 'insert')[0]!.payload).toMatchObject({ severity: 'warning' });
  });

  it('still alerts when no local payment matches the disputed transaction', async () => {
    rpcResolvers.commerce_apply_paypal_dispute = () => ({ data: [], error: null });
    process.env.DISCORD_GUILD_ID = '333333333333333333';

    await handleDisputeEvent(supabase as never, disputeResource(), 'CUSTOMER.DISPUTE.CREATED');

    const alert = opsFor('alerts', 'insert')[0];
    expect(alert!.payload).toMatchObject({ guild_id: '333333333333333333' });
    expect((alert!.payload as { metadata: Record<string, unknown> }).metadata)
      .toMatchObject({ unmatched_transaction: true, order_ids: [] });
    expect(opsFor('orders', 'update')).toHaveLength(0);
  });

  it('refreshes the open alert in place across CREATED -> UPDATED', async () => {
    withMatchedPayment();
    resolvers['alerts.update'] = () => ({ data: [{ id: 'alert-1' }], error: null });

    await handleDisputeEvent(supabase as never, disputeResource(), 'CUSTOMER.DISPUTE.UPDATED');

    const alertUpdate = opsFor('alerts', 'update')[0]!;
    expect(filterArgs(alertUpdate, 'eq')).toContainEqual(['metadata->>dispute_id', 'PP-D-27803']);
    expect(opsFor('alerts', 'insert')).toHaveLength(0);
  });

  it('throws on a dispute with no usable id so the event is not silently lost', async () => {
    await expect(
      handleDisputeEvent(supabase as never, { disputed_transactions: [] }, 'CUSTOMER.DISPUTE.CREATED'),
    ).rejects.toThrow(/dispute id/i);
  });

  it('fails loudly if the payments lookup errors, rather than alerting a wrong guild', async () => {
    rpcResolvers.commerce_apply_paypal_dispute = () => ({
      data: null,
      error: { message: 'db down' },
    });

    await expect(
      handleDisputeEvent(supabase as never, disputeResource(), 'CUSTOMER.DISPUTE.CREATED'),
    ).rejects.toThrow(/apply PayPal dispute/i);
  });

  it('rejects a malformed transaction set before calling the mutation RPC', async () => {
    await expect(handleDisputeEvent(
      supabase as never,
      disputeResource({
        disputed_transactions: [
          { seller_transaction_id: CAPTURE_ID },
          { seller_transaction_id: 'has spaces' },
        ],
      }),
      'CUSTOMER.DISPUTE.CREATED',
    )).rejects.toThrow(/malformed transaction identity/i);

    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

// ── Denied captures ─────────────────────────────────────────────────────────

describe('handleCaptureDenied', () => {
  it('cancels the pending order and alerts', async () => {
    withDeniedOrder();

    await handleCaptureDenied(supabase as never, deniedCaptureResource());

    expect(supabase.rpc).toHaveBeenCalledWith('commerce_apply_capture_denied', {
      p_paypal_order_id: 'PAYPAL-ORDER-1',
      p_claimed_guild_id: GUILD_ID,
    });
    expect(opsFor('orders', 'update')).toHaveLength(0);

    const alert = opsFor('alerts', 'insert')[0]!;
    expect(alert.payload).toMatchObject({
      guild_id: GUILD_ID,
      alert_type: 'paypal_capture_denied',
      severity: 'warning',
    });
    expect((alert.payload as { metadata: Record<string, unknown> }).metadata)
      .toMatchObject({ amount_cents: 1999, order_cancelled: true });
  });

  it('never touches an order that is no longer pending', async () => {
    withDeniedOrder(GUILD_ID, false, 'completed');

    await handleCaptureDenied(supabase as never, deniedCaptureResource());

    expect(opsFor('orders', 'update')).toHaveLength(0);
    expect((opsFor('alerts', 'insert')[0]!.payload as { metadata: Record<string, unknown> }).metadata)
      .toMatchObject({ order_cancelled: false });
  });

  it('does not cancel or alert from valid foreign custom data without an exact local order', async () => {
    process.env.DISCORD_GUILD_ID = GUILD_ID;
    rpcResolvers.commerce_apply_capture_denied = () => ({ data: [], error: null });

    await handleCaptureDenied(supabase as never, deniedCaptureResource());

    expect(supabase.rpc).toHaveBeenCalledWith('commerce_apply_capture_denied', {
      p_paypal_order_id: 'PAYPAL-ORDER-1',
      p_claimed_guild_id: GUILD_ID,
    });
    expect(opsFor('orders', 'update')).toHaveLength(0);
    expect(opsFor('alerts')).toHaveLength(0);
  });

  it('cancels and alerts in the local order guild when custom_id is malformed', async () => {
    withDeniedOrder();

    await handleCaptureDenied(
      supabase as never,
      deniedCaptureResource({ custom_id: 'not-json' }),
    );

    expect(opsFor('orders', 'select')).toHaveLength(0);
    expect(opsFor('orders', 'update')).toHaveLength(0);
    expect(opsFor('alerts', 'insert')[0]!.payload).toMatchObject({
      guild_id: GUILD_ID,
    });
  });

  it('fails closed when custom_id claims a different guild than the local order', async () => {
    rpcResolvers.commerce_apply_capture_denied = () => ({
      data: null,
      error: { message: 'denied-capture metadata conflicts with the local tenant' },
    });

    await expect(
      handleCaptureDenied(supabase as never, deniedCaptureResource()),
    ).rejects.toThrow(/tenant|guild/i);

    expect(opsFor('orders', 'update')).toHaveLength(0);
  });

  it('throws when the capture has no usable provider id', async () => {
    await expect(
      handleCaptureDenied(supabase as never, { status: 'DECLINED' }),
    ).rejects.toThrow(/provider id/i);
  });
});

// ── End-to-end through the route ────────────────────────────────────────────

describe('route dispatch', () => {
  it('routes CUSTOMER.DISPUTE.CREATED to the dispute handler, not default:', async () => {
    withMatchedPayment();

    const res = await POST(makeReplay({
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      resource: disputeResource(),
      id: 'EVT-DISPUTE-ROUTED',
    }) as never);

    expect(res.status).toBe(200);
    expect(logSpy).not.toHaveBeenCalledWith(
      '[Webhook] Unhandled event: CUSTOMER.DISPUTE.CREATED',
    );
    expect(supabase.rpc).toHaveBeenCalledWith(
      'commerce_apply_paypal_dispute',
      expect.objectContaining({ p_mark_disputed: true }),
    );
    expect(opsFor('alerts', 'insert')).toHaveLength(1);
  });

  it('routes PAYMENT.CAPTURE.DENIED to the denied-capture handler', async () => {
    withDeniedOrder();

    const res = await POST(makeReplay({
      event_type: 'PAYMENT.CAPTURE.DENIED',
      resource: deniedCaptureResource(),
      id: 'EVT-DENIED-ROUTED',
    }) as never);

    expect(res.status).toBe(200);
    expect(logSpy).not.toHaveBeenCalledWith(
      '[Webhook] Unhandled event: PAYMENT.CAPTURE.DENIED',
    );
    expect(supabase.rpc).toHaveBeenCalledWith('commerce_apply_capture_denied', {
      p_paypal_order_id: 'PAYPAL-ORDER-1',
      p_claimed_guild_id: GUILD_ID,
    });
  });

  it('keeps an unmatched denied capture unattributed despite valid foreign custom data', async () => {
    process.env.DISCORD_GUILD_ID = GUILD_ID;
    resolvers['orders.select'] = () => ({ data: null, error: null });

    const req = new Request('http://localhost/api/paypal/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://example.com/cert',
        'paypal-transmission-id': 'EVT-DENIED-FOREIGN',
        'paypal-transmission-sig': 'sig-1',
        'paypal-transmission-time': new Date().toISOString(),
      },
      body: JSON.stringify({
        id: 'EVT-DENIED-FOREIGN',
        event_type: 'PAYMENT.CAPTURE.DENIED',
        resource: deniedCaptureResource(),
      }),
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    let res: Response;
    try {
      res = await POST(req as never);
    } finally {
      global.fetch = originalFetch;
    }

    expect(res.status).toBe(200);
    expect(opsFor('orders', 'update')).toHaveLength(0);
    expect(opsFor('alerts')).toHaveLength(0);
    // Route attribution performs the exact global order lookup; the handler
    // uses the exact-identity database transition RPC.
    expect(opsFor('orders', 'select')).toHaveLength(1);
    expect(opsFor('webhook_events', 'upsert')[0]!.payload)
      .not.toHaveProperty('guild_id');
  });

  it('attributes a dispute webhook row to the guild that owns the payment', async () => {
    withMatchedPayment();
    resolvers['payments.select'] = () => ({ data: { guild_id: GUILD_ID }, error: null });

    const req = new Request('http://localhost/api/paypal/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://example.com/cert',
        'paypal-transmission-id': 'EVT-DISPUTE-ATTRIBUTED',
        'paypal-transmission-sig': 'sig-1',
        'paypal-transmission-time': new Date().toISOString(),
      },
      body: JSON.stringify({
        id: 'EVT-DISPUTE-ATTRIBUTED',
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        resource: disputeResource(),
      }),
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      await POST(req as never);
    } finally {
      global.fetch = originalFetch;
    }

    expect(opsFor('webhook_events', 'upsert')[0]!.payload).toMatchObject({
      guild_id: GUILD_ID,
    });
  });

  it('keeps a partially matched multi-transaction dispute unattributed and fails it', async () => {
    const unmatchedCaptureId = 'CAPTURE-NOT-LOCAL';
    resolvers['payments.select'] = (op) => {
      const paymentId = filterArgs(op, 'eq')
        .find((args) => args[0] === 'paypal_payment_id')?.[1];
      return {
        data: paymentId === CAPTURE_ID ? { guild_id: GUILD_ID } : null,
        error: null,
      };
    };
    rpcResolvers.commerce_apply_paypal_dispute = () => ({
      data: null,
      error: { message: 'PayPal dispute identity set is incomplete' },
    });

    const req = new Request('http://localhost/api/paypal/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://example.com/cert',
        'paypal-transmission-id': 'EVT-DISPUTE-PARTIAL',
        'paypal-transmission-sig': 'sig-1',
        'paypal-transmission-time': new Date().toISOString(),
      },
      body: JSON.stringify({
        id: 'EVT-DISPUTE-PARTIAL',
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        resource: disputeResource({
          disputed_transactions: [
            { seller_transaction_id: CAPTURE_ID },
            { seller_transaction_id: unmatchedCaptureId },
          ],
        }),
      }),
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    let res: Response;
    try {
      res = await POST(req as never);
    } finally {
      global.fetch = originalFetch;
    }

    expect(res.status).toBe(500);
    expect(opsFor('webhook_events', 'upsert')[0]!.payload)
      .not.toHaveProperty('guild_id');
  });

  it('keeps a malformed full dispute identity set unattributed and rejects it', async () => {
    const req = new Request('http://localhost/api/paypal/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://example.com/cert',
        'paypal-transmission-id': 'EVT-DISPUTE-MALFORMED-SET',
        'paypal-transmission-sig': 'sig-1',
        'paypal-transmission-time': new Date().toISOString(),
      },
      body: JSON.stringify({
        id: 'EVT-DISPUTE-MALFORMED-SET',
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        resource: disputeResource({
          disputed_transactions: [
            { seller_transaction_id: CAPTURE_ID },
            { seller_transaction_id: 'CAPTURE HAS SPACES' },
          ],
        }),
      }),
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    let res: Response;
    try {
      res = await POST(req as never);
    } finally {
      global.fetch = originalFetch;
    }

    expect(res.status).toBe(500);
    expect(opsFor('payments', 'select')).toHaveLength(0);
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      'commerce_apply_paypal_dispute',
      expect.anything(),
    );
    expect(opsFor('webhook_events', 'upsert')[0]!.payload)
      .not.toHaveProperty('guild_id');
  });
});

describe('provider money recovery consumer', () => {
  const recoveryRow = (overrides: Record<string, unknown> = {}) => ({
    webhook_event_id: 'evt-recovery-1',
    provider_resource_id: 'CAPTURE-1',
    provider_parent_id: 'ORDER-1',
    guild_id: GUILD_ID,
    reason: 'provider_identity_malformed',
    attempts: 1,
    max_attempts: 5,
    lease_token: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  });

  function configureClaim(row: Record<string, unknown> | null) {
    rpcResolvers.commerce_claim_provider_money_recovery = () => ({
      data: row ? [row] : [],
      error: null,
    });
    resolvers['commerce_provider_money_recovery.update'] = () => ({
      data: row ? [{ webhook_event_id: row.webhook_event_id }] : [],
      error: null,
    });
  }

  it('claims once and refunds against the guild sandbox host', async () => {
    configureClaim(recoveryRow());
    vi.mocked(loadPayPalPolicy).mockResolvedValueOnce({ environment: 'sandbox' } as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeProviderMoneyRecovery(supabase as never, 'evt-recovery-1'))
      .resolves.toBe('refunded');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE-1/refund',
      expect.any(Object),
    );
  });

  it('isolates a live guild recovery from sandbox defaults', async () => {
    configureClaim(recoveryRow());
    vi.mocked(loadPayPalPolicy).mockResolvedValueOnce({ environment: 'live' } as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeProviderMoneyRecovery(supabase as never, 'evt-recovery-1'))
      .resolves.toBe('refunded');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-m.paypal.com/v2/payments/captures/CAPTURE-1/refund',
      expect.any(Object),
    );
  });

  it('returns retry after a provider failure and escalates at max attempts', async () => {
    configureClaim(recoveryRow({ attempts: 2, max_attempts: 5 }));
    vi.mocked(loadPayPalPolicy).mockResolvedValueOnce({ environment: 'sandbox' } as never);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    await expect(executeProviderMoneyRecovery(supabase as never, 'evt-recovery-1'))
      .resolves.toBe('retry');

    configureClaim(recoveryRow({ attempts: 5, max_attempts: 5 }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    await expect(executeProviderMoneyRecovery(supabase as never, 'evt-recovery-1'))
      .resolves.toBe('manual_review');
  });

  it('marks a malformed capture with no provider id for manual review without refunding', async () => {
    configureClaim(recoveryRow({ provider_resource_id: null }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(executeProviderMoneyRecovery(supabase as never, 'evt-recovery-1'))
      .resolves.toBe('manual_review');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not refund when a concurrent worker owns the lease', async () => {
    let calls = 0;
    rpcResolvers.commerce_claim_provider_money_recovery = () => ({
      data: calls++ === 0 ? [recoveryRow()] : [],
      error: null,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const results = await Promise.all([
      executeProviderMoneyRecovery(supabase as never, 'evt-recovery-1'),
      executeProviderMoneyRecovery(supabase as never, 'evt-recovery-1'),
    ]);
    expect(results).toContain('retry');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
