/**
 * POST /api/paypal/webhook — PayPal webhook handler.
 *
 * Verifies signature, processes order completions and subscription events.
 * All fulfillment (role grants, receipt DMs, events) is delegated to the bot
 * via the `bot_action_queue`. This route only handles PayPal-side capture +
 * database records (orders, payments, entitlements, license keys).
 *
 * V5 Audit §2.P3a: Business logic extracted into focused sub-modules:
 *   - verify.ts   — signature verification + replay authentication
 *   - handlers.ts — per-event-type handlers
 *   - fulfillment.ts — license key generation + queue helper
 *
 * Architecture doc §30.5.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';
import {
  SETUP_WEBHOOK_PROBE_HEADER,
  buildSetupWebhookProbeEcho,
  verifySetupWebhookProbeChallenge,
} from '@/lib/setup-webhook-probe';

import {
  isInternalReplay,
  raisePayPalVerifyUnavailableAlert,
  verifyWebhookSignature,
} from './verify';
import { raiseWebhookProcessingErrorAlert } from './alerts';
import {
  handleOrderApproved,
  handlePaymentCaptured,
  handleSubscriptionActivated,
  handleSubscriptionCancelled,
  handleSubscriptionExpired,
  handleSubscriptionSuspended,
  handleSubscriptionPaymentFailed,
  handleSubscriptionPayment,
  handleCaptureRefunded,
  handleSaleRefunded,
  handleDisputeEvent,
  handleCaptureDenied,
  resolveRefundPaymentId,
  resolveStrictDisputedTransactionIds,
} from './handlers';

// ── Main handler ────────────────────────────────────

const WEBHOOK_PROCESSING_STALE_MS = 5 * 60 * 1000;
const DURABLE_PROVIDER_EVENT_TYPES = new Set([
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
]);
const RESUMABLE_FAILED_EVENT_TYPES = new Set([
  // Finding 2: a failed capture used to be permanent. handleOrderApproved is
  // the ONLY thing that captures an approved order (intent: 'CAPTURE'), so a
  // PayPal 5xx/timeout there left the buyer redirected to a success page with
  // an approved-but-uncaptured order — and because this type was not
  // resumable, PayPal's redelivery got HTTP 200 and PayPal stopped retrying.
  // The handler is now idempotent at PayPal (PayPal-Request-Id keyed on the
  // order id) and treats ORDER_ALREADY_CAPTURED as success, so a resumed
  // retry can never double-charge: it either captures once or observes the
  // capture that already happened.
  'CHECKOUT.ORDER.APPROVED',
  // Capture/activation handlers freeze order grants and use a staged outbox
  // keyed by the provider id, so any partial database/queue failure resumes
  // the exact snapshot without duplicating totals, license keys, or actions.
  'PAYMENT.CAPTURE.COMPLETED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  // Subscription sale persistence is idempotent on paypal_payment_id. A
  // resumed 23505 validates every immutable payment field before succeeding.
  'PAYMENT.SALE.COMPLETED',
  // W2 refund semantics: refund handling is idempotent (payment_refunds
  // unique refund id + payments.status flipped only after all effects), and
  // an out-of-order refund (arriving before its capture/sale-completed
  // event) intentionally fails so PayPal's retry re-processes it once the
  // payment row exists. Both need failed refund events to be resumable.
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
  // Cancellation/suspension enqueue their exact provider event and lifecycle
  // transition atomically. Redelivery can therefore recover the same action,
  // while a conflicting payload for that event id is rejected.
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  // Finding 9: dispute and denied-capture handling is awareness-only and fully
  // idempotent — the order status flips are conditional on the current status
  // and the alerts are DB-deduped on dispute/capture id. A transient failure
  // must not permanently lose the operator's only notice of a chargeback.
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
  'PAYMENT.CAPTURE.DENIED',
]);

type PayPalWebhookEvent = {
  event_type: string;
  resource: Record<string, unknown>;
  id?: string;
  create_time?: string;
};

function parseCustomIdGuildId(customId: unknown): string | null {
  if (typeof customId !== 'string') return null;
  try {
    const parsed = JSON.parse(customId);
    if (parsed && typeof parsed === 'object') {
      const guildId = (parsed as { g?: unknown; guild_id?: unknown }).g
        ?? (parsed as { guild_id?: unknown }).guild_id;
      return typeof guildId === 'string' && guildId.length > 0 ? guildId : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Finding 2: order-shaped PayPal resources (CHECKOUT.ORDER.*) do NOT carry
 * `custom_id` at the resource root — the checkout metadata lives on each
 * purchase unit (`purchase_units[].custom_id`). Reading only the root meant
 * `CHECKOUT.ORDER.APPROVED` always resolved to a null guild, the
 * `webhook_events` row was written with `guild_id` omitted, and the dashboard
 * (which filters `.eq('guild_id', …)`) could neither list nor replay it.
 *
 * Every purchase unit that carries a parseable guild must agree. A mixed-guild
 * order is not something this integration creates (one product per checkout),
 * so an ambiguous resource resolves to null rather than guessing — the same
 * fail-closed answer as before, but now only for genuinely ambiguous input.
 */
function parsePurchaseUnitsGuildIds(purchaseUnits: unknown): Set<string> {
  const guildIds = new Set<string>();
  if (!Array.isArray(purchaseUnits)) return guildIds;

  for (const unit of purchaseUnits) {
    if (!unit || typeof unit !== 'object') continue;
    const guildId = parseCustomIdGuildId((unit as { custom_id?: unknown }).custom_id);
    if (guildId) guildIds.add(guildId);
  }

  return guildIds;
}

async function lookupSubscriptionGuildId(
  supabase: ReturnType<typeof createAdminSupabase>,
  subscriptionId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('guild_id, status, created_at')
    .eq('paypal_subscription_id', subscriptionId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(`Failed to resolve webhook guild: ${error.message}`);
  }

  const orders = Array.isArray(data) ? data : data ? [data] : [];
  const order = orders.find((row) => row.status === 'completed') ?? orders[0];
  return typeof order?.guild_id === 'string' ? order.guild_id : null;
}

async function lookupPaymentGuildId(
  supabase: ReturnType<typeof createAdminSupabase>,
  paymentId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('payments')
    .select('guild_id')
    .eq('paypal_payment_id', paymentId)
    .eq('provider', 'paypal')
    .in('paypal_resource_type', ['capture', 'sale'])
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to resolve payment webhook guild: ${error.message}`);
  }

  return typeof data?.guild_id === 'string' ? data.guild_id : null;
}

async function lookupPayPalOrderGuildId(
  supabase: ReturnType<typeof createAdminSupabase>,
  paypalOrderId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('guild_id, paypal_order_id')
    .eq('paypal_order_id', paypalOrderId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to resolve checkout webhook guild: ${error.message}`);
  }
  return data?.paypal_order_id === paypalOrderId
    && typeof data.guild_id === 'string'
    ? data.guild_id
    : null;
}

async function resolveWebhookGuildId(
  supabase: ReturnType<typeof createAdminSupabase>,
  event: PayPalWebhookEvent,
): Promise<string | null> {
  const metadataGuildIds = new Set<string>();
  const rootGuildId = parseCustomIdGuildId(event.resource.custom_id);
  if (rootGuildId) metadataGuildIds.add(rootGuildId);
  for (const guildId of parsePurchaseUnitsGuildIds(event.resource.purchase_units)) {
    metadataGuildIds.add(guildId);
  }

  const acceptExactGuild = (exactGuildId: string | null): string | null => {
    if (!exactGuildId) return null;
    return [...metadataGuildIds].every((hint) => hint === exactGuildId)
      ? exactGuildId
      : null;
  };

  if (event.event_type === 'PAYMENT.CAPTURE.DENIED') {
    const supplementary = event.resource.supplementary_data as
      { related_ids?: { order_id?: unknown } } | undefined;
    const paypalOrderId = supplementary?.related_ids?.order_id;
    return typeof paypalOrderId === 'string'
      ? acceptExactGuild(await lookupPayPalOrderGuildId(supabase, paypalOrderId))
      : null;
  }

  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const supplementary = event.resource.supplementary_data as
      { related_ids?: { order_id?: unknown } } | undefined;
    const paypalOrderId = supplementary?.related_ids?.order_id;
    return typeof paypalOrderId === 'string'
      ? acceptExactGuild(await lookupPayPalOrderGuildId(supabase, paypalOrderId))
      : null;
  }

  const resourceId = event.resource.id;
  if (
    typeof resourceId === 'string'
    && event.event_type === 'CHECKOUT.ORDER.APPROVED'
  ) {
    return acceptExactGuild(await lookupPayPalOrderGuildId(supabase, resourceId));
  }
  if (typeof resourceId === 'string' && event.event_type.startsWith('BILLING.SUBSCRIPTION.')) {
    return acceptExactGuild(await lookupSubscriptionGuildId(supabase, resourceId));
  }

  const billingAgreementId = event.resource.billing_agreement_id;
  if (
    typeof billingAgreementId === 'string' &&
    event.event_type === 'PAYMENT.SALE.COMPLETED'
  ) {
    return acceptExactGuild(await lookupSubscriptionGuildId(supabase, billingAgreementId));
  }

  const refundPaymentId = resolveRefundPaymentId(event.resource, event.event_type);
  if (refundPaymentId) {
    return acceptExactGuild(await lookupPaymentGuildId(supabase, refundPaymentId));
  }

  // Finding 9: a dispute resource carries no custom_id at all — it identifies
  // the money via disputed_transactions[].seller_transaction_id, which is the
  // capture/sale id stored in payments.paypal_payment_id. Without this, every
  // chargeback would land as an unattributed row.
  if (event.event_type.startsWith('CUSTOMER.DISPUTE.')) {
    const transactionSet = resolveStrictDisputedTransactionIds(event.resource);
    if (!transactionSet.valid) return null;
    const matchedGuildIds = new Set<string>();
    for (const transactionId of transactionSet.ids) {
      const disputeGuildId = await lookupPaymentGuildId(supabase, transactionId);
      // Every transaction in the signed dispute must resolve locally. A
      // partial match stays unattributed rather than filing the full payload
      // under the one tenant we happened to recognize.
      if (!disputeGuildId) return null;
      matchedGuildIds.add(disputeGuildId);
    }
    return matchedGuildIds.size === 1
      ? acceptExactGuild([...matchedGuildIds][0]!)
      : null;
  }

  return null;
}

export async function POST(req: NextRequest) {
  // V5 Audit P3-1: IP-level rate limit to prevent signature-verification abuse
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const rl = await rateLimits.paypalWebhook(clientIp);
  if (rl.limited) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  // ── Setup reachability probe short-circuit ─────────
  // The first-run setup wizard proves the public webhook URL routes back to
  // this deployment by POSTing a signed, short-lived challenge (see
  // @/lib/setup-webhook-probe). Probes are handled before the body is even
  // read: they never touch PayPal signature verification, never create
  // webhook_events rows, and never reach fulfillment handlers.
  const probeChallenge = req.headers.get(SETUP_WEBHOOK_PROBE_HEADER);
  if (probeChallenge !== null) {
    // Invalid, expired, or forged challenges are rejected outright instead
    // of falling through to normal processing, so the probe header can never
    // be used to influence real webhook handling. Verification is a
    // constant-time HMAC compare.
    const echo = verifySetupWebhookProbeChallenge(probeChallenge)
      ? buildSetupWebhookProbeEcho(probeChallenge)
      : null;
    if (!echo) {
      return NextResponse.json({ error: 'Invalid probe challenge' }, { status: 401 });
    }
    // The echo is HMAC-signed so the prober can tell that *this* deployment
    // answered — a 200 from a captive portal or stale deployment won't do.
    return NextResponse.json({ status: 'probe', echo }, { status: 200 });
  }

  const rawBody = await req.text();
  const supabase = createAdminSupabase();

  // V47-C3: accept internal replay POSTs that carry a valid X-Replay-Secret
  const replay = isInternalReplay(req);

  if (!replay) {
    const verification = await verifyWebhookSignature(req, rawBody);

    if (verification.outcome === 'unavailable') {
      // W2: verification INFRASTRUCTURE failed (token fetch / verify API
      // timeout or 5xx after in-request retries) — we never learned whether
      // the signature is valid. Respond 503, not 401: PayPal redelivers
      // failed (non-2xx) webhook deliveries, and the event was NOT recorded
      // in webhook_events yet, so the redelivery processes cleanly through
      // dedup instead of the paid order being lost as "unauthorized".
      console.error('[Webhook] Signature verification unavailable:', verification.reason);
      await raisePayPalVerifyUnavailableAlert(supabase, verification.reason);
      return NextResponse.json(
        { error: 'Signature verification temporarily unavailable' },
        { status: 503, headers: { 'Retry-After': '60' } },
      );
    }

    if (verification.outcome !== 'verified') {
      console.error('[Webhook] Signature verification failed');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  // V7 Audit §7.P2a — Zod-validated webhook payload shape
  let event: PayPalWebhookEvent;
  try {
    const raw = JSON.parse(rawBody);
    const paypalEventSchema = z.object({
      event_type: z.string().min(1),
      resource: z.record(z.unknown()),
      id: z.string().optional(),
      create_time: z.string().optional(),
    });
    const parsed = paypalEventSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid webhook payload shape' }, { status: 400 });
    }
    event = parsed.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // I-3: Atomic dedup — INSERT the event row first; if a duplicate already exists
  // (event_id is PRIMARY KEY), the ON CONFLICT DO NOTHING makes the insert a no-op
  if (!event.id && DURABLE_PROVIDER_EVENT_TYPES.has(event.event_type)) {
    return NextResponse.json(
      { error: 'Missing webhook event identity' },
      { status: 400 },
    );
  }
  const eventId = event.id ?? req.headers.get('paypal-transmission-id') ?? '';
  const resolvedEventId = eventId || randomBytes(16).toString('hex');
  const replayClaimToken = replay
    ? req.headers.get('x-replay-claim-token')
    : null;
  if (replay) {
    const parsedClaimToken = z.string().uuid().safeParse(replayClaimToken);
    if (!eventId || !parsedClaimToken.success) {
      return NextResponse.json({ error: 'Invalid replay claim' }, { status: 409 });
    }
    const { data: claimIsCurrent, error: claimCheckError } = await supabase.rpc(
      'webhooks_replay_claim_is_current',
      {
        p_event_id: resolvedEventId,
        p_claim_token: parsedClaimToken.data,
      },
    );
    if (claimCheckError || claimIsCurrent !== true) {
      return NextResponse.json({ error: 'Replay claim is no longer current' }, { status: 409 });
    }
  }
  const shouldRecordEventResult = Boolean(eventId) || !replay;
  let retryingFailedEvent = replay && req.headers.get('x-webhook-retrying-failed-event') === '1';
  let webhookGuildId: string | null = null;
  if (!replay) {
    try {
      webhookGuildId = await resolveWebhookGuildId(supabase, event);
    } catch (err) {
      console.error('[Webhook] Failed to resolve webhook guild:', err);
      return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
    }

    const { data: inserted, error: insertError } = await supabase
      .from('webhook_events')
      .upsert(
        {
          event_id: resolvedEventId,
          event_type: event.event_type,
          payload: event as unknown as Record<string, unknown>,
          ...(webhookGuildId ? { guild_id: webhookGuildId } : {}),
        },
        { onConflict: 'event_id', ignoreDuplicates: true },
      )
      .select('event_id')
      .limit(1000);
    if (insertError) {
      console.error('[Webhook] Failed to record webhook event:', insertError.message);
      return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
    }

    if (!inserted || inserted.length === 0) {
      const { data: existing, error: existingError } = await supabase
        .from('webhook_events')
        .select('result, processed_at, replay_claim_token')
        .eq('event_id', resolvedEventId)
        .maybeSingle();

      if (existingError) {
        console.error('[Webhook] Failed to inspect duplicate webhook event:', existingError.message);
        return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
      }

      if (existing?.result === 'success' || existing?.result === 'duplicate') {
        return NextResponse.json({ status: 'duplicate' }, { status: 200 });
      }

      if (existing?.result === 'error') {
        if (!RESUMABLE_FAILED_EVENT_TYPES.has(event.event_type)) {
          return NextResponse.json({ status: 'failed_requires_manual_replay' }, { status: 200 });
        }

        const { data: claimed, error: claimError } = await supabase
          .from('webhook_events')
          .update({
            result: null,
            error_details: null,
            processed_at: new Date().toISOString(),
            ...(webhookGuildId ? { guild_id: webhookGuildId } : {}),
          })
          .eq('event_id', resolvedEventId)
          .eq('result', 'error')
          .select('event_id')
          .maybeSingle();

        if (claimError) {
          console.error('[Webhook] Failed to claim failed webhook retry:', claimError.message);
          return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
        }

        if (!claimed) {
          return NextResponse.json({ status: 'processing' }, { status: 409 });
        }

        retryingFailedEvent = true;
      } else if (existing?.result == null) {
        if (existing?.replay_claim_token) {
          return NextResponse.json({ status: 'processing' }, { status: 409 });
        }
        const processedAt = Date.parse(String(existing?.processed_at ?? ''));
        const isStale = Number.isFinite(processedAt) &&
          Date.now() - processedAt >= WEBHOOK_PROCESSING_STALE_MS;

        if (!isStale) {
          return NextResponse.json({ status: 'processing' }, { status: 409 });
        }

        const staleBefore = new Date(Date.now() - WEBHOOK_PROCESSING_STALE_MS).toISOString();
        if (!RESUMABLE_FAILED_EVENT_TYPES.has(event.event_type)) {
          const { error: markError } = await supabase
            .from('webhook_events')
            .update({
              result: 'error',
              error_details: 'Stale webhook requires manual replay',
              processed_at: new Date().toISOString(),
              ...(webhookGuildId ? { guild_id: webhookGuildId } : {}),
            })
            .eq('event_id', resolvedEventId)
            .is('result', null)
            .lt('processed_at', staleBefore);

          if (markError) {
            console.error('[Webhook] Failed to mark stale webhook for manual replay:', markError.message);
            return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
          }

          // Finding 2: this row just landed on result = 'error' and PayPal is
          // about to be told 200 — tell the operator before they stop retrying.
          await raiseWebhookProcessingErrorAlert(supabase, {
            eventId: resolvedEventId,
            eventType: event.event_type,
            guildId: webhookGuildId,
            reason: 'Stale webhook requires manual replay',
            requiresManualReplay: true,
          });

          return NextResponse.json({ status: 'stale_requires_manual_replay' }, { status: 200 });
        }

        const { data: claimed, error: claimError } = await supabase
          .from('webhook_events')
          .update({
            processed_at: new Date().toISOString(),
            error_details: null,
            ...(webhookGuildId ? { guild_id: webhookGuildId } : {}),
          })
          .eq('event_id', resolvedEventId)
          .is('result', null)
          .lt('processed_at', staleBefore)
          .select('event_id')
          .maybeSingle();

        if (claimError) {
          console.error('[Webhook] Failed to claim stale webhook retry:', claimError.message);
          return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
        }

        if (!claimed) {
          return NextResponse.json({ status: 'processing' }, { status: 409 });
        }

        retryingFailedEvent = true;
      } else {
        return NextResponse.json({ status: 'processing' }, { status: 409 });
      }
    }
  }

  try {
    switch (event.event_type) {
      case 'CHECKOUT.ORDER.APPROVED':
        await handleOrderApproved(supabase, event.resource, {
          webhookEventId: resolvedEventId,
        });
        break;
      case 'PAYMENT.CAPTURE.COMPLETED':
        await handlePaymentCaptured(supabase, event.resource, {
          webhookEventId: resolvedEventId,
        });
        break;
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        await handleSubscriptionActivated(supabase, event.resource, {
          webhookEventId: resolvedEventId,
          providerOccurredAt: event.create_time,
        });
        break;
      case 'BILLING.SUBSCRIPTION.CANCELLED':
        await handleSubscriptionCancelled(supabase, event.resource, {
          retryingFailedEvent,
          webhookEventId: resolvedEventId,
          providerOccurredAt: event.create_time,
        });
        break;
      case 'BILLING.SUBSCRIPTION.EXPIRED':
        await handleSubscriptionExpired(supabase, event.resource, {
          retryingFailedEvent,
          webhookEventId: resolvedEventId,
          providerOccurredAt: event.create_time,
        });
        break;
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        await handleSubscriptionSuspended(supabase, event.resource, {
          retryingFailedEvent,
          webhookEventId: resolvedEventId,
          providerOccurredAt: event.create_time,
        });
        break;
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        await handleSubscriptionPaymentFailed(supabase, event.resource, {
          retryingFailedEvent,
          webhookEventId: resolvedEventId,
          providerOccurredAt: event.create_time,
        });
        break;
      case 'PAYMENT.SALE.COMPLETED':
        await handleSubscriptionPayment(supabase, event.resource, {
          webhookEventId: resolvedEventId,
          providerOccurredAt: event.create_time,
        });
        break;
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED':
        await handleCaptureRefunded(supabase, event.resource, event.event_type, {
          retryingFailedEvent,
        });
        break;
      case 'PAYMENT.SALE.REFUNDED':
      case 'PAYMENT.SALE.REVERSED':
        await handleSaleRefunded(supabase, event.resource, event.event_type, {
          retryingFailedEvent,
        });
        break;
      // Finding 9: these used to fall to `default:`, log "Unhandled event",
      // and then take the success path — a chargeback recorded as a success.
      case 'CUSTOMER.DISPUTE.CREATED':
      case 'CUSTOMER.DISPUTE.UPDATED':
      case 'CUSTOMER.DISPUTE.RESOLVED':
        await handleDisputeEvent(supabase, event.resource, event.event_type);
        break;
      case 'PAYMENT.CAPTURE.DENIED':
        await handleCaptureDenied(supabase, event.resource);
        break;
      default:
        console.log(`[Webhook] Unhandled event: ${event.event_type}`);
    }

    if (shouldRecordEventResult) {
      const completion = replay
        ? await supabase.rpc('webhooks_finish_replay_claim', {
          p_event_id: resolvedEventId,
          p_claim_token: replayClaimToken,
          p_result: 'success',
          p_error_details: null,
        })
        : await supabase
          .from('webhook_events')
          .update({
            result: 'success',
            error_details: null,
            ...(webhookGuildId ? { guild_id: webhookGuildId } : {}),
          })
          .eq('event_id', resolvedEventId);
      const completionError = completion.error;
      if (completionError) {
        throw new Error(`Failed to persist webhook completion: ${completionError.message}`);
      }
      if (replay && completion.data !== true) {
        throw new Error('Webhook replay claim is no longer current');
      }
    }

    // Emit webhook.received audit event via bot action queue (Finding #4)
    const guildId = process.env.DISCORD_GUILD_ID;
    if (guildId && shouldRecordEventResult) {
      await supabase.from('bot_action_queue').insert({
        guild_id: guildId,
        action: 'emit_audit_event',
        payload: {
          event_type: 'webhook.received',
          event_data: {
            eventId: resolvedEventId,
            eventType: event.event_type,
            provider: 'paypal',
            result: 'success',
          },
        },
        status: 'pending',
      }).then(null, () => { /* non-blocking */ });
    }

    return NextResponse.json({ status: 'ok' }, { status: 200 });
  } catch (err) {
    console.error(`[Webhook] Error processing ${event.event_type}:`, err);
    if (shouldRecordEventResult) {
      const errorCompletion = replay
        ? await supabase.rpc('webhooks_finish_replay_claim', {
          p_event_id: resolvedEventId,
          p_claim_token: replayClaimToken,
          p_result: 'error',
          p_error_details: String(err),
        })
        : await supabase
          .from('webhook_events')
          .update({
            result: 'error',
            error_details: String(err),
            ...(webhookGuildId ? { guild_id: webhookGuildId } : {}),
          })
          .eq('event_id', resolvedEventId);

      // Finding 2: a webhook_events row landing on result = 'error' used to be
      // completely silent. Non-resumable types get HTTP 200 on PayPal's next
      // delivery, so PayPal stops retrying and the failure is permanent unless
      // a human notices. Alert on every error, resumable or not.
      if (!replay || (!errorCompletion.error && errorCompletion.data === true)) {
        await raiseWebhookProcessingErrorAlert(supabase, {
          eventId: resolvedEventId,
          eventType: event.event_type,
          guildId: webhookGuildId,
          reason: String(err),
          requiresManualReplay: !RESUMABLE_FAILED_EVENT_TYPES.has(event.event_type),
        });
      }
    }

    // V11 Re-Audit L-2: Don't leak event_type in error responses.
    // Internal details help attackers fingerprint webhook handling.
    return NextResponse.json(
      { error: 'Processing failed' },
      { status: 500 },
    );
  }
}
