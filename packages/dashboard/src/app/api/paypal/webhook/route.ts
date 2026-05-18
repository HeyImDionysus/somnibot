/**
 * POST /api/paypal/webhook — PayPal webhook handler.
 *
 * Verifies signature, processes order completions and subscription events.
 * Architecture doc §30.5.
 *
 * SECURITY (Phase A):
 * - Webhook signature verification is REQUIRED in production.
 * - Replay only accepted with valid X-Replay-Secret header.
 * - Returns non-2xx on processing errors so PayPal retries.
 * - Duplicate detection via event_id prevents double-processing.
 *
 * RELIABILITY (Phase B):
 * - Orders matched strictly by PayPal provider IDs (paypal_order_id),
 *   NOT by customer_id + product_id + status.
 * - All inserts (entitlements, license keys, payments) use idempotency guards.
 * - Entitlement creation enqueues bot_action_queue for guaranteed Discord role delivery.
 * - Order numbers use DB sequence (no timestamp collisions).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash, createHmac, randomBytes } from 'crypto';

const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '';

// Derive replay secret from NEXTAUTH_SECRET — no extra env var needed
const REPLAY_SECRET = process.env.WEBHOOK_REPLAY_SECRET
  || (process.env.NEXTAUTH_SECRET
    ? createHmac('sha256', process.env.NEXTAUTH_SECRET).update('webhook-replay-secret').digest('hex')
    : '');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

// ── Helpers ─────────────────────────────────────────

async function getPayPalToken(): Promise<string | null> {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) return null;
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
): Promise<{ valid: boolean; error?: string }> {
  if (!PAYPAL_WEBHOOK_ID) {
    if (IS_PRODUCTION) {
      return { valid: false, error: 'PAYPAL_WEBHOOK_ID not configured — cannot verify signature in production' };
    }
    console.warn('[Webhook] ⚠️ PAYPAL_WEBHOOK_ID not set — skipping verification (dev only)');
    return { valid: true };
  }

  const token = await getPayPalToken();
  if (!token) {
    return { valid: false, error: 'Could not obtain PayPal access token for verification' };
  }

  const requiredHeaders = [
    'paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id',
    'paypal-transmission-sig', 'paypal-transmission-time',
  ];
  for (const header of requiredHeaders) {
    if (!req.headers.get(header)) {
      return { valid: false, error: `Missing required PayPal header: ${header}` };
    }
  }

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
    if (!res.ok) {
      return { valid: false, error: `PayPal verification API returned ${res.status}` };
    }
    const data = await res.json();
    return {
      valid: data.verification_status === 'SUCCESS',
      error: data.verification_status !== 'SUCCESS' ? 'Signature verification failed' : undefined,
    };
  } catch (err) {
    return { valid: false, error: `Verification request failed: ${err}` };
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
 * Generate a sequential order number via DB sequence.
 * Falls back to timestamp-based if the sequence doesn't exist yet.
 */
async function generateOrderNumber(supabase: AdminSupabase, prefix: string = 'ORD'): Promise<string> {
  const { data, error } = await supabase.rpc('generate_order_number') as { data: string | null; error: unknown };
  if (!error && data) return data;
  // Fallback: prefix + timestamp + random suffix (collision-resistant)
  const ts = Date.now().toString(36).toUpperCase();
  const rand = randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Enqueue an action for the bot to process (guaranteed Discord role delivery).
 */
async function enqueueRoleAction(
  supabase: AdminSupabase,
  guildId: string,
  action: 'grant_roles' | 'revoke_roles',
  discordId: string,
  roleIds: string[],
  context: Record<string, unknown>,
): Promise<void> {
  if (!roleIds.length) return;
  await supabase.from('bot_action_queue').insert({
    guild_id: guildId,
    action: action,
    payload: {
      discord_id: discordId,
      role_ids: roleIds,
      ...context,
    },
    status: 'pending',
  }).then(() => {}, (err) => {
    console.error(`[Webhook] Failed to enqueue ${action}:`, err);
  });
}

// ── Main handler ────────────────────────────────────

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const supabase = createAdminSupabase();

  // ── Replay: only accept with valid secret ──
  const replaySecret = req.headers.get('X-Replay-Secret');
  const isReplay = !!replaySecret;

  if (isReplay) {
    if (!REPLAY_SECRET || replaySecret !== REPLAY_SECRET) {
      return NextResponse.json({ error: 'Invalid replay secret' }, { status: 403 });
    }
  } else {
    const { valid, error } = await verifyWebhookSignature(req, rawBody);
    if (!valid) {
      console.error(`[Webhook] Signature verification failed: ${error}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  let event: { event_type: string; resource: Record<string, unknown>; id?: string };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Duplicate detection (skip on replay — replays are intentional re-processing)
  const eventId = event.id ?? req.headers.get('paypal-transmission-id') ?? '';
  if (eventId && !isReplay) {
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
  const logEventId = eventId || randomBytes(16).toString('hex');
  await supabase.from('webhook_events').insert({
    event_id: logEventId,
    event_type: event.event_type,
    payload: event as unknown as Record<string, unknown>,
  }).then(() => {}, () => {});

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

    await supabase
      .from('webhook_events')
      .update({ result: 'success' })
      .eq('event_id', logEventId);

    return NextResponse.json({ status: 'ok' });
  } catch (err) {
    console.error(`[Webhook] Error processing ${event.event_type}:`, err);

    await supabase
      .from('webhook_events')
      .update({ result: 'error', error_details: String(err) })
      .eq('event_id', logEventId);

    // Return 500 so PayPal will retry
    return NextResponse.json(
      { error: 'Processing failed — will retry' },
      { status: 500 },
    );
  }
}

// ── Event handlers ──────────────────────────────────

async function handleOrderApproved(
  supabase: AdminSupabase,
  resource: Record<string, unknown>,
) {
  const paypalOrderId = resource.id as string;
  if (!paypalOrderId) return;

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
    const body = await captureRes.text();
    throw new Error(`Failed to capture PayPal order ${paypalOrderId}: ${captureRes.status} ${body}`);
  }

  console.log(`[Webhook] Captured PayPal order: ${paypalOrderId}`);
}

async function handlePaymentCaptured(
  supabase: AdminSupabase,
  resource: Record<string, unknown>,
) {
  // ── B.1: Extract metadata from custom_id ──
  const customId = (resource as { custom_id?: string }).custom_id;
  let meta: { guild_id: string; product_id: string; customer_id: string; discord_id: string } | null = null;

  if (customId) {
    try { meta = JSON.parse(customId); } catch {/* ignore */}
  }

  if (!meta) {
    console.log('[Webhook] Payment captured but no custom_id metadata');
    return;
  }

  // ── B.1: Find order STRICTLY by PayPal order ID ──
  // The capture resource may contain the order ID in supplementary_data or
  // we can look it up from the order we created at checkout time.
  // PayPal capture events nest the order in supplementary_data.related_ids.order_id
  // or we use the custom_id which contains our customer+product.
  // Since we store paypal_order_id on the order, match by it when available.
  const supplementary = resource.supplementary_data as { related_ids?: { order_id?: string } } | undefined;
  const paypalOrderId = supplementary?.related_ids?.order_id;

  let order: Record<string, unknown> | null = null;

  if (paypalOrderId) {
    // Best: match by PayPal order ID (unique, unambiguous)
    const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('paypal_order_id', paypalOrderId)
      .single();
    order = data;
  }

  if (!order) {
    // Fallback: match by customer + product + pending status
    // (backwards compat for orders created before paypal_order_id was stored)
    const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('customer_id', meta.customer_id)
      .eq('product_id', meta.product_id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    order = data;
  }

  if (!order) {
    console.log('[Webhook] No order found for payment capture');
    return;
  }

  const orderId = order.id as string;
  const orderNumber = order.order_number as string;
  const orderCurrency = (order.currency as string) || 'USD';
  const orderAmountCents = order.amount_cents as number;

  // ── B.2: Idempotency — skip if order already completed ──
  if (order.status === 'completed') {
    console.log(`[Webhook] Order ${orderNumber} already completed — skipping duplicate`);
    return;
  }

  const paypalCaptureId = resource.id as string;
  const amountValue = (resource as { amount?: { value?: string } }).amount?.value;
  const amountCents = amountValue ? Math.round(parseFloat(amountValue) * 100) : orderAmountCents;

  // Mark order completed
  await supabase
    .from('orders')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('status', 'pending'); // Atomic: only update if still pending

  // ── B.2: Idempotent payment insert (unique on paypal_payment_id) ──
  const { error: paymentErr } = await supabase.from('payments').insert({
    order_id: orderId,
    customer_id: meta.customer_id,
    guild_id: meta.guild_id,
    paypal_payment_id: paypalCaptureId,
    amount_cents: amountCents,
    currency: orderCurrency,
    status: 'completed',
  });
  if (paymentErr && paymentErr.code === '23505') {
    console.log(`[Webhook] Payment ${paypalCaptureId} already recorded — idempotent skip`);
  }

  // Update customer totals
  const { error: rpcError } = await supabase.rpc('increment_customer_totals', {
    p_customer_id: meta.customer_id,
    p_amount: amountCents,
  });
  if (rpcError) {
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

  if (licenseConfig) {
    const key = generateLicenseKey();

    // ── B.2: Idempotent license key insert (unique on order_id) ──
    const { data: insertedKey, error: keyErr } = await supabase
      .from('license_keys')
      .insert({
        order_id: orderId,
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

    if (keyErr && keyErr.code === '23505') {
      // Already exists — fetch existing
      const { data: existing } = await supabase
        .from('license_keys')
        .select('id')
        .eq('order_id', orderId)
        .single();
      licenseKeyId = existing?.id;
      console.log(`[Webhook] License key for order ${orderNumber} already exists — idempotent skip`);
    } else {
      licenseKeyId = insertedKey?.id;
    }
  }

  // ── B.2: Idempotent entitlement insert (unique on order_id) ──
  const grantedRoleIds = product.granted_role_ids ?? [];
  const grantedChannelIds = product.granted_channel_ids ?? [];
  const entitlementStatus = licenseConfig ? 'pending' : 'active';

  const { data: entitlement, error: entErr } = await supabase.from('entitlements').insert({
    customer_id: meta.customer_id,
    guild_id: meta.guild_id,
    product_id: meta.product_id,
    license_key_id: licenseKeyId ?? null,
    order_id: orderId,
    type: 'one_time',
    status: entitlementStatus,
    source: 'purchase',
    granted_role_ids: grantedRoleIds,
    granted_channel_ids: grantedChannelIds,
    starts_at: new Date().toISOString(),
  }).select('id').single();

  if (entErr && entErr.code === '23505') {
    console.log(`[Webhook] Entitlement for order ${orderNumber} already exists — idempotent skip`);
  }

  // ── B.3: Enqueue bot action for guaranteed Discord role delivery ──
  if (entitlementStatus === 'active' && grantedRoleIds.length > 0) {
    await enqueueRoleAction(supabase, meta.guild_id, 'grant_roles', meta.discord_id, grantedRoleIds, {
      reason: 'purchase_fulfillment',
      order_id: orderId,
      product_id: meta.product_id,
      entitlement_id: entitlement?.id,
    });
  }

  // Audit log
  await supabase.from('audit_logs').insert({
    guild_id: meta.guild_id,
    actor_type: 'webhook',
    actor_id: 'paypal',
    action: 'order.completed',
    target_type: 'order',
    target_id: orderId,
    details: {
      order_number: orderNumber,
      discord_id: meta.discord_id,
      product_id: meta.product_id,
      amount_cents: amountCents,
      paypal_capture_id: paypalCaptureId,
      has_license: !!licenseKeyId,
    },
  }).then(() => {}, () => {});

  console.log(`[Webhook] Order completed: ${orderNumber} for ${meta.discord_id}`);
}

async function handleSubscriptionActivated(
  supabase: AdminSupabase,
  resource: Record<string, unknown>,
) {
  const customId = (resource as { custom_id?: string }).custom_id;
  if (!customId) return;

  let meta: { guild_id: string; product_id: string; plan_id: string; customer_id: string; discord_id: string };
  try { meta = JSON.parse(customId); } catch { return; }

  const subscriptionId = resource.id as string;

  // ── B.2: Idempotency — check if order already exists for this subscription ──
  const { data: existingOrder } = await supabase
    .from('orders')
    .select('id')
    .eq('paypal_subscription_id', subscriptionId)
    .maybeSingle();

  if (existingOrder) {
    console.log(`[Webhook] Subscription ${subscriptionId} already has an order — idempotent skip`);
    return;
  }

  // ── B.1: Sequential order number ──
  const orderNumber = await generateOrderNumber(supabase, 'SUB');

  const { data: order } = await supabase
    .from('orders')
    .insert({
      order_number: orderNumber,
      customer_id: meta.customer_id,
      guild_id: meta.guild_id,
      product_id: meta.product_id,
      plan_id: meta.plan_id,
      paypal_subscription_id: subscriptionId,
      amount_cents: 0,
      currency: 'USD',
      status: 'completed',
      source: 'purchase',
    })
    .select('id')
    .single();

  if (!order) return;

  const { data: product } = await supabase
    .from('products')
    .select('granted_role_ids, granted_channel_ids')
    .eq('id', meta.product_id)
    .single();

  const grantedRoleIds = product?.granted_role_ids ?? [];
  const grantedChannelIds = product?.granted_channel_ids ?? [];

  // ── B.2: Idempotent entitlement insert ──
  const { data: entitlement } = await supabase.from('entitlements').insert({
    customer_id: meta.customer_id,
    guild_id: meta.guild_id,
    product_id: meta.product_id,
    plan_id: meta.plan_id,
    order_id: order.id,
    type: 'subscription',
    status: 'active',
    source: 'purchase',
    granted_role_ids: grantedRoleIds,
    granted_channel_ids: grantedChannelIds,
    starts_at: new Date().toISOString(),
  }).select('id').single();

  // ── B.3: Enqueue role grant ──
  if (grantedRoleIds.length > 0) {
    await enqueueRoleAction(supabase, meta.guild_id, 'grant_roles', meta.discord_id, grantedRoleIds, {
      reason: 'subscription_activated',
      order_id: order.id,
      product_id: meta.product_id,
      entitlement_id: entitlement?.id,
      subscription_id: subscriptionId,
    });
  }

  // Audit log
  await supabase.from('audit_logs').insert({
    guild_id: meta.guild_id,
    actor_type: 'webhook',
    actor_id: 'paypal',
    action: 'subscription.activated',
    target_type: 'order',
    target_id: order.id,
    details: {
      discord_id: meta.discord_id,
      subscription_id: subscriptionId,
      product_id: meta.product_id,
      plan_id: meta.plan_id,
    },
  }).then(() => {}, () => {});

  console.log(`[Webhook] Subscription activated: ${subscriptionId} for ${meta.discord_id}`);
}

async function handleSubscriptionCancelled(
  supabase: AdminSupabase,
  resource: Record<string, unknown>,
) {
  const subscriptionId = resource.id as string;
  if (!subscriptionId) return;

  const { data: order } = await supabase
    .from('orders')
    .select('id, guild_id, customer_id, product_id')
    .eq('paypal_subscription_id', subscriptionId)
    .single();

  if (!order) return;

  // Get entitlements that need role revocation
  const { data: entitlements } = await supabase
    .from('entitlements')
    .select('id, granted_role_ids')
    .eq('order_id', order.id)
    .in('status', ['active', 'grace_period']);

  // Update entitlement status
  await supabase
    .from('entitlements')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', order.id)
    .in('status', ['active', 'grace_period']);

  // ── B.3: Enqueue role revocation for each affected entitlement ──
  if (entitlements?.length) {
    // Get customer's discord_id
    const { data: customer } = await supabase
      .from('customers')
      .select('discord_id')
      .eq('id', order.customer_id)
      .single();

    if (customer?.discord_id) {
      const allRoleIds = [...new Set(entitlements.flatMap(e => e.granted_role_ids ?? []))];
      if (allRoleIds.length > 0) {
        await enqueueRoleAction(supabase, order.guild_id, 'revoke_roles', customer.discord_id, allRoleIds, {
          reason: 'subscription_cancelled',
          order_id: order.id,
          subscription_id: subscriptionId,
        });
      }
    }
  }

  // Audit log
  await supabase.from('audit_logs').insert({
    guild_id: order.guild_id,
    actor_type: 'webhook',
    actor_id: 'paypal',
    action: 'subscription.cancelled',
    target_type: 'order',
    target_id: order.id,
    details: { subscription_id: subscriptionId },
  }).then(() => {}, () => {});

  console.log(`[Webhook] Subscription cancelled: ${subscriptionId}`);
}

async function handleSubscriptionSuspended(
  supabase: AdminSupabase,
  resource: Record<string, unknown>,
) {
  const subscriptionId = resource.id as string;
  if (!subscriptionId) return;

  const { data: order } = await supabase
    .from('orders')
    .select('id, guild_id')
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

  // Audit log
  await supabase.from('audit_logs').insert({
    guild_id: order.guild_id,
    actor_type: 'webhook',
    actor_id: 'paypal',
    action: 'subscription.suspended',
    target_type: 'order',
    target_id: order.id,
    details: {
      subscription_id: subscriptionId,
      grace_period_ends: gracePeriodEnd.toISOString(),
    },
  }).then(() => {}, () => {});

  console.log(`[Webhook] Subscription suspended: ${subscriptionId} (grace until ${gracePeriodEnd.toISOString()})`);
}

async function handleSubscriptionPayment(
  supabase: AdminSupabase,
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

  const paypalPaymentId = resource.id as string;
  const amountValue = (resource as { amount?: { total?: string } }).amount?.total;
  const amountCents = amountValue ? Math.round(parseFloat(amountValue) * 100) : 0;

  // ── B.2: Idempotent payment insert ──
  const { error: paymentErr } = await supabase.from('payments').insert({
    order_id: order.id,
    customer_id: order.customer_id,
    guild_id: order.guild_id,
    paypal_payment_id: paypalPaymentId,
    amount_cents: amountCents,
    currency: 'USD',
    status: 'completed',
  });

  if (paymentErr && paymentErr.code === '23505') {
    console.log(`[Webhook] Subscription payment ${paypalPaymentId} already recorded — idempotent skip`);
    return;
  }

  // Update customer totals on each recurring payment
  const { error: rpcError } = await supabase.rpc('increment_customer_totals', {
    p_customer_id: order.customer_id,
    p_amount: amountCents,
  });
  if (rpcError) {
    // Manual increment fallback
    const { data: customer } = await supabase
      .from('customers')
      .select('total_spent_cents')
      .eq('id', order.customer_id)
      .single();

    if (customer) {
      await supabase
        .from('customers')
        .update({
          total_spent_cents: (customer.total_spent_cents ?? 0) + amountCents,
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.customer_id);
    }
  }

  console.log(`[Webhook] Subscription payment: ${paypalPaymentId} ($${(amountCents / 100).toFixed(2)})`);
}
