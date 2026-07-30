/**
 * POST /api/webhooks/[id]/replay — Replay a failed webhook event.
 *
 * SECURITY (Phase A):
 * - Requires guild owner authentication.
 * - Uses internal WEBHOOK_REPLAY_SECRET instead of public X-Replay header.
 * - Validates event ID format.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createHmac } from 'crypto';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { raiseWebhookProcessingErrorAlert } from '../../../paypal/webhook/alerts';
import { recordAdminChange } from '@/lib/admin-changes';

/** V7 Audit §7.P2a — Zod schema for replay event ID path param. */
const eventIdSchema = z.string().min(1).max(128).regex(/^[\w-]+$/, 'Invalid event ID format');
const replayClaimTokenSchema = z.string().uuid();
const WEBHOOK_REPLAY_PROCESSING_STALE_MS = 5 * 60 * 1000;

// V7 Audit §2.P2a: Prefer dedicated WEBHOOK_REPLAY_SECRET env var.
// Falls back to HMAC derivation from NEXTAUTH_SECRET for backwards compat.
let _replaySecret: string | undefined;
function getReplaySecret(): string {
  if (_replaySecret) return _replaySecret;

  if (process.env.WEBHOOK_REPLAY_SECRET) {
    _replaySecret = process.env.WEBHOOK_REPLAY_SECRET;
    return _replaySecret;
  }

  if (process.env.NEXTAUTH_SECRET) {
    console.warn(
      '[WebhookReplay] WEBHOOK_REPLAY_SECRET not set — deriving from NEXTAUTH_SECRET. ' +
      'Set a dedicated WEBHOOK_REPLAY_SECRET env var for better security isolation.',
    );
    _replaySecret = createHmac('sha256', process.env.NEXTAUTH_SECRET)
      .update('webhook-replay-secret')
      .digest('hex');
    return _replaySecret;
  }

  throw new Error(
    'Missing WEBHOOK_REPLAY_SECRET (or NEXTAUTH_SECRET fallback). ' +
    'Cannot derive replay secret.',
  );
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // ── Require guild owner ──
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;

  const { id: rawId } = await params;

  // V7 Audit §7.P2a — Zod-validated event ID
  const parsed = eventIdSchema.safeParse(rawId);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid event ID format' },
      { status: 400 },
    );
  }
  const id = parsed.data;

  const supabase = createAdminSupabase();

  // The database holds guild ownership stable while it authorizes and claims
  // the row, so a newly-added operator cannot race an unattributed replay.
  const { data: claimRows, error: claimError } = await supabase.rpc(
    'webhooks_claim_scoped_replay',
    {
      p_event_id: id,
      p_guild_id: guildId,
      p_discord_id: discordId,
      p_stale_seconds: WEBHOOK_REPLAY_PROCESSING_STALE_MS / 1000,
    },
  );
  if (claimError) {
    return NextResponse.json(
      { success: false, error: 'Failed to claim webhook replay' },
      { status: 500 },
    );
  }
  const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
  if (!claim || claim.outcome === 'not_found') {
    return NextResponse.json(
      { success: false, error: 'Webhook event not found' },
      { status: 404 },
    );
  }
  if (claim.outcome === 'processing') {
    return NextResponse.json(
      { success: false, error: 'Webhook replay already processing' },
      { status: 409 },
    );
  }
  if (
    claim.outcome !== 'claimed'
    || !claim.event_data
    || typeof claim.event_data !== 'object'
    || Array.isArray(claim.event_data)
    || !replayClaimTokenSchema.safeParse(claim.claim_token).success
  ) {
    return NextResponse.json(
      { success: false, error: 'Failed to claim webhook replay' },
      { status: 500 },
    );
  }
  const event = claim.event_data as Record<string, unknown>;
  const claimToken = claim.claim_token as string;
  const eventGuildId = (event.guild_id ?? null) as string | null;
  const eventType = typeof event.event_type === 'string'
    ? event.event_type
    : 'unknown';

  // Determine base URL for internal replay
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';

  try {
    const replayCount = (typeof event.replay_count === 'number'
      ? event.replay_count
      : 0) + 1;

    // Re-post to internal webhook endpoint with replay secret
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Use replay secret for authentication (NOT the old public X-Replay header)
    try {
      headers['X-Replay-Secret'] = getReplaySecret();
    } catch {
      // WEBHOOK_REPLAY_SECRET not configured — replay may fail signature verification
    }
    headers['PayPal-Transmission-Id'] = id;
    headers['X-Replay-Claim-Token'] = claimToken;
    const payloadEventType = (
      event.payload &&
      typeof event.payload === 'object' &&
      'event_type' in event.payload
    )
      ? (event.payload as { event_type?: unknown }).event_type
      : null;
    const isSubscriptionExpiry =
      event.event_type === 'BILLING.SUBSCRIPTION.EXPIRED' ||
      payloadEventType === 'BILLING.SUBSCRIPTION.EXPIRED';
    if (event.result === 'error' || event.result == null || isSubscriptionExpiry) {
      headers['X-Webhook-Retrying-Failed-Event'] = '1';
    }

    const replayRes = await fetch(`${baseUrl}/api/paypal/webhook`, {
      method: 'POST',
      headers,
      body: JSON.stringify(event.payload),
    });

    const success = replayRes.ok;

    if (!success) {
      const { data: finished, error: finishError } = await supabase.rpc(
        'webhooks_finish_replay_claim',
        {
          p_event_id: id,
          p_claim_token: claimToken,
          p_result: 'error',
          p_error_details: `Replay failed: HTTP ${replayRes.status}`,
        },
      );

      // Finding 2: any row landing on result = 'error' raises an alert, so a
      // replay that silently fails is not another dead end.
      if (!finishError && finished === true) {
        await raiseWebhookProcessingErrorAlert(supabase, {
          eventId: id,
          eventType,
          guildId: eventGuildId,
          reason: `Replay failed: HTTP ${replayRes.status}`,
          requiresManualReplay: true,
        });
      }
    }
    // Note: the webhook handler itself updates result on success

    // Emit webhook.replayed audit event via bot action queue (Finding #4)
    const envGuildId = process.env.DISCORD_GUILD_ID;
    if (envGuildId) {
      await supabase.from('bot_action_queue').insert({
        guild_id: envGuildId,
        action: 'emit_audit_event',
        payload: {
          event_type: 'webhook.replayed',
          event_data: {
            eventId: id,
            eventType,
            replayedBy: auth.ctx.discordId,
            replayCount,
          },
        },
        status: 'pending',
      }).then(null, () => { /* non-blocking */ });
    }

    // Replaying re-posts the original PayPal payload to the live webhook
    // handler, which can re-run fulfilment, entitlement grants and role
    // delivery for a real customer. There is no undo and there never can be —
    // no row update and no allowlisted queue action un-runs a side effect that
    // already reached a buyer.
    //
    // [privacy] `event.payload` is NOT recorded. A PayPal event body carries
    // payer identity, email and transaction detail; the Admin Changes page is
    // not the place to mirror it. The identifiers below are enough to find the
    // event on the Webhooks page.
    await recordAdminChange({
      guildId,
      actorId: auth.ctx.discordId,
      action: 'webhook.replayed',
      targetType: 'payment webhook',
      targetId: id,
      description:
        `Replayed the ${String(event.event_type ?? 'PayPal')} payment webhook `
        + `(attempt ${replayCount}), which re-runs whatever it originally triggered`,
      before: { result: event.result ?? null, replay_count: event.replay_count ?? 0 },
      after: {
        replay_count: replayCount,
        outcome: success ? 'accepted' : `http_${replayRes.status}`,
      },
      blastRadius: 'high',
      undoReason:
        'a replayed webhook re-runs real payment side effects such as fulfilment and role delivery, and those cannot be taken back',
    }, supabase);

    return NextResponse.json({ success, replayed: true });
  } catch (err) {
    const { data: finished, error: finishError } = await supabase.rpc(
      'webhooks_finish_replay_claim',
      {
        p_event_id: id,
        p_claim_token: claimToken,
        p_result: 'error',
        p_error_details: `Replay exception: ${String(err)}`,
      },
    );
    if (!finishError && finished === true) {
      await raiseWebhookProcessingErrorAlert(supabase, {
        eventId: id,
        eventType,
        guildId: eventGuildId,
        reason: `Replay exception: ${String(err)}`,
        requiresManualReplay: true,
      });
    }

    return NextResponse.json(
      { success: false, error: 'Replay failed' },
      { status: 500 },
    );
  }
}
