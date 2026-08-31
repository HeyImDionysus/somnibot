import type { LaunchStageKey, LaunchStageState } from './commerce-operations';

function proofTimestampMicros(value: string): bigint | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = value.match(/\.(\d+)/)?.[1] ?? '';
  return BigInt(milliseconds) * BigInt(1000) + BigInt(fraction.padEnd(6, '0').slice(3, 6));
}

export function launchProofAtOrAfter(value: string | null, cutoff: string): boolean {
  const timestamp = value === null ? null : proofTimestampMicros(value);
  const boundary = proofTimestampMicros(cutoff);
  return timestamp !== null && boundary !== null && timestamp >= boundary;
}

export function latestLaunchProofTimestamp(values: readonly [string, ...string[]]): string {
  return values.reduce((latest, value) => launchProofAtOrAfter(value, latest) ? value : latest);
}

type ProductEvidence = {
  readonly id: string;
  readonly active: boolean;
  readonly type: 'one_time' | 'subscription' | 'free';
  readonly deliveryType: string;
  readonly priceCents: number;
  readonly policyConfigured: boolean;
  readonly integrationVerified: boolean;
};

type LaunchEvidenceInput = {
  readonly product: ProductEvidence;
  readonly orders: readonly {
    readonly id: string; readonly productId: string; readonly status: string;
    readonly paypalOrderId: string | null;
    readonly paypalSubscriptionId: string | null;
  }[];
  readonly freeClaims: readonly {
    readonly id: string; readonly orderId: string; readonly productId: string;
  }[];
  readonly payments: readonly {
    readonly id: string; readonly orderId: string; readonly status: string;
    readonly paypalPaymentId: string | null; readonly paypalEventId: string | null;
  }[];
  readonly webhooks: readonly {
    readonly eventId: string; readonly eventType: string; readonly result: 'success' | 'duplicate';
    readonly resourceId: string | null; readonly relatedOrderId: string | null;
    readonly billingAgreementId?: string | null;
  }[];
  readonly entitlements: readonly {
    readonly id: string; readonly orderId: string; readonly productId: string; readonly status: string;
  }[];
  readonly fulfillments: readonly {
    readonly id: string; readonly orderId: string; readonly kind: 'license' | 'download' | 'access';
    readonly deliveryState?: string; readonly sentAt?: string | null;
  }[];
  readonly refunds: readonly {
    readonly id: string; readonly orderId: string; readonly paymentId: string;
    readonly paypalRefundId: string;
  }[];
  readonly cancellations: readonly { readonly id: string; readonly orderId: string; readonly status: string }[];
};

type LaunchWitness = {
  readonly orderId: string | null;
  readonly paymentId: string | null;
  readonly paymentWebhookEventId: string | null;
  readonly reversalWebhookEventId: string | null;
  readonly freeClaimId: string | null;
};

function stage(proven: boolean): LaunchStageState {
  return proven ? 'verified' : 'pending';
}

function emptyWitness(): LaunchWitness {
  return {
    orderId: null,
    paymentId: null,
    paymentWebhookEventId: null,
    reversalWebhookEventId: null,
    freeClaimId: null,
  };
}

export function evaluateCommerceLaunchEvidence(input: LaunchEvidenceInput): {
  readonly stages: Readonly<Record<LaunchStageKey, LaunchStageState>>;
  readonly witness: LaunchWitness;
} {
  const productOrders = input.orders.filter((order) => order.productId === input.product.id);
  const deliveredFulfillments = input.fulfillments.filter((fulfillment) =>
    (input.product.deliveryType !== 'license_key' || fulfillment.kind === 'license')
    && (input.product.deliveryType !== 'access_pass' || fulfillment.kind === 'access')
    && (fulfillment.kind === 'download' || (fulfillment.deliveryState === 'sent' && Boolean(fulfillment.sentAt))));
  const baseStages = {
    product: stage(!input.product.active),
    policy: stage(input.product.policyConfigured),
    pricing: stage(input.product.type === 'free' ? input.product.priceCents === 0 : input.product.priceCents > 0),
    integration: stage(input.product.integrationVerified),
  } as const;

  if (input.product.type === 'free') {
    const claim = input.freeClaims.find((candidate) => (
      candidate.productId === input.product.id
      && productOrders.some((order) => order.id === candidate.orderId && order.status === 'completed')
    ));
    const orderId = claim?.orderId ?? null;
    const entitlement = orderId
      ? input.entitlements.find((candidate) => candidate.orderId === orderId
        && candidate.productId === input.product.id && candidate.status === 'active')
      : undefined;
    const fulfillment = orderId
      ? deliveredFulfillments.find((candidate) => candidate.orderId === orderId)
      : undefined;
    return {
      stages: {
        ...baseStages,
        sandbox_transaction: 'not_applicable',
        webhook: 'not_applicable',
        entitlement: stage(entitlement !== undefined),
        fulfillment: stage(fulfillment !== undefined),
        reversal: 'not_applicable',
      },
      witness: { ...emptyWitness(), orderId, freeClaimId: claim?.id ?? null },
    };
  }

  const payment = input.payments.find((candidate) => {
    const order = productOrders.find((productOrder) => productOrder.id === candidate.orderId);
    if (!order || !candidate.paypalPaymentId || !candidate.paypalEventId) return false;
    if (!(input.product.type === 'subscription' ? order.paypalSubscriptionId : order.paypalOrderId)) return false;
    return ['completed', 'refunded', 'reversed'].includes(candidate.status);
  });
  const order = payment ? productOrders.find((candidate) => candidate.id === payment.orderId) : undefined;
  const paymentWebhook = payment && order
    ? input.webhooks.find((candidate) => (
        candidate.eventId === payment.paypalEventId
        && candidate.resourceId === payment.paypalPaymentId
        && (input.product.type === 'subscription'
          ? candidate.eventType === 'PAYMENT.SALE.COMPLETED'
            && candidate.billingAgreementId === order.paypalSubscriptionId
          : candidate.eventType === 'PAYMENT.CAPTURE.COMPLETED'
            && candidate.relatedOrderId === order.paypalOrderId)
      ))
    : undefined;
  const entitlement = order
    ? input.entitlements.find((candidate) => candidate.orderId === order.id && candidate.productId === input.product.id)
    : undefined;
  const fulfillment = order
    ? deliveredFulfillments.find((candidate) => candidate.orderId === order.id)
    : undefined;
  const refund = payment
    ? input.refunds.find((candidate) => candidate.orderId === payment.orderId && candidate.paymentId === payment.id)
    : undefined;
  const reversalWebhook = refund
    ? input.webhooks.find((candidate) => (
        ['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED', 'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED'].includes(candidate.eventType)
        && candidate.resourceId === refund.paypalRefundId
      ))
    : undefined;
  const entitlementRevoked = entitlement !== undefined
    && ['cancelled', 'expired', 'suspended'].includes(entitlement.status);
  const cancellationProven = input.product.type !== 'subscription'
    || (order !== undefined && input.cancellations.some((candidate) => candidate.orderId === order.id && candidate.status === 'completed'));

  return {
    stages: {
      ...baseStages,
      sandbox_transaction: stage(payment !== undefined),
      webhook: stage(paymentWebhook !== undefined),
      entitlement: stage(entitlement !== undefined),
      fulfillment: stage(fulfillment !== undefined),
      reversal: stage(refund !== undefined && reversalWebhook !== undefined && entitlementRevoked && cancellationProven),
    },
    witness: {
      orderId: order?.id ?? null,
      paymentId: payment?.id ?? null,
      paymentWebhookEventId: paymentWebhook?.eventId ?? null,
      reversalWebhookEventId: reversalWebhook?.eventId ?? null,
      freeClaimId: null,
    },
  };
}
