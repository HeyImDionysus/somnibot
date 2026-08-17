/**
 * GET /api/portal/orders — Customer's order history with invoices.
 * Requires: x-portal-token header.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { rateLimits } from '@/lib/api/rate-limit';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function getPortalCustomer(request: NextRequest) {
  const token = request.headers.get('x-portal-token');
  if (!token) return null;

  const admin = createAdminSupabase();
  const { data: session } = await admin
    .from('portal_sessions')
    .select('customer_id, guild_id')
    .eq('token_hash', hashToken(token))
    .eq('revoked', false)
    .gt('expires_at', new Date().toISOString())
    .single();

  return session;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getPortalCustomer(request);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // V6 Audit §7.1: Rate-limit portal data reads per token
    const token = request.headers.get('x-portal-token')!;
    const rl = await rateLimits.portalData(hashToken(token));
    if (rl.limited) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const admin = createAdminSupabase();

    const { data: portalConfig, error: configError } = await admin
      .from('guild_config')
      .select('self_service_cancellation, cancellation_timing, refund_requests_enabled, service_requests_enabled')
      .eq('guild_id', session.guild_id)
      .maybeSingle();
    if (configError) {
      return NextResponse.json({ error: 'Portal controls could not be loaded.' }, { status: 503 });
    }

    const { data: orders, error: ordersError } = await admin
      .from('orders')
      .select('id, order_number, amount_cents, discount_cents, currency, status, source, paypal_subscription_id, created_at, products(name, type), payments(id, amount_cents, currency, status, provider, created_at), entitlements(id, status, type, expires_at, grace_period_ends_at, cancelled_at)')
      .eq('customer_id', session.customer_id)
      .eq('guild_id', session.guild_id)
      .order('created_at', { ascending: false })
      .limit(500);
    if (ordersError) {
      return NextResponse.json({ error: 'Order history could not be loaded.' }, { status: 503 });
    }

    return NextResponse.json({
      success: true,
      data: (orders || []).map(({ paypal_subscription_id: subscriptionId, ...order }) => ({
        ...order,
        can_self_service_cancel:
          (order.source === 'purchase' || order.source === null)
          && typeof subscriptionId === 'string'
          && subscriptionId.length > 0
          && subscriptionId.trim() === subscriptionId,
      })),
      controls: {
        self_service_cancellation: portalConfig?.self_service_cancellation !== false,
        cancellation_timing: portalConfig?.cancellation_timing === 'immediate' ? 'immediate' : 'end-of-term',
        refund_requests_enabled: portalConfig?.refund_requests_enabled !== false,
        service_requests_enabled: portalConfig?.service_requests_enabled !== false,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
