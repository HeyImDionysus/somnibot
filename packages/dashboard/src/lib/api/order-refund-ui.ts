import type { RefundRequestResult } from './order-refund-client';

export type RefundDialogState =
  | 'ready'
  | 'pending'
  | 'provider_completed'
  | 'failed'
  | 'retry';

export type RefundProviderContext = 'provider' | 'local';

export interface RefundableOrderSummary {
  status: string;
  plan_id: string | null;
  paypal_subscription_id: string | null;
  amount_cents: number;
  refund_context: RefundProviderContext | null;
  refund_state: Exclude<RefundDialogState, 'ready'> | null;
}

export interface RefundUiOutcome {
  closeDialog: boolean;
  refreshOrders: boolean;
  nextState: RefundDialogState;
  toast: {
    title: string;
    description?: string;
    variant: 'success' | 'error' | 'warning' | 'info';
  };
}

export function canOfferOwnerRefund(order: RefundableOrderSummary): boolean {
  if (
    order.plan_id !== null
    || order.paypal_subscription_id !== null
    || !Number.isSafeInteger(order.amount_cents)
    || order.amount_cents < 0
  ) return false;

  if (order.status === 'refunded') {
    return order.amount_cents > 0
      && order.refund_context === 'provider'
      && ['retry', 'pending', 'provider_completed'].includes(order.refund_state as string);
  }
  if (order.status !== 'completed') return false;

  if (order.amount_cents > 0) {
    return order.refund_context === 'provider';
  }

  return order.refund_context === 'local';
}

export function refundActionLabel(
  state: RefundDialogState | null | undefined,
): string {
  switch (state) {
    case 'pending':
      return 'Check Refund';
    case 'provider_completed':
      return 'Finish Refund';
    case 'failed':
    case 'retry':
      return 'Retry Refund';
    case 'ready':
    case null:
    case undefined:
      return 'Refund';
  }
}

export function interpretRefundResult(result: RefundRequestResult): RefundUiOutcome {
  if (result.ok && result.status === 'completed') {
    return {
      closeDialog: true,
      refreshOrders: true,
      nextState: 'ready',
      toast: { title: 'Order refunded', variant: 'success' },
    };
  }
  if (result.ok) {
    return {
      closeDialog: false,
      refreshOrders: false,
      nextState: 'pending',
      toast: {
        title: 'Refund pending at PayPal',
        description: result.message,
        variant: 'info',
      },
    };
  }

  if (result.code === 'ORDER_NOT_REFUNDABLE') {
    return {
      closeDialog: true,
      refreshOrders: true,
      nextState: 'ready',
      toast: { title: 'Refund unavailable', description: result.error, variant: 'error' },
    };
  }
  if (result.code === 'PROVIDER_FAILED' || result.code === 'PROVIDER_CANCELLED') {
    return {
      closeDialog: false,
      refreshOrders: false,
      nextState: 'failed',
      toast: { title: 'Refund not completed', description: result.error, variant: 'error' },
    };
  }
  if (result.code === 'LOCAL_FINALIZATION_PENDING' || result.status === 'provider_completed') {
    return {
      closeDialog: false,
      refreshOrders: false,
      nextState: 'provider_completed',
      toast: { title: 'Access cleanup pending', description: result.error, variant: 'warning' },
    };
  }
  return {
    closeDialog: false,
    refreshOrders: false,
    nextState: 'retry',
    toast: { title: 'Refund could not be confirmed', description: result.error, variant: 'error' },
  };
}

export function completedRefundRefreshFailureToast(): RefundUiOutcome['toast'] {
  return {
    title: 'Refund completed; refresh failed',
    description: 'The refund completed, but the order list could not refresh.',
    variant: 'warning',
  };
}

export function refundDialogCopy(
  state: RefundDialogState,
  orderNumber: string,
  providerContext: RefundProviderContext = 'provider',
) {
  switch (state) {
    case 'pending':
      return {
        description: `PayPal is still processing order ${orderNumber}. Checking status will not issue a second refund.`,
        confirmLabel: 'Check Status',
      };
    case 'provider_completed':
      return {
        description: `PayPal refunded order ${orderNumber}, but access cleanup is pending. Retry to finish safely.`,
        confirmLabel: 'Finish Refund',
      };
    case 'failed':
      return {
        description: `PayPal did not complete the refund for order ${orderNumber}. Customer access remains active.`,
        confirmLabel: 'Try Again',
      };
    case 'retry':
      if (providerContext === 'local') {
        return {
          description: `The local refund for order ${orderNumber} did not finish. Retry resumes immediate access revocation without contacting PayPal.`,
          confirmLabel: 'Retry',
        };
      }
      return {
        description: `The refund status for order ${orderNumber} could not be confirmed. Retry uses the same durable attempt when required.`,
        confirmLabel: 'Retry',
      };
    case 'ready':
      if (providerContext === 'local') {
        return {
          description: `Complete the local refund for order ${orderNumber}? Access will be revoked immediately; no PayPal request is required.`,
          confirmLabel: 'Refund',
        };
      }
      return {
        description: `Issue a refund for order ${orderNumber}? Entitlements and license keys will be revoked only after PayPal completes it.`,
        confirmLabel: 'Refund',
      };
  }
}
