/**
 * POST /api/orders/[id]/refund — Issue a refund via PayPal + revoke entitlement.
 *
 * Admin action. Terminal entitlement updates atomically enqueue Discord role
 * revocation through the database trigger.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';

import { getPayPalRuntimeConfig, getPayPalToken } from '@/lib/paypal';
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
    const paypalConfig = await getPayPalRuntimeConfig();
    const token = await getPayPalToken(paypalConfig);
    if (token) {
      try {
        const refundRes = await fetch(
          `${paypalConfig.apiBase}/v2/payments/captures/${payment.paypal_payment_id}/refund`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              // A local revocation failure must leave the route retryable.
              // Reuse the order UUID so a retry cannot create a second
              // provider refund while it repairs the local transition.
              'PayPal-Request-Id': orderId,
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

  // Revoke entitlements before marking the order terminal. The terminal
  // transition's database trigger writes the Discord role-revocation outbox
  // in the same transaction; if either part fails, no later local refund
  // effects may run and the non-terminal order remains retryable.
  const { data: revokedEntitlements, error: entitlementRevocationError } = await supabase
    .from('entitlements')
    .update({
      status: 'expired',
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', orderId)
    .in('status', ['active', 'pending', 'grace_period'])
    .select('id');

  if (entitlementRevocationError) {
    console.error('[Commerce] Failed to persist entitlement revocation for refund:', {
      orderId,
      guildId,
      error: entitlementRevocationError.message,
    });
    return NextResponse.json(
      { success: false, error: 'Refund could not be finalized. Please retry.' },
      { status: 500 },
    );
  }

  const { error: orderStatusError } = await supabase
    .from('orders')
    .update({ status: 'refunded', updated_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('guild_id', guildId);

  if (orderStatusError) {
    console.error('[Commerce] Failed to persist refunded order status:', {
      orderId,
      guildId,
      error: orderStatusError.message,
    });
    return NextResponse.json(
      { success: false, error: 'Refund could not be finalized. Please retry.' },
      { status: 500 },
    );
  }

  // W2 codex round 2: the revocation above expires 'grace_period' rows, a
  // terminal transition that strands any open 'entitlement_grace_period'
  // operator alert suspend() raised — EntitlementService.revoke() and the
  // reconciliation sweep resolve it on their terminal writes, but this manual
  // admin refund bypassed both. Resolve it with the same entitlement-scoped
  // filter (a no-op when none is open). Non-fatal: the revocation committed.
  const graceAlertEntitlementIds = [...new Set((revokedEntitlements ?? []).map((e) => e.id))];
  if (graceAlertEntitlementIds.length > 0) {
    const { error: graceAlertError } = await supabase
      .from('alerts')
      .update({ resolved: true, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('guild_id', guildId)
      .eq('alert_type', 'entitlement_grace_period')
      .in('metadata->>entitlement_id', graceAlertEntitlementIds)
      .eq('resolved', false);
    if (graceAlertError) {
      console.error('[Commerce] Failed to resolve grace-period alerts on refund:', graceAlertError.message);
    }
  }

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
