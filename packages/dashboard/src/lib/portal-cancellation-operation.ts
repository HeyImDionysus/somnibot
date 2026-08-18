import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { writeCommerceAudit } from './commerce-audit';
import { cancelPayPalSubscription } from './paypal-subscription-cancellation';

const operationSchema = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  status: z.enum(['pending', 'uncertain', 'provider_confirmed', 'completed', 'failed']),
});

export type PortalCancellationOperation = z.infer<typeof operationSchema>;

export type PortalCancellationClaim = {
  readonly entitlementId: string;
  readonly orderId: string;
  readonly guildId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly timing: 'immediate' | 'end-of-term';
  readonly accessUntil: string;
  readonly providerApiBase: string;
  readonly providerToken: string;
};

export type ProviderCancellationResult =
  | { readonly kind: 'confirmed'; readonly operation: PortalCancellationOperation }
  | { readonly kind: 'retryable_failure'; readonly operation: PortalCancellationOperation }
  | { readonly kind: 'rejected'; readonly operation: PortalCancellationOperation }
  | { readonly kind: 'instrumentation_error' };

type OperationUpdate = {
  readonly operationId: string;
  readonly expectedStatuses: readonly PortalCancellationOperation['status'][];
  readonly values: Readonly<Record<string, unknown>>;
};

type OperationAudit = {
  readonly operation: PortalCancellationOperation;
  readonly claim: PortalCancellationClaim;
  readonly action: 'requested' | 'succeeded' | 'failed' | 'reconciled';
  readonly success: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
};

async function claimOperation(
  admin: SupabaseClient,
  claim: PortalCancellationClaim,
): Promise<PortalCancellationOperation | null> {
  const { data, error } = await admin.rpc('claim_portal_cancellation_operation', {
    p_entitlement_id: claim.entitlementId,
    p_order_id: claim.orderId,
    p_guild_id: claim.guildId,
    p_customer_id: claim.customerId,
    p_paypal_subscription_id: claim.subscriptionId,
    p_cancellation_timing: claim.timing,
    p_access_until: claim.accessUntil,
  });
  if (error) return null;
  const parsed = operationSchema.safeParse(Array.isArray(data) ? data[0] : data);
  return parsed.success ? parsed.data : null;
}

async function updateOperation(
  admin: SupabaseClient,
  update: OperationUpdate,
): Promise<boolean> {
  const { data, error } = await admin
    .from('portal_cancellation_operations')
    .update({ ...update.values, updated_at: new Date().toISOString() })
    .eq('id', update.operationId)
    .in('status', [...update.expectedStatuses])
    .select('id')
    .maybeSingle();
  return !error && data?.id === update.operationId;
}

async function writeOperationAudit(admin: SupabaseClient, entry: OperationAudit): Promise<void> {
  await writeCommerceAudit(admin, {
    guildId: entry.claim.guildId,
    actorId: entry.claim.customerId,
    action: `portal.cancellation_${entry.action}`,
    targetType: 'entitlement',
    targetId: entry.claim.entitlementId,
    occurrenceKey: `portal.cancellation_${entry.action}:${entry.operation.id}`,
    success: entry.success,
    details: {
      operation_id: entry.operation.id,
      provider_request_id: entry.operation.request_id,
      ...entry.details,
    },
  });
}

export async function ensurePortalCancellationProvider(
  admin: SupabaseClient,
  claim: PortalCancellationClaim,
): Promise<ProviderCancellationResult> {
  const operation = await claimOperation(admin, claim);
  if (!operation) return { kind: 'instrumentation_error' };
  await writeOperationAudit(admin, {
    operation,
    claim,
    action: 'requested',
    success: true,
    details: { cancellation_timing: claim.timing },
  });
  if (operation.status === 'provider_confirmed' || operation.status === 'completed') {
    return { kind: 'confirmed', operation };
  }

  const provider = await cancelPayPalSubscription({
    apiBase: claim.providerApiBase,
    token: claim.providerToken,
    subscriptionId: claim.subscriptionId,
    requestId: operation.request_id,
  });
  const providerDetails = {
    provider_http_status: provider.httpStatus,
    provider_debug_id: provider.debugId,
    provider_status: provider.providerStatus,
    reconciliation_state: provider.reconciliationState,
  };
  if (provider.confirmed) {
    const recorded = await updateOperation(admin, {
      operationId: operation.id,
      expectedStatuses: ['pending', 'uncertain', 'provider_confirmed'],
      values: {
        status: 'provider_confirmed',
        ...providerDetails,
        failure_code: null,
        provider_confirmed_at: new Date().toISOString(),
      },
    });
    if (!recorded) return { kind: 'instrumentation_error' };
    if (provider.reconciled) {
      await writeOperationAudit(admin, {
        operation,
        claim,
        action: 'reconciled',
        success: true,
        details: providerDetails,
      });
    }
    return { kind: 'confirmed', operation };
  }

  const retryable = !provider.responsePresent
    || provider.httpStatus === 408
    || provider.httpStatus === 429
    || (provider.httpStatus !== null && provider.httpStatus >= 500);
  const recorded = await updateOperation(admin, {
    operationId: operation.id,
    expectedStatuses: ['pending', 'uncertain'],
    values: {
      status: retryable ? 'uncertain' : 'failed',
      ...providerDetails,
      failure_code: retryable ? 'provider_uncertain' : 'provider_rejected',
    },
  });
  if (!recorded) return { kind: 'instrumentation_error' };
  await writeOperationAudit(admin, {
    operation,
    claim,
    action: 'failed',
    success: false,
    details: { ...providerDetails, retryable },
  });
  return { kind: retryable ? 'retryable_failure' : 'rejected', operation };
}

export async function completePortalCancellationOperation(
  admin: SupabaseClient,
  operation: PortalCancellationOperation,
  claim: PortalCancellationClaim,
): Promise<boolean> {
  const completed = await updateOperation(admin, {
    operationId: operation.id,
    expectedStatuses: ['provider_confirmed', 'completed'],
    values: {
      status: 'completed',
      completed_at: new Date().toISOString(),
      failure_code: null,
    },
  });
  if (!completed) return false;
  await writeOperationAudit(admin, {
    operation,
    claim,
    action: 'succeeded',
    success: true,
  });
  return true;
}
