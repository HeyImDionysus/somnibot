import { describe, expect, it } from 'vitest';
import { evaluateCommerceLaunchEvidence } from '@/lib/store/commerce-launch-evidence';

const base = {
  product: {
    id: 'product-1', active: false, type: 'one_time' as const,
    deliveryType: 'license_key', priceCents: 100,
    policyConfigured: true, integrationVerified: true,
  },
  orders: [{ id: 'order-1', productId: 'product-1', status: 'refunded', paypalOrderId: 'ORDER-1' }],
  freeClaims: [],
  payments: [{ id: 'payment-1', orderId: 'order-1', status: 'refunded', paypalPaymentId: 'CAPTURE-1', paypalEventId: 'EVENT-PAID' }],
  webhooks: [
    { eventId: 'EVENT-PAID', eventType: 'PAYMENT.CAPTURE.COMPLETED', result: 'success' as const, resourceId: 'CAPTURE-1', relatedOrderId: 'ORDER-1' },
    { eventId: 'EVENT-REFUND', eventType: 'PAYMENT.CAPTURE.REFUNDED', result: 'success' as const, resourceId: 'REFUND-1', relatedOrderId: null },
  ],
  entitlements: [{ id: 'entitlement-1', orderId: 'order-1', productId: 'product-1', status: 'cancelled' }],
  fulfillments: [{ id: 'key-1', orderId: 'order-1', kind: 'license' as const }],
  refunds: [{ id: 'refund-row-1', orderId: 'order-1', paymentId: 'payment-1', paypalRefundId: 'REFUND-1' }],
  cancellations: [],
};

describe('commerce launch evidence', () => {
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
      orders: [{ id: 'free-order', productId: 'product-1', status: 'completed', paypalOrderId: null }],
      freeClaims: [{ id: 'claim-1', orderId: 'free-order', productId: 'product-1' }],
      payments: [], webhooks: [], refunds: [], cancellations: [],
      entitlements: [{ id: 'entitlement-free', orderId: 'free-order', productId: 'product-1', status: 'active' }],
      fulfillments: [{ id: 'license-free', orderId: 'free-order', kind: 'license' }],
    });

    expect(result.stages.sandbox_transaction).toBe('not_applicable');
    expect(result.stages.webhook).toBe('not_applicable');
    expect(result.stages.entitlement).toBe('verified');
    expect(result.stages.fulfillment).toBe('verified');
    expect(result.stages.reversal).toBe('not_applicable');
    expect(result.witness.freeClaimId).toBe('claim-1');
  });
});
