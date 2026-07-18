import { describe, expect, it } from 'vitest';
import {
  canOfferOwnerRefund,
  completedRefundRefreshFailureToast,
  interpretRefundResult,
  refundActionLabel,
  refundDialogCopy,
} from '@/lib/api/order-refund-ui';
import type { RefundRequestResult } from '@/lib/api/order-refund-client';

function order(overrides: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    plan_id: null,
    paypal_subscription_id: null,
    amount_cents: 1_000,
    paypal_order_id: 'PAYPAL-ORDER-1',
    source: 'purchase',
    refund_context: 'provider',
    refund_state: null,
    ...overrides,
  };
}

function failure(
  code: string,
  status: string,
  error = 'error detail',
): RefundRequestResult {
  return { ok: false, httpStatus: 500, code, status, error };
}

describe('owner refund eligibility', () => {
  it('offers a completed non-subscription paid order for authoritative preparation', () => {
    expect(canOfferOwnerRefund(order())).toBe(true);
  });

  it.each([
    ['retyped product', { products: { type: 'subscription' } }],
    ['moved or unavailable product relation', { products: null }],
  ])('keeps a historical one-time order available after %s', (_label, overrides) => {
    expect(canOfferOwnerRefund(order(overrides))).toBe(true);
  });

  it.each(['manual', 'giveaway', 'automation'])(
    'offers a valid local zero-value %s order',
    (source) => {
      expect(canOfferOwnerRefund(order({
        amount_cents: 0,
        paypal_order_id: null,
        source,
        refund_context: 'local',
      }))).toBe(true);
    },
  );

  it.each([
    ['pending order', { status: 'pending' }],
    ['refunded order', { status: 'refunded' }],
    ['plan-backed order', { plan_id: 'plan-1' }],
    ['PayPal subscription order', { paypal_subscription_id: 'I-SUB' }],
    ['negative amount', { amount_cents: -1 }],
    ['fractional amount', { amount_cents: 1.5 }],
    ['positive order without exact capture context', { refund_context: null }],
    ['positive local context mismatch', { refund_context: 'local' }],
    ['zero-value purchase', { amount_cents: 0, paypal_order_id: null, refund_context: null }],
    ['zero-value provider order', { amount_cents: 0, paypal_order_id: 'PAYPAL-ORDER-1', source: 'manual' }],
  ])('does not advertise the action for %s', (_label, overrides) => {
    expect(canOfferOwnerRefund(order(overrides))).toBe(false);
  });

  it.each([
    ['retry', 'provider', true],
    ['pending', 'provider', true],
    ['provider_completed', 'provider', true],
    ['failed', 'provider', false],
    [null, 'provider', false],
    ['retry', 'local', false],
    ['pending', 'local', false],
    ['provider_completed', 'local', false],
    [null, null, false],
  ] as const)(
    'refunded recovery state=%s context=%s is offered=%s',
    (refundState, refundContext, expected) => {
      expect(canOfferOwnerRefund(order({
        status: 'refunded',
        refund_state: refundState,
        refund_context: refundContext,
      }))).toBe(expected);
    },
  );
});

describe('refund UI outcome matrix', () => {
  it.each([
    [
      'completed',
      { ok: true, status: 'completed', message: null } as RefundRequestResult,
      { closeDialog: true, refreshOrders: true, nextState: 'ready', title: 'Order refunded', variant: 'success' },
    ],
    [
      'pending',
      { ok: true, status: 'pending', message: 'Still processing' } as RefundRequestResult,
      { closeDialog: false, refreshOrders: false, nextState: 'pending', title: 'Refund pending at PayPal', variant: 'info' },
    ],
    [
      'permanent conflict',
      failure('ORDER_NOT_REFUNDABLE', 'not_refundable'),
      { closeDialog: true, refreshOrders: true, nextState: 'ready', title: 'Refund unavailable', variant: 'error' },
    ],
    [
      'provider failed',
      failure('PROVIDER_FAILED', 'failed'),
      { closeDialog: false, refreshOrders: false, nextState: 'failed', title: 'Refund not completed', variant: 'error' },
    ],
    [
      'provider cancelled',
      failure('PROVIDER_CANCELLED', 'cancelled'),
      { closeDialog: false, refreshOrders: false, nextState: 'failed', title: 'Refund not completed', variant: 'error' },
    ],
    [
      'provider completed but local pending',
      failure('LOCAL_FINALIZATION_PENDING', 'provider_completed'),
      { closeDialog: false, refreshOrders: false, nextState: 'provider_completed', title: 'Access cleanup pending', variant: 'warning' },
    ],
    [
      'unexpected preparation error',
      failure('REFUND_PREPARATION_FAILED', 'preparation_failed'),
      { closeDialog: false, refreshOrders: false, nextState: 'retry', title: 'Refund could not be confirmed', variant: 'error' },
    ],
    [
      'transport unknown',
      failure('PROVIDER_REQUEST_UNCONFIRMED', 'unconfirmed'),
      { closeDialog: false, refreshOrders: false, nextState: 'retry', title: 'Refund could not be confirmed', variant: 'error' },
    ],
  ])('maps %s honestly', (_label, result, expected) => {
    const outcome = interpretRefundResult(result);
    expect(outcome).toMatchObject({
      closeDialog: expected.closeDialog,
      refreshOrders: expected.refreshOrders,
      nextState: expected.nextState,
      toast: { title: expected.title, variant: expected.variant },
    });
  });

  it('warns explicitly when the refund completed but the cleared list could not refresh', () => {
    expect(completedRefundRefreshFailureToast()).toEqual({
      title: 'Refund completed; refresh failed',
      description: 'The refund completed, but the order list could not refresh.',
      variant: 'warning',
    });
  });
});

describe('refund dialog copy', () => {
  it.each([
    [null, 'Refund'],
    ['pending', 'Check Refund'],
    ['provider_completed', 'Finish Refund'],
    ['failed', 'Retry Refund'],
    ['retry', 'Retry Refund'],
  ] as const)('uses recovery-specific row action label for %s', (state, label) => {
    expect(refundActionLabel(state)).toBe(label);
  });

  it.each([
    ['ready', 'Refund', 'revoked only after PayPal completes'],
    ['pending', 'Check Status', 'will not issue a second refund'],
    ['provider_completed', 'Finish Refund', 'access cleanup is pending'],
    ['failed', 'Try Again', 'access remains active'],
    ['retry', 'Retry', 'same durable attempt'],
  ] as const)('describes %s without overstating success', (state, label, phrase) => {
    const copy = refundDialogCopy(state, 'ORD-1');
    expect(copy.confirmLabel).toBe(label);
    expect(copy.description).toContain(phrase);
  });

  it.each([
    ['ready', 'revoked immediately', 'no PayPal request is required'],
    ['retry', 'immediate access revocation', 'without contacting PayPal'],
  ] as const)('describes a local zero-value %s without waiting for PayPal', (
    state,
    immediatePhrase,
    noProviderPhrase,
  ) => {
    const copy = refundDialogCopy(state, 'ORD-LOCAL', 'local');
    expect(copy.description).toContain(immediatePhrase);
    expect(copy.description).toContain(noProviderPhrase);
  });
});
