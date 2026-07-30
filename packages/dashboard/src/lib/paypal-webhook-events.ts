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
    eventType: 'BILLING.SUBSCRIPTION.EXPIRED',
    purpose: 'Expires access for a managed product subscription at normal term end.',
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
  {
    eventType: 'PAYMENT.CAPTURE.DENIED',
    purpose: 'Cancels the pending order and alerts when PayPal refuses a capture.',
  },
  {
    eventType: 'CUSTOMER.DISPUTE.CREATED',
    purpose: 'Marks the order disputed and alerts the operator about a chargeback.',
  },
  {
    eventType: 'CUSTOMER.DISPUTE.UPDATED',
    purpose: 'Keeps the open dispute alert current as the case progresses.',
  },
  {
    eventType: 'CUSTOMER.DISPUTE.RESOLVED',
    purpose: 'Records the dispute outcome for the operator.',
  },
] as const;

export const PAYPAL_HANDLED_WEBHOOK_EVENT_TYPES = PAYPAL_HANDLED_WEBHOOK_EVENTS.map(
  (event) => event.eventType,
);

export const PAYPAL_INTENTIONALLY_EXCLUDED_WEBHOOK_EVENTS = [] as const;
