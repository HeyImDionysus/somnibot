import type { createAdminSupabase } from '@/lib/supabase/admin';
import {
  paypalApiBaseForEnvironment as sharedPaypalApiBaseForEnvironment,
  resolvePayPalEnvironment,
  type PayPalEnvironment as SharedPayPalEnvironment,
} from '@somnibot/shared';

export type PayPalEnvironment = SharedPayPalEnvironment;
export type PayPalRefundStrategy = 'provider-first' | 'local-first';

export interface PayPalPolicy {
  legacyUsdSaleTolerance: boolean;
  environment: PayPalEnvironment;
  refundStrategy: PayPalRefundStrategy;
  webhookStaleProcessingMs: number;
  webhookVerifyAttempts: number;
}

export const DEFAULT_PAYPAL_POLICY: PayPalPolicy = {
  legacyUsdSaleTolerance: true,
  environment: 'sandbox',
  refundStrategy: 'provider-first',
  webhookStaleProcessingMs: 300_000,
  webhookVerifyAttempts: 3,
};

interface PayPalPolicyRow {
  paypal_legacy_usd_sale_tolerance: boolean | null;
  paypal_environment: string | null;
  paypal_refund_strategy: string | null;
  paypal_webhook_stale_processing_ms: number | null;
  paypal_webhook_verify_attempts: number | null;
}

export function paypalApiBaseForEnvironment(environment: PayPalPolicy['environment']): string {
  return sharedPaypalApiBaseForEnvironment(environment);
}

/** Apply a tenant-selected provider mode to a process-level credential set. */
export function applyPayPalPolicyEnvironment<T extends { apiBase: string; sandbox: boolean }>(
  config: T,
  environment: unknown,
): T {
  const resolved = resolvePayPalEnvironment(environment);
  return {
    ...config,
    apiBase: paypalApiBaseForEnvironment(resolved),
    sandbox: resolved === 'sandbox',
  };
}

/** Load tenant-scoped PayPal controls, preserving pre-migration behavior. */
export async function loadPayPalPolicy(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string | null | undefined,
): Promise<PayPalPolicy> {
  if (!guildId) return DEFAULT_PAYPAL_POLICY;

  const { data, error } = await (supabase
    .from('guild_config')
    .select(
      'paypal_legacy_usd_sale_tolerance, paypal_environment, paypal_refund_strategy, '
      + 'paypal_webhook_stale_processing_ms, paypal_webhook_verify_attempts',
    )
    .eq('guild_id', guildId)
    .maybeSingle() as unknown as PromiseLike<{
      data: PayPalPolicyRow | null;
      error: { message?: string } | null;
    }>);

  if (error || !data) return DEFAULT_PAYPAL_POLICY;

  return {
    legacyUsdSaleTolerance: typeof data.paypal_legacy_usd_sale_tolerance === 'boolean'
      ? data.paypal_legacy_usd_sale_tolerance
      : DEFAULT_PAYPAL_POLICY.legacyUsdSaleTolerance,
    environment: resolvePayPalEnvironment(data.paypal_environment),
    refundStrategy: data.paypal_refund_strategy === 'local-first'
      ? 'local-first'
      : 'provider-first',
    webhookStaleProcessingMs: typeof data.paypal_webhook_stale_processing_ms === 'number'
      && Number.isInteger(data.paypal_webhook_stale_processing_ms)
      ? Math.min(86_400_000, Math.max(60_000, data.paypal_webhook_stale_processing_ms))
      : DEFAULT_PAYPAL_POLICY.webhookStaleProcessingMs,
    webhookVerifyAttempts: typeof data.paypal_webhook_verify_attempts === 'number'
      && Number.isInteger(data.paypal_webhook_verify_attempts)
      ? Math.min(10, Math.max(1, data.paypal_webhook_verify_attempts))
      : DEFAULT_PAYPAL_POLICY.webhookVerifyAttempts,
  };
}
