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
  releaseReconcileLease,
  parseAmountToCents,
  fetchProviderTransactions,
  RECONCILE_ALERT_TYPE,
  RECONCILE_FAILURE_ALERT_TYPE,
  RECONCILE_LEASE_KEY,
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

function filterArgs(op: RecordedOp, method: string) {
  return op.filters.filter((f) => f.method === method).map((f) => f.args);
}

// ── PayPal fetch scripting ──────────────────────────────────────────────────

const mockFetch = vi.fn();
let transactionSearchCalls: string[] = [];

interface TxnSpec {
  id: string;
  value: string;
  currency?: string;
  status?: string;
  eventCode?: string;
  customField?: string | null;
  referenceId?: string | null;
  referenceType?: string | null;
}

function txn(spec: TxnSpec) {
  const customField = spec.customField === undefined
    ? JSON.stringify({
        g: GUILD_ID,
        p: PRODUCT_UUID,
        c: CUSTOMER_UUID,
        d: DISCORD_ID,
      })
    : spec.customField;
  return {
    transaction_info: {
      transaction_id: spec.id,
      transaction_status: spec.status ?? 'S',
      transaction_event_code: spec.eventCode ?? 'T0006',
      transaction_initiation_date: '2026-07-20T10:00:00+0000',
      transaction_amount: {
        currency_code: spec.currency ?? 'USD',
        value: spec.value,
      },
      ...(customField === null ? {} : { custom_field: customField }),
      ...(spec.referenceId == null ? {} : { paypal_reference_id: spec.referenceId }),
      ...(spec.referenceType == null ? {} : { paypal_reference_id_type: spec.referenceType }),
    },
  };
}

function scriptPayPal(
  pages: Array<{ transaction_details: unknown[]; total_pages?: number }>,
  options: { tokenStatus?: number; searchStatus?: number } = {},
) {
  let pageIndex = 0;
  mockFetch.mockImplementation(async (url: unknown) => {
    const target = String(url);
    if (target.includes('/v1/oauth2/token')) {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return new Response('{}', { status: options.tokenStatus });
      }
      return new Response(JSON.stringify({ access_token: 'tok-1' }), { status: 200 });
    }
    if (target.includes('/v1/reporting/transactions')) {
      transactionSearchCalls.push(target);
      if (options.searchStatus && options.searchStatus !== 200) {
        return new Response('{}', { status: options.searchStatus });
      }
      const page = pages[Math.min(pageIndex++, pages.length - 1)]!;
      return new Response(
        JSON.stringify({ total_pages: page.total_pages ?? pages.length, ...page }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });
}

const originalEnv = { ...process.env };
let supabase: ReturnType<typeof makeSupabase>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  ops = [];
  transactionSearchCalls = [];
  resolvers = {};
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
  orders?: Array<Record<string, unknown>>;
  customers?: Array<Record<string, unknown>>;
  guildIds?: string[];
  inferOrders?: boolean;
}) {
  const payments = (opts.payments ?? []).map((payment) => ({
    provider: 'paypal',
    ...payment,
  }));
  const explicitOrders = (opts.orders ?? []).map((order) => ({
    order_number: null,
    status: 'completed',
    source: 'purchase',
    currency: 'USD',
    customer_id: CUSTOMER_UUID,
    product_id: PRODUCT_UUID,
    plan_id: null,
    paypal_order_id: `PAYPAL-${String(order.id ?? 'ORDER')}`,
    paypal_subscription_id: null,
    ...order,
  }));
  const explicitIds = new Set(explicitOrders.map((order) => order.id));
  const inferredOrders = opts.inferOrders === false
    ? []
    : payments
      .filter((payment) =>
        typeof payment.order_id === 'string'
        && !explicitIds.has(payment.order_id),
      )
      .map((payment) => ({
        id: payment.order_id,
        order_number: null,
        guild_id: payment.guild_id,
        customer_id: CUSTOMER_UUID,
        product_id: PRODUCT_UUID,
        plan_id: null,
        amount_cents: payment.amount_cents,
        currency: payment.currency ?? 'USD',
        status: 'completed',
        source: 'purchase',
        paypal_order_id: `PAYPAL-${String(payment.order_id)}`,
        paypal_subscription_id: null,
        created_at: payment.created_at,
      }));
  const orders = [...explicitOrders, ...inferredOrders];
  const customers = opts.customers ?? orders
    .filter((order) =>
      typeof order.customer_id === 'string'
      && typeof order.guild_id === 'string',
    )
    .map((order) => ({
      id: order.customer_id,
      guild_id: order.guild_id,
      discord_id: order.customer_discord_id ?? DISCORD_ID,
    }));
  const page = (rows: Array<Record<string, unknown>>, op: RecordedOp) => {
    const range = filterArgs(op, 'range').at(-1);
    if (!range) return rows;
    const [from, to] = range as [number, number];
    return rows.slice(from, to + 1);
  };
  resolvers['payments'] = (op) => ({ data: page(payments, op), error: null });
  resolvers['orders'] = (op) => ({ data: page(orders, op), error: null });
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

describe('fetchProviderTransactions', () => {
  it('paginates and de-duplicates', async () => {
    scriptPayPal([
      { transaction_details: [txn({ id: 'T1', value: '1.00' })], total_pages: 2 },
      {
        transaction_details: [
          txn({ id: 'T1', value: '1.00' }),
          txn({ id: 'T2', value: '2.00' }),
        ],
        total_pages: 2,
      },
    ]);

    const result = await fetchProviderTransactions('https://api', 'tok', 0, 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transactions.map((t) => t.transactionId)).toEqual(['T1', 'T2']);
    expect(transactionSearchCalls).toHaveLength(2);
  });

  it('ignores fees and payouts outside the Checkout/subscription allowlist', async () => {
    scriptPayPal([{
      transaction_details: [
        txn({ id: 'FEE', value: '-0.49', eventCode: 'T0013' }),
        txn({ id: 'PAY', value: '9.99' }),
      ],
      total_pages: 1,
    }]);

    const result = await fetchProviderTransactions('https://api', 'tok', 0, 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transactions.map((t) => t.transactionId)).toEqual(['PAY']);
  });

  it.each([
    {
      label: 'missing transaction id',
      entry: () => {
        const value = txn({ id: 'WILL-BE-REMOVED', value: '9.99' });
        delete (value.transaction_info as Record<string, unknown>).transaction_id;
        return value;
      },
    },
    {
      label: 'non-canonical positive money',
      entry: () => txn({ id: 'BAD-MONEY', value: '9.999' }),
    },
    {
      label: 'invalid currency',
      entry: () => txn({ id: 'BAD-CURRENCY', value: '9.99', currency: 'US' }),
    },
  ])('fails closed on a supported successful record with $label', async ({ entry }) => {
    scriptPayPal([{ transaction_details: [entry()], total_pages: 1 }]);

    const result = await fetchProviderTransactions('https://api', 'tok', 0, 1000);

    expect(result).toMatchObject({
      ok: false,
      retriable: false,
      reason: expect.stringMatching(/malformed supported payment/i),
    });
  });

  it('fails closed on conflicting duplicate provider transaction ids', async () => {
    scriptPayPal([{
      transaction_details: [
        txn({ id: 'DUPLICATE-CONFLICT', value: '9.99' }),
        txn({ id: 'DUPLICATE-CONFLICT', value: '19.99' }),
      ],
      total_pages: 1,
    }]);

    const result = await fetchProviderTransactions('https://api', 'tok', 0, 1000);

    expect(result).toMatchObject({
      ok: false,
      retriable: false,
      reason: expect.stringMatching(/conflicting duplicate/i),
    });
  });

  it('asks PayPal only for successful transactions', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    await fetchProviderTransactions('https://api', 'tok', 0, 1000);
    const query = new URL(transactionSearchCalls[0]!);
    expect(query.searchParams.get('transaction_status')).toBe('S');
    expect(query.searchParams.get('fields')).toBe('transaction_info');
    expect(query.searchParams.get('balance_affecting_records_only')).toBe('Y');
  });

  it('parses only the documented SomniBot payment response shape', async () => {
    const customField = JSON.stringify({
      g: GUILD_ID,
      p: PRODUCT_UUID,
      c: CUSTOMER_UUID,
      d: DISCORD_ID,
    });
    scriptPayPal([{
      transaction_details: [txn({
        id: 'CAPTURE-SHAPED',
        value: '9.99',
        currency: 'usd',
        customField,
        referenceId: 'PAYPAL-ORDER-1',
        referenceType: 'ODR',
      })],
      total_pages: 1,
    }]);

    const result = await fetchProviderTransactions('https://api', 'tok', 0, 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transactions).toEqual([expect.objectContaining({
      transactionId: 'CAPTURE-SHAPED',
      amountCents: 999,
      currency: 'USD',
      eventCode: 'T0006',
      referenceId: 'PAYPAL-ORDER-1',
      referenceType: 'ODR',
      customIdentity: expect.objectContaining({
        guildId: GUILD_ID,
        productId: PRODUCT_UUID,
        customerId: CUSTOMER_UUID,
        discordId: DISCORD_ID,
      }),
    })]);
  });

  it('rejects successful positive transactions outside the Checkout/subscription allowlist', async () => {
    scriptPayPal([{
      transaction_details: [
        txn({ id: 'FOREIGN-TXN', value: '9.99', eventCode: 'T0013' }),
        txn({ id: 'PENDING-TXN', value: '9.99', status: 'P' }),
        txn({ id: 'CHECKOUT-TXN', value: '9.99', eventCode: 'T0006' }),
        txn({ id: 'SUB-TXN', value: '4.99', eventCode: 'T0002' }),
      ],
      total_pages: 1,
    }]);

    const result = await fetchProviderTransactions('https://api', 'tok', 0, 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transactions.map((item) => item.transactionId))
      .toEqual(['CHECKOUT-TXN', 'SUB-TXN']);
  });

  it('reports a missing Transaction Search permission as non-retriable', async () => {
    scriptPayPal([], { searchStatus: 403 });
    const result = await fetchProviderTransactions('https://api', 'tok', 0, 1000);
    expect(result).toMatchObject({ ok: false, retriable: false });
    if (result.ok) return;
    expect(result.reason).toMatch(/Transaction Search/i);
  });

  it('reports a provider outage as retriable', async () => {
    scriptPayPal([], { searchStatus: 503 });
    const result = await fetchProviderTransactions('https://api', 'tok', 0, 1000);
    expect(result).toMatchObject({ ok: false, retriable: true });
  });
});

// ── The diff ────────────────────────────────────────────────────────────────

describe('runPayPalReconciliation', () => {
  it('ignores custom-only provider data even when it matches a durable local order', async () => {
    const mimickedIdentity = JSON.stringify({
      g: GUILD_ID,
      p: PRODUCT_UUID,
      c: CUSTOMER_UUID,
      d: DISCORD_ID,
    });
    scriptPayPal([{
      transaction_details: [txn({
        id: 'FOREIGN-POSITIVE',
        value: '49.99',
        customField: mimickedIdentity,
      })],
      total_pages: 1,
    }]);
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 4999,
        status: 'pending',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.providerTransactions).toBe(0);
    expect(result.missingLocalPayments).toEqual([]);
    expect(opsFor('alerts', 'insert')).toHaveLength(0);
  });

  it('does not let matching custom-only data resolve a settled local finding', async () => {
    scriptPayPal([{
      transaction_details: [txn({
        id: 'CUSTOM-ONLY-COPIED',
        value: '9.99',
      })],
      total_pages: 1,
    }]);
    withLedger({
      orders: [{
        id: ORDER_UUID,
        order_number: 'ORD-CUSTOM-ONLY',
        guild_id: GUILD_ID,
        amount_cents: 999,
        paypal_order_id: null,
        paypal_subscription_id: null,
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.providerTransactions).toBe(0);
    expect(result.missingLocalPayments).toEqual([]);
    expect(result.missingProviderPayments).toEqual([
      expect.objectContaining({ orderId: ORDER_UUID }),
    ]);
    expect(opsFor('alerts', 'insert')).toHaveLength(1);
  });

  it.each([
    {
      label: 'old subscription',
      eventCode: 'T0002',
      referenceType: 'SUB',
      referenceId: 'SUB-OLDER-THAN-WINDOW',
      providerColumn: 'paypal_subscription_id',
    },
    {
      label: 'checkout just before the local window',
      eventCode: 'T0006',
      referenceType: 'ODR',
      referenceId: 'ORDER-BEFORE-WINDOW',
      providerColumn: 'paypal_order_id',
    },
  ])('resolves an exact $label reference outside the creation window', async ({
    eventCode,
    referenceType,
    referenceId,
    providerColumn,
  }) => {
    scriptPayPal([{
      transaction_details: [txn({
        id: `CURRENT-${referenceType}`,
        value: '9.99',
        eventCode,
        customField: null,
        referenceId,
        referenceType,
      })],
      total_pages: 1,
    }]);
    const oldOrder = {
      id: ORDER_UUID,
      order_number: 'ORD-OLD',
      guild_id: GUILD_ID,
      customer_id: CUSTOMER_UUID,
      product_id: PRODUCT_UUID,
      plan_id: eventCode === 'T0002'
        ? '30000000-0000-4000-8000-000000000001'
        : null,
      amount_cents: 999,
      currency: 'USD',
      status: 'completed',
      source: 'purchase',
      paypal_order_id: providerColumn === 'paypal_order_id' ? referenceId : null,
      paypal_subscription_id:
        providerColumn === 'paypal_subscription_id' ? referenceId : null,
      created_at: '2025-01-01T00:00:00.000Z',
    };
    resolvers['payments'] = () => ({ data: [], error: null });
    resolvers['guild'] = () => ({ data: [{ id: GUILD_ID }], error: null });
    resolvers['orders'] = (op) => {
      const exactLookup = filterArgs(op, 'in')
        .some((args) => args[0] === providerColumn && (args[1] as string[]).includes(referenceId));
      return { data: exactLookup ? [oldOrder] : [], error: null };
    };
    resolvers['alerts.update'] = () => ({ data: [], error: null });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.missingLocalPayments).toEqual([
      expect.objectContaining({
        transactionId: `CURRENT-${referenceType}`,
        guildId: GUILD_ID,
      }),
    ]);
    expect(result.missingProviderPayments).toEqual([]);
    expect(
      opsFor('orders', 'select')
        .some((op) => filterArgs(op, 'in').some((args) => args[0] === providerColumn)),
    ).toBe(true);
  });

  it('fails closed on conflicting local payment, reference, and custom tenant identity', async () => {
    const secondOrderId = '00000000-0000-4000-8000-000000000002';
    const conflictingCustom = JSON.stringify({
      g: SECOND_GUILD_ID,
      p: PRODUCT_UUID,
      c: SECOND_CUSTOMER_UUID,
      d: DISCORD_ID,
    });
    scriptPayPal([{
      transaction_details: [txn({
        id: 'CAPTURE-CONFLICT',
        value: '9.99',
        customField: conflictingCustom,
        referenceId: 'PAYPAL-ORDER-GUILD-TWO',
        referenceType: 'ODR',
      })],
      total_pages: 1,
    }]);
    withLedger({
      guildIds: [GUILD_ID, SECOND_GUILD_ID],
      payments: [{
        id: 'payment-guild-one',
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_payment_id: 'CAPTURE-CONFLICT',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
      orders: [
        {
          id: ORDER_UUID,
          guild_id: GUILD_ID,
          customer_id: CUSTOMER_UUID,
          product_id: PRODUCT_UUID,
          amount_cents: 999,
          status: 'completed',
          source: 'purchase',
          paypal_order_id: 'PAYPAL-ORDER-GUILD-ONE',
          created_at: '2026-07-20T10:00:00.000Z',
        },
        {
          id: secondOrderId,
          guild_id: SECOND_GUILD_ID,
          customer_id: SECOND_CUSTOMER_UUID,
          product_id: PRODUCT_UUID,
          amount_cents: 999,
          status: 'completed',
          source: 'purchase',
          paypal_order_id: 'PAYPAL-ORDER-GUILD-TWO',
          created_at: '2026-07-20T10:00:00.000Z',
        },
      ],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result).toMatchObject({
      status: 'failed',
      retriable: false,
      reason: expect.stringMatching(/identity conflict/i),
    });
    expect(opsFor('alerts', 'insert')).toHaveLength(0);
  });

  it('fails closed when exact attribution conflicts with custom discord identity', async () => {
    const wrongDiscordCustom = JSON.stringify({
      g: GUILD_ID,
      p: PRODUCT_UUID,
      c: CUSTOMER_UUID,
      d: '444444444444444444',
    });
    scriptPayPal([{
      transaction_details: [txn({
        id: 'CAPTURE-WRONG-DISCORD',
        value: '9.99',
        customField: wrongDiscordCustom,
      })],
      total_pages: 1,
    }]);
    withLedger({
      payments: [{
        id: 'payment-wrong-discord',
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_payment_id: 'CAPTURE-WRONG-DISCORD',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result).toMatchObject({
      status: 'failed',
      retriable: false,
      reason: expect.stringMatching(/identity conflict/i),
    });
    expect(opsFor('customers', 'select')).toHaveLength(1);
    expect(opsFor('alerts', 'insert')).toHaveLength(0);
  });

  it('attributes a missing local capture through an exact ODR reference', async () => {
    scriptPayPal([{
      transaction_details: [txn({
        id: 'CAPTURE-LOST-BY-REFERENCE',
        value: '9.99',
        customField: null,
        referenceId: 'PAYPAL-ORDER-EXACT',
        referenceType: 'ODR',
      })],
      total_pages: 1,
    }]);
    withLedger({
      orders: [{
        id: ORDER_UUID,
        order_number: 'ORD-REFERENCE',
        guild_id: GUILD_ID,
        customer_id: CUSTOMER_UUID,
        product_id: PRODUCT_UUID,
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        source: 'purchase',
        paypal_order_id: 'PAYPAL-ORDER-EXACT',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.missingLocalPayments).toEqual([
      expect.objectContaining({
        transactionId: 'CAPTURE-LOST-BY-REFERENCE',
        guildId: GUILD_ID,
      }),
    ]);
    // The provider reference proves this exact order exists at PayPal; do not
    // simultaneously claim the same order is missing at the provider.
    expect(result.missingProviderPayments).toEqual([]);
  });

  it('flags a PayPal payment with no local row — the critical direction', async () => {
    const lostOrderId = '00000000-0000-4000-8000-000000000002';
    scriptPayPal([{
      transaction_details: [
        txn({ id: 'CAPTURE-RECORDED', value: '9.99' }),
        txn({
          id: 'CAPTURE-LOST',
          value: '19.99',
          referenceId: 'PAYPAL-ORDER-LOST',
          referenceType: 'ODR',
        }),
      ],
      total_pages: 1,
    }]);
    withLedger({
      payments: [{
        id: 'p1',
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_payment_id: 'CAPTURE-RECORDED',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
      orders: [{
        id: lostOrderId,
        guild_id: GUILD_ID,
        amount_cents: 1999,
        paypal_order_id: 'PAYPAL-ORDER-LOST',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.missingLocalPayments).toEqual([
      expect.objectContaining({ transactionId: 'CAPTURE-LOST', amountCents: 1999 }),
    ]);
    expect(result.alerted).toBe(true);

    const alert = opsFor('alerts', 'insert')[0]!;
    expect(alert.payload).toMatchObject({
      guild_id: GUILD_ID,
      alert_type: RECONCILE_ALERT_TYPE,
      severity: 'critical',
    });
    expect(alert.payload!.message).toContain('CAPTURE-LOST');
    expect(alert.payload!.message).toContain('received nothing');
  });

  it('flags a completed local order PayPal has no record of', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({
      payments: [{
        id: 'p1',
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_payment_id: 'CAPTURE-PHANTOM',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
      orders: [{
        id: ORDER_UUID,
        order_number: 'ORD-1001',
        guild_id: GUILD_ID,
        amount_cents: 999,
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.missingProviderPayments).toEqual([
      expect.objectContaining({ orderId: ORDER_UUID, orderNumber: 'ORD-1001' }),
    ]);
    expect(opsFor('alerts', 'insert')[0]!.payload!.message).toContain('ORD-1001');
  });

  it('flags a completed purchase whose local provider identity write was lost', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({
      orders: [{
        id: ORDER_UUID,
        order_number: 'ORD-NO-PROVIDER-ID',
        guild_id: GUILD_ID,
        customer_id: CUSTOMER_UUID,
        product_id: PRODUCT_UUID,
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        source: 'purchase',
        paypal_order_id: null,
        paypal_subscription_id: null,
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.missingProviderPayments).toEqual([
      expect.objectContaining({
        orderId: ORDER_UUID,
        orderNumber: 'ORD-NO-PROVIDER-ID',
        paypalPaymentIds: [],
      }),
    ]);
  });

  it('includes a legacy null-source order when a PayPal order id proves commerce', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({
      orders: [{
        id: ORDER_UUID,
        order_number: 'ORD-LEGACY-PAYPAL',
        guild_id: GUILD_ID,
        amount_cents: 999,
        source: null,
        paypal_order_id: 'LEGACY-PAYPAL-ORDER',
        paypal_subscription_id: null,
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.missingProviderPayments).toEqual([
      expect.objectContaining({ orderId: ORDER_UUID }),
    ]);
  });

  it('includes a null-source order reached through an exact local PayPal payment', async () => {
    scriptPayPal([{
      transaction_details: [txn({ id: 'LEGACY-CAPTURE', value: '9.99' })],
      total_pages: 1,
    }]);
    withLedger({
      payments: [{
        id: 'legacy-payment',
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_payment_id: 'LEGACY-CAPTURE',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 999,
        source: null,
        paypal_order_id: null,
        paypal_subscription_id: null,
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.providerTransactions).toBe(1);
    expect(result.missingLocalPayments).toEqual([]);
    expect(result.amountMismatches).toEqual([]);
    expect(result.unsettledLocalPayments).toEqual([]);
  });

  it('flags an in-window null-source order proven only by a missing provider payment', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({
      payments: [{
        id: 'legacy-payment-without-provider-match',
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_payment_id: 'LEGACY-CAPTURE-MISSING',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
      orders: [{
        id: ORDER_UUID,
        order_number: 'ORD-LEGACY-MISSING',
        guild_id: GUILD_ID,
        amount_cents: 999,
        source: null,
        paypal_order_id: null,
        paypal_subscription_id: null,
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.missingProviderPayments).toEqual([
      expect.objectContaining({
        orderId: ORDER_UUID,
        paypalPaymentIds: ['LEGACY-CAPTURE-MISSING'],
      }),
    ]);
  });

  it('excludes a null-source order with no durable PayPal evidence', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 999,
        source: null,
        paypal_order_id: null,
        paypal_subscription_id: null,
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.missingProviderPayments).toEqual([]);
  });

  it('fails closed instead of resolving alerts over a malformed local PayPal row', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({
      payments: [{
        id: 'malformed-payment',
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_payment_id: 'contains spaces',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result).toMatchObject({
      status: 'failed',
      retriable: false,
      reason: expect.stringMatching(/malformed local PayPal payment/i),
    });
    expect(opsFor('alerts', 'update')).toHaveLength(0);
  });

  it('scans only settled-capable purchase orders for the local->provider direction', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({});

    await runPayPalReconciliation(supabase as never);

    const orderScan = opsFor('orders', 'select')[0]!;
    expect(filterArgs(orderScan, 'or'))
      .toContainEqual(['source.eq.purchase,source.is.null']);
    expect(filterArgs(orderScan, 'in')).toContainEqual([
      'status',
      ['completed', 'disputed', 'refunded', 'pending', 'pending_review'],
    ]);
  });

  it('restricts local scans to PayPal commerce and excludes free/manual rows', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({
      payments: [{
        id: 'stripe-payment',
        order_id: '00000000-0000-4000-8000-000000000099',
        guild_id: GUILD_ID,
        paypal_payment_id: 'NOT-PAYPAL',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        provider: 'stripe',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
      orders: [
        {
          id: '00000000-0000-4000-8000-000000000098',
          guild_id: GUILD_ID,
          amount_cents: 0,
          source: 'manual',
          status: 'completed',
          paypal_order_id: null,
          created_at: '2026-07-20T10:00:00.000Z',
        },
        {
          id: '00000000-0000-4000-8000-000000000097',
          guild_id: GUILD_ID,
          amount_cents: 0,
          source: 'giveaway',
          status: 'completed',
          paypal_order_id: null,
          created_at: '2026-07-20T10:00:00.000Z',
        },
      ],
      inferOrders: false,
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.localPayments).toBe(0);
    expect(result.missingProviderPayments).toEqual([]);
    const paymentScan = opsFor('payments', 'select')[0]!;
    expect(filterArgs(paymentScan, 'eq')).toContainEqual(['provider', 'paypal']);
    const orderScan = opsFor('orders', 'select')[0]!;
    expect(filterArgs(orderScan, 'or'))
      .toContainEqual(['source.eq.purchase,source.is.null']);
    expect(filterArgs(orderScan, 'gt')).toContainEqual(['amount_cents', 0]);
  });

  it('flags an amount mismatch on a matched pair, in integer cents', async () => {
    scriptPayPal([{
      transaction_details: [txn({ id: 'CAPTURE-1', value: '19.99' })],
      total_pages: 1,
    }]);
    withLedger({
      payments: [{
        id: 'p1',
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_payment_id: 'CAPTURE-1',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.amountMismatches).toEqual([
      expect.objectContaining({
        transactionId: 'CAPTURE-1',
        providerAmountCents: 1999,
        localAmountCents: 999,
      }),
    ]);
    // No false "missing" finding — the pair matched, only the amount diverged.
    expect(result.missingLocalPayments).toEqual([]);
  });

  it('normalizes ISO currency case and flags a currency-only mismatch', async () => {
    scriptPayPal([{
      transaction_details: [
        txn({ id: 'CAPTURE-SAME-CURRENCY', value: '9.99', currency: 'usd' }),
        txn({ id: 'CAPTURE-WRONG-CURRENCY', value: '9.99', currency: 'EUR' }),
      ],
      total_pages: 1,
    }]);
    withLedger({
      payments: [
        {
          id: 'p1',
          order_id: ORDER_UUID,
          guild_id: GUILD_ID,
          paypal_payment_id: 'CAPTURE-SAME-CURRENCY',
          amount_cents: 999,
          currency: 'uSd',
          status: 'completed',
          created_at: '2026-07-20T10:00:00.000Z',
        },
        {
          id: 'p2',
          order_id: '00000000-0000-4000-8000-000000000002',
          guild_id: GUILD_ID,
          paypal_payment_id: 'CAPTURE-WRONG-CURRENCY',
          amount_cents: 999,
          currency: 'USD',
          status: 'completed',
          created_at: '2026-07-20T10:00:00.000Z',
        },
      ],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.amountMismatches).toEqual([
      expect.objectContaining({
        transactionId: 'CAPTURE-WRONG-CURRENCY',
        providerCurrency: 'EUR',
        localCurrency: 'USD',
      }),
    ]);
  });

  it('does not accept a provider transaction against an unsettled local payment/order', async () => {
    scriptPayPal([{
      transaction_details: [txn({ id: 'CAPTURE-PENDING', value: '9.99' })],
      total_pages: 1,
    }]);
    withLedger({
      payments: [{
        id: 'p-pending',
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_payment_id: 'CAPTURE-PENDING',
        amount_cents: 999,
        currency: 'USD',
        status: 'pending',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 999,
        currency: 'USD',
        status: 'pending_review',
        source: 'purchase',
        paypal_order_id: 'PAYPAL-ORDER-PENDING',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.unsettledLocalPayments).toEqual([
      expect.objectContaining({
        transactionId: 'CAPTURE-PENDING',
        guildId: GUILD_ID,
        paymentStatus: 'pending',
        orderStatus: 'pending_review',
      }),
    ]);
    expect(result.amountMismatches).toEqual([]);
  });

  it('partitions alerts by guild without leaking another guild findings', async () => {
    const secondCustom = JSON.stringify({
      g: SECOND_GUILD_ID,
      p: PRODUCT_UUID,
      c: SECOND_CUSTOMER_UUID,
      d: DISCORD_ID,
    });
    scriptPayPal([{
      transaction_details: [
        txn({
          id: 'LOST-GUILD-ONE',
          value: '9.99',
          referenceId: 'PAYPAL-ORDER-GUILD-ONE',
          referenceType: 'ODR',
        }),
        txn({
          id: 'LOST-GUILD-TWO',
          value: '19.99',
          customField: secondCustom,
          referenceId: 'PAYPAL-ORDER-GUILD-TWO',
          referenceType: 'ODR',
        }),
      ],
      total_pages: 1,
    }]);
    withLedger({
      guildIds: [GUILD_ID, SECOND_GUILD_ID],
      orders: [
        {
          id: ORDER_UUID,
          guild_id: GUILD_ID,
          amount_cents: 999,
          paypal_order_id: 'PAYPAL-ORDER-GUILD-ONE',
          created_at: '2026-07-20T10:00:00.000Z',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          guild_id: SECOND_GUILD_ID,
          customer_id: SECOND_CUSTOMER_UUID,
          amount_cents: 1999,
          paypal_order_id: 'PAYPAL-ORDER-GUILD-TWO',
          created_at: '2026-07-20T10:00:00.000Z',
        },
      ],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.alerted).toBe(true);
    const inserts = opsFor('alerts', 'insert');
    expect(inserts).toHaveLength(2);
    const first = inserts.find((op) => op.payload?.guild_id === GUILD_ID)!;
    const second = inserts.find((op) => op.payload?.guild_id === SECOND_GUILD_ID)!;
    expect(first.payload?.message).toContain('LOST-GUILD-ONE');
    expect(first.payload?.message).not.toContain('LOST-GUILD-TWO');
    expect(second.payload?.message).toContain('LOST-GUILD-TWO');
    expect(second.payload?.message).not.toContain('LOST-GUILD-ONE');
  });

  it('reports failure rather than claiming an alert was written when Supabase returns an error', async () => {
    scriptPayPal([{
      transaction_details: [txn({
        id: 'LOST-UNALERTED',
        value: '9.99',
        referenceId: 'PAYPAL-ORDER-UNALERTED',
        referenceType: 'ODR',
      })],
      total_pages: 1,
    }]);
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 999,
        paypal_order_id: 'PAYPAL-ORDER-UNALERTED',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });
    resolvers['alerts.update'] = () => ({ data: null, error: { message: 'alerts down' } });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result).toMatchObject({
      status: 'failed',
      retriable: true,
      reason: expect.stringMatching(/alert/i),
    });
    expect((result as { alerted?: boolean }).alerted).not.toBe(true);
  });

  it('fails closed when the local payment scan would be truncated', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    resolvers['payments'] = (op) => {
      const [from] = (filterArgs(op, 'range').at(-1) ?? [0]) as [number, number];
      const count = from < LOCAL_SCAN_MAX_ROWS ? 1000 : 1;
      return {
        data: Array.from({ length: count }, (_, index) => ({
          id: `p-${from + index}`,
          order_id: null,
          guild_id: GUILD_ID,
          paypal_payment_id: `CAPTURE-${from + index}`,
          amount_cents: 100,
          currency: 'USD',
          status: 'completed',
          provider: 'paypal',
          created_at: '2026-07-20T10:00:00.000Z',
        })),
        error: null,
      };
    };

    const result = await runPayPalReconciliation(supabase as never);

    expect(result).toMatchObject({
      status: 'failed',
      retriable: false,
      reason: expect.stringMatching(/payment scan exceeded/i),
    });
    const ranges = opsFor('payments', 'select').flatMap((op) => filterArgs(op, 'range'));
    expect(ranges.at(-1)).toEqual([LOCAL_SCAN_MAX_ROWS, LOCAL_SCAN_MAX_ROWS]);
  });

  it('raises nothing and resolves the open alert when the ledgers agree', async () => {
    scriptPayPal([{
      transaction_details: [txn({ id: 'CAPTURE-1', value: '9.99' })],
      total_pages: 1,
    }]);
    withLedger({
      payments: [{
        id: 'p1',
        order_id: ORDER_UUID,
        guild_id: GUILD_ID,
        paypal_payment_id: 'CAPTURE-1',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
      orders: [{
        id: ORDER_UUID,
        order_number: 'ORD-1001',
        guild_id: GUILD_ID,
        amount_cents: 999,
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.missingLocalPayments).toEqual([]);
    expect(result.missingProviderPayments).toEqual([]);
    expect(result.alerted).toBe(false);
    expect(opsFor('alerts', 'insert')).toHaveLength(0);

    // A clean pass clears any standing divergence alert.
    const resolveOp = opsFor('alerts', 'update')
      .find((o) => (o.payload as { resolved?: boolean })?.resolved === true);
    expect(resolveOp).toBeDefined();
  });

  it('refreshes the standing alert in place rather than stacking rows', async () => {
    scriptPayPal([{
      transaction_details: [txn({
        id: 'CAPTURE-LOST',
        value: '9.99',
        referenceId: 'PAYPAL-ORDER-LOST',
        referenceType: 'ODR',
      })],
      total_pages: 1,
    }]);
    withLedger({
      orders: [{
        id: ORDER_UUID,
        guild_id: GUILD_ID,
        amount_cents: 999,
        paypal_order_id: 'PAYPAL-ORDER-LOST',
        created_at: '2026-07-20T10:00:00.000Z',
      }],
    });
    resolvers['alerts.update'] = () => ({ data: [{ id: 'alert-1' }], error: null });

    await runPayPalReconciliation(supabase as never);

    expect(opsFor('alerts', 'insert')).toHaveLength(0);
    expect(opsFor('alerts', 'update')).toHaveLength(1);
  });

  it('excludes the settlement lag window so it does not cry wolf', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({});
    const now = Date.parse('2026-07-27T12:00:00.000Z');

    const result = await runPayPalReconciliation(supabase as never, {
      now,
      windowMs: 24 * 60 * 60 * 1000,
      settlementLagMs: 6 * 60 * 60 * 1000,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    // Window ends 6h before "now", not at "now": PayPal's reporting index lags
    // and our own webhook may still be in flight.
    expect(result.windowEnd).toBe('2026-07-27T06:00:00.000Z');
    expect(result.windowStart).toBe('2026-07-26T06:00:00.000Z');

    // Both sides are constrained to the same window.
    const paymentScan = opsFor('payments', 'select')[0]!;
    expect(filterArgs(paymentScan, 'gte')).toContainEqual(['created_at', result.windowStart]);
    expect(filterArgs(paymentScan, 'lte')).toContainEqual(['created_at', result.windowEnd]);
  });

  it('reports a token failure without inventing a divergence', async () => {
    scriptPayPal([], { tokenStatus: 503 });
    withLedger({});

    const result = await runPayPalReconciliation(supabase as never);

    expect(result).toMatchObject({ status: 'failed', retriable: true });
    expect(opsFor('alerts', 'insert')).toHaveLength(0);
  });

  it('skips cleanly when PayPal is not configured at all', async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    // Force the DB-backed config path to return nothing.
    resolvers['instance_settings'] = () => ({ data: [], error: null });

    const result = await runPayPalReconciliation(supabase as never);

    expect(result).toMatchObject({ status: 'skipped' });
  });

  it('does not read or write the in-server coin economy', async () => {
    scriptPayPal([{
      transaction_details: [txn({ id: 'CAPTURE-LOST', value: '9.99' })],
      total_pages: 1,
    }]);
    withLedger({});

    await runPayPalReconciliation(supabase as never);

    const touched = new Set(ops.map((o) => o.table));
    for (const gameTable of [
      'economy_balances', 'economy_transactions', 'shop_items', 'inventory',
    ]) {
      expect(touched.has(gameTable)).toBe(false);
    }
  });
});

// ── Lease ───────────────────────────────────────────────────────────────────

describe('acquireReconcileLease', () => {
  it('inserts the lease row on a first-ever run', async () => {
    resolvers['instance_settings.select'] = () => ({ data: null, error: null });
    resolvers['instance_settings.insert'] = () => ({ data: null, error: null });

    await expect(acquireReconcileLease(supabase as never, 1000, 5000)).resolves.toBe(true);
    expect(opsFor('instance_settings', 'insert')[0]!.payload)
      .toMatchObject({ key: RECONCILE_LEASE_KEY });
  });

  it('refuses when a pass ran inside the lease window', async () => {
    resolvers['instance_settings.select'] = () => ({ data: { value: '4500' }, error: null });

    await expect(acquireReconcileLease(supabase as never, 1000, 5000)).resolves.toBe(false);
    expect(opsFor('instance_settings', 'update')).toHaveLength(0);
  });

  it('claims with a compare-and-set once the lease expires', async () => {
    resolvers['instance_settings.select'] = () => ({ data: { value: '1000' }, error: null });
    resolvers['instance_settings.update'] = () => ({ data: [{ key: RECONCILE_LEASE_KEY }], error: null });

    await expect(acquireReconcileLease(supabase as never, 1000, 5000)).resolves.toBe(true);

    const claim = opsFor('instance_settings', 'update')[0]!;
    // The prior value is part of the predicate — that is what makes it atomic.
    expect(filterArgs(claim, 'eq')).toContainEqual(['value', '1000']);
  });

  it('lets the racing loser skip instead of duplicating the pass', async () => {
    resolvers['instance_settings.select'] = () => ({ data: { value: '1000' }, error: null });
    resolvers['instance_settings.update'] = () => ({ data: [], error: null });

    await expect(acquireReconcileLease(supabase as never, 1000, 5000)).resolves.toBe(false);
  });

  it('fails closed when the lease cannot be read', async () => {
    resolvers['instance_settings.select'] = () => ({ data: null, error: { message: 'boom' } });

    await expect(acquireReconcileLease(supabase as never, 1000, 5000)).resolves.toBe(false);
  });

  it('releases only the lease value owned by this pass', async () => {
    resolvers['instance_settings.update'] = () => ({
      data: [{ key: RECONCILE_LEASE_KEY }],
      error: null,
    });

    await expect(releaseReconcileLease(supabase as never, 5000)).resolves.toBe(true);

    const release = opsFor('instance_settings', 'update')[0]!;
    expect(filterArgs(release, 'eq')).toContainEqual(['key', RECONCILE_LEASE_KEY]);
    expect(filterArgs(release, 'eq')).toContainEqual(['value', '5000']);
  });

  it('promptly releases a claimed lease after a provider failure', async () => {
    scriptPayPal([], { tokenStatus: 503 });
    resolvers['instance_settings.select'] = () => ({ data: null, error: null });
    resolvers['instance_settings.insert'] = () => ({ data: null, error: null });
    resolvers['instance_settings.update'] = () => ({
      data: [{ key: RECONCILE_LEASE_KEY }],
      error: null,
    });

    const result = await runPayPalReconciliation(supabase as never, {
      requireLease: true,
      now: 5000,
    });

    expect(result.status).toBe('failed');
    const release = opsFor('instance_settings', 'update')
      .find((op) => filterArgs(op, 'eq').some((args) => args[0] === 'value'));
    expect(release).toBeDefined();
    expect(filterArgs(release!, 'eq')).toContainEqual(['value', '5000']);
  });

  it('treats a returned last-result upsert error as a failed pass and releases the lease', async () => {
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({});
    resolvers['instance_settings.select'] = () => ({ data: null, error: null });
    resolvers['instance_settings.insert'] = () => ({ data: null, error: null });
    resolvers['instance_settings.upsert'] = () => ({
      data: null,
      error: { message: 'bookkeeping down' },
    });
    resolvers['instance_settings.update'] = () => ({
      data: [{ key: RECONCILE_LEASE_KEY }],
      error: null,
    });

    const result = await runPayPalReconciliation(supabase as never, {
      requireLease: true,
      now: 5000,
    });

    expect(result).toMatchObject({
      status: 'failed',
      retriable: true,
      reason: expect.stringMatching(/last result/i),
    });
    expect(
      opsFor('instance_settings', 'update')
        .some((op) => filterArgs(op, 'eq').some((args) => args[0] === 'value')),
    ).toBe(true);
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
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({});

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, status: 'completed' });
    // An operator pressing "run now" is not blocked by the schedule lease.
    expect(opsFor('instance_settings', 'update')).toHaveLength(0);
  });

  it('returns only the authenticated owner guild findings', async () => {
    const secondCustom = JSON.stringify({
      g: SECOND_GUILD_ID,
      p: PRODUCT_UUID,
      c: SECOND_CUSTOMER_UUID,
      d: DISCORD_ID,
    });
    scriptPayPal([{
      transaction_details: [
        txn({
          id: 'OWNER-GUILD-FINDING',
          value: '9.99',
          referenceId: 'OWNER-GUILD-ORDER',
          referenceType: 'ODR',
        }),
        txn({
          id: 'OTHER-GUILD-FINDING',
          value: '19.99',
          customField: secondCustom,
          referenceId: 'OTHER-GUILD-ORDER',
          referenceType: 'ODR',
        }),
      ],
      total_pages: 1,
    }]);
    withLedger({
      guildIds: [GUILD_ID, SECOND_GUILD_ID],
      orders: [
        {
          id: ORDER_UUID,
          guild_id: GUILD_ID,
          amount_cents: 999,
          paypal_order_id: 'OWNER-GUILD-ORDER',
          created_at: '2026-07-20T10:00:00.000Z',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          guild_id: SECOND_GUILD_ID,
          customer_id: SECOND_CUSTOMER_UUID,
          amount_cents: 1999,
          paypal_order_id: 'OTHER-GUILD-ORDER',
          created_at: '2026-07-20T10:00:00.000Z',
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

  it('accepts the scheduler secret and takes the lease', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'super-secret-value';
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
    withLedger({});
    resolvers['instance_settings.select'] = () => ({ data: null, error: null });
    resolvers['instance_settings.insert'] = () => ({ data: null, error: null });

    const res = await POST(request({ 'x-reconcile-secret': 'super-secret-value' }));

    expect(res.status).toBe(200);
    expect(opsFor('instance_settings', 'insert')[0]!.payload)
      .toMatchObject({ key: RECONCILE_LEASE_KEY });
  });

  it('accepts the scheduler secret as a bearer token', async () => {
    process.env.PAYPAL_RECONCILE_SECRET = 'super-secret-value';
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });
    scriptPayPal([{ transaction_details: [], total_pages: 1 }]);
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
    scriptPayPal([], { tokenStatus: 503 });
    withLedger({});

    const res = await POST(request());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
  });

  it('answers 500 for a configuration failure a retry cannot fix', async () => {
    scriptPayPal([], { searchStatus: 403 });
    withLedger({});

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
    expect(await res.json()).toMatchObject({
      success: true,
      lastRun: { ran_at: '2026-07-27T00:00:00.000Z', missing_local: 0 },
    });
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
