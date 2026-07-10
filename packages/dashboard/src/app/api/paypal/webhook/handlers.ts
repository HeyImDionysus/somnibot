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

const EXPIRABLE_ENTITLEMENT_STATUSES = ['active', 'pending', 'grace_period', 'suspended'];
const EXPIRY_RETRY_ENTITLEMENT_STATUSES = [
  ...EXPIRABLE_ENTITLEMENT_STATUSES,
  'expired',
];

function completedRevokeHadFailedRoles(result: unknown): boolean {
  if (!result || typeof result !== 'object' || !('failed' in result)) {
    return false;
  }
  const failed = (result as { failed?: unknown }).failed;
  return Array.isArray(failed) && failed.length > 0;
}

async function hasQueuedRoleRevocation(
  supabase: ReturnType<typeof createAdminSupabase>,
  input: {
    guildId: string;
    discordId: string;
    orderId: string;
    reason: string;
    productId?: string;
  },
): Promise<boolean> {
  const payloadFilter: Record<string, string> = {
    discord_id: input.discordId,
    order_id: input.orderId,
    reason: input.reason,
  };
  if (input.productId) {
    payloadFilter.product_id = input.productId;
  }

  const { data, error } = await supabase
    .from('bot_action_queue')
    .select('id, status, result')
    .eq('guild_id', input.guildId)
    .eq('action', 'revoke_roles')
    .in('status', ['pending', 'processing', 'completed'])
    .contains('payload', payloadFilter)
    .limit(1000);
  requireSupabaseSuccess(
    error,
    'Failed to inspect queued role revocation',
  );
  if (!Array.isArray(data)) return false;
  return data.some((row) => {
    if (!row || typeof row !== 'object') return false;
    const status = (row as { status?: unknown }).status;
    if (status !== 'completed') return true;
    return !completedRevokeHadFailedRoles((row as { result?: unknown }).result);
  });
}

/**
 * W2 codex round 2: retry-dedupe probe for cancellation/suspension
 * fulfillments. A failed BILLING.SUBSCRIPTION.CANCELLED / .SUSPENDED /
 * .PAYMENT.FAILED event is resumable (RESUMABLE_FAILED_EVENT_TYPES), and the
 * failed attempt may already have queued the fulfillment (insert committed
 * but the response was lost, or the process died before recording success).
 * The bot-side entitlement effects are idempotent, but the user DM / event
 * emission are not — so a resumed retry must not queue a second action.
 * The probe is scoped by the triggering webhook event id (stamped into the
 * payload) so a fulfillment queued by an EARLIER suspension episode of the
 * same order never suppresses a genuinely new one.
 */
async function hasQueuedOrderFulfillment(
  supabase: ReturnType<typeof createAdminSupabase>,
  input: {
    guildId: string;
    action: string;
    orderId: string;
    fulfillmentType: string;
    webhookEventId?: string;
  },
): Promise<boolean> {
  const payloadFilter: Record<string, string> = {
    order_id: input.orderId,
    fulfillment_type: input.fulfillmentType,
  };
  if (input.webhookEventId) {
    payloadFilter.webhook_event_id = input.webhookEventId;
  }

  const { data, error } = await supabase
    .from('bot_action_queue')
    .select('id')
    .eq('guild_id', input.guildId)
    .eq('action', input.action)
    .in('status', ['pending', 'processing', 'completed'])
    .contains('payload', payloadFilter)
    .limit(1000);
  requireSupabaseSuccess(error, `Failed to inspect queued ${input.action}`);
  return Array.isArray(data) && data.length > 0;
}

async function hasQueuedSubscriptionExpiredAuditEvent(
  supabase: ReturnType<typeof createAdminSupabase>,
  input: {
    guildId: string;
    discordId: string;
    orderId: string;
    productId: string;
  },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('bot_action_queue')
    .select('id')
    .eq('guild_id', input.guildId)
    .eq('action', 'emit_audit_event')
    .in('status', ['pending', 'processing', 'completed'])
    .contains('payload', {
      event_type: 'subscription.expired',
      event_data: {
        discordId: input.discordId,
        orderId: input.orderId,
        productId: input.productId,
      },
    })
    .limit(1000);
  requireSupabaseSuccess(
    error,
    'Failed to inspect queued subscription expired audit event',
  );
  return Array.isArray(data) && data.length > 0;
}

function resolveCaptureRefundPaymentId(resource: Record<string, unknown>): string | null {
  const parsed = paypalCaptureResourceSchema.safeParse(resource);
  const capture: PayPalCaptureResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };

  const supp = capture.supplementary_data;
  if (supp?.related_ids?.capture_id) {
    return supp.related_ids.capture_id;
  }

  const links = capture.links ?? [];
  const up = links.find((l) => l.rel === 'up');
  if (up?.href) {
    const m = up.href.match(/\/captures\/([^/?#]+)/);
    if (m?.[1]) return m[1];
  }

  return null;
}

function resolveSaleRefundPaymentId(
  resource: Record<string, unknown>,
  eventType: string,
): string | null {
  const parsed = paypalSaleResourceSchema.safeParse(resource);
  const sale: PayPalSaleResource = parsed.success
    ? parsed.data
    : { id: String(resource.id ?? '') };

  if (sale.sale_id) return sale.sale_id;
  if (sale.capture_id) return sale.capture_id;

  const links = sale.links ?? [];
  const saleLink = links.find((l) => /\/sales?\//.test(l.href ?? ''));
  if (saleLink?.href) {
    const m = saleLink.href.match(/\/sales?\/([^/?#]+)/);
    if (m?.[1]) return m[1];
  }

  if (eventType === 'PAYMENT.SALE.REVERSED' && sale.id) {
    return sale.id;
  }

  return null;
}

export function resolveRefundPaymentId(
  resource: Record<string, unknown>,
  eventType: string,
): string | null {
  if (eventType === 'PAYMENT.CAPTURE.REFUNDED' || eventType === 'PAYMENT.CAPTURE.REVERSED') {
    return resolveCaptureRefundPaymentId(resource);
  }

  if (eventType === 'PAYMENT.SALE.REFUNDED' || eventType === 'PAYMENT.SALE.REVERSED') {
    return resolveSaleRefundPaymentId(resource, eventType);
  }

  return null;
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

export interface SubscriptionQueueOptions {
  retryingFailedEvent?: boolean;
  /** Webhook event id — stamped into the fulfillment payload for retry dedupe. */
  webhookEventId?: string;
}

export async function handleSubscriptionCancelled(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  options: SubscriptionQueueOptions = {},
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

  // W2 codex round 2: on a resumed retry the failed attempt may already have
  // queued this fulfillment — don't queue a duplicate (double DM / event).
  if (options.retryingFailedEvent) {
    const alreadyQueued = await hasQueuedOrderFulfillment(supabase, {
      guildId: order.guild_id,
      action: 'fulfill_cancellation',
      orderId: order.id,
      fulfillmentType: 'subscription_cancelled',
      webhookEventId: options.webhookEventId,
    });
    if (alreadyQueued) {
      console.info(
        `[Webhook] Subscription cancellation fulfillment already queued for ${subscriptionId}, skipping duplicate`,
      );
      return;
    }
  }

  const queued = await queueFulfillment(supabase, 'fulfill_cancellation', order.guild_id, {
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
    ...(options.webhookEventId ? { webhook_event_id: options.webhookEventId } : {}),
  });
  // W2: a failed queue insert used to be logged and swallowed — the
  // cancellation (and the bot-side entitlement revocation it drives) was
  // silently lost. Throw so the webhook records an error and PayPal's
  // redelivery re-processes it (BILLING.SUBSCRIPTION.CANCELLED is in
  // RESUMABLE_FAILED_EVENT_TYPES); the bot-side revoke is a no-op for
  // already-revoked entitlements, so a retry cannot double-revoke.
  if (!queued) {
    throw new Error('Failed to queue subscription cancellation fulfillment');
  }

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

  const { data: orders, error: orderError } = await supabase
    .from('orders')
    .select('id, order_number, guild_id, customer_id, product_id, plan_id, status, created_at')
    .eq('paypal_subscription_id', subscriptionId)
    .order('created_at', { ascending: false })
    .limit(100);

  requireSupabaseSuccess(orderError, 'Failed to load expired subscription order');
  const orderRows = Array.isArray(orders) ? orders : orders ? [orders] : [];
  const order = orderRows.find((row) => row.status === 'completed') ?? orderRows[0];
  if (!order) return;

  const now = new Date().toISOString();
  const entitlementLookupStatuses = options.retryingFailedEvent
    ? EXPIRY_RETRY_ENTITLEMENT_STATUSES
    : EXPIRABLE_ENTITLEMENT_STATUSES;
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
    .in('status', EXPIRABLE_ENTITLEMENT_STATUSES);
  requireSupabaseSuccess(
    expireEntitlementsError,
    'Failed to expire entitlements for subscription expiry',
  );

  // W2 codex round 2: EXPIRABLE_ENTITLEMENT_STATUSES includes 'grace_period',
  // so this expiry is a terminal transition for a row that suspend() may have
  // left an 'entitlement_grace_period' operator alert open on. revoke() and
  // the reconciliation sweep resolve that alert on their terminal writes; this
  // direct webhook expiry bypassed both. Resolve it with the same
  // entitlement-scoped, entitlement_grace_period filter (no-op when none open).
  // Non-fatal: the entitlement expiry above has already committed.
  const expiryGraceAlertEntitlementIds = (activeEntitlements ?? []).map((ent) => ent.id);
  if (expiryGraceAlertEntitlementIds.length > 0) {
    const { error: expireGraceAlertError } = await supabase
      .from('alerts')
      .update({ resolved: true, resolved_at: now, updated_at: now })
      .eq('guild_id', order.guild_id)
      .eq('alert_type', 'entitlement_grace_period')
      .in('metadata->>entitlement_id', expiryGraceAlertEntitlementIds)
      .eq('resolved', false);
    if (expireGraceAlertError) {
      console.error(
        '[Webhook] Failed to resolve grace-period alerts for subscription expiry:',
        formatSupabaseError(expireGraceAlertError),
      );
    }
  }

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
      let shouldQueueRoleRevocation = roleIds.length > 0;
      if (shouldQueueRoleRevocation && options.retryingFailedEvent) {
        shouldQueueRoleRevocation = !(await hasQueuedRoleRevocation(
          supabase,
          {
            guildId: order.guild_id,
            discordId: customer.discord_id,
            orderId: order.id,
            productId: order.product_id,
            reason: 'subscription_expired',
          },
        ));
      }

      if (shouldQueueRoleRevocation) {
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

      let shouldQueueAuditEvent = true;
      if (options.retryingFailedEvent) {
        shouldQueueAuditEvent = !(await hasQueuedSubscriptionExpiredAuditEvent(
          supabase,
          {
            guildId: order.guild_id,
            discordId: customer.discord_id,
            orderId: order.id,
            productId: order.product_id,
          },
        ));
      }

      if (shouldQueueAuditEvent) {
        const queued = await queueFulfillment(supabase, 'emit_audit_event', order.guild_id, {
          event_type: 'subscription.expired',
          event_data: {
            discordId: customer.discord_id,
            orderId: order.id,
            productId: order.product_id,
            planId: order.plan_id ?? '',
            status: 'expired',
          },
        });
        if (!queued) {
          throw new Error('Failed to queue subscription expired audit event');
        }
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
  options: SubscriptionQueueOptions = {},
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

  // W2 codex round 2: same retry dedupe as handleSubscriptionCancelled.
  if (options.retryingFailedEvent) {
    const alreadyQueued = await hasQueuedOrderFulfillment(supabase, {
      guildId: order.guild_id,
      action: 'fulfill_suspension',
      orderId: order.id,
      fulfillmentType: 'subscription_suspended',
      webhookEventId: options.webhookEventId,
    });
    if (alreadyQueued) {
      console.info(
        `[Webhook] Subscription suspension fulfillment already queued for ${subscriptionId}, skipping duplicate`,
      );
      return;
    }
  }

  const queued = await queueFulfillment(supabase, 'fulfill_suspension', order.guild_id, {
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
    ...(options.webhookEventId ? { webhook_event_id: options.webhookEventId } : {}),
  });
  // W2: same reasoning as handleSubscriptionCancelled — losing this insert
  // silently means the entitlement never enters its grace period. The
  // bot-side suspend targets 'active' entitlements only, so retries are safe
  // (BILLING.SUBSCRIPTION.SUSPENDED / .PAYMENT.FAILED are in
  // RESUMABLE_FAILED_EVENT_TYPES).
  if (!queued) {
    throw new Error('Failed to queue subscription suspension fulfillment');
  }

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
    // W2 codex round 2: persist the sale's actual currency instead of a
    // hardcoded 'USD' — the refund currency-mismatch guard compares against
    // this value, and a wrong label turned legitimate partial refunds on
    // non-USD plans into full revocations.
    currency: sale.amount?.currency ?? 'USD',
    status: 'completed',
  });

  console.log(`[Webhook] Subscription payment recorded: ${resource.id}`);
}

// ── Capture Refunded / Reversed ─────────────────────

export interface RefundHandlerOptions {
  retryingFailedEvent?: boolean;
}

export async function handleCaptureRefunded(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  eventType: string,
  options: RefundHandlerOptions = {},
) {
  const captureId = resolveCaptureRefundPaymentId(resource);

  if (!captureId) {
    console.error(
      `[Webhook] ${eventType} arrived without a recoverable capture_id — payload:`,
      JSON.stringify(resource).slice(0, 500),
    );
    return;
  }

  await handleExternalPaymentRefunded(
    supabase,
    captureId,
    eventType,
    'capture_id',
    resource,
    options,
  );
}

// ── Subscription Sale Refunded / Reversed ───────────

export async function handleSaleRefunded(
  supabase: ReturnType<typeof createAdminSupabase>,
  resource: Record<string, unknown>,
  eventType: string,
  options: RefundHandlerOptions = {},
) {
  const saleId = resolveSaleRefundPaymentId(resource, eventType);

  if (!saleId) {
    console.error(
      `[Webhook] ${eventType} arrived without a recoverable sale_id — payload:`,
      JSON.stringify(resource).slice(0, 500),
    );
    return;
  }

  await handleExternalPaymentRefunded(
    supabase,
    saleId,
    eventType,
    'sale_id',
    resource,
    options,
  );
}

// ── Refund semantics (W2) ───────────────────────────

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === '23505',
  );
}

/**
 * Parse a PayPal money string ("10.00", or "-5.00" — v1 sale refund events
 * report the refund amount as a negative delta) into non-negative cents.
 */
function parseAmountToCents(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.abs(Math.round(parsed * 100));
}

interface RefundAmountInfo {
  /** Amount of THIS refund event, in cents (null = missing/unparseable). */
  refundAmountCents: number | null;
  refundCurrency: string | null;
  /** PayPal's cumulative refunded total for the parent capture/sale. */
  paypalTotalRefundedCents: number | null;
  /**
   * Currency of PayPal's cumulative refunded total. PayPal issues refunds in
   * the parent sale's currency, so this is the payload's own statement of the
   * sale's actual currency — used to tolerate legacy payments rows whose
   * currency label was persisted as a hardcoded 'USD'.
   */
  paypalTotalRefundedCurrency: string | null;
}

function resolveRefundAmounts(
  resource: Record<string, unknown>,
  eventType: string,
): RefundAmountInfo {
  if (eventType.startsWith('PAYMENT.CAPTURE.')) {
    const parsed = paypalCaptureResourceSchema.safeParse(resource);
    if (!parsed.success) {
      return {
        refundAmountCents: null,
        refundCurrency: null,
        paypalTotalRefundedCents: null,
        paypalTotalRefundedCurrency: null,
      };
    }
    return {
      refundAmountCents: parseAmountToCents(parsed.data.amount?.value),
      refundCurrency: parsed.data.amount?.currency_code ?? null,
      paypalTotalRefundedCents: parseAmountToCents(
        parsed.data.seller_payable_breakdown?.total_refunded_amount?.value,
      ),
      paypalTotalRefundedCurrency:
        parsed.data.seller_payable_breakdown?.total_refunded_amount?.currency_code ?? null,
    };
  }

  const parsed = paypalSaleResourceSchema.safeParse(resource);
  if (!parsed.success) {
    return {
      refundAmountCents: null,
      refundCurrency: null,
      paypalTotalRefundedCents: null,
      paypalTotalRefundedCurrency: null,
    };
  }
  return {
    refundAmountCents: parseAmountToCents(parsed.data.amount?.total),
    refundCurrency: parsed.data.amount?.currency ?? null,
    paypalTotalRefundedCents: parseAmountToCents(parsed.data.total_refunded_amount?.value),
    paypalTotalRefundedCurrency: parsed.data.total_refunded_amount?.currency ?? null,
  };
}

type FullRefundReason =
  | 'reversal'
  | 'unparseable_amount'
  | 'currency_mismatch'
  | 'no_payment_baseline'
  | 'cumulative_total';

type RefundScope = { kind: 'full'; reason: FullRefundReason } | { kind: 'partial' };

/**
 * Decide whether a refund event revokes access (full) or is flagged for
 * operator review (partial). Every ambiguous case resolves to FULL — the
 * merchant-safe default (money left, so access goes) that also matches the
 * pre-W2 behavior:
 *   - .REVERSED events are chargebacks/reversals — always full.
 *   - Unparseable/missing amounts can't be compared — full.
 *   - A refund in a different currency can't be compared — full, EXCEPT for
 *     legacy mislabeled subscription payments (see below).
 *   - A payment recorded with amount_cents <= 0 (e.g. a subscription sale
 *     whose amount lookup failed) has no baseline — full.
 * Otherwise the cumulative refunded total (max of PayPal's authoritative
 * total and the locally recorded payment_refunds sum) decides.
 *
 * Legacy tolerance (W2 codex round 2): handleSubscriptionPayment used to
 * persist a hardcoded 'USD' currency label while amount_cents was parsed
 * from the sale payload in the plan's actual currency — the recorded CENTS
 * are right, only the label is wrong. PayPal always issues refunds in the
 * parent sale's currency, so when a PAYMENT.SALE.* refund against a
 * USD-labeled payment carries a signature-verified payload whose cumulative
 * refunded total is in the refund's own currency, the payload — not our
 * label — is authoritative and the cents comparison remains valid. Capture
 * refunds keep the strict fail-safe: their payments rows were always
 * persisted with the checkout currency.
 */
function classifyRefundScope(input: {
  eventType: string;
  paymentAmountCents: number | null;
  paymentCurrency: string | null;
  refundAmountCents: number | null;
  refundCurrency: string | null;
  paypalTotalRefundedCurrency: string | null;
  cumulativeRefundedCents: number;
}): RefundScope {
  if (input.eventType.endsWith('.REVERSED')) {
    return { kind: 'full', reason: 'reversal' };
  }
  if (input.refundAmountCents == null) {
    return { kind: 'full', reason: 'unparseable_amount' };
  }
  if (
    input.refundCurrency &&
    input.paymentCurrency &&
    input.refundCurrency.toUpperCase() !== input.paymentCurrency.toUpperCase()
  ) {
    const legacyMislabeledSalePayment =
      input.eventType.startsWith('PAYMENT.SALE.') &&
      input.paymentCurrency.toUpperCase() === 'USD' &&
      input.paypalTotalRefundedCurrency != null &&
      input.paypalTotalRefundedCurrency.toUpperCase() === input.refundCurrency.toUpperCase();
    if (!legacyMislabeledSalePayment) {
      return { kind: 'full', reason: 'currency_mismatch' };
    }
  }
  if (typeof input.paymentAmountCents !== 'number' || input.paymentAmountCents <= 0) {
    return { kind: 'full', reason: 'no_payment_baseline' };
  }
  if (input.cumulativeRefundedCents >= input.paymentAmountCents) {
    return { kind: 'full', reason: 'cumulative_total' };
  }
  return { kind: 'partial' };
}

function formatCents(cents: number | null, currency: string | null): string {
  if (cents == null) return 'an unknown amount';
  return `${(cents / 100).toFixed(2)} ${currency ?? ''}`.trim();
}

/**
 * PAYMENT.CAPTURE.REFUNDED / .REVERSED and PAYMENT.SALE.REFUNDED / .REVERSED.
 *
 * W2 semantics:
 *  - FULL refund/reversal → revoke entitlements, license keys and their
 *    active license sessions, queue Discord role revocation, and write the
 *    audit trail. The payments.status flip to refunded/reversed happens LAST:
 *    it is the commit marker the replay guard keys off, so a crash mid-way
 *    leaves the event retryable instead of half-revoked-but-skipped.
 *  - PARTIAL refund → access is NOT auto-revoked. The refund is recorded,
 *    an operator-review alert is raised (deduped per refund id by a partial
 *    unique index), and the decision is written to audit_logs. (No per-product
 *    auto-revoke override exists in the schema today; review-first is the
 *    only behavior.)
 *  - Idempotency → each refund id is recorded in payment_refunds under a
 *    unique index; a replayed event tolerates the 23505 and skips its side
 *    effects unless it is resuming a previously failed attempt.
 *  - Ordering → a refund arriving before its capture/sale-completed event
 *    (no payments row yet) throws so the webhook is recorded as an error and
 *    PayPal's retry re-processes it once the payment exists (refund event
 *    types are in RESUMABLE_FAILED_EVENT_TYPES).
 */
async function handleExternalPaymentRefunded(
  supabase: ReturnType<typeof createAdminSupabase>,
  paymentId: string,
  eventType: string,
  identifierField: 'capture_id' | 'sale_id',
  resource: Record<string, unknown>,
  options: RefundHandlerOptions = {},
) {
  const identifierName = identifierField === 'capture_id' ? 'capture' : 'sale';

  const { data: payment, error: paymentError } = await supabase
    .from('payments')
    .select('id, order_id, customer_id, guild_id, status, amount_cents, currency')
    .eq('paypal_payment_id', paymentId)
    .maybeSingle();
  requireSupabaseSuccess(paymentError, 'Failed to load payment for refund');

  if (!payment?.order_id) {
    // Out-of-order webhook: the refund raced ahead of its
    // PAYMENT.CAPTURE.COMPLETED / PAYMENT.SALE.COMPLETED (or the payment was
    // never recorded). Silently ignoring this — the old behavior — left the
    // customer with full access after an external refund. Throw instead so
    // the event is recorded as an error and PayPal's retries re-process it
    // once the payment row exists.
    throw new Error(
      `${eventType} for ${identifierName} ${paymentId} has no matching payment row yet — ` +
        'deferring for webhook retry (out-of-order delivery or unknown payment)',
    );
  }

  // Idempotency guard: only set after every revocation effect has succeeded.
  if (payment.status === 'refunded' || payment.status === 'reversed') {
    console.info(
      `[Webhook] ${eventType} for ${identifierName} ${paymentId} — payment already ${payment.status}, skipping`,
    );
    return;
  }

  const orderId = payment.order_id;
  const refundStatus = eventType.endsWith('.REVERSED') ? 'reversed' : 'refunded';
  const amounts = resolveRefundAmounts(resource, eventType);
  const refundId =
    typeof resource.id === 'string' && resource.id.length > 0 ? resource.id : null;

  // Record this refund id — the unique index on payment_refunds
  // (paypal_refund_id) is the atomic dedupe across replays, resumed retries
  // and concurrent instances; a 23505 means "already recorded", not an error.
  let alreadyRecorded = false;
  if (refundId) {
    const { error: refundInsertError } = await supabase.from('payment_refunds').insert({
      payment_id: payment.id,
      order_id: orderId,
      guild_id: payment.guild_id,
      paypal_refund_id: refundId,
      event_type: eventType,
      amount_cents: amounts.refundAmountCents,
      currency: amounts.refundCurrency,
    });
    if (refundInsertError) {
      if (isUniqueViolation(refundInsertError)) {
        alreadyRecorded = true;
      } else {
        throw new Error(
          `Failed to record refund ${refundId}: ${formatSupabaseError(refundInsertError)}`,
        );
      }
    }
  }

  // Locally recorded cumulative total (includes this refund's row).
  const { data: recordedRefunds, error: recordedRefundsError } = await supabase
    .from('payment_refunds')
    .select('amount_cents')
    .eq('payment_id', payment.id)
    .limit(1000);
  requireSupabaseSuccess(recordedRefundsError, 'Failed to load recorded refunds for payment');
  const locallyRecordedCents = (recordedRefunds ?? []).reduce(
    (sum, row) =>
      sum + (typeof row?.amount_cents === 'number' ? row.amount_cents : 0),
    0,
  );
  // Two concurrent partial refunds can each miss the other's row locally;
  // PayPal's cumulative total (present on capture refunds and sale refunds)
  // is authoritative and closes that window on whichever event carries it.
  const cumulativeRefundedCents = Math.max(
    locallyRecordedCents,
    amounts.paypalTotalRefundedCents ?? 0,
    amounts.refundAmountCents ?? 0,
  );

  const scope = classifyRefundScope({
    eventType,
    paymentAmountCents: typeof payment.amount_cents === 'number' ? payment.amount_cents : null,
    paymentCurrency: typeof payment.currency === 'string' ? payment.currency : null,
    refundAmountCents: amounts.refundAmountCents,
    refundCurrency: amounts.refundCurrency,
    paypalTotalRefundedCurrency: amounts.paypalTotalRefundedCurrency,
    cumulativeRefundedCents,
  });

  if (scope.kind === 'partial') {
    // A replayed, already-recorded partial refund has nothing left to do —
    // unless this is the resumption of a previously FAILED attempt, where
    // the alert/audit writes may not have happened (both are idempotent:
    // the alert is deduped per refund id by a partial unique index).
    if (alreadyRecorded && !options.retryingFailedEvent) {
      console.info(
        `[Webhook] ${eventType} for ${identifierName} ${paymentId} — partial refund ${refundId} already processed, skipping`,
      );
      return;
    }

    const { error: alertError } = await supabase.from('alerts').insert({
      guild_id: payment.guild_id,
      alert_type: 'partial_refund_review',
      severity: 'warning',
      title: 'Partial PayPal refund — review required',
      message:
        `PayPal reported a partial refund of ${formatCents(amounts.refundAmountCents, amounts.refundCurrency)} ` +
        `against a payment of ${formatCents(payment.amount_cents, payment.currency)} (order ${orderId}). ` +
        'Access was NOT revoked automatically — review the order and revoke manually if warranted.',
      metadata: {
        source: 'paypal_webhook',
        event_type: eventType,
        paypal_refund_id: refundId,
        [identifierField]: paymentId,
        order_id: orderId,
        payment_id: payment.id,
        refund_amount_cents: amounts.refundAmountCents,
        payment_amount_cents: payment.amount_cents ?? null,
        cumulative_refunded_cents: cumulativeRefundedCents,
        currency: amounts.refundCurrency ?? payment.currency ?? null,
      },
    });
    if (alertError && !isUniqueViolation(alertError)) {
      throw new Error(
        `Failed to raise partial refund review alert: ${formatSupabaseError(alertError)}`,
      );
    }

    const { error: auditError } = await supabase.from('audit_logs').insert({
      guild_id: payment.guild_id,
      actor_type: 'system',
      actor_id: 'paypal_webhook',
      action: 'order.refund_partial',
      target_type: 'order',
      target_id: orderId,
      details: {
        event_type: eventType,
        [identifierField]: paymentId,
        paypal_refund_id: refundId,
        refund_scope: 'partial',
        refund_amount_cents: amounts.refundAmountCents,
        payment_amount_cents: payment.amount_cents ?? null,
        cumulative_refunded_cents: cumulativeRefundedCents,
        currency: amounts.refundCurrency ?? payment.currency ?? null,
        decision: 'access_retained_pending_review',
      },
    });
    requireSupabaseSuccess(auditError, 'Failed to write partial refund audit log');

    console.log(
      `[Webhook] ${eventType} processed for order ${orderId} (${identifierName} ${paymentId}) — ` +
        `partial refund (${cumulativeRefundedCents}/${payment.amount_cents} cents), access retained, operator review raised`,
    );
    return;
  }

  // ── FULL refund/reversal: revoke everything, marker last ──

  // On a resumed retry, entitlements may already be expired by the failed
  // attempt — include them so the role revocation is still computed/queued.
  const entitlementLookupStatuses = options.retryingFailedEvent
    ? EXPIRY_RETRY_ENTITLEMENT_STATUSES
    : EXPIRABLE_ENTITLEMENT_STATUSES;

  const { data: activeEntitlements, error: entitlementsError } = await supabase
    .from('entitlements')
    .select('id, customer_id, granted_role_ids, license_key_id')
    .eq('order_id', orderId)
    .in('status', entitlementLookupStatuses)
    .limit(1000);
  requireSupabaseSuccess(entitlementsError, 'Failed to load entitlements for refund revocation');

  // All of the order's license keys (any status) so already-revoked keys from
  // a crashed earlier attempt still get their sessions deactivated.
  const { data: orderLicenseKeys, error: orderLicenseKeysError } = await supabase
    .from('license_keys')
    .select('id')
    .eq('order_id', orderId)
    .limit(1000);
  requireSupabaseSuccess(orderLicenseKeysError, 'Failed to load license keys for refund revocation');

  const licenseKeyIds = [
    ...new Set([
      ...(activeEntitlements ?? [])
        .map((ent) => ent.license_key_id)
        .filter((id): id is string => Boolean(id)),
      ...(orderLicenseKeys ?? [])
        .map((key) => key.id)
        .filter((id): id is string => Boolean(id)),
    ]),
  ];

  const revokedRoleIds = [
    ...new Set(
      (activeEntitlements ?? []).flatMap((ent) => ent.granted_role_ids ?? []),
    ),
  ];
  const customerId: string | null =
    (typeof payment.customer_id === 'string' && payment.customer_id) ||
    activeEntitlements?.[0]?.customer_id ||
    null;

  // Preserve roles still granted by the customer's other live entitlements
  // (same rule as subscription expiry) — a refund of product A must not strip
  // a role the customer still pays for through product B.
  let roleIds = revokedRoleIds;
  if (revokedRoleIds.length > 0 && customerId) {
    const { data: remainingEntitlements, error: remainingError } = await supabase
      .from('entitlements')
      .select('granted_role_ids')
      .eq('customer_id', customerId)
      .eq('guild_id', payment.guild_id)
      .neq('order_id', orderId)
      .in('status', ['active', 'pending', 'grace_period'])
      .limit(1000);
    requireSupabaseSuccess(
      remainingError,
      'Failed to load role-preserving entitlements for refund',
    );
    const preservedRoleIds = new Set(
      (remainingEntitlements ?? []).flatMap((ent) => ent.granted_role_ids ?? []),
    );
    roleIds = revokedRoleIds.filter((roleId) => !preservedRoleIds.has(roleId));
  }

  const nowIso = new Date().toISOString();

  const { error: expireEntitlementsError } = await supabase
    .from('entitlements')
    .update({
      status: 'expired',
      cancelled_at: nowIso,
      updated_at: nowIso,
    })
    .eq('order_id', orderId)
    .in('status', EXPIRABLE_ENTITLEMENT_STATUSES);
  requireSupabaseSuccess(expireEntitlementsError, 'Failed to revoke entitlements for refund');

  // W2 codex round 2: EXPIRABLE_ENTITLEMENT_STATUSES includes 'grace_period',
  // so a full refund is a terminal transition for a row that suspend() may
  // have left an 'entitlement_grace_period' operator alert open on. revoke()
  // and the reconciliation sweep resolve that alert on their terminal writes;
  // this direct refund expiry bypassed both. Resolve it with the same
  // entitlement-scoped, entitlement_grace_period filter (a no-op when none is
  // open). Non-fatal: the entitlement revocation above has already committed.
  const graceAlertEntitlementIds = (activeEntitlements ?? []).map((ent) => ent.id);
  if (graceAlertEntitlementIds.length > 0) {
    const { error: refundGraceAlertError } = await supabase
      .from('alerts')
      .update({ resolved: true, resolved_at: nowIso, updated_at: nowIso })
      .eq('guild_id', payment.guild_id)
      .eq('alert_type', 'entitlement_grace_period')
      .in('metadata->>entitlement_id', graceAlertEntitlementIds)
      .eq('resolved', false);
    if (refundGraceAlertError) {
      console.error(
        '[Webhook] Failed to resolve grace-period alerts for refund revocation:',
        formatSupabaseError(refundGraceAlertError),
      );
    }
  }

  const { error: revokeKeysError } = await supabase
    .from('license_keys')
    .update({
      status: 'revoked',
      revoked_at: nowIso,
      revocation_reason: refundStatus,
      updated_at: nowIso,
    })
    .eq('order_id', orderId)
    .neq('status', 'revoked');
  requireSupabaseSuccess(revokeKeysError, 'Failed to revoke license keys for refund');

  if (licenseKeyIds.length > 0) {
    const { error: deactivateSessionsError } = await supabase
      .from('license_sessions')
      .update({
        active: false,
        deactivated_at: nowIso,
        deactivation_reason: 'entitlement_revoked',
      })
      .in('license_key_id', licenseKeyIds)
      .eq('active', true);
    requireSupabaseSuccess(
      deactivateSessionsError,
      'Failed to deactivate license sessions for refund',
    );
  }

  if (roleIds.length > 0 && customerId) {
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('discord_id')
      .eq('id', customerId)
      .maybeSingle();
    requireSupabaseSuccess(customerError, 'Failed to load customer for refund role revocation');

    if (customer?.discord_id) {
      let shouldQueueRoleRevocation = true;
      if (options.retryingFailedEvent) {
        shouldQueueRoleRevocation = !(await hasQueuedRoleRevocation(supabase, {
          guildId: payment.guild_id,
          discordId: customer.discord_id,
          orderId,
          reason: refundStatus,
        }));
      }

      if (shouldQueueRoleRevocation) {
        const queued = await queueFulfillment(supabase, 'revoke_roles', payment.guild_id, {
          discord_id: customer.discord_id,
          role_ids: roleIds,
          reason: refundStatus,
          order_id: orderId,
        });
        if (!queued) {
          throw new Error('Failed to queue role revocation for refund');
        }
      }
    } else {
      console.warn(
        `[Webhook] ${eventType} for order ${orderId} — customer has no discord_id, Discord roles not revoked`,
      );
    }
  }

  const { error: auditError } = await supabase.from('audit_logs').insert({
    guild_id: payment.guild_id,
    actor_type: 'system',
    actor_id: 'paypal_webhook',
    action:
      eventType.endsWith('.REVERSED')
        ? 'order.reversed'
        : 'order.refunded_external',
    target_type: 'order',
    target_id: orderId,
    details: {
      event_type: eventType,
      [identifierField]: paymentId,
      paypal_refund_id: refundId,
      refund_scope: 'full',
      full_refund_reason: scope.reason,
      refund_amount_cents: amounts.refundAmountCents,
      payment_amount_cents: payment.amount_cents ?? null,
      cumulative_refunded_cents: cumulativeRefundedCents,
      entitlement_ids: (activeEntitlements ?? []).map((ent) => ent.id),
      license_key_ids: licenseKeyIds,
      role_ids: roleIds,
    },
  });
  requireSupabaseSuccess(auditError, 'Failed to write refund audit log');

  const { error: orderUpdateError } = await supabase
    .from('orders')
    .update({ status: 'refunded', updated_at: nowIso })
    .eq('id', orderId);
  requireSupabaseSuccess(orderUpdateError, 'Failed to mark order refunded');

  // Commit marker LAST — the replay guard at the top keys off this status,
  // so it must only flip once every revocation effect has been applied.
  const { error: paymentUpdateError } = await supabase
    .from('payments')
    .update({ status: refundStatus })
    .eq('id', payment.id);
  requireSupabaseSuccess(paymentUpdateError, `Failed to mark payment ${refundStatus}`);

  console.log(
    `[Webhook] ${eventType} processed for order ${orderId} (${identifierName} ${paymentId}) — full refund, access revoked`,
  );
}
