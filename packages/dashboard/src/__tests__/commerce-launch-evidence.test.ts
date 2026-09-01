import { describe, expect, it } from 'vitest';
import { evaluateCommerceLaunchEvidence, latestLaunchProofTimestamp, launchProofAtOrAfter } from '@/lib/store/commerce-launch-evidence';

const base = {
  product: {
    id: 'product-1', active: false, type: 'one_time' as const,
    deliveryType: 'license_key', priceCents: 100,
    policyConfigured: true, integrationVerified: true,
  },
  orders: [{ id: 'order-1', productId: 'product-1', status: 'refunded', paypalOrderId: 'ORDER-1', paypalSubscriptionId: null }],
  freeClaims: [],
  payments: [{ id: 'payment-1', orderId: 'order-1', status: 'refunded', paypalPaymentId: 'CAPTURE-1', paypalEventId: 'EVENT-PAID' }],
  webhooks: [
    { eventId: 'EVENT-PAID', eventType: 'PAYMENT.CAPTURE.COMPLETED', result: 'success' as const, resourceId: 'CAPTURE-1', relatedOrderId: 'ORDER-1' },
    { eventId: 'EVENT-REFUND', eventType: 'PAYMENT.CAPTURE.REFUNDED', result: 'success' as const, resourceId: 'REFUND-1', relatedOrderId: null },
  ],
  entitlements: [{ id: 'entitlement-1', orderId: 'order-1', productId: 'product-1', status: 'cancelled' }],
  fulfillments: [{ id: 'key-1', orderId: 'order-1', kind: 'license' as const, deliveryState: 'sent', sentAt: '2026-08-23T12:01:00Z' }],
  refunds: [{ id: 'refund-row-1', orderId: 'order-1', paymentId: 'payment-1', paypalRefundId: 'REFUND-1' }],
  cancellations: [],
};

describe('commerce launch evidence', () => {
  it('preserves PostgreSQL microseconds while comparing equivalent timezone offsets', () => {
    const older = '2026-08-23T08:01:00.000800-04:00';
    const newer = '2026-08-23T12:01:00.000900Z';
    expect(launchProofAtOrAfter(older, newer)).toBe(false);
    expect(launchProofAtOrAfter(newer, older)).toBe(true);
    expect(latestLaunchProofTimestamp([newer, older])).toBe(newer);
  });

  it('verifies a paid launch only when one exact order links product, payment, signed webhooks, delivery, entitlement and reversal', () => {
    const result = evaluateCommerceLaunchEvidence(base);

    expect(result.stages).toEqual({
      product: 'verified', policy: 'verified', pricing: 'verified', integration: 'verified',
      sandbox_transaction: 'verified', webhook: 'verified', entitlement: 'verified',
      fulfillment: 'verified', reversal: 'verified',
    });
    expect(result.witness).toEqual({
      orderId: 'order-1', paymentId: 'payment-1', paymentWebhookEventId: 'EVENT-PAID',
      reversalWebhookEventId: 'EVENT-REFUND', freeClaimId: null,
    });
  });

  it('rejects unrelated successful webhooks and reversals from another order', () => {
    const result = evaluateCommerceLaunchEvidence({
      ...base,
      webhooks: base.webhooks.map((webhook) => ({ ...webhook, resourceId: `OTHER-${webhook.resourceId}` })),
      refunds: [{ ...base.refunds[0], orderId: 'order-2' }],
    });

    expect(result.stages.webhook).toBe('pending');
    expect(result.stages.reversal).toBe('pending');
  });

  it('proves a free claim, entitlement and fulfillment without requiring PayPal evidence', () => {
    const result = evaluateCommerceLaunchEvidence({
      product: { ...base.product, type: 'free', priceCents: 0 },
      orders: [{ id: 'free-order', productId: 'product-1', status: 'completed', paypalOrderId: null, paypalSubscriptionId: null }],
      freeClaims: [{ id: 'claim-1', orderId: 'free-order', productId: 'product-1' }],
      payments: [], webhooks: [], refunds: [], cancellations: [],
      entitlements: [{ id: 'entitlement-free', orderId: 'free-order', productId: 'product-1', status: 'active' }],
      fulfillments: [{ id: 'license-free', orderId: 'free-order', kind: 'license', deliveryState: 'sent', sentAt: '2026-08-23T12:01:00Z' }],
    });

    expect(result.stages.sandbox_transaction).toBe('not_applicable');
    expect(result.stages.webhook).toBe('not_applicable');
    expect(result.stages.entitlement).toBe('verified');
    expect(result.stages.fulfillment).toBe('verified');
    expect(result.stages.reversal).toBe('not_applicable');
    expect(result.witness.freeClaimId).toBe('claim-1');
  });

  it('verifies subscription SALE evidence with a subscription identity and no PayPal order id', () => {
    // Given a completed subscription journey with provider-bound sale and cancellation.
    const input = {
      ...base, product: { ...base.product, type: 'subscription' as const },
      orders: [{ ...base.orders[0], paypalOrderId: null, paypalSubscriptionId: 'SUB-1' }],
      webhooks: [
        { ...base.webhooks[0], eventType: 'PAYMENT.SALE.COMPLETED', relatedOrderId: null, billingAgreementId: 'SUB-1' },
        { ...base.webhooks[1], eventType: 'PAYMENT.SALE.REFUNDED' },
      ],
      cancellations: [{ id: 'cancel-1', orderId: 'order-1', status: 'completed' }],
    };
    // When the evidence is evaluated.
    const result = evaluateCommerceLaunchEvidence(input);
    // Then every journey stage is proven.
    expect(Object.values(result.stages).every((value) => value === 'verified')).toBe(true);
  });

  it.each(['SUB-OTHER', null])('rejects a SALE whose billing agreement is %s', (billingAgreementId) => {
    // Given a sale belonging to a different or unidentified subscription.
    const input = {
      ...base, product: { ...base.product, type: 'subscription' as const },
      orders: [{ ...base.orders[0], paypalSubscriptionId: 'SUB-1' }],
      webhooks: [{ ...base.webhooks[0], eventType: 'PAYMENT.SALE.COMPLETED', billingAgreementId }],
    };
    // When / Then the webhook is not verified.
    expect(evaluateCommerceLaunchEvidence(input).stages.webhook).toBe('pending');
  });

  it('rejects SALE evidence for a one-time capture order', () => {
    // Given / When a subscription sale is attached to a one-time order.
    const result = evaluateCommerceLaunchEvidence({ ...base,
      webhooks: [{ ...base.webhooks[0], eventType: 'PAYMENT.SALE.COMPLETED' }],
    });
    // Then a capture is still required.
    expect(result.stages.webhook).toBe('pending');
  });

  it.each(['pending', 'sending', 'failed', 'uncertain'])('does not prove license delivery while outward state is %s', (deliveryState) => {
    // Given a persisted key without confirmed outward delivery.
    const input = { ...base, fulfillments: [{ ...base.fulfillments[0], deliveryState, sentAt: null }] };
    // When / Then persistence alone is not fulfillment.
    expect(evaluateCommerceLaunchEvidence(input).stages.fulfillment).toBe('pending');
  });

  it('rejects sent license delivery without a durable sent timestamp', () => {
    // Given / When an incomplete delivery record is evaluated.
    const result = evaluateCommerceLaunchEvidence({ ...base,
      fulfillments: [{ ...base.fulfillments[0], sentAt: null }],
    });
    // Then the license remains unfulfilled.
    expect(result.stages.fulfillment).toBe('pending');
  });

  it('does not substitute a companion download for required license delivery', () => {
    const result = evaluateCommerceLaunchEvidence({ ...base,
      fulfillments: [{ id: 'download-1', orderId: 'order-1', kind: 'download' }],
    });
    expect(result.stages.fulfillment).toBe('pending');
  });

  it('requires every configured license, file, role, and channel fulfillment', () => {
    // Given a composed product whose saved policy requires four distinct benefits.
    const result = evaluateCommerceLaunchEvidence({
      ...base,
      product: {
        ...base.product,
        requiredFulfillments: [
          { kind: 'license' },
          { kind: 'download', targetId: 'file-1' },
          { kind: 'discord_role', targetId: 'role-1' },
          { kind: 'discord_channel', targetId: 'channel-1' },
        ],
      },
      fulfillments: [
        base.fulfillments[0],
        { id: 'download-1', orderId: 'order-1', kind: 'download', targetId: 'file-1' },
        { id: 'role-1', orderId: 'order-1', kind: 'discord_role', targetId: 'role-1', deliveryState: 'sent', sentAt: '2026-08-23T12:01:00Z' },
        { id: 'channel-1', orderId: 'order-1', kind: 'discord_channel', targetId: 'channel-1', deliveryState: 'sent', sentAt: '2026-08-23T12:01:00Z' },
      ],
    });

    // Then all four concrete requirements are proven.
    expect(result.stages.fulfillment).toBe('verified');
    expect(result.fulfillment).toEqual({
      required: ['license', 'file:file-1', 'discord_role:role-1', 'discord_channel:channel-1'],
      verified: ['license', 'file:file-1', 'discord_role:role-1', 'discord_channel:channel-1'],
      missing: [],
    });
  });

  it('preserves the specific missing secondary rail instead of accepting the primary delivery', () => {
    // Given current license evidence without the separately configured file delivery.
    const result = evaluateCommerceLaunchEvidence({
      ...base,
      product: {
        ...base.product,
        requiredFulfillments: [
          { kind: 'license' },
          { kind: 'download', targetId: 'file-1' },
        ],
      },
    });

    // Then the composed fulfillment is blocked with the exact missing file.
    expect(result.stages.fulfillment).toBe('pending');
    expect(result.fulfillment.missing).toEqual(['file:file-1']);
  });

  it('retains delivery-type fallback for a truly single-rail product', () => {
    // Given a legacy license-only product with no explicit requirement vector.
    const result = evaluateCommerceLaunchEvidence(base);

    // Then its one successful rail remains sufficient.
    expect(result.stages.fulfillment).toBe('verified');
    expect(result.fulfillment).toEqual({ required: ['license'], verified: ['license'], missing: [] });
  });
});
