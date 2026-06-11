export const PAYPAL_HANDLED_WEBHOOK_EVENTS = [
  {
    eventType: 'CHECKOUT.ORDER.APPROVED',
    purpose: 'Captures approved one-time checkout orders.',
  },
  {
    eventType: 'PAYMENT.CAPTURE.COMPLETED',
    purpose: 'Completes one-time orders and queues fulfillment.',
  },
  {
    eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
    purpose: 'Creates subscription orders and queues initial fulfillment.',
  },
  {
    eventType: 'BILLING.SUBSCRIPTION.CANCELLED',
    purpose: 'Revokes cancelled subscription access.',
  },
  {
    eventType: 'BILLING.SUBSCRIPTION.SUSPENDED',
    purpose: 'Moves subscription access into grace-period handling.',
  },
  {
    eventType: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
    purpose: 'Triggers the same grace-period handling as suspension.',
  },
  {
    eventType: 'PAYMENT.SALE.COMPLETED',
    purpose: 'Records recurring subscription payments.',
  },
  {
    eventType: 'PAYMENT.SALE.REFUNDED',
    purpose: 'Revokes subscription access after sale refunds.',
  },
  {
    eventType: 'PAYMENT.SALE.REVERSED',
    purpose: 'Revokes subscription access after sale reversals.',
  },
  {
    eventType: 'PAYMENT.CAPTURE.REFUNDED',
    purpose: 'Revokes access after external capture refunds.',
  },
  {
    eventType: 'PAYMENT.CAPTURE.REVERSED',
    purpose: 'Revokes access after capture reversals or chargebacks.',
  },
] as const;

export const PAYPAL_HANDLED_WEBHOOK_EVENT_TYPES = PAYPAL_HANDLED_WEBHOOK_EVENTS.map(
  (event) => event.eventType,
);

export const PAYPAL_INTENTIONALLY_EXCLUDED_WEBHOOK_EVENTS = [
  {
    eventType: 'BILLING.SUBSCRIPTION.EXPIRED',
    reason:
      'Do not subscribe by default until fixed-term subscription expiry policy is explicit; cancellation, suspension, failed payment, refund, reversal, and reconciliation paths currently control access removal.',
  },
] as const;
