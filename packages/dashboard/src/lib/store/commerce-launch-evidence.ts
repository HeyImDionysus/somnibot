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
  readonly requiredFulfillments?: readonly FulfillmentRequirement[];
};

type FulfillmentRequirement =
  | { readonly kind: 'license' }
  | { readonly kind: 'download'; readonly targetId?: string }
  | { readonly kind: 'access' }
  | { readonly kind: 'discord_role'; readonly targetId: string }
  | { readonly kind: 'discord_channel'; readonly targetId: string };

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
    readonly id: string; readonly orderId: string;
    readonly kind: 'license' | 'download' | 'access' | 'discord_role' | 'discord_channel';
    readonly targetId?: string;
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

type FulfillmentSummary = {
  readonly required: readonly string[];
  readonly verified: readonly string[];
  readonly missing: readonly string[];
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

function fallbackFulfillmentRequirements(deliveryType: string): readonly FulfillmentRequirement[] {
  switch (deliveryType) {
    case 'license_key': return [{ kind: 'license' }];
    case 'access_pass': return [{ kind: 'access' }];
    default: return [{ kind: 'download' }];
  }
}

function fulfillmentRequirementKey(requirement: FulfillmentRequirement): string {
  switch (requirement.kind) {
    case 'license': return 'license';
    case 'download': return requirement.targetId ? `file:${requirement.targetId}` : 'download';
    case 'access': return 'access';
    case 'discord_role': return `discord_role:${requirement.targetId}`;
    case 'discord_channel': return `discord_channel:${requirement.targetId}`;
  }
}

export function evaluateCommerceLaunchEvidence(input: LaunchEvidenceInput): {
  readonly stages: Readonly<Record<LaunchStageKey, LaunchStageState>>;
  readonly witness: LaunchWitness;
  readonly fulfillment: FulfillmentSummary;
} {
  const productOrders = input.orders.filter((order) => order.productId === input.product.id);
  const requirements = input.product.requiredFulfillments
    ?? fallbackFulfillmentRequirements(input.product.deliveryType);
  const requirementMatches = (requirement: FulfillmentRequirement, orderId: string) => input.fulfillments.some((fulfillment) => {
    if (fulfillment.orderId !== orderId) return false;
    const delivered = fulfillment.kind === 'download'
      || (fulfillment.deliveryState === 'sent' && Boolean(fulfillment.sentAt));
    if (!delivered) return false;
    switch (requirement.kind) {
      case 'license': return fulfillment.kind === 'license';
      case 'download': return fulfillment.kind === 'download'
        && (requirement.targetId === undefined || fulfillment.targetId === requirement.targetId);
      case 'access': return fulfillment.kind === 'access';
      case 'discord_role': return (fulfillment.kind === 'access' || fulfillment.kind === 'discord_role')
        && (fulfillment.kind === 'access' || fulfillment.targetId === requirement.targetId);
      case 'discord_channel': return (fulfillment.kind === 'access' || fulfillment.kind === 'discord_channel')
        && (fulfillment.kind === 'access' || fulfillment.targetId === requirement.targetId);
    }
  });
  const summarizeFulfillment = (orderId: string | null): FulfillmentSummary => {
    const required = requirements.map(fulfillmentRequirementKey);
    const verified = orderId === null ? [] : requirements
      .filter((requirement) => requirementMatches(requirement, orderId))
      .map(fulfillmentRequirementKey);
    return { required, verified, missing: required.filter((key) => !verified.includes(key)) };
  };
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
    const fulfillment = summarizeFulfillment(orderId);
    return {
      stages: {
        ...baseStages,
        sandbox_transaction: 'not_applicable',
        webhook: 'not_applicable',
        entitlement: stage(entitlement !== undefined),
        fulfillment: stage(fulfillment.missing.length === 0),
        reversal: 'not_applicable',
      },
      witness: { ...emptyWitness(), orderId, freeClaimId: claim?.id ?? null },
      fulfillment,
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
  const fulfillment = summarizeFulfillment(order?.id ?? null);
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
      fulfillment: stage(fulfillment.missing.length === 0),
      reversal: stage(refund !== undefined && reversalWebhook !== undefined && entitlementRevoked && cancellationProven),
    },
    witness: {
      orderId: order?.id ?? null,
      paymentId: payment?.id ?? null,
      paymentWebhookEventId: paymentWebhook?.eventId ?? null,
      reversalWebhookEventId: reversalWebhook?.eventId ?? null,
      freeClaimId: null,
    },
    fulfillment,
  };
}
