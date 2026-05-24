/**
 * POST /api/orders/[id]/refund — Issue a refund via PayPal + revoke entitlement.
 *
 * Admin action. Phase B: also enqueues Discord role revocation via bot_action_queue.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';

import { getPayPalToken, PAYPAL_API_BASE } from '@/lib/paypal';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { id: orderId } = await params;
  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.order.refund);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // V47-C2: scope by guild_id so an attacker who owns another guild cannot
  // refund (and revoke entitlements + license keys + roles for) an unrelated
  // guild's order by sending its UUID.
  const { data: order } = await supabase
    .from('orders')
    .select('*, payments(*)')
    .eq('id', orderId)
    .eq('guild_id', guildId)
    .single();

  if (!order) {
    return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
  }

  if (order.status === 'refunded') {
    return NextResponse.json({ success: false, error: 'Order already refunded' }, { status: 400 });
  }

  // Attempt PayPal refund if we have a payment
  const payment = order.payments?.[0];
  if (payment?.paypal_payment_id) {
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

  // ── B.3: Get entitlements BEFORE updating, for role revocation ──
  const { data: activeEntitlements } = await supabase
    .from('entitlements')
    .select('id, customer_id, granted_role_ids')
    .eq('order_id', orderId)
    .in('status', ['active', 'pending', 'grace_period'])
    .limit(1000);

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

  // ── B.3: Enqueue Discord role revocation ──
  if (activeEntitlements?.length) {
    const allRoleIds = [...new Set(activeEntitlements.flatMap(e => e.granted_role_ids ?? []))];
    if (allRoleIds.length > 0) {
      // Get the customer's Discord ID
      const customerId = activeEntitlements[0]!.customer_id;
      const { data: customer } = await supabase
        .from('customers')
        .select('discord_id')
        .eq('id', customerId)
        .single();

      if (customer?.discord_id) {
        await supabase.from('bot_action_queue').insert({
          guild_id: guildId,
          action: 'revoke_roles',
          payload: {
            discord_id: customer.discord_id,
            role_ids: allRoleIds,
            reason: 'refund',
            order_id: orderId,
          },
          status: 'pending',
        }).then(() => {}, (err) => {
          console.error('[Commerce] Failed to enqueue role revocation:', err);
        });
      }
    }
  }

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
