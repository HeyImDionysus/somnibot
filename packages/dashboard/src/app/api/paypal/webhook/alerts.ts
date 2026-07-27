/**
 * Operator alerts raised from the PayPal webhook route.
 *
 * Finding 2: a `webhook_events` row that lands on `result = 'error'` used to
 * be completely silent. PayPal's redelivery of a non-resumable event gets an
 * HTTP 200 (`failed_requires_manual_replay`), so PayPal stops retrying and
 * nobody is told. For `CHECKOUT.ORDER.APPROVED` that means the buyer was
 * redirected to a success page, PayPal holds an approved-but-uncaptured
 * order, and the operator finds out when the customer emails.
 *
 * Every path in the route that writes `result = 'error'` now also raises an
 * operator alert. Mirrors `raisePayPalVerifyUnavailableAlert` in ./verify.ts:
 * atomic DB dedupe via a partial unique index, UPDATE-then-INSERT with 23505
 * treated as "another instance already raised it" (no check-then-insert
 * window).
 */
import type { createAdminSupabase } from '@/lib/supabase/admin';

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

/** Operator-visible alert type for failed webhook processing (see `alerts` table). */
export const WEBHOOK_ERROR_ALERT_TYPE = 'paypal_webhook_processing_error';

/**
 * Cap on the stored failure reason. `error_details` can carry a PayPal error
 * body; the alert row only needs enough to identify the failure mode.
 */
const MAX_REASON_LENGTH = 500;

/**
 * Event types where a permanently-failed event means money moved (or is about
 * to) without the database recording it. These get `critical`; everything else
 * gets `warning`.
 */
const MONEY_CRITICAL_EVENT_TYPES = new Set([
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.SALE.COMPLETED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
]);

function truncateReason(reason: string): string {
  const trimmed = reason.trim();
  return trimmed.length > MAX_REASON_LENGTH
    ? `${trimmed.slice(0, MAX_REASON_LENGTH)}…`
    : trimmed;
}

/**
 * Raise (or refresh) one operator alert, deduped in the database.
 *
 * `dedupeKey` names a `metadata` field carrying the natural key of the thing
 * being alerted about (a webhook event id, a dispute id, a capture id). A
 * matching partial unique index keeps at most one unresolved alert per key, so
 * a repeated delivery refreshes the open row instead of piling up — and racing
 * dashboard instances collide in the DB (23505) rather than in a
 * check-then-insert window.
 *
 * Never throws. Alerting must not turn a recorded failure into an unrecorded
 * one, and must never be the thing that fails a webhook.
 */
async function upsertDedupedAlert(
  supabase: AdminSupabase,
  args: {
    guildId: string;
    alertType: string;
    severity: 'info' | 'warning' | 'critical';
    title: string;
    message: string;
    metadata: Record<string, unknown>;
    dedupeKey: string;
    dedupeValue: string;
  },
): Promise<void> {
  // Constant call-site keys only; refuse anything that could reshape the
  // PostgREST `metadata->>key` selector.
  if (!/^[a-z_][a-z0-9_]*$/.test(args.dedupeKey)) {
    console.error(`[Webhook] Refusing alert with unsafe dedupe key: ${args.dedupeKey}`);
    return;
  }

  try {
    const { data: refreshed, error: updateError } = await supabase
      .from('alerts')
      .update({
        severity: args.severity,
        title: args.title,
        message: args.message,
        metadata: args.metadata,
        updated_at: new Date().toISOString(),
      })
      .eq('guild_id', args.guildId)
      .eq('alert_type', args.alertType)
      .eq('resolved', false)
      .eq(`metadata->>${args.dedupeKey}`, args.dedupeValue)
      .select('id');

    if (updateError) {
      console.error(`[Webhook] Failed to refresh ${args.alertType} alert:`, updateError.message);
      return;
    }
    if (refreshed && refreshed.length > 0) return;

    const { error: insertError } = await supabase.from('alerts').insert({
      guild_id: args.guildId,
      alert_type: args.alertType,
      severity: args.severity,
      title: args.title,
      message: args.message,
      metadata: args.metadata,
    });
    // 23505 => another instance raised this exact alert first.
    if (insertError && insertError.code !== '23505') {
      console.error(`[Webhook] Failed to insert ${args.alertType} alert:`, insertError.message);
    }
  } catch (err) {
    console.error(
      `[Webhook] Failed to write ${args.alertType} alert:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Resolve the guild an alert should be filed under. Falls back to the
 * instance's primary guild — the same fallback the verify-outage alert uses —
 * so an event we could not attribute still surfaces somewhere the operator
 * actually looks.
 */
function resolveAlertGuildId(guildId: string | null, context: string): string | null {
  const resolved = guildId ?? process.env.DISCORD_GUILD_ID ?? null;
  if (!resolved) {
    console.warn(
      `[Webhook] Cannot raise ${context} alert — no guild resolved and DISCORD_GUILD_ID is not set`,
    );
  }
  return resolved;
}

/**
 * Raise (or refresh) the operator alert for a webhook event that failed to
 * process.
 *
 * `guildId` is the guild the event was attributed to. When the event could
 * not be attributed to a guild at all (the exact case that makes it invisible
 * in the dashboard), the alert falls back to the instance's primary guild —
 * the same fallback `raisePayPalVerifyUnavailableAlert` uses for
 * instance-level webhook problems — so an unattributable failure is still
 * surfaced somewhere the operator actually looks.
 *
 * Never throws: alerting must not turn a recorded failure into an unrecorded
 * one. Callers run this after the `result = 'error'` write has landed.
 */
export async function raiseWebhookProcessingErrorAlert(
  supabase: AdminSupabase,
  args: {
    eventId: string;
    eventType: string;
    guildId: string | null;
    reason: string;
    /** Set when the event is not replayable by PayPal's own retries. */
    requiresManualReplay?: boolean;
  },
): Promise<void> {
  const guildId = resolveAlertGuildId(args.guildId, 'webhook processing');
  if (!guildId) return;

  const reason = truncateReason(args.reason);
  const severity = MONEY_CRITICAL_EVENT_TYPES.has(args.eventType) ? 'critical' : 'warning';
  const unattributed = args.guildId === null;

  const message =
    `PayPal webhook ${args.eventType} (event ${args.eventId}) failed to process: ${reason}` +
    (args.requiresManualReplay
      ? ' PayPal will not retry this delivery — replay it from the dashboard webhook log.'
      : ' PayPal may redeliver it; if it does not recover, replay it from the dashboard webhook log.') +
    (unattributed
      ? ' The event could not be attributed to a guild, so it is filed under the instance primary guild.'
      : '');

  const metadata = {
    event_id: args.eventId,
    event_type: args.eventType,
    reason,
    requires_manual_replay: args.requiresManualReplay === true,
    unattributed_guild: unattributed,
    source: 'paypal_webhook',
  };

  await upsertDedupedAlert(supabase, {
    guildId,
    alertType: WEBHOOK_ERROR_ALERT_TYPE,
    severity,
    title: `PayPal webhook failed: ${args.eventType}`,
    message,
    metadata,
    dedupeKey: 'event_id',
    dedupeValue: args.eventId,
  });
}

// ── Finding 9: disputes and denied captures ────────────────────────────────

/** Operator-visible alert type for PayPal disputes / chargebacks. */
export const DISPUTE_ALERT_TYPE = 'paypal_dispute';

/** Operator-visible alert type for a capture PayPal refused to settle. */
export const CAPTURE_DENIED_ALERT_TYPE = 'paypal_capture_denied';

/**
 * A chargeback or dispute was opened, updated, or resolved.
 *
 * Before this, `CUSTOMER.DISPUTE.*` fell through to the route's `default:`
 * branch, logged "Unhandled event", and was then recorded as
 * `result: 'success'` — a chargeback was literally filed as a success.
 *
 * Settlement is NOT re-done here: `PAYMENT.CAPTURE.REVERSED` / `.REFUNDED`
 * already revoke access correctly when money actually moves. This is purely
 * about awareness, plus flipping `orders.status` to the `'disputed'` value
 * that the schema has always allowed and nothing ever set.
 */
export async function raiseDisputeAlert(
  supabase: AdminSupabase,
  args: {
    disputeId: string;
    eventType: string;
    guildId: string | null;
    status: string | null;
    reason: string | null;
    /** Integer cents. Never a float — money is integer cents everywhere. */
    amountCents: number | null;
    currency: string | null;
    orderIds: string[];
    /** Set when no local payment matched the disputed transaction. */
    unmatched: boolean;
  },
): Promise<void> {
  const guildId = resolveAlertGuildId(args.guildId, 'dispute');
  if (!guildId) return;

  const resolvedStage = args.eventType === 'CUSTOMER.DISPUTE.RESOLVED';
  const amountText = args.amountCents !== null && args.currency
    ? ` for ${(args.amountCents / 100).toFixed(2)} ${args.currency}`
    : '';

  const message =
    (resolvedStage
      ? `PayPal dispute ${args.disputeId} was resolved`
      : `A PayPal dispute (${args.disputeId}) is open`)
    + `${amountText}.`
    + (args.status ? ` Status: ${args.status}.` : '')
    + (args.reason ? ` Reason: ${args.reason}.` : '')
    + (args.unmatched
      ? ' No local payment matches the disputed transaction — reconcile this manually.'
      : ` Affected order(s): ${args.orderIds.join(', ') || 'none matched'}.`)
    + (resolvedStage
      ? ' Order status is NOT changed automatically: any money movement arrives'
        + ' separately as PAYMENT.CAPTURE.REVERSED/.REFUNDED, which is what'
        + ' revokes access.'
      : ' Respond in the PayPal resolution center before the deadline.');

  await upsertDedupedAlert(supabase, {
    guildId,
    alertType: DISPUTE_ALERT_TYPE,
    // A live dispute is money at risk; a resolved one is an FYI.
    severity: resolvedStage ? 'warning' : 'critical',
    title: resolvedStage ? 'PayPal dispute resolved' : 'PayPal dispute opened',
    message,
    metadata: {
      dispute_id: args.disputeId,
      event_type: args.eventType,
      dispute_status: args.status,
      dispute_reason: args.reason,
      dispute_amount_cents: args.amountCents,
      currency: args.currency,
      order_ids: args.orderIds,
      unmatched_transaction: args.unmatched,
      source: 'paypal_webhook',
    },
    dedupeKey: 'dispute_id',
    dedupeValue: args.disputeId,
  });
}

/**
 * PayPal refused to settle a capture. Without this the order sat `pending`
 * forever and nobody was told — `PAYMENT.CAPTURE.DENIED` was not even in the
 * handled-event catalog, so the webhook was not subscribed to it.
 */
export async function raiseCaptureDeniedAlert(
  supabase: AdminSupabase,
  args: {
    captureId: string;
    guildId: string | null;
    orderId: string | null;
    paypalOrderId: string | null;
    /** Integer cents. */
    amountCents: number | null;
    currency: string | null;
    orderCancelled: boolean;
  },
): Promise<void> {
  const guildId = resolveAlertGuildId(args.guildId, 'capture denied');
  if (!guildId) return;

  const amountText = args.amountCents !== null && args.currency
    ? ` (${(args.amountCents / 100).toFixed(2)} ${args.currency})`
    : '';

  const message =
    `PayPal denied capture ${args.captureId}${amountText}. The buyer was not charged`
    + ' and no entitlement was granted.'
    + (args.orderId
      ? args.orderCancelled
        ? ` Order ${args.orderId} was moved from pending to cancelled.`
        : ` Order ${args.orderId} was left as-is because it is no longer pending.`
      : ' No local order matched this capture — reconcile this manually.');

  await upsertDedupedAlert(supabase, {
    guildId,
    alertType: CAPTURE_DENIED_ALERT_TYPE,
    severity: 'warning',
    title: 'PayPal capture denied',
    message,
    metadata: {
      capture_id: args.captureId,
      order_id: args.orderId,
      paypal_order_id: args.paypalOrderId,
      amount_cents: args.amountCents,
      currency: args.currency,
      order_cancelled: args.orderCancelled,
      source: 'paypal_webhook',
    },
    dedupeKey: 'capture_id',
    dedupeValue: args.captureId,
  });
}
