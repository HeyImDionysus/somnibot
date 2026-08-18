import { z } from 'zod';

type CancelSubscriptionRequest = {
  readonly apiBase: string;
  readonly token: string;
  readonly subscriptionId: string;
  readonly requestId: string;
};

export type CancelSubscriptionOutcome = {
  readonly confirmed: boolean;
  readonly reconciled: boolean;
  readonly responsePresent: boolean;
  readonly httpStatus: number | null;
  readonly debugId: string | null;
  readonly providerStatus: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED' | null;
  readonly reconciliationState: 'not_required' | 'confirmed_cancelled' | 'confirmed_active' | 'unavailable';
};

function sanitizedDebugId(response: Response): string | null {
  const debugId = response.headers?.get('paypal-debug-id') ?? null;
  return debugId && /^[A-Za-z0-9_-]{1,128}$/.test(debugId) ? debugId : null;
}

async function readProviderState(
  request: CancelSubscriptionRequest,
): Promise<Pick<CancelSubscriptionOutcome, 'providerStatus' | 'reconciliationState'>> {
  try {
    const response = await fetch(
      `${request.apiBase}/v1/billing/subscriptions/${request.subscriptionId}`,
      {
        headers: { Authorization: `Bearer ${request.token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return { providerStatus: null, reconciliationState: 'unavailable' };
    const parsed = z.object({
      id: z.string(),
      status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED']),
    }).safeParse(await response.json());
    if (!parsed.success || parsed.data.id !== request.subscriptionId) {
      return { providerStatus: null, reconciliationState: 'unavailable' };
    }
    return {
      providerStatus: parsed.data.status,
      reconciliationState: ['CANCELLED', 'EXPIRED'].includes(parsed.data.status)
        ? 'confirmed_cancelled'
        : 'confirmed_active',
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { providerStatus: null, reconciliationState: 'unavailable' };
  }
}

export async function cancelPayPalSubscription(
  request: CancelSubscriptionRequest,
): Promise<CancelSubscriptionOutcome> {
  let response: Response | null = null;
  try {
    response = await fetch(
      `${request.apiBase}/v1/billing/subscriptions/${request.subscriptionId}/cancel`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.token}`,
          'PayPal-Request-Id': request.requestId,
        },
        body: JSON.stringify({ reason: 'Customer requested cancellation via self-service portal' }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  if (response?.status === 204) {
    return {
      confirmed: true,
      reconciled: false,
      responsePresent: true,
      httpStatus: 204,
      debugId: sanitizedDebugId(response),
      providerStatus: null,
      reconciliationState: 'not_required',
    };
  }
  const readback = await readProviderState(request);
  return {
    confirmed: readback.reconciliationState === 'confirmed_cancelled',
    reconciled: readback.reconciliationState === 'confirmed_cancelled',
    responsePresent: response !== null,
    httpStatus: response?.status ?? null,
    debugId: response ? sanitizedDebugId(response) : null,
    providerStatus: readback.providerStatus,
    reconciliationState: readback.reconciliationState,
  };
}
