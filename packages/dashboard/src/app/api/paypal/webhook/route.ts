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

import { isInternalReplay, verifyWebhookSignature } from './verify';
import {
  handleOrderApproved,
  handlePaymentCaptured,
  handleSubscriptionActivated,
  handleSubscriptionCancelled,
  handleSubscriptionSuspended,
  handleSubscriptionPayment,
  handleCaptureRefunded,
} from './handlers';

// ── Main handler ────────────────────────────────────

export async function POST(req: NextRequest) {
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
  if (!replay) {
    const resolvedId = eventId || randomBytes(16).toString('hex');
    const { data: inserted } = await supabase
      .from('webhook_events')
      .upsert(
        {
          event_id: resolvedId,
          event_type: event.event_type,
          payload: event as unknown as Record<string, unknown>,
        },
        { onConflict: 'event_id', ignoreDuplicates: true },
      )
      .select('event_id')
      .limit(1000);

    if (!inserted || inserted.length === 0) {
      return NextResponse.json({ status: 'duplicate' }, { status: 200 });
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
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        await handleSubscriptionSuspended(supabase, event.resource);
        break;
      case 'PAYMENT.SALE.COMPLETED':
        await handleSubscriptionPayment(supabase, event.resource);
        break;
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED':
        await handleCaptureRefunded(supabase, event.resource, event.event_type);
        break;
      default:
        console.log(`[Webhook] Unhandled event: ${event.event_type}`);
    }

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

    return NextResponse.json(
      { error: 'Processing failed', event_type: event.event_type },
      { status: 500 },
    );
  }
}
