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
  const guildId = args.guildId ?? process.env.DISCORD_GUILD_ID ?? null;
  if (!guildId) {
    console.warn(
      '[Webhook] Cannot raise webhook processing alert — event has no guild and DISCORD_GUILD_ID is not set',
    );
    return;
  }

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

  try {
    // Refresh an existing unresolved alert for this exact event in place —
    // a single atomic UPDATE, no read-then-write window.
    const { data: refreshed, error: updateError } = await supabase
      .from('alerts')
      .update({ severity, message, metadata, updated_at: new Date().toISOString() })
      .eq('guild_id', guildId)
      .eq('alert_type', WEBHOOK_ERROR_ALERT_TYPE)
      .eq('resolved', false)
      .eq('metadata->>event_id', args.eventId)
      .select('id');

    if (updateError) {
      console.error(
        '[Webhook] Failed to refresh webhook processing alert:',
        updateError.message,
      );
      return;
    }
    if (refreshed && refreshed.length > 0) return;

    const { error: insertError } = await supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: WEBHOOK_ERROR_ALERT_TYPE,
      severity,
      title: `PayPal webhook failed: ${args.eventType}`,
      message,
      metadata,
    });
    // 23505 => the partial unique index
    // `uniq_alerts_unresolved_paypal_webhook_processing_error` already has an
    // unresolved row for this event: another instance raised it first.
    if (insertError && insertError.code !== '23505') {
      console.error(
        '[Webhook] Failed to insert webhook processing alert:',
        insertError.message,
      );
    }
  } catch (err) {
    console.error(
      '[Webhook] Failed to write webhook processing alert:',
      err instanceof Error ? err.message : err,
    );
  }
}
