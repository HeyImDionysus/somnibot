import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { apiServerError, dbError } from '@/lib/api/response';
import { getPayPalRuntimeConfig } from '@/lib/paypal';
import { applyPayPalPolicyEnvironment, loadPayPalPolicy } from '@/lib/paypal-policy';
import { createAdminSupabase } from '@/lib/supabase/admin';

const webhookRowSchema = z.object({
  event_type: z.string().min(1),
  result: z.enum(['success', 'error', 'duplicate']).nullable(),
  processed_at: z.string().datetime({ offset: true }).nullable(),
});

function webhookUrlReady(value: string): boolean {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname);
    return url.protocol === 'https:' && !local && url.pathname.replace(/\/$/, '') === '/api/paypal/webhook';
  } catch {
    return false;
  }
}

function dashboardApiBase(requestOrigin: string): string {
  const configured = process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || process.env.DASHBOARD_URL
    || '';
  try {
    return `${new URL(configured).origin}/api`;
  } catch {
    return `${requestOrigin.replace(/\/$/, '')}/api`;
  }
}

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const supabase = createAdminSupabase();
  try {
    const runtime = await getPayPalRuntimeConfig();
    const policy = await loadPayPalPolicy(supabase, auth.ctx.guildId);
    const paypal = applyPayPalPolicyEnvironment(runtime, policy.environment);
    const { data, error } = await supabase
      .from('webhook_events')
      .select('event_type, result, processed_at')
      .eq('guild_id', auth.ctx.guildId)
      .order('processed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return dbError(error, 'store/onboarding');

    const parsed = data ? webhookRowSchema.safeParse(data) : null;
    if (parsed && !parsed.success) {
      return apiServerError(new Error('latest PayPal webhook readback was invalid'), 'store/onboarding');
    }
    const lastWebhook = parsed?.success ? parsed.data : null;
    return NextResponse.json({
      success: true,
      data: {
        guildId: auth.ctx.guildId,
        environment: paypal.sandbox ? 'sandbox' : 'live',
        apiBase: dashboardApiBase(request.nextUrl.origin),
        credentialsConfigured: Boolean(paypal.clientId && paypal.clientSecret),
        webhookIdConfigured: Boolean(paypal.webhookId),
        webhookUrl: paypal.webhookUrl || null,
        webhookUrlReady: webhookUrlReady(paypal.webhookUrl),
        lastWebhook: lastWebhook ? {
          result: lastWebhook.result ?? 'pending',
          processedAt: lastWebhook.processed_at,
          eventType: lastWebhook.event_type,
        } : null,
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (caught) {
    return apiServerError(caught, 'store/onboarding');
  }
}
