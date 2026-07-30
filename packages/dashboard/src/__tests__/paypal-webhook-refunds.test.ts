/**
 * Refund / reversal semantics for POST /api/paypal/webhook.
 *
 * W2 hardening — differentiated refund handling:
 *  (a) FULL refund  → revoke entitlements + license keys + license sessions;
 *      the terminal entitlement trigger owns Discord revocation atomically.
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
  getPayPalTokenResult: vi.fn().mockResolvedValue({ ok: true, token: 'test-token' }),
  getSubscriptionAmount: vi.fn().mockResolvedValue({
    amountCents: 999,
    currency: 'EUR',
    planId: 'PAYPAL-PLAN-1',
    nextBillingTime: '2026-08-29T00:00:00.000Z',
  }),
  isRetriablePayPalStatus: (status: number) => status >= 500 || status === 429 || status === 408,
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
}));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    paypalWebhook: vi.fn().mockResolvedValue({ limited: false, remaining: 1, retryAfterMs: 0 }),
  },
}));

import { POST } from '@/app/api/paypal/webhook/route';
import { resolveRefundPaymentId } from '@/app/api/paypal/webhook/handlers';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getPayPalTokenResult } from '@/lib/paypal';

const REPLAY_CLAIM_TOKEN = '11111111-1111-4111-8111-111111111111';

function withProviderTime(body: unknown): unknown {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? { create_time: '2026-07-29T00:00:00.000Z', ...body }
    : body;
}

function makeReplay(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/paypal/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-replay-secret': replaySecret,
      'x-replay-claim-token': REPLAY_CLAIM_TOKEN,
      ...headers,
    },
    body: JSON.stringify(withProviderTime(body)),
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
    body: JSON.stringify(withProviderTime(body)),
  });
}

describe('PayPal refund parent identity', () => {
  it('accepts every agreeing canonical v1 sale-refund identity witness', () => {
    expect(resolveRefundPaymentId({
      id: 'REFUND-1',
      sale_id: 'SALE-1',
      capture_id: 'SALE-1',
      links: [{
        rel: 'sale',
        href: 'https://api-m.paypal.com/v1/payments/sale/SALE-1',
      }],
    }, 'PAYMENT.SALE.REFUNDED')).toBe('SALE-1');
  });

  it.each([
    {
      label: 'sale and capture fields conflict',
      resource: { id: 'REFUND-1', sale_id: 'SALE-1', capture_id: 'SALE-2' },
    },
    {
      label: 'sale field and rel=sale link conflict',
      resource: {
        id: 'REFUND-1',
        sale_id: 'SALE-1',
        links: [{
          rel: 'sale',
          href: 'https://api-m.paypal.com/v1/payments/sale/SALE-2',
        }],
      },
    },
    {
      label: 'sale id has surrounding whitespace',
      resource: { id: 'REFUND-1', sale_id: ' SALE-1 ' },
    },
    {
      label: 'sale id has an embedded whitespace character',
      resource: { id: 'REFUND-1', sale_id: 'SALE 1' },
    },
    {
      label: 'schema rejects a non-string sale id',
      resource: { id: 'REFUND-1', sale_id: 123 },
    },
    {
      label: 'an arbitrary sale-looking link is not an identity witness',
      resource: {
        id: 'REFUND-1',
        links: [{
          rel: 'up',
          href: 'https://api-m.paypal.com/v1/payments/sale/SALE-1',
        }],
      },
    },
  ])('rejects malformed or ambiguous sale parent identity: $label', ({ resource }) => {
    expect(resolveRefundPaymentId(
      resource as Record<string, unknown>,
      'PAYMENT.SALE.REFUNDED',
    )).toBeNull();
  });

  it('uses resource.id only for the documented direct reversed-sale shape', () => {
    expect(resolveRefundPaymentId({
      id: 'SALE-REVERSED-1',
      state: 'reversed',
      parent_payment: 'PAY-1',
      links: [
        {
          rel: 'self',
          href: 'https://api-m.paypal.com/v1/payments/sale/SALE-REVERSED-1',
        },
        {
          rel: 'refund',
          href: 'https://api-m.paypal.com/v1/payments/sale/SALE-REVERSED-1/refund',
        },
      ],
    }, 'PAYMENT.SALE.REVERSED')).toBe('SALE-REVERSED-1');

    expect(resolveRefundPaymentId({
      id: 'SALE-REVERSED-1',
      state: 'reversed',
    }, 'PAYMENT.SALE.REVERSED')).toBeNull();
    expect(resolveRefundPaymentId({
      id: 'REFUND-1',
      state: 'reversed',
      parent_payment: 'PAY-1',
    }, 'PAYMENT.SALE.REFUNDED')).toBeNull();
  });

  it('rejects a direct reversed-sale link that contradicts resource.id', () => {
    expect(resolveRefundPaymentId({
      id: 'SALE-REVERSED-1',
      status: 'REVERSED',
      parent_payment: 'PAY-1',
      links: [{
        rel: 'self',
        href: 'https://api-m.paypal.com/v1/payments/sale/SALE-OTHER',
      }],
    }, 'PAYMENT.SALE.REVERSED')).toBeNull();
  });

  it('accepts v1 capture_id and exact rel=capture witnesses', () => {
    expect(resolveRefundPaymentId({
      id: 'REFUND-CAPTURE-1',
      capture_id: 'CAPTURE-1',
      links: [{
        rel: 'capture',
        href: 'https://api-m.paypal.com/v1/payments/capture/CAPTURE-1',
      }],
    }, 'PAYMENT.CAPTURE.REFUNDED')).toBe('CAPTURE-1');
  });

  it('rejects conflicting or noncanonical capture witnesses', () => {
    expect(resolveRefundPaymentId({
      id: 'REFUND-CAPTURE-1',
      capture_id: 'CAPTURE-1',
      supplementary_data: { related_ids: { capture_id: 'CAPTURE-2' } },
    }, 'PAYMENT.CAPTURE.REFUNDED')).toBeNull();
    expect(resolveRefundPaymentId({
      id: 'REFUND-CAPTURE-1',
      capture_id: ' CAPTURE-1 ',
    }, 'PAYMENT.CAPTURE.REFUNDED')).toBeNull();
  });
});

function makeMockSupabase() {
  const fromFn = vi.fn();
  const rpc = vi.fn(async (name: string) => ({
    data: name === 'webhooks_replay_claim_is_current'
      || name === 'webhooks_finish_replay_claim'
      ? true
      : null,
    error: null,
  }));

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
    'gt',
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

interface WebhookRpcOptions {
  record?: Record<string, unknown> | null;
  recordSequence?: Array<Record<string, unknown> | null>;
  recordError?: unknown;
  finalize?: Record<string, unknown> | null;
  finalizeError?: unknown;
  release?: Record<string, unknown> | null;
  releaseError?: unknown;
}

function useWebhookRows(
  rows: Record<string, MockRowResult | MockRowResult[]>,
  rpcOptions: WebhookRpcOptions = {},
) {
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const upserts: Array<{ table: string; payload: unknown }> = [];
  const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];
  const updates: Array<{ table: string; payload: unknown }> = [];
  const inCalls: Array<{ table: string; column: string; values: unknown[] }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tableCallCounts = new Map<string, number>();
  let recordCallCount = 0;
  const tableData = (table: string): Record<string, unknown>[] => {
    const configured = rows[table];
    const results = Array.isArray(configured) ? configured : configured ? [configured] : [];
    return results.flatMap((result) => {
      if (Array.isArray(result.data)) {
        return result.data.filter(
          (value): value is Record<string, unknown> =>
            value !== null && typeof value === 'object' && !Array.isArray(value),
        );
      }
      return result.data !== null
        && typeof result.data === 'object'
        && !Array.isArray(result.data)
        ? [result.data as Record<string, unknown>]
        : [];
    });
  };
  mockSb.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (
      name === 'webhooks_replay_claim_is_current'
      || name === 'webhooks_finish_replay_claim'
    ) {
      return { data: true, error: null };
    }
    rpcCalls.push({ name, args });
    if (name === 'commerce_record_subscription_lifecycle_observation') {
      return {
        data: {
          disposition: 'accepted',
          accepted: true,
          generation: 1,
          webhook_event_id: args.p_webhook_event_id,
          provider_event_type: args.p_provider_event_type,
          provider_occurred_at: args.p_provider_occurred_at,
          provider_paid_through_at: args.p_provider_paid_through_at,
          paypal_subscription_id: args.p_paypal_subscription_id,
          order_id: args.p_order_id,
          guild_id: args.p_guild_id,
          customer_id: args.p_customer_id,
          product_id: args.p_product_id,
          plan_id: args.p_plan_id,
        },
        error: null,
      };
    }
    if (name === 'commerce_record_subscription_sale_or_hold') {
      const order = tableData('orders').find((row) => row.id === args.p_order_id);
      const payment = tableData('payments').find(
        (row) => row.paypal_payment_id === args.p_paypal_payment_id,
      );
      const terminalPaymentStatus =
        payment?.status === 'refunded' || payment?.status === 'reversed'
          ? payment.status
          : 'completed';
      const successorReplay = terminalPaymentStatus !== 'completed';
      const financialMismatch =
        order?.amount_cents !== args.p_amount_cents
        || order?.currency !== args.p_currency;
      const disposition = financialMismatch
        ? 'held_financial_mismatch'
        : successorReplay
          ? 'successor_replay'
          : 'staged';
      return {
        data: {
          disposition,
          fulfillment_allowed: disposition === 'staged',
          paypal_payment_id: args.p_paypal_payment_id,
          paypal_subscription_id: args.p_paypal_subscription_id,
          order_id: args.p_order_id,
          order_number: order?.order_number,
          guild_id: args.p_guild_id,
          customer_id: args.p_customer_id,
          product_id: args.p_product_id,
          plan_id: args.p_plan_id,
          stored_order_amount_cents: order?.amount_cents,
          stored_order_currency: order?.currency,
          provider_payment_amount_cents: args.p_amount_cents,
          provider_payment_currency: args.p_currency,
          payment_id: payment?.id ?? 'payment-router-created',
          payment_created: payment === undefined,
          terminal_payment_status: terminalPaymentStatus,
          action_id: disposition === 'staged' ? 'action-router-created' : null,
          action: disposition === 'staged' ? 'fulfill_subscription' : null,
          action_status: disposition === 'staged' ? 'pending' : null,
          idempotency_key: disposition !== 'staged'
            ? null
            : `paypal:sale:${String(args.p_paypal_payment_id)}:fulfill_subscription_renewal`,
          payload: disposition === 'staged'
            ? { fulfillment_type: 'subscription_renewed' }
            : null,
          hold_reason: financialMismatch ? 'financial_mismatch' : null,
          contract_detail: financialMismatch ? 'provider amount differs from order' : null,
          alert_id: financialMismatch ? 'alert-financial-mismatch' : null,
          alert_type: financialMismatch ? 'commerce_financial_mismatch' : null,
        },
        error: null,
      };
    }
    if (name === 'commerce_create_or_recover_subscription_lifecycle_action') {
      const order = tableData('orders').find((row) => row.id === args.p_order_id);
      const carrier = tableData('bot_action_queue').find(
        (row) => row.idempotency_key
          === `paypal:subscription:${String(args.p_paypal_subscription_id)}:fulfill_subscription`,
      );
      const carrierPayload = carrier?.payload as Record<string, unknown> | undefined;
      const replay = tableData('bot_action_queue').some(
        (row) => row !== carrier && typeof row.id === 'string' && row.id.length > 0,
      );
      return {
        data: {
          disposition: replay ? 'replay' : 'created',
          action_id: 'action-lifecycle-created',
          action_status: 'pending',
          action: args.p_fulfillment_type === 'subscription_cancelled'
            ? 'fulfill_cancellation'
            : 'fulfill_suspension',
          idempotency_key:
            `paypal:lifecycle:${String(args.p_webhook_event_id)}:${String(args.p_fulfillment_type)}`,
          webhook_event_id: args.p_webhook_event_id,
          fulfillment_type: args.p_fulfillment_type,
          guild_id: args.p_guild_id,
          customer_id: args.p_customer_id,
          discord_id: args.p_discord_id,
          product_id: args.p_product_id,
          product_name: carrierPayload?.product_name,
          order_id: args.p_order_id,
          order_number: order?.order_number,
          plan_id: args.p_plan_id,
          paypal_subscription_id: args.p_paypal_subscription_id,
          amount_cents: order?.amount_cents,
          currency: order?.currency,
        },
        error: null,
      };
    }
    if (name === 'bot_action_queue_release_staged') {
      if (rpcOptions.releaseError) return { data: null, error: rpcOptions.releaseError };
      return {
        data: rpcOptions.release === null
          ? null
          : [{
              action_id: args.p_action_id,
              action_status: 'pending',
              disposition: 'released',
              ...rpcOptions.release,
            }],
        error: null,
      };
    }
    if (name === 'commerce_record_paypal_refund_event') {
      if (rpcOptions.recordError) return { data: null, error: rpcOptions.recordError };
      const recordOverride = rpcOptions.recordSequence
        ? rpcOptions.recordSequence[
            Math.min(recordCallCount, rpcOptions.recordSequence.length - 1)
          ]
        : rpcOptions.record;
      recordCallCount += 1;
      const requestedAmount = typeof args.p_refund_amount_cents === 'number'
        ? args.p_refund_amount_cents
        : 1000;
      const amount = typeof recordOverride?.refund_amount_cents === 'number'
        ? recordOverride.refund_amount_cents
        : requestedAmount;
      const cumulative = typeof recordOverride?.cumulative_refunded_cents === 'number'
        ? recordOverride.cumulative_refunded_cents
        : amount;
      return {
        data: recordOverride === null
          ? null
          : {
              payment_id: args.p_payment_id,
              order_id: args.p_order_id,
              paypal_refund_id: args.p_paypal_refund_id,
              event_type: args.p_event_type,
              refund_amount_cents: amount,
              currency: 'USD',
              cumulative_refunded_cents: cumulative,
              full_refund: cumulative === 1000,
              already_recorded: false,
              terminal_witness: cumulative === 1000,
              terminal_history_consistent: true,
              terminal_history_replay: false,
              terminal_payment_status: 'completed',
              partial_audit_recorded: cumulative < 1000,
              partial_alert_recorded: cumulative < 1000,
              ...recordOverride,
            },
        error: null,
      };
    }
    if (name === 'commerce_finalize_paypal_refund_status') {
      if (rpcOptions.finalizeError) return { data: null, error: rpcOptions.finalizeError };
      return {
        data: rpcOptions.finalize === null
          ? null
          : {
              order_id: args.p_order_id,
              payment_id: args.p_payment_id,
              order_status: 'refunded',
              payment_status: args.p_payment_status,
              already_terminal: false,
              audit_recorded: true,
              partial_alerts_resolved: 0,
              ...rpcOptions.finalize,
            },
        error: null,
      };
    }
    return { data: null, error: null };
  });
  mockSb.from.mockImplementation((table: string) => {
    const callCount = tableCallCounts.get(table) ?? 0;
    tableCallCounts.set(table, callCount + 1);
    const tableRows = rows[table] ?? { data: null, error: null };
    const selected = Array.isArray(tableRows)
      ? tableRows[Math.min(callCount, tableRows.length - 1)]
      : tableRows;
    const resolved = table === 'payment_refunds' && Array.isArray(selected.data)
      ? {
          ...selected,
          data: selected.data.map((row, index) => ({
            id: `refund-row-${callCount}-${String(index).padStart(4, '0')}`,
            ...(row as Record<string, unknown>),
          })),
        }
      : selected;

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

  return { inserts, upserts, eqCalls, updates, inCalls, rpcCalls };
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
  paypal_payment_id: 'CAPTURE-1',
  paypal_resource_type: 'capture',
  status: 'completed',
  amount_cents: 1000,
  currency: 'USD',
};

const baseSalePayment = {
  ...basePayment,
  paypal_payment_id: 'SALE-1',
  paypal_resource_type: 'sale',
};

function expectAtomicRefundFinalization(
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>,
  input: {
    status: 'refunded' | 'reversed';
    providerPaymentId?: string;
    resourceType?: 'capture' | 'sale';
  },
) {
  expect(rpcCalls).toContainEqual({
    name: 'commerce_finalize_paypal_refund_status',
    args: expect.objectContaining({
      p_payment_id: 'payment-row-1',
      p_order_id: 'order-1',
      p_guild_id: 'guild-1',
      p_customer_id: 'customer-1',
      p_paypal_payment_id: input.providerPaymentId ?? 'CAPTURE-1',
      p_resource_type: input.resourceType ?? 'capture',
      p_payment_status: input.status,
      p_paypal_refund_id: expect.any(String),
      p_event_type: expect.any(String),
      p_audit_details: expect.any(Object),
    }),
  });
}

function expectAtomicRefundRecord(
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>,
  input: {
    refundId: string;
    eventType: string;
    amountCents: number | null;
    currency: string | null;
    providerPaymentId?: string;
    resourceType?: 'capture' | 'sale';
  },
) {
  expect(rpcCalls).toContainEqual({
    name: 'commerce_record_paypal_refund_event',
    args: {
      p_payment_id: 'payment-row-1',
      p_order_id: 'order-1',
      p_guild_id: 'guild-1',
      p_customer_id: 'customer-1',
      p_paypal_payment_id: input.providerPaymentId ?? 'CAPTURE-1',
      p_resource_type: input.resourceType ?? 'capture',
      p_paypal_refund_id: input.refundId,
      p_event_type: input.eventType,
      p_refund_amount_cents: input.amountCents,
      p_currency: input.currency,
      p_audit_details: expect.any(Object),
    },
  });
}

function completedSaleRenewalContext(input: {
  orderId: string;
  subscriptionId: string;
  saleId: string;
  customerId?: string;
  guildId?: string;
  status?: string;
}) {
  const customerId = input.customerId ?? 'customer-1';
  const guildId = input.guildId ?? 'guild-1';
  const productId = `product-${input.orderId}`;
  const planId = `plan-${input.orderId}`;
  const entitlementId = `entitlement-${input.orderId}`;
  const queueId = `queue-${input.orderId}`;
  const order = {
    id: input.orderId,
    order_number: `ORD-${input.orderId}`,
    customer_id: customerId,
    guild_id: guildId,
    product_id: productId,
    plan_id: planId,
    amount_cents: 999,
    currency: 'EUR',
    status: input.status ?? 'completed',
    source: 'purchase',
    paypal_subscription_id: input.subscriptionId,
    granted_role_ids_snapshot: ['role-1'],
    granted_channel_ids_snapshot: [],
    temporary_role_grants_snapshot: [],
    grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
  };
  const payload = {
    fulfillment_type: 'subscription_renewed',
    guild_id: guildId,
    customer_id: customerId,
    discord_id: 'discord-1',
    product_id: productId,
    product_name: 'Subscription Product',
    order_id: input.orderId,
    order_number: order.order_number,
    plan_id: planId,
    paypal_subscription_id: input.subscriptionId,
    amount_cents: 999,
    currency: 'EUR',
    granted_role_ids: ['role-1'],
    granted_channel_ids: [],
    entitlement_type: 'subscription',
    existing_entitlement_id: entitlementId,
  };
  const idempotencyKey = `paypal:sale:${input.saleId}:fulfill_subscription_renewal`;
  return {
    order,
    payload,
    rows: {
      orders: { data: order, error: null },
      customers: {
        data: { id: customerId, guild_id: guildId, discord_id: 'discord-1' },
        error: null,
      },
      products: {
        data: { id: productId, name: 'Subscription Product' },
        error: null,
      },
      entitlements: {
        data: {
          id: entitlementId,
          guild_id: guildId,
          customer_id: customerId,
          order_id: input.orderId,
          product_id: productId,
          plan_id: planId,
          type: 'subscription',
          status: 'grace_period',
          source: 'purchase',
          granted_role_ids: ['role-1'],
          granted_channel_ids: [],
        },
        error: null,
      },
      bot_action_queue: [
        { data: null, error: null },
        {
          data: {
            id: queueId,
            guild_id: guildId,
            action: 'fulfill_subscription',
            payload,
            status: 'staged',
            idempotency_key: idempotencyKey,
          },
          error: null,
        },
        { data: { id: queueId }, error: null },
      ],
    },
  };
}

describe('PayPal webhook — full refund semantics', () => {
  it('full capture refund revokes durable access and delegates roles to the atomic trigger', async () => {
    const { inserts, updates, inCalls, rpcCalls, eqCalls } = useWebhookRows({
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
        { data: null, error: null }, // terminal entitlement update
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

    expectAtomicRefundRecord(rpcCalls, {
      refundId: 'REFUND-FULL-1',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      amountCents: 1000,
      currency: 'USD',
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
      ]),
    );
    expectAtomicRefundFinalization(rpcCalls, { status: 'refunded' });
    expect(updates.filter(({ table }) => table === 'orders' || table === 'payments')).toEqual([]);
    expect(inCalls).toContainEqual({
      table: 'license_sessions',
      column: 'license_key_id',
      values: ['license-1', 'license-2'],
    });
    for (const table of ['entitlements', 'license_keys']) {
      expect(eqCalls).toContainEqual({
        table,
        column: 'guild_id',
        value: 'guild-1',
      });
      expect(eqCalls).toContainEqual({
        table,
        column: 'customer_id',
        value: 'customer-1',
      });
    }

    expect(inserts).not.toContainEqual(
      expect.objectContaining({
        table: 'bot_action_queue',
        payload: expect.objectContaining({ action: 'revoke_roles' }),
      }),
    );

    // The exact audit is committed inside the same RPC as the parent/child
    // status transition, so a crash cannot duplicate it.
    expect(rpcCalls).toContainEqual({
      name: 'commerce_finalize_paypal_refund_status',
      args: expect.objectContaining({
        p_paypal_refund_id: 'REFUND-FULL-1',
        p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
        p_audit_details: expect.objectContaining({
          refund_amount_cents: 1000,
          payment_amount_cents: 1000,
          entitlement_ids: ['entitlement-1'],
          license_key_ids: ['license-1', 'license-2'],
          role_revocation_source: 'entitlement_status_trigger',
        }),
      }),
    });
    expect(inserts.filter(({ table }) => table === 'audit_logs')).toEqual([]);
  });

  it('uses the serialized ledger result as the sole cumulative full-refund proof', async () => {
    const { rpcCalls } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      entitlements: [{ data: [], error: null }, { data: null, error: null }],
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
    }, {
      record: {
        refund_amount_cents: 1,
        cumulative_refunded_cents: 1000,
        full_refund: true,
      },
    });
    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-PAGE-501',
        amount: { value: '0.01', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REFUND-PAGE-501',
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expectAtomicRefundFinalization(rpcCalls, { status: 'refunded' });
  });

  it.each([
    ['database error', { recordError: { message: 'ledger unavailable' } }],
    ['missing proof', { record: null }],
    ['mismatched proof', { record: { payment_id: 'wrong-payment' } }],
  ] as const)('fails before access mutation when atomic refund recording returns %s', async (
    _label,
    rpcOptions,
  ) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { updates, inserts, rpcCalls } = useWebhookRows({
        payments: { data: basePayment, error: null },
      }, rpcOptions);
      const req = makeReplay({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: `REFUND-RECORD-${_label.replaceAll(' ', '-').toUpperCase()}`,
          amount: { value: '10.00', currency_code: 'USD' },
          supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
        },
        id: `EVT-RECORD-${_label.replaceAll(' ', '-').toUpperCase()}`,
      });

      const res = await POST(req as never);
      expect(res.status).toBe(500);
      expect(rpcCalls.map(({ name }) => name)).toEqual(['commerce_record_paypal_refund_event']);
      expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
      expect(inserts).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    {
      label: 'full refund',
      amount: '10.00',
      record: {
        refund_amount_cents: 1000,
        cumulative_refunded_cents: 1000,
        full_refund: true,
        terminal_witness: true,
        terminal_history_consistent: false,
      },
    },
    {
      label: 'partial refund',
      amount: '2.50',
      record: {
        refund_amount_cents: 250,
        cumulative_refunded_cents: 250,
        full_refund: false,
        terminal_witness: false,
        terminal_history_consistent: false,
      },
    },
  ] as const)(
    'fails before access or finalizer effects when $label history proof is false',
    async ({ label, amount, record }) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { updates, inserts, rpcCalls } = useWebhookRows({
          payments: [{ data: basePayment, error: null }, { data: null, error: null }],
          entitlements: [{ data: [], error: null }, { data: null, error: null }],
          license_keys: [{ data: [], error: null }, { data: null, error: null }],
        }, { record });
        const suffix = label.replaceAll(' ', '-').toUpperCase();
        const res = await POST(makeReplay({
          event_type: 'PAYMENT.CAPTURE.REFUNDED',
          resource: {
            id: `REFUND-FALSE-HISTORY-${suffix}`,
            amount: { value: amount, currency_code: 'USD' },
            supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
          },
          id: `EVT-FALSE-HISTORY-${suffix}`,
        }) as never);

        expect(res.status).toBe(500);
        expect(rpcCalls.map(({ name }) => name)).toEqual([
          'commerce_record_paypal_refund_event',
        ]);
        expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
        expect(inserts).toEqual([]);
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each([
    {
      label: 'new refund with a zero returned event amount',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-ZERO-RETURNED-AMOUNT',
        amount: { value: '2.50', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      record: {
        refund_amount_cents: 0,
        cumulative_refunded_cents: 0,
        full_refund: false,
        terminal_witness: false,
      },
    },
    {
      label: 'replayed refund with a smaller returned event amount',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-REPLAY-SMALLER-RETURNED-AMOUNT',
        amount: { value: '2.50', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      record: {
        already_recorded: true,
        refund_amount_cents: 100,
        cumulative_refunded_cents: 100,
        full_refund: false,
        terminal_witness: false,
      },
    },
    {
      label: 'new supplied reversal with a smaller returned event amount',
      eventType: 'PAYMENT.CAPTURE.REVERSED',
      resource: {
        id: 'REVERSAL-SMALLER-RETURNED-AMOUNT',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      record: {
        refund_amount_cents: 500,
        cumulative_refunded_cents: 1000,
        full_refund: true,
        terminal_witness: true,
      },
    },
    {
      label: 'replayed supplied reversal with a zero returned event amount',
      eventType: 'PAYMENT.CAPTURE.REVERSED',
      resource: {
        id: 'REVERSAL-REPLAY-ZERO-RETURNED-AMOUNT',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      record: {
        already_recorded: true,
        refund_amount_cents: 0,
        cumulative_refunded_cents: 1000,
        full_refund: true,
        terminal_witness: true,
      },
    },
    {
      label: 'cumulative total below the returned event amount',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-CUMULATIVE-BELOW-EVENT',
        amount: { value: '2.50', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      record: {
        refund_amount_cents: 250,
        cumulative_refunded_cents: 100,
        full_refund: false,
        terminal_witness: false,
      },
    },
  ] as const)(
    'rejects malformed atomic event money proof: $label',
    async ({ eventType, resource, record }) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { updates, inserts, rpcCalls } = useWebhookRows({
          payments: [{ data: basePayment, error: null }, { data: null, error: null }],
          entitlements: [{ data: [], error: null }, { data: null, error: null }],
          license_keys: [{ data: [], error: null }, { data: null, error: null }],
        }, { record });
        const res = await POST(makeReplay({
          event_type: eventType,
          resource,
          id: `EVT-${resource.id}`,
        }) as never);

        expect(res.status).toBe(500);
        expect(rpcCalls.map(({ name }) => name)).toEqual([
          'commerce_record_paypal_refund_event',
        ]);
        expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
        expect(inserts).toEqual([]);
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it('full refund emits no legacy partial queue for shared or suspended role owners', async () => {
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
          data: [{ status: 'suspended', granted_role_ids: ['role-shared', 'role-other'] }],
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
    expect(inserts).not.toContainEqual(
      expect.objectContaining({
        table: 'bot_action_queue',
        payload: expect.objectContaining({ action: 'revoke_roles' }),
      }),
    );
  });

  it('capture reversal with omitted money uses the atomic ledger canonical amount', async () => {
    const { updates, rpcCalls } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      entitlements: [
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REVERSED',
      resource: {
        id: 'REVERSAL-1',
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REVERSAL-MISSING-AMOUNT',
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
      ]),
    );
    expectAtomicRefundRecord(rpcCalls, {
      refundId: 'REVERSAL-1',
      eventType: 'PAYMENT.CAPTURE.REVERSED',
      amountCents: null,
      currency: null,
    });
    expectAtomicRefundFinalization(rpcCalls, { status: 'reversed' });
  });

  it('accepts an omitted-money reversal whose canonical remaining amount is zero', async () => {
    const { rpcCalls } = useWebhookRows({
      payments: [{ data: basePayment, error: null }, { data: null, error: null }],
      entitlements: [{ data: [], error: null }, { data: null, error: null }],
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
    }, {
      record: {
        refund_amount_cents: 0,
        cumulative_refunded_cents: 1000,
        full_refund: true,
        terminal_witness: true,
      },
    });

    const res = await POST(makeReplay({
      event_type: 'PAYMENT.CAPTURE.REVERSED',
      resource: {
        id: 'REVERSAL-ZERO-REMAINING',
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-REVERSAL-ZERO-REMAINING',
    }) as never);

    expect(res.status).toBe(200);
    expectAtomicRefundFinalization(rpcCalls, { status: 'reversed' });
  });

  it('refund in a different currency fails before ledger or access mutation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { inserts, rpcCalls } = useWebhookRows({
      payments: { data: basePayment, error: null },
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
    expect(res.status).toBe(500);
    expect(rpcCalls).toEqual([]);
    expect(inserts).toEqual([]);
    errorSpy.mockRestore();
  });

  it('partial refund becomes full once PayPal cumulative total covers the payment', async () => {
    const { rpcCalls } = useWebhookRows({
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
    }, {
      record: {
        refund_amount_cents: 250,
        cumulative_refunded_cents: 1000,
        full_refund: true,
      },
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
    expectAtomicRefundFinalization(rpcCalls, { status: 'refunded' });
  });

  it('full refund does not mark the payment refunded when entitlement revocation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rpcCalls } = useWebhookRows({
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
    expect(rpcCalls.map(({ name }) => name)).toEqual([
      'commerce_record_paypal_refund_event',
    ]);
    errorSpy.mockRestore();
  });

  it('full refund no longer performs a second legacy role queue insert', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rpcCalls } = useWebhookRows({
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
    expect(res.status).toBe(200);
    expectAtomicRefundFinalization(rpcCalls, { status: 'refunded' });
    errorSpy.mockRestore();
  });

  it('returns 500 when the atomic refund finalizer fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      useWebhookRows({
        payments: { data: basePayment, error: null },
        payment_refunds: [
          { data: null, error: null },
          { data: [{ amount_cents: 1000 }], error: null },
        ],
        entitlements: [{ data: [], error: null }, { data: null, error: null }],
        license_keys: [{ data: [], error: null }, { data: null, error: null }],
        audit_logs: { data: null, error: null },
      }, {
        finalizeError: { message: 'atomic finalizer unavailable' },
      });

      const res = await POST(makeReplay({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: 'REFUND-ATOMIC-ERROR',
          amount: { value: '10.00', currency_code: 'USD' },
          supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
        },
        id: 'EVT-REFUND-ATOMIC-ERROR',
      }) as never);

      expect(res.status).toBe(500);
      expect(mockSb.rpc).toHaveBeenCalledWith(
        'commerce_finalize_paypal_refund_status',
        expect.objectContaining({
          p_payment_id: 'payment-row-1',
          p_order_id: 'order-1',
          p_payment_status: 'refunded',
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    ['missing proof', null],
    [
      'mismatched proof',
      {
        order_id: 'wrong-order',
        payment_id: 'payment-row-1',
        order_status: 'refunded',
        payment_status: 'refunded',
        already_terminal: false,
      },
    ],
  ])('returns 500 when the atomic refund finalizer returns %s', async (_label, proof) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      useWebhookRows({
        payments: { data: basePayment, error: null },
        payment_refunds: [
          { data: null, error: null },
          { data: [{ amount_cents: 1000 }], error: null },
        ],
        entitlements: [{ data: [], error: null }, { data: null, error: null }],
        license_keys: [{ data: [], error: null }, { data: null, error: null }],
        audit_logs: { data: null, error: null },
      }, { finalize: proof });

      const res = await POST(makeReplay({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: `REFUND-ATOMIC-${String(_label).toUpperCase().replaceAll(' ', '-')}`,
          amount: { value: '10.00', currency_code: 'USD' },
          supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
        },
        id: `EVT-REFUND-ATOMIC-${String(_label).toUpperCase().replaceAll(' ', '-')}`,
      }) as never);

      expect(res.status).toBe(500);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    {
      label: 'refunded target as reversed',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      targetStatus: 'refunded',
      returnedStatus: 'reversed',
      resource: {
        id: 'REFUND-FINALIZER-RETURNED-REVERSED',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
    },
    {
      label: 'reversed target as refunded',
      eventType: 'PAYMENT.CAPTURE.REVERSED',
      targetStatus: 'reversed',
      returnedStatus: 'refunded',
      resource: {
        id: 'REVERSAL-FINALIZER-RETURNED-REFUNDED',
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
    },
  ] as const)(
    'rejects an atomic finalizer that reports $label',
    async ({ eventType, targetStatus, returnedStatus, resource }) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { rpcCalls } = useWebhookRows({
          payments: { data: basePayment, error: null },
          entitlements: [{ data: [], error: null }, { data: null, error: null }],
          license_keys: [{ data: [], error: null }, { data: null, error: null }],
        }, {
          finalize: { payment_status: returnedStatus },
        });

        const res = await POST(makeReplay({
          event_type: eventType,
          resource,
          id: `EVT-${resource.id}`,
        }) as never);

        expect(res.status).toBe(500);
        expectAtomicRefundFinalization(rpcCalls, { status: targetStatus });
      } finally {
        errorSpy.mockRestore();
      }
    },
  );
});

describe('PayPal webhook — partial refund semantics', () => {
  it.each([
    '10oops',
    '1e1',
    '10.001',
    '90071992547409.92',
    '010.00',
    '-10.00',
    ' 10.00',
  ])('rejects noncanonical capture refund money %j before the atomic ledger', async (value) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rpcCalls, inserts, updates } = useWebhookRows({
        payments: { data: basePayment, error: null },
      });
      const req = makeReplay({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: 'REFUND-INVALID-MONEY',
          amount: { value, currency_code: 'USD' },
          supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
        },
        id: `EVT-REFUND-INVALID-MONEY-${value}`,
      });

      const res = await POST(req as never);
      expect(res.status).toBe(500);
      expect(rpcCalls).toEqual([]);
      expect(inserts).toEqual([]);
      expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('lets the signed atomic ledger adopt a legacy null capture resource type', async () => {
    const { rpcCalls } = useWebhookRows({
      payments: {
        data: { ...basePayment, paypal_resource_type: null },
        error: null,
      },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-LEGACY-NULL-CAPTURE',
        amount: { value: '2.50', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-LEGACY-NULL-CAPTURE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expectAtomicRefundRecord(rpcCalls, {
      refundId: 'REFUND-LEGACY-NULL-CAPTURE',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      amountCents: 250,
      currency: 'USD',
    });
  });

  it('canonicalizes a legacy lowercase stored payment currency under the ledger lock', async () => {
    const { rpcCalls } = useWebhookRows({
      payments: {
        data: { ...basePayment, currency: 'usd' },
        error: null,
      },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-LEGACY-LOWERCASE-CURRENCY',
        amount: { value: '2.50', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-LEGACY-LOWERCASE-CURRENCY',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expectAtomicRefundRecord(rpcCalls, {
      refundId: 'REFUND-LEGACY-LOWERCASE-CURRENCY',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      amountCents: 250,
      currency: 'USD',
    });
  });

  it('partial capture refund keeps access and raises an operator-review alert', async () => {
    const { inserts, updates, rpcCalls } = useWebhookRows({
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

    expectAtomicRefundRecord(rpcCalls, {
      refundId: 'REFUND-PARTIAL-1',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      amountCents: 250,
      currency: 'USD',
    });

    expect(rpcCalls).toContainEqual({
      name: 'commerce_record_paypal_refund_event',
      args: expect.objectContaining({
        p_audit_details: expect.objectContaining({ source: 'paypal_webhook' }),
      }),
    });
    expect(inserts.filter(({ table }) => table === 'alerts' || table === 'audit_logs')).toEqual([]);
  });

  it('sale refund with negative amount is treated as partial by absolute value', async () => {
    const { inserts, updates, rpcCalls } = useWebhookRows({
      payments: { data: baseSalePayment, error: null },
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
    expectAtomicRefundRecord(rpcCalls, {
      refundId: 'REFUND-SALE-NEG',
      eventType: 'PAYMENT.SALE.REFUNDED',
      amountCents: 500,
      currency: 'USD',
      providerPaymentId: 'SALE-1',
      resourceType: 'sale',
    });
    expect(inserts.filter(({ table }) => table === 'alerts' || table === 'audit_logs')).toEqual([]);
  });

  it('atomic partial replay treats existing audit and alert as dedupe success', async () => {
    const { inserts, rpcCalls } = useWebhookRows({
      payments: { data: basePayment, error: null },
      payment_refunds: [
        { data: null, error: null },
        { data: [{ amount_cents: 250 }], error: null },
      ],
      alerts: { data: null, error: null },
      audit_logs: { data: null, error: null },
    }, {
      record: {
        already_recorded: true,
        partial_audit_recorded: false,
        partial_alert_recorded: false,
      },
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
    expect(rpcCalls.map(({ name }) => name)).toEqual(['commerce_record_paypal_refund_event']);
    expect(inserts.filter(({ table }) => table === 'alerts' || table === 'audit_logs')).toEqual([]);
  });
});

describe('PayPal webhook — refund idempotency', () => {
  it.each([
    {
      paymentStatus: 'refunded',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-REPLAY',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
    },
    {
      paymentStatus: 'reversed',
      eventType: 'PAYMENT.CAPTURE.REVERSED',
      resource: {
        id: 'REVERSAL-REPLAY',
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
    },
  ] as const)('terminal $paymentStatus replay requires its exact existing ledger witness', async ({
    paymentStatus,
    eventType,
    resource,
  }) => {
    const { inserts, updates, rpcCalls } = useWebhookRows({
      payments: { data: { ...basePayment, status: paymentStatus }, error: null },
    }, {
      record: {
        already_recorded: true,
        terminal_history_replay: true,
        terminal_payment_status: paymentStatus,
      },
    });

    const req = makeReplay({
      event_type: eventType,
      resource,
      id: `EVT-${paymentStatus.toUpperCase()}-ALREADY-DONE`,
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inserts).toEqual([]);
    expect(updates.filter((u) => u.table !== 'webhook_events')).toEqual([]);
    expect(rpcCalls.map(({ name }) => name)).toEqual(['commerce_record_paypal_refund_event']);
  });

  it('lets the losing same-refund handler accept a concurrent completed-to-refunded successor', async () => {
    const { inserts, updates, rpcCalls } = useWebhookRows({
      payments: [
        { data: basePayment, error: null },
        { data: basePayment, error: null },
      ],
      entitlements: [
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: [
        { data: [], error: null },
        { data: null, error: null },
      ],
    }, {
      recordSequence: [
        {},
        {
          already_recorded: true,
          terminal_witness: true,
          terminal_history_consistent: true,
          terminal_history_replay: true,
          terminal_payment_status: 'refunded',
        },
      ],
    });
    const resource = {
      id: 'REFUND-CONCURRENT-SAME',
      amount: { value: '10.00', currency_code: 'USD' },
      supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
    };

    const results = await Promise.all([
      POST(makeReplay({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource,
        id: 'EVT-CONCURRENT-SAME-A',
      }) as never),
      POST(makeReplay({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource,
        id: 'EVT-CONCURRENT-SAME-B',
      }) as never),
    ]);

    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(rpcCalls.filter(({ name }) => name === 'commerce_record_paypal_refund_event'))
      .toHaveLength(2);
    expect(rpcCalls.filter(({ name }) => name === 'commerce_finalize_paypal_refund_status'))
      .toHaveLength(1);
    expect(updates.filter(({ table }) => table === 'entitlements')).toHaveLength(1);
    expect(updates.filter(({ table }) => table === 'license_keys')).toHaveLength(1);
    expect(inserts.filter(({ table }) => table === 'alerts' || table === 'audit_logs'))
      .toEqual([]);
  });

  it('does not turn an old partial refund replay into a new full witness after reversal', async () => {
    const { inserts, updates, rpcCalls } = useWebhookRows({
      payments: { data: { ...basePayment, status: 'reversed' }, error: null },
    }, {
      record: {
        already_recorded: true,
        refund_amount_cents: 250,
        cumulative_refunded_cents: 1000,
        full_refund: true,
        terminal_witness: false,
        terminal_history_replay: true,
        terminal_payment_status: 'reversed',
      },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-OLD-PARTIAL',
        amount: { value: '2.50', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-OLD-PARTIAL-AFTER-REVERSAL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(rpcCalls.map(({ name }) => name)).toEqual(['commerce_record_paypal_refund_event']);
    expect(inserts).toEqual([]);
    expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
  });

  it('accepts a delayed full refund replay after a zero-remaining reversal witness', async () => {
    const { inserts, updates, rpcCalls } = useWebhookRows({
      payments: { data: { ...basePayment, status: 'reversed' }, error: null },
    }, {
      record: {
        already_recorded: true,
        refund_amount_cents: 1000,
        cumulative_refunded_cents: 1000,
        full_refund: true,
        terminal_witness: false,
        terminal_history_consistent: true,
        terminal_history_replay: true,
        terminal_payment_status: 'reversed',
      },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-FULL-BEFORE-ZERO-REVERSAL',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-FULL-REFUND-AFTER-ZERO-REVERSAL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(rpcCalls.map(({ name }) => name)).toEqual(['commerce_record_paypal_refund_event']);
    expect(inserts).toEqual([]);
    expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
  });

  it('rejects a reversed payment whose locked ledger has no reversal witness', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { inserts, updates, rpcCalls } = useWebhookRows({
        payments: { data: { ...basePayment, status: 'reversed' }, error: null },
      }, {
        record: {
          already_recorded: true,
          terminal_history_consistent: false,
          terminal_history_replay: true,
          terminal_payment_status: 'reversed',
        },
      });

      const req = makeReplay({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: 'REFUND-EXISTS-BUT-REVERSAL-MISSING',
          amount: { value: '10.00', currency_code: 'USD' },
          supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
        },
        id: 'EVT-CORRUPTED-REVERSED-HISTORY',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(500);
      expect(rpcCalls.map(({ name }) => name)).toEqual(['commerce_record_paypal_refund_event']);
      expect(inserts).toEqual([]);
      expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not let an old partial replay own a later full transition before finalization', async () => {
    const { inserts, updates, rpcCalls } = useWebhookRows({
      payments: { data: basePayment, error: null },
    }, {
      record: {
        already_recorded: true,
        refund_amount_cents: 250,
        cumulative_refunded_cents: 1000,
        full_refund: true,
        terminal_witness: false,
      },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-OLD-PARTIAL-BEFORE-FINALIZE',
        amount: { value: '2.50', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-OLD-PARTIAL-BEFORE-FINALIZE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(rpcCalls.map(({ name }) => name)).toEqual(['commerce_record_paypal_refund_event']);
    expect(inserts).toEqual([]);
    expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
  });

  it('accepts an old partial replay when a concurrent handler already finalized the later full refund', async () => {
    const { inserts, updates, rpcCalls } = useWebhookRows({
      // This is the stale pre-RPC read. The locked proof below is newer.
      payments: { data: basePayment, error: null },
    }, {
      record: {
        already_recorded: true,
        refund_amount_cents: 250,
        cumulative_refunded_cents: 1000,
        full_refund: true,
        terminal_witness: false,
        terminal_history_consistent: true,
        terminal_history_replay: true,
        terminal_payment_status: 'refunded',
      },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-OLD-PARTIAL-CONCURRENT-FINALIZE',
        amount: { value: '2.50', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
      id: 'EVT-OLD-PARTIAL-CONCURRENT-FINALIZE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(rpcCalls.map(({ name }) => name)).toEqual(['commerce_record_paypal_refund_event']);
    expect(inserts).toEqual([]);
    expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
  });

  it.each([
    ['refunded', 'completed'],
    ['refunded', 'reversed'],
    ['reversed', 'completed'],
    ['reversed', 'refunded'],
  ] as const)(
    'rejects a non-monotonic locked payment proof from %s to %s',
    async (loadedStatus, lockedStatus) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { updates, rpcCalls } = useWebhookRows({
          payments: { data: { ...basePayment, status: loadedStatus }, error: null },
        }, {
          record: {
            already_recorded: true,
            terminal_history_replay: lockedStatus !== 'completed',
            terminal_payment_status: lockedStatus,
          },
        });
        const req = makeReplay({
          event_type: 'PAYMENT.CAPTURE.REFUNDED',
          resource: {
            id: `REFUND-NON-MONOTONIC-${loadedStatus}-${lockedStatus}`,
            amount: { value: '10.00', currency_code: 'USD' },
            supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
          },
          id: `EVT-NON-MONOTONIC-${loadedStatus}-${lockedStatus}`,
        });

        const res = await POST(req as never);
        expect(res.status).toBe(500);
        expect(rpcCalls.map(({ name }) => name)).toEqual(['commerce_record_paypal_refund_event']);
        expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it('rejects an opposite terminal event even when an RPC claims its witness exists', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { inserts, updates, rpcCalls } = useWebhookRows({
        payments: { data: { ...basePayment, status: 'refunded' }, error: null },
      }, {
        record: {
          already_recorded: true,
          terminal_history_replay: true,
          terminal_payment_status: 'refunded',
        },
      });
      const req = makeReplay({
        event_type: 'PAYMENT.CAPTURE.REVERSED',
        resource: {
          id: 'REVERSAL-CONFLICTING-TERMINAL',
          supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
        },
        id: 'EVT-REVERSAL-CONFLICTING-TERMINAL',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(500);
      expect(rpcCalls.map(({ name }) => name)).toEqual(['commerce_record_paypal_refund_event']);
      expect(inserts).toEqual([]);
      expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects an unknown refund id for a terminal payment', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { inserts, updates, rpcCalls } = useWebhookRows({
        payments: { data: { ...basePayment, status: 'refunded' }, error: null },
      }, {
        record: {
          terminal_history_replay: true,
          terminal_payment_status: 'refunded',
        },
      });
      const req = makeReplay({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: 'REFUND-UNKNOWN-AFTER-TERMINAL',
          amount: { value: '10.00', currency_code: 'USD' },
          supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
        },
        id: 'EVT-REFUND-UNKNOWN-AFTER-TERMINAL',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(500);
      expect(rpcCalls.map(({ name }) => name)).toEqual(['commerce_record_paypal_refund_event']);
      expect(inserts).toEqual([]);
      expect(updates.filter((update) => update.table !== 'webhook_events')).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    {
      label: 'malformed refund id',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      status: 'refunded',
      resource: {
        id: 'REFUND BAD ID',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
    },
    {
      label: 'malformed refund money',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      status: 'refunded',
      resource: {
        id: 'REFUND-BAD-MONEY-TERMINAL',
        amount: { value: '10oops', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
    },
    {
      label: 'malformed supplied reversal money',
      eventType: 'PAYMENT.CAPTURE.REVERSED',
      status: 'reversed',
      resource: {
        id: 'REVERSAL-BAD-MONEY-TERMINAL',
        amount: { value: '1e1', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: 'CAPTURE-1' } },
      },
    },
  ] as const)('rejects $label before terminal ledger validation', async ({
    eventType,
    status,
    resource,
  }) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rpcCalls } = useWebhookRows({
        payments: { data: { ...basePayment, status }, error: null },
      }, {
        record: { already_recorded: true },
      });
      const req = makeReplay({
        event_type: eventType,
        resource,
        id: `EVT-${resource.id}`,
      });

      const res = await POST(req as never);
      expect(res.status).toBe(500);
      expect(rpcCalls).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
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
    }, {
      record: { already_recorded: true },
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

  it('failed refund events resume without creating a legacy partial role queue', async () => {
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
      expect(inserts).not.toContainEqual(
        expect.objectContaining({
          table: 'bot_action_queue',
          payload: expect.objectContaining({ action: 'revoke_roles' }),
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

  it('refund retry never recreates a legacy role revocation from a failed attempt', async () => {
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
  it.each([
    ['underpayment', '9.98', 'EUR'],
    ['overpayment', '10.00', 'EUR'],
    ['currency mismatch', '9.99', 'USD'],
  ])('PAYMENT.SALE.COMPLETED atomically holds renewal %s without legacy writes', async (
    _label,
    total,
    currency,
  ) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const context = completedSaleRenewalContext({
        orderId: `order-renewal-${_label.replaceAll(' ', '-')}`,
        subscriptionId: `SUB-RENEWAL-${_label.replaceAll(' ', '-').toUpperCase()}`,
        saleId: `SALE-RENEWAL-${_label.replaceAll(' ', '-').toUpperCase()}`,
      });
      const { inserts, rpcCalls } = useWebhookRows(context.rows);
      const req = makeReplay({
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: {
          id: context.payload.order_id.replace('order-', 'SALE-').toUpperCase(),
          billing_agreement_id: context.order.paypal_subscription_id,
          amount: { total, currency },
        },
        id: `EVT-RENEWAL-${_label.replaceAll(' ', '-').toUpperCase()}`,
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(rpcCalls).toContainEqual({
        name: 'commerce_record_subscription_sale_or_hold',
        args: expect.objectContaining({
          p_paypal_subscription_id: context.order.paypal_subscription_id,
        }),
      });
      expect(inserts).not.toContainEqual(expect.objectContaining({ table: 'payments' }));
      expect(inserts).not.toContainEqual(expect.objectContaining({ table: 'bot_action_queue' }));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    '10oops',
    '1e1',
    '9.999',
    '90071992547409.92',
    '09.99',
    '-9.99',
    ' 9.99',
  ])('PAYMENT.SALE.COMPLETED rejects noncanonical money %j before persistence', async (total) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { inserts } = useWebhookRows({});
      const req = makeReplay({
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: {
          id: 'SALE-INVALID-MONEY',
          billing_agreement_id: 'SUB-INVALID-MONEY',
          amount: { total, currency: 'EUR' },
        },
        id: `EVT-SALE-INVALID-MONEY-${total}`,
      });

      const res = await POST(req as never);
      expect(res.status).toBe(500);
      expect(inserts).not.toContainEqual(expect.objectContaining({ table: 'payments' }));
      expect(inserts).not.toContainEqual(expect.objectContaining({ table: 'bot_action_queue' }));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('PAYMENT.SALE.COMPLETED persists the sale currency instead of hardcoded USD', async () => {
    const context = completedSaleRenewalContext({
      orderId: 'order-sub-eur',
      subscriptionId: 'SUB-EUR-1',
      saleId: 'SALE-EUR-1',
    });
    const { rpcCalls } = useWebhookRows({
      ...context.rows,
      payments: {
        data: {
          id: 'payment-sale-eur-1',
          order_id: 'order-sub-eur',
          customer_id: 'customer-1',
          guild_id: 'guild-1',
          paypal_payment_id: 'SALE-EUR-1',
          amount_cents: 999,
          currency: 'EUR',
          status: 'completed',
          paypal_resource_type: 'sale',
        },
        error: null,
      },
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
    expect(rpcCalls).toContainEqual({
      name: 'commerce_record_subscription_sale_or_hold',
      args: expect.objectContaining({
        p_paypal_payment_id: 'SALE-EUR-1',
        p_paypal_subscription_id: 'SUB-EUR-1',
        p_order_id: 'order-sub-eur',
        p_plan_id: 'plan-order-sub-eur',
        p_amount_cents: 999,
        p_currency: 'EUR',
      }),
    });
  });

  it('PAYMENT.SALE.COMPLETED retries when its exact subscription order read fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { inserts } = useWebhookRows({
        orders: { data: null, error: { message: 'order lookup unavailable' } },
      });
      const req = makeReplay({
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: {
          id: 'SALE-ORDER-READ-FAIL',
          billing_agreement_id: 'SUB-ORDER-READ-FAIL',
          amount: { total: '9.99', currency: 'EUR' },
        },
        id: 'EVT-SALE-ORDER-READ-FAIL',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(500);
      expect(inserts).not.toContainEqual(expect.objectContaining({ table: 'payments' }));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('PAYMENT.SALE.COMPLETED retries when the payment insert fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      useWebhookRows({
        orders: {
          data: {
            id: 'order-insert-fail',
            customer_id: 'customer-1',
            guild_id: 'guild-1',
            paypal_subscription_id: 'SUB-INSERT-FAIL',
          },
          error: null,
        },
        payments: { data: null, error: { code: '08006', message: 'write unavailable' } },
      });
      const req = makeReplay({
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: {
          id: 'SALE-INSERT-FAIL',
          billing_agreement_id: 'SUB-INSERT-FAIL',
          amount: { total: '9.99', currency: 'EUR' },
        },
        id: 'EVT-SALE-INSERT-FAIL',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(500);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('PAYMENT.SALE.COMPLETED accepts a 23505 replay only when the persisted row is exact', async () => {
    const context = completedSaleRenewalContext({
      orderId: 'order-exact-replay',
      subscriptionId: 'SUB-EXACT-REPLAY',
      saleId: 'SALE-EXACT-REPLAY',
    });
    const { rpcCalls } = useWebhookRows({
      ...context.rows,
      payments: [
        { data: null, error: { code: '23505', message: 'duplicate payment' } },
        {
          data: {
            id: 'payment-exact-replay',
            order_id: 'order-exact-replay',
            customer_id: 'customer-1',
            guild_id: 'guild-1',
            paypal_payment_id: 'SALE-EXACT-REPLAY',
            amount_cents: 999,
            currency: 'EUR',
            status: 'completed',
            paypal_resource_type: 'sale',
          },
          error: null,
        },
      ],
    });
    const req = makeReplay({
      event_type: 'PAYMENT.SALE.COMPLETED',
      resource: {
        id: 'SALE-EXACT-REPLAY',
        billing_agreement_id: 'SUB-EXACT-REPLAY',
        amount: { total: '9.99', currency: 'EUR' },
      },
      id: 'EVT-SALE-EXACT-REPLAY',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(rpcCalls.filter(({ name }) =>
      name === 'commerce_record_subscription_sale_or_hold')).toHaveLength(1);
  });

  it.each([
    ['refunded', 'refunded'],
    ['reversed', 'refunded'],
    ['reversed', 'disputed'],
  ] as const)(
    'PAYMENT.SALE.COMPLETED treats an exact %s sale replay with a %s order as a successor-state no-op',
    async (successorStatus, successorOrderStatus) => {
      const { rpcCalls, updates } = useWebhookRows({
        orders: {
          data: {
            id: 'order-successor-replay',
            order_number: 'ORD-SUCCESSOR-REPLAY',
            customer_id: 'customer-1',
            guild_id: 'guild-1',
            product_id: 'product-successor-replay',
            plan_id: 'plan-successor-replay',
            paypal_subscription_id: 'SUB-SUCCESSOR-REPLAY',
            amount_cents: 999,
            currency: 'EUR',
            status: successorOrderStatus,
          },
          error: null,
        },
        payments: [
          { data: null, error: { code: '23505', message: 'duplicate payment' } },
          {
            data: {
              id: 'payment-successor-replay',
              order_id: 'order-successor-replay',
              customer_id: 'customer-1',
              guild_id: 'guild-1',
              paypal_payment_id: 'SALE-SUCCESSOR-REPLAY',
              paypal_resource_type: 'sale',
              amount_cents: 999,
              currency: 'EUR',
              status: successorStatus,
            },
            error: null,
          },
        ],
      });
      const req = makeReplay({
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: {
          id: 'SALE-SUCCESSOR-REPLAY',
          billing_agreement_id: 'SUB-SUCCESSOR-REPLAY',
          amount: { total: '9.99', currency: 'EUR' },
        },
        id: `EVT-SALE-SUCCESSOR-${successorStatus.toUpperCase()}-${successorOrderStatus.toUpperCase()}`,
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(rpcCalls.filter(({ name }) =>
        name === 'commerce_record_subscription_sale_or_hold')).toHaveLength(1);
      expect(updates.filter(({ table }) => table === 'payments')).toEqual([]);
    },
  );

  it.each([
    ['refunded', 'completed'],
    ['refunded', 'disputed'],
    ['reversed', 'completed'],
    ['reversed', 'pending'],
  ] as const)(
    'PAYMENT.SALE.COMPLETED rejects an exact %s payment replay paired with a %s order',
    async (successorStatus, orderStatus) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        useWebhookRows({
          orders: {
            data: {
              id: 'order-successor-state-mismatch',
              customer_id: 'customer-1',
              guild_id: 'guild-1',
              paypal_subscription_id: 'SUB-SUCCESSOR-STATE-MISMATCH',
              amount_cents: 999,
              currency: 'EUR',
              status: orderStatus,
            },
            error: null,
          },
          payments: [
            { data: null, error: { code: '23505', message: 'duplicate payment' } },
            {
              data: {
                id: 'payment-successor-state-mismatch',
                order_id: 'order-successor-state-mismatch',
                customer_id: 'customer-1',
                guild_id: 'guild-1',
                paypal_payment_id: 'SALE-SUCCESSOR-STATE-MISMATCH',
                paypal_resource_type: 'sale',
                amount_cents: 999,
                currency: 'EUR',
                status: successorStatus,
              },
              error: null,
            },
          ],
        });
        const req = makeReplay({
          event_type: 'PAYMENT.SALE.COMPLETED',
          resource: {
            id: 'SALE-SUCCESSOR-STATE-MISMATCH',
            billing_agreement_id: 'SUB-SUCCESSOR-STATE-MISMATCH',
            amount: { total: '9.99', currency: 'EUR' },
          },
          id: `EVT-SALE-SUCCESSOR-STATE-MISMATCH-${successorStatus}-${orderStatus}`,
        });

        const res = await POST(req as never);
        expect(res.status).toBe(500);
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each([
    ['provider payment', { paypal_payment_id: 'SALE-DIFFERENT' }],
    ['order', { order_id: 'order-different' }],
    ['amount', { amount_cents: 1 }],
    ['currency', { currency: 'USD' }],
    ['resource type', { paypal_resource_type: 'capture' }],
  ])(
    'PAYMENT.SALE.COMPLETED rejects a successor-state replay with a different %s identity',
    async (_identity, persistedOverride) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        useWebhookRows({
          orders: {
            data: {
              id: 'order-successor-mismatch',
              customer_id: 'customer-1',
              guild_id: 'guild-1',
              paypal_subscription_id: 'SUB-SUCCESSOR-MISMATCH',
              status: 'refunded',
            },
            error: null,
          },
          payments: [
            { data: null, error: { code: '23505', message: 'duplicate payment' } },
            {
              data: {
                id: 'payment-successor-mismatch',
                order_id: 'order-successor-mismatch',
                customer_id: 'customer-1',
                guild_id: 'guild-1',
                paypal_payment_id: 'SALE-SUCCESSOR-MISMATCH',
                paypal_resource_type: 'sale',
                amount_cents: 999,
                currency: 'EUR',
                status: 'refunded',
                ...persistedOverride,
              },
              error: null,
            },
          ],
        });
        const req = makeReplay({
          event_type: 'PAYMENT.SALE.COMPLETED',
          resource: {
            id: 'SALE-SUCCESSOR-MISMATCH',
            billing_agreement_id: 'SUB-SUCCESSOR-MISMATCH',
            amount: { total: '9.99', currency: 'EUR' },
          },
          id: `EVT-SALE-SUCCESSOR-MISMATCH-${String(_identity)}`,
        });

        const res = await POST(req as never);
        expect(res.status).toBe(500);
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it('errored PAYMENT.SALE.COMPLETED redelivery resumes through exact 23505 validation', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const context = completedSaleRenewalContext({
        orderId: 'order-resumed-sale',
        subscriptionId: 'SUB-RESUMED-SALE',
        saleId: 'SALE-RESUMED',
      });
      const { rpcCalls, updates } = useWebhookRows({
        ...context.rows,
        orders: [
          {
            data: [
              {
                guild_id: 'guild-1',
                status: 'completed',
                created_at: '2026-07-11T00:00:00.000Z',
              },
            ],
            error: null,
          },
          {
            data: context.order,
            error: null,
          },
        ],
        webhook_events: [
          { data: [], error: null },
          { data: { result: 'error', processed_at: new Date().toISOString() }, error: null },
          { data: { event_id: 'EVT-SALE-RESUMED' }, error: null },
          { data: null, error: null },
        ],
        payments: [
          { data: null, error: { code: '23505', message: 'duplicate payment' } },
          {
            data: {
              id: 'payment-resumed-sale',
              order_id: 'order-resumed-sale',
              customer_id: 'customer-1',
              guild_id: 'guild-1',
              paypal_payment_id: 'SALE-RESUMED',
              paypal_resource_type: 'sale',
              amount_cents: 999,
              currency: 'EUR',
              status: 'completed',
            },
            error: null,
          },
        ],
      });
      const req = makeSignedWebhook({
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: {
          id: 'SALE-RESUMED',
          billing_agreement_id: 'SUB-RESUMED-SALE',
          amount: { total: '9.99', currency: 'EUR' },
        },
        id: 'EVT-SALE-RESUMED',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(rpcCalls.filter(({ name }) =>
        name === 'commerce_record_subscription_sale_or_hold')).toHaveLength(1);
      expect(updates).toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({ result: null, error_details: null }),
      });
      expect(updates).toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({ result: 'success' }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('PAYMENT.SALE.COMPLETED rejects a 23505 replay whose persisted row differs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      useWebhookRows({
        orders: {
          data: {
            id: 'order-mismatched-replay',
            customer_id: 'customer-1',
            guild_id: 'guild-1',
            paypal_subscription_id: 'SUB-MISMATCHED-REPLAY',
          },
          error: null,
        },
        payments: [
          { data: null, error: { code: '23505', message: 'duplicate payment' } },
          {
            data: {
              id: 'payment-mismatched-replay',
              order_id: 'order-mismatched-replay',
              customer_id: 'customer-1',
              guild_id: 'guild-1',
              paypal_payment_id: 'SALE-MISMATCHED-REPLAY',
              paypal_resource_type: 'sale',
              amount_cents: 1,
              currency: 'EUR',
              status: 'completed',
            },
            error: null,
          },
        ],
      });
      const req = makeReplay({
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: {
          id: 'SALE-MISMATCHED-REPLAY',
          billing_agreement_id: 'SUB-MISMATCHED-REPLAY',
          amount: { total: '9.99', currency: 'EUR' },
        },
        id: 'EVT-SALE-MISMATCHED-REPLAY',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(500);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('legacy USD-mislabeled sale payment accepts a self-confirmed foreign-currency partial refund under the stored label', async () => {
    // Legacy row: amount_cents parsed from the EUR sale payload, but the
    // currency label was persisted as hardcoded 'USD'. The payload's own
    // cumulative refunded total states the sale's real currency, so the
    // exact-cents comparison stays valid; without the tolerance this refund
    // throws identically on every PayPal retry forever.
    const { updates, rpcCalls } = useWebhookRows({
      payments: { data: baseSalePayment, error: null },
      alerts: { data: null, error: null },
      audit_logs: { data: null, error: null },
    }, {
      record: { refund_amount_cents: 250, cumulative_refunded_cents: 250 },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REFUNDED',
      resource: {
        id: 'REFUND-SALE-EUR-PARTIAL',
        sale_id: 'SALE-1',
        amount: { total: '-2.50', currency: 'EUR' },
        total_refunded_amount: { value: '2.50', currency: 'EUR' },
      },
      id: 'EVT-SALE-REFUND-EUR-PARTIAL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    // Recorded under the STORED label — the ledger stays internally
    // consistent — while the audit details keep the mislabel visible.
    expectAtomicRefundRecord(rpcCalls, {
      refundId: 'REFUND-SALE-EUR-PARTIAL',
      eventType: 'PAYMENT.SALE.REFUNDED',
      amountCents: 250,
      currency: 'USD',
      providerPaymentId: 'SALE-1',
      resourceType: 'sale',
    });
    expect(rpcCalls).toContainEqual({
      name: 'commerce_record_paypal_refund_event',
      args: expect.objectContaining({
        p_audit_details: expect.objectContaining({
          legacy_usd_currency_mislabel: true,
          stored_payment_currency: 'USD',
          provider_refund_currency: 'EUR',
        }),
      }),
    });
    // Partial → access retained.
    expect(updates.filter((u) => u.table !== 'webhook_events')).toEqual([]);
  });

  it('legacy null-resource sale payment is refundable only via exact subscription order evidence', async () => {
    const { rpcCalls } = useWebhookRows({
      // Pre-resource-typing row: paypal_resource_type never adopted.
      payments: [
        { data: { ...baseSalePayment, paypal_resource_type: null }, error: null },
        { data: null, error: null },
      ],
      orders: {
        data: {
          id: 'order-1',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          plan_id: 'plan-1',
          paypal_subscription_id: 'SUB-LEGACY-1',
        },
        error: null,
      },
      entitlements: [
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
      audit_logs: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REFUNDED',
      resource: {
        id: 'REFUND-SALE-EUR-LEGACY-NULL',
        sale_id: 'SALE-1',
        amount: { total: '-10.00', currency: 'EUR' },
        total_refunded_amount: { value: '10.00', currency: 'EUR' },
      },
      id: 'EVT-SALE-REFUND-EUR-LEGACY-NULL',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expectAtomicRefundRecord(rpcCalls, {
      refundId: 'REFUND-SALE-EUR-LEGACY-NULL',
      eventType: 'PAYMENT.SALE.REFUNDED',
      amountCents: 1000,
      currency: 'USD',
      providerPaymentId: 'SALE-1',
      resourceType: 'sale',
    });
    // Full refund proceeds to the terminal marker with the mislabel audited.
    expect(rpcCalls).toContainEqual({
      name: 'commerce_finalize_paypal_refund_status',
      args: expect.objectContaining({
        p_payment_status: 'refunded',
        p_audit_details: expect.objectContaining({
          legacy_usd_currency_mislabel: true,
          provider_refund_currency: 'EUR',
        }),
      }),
    });
  });

  it('legacy null-resource sale refund without subscription order evidence still fails closed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { inserts, rpcCalls } = useWebhookRows({
      payments: { data: { ...baseSalePayment, paypal_resource_type: null }, error: null },
      // A one-time order shape is not subscription evidence: the mislabeled
      // rows were only ever written by the subscription-payment handler.
      orders: {
        data: {
          id: 'order-1',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          plan_id: null,
          paypal_subscription_id: null,
        },
        error: null,
      },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REFUNDED',
      resource: {
        id: 'REFUND-SALE-EUR-NO-EVIDENCE',
        sale_id: 'SALE-1',
        amount: { total: '-2.50', currency: 'EUR' },
        total_refunded_amount: { value: '2.50', currency: 'EUR' },
      },
      id: 'EVT-SALE-REFUND-EUR-NO-EVIDENCE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    expect(rpcCalls).toEqual([]);
    expect(inserts).toEqual([]);
    errorSpy.mockRestore();
  });

  it('sale refund currency mismatch against a non-USD stored label still fails closed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { inserts, rpcCalls } = useWebhookRows({
      // Post-deploy row: the sale's real currency was persisted, so a
      // differing refund currency is evidence of a wrong parent, not the
      // legacy label bug.
      payments: { data: { ...baseSalePayment, currency: 'EUR' }, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REFUNDED',
      resource: {
        id: 'REFUND-SALE-USD-POSTDEPLOY',
        sale_id: 'SALE-1',
        amount: { total: '-2.50', currency: 'USD' },
        total_refunded_amount: { value: '2.50', currency: 'USD' },
      },
      id: 'EVT-SALE-REFUND-USD-POSTDEPLOY',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    expect(rpcCalls).toEqual([]);
    expect(inserts).toEqual([]);
    errorSpy.mockRestore();
  });

  it('legacy tolerance never repairs a mismatch whose payload total states a THIRD currency', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { inserts, rpcCalls } = useWebhookRows({
      payments: { data: baseSalePayment, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REFUNDED',
      resource: {
        id: 'REFUND-SALE-EUR-THIRD-CCY',
        sale_id: 'SALE-1',
        amount: { total: '-2.50', currency: 'EUR' },
        // The payload does NOT self-confirm the refund currency as the
        // sale's currency, so the label bug is not proven — fail closed.
        total_refunded_amount: { value: '2.50', currency: 'GBP' },
      },
      id: 'EVT-SALE-REFUND-EUR-THIRD-CCY',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    expect(rpcCalls).toEqual([]);
    expect(inserts).toEqual([]);
    errorSpy.mockRestore();
  });

  it('legacy USD-mislabeled sale payment accepts a self-confirmed foreign-currency reversal under the stored label', async () => {
    // Same label bug, terminal event: a REVERSED payload that self-states its
    // amounts in the sale's real currency gets the identical tolerance —
    // otherwise the reversal throws on every retry forever with money
    // returned at PayPal and access retained locally.
    const { rpcCalls } = useWebhookRows({
      payments: [{ data: baseSalePayment, error: null }, { data: null, error: null }],
      orders: { data: null, error: null },
      entitlements: [
        { data: [], error: null },
        { data: null, error: null },
      ],
      license_keys: [{ data: [], error: null }, { data: null, error: null }],
      audit_logs: { data: null, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REVERSED',
      resource: {
        id: 'SALE-REVERSED-EUR-1',
        sale_id: 'SALE-1',
        amount: { total: '-10.00', currency: 'EUR' },
        total_refunded_amount: { value: '10.00', currency: 'EUR' },
      },
      id: 'EVT-SALE-REVERSED-EUR-1',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expectAtomicRefundRecord(rpcCalls, {
      refundId: 'SALE-REVERSED-EUR-1',
      eventType: 'PAYMENT.SALE.REVERSED',
      amountCents: 1000,
      currency: 'USD',
      providerPaymentId: 'SALE-1',
      resourceType: 'sale',
    });
    expect(rpcCalls).toContainEqual({
      name: 'commerce_record_paypal_refund_event',
      args: expect.objectContaining({
        p_audit_details: expect.objectContaining({
          legacy_usd_currency_mislabel: true,
          stored_payment_currency: 'USD',
          provider_refund_currency: 'EUR',
        }),
      }),
    });
    expect(rpcCalls).toContainEqual({
      name: 'commerce_finalize_paypal_refund_status',
      args: expect.objectContaining({
        p_payment_status: 'reversed',
        p_audit_details: expect.objectContaining({
          legacy_usd_currency_mislabel: true,
          provider_refund_currency: 'EUR',
        }),
      }),
    });
  });

  it('a legacy reversal stating an amount without the confirming total stays fail-closed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { inserts, rpcCalls } = useWebhookRows({
      payments: { data: baseSalePayment, error: null },
    });

    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REVERSED',
      resource: {
        id: 'SALE-REVERSED-EUR-NOCONF',
        sale_id: 'SALE-1',
        // Amount stated in a differing currency with no cumulative total:
        // the payload carries no proof of the sale's real currency.
        amount: { total: '-10.00', currency: 'EUR' },
      },
      id: 'EVT-SALE-REVERSED-EUR-NOCONF',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    expect(rpcCalls).toEqual([]);
    expect(inserts).toEqual([]);
    errorSpy.mockRestore();
  });

  it('sale refund currency mismatch fails before ledger or access mutation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { inserts, rpcCalls } = useWebhookRows({
      payments: [{ data: baseSalePayment, error: null }, { data: null, error: null }],
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
    expect(res.status).toBe(500);
    expect(rpcCalls).toEqual([]);
    expect(inserts).toEqual([]);
    errorSpy.mockRestore();
  });

  it('capture refund currency mismatch fails even when the payload self-confirms it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { inserts, rpcCalls } = useWebhookRows({
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
    expect(res.status).toBe(500);
    expect(rpcCalls).toEqual([]);
    expect(inserts).toEqual([]);
    errorSpy.mockRestore();
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
          paypal_subscription_id: 'SUB-CANCEL-QUEUE-FAIL',
        },
        error: null,
      },
      products: {
        data: { id: 'product-1', guild_id: 'guild-1', name: 'Subscription' },
        error: null,
      },
      customers: {
        data: { id: 'customer-1', guild_id: 'guild-1', discord_id: 'discord-1' },
        error: null,
      },
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
          paypal_subscription_id: 'SUB-SUSPEND-QUEUE-FAIL',
        },
        error: null,
      },
      products: {
        data: { id: 'product-1', guild_id: 'guild-1', name: 'Subscription' },
        error: null,
      },
      customers: {
        data: { id: 'customer-1', guild_id: 'guild-1', discord_id: 'discord-1' },
        error: null,
      },
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
            plan_id: 'plan-1',
            paypal_subscription_id: input.eventId.replace(/^EVT-/, ''),
            amount_cents: 999,
            currency: 'USD',
            status: 'completed',
          },
          error: null,
        },
      ],
      products: {
        data: { id: 'product-1', guild_id: 'guild-1', name: 'Subscription' },
        error: null,
      },
      customers: {
        data: { id: 'customer-1', guild_id: 'guild-1', discord_id: 'discord-1' },
        error: null,
      },
      bot_action_queue: [
        {
          data: {
            id: 'activation-carrier-1',
            guild_id: 'guild-1',
            action: 'fulfill_subscription',
            lane: 'commerce',
            status: 'completed',
            idempotency_key:
              `paypal:subscription:${input.eventId.replace(/^EVT-/, '')}:fulfill_subscription`,
            payload: {
              fulfillment_type: 'subscription_activated',
              guild_id: 'guild-1',
              customer_id: 'customer-1',
              discord_id: 'discord-1',
              product_id: 'product-1',
              product_name: 'Subscription',
              order_id: input.orderId,
              order_number: `ORD-${input.orderId}`,
              plan_id: 'plan-1',
              paypal_plan_id: 'PAYPAL-PLAN-1',
              paypal_subscription_id: input.eventId.replace(/^EVT-/, ''),
              entitlement_type: 'subscription',
            },
          },
          error: null,
        },
        input.queueProbe,
      ],
    });
  }

  it('errored BILLING.SUBSCRIPTION.CANCELLED is resumable — redelivery queues the fulfillment exactly once', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { rpcCalls, updates } = useResumedSubscriptionRows({
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
      expect(rpcCalls).toContainEqual({
        name: 'commerce_create_or_recover_subscription_lifecycle_action',
        args: expect.objectContaining({
          p_webhook_event_id: 'EVT-SUB-CANCEL-RETRY',
          p_fulfillment_type: 'subscription_cancelled',
          p_order_id: 'order-cancel-retry',
          p_discord_id: 'discord-1',
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

  it('resumed cancellation retry does not queue a duplicate fulfillment already queued by the failed attempt', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { rpcCalls, updates } = useResumedSubscriptionRows({
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
      expect(rpcCalls.filter(({ name }) =>
        name === 'commerce_create_or_recover_subscription_lifecycle_action')).toHaveLength(1);
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
      const { rpcCalls } = useResumedSubscriptionRows({
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
      expect(rpcCalls).toContainEqual({
        name: 'commerce_create_or_recover_subscription_lifecycle_action',
        args: expect.objectContaining({
          p_webhook_event_id: 'EVT-SUB-SUSPEND-RETRY',
          p_fulfillment_type: 'subscription_suspended',
          p_order_id: 'order-suspend-retry',
        }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('errored BILLING.SUBSCRIPTION.PAYMENT.FAILED resumes through its distinct lifecycle action', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { rpcCalls } = useResumedSubscriptionRows({
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
      expect(rpcCalls).toContainEqual({
        name: 'commerce_create_or_recover_subscription_lifecycle_action',
        args: expect.objectContaining({
          p_webhook_event_id: 'EVT-SUB-PAYFAIL-RETRY',
          p_fulfillment_type: 'subscription_payment_failed',
          p_order_id: 'order-payfail-retry',
        }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('verification outage (503) on a redelivery leaves the errored event untouched — a later redelivery still resumes it', async () => {
    // W2 × PR #270 composition: an event that VERIFIED on its first delivery
    // can hold result='error' in webhook_events while a later redelivery hits
    // a verify-infrastructure outage. The 503 outage response must return
    // BEFORE any webhook_events access, so the errored row is neither claimed
    // nor rewritten — it stays resumable for the redelivery after recovery,
    // and the event-id-stamped queue probe still enforces exactly-once.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    const tokenResultMock = getPayPalTokenResult as ReturnType<typeof vi.fn>;
    try {
      const { inserts, updates, upserts, rpcCalls } = useResumedSubscriptionRows({
        eventId: 'EVT-SUB-CANCEL-OUTAGE',
        orderId: 'order-cancel-outage',
        queueProbe: { data: [], error: null }, // failed attempt queued nothing
      });

      const makeRedelivery = () =>
        makeSignedWebhook({
          event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
          resource: { id: 'SUB-CANCEL-OUTAGE' },
          id: 'EVT-SUB-CANCEL-OUTAGE',
        });

      // Redelivery 1 arrives during a verify-infrastructure outage: every
      // token fetch fails retriably, so verification ends 'unavailable'.
      tokenResultMock.mockResolvedValue({
        ok: false,
        retriable: true,
        reason: 'token endpoint returned 503',
      });

      const outageRes = await POST(makeRedelivery() as never);
      expect(outageRes.status).toBe(503);
      expect(outageRes.headers.get('Retry-After')).toBe('60');
      // No database access at all on the outage path — in particular the
      // errored webhook_events row is not claimed (result left as 'error').
      expect(mockSb.from).not.toHaveBeenCalled();
      expect(inserts).toEqual([]);
      expect(updates).toEqual([]);
      expect(upserts).toEqual([]);

      // Redelivery 2 after the verify infrastructure recovers.
      tokenResultMock.mockResolvedValue({ ok: true, token: 'test-token' });

      const resumedRes = await POST(makeRedelivery() as never);
      expect(resumedRes.status).toBe(200);
      expect(rpcCalls).toContainEqual({
        name: 'commerce_create_or_recover_subscription_lifecycle_action',
        args: expect.objectContaining({
          p_webhook_event_id: 'EVT-SUB-CANCEL-OUTAGE',
          p_fulfillment_type: 'subscription_cancelled',
          p_order_id: 'order-cancel-outage',
        }),
      });
      expect(updates).toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({ result: 'success' }),
      });
    } finally {
      tokenResultMock.mockResolvedValue({ ok: true, token: 'test-token' });
      global.fetch = originalFetch;
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
