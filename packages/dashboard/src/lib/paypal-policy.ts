import type { createAdminSupabase } from '@/lib/supabase/admin';

export const DEFAULT_PAYPAL_POLICY = {
  legacyUsdSaleTolerance: true,
  environment: 'sandbox' as const,
  refundStrategy: 'provider-first' as const,
  webhookStaleProcessingMs: 300_000,
  webhookVerifyAttempts: 3,
};

export type PayPalPolicy = typeof DEFAULT_PAYPAL_POLICY;

export function paypalApiBaseForEnvironment(environment: PayPalPolicy['environment']): string {
  return environment === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

/** Load tenant-scoped PayPal controls, preserving pre-migration behavior. */
export async function loadPayPalPolicy(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string | null | undefined,
): Promise<PayPalPolicy> {
  if (!guildId) return DEFAULT_PAYPAL_POLICY;

  const { data, error } = await supabase
    .from('guild_config')
    .select(
      'paypal_legacy_usd_sale_tolerance, paypal_environment, paypal_refund_strategy, '
      + 'paypal_webhook_stale_processing_ms, paypal_webhook_verify_attempts',
    )
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error || !data) return DEFAULT_PAYPAL_POLICY;

  return {
    legacyUsdSaleTolerance: typeof data.paypal_legacy_usd_sale_tolerance === 'boolean'
      ? data.paypal_legacy_usd_sale_tolerance
      : DEFAULT_PAYPAL_POLICY.legacyUsdSaleTolerance,
    environment: data.paypal_environment === 'live' ? 'live' : 'sandbox',
    refundStrategy: data.paypal_refund_strategy === 'local-first'
      ? 'local-first'
      : 'provider-first',
    webhookStaleProcessingMs: Number.isInteger(data.paypal_webhook_stale_processing_ms)
      ? Math.min(86_400_000, Math.max(60_000, data.paypal_webhook_stale_processing_ms))
      : DEFAULT_PAYPAL_POLICY.webhookStaleProcessingMs,
    webhookVerifyAttempts: Number.isInteger(data.paypal_webhook_verify_attempts)
      ? Math.min(10, Math.max(1, data.paypal_webhook_verify_attempts))
      : DEFAULT_PAYPAL_POLICY.webhookVerifyAttempts,
  };
}
