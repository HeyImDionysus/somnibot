/**
 * POST /api/portal/cancel — Buyer self-service subscription cancellation.
 *
 * Commerce-portal contracts self-service-cancellation (default ON). The store
 * chooses whether access ends immediately or at the current access boundary.
 *
 * This route:
 *  - authenticates the portal customer via x-portal-token,
 *  - verifies the target subscription entitlement belongs to the customer,
 *  - cancels the PayPal subscription so it stops renewing,
 *  - applies the configured immediate or end-of-term access effect,
 *  - is idempotent: a second confirm resolves to the single scheduled
 *    cancellation without a second provider call or state change.
 *
 * Body: { entitlement_id: uuid, cancellation_timing: 'immediate' | 'end-of-term' }
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { rateLimits } from '@/lib/api/rate-limit';
import { getPayPalRuntimeConfig, getPayPalToken } from '@/lib/paypal';
import { applyPayPalPolicyEnvironment, loadPayPalPolicy } from '@/lib/paypal-policy';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const portalCancelSchema = z.object({
  entitlement_id: z.string().uuid(),
  cancellation_timing: z.enum(['immediate', 'end-of-term']),
});

function scheduledResponse(entitlement: {
  id: string;
  status: string;
  expires_at: string | null;
  grace_period_ends_at: string | null;
  cancelled_at: string | null;
  portal_cancellation_timing: string | null;
}, deduped: boolean, cancellationTiming: 'immediate' | 'end-of-term') {
  const immediate = cancellationTiming === 'immediate';
  return NextResponse.json({
    success: true,
    deduped,
    message: 'cancellation-scheduled',
    data: {
      entitlement_id: entitlement.id,
      status: entitlement.status,
      cancellation_timing: cancellationTiming,
      access_until: immediate
        ? entitlement.expires_at
        : entitlement.status === 'grace_period'
          ? entitlement.grace_period_ends_at
          : entitlement.expires_at,
      cancellation_scheduled_at: entitlement.cancelled_at,
    },
  });
}

function persistedCancellationTiming(
  entitlement: { portal_cancellation_timing: string | null },
): 'immediate' | 'end-of-term' | null {
  return entitlement.portal_cancellation_timing === 'immediate'
    || entitlement.portal_cancellation_timing === 'end-of-term'
    ? entitlement.portal_cancellation_timing
    : null;
}

export async function POST(request: NextRequest) {
  try {
    const token = request.headers.get('x-portal-token');
    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const admin = createAdminSupabase();
    const { data: session } = await admin
      .from('portal_sessions')
      .select('customer_id, guild_id')
      .eq('token_hash', hashToken(token))
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!session) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    const { data: portalConfig, error: portalConfigError } = await admin
      .from('guild_config')
      .select('self_service_cancellation, cancellation_timing')
      .eq('guild_id', session.guild_id)
      .maybeSingle();
    if (portalConfigError) {
      return NextResponse.json(
        { error: 'Could not verify the store cancellation policy. Please try again.' },
        { status: 503 },
      );
    }
    const selfServiceEnabled = portalConfig?.self_service_cancellation !== false;
    if (!selfServiceEnabled) {
      return NextResponse.json(
        { error: 'Self-service cancellation is disabled for this store.' },
        { status: 403 },
      );
    }
    const cancellationTiming = portalConfig?.cancellation_timing === 'immediate'
      ? 'immediate'
      : 'end-of-term';

    const rl = await rateLimits.portalData(hashToken(token));
    if (rl.limited) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const parsed = await parseBody(request, portalCancelSchema);
    if (!parsed.ok) return parsed.response;
    const { entitlement_id, cancellation_timing: confirmedTiming } = parsed.data;

    // The entitlement MUST be a subscription owned by this customer in this guild.
    const { data: entitlement, error: entitlementError } = await admin
      .from('entitlements')
      .select('id, status, type, expires_at, grace_period_ends_at, cancelled_at, portal_cancellation_timing, order_id')
      .eq('id', entitlement_id)
      .eq('customer_id', session.customer_id)
      .eq('guild_id', session.guild_id)
      .maybeSingle();

    if (entitlementError) {
      return NextResponse.json(
        { error: 'Could not verify the subscription. Please try again.' },
        { status: 503 },
      );
    }
    if (!entitlement || entitlement.type !== 'subscription') {
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 });
    }
    if (entitlement.cancelled_at) {
      const appliedTiming = persistedCancellationTiming(entitlement);
      if (!appliedTiming) {
        return NextResponse.json(
          { error: 'This subscription was cancelled outside the customer portal.' },
          { status: 409 },
        );
      }
      return scheduledResponse(entitlement, true, appliedTiming);
    }
    if (confirmedTiming !== cancellationTiming) {
      return NextResponse.json(
        { error: 'The store cancellation policy changed. Reload this page and review the current terms before confirming again.' },
        { status: 409 },
      );
    }
    if (!['active', 'grace_period'].includes(entitlement.status)) {
      return NextResponse.json({ error: 'This subscription is not active.' }, { status: 409 });
    }
    const accessUntil = entitlement.status === 'grace_period'
      ? entitlement.grace_period_ends_at
      : entitlement.expires_at;
    if (
      cancellationTiming === 'end-of-term'
      && (typeof accessUntil !== 'string' || !Number.isFinite(Date.parse(accessUntil)))
    ) {
      return NextResponse.json(
        { error: 'The paid-through date is unavailable. Cancellation was not scheduled.' },
        { status: 409 },
      );
    }

    // Cancel the PayPal subscription so it stops renewing. Access continues until
    // the current term end (expires_at) — this is the end-of-term effect.
    if (!entitlement.order_id) {
      return NextResponse.json(
        { error: 'The subscription billing record is unavailable. Cancellation was not scheduled.' },
        { status: 409 },
      );
    }
    const { data: order, error: orderError } = await admin
      .from('orders')
      .select('id, guild_id, customer_id, paypal_subscription_id')
      .eq('id', entitlement.order_id)
      .eq('guild_id', session.guild_id)
      .eq('customer_id', session.customer_id)
      .maybeSingle();
    if (orderError) {
      return NextResponse.json(
        { error: 'Could not verify the billing record. Please try again.' },
        { status: 503 },
      );
    }
    const subscriptionId = order?.paypal_subscription_id ?? null;
    if (
      !order
      || order.id !== entitlement.order_id
      || order.guild_id !== session.guild_id
      || order.customer_id !== session.customer_id
      || typeof subscriptionId !== 'string'
      || subscriptionId.length === 0
      || subscriptionId.trim() !== subscriptionId
    ) {
      return NextResponse.json(
        { error: 'The subscription billing record is unavailable. Cancellation was not scheduled.' },
        { status: 409 },
      );
    }

    const runtimeConfig = await getPayPalRuntimeConfig();
    const paypalPolicy = await loadPayPalPolicy(admin, session.guild_id);
    const config = applyPayPalPolicyEnvironment(runtimeConfig, paypalPolicy.environment);
    const paypalToken = await getPayPalToken(config);
    if (!paypalToken) {
      return NextResponse.json(
        { error: 'Payment provider unavailable. Please try again shortly.' },
        { status: 502 },
      );
    }
    const providerUrl = `${config.apiBase}/v1/billing/subscriptions/${subscriptionId}`;
    const res = await fetch(`${providerUrl}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${paypalToken}` },
      body: JSON.stringify({ reason: 'Customer requested cancellation via self-service portal' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      let reconciled = false;
      if (res.status === 422) {
        const providerState = await fetch(providerUrl, {
          headers: { Authorization: `Bearer ${paypalToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (providerState.ok) {
          const providerBody = await providerState.json().catch(() => null) as
            | { id?: unknown; status?: unknown }
            | null;
          reconciled =
            providerBody?.id === subscriptionId
            && ['CANCELLED', 'EXPIRED'].includes(String(providerBody?.status));
        }
      }
      if (!reconciled) {
        return NextResponse.json(
          { error: 'Could not schedule cancellation with the payment provider. Please try again.' },
          { status: 502 },
        );
      }
    }

    // Mark cancellation. The `.is('cancelled_at', null)` guard makes the write
    // single-winner under a race. Immediate policy revokes access now; the
    // default end-of-term policy keeps the entitlement active through expiry.
    const now = new Date().toISOString();
    const cancellationUpdate = cancellationTiming === 'immediate'
      ? {
          cancelled_at: now,
          portal_cancellation_timing: cancellationTiming,
          status: 'cancelled',
          expires_at: now,
          updated_at: now,
        }
      : { cancelled_at: now, portal_cancellation_timing: cancellationTiming, updated_at: now };
    const guardedUpdate = admin
      .from('entitlements')
      .update(cancellationUpdate)
      .eq('id', entitlement.id)
      .eq('customer_id', session.customer_id)
      .eq('guild_id', session.guild_id)
      .eq('status', entitlement.status)
      .is('cancelled_at', null)
      .is('portal_cancellation_timing', null);
    if (entitlement.expires_at === null) {
      guardedUpdate.is('expires_at', null);
    } else {
      guardedUpdate.eq('expires_at', entitlement.expires_at);
    }
    if (entitlement.grace_period_ends_at === null) {
      guardedUpdate.is('grace_period_ends_at', null);
    } else {
      guardedUpdate.eq('grace_period_ends_at', entitlement.grace_period_ends_at);
    }
    const { data: updated, error: updateError } = await guardedUpdate
      .select('id, status, expires_at, grace_period_ends_at, cancelled_at, portal_cancellation_timing')
      .maybeSingle();

    if (updateError) {
      return NextResponse.json(
        { error: 'The provider cancelled renewal, but the local schedule could not be saved. Please retry.' },
        { status: 503 },
      );
    }
    if (updated) {
      if (
        updated.id !== entitlement.id
        || (cancellationTiming === 'end-of-term' && !['active', 'grace_period'].includes(updated.status))
        || (cancellationTiming === 'immediate' && updated.status !== 'cancelled')
        || (cancellationTiming === 'end-of-term' && updated.expires_at !== entitlement.expires_at)
        || (cancellationTiming === 'end-of-term' && updated.grace_period_ends_at !== entitlement.grace_period_ends_at)
        || updated.portal_cancellation_timing !== cancellationTiming
        || typeof updated.cancelled_at !== 'string'
        || !Number.isFinite(Date.parse(updated.cancelled_at))
      ) {
        return NextResponse.json(
          { error: 'Cancellation scheduling returned inconsistent state. Please retry.' },
          { status: 503 },
        );
      }
      return scheduledResponse(updated, false, cancellationTiming);
    }

    // A concurrent confirm already scheduled it — resolve to that single entry.
    const { data: current, error: currentError } = await admin
      .from('entitlements')
      .select('id, status, expires_at, grace_period_ends_at, cancelled_at, portal_cancellation_timing')
      .eq('id', entitlement.id)
      .eq('customer_id', session.customer_id)
      .eq('guild_id', session.guild_id)
      .maybeSingle();
    if (
      currentError
      || !current
      || current.id !== entitlement.id
      || typeof current.cancelled_at !== 'string'
      || !Number.isFinite(Date.parse(current.cancelled_at))
    ) {
      return NextResponse.json(
        { error: 'The provider cancelled renewal, but the local schedule is unconfirmed. Please retry.' },
        { status: 503 },
      );
    }
    const appliedTiming = persistedCancellationTiming(current);
    if (!appliedTiming) {
      return NextResponse.json(
        { error: 'The provider cancelled renewal, but the local schedule is unconfirmed. Please retry.' },
        { status: 503 },
      );
    }
    if (
      appliedTiming === 'end-of-term'
      && (
        !['active', 'grace_period'].includes(current.status)
        || current.expires_at !== entitlement.expires_at
        || current.grace_period_ends_at !== entitlement.grace_period_ends_at
      )
    ) {
      return NextResponse.json(
        { error: 'The provider cancelled renewal, but the local schedule is unconfirmed. Please retry.' },
        { status: 503 },
      );
    }
    return scheduledResponse(current, true, appliedTiming);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
