import {
  paypalApiBaseForEnvironment,
  resolvePayPalEnvironment,
  type PayPalEnvironment,
} from '@somnibot/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

interface GuildPolicyQuery {
  select(columns: string): {
    eq(column: string, value: string): {
      maybeSingle(): PromiseLike<{
        data: { paypal_environment?: unknown } | null;
        error?: { message?: string } | null;
      }>;
    };
  };
}

export interface GuildPayPalRuntime {
  environment: PayPalEnvironment;
  apiBase: string;
  clientId: string;
  clientSecret: string;
  configured: boolean;
}

/**
 * Resolve PayPal credentials and provider host for one guild. Missing rows,
 * query errors, and invalid values all fall back to sandbox. A sandbox
 * credential marker can never be used to make a live provider call.
 */
export async function resolveGuildPayPalRuntime(
  supabase: SupabaseClient,
  guildId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GuildPayPalRuntime> {
  let policyValue: unknown;
  try {
    const query = supabase.from('guild_config') as unknown as GuildPolicyQuery;
    const result = await query
      .select('paypal_environment')
      .eq('guild_id', guildId)
      .maybeSingle();
    if (!result.error) policyValue = result.data?.paypal_environment;
  } catch {
    // Safe default: a policy read outage must not select live PayPal.
  }

  const environment = resolvePayPalEnvironment(policyValue);
  const clientId = env.PAYPAL_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim() ?? '';
  const sandboxMarker = env.PAYPAL_SANDBOX?.trim().toLowerCase();
  const sandboxCredential = ['true', '1', 'yes', 'sandbox'].includes(sandboxMarker ?? '');
  const configured = Boolean(clientId && clientSecret)
    && (environment === 'sandbox' || !sandboxCredential);

  return {
    environment,
    apiBase: paypalApiBaseForEnvironment(environment),
    clientId,
    clientSecret,
    configured,
  };
}
