/**
 * POST /api/paypal/webhook — PayPal webhook handler.
 *
 * Verifies signature, processes order completions and subscription events.
 * Architecture doc §30.5.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash, randomBytes } from 'crypto';

const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '';

// ── Helpers ─────────────────────────────────────────

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

async function verifyWebhookSignature(
  req: NextRequest,
  rawBody: string,
): Promise<boolean> {
  if (!PAYPAL_WEBHOOK_ID) return true; // Skip verification if no webhook ID configured

  const token = await getPayPalToken();
  if (!token) return false;

  try {
    const res = await fetch(
      `${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          auth_algo: req.headers.get('paypal-auth-algo'),
          cert_url: req.headers.get('paypal-cert-url'),
          transmission_id: req.headers.get('paypal-transmission-id'),
          transmission_sig: req.headers.get('paypal-transmission-sig'),
          transmission_time: req.headers.get('paypal-transmission-time'),
          webhook_id: PAYPAL_WEBHOOK_ID,
          webhook_event: JSON.parse(rawBody),
        }),
      },
    );

    if (!res.ok) return false;
    const data = await res.json();
    return data.verification_status === 'SUCCESS';
  } catch {
    return false;
  }
}

function generateLicenseKey(): {
  plaintext: string;
  hash: string;
  prefix: string;
  suffix: string;
} {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) {
      group += charset[bytes[g * 4 + i]! % charset.length];
    }
    groups.push(group);
  }
  const plaintext = `SMNI-${groups.join('-')}`;
  const hash = createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash, prefix: 'SMNI', suffix: groups[3]! };
}

// ── Main handler ────────────────────────────────────

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const supabase = createAdminSupabase();

  // Skip signature verification on replays
  const isReplay = req.headers.get('X-Replay') === 'true';
  if (!isReplay) {
    const valid = await verifyWebhookSignature(req, rawBody);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  let event: { event_type: string; resource: Record<string, unknown>; id?: string };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Check for duplicate
  const eventId = event.id ?? req.headers.get('paypal-transmission-id') ?? '';
  if (eventId) {
    const { data: existing } = await supabase
      .from('webhook_events')
      .select('event_id')
      .eq('event_id', eventId)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ status: 'duplicate' });
    }
  }

  // Log the event
  await supabase.from('webhook_events').insert({
    event_id: eventId || randomBytes(16).toString('hex'),
    event_type: event.event_type,
    payload: event as unknown as Record<string, unknown>,
  }).then(() => {}, () => {/* ignore logging failure */});

  try {
    switch (event.event_type) {
      case 'CHECKOUT.ORDER.APPROVED':
        await handleOrderApproved(supabase, event.resource);
        break;
      case 'PAYMENT.CAPTURE.COMPLETED':
        await handlePaymentCaptured(supabase, event.resource);
        break;
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        await handleSubscriptionActivated(supabase, event.resource);
        break;
      case 'BILLING.SUBSCRIPTION.CANCELLED':
        await handleSubscriptionCancelled(supabase, event.resource);
        break;
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        await handleSubscriptionSuspended(supabase, event.resource);
        break;
      case 'PAYMENT.SALE.COMPLETED':
        await handleSubscriptionPayment(supabase, event.resource);
        break;
      default:
        console.log(`[Webhook] Unhandled event: ${event.event_type}`);
    }

    // Mark event as processed
    if (eventId) {
      await supabase
        .from('webhook_events')
        .update({ result: 'success' })
        .eq('event_id', eventId);
    }
  } catch (err) {
    console.error(`[Webhook] Error processing ${event.event_type}:`, err);
    if (eventId) {
      await supabase
        .from('webhook_events')
        .update({ result: 'error', error_details: String(err) })
        .eq('event_id', eventId);
    }
  }

  return NextResponse.json({ status: 'ok' });
}

// ── Event handlers ──────────────────────────────────

async function handleOrderApproved(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const paypalOrderId = resource.id as string;
  if (!paypalOrderId) return;

  // Capture the payment
  const token = await getPayPalToken();
  if (!token) {
    console.error('[Webhook] Could not get PayPal token to capture order');
    return;
  }

  const captureRes = await fetch(
    `${PAYPAL_API_BASE}/v2/checkout/orders/${paypalOrderId}/capture`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (!captureRes.ok) {
    console.error('[Webhook] Failed to capture PayPal order:', await captureRes.text());
    return;
  }

  // Payment captured — PAYMENT.CAPTURE.COMPLETED will fire next
  console.log(`[Webhook] Captured PayPal order: ${paypalOrderId}`);
}

async function handlePaymentCaptured(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  // Find the order by PayPal order ID (from custom_id in purchase_units)
  const customId = (resource as { custom_id?: string }).custom_id;
  let meta: { guild_id: string; product_id: string; customer_id: string; discord_id: string } | null = null;

  if (customId) {
    try {
      meta = JSON.parse(customId);
    } catch {/* ignore */}
  }

  if (!meta) {
    // Try to find from supplementary_data or by paypal order ID reference
    console.log('[Webhook] Payment captured but no custom_id metadata');
    return;
  }

  // Find the pending order
  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_id', meta.customer_id)
    .eq('product_id', meta.product_id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!order) {
    console.log('[Webhook] No pending order found for payment');
    return;
  }

  const paypalCaptureId = resource.id as string;
  const amountValue = (resource as { amount?: { value?: string } }).amount?.value;
  const amountCents = amountValue ? Math.round(parseFloat(amountValue) * 100) : order.amount_cents;

  // Mark order completed
  await supabase
    .from('orders')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', order.id);

  // Create payment record
  await supabase.from('payments').insert({
    order_id: order.id,
    customer_id: meta.customer_id,
    guild_id: meta.guild_id,
    paypal_payment_id: paypalCaptureId,
    amount_cents: amountCents,
    currency: order.currency,
    status: 'completed',
  });

  // Update customer totals
  const { error: rpcError } = await supabase.rpc('increment_customer_totals', {
    p_customer_id: meta.customer_id,
    p_amount: amountCents,
  });
  if (rpcError) {
    // If RPC doesn't exist, do manual update
    await supabase
      .from('customers')
      .update({
        total_spent_cents: amountCents,
        first_purchase_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', meta.customer_id)
      .is('first_purchase_at', null);
  }

  // Get product info
  const { data: product } = await supabase
    .from('products')
    .select('*')
    .eq('id', meta.product_id)
    .single();

  if (!product) return;

  // Generate license key if product needs one
  const { data: licenseConfig } = await supabase
    .from('product_license_config')
    .select('*')
    .eq('product_id', meta.product_id)
    .maybeSingle();

  let licenseKeyId: string | undefined;
  let plaintextKey: string | undefined;

  if (licenseConfig) {
    const key = generateLicenseKey();
    plaintextKey = key.plaintext;

    const { data: insertedKey } = await supabase
      .from('license_keys')
      .insert({
        order_id: order.id,
        customer_id: meta.customer_id,
        product_id: meta.product_id,
        guild_id: meta.guild_id,
        key_hash: key.hash,
        key_prefix: key.prefix,
        key_suffix: key.suffix,
        bound_discord_id: meta.discord_id,
        status: 'pending_activation',
      })
      .select('id')
      .single();

    licenseKeyId = insertedKey?.id;
  }

  // Create entitlement
  await supabase.from('entitlements').insert({
    customer_id: meta.customer_id,
    guild_id: meta.guild_id,
    product_id: meta.product_id,
    license_key_id: licenseKeyId ?? null,
    order_id: order.id,
    type: 'one_time',
    status: licenseConfig ? 'pending' : 'active',
    source: 'purchase',
    granted_role_ids: product.granted_role_ids ?? [],
    granted_channel_ids: product.granted_channel_ids ?? [],
    starts_at: new Date().toISOString(),
  });

  console.log(`[Webhook] Order completed: ${order.order_number} for ${meta.discord_id}`);
  // NOTE: The bot's event system will handle DM receipts and role grants
  // when it picks up the entitlement.granted event
}

async function handleSubscriptionActivated(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const customId = (resource as { custom_id?: string }).custom_id;
  if (!customId) return;

  let meta: { guild_id: string; product_id: string; plan_id: string; customer_id: string; discord_id: string };
  try {
    meta = JSON.parse(customId);
  } catch { return; }

  const subscriptionId = resource.id as string;

  // Create order
  const { data: order } = await supabase
    .from('orders')
    .insert({
      order_number: `INS-${Date.now().toString().slice(-5)}`,
      customer_id: meta.customer_id,
      guild_id: meta.guild_id,
      product_id: meta.product_id,
      plan_id: meta.plan_id,
      paypal_subscription_id: subscriptionId,
      amount_cents: 0, // Will be updated on first payment
      currency: 'USD',
      status: 'completed',
      source: 'purchase',
    })
    .select('id')
    .single();

  if (!order) return;

  // Get product
  const { data: product } = await supabase
    .from('products')
    .select('granted_role_ids, granted_channel_ids')
    .eq('id', meta.product_id)
    .single();

  // Create entitlement
  await supabase.from('entitlements').insert({
    customer_id: meta.customer_id,
    guild_id: meta.guild_id,
    product_id: meta.product_id,
    plan_id: meta.plan_id,
    order_id: order.id,
    type: 'subscription',
    status: 'active',
    source: 'purchase',
    granted_role_ids: product?.granted_role_ids ?? [],
    granted_channel_ids: product?.granted_channel_ids ?? [],
    starts_at: new Date().toISOString(),
  });

  console.log(`[Webhook] Subscription activated: ${subscriptionId} for ${meta.discord_id}`);
}

async function handleSubscriptionCancelled(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const subscriptionId = resource.id as string;
  if (!subscriptionId) return;

  // Find order
  const { data: order } = await supabase
    .from('orders')
    .select('id')
    .eq('paypal_subscription_id', subscriptionId)
    .single();

  if (!order) return;

  await supabase
    .from('entitlements')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', order.id)
    .in('status', ['active', 'grace_period']);

  console.log(`[Webhook] Subscription cancelled: ${subscriptionId}`);
}

async function handleSubscriptionSuspended(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const subscriptionId = resource.id as string;
  if (!subscriptionId) return;

  const { data: order } = await supabase
    .from('orders')
    .select('id')
    .eq('paypal_subscription_id', subscriptionId)
    .single();

  if (!order) return;

  const gracePeriodEnd = new Date();
  gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 3);

  await supabase
    .from('entitlements')
    .update({
      status: 'grace_period',
      grace_period_ends_at: gracePeriodEnd.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', order.id)
    .eq('status', 'active');

  console.log(`[Webhook] Subscription suspended: ${subscriptionId}`);
}

async function handleSubscriptionPayment(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const billingAgreementId = (resource as { billing_agreement_id?: string }).billing_agreement_id;
  if (!billingAgreementId) return;

  const { data: order } = await supabase
    .from('orders')
    .select('id, customer_id, guild_id')
    .eq('paypal_subscription_id', billingAgreementId)
    .single();

  if (!order) return;

  const amountValue = (resource as { amount?: { total?: string } }).amount?.total;
  const amountCents = amountValue ? Math.round(parseFloat(amountValue) * 100) : 0;

  await supabase.from('payments').insert({
    order_id: order.id,
    customer_id: order.customer_id,
    guild_id: order.guild_id,
    paypal_payment_id: resource.id as string,
    amount_cents: amountCents,
    currency: 'USD',
    status: 'completed',
  });

  console.log(`[Webhook] Subscription payment: ${resource.id}`);
}
