/**
 * Finding 2 — a failed capture must not be permanent, invisible, or unreplayable.
 *
 * `CHECKOUT.ORDER.APPROVED` is the ONLY thing that captures an approved order
 * (the integration uses intent: 'CAPTURE'). Before this change, a PayPal
 * 5xx/timeout on that capture:
 *   1. recorded webhook_events.result = 'error',
 *   2. was NOT resumable, so PayPal's redelivery got HTTP 200
 *      ('failed_requires_manual_replay') and PayPal stopped retrying,
 *   3. wrote guild_id = NULL, because the Order resource keeps custom_id on
 *      `purchase_units[]`, not at the resource root — making the row invisible
 *      to the dashboard's `.eq('guild_id', …)` filters, and
 *   4. told nobody.
 *
 * The buyer had already been redirected to a success page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-capture-failure';
  process.env.WEBHOOK_REPLAY_SECRET = 'test-capture-failure-replay-secret';
  process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
});

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    paypalWebhook: vi.fn().mockResolvedValue({ limited: false, remaining: 1, retryAfterMs: 0 }),
  },
}));

import { POST } from '@/app/api/paypal/webhook/route';
import { createAdminSupabase } from '@/lib/supabase/admin';

const originalEnv = { ...process.env };
const mockFetch = vi.fn();

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

  return { from: vi.fn(from), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

function opsFor(table: string, op?: RecordedOp['op']) {
  return ops.filter((o) => o.table === table && (op ? o.op === op : true));
}

// ── PayPal fetch scripting ──────────────────────────────────────────────────

const GUILD_ID = '111111111111111111';

const CHECKOUT_META = JSON.stringify({
  g: GUILD_ID,
  p: 'product-1',
  c: 'customer-1',
  d: '222222222222222222',
});

let captureResponse: (orderId: string) => Response;

function scriptPayPal() {
  mockFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok-1' }), { status: 200 });
    }
    if (target.includes('/v1/notifications/verify-webhook-signature')) {
      return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 });
    }
    if (target.includes('/capture')) {
      captureCalls.push({ url: target, init });
      const orderId = target.match(/\/orders\/([^/]+)\/capture$/)?.[1] ?? '';
      return captureResponse(orderId);
    }
    throw new Error(`Unexpected fetch call: ${target}`);
  });
}

let captureCalls: Array<{ url: string; init?: RequestInit }> = [];

function signedOrderApproved(
  eventId: string,
  resource: Record<string, unknown>,
) {
  return new Request('http://localhost/api/paypal/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://example.com/cert',
      'paypal-transmission-id': eventId,
      'paypal-transmission-sig': 'sig-1',
      'paypal-transmission-time': new Date().toISOString(),
    },
    body: JSON.stringify({
      id: eventId,
      event_type: 'CHECKOUT.ORDER.APPROVED',
      resource,
    }),
  });
}

/** A real PayPal Order resource: custom_id lives on the purchase unit. */
function orderResource(orderId = 'ORDER-1') {
  return {
    id: orderId,
    intent: 'CAPTURE',
    status: 'APPROVED',
    purchase_units: [
      { reference_id: 'default', custom_id: CHECKOUT_META, amount: { value: '9.99', currency_code: 'USD' } },
    ],
  };
}

const captureOk = (orderId: string) =>
  new Response(JSON.stringify({ id: orderId, status: 'COMPLETED' }), { status: 200 });
const captureOutage = () => new Response('upstream unavailable', { status: 503 });
const captureAlreadyDone = () =>
  new Response(
    JSON.stringify({
      name: 'UNPROCESSABLE_ENTITY',
      details: [{ issue: 'ORDER_ALREADY_CAPTURED', description: 'Order already captured.' }],
    }),
    { status: 422 },
  );

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  ops = [];
  captureCalls = [];
  captureResponse = captureOk;
  process.env = { ...originalEnv };
  // Fully env-sourced PayPal config so config load never reads Supabase.
  process.env.PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';
  process.env.PAYPAL_SANDBOX = 'true';
  process.env.PAYPAL_CLIENT_ID = 'test-client-id';
  process.env.PAYPAL_CLIENT_SECRET = '<<mock-client-secret>>';
  process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
  process.env.PAYPAL_WEBHOOK_URL = 'http://localhost/api/paypal/webhook';
  delete process.env.DISCORD_GUILD_ID;

  // Default: the event is new, and the alert has no existing row to refresh.
  resolvers = {
    'webhook_events.upsert': () => ({ data: [{ event_id: 'inserted' }], error: null }),
    'alerts.update': () => ({ data: [], error: null }),
    'orders.select': (op) => {
      const paypalOrderId = op.filters
        .find(({ method, args }) => method === 'eq' && args[0] === 'paypal_order_id')
        ?.args[1];
      return {
        data: typeof paypalOrderId === 'string'
          ? {
              id: `local-${paypalOrderId}`,
              guild_id: GUILD_ID,
              paypal_order_id: paypalOrderId,
              status: 'pending',
            }
          : null,
        error: null,
      };
    },
  };

  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabase());
  vi.stubGlobal('fetch', mockFetch);
  scriptPayPal();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  vi.unstubAllGlobals();
});

// ── 1. Guild attribution from purchase_units ────────────────────────────────

describe('CHECKOUT.ORDER.APPROVED guild attribution', () => {
  it('resolves custom_id from purchase_units[0] so the row is not orphaned', async () => {
    const res = await POST(signedOrderApproved('EVT-ATTRIBUTED', orderResource()) as never);

    expect(res.status).toBe(200);
    const upsert = opsFor('webhook_events', 'upsert')[0];
    expect(upsert).toBeDefined();
    expect(upsert!.payload).toMatchObject({
      event_id: 'EVT-ATTRIBUTED',
      event_type: 'CHECKOUT.ORDER.APPROVED',
      guild_id: GUILD_ID,
    });
  });

  it('leaves guild_id unset when purchase units disagree, rather than guessing', async () => {
    const resource = {
      id: 'ORDER-MIXED',
      purchase_units: [
        { custom_id: CHECKOUT_META },
        { custom_id: JSON.stringify({ g: '999999999999999999' }) },
      ],
    };

    await POST(signedOrderApproved('EVT-MIXED', resource) as never);

    const upsert = opsFor('webhook_events', 'upsert')[0];
    expect(upsert!.payload).not.toHaveProperty('guild_id');
  });

  it('leaves guild_id unset when untrusted root metadata contradicts the exact local order', async () => {
    const resource = {
      ...orderResource('ORDER-ROOT-MISMATCH'),
      custom_id: JSON.stringify({ g: '999999999999999999' }),
    };

    await POST(signedOrderApproved('EVT-ROOT-MISMATCH', resource) as never);

    expect(opsFor('webhook_events', 'upsert')[0]!.payload)
      .not.toHaveProperty('guild_id');
  });

  it('ignores malformed purchase units without throwing', async () => {
    const resource = {
      id: 'ORDER-JUNK',
      purchase_units: [null, 'nope', { custom_id: 'not-json' }, { custom_id: CHECKOUT_META }],
    };

    const res = await POST(signedOrderApproved('EVT-JUNK', resource) as never);

    expect(res.status).toBe(200);
    expect(opsFor('webhook_events', 'upsert')[0]!.payload).toMatchObject({ guild_id: GUILD_ID });
  });
});

// ── 2. The capture-fails path ───────────────────────────────────────────────

describe('capture failure is recorded and surfaced', () => {
  it('records result=error WITH the resolved guild and raises a critical alert', async () => {
    captureResponse = captureOutage;

    const res = await POST(signedOrderApproved('EVT-CAPTURE-FAIL', orderResource()) as never);

    expect(res.status).toBe(500);

    // The failure is attributed, so the dashboard can list and replay it.
    const errorUpdate = opsFor('webhook_events', 'update')
      .find((o) => (o.payload as { result?: string })?.result === 'error');
    expect(errorUpdate).toBeDefined();
    expect(errorUpdate!.payload).toMatchObject({ result: 'error', guild_id: GUILD_ID });

    // ...and the operator is told, instead of finding out by customer email.
    const alertInsert = opsFor('alerts', 'insert')[0];
    expect(alertInsert).toBeDefined();
    expect(alertInsert!.payload).toMatchObject({
      guild_id: GUILD_ID,
      alert_type: 'paypal_webhook_processing_error',
      severity: 'critical',
    });
    expect((alertInsert!.payload as { metadata: Record<string, unknown> }).metadata)
      .toMatchObject({
        event_id: 'EVT-CAPTURE-FAIL',
        event_type: 'CHECKOUT.ORDER.APPROVED',
        requires_manual_replay: false,
        unattributed_guild: false,
      });
  });

  it('refreshes an existing open alert in place instead of inserting a duplicate', async () => {
    captureResponse = captureOutage;
    resolvers['alerts.update'] = () => ({ data: [{ id: 'alert-1' }], error: null });

    await POST(signedOrderApproved('EVT-CAPTURE-FAIL-2', orderResource()) as never);

    expect(opsFor('alerts', 'update')).toHaveLength(1);
    expect(opsFor('alerts', 'insert')).toHaveLength(0);
  });

  it('files an unattributable failure under the instance primary guild', async () => {
    captureResponse = captureOutage;
    process.env.DISCORD_GUILD_ID = '333333333333333333';
    resolvers['orders.select'] = () => ({ data: null, error: null });

    // No custom_id anywhere — the guild is genuinely unknowable.
    await POST(signedOrderApproved('EVT-ORPHAN', { id: 'ORDER-ORPHAN' }) as never);

    const alertInsert = opsFor('alerts', 'insert')[0];
    expect(alertInsert!.payload).toMatchObject({ guild_id: '333333333333333333' });
    expect((alertInsert!.payload as { metadata: Record<string, unknown> }).metadata)
      .toMatchObject({ unattributed_guild: true });
  });

  it('marks the alert manual-replay-only for event types PayPal will not retry', async () => {
    // BILLING.SUBSCRIPTION.UPDATED is not in RESUMABLE_FAILED_EVENT_TYPES.
    resolvers['orders.select'] = () => ({
      data: [{ guild_id: GUILD_ID, status: 'completed', created_at: new Date().toISOString() }],
      error: null,
    });
    resolvers['webhook_events.upsert'] = () => ({ data: [], error: null });
    resolvers['webhook_events.select'] = () => ({
      data: { result: null, processed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      error: null,
    });

    const req = new Request('http://localhost/api/paypal/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://example.com/cert',
        'paypal-transmission-id': 'EVT-STALE',
        'paypal-transmission-sig': 'sig-1',
        'paypal-transmission-time': new Date().toISOString(),
      },
      body: JSON.stringify({
        id: 'EVT-STALE',
        event_type: 'BILLING.SUBSCRIPTION.UPDATED',
        resource: { id: 'SUB-1', custom_id: CHECKOUT_META },
      }),
    });

    const res = await POST(req as never);

    expect(await res.json()).toEqual({ status: 'stale_requires_manual_replay' });
    const alertInsert = opsFor('alerts', 'insert')[0];
    expect(alertInsert).toBeDefined();
    expect((alertInsert!.payload as { metadata: Record<string, unknown> }).metadata)
      .toMatchObject({ requires_manual_replay: true });
    // Non-money event type => warning, not critical.
    expect(alertInsert!.payload).toMatchObject({ severity: 'warning' });
  });
});

// ── 3. PayPal's own retries can now recover ─────────────────────────────────

describe('CHECKOUT.ORDER.APPROVED is resumable', () => {
  it('claims and reprocesses a previously-failed event on redelivery', async () => {
    // PayPal redelivers; the row already exists with result = 'error'.
    resolvers['webhook_events.upsert'] = () => ({ data: [], error: null });
    resolvers['webhook_events.select'] = () => ({ data: { result: 'error' }, error: null });
    resolvers['webhook_events.update'] = () => ({ data: { event_id: 'EVT-RETRY' }, error: null });

    const res = await POST(signedOrderApproved('EVT-RETRY', orderResource()) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    // It actually retried the capture rather than giving up.
    expect(captureCalls).toHaveLength(1);
  });

  it('does NOT return failed_requires_manual_replay for an approved-order retry', async () => {
    resolvers['webhook_events.upsert'] = () => ({ data: [], error: null });
    resolvers['webhook_events.select'] = () => ({ data: { result: 'error' }, error: null });
    resolvers['webhook_events.update'] = () => ({ data: { event_id: 'EVT-RETRY-2' }, error: null });

    const res = await POST(signedOrderApproved('EVT-RETRY-2', orderResource()) as never);

    expect(await res.json()).not.toMatchObject({ status: 'failed_requires_manual_replay' });
  });
});

// ── 4. The retry cannot double-charge ───────────────────────────────────────

describe('capture retries are idempotent at PayPal', () => {
  it('sends a PayPal-Request-Id keyed on the order id', async () => {
    await POST(signedOrderApproved('EVT-IDEMPOTENT', orderResource('ORDER-IDEM')) as never);

    expect(captureCalls).toHaveLength(1);
    const headers = captureCalls[0]!.init?.headers as Record<string, string>;
    expect(headers['PayPal-Request-Id']).toBe('capture-ORDER-IDEM');
  });

  it('treats ORDER_ALREADY_CAPTURED as success, not a permanent failure', async () => {
    captureResponse = captureAlreadyDone;

    const res = await POST(signedOrderApproved('EVT-ALREADY', orderResource()) as never);

    expect(res.status).toBe(200);
    const successUpdate = opsFor('webhook_events', 'update')
      .find((o) => (o.payload as { result?: string })?.result === 'success');
    expect(successUpdate).toBeDefined();
    expect(opsFor('alerts', 'insert')).toHaveLength(0);
  });

  it('still fails loudly on a genuine capture rejection', async () => {
    captureResponse = () =>
      new Response(
        JSON.stringify({ details: [{ issue: 'INSTRUMENT_DECLINED' }] }),
        { status: 422 },
      );

    const res = await POST(signedOrderApproved('EVT-DECLINED', orderResource()) as never);

    expect(res.status).toBe(500);
    expect(opsFor('alerts', 'insert')).toHaveLength(1);
  });

  it('returns 500 and records an error when the success marker cannot be persisted', async () => {
    resolvers['webhook_events.update'] = (op) =>
      op.payload?.result === 'success'
        ? { data: null, error: { message: 'completion marker unavailable' } }
        : { data: null, error: null };

    const res = await POST(signedOrderApproved('EVT-MARKER-FAIL', orderResource()) as never);

    expect(res.status).toBe(500);
    expect(opsFor('webhook_events', 'update').map((op) => op.payload?.result))
      .toEqual(['success', 'error']);
    expect(opsFor('alerts', 'insert')[0]!.payload).toMatchObject({
      guild_id: GUILD_ID,
      alert_type: 'paypal_webhook_processing_error',
      severity: 'critical',
    });
  });
});
