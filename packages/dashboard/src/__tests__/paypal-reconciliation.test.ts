/**
 * Finding 1 — nothing ever compared PayPal's records to ours.
 *
 * The bot's `reconciliation.ts` reconciles entitlements against Discord roles,
 * grace expiry, and stale license sessions; the string "paypal" does not
 * appear in it. `POST /api/reconciliation` does not reconcile either — it
 * enqueues a `bot_action_queue` row, so if the bot is the broken thing the
 * button does nothing. A payment that succeeded at PayPal but never landed in
 * `payments` was therefore invisible until a customer emailed.
 *
 * These cover the diff itself (both directions), the money handling (integer
 * cents, never a float), the settlement-lag window that keeps the diff from
 * crying wolf, the cross-process lease, and the route that makes the pass
 * runnable without the bot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-reconcile';
  process.env.WEBHOOK_REPLAY_SECRET = 'test-reconcile-replay-secret';
});

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));

import {
  runPayPalReconciliation,
  acquireReconcileLease,
  heartbeatReconcileLease,
  finalizeReconcileLease,
  parseAmountToCents,
  fetchProviderCapture,
  fetchProviderRefund,
  fetchProviderOrder,
  fetchProviderSubscription,
  RECONCILE_ALERT_TYPE,
  RECONCILE_FAILURE_ALERT_TYPE,
  RECONCILE_LAST_RESULT_KEY,
  LOCAL_SCAN_MAX_ROWS,
  recordScheduledReconciliationFailure,
} from '@/lib/paypal-reconciliation';
import { POST, GET } from '@/app/api/paypal/reconcile/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';

const GUILD_ID = '111111111111111111';
const SECOND_GUILD_ID = '222222222222222222';
const ORDER_UUID = '00000000-0000-4000-8000-000000000001';
const PRODUCT_UUID = '10000000-0000-4000-8000-000000000001';
const CUSTOMER_UUID = '20000000-0000-4000-8000-000000000001';
const SECOND_CUSTOMER_UUID = '20000000-0000-4000-8000-000000000002';
const DISCORD_ID = '333333333333333333';

// ── Recording Supabase double ───────────────────────────────────────────────

interface RecordedOp {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: Record<string, unknown>;
  filters: Array<{ method: string; args: unknown[] }>;
}

type Resolver = (op: RecordedOp) => { data: unknown; error: unknown };
type RpcResolver = (
  args: Record<string, unknown>,
) => { data: unknown; error: unknown };

let ops: RecordedOp[] = [];
let resolvers: Record<string, Resolver> = {};
let rpcOps: Array<{ functionName: string; args: Record<string, unknown> }> = [];
let rpcResolvers: Record<string, RpcResolver> = {};

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

  const rpc = vi.fn(async (
    functionName: string,
    args: Record<string, unknown>,
  ) => {
    rpcOps.push({ functionName, args });
    const resolver = rpcResolvers[functionName];
    if (resolver) return resolver(args);
    if (functionName === 'paypal_reconcile_acquire') {
      return { data: 'acquired', error: null };
    }
    if (
      functionName === 'paypal_reconcile_heartbeat'
      || functionName === 'paypal_reconcile_finalize'
    ) {
      return { data: true, error: null };
    }
    return { data: null, error: null };
  });

  return { from: vi.fn(from), rpc };
}

function opsFor(table: string, op?: RecordedOp['op']) {
  return ops.filter((o) => o.table === table && (op ? o.op === op : true));
}

function filterArgs(op: RecordedOp, method: string) {
  return op.filters.filter((f) => f.method === method).map((f) => f.args);
}

// ── PayPal fetch scripting ──────────────────────────────────────────────────
//
// SomniBot does PayPal per-object: reconciliation asks the commerce API about
// exactly the order/capture/refund/subscription ids the local ledger stored.
// The router below serves those objects from per-test registries; an id with
// no entry 404s like the live API.

const mockFetch = vi.fn();
let providerCalls: string[] = [];

const IDENTITY_CUSTOM_FIELD = JSON.stringify({
  g: GUILD_ID,
  p: PRODUCT_UUID,
  c: CUSTOMER_UUID,
  d: DISCORD_ID,
});

interface ProviderRegistry {
  captures?: Record<string, unknown>;
  refunds?: Record<string, unknown>;
  orders?: Record<string, unknown>;
  subscriptions?: Record<string, unknown>;
  sales?: Record<string, unknown>;
  saleRefunds?: Record<string, unknown>;
  /** Per-subscription transaction lists; live subscriptions default to []. */
  subscriptionTransactions?: Record<string, unknown>;
  tokenStatus?: number;
}

function scriptProviderObjects(objects: ProviderRegistry = {}) {
  mockFetch.mockImplementation(async (url: unknown) => {
    const target = String(url);
    providerCalls.push(target);
    if (target.includes('/v1/oauth2/token')) {
      if (objects.tokenStatus && objects.tokenStatus !== 200) {
        return new Response('{}', { status: objects.tokenStatus });
      }
      return new Response(JSON.stringify({ access_token: 'tok-1' }), { status: 200 });
    }
    const txnMatch = target.match(/\/v1\/billing\/subscriptions\/([^/?]+)\/transactions(?:\?|$)/);
    if (txnMatch) {
      const id = decodeURIComponent(txnMatch[1]!);
      // An EXPLICIT registry (even empty) opts out of the live-subscription
      // default, so 404 behavior is testable.
      const body = objects.subscriptionTransactions !== undefined
        ? objects.subscriptionTransactions[id]
        : (objects.subscriptions?.[id] !== undefined ? { transactions: [] } : undefined);
      if (body === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }
    // Settled orders are always fetched now: when a fixture scripts
    // captures but no orders registry, serve the canonical order with the
    // scripted captures mirrored so single-capture fixtures stay valid.
    const autoOrderMatch = target.match(/\/v2\/checkout\/orders\/([^/?]+)$/);
    if (autoOrderMatch && objects.orders === undefined) {
      const requestedOrderId = decodeURIComponent(autoOrderMatch[1]!);
      const captureEntries = Object.entries(objects.captures ?? {});
      if (requestedOrderId === 'PP-ORDER-1' && captureEntries.length > 0) {
        return new Response(JSON.stringify({
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: captureEntries.map(([captureId, capture]) => ({
                id: captureId,
                status: (capture as Record<string, unknown>).status,
                amount: (capture as Record<string, unknown>).amount,
              })),
            },
          }],
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }
    const routes: Array<[RegExp, Record<string, unknown> | undefined]> = [
      [/\/v2\/payments\/captures\/([^/?]+)$/, objects.captures],
      [/\/v2\/payments\/refunds\/([^/?]+)$/, objects.refunds],
      [/\/v2\/checkout\/orders\/([^/?]+)$/, objects.orders],
      [/\/v1\/billing\/subscriptions\/([^/?]+)$/, objects.subscriptions],
      [/\/v1\/payments\/sale\/([^/?]+)$/, objects.sales],
      [/\/v1\/payments\/refund\/([^/?]+)$/, objects.saleRefunds],
    ];
    for (const [pattern, registry] of routes) {
      const match = target.match(pattern);
      if (!match) continue;
      const id = decodeURIComponent(match[1]!);
      const body = registry?.[id];
      if (body === undefined) return new Response('{}', { status: 404 });
      const record = body as Record<string, unknown>;
      if (typeof record.__status === 'number') {
        return new Response(String(record.__body ?? '{}'), {
          status: record.__status as number,
        });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });
}

function captureObject(spec: {
  status?: string;
  value?: string;
  currency?: string;
  relatedOrderId?: string | null;
} = {}) {
  const related = spec.relatedOrderId === null
    ? null
    : spec.relatedOrderId ?? 'PP-ORDER-1';
  return {
    status: spec.status ?? 'COMPLETED',
    amount: { currency_code: spec.currency ?? 'USD', value: spec.value ?? '25.00' },
    ...(related === null
      ? {}
      : { supplementary_data: { related_ids: { order_id: related } } }),
  };
}

function refundObject(spec: {
  status?: string;
  value?: string;
  currency?: string;
  parentCaptureId?: string | null;
} = {}) {
  const parent = spec.parentCaptureId === null ? null : spec.parentCaptureId ?? 'CAP-1';
  return {
    status: spec.status ?? 'COMPLETED',
    amount: { currency_code: spec.currency ?? 'USD', value: spec.value ?? '25.00' },
    ...(parent === null
      ? {}
      : {
          links: [{
            rel: 'up',
            href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${parent}`,
          }],
        }),
  };
}

function orderObject(spec: {
  status?: string;
  customId?: string | null;
  captures?: Array<{ id: string; status?: string; value?: string; currency?: string }>;
} = {}) {
  return {
    status: spec.status ?? 'COMPLETED',
    purchase_units: [{
      ...(spec.customId === null ? {} : { custom_id: spec.customId ?? IDENTITY_CUSTOM_FIELD }),
      payments: {
        captures: (spec.captures ?? []).map((capture) => ({
          id: capture.id,
          status: capture.status ?? 'COMPLETED',
          amount: {
            currency_code: capture.currency ?? 'USD',
            value: capture.value ?? '25.00',
          },
        })),
      },
    }],
  };
}

function subscriptionObject(spec: {
  status?: string;
  lastPaymentTime?: string | null;
  lastPaymentValue?: string;
  lastPaymentCurrency?: string;
  customId?: string;
  planId?: string;
} = {}) {
  return {
    status: spec.status ?? 'ACTIVE',
    ...(spec.customId ? { custom_id: spec.customId } : {}),
    ...(spec.planId ? { plan_id: spec.planId } : {}),
    billing_info: spec.lastPaymentTime === null
      ? {}
      : {
          last_payment: {
            time: spec.lastPaymentTime ?? '2026-07-20T10:00:00Z',
            amount: {
              currency_code: spec.lastPaymentCurrency ?? 'USD',
              value: spec.lastPaymentValue ?? '25.00',
            },
          },
        },
  };
}

function saleObject(spec: {
  state?: string;
  total?: string;
  currency?: string;
  billingAgreementId?: string | null;
} = {}) {
  return {
    state: spec.state ?? 'completed',
    amount: { currency: spec.currency ?? 'USD', total: spec.total ?? '25.00' },
    ...(spec.billingAgreementId === null
      ? {}
      : { billing_agreement_id: spec.billingAgreementId ?? 'SUB-1' }),
  };
}

const originalEnv = { ...process.env };
let supabase: ReturnType<typeof makeSupabase>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.resetAllMocks();
  ops = [];
  rpcOps = [];
  providerCalls = [];
  resolvers = {};
  rpcResolvers = {};
  process.env = { ...originalEnv };
  // Fully env-sourced PayPal config so config load never reads Supabase.
  process.env.PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';
  process.env.PAYPAL_SANDBOX = 'true';
  process.env.PAYPAL_CLIENT_ID = 'test-client-id';
  process.env.PAYPAL_CLIENT_SECRET = '<<mock-client-secret>>';
  process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
  process.env.PAYPAL_WEBHOOK_URL = 'http://localhost/api/paypal/webhook';
  process.env.DISCORD_GUILD_ID = GUILD_ID;
  delete process.env.PAYPAL_RECONCILE_SECRET;

  supabase = makeSupabase();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);
  (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: '123456789012345678', guildId: GUILD_ID },
  });
  vi.stubGlobal('fetch', mockFetch);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  logSpy.mockRestore();
  errorSpy.mockRestore();
  vi.unstubAllGlobals();
});

/** Local ledger contents for a pass. */
function withLedger(opts: {
  payments?: Array<Record<string, unknown>>;
  refunds?: Array<Record<string, unknown>>;
  orders?: Array<Record<string, unknown>>;
  customers?: Array<Record<string, unknown>>;
  guildIds?: string[];
  inferOrders?: boolean;
}) {
  const payments: Array<Record<string, unknown>> = (opts.payments ?? []).map((payment) => ({
    provider: 'paypal',
    ...payment,
  }));
  const refunds = opts.refunds ?? [];
  const explicitOrders: Array<Record<string, unknown>> = (opts.orders ?? []).map((order) => ({
    order_number: null,
    status: 'completed',
    source: 'purchase',
    currency: 'USD',
    customer_id: CUSTOMER_UUID,
    product_id: PRODUCT_UUID,
    plan_id: null,
    paypal_order_id: 'PP-ORDER-1',
    paypal_subscription_id: null,
    ...order,
  }));
  const explicitIds = new Set(explicitOrders.map((order) => order.id));
  const inferredOrders: Array<Record<string, unknown>> = opts.inferOrders === false
    ? []
    : payments
      .filter((payment) =>
        typeof payment.order_id === 'string'
        && !explicitIds.has(payment.order_id),
      )
      .map((payment) => ({
        id: payment.order_id as string,
        order_number: null,
        guild_id: payment.guild_id,
        customer_id: CUSTOMER_UUID,
        product_id: PRODUCT_UUID,
        plan_id: null,
        amount_cents: payment.amount_cents,
        currency: payment.currency ?? 'USD',
        status: 'completed',
        source: 'purchase',
        paypal_order_id: 'PP-ORDER-1',
        paypal_subscription_id: null,
        created_at: payment.created_at,
      }));
  const orders: Array<Record<string, unknown>> = [...explicitOrders, ...inferredOrders];
  const customers: Array<Record<string, unknown>> = opts.customers ?? orders
    .filter((order) =>
      typeof order.customer_id === 'string'
      && typeof order.guild_id === 'string',
    )
    .map((order) => ({
      id: order.customer_id as string,
      guild_id: order.guild_id as string,
      discord_id: order.customer_discord_id ?? DISCORD_ID,
    }));
  const page = (rows: Array<Record<string, unknown>>, op: RecordedOp) => {
    const range = filterArgs(op, 'range').at(-1);
    if (!range) return rows;
    const [from, to] = range as [number, number];
    return rows.slice(from, to + 1);
  };
  resolvers['payments'] = (op) => {
    // The window scan and the refund-lookback scan carry created_at bounds;
    // exact-id lookups carry none. Honor both so lookback fixtures work.
    const gte = filterArgs(op, 'gte').find((args) => args[0] === 'created_at')?.[1] as
      string | undefined;
    const lte = filterArgs(op, 'lte').find((args) => args[0] === 'created_at')?.[1] as
      string | undefined;
    const bounded = payments.filter((payment) => {
      const created = String(payment.created_at ?? '');
      return (!gte || created >= gte) && (!lte || created <= lte);
    });
    return { data: page(bounded, op), error: null };
  };
  resolvers['payment_refunds'] = (op) => {
    const byProviderId = filterArgs(op, 'in')
      .find((args) => args[0] === 'paypal_refund_id')?.[1] as string[] | undefined;
    const byPaymentId = filterArgs(op, 'in')
      .find((args) => args[0] === 'payment_id')?.[1] as string[] | undefined;
    const selected = byProviderId
      ? refunds.filter((refund) => byProviderId.includes(String(refund.paypal_refund_id)))
      : byPaymentId
        ? refunds.filter((refund) => byPaymentId.includes(String(refund.payment_id)))
        : refunds;
    return { data: page(selected, op), error: null };
  };
  resolvers['orders'] = (op) => {
    // The window scan and the historical cancelled scan carry created_at
    // bounds; exact-id lookups and the subscription sweep carry none.
    const gte = filterArgs(op, 'gte').find((args) => args[0] === 'created_at')?.[1] as
      string | undefined;
    const lte = filterArgs(op, 'lte').find((args) => args[0] === 'created_at')?.[1] as
      string | undefined;
    const lt = filterArgs(op, 'lt').find((args) => args[0] === 'created_at')?.[1] as
      string | undefined;
    const bounded = orders.filter((order) => {
      const created = String(order.created_at ?? '');
      return (!gte || created >= gte) && (!lte || created <= lte) && (!lt || created < lt);
    });
    return { data: page(bounded, op), error: null };
  };
  resolvers['customers'] = (op) => ({ data: page(customers, op), error: null });
  const derivedGuilds = new Set(
    opts.guildIds
      ?? [...payments, ...orders]
        .map((row) => row.guild_id)
        .filter((id): id is string => typeof id === 'string'),
  );
  if (derivedGuilds.size === 0) derivedGuilds.add(GUILD_ID);
  const guilds = [...derivedGuilds].map((id) => ({ id }));
  resolvers['guild'] = (op) => ({ data: page(guilds, op), error: null });
  resolvers['alerts.update'] = () => ({ data: [], error: null });
}

// ── Money ───────────────────────────────────────────────────────────────────

describe('parseAmountToCents', () => {
  it('converts decimals to exact integer cents', () => {
    expect(parseAmountToCents('9.99')).toBe(999);
    expect(parseAmountToCents('0.01')).toBe(1);
    expect(parseAmountToCents('192.35')).toBe(19235);
    expect(parseAmountToCents('100')).toBe(10000);
    expect(parseAmountToCents('10.1')).toBe(1010);
  });

  it('is exact where float arithmetic is not', () => {
    // 1.15 * 100 === 114.99999999999999 in IEEE-754.
    expect(parseAmountToCents('1.15')).toBe(115);
    expect(parseAmountToCents('4.35')).toBe(435);
    expect(Number.isInteger(parseAmountToCents('1.15'))).toBe(true);
  });

  it('handles negative amounts (fees, payouts, reversals)', () => {
    expect(parseAmountToCents('-2.50')).toBe(-250);
  });

  it('rejects anything that is not a canonical PayPal decimal', () => {
    for (const bad of ['', 'abc', '1.234', '1,50', '01.5', ' 1.5', null, 12, '1e3']) {
      expect(parseAmountToCents(bad)).toBeNull();
    }
  });
});

// ── Provider fetch ──────────────────────────────────────────────────────────

describe('per-object provider fetchers', () => {
  const BASE = 'https://api-m.sandbox.paypal.com';

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    providerCalls = [];
  });

  it('parses a capture and requires status, amount, and currency', async () => {
    scriptProviderObjects({ captures: { 'CAP-1': captureObject({ value: '19.99' }) } });
    const result = await fetchProviderCapture(BASE, 'tok', 'CAP-1');
    expect(result).toEqual({
      ok: true,
      found: true,
      value: {
        status: 'COMPLETED',
        amountCents: 1999,
        currency: 'USD',
        relatedOrderId: 'PP-ORDER-1',
        updateTimeMs: null,
      },
    });
  });

  it('reports a missing capture as found:false, not an error', async () => {
    scriptProviderObjects({ captures: {} });
    await expect(fetchProviderCapture(BASE, 'tok', 'CAP-GONE')).resolves.toEqual({
      ok: true,
      found: false,
    });
  });

  it.each([
    ['missing status', { amount: { currency_code: 'USD', value: '1.00' } }],
    ['non-string status', { status: 5, amount: { currency_code: 'USD', value: '1.00' } }],
    ['missing amount', { status: 'COMPLETED' }],
    ['non-canonical money', { status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.999' } }],
    ['invalid currency', { status: 'COMPLETED', amount: { currency_code: 'usd!', value: '1.00' } }],
  ])('fails closed on a capture with %s', async (_label, body) => {
    scriptProviderObjects({ captures: { 'CAP-1': body } });
    const result = await fetchProviderCapture(BASE, 'tok', 'CAP-1');
    expect(result).toEqual({
      ok: false,
      retriable: false,
      reason: 'capture lookup returned a malformed record',
    });
  });

  it.each([
    [500, true],
    [429, true],
    [403, false],
  ])('maps capture HTTP %s to retriable=%s', async (status, retriable) => {
    scriptProviderObjects({ captures: { 'CAP-1': { __status: status } } });
    const result = await fetchProviderCapture(BASE, 'tok', 'CAP-1');
    expect(result).toEqual({
      ok: false,
      retriable,
      reason: `capture lookup returned ${status}`,
    });
  });

  it('reports malformed capture JSON as retriable', async () => {
    scriptProviderObjects({ captures: { 'CAP-1': { __status: 200, __body: '{nope' } } });
    const result = await fetchProviderCapture(BASE, 'tok', 'CAP-1');
    expect(result).toEqual({
      ok: false,
      retriable: true,
      reason: 'capture lookup returned malformed JSON',
    });
  });

  it('reports a network fault as retriable', async () => {
    mockFetch.mockImplementation(async () => {
      throw new Error('socket hang up');
    });
    const result = await fetchProviderCapture(BASE, 'tok', 'CAP-1');
    expect(result).toEqual({
      ok: false,
      retriable: true,
      reason: 'capture lookup request failed: socket hang up',
    });
  });

  it('parses a refund with the same strictness', async () => {
    scriptProviderObjects({ refunds: { 'REF-1': refundObject({ value: '5.50' }) } });
    await expect(fetchProviderRefund(BASE, 'tok', 'REF-1')).resolves.toEqual({
      ok: true,
      found: true,
      value: { status: 'COMPLETED', amountCents: 550, currency: 'USD', parentCaptureId: 'CAP-1' },
    });
    scriptProviderObjects({ refunds: { 'REF-1': { status: 'COMPLETED' } } });
    await expect(fetchProviderRefund(BASE, 'tok', 'REF-1')).resolves.toEqual({
      ok: false,
      retriable: false,
      reason: 'refund lookup returned a malformed record',
    });
  });

  it('parses an order: status, custom_id, settled captures, and refunds', async () => {
    scriptProviderObjects({
      orders: {
        'ORD-1': orderObject({
          status: 'COMPLETED',
          captures: [{ id: 'CAP-A', value: '25.00' }],
        }),
      },
    });
    const result = await fetchProviderOrder(BASE, 'tok', 'ORD-1');
    expect(result).toEqual({
      ok: true,
      found: true,
      value: {
        status: 'COMPLETED',
        customId: IDENTITY_CUSTOM_FIELD,
        subscriptionId: null,
        captures: [{ id: 'CAP-A', status: 'COMPLETED', amountCents: 2500, currency: 'USD', createTimeMs: null }],
        refunds: [],
        updateTimeMs: null,
      },
    });
  });

  it('fails closed on an order capture without an id or amount', async () => {
    scriptProviderObjects({
      orders: {
        'ORD-1': {
          status: 'COMPLETED',
          purchase_units: [{ payments: { captures: [{ status: 'COMPLETED' }] } }],
        },
      },
    });
    await expect(fetchProviderOrder(BASE, 'tok', 'ORD-1')).resolves.toEqual({
      ok: false,
      retriable: false,
      reason: 'order lookup returned a malformed record',
    });
  });

  it('parses a subscription, tolerating absent billing info', async () => {
    scriptProviderObjects({
      subscriptions: { 'SUB-1': subscriptionObject({ lastPaymentValue: '9.99' }) },
    });
    await expect(fetchProviderSubscription(BASE, 'tok', 'SUB-1')).resolves.toEqual({
      ok: true,
      found: true,
      value: {
        status: 'ACTIVE',
        customId: null,
        planId: null,
        statusUpdateTimeMs: null,
        lastPaymentTime: '2026-07-20T10:00:00Z',
        lastPaymentAmountCents: 999,
        lastPaymentCurrency: 'USD',
      },
    });
    scriptProviderObjects({
      subscriptions: { 'SUB-1': subscriptionObject({ lastPaymentTime: null }) },
    });
    await expect(fetchProviderSubscription(BASE, 'tok', 'SUB-1')).resolves.toEqual({
      ok: true,
      found: true,
      value: {
        status: 'ACTIVE',
        customId: null,
        planId: null,
        statusUpdateTimeMs: null,
        lastPaymentTime: null,
        lastPaymentAmountCents: null,
        lastPaymentCurrency: null,
      },
    });
  });
});

describe('runPayPalReconciliation', () => {
  const NOW = Date.parse('2026-07-27T12:00:00.000Z');
  const IN_WINDOW = '2026-07-24T10:00:00.000Z';
  const OPTS = { now: NOW, settlementLagMs: 0 } as const;
  const PAY_UUID = '30000000-0000-4000-8000-000000000001';
  const PAY2_UUID = '30000000-0000-4000-8000-000000000002';
  const REF_UUID = '40000000-0000-4000-8000-000000000001';
  const REF2_UUID = '40000000-0000-4000-8000-000000000002';

  function paymentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: PAY_UUID,
      order_id: ORDER_UUID,
      guild_id: GUILD_ID,
      paypal_payment_id: 'CAP-1',
      amount_cents: 2500,
      currency: 'USD',
      status: 'completed',
      created_at: IN_WINDOW,
      ...overrides,
    };
  }

  function completedResult(result: Awaited<ReturnType<typeof runPayPalReconciliation>>) {
    if (result.status !== 'completed') {
      throw new Error(`expected completed, got ${JSON.stringify(result)}`);
    }
    return result;
  }

  it('verifies a settled payment per-object and never touches the reporting API', async () => {
    withLedger({ payments: [paymentRow()] });
    scriptProviderObjects({ captures: { 'CAP-1': captureObject({ value: '25.00' }) } });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([]);
    expect(result.missingProviderPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([]);
    expect(result.unsettledLocalPayments).toEqual([]);
    expect(result.providerTransactions).toBe(2);
    expect(result.localPayments).toBe(1);
    // The white-label model: only per-object commerce GETs, which any bare
    // REST app may call. The reporting product (Transaction Search) that
    // 403'd for wizard-onboarded operators must never be requested again.
    expect(providerCalls.some((url) => url.includes('/v1/reporting/'))).toBe(false);
    expect(providerCalls.some((url) => url.includes('/v2/payments/captures/CAP-1'))).toBe(true);
    // Clean pass resolves any standing mismatch alert and records the result.
    expect(opsFor('alerts', 'update').length).toBeGreaterThan(0);
    const upserts = opsFor('instance_settings', 'upsert');
    expect(upserts.length).toBe(1);
    expect(upserts[0]!.payload?.key).toBe(RECONCILE_LAST_RESULT_KEY);
  });

  it('flags a settled payment whose capture PayPal cannot produce', async () => {
    withLedger({ payments: [paymentRow()] });
    scriptProviderObjects({ captures: {} });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([
      {
        kind: 'payment',
        orderId: ORDER_UUID,
        orderNumber: null,
        guildId: GUILD_ID,
        paypalPaymentIds: ['CAP-1'],
        amountCents: 2500,
        currency: 'USD',
        createdAt: IN_WINDOW,
      },
      {
        kind: 'order',
        orderId: ORDER_UUID,
        orderNumber: null,
        guildId: GUILD_ID,
        paypalPaymentIds: [],
        amountCents: 2500,
        currency: 'USD',
        createdAt: IN_WINDOW,
      },
    ]);
    const alertInserts = opsFor('alerts', 'insert');
    expect(alertInserts.length).toBe(1);
    expect(alertInserts[0]!.payload).toMatchObject({
      guild_id: GUILD_ID,
      alert_type: RECONCILE_ALERT_TYPE,
      severity: 'critical',
    });
  });

  it('reports a provider-settled capture backing an unsettled local pair', async () => {
    withLedger({
      payments: [paymentRow({ status: 'pending' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject() },
      orders: { 'PP-ORDER-1': orderObject({ captures: [{ id: 'CAP-1' }] }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'CAP-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'pending',
      orderStatus: 'pending',
    }]);
    // The capture pass owns locally-known captures; the pending-order GET
    // must not double-report the same capture.
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('flags a provider-side refund that never landed locally', async () => {
    withLedger({ payments: [paymentRow()] });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([{
      kind: 'refund',
      transactionId: 'CAP-1',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: null,
      source: 'capture',
      referenceId: 'CAP-1',
    }]);
  });

  it('accepts a provider-side refund that IS recorded locally', async () => {
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: { 'REF-1': refundObject({ value: '25.00' }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([]);
    expect(result.missingProviderPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([]);
    expect(result.providerTransactions).toBe(3);
  });

  it('flags a local refund PayPal cannot produce, tolerating zero-amount reversal witnesses', async () => {
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [
        {
          id: REF_UUID,
          payment_id: PAY_UUID,
          order_id: ORDER_UUID,
          guild_id: GUILD_ID,
          paypal_refund_id: 'REF-MISSING',
          event_type: 'PAYMENT.CAPTURE.REFUNDED',
          amount_cents: 2500,
          currency: 'USD',
          created_at: IN_WINDOW,
        },
        {
          id: REF2_UUID,
          payment_id: PAY_UUID,
          order_id: ORDER_UUID,
          guild_id: GUILD_ID,
          paypal_refund_id: 'REF-WITNESS',
          event_type: 'PAYMENT.CAPTURE.REVERSED',
          amount_cents: 0,
          currency: 'USD',
          created_at: IN_WINDOW,
        },
      ],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: {},
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([{
      kind: 'refund',
      orderId: ORDER_UUID,
      orderNumber: null,
      guildId: GUILD_ID,
      paypalPaymentIds: ['REF-MISSING'],
      amountCents: 2500,
      currency: 'USD',
      createdAt: IN_WINDOW,
    }]);
  });

  it('reports amount and currency drift on captures and refunds in local sign convention', async () => {
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '30.00' }) },
      refunds: { 'REF-1': refundObject({ value: '20.00' }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toEqual(expect.arrayContaining([
      {
        transactionId: 'CAP-1',
        guildId: GUILD_ID,
        providerAmountCents: 3000,
        localAmountCents: 2500,
        providerCurrency: 'USD',
        localCurrency: 'USD',
      },
      {
        transactionId: 'REF-1',
        guildId: GUILD_ID,
        providerAmountCents: 2000,
        localAmountCents: 2500,
        providerCurrency: 'USD',
        localCurrency: 'USD',
      },
    ]));
    expect(result.amountMismatches).toHaveLength(2);
  });

  it('surfaces settled provider captures on an order with no local payment write at all', async () => {
    withLedger({
      payments: [],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: {
        'PP-ORDER-1': orderObject({ captures: [{ id: 'CAP-NEW', value: '25.00' }] }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([{
      kind: 'payment',
      transactionId: 'CAP-NEW',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: null,
      source: 'order',
      referenceId: 'PP-ORDER-1',
    }]);
  });

  it('treats a vanished PENDING order as no money moved', async () => {
    withLedger({
      payments: [],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({ orders: {} });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([]);
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('flags a SETTLED order whose provider evidence is wholly absent', async () => {
    withLedger({
      payments: [],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({ orders: {} });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([{
      kind: 'order',
      orderId: ORDER_UUID,
      orderNumber: null,
      guildId: GUILD_ID,
      paypalPaymentIds: [],
      amountCents: 2500,
      currency: 'USD',
      createdAt: IN_WINDOW,
    }]);
  });

  it('fails closed when a fetched order carries a foreign SomniBot identity', async () => {
    withLedger({
      payments: [],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: {
        'PP-ORDER-1': orderObject({
          customId: JSON.stringify({
            g: SECOND_GUILD_ID,
            p: PRODUCT_UUID,
            c: CUSTOMER_UUID,
            d: DISCORD_ID,
          }),
          // Round 16: COMPLETED orders must carry a capture row, so give the
          // identity check something well-formed to reach.
          captures: [{ id: 'CAP-FOREIGN-ID', value: '25.00' }],
        }),
      },
    });

    await expect(runPayPalReconciliation(supabase as never, OPTS)).resolves.toEqual({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('verifies subscription commerce through the subscription, not the captures API', async () => {
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      captures: {},
      sales: { 'SALE-1': saleObject({ total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // Subscription rows never touch the captures API: the row is verified
    // through /v1/payments/sale and the subscription's billing state.
    expect(result.missingProviderPayments).toEqual([]);
    expect(result.missingLocalPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([]);
    expect(providerCalls.some((url) => url.includes('/v1/billing/subscriptions/SUB-1'))).toBe(true);
  });

  it('flags a provider subscription charge with no local payment in the window', async () => {
    withLedger({
      payments: [],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-LOST',
            status: 'COMPLETED',
            time: IN_WINDOW,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // Reported ONCE, by the actual sale id operators can replay.
    expect(result.missingLocalPayments).toEqual([{
      kind: 'payment',
      transactionId: 'SALE-LOST',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: new Date(Date.parse(IN_WINDOW)).toISOString(),
      source: 'subscription',
      referenceId: 'SUB-1',
    }]);
  });

  it('flags a settled subscription order whose subscription PayPal cannot produce', async () => {
    withLedger({
      payments: [],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-GONE',
      }],
    });
    scriptProviderObjects({ subscriptions: {} });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([{
      kind: 'order',
      orderId: ORDER_UUID,
      orderNumber: null,
      guildId: GUILD_ID,
      paypalPaymentIds: ['SUB-GONE'],
      amountCents: 2500,
      currency: 'USD',
      createdAt: IN_WINDOW,
    }]);
  });

  // ── PR #409 review round 1 repairs ────────────────────────────────────────

  it('detects a lost refund webhook on a capture OLDER than the window', async () => {
    // PayPal accepts refunds for months; the rolling window alone never
    // re-fetched old captures, so an 8-day-old refund with a lost webhook
    // completed cleanly while the entitlement stayed live.
    const OLD = '2026-06-30T10:00:00.000Z';
    withLedger({ payments: [paymentRow({ created_at: OLD })] });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([{
      kind: 'refund',
      transactionId: 'CAP-1',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: null,
      source: 'capture',
      referenceId: 'CAP-1',
    }]);
    expect(providerCalls.some((url) => url.includes('/v2/payments/captures/CAP-1'))).toBe(true);
  });

  it('detects a missing refund SIBLING through the aggregate, not a boolean', async () => {
    // One partial refund recorded, the second webhook lost, capture fully
    // REFUNDED at the provider: the old boolean check called this clean.
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 1000,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: { 'REF-1': refundObject({ value: '10.00' }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([{
      kind: 'refund',
      transactionId: 'CAP-1',
      guildId: GUILD_ID,
      amountCents: 1500,
      currency: 'USD',
      initiatedAt: null,
      source: 'capture',
      referenceId: 'CAP-1',
    }]);
  });

  it('flags a local full-refund claim the provider calls PARTIALLY_REFUNDED', async () => {
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'PARTIALLY_REFUNDED', value: '25.00' }) },
      refunds: { 'REF-1': refundObject({ value: '25.00' }) },
      orders: {
        'PP-ORDER-1': orderObject({
          status: 'COMPLETED',
          captures: [{ id: 'CAP-1', status: 'PARTIALLY_REFUNDED', value: '25.00' }],
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toEqual([{
      transactionId: 'CAP-1',
      guildId: GUILD_ID,
      providerAmountCents: 2500,
      localAmountCents: 2500,
      providerCurrency: 'USD',
      localCurrency: 'USD',
    }]);
  });

  it('reports a settled local pair whose provider capture never settled', async () => {
    // The window already trails a settlement lag, so PENDING/DECLINED at the
    // provider behind locally settled money is a material disagreement.
    withLedger({ payments: [paymentRow()] });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'PENDING', value: '25.00' }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([
      {
        kind: 'payment',
        orderId: ORDER_UUID,
        orderNumber: null,
        guildId: GUILD_ID,
        paypalPaymentIds: ['CAP-1'],
        amountCents: 2500,
        currency: 'USD',
        createdAt: IN_WINDOW,
      },
      {
        kind: 'order',
        orderId: ORDER_UUID,
        orderNumber: null,
        guildId: GUILD_ID,
        paypalPaymentIds: [],
        amountCents: 2500,
        currency: 'USD',
        createdAt: IN_WINDOW,
      },
    ]);
  });

  it('fails closed when a capture belongs to a DIFFERENT provider order', async () => {
    withLedger({
      payments: [paymentRow()],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({ value: '25.00', relatedOrderId: 'PP-ORDER-OTHER' }),
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('fails closed when a refund belongs to a DIFFERENT capture', async () => {
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: {
        'REF-1': refundObject({ value: '25.00', parentCaptureId: 'CAP-SOMEONE-ELSES' }),
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider refund identity conflict',
      retriable: false,
    });
  });

  it('reports a terminal local refund whose provider refund never COMPLETED', async () => {
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: { 'REF-1': refundObject({ status: 'PENDING', value: '25.00' }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([{
      kind: 'refund',
      orderId: ORDER_UUID,
      orderNumber: null,
      guildId: GUILD_ID,
      paypalPaymentIds: ['REF-1'],
      amountCents: 2500,
      currency: 'USD',
      createdAt: IN_WINDOW,
    }]);
    expect(result.amountMismatches).toEqual([]);
  });

  it('requires a COMPLETED local row for the latest subscription charge', async () => {
    withLedger({
      payments: [paymentRow({ status: 'pending' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'pending',
      orderStatus: 'completed',
    }]);
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('requires provider billing evidence behind settled local subscription sales', async () => {
    withLedger({
      payments: [paymentRow()],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'CAP-1': saleObject({ total: '25.00' }) },
      subscriptions: { 'SUB-1': subscriptionObject({ lastPaymentTime: null }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([{
      kind: 'payment',
      orderId: ORDER_UUID,
      orderNumber: null,
      guildId: GUILD_ID,
      paypalPaymentIds: ['SUB-1'],
      amountCents: 2500,
      currency: 'USD',
      createdAt: IN_WINDOW,
    }]);
  });

  it('reports a SETTLED order with no provider identity anywhere', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: null,
      }],
    });
    scriptProviderObjects({});

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([{
      kind: 'order',
      orderId: ORDER_UUID,
      orderNumber: null,
      guildId: GUILD_ID,
      paypalPaymentIds: [],
      amountCents: 2500,
      currency: 'USD',
      createdAt: IN_WINDOW,
    }]);
  });

  it('rejects a non-completed provider order behind a settled local order', async () => {
    // APPROVED with zero settled captures is PayPal explicitly saying no
    // money settled — the provider order status must not gate the finding.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: { 'PP-ORDER-1': orderObject({ status: 'APPROVED', captures: [] }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([{
      kind: 'order',
      orderId: ORDER_UUID,
      orderNumber: null,
      guildId: GUILD_ID,
      paypalPaymentIds: [],
      amountCents: 2500,
      currency: 'USD',
      createdAt: IN_WINDOW,
    }]);
  });

  it('aborts between provider chunks when the lease heartbeat is lost', async () => {
    // 201 payments cross one chunk boundary; the heartbeat after the first
    // chunk fails, so the pass must stop instead of outliving the lease.
    const manyPayments = Array.from({ length: 201 }, (_, index) => paymentRow({
      id: `30000000-0000-4000-8000-${String(100000000000 + index)}`,
      order_id: ORDER_UUID,
      paypal_payment_id: `CAP-M${index}`,
    }));
    withLedger({
      payments: manyPayments,
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    const captures: Record<string, unknown> = {};
    for (let index = 0; index < 201; index++) {
      captures[`CAP-M${index}`] = captureObject({ value: '25.00' });
    }
    scriptProviderObjects({ captures });
    let heartbeats = 0;
    rpcResolvers['paypal_reconcile_heartbeat'] = () => {
      heartbeats += 1;
      // The pre-verification heartbeats succeed; fail once the capture
      // chunks start reporting.
      return heartbeats <= 2
        ? { data: true, error: null }
        : { data: false, error: null };
    };

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result.status).toBe('failed');
  });

  // ── PR #409 review round 2 repairs ────────────────────────────────────────

  it('detects a lost refund on a subscription SALE through /v1/payments/sale', async () => {
    // The capture-404 continue used to leave subscription sales entirely
    // outside refund reconciliation: a lost PAYMENT.SALE.REFUNDED kept the
    // refunded subscriber's access live.
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'refunded', total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toContainEqual({
      kind: 'refund',
      transactionId: 'SALE-1',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: null,
      source: 'capture',
      referenceId: 'SALE-1',
    });
    expect(providerCalls.some((url) => url.includes('/v1/payments/sale/SALE-1'))).toBe(true);
  });

  it('detects a lost MIDDLE refund sibling through the parent order enumeration', async () => {
    // Provider: two completed partial refunds (10 + 10), capture still
    // PARTIALLY_REFUNDED. Local: only the first. Status thresholds alone
    // cannot see this — the order's refund list is the authoritative
    // aggregate.
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 1000,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'PARTIALLY_REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      refunds: { 'REF-1': refundObject({ value: '10.00', parentCaptureId: 'CAP-1' }) },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [{
                id: 'CAP-1',
                status: 'PARTIALLY_REFUNDED',
                amount: { currency_code: 'USD', value: '25.00' },
              }],
              refunds: [
                { id: 'REF-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' } },
                { id: 'REF-LOST', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' } },
              ],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // Reported by the MISSING SIBLING's own id — the id operators replay.
    expect(result.missingLocalPayments).toEqual([{
      kind: 'refund',
      transactionId: 'REF-LOST',
      guildId: GUILD_ID,
      amountCents: 1000,
      currency: 'USD',
      initiatedAt: null,
      source: 'capture',
      referenceId: 'CAP-1',
    }]);
  });

  it('verifies a legacy sale refund through /v1/payments/refund, not the v2 endpoint', async () => {
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1', status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'SALEREF-1',
        event_type: 'PAYMENT.SALE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'refunded', total: '25.00' }) },
      saleRefunds: {
        'SALEREF-1': {
          state: 'completed',
          amount: { currency: 'USD', total: '25.00' },
          sale_id: 'SALE-1',
        },
      },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([]);
    expect(providerCalls.some((url) => url.includes('/v1/payments/refund/SALEREF-1'))).toBe(true);
    expect(providerCalls.some((url) => url.includes('/v2/payments/refunds/SALEREF-1'))).toBe(false);
  });

  it('targets ESTABLISHED subscriptions whose renewal webhook was lost', async () => {
    // Order months old, no window payment at all: the provider's in-window
    // charge used to be completely invisible.
    const OLD = '2026-05-01T10:00:00.000Z';
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: OLD,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-LOST',
            status: 'COMPLETED',
            time: IN_WINDOW,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([{
      kind: 'payment',
      transactionId: 'SALE-LOST',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: new Date(Date.parse(IN_WINDOW)).toISOString(),
      source: 'subscription',
      referenceId: 'SUB-1',
    }]);
    expect(providerCalls.some((url) => url.includes('/v1/billing/subscriptions/SUB-1'))).toBe(true);
  });

  it('rejects an older renewal standing in for the LATEST lost charge', async () => {
    // Daily plans bill several times per window; an older completed row of
    // the same amount must not satisfy the latest charge.
    const EARLIER = '2026-07-21T10:00:00.000Z';
    const LATEST_CHARGE = '2026-07-24T10:00:00.000Z';
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1', created_at: EARLIER })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({
          lastPaymentTime: LATEST_CHARGE,
          lastPaymentValue: '25.00',
        }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [
            {
              id: 'SALE-1',
              status: 'COMPLETED',
              time: EARLIER,
              amount_with_breakdown: {
                gross_amount: { currency_code: 'USD', value: '25.00' },
              },
            },
            {
              id: 'SALE-LATEST',
              status: 'COMPLETED',
              time: LATEST_CHARGE,
              amount_with_breakdown: {
                gross_amount: { currency_code: 'USD', value: '25.00' },
              },
            },
          ],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // The older completed renewal cannot stand in: the enumeration reports
    // the LATEST charge by its own sale id.
    expect(result.missingLocalPayments).toEqual([{
      kind: 'payment',
      transactionId: 'SALE-LATEST',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: new Date(Date.parse(LATEST_CHARGE)).toISOString(),
      source: 'subscription',
      referenceId: 'SUB-1',
    }]);
  });

  it('surfaces a lost subscription lifecycle transition for replay', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'CANCELLED', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_cancelled',
      orderStatus: 'completed',
    }]);
  });

  // ── PR #409 review round 3 repairs ────────────────────────────────────────

  it('fails closed when a sale belongs to a DIFFERENT subscription', async () => {
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: {
        'SALE-1': {
          ...saleObject({ total: '25.00' }),
          billing_agreement_id: 'SUB-SOMEONE-ELSES',
        },
      },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('does not re-alert a lifecycle transition the durable head already observed', async () => {
    // Purchase orders stay 'completed' forever by design: a properly
    // processed cancellation must read clean, not critical, forever.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['commerce_subscription_lifecycle_heads'] = () => ({
      data: [{
        paypal_subscription_id: 'SUB-1',
        last_event_priority: 60,
        last_provider_event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
        last_webhook_event_id: 'WH-1',
      }],
      error: null,
    });
    // Rounds 8-9: the head alone is not enough — the fulfillment ACTION for
    // THIS transition (keyed by the head's webhook event) must be healthy.
    resolvers['bot_action_queue'] = (op) => {
      const wantsStaged = op.filters.some(
        (f) => f.method === 'eq' && f.args[0] === 'status' && f.args[1] === 'staged',
      );
      return {
        data: wantsStaged
          ? []
          : [{
              idempotency_key: 'paypal:lifecycle:WH-1:subscription_cancelled',
              status: 'completed',
            }],
        error: null,
      };
    };
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'CANCELLED', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([]);
  });

  it('surfaces a lost activation for a pending subscription order', async () => {
    // Free trials can be ACTIVE with no payment at all — the divergence is
    // the pending local order behind an ACTIVE provider subscription.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'ACTIVE', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_active_unfulfilled',
      orderStatus: 'pending',
    }]);
  });

  it('applies money checks to EVERY fetched sale, not only the latest charge', async () => {
    // Two daily charges in-window; the older local row drifted. The correct
    // newest charge must not make the pass clean.
    const EARLIER = '2026-07-22T10:00:00.000Z';
    withLedger({
      payments: [
        paymentRow({ paypal_payment_id: 'SALE-OLD', created_at: EARLIER, amount_cents: 1500 }),
        paymentRow({
          id: PAY2_UUID,
          paypal_payment_id: 'SALE-NEW',
          created_at: IN_WINDOW,
        }),
      ],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: {
        'SALE-OLD': saleObject({ total: '25.00' }),
        'SALE-NEW': saleObject({ total: '25.00' }),
      },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toEqual([{
      transactionId: 'SALE-OLD',
      guildId: GUILD_ID,
      providerAmountCents: 2500,
      localAmountCents: 1500,
      providerCurrency: 'USD',
      localCurrency: 'USD',
    }]);
  });

  it('surfaces an APPROVED provider order whose capture webhook was lost', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: { 'PP-ORDER-1': orderObject({ status: 'APPROVED', captures: [] }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'PP-ORDER-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'order_approved_uncaptured',
      orderStatus: 'pending',
    }]);
  });

  it('excludes cross-currency historical refund rows from the aggregate and flags them', async () => {
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'EUR',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: { 'REF-1': refundObject({ value: '25.00', currency: 'EUR' }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // The EUR row cannot certify the USD capture's refund: the aggregate
    // stays short (missing 25.00) and the row itself is flagged.
    expect(result.missingLocalPayments).toContainEqual(expect.objectContaining({
      kind: 'refund',
      transactionId: 'CAP-1',
      amountCents: 2500,
    }));
    expect(result.amountMismatches).toContainEqual(expect.objectContaining({
      transactionId: 'REF-1',
      localCurrency: 'EUR',
    }));
  });

  it('fails closed on a foreign capture parent in the refund LOOKBACK', async () => {
    const OLD = '2026-06-30T10:00:00.000Z';
    withLedger({
      payments: [paymentRow({ created_at: OLD })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: OLD,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-OTHER',
        }),
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('lets the settlement lag absorb a provider refund issued moments ago', async () => {
    // The operator refunded just before the pass: the order GET already
    // shows the refund while the webhook is legitimately in flight — no
    // critical alert yet.
    const JUST_NOW = '2026-07-27T11:59:30.000Z';
    withLedger({
      payments: [paymentRow()],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [{
                id: 'CAP-1',
                status: 'REFUNDED',
                amount: { currency_code: 'USD', value: '25.00' },
              }],
              refunds: [{
                id: 'REF-FRESH',
                status: 'COMPLETED',
                amount: { currency_code: 'USD', value: '25.00' },
                create_time: JUST_NOW,
              }],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.missingLocalPayments).toEqual([]);
  });

  // ── PR #409 review round 4 repairs ────────────────────────────────────────

  it('fails closed on a subscription minted by a DIFFERENT checkout', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({
          lastPaymentTime: null,
          customId: JSON.stringify({
            g: '999999999999999999',
            p: PRODUCT_UUID,
            c: CUSTOMER_UUID,
            d: DISCORD_ID,
          }),
        }),
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('fails closed when the provider bills a DIFFERENT plan', async () => {
    const PLAN_UUID = '50000000-0000-4000-8000-000000000001';
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
        plan_id: PLAN_UUID,
      }],
    });
    resolvers['bot_action_queue'] = (op) => {
      const wantsStaged = op.filters.some(
        (f) => f.method === 'eq' && f.args[0] === 'status' && f.args[1] === 'staged',
      );
      return {
        data: wantsStaged
          ? []
          : [{
              idempotency_key: 'paypal:subscription:SUB-1:fulfill_subscription',
              payload: { order_id: ORDER_UUID, paypal_plan_id: 'P-LOCAL' },
              status: 'completed',
            }],
        error: null,
      };
    };
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null, planId: 'P-OTHER' }),
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('surfaces a lost REACTIVATION after an observed suspension', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['commerce_subscription_lifecycle_heads'] = () => ({
      data: [{
        paypal_subscription_id: 'SUB-1',
        last_event_priority: 50,
        last_provider_event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
      }],
      error: null,
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'ACTIVE', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_reactivated_unfulfilled',
      orderStatus: 'completed',
    }]);
  });

  it('lets the settlement lag absorb a latest charge still in flight', async () => {
    // Daily plan: yesterday's charge is local and in-window; today's charge
    // happened 5 minutes ago (inside the 15-minute lag). No reverse
    // missing-at-PayPal alert.
    const YESTERDAY = '2026-07-26T12:00:00.000Z';
    const FIVE_MIN_AGO = '2026-07-27T11:55:00.000Z';
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-YDAY', created_at: YESTERDAY })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-YDAY': saleObject({ total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({
          lastPaymentTime: FIVE_MIN_AGO,
          lastPaymentValue: '25.00',
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.missingProviderPayments).toEqual([]);
  });

  it('keeps local and provider refund aggregates symmetric under the lag', async () => {
    // The refund webhook landed seconds ago: the local row exists while the
    // provider aggregate deliberately excludes the in-flight refund. No
    // false mismatch.
    const JUST_NOW = '2026-07-27T11:59:30.000Z';
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: JUST_NOW,
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      refunds: { 'REF-1': refundObject({ value: '25.00' }) },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [{
                id: 'CAP-1',
                status: 'REFUNDED',
                amount: { currency_code: 'USD', value: '25.00' },
              }],
              refunds: [{
                id: 'REF-1',
                status: 'COMPLETED',
                amount: { currency_code: 'USD', value: '25.00' },
                create_time: JUST_NOW,
              }],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.amountMismatches).toEqual([]);
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('treats a REVERSED sale as settled reversal evidence, not missing money', async () => {
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1', status: 'reversed' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'SALEREF-1',
        event_type: 'PAYMENT.SALE.REVERSED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'reversed', total: '25.00' }) },
      saleRefunds: {
        'SALEREF-1': {
          state: 'completed',
          amount: { currency: 'USD', total: '25.00' },
          sale_id: 'SALE-1',
        },
      },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([]);
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('discovers a NON-latest lost charge through the transactions list', async () => {
    // Monday's webhook lost, Tuesday's landed: last_payment matches locally,
    // but the enumeration must still find Monday's money.
    const MONDAY = '2026-07-23T10:00:00.000Z';
    const TUESDAY = '2026-07-24T10:00:00.000Z';
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-TUE', created_at: TUESDAY })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-TUE': saleObject({ total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: TUESDAY, lastPaymentValue: '25.00' }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [
            {
              id: 'SALE-MON',
              status: 'COMPLETED',
              time: MONDAY,
              amount_with_breakdown: {
                gross_amount: { currency_code: 'USD', value: '25.00' },
              },
            },
            {
              id: 'SALE-TUE',
              status: 'COMPLETED',
              time: TUESDAY,
              amount_with_breakdown: {
                gross_amount: { currency_code: 'USD', value: '25.00' },
              },
            },
          ],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([{
      kind: 'payment',
      transactionId: 'SALE-MON',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: new Date(Date.parse(MONDAY)).toISOString(),
      source: 'subscription',
      referenceId: 'SUB-1',
    }]);
  });

  // ── PR #409 review round 5 repairs ────────────────────────────────────────

  it('verifies a DIRECT sale reversal witness through the sale endpoint', async () => {
    // PAYMENT.SALE.REVERSED with a direct Sale resource mints no distinct
    // refund object: the ledger stores the SALE id as the refund id. The
    // refund endpoint can never serve it — the sale's terminal state is the
    // evidence, and this must not read as missing at PayPal on every pass.
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1', status: 'reversed' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'SALE-1',
        event_type: 'PAYMENT.SALE.REVERSED',
        amount_cents: 1200,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'reversed', total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([]);
    expect(providerCalls.some((url) => url.includes('/v1/payments/refund/SALE-1'))).toBe(false);
  });

  it('fails closed when a subscription transaction id is attached to a foreign order', async () => {
    // SALE-X is locally attached to a ONE-TIME order; subscription SUB-1's
    // transaction list claims the same id. Suppressing the transaction
    // because the id is "known" would hide SUB-1's missing money behind the
    // wrong order's row.
    const OTHER_ORDER = '00000000-0000-4000-8000-000000000002';
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-X', order_id: OTHER_ORDER })],
      orders: [
        {
          id: OTHER_ORDER,
          guild_id: GUILD_ID,
          amount_cents: 2500,
          status: 'completed',
          created_at: IN_WINDOW,
          paypal_order_id: 'PP-ORDER-OTHER',
        },
        {
          id: ORDER_UUID,
          guild_id: GUILD_ID,
          amount_cents: 2500,
          status: 'completed',
          created_at: IN_WINDOW,
          paypal_order_id: null,
          paypal_subscription_id: 'SUB-1',
        },
      ],
    });
    scriptProviderObjects({
      captures: { 'SALE-X': captureObject({ value: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-X',
            status: 'COMPLETED',
            time: IN_WINDOW,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  // ── PR #409 review round 6 repairs ────────────────────────────────────────

  it('lets the settlement lag absorb a capture DISCOVERED through the order', async () => {
    // The buyer approved and PayPal captured 30 seconds ago: the order GET
    // already shows the capture while its webhook is in flight. Not a
    // critical alert.
    const JUST_NOW = '2026-07-27T11:59:30.000Z';
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [{
                id: 'CAP-FRESH',
                status: 'COMPLETED',
                amount: { currency_code: 'USD', value: '25.00' },
                create_time: JUST_NOW,
              }],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.missingLocalPayments).toEqual([]);
  });

  it('anchors the activation lag on the provider transition time', async () => {
    // The order is weeks old, but the buyer only just approved: PayPal
    // flipped to ACTIVE five minutes ago and the activation webhook is
    // legitimately in flight.
    const OLD_ORDER = '2026-07-01T10:00:00.000Z';
    const FIVE_MIN_AGO = '2026-07-27T11:55:00.000Z';
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: OLD_ORDER,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': {
          ...subscriptionObject({ status: 'ACTIVE', lastPaymentTime: null }),
          status_update_time: FIVE_MIN_AGO,
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.unsettledLocalPayments).toEqual([]);
  });

  it('accepts a refunded latest charge as a settled pair, not an unsettled row', async () => {
    // The latest in-window charge was legitimately refunded: the refunded
    // local row is terminal-settled and must not read as pending/failed.
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1', status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'SALEREF-1',
        event_type: 'PAYMENT.SALE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'refunded', total: '25.00' }) },
      saleRefunds: {
        'SALEREF-1': {
          state: 'completed',
          amount: { currency: 'USD', total: '25.00' },
          sale_id: 'SALE-1',
        },
      },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-1',
            status: 'REFUNDED',
            time: IN_WINDOW,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // Round 17: the refunded pair is settled (no pending/failed noise), and
    // the STILL-ACTIVE billing agreement behind the refunded order is its
    // own divergence — PayPal keeps charging a customer with nothing.
    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_active_after_refund',
      orderStatus: 'refunded',
    }]);
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('reads every refund sibling page when summing the local aggregate', async () => {
    // 1001 sibling rows total exactly the capture amount: an unpaged read
    // would truncate at 1000 and fake a missing remainder.
    const siblings = Array.from({ length: 1001 }, (_, index) => ({
      id: `40000000-0000-4000-8000-${String(100000000000 + index)}`,
      payment_id: PAY_UUID,
      order_id: ORDER_UUID,
      guild_id: GUILD_ID,
      paypal_refund_id: `REF-S${index}`,
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      amount_cents: index === 1000 ? 500 : 2,
      currency: 'USD',
      created_at: IN_WINDOW,
    }));
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: '2026-07-20T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: siblings,
    });
    const saleRefundRegistry: Record<string, unknown> = {};
    const refundRegistry: Record<string, unknown> = {};
    for (const sibling of siblings) {
      refundRegistry[sibling.paypal_refund_id] = refundObject({
        value: (sibling.amount_cents / 100).toFixed(2),
        parentCaptureId: 'CAP-1',
      });
    }
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: refundRegistry,
      saleRefunds: saleRefundRegistry,
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // The full 1001-row aggregate covers the capture: nothing missing.
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('lets the settlement lag absorb a sale refunded moments ago', async () => {
    const JUST_NOW = '2026-07-27T11:59:30.000Z';
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: {
        'SALE-1': {
          ...saleObject({ state: 'refunded', total: '25.00' }),
          update_time: JUST_NOW,
        },
      },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-1',
            status: 'COMPLETED',
            time: IN_WINDOW,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.missingLocalPayments).toEqual([]);
  });

  it('demands provider evidence for a settled order backed only by a failed row', async () => {
    // The order (and entitlements) claim settlement; the only payment row
    // failed and its capture does not exist at PayPal. That must never
    // complete clean.
    withLedger({
      payments: [paymentRow({ status: 'failed' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({ captures: {} });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([
      {
        kind: 'payment',
        orderId: ORDER_UUID,
        orderNumber: null,
        guildId: GUILD_ID,
        paypalPaymentIds: ['CAP-1'],
        amountCents: 2500,
        currency: 'USD',
        createdAt: IN_WINDOW,
      },
      {
        kind: 'order',
        orderId: ORDER_UUID,
        orderNumber: null,
        guildId: GUILD_ID,
        paypalPaymentIds: [],
        amountCents: 2500,
        currency: 'USD',
        createdAt: IN_WINDOW,
      },
    ]);
  });

  // ── PR #409 review round 7 repairs ────────────────────────────────────────

  it('defers a terminal lifecycle flip that happened inside the lag', async () => {
    const FIVE_MIN_AGO = '2026-07-27T11:55:00.000Z';
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': {
          ...subscriptionObject({ status: 'CANCELLED', lastPaymentTime: null }),
          status_update_time: FIVE_MIN_AGO,
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    // The cancellation webhook is in flight — the next pass owns it.
    expect(result.unsettledLocalPayments).toEqual([]);
  });

  it('defers an approval that happened inside the lag', async () => {
    const FIVE_MIN_AGO = '2026-07-27T11:55:00.000Z';
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: {
        'PP-ORDER-1': {
          ...orderObject({ status: 'APPROVED', captures: [] }),
          update_time: FIVE_MIN_AGO,
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.unsettledLocalPayments).toEqual([]);
  });

  // ── PR #409 review round 8 repairs ────────────────────────────────────────

  it('flags an observed cancellation whose fulfillment action never queued healthily', async () => {
    // The head records the observation BEFORE the action write: head parity
    // alone cannot prove access was revoked.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['commerce_subscription_lifecycle_heads'] = () => ({
      data: [{ paypal_subscription_id: 'SUB-1', last_event_priority: 60 }],
      error: null,
    });
    resolvers['bot_action_queue'] = () => ({ data: [], error: null });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'CANCELLED', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_cancelled',
      orderStatus: 'completed',
    }]);
  });

  it('flags an ACTIVE completed order whose fulfillment is still STAGED', async () => {
    // The activation handler completes the order BEFORE releasing the staged
    // fulfillment: a crash in the gap leaves a paying buyer with nothing.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    // Round 13: the exact activation carrier's status is the truth — a
    // STAGED (or FAILED) carrier behind an ACTIVE completed order means the
    // buyer received nothing.
    resolvers['bot_action_queue'] = () => ({
      data: [{
        idempotency_key: 'paypal:subscription:SUB-1:fulfill_subscription',
        payload: { order_id: ORDER_UUID },
        status: 'staged',
      }],
      error: null,
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'ACTIVE', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_activation_unreleased',
      orderStatus: 'completed',
    }]);
  });

  it('fails closed when a discovered capture is known on a DIFFERENT order', async () => {
    // Historical refund parents enter the provider-id map without crossing
    // the capture pass — membership alone must not suppress discovery.
    const OTHER_ORDER = '00000000-0000-4000-8000-000000000003';
    const OLD = '2026-06-15T10:00:00.000Z';
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'CAP-FOREIGN',
        order_id: OTHER_ORDER,
        created_at: OLD,
        status: 'refunded',
      })],
      orders: [
        {
          id: OTHER_ORDER,
          guild_id: GUILD_ID,
          amount_cents: 2500,
          status: 'refunded',
          created_at: OLD,
          paypal_order_id: 'PP-ORDER-OTHER',
        },
        {
          id: ORDER_UUID,
          guild_id: GUILD_ID,
          amount_cents: 2500,
          status: 'completed',
          created_at: IN_WINDOW,
          paypal_order_id: 'PP-ORDER-1',
        },
      ],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: OTHER_ORDER,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-FOREIGN': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: { 'REF-1': refundObject({ value: '25.00', parentCaptureId: 'CAP-FOREIGN' }) },
      orders: {
        'PP-ORDER-1': orderObject({
          captures: [{ id: 'CAP-FOREIGN', value: '25.00' }],
        }),
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('fails the pass when a live subscription has no transactions collection', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      // Explicitly deny the transactions subresource for a live sub.
      subscriptionTransactions: {},
    });
    // The harness default would synthesize an empty list; forcing an entry
    // registry without SUB-1 makes the subresource 404.
    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      retriable: true,
    });
  });

  // ── PR #409 review round 9 repairs ────────────────────────────────────────

  it('does not let an OLD completed action mask the current lost transition', async () => {
    // Suspended, reactivated, suspended again: the head names the SECOND
    // suspension's webhook, and only an action keyed by THAT event counts.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['commerce_subscription_lifecycle_heads'] = () => ({
      data: [{
        paypal_subscription_id: 'SUB-1',
        last_event_priority: 50,
        last_provider_event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
        last_webhook_event_id: 'WH-SECOND',
      }],
      error: null,
    });
    resolvers['bot_action_queue'] = (op) => {
      const wantsStaged = op.filters.some(
        (f) => f.method === 'eq' && f.args[0] === 'status' && f.args[1] === 'staged',
      );
      return {
        data: wantsStaged
          ? []
          // Only the FIRST suspension's action exists.
          : [{
              idempotency_key: 'paypal:lifecycle:WH-FIRST:subscription_suspended',
              status: 'completed',
            }],
        error: null,
      };
    };
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'SUSPENDED', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_suspended',
      orderStatus: 'completed',
    }]);
  });

  it('reports a partially refunded sale behind a FULL reversal witness', async () => {
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1', status: 'reversed' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'SALE-1',
        event_type: 'PAYMENT.SALE.REVERSED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'partially_refunded', total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // The witness claims a full reversal the provider does not corroborate.
    expect(result.missingProviderPayments).toContainEqual(expect.objectContaining({
      kind: 'refund',
      paypalPaymentIds: ['SALE-1'],
    }));
  });

  it('defers the status-only refund fallback while the capture is in the lag', async () => {
    const JUST_NOW = '2026-07-27T11:59:30.000Z';
    withLedger({
      payments: [paymentRow()],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': {
          ...captureObject({ status: 'REFUNDED', value: '25.00' }),
          update_time: JUST_NOW,
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    // No parent order to enumerate and the capture just flipped: in flight.
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('catches sibling identity drift even when the totals agree', async () => {
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-WRONG',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 1000,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'PARTIALLY_REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      refunds: { 'REF-WRONG': refundObject({ value: '10.00', parentCaptureId: 'CAP-1' }) },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [{
                id: 'CAP-1',
                status: 'PARTIALLY_REFUNDED',
                amount: { currency_code: 'USD', value: '25.00' },
              }],
              refunds: [
                { id: 'REF-RIGHT', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' } },
              ],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // Same aggregate, wrong sibling id: REF-RIGHT is still reported missing.
    expect(result.missingLocalPayments).toContainEqual(expect.objectContaining({
      kind: 'refund',
      transactionId: 'REF-RIGHT',
      referenceId: 'CAP-1',
    }));
  });

  // ── PR #409 review round 10 repairs ───────────────────────────────────────

  it('reads a processed EXPIRY clean through its cancellation action', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['commerce_subscription_lifecycle_heads'] = () => ({
      data: [{
        paypal_subscription_id: 'SUB-1',
        last_event_priority: 60,
        last_provider_event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        last_webhook_event_id: 'WH-EXP',
      }],
      error: null,
    });
    resolvers['bot_action_queue'] = (op) => {
      const wantsStaged = op.filters.some(
        (f) => f.method === 'eq' && f.args[0] === 'status' && f.args[1] === 'staged',
      );
      return {
        data: wantsStaged
          ? []
          : [{
              idempotency_key: 'paypal:lifecycle:WH-EXP:subscription_cancelled',
              status: 'completed',
            }],
        error: null,
      };
    };
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'EXPIRED', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([]);
  });

  it('flags a completed order whose subscription PayPal never activated', async () => {
    // Free trial: no payment rows exist, so only the status comparison can
    // catch entitlements claiming an activation that never happened.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'APPROVAL_PENDING', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_never_activated',
      orderStatus: 'completed',
    }]);
  });

  it('reports a lost latest charge once even when an OLDER renewal failed', async () => {
    const OLD_FAILED = '2026-07-21T10:00:00.000Z';
    const LATEST = '2026-07-24T10:00:00.000Z';
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'SALE-OLDFAIL',
        created_at: OLD_FAILED,
        status: 'failed',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-OLDFAIL': saleObject({ state: 'denied', total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: LATEST, lastPaymentValue: '25.00' }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-LATEST',
            status: 'COMPLETED',
            time: LATEST,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // The stale failed renewal does not correlate with the latest charge:
    // one finding, by the actual sale id.
    expect(result.unsettledLocalPayments).toEqual([]);
    expect(result.missingLocalPayments).toEqual([{
      kind: 'payment',
      transactionId: 'SALE-LATEST',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: new Date(Date.parse(LATEST)).toISOString(),
      source: 'subscription',
      referenceId: 'SUB-1',
    }]);
  });

  // ── PR #409 review round 11 repairs ───────────────────────────────────────

  it('discovers a REVERSED subscription transaction with no local rows', async () => {
    const MONDAY = '2026-07-23T10:00:00.000Z';
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-REV',
            status: 'REVERSED',
            time: MONDAY,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toContainEqual(expect.objectContaining({
      kind: 'payment',
      transactionId: 'SALE-REV',
      referenceId: 'SUB-1',
    }));
  });

  it('falls back to the capture state when the refund list is inexplicably empty', async () => {
    // REFUNDED capture, parent order enumerates NO refunds at all: the empty
    // list is provider-inconsistent, never authoritative — the status-bound
    // comparison must still report the lost refund.
    withLedger({
      payments: [paymentRow()],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [{
                id: 'CAP-1',
                status: 'REFUNDED',
                amount: { currency_code: 'USD', value: '25.00' },
              }],
              refunds: [],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toContainEqual(expect.objectContaining({
      kind: 'refund',
      transactionId: 'CAP-1',
      amountCents: 2500,
    }));
  });

  it('rejects a COMPLETED order whose capture collection is absent', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{ custom_id: IDENTITY_CUSTOM_FIELD }],
        },
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order lookup returned a malformed record',
    });
  });

  it('judges the FULL ledger of an old direct sale reversal, not the echo', async () => {
    // The witness row's remaining balance (12.00) would compare equal by
    // construction; the sale's own total (25.00) vs the local ledger is the
    // real check, and here 13.00 of reversal never landed.
    const OLD = '2026-06-15T10:00:00.000Z';
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'SALE-1',
        status: 'reversed',
        created_at: OLD,
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: OLD,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'SALE-1',
        event_type: 'PAYMENT.SALE.REVERSED',
        amount_cents: 1200,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'reversed', total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toContainEqual(expect.objectContaining({
      kind: 'refund',
      transactionId: 'SALE-1',
      amountCents: 1300,
    }));
  });

  // ── PR #409 review round 12 repairs ───────────────────────────────────────

  it('demands sale evidence for a settled subscription order with only a failed row', async () => {
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1', status: 'failed' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toContainEqual(expect.objectContaining({
      kind: 'payment',
      paypalPaymentIds: ['SALE-1'],
    }));
  });

  it('compares each matched refund sibling by money, not id alone', async () => {
    // The local row has the RIGHT id but an understated amount; the
    // aggregate's one-way check would pass it silently.
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 800,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'PARTIALLY_REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      refunds: { 'REF-1': refundObject({ value: '8.00', parentCaptureId: 'CAP-1' }) },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [{
                id: 'CAP-1',
                status: 'PARTIALLY_REFUNDED',
                amount: { currency_code: 'USD', value: '25.00' },
              }],
              refunds: [
                { id: 'REF-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' } },
              ],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toContainEqual(expect.objectContaining({
      transactionId: 'REF-1',
      providerAmountCents: 1000,
      localAmountCents: 800,
    }));
  });

  it('fails closed on a historical refund row owned by another order', async () => {
    const OTHER_ORDER = '00000000-0000-4000-8000-000000000004';
    withLedger({
      payments: [paymentRow()],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: OTHER_ORDER,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-X',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: '2026-07-01T10:00:00.000Z',
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider refund identity conflict',
      retriable: false,
    });
  });

  it('falls back to last_payment evidence when the enumeration is empty', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
      subscriptionTransactions: {
        'SUB-1': { transactions: [] },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // The provider's own latest-charge evidence must not be out-reported by
    // an empty enumeration.
    expect(result.missingLocalPayments).toEqual([{
      kind: 'payment',
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: IN_WINDOW,
      source: 'subscription',
      referenceId: 'SUB-1',
    }]);
  });

  // ── PR #409 review round 13 repairs ───────────────────────────────────────

  it('flags a FAILED activation carrier behind an ACTIVE subscription', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['bot_action_queue'] = () => ({
      data: [{
        idempotency_key: 'paypal:subscription:SUB-1:fulfill_subscription',
        payload: { order_id: ORDER_UUID },
        status: 'failed',
      }],
      error: null,
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'ACTIVE', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_activation_unreleased',
      orderStatus: 'completed',
    }]);
  });

  it("does not let yesterday's renewal suppress the fallback for today's lost charge", async () => {
    const YESTERDAY = '2026-07-26T10:00:00.000Z';
    const TODAY = '2026-07-27T10:00:00.000Z';
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-YDAY', created_at: YESTERDAY })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-YDAY': saleObject({ total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: TODAY, lastPaymentValue: '25.00' }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          // The list omits TODAY's advertised charge and returns only the
          // known older renewal.
          transactions: [{
            id: 'SALE-YDAY',
            status: 'COMPLETED',
            time: YESTERDAY,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toContainEqual(expect.objectContaining({
      kind: 'payment',
      transactionId: 'SUB-1',
      referenceId: 'SUB-1',
      initiatedAt: TODAY,
    }));
  });

  it('does not let a pending fallback row suppress a settled discovered charge', async () => {
    const MONDAY = '2026-07-23T10:00:00.000Z';
    withLedger({
      // The row exists but never settled — created OUTSIDE the window so
      // only the enumeration fallback path can see it.
      payments: [paymentRow({
        paypal_payment_id: 'SALE-MON',
        created_at: '2026-07-10T10:00:00.000Z',
        status: 'pending',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-MON': saleObject({ total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-MON',
            status: 'COMPLETED',
            time: MONDAY,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toContainEqual(expect.objectContaining({
      kind: 'payment',
      transactionId: 'SALE-MON',
    }));
  });

  it('tolerates a boundary charge whose row bled into the window', async () => {
    // The charge happened moments before the window start; its webhook row
    // landed inside. Not absent billing evidence.
    const JUST_BEFORE_WINDOW = '2026-07-20T11:58:00.000Z';
    const ROW_IN_WINDOW = '2026-07-20T12:01:00.000Z';
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-EDGE', created_at: ROW_IN_WINDOW })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-EDGE': saleObject({ total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({
          lastPaymentTime: JUST_BEFORE_WINDOW,
          lastPaymentValue: '25.00',
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([]);
  });

  // ── PR #409 review round 14 repairs ───────────────────────────────────────

  it('surfaces money drift on an exact-lookup fallback row', async () => {
    const MONDAY = '2026-07-23T10:00:00.000Z';
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'SALE-MON',
        created_at: '2026-07-10T10:00:00.000Z',
        amount_cents: 1500,
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-MON': saleObject({ total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-MON',
            status: 'COMPLETED',
            time: MONDAY,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toContainEqual(expect.objectContaining({
      transactionId: 'SALE-MON',
      providerAmountCents: 2500,
      localAmountCents: 1500,
    }));
  });

  it('surfaces an ACTIVE provider behind a CANCELLED head', async () => {
    // Access was revoked by the completed cancellation action while PayPal
    // still bills the customer.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['commerce_subscription_lifecycle_heads'] = () => ({
      data: [{
        paypal_subscription_id: 'SUB-1',
        last_event_priority: 60,
        last_provider_event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
        last_webhook_event_id: 'WH-1',
      }],
      error: null,
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'ACTIVE', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_reactivated_unfulfilled',
      orderStatus: 'completed',
    }]);
  });

  // ── PR #409 review round 15 repairs ───────────────────────────────────────

  it('judges the refund ledger when a completed row hides a REFUNDED transaction', async () => {
    const MONDAY = '2026-07-23T10:00:00.000Z';
    withLedger({
      // Out-of-window row still 'completed': the refund webhook was lost.
      payments: [paymentRow({
        paypal_payment_id: 'SALE-MON',
        created_at: '2026-07-10T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-MON': saleObject({ total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-MON',
            status: 'REFUNDED',
            time: MONDAY,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toContainEqual(expect.objectContaining({
      kind: 'refund',
      transactionId: 'SALE-MON',
      amountCents: 2500,
    }));
  });

  it('reports the uncovered remainder of a fully refunded capture', async () => {
    // REFUNDED $25 capture; the order enumerates only one $8 refund and the
    // ledger has that same $8 row: the $17 remainder is a lost refund the
    // order response failed to enumerate.
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 800,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      refunds: { 'REF-1': refundObject({ value: '8.00', parentCaptureId: 'CAP-1' }) },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [{
                id: 'CAP-1',
                status: 'REFUNDED',
                amount: { currency_code: 'USD', value: '25.00' },
              }],
              refunds: [
                { id: 'REF-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '8.00' } },
              ],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toContainEqual(expect.objectContaining({
      kind: 'refund',
      transactionId: 'CAP-1',
      amountCents: 1700,
    }));
  });

  // ── PR #409 review round 16 repairs ───────────────────────────────────────

  it('rejects a COMPLETED order whose capture list is EMPTY', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: { 'PP-ORDER-1': orderObject({ status: 'COMPLETED', captures: [] }) },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order lookup returned a malformed record',
    });
  });

  it('judges a PARTIALLY_REFUNDED fallback transaction with no local refunds', async () => {
    const MONDAY = '2026-07-23T10:00:00.000Z';
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'SALE-MON',
        created_at: '2026-07-10T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-MON': saleObject({ total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-MON',
            status: 'PARTIALLY_REFUNDED',
            time: MONDAY,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // Zero local refund rows behind provider-side partial refunds: the lost
    // first partial webhook surfaces.
    expect(result.missingLocalPayments).toContainEqual(expect.objectContaining({
      kind: 'refund',
      transactionId: 'SALE-MON',
    }));
  });

  // ── PR #409 review round 17 repairs ───────────────────────────────────────

  it('flags a provider SUSPENSION behind a cancellation-family head', async () => {
    // The cancellation (priority 60) outranks the suspension threshold, but
    // it is the WRONG family: the suspension transition and its distinct
    // fulfillment were never observed.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['commerce_subscription_lifecycle_heads'] = () => ({
      data: [{
        paypal_subscription_id: 'SUB-1',
        last_event_priority: 60,
        last_provider_event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
        last_webhook_event_id: 'WH-CANCEL',
      }],
      error: null,
    });
    resolvers['bot_action_queue'] = (op) => {
      const wantsStaged = op.filters.some(
        (f) => f.method === 'eq' && f.args[0] === 'status' && f.args[1] === 'staged',
      );
      return {
        data: wantsStaged
          ? []
          : [{
              idempotency_key: 'paypal:lifecycle:WH-CANCEL:subscription_cancelled',
              status: 'completed',
            }],
        error: null,
      };
    };
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'SUSPENDED', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_suspended',
      orderStatus: 'completed',
    }]);
  });

  it('flags an ACTIVE billing agreement behind a refunded order', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'ACTIVE', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_active_after_refund',
      orderStatus: 'refunded',
    }]);
  });

  // ── PR #409 review round 18 repairs ─────────────────────────────────────

  it('surfaces a COMPLETED provider order backed only by unsettled captures', async () => {
    // PayPal claims completion while its only capture row is still PENDING:
    // no money settled and nothing local advanced. Completion alone must
    // not read as clean for a locally pending order.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: {
        'PP-ORDER-1': orderObject({
          status: 'COMPLETED',
          captures: [{ id: 'CAP-PEND', status: 'PENDING', value: '25.00' }],
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'PP-ORDER-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'order_completed_uncaptured',
      orderStatus: 'pending',
    }]);
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('surfaces payment-money drift on a refund-judged fallback row', async () => {
    // Out-of-window completed row behind a REFUNDED discovered charge: the
    // refund ledger fully matches the provider, but the payment row's OWN
    // money drifted. Parity on one axis must not silence the other.
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'SALE-MON',
        amount_cents: 1900,
        created_at: '2026-07-10T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'SALEREF-MON',
        event_type: 'PAYMENT.SALE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-MON': saleObject({ state: 'refunded', total: '25.00' }) },
      saleRefunds: {
        'SALEREF-MON': {
          state: 'completed',
          amount: { currency: 'USD', total: '25.00' },
          sale_id: 'SALE-MON',
        },
      },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-MON',
            status: 'REFUNDED',
            time: '2026-07-23T10:00:00.000Z',
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([]);
    expect(result.missingProviderPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([{
      transactionId: 'SALE-MON',
      guildId: GUILD_ID,
      providerAmountCents: 2500,
      localAmountCents: 1900,
      providerCurrency: 'USD',
      localCurrency: 'USD',
    }]);
  });

  it('flags a terminal fulfillment action stalled past the settlement lag', async () => {
    // The cancellation head and carrier both exist, but the carrier has sat
    // pending since long before the lag cutoff: the bot is the broken
    // component and access was never actually revoked.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['commerce_subscription_lifecycle_heads'] = () => ({
      data: [{
        paypal_subscription_id: 'SUB-1',
        last_event_priority: 60,
        last_provider_event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
        last_webhook_event_id: 'WH-CANCEL',
      }],
      error: null,
    });
    resolvers['bot_action_queue'] = (op) => {
      const wantsStaged = op.filters.some(
        (f) => f.method === 'eq' && f.args[0] === 'status' && f.args[1] === 'staged',
      );
      return {
        data: wantsStaged
          ? []
          : [{
              idempotency_key: 'paypal:lifecycle:WH-CANCEL:subscription_cancelled',
              status: 'pending',
              created_at: IN_WINDOW,
            }],
        error: null,
      };
    };
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'CANCELLED', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_cancelled',
      orderStatus: 'completed',
    }]);
  });

  it('tolerates an in-flight terminal fulfillment action inside the lag', async () => {
    // Same shape, but the carrier was enqueued within the settlement lag:
    // the bot is still legitimately working through the queue.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['commerce_subscription_lifecycle_heads'] = () => ({
      data: [{
        paypal_subscription_id: 'SUB-1',
        last_event_priority: 60,
        last_provider_event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
        last_webhook_event_id: 'WH-CANCEL',
      }],
      error: null,
    });
    resolvers['bot_action_queue'] = (op) => {
      const wantsStaged = op.filters.some(
        (f) => f.method === 'eq' && f.args[0] === 'status' && f.args[1] === 'staged',
      );
      return {
        data: wantsStaged
          ? []
          : [{
              idempotency_key: 'paypal:lifecycle:WH-CANCEL:subscription_cancelled',
              status: 'processing',
              created_at: '2026-07-27T11:50:00.000Z',
            }],
        error: null,
      };
    };
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'CANCELLED', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.unsettledLocalPayments).toEqual([]);
  });

  it('reports an over-refunded ledger behind a fully refunded sale', async () => {
    // The sale is fully refunded at 2500, but the local ledger claims 3000:
    // the status-only fallback used to check only the UNDER direction.
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1', status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [
        {
          id: REF_UUID,
          payment_id: PAY_UUID,
          order_id: ORDER_UUID,
          guild_id: GUILD_ID,
          paypal_refund_id: 'SALEREF-1',
          event_type: 'PAYMENT.SALE.REFUNDED',
          amount_cents: 2500,
          currency: 'USD',
          created_at: IN_WINDOW,
        },
        {
          id: '40000000-0000-4000-8000-000000000099',
          payment_id: PAY_UUID,
          order_id: ORDER_UUID,
          guild_id: GUILD_ID,
          paypal_refund_id: 'SALEREF-2',
          event_type: 'PAYMENT.SALE.REFUNDED',
          amount_cents: 500,
          currency: 'USD',
          created_at: IN_WINDOW,
        },
      ],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'refunded', total: '25.00' }) },
      saleRefunds: {
        'SALEREF-1': {
          state: 'completed',
          amount: { currency: 'USD', total: '25.00' },
          sale_id: 'SALE-1',
        },
        'SALEREF-2': {
          state: 'completed',
          amount: { currency: 'USD', total: '5.00' },
          sale_id: 'SALE-1',
        },
      },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-1',
            status: 'REFUNDED',
            time: IN_WINDOW,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toContainEqual({
      transactionId: 'SALE-1',
      guildId: GUILD_ID,
      providerAmountCents: 2500,
      localAmountCents: 3000,
      providerCurrency: 'USD',
      localCurrency: 'USD',
    });
  });

  it('counts a late-written local row for a settled enumerated refund', async () => {
    // The provider refund settled long ago; its local row was only written
    // during the lag interval (late replay). Dropping the row manufactured
    // a false "missing locally" against the settled sibling.
    const JUST_NOW = '2026-07-27T11:59:30.000Z';
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: JUST_NOW,
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      refunds: { 'REF-1': refundObject({ value: '25.00' }) },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [{
                id: 'CAP-1',
                status: 'REFUNDED',
                amount: { currency_code: 'USD', value: '25.00' },
              }],
              refunds: [{
                id: 'REF-1',
                status: 'COMPLETED',
                amount: { currency_code: 'USD', value: '25.00' },
                create_time: IN_WINDOW,
              }],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.amountMismatches).toEqual([]);
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('counts late-written rows in the status-bound refund fallback', async () => {
    // No enumerable sibling list (the order response lists no refunds), so
    // the capture's own settled REFUNDED status bounds the ledger — and the
    // late-written local row is that refund's evidence.
    const JUST_NOW = '2026-07-27T11:59:30.000Z';
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: JUST_NOW,
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      refunds: { 'REF-1': refundObject({ value: '25.00' }) },
      orders: {
        'PP-ORDER-1': orderObject({
          status: 'COMPLETED',
          captures: [{ id: 'CAP-1', status: 'REFUNDED', value: '25.00' }],
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.amountMismatches).toEqual([]);
    expect(result.missingLocalPayments).toEqual([]);
  });

  // ── PR #409 review round 19 repairs ─────────────────────────────────────

  it('reports settled captures on a cancelled order (late settlement)', async () => {
    // The capture-denied path cancelled the order locally — but a later
    // capture SUCCEEDED at PayPal. The customer's money settled while the
    // ledger says they were never charged.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'cancelled',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: {
        'PP-ORDER-1': orderObject({
          status: 'COMPLETED',
          captures: [{ id: 'CAP-LATE', status: 'COMPLETED', value: '25.00' }],
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([{
      kind: 'payment',
      transactionId: 'CAP-LATE',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: null,
      source: 'order',
      referenceId: 'PP-ORDER-1',
    }]);
    expect(result.missingProviderPayments).toEqual([]);
    expect(result.unsettledLocalPayments).toEqual([]);
  });

  it('stays silent on cancelled orders PayPal also shows unsettled or purged', async () => {
    // Vanished (purged) and CREATED-no-capture provider states agree with
    // the local cancellation: no money moved, nothing to report.
    withLedger({
      orders: [
        {
          id: ORDER_UUID,
          guild_id: GUILD_ID,
          amount_cents: 2500,
          status: 'cancelled',
          created_at: IN_WINDOW,
          paypal_order_id: 'PP-ORDER-GONE',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          guild_id: GUILD_ID,
          amount_cents: 2500,
          status: 'cancelled',
          created_at: IN_WINDOW,
          paypal_order_id: 'PP-ORDER-2',
        },
      ],
    });
    scriptProviderObjects({
      orders: {
        'PP-ORDER-2': orderObject({ status: 'CREATED', captures: [] }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([]);
    expect(result.missingProviderPayments).toEqual([]);
    expect(result.unsettledLocalPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([]);
  });

  it('reports a zero-amount reversal witness whose parent capture is unreversed', async () => {
    // The witness's own refund object 404s (expected for reversals) — but
    // the parent capture still reads COMPLETED: PayPal holds money the
    // terminal local claim says is gone, and silence would bless it.
    withLedger({
      payments: [paymentRow({
        status: 'reversed',
        created_at: '2026-07-10T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: '2026-07-10T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-WITNESS',
        event_type: 'PAYMENT.CAPTURE.REVERSED',
        amount_cents: 0,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'COMPLETED', value: '25.00' }) },
      refunds: {},
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([{
      kind: 'refund',
      orderId: ORDER_UUID,
      orderNumber: null,
      guildId: GUILD_ID,
      paypalPaymentIds: ['REF-WITNESS'],
      amountCents: 0,
      currency: 'USD',
      createdAt: IN_WINDOW,
    }]);
  });

  it('accepts a zero-amount reversal witness whose parent capture is REFUNDED', async () => {
    withLedger({
      payments: [paymentRow({
        status: 'reversed',
        created_at: '2026-07-10T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: '2026-07-10T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [
        {
          id: REF_UUID,
          payment_id: PAY_UUID,
          order_id: ORDER_UUID,
          guild_id: GUILD_ID,
          paypal_refund_id: 'REF-MONEY',
          event_type: 'PAYMENT.CAPTURE.REFUNDED',
          amount_cents: 2500,
          currency: 'USD',
          created_at: IN_WINDOW,
        },
        {
          id: REF2_UUID,
          payment_id: PAY_UUID,
          order_id: ORDER_UUID,
          guild_id: GUILD_ID,
          paypal_refund_id: 'REF-WITNESS',
          event_type: 'PAYMENT.CAPTURE.REVERSED',
          amount_cents: 0,
          currency: 'USD',
          created_at: IN_WINDOW,
        },
      ],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: { 'REF-MONEY': refundObject({ value: '25.00', parentCaptureId: 'CAP-1' }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([]);
    expect(result.missingLocalPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([]);
  });

  it('flags an activation carrier stalled in-progress past the lag', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['bot_action_queue'] = () => ({
      data: [{
        idempotency_key: 'paypal:subscription:SUB-1:fulfill_subscription',
        payload: { order_id: ORDER_UUID },
        status: 'processing',
        created_at: IN_WINDOW,
      }],
      error: null,
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'ACTIVE', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'SUB-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'subscription_activation_unreleased',
      orderStatus: 'completed',
    }]);
  });

  it('tolerates an in-flight activation carrier inside the lag', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['bot_action_queue'] = () => ({
      data: [{
        idempotency_key: 'paypal:subscription:SUB-1:fulfill_subscription',
        payload: { order_id: ORDER_UUID },
        status: 'pending',
        created_at: '2026-07-27T11:50:00.000Z',
      }],
      error: null,
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'ACTIVE', lastPaymentTime: null }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.unsettledLocalPayments).toEqual([]);
  });

  // ── PR #409 review round 20 repairs ─────────────────────────────────────

  it('flags a refunded local pair whose capture is still an ordinary charge', async () => {
    // Access was revoked over a refund PayPal has no trace of: the capture
    // still reads COMPLETED and the customer's money never came back.
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'COMPLETED', value: '25.00' }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'CAP-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'refunded',
      orderStatus: 'refunded',
    }]);
    expect(result.missingProviderPayments).toEqual([]);
  });

  it('flags a refunded subscription sale the provider still calls completed', async () => {
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1', status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'completed', total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: { 'SUB-1': { transactions: [] } },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toContainEqual({
      transactionId: 'SALE-1',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'refunded',
      orderStatus: 'refunded',
    });
  });

  it('fails closed on a subscription sale with no billing agreement', async () => {
    // Ingestion rejects agreement-less subscription sales as malformed; a
    // fetched sale without one is a borrowed/standalone identity and must
    // never verify against the subscription order.
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ billingAgreementId: null }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: IN_WINDOW, lastPaymentValue: '25.00' }),
      },
      subscriptionTransactions: { 'SUB-1': { transactions: [] } },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('judges the parent ledger and money behind an accepted reversal witness', async () => {
    // The witness is legitimate (parent capture REFUNDED) — but the parent
    // row's money drifted AND the reversal's money row never landed. Both
    // must surface; the witness acceptance excuses neither.
    withLedger({
      payments: [paymentRow({
        status: 'reversed',
        amount_cents: 1900,
        created_at: '2026-07-10T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: '2026-07-10T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-WITNESS',
        event_type: 'PAYMENT.CAPTURE.REVERSED',
        amount_cents: 0,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: {},
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toEqual([{
      transactionId: 'CAP-1',
      guildId: GUILD_ID,
      providerAmountCents: 2500,
      localAmountCents: 1900,
      providerCurrency: 'USD',
      localCurrency: 'USD',
    }]);
    expect(result.missingLocalPayments).toEqual([{
      kind: 'refund',
      transactionId: 'CAP-1',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: null,
      source: 'capture',
      referenceId: 'CAP-1',
    }]);
  });

  // ── PR #409 review round 21 repairs ─────────────────────────────────────

  it('rechecks a historical cancelled order and finds its late capture', async () => {
    // Cancelled six weeks ago (far outside the window) — but PayPal later
    // settled a capture whose webhook was lost. The historical sweep must
    // still surface the money.
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'cancelled',
        created_at: '2026-06-15T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-OLD',
      }],
    });
    scriptProviderObjects({
      orders: {
        'PP-ORDER-OLD': orderObject({
          status: 'COMPLETED',
          captures: [{ id: 'CAP-LATE', status: 'COMPLETED', value: '25.00' }],
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([{
      kind: 'payment',
      transactionId: 'CAP-LATE',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: null,
      source: 'order',
      referenceId: 'PP-ORDER-OLD',
    }]);
    expect(result.missingProviderPayments).toEqual([]);
  });

  it('fails closed on an agreement-less sale in the refund lookback', async () => {
    // The lookback is this old completed row's only verification path; an
    // agreement-less refunded sale is a borrowed/standalone identity.
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'SALE-OLD',
        created_at: '2026-07-01T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: {
        'SALE-OLD': saleObject({ state: 'refunded', billingAgreementId: null }),
      },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: { 'SUB-1': { transactions: [] } },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('judges the old sale parent behind an accepted reversal witness', async () => {
    // The witness is legitimate (sale reversed) — but the parent row's
    // money drifted and the reversal money row never landed. The sale-family
    // witness path owes the same judgment the capture path applies.
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'SALE-1',
        status: 'reversed',
        amount_cents: 1900,
        created_at: '2026-07-10T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: '2026-07-10T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'SALEREF-W',
        event_type: 'PAYMENT.SALE.REVERSED',
        amount_cents: 0,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'reversed', total: '25.00' }) },
      saleRefunds: {},
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: { 'SUB-1': { transactions: [] } },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toEqual([{
      transactionId: 'SALE-1',
      guildId: GUILD_ID,
      providerAmountCents: 2500,
      localAmountCents: 1900,
      providerCurrency: 'USD',
      localCurrency: 'USD',
    }]);
    expect(result.missingLocalPayments).toEqual([{
      kind: 'refund',
      transactionId: 'SALE-1',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: null,
      source: 'capture',
      referenceId: 'SALE-1',
    }]);
  });

  it('fails closed on a refund object with no parent up-link', async () => {
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: { 'REF-1': refundObject({ value: '25.00', parentCaptureId: null }) },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider refund identity conflict',
      retriable: false,
    });
  });

  // ── PR #409 review round 22 repairs ─────────────────────────────────────

  it('surfaces parent-money drift in the refund lookback', async () => {
    // The refund ledger fully matches the provider — but the historical
    // payment row itself recorded the wrong amount. The lookback is this
    // row's only provider touch and owes it the money comparison.
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'CAP-OLD',
        amount_cents: 3000,
        created_at: '2026-07-01T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 3000,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-OLD',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-OLD',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: '2026-07-02T10:00:00.000Z',
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-OLD': captureObject({
          status: 'REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-OLD',
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toEqual([{
      transactionId: 'CAP-OLD',
      guildId: GUILD_ID,
      providerAmountCents: 2500,
      localAmountCents: 3000,
      providerCurrency: 'USD',
      localCurrency: 'USD',
    }]);
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('validates the old parent behind a DIRECT sale reversal witness', async () => {
    // The witness (refund id == sale id) judges the aggregate — but the
    // parent row's own money drifted from the fetched sale. Same checks as
    // the non-direct witness path.
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'SALE-1',
        status: 'reversed',
        amount_cents: 1900,
        created_at: '2026-07-10T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: '2026-07-10T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'SALE-1',
        event_type: 'PAYMENT.SALE.REVERSED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'reversed', total: '25.00' }) },
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: { 'SUB-1': { transactions: [] } },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toEqual([{
      transactionId: 'SALE-1',
      guildId: GUILD_ID,
      providerAmountCents: 2500,
      localAmountCents: 1900,
      providerCurrency: 'USD',
      localCurrency: 'USD',
    }]);
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('supports a ledger exactly at the historical scan cap', async () => {
    // 20000 unidentified cancelled rows fill every page to the cap: the
    // overflow PROBE must distinguish exactly-at-cap (supported) from
    // beyond-cap (failure) instead of rejecting the boundary.
    const bulk = Array.from({ length: 20000 }, (_, index) => ({
      id: `20000000-0000-4000-8000-${String(100000000000 + index)}`,
      guild_id: GUILD_ID,
      amount_cents: 100,
      status: 'cancelled',
      created_at: IN_WINDOW,
      paypal_order_id: null,
    }));
    withLedger({ orders: bulk });
    scriptProviderObjects({});

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([]);
    expect(result.missingProviderPayments).toEqual([]);
    expect(result.unsettledLocalPayments).toEqual([]);
  });

  it('fails closed on a historical refund parent attached to a foreign-guild order', async () => {
    // Payment and refund consistently claim guild B while the ORDER belongs
    // to guild A: the refund-to-payment guard alone cannot see it, and the
    // parent predates the window so only the extended relation guard can.
    withLedger({
      payments: [paymentRow({
        guild_id: '222222222222222222',
        created_at: '2026-07-10T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: '222222222222222222',
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
      guildIds: [GUILD_ID, '222222222222222222'],
    });
    scriptProviderObjects({});

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  // ── PR #409 review round 23 repairs ─────────────────────────────────────

  it('fails closed on a lookback payment attached to a foreign-guild order', async () => {
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'CAP-OLD',
        guild_id: '222222222222222222',
        created_at: '2026-07-01T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-OLD',
      }],
      guildIds: [GUILD_ID, '222222222222222222'],
    });
    scriptProviderObjects({});

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('judges each capture only against its own refund siblings', async () => {
    // The order enumerates refunds for TWO captures; capture A's judge must
    // not read capture B's refund as A's missing money.
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-A',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      refunds: { 'REF-A': refundObject({ value: '25.00' }) },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [{
                id: 'CAP-1',
                status: 'REFUNDED',
                amount: { currency_code: 'USD', value: '25.00' },
              }],
              refunds: [
                {
                  id: 'REF-A',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '25.00' },
                  create_time: IN_WINDOW,
                  links: [{
                    rel: 'up',
                    href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP-1',
                  }],
                },
                {
                  id: 'REF-B',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '3.00' },
                  create_time: IN_WINDOW,
                  links: [{
                    rel: 'up',
                    href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP-OTHER',
                  }],
                },
              ],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([]);
  });

  it('refuses the direct-witness shortcut for a REFUNDED row carrying the sale id', async () => {
    // Only PAYMENT.SALE.REVERSED may substitute the sale id for the refund
    // id; a REFUNDED row doing so is malformed identity and must face the
    // real refund endpoint (which cannot produce it).
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1', status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'SALE-1',
        event_type: 'PAYMENT.SALE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'refunded', total: '25.00' }) },
      saleRefunds: {},
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: { 'SUB-1': { transactions: [] } },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toContainEqual({
      kind: 'refund',
      orderId: ORDER_UUID,
      orderNumber: null,
      guildId: GUILD_ID,
      paypalPaymentIds: ['SALE-1'],
      amountCents: 2500,
      currency: 'USD',
      createdAt: IN_WINDOW,
    });
  });

  it('fails closed on an unrecognized provider subscription status', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'SUSPENDED_PENDING_REVIEW', lastPaymentTime: null }),
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'subscription lookup returned a malformed record',
      retriable: false,
    });
  });

  // ── PR #409 review round 24 repairs ─────────────────────────────────────

  it('resolves an unlinked enumerated refund through the standalone endpoint', async () => {
    // Multi-capture order, one enumerated refund without an up-link: the
    // standalone refund object names the parent, and capture A judges clean
    // instead of reading the linkless entry ambiguously.
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-A',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      refunds: { 'REF-A': refundObject({ value: '25.00' }) },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [
                {
                  id: 'CAP-1',
                  status: 'REFUNDED',
                  amount: { currency_code: 'USD', value: '25.00' },
                },
                {
                  id: 'CAP-OTHER',
                  status: 'PENDING',
                  amount: { currency_code: 'USD', value: '5.00' },
                },
              ],
              refunds: [{
                id: 'REF-A',
                status: 'COMPLETED',
                amount: { currency_code: 'USD', value: '25.00' },
                create_time: IN_WINDOW,
              }],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([]);
  });

  it('fails closed when a multi-capture enumeration cannot name a parent', async () => {
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-A',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({
          status: 'REFUNDED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-1',
        }),
      },
      // REF-A is deliberately absent from the standalone registry AND from
      // its own row's verification: the window refund pass would find it,
      // so the enumerated ghost sibling is a different id.
      refunds: { 'REF-A': refundObject({ value: '25.00' }) },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [
                {
                  id: 'CAP-1',
                  status: 'REFUNDED',
                  amount: { currency_code: 'USD', value: '25.00' },
                },
                {
                  id: 'CAP-OTHER',
                  status: 'PENDING',
                  amount: { currency_code: 'USD', value: '5.00' },
                },
              ],
              refunds: [{
                id: 'REF-GHOST',
                status: 'COMPLETED',
                amount: { currency_code: 'USD', value: '3.00' },
                create_time: IN_WINDOW,
              }],
            },
          }],
        },
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order lookup returned a malformed record',
      retriable: false,
    });
  });

  it('fails closed when activation history names a plan the provider omits', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    resolvers['bot_action_queue'] = () => ({
      data: [{
        idempotency_key: 'paypal:subscription:SUB-1:fulfill_subscription',
        payload: { order_id: ORDER_UUID, paypal_plan_id: 'PLAN-1' },
        status: 'completed',
      }],
      error: null,
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'ACTIVE', lastPaymentTime: null }),
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('fails closed on a sale-family refund attached to a capture-backed order', async () => {
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.SALE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      saleRefunds: {
        'REF-1': {
          state: 'completed',
          amount: { currency: 'USD', total: '25.00' },
          sale_id: 'CAP-1',
        },
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider refund identity conflict',
      retriable: false,
    });
  });

  // ── PR #409 review round 25 repairs ─────────────────────────────────────

  it('judges the incomplete ledger behind a terminal fallback row', async () => {
    // The out-of-window row is already refunded — but the provider says the
    // sale is REFUNDED at 2500 and the local ledger holds nothing. Status
    // agreement must not bless a missing aggregate.
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'SALE-MON',
        status: 'refunded',
        created_at: '2026-07-10T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ status: 'CANCELLED', lastPaymentTime: null }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-MON',
            status: 'REFUNDED',
            time: '2026-07-23T10:00:00.000Z',
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toContainEqual({
      kind: 'refund',
      transactionId: 'SALE-MON',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: null,
      source: 'capture',
      referenceId: 'SALE-MON',
    });
  });

  it('fails closed on a capture that omits its related order', async () => {
    withLedger({
      payments: [paymentRow()],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ relatedOrderId: null }) },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'provider identity conflict',
      retriable: false,
    });
  });

  it('fails closed on a settled subscription transaction with no money', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': subscriptionObject({ lastPaymentTime: null }),
      },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-NOMONEY',
            status: 'COMPLETED',
            time: IN_WINDOW,
          }],
        },
      },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'subscription transactions lookup returned a malformed record',
      retriable: false,
    });
  });

  // ── PR #409 review round 26 repairs ─────────────────────────────────────

  it('validates the old terminal parent behind an ordinary refund row', async () => {
    // The window refund row verifies cleanly — but its pre-window reversed
    // parent drifted to 1900 cents. The historical-parent sweep is that
    // row's only provider touch and must surface the drift.
    withLedger({
      payments: [paymentRow({
        status: 'reversed',
        amount_cents: 1900,
        created_at: '2026-07-10T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: '2026-07-10T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: { 'REF-1': refundObject({ value: '25.00' }) },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toEqual([{
      transactionId: 'CAP-1',
      guildId: GUILD_ID,
      providerAmountCents: 2500,
      localAmountCents: 1900,
      providerCurrency: 'USD',
      localCurrency: 'USD',
    }]);
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('fails closed on an unrecognized provider capture status', async () => {
    withLedger({
      payments: [paymentRow()],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'MYSTERY_HOLD' }) },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'capture lookup returned a malformed record',
      retriable: false,
    });
  });

  it('fails closed on unrecognized sale, refund, and order states', async () => {
    // One fixture per parser: unknown provider states must never read as
    // ordinary non-settlement.
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'on_hold' }) },
      subscriptions: { 'SUB-1': subscriptionObject({ lastPaymentTime: null }) },
      subscriptionTransactions: { 'SUB-1': { transactions: [] } },
    });
    expect(await runPayPalReconciliation(supabase as never, OPTS)).toMatchObject({
      status: 'failed',
      reason: 'sale lookup returned a malformed record',
      retriable: false,
    });

    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: { 'REF-1': refundObject({ status: 'ON_HOLD', value: '25.00' }) },
    });
    expect(await runPayPalReconciliation(supabase as never, OPTS)).toMatchObject({
      status: 'failed',
      reason: 'refund lookup returned a malformed record',
      retriable: false,
    });

    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: { 'PP-ORDER-1': orderObject({ status: 'IN_PROGRESS' }) },
    });
    expect(await runPayPalReconciliation(supabase as never, OPTS)).toMatchObject({
      status: 'failed',
      reason: 'order lookup returned a malformed record',
      retriable: false,
    });
  });

  it('fails closed on an unrecognized v1 sale-refund state', async () => {
    withLedger({
      payments: [paymentRow({ paypal_payment_id: 'SALE-1', status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'SALEREF-1',
        event_type: 'PAYMENT.SALE.REFUNDED',
        amount_cents: 2500,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      sales: { 'SALE-1': saleObject({ state: 'refunded', total: '25.00' }) },
      saleRefunds: {
        'SALEREF-1': {
          state: 'on_hold',
          amount: { currency: 'USD', total: '25.00' },
          sale_id: 'SALE-1',
        },
      },
      subscriptions: { 'SUB-1': subscriptionObject({ lastPaymentTime: null }) },
      subscriptionTransactions: { 'SUB-1': { transactions: [] } },
    });

    expect(await runPayPalReconciliation(supabase as never, OPTS)).toMatchObject({
      status: 'failed',
      reason: 'sale refund lookup returned a malformed record',
      retriable: false,
    });
  });

  it('reports a lookback payment whose provider object vanished', async () => {
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'CAP-OLD',
        created_at: '2026-07-01T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-OLD',
      }],
    });
    scriptProviderObjects({});

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([{
      kind: 'payment',
      orderId: ORDER_UUID,
      orderNumber: null,
      guildId: GUILD_ID,
      paypalPaymentIds: ['CAP-OLD'],
      amountCents: 2500,
      currency: 'USD',
      createdAt: '2026-07-01T10:00:00.000Z',
    }]);
  });

  // ── PR #409 review round 27 repairs ─────────────────────────────────────

  it('fails closed on unrecognized embedded order money statuses', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'cancelled',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      orders: {
        'PP-ORDER-1': orderObject({
          status: 'COMPLETED',
          captures: [{ id: 'CAP-X', status: 'MYSTERY_HOLD', value: '25.00' }],
        }),
      },
    });

    expect(await runPayPalReconciliation(supabase as never, OPTS)).toMatchObject({
      status: 'failed',
      reason: 'order lookup returned a malformed record',
      retriable: false,
    });
  });

  it('fails closed on an unrecognized subscription transaction status', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: { 'SUB-1': subscriptionObject({ lastPaymentTime: null }) },
      subscriptionTransactions: {
        'SUB-1': {
          transactions: [{
            id: 'SALE-ODD',
            status: 'ON_HOLD',
            time: IN_WINDOW,
            amount_with_breakdown: {
              gross_amount: { currency_code: 'USD', value: '25.00' },
            },
          }],
        },
      },
    });

    expect(await runPayPalReconciliation(supabase as never, OPTS)).toMatchObject({
      status: 'failed',
      reason: 'subscription transactions lookup returned a malformed record',
      retriable: false,
    });
  });

  it('reports a lookback payment the provider now calls FAILED', async () => {
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'CAP-OLD',
        created_at: '2026-07-01T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-OLD',
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-OLD': captureObject({
          status: 'FAILED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-OLD',
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingProviderPayments).toEqual([{
      kind: 'payment',
      orderId: ORDER_UUID,
      orderNumber: null,
      guildId: GUILD_ID,
      paypalPaymentIds: ['CAP-OLD'],
      amountCents: 2500,
      currency: 'USD',
      createdAt: '2026-07-01T10:00:00.000Z',
    }]);
  });

  it('does not let an unlinked in-flight refund defer another capture', async () => {
    // The fresh unlinked refund belongs to CAP-OTHER (resolved through the
    // standalone endpoint). CAP-1's partial ledger is missing entirely and
    // must surface instead of hiding behind a foreign in-flight deferral.
    const JUST_NOW = '2026-07-27T11:59:30.000Z';
    withLedger({
      payments: [paymentRow()],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({ status: 'PARTIALLY_REFUNDED', value: '25.00' }),
      },
      refunds: {
        'REF-FRESH': refundObject({ value: '3.00', parentCaptureId: 'CAP-OTHER' }),
      },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [
                {
                  id: 'CAP-1',
                  status: 'PARTIALLY_REFUNDED',
                  amount: { currency_code: 'USD', value: '25.00' },
                },
                {
                  id: 'CAP-OTHER',
                  status: 'PENDING',
                  amount: { currency_code: 'USD', value: '5.00' },
                },
              ],
              refunds: [{
                id: 'REF-FRESH',
                status: 'COMPLETED',
                amount: { currency_code: 'USD', value: '3.00' },
                create_time: JUST_NOW,
              }],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.missingLocalPayments).toContainEqual({
      kind: 'refund',
      transactionId: 'CAP-1',
      guildId: GUILD_ID,
      amountCents: 2500,
      currency: 'USD',
      initiatedAt: null,
      source: 'capture',
      referenceId: 'CAP-1',
    });
  });

  it('fails closed on a malformed historical cancelled row', async () => {
    withLedger({
      orders: [
        {
          id: ORDER_UUID,
          guild_id: GUILD_ID,
          amount_cents: 2500,
          status: 'completed',
          created_at: IN_WINDOW,
          paypal_order_id: 'PP-ORDER-1',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          guild_id: '999999999999999999',
          amount_cents: 2500,
          status: 'cancelled',
          created_at: '2026-06-15T10:00:00.000Z',
          paypal_order_id: 'PP-ORDER-GHOST',
        },
      ],
      guildIds: [GUILD_ID],
    });
    scriptProviderObjects({
      orders: { 'PP-ORDER-1': orderObject({ status: 'COMPLETED', captures: [] }) },
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'malformed local PayPal purchase order',
      retriable: false,
    });
  });

  it('fails when a partial refund cannot enumerate its siblings', async () => {
    withLedger({
      payments: [paymentRow()],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-1': captureObject({ status: 'PARTIALLY_REFUNDED', value: '25.00' }),
      },
      orders: {},
    });

    const result = await runPayPalReconciliation(supabase as never, OPTS);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'refund sibling enumeration unavailable: provider order missing',
      retriable: true,
    });
  });

  // ── PR #409 review round 28 repairs ─────────────────────────────────────

  it('fails closed on an advertised last payment with no timestamp', async () => {
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: null,
        paypal_subscription_id: 'SUB-1',
      }],
    });
    scriptProviderObjects({
      subscriptions: {
        'SUB-1': {
          status: 'ACTIVE',
          billing_info: {
            last_payment: {
              amount: { currency_code: 'USD', value: '25.00' },
            },
          },
        },
      },
    });

    expect(await runPayPalReconciliation(supabase as never, OPTS)).toMatchObject({
      status: 'failed',
      reason: 'subscription lookup returned a malformed record',
      retriable: false,
    });
  });

  it('fails closed on a payment identity with no timestamp', async () => {
    withLedger({
      payments: [paymentRow({ created_at: null })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({});

    expect(await runPayPalReconciliation(supabase as never, OPTS)).toMatchObject({
      status: 'failed',
      reason: 'malformed local PayPal payment identity row',
      retriable: false,
    });
  });

  it('defers the full-refund remainder while a sibling is in flight', async () => {
    // RA settled long ago and is judged; RB completed seconds ago and its
    // webhook is in flight. The uncovered remainder belongs to RB — not a
    // missing-refund alert.
    const JUST_NOW = '2026-07-27T11:59:30.000Z';
    withLedger({
      payments: [paymentRow({ status: 'refunded' })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'refunded',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
      refunds: [{
        id: REF_UUID,
        payment_id: PAY_UUID,
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_refund_id: 'REF-A',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 1000,
        currency: 'USD',
        created_at: IN_WINDOW,
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject({ status: 'REFUNDED', value: '25.00' }) },
      refunds: { 'REF-A': refundObject({ value: '10.00' }) },
      orders: {
        'PP-ORDER-1': {
          status: 'COMPLETED',
          purchase_units: [{
            custom_id: IDENTITY_CUSTOM_FIELD,
            payments: {
              captures: [{
                id: 'CAP-1',
                status: 'REFUNDED',
                amount: { currency_code: 'USD', value: '25.00' },
              }],
              refunds: [
                {
                  id: 'REF-A',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '10.00' },
                  create_time: IN_WINDOW,
                  links: [{
                    rel: 'up',
                    href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP-1',
                  }],
                },
                {
                  id: 'REF-B',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '15.00' },
                  create_time: JUST_NOW,
                  links: [{
                    rel: 'up',
                    href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP-1',
                  }],
                },
              ],
            },
          }],
        },
      },
    });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { now: NOW, settlementLagMs: 15 * 60 * 1000 },
    ));

    expect(result.missingLocalPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([]);
  });

  // ── PR #409 review round 29 repairs ─────────────────────────────────────

  it('compares money on a still-completed lookback payment', async () => {
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'CAP-OLD',
        amount_cents: 1500,
        created_at: '2026-07-01T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 1500,
        status: 'completed',
        created_at: '2026-06-01T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-OLD',
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-OLD': captureObject({
          status: 'COMPLETED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-OLD',
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.amountMismatches).toEqual([{
      transactionId: 'CAP-OLD',
      guildId: GUILD_ID,
      providerAmountCents: 2500,
      localAmountCents: 1500,
      providerCurrency: 'USD',
      localCurrency: 'USD',
    }]);
  });

  it('enumerates a settled order past its single known capture', async () => {
    // Capture A's webhook wrote its row; capture B's was lost. The order
    // GET must run despite the known identity and surface B.
    withLedger({
      payments: [paymentRow()],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'completed',
        created_at: IN_WINDOW,
        paypal_order_id: 'PP-ORDER-1',
      }],
    });
    scriptProviderObjects({
      captures: { 'CAP-1': captureObject() },
      orders: {
        'PP-ORDER-1': orderObject({
          status: 'COMPLETED',
          captures: [
            { id: 'CAP-1', status: 'COMPLETED', value: '25.00' },
            { id: 'CAP-B', status: 'COMPLETED', value: '10.00' },
          ],
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.missingLocalPayments).toEqual([{
      kind: 'payment',
      transactionId: 'CAP-B',
      guildId: GUILD_ID,
      amountCents: 1000,
      currency: 'USD',
      initiatedAt: null,
      source: 'order',
      referenceId: 'PP-ORDER-1',
    }]);
  });

  it('reports an unresolved historical row whose capture settled', async () => {
    withLedger({
      payments: [paymentRow({
        paypal_payment_id: 'CAP-OLD',
        status: 'pending',
        created_at: '2026-07-01T10:00:00.000Z',
      })],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 2500,
        status: 'pending',
        created_at: '2026-07-01T10:00:00.000Z',
        paypal_order_id: 'PP-ORDER-OLD',
      }],
    });
    scriptProviderObjects({
      captures: {
        'CAP-OLD': captureObject({
          status: 'COMPLETED',
          value: '25.00',
          relatedOrderId: 'PP-ORDER-OLD',
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    expect(result.unsettledLocalPayments).toEqual([{
      transactionId: 'CAP-OLD',
      guildId: GUILD_ID,
      orderId: ORDER_UUID,
      paymentStatus: 'pending',
      orderStatus: 'pending',
    }]);
  });

  it('propagates a retriable provider fault instead of inventing a verdict', async () => {
    withLedger({ payments: [paymentRow()] });
    scriptProviderObjects({ captures: { 'CAP-1': { __status: 503 } } });

    await expect(runPayPalReconciliation(supabase as never, OPTS)).resolves.toEqual({
      status: 'failed',
      reason: 'capture lookup returned 503',
      retriable: true,
    });
    expect(opsFor('alerts', 'insert')).toEqual([]);
  });

  it('skips when PayPal credentials are not configured', async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    withLedger({ payments: [] });
    // No saved wizard credentials either: the settings table exists and is
    // simply empty, which must read as "not configured", not as a fault.
    resolvers['instance_settings'] = () => ({ data: [], error: null });
    scriptProviderObjects({});

    await expect(runPayPalReconciliation(supabase as never, OPTS)).resolves.toEqual({
      status: 'skipped',
      reason: 'PayPal credentials are not configured',
    });
  });

  it('alerts the divergent guild and resolves the clean one', async () => {
    const secondCustom = JSON.stringify({
      g: SECOND_GUILD_ID,
      p: PRODUCT_UUID,
      c: SECOND_CUSTOMER_UUID,
      d: DISCORD_ID,
    });
    withLedger({
      payments: [
        paymentRow(),
        paymentRow({
          id: PAY2_UUID,
          order_id: '00000000-0000-4000-8000-000000000002',
          guild_id: SECOND_GUILD_ID,
          paypal_payment_id: 'CAP-2',
        }),
      ],
      orders: [
        {
          id: ORDER_UUID,
          guild_id: GUILD_ID,
          amount_cents: 2500,
          status: 'completed',
          created_at: IN_WINDOW,
          paypal_order_id: 'PP-ORDER-1',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          guild_id: SECOND_GUILD_ID,
          customer_id: SECOND_CUSTOMER_UUID,
          amount_cents: 2500,
          status: 'completed',
          created_at: IN_WINDOW,
          paypal_order_id: 'PP-ORDER-2',
        },
      ],
      guildIds: [GUILD_ID, SECOND_GUILD_ID],
    });
    scriptProviderObjects({
      captures: {
        'CAP-2': captureObject({ value: '25.00', relatedOrderId: 'PP-ORDER-2' }),
      },
      orders: {
        'PP-ORDER-2': orderObject({
          customId: secondCustom,
          captures: [{ id: 'CAP-2', value: '25.00' }],
        }),
      },
    });

    const result = completedResult(await runPayPalReconciliation(supabase as never, OPTS));

    // Guild 1's capture AND its order evidence are both unproducible.
    expect(result.missingProviderPayments).toHaveLength(2);
    expect(result.missingProviderPayments.every(
      (finding) => finding.guildId === GUILD_ID,
    )).toBe(true);
    const alertInserts = opsFor('alerts', 'insert');
    expect(alertInserts).toHaveLength(1);
    expect(alertInserts[0]!.payload?.guild_id).toBe(GUILD_ID);
    const resolutions = opsFor('alerts', 'update').filter((op) =>
      filterArgs(op, 'eq').some(
        (args) => args[0] === 'guild_id' && args[1] === SECOND_GUILD_ID,
      ),
    );
    expect(resolutions.length).toBeGreaterThan(0);
  });

  it('scopes the returned findings to resultGuildId while alerting every guild', async () => {
    withLedger({
      payments: [
        paymentRow(),
        paymentRow({
          id: PAY2_UUID,
          order_id: '00000000-0000-4000-8000-000000000002',
          guild_id: SECOND_GUILD_ID,
          paypal_payment_id: 'CAP-2',
        }),
      ],
      orders: [
        {
          id: ORDER_UUID,
          guild_id: GUILD_ID,
          amount_cents: 2500,
          status: 'completed',
          created_at: IN_WINDOW,
          paypal_order_id: 'PP-ORDER-1',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          guild_id: SECOND_GUILD_ID,
          customer_id: SECOND_CUSTOMER_UUID,
          amount_cents: 2500,
          status: 'completed',
          created_at: IN_WINDOW,
          paypal_order_id: 'PP-ORDER-2',
        },
      ],
      guildIds: [GUILD_ID, SECOND_GUILD_ID],
    });
    scriptProviderObjects({ captures: {}, orders: {} });

    const result = completedResult(await runPayPalReconciliation(
      supabase as never,
      { ...OPTS, resultGuildId: SECOND_GUILD_ID },
    ));

    // Each guild diverges on its capture AND its order evidence; the
    // returned scope carries only the second guild's pair.
    expect(result.missingProviderPayments).toHaveLength(2);
    expect(result.missingProviderPayments.every(
      (finding) => finding.guildId === SECOND_GUILD_ID,
    )).toBe(true);
    expect(opsFor('alerts', 'insert')).toHaveLength(2);
  });
});

describe('acquireReconcileLease', () => {
  it.each(['acquired', 'busy', 'cooldown'] as const)(
    'returns the typed %s database result without an application timestamp',
    async (status) => {
      rpcResolvers['paypal_reconcile_acquire'] = () => ({ data: status, error: null });

      await expect(acquireReconcileLease(
        supabase as never,
        '80000000-0000-4000-8000-000000000001',
        120_000,
        21_600_000,
        true,
      )).resolves.toEqual({ status });

      expect(rpcOps[0]).toEqual({
        functionName: 'paypal_reconcile_acquire',
        args: {
          p_owner_token: '80000000-0000-4000-8000-000000000001',
          p_lease_seconds: 120,
          p_cooldown_seconds: 21_600,
          p_bypass_cooldown: true,
        },
      });
      expect(rpcOps[0]!.args).not.toHaveProperty('p_now');
    },
  );

  it('returns a distinct error result when the atomic acquisition RPC fails', async () => {
    rpcResolvers['paypal_reconcile_acquire'] = () => ({
      data: null,
      error: { message: 'storage down' },
    });

    await expect(acquireReconcileLease(
      supabase as never,
      '80000000-0000-4000-8000-000000000001',
      120_000,
      21_600_000,
      false,
    )).resolves.toMatchObject({
      status: 'error',
      reason: expect.stringMatching(/acquisition.*storage down/i),
    });
  });

  it('heartbeats and finalizes with the same opaque owner token', async () => {
    const ownerToken = '80000000-0000-4000-8000-000000000001';

    await expect(
      heartbeatReconcileLease(supabase as never, ownerToken, 120_000),
    ).resolves.toEqual({ ok: true });
    await expect(
      finalizeReconcileLease(supabase as never, ownerToken, true),
    ).resolves.toEqual({ ok: true });

    expect(rpcOps).toEqual([
      {
        functionName: 'paypal_reconcile_heartbeat',
        args: { p_owner_token: ownerToken, p_lease_seconds: 120 },
      },
      {
        functionName: 'paypal_reconcile_finalize',
        args: { p_owner_token: ownerToken, p_succeeded: true },
      },
    ]);
  });

  it('fails closed when an exact-owner heartbeat or finalization is rejected', async () => {
    rpcResolvers['paypal_reconcile_heartbeat'] = () => ({ data: false, error: null });
    rpcResolvers['paypal_reconcile_finalize'] = () => ({ data: false, error: null });
    const ownerToken = '80000000-0000-4000-8000-000000000001';

    await expect(
      heartbeatReconcileLease(supabase as never, ownerToken, 120_000),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/ownership.*lost/i),
    });
    await expect(
      finalizeReconcileLease(supabase as never, ownerToken, false),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/lost ownership/i),
    });
  });

  it('finalizes a provider failure as unsuccessful for immediate retry', async () => {
    scriptProviderObjects({ tokenStatus: 503 });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('failed');
    expect(
      rpcOps.find((op) => op.functionName === 'paypal_reconcile_finalize')?.args,
    ).toMatchObject({ p_succeeded: false });
  });

  it('treats a returned last-result upsert error as a failed pass and releases ownership', async () => {
    scriptProviderObjects({});
    withLedger({});
    resolvers['instance_settings.upsert'] = () => ({
      data: null,
      error: { message: 'bookkeeping down' },
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result).toMatchObject({
      status: 'failed',
      retriable: true,
      reason: expect.stringMatching(/last result/i),
    });
    expect(
      rpcOps.find((op) => op.functionName === 'paypal_reconcile_finalize')?.args,
    ).toMatchObject({ p_succeeded: false });
  });

  it('releases the exact owner when scheduled failure visibility rejects', async () => {
    scriptProviderObjects({ tokenStatus: 503 });
    withLedger({ guildIds: [GUILD_ID, SECOND_GUILD_ID] });
    let activeOwner: string | null = null;
    rpcResolvers['paypal_reconcile_acquire'] = (args) => {
      if (activeOwner !== null) return { data: 'busy', error: null };
      activeOwner = String(args.p_owner_token);
      return { data: 'acquired', error: null };
    };
    rpcResolvers['paypal_reconcile_finalize'] = (args) => {
      const ownsLease = activeOwner === args.p_owner_token;
      if (ownsLease) activeOwner = null;
      return { data: ownsLease, error: null };
    };
    let guildReads = 0;
    resolvers['guild'] = () => {
      guildReads += 1;
      if (guildReads === 1) throw new Error('scheduled visibility transport rejected');
      return {
        data: [{ id: GUILD_ID }, { id: SECOND_GUILD_ID }],
        error: null,
      };
    };

    const result = await runPayPalReconciliation(supabase as never, {
      bypassCooldown: false,
      scheduledVisibility: true,
    });

    expect(result).toMatchObject({
      status: 'failed',
      retriable: true,
      reason: expect.stringMatching(/visibility|transport rejected/i),
    });
    const acquisitions = rpcOps.filter(
      (op) => op.functionName === 'paypal_reconcile_acquire',
    );
    const finalizations = rpcOps.filter(
      (op) => op.functionName === 'paypal_reconcile_finalize',
    );
    expect(finalizations).toHaveLength(1);
    expect(finalizations[0]?.args).toEqual({
      p_owner_token: acquisitions[0]?.args.p_owner_token,
      p_succeeded: false,
    });
    expect(activeOwner).toBeNull();

    const followerToken = '80000000-0000-4000-8000-000000000099';
    await expect(acquireReconcileLease(
      supabase as never,
      followerToken,
      120_000,
      0,
      false,
    )).resolves.toEqual({ status: 'acquired' });
    expect(activeOwner).toBe(followerToken);

    expect(opsFor('instance_settings', 'upsert')).toHaveLength(2);
    const failureAlerts = opsFor('alerts', 'insert')
      .filter((op) => op.payload?.alert_type === RECONCILE_FAILURE_ALERT_TYPE);
    expect(failureAlerts.map((op) => op.payload?.guild_id).sort())
      .toEqual([GUILD_ID, SECOND_GUILD_ID].sort());
  });
});

// ── Route ───────────────────────────────────────────────────────────────────

describe('POST /api/paypal/reconcile', () => {
  function request(headers: Record<string, string> = {}) {
    return new Request('http://localhost/api/paypal/reconcile', {
      method: 'POST',
      headers: { 'x-forwarded-for': '1.2.3.4', ...headers },
    }) as never;
  }

  it('runs a pass for the authenticated owner', async () => {
    scriptProviderObjects({});
    withLedger({});

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, status: 'completed' });
    expect(
      rpcOps.find((op) => op.functionName === 'paypal_reconcile_acquire')?.args,
    ).toMatchObject({ p_bypass_cooldown: true });
    expect(
      rpcOps.find((op) => op.functionName === 'paypal_reconcile_finalize')?.args,
    ).toMatchObject({ p_succeeded: true });
  });

  it('does not let owner run-now overlap an active scheduled owner, regardless of app clock', async () => {
    rpcResolvers['paypal_reconcile_acquire'] = () => ({
      data: 'busy',
      error: null,
    });
    scriptProviderObjects({});
    withLedger({});

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      status: 'skipped',
      reason: expect.stringMatching(/running|active/i),
    });
    expect(providerCalls).toHaveLength(0);
    expect(rpcOps).toEqual([
      expect.objectContaining({
        functionName: 'paypal_reconcile_acquire',
        args: expect.objectContaining({ p_bypass_cooldown: true }),
      }),
    ]);
    expect(rpcOps[0]!.args).not.toHaveProperty('p_now');
  });

  it('reports lease storage failure as retriable instead of skipped contention', async () => {
    rpcResolvers['paypal_reconcile_acquire'] = () => ({
      data: null,
      error: { message: 'lease database unavailable' },
    });
    scriptProviderObjects({});
    withLedger({});

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toMatchObject({
      success: false,
      status: 'failed',
      retriable: true,
      reason: expect.stringMatching(/lease.*unavailable|acquire/i),
    });
    expect(providerCalls).toHaveLength(0);
  });

  it('returns only the authenticated owner guild findings', async () => {
    const secondCustom = JSON.stringify({
      g: SECOND_GUILD_ID,
      p: PRODUCT_UUID,
      c: SECOND_CUSTOMER_UUID,
      d: DISCORD_ID,
    });
    // Each guild's settled order carries a provider capture with no local
    // payment row — one per-object finding per guild. The route derives its
    // window from the real clock, so the fixture anchors on it too.
    const recentCreatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    scriptProviderObjects({
      orders: {
        'OWNER-GUILD-ORDER': orderObject({
          captures: [{ id: 'OWNER-GUILD-FINDING', value: '9.99' }],
        }),
        'OTHER-GUILD-ORDER': orderObject({
          customId: secondCustom,
          captures: [{ id: 'OTHER-GUILD-FINDING', value: '19.99' }],
        }),
      },
    });
    withLedger({
      guildIds: [GUILD_ID, SECOND_GUILD_ID],
      orders: [
        {
          id: ORDER_UUID,
          guild_id: GUILD_ID,
          amount_cents: 999,
          paypal_order_id: 'OWNER-GUILD-ORDER',
          created_at: recentCreatedAt,
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          guild_id: SECOND_GUILD_ID,
          customer_id: SECOND_CUSTOMER_UUID,
          amount_cents: 1999,
          paypal_order_id: 'OTHER-GUILD-ORDER',
          created_at: recentCreatedAt,
        },
      ],
    });

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.missingLocalPayments).toEqual([
      expect.objectContaining({ transactionId: 'OWNER-GUILD-FINDING' }),
    ]);
    expect(JSON.stringify(body)).not.toContain('OTHER-GUILD-FINDING');
    expect(JSON.stringify(body)).not.toContain(SECOND_GUILD_ID);
    // The monitor still performs and alerts the complete cross-guild pass.
    expect(opsFor('alerts', 'insert').map((op) => op.payload?.guild_id).sort())
      .toEqual([GUILD_ID, SECOND_GUILD_ID].sort());
  });

  it('rejects an unauthenticated caller when no scheduler secret is configured', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

    const res = await POST(request({ 'x-reconcile-secret': 'anything' }));

    expect(res.status).toBe(401);
  });

  it('accepts the scheduler secret and takes the shared owner fence', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'super-secret-value';
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });
    scriptProviderObjects({});
    withLedger({});

    const res = await POST(request({ 'x-reconcile-secret': 'super-secret-value' }));

    expect(res.status).toBe(200);
    expect(
      rpcOps.find((op) => op.functionName === 'paypal_reconcile_acquire')?.args,
    ).toMatchObject({ p_bypass_cooldown: false });
  });

  it('lets owner run-now bypass completed cooldown but keeps the scheduler on cadence', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'super-secret-value';
    scriptProviderObjects({});
    withLedger({});
    rpcResolvers['paypal_reconcile_acquire'] = (args) => ({
      data: args.p_bypass_cooldown === true ? 'acquired' : 'cooldown',
      error: null,
    });

    const owner = await POST(request());
    const scheduled = await POST(request({
      'x-reconcile-secret': 'super-secret-value',
    }));

    expect(await owner.json()).toMatchObject({ status: 'completed' });
    expect(await scheduled.json()).toMatchObject({
      status: 'skipped',
      reason: expect.stringMatching(/cooldown|recent/i),
    });
    expect(
      rpcOps
        .filter((op) => op.functionName === 'paypal_reconcile_acquire')
        .map((op) => op.args.p_bypass_cooldown),
    ).toEqual([true, false]);
  });

  it('records and alerts an external scheduler failure before returning it', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'super-secret-value';
    scriptProviderObjects({ tokenStatus: 503 });
    withLedger({ guildIds: [GUILD_ID, SECOND_GUILD_ID] });

    const res = await POST(request({
      'x-reconcile-secret': 'super-secret-value',
    }));

    expect(res.status).toBe(503);
    expect(
      opsFor('instance_settings', 'upsert')
        .some((op) => String(op.payload?.value).includes('"status":"failed"')),
    ).toBe(true);
    const failureAlerts = opsFor('alerts', 'insert')
      .filter((op) => op.payload?.alert_type === RECONCILE_FAILURE_ALERT_TYPE);
    expect(failureAlerts.map((op) => op.payload?.guild_id).sort())
      .toEqual([GUILD_ID, SECOND_GUILD_ID].sort());
  });

  it('durably records an unexpected scheduled rejection and returns a retriable response', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'super-secret-value';
    scriptProviderObjects({ tokenStatus: 503 });
    withLedger({ guildIds: [GUILD_ID, SECOND_GUILD_ID] });
    let guildReads = 0;
    resolvers['guild'] = () => {
      guildReads += 1;
      if (guildReads === 1) throw new Error('unexpected scheduled visibility rejection');
      return {
        data: [{ id: GUILD_ID }, { id: SECOND_GUILD_ID }],
        error: null,
      };
    };

    const res = await POST(request({
      'x-reconcile-secret': 'super-secret-value',
    }));

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
    expect(await res.json()).toMatchObject({
      success: false,
      status: 'failed',
      retriable: true,
    });
    expect(opsFor('instance_settings', 'upsert')).toHaveLength(2);
    const failureAlerts = opsFor('alerts', 'insert')
      .filter((op) => op.payload?.alert_type === RECONCILE_FAILURE_ALERT_TYPE);
    expect(failureAlerts.map((op) => op.payload?.guild_id).sort())
      .toEqual([GUILD_ID, SECOND_GUILD_ID].sort());
  });

  it('resolves scheduler-failure alerts after an external scheduler success', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'super-secret-value';
    scriptProviderObjects({});
    withLedger({ guildIds: [GUILD_ID, SECOND_GUILD_ID] });

    const res = await POST(request({
      'x-reconcile-secret': 'super-secret-value',
    }));

    expect(res.status).toBe(200);
    const failureResolutions = opsFor('alerts', 'update')
      .filter((op) =>
        filterArgs(op, 'eq')
          .some((args) =>
            args[0] === 'alert_type'
            && args[1] === RECONCILE_FAILURE_ALERT_TYPE,
          ),
      );
    expect(failureResolutions).toHaveLength(2);
  });

  it('accepts the scheduler secret as a bearer token', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'super-secret-value';
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });
    scriptProviderObjects({});
    withLedger({});
    resolvers['instance_settings.select'] = () => ({ data: null, error: null });

    const res = await POST(request({ authorization: 'Bearer super-secret-value' }));

    expect(res.status).toBe(200);
  });

  it('rejects a wrong scheduler secret', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'super-secret-value';
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

    const res = await POST(request({ 'x-reconcile-secret': 'wrong-secret-value' }));

    expect(res.status).toBe(401);
  });

  it('answers 503 with Retry-After for a transient provider failure', async () => {
    scriptProviderObjects({ tokenStatus: 503 });
    withLedger({});

    const res = await POST(request());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
  });

  it('answers 500 for a configuration failure a retry cannot fix', async () => {
    withLedger({
      payments: [{
        id: 'pay-1',
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_payment_id: 'CAP-1',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });
    scriptProviderObjects({ captures: { 'CAP-1': { __status: 403 } } });

    const res = await POST(request());

    expect(res.status).toBe(500);
  });
});

describe('GET /api/paypal/reconcile', () => {
  it('reports the last pass summary', async () => {
    resolvers['instance_settings'] = () => ({
      data: { value: JSON.stringify({ ran_at: '2026-07-27T00:00:00.000Z', missing_local: 0 }) },
      error: null,
    });

    const res = await GET(new Request('http://localhost/api/paypal/reconcile') as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      lastRun: { ran_at: '2026-07-27T00:00:00.000Z' },
    });
    expect(body.lastRun).not.toHaveProperty('missing_local');
  });

  it('requires authentication', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

    const res = await GET(new Request('http://localhost/api/paypal/reconcile') as never);

    expect(res.status).toBe(401);
  });
});

describe('scheduled reconciliation failure bookkeeping', () => {
  it('persists the failure and writes one tenant-safe deduped alert per configured guild', async () => {
    withLedger({ guildIds: [GUILD_ID, SECOND_GUILD_ID] });

    await expect(recordScheduledReconciliationFailure(supabase as never, {
      status: 'failed',
      reason: 'transaction search returned 503',
      retriable: true,
    })).resolves.toBe(true);

    const summary = opsFor('instance_settings', 'upsert')[0]!;
    expect(summary.payload).toMatchObject({ key: RECONCILE_LAST_RESULT_KEY });
    expect(String(summary.payload?.value)).toContain('"status":"failed"');

    const alerts = opsFor('alerts', 'insert');
    expect(alerts).toHaveLength(2);
    expect(alerts.map((op) => op.payload?.guild_id).sort())
      .toEqual([GUILD_ID, SECOND_GUILD_ID].sort());
    for (const alert of alerts) {
      expect(alert.payload).toMatchObject({
        alert_type: RECONCILE_FAILURE_ALERT_TYPE,
        severity: 'critical',
      });
      expect(alert.payload?.message).toContain('transaction search returned 503');
      expect(alert.payload?.message).not.toContain(GUILD_ID);
      expect(alert.payload?.message).not.toContain(SECOND_GUILD_ID);
    }
  });

  it('returns false when Supabase returns a bookkeeping error', async () => {
    withLedger({ guildIds: [GUILD_ID] });
    resolvers['instance_settings.upsert'] = () => ({
      data: null,
      error: { message: 'settings unavailable' },
    });

    await expect(recordScheduledReconciliationFailure(supabase as never, {
      status: 'failed',
      reason: 'provider unavailable',
      retriable: true,
    })).resolves.toBe(false);

    expect(opsFor('alerts', 'insert')).toHaveLength(0);
  });
});
