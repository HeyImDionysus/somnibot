/**
 * Edge-case tests for POST /api/paypal/webhook.
 *
 * V5 Audit §13.P2a: Covers missing custom_id, refund flow,
 * subscription lifecycle, and unhandled event types.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

afterEach(() => vi.restoreAllMocks());

const { replaySecret, paypalClientSecret } = vi.hoisted(() => {
  const secret = 'test-edge-webhook-replay-secret';
  const clientSecret = 'test-paypal-client-secret';
  process.env.NEXTAUTH_SECRET = 'test-secret-edge';
  process.env.WEBHOOK_REPLAY_SECRET = secret;
  process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
  process.env.PAYPAL_CLIENT_SECRET = clientSecret;
  return { replaySecret: secret, paypalClientSecret: clientSecret };
});

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn().mockResolvedValue({
    apiBase: 'https://api-m.sandbox.paypal.com',
    clientSecret: paypalClientSecret,
    webhookId: 'test-webhook-id',
  }),
  getPayPalToken: vi.fn().mockResolvedValue('test-token'),
  getPayPalTokenResult: vi.fn().mockResolvedValue({ ok: true, token: 'test-token' }),
  getSubscriptionAmount: vi.fn().mockResolvedValue({
    amountCents: 999,
    currency: 'USD',
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
import {
  handlePaymentCaptured as handlePaymentCapturedWithEvent,
  handleSubscriptionActivated as handleSubscriptionActivatedWithEvent,
  handleSubscriptionCancelled as handleSubscriptionCancelledWithChronology,
  handleSubscriptionPayment,
  handleSubscriptionSuspended as handleSubscriptionSuspendedWithChronology,
} from '@/app/api/paypal/webhook/handlers';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  getPayPalRuntimeConfig,
  getPayPalToken,
  getPayPalTokenResult,
  getSubscriptionAmount,
} from '@/lib/paypal';
import { rateLimits } from '@/lib/api/rate-limit';

const handlePaymentCaptured = (
  supabase: Parameters<typeof handlePaymentCapturedWithEvent>[0],
  resource: Parameters<typeof handlePaymentCapturedWithEvent>[1],
) => handlePaymentCapturedWithEvent(supabase, resource, {
  webhookEventId: 'EVT-DIRECT-CAPTURE',
  providerOccurredAt: '2026-07-29T00:00:00.000Z',
});

const handleSubscriptionActivated = (
  supabase: Parameters<typeof handleSubscriptionActivatedWithEvent>[0],
  resource: Parameters<typeof handleSubscriptionActivatedWithEvent>[1],
) => handleSubscriptionActivatedWithEvent(supabase, resource, {
  webhookEventId: 'EVT-DIRECT-SUBSCRIPTION-ACTIVATION',
  providerOccurredAt: '2026-07-29T00:00:00.000Z',
});

const handleSubscriptionCancelled = (
  supabase: Parameters<typeof handleSubscriptionCancelledWithChronology>[0],
  resource: Parameters<typeof handleSubscriptionCancelledWithChronology>[1],
  options: Parameters<typeof handleSubscriptionCancelledWithChronology>[2],
) => handleSubscriptionCancelledWithChronology(supabase, resource, {
  providerOccurredAt: '2026-07-29T00:00:00.000Z',
  ...options,
});

const handleSubscriptionSuspended = (
  supabase: Parameters<typeof handleSubscriptionSuspendedWithChronology>[0],
  resource: Parameters<typeof handleSubscriptionSuspendedWithChronology>[1],
  options: Parameters<typeof handleSubscriptionSuspendedWithChronology>[2],
) => handleSubscriptionSuspendedWithChronology(supabase, resource, {
  providerOccurredAt: '2026-07-29T00:00:00.000Z',
  ...options,
});

const EXACT_EXPIRED_SUBSCRIPTION_ORDER = {
  id: 'order-expired',
  order_number: 'ORD-EXPIRED',
  guild_id: 'guild-1',
  customer_id: 'customer-1',
  product_id: 'product-1',
  plan_id: 'plan-1',
  amount_cents: 1000,
  currency: 'USD',
  status: 'completed',
  paypal_subscription_id: 'SUB-EXPIRED',
};

const EXACT_SUBSCRIPTION_CUSTOMER = {
  id: 'customer-1',
  guild_id: 'guild-1',
  discord_id: 'discord-1',
};
const REPLAY_CLAIM_TOKEN = '11111111-1111-4111-8111-111111111111';

function makeReplay(body: unknown, headers: Record<string, string> = {}) {
  const payload = body && typeof body === 'object' && !Array.isArray(body)
    ? { create_time: '2026-07-29T00:00:00.000Z', ...body }
    : body;
  return new Request('http://localhost/api/paypal/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-replay-secret': replaySecret,
      'x-replay-claim-token': REPLAY_CLAIM_TOKEN,
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

function makeSignedWebhook(body: unknown) {
  const payload = body && typeof body === 'object' && !Array.isArray(body)
    ? { create_time: '2026-07-29T00:00:00.000Z', ...body }
    : body;
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
    body: JSON.stringify(payload),
  });
}

function providerIncidentResult(args: Record<string, unknown>) {
  const routableGuildId =
    typeof args.p_observed_guild_id === 'string'
    && args.p_observed_guild_id.length > 0
      ? args.p_observed_guild_id
      : null;
  return {
    data: {
      disposition: 'created',
      incident_id: 'provider-incident-1',
      webhook_event_id: args.p_webhook_event_id,
      provider_event_type: args.p_provider_event_type,
      provider_resource_id: args.p_provider_resource_id ?? null,
      provider_parent_id: args.p_provider_parent_id ?? null,
      observed_guild_id: args.p_observed_guild_id ?? null,
      routable_guild_id: routableGuildId,
      incident_reason: args.p_incident_reason,
      fulfillment_allowed: false,
      alert_id: routableGuildId ? 'provider-incident-alert-1' : null,
    },
    error: null,
  };
}

/**
 * Build a fully chainable mock Supabase client.
 * Every method returns the chain object itself (for .from().select().eq()...),
 * and the chain is also a thenable that resolves to { data: null, error: null }
 * so awaiting any chain position works.
 */
function makeMockSupabase() {
  const fromFn = vi.fn();
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<MockRowResult>
  >(async (name: string, args: Record<string, unknown>) =>
    name === 'webhooks_replay_claim_is_current'
      || name === 'webhooks_finish_replay_claim'
      ? { data: true, error: null }
      : name === 'commerce_record_provider_incident'
      ? providerIncidentResult(args)
      : { data: null, error: null });

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
  onUpsert?: (payload: unknown) => void,
  onSelect?: (columns: string) => void,
  onOrder?: (column: string, options: unknown) => void,
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
  chain.select = vi.fn((columns: string) => {
    onSelect?.(columns);
    return chain;
  });
  chain.order = vi.fn((column: string, options: unknown) => {
    onOrder?.(column, options);
    return chain;
  });
  chain.then = (
    resolve: (v: unknown) => void,
    reject?: (reason: unknown) => void,
  ) => Promise.resolve(resolvedValue).then(resolve, reject);

  return chain;
}

type MockRowResult = { data: unknown; error: unknown };

function useWebhookRows(
  rows: Record<string, MockRowResult | MockRowResult[]>,
  options: {
    chronologyResponse?: (
      canonical: Record<string, unknown>,
      args: Record<string, unknown>,
    ) => MockRowResult;
    lifecycleResponse?: (
      canonical: Record<string, unknown>,
      args: Record<string, unknown>,
    ) => MockRowResult;
  } = {},
) {
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const upserts: Array<{ table: string; payload: unknown }> = [];
  const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];
  const updates: Array<{ table: string; payload: unknown }> = [];
  const inCalls: Array<{ table: string; column: string; values: unknown[] }> = [];
  const selectCalls: Array<{ table: string; columns: string }> = [];
  const orderCalls: Array<{ table: string; column: string; options: unknown }> = [];
  const tableCallCounts = new Map<string, number>();
  mockSb.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (
      name === 'webhooks_replay_claim_is_current'
      || name === 'webhooks_finish_replay_claim'
    ) {
      return { data: true, error: null };
    }
    if (name === 'commerce_record_provider_incident') {
      return providerIncidentResult(args);
    }
    if (name === 'commerce_record_subscription_lifecycle_observation') {
      const canonical = {
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
      };
      return options.chronologyResponse
        ? options.chronologyResponse(canonical, args)
        : { data: canonical, error: null };
    }
    if (name === 'commerce_create_or_recover_subscription_lifecycle_action') {
      const firstResult = (table: string): MockRowResult => {
        const configured = rows[table] ?? { data: null, error: null };
        return Array.isArray(configured) ? configured[0]! : configured;
      };
      const order = firstResult('orders').data as Record<string, unknown>;
      const product = firstResult('products').data as Record<string, unknown>;
      const customer = firstResult('customers').data as Record<string, unknown>;
      const carrier = firstResult('bot_action_queue').data as
        | Record<string, unknown>
        | null;
      const carrierPayload = carrier?.payload as Record<string, unknown> | undefined;
      const fulfillmentType = String(args.p_fulfillment_type);
      const canonical = {
          action_id: 'action-lifecycle-1',
          disposition: 'created',
          action_status: 'pending',
          action: fulfillmentType === 'subscription_cancelled'
            ? 'fulfill_cancellation'
            : 'fulfill_suspension',
          idempotency_key:
            `paypal:lifecycle:${String(args.p_webhook_event_id)}:${fulfillmentType}`,
          webhook_event_id: args.p_webhook_event_id,
          fulfillment_type: fulfillmentType,
          guild_id: order.guild_id,
          customer_id: order.customer_id,
          discord_id:
            carrierPayload?.discord_id ?? customer?.discord_id ?? 'discord-1',
          product_id: order.product_id,
          product_name:
            carrierPayload?.product_name ?? product?.name ?? 'Subscription Product',
          order_id: order.id,
          order_number: order.order_number,
          plan_id: order.plan_id,
          paypal_subscription_id: order.paypal_subscription_id,
          amount_cents: order.amount_cents,
          currency: order.currency,
      };
      return options.lifecycleResponse
        ? options.lifecycleResponse(canonical, args)
        : { data: canonical, error: null };
    }
    if (name === 'commerce_record_paypal_refund_event') {
      const amount = typeof args.p_refund_amount_cents === 'number'
        ? args.p_refund_amount_cents
        : 1000;
      return {
        data: {
          payment_id: args.p_payment_id,
          order_id: args.p_order_id,
          paypal_refund_id: args.p_paypal_refund_id,
          event_type: args.p_event_type,
          refund_amount_cents: amount,
          currency: args.p_currency ?? 'USD',
          cumulative_refunded_cents: 1000,
          full_refund: true,
          already_recorded: false,
          terminal_witness: true,
          terminal_history_consistent: true,
          terminal_history_replay: false,
          terminal_payment_status: 'completed',
          partial_audit_recorded: false,
          partial_alert_recorded: false,
        },
        error: null,
      };
    }
    if (name === 'commerce_finalize_paypal_refund_status') {
      return {
        data: {
          order_id: args.p_order_id,
          payment_id: args.p_payment_id,
          order_status: 'refunded',
          payment_status: args.p_payment_status,
          already_terminal: false,
          audit_recorded: true,
          partial_alerts_resolved: 0,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  });
  mockSb.from.mockImplementation((table: string) => {
    const callCount = tableCallCounts.get(table) ?? 0;
    tableCallCounts.set(table, callCount + 1);
    let tableRows = rows[table] ?? { data: null, error: null };
    if (table === 'bot_action_queue' && !('products' in rows)) {
      const configuredOrder = rows.orders;
      const firstOrderResult = Array.isArray(configuredOrder)
        ? configuredOrder[0]
        : configuredOrder;
      const order = firstOrderResult?.data as Record<string, unknown> | null;
      if (
        order
        && typeof order.paypal_subscription_id === 'string'
        && order.paypal_subscription_id.length > 0
      ) {
        tableRows = {
          data: {
            id: 'action-activation-carrier',
            guild_id: order.guild_id,
            action: 'fulfill_subscription',
            lane: 'commerce',
            status: 'completed',
            idempotency_key:
              `paypal:subscription:${order.paypal_subscription_id}:fulfill_subscription`,
            payload: {
              fulfillment_type: 'subscription_activated',
              guild_id: order.guild_id,
              customer_id: order.customer_id,
              discord_id: 'discord-1',
              product_id: order.product_id,
              product_name: 'Subscription Product',
              order_id: order.id,
              order_number: order.order_number,
              plan_id: order.plan_id,
              paypal_plan_id: 'PAYPAL-PLAN-1',
              paypal_subscription_id: order.paypal_subscription_id,
              amount_cents: order.amount_cents,
              currency: order.currency,
              granted_role_ids: [],
              granted_channel_ids: [],
              entitlement_type: 'subscription',
            },
          },
          error: null,
        };
      }
    }
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
      (columns) => {
        selectCalls.push({ table, columns });
      },
      (column, options) => {
        orderCalls.push({ table, column, options });
      },
    );
  });

  return {
    inserts,
    upserts,
    eqCalls,
    updates,
    inCalls,
    selectCalls,
    orderCalls,
    rpc: mockSb.rpc,
  };
}

const ORIGINAL_ROLE = '111111111111111111';
const ORIGINAL_CHANNEL = '222222222222222222';
const ORIGINAL_TEMP_ROLE = '333333333333333333';

function createCaptureRecoveryHarness(options: {
  withLicense?: boolean;
  subscription?: boolean;
  failStageAttempts?: number;
  failLicenseAttempts?: number;
  failReleaseAttempts?: number;
  failOrderCompleteAttempts?: number;
  failOrderPriceUpdateAttempts?: number;
  failCustomerReadAttempts?: number;
  failClaimAttempts?: number;
  failAlertInsertAttempts?: number;
  signedCheckout?: boolean;
} = {}) {
  const state: any = {
    order: {
      id: 'order-1',
      order_number: 'ORD-RECOVERY-1',
      customer_id: 'customer-1',
      guild_id: 'guild-1',
      product_id: 'product-1',
      plan_id: options.subscription ? 'plan-1' : null,
      amount_cents: 999,
      currency: 'USD',
      status: 'pending',
      source: 'purchase',
      checkout_active: true,
      grant_snapshot_frozen_at: null,
      delivery_type_snapshot: options.withLicense ? 'license_key' : 'access_pass',
      paypal_order_id: options.subscription ? null : 'PAYPAL-ORDER-RECOVERY-1',
      paypal_subscription_id: options.subscription ? 'SUB-RECOVERY-1' : null,
    },
    customer: { id: 'customer-1', guild_id: 'guild-1', discord_id: 'discord-1' },
    product: { id: 'product-1', guild_id: 'guild-1', name: 'Original Product' },
    plan: {
      id: 'plan-1',
      guild_id: 'guild-1',
      product_id: 'product-1',
      paypal_plan_id: 'PAYPAL-PLAN-1',
    },
    currentSnapshot: {
      granted_role_ids_snapshot: [ORIGINAL_ROLE],
      granted_channel_ids_snapshot: [ORIGINAL_CHANNEL],
      temporary_role_grants_snapshot: [
        { role_id: ORIGINAL_TEMP_ROLE, duration_seconds: 3600 },
      ],
    },
    frozenSnapshot: null,
    legacySubscriptionContract: null,
    payment: null,
    queue: null,
    licenseKey: null,
    totalsApplied: 0,
    failStageAttempts: options.failStageAttempts ?? 0,
    failLicenseAttempts: options.failLicenseAttempts ?? 0,
    failReleaseAttempts: options.failReleaseAttempts ?? 0,
    failOrderCompleteAttempts: options.failOrderCompleteAttempts ?? 0,
    failOrderPriceUpdateAttempts: options.failOrderPriceUpdateAttempts ?? 0,
    failCustomerReadAttempts: options.failCustomerReadAttempts ?? 0,
    failClaimAttempts: options.failClaimAttempts ?? 0,
    failAlertInsertAttempts: options.failAlertInsertAttempts ?? 0,
    fulfillmentClaimOrderId: null,
    fulfillmentHold: null,
    providerIncidents: [] as Array<Record<string, unknown>>,
    inserts: [] as Array<{ table: string; payload: any }>,
    updates: [] as Array<{ table: string; payload: any }>,
  };
  state.checkoutIntent = options.signedCheckout ? {
    token: '01234567-89ab-4cde-8fab-0123456789ab',
    guild_id: state.order.guild_id,
    customer_id: state.order.customer_id,
    product_id: state.order.product_id,
    gift_checkout_token: null,
    provider_id: state.order.paypal_order_id,
    expires_at: '2099-01-01T00:00:00.000Z',
    approval_exposed_at: '2026-08-11T00:00:00.000Z',
    status: 'bound',
  } : null;
  state.orders = [state.order];

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (
      name === 'webhooks_replay_claim_is_current'
      || name === 'webhooks_finish_replay_claim'
    ) {
      return { data: true, error: null };
    }
    if (name === 'commerce_record_provider_incident') {
      state.providerIncidents.push(structuredClone(args));
      return providerIncidentResult(args);
    }
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
    if (name === 'commerce_reprice_pending_subscription_order') {
      if (state.failOrderPriceUpdateAttempts > 0) {
        state.failOrderPriceUpdateAttempts -= 1;
        return { data: null, error: null };
      }
      if (
        args.p_order_id !== state.order.id
        || args.p_guild_id !== state.order.guild_id
        || args.p_customer_id !== state.order.customer_id
        || args.p_product_id !== state.order.product_id
        || args.p_plan_id !== state.order.plan_id
        || args.p_paypal_subscription_id !== state.order.paypal_subscription_id
        || !['pending', 'pending_review'].includes(state.order.status)
      ) {
        return { data: null, error: { message: 'subscription reprice identity mismatch' } };
      }
      state.order.status = 'pending_review';
      const mismatchAlert = (state.alerts ??= []).find(
        (alert: any) =>
          alert.alert_type === 'commerce_subscription_financial_mismatch'
          && alert.metadata?.order_id === state.order.id
          && alert.resolved === false,
      );
      if (!mismatchAlert) {
        state.alerts.push({
          id: 'alert-subscription-financial-mismatch',
          guild_id: state.order.guild_id,
          alert_type: 'commerce_subscription_financial_mismatch',
          severity: 'critical',
          resolved: false,
          metadata: { order_id: state.order.id },
        });
      }
      return {
        data: {
          order_id: state.order.id,
          guild_id: state.order.guild_id,
          status: 'pending_review',
          amount_cents: state.order.amount_cents,
          currency: state.order.currency,
          disposition: 'held_financial_mismatch',
          alert_id: 'alert-subscription-financial-mismatch',
        },
        error: null,
      };
    }
    if (name === 'commerce_complete_pending_subscription_order') {
      if (state.failOrderCompleteAttempts > 0) {
        state.failOrderCompleteAttempts -= 1;
        return {
          data: null,
          error: { message: 'order completion unavailable', code: '08006' },
        };
      }
      if (
        args.p_order_id !== state.order.id
        || args.p_guild_id !== state.order.guild_id
        || args.p_customer_id !== state.order.customer_id
        || args.p_product_id !== state.order.product_id
        || args.p_plan_id !== state.order.plan_id
        || args.p_paypal_subscription_id !== state.order.paypal_subscription_id
        || args.p_amount_cents !== state.order.amount_cents
        || args.p_currency !== state.order.currency
        || !state.queue
        || state.queue.status !== 'staged'
        || state.queue.payload.order_id !== state.order.id
        || state.fulfillmentClaimOrderId !== state.order.id
      ) {
        return { data: null, error: { message: 'subscription completion identity mismatch' } };
      }
      if (state.order.status === 'pending') state.order.status = 'completed';
      if (state.order.status !== 'completed') {
        return { data: null, error: { message: 'subscription completion state mismatch' } };
      }
      return {
        data: {
          order_id: state.order.id,
          guild_id: state.order.guild_id,
          status: 'completed',
          amount_cents: state.order.amount_cents,
          currency: state.order.currency,
        },
        error: null,
      };
    }
    if (name === 'bot_action_queue_release_staged') {
      if (state.failReleaseAttempts > 0) {
        state.failReleaseAttempts -= 1;
        return { data: null, error: { message: 'queue release unavailable', code: '08006' } };
      }
      if (!state.queue
        || args.p_action_id !== state.queue.id
        || args.p_guild_id !== state.queue.guild_id
        || args.p_idempotency_key !== state.queue.idempotency_key) {
        return { data: [], error: null };
      }
      if (state.queue.status === 'staged') {
        state.queue.status = 'pending';
        return {
          data: [{
            action_id: state.queue.id,
            action_status: 'pending',
            disposition: 'released',
          }],
          error: null,
        };
      }
      if (['pending', 'processing', 'completed', 'failed'].includes(state.queue.status)) {
        return {
          data: [{
            action_id: state.queue.id,
            action_status: state.queue.status,
            disposition: 'already_released',
          }],
          error: null,
        };
      }
      return { data: null, error: { message: 'invalid queue status', code: '23514' } };
    }
    if (name === 'commerce_freeze_order_grant_snapshot') {
      if (state.order.status !== 'pending' && !state.order.grant_snapshot_frozen_at) {
        return {
          data: null,
          error: { message: 'only pending orders can freeze a grant snapshot', code: '23514' },
        };
      }
      if (!state.frozenSnapshot) state.frozenSnapshot = structuredClone(state.currentSnapshot);
      state.order.grant_snapshot_frozen_at = '2026-07-11T00:00:00.000Z';
      return {
        data: {
          order_id: state.order.id,
          ...structuredClone(state.frozenSnapshot),
          grant_snapshot_frozen_at: '2026-07-11T00:00:00.000Z',
        },
        error: null,
      };
    }
    if (name === 'commerce_adopt_legacy_subscription_grant_contract') {
      if (
        args.p_order_id !== state.order.id
        || args.p_source_queue_id !== state.queue?.id
        || !state.queue
      ) {
        return { data: null, error: { message: 'legacy contract identity mismatch', code: 'P0001' } };
      }
      const candidate = {
        order_id: state.order.id,
        source_queue_id: state.queue.id,
        granted_role_ids_snapshot: structuredClone(state.queue.payload.granted_role_ids),
        granted_channel_ids_snapshot: structuredClone(state.queue.payload.granted_channel_ids),
        persisted_at: '2026-07-11T00:01:00.000Z',
      };
      if (
        state.legacySubscriptionContract
        && JSON.stringify(state.legacySubscriptionContract) !== JSON.stringify(candidate)
      ) {
        return { data: null, error: { message: 'immutable replay mismatch', code: 'P0001' } };
      }
      state.legacySubscriptionContract ??= candidate;
      return { data: structuredClone(state.legacySubscriptionContract), error: null };
    }
    if (name === 'commerce_hold_unknown_delivery_contract') {
      if (state.failClaimAttempts > 0) {
        state.failClaimAttempts -= 1;
        return { data: null, error: { message: 'claim database unavailable', code: '08006' } };
      }
      if (state.failAlertInsertAttempts > 0) {
        state.failAlertInsertAttempts -= 1;
        return {
          data: null,
          error: { message: 'unknown delivery alert unavailable', code: '08006' },
        };
      }

      const existingAlert = (state.alerts ?? []).find(
        (alert: any) =>
          alert.alert_type === 'commerce_unknown_delivery_contract'
          && alert.metadata?.order_id === state.order.id
          && alert.resolved !== true,
      );
      state.fulfillmentClaimOrderId ??= state.order.id;
      state.fulfillmentHold = {
        winning_order_id: state.order.id,
        conflicting_entitlement_id: null,
        hold_reason: 'unknown_delivery_contract',
      };
      const alert = existingAlert ?? {
        id: 'alert-unknown-delivery',
        guild_id: state.order.guild_id,
        alert_type: 'commerce_unknown_delivery_contract',
        severity: 'critical',
        title: 'Paid order requires manual delivery review',
        message: 'Paid order has no immutable delivery contract.',
        resolved: false,
        metadata: {
          order_id: state.order.id,
          order_number: state.order.order_number,
          customer_id: state.order.customer_id,
          product_id: state.order.product_id,
          provider_kind: args.p_provider_kind,
          provider_id: args.p_provider_id,
          amount_cents: args.p_amount_cents,
          currency: args.p_currency,
          winning_order_id: state.order.id,
          existing_entitlement_id: null,
          hold_reason: 'unknown_delivery_contract',
          required_action: 'manual_fulfillment_or_refund',
        },
      };
      if (!existingAlert) (state.alerts ??= []).push(alert);
      return {
        data: {
          order_id: state.order.id,
          disposition: 'held',
          winning_order_id: state.order.id,
          conflicting_entitlement_id: null,
          alert_id: alert.id,
        },
        error: null,
      };
    }
    if (name === 'commerce_claim_paid_fulfillment') {
      if (state.failClaimAttempts > 0) {
        state.failClaimAttempts -= 1;
        return { data: null, error: { message: 'claim database unavailable', code: '08006' } };
      }
      if (state.fulfillmentHold) {
        const existingAlert = (state.alerts ?? []).find(
          (alert: any) =>
            alert.metadata?.order_id === state.order.id
            && alert.resolved !== true,
        );
        if (!existingAlert) {
          (state.alerts ??= []).push({
            id: 'alert-claim-hold',
            guild_id: state.order.guild_id,
            alert_type: args.p_provider_kind === 'capture'
              ? 'commerce_duplicate_purchase_capture'
              : 'commerce_duplicate_subscription_activation',
            severity: 'critical',
            message: `Paid order ${state.order.order_number} was held; refund required.`,
            metadata: {
              order_id: state.order.id,
              provider_id: args.p_provider_id,
              winning_order_id: state.fulfillmentHold.winning_order_id,
              existing_entitlement_id:
                state.fulfillmentHold.conflicting_entitlement_id,
            },
          });
        }
        return {
          data: {
            order_id: state.order.id,
            disposition: 'held',
            winning_order_id: state.fulfillmentHold.winning_order_id,
            conflicting_entitlement_id:
              state.fulfillmentHold.conflicting_entitlement_id,
            alert_id: 'alert-claim-hold',
          },
          error: null,
        };
      }

      const liveStatuses = ['active', 'pending', 'grace_period', 'suspended'];
      const liveEntitlements = (state.entitlements ?? []).filter(
        (entitlement: any) =>
          entitlement.guild_id === state.order.guild_id
          && entitlement.customer_id === state.order.customer_id
          && entitlement.product_id === state.order.product_id
          && liveStatuses.includes(entitlement.status),
      );
      const sameOrderEntitlement = liveEntitlements.find(
        (entitlement: any) => entitlement.order_id === state.order.id,
      );
      const conflictingEntitlement = liveEntitlements.find(
        (entitlement: any) => entitlement.order_id !== state.order.id,
      );

      if (sameOrderEntitlement) {
        state.fulfillmentClaimOrderId ??= state.order.id;
        return {
          data: {
            order_id: state.order.id,
            disposition: 'winner',
            winning_order_id: state.order.id,
            conflicting_entitlement_id: null,
            alert_id: null,
          },
          error: null,
        };
      }

      const winningOrderId = conflictingEntitlement?.order_id
        ?? (
          state.fulfillmentClaimOrderId !== state.order.id
            ? state.fulfillmentClaimOrderId
            : null
        );
      if (conflictingEntitlement || winningOrderId) {
        state.fulfillmentHold = {
          winning_order_id: winningOrderId,
          conflicting_entitlement_id: conflictingEntitlement?.id ?? null,
        };
        if (
          args.p_provider_kind === 'subscription'
          && ['pending', 'completed'].includes(state.order.status)
        ) {
          state.order.status = 'pending_review';
        }
        const alert = {
          id: 'alert-claim-hold',
          guild_id: state.order.guild_id,
          alert_type: args.p_provider_kind === 'capture'
            ? 'commerce_duplicate_purchase_capture'
            : 'commerce_duplicate_subscription_activation',
          severity: 'critical',
          message:
            `Paid order ${state.order.order_number} lost the atomic fulfillment claim; `
            + 'review and refund/cancel this exact order.',
          metadata: {
            order_id: state.order.id,
            provider_id: args.p_provider_id,
            ...(args.p_provider_kind === 'capture'
              ? { paypal_capture_id: args.p_provider_id }
              : { paypal_subscription_id: args.p_provider_id }),
            amount_cents: args.p_amount_cents,
            currency: args.p_currency,
            winning_order_id: winningOrderId,
            existing_entitlement_id: conflictingEntitlement?.id ?? null,
          },
        };
        (state.alerts ??= []).push(alert);
        return {
          data: {
            order_id: state.order.id,
            disposition: 'held',
            winning_order_id: winningOrderId,
            conflicting_entitlement_id: conflictingEntitlement?.id ?? null,
            alert_id: alert.id,
          },
          error: null,
        };
      }

      state.fulfillmentClaimOrderId = state.order.id;
      return {
        data: {
          order_id: state.order.id,
          disposition: 'winner',
          winning_order_id: state.order.id,
          conflicting_entitlement_id: null,
          alert_id: null,
        },
        error: null,
      };
    }
    if (name === 'commerce_finalize_paypal_capture') {
      const completed = args.p_amount_cents === state.order.amount_cents
        && String(args.p_currency).toUpperCase() === String(state.order.currency).toUpperCase()
        && args.p_paypal_order_id === state.order.paypal_order_id;
      if (state.order.status === 'refunded' || state.order.status === 'disputed') {
        const exactReplay = completed
          && state.payment?.paypal_payment_id === args.p_paypal_capture_id;
        if (!exactReplay) {
          return {
            data: null,
            error: { message: 'successor replay identity mismatch', code: 'P0001' },
          };
        }
        return {
          data: {
            order_id: state.order.id,
            order_status: state.order.status,
            payment_id: state.payment.id,
            payment_created: false,
          },
          error: null,
        };
      }
      if (state.order.status === 'completed' && state.payment) {
        const exactReplay = completed
          && state.payment.paypal_payment_id === args.p_paypal_capture_id;
        if (!exactReplay) {
          return {
            data: null,
            error: { message: 'completed replay identity mismatch', code: 'P0001' },
          };
        }
        return {
          data: {
            order_id: state.order.id,
            order_status: 'completed',
            payment_id: state.payment.id,
            payment_created: false,
          },
          error: null,
        };
      }
      if (!state.order.grant_snapshot_frozen_at || !state.frozenSnapshot) {
        return {
          data: null,
          error: { message: 'capture order grant snapshot is not frozen', code: '23514' },
        };
      }
      const paymentCreated = !state.payment;
      if (paymentCreated) {
        state.payment = {
          id: 'payment-1',
          order_id: state.order.id,
          paypal_payment_id: args.p_paypal_capture_id,
        };
        if (completed) state.totalsApplied += 1;
      }
      state.order.status = completed ? 'completed' : 'pending_review';
      return {
        data: {
          order_id: state.order.id,
          order_status: state.order.status,
          payment_id: state.payment.id,
          payment_created: paymentCreated,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  });

  function from(table: string) {
    let operation: 'read' | 'insert' | 'update' = 'read';
    let payload: any = null;
    const filters: Array<(row: any) => boolean> = [];
    let limitCount: number | null = null;

    const tableRows = () => {
      if (table === 'orders') return state.orders;
      if (table === 'payments') return state.payment ? [state.payment] : [];
      if (table === 'customers') return state.customer ? [state.customer] : [];
      if (table === 'products') return state.product ? [state.product] : [];
      if (table === 'plans') return state.plan ? [state.plan] : [];
      if (table === 'product_license_config') {
        return options.withLicense ? [{ product_id: state.order.product_id }] : [];
      }
      if (table === 'commerce_checkout_intents') {
        return state.checkoutIntent ? [state.checkoutIntent] : [];
      }
      if (table === 'bot_action_queue') return state.queue ? [state.queue] : [];
      if (table === 'license_keys') return state.licenseKey ? [state.licenseKey] : [];
      // Duplicate-purchase rail (Finding 10): empty by default, so every other
      // case in this file keeps its existing single-purchase behaviour.
      if (table === 'entitlements') return state.entitlements ?? [];
      if (table === 'alerts') return state.alerts ?? [];
      return [];
    };

    const matchingRows = () => {
      let rows = tableRows().filter((row: any) => filters.every((filter) => filter(row)));
      if (limitCount !== null) rows = rows.slice(0, limitCount);
      return rows;
    };

    const resolve = () => {
      if (operation === 'read') {
        if (table === 'customers' && state.failCustomerReadAttempts > 0) {
          state.failCustomerReadAttempts -= 1;
          return { data: null, error: { message: 'customer lookup unavailable', code: '08006' } };
        }
        return { data: matchingRows(), error: null };
      }
      if (operation === 'insert') {
        state.inserts.push({ table, payload: structuredClone(payload) });
        if (table === 'alerts') {
          if (state.failAlertInsertAttempts > 0) {
            state.failAlertInsertAttempts -= 1;
            return { data: null, error: { message: 'alerts unavailable', code: '08006' } };
          }
          (state.alerts ??= []).push(structuredClone(payload));
          return { data: payload, error: null };
        }
        if (table === 'bot_action_queue') {
          if (state.failStageAttempts > 0) {
            state.failStageAttempts -= 1;
            return { data: null, error: { message: 'queue unavailable', code: '08006' } };
          }
          if (state.queue) {
            return { data: null, error: { message: 'duplicate queue key', code: '23505' } };
          }
          state.queue = { id: 'queue-1', ...structuredClone(payload) };
          return { data: state.queue, error: null };
        }
        if (table === 'license_keys') {
          if (state.failLicenseAttempts > 0) {
            state.failLicenseAttempts -= 1;
            return { data: null, error: { message: 'license storage unavailable', code: '08006' } };
          }
          if (state.licenseKey) {
            return { data: null, error: { message: 'duplicate license key', code: '23505' } };
          }
          state.licenseKey = structuredClone(payload);
          return { data: state.licenseKey, error: null };
        }
        return { data: payload, error: null };
      }

      state.updates.push({ table, payload: structuredClone(payload) });
      if (
        table === 'orders' &&
        payload?.status === 'completed' &&
        state.failOrderCompleteAttempts > 0
      ) {
        state.failOrderCompleteAttempts -= 1;
        return { data: null, error: { message: 'order completion unavailable', code: '08006' } };
      }
      if (
        table === 'orders' &&
        payload?.amount_cents !== undefined &&
        state.failOrderPriceUpdateAttempts > 0
      ) {
        state.failOrderPriceUpdateAttempts -= 1;
        return { data: null, error: null };
      }
      const row = matchingRows()[0] ?? null;
      if (row) Object.assign(row, payload);
      return { data: row, error: null };
    };

    const terminal = async () => {
      const result = resolve();
      return {
        ...result,
        data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
      };
    };

    const chain: any = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return chain;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return chain;
      },
      order: () => chain,
      limit: (count: number) => {
        limitCount = count;
        return chain;
      },
      insert: (value: unknown) => {
        operation = 'insert';
        payload = value;
        return chain;
      },
      update: (value: unknown) => {
        operation = 'update';
        payload = value;
        return chain;
      },
      single: terminal,
      maybeSingle: terminal,
      then: (
        resolvePromise: (value: unknown) => unknown,
        rejectPromise?: (reason: unknown) => unknown,
      ) => Promise.resolve(resolve()).then(resolvePromise, rejectPromise),
    };
    return chain;
  }

  return { supabase: { from, rpc } as any, state, rpc };
}

let mockSb: ReturnType<typeof makeMockSupabase>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPayPalRuntimeConfig).mockResolvedValue({
    apiBase: 'https://api-m.sandbox.paypal.com',
    clientSecret: paypalClientSecret,
    webhookId: 'test-webhook-id',
  } as never);
  vi.mocked(getPayPalToken).mockResolvedValue('test-token');
  vi.mocked(getPayPalTokenResult).mockResolvedValue({
    ok: true,
    token: 'test-token',
  });
  vi.mocked(getSubscriptionAmount).mockResolvedValue({
    amountCents: 999,
    currency: 'USD',
    planId: 'PAYPAL-PLAN-1',
    nextBillingTime: '2026-08-29T00:00:00.000Z',
  });
  vi.mocked(rateLimits.paypalWebhook).mockResolvedValue({
    limited: false,
    remaining: 1,
    retryAfterMs: 0,
  });
  mockSb = makeMockSupabase();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSb);
});

describe('PayPal webhook — edge cases', () => {
  const exactLifecycleRows = {
    orders: {
      data: {
        id: 'order-lifecycle',
        order_number: 'ORD-LIFECYCLE',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        product_id: 'product-1',
        plan_id: 'plan-1',
        paypal_subscription_id: 'SUB-LIFECYCLE',
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
      },
      error: null,
    },
    products: {
      data: { id: 'product-1', guild_id: 'guild-1', name: 'Subscription Product' },
      error: null,
    },
    customers: { data: EXACT_SUBSCRIPTION_CUSTOMER, error: null },
    bot_action_queue: {
      data: {
        id: 'activation-carrier-1',
        guild_id: 'guild-1',
        action: 'fulfill_subscription',
        lane: 'commerce',
        status: 'completed',
        idempotency_key:
          'paypal:subscription:SUB-LIFECYCLE:fulfill_subscription',
        payload: {
          fulfillment_type: 'subscription_activated',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          discord_id: 'discord-at-commit',
          product_id: 'product-1',
          product_name: 'Original Product',
          order_id: 'order-lifecycle',
          order_number: 'ORD-LIFECYCLE',
          plan_id: 'plan-1',
          paypal_plan_id: 'PAYPAL-PLAN-1',
          paypal_subscription_id: 'SUB-LIFECYCLE',
          entitlement_type: 'subscription',
        },
      },
      error: null,
    },
  } satisfies Record<string, MockRowResult>;

  const lifecycleLookupFailures: Array<
    [string, Record<string, MockRowResult | MockRowResult[]>]
  > = [
    [
      'order database error',
      { ...exactLifecycleRows, orders: { data: null, error: { message: 'order unavailable' } } },
    ],
    ['missing order', { ...exactLifecycleRows, orders: { data: null, error: null } }],
    [
      'malformed order',
      {
        ...exactLifecycleRows,
        orders: {
          data: { ...exactLifecycleRows.orders.data, order_number: '' },
          error: null,
        },
      },
    ],
    [
      'mismatched order',
      {
        ...exactLifecycleRows,
        orders: {
          data: {
            ...exactLifecycleRows.orders.data,
            paypal_subscription_id: 'SUB-OTHER',
          },
          error: null,
        },
      },
    ],
  ];

  for (const [operation, handler] of [
    ['subscription cancellation', handleSubscriptionCancelled],
    ['subscription suspension', handleSubscriptionSuspended],
  ] as const) {
    it.each(lifecycleLookupFailures)(
      `${operation} rejects a %s without queueing fulfillment`,
      async (_caseName, rows) => {
        const { inserts } = useWebhookRows(rows);

        await expect(handler(
          mockSb as never,
          { id: 'SUB-LIFECYCLE' },
          { webhookEventId: 'EVT-LIFECYCLE-LOOKUP' },
        )).rejects.toThrow();
        expect(inserts).not.toContainEqual(
          expect.objectContaining({ table: 'bot_action_queue' }),
        );
      },
    );
  }

  it('recovers a lifecycle carrier after mutable product and Discord display identity changed', async () => {
    const { rpc, inserts } = useWebhookRows(
      {
        ...exactLifecycleRows,
        products: {
          data: { ...exactLifecycleRows.products.data, name: 'Renamed Product' },
          error: null,
        },
        customers: {
          data: {
            id: 'customer-1',
            guild_id: 'guild-1',
            discord_id: 'discord-current',
          },
          error: null,
        },
      },
      {
        lifecycleResponse: (canonical) => ({
          data: {
            ...canonical,
            disposition: 'replay',
            action_status: 'processing',
            product_name: 'Original Product',
            discord_id: 'discord-at-commit',
          },
          error: null,
        }),
      },
    );

    await expect(handleSubscriptionCancelled(
      mockSb as never,
      { id: 'SUB-LIFECYCLE' },
      { webhookEventId: 'EVT-LIFECYCLE-REPLAY' },
    )).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith(
      'commerce_create_or_recover_subscription_lifecycle_action',
      expect.objectContaining({
        p_webhook_event_id: 'EVT-LIFECYCLE-REPLAY',
        p_fulfillment_type: 'subscription_cancelled',
        p_customer_id: 'customer-1',
        p_product_id: 'product-1',
        p_order_id: 'order-lifecycle',
        p_plan_id: 'plan-1',
        p_paypal_subscription_id: 'SUB-LIFECYCLE',
      }),
    );
    expect(inserts.filter(({ table }) => table === 'bot_action_queue')).toEqual([]);
  });

  it('fails closed on an operator-held lifecycle carrier without inserting a replacement', async () => {
    const { inserts } = useWebhookRows(exactLifecycleRows, {
      lifecycleResponse: (canonical) => ({
        data: {
          ...canonical,
          disposition: 'operator_held',
          action_status: 'failed',
        },
        error: null,
      }),
    });

    await expect(handleSubscriptionSuspended(
      mockSb as never,
      { id: 'SUB-LIFECYCLE' },
      { webhookEventId: 'EVT-LIFECYCLE-HELD' },
    )).rejects.toThrow('operator-held');
    expect(inserts.filter(({ table }) => table === 'bot_action_queue')).toEqual([]);
  });

  it.each([
    ['action id', { action_id: null }],
    ['order id', { order_id: 'wrong-order' }],
    ['plan id', { plan_id: 'wrong-plan' }],
    ['amount', { amount_cents: 1000 }],
    ['currency', { currency: 'EUR' }],
    ['event id', { webhook_event_id: 'wrong-event' }],
  ])('rejects lifecycle RPC evidence with one corrupted %s', async (_label, corruption) => {
    useWebhookRows(exactLifecycleRows, {
      lifecycleResponse: (canonical) => ({
        data: { ...canonical, ...corruption },
        error: null,
      }),
    });

    await expect(handleSubscriptionCancelled(
      mockSb as never,
      { id: 'SUB-LIFECYCLE' },
      { webhookEventId: 'EVT-LIFECYCLE-CORRUPT' },
    )).rejects.toThrow('malformed identity');
  });

  it('capture without custom_id persists an access-blocking provider incident', async () => {
    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAP-NO-META', amount: { value: '10.00', currency_code: 'USD' } },
      id: 'EVT-NO-META',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(mockSb.rpc).toHaveBeenCalledWith(
      'commerce_record_provider_incident',
      expect.objectContaining({
        p_webhook_event_id: 'EVT-NO-META',
        p_provider_event_type: 'PAYMENT.CAPTURE.COMPLETED',
        p_provider_resource_id: 'CAP-NO-META',
        p_incident_reason: 'custom_identity_missing_or_malformed',
      }),
    );
  });

  it('empty event_type is rejected by Zod (min 1)', async () => {
    const req = makeReplay({
      event_type: '',
      resource: {},
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it('subscription cancellation with an unknown subscription stays retryable', async () => {
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
      resource: { id: 'SUB-NONEXISTENT' },
      id: 'EVT-CANCEL-MISS',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
  });

  it('subscription suspension with an unknown subscription stays retryable', async () => {
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
      resource: { id: 'SUB-NONEXISTENT-2' },
      id: 'EVT-SUSPEND-MISS',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
  });

  it.each([
    ['router error', { data: null, error: { message: 'router collision' } }],
    ['malformed router result', { data: { disposition: 'replay' }, error: null }],
  ])('subscription sale %s persists an immutable provider incident', async (
    _failure,
    routerResult,
  ) => {
    const order = {
      id: 'order-sale-router-failure',
      order_number: 'ORD-SALE-ROUTER-FAILURE',
      guild_id: 'guild-1',
      customer_id: 'customer-1',
      product_id: 'product-1',
      plan_id: 'plan-1',
      paypal_subscription_id: 'SUB-SALE-ROUTER-FAILURE',
      amount_cents: 999,
      currency: 'USD',
      status: 'completed',
    };
    const { rpc } = useWebhookRows({
      orders: { data: order, error: null },
    });
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'commerce_record_provider_incident') {
        return providerIncidentResult(args);
      }
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
        return routerResult;
      }
      return { data: null, error: null };
    });

    await expect(handleSubscriptionPayment(
      mockSb as unknown as Parameters<typeof handleSubscriptionPayment>[0],
      {
        id: 'SALE-ROUTER-FAILURE',
        billing_agreement_id: order.paypal_subscription_id,
        amount: { total: '9.99', currency: 'USD' },
      },
      {
        webhookEventId: 'EVT-SALE-ROUTER-FAILURE',
        providerOccurredAt: '2026-07-29T00:00:00.000Z',
      },
    )).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledWith(
      'commerce_record_provider_incident',
      {
        p_webhook_event_id: 'EVT-SALE-ROUTER-FAILURE',
        p_provider_event_type: 'PAYMENT.SALE.COMPLETED',
        p_provider_resource_id: 'SALE-ROUTER-FAILURE',
        p_provider_parent_id: 'SUB-SALE-ROUTER-FAILURE',
        p_observed_guild_id: 'guild-1',
        p_incident_reason: 'subscription_sale_router_failed',
        p_evidence: {
          paypal_payment_id: 'SALE-ROUTER-FAILURE',
          paypal_subscription_id: 'SUB-SALE-ROUTER-FAILURE',
          order_id: 'order-sale-router-failure',
          order_number: 'ORD-SALE-ROUTER-FAILURE',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          provider_amount_cents: 999,
          provider_currency: 'USD',
        },
      },
    );
  });

  it('subscription payment failure queues grace-period suspension fulfillment', async () => {
    const { inserts, rpc } = useWebhookRows({
      orders: {
        data: {
          id: 'order-payment-failed',
          order_number: 'ORD-PAYMENT-FAILED',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          paypal_subscription_id: 'SUB-FAILED-PAYMENT',
          amount_cents: 999,
          currency: 'USD',
          status: 'completed',
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
      bot_action_queue: {
        data: {
          id: 'activation-carrier-payment-failed',
          guild_id: 'guild-1',
          action: 'fulfill_subscription',
          lane: 'commerce',
          status: 'completed',
          idempotency_key:
            'paypal:subscription:SUB-FAILED-PAYMENT:fulfill_subscription',
          payload: {
            fulfillment_type: 'subscription_activated',
            guild_id: 'guild-1',
            customer_id: 'customer-1',
            discord_id: 'discord-1',
            product_id: 'product-1',
            product_name: 'Subscription',
            order_id: 'order-payment-failed',
            order_number: 'ORD-PAYMENT-FAILED',
            plan_id: 'plan-1',
            paypal_plan_id: 'PAYPAL-PLAN-1',
            paypal_subscription_id: 'SUB-FAILED-PAYMENT',
            entitlement_type: 'subscription',
          },
        },
        error: null,
      },
    });
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
      resource: { id: 'SUB-FAILED-PAYMENT' },
      id: 'EVT-PAYMENT-FAILED',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(inserts.filter(({ table }) => table === 'bot_action_queue')).toEqual([]);
    expect(rpc).toHaveBeenCalledWith(
      'commerce_create_or_recover_subscription_lifecycle_action',
      {
        p_webhook_event_id: 'EVT-PAYMENT-FAILED',
        p_fulfillment_type: 'subscription_payment_failed',
        p_guild_id: 'guild-1',
        p_customer_id: 'customer-1',
        p_discord_id: 'discord-1',
        p_product_id: 'product-1',
        p_order_id: 'order-payment-failed',
        p_plan_id: 'plan-1',
        p_paypal_subscription_id: 'SUB-FAILED-PAYMENT',
      },
    );
  });


  it.each([
    ['database error', { data: null, error: { message: 'order lookup unavailable' } }],
    ['missing row', { data: null, error: null }],
    [
      'malformed row',
      {
        data: {
          ...EXACT_EXPIRED_SUBSCRIPTION_ORDER,
          status: '',
        },
        error: null,
      },
    ],
    [
      'mismatched row',
      {
        data: {
          ...EXACT_EXPIRED_SUBSCRIPTION_ORDER,
          paypal_subscription_id: 'SUB-WRONG',
        },
        error: null,
      },
    ],
  ])('subscription expiry fails closed on an exact-order %s', async (_caseName, orderResult) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { inserts, updates, rpc } = useWebhookRows({ orders: orderResult });
      const req = makeReplay({
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-EXPIRED' },
        id: `EVT-SUB-EXPIRED-${_caseName}`,
      });

      const res = await POST(req as never);
      expect(res.status).toBe(500);
      expect(inserts).toEqual([]);
      expect(rpc).toHaveBeenCalledWith(
        'webhooks_finish_replay_claim',
        expect.objectContaining({
          p_result: 'error',
          p_claim_token: REPLAY_CLAIM_TOKEN,
        }),
      );
      expect(updates.filter(({ table }) => table !== 'webhook_events')).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('routes an internal replay failure alert to the claimed event guild', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { inserts } = useWebhookRows({
        orders: { data: null, error: { message: 'order lookup unavailable' } },
      });
      const req = makeReplay({
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-EXPIRED' },
        id: 'EVT-SUB-EXPIRED-ALERT-GUILD',
      }, {
        'x-replay-guild-id': 'guild-1',
      });

      const res = await POST(req as never);

      expect(res.status).toBe(500);
      expect(inserts).toContainEqual({
        table: 'alerts',
        payload: expect.objectContaining({
          guild_id: 'guild-1',
          alert_type: 'paypal_webhook_processing_error',
        }),
      });
    } finally {
      errorSpy.mockRestore();
    }
  });


  it('records guild_id on persisted capture refund webhook events', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { upserts } = useWebhookRows({
        payments: [
          { data: { guild_id: 'guild-1' }, error: null },
          {
            data: {
              id: 'payment-row-1',
              order_id: 'order-1',
              customer_id: 'customer-1',
              guild_id: 'guild-1',
              paypal_payment_id: 'CAPTURE-1',
              paypal_resource_type: 'capture',
              status: 'completed',
              amount_cents: 1000,
              currency: 'USD',
            },
            error: null,
          },
        ],
        webhook_events: { data: [{ event_id: 'EVT-CAPTURE-REFUND-GUILD' }], error: null },
        payment_refunds: { data: [], error: null },
        entitlements: { data: [], error: null },
        license_keys: { data: [], error: null },
      });
      const req = makeSignedWebhook({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: 'REFUND-1',
          amount: { value: '10.00', currency_code: 'USD' },
          supplementary_data: {
            related_ids: { capture_id: 'CAPTURE-1' },
          },
        },
        id: 'EVT-CAPTURE-REFUND-GUILD',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(upserts).toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({
          event_id: 'EVT-CAPTURE-REFUND-GUILD',
          event_type: 'PAYMENT.CAPTURE.REFUNDED',
          guild_id: 'guild-1',
        }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('records guild_id on persisted sale reversal webhook events', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }),
    );
    try {
      const { upserts } = useWebhookRows({
        payments: [
          { data: { guild_id: 'guild-1' }, error: null },
          {
            data: {
              id: 'payment-row-2',
              order_id: 'order-2',
              customer_id: 'customer-2',
              guild_id: 'guild-1',
              paypal_payment_id: 'SALE-1',
              paypal_resource_type: 'sale',
              status: 'completed',
              amount_cents: 1000,
              currency: 'USD',
            },
            error: null,
          },
        ],
        webhook_events: { data: [{ event_id: 'EVT-SALE-REVERSAL-GUILD' }], error: null },
        payment_refunds: { data: [], error: null },
        entitlements: { data: [], error: null },
        license_keys: { data: [], error: null },
      });
      const req = makeSignedWebhook({
        event_type: 'PAYMENT.SALE.REVERSED',
        resource: {
          id: 'SALE-1',
          state: 'reversed',
          parent_payment: 'PAY-SALE-1',
        },
        id: 'EVT-SALE-REVERSAL-GUILD',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(upserts).toContainEqual({
        table: 'webhook_events',
        payload: expect.objectContaining({
          event_id: 'EVT-SALE-REVERSAL-GUILD',
          event_type: 'PAYMENT.SALE.REVERSED',
          guild_id: 'guild-1',
        }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });













  // Finding 2 note: these two cases originally used CHECKOUT.ORDER.APPROVED as
  // their stand-in for "a non-resumable event type". That type is now
  // deliberately resumable — a failed capture must be recoverable by PayPal's
  // own redelivery — so they use CHECKOUT.ORDER.COMPLETED instead. The
  // invariant under test is unchanged: a type that is NOT in
  // RESUMABLE_FAILED_EVENT_TYPES is never silently auto-retried.
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
        event_type: 'CHECKOUT.ORDER.COMPLETED',
        resource: { id: 'ORDER-FAILED-RETRY' },
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
        event_type: 'CHECKOUT.ORDER.COMPLETED',
        resource: { id: 'ORDER-STALE-NON-RESUMABLE' },
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

  it('refund event without one canonical capture_id returns 500 for provider retry', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = makeReplay({
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'REFUND-1' },
      id: 'EVT-REFUND-NO-CAPTURE',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('subscription sale refund relies on the terminal entitlement trigger for roles', async () => {
    const { inserts, eqCalls } = useWebhookRows({
      payments: {
        data: {
          id: 'payment-row-1',
          order_id: 'order-subscription-1',
          customer_id: 'customer-1',
          guild_id: 'guild-1',
          paypal_payment_id: 'SALE-SUBSCRIPTION-1',
          paypal_resource_type: 'sale',
          status: 'completed',
          amount_cents: 1000,
          currency: 'USD',
        },
        error: null,
      },
      payment_refunds: [
        { data: null, error: null },
        { data: [], error: null },
      ],
      entitlements: [
        {
          data: [
            {
              id: 'entitlement-1',
              customer_id: 'customer-1',
              granted_role_ids: ['role-1', 'role-2'],
              license_key_id: null,
            },
          ],
          error: null,
        },
        { data: null, error: null }, // terminal entitlement update
        { data: null, error: null },
      ],
      license_keys: { data: [], error: null },
      customers: { data: { discord_id: 'discord-1' }, error: null },
      bot_action_queue: { data: null, error: null },
      audit_logs: { data: null, error: null },
      orders: { data: null, error: null },
    });
    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REFUNDED',
      resource: {
        id: 'REFUND-1',
        sale_id: 'SALE-SUBSCRIPTION-1',
        amount: { total: '-10.00', currency: 'USD' },
      },
      id: 'EVT-SALE-REFUND',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual({
      table: 'payments',
      column: 'paypal_payment_id',
      value: 'SALE-SUBSCRIPTION-1',
    });
    expect(inserts).not.toContainEqual(
      expect.objectContaining({
        table: 'bot_action_queue',
        payload: expect.objectContaining({ action: 'revoke_roles' }),
      }),
    );
  });

  it('subscription sale reversal uses the sale id as the local payment id', async () => {
    const { eqCalls } = useWebhookRows({
      payments: {
        data: {
          id: 'payment-row-2',
          order_id: 'order-subscription-2',
          customer_id: 'customer-2',
          guild_id: 'guild-1',
          paypal_payment_id: 'SALE-SUBSCRIPTION-2',
          paypal_resource_type: 'sale',
          status: 'completed',
          amount_cents: 1000,
          currency: 'USD',
        },
        error: null,
      },
      payment_refunds: [
        { data: null, error: null },
        { data: [], error: null },
      ],
      entitlements: { data: [], error: null },
      license_keys: { data: [], error: null },
    });
    const req = makeReplay({
      event_type: 'PAYMENT.SALE.REVERSED',
      resource: {
        id: 'SALE-SUBSCRIPTION-2',
        state: 'reversed',
        parent_payment: 'PAY-SUBSCRIPTION-2',
      },
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
      new Response(JSON.stringify({ id: 'ORDER-CAPTURE-1', status: 'COMPLETED' }), { status: 200 }),
    );
    global.fetch = captureCall;

    try {
      useWebhookRows({
        orders: {
          data: {
            id: 'order-local-1',
            guild_id: 'guild-1',
            paypal_order_id: 'ORDER-CAPTURE-1',
            status: 'pending',
          },
          error: null,
        },
      });
      const req = makeReplay({
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { id: 'ORDER-CAPTURE-1' },
        id: 'EVT-ORDER-1',
      });

      const res = await POST(req as never);
      expect(res.status).toBe(200);
      expect(captureCall).toHaveBeenCalledWith(
        expect.stringContaining('/v2/checkout/orders/ORDER-CAPTURE-1/capture'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'PayPal-Request-Id': 'capture-ORDER-CAPTURE-1',
          }),
        }),
      );
      expect(logSpy).toHaveBeenCalledWith('[Webhook] Captured PayPal order: ORDER-CAPTURE-1');
    } finally {
      global.fetch = origFetch;
      logSpy.mockRestore();
    }
  });

  it('subscription expiry queues one chronology-bound terminal fulfillment', async () => {
    const { rpc, updates } = useWebhookRows({
      orders: { data: EXACT_EXPIRED_SUBSCRIPTION_ORDER, error: null },
    });
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      resource: { id: 'SUB-EXPIRED' },
      id: 'EVT-SUB-EXPIRED-QUEUED',
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      'commerce_record_subscription_lifecycle_observation',
      expect.objectContaining({
        p_webhook_event_id: 'EVT-SUB-EXPIRED-QUEUED',
        p_provider_event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        p_paypal_subscription_id: 'SUB-EXPIRED',
        p_order_id: 'order-expired',
      }),
    );
    expect(rpc).toHaveBeenCalledWith(
      'commerce_create_or_recover_subscription_lifecycle_action',
      expect.objectContaining({
        p_webhook_event_id: 'EVT-SUB-EXPIRED-QUEUED',
        p_fulfillment_type: 'subscription_cancelled',
        p_paypal_subscription_id: 'SUB-EXPIRED',
        p_order_id: 'order-expired',
      }),
    );
    expect(updates.filter(({ table }) =>
      ['entitlements', 'license_keys', 'license_sessions'].includes(table)
    )).toEqual([]);
  });

  it('stale subscription expiry does not create a terminal action', async () => {
    const { rpc } = useWebhookRows(
      { orders: { data: EXACT_EXPIRED_SUBSCRIPTION_ORDER, error: null } },
      {
        chronologyResponse: (canonical) => ({
          data: {
            ...canonical,
            disposition: 'stale',
            accepted: false,
          },
          error: null,
        }),
      },
    );
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      resource: { id: 'SUB-EXPIRED' },
      id: 'EVT-SUB-EXPIRED-STALE',
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalledWith(
      'commerce_create_or_recover_subscription_lifecycle_action',
      expect.anything(),
    );
  });

  it('subscription expiry stays retryable when terminal action staging fails', async () => {
    const { rpc } = useWebhookRows(
      { orders: { data: EXACT_EXPIRED_SUBSCRIPTION_ORDER, error: null } },
      {
        lifecycleResponse: () => ({
          data: null,
          error: { message: 'lifecycle queue unavailable' },
        }),
      },
    );
    const req = makeReplay({
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      resource: { id: 'SUB-EXPIRED' },
      id: 'EVT-SUB-EXPIRED-QUEUE-ERROR',
    });

    const res = await POST(req as never);

    expect(res.status).toBe(500);
    expect(rpc).toHaveBeenCalledWith(
      'commerce_create_or_recover_subscription_lifecycle_action',
      expect.anything(),
    );
  });

  it('CHECKOUT.ORDER.APPROVED reconciles a lost capture response without a second capture identity', async () => {
    useWebhookRows({
      orders: {
        data: {
          id: 'order-local-1',
          guild_id: 'guild-1',
          paypal_order_id: 'ORDER-CAPTURE-1',
          status: 'pending',
        },
        error: null,
      },
    });
    const originalFetch = global.fetch;
    const provider = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'ORDER-CAPTURE-1', status: 'COMPLETED' }),
          { status: 200 },
        ),
      );
    global.fetch = provider;
    try {
      const res = await POST(makeReplay({
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { id: 'ORDER-CAPTURE-1' },
        id: 'EVT-ORDER-RECOVERY-1',
      }) as never);

      expect(res.status).toBe(200);
      expect(provider).toHaveBeenCalledTimes(2);
      expect(String(provider.mock.calls[0]?.[0])).toContain('/capture');
      expect(String(provider.mock.calls[1]?.[0])).not.toContain('/capture');
    } finally {
      global.fetch = originalFetch;
    }
  });

  // Finding 9: this case used to assert that CUSTOMER.DISPUTE.CREATED hit the
  // `default:` branch and was recorded as a SUCCESS — i.e. it encoded the bug
  // where a chargeback was filed as a success. Disputes are handled now, so
  // the "unhandled event" contract is proven with a genuinely unhandled type.
  it('unhandled event type returns 200 without error', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = makeReplay({
      event_type: 'BILLING.PLAN.UPDATED',
      resource: { id: 'PLAN-1' },
      id: 'EVT-UNHANDLED',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(logSpy).toHaveBeenCalledWith('[Webhook] Unhandled event: BILLING.PLAN.UPDATED');
    logSpy.mockRestore();
  });

  it('CUSTOMER.DISPUTE.CREATED is no longer swallowed as an unhandled success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = makeReplay({
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      resource: {
        dispute_id: 'PP-D-27803',
        status: 'WAITING_FOR_SELLER_RESPONSE',
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        dispute_amount: { currency_code: 'USD', value: '9.99' },
        disputed_transactions: [{ seller_transaction_id: 'CAPTURE-DISPUTED-1' }],
      },
      id: 'EVT-DISPUTE-HANDLED',
    });

    await POST(req as never);

    expect(logSpy).not.toHaveBeenCalledWith(
      '[Webhook] Unhandled event: CUSTOMER.DISPUTE.CREATED',
    );
    logSpy.mockRestore();
  });

  describe('capture/activation frozen fulfillment recovery', () => {
    const captureResource = {
      id: 'CAPTURE-RECOVERY-1',
      custom_id: JSON.stringify({
        guild_id: 'guild-1',
        product_id: 'product-1',
        customer_id: 'customer-1',
        discord_id: 'discord-1',
      }),
      amount: { value: '9.99', currency_code: 'USD' },
      supplementary_data: {
        related_ids: { order_id: 'PAYPAL-ORDER-RECOVERY-1' },
      },
    };

    it('fulfills a signed one-time checkout using the customer Discord identity', async () => {
      const { supabase, state } = createCaptureRecoveryHarness({
        withLicense: true,
        signedCheckout: true,
      });
      const signature = createHmac('sha256', paypalClientSecret)
        .update(`somnibot-checkout:v1:${state.checkoutIntent.token}`)
        .digest('hex');

      await handlePaymentCaptured(supabase, {
        ...captureResource,
        custom_id: `v1:${state.checkoutIntent.token}.${signature}`,
      });

      expect(state.order.status).toBe('completed');
      expect(state.queue.payload.discord_id).toBe(state.customer.discord_id);
      expect(state.licenseKey.bound_discord_id).toBe(state.customer.discord_id);
      expect(state.providerIncidents).toEqual([]);
    });

    it('verifies checkout identity with the authoritative saved PayPal secret instead of a stale environment fallback', async () => {
      const savedSecret = 'saved-paypal-client-secret';
      process.env.PAYPAL_CLIENT_SECRET = 'stale-environment-secret';
      vi.mocked(getPayPalRuntimeConfig).mockResolvedValue({
        apiBase: 'https://api-m.sandbox.paypal.com',
        clientSecret: savedSecret,
        webhookId: 'test-webhook-id',
      } as never);
      const { supabase, state } = createCaptureRecoveryHarness({
        withLicense: true,
        signedCheckout: true,
      });
      const signature = createHmac('sha256', savedSecret)
        .update(`somnibot-checkout:v1:${state.checkoutIntent.token}`)
        .digest('hex');

      await handlePaymentCaptured(supabase, {
        ...captureResource,
        custom_id: `v1:${state.checkoutIntent.token}.${signature}`,
      });

      expect(state.order.status).toBe('completed');
      expect(state.providerIncidents).toEqual([]);
    });

    it('verifies new checkout signatures with a stable secret across PayPal credential rotation', async () => {
      const previousStableSecret = process.env.SUPABASE_SECRET_KEY;
      process.env.SUPABASE_SECRET_KEY = 'stable-checkout-signing-secret';
      process.env.PAYPAL_CLIENT_SECRET = 'old-paypal-client-secret';
      vi.mocked(getPayPalRuntimeConfig).mockResolvedValue({
        apiBase: 'https://api-m.sandbox.paypal.com',
        clientId: 'test-client-id',
        clientSecret: 'rotated-paypal-client-secret',
        webhookId: 'test-webhook-id',
        webhookUrl: 'https://example.com/api/paypal/webhook',
        sandbox: true,
        sources: {
          apiBase: 'env',
          clientId: 'env',
          clientSecret: 'saved',
          webhookId: 'env',
          webhookUrl: 'env',
          sandbox: 'env',
        },
      });
      const { supabase, state } = createCaptureRecoveryHarness({
        withLicense: true,
        signedCheckout: true,
      });
      const signature = createHmac('sha256', process.env.SUPABASE_SECRET_KEY)
        .update(`somnibot-checkout:v2:${state.checkoutIntent.token}`)
        .digest('hex');

      try {
        await handlePaymentCaptured(supabase, {
          ...captureResource,
          custom_id: `v2:${state.checkoutIntent.token}.${signature}`,
        });

        expect(state.order.status).toBe('completed');
        expect(state.providerIncidents).toEqual([]);
      } finally {
        if (previousStableSecret === undefined) delete process.env.SUPABASE_SECRET_KEY;
        else process.env.SUPABASE_SECRET_KEY = previousStableSecret;
      }
    });

    it('binds simultaneous same-product checkouts to the exact PayPal order id', async () => {
      const { supabase, state } = createCaptureRecoveryHarness();
      const laterPendingAttempt = {
        ...structuredClone(state.order),
        id: 'order-newer-decoy',
        order_number: 'ORD-NEWER-DECOY',
        paypal_order_id: 'PAYPAL-ORDER-DECOY',
      };
      state.orders = [laterPendingAttempt, state.order];

      await handlePaymentCaptured(supabase, captureResource);

      expect(state.order.status).toBe('completed');
      expect(laterPendingAttempt.status).toBe('pending');
      expect(state.queue.payload.order_id).toBe(state.order.id);
      expect(state.queue.payload.paypal_capture_id).toBe('CAPTURE-RECOVERY-1');
    });

    it('holds capture metadata whose Discord identity disagrees with the customer', async () => {
      const { supabase, state } = createCaptureRecoveryHarness();
      state.customer.discord_id = 'discord-other';

      await handlePaymentCaptured(supabase, captureResource);
      expect(state.queue).toBeNull();
      expect(state.providerIncidents).toEqual([
        expect.objectContaining({
          p_webhook_event_id: 'EVT-DIRECT-CAPTURE',
          p_provider_event_type: 'PAYMENT.CAPTURE.COMPLETED',
          p_provider_resource_id: 'CAPTURE-RECOVERY-1',
          p_provider_parent_id: 'PAYPAL-ORDER-RECOVERY-1',
          p_observed_guild_id: 'guild-1',
          p_incident_reason: 'customer_identity_missing_or_mismatched',
        }),
      ]);
    });

    it('keeps capture customer lookup failures retryable without mutation', async () => {
      const { supabase, state, rpc } = createCaptureRecoveryHarness({
        failCustomerReadAttempts: 1,
      });

      await expect(handlePaymentCaptured(supabase, captureResource)).rejects.toThrow(
        'customer lookup unavailable',
      );
      expect(state.queue).toBeNull();
      expect(rpc).not.toHaveBeenCalled();
    });

    it('holds before mutation when a first capture has no PayPal order identity', async () => {
      const { supabase, state } = createCaptureRecoveryHarness();
      const { supplementary_data: _omitted, ...withoutProviderOrder } = captureResource;

      await handlePaymentCaptured(supabase, withoutProviderOrder);
      expect(state.order.status).toBe('pending');
      expect(state.queue).toBeNull();
      expect(state.totalsApplied).toBe(0);
      expect(state.providerIncidents).toEqual([
        expect.objectContaining({
          p_webhook_event_id: 'EVT-DIRECT-CAPTURE',
          p_provider_event_type: 'PAYMENT.CAPTURE.COMPLETED',
          p_provider_resource_id: 'CAPTURE-RECOVERY-1',
          p_provider_parent_id: null,
          p_incident_reason: 'provider_identity_malformed',
        }),
      ]);
    });

    it('rejects a conflicting PayPal order identity on payment-row replay', async () => {
      const { supabase, state } = createCaptureRecoveryHarness();
      await handlePaymentCaptured(supabase, captureResource);
      const conflictingReplay = {
        ...captureResource,
        supplementary_data: {
          related_ids: { order_id: 'PAYPAL-ORDER-CONFLICT' },
        },
      };

      await handlePaymentCaptured(supabase, conflictingReplay);
      expect(state.totalsApplied).toBe(1);
      expect(state.providerIncidents).toEqual([
        expect.objectContaining({
          p_webhook_event_id: 'EVT-DIRECT-CAPTURE',
          p_provider_event_type: 'PAYMENT.CAPTURE.COMPLETED',
          p_provider_resource_id: 'CAPTURE-RECOVERY-1',
          p_provider_parent_id: 'PAYPAL-ORDER-CONFLICT',
          p_incident_reason: 'order_identity_missing_or_ambiguous',
        }),
      ]);
    });

    it.each(['refunded', 'disputed'] as const)(
      'treats an exact %s capture replay as a successor-state no-op',
      async (successorStatus) => {
        const { supabase, state, rpc } = createCaptureRecoveryHarness();
        state.order.status = successorStatus;
        state.payment = {
          id: 'payment-1',
          order_id: state.order.id,
          paypal_payment_id: 'CAPTURE-RECOVERY-1',
        };

        await handlePaymentCaptured(supabase, captureResource);

        expect(state.order.status).toBe(successorStatus);
        expect(state.queue).toBeNull();
        expect(state.frozenSnapshot).toBeNull();
        expect(state.licenseKey).toBeNull();
        expect(state.totalsApplied).toBe(0);
        expect(state.inserts).toEqual([]);
        expect(state.updates).toEqual([]);
        expect(rpc.mock.calls.map(([name]) => name)).toEqual([
          'commerce_finalize_paypal_capture',
        ]);
      },
    );

    it('atomically claims and holds a legacy completed capture with no frozen snapshot', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        const { supabase, state, rpc } = createCaptureRecoveryHarness();
        state.order.status = 'completed';
        state.order.grant_snapshot_frozen_at = null;
        state.payment = {
          id: 'payment-1',
          order_id: state.order.id,
          paypal_payment_id: 'CAPTURE-RECOVERY-1',
        };

        await handlePaymentCaptured(supabase, captureResource);

        expect(state.order.status).toBe('completed');
        expect(state.order.grant_snapshot_frozen_at).toBeNull();
        expect(state.frozenSnapshot).toBeNull();
        expect(state.queue).toBeNull();
        expect(state.licenseKey).toBeNull();
        expect(state.totalsApplied).toBe(0);
        expect(rpc.mock.calls.map(([name]) => name)).toEqual([
          'commerce_finalize_paypal_capture',
          'commerce_hold_unknown_delivery_contract',
        ]);
        expect(state.fulfillmentClaimOrderId).toBe(state.order.id);
        expect(state.fulfillmentHold).toMatchObject({
          winning_order_id: state.order.id,
          conflicting_entitlement_id: null,
          hold_reason: 'unknown_delivery_contract',
        });
        expect(state.alerts).toEqual([
          expect.objectContaining({
            alert_type: 'commerce_unknown_delivery_contract',
            severity: 'critical',
            metadata: expect.objectContaining({
              order_id: state.order.id,
              provider_kind: 'capture',
              provider_id: 'CAPTURE-RECOVERY-1',
              required_action: 'manual_fulfillment_or_refund',
            }),
          }),
        ]);
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining('Exact legacy capture replay has no frozen grant snapshot'),
        );
      } finally {
        infoSpy.mockRestore();
      }
    });

    it('holds when PayPal omits the captured amount', async () => {
      const { supabase, state } = createCaptureRecoveryHarness();
      const { amount: _omitted, ...withoutAmount } = captureResource;

      await handlePaymentCaptured(supabase, withoutAmount);
      expect(state.order.status).toBe('pending');
      expect(state.queue).toBeNull();
      expect(state.providerIncidents).toEqual([
        expect.objectContaining({
          p_webhook_event_id: 'EVT-DIRECT-CAPTURE',
          p_provider_event_type: 'PAYMENT.CAPTURE.COMPLETED',
          p_provider_resource_id: 'CAPTURE-RECOVERY-1',
          p_provider_parent_id: 'PAYPAL-ORDER-RECOVERY-1',
          p_incident_reason: 'financial_identity_malformed',
        }),
      ]);
    });

    it('freezes a mismatched first capture but never stages access, including on replay', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { supabase, state, rpc } = createCaptureRecoveryHarness({ withLicense: true });
        const soldSnapshot = structuredClone(state.currentSnapshot);
        const mismatchedCapture = {
          ...captureResource,
          amount: { value: '10.99', currency_code: 'USD' },
        };

        await handlePaymentCaptured(supabase, mismatchedCapture);

        expect(state.order.status).toBe('pending_review');
        expect(state.frozenSnapshot).toEqual(soldSnapshot);
        expect(state.queue).toBeNull();
        expect(state.licenseKey).toBeNull();
        expect(state.totalsApplied).toBe(0);
        expect(state.inserts).toEqual([]);
        expect(state.updates).toEqual([]);
        expect(rpc.mock.calls.map(([name]) => name)).toEqual([
          'commerce_freeze_order_grant_snapshot',
          'commerce_finalize_paypal_capture',
        ]);

        state.currentSnapshot.granted_role_ids_snapshot = ['999999999999999999'];
        await handlePaymentCaptured(supabase, mismatchedCapture);

        expect(state.order.status).toBe('pending_review');
        expect(state.frozenSnapshot).toEqual(soldSnapshot);
        expect(state.queue).toBeNull();
        expect(state.licenseKey).toBeNull();
        expect(state.totalsApplied).toBe(0);
        expect(state.inserts).toEqual([]);
        expect(state.updates).toEqual([]);
        expect(rpc.mock.calls.map(([name]) => name)).toEqual([
          'commerce_freeze_order_grant_snapshot',
          'commerce_finalize_paypal_capture',
          'commerce_finalize_paypal_capture',
        ]);
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('freezes and records the exact capture before claim/staging, then releases it', async () => {
      const { supabase, state, rpc } = createCaptureRecoveryHarness();

      await handlePaymentCaptured(supabase, captureResource);

      const stage = state.inserts.find((entry: any) => entry.table === 'bot_action_queue');
      expect(stage.payload).toMatchObject({
        status: 'staged',
        idempotency_key: 'paypal:capture:CAPTURE-RECOVERY-1:fulfill_purchase',
        payload: {
          granted_role_ids: [ORIGINAL_ROLE],
          granted_channel_ids: [ORIGINAL_CHANNEL],
          temporary_role_grants: [
            { role_id: ORIGINAL_TEMP_ROLE, duration_seconds: 3600 },
          ],
        },
      });
      expect(state.queue.status).toBe('pending');
      expect(state.order.status).toBe('completed');
      expect(state.totalsApplied).toBe(1);
      expect(rpc.mock.calls.map(([name]) => name)).toEqual([
        'commerce_freeze_order_grant_snapshot',
        'commerce_finalize_paypal_capture',
        'commerce_claim_paid_fulfillment',
        'bot_action_queue_release_staged',
      ]);
      expect(rpc).toHaveBeenCalledWith('bot_action_queue_release_staged', {
        p_action_id: 'queue-1',
        p_guild_id: 'guild-1',
        p_idempotency_key: 'paypal:capture:CAPTURE-RECOVERY-1:fulfill_purchase',
      });
      expect(state.updates.filter((entry: any) => entry.table === 'bot_action_queue')).toEqual([]);
      expect(rpc).not.toHaveBeenCalledWith('increment_customer_totals', expect.anything());
    });

    it('finalizes a frozen one-time capture after the product moves guilds', async () => {
      const { supabase, state } = createCaptureRecoveryHarness();
      const soldSnapshot = structuredClone(state.currentSnapshot);
      state.frozenSnapshot = soldSnapshot;
      state.order.grant_snapshot_frozen_at = '2026-07-11T00:00:00.000Z';
      state.product.guild_id = 'guild-moved-after-checkout';
      state.product.name = 'Moved Product';
      state.currentSnapshot.granted_role_ids_snapshot = ['999999999999999999'];

      await handlePaymentCaptured(supabase, captureResource);

      expect(state.order.status).toBe('completed');
      expect(state.queue).toMatchObject({
        status: 'pending',
        payload: {
          product_id: 'product-1',
          product_name: 'Moved Product',
          granted_role_ids: soldSnapshot.granted_role_ids_snapshot,
        },
      });
      expect(state.frozenSnapshot).toEqual(soldSnapshot);
      expect(state.totalsApplied).toBe(1);
    });

    it('replays a failed stage from the order snapshot even after current config changes', async () => {
      const { supabase, state, rpc } = createCaptureRecoveryHarness({ failStageAttempts: 1 });

      await expect(handlePaymentCaptured(supabase, captureResource)).rejects.toThrow(
        'Failed to stage fulfillment outbox',
      );
      expect(state.order.status).toBe('completed');
      expect(state.totalsApplied).toBe(1);
      state.currentSnapshot = {
        granted_role_ids_snapshot: ['444444444444444444'],
        granted_channel_ids_snapshot: ['555555555555555555'],
        temporary_role_grants_snapshot: [
          { role_id: '666666666666666666', duration_seconds: 7200 },
        ],
      };

      await handlePaymentCaptured(supabase, captureResource);

      expect(state.queue.payload).toMatchObject({
        granted_role_ids: [ORIGINAL_ROLE],
        granted_channel_ids: [ORIGINAL_CHANNEL],
        temporary_role_grants: [
          { role_id: ORIGINAL_TEMP_ROLE, duration_seconds: 3600 },
        ],
      });
      expect(state.queue.status).toBe('pending');
      expect(state.totalsApplied).toBe(1);
      expect(rpc.mock.calls.filter(([name]) => name === 'commerce_finalize_paypal_capture')).toHaveLength(2);
    });

    it('reuses the staged plaintext/key id after license persistence fails and applies totals once', async () => {
      const { supabase, state, rpc } = createCaptureRecoveryHarness({
        withLicense: true,
        failLicenseAttempts: 1,
      });

      await expect(handlePaymentCaptured(supabase, captureResource)).rejects.toThrow(
        'Failed to persist staged license key',
      );
      const stagedKeyId = state.queue.payload.license_key_id;
      const stagedPlaintext = state.queue.payload.license_key_plaintext;
      expect(state.queue.status).toBe('staged');
      expect(state.totalsApplied).toBe(1);

      state.currentSnapshot.granted_role_ids_snapshot = ['777777777777777777'];
      await handlePaymentCaptured(supabase, captureResource);

      expect(state.queue.payload.license_key_id).toBe(stagedKeyId);
      expect(state.queue.payload.license_key_plaintext).toBe(stagedPlaintext);
      expect(state.licenseKey.id).toBe(stagedKeyId);
      expect(state.queue.status).toBe('pending');
      expect(state.totalsApplied).toBe(1);
      expect(rpc.mock.calls.filter(([name]) => name === 'commerce_finalize_paypal_capture')).toHaveLength(2);
    });

    it.each([
      [{ role_id: 'not-a-snowflake', duration_seconds: 60 }],
      [{ role_id: ORIGINAL_TEMP_ROLE, duration_seconds: 315_360_001 }],
      [
        { role_id: ORIGINAL_TEMP_ROLE, duration_seconds: 60 },
        { role_id: ORIGINAL_TEMP_ROLE, duration_seconds: 120 },
      ],
    ])('fails closed on malformed temporary-role snapshots', async (...temporaryRoleGrants) => {
      const { supabase, state } = createCaptureRecoveryHarness();
      state.currentSnapshot.temporary_role_grants_snapshot = temporaryRoleGrants;

      await expect(handlePaymentCaptured(supabase, captureResource)).rejects.toThrow(
        'Temporary role snapshot is malformed',
      );
      expect(state.queue).toBeNull();
      expect(state.order.status).toBe('pending');
    });

    it('releases the same staged subscription snapshot after a transient release failure', async () => {
      const { supabase, state } = createCaptureRecoveryHarness({
        subscription: true,
        failReleaseAttempts: 1,
      });
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Failed to release staged fulfillment',
      );
      expect(state.queue.status).toBe('staged');
      state.currentSnapshot.granted_role_ids_snapshot = ['888888888888888888'];

      await handleSubscriptionActivated(supabase, resource);

      expect(state.queue.status).toBe('pending');
      expect(state.queue.payload.granted_role_ids).toEqual([ORIGINAL_ROLE]);
      expect(state.queue.payload).not.toHaveProperty('temporary_role_grants');
      expect(state.inserts.filter((entry: any) => entry.table === 'bot_action_queue')).toHaveLength(1);
      expect(getSubscriptionAmount).toHaveBeenCalledTimes(1);
    });

    it('atomically claims and holds a legacy completed subscription with no grant snapshot', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        const { supabase, state, rpc } = createCaptureRecoveryHarness({ subscription: true });
        state.order.status = 'completed';
        state.order.grant_snapshot_frozen_at = null;
        state.frozenSnapshot = null;
        const resource = {
          id: 'SUB-RECOVERY-1',
          custom_id: JSON.stringify({
            guild_id: 'guild-1',
            product_id: 'product-1',
            plan_id: 'plan-1',
            customer_id: 'customer-1',
            discord_id: 'discord-1',
          }),
        };

        await handleSubscriptionActivated(supabase, resource);

        expect(state.order).toMatchObject({
          status: 'completed',
          grant_snapshot_frozen_at: null,
        });
        expect(state.frozenSnapshot).toBeNull();
        expect(state.queue).toBeNull();
        expect(rpc.mock.calls.map(([name]) => name)).toEqual([
          'commerce_hold_unknown_delivery_contract',
        ]);
        expect(state.fulfillmentClaimOrderId).toBe(state.order.id);
        expect(state.fulfillmentHold).toMatchObject({
          winning_order_id: state.order.id,
          conflicting_entitlement_id: null,
          hold_reason: 'unknown_delivery_contract',
        });
        expect(state.alerts).toEqual([
          expect.objectContaining({
            alert_type: 'commerce_unknown_delivery_contract',
            severity: 'critical',
            metadata: expect.objectContaining({
              order_id: state.order.id,
              provider_kind: 'subscription',
              provider_id: 'SUB-RECOVERY-1',
              required_action: 'manual_fulfillment_or_refund',
            }),
          }),
        ]);
        expect(getSubscriptionAmount).toHaveBeenCalledTimes(1);
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining('Exact legacy subscription replay has no durable grant contract'),
        );
      } finally {
        infoSpy.mockRestore();
      }
    });

    it.each([
      {
        label: 'plan moved to another catalog owner',
        mutateCatalog: (state: any) => {
          state.plan.guild_id = 'guild-moved-after-sale';
          state.plan.product_id = 'product-moved-after-sale';
        },
      },
      {
        label: 'current PayPal plan id rotated',
        mutateCatalog: (state: any) => {
          state.plan.paypal_plan_id = 'PAYPAL-PLAN-CURRENT-OTHER';
        },
      },
      {
        label: 'local plan deleted',
        mutateCatalog: (state: any) => {
          state.plan = null;
        },
      },
    ])('keeps an exact legacy no-contract replay access-free and held after $label', async ({ mutateCatalog }) => {
      const { supabase, state, rpc } = createCaptureRecoveryHarness({ subscription: true });
      state.order.status = 'completed';
      state.order.grant_snapshot_frozen_at = null;
      state.frozenSnapshot = null;
      mutateCatalog(state);
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await handleSubscriptionActivated(supabase, resource);

      expect(state.order).toMatchObject({
        status: 'completed',
        grant_snapshot_frozen_at: null,
      });
      expect(state.queue).toBeNull();
      expect(state.inserts).toEqual([]);
      expect(state.updates).toEqual([]);
      expect(rpc.mock.calls.map(([name]) => name)).toEqual([
        'commerce_hold_unknown_delivery_contract',
      ]);
      expect(state.fulfillmentHold).toMatchObject({
        winning_order_id: state.order.id,
        hold_reason: 'unknown_delivery_contract',
      });
      expect(getSubscriptionAmount).toHaveBeenCalledTimes(1);
    });

    it('rejects a legacy completed subscription replay whose provider finances mismatch', async () => {
      vi.mocked(getSubscriptionAmount).mockResolvedValueOnce({
        amountCents: 1_299,
        currency: 'USD',
        planId: 'PAYPAL-PLAN-1',
        nextBillingTime: '2026-08-29T00:00:00.000Z',
      });
      const { supabase, state, rpc } = createCaptureRecoveryHarness({ subscription: true });
      state.order.status = 'completed';
      state.order.grant_snapshot_frozen_at = null;
      state.frozenSnapshot = null;
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Completed subscription order disagrees with PayPal financial state',
      );
      expect(state.queue).toBeNull();
      expect(state.inserts).toEqual([]);
      expect(state.updates).toEqual([]);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('releases a recoverable legacy staged subscription without re-freezing current grants', async () => {
      const { supabase, state, rpc } = createCaptureRecoveryHarness({
        subscription: true,
        failOrderCompleteAttempts: 1,
      });
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Failed to complete subscription order',
      );
      expect(state.queue).toMatchObject({
        status: 'staged',
        payload: { granted_role_ids: [ORIGINAL_ROLE] },
      });

      state.order.status = 'completed';
      state.order.grant_snapshot_frozen_at = null;
      state.frozenSnapshot = null;
      state.plan.guild_id = 'guild-moved-after-sale';
      state.plan.product_id = 'product-moved-after-sale';
      state.plan.paypal_plan_id = 'PAYPAL-PLAN-CURRENT-OTHER';
      state.currentSnapshot.granted_role_ids_snapshot = ['999999999999999999'];
      rpc.mockClear();

      await handleSubscriptionActivated(supabase, resource);

      expect(state.queue).toMatchObject({
        status: 'pending',
        payload: {
          granted_role_ids: [ORIGINAL_ROLE],
          granted_channel_ids: [ORIGINAL_CHANNEL],
        },
      });
      expect(state.order.grant_snapshot_frozen_at).toBeNull();
      expect(state.frozenSnapshot).toBeNull();
      expect(state.legacySubscriptionContract).toMatchObject({
        order_id: 'order-1',
        source_queue_id: 'queue-1',
        granted_role_ids_snapshot: [ORIGINAL_ROLE],
        granted_channel_ids_snapshot: [ORIGINAL_CHANNEL],
      });
      expect(rpc).toHaveBeenCalledWith(
        'commerce_adopt_legacy_subscription_grant_contract',
        { p_order_id: 'order-1', p_source_queue_id: 'queue-1' },
      );
      expect(state.inserts.filter((entry: any) => entry.table === 'bot_action_queue')).toHaveLength(1);

      // Adoption is idempotent after release. A later webhook replay may
      // observe pending/processing/completed queue state, but it must recover
      // only the exact already-persisted contract.
      await handleSubscriptionActivated(supabase, resource);
      expect(state.queue.status).toBe('pending');
      expect(rpc.mock.calls.filter(
        ([name]) => name === 'commerce_adopt_legacy_subscription_grant_contract',
      )).toHaveLength(2);

      state.queue.payload.granted_role_ids = ['999999999999999999'];
      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Failed to persist legacy subscription grant contract: immutable replay mismatch',
      );
    });

    it('keeps an unknown legacy-looking subscription retryable without creating access', async () => {
      vi.mocked(getSubscriptionAmount).mockResolvedValueOnce(null);
      const { supabase, state, rpc } = createCaptureRecoveryHarness({ subscription: true });
      state.orders = [];
      const resource = {
        id: 'SUB-UNKNOWN',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'authoritative billing amount is unavailable',
      );
      expect(state.orders).toEqual([]);
      expect(state.queue).toBeNull();
      expect(state.inserts).toEqual([]);
      expect(state.updates).toEqual([]);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('holds subscription metadata whose Discord identity disagrees with the customer', async () => {
      const { supabase, state } = createCaptureRecoveryHarness({ subscription: true });
      state.customer.discord_id = 'discord-other';
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await handleSubscriptionActivated(supabase, resource);
      expect(state.queue).toBeNull();
      expect(state.providerIncidents).toEqual([
        expect.objectContaining({
          p_webhook_event_id: 'EVT-DIRECT-SUBSCRIPTION-ACTIVATION',
          p_provider_event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          p_provider_resource_id: 'SUB-RECOVERY-1',
          p_observed_guild_id: 'guild-1',
          p_incident_reason: 'customer_identity_missing_or_mismatched',
        }),
      ]);
    });

    it('keeps subscription customer lookup failures retryable without mutation', async () => {
      const { supabase, state, rpc } = createCaptureRecoveryHarness({
        subscription: true,
        failCustomerReadAttempts: 1,
      });
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'customer lookup unavailable',
      );
      expect(state.queue).toBeNull();
      expect(rpc).not.toHaveBeenCalled();
    });

    it('finalizes a frozen subscription after its product and plan move in the catalog', async () => {
      const { supabase, state } = createCaptureRecoveryHarness({ subscription: true });
      const soldSnapshot = structuredClone(state.currentSnapshot);
      state.frozenSnapshot = soldSnapshot;
      state.order.grant_snapshot_frozen_at = '2026-07-11T00:00:00.000Z';
      state.product.guild_id = 'guild-moved-after-checkout';
      state.product.name = 'Moved Subscription Product';
      state.plan.guild_id = 'guild-moved-after-checkout';
      state.plan.product_id = 'product-currently-elsewhere';
      state.plan.paypal_plan_id = 'PAYPAL-PLAN-CURRENT-OTHER';
      state.currentSnapshot.granted_role_ids_snapshot = ['999999999999999999'];
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await handleSubscriptionActivated(supabase, resource);

      expect(state.order.status).toBe('completed');
      expect(state.queue).toMatchObject({
        status: 'pending',
        payload: {
          product_id: 'product-1',
          product_name: 'Moved Subscription Product',
          plan_id: 'plan-1',
          paypal_plan_id: 'PAYPAL-PLAN-1',
          granted_role_ids: soldSnapshot.granted_role_ids_snapshot,
        },
      });
      expect(state.frozenSnapshot).toEqual(soldSnapshot);
    });

    it('still requires the exact current plan for an unfrozen subscription order', async () => {
      const { supabase, state, rpc } = createCaptureRecoveryHarness({ subscription: true });
      state.product.guild_id = 'guild-moved-before-freeze';
      state.plan.guild_id = 'guild-moved-before-freeze';
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Subscription provider plan identity mismatch',
      );
      expect(state.order.status).toBe('pending');
      expect(state.queue).toBeNull();
      expect(rpc).not.toHaveBeenCalled();
    });

    it('rejects a same-price subscription bound to a different provider plan', async () => {
      vi.mocked(getSubscriptionAmount).mockResolvedValueOnce({
        amountCents: 999,
        currency: 'USD',
        planId: 'PAYPAL-PLAN-OTHER',
        nextBillingTime: '2026-08-29T00:00:00.000Z',
      });
      const { supabase, state, rpc } = createCaptureRecoveryHarness({ subscription: true });
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Subscription provider plan identity mismatch',
      );
      expect(state.queue).toBeNull();
      expect(rpc).not.toHaveBeenCalled();
    });

    it('holds a mismatched provider plan before creating a missing subscription order', async () => {
      const { supabase, state } = createCaptureRecoveryHarness({ subscription: true });
      state.orders = [];
      state.plan.paypal_plan_id = 'PAYPAL-PLAN-OTHER';
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await handleSubscriptionActivated(supabase, resource);
      expect(state.inserts).not.toContainEqual(
        expect.objectContaining({ table: 'orders' }),
      );
      expect(state.queue).toBeNull();
      expect(state.providerIncidents).toEqual([
        expect.objectContaining({
          p_webhook_event_id: 'EVT-DIRECT-SUBSCRIPTION-ACTIVATION',
          p_provider_event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          p_provider_resource_id: 'SUB-RECOVERY-1',
          p_observed_guild_id: 'guild-1',
          p_incident_reason: 'plan_identity_missing_or_mismatched',
        }),
      ]);
    });

    it('fails retryably when a pending activation has no authoritative PayPal amount', async () => {
      vi.mocked(getSubscriptionAmount).mockResolvedValueOnce(null);
      const { supabase, state, rpc } = createCaptureRecoveryHarness({ subscription: true });
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'authoritative billing amount is unavailable',
      );
      expect(state.order.status).toBe('pending');
      expect(state.queue).toBeNull();
      expect(rpc).not.toHaveBeenCalled();
    });

    it('holds a divergent positive provider amount without changing the sold order', async () => {
      vi.mocked(getSubscriptionAmount).mockResolvedValueOnce({
        amountCents: 1_299,
        currency: 'eur',
        planId: 'PAYPAL-PLAN-1',
        nextBillingTime: '2026-08-29T00:00:00.000Z',
      });
      const { supabase, state } = createCaptureRecoveryHarness({ subscription: true });
      // The bot freezes this snapshot before it exposes the subscription link.
      const soldSnapshot = structuredClone(state.currentSnapshot);
      state.frozenSnapshot = soldSnapshot;
      state.order.grant_snapshot_frozen_at = '2026-07-11T00:00:00.000Z';
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await handleSubscriptionActivated(supabase, resource);

      expect(state.order).toMatchObject({
        status: 'pending_review',
        amount_cents: 999,
        currency: 'USD',
      });
      expect(state.updates).toEqual([]);
      expect(state.frozenSnapshot).toEqual(soldSnapshot);
      expect(state.queue).toBeNull();
      expect(state.alerts).toContainEqual(
        expect.objectContaining({
          alert_type: 'commerce_subscription_financial_mismatch',
          severity: 'critical',
          resolved: false,
          metadata: { order_id: 'order-1' },
        }),
      );
    });

    it('fails retryably when the frozen pending subscription price correction loses its race', async () => {
      vi.mocked(getSubscriptionAmount).mockResolvedValueOnce({
        amountCents: 1_299,
        currency: 'EUR',
        planId: 'PAYPAL-PLAN-1',
        nextBillingTime: '2026-08-29T00:00:00.000Z',
      });
      const { supabase, state, rpc } = createCaptureRecoveryHarness({
        subscription: true,
        failOrderPriceUpdateAttempts: 1,
      });
      state.frozenSnapshot = structuredClone(state.currentSnapshot);
      state.order.grant_snapshot_frozen_at = '2026-07-11T00:00:00.000Z';
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Subscription billing amount update lost its state race',
      );
      expect(state.order).toMatchObject({
        status: 'pending',
        amount_cents: 999,
        currency: 'USD',
      });
      expect(state.updates).toEqual([]);
      expect(state.queue).toBeNull();
      expect(rpc).toHaveBeenCalledWith(
        'commerce_reprice_pending_subscription_order',
        expect.objectContaining({
          p_order_id: 'order-1',
          p_amount_cents: 1_299,
          p_currency: 'EUR',
        }),
      );
    });

    it('uses a validated staged amount when completion retries during a provider outage', async () => {
      const { supabase, state } = createCaptureRecoveryHarness({
        subscription: true,
        failOrderCompleteAttempts: 1,
      });
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Failed to complete subscription order',
      );
      expect(state.order.status).toBe('pending');
      expect(state.queue).toMatchObject({
        status: 'staged',
        payload: { amount_cents: 999, currency: 'USD' },
      });
      const amountMock = vi.mocked(getSubscriptionAmount);
      amountMock.mockResolvedValue(null);
      try {
        await handleSubscriptionActivated(supabase, resource);

        expect(getSubscriptionAmount).toHaveBeenCalledTimes(1);
        expect(state.order.status).toBe('completed');
        expect(state.queue.status).toBe('pending');
      } finally {
        amountMock.mockResolvedValue({
          amountCents: 999,
          currency: 'USD',
          planId: 'PAYPAL-PLAN-1',
          nextBillingTime: '2026-08-29T00:00:00.000Z',
        });
      }
    });

    it('fails closed when a staged subscription payload is tampered before replay', async () => {
      const { supabase, state } = createCaptureRecoveryHarness({
        subscription: true,
        failOrderCompleteAttempts: 1,
      });
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };
      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Failed to complete subscription order',
      );
      state.queue.payload.customer_id = 'customer-attacker';

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Fulfillment outbox row failed payload validation (customer_id)',
      );
      expect(state.order.status).toBe('pending');
      expect(state.queue.status).toBe('staged');
    });

    it('fails closed when staged subscription financial identity is tampered', async () => {
      const { supabase, state, rpc } = createCaptureRecoveryHarness({
        subscription: true,
        failOrderCompleteAttempts: 1,
      });
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };
      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Failed to complete subscription order',
      );
      const rpcCallsBeforeTamper = rpc.mock.calls.length;
      const updatesBeforeTamper = state.updates.length;
      state.queue.payload.amount_cents = 1;

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Staged subscription fulfillment disagrees with the order financial state',
      );
      expect(state.order.status).toBe('pending');
      expect(state.queue.status).toBe('staged');
      expect(rpc.mock.calls).toHaveLength(rpcCallsBeforeTamper);
      expect(state.updates).toHaveLength(updatesBeforeTamper);
    });

    it('preserves completed subscription financial state after an exact provider re-read', async () => {
      vi.mocked(getSubscriptionAmount).mockResolvedValueOnce({
        amountCents: 1_299,
        currency: 'EUR',
        planId: 'PAYPAL-PLAN-1',
        nextBillingTime: '2026-08-29T00:00:00.000Z',
      });
      const { supabase, state } = createCaptureRecoveryHarness({ subscription: true });
      state.order.status = 'completed';
      state.order.amount_cents = 1_299;
      state.order.currency = 'EUR';
      state.frozenSnapshot = structuredClone(state.currentSnapshot);
      state.order.grant_snapshot_frozen_at = '2026-07-11T00:00:00.000Z';
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await handleSubscriptionActivated(supabase, resource);

      expect(getSubscriptionAmount).toHaveBeenCalledTimes(1);
      expect(state.order).toMatchObject({
        status: 'completed',
        amount_cents: 1_299,
        currency: 'EUR',
      });
      expect(state.queue.payload).toMatchObject({ amount_cents: 1_299, currency: 'EUR' });
    });

    it('rejects a provider financial mismatch after the subscription order is completed', async () => {
      vi.mocked(getSubscriptionAmount).mockResolvedValueOnce({
        amountCents: 1_299,
        currency: 'EUR',
        planId: 'PAYPAL-PLAN-1',
        nextBillingTime: '2026-08-29T00:00:00.000Z',
      });
      const { supabase, state, rpc } = createCaptureRecoveryHarness({ subscription: true });
      state.order.status = 'completed';
      state.frozenSnapshot = structuredClone(state.currentSnapshot);
      state.order.grant_snapshot_frozen_at = '2026-07-11T00:00:00.000Z';
      const resource = {
        id: 'SUB-RECOVERY-1',
        custom_id: JSON.stringify({
          guild_id: 'guild-1',
          product_id: 'product-1',
          plan_id: 'plan-1',
          customer_id: 'customer-1',
          discord_id: 'discord-1',
        }),
      };

      await expect(handleSubscriptionActivated(supabase, resource)).rejects.toThrow(
        'Completed subscription order disagrees with PayPal financial state',
      );
      expect(state.order).toMatchObject({
        status: 'completed',
        amount_cents: 999,
        currency: 'USD',
      });
      expect(state.queue).toBeNull();
      expect(state.updates).toEqual([]);
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});

/**
 * Finding 10 — a customer charged twice must not be fulfilled twice, and must
 * not simply lose the money either.
 */
describe('PayPal webhook — duplicate purchase capture', () => {
  const captureResource = {
    id: 'CAPTURE-DUPLICATE-1',
    custom_id: JSON.stringify({
      guild_id: 'guild-1',
      product_id: 'product-1',
      customer_id: 'customer-1',
      discord_id: 'discord-1',
    }),
    amount: { value: '9.99', currency_code: 'USD' },
    supplementary_data: {
      related_ids: { order_id: 'PAYPAL-ORDER-RECOVERY-1' },
    },
  };

  const priorEntitlement = {
    id: 'ent-prior',
    guild_id: 'guild-1',
    customer_id: 'customer-1',
    product_id: 'product-1',
    order_id: 'order-prior',
    status: 'active',
    created_at: '2026-07-01T00:00:00.000Z',
  };

  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('records the payment but grants nothing when the customer already owns the product', async () => {
    const { supabase, state } = createCaptureRecoveryHarness({ withLicense: true });
    state.entitlements = [priorEntitlement];

    await handlePaymentCaptured(supabase, captureResource);

    // The money is real and stays recorded — never silently swallowed.
    expect(state.payment).not.toBeNull();
    expect(state.order.status).toBe('completed');

    // …but nothing is delivered a second time: no fulfilment queued, no
    // licence key minted, no second entitlement.
    expect(state.queue).toBeNull();
    expect(state.licenseKey).toBeNull();
    expect(state.inserts.filter((i: any) => i.table === 'bot_action_queue')).toHaveLength(0);
  });

  it('records but withholds a historical capture that loses an atomic claim race', async () => {
    const { supabase, state } = createCaptureRecoveryHarness({ withLicense: true });
    state.fulfillmentClaimOrderId = 'order-concurrent-winner';

    await handlePaymentCaptured(supabase, captureResource);

    expect(state.payment).not.toBeNull();
    expect(state.order.status).toBe('completed');
    expect(state.fulfillmentHold).toEqual({
      winning_order_id: 'order-concurrent-winner',
      conflicting_entitlement_id: null,
    });
    expect(state.queue).toBeNull();
    expect(state.licenseKey).toBeNull();
    expect(state.alerts).toContainEqual(expect.objectContaining({
      alert_type: 'commerce_duplicate_purchase_capture',
      severity: 'critical',
      metadata: expect.objectContaining({
        order_id: 'order-1',
        winning_order_id: 'order-concurrent-winner',
      }),
    }));
  });

  it('raises a critical operator alert naming the order and the money at stake', async () => {
    const { supabase, state } = createCaptureRecoveryHarness();
    state.entitlements = [priorEntitlement];

    await handlePaymentCaptured(supabase, captureResource);

    expect(state.alerts).toHaveLength(1);
    const alert = state.alerts[0];
    expect(alert).toMatchObject({
      guild_id: 'guild-1',
      alert_type: 'commerce_duplicate_purchase_capture',
      severity: 'critical',
    });
    expect(alert.message).toContain('ORD-RECOVERY-1');
    expect(alert.message).toMatch(/refund/i);
    expect(alert.metadata).toMatchObject({
      order_id: 'order-1',
      paypal_capture_id: 'CAPTURE-DUPLICATE-1',
      amount_cents: 999,
      currency: 'USD',
      existing_entitlement_id: 'ent-prior',
    });
  });

  it('fulfils normally when the only entitlement came from this same order', async () => {
    const { supabase, state } = createCaptureRecoveryHarness();
    // A redelivered capture after fulfilment: the entitlement is this order's.
    state.entitlements = [{ ...priorEntitlement, id: 'ent-self', order_id: 'order-1' }];

    await handlePaymentCaptured(supabase, captureResource);

    expect(state.queue).not.toBeNull();
    expect(state.alerts ?? []).toHaveLength(0);
  });

  it.each(['expired', 'revoked', 'cancelled'])(
    'does not treat a %s entitlement as ownership',
    async (status) => {
      const { supabase, state } = createCaptureRecoveryHarness();
      state.entitlements = [{ ...priorEntitlement, status }];

      await handlePaymentCaptured(supabase, captureResource);

      expect(state.queue).not.toBeNull();
      expect(state.alerts ?? []).toHaveLength(0);
    },
  );

  it('refuses to fulfil when the atomic claim cannot be persisted', async () => {
    const { supabase, state } = createCaptureRecoveryHarness({ failClaimAttempts: 1 });

    await expect(handlePaymentCaptured(supabase, captureResource)).rejects.toThrow(
      /claim paid fulfillment/i,
    );
    // Nothing is staged or minted; the webhook fails loudly and retries.
    expect(state.queue).toBeNull();
    expect(state.licenseKey).toBeNull();
  });
});

describe('PayPal webhook — frozen licence delivery contract', () => {
  const subscriptionResource = {
    id: 'SUB-RECOVERY-1',
    custom_id: JSON.stringify({
      guild_id: 'guild-1',
      product_id: 'product-1',
      plan_id: 'plan-1',
      customer_id: 'customer-1',
      discord_id: 'discord-1',
    }),
  };
  const captureResource = {
    id: 'CAPTURE-RECOVERY-1',
    custom_id: JSON.stringify({
      guild_id: 'guild-1',
      product_id: 'product-1',
      customer_id: 'customer-1',
      discord_id: 'discord-1',
    }),
    amount: { value: '9.99', currency_code: 'USD' },
    supplementary_data: {
      related_ids: { order_id: 'PAYPAL-ORDER-RECOVERY-1' },
    },
  };

  it('stages, persists and delivers a key for a subscription sold as licence_key', async () => {
    const { supabase, state } = createCaptureRecoveryHarness({
      subscription: true,
      withLicense: true,
    });

    await handleSubscriptionActivated(supabase, subscriptionResource);

    expect(state.order.status).toBe('completed');
    expect(state.queue.payload).toMatchObject({
      fulfillment_type: 'subscription_activated',
      license_key_id: expect.any(String),
      license_key_plaintext: expect.stringMatching(/^SMNI(?:-[A-Z0-9]{4}){4}$/),
    });
    expect(state.licenseKey).toMatchObject({
      id: state.queue.payload.license_key_id,
      order_id: 'order-1',
      product_id: 'product-1',
    });
    expect(state.queue.status).toBe('pending');
  });

  it('never mints from a stale licence config when the frozen order sold file delivery', async () => {
    const { supabase, state } = createCaptureRecoveryHarness({ withLicense: true });
    state.order.delivery_type_snapshot = 'file';

    await handlePaymentCaptured(supabase, captureResource);

    expect(state.order.status).toBe('completed');
    expect(state.queue.payload).not.toHaveProperty('license_key_id');
    expect(state.queue.payload).not.toHaveProperty('license_key_plaintext');
    expect(state.licenseKey).toBeNull();
  });

  it('records and holds a legacy paid capture instead of guessing a missing delivery contract', async () => {
    const { supabase, state, rpc } = createCaptureRecoveryHarness({ withLicense: true });
    state.order.delivery_type_snapshot = null;

    await handlePaymentCaptured(supabase, captureResource);

    expect(state.payment).not.toBeNull();
    expect(state.order.status).toBe('completed');
    expect(state.queue).toBeNull();
    expect(state.licenseKey).toBeNull();
    expect(rpc.mock.calls
      .map(([name]) => name)
      .filter((name) =>
        name === 'commerce_claim_paid_fulfillment'
        || name === 'commerce_hold_unknown_delivery_contract'))
      .toEqual(['commerce_hold_unknown_delivery_contract']);
    expect(state.alerts).toContainEqual(expect.objectContaining({
      alert_type: 'commerce_unknown_delivery_contract',
      severity: 'critical',
      metadata: expect.objectContaining({ order_id: 'order-1' }),
    }));
  });

  it('rolls back claim and hold when the atomic unknown-delivery alert cannot persist', async () => {
    const { supabase, state, rpc } = createCaptureRecoveryHarness({
      subscription: true,
      withLicense: true,
      failAlertInsertAttempts: 1,
    });
    state.order.delivery_type_snapshot = null;

    await expect(
      handleSubscriptionActivated(supabase, subscriptionResource),
    ).rejects.toThrow('Failed to hold unknown delivery contract');

    expect(state.order.status).toBe('pending');
    expect(state.queue).toBeNull();
    expect(state.alerts ?? []).toHaveLength(0);
    expect(state.fulfillmentClaimOrderId).toBeNull();
    expect(state.fulfillmentHold).toBeNull();
    expect(rpc.mock.calls
      .map(([name]) => name)
      .filter((name) =>
        name === 'commerce_claim_paid_fulfillment'
        || name === 'commerce_hold_unknown_delivery_contract'))
      .toEqual(['commerce_hold_unknown_delivery_contract']);

    await handleSubscriptionActivated(supabase, subscriptionResource);

    expect(state.order.status).toBe('pending');
    expect(state.queue).toBeNull();
    expect(state.fulfillmentClaimOrderId).toBe(state.order.id);
    expect(state.fulfillmentHold).toMatchObject({
      winning_order_id: state.order.id,
      hold_reason: 'unknown_delivery_contract',
    });
    expect(state.alerts).toContainEqual(expect.objectContaining({
      alert_type: 'commerce_unknown_delivery_contract',
      severity: 'critical',
      metadata: expect.objectContaining({ order_id: 'order-1' }),
    }));
  });

  it('holds an activated duplicate subscription before any second entitlement or key', async () => {
    const { supabase, state } = createCaptureRecoveryHarness({
      subscription: true,
      withLicense: true,
    });
    state.entitlements = [{
      id: 'ent-prior-subscription',
      guild_id: 'guild-1',
      customer_id: 'customer-1',
      product_id: 'product-1',
      order_id: 'order-prior',
      status: 'active',
      created_at: '2026-07-01T00:00:00.000Z',
    }];

    await handleSubscriptionActivated(supabase, subscriptionResource);

    expect(state.order.status).toBe('pending_review');
    expect(state.queue).toBeNull();
    expect(state.licenseKey).toBeNull();
    expect(state.alerts).toContainEqual(expect.objectContaining({
      alert_type: 'commerce_duplicate_subscription_activation',
      severity: 'critical',
      metadata: expect.objectContaining({
        order_id: 'order-1',
        paypal_subscription_id: 'SUB-RECOVERY-1',
        existing_entitlement_id: 'ent-prior-subscription',
      }),
    }));
  });

  it('holds the subscription that loses a concurrent historical activation claim', async () => {
    const { supabase, state } = createCaptureRecoveryHarness({
      subscription: true,
      withLicense: true,
    });
    state.fulfillmentClaimOrderId = 'order-concurrent-subscription-winner';

    await handleSubscriptionActivated(supabase, subscriptionResource);

    expect(state.order.status).toBe('pending_review');
    expect(state.fulfillmentHold).toEqual({
      winning_order_id: 'order-concurrent-subscription-winner',
      conflicting_entitlement_id: null,
    });
    expect(state.queue).toBeNull();
    expect(state.licenseKey).toBeNull();
    expect(state.alerts).toContainEqual(expect.objectContaining({
      alert_type: 'commerce_duplicate_subscription_activation',
      severity: 'critical',
      metadata: expect.objectContaining({
        order_id: 'order-1',
        winning_order_id: 'order-concurrent-subscription-winner',
      }),
    }));
  });
});
