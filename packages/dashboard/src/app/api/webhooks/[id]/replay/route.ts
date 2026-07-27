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
import { isSoleInstanceOperator, mayAccessWebhookRow } from '../../scope';
import { raiseWebhookProcessingErrorAlert } from '../../../paypal/webhook/alerts';

/** V7 Audit §7.P2a — Zod schema for replay event ID path param. */
const eventIdSchema = z.string().min(1).max(128).regex(/^[\w-]+$/, 'Invalid event ID format');
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

  // Fetch by primary key, then authorize in code. Guild scoping is still
  // absolute for attributed rows — another guild's event is never replayable —
  // but an UNATTRIBUTED row (guild_id NULL) could not be replayed at all under
  // the old `.eq('guild_id', …)` filter, because NULL never equals anything.
  // Those are precisely the failed-capture rows an operator most needs to
  // re-drive. See ../../scope.ts for who may touch them and why.
  //
  // Unauthorized rows return the same 404 as missing ones, so this cannot be
  // used to probe which event ids exist in another guild.
  const { data: event, error: fetchError } = await supabase
    .from('webhook_events')
    .select('*')
    .eq('event_id', id)
    .maybeSingle();

  const eventGuildId = (event?.guild_id ?? null) as string | null;
  const isUnattributed = event != null && eventGuildId === null;
  const soleOperator = isUnattributed
    ? await isSoleInstanceOperator(supabase, discordId)
    : false;

  if (
    fetchError
    || !event
    || !mayAccessWebhookRow(eventGuildId, guildId, soleOperator)
  ) {
    return NextResponse.json(
      { success: false, error: 'Webhook event not found' },
      { status: 404 },
    );
  }

  // Determine base URL for internal replay
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';

  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const replayCount = (event.replay_count ?? 0) + 1;
    const claimUpdate = {
      result: null,
      error_details: null,
      replayed_at: nowIso,
      replay_count: replayCount,
      processed_at: nowIso,
    };

    // event_id is the primary key, so the guild predicate is defence in depth:
    // it makes the claim fail rather than cross guilds if the row's
    // attribution changed between the read above and this write. Unattributed
    // rows keep the same guarantee via IS NULL — `.eq()` would never match.
    let claimQuery = supabase
      .from('webhook_events')
      .update(claimUpdate)
      .eq('event_id', id);

    claimQuery = isUnattributed
      ? claimQuery.is('guild_id', null)
      : claimQuery.eq('guild_id', guildId);

    if (event.result == null) {
      const processedAt = Date.parse(String(event.processed_at ?? ''));
      const isStale = Number.isFinite(processedAt) &&
        Date.now() - processedAt >= WEBHOOK_REPLAY_PROCESSING_STALE_MS;
      if (!isStale) {
        return NextResponse.json(
          { success: false, error: 'Webhook replay already processing' },
          { status: 409 },
        );
      }
      claimQuery = claimQuery
        .is('result', null)
        .lt(
          'processed_at',
          new Date(Date.now() - WEBHOOK_REPLAY_PROCESSING_STALE_MS).toISOString(),
        );
    } else {
      claimQuery = claimQuery.eq('result', event.result);
    }

    const { data: claimed, error: claimError } = await claimQuery
      .select('event_id')
      .maybeSingle();

    if (claimError) {
      return NextResponse.json(
        { success: false, error: 'Failed to claim webhook replay' },
        { status: 500 },
      );
    }

    if (!claimed) {
      return NextResponse.json(
        { success: false, error: 'Webhook replay already processing' },
        { status: 409 },
      );
    }

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
      await supabase
        .from('webhook_events')
        .update({
          result: 'error',
          error_details: `Replay failed: HTTP ${replayRes.status}`,
        })
        .eq('event_id', id);

      // Finding 2: any row landing on result = 'error' raises an alert, so a
      // replay that silently fails is not another dead end.
      await raiseWebhookProcessingErrorAlert(supabase, {
        eventId: id,
        eventType: event.event_type ?? 'unknown',
        guildId: eventGuildId,
        reason: `Replay failed: HTTP ${replayRes.status}`,
        requiresManualReplay: true,
      });
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
            eventType: event.event_type ?? 'unknown',
            replayedBy: auth.ctx.discordId,
            replayCount,
          },
        },
        status: 'pending',
      }).then(null, () => { /* non-blocking */ });
    }

    return NextResponse.json({ success, replayed: true });
  } catch (err) {
    await supabase
      .from('webhook_events')
      .update({
        result: 'error',
        error_details: `Replay exception: ${String(err)}`,
      })
      .eq('event_id', id);

    await raiseWebhookProcessingErrorAlert(supabase, {
      eventId: id,
      eventType: event.event_type ?? 'unknown',
      guildId: eventGuildId,
      reason: `Replay exception: ${String(err)}`,
      requiresManualReplay: true,
    });

    return NextResponse.json(
      { success: false, error: 'Replay failed' },
      { status: 500 },
    );
  }
}
