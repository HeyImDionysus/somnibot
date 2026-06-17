/**
 * PayPal Webhook Event Handlers.
 *
 * V5 Audit §2.P3a: Extracted from the monolithic route.ts for maintainability.
 * Each handler deals with one PayPal event type (or a small group).
 */

import { createAdminSupabase } from '@/lib/supabase/admin';
import { getPayPalRuntimeConfig, getPayPalToken, getSubscriptionAmount } from '@/lib/paypal';
import {
  paypalCaptureResourceSchema,
  paypalSaleResourceSchema,
  type PayPalCaptureResource,
  type PayPalSaleResource,
} from '@/lib/types/paypal';
import { generateLicenseKey, queueFulfillment } from './fulfillment';

function formatSupabaseError(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return String(error);
}

function requireSupabaseSuccess(error: unknown, operation: string) {
  if (error) {
    throw new Error(`${operation}: ${formatSupabaseError(error)}`);
  }
}

// ── Order Approved ──────────────────────────────────

export async function handleOrderApproved(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const paypalOrderId = resource.id as string;
  if (!paypalOrderId) return;

  const paypalConfig = await getPayPalRuntimeConfig();
  const token = await getPayPalToken(paypalConfig);
  if (!token) {
    throw new Error('Could not get PayPal token to capture order');
  }

  const captureRes = await fetch(
    `${paypalConfig.apiBase}/v2/checkout/orders/${paypalOrderId}/capture`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!captureRes.ok) {
    const errorText = await captureRes.text();
    throw new Error(`Failed to capture PayPal order: ${errorText}`);
  }

  console.log(`[Webhook] Captured PayPal order: ${paypalOrderId}`);
}

// ── Payment Captured ────────────────────────────────

export async function handlePaymentCaptured(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const parsed = paypalCaptureResourceSchema.safeParse(resource);
  const capture: PayPalCaptureResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };

  const customId = capture.custom_id;
  let meta: {
    guild_id: string;
    product_id: string;
    customer_id: string;
    discord_id: string;
  } | null = null;

  if (customId) {
    try {
      const raw = JSON.parse(customId);
      if (raw.g && raw.p && raw.c && raw.d) {
        meta = {
          guild_id: raw.g,
          product_id: raw.p,
          customer_id: raw.c,
          discord_id: raw.d,
        };
      } else {
        meta = raw;
      }
    } catch {
      /* ignore */
    }
  }

  if (!meta) {
    const captureId = resource.id as string | undefined;
    console.error(
      `[Webhook] Payment captured but custom_id is missing or malformed — ` +
        `captureId=${captureId ?? 'unknown'}, raw custom_id=${JSON.stringify(customId)}. ` +
        `Customer was charged but no order/entitlement was created. Manual reconciliation required.`,
    );
    throw new Error(
      `Payment captured without valid custom_id metadata (capture ${captureId})`,
    );
  }

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
  const amountValue = capture.amount?.value;
  const amountCents = amountValue
    ? Math.round(parseFloat(amountValue) * 100)
    : order.amount_cents;

  let amountMismatch = false;
  if (amountValue && order.amount_cents > 0) {
    const expectedCents = order.amount_cents;
    if (amountCents !== expectedCents) {
      amountMismatch = true;
      console.error(
        `[Webhook] AMOUNT MISMATCH: PayPal captured ${amountCents} cents but order ${order.id} ` +
          `expected ${expectedCents} cents. Customer ${meta.customer_id}, product ${meta.product_id}. ` +
          `Order flagged as pending_review — manual intervention required.`,
      );
    }
  }

  const orderStatus = amountMismatch ? 'pending_review' : 'completed';
  await supabase
    .from('orders')
    .update({ status: orderStatus, updated_at: new Date().toISOString() })
    .eq('id', order.id);

  await supabase.from('payments').insert({
    order_id: order.id,
    customer_id: meta.customer_id,
    guild_id: meta.guild_id,
    paypal_payment_id: paypalCaptureId,
    amount_cents: amountCents,
    currency: order.currency,
    status: amountMismatch ? 'pending_review' : 'completed',
  });

  if (amountMismatch) {
    console.warn(
      `[Webhook] Skipping auto-fulfillment for order ${order.order_number} due to amount mismatch. ` +
        `Resolve via dashboard → Orders → pending_review.`,
    );
    return;
  }

  const { error: rpcError } = await supabase.rpc('increment_customer_totals', {
    p_customer_id: meta.customer_id,
    p_amount: amountCents,
  });
  if (rpcError) {
    console.warn(
      '[Webhook] increment_customer_totals RPC failed, retrying once:',
      rpcError.message,
    );
    const { error: retryError } = await supabase.rpc(
      'increment_customer_totals',
      {
        p_customer_id: meta.customer_id,
        p_amount: amountCents,
      },
    );
    if (retryError) {
      console.error(
        '[Webhook] increment_customer_totals failed after retry:',
        retryError.message,
        '— customer totals may be stale until next reconciliation run',
      );
    }
  }

  const { data: product } = await supabase
    .from('products')
    .select('*')
    .eq('id', meta.product_id)
    .single();

  if (!product) {
    throw new Error(`Product ${meta.product_id} not found`);
  }

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

  console.log(
    `[Webhook] Order completed + fulfillment queued: ${order.order_number} for ${meta.discord_id}`,
  );
}

// ── Subscription Activated ──────────────────────────

export async function handleSubscriptionActivated(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const parsed = paypalCaptureResourceSchema.safeParse(resource);
  const capture: PayPalCaptureResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };
  const customId = capture.custom_id;
  if (!customId) return;

  let meta: {
    guild_id: string;
    product_id: string;
    plan_id: string;
    customer_id: string;
    discord_id: string;
  };
  try {
    const raw = JSON.parse(customId);
    if (raw.g && raw.p && raw.c && raw.d) {
      meta = {
        guild_id: raw.g,
        product_id: raw.p,
        plan_id: raw.pl ?? raw.plan_id ?? '',
        customer_id: raw.c,
        discord_id: raw.d,
      };
    } else {
      meta = raw;
    }
  } catch {
    console.error(
      '[Webhook] Malformed custom_id in subscription event:',
      customId,
    );
    return;
  }

  const subscriptionId = resource.id as string;

  // V5-Audit §2.1: Fetch the actual billing amount from PayPal instead of
  // recording 0. Falls back to 0 if the lookup fails — the amount will be
  // corrected when PAYMENT.SALE.COMPLETED fires.
  const subAmount = await getSubscriptionAmount(subscriptionId);
  const amountCents = subAmount?.amountCents ?? 0;
  const currency = subAmount?.currency ?? 'USD';

  const { data: order } = await supabase
    .from('orders')
    .insert({
      order_number: `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
      customer_id: meta.customer_id,
      guild_id: meta.guild_id,
      product_id: meta.product_id,
      plan_id: meta.plan_id,
      paypal_subscription_id: subscriptionId,
      amount_cents: amountCents,
      currency,
      status: 'completed',
      source: 'purchase',
    })
    .select('id, order_number')
    .single();

  if (!order) return;

  const { data: product } = await supabase
    .from('products')
    .select('name, granted_role_ids, granted_channel_ids')
    .eq('id', meta.product_id)
    .single();

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
    amount_cents: amountCents,
    currency,
    granted_role_ids: product?.granted_role_ids ?? [],
    granted_channel_ids: product?.granted_channel_ids ?? [],
    entitlement_type: 'subscription',
  });

  console.log(
    `[Webhook] Subscription activated + fulfillment queued: ${subscriptionId} for ${meta.discord_id}`,
  );
}

// ── Subscription Cancelled ──────────────────────────

export async function handleSubscriptionCancelled(
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

  console.log(
    `[Webhook] Subscription cancelled + fulfillment queued: ${subscriptionId}`,
  );
}

// ── Subscription Expired ────────────────────────────

export async function handleSubscriptionExpired(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: { retryingFailedEvent?: boolean } = {},
) {
  const subscriptionId = resource.id as string;
  if (!subscriptionId) return;

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, order_number, guild_id, customer_id, product_id, plan_id')
    .eq('paypal_subscription_id', subscriptionId)
    .maybeSingle();

  requireSupabaseSuccess(orderError, 'Failed to load expired subscription order');
  if (!order) return;

  const now = new Date().toISOString();
  const entitlementLookupStatuses = options.retryingFailedEvent
    ? ['active', 'pending', 'grace_period', 'expired']
    : ['active', 'pending', 'grace_period'];
  const licenseKeyLookupStatuses = options.retryingFailedEvent
    ? ['pending_activation', 'active', 'suspended', 'expired']
    : ['pending_activation', 'active', 'suspended'];

  const { data: activeEntitlements, error: activeEntitlementsError } = await supabase
    .from('entitlements')
    .select('id, customer_id, granted_role_ids, license_key_id')
    .eq('order_id', order.id)
    .eq('guild_id', order.guild_id)
    .eq('product_id', order.product_id)
    .in('status', entitlementLookupStatuses)
    .limit(1000);
  requireSupabaseSuccess(
    activeEntitlementsError,
    'Failed to load active entitlements for subscription expiry',
  );

  const { data: activeLicenseKeys, error: activeLicenseKeysError } = await supabase
    .from('license_keys')
    .select('id')
    .eq('order_id', order.id)
    .eq('guild_id', order.guild_id)
    .eq('product_id', order.product_id)
    .in('status', licenseKeyLookupStatuses)
    .limit(1000);
  requireSupabaseSuccess(
    activeLicenseKeysError,
    'Failed to load active license keys for subscription expiry',
  );

  const licenseKeyIds = [
    ...new Set([
      ...(activeEntitlements ?? [])
        .map((ent) => ent.license_key_id)
        .filter((id): id is string => Boolean(id)),
      ...(activeLicenseKeys ?? [])
        .map((key) => key.id)
        .filter((id): id is string => Boolean(id)),
    ]),
  ];

  const expiredRoleIds = [
    ...new Set(
      (activeEntitlements ?? []).flatMap((ent) => ent.granted_role_ids ?? []),
    ),
  ];

  let remainingEntitlements: Array<{ granted_role_ids?: string[] | null }> = [];
  if (expiredRoleIds.length > 0) {
    const { data, error } = await supabase
      .from('entitlements')
      .select('granted_role_ids')
      .eq('customer_id', order.customer_id)
      .eq('guild_id', order.guild_id)
      .neq('order_id', order.id)
      .in('status', ['active', 'pending', 'grace_period'])
      .limit(1000);
    requireSupabaseSuccess(
      error,
      'Failed to load role-preserving entitlements for subscription expiry',
    );
    remainingEntitlements = data ?? [];
  }

  const preservedRoleIds = new Set(
    (remainingEntitlements ?? []).flatMap((ent) => ent.granted_role_ids ?? []),
  );
  const roleIds = expiredRoleIds.filter((roleId) => !preservedRoleIds.has(roleId));

  const { error: expireEntitlementsError } = await supabase
    .from('entitlements')
    .update({
      status: 'expired',
      expires_at: now,
      grace_period_ends_at: null,
      updated_at: now,
    })
    .eq('order_id', order.id)
    .eq('guild_id', order.guild_id)
    .eq('product_id', order.product_id)
    .in('status', ['active', 'pending', 'grace_period']);
  requireSupabaseSuccess(
    expireEntitlementsError,
    'Failed to expire entitlements for subscription expiry',
  );

  const { error: expireLicenseKeysError } = await supabase
    .from('license_keys')
    .update({
      status: 'expired',
      expires_at: now,
      updated_at: now,
    })
    .eq('order_id', order.id)
    .eq('guild_id', order.guild_id)
    .eq('product_id', order.product_id)
    .in('status', ['pending_activation', 'active', 'suspended']);
  requireSupabaseSuccess(
    expireLicenseKeysError,
    'Failed to expire license keys for subscription expiry',
  );

  if (licenseKeyIds.length > 0) {
    const { error: deactivateSessionsError } = await supabase
      .from('license_sessions')
      .update({
        active: false,
        deactivated_at: now,
        deactivation_reason: 'entitlement_revoked',
      })
      .in('license_key_id', licenseKeyIds)
      .eq('active', true);
    requireSupabaseSuccess(
      deactivateSessionsError,
      'Failed to deactivate license sessions for subscription expiry',
    );
  }

  const hadActiveAccess =
    (activeEntitlements?.length ?? 0) > 0 || licenseKeyIds.length > 0;

  if (hadActiveAccess) {
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('discord_id')
      .eq('id', order.customer_id)
      .eq('guild_id', order.guild_id)
      .maybeSingle();
    requireSupabaseSuccess(
      customerError,
      'Failed to load customer for subscription expiry fulfillment',
    );

    if (customer?.discord_id) {
      if (roleIds.length > 0) {
        const queued = await queueFulfillment(supabase, 'revoke_roles', order.guild_id, {
          discord_id: customer.discord_id,
          role_ids: roleIds,
          reason: 'subscription_expired',
          order_id: order.id,
          product_id: order.product_id,
        });
        if (!queued) {
          throw new Error('Failed to queue role revocation for subscription expiry');
        }
      }

      const queued = await queueFulfillment(supabase, 'emit_audit_event', order.guild_id, {
        event_type: 'subscription.lapsed',
        event_data: {
          discordId: customer.discord_id,
          productId: order.product_id,
          planId: order.plan_id ?? '',
          status: 'lapsed',
        },
      });
      if (!queued) {
        throw new Error('Failed to queue subscription lapsed audit event');
      }
    }
  }

  await supabase
    .from('audit_logs')
    .insert({
      guild_id: order.guild_id,
      actor_type: 'system',
      actor_id: 'paypal_webhook',
      action: 'subscription.expired',
      target_type: 'order',
      target_id: order.id,
      details: {
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        paypal_subscription_id: subscriptionId,
        product_id: order.product_id,
        entitlement_ids: (activeEntitlements ?? []).map((ent) => ent.id),
        license_key_ids: licenseKeyIds,
        role_ids: roleIds,
      },
    })
    .then(
      () => {},
      () => {
        /* ignore */
      },
    );

  console.log(
    `[Webhook] Subscription expired + product access expired: ${subscriptionId}`,
  );
}

// ── Subscription Suspended ──────────────────────────

export async function handleSubscriptionSuspended(
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

  console.log(
    `[Webhook] Subscription suspended + fulfillment queued: ${subscriptionId}`,
  );
}

// ── Subscription Payment ────────────────────────────

export async function handleSubscriptionPayment(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
) {
  const parsed = paypalSaleResourceSchema.safeParse(resource);
  const sale: PayPalSaleResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };

  const billingAgreementId = sale.billing_agreement_id;
  if (!billingAgreementId) return;

  const { data: order } = await supabase
    .from('orders')
    .select('id, customer_id, guild_id')
    .eq('paypal_subscription_id', billingAgreementId)
    .single();

  if (!order) return;

  const amountValue = sale.amount?.total;
  const amountCents = amountValue
    ? Math.round(parseFloat(amountValue) * 100)
    : 0;

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

// ── Capture Refunded / Reversed ─────────────────────

export async function handleCaptureRefunded(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  eventType: string,
) {
  const parsed = paypalCaptureResourceSchema.safeParse(resource);
  const capture: PayPalCaptureResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };

  let captureId: string | undefined;

  const supp = capture.supplementary_data;
  if (supp?.related_ids?.capture_id) {
    captureId = supp.related_ids.capture_id;
  }

  if (!captureId) {
    const links = capture.links ?? [];
    const up = links.find((l) => l.rel === 'up');
    if (up?.href) {
      const m = up.href.match(/\/captures\/([^/?#]+)/);
      if (m?.[1]) captureId = m[1];
    }
  }

  if (!captureId) {
    console.error(
      `[Webhook] ${eventType} arrived without a recoverable capture_id — payload:`,
      JSON.stringify(resource).slice(0, 500),
    );
    return;
  }

  await handleExternalPaymentRefunded(supabase, captureId, eventType, 'capture_id');
}

// ── Subscription Sale Refunded / Reversed ───────────

export async function handleSaleRefunded(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  eventType: string,
) {
  const parsed = paypalSaleResourceSchema.safeParse(resource);
  const sale: PayPalSaleResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };

  let saleId = sale.sale_id ?? sale.capture_id;

  if (!saleId) {
    const links = sale.links ?? [];
    const saleLink = links.find((l) => /\/sales?\//.test(l.href ?? ''));
    if (saleLink?.href) {
      const m = saleLink.href.match(/\/sales?\/([^/?#]+)/);
      if (m?.[1]) saleId = m[1];
    }
  }

  if (!saleId && eventType === 'PAYMENT.SALE.REVERSED') {
    saleId = sale.id;
  }

  if (!saleId) {
    console.error(
      `[Webhook] ${eventType} arrived without a recoverable sale_id — payload:`,
      JSON.stringify(resource).slice(0, 500),
    );
    return;
  }

  await handleExternalPaymentRefunded(supabase, saleId, eventType, 'sale_id');
}

async function handleExternalPaymentRefunded(
  supabase: ReturnType<typeof createAdminSupabase>,
  paymentId: string,
  eventType: string,
  identifierField: 'capture_id' | 'sale_id',
) {
  const { data: payment } = await supabase
    .from('payments')
    .select('id, order_id, customer_id, guild_id, status')
    .eq('paypal_payment_id', paymentId)
    .maybeSingle();

  const identifierName = identifierField === 'capture_id' ? 'capture' : 'sale';

  if (!payment?.order_id) {
    console.warn(
      `[Webhook] ${eventType} for ${identifierName} ${paymentId} — no matching payment row, ignoring`,
    );
    return;
  }

  // V5 Audit §2.P3b: Skip if payment was already refunded/reversed to prevent
  // duplicate processing noise and redundant role-revocation queue entries.
  if (payment.status === 'refunded' || payment.status === 'reversed') {
    console.info(
      `[Webhook] ${eventType} for ${identifierName} ${paymentId} — payment already ${payment.status}, skipping`,
    );
    return;
  }

  const orderId = payment.order_id;
  const refundStatus = eventType.endsWith('.REVERSED') ? 'reversed' : 'refunded';

  const { data: activeEntitlements } = await supabase
    .from('entitlements')
    .select('id, customer_id, granted_role_ids')
    .eq('order_id', orderId)
    .in('status', ['active', 'pending', 'grace_period'])
    .limit(1000);

  await supabase
    .from('payments')
    .update({ status: refundStatus })
    .eq('id', payment.id);

  await supabase
    .from('orders')
    .update({ status: 'refunded', updated_at: new Date().toISOString() })
    .eq('id', orderId);

  await supabase
    .from('entitlements')
    .update({
      status: 'expired',
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', orderId)
    .in('status', ['active', 'pending', 'grace_period']);

  await supabase
    .from('license_keys')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revocation_reason: refundStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', orderId)
    .neq('status', 'revoked');

  if (activeEntitlements?.length) {
    const allRoleIds = [
      ...new Set(activeEntitlements.flatMap((e) => e.granted_role_ids ?? [])),
    ];
    if (allRoleIds.length > 0) {
      const { data: customer } = await supabase
        .from('customers')
        .select('discord_id')
        .eq('id', activeEntitlements[0]!.customer_id)
        .single();

      if (customer?.discord_id) {
        await queueFulfillment(supabase, 'revoke_roles', payment.guild_id, {
          discord_id: customer.discord_id,
          role_ids: allRoleIds,
          reason: refundStatus,
          order_id: orderId,
        });
      }
    }
  }

  await supabase
    .from('audit_logs')
    .insert({
      guild_id: payment.guild_id,
      actor_type: 'system',
      actor_id: 'paypal_webhook',
      action:
        eventType.endsWith('.REVERSED')
          ? 'order.reversed'
          : 'order.refunded_external',
      target_type: 'order',
      target_id: orderId,
      details: { event_type: eventType, [identifierField]: paymentId },
    })
    .then(
      () => {},
      () => {
        /* ignore */
      },
    );

  console.log(
    `[Webhook] ${eventType} processed for order ${orderId} (${identifierName} ${paymentId})`,
  );
}
