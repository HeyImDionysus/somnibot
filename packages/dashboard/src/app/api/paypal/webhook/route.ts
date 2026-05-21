/**
 * POST /api/paypal/webhook — PayPal webhook handler.
 *
 * Verifies signature, processes order completions and subscription events.
 * All fulfillment (role grants, receipt DMs, events) is delegated to the bot
 * via the `bot_action_queue`. This route only handles PayPal-side capture +
 * database records (orders, payments, entitlements, license keys).
 *
 * Architecture doc §30.5.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash, randomBytes } from 'crypto';

import { getPayPalToken, PAYPAL_API_BASE } from '@/lib/paypal';

const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '';

// ── Helpers ─────────────────────────────────────────

async function verifyWebhookSignature(
  req: NextRequest,
  rawBody: string,
): Promise<boolean> {
  // Webhook ID is REQUIRED — refuse to process without it
  if (!PAYPAL_WEBHOOK_ID) {
    console.error('[Webhook] PAYPAL_WEBHOOK_ID is not configured — refusing to process');
    return false;
  }

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

/**
 * Queue a fulfillment action for the bot process to pick up.
 * The bot has Discord access + event bus; this route does not.
 */
async function queueFulfillment(
  supabase: ReturnType<typeof createAdminSupabase>,
  action: string,
  guildId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await supabase.from('bot_action_queue').insert({
    guild_id: guildId,
    action,
    payload,
    status: 'pending',
  });

  if (error) {
    console.error(`[Webhook] Failed to queue ${action}:`, error.message);
    return false;
  }
  return true;
}

// ── Main handler ────────────────────────────────────

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const supabase = createAdminSupabase();

  // ALWAYS verify webhook signature — no bypasses
  const valid = await verifyWebhookSignature(req, rawBody);
  if (!valid) {
    console.error('[Webhook] Signature verification failed');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
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
      return NextResponse.json({ status: 'duplicate' }, { status: 200 });
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

    return NextResponse.json({ status: 'ok' }, { status: 200 });
  } catch (err) {
    console.error(`[Webhook] Error processing ${event.event_type}:`, err);
    if (eventId) {
      await supabase
        .from('webhook_events')
        .update({ result: 'error', error_details: String(err) })
        .eq('event_id', eventId);
    }

    // Return 500 so PayPal retries the webhook
    return NextResponse.json(
      { error: 'Processing failed', event_type: event.event_type },
      { status: 500 },
    );
  }
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
    throw new Error('Could not get PayPal token to capture order');
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
    const errorText = await captureRes.text();
    throw new Error(`Failed to capture PayPal order: ${errorText}`);
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
    const captureId = resource.id as string | undefined;
    console.error(
      `[Webhook] Payment captured but custom_id is missing or malformed — ` +
      `captureId=${captureId ?? 'unknown'}, raw custom_id=${JSON.stringify(customId)}. ` +
      `Customer was charged but no order/entitlement was created. Manual reconciliation required.`,
    );
    // Throw so the webhook returns 500 and PayPal retries (up to ~3 days).
    // This is preferable to silently losing the payment — the retry gives
    // time for the root cause (e.g., frontend not setting custom_id) to be fixed.
    throw new Error(`Payment captured without valid custom_id metadata (capture ${captureId})`);
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
    // Fallback: read current totals, add, and write back.
    // Note: increment_customer_totals RPC (V5) is the atomic path and should
    // rarely fail. This non-atomic fallback is a safety net.
    console.warn('[Webhook] increment_customer_totals RPC failed, using fallback:', rpcError.message);
    {
      const { data: customer } = await supabase
        .from('customers')
        .select('total_spent_cents, first_purchase_at')
        .eq('id', meta.customer_id)
        .single();

      await supabase
        .from('customers')
        .update({
          total_spent_cents: (customer?.total_spent_cents ?? 0) + amountCents,
          first_purchase_at: customer?.first_purchase_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', meta.customer_id);
    }
  }

  // Get product info
  const { data: product } = await supabase
    .from('products')
    .select('*')
    .eq('id', meta.product_id)
    .single();

  if (!product) {
    throw new Error(`Product ${meta.product_id} not found`);
  }

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

  // Queue fulfillment for the bot process (roles, DM, events)
  await queueFulfillment(supabase, 'fulfill_purchase', meta.guild_id, {
    fulfillment_type: 'one_time_purchase',
    guild_id: meta.guild_id,
    customer_id: meta.customer_id,
    discord_id: meta.discord_id,
    product_id: meta.product_id,
    product_name: product.name,
    order_id: order.id,
    order_number: order.order_number,
    amount_cents: amountCents,
    currency: order.currency,
    granted_role_ids: product.granted_role_ids ?? [],
    granted_channel_ids: product.granted_channel_ids ?? [],
    license_key_id: licenseKeyId,
    license_key_plaintext: plaintextKey,
    entitlement_type: 'one_time',
  });

  console.log(`[Webhook] Order completed + fulfillment queued: ${order.order_number} for ${meta.discord_id}`);
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
  } catch {
    console.error('[Webhook] Malformed custom_id in subscription event:', customId);
    return;
  }

  const subscriptionId = resource.id as string;

  // Create order
  const { data: order } = await supabase
    .from('orders')
    .insert({
      order_number: `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
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
    .select('id, order_number')
    .single();

  if (!order) return;

  // Get product
  const { data: product } = await supabase
    .from('products')
    .select('name, granted_role_ids, granted_channel_ids')
    .eq('id', meta.product_id)
    .single();

  // Queue fulfillment for the bot (roles, DM, events)
  await queueFulfillment(supabase, 'fulfill_subscription', meta.guild_id, {
    fulfillment_type: 'subscription_activated',
    guild_id: meta.guild_id,
    customer_id: meta.customer_id,
    discord_id: meta.discord_id,
    product_id: meta.product_id,
    product_name: product?.name ?? 'Subscription',
    order_id: order.id,
    order_number: order.order_number,
    plan_id: meta.plan_id,
    amount_cents: 0,
    currency: 'USD',
    granted_role_ids: product?.granted_role_ids ?? [],
    granted_channel_ids: product?.granted_channel_ids ?? [],
    entitlement_type: 'subscription',
  });

  console.log(`[Webhook] Subscription activated + fulfillment queued: ${subscriptionId} for ${meta.discord_id}`);
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
    .select('id, order_number, guild_id, customer_id, product_id')
    .eq('paypal_subscription_id', subscriptionId)
    .single();

  if (!order) return;

  // Get product + customer info
  const { data: product } = await supabase
    .from('products')
    .select('name')
    .eq('id', order.product_id)
    .single();

  const { data: customer } = await supabase
    .from('customers')
    .select('discord_id')
    .eq('id', order.customer_id)
    .single();

  if (!customer?.discord_id) return;

  // Queue fulfillment for the bot (role revocation, DM, events)
  await queueFulfillment(supabase, 'fulfill_cancellation', order.guild_id, {
    fulfillment_type: 'subscription_cancelled',
    guild_id: order.guild_id,
    customer_id: order.customer_id,
    discord_id: customer.discord_id,
    product_id: order.product_id,
    product_name: product?.name ?? 'Subscription',
    order_id: order.id,
    order_number: order.order_number,
    amount_cents: 0,
    currency: 'USD',
    granted_role_ids: [],
    granted_channel_ids: [],
    entitlement_type: 'subscription',
  });

  console.log(`[Webhook] Subscription cancelled + fulfillment queued: ${subscriptionId}`);
}

async function handleSubscriptionSuspended(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const subscriptionId = resource.id as string;
  if (!subscriptionId) return;

  const { data: order } = await supabase
    .from('orders')
    .select('id, order_number, guild_id, customer_id, product_id')
    .eq('paypal_subscription_id', subscriptionId)
    .single();

  if (!order) return;

  const { data: product } = await supabase
    .from('products')
    .select('name')
    .eq('id', order.product_id)
    .single();

  const { data: customer } = await supabase
    .from('customers')
    .select('discord_id')
    .eq('id', order.customer_id)
    .single();

  if (!customer?.discord_id) return;

  await queueFulfillment(supabase, 'fulfill_suspension', order.guild_id, {
    fulfillment_type: 'subscription_suspended',
    guild_id: order.guild_id,
    customer_id: order.customer_id,
    discord_id: customer.discord_id,
    product_id: order.product_id,
    product_name: product?.name ?? 'Subscription',
    order_id: order.id,
    order_number: order.order_number,
    amount_cents: 0,
    currency: 'USD',
    granted_role_ids: [],
    granted_channel_ids: [],
    entitlement_type: 'subscription',
  });

  console.log(`[Webhook] Subscription suspended + fulfillment queued: ${subscriptionId}`);
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

  console.log(`[Webhook] Subscription payment recorded: ${resource.id}`);
}
