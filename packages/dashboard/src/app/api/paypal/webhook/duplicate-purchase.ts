/**
 * Capture-time duplicate-purchase detection (Finding 10).
 *
 * The already-purchased guard in the bot runs at BUY-CLICK time. A customer who
 * double-clicked Buy got two PayPal orders with two approval links; completing
 * both produced two successful captures. The only entitlement uniqueness in the
 * schema is `idx_entitlements_order_id` on `order_id`, so two orders yield two
 * entitlements — and `handlePaymentCaptured` never re-checked.
 *
 * The database index `uniq_orders_pending_one_time_checkout` now stops the
 * second in-flight one-time checkout being created at all. This module is the
 * second rail: the check that runs when a capture arrives anyway (a subscription
 * order, a pre-index approval link, a manually granted entitlement, or any path
 * that reaches capture with the product already owned).
 *
 * WHAT IT MUST NOT DO
 * -------------------
 * Silently swallow the payment. The customer's money is real and already
 * captured. So the payment is still recorded through the normal finalizer — it
 * must be visible in orders/payments and refundable through the existing admin
 * refund flow — and only the FULFILMENT is withheld, because granting a second
 * entitlement, a second role set, and a second licence key for one product is
 * not a fix, it is a second wrong.
 *
 * The duplicate is then raised as a CRITICAL operator alert, following the same
 * update-in-place / insert / swallow-23505 pattern as
 * `raisePayPalVerifyUnavailableAlert` in verify.ts. The operator refunds via
 * Orders → Refund.
 *
 * WHY NOT `pending_review`
 * ------------------------
 * `pending_review` is set only by `commerce_finalize_paypal_capture`, for an
 * amount/currency mismatch, and its replay guard requires the order/payment
 * status pair to still match on redelivery
 * (`v_replay_state_valid := v_payment.status = 'pending_review' AND
 *   v_order.status = 'pending_review'`). Stamping `pending_review` on the order
 * AFTER the finalizer has written `completed` would make every PayPal
 * redelivery of that capture raise 'existing capture/order successor state
 * mismatch' forever — i.e. it would break idempotency, which must be preserved
 * exactly. The alert rail carries the same operator signal without touching the
 * finalizer's state machine, and re-detects idempotently on replay.
 */
import type { createAdminSupabase } from '@/lib/supabase/admin';

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

export const DUPLICATE_PURCHASE_ALERT_TYPE = 'commerce_duplicate_purchase_capture';

/** Entitlement states that mean "this customer already owns this product". */
const OWNED_ENTITLEMENT_STATUSES = ['active', 'pending', 'grace_period'] as const;

export interface DuplicatePurchaseOrder {
  id: string;
  order_number: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
}

export interface ConflictingEntitlement {
  id: string;
  order_id: string | null;
  status: string;
}

/**
 * Find an entitlement that already grants this customer this product, created by
 * a DIFFERENT order than the one being captured.
 *
 * Returns `null` when there is none. Throws on a read failure: a capture must
 * never be fulfilled on an unanswered "does this customer already own it?".
 */
export async function findConflictingEntitlement(
  supabase: AdminSupabase,
  order: DuplicatePurchaseOrder,
): Promise<ConflictingEntitlement | null> {
  const { data, error } = await supabase
    .from('entitlements')
    .select('id, order_id, status')
    .eq('guild_id', order.guild_id)
    .eq('customer_id', order.customer_id)
    .eq('product_id', order.product_id)
    .in('status', OWNED_ENTITLEMENT_STATUSES as unknown as string[])
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) {
    throw new Error(`Failed to check for a duplicate purchase: ${error.message}`);
  }

  const rows = (data ?? []) as ConflictingEntitlement[];
  // An entitlement from THIS order is the normal replay case, not a duplicate.
  return rows.find((row) => row.order_id !== order.id) ?? null;
}

/**
 * Raise (or refresh) the operator alert for a duplicate capture.
 *
 * Never throws: a failed alert write must not fail the webhook and cause PayPal
 * to redeliver a capture that was already recorded.
 */
export async function raiseDuplicatePurchaseAlert(
  supabase: AdminSupabase,
  order: DuplicatePurchaseOrder,
  conflict: ConflictingEntitlement,
  capture: { paypalCaptureId: string; amountCents: number; currency: string },
): Promise<void> {
  const message =
    `Order ${order.order_number} was paid but the customer already owned this `
    + `product through an earlier entitlement, so a second entitlement, role set `
    + `and licence key were NOT granted. The customer has been charged `
    + `${(capture.amountCents / 100).toFixed(2)} ${capture.currency} for something `
    + `they already have — review and refund this order (Store → Orders → Refund).`;

  const metadata = {
    source: 'paypal_webhook',
    order_id: order.id,
    order_number: order.order_number,
    customer_id: order.customer_id,
    product_id: order.product_id,
    paypal_capture_id: capture.paypalCaptureId,
    amount_cents: capture.amountCents,
    currency: capture.currency,
    existing_entitlement_id: conflict.id,
    existing_entitlement_order_id: conflict.order_id,
  };

  try {
    // Refresh an unresolved alert for THIS order in place; a PayPal redelivery
    // of the same capture must not pile up alert rows.
    const { data: refreshed, error: updateError } = await supabase
      .from('alerts')
      .update({ message, metadata, updated_at: new Date().toISOString() })
      .eq('guild_id', order.guild_id)
      .eq('alert_type', DUPLICATE_PURCHASE_ALERT_TYPE)
      .eq('resolved', false)
      .eq('metadata->>order_id', order.id)
      .select('id');

    if (updateError) {
      console.error('[Webhook] Failed to refresh duplicate-purchase alert:', updateError.message);
    } else if (refreshed && refreshed.length > 0) {
      return;
    }

    const { error: insertError } = await supabase.from('alerts').insert({
      guild_id: order.guild_id,
      alert_type: DUPLICATE_PURCHASE_ALERT_TYPE,
      severity: 'critical',
      title: 'Customer charged twice for the same product',
      message,
      metadata,
    });
    if (insertError && insertError.code !== '23505') {
      console.error('[Webhook] Failed to insert duplicate-purchase alert:', insertError.message);
    }
  } catch (err) {
    console.error(
      '[Webhook] Failed to write duplicate-purchase alert:',
      err instanceof Error ? err.message : err,
    );
  }
}
