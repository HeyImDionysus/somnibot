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
} from './handlers';

// ── Main handler ────────────────────────────────────

const WEBHOOK_PROCESSING_STALE_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest) {
  // V5 Audit P3-1: IP-level rate limit to prevent signature-verification abuse
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const rl = await rateLimits.paypalWebhook(clientIp);
  if (rl.limited) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
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
  let event: { event_type: string; resource: Record<string, unknown>; id?: string };
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
  if (!replay) {
    const { data: inserted, error: insertError } = await supabase
      .from('webhook_events')
      .upsert(
        {
          event_id: resolvedEventId,
          event_type: event.event_type,
          payload: event as unknown as Record<string, unknown>,
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
        const { data: claimed, error: claimError } = await supabase
          .from('webhook_events')
          .update({
            result: null,
            error_details: null,
            processed_at: new Date().toISOString(),
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
        const { data: claimed, error: claimError } = await supabase
          .from('webhook_events')
          .update({
            processed_at: new Date().toISOString(),
            error_details: null,
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
        .update({ result: 'success', error_details: null })
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
        .update({ result: 'error', error_details: String(err) })
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
