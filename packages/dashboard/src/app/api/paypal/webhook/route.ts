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

import { isInternalReplay, verifyWebhookSignature } from './verify';
import {
  handleOrderApproved,
  handlePaymentCaptured,
  handleSubscriptionActivated,
  handleSubscriptionCancelled,
  handleSubscriptionExpired,
  handleSubscriptionSuspended,
  handleSubscriptionPayment,
  handleCaptureRefunded,
  handleSaleRefunded,
  resolveRefundPaymentId,
} from './handlers';

// ── Main handler ────────────────────────────────────

const WEBHOOK_PROCESSING_STALE_MS = 5 * 60 * 1000;
const RESUMABLE_FAILED_EVENT_TYPES = new Set([
  'BILLING.SUBSCRIPTION.EXPIRED',
]);

type PayPalWebhookEvent = {
  event_type: string;
  resource: Record<string, unknown>;
  id?: string;
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
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to resolve payment webhook guild: ${error.message}`);
  }

  return typeof data?.guild_id === 'string' ? data.guild_id : null;
}

async function resolveWebhookGuildId(
  supabase: ReturnType<typeof createAdminSupabase>,
  event: PayPalWebhookEvent,
): Promise<string | null> {
  const customIdGuildId = parseCustomIdGuildId(event.resource.custom_id);
  if (customIdGuildId) return customIdGuildId;

  const resourceId = event.resource.id;
  if (typeof resourceId === 'string' && event.event_type.startsWith('BILLING.SUBSCRIPTION.')) {
    return lookupSubscriptionGuildId(supabase, resourceId);
  }

  const billingAgreementId = event.resource.billing_agreement_id;
  if (
    typeof billingAgreementId === 'string' &&
    event.event_type === 'PAYMENT.SALE.COMPLETED'
  ) {
    return lookupSubscriptionGuildId(supabase, billingAgreementId);
  }

  const refundPaymentId = resolveRefundPaymentId(event.resource, event.event_type);
  if (refundPaymentId) {
    return lookupPaymentGuildId(supabase, refundPaymentId);
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
    const valid = await verifyWebhookSignature(req, rawBody);
    if (!valid) {
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
  const eventId = event.id ?? req.headers.get('paypal-transmission-id') ?? '';
  const resolvedEventId = eventId || randomBytes(16).toString('hex');
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
        .select('result, processed_at')
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
      case 'BILLING.SUBSCRIPTION.EXPIRED':
        await handleSubscriptionExpired(supabase, event.resource, { retryingFailedEvent });
        break;
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        await handleSubscriptionSuspended(supabase, event.resource);
        break;
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        await handleSubscriptionSuspended(supabase, event.resource);
        break;
      case 'PAYMENT.SALE.COMPLETED':
        await handleSubscriptionPayment(supabase, event.resource);
        break;
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED':
        await handleCaptureRefunded(supabase, event.resource, event.event_type);
        break;
      case 'PAYMENT.SALE.REFUNDED':
      case 'PAYMENT.SALE.REVERSED':
        await handleSaleRefunded(supabase, event.resource, event.event_type);
        break;
      default:
        console.log(`[Webhook] Unhandled event: ${event.event_type}`);
    }

    if (shouldRecordEventResult) {
      await supabase
        .from('webhook_events')
        .update({
          result: 'success',
          error_details: null,
          ...(webhookGuildId ? { guild_id: webhookGuildId } : {}),
        })
        .eq('event_id', resolvedEventId);
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
      await supabase
        .from('webhook_events')
        .update({
          result: 'error',
          error_details: String(err),
          ...(webhookGuildId ? { guild_id: webhookGuildId } : {}),
        })
        .eq('event_id', resolvedEventId);
    }

    // V11 Re-Audit L-2: Don't leak event_type in error responses.
    // Internal details help attackers fingerprint webhook handling.
    return NextResponse.json(
      { error: 'Processing failed' },
      { status: 500 },
    );
  }
}
