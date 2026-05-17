/**
 * POST /api/orders/[id]/refund — Issue a refund via PayPal + revoke entitlement.
 *
 * Admin action.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';

async function getPayPalToken(): Promise<string | null> {
  try {
    const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token;
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: orderId } = await params;
  const supabase = createAdminSupabase();
  const body = await req.json().catch(() => ({}));

  // Fetch order
  const { data: order } = await supabase
    .from('orders')
    .select('*, payments(*)')
    .eq('id', orderId)
    .single();

  if (!order) {
    return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
  }

  if (order.status === 'refunded') {
    return NextResponse.json({ success: false, error: 'Order already refunded' }, { status: 400 });
  }

  // Attempt PayPal refund if we have a payment
  const payment = order.payments?.[0];
  if (payment?.paypal_payment_id && PAYPAL_CLIENT_ID) {
    const token = await getPayPalToken();
    if (token) {
      try {
        const refundRes = await fetch(
          `${PAYPAL_API_BASE}/v2/payments/captures/${payment.paypal_payment_id}/refund`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              note_to_payer: body.reason ?? 'Refund issued',
            }),
          },
        );

        if (!refundRes.ok) {
          const err = await refundRes.text();
          console.error('[Commerce] PayPal refund failed:', err);
          // Continue with DB refund even if PayPal fails
        }
      } catch (err) {
        console.error('[Commerce] PayPal refund error:', err);
      }
    }
  }

  // Update order status
  await supabase
    .from('orders')
    .update({ status: 'refunded', updated_at: new Date().toISOString() })
    .eq('id', orderId);

  // Revoke entitlements
  await supabase
    .from('entitlements')
    .update({
      status: 'expired',
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', orderId)
    .in('status', ['active', 'pending', 'grace_period']);

  // Revoke license keys
  await supabase
    .from('license_keys')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revocation_reason: 'refund',
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', orderId)
    .neq('status', 'revoked');

  // Audit log
  await supabase.from('audit_logs').insert({
    guild_id: order.guild_id,
    actor_type: 'user',
    actor_id: 'dashboard',
    action: 'order.refunded',
    target_type: 'order',
    target_id: orderId,
    details: { reason: body.reason ?? 'Admin refund', amount_cents: order.amount_cents },
  });

  return NextResponse.json({ success: true });
}
