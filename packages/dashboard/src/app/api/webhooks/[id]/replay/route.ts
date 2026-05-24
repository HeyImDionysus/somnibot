/**
 * POST /api/webhooks/[id]/replay — Replay a failed webhook event.
 *
 * SECURITY (Phase A):
 * - Requires guild owner authentication.
 * - Uses internal WEBHOOK_REPLAY_SECRET instead of public X-Replay header.
 * - Validates event ID format.
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createHmac } from 'crypto';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

// Derive replay secret from NEXTAUTH_SECRET — no extra env var needed
let _replaySecret: string | undefined;
function getReplaySecret(): string {
  if (_replaySecret) return _replaySecret;
  const secret = process.env.WEBHOOK_REPLAY_SECRET
    || (process.env.NEXTAUTH_SECRET
      ? createHmac('sha256', process.env.NEXTAUTH_SECRET).update('webhook-replay-secret').digest('hex')
      : undefined);
  if (!secret) throw new Error('Missing WEBHOOK_REPLAY_SECRET or NEXTAUTH_SECRET — cannot derive replay secret');
  _replaySecret = secret;
  return secret;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // ── Require guild owner ──
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { id } = await params;

  // Validate ID format (prevent injection)
  if (!id || id.length > 128 || !/^[\w-]+$/.test(id)) {
    return NextResponse.json(
      { success: false, error: 'Invalid event ID format' },
      { status: 400 },
    );
  }

  const supabase = createAdminSupabase();

  // Fetch the webhook event — scope by guild_id to prevent cross-guild replay
  const { data: event, error: fetchError } = await supabase
    .from('webhook_events')
    .select('*')
    .eq('event_id', id)
    .eq('guild_id', guildId)
    .single();

  if (fetchError || !event) {
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
    // Mark as replaying
    await supabase
      .from('webhook_events')
      .update({
        result: null,
        error_details: null,
        replayed_at: new Date().toISOString(),
        replay_count: (event.replay_count ?? 0) + 1,
      })
      .eq('event_id', id);

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
    }
    // Note: the webhook handler itself updates result on success

    return NextResponse.json({ success, replayed: true });
  } catch (err) {
    await supabase
      .from('webhook_events')
      .update({
        result: 'error',
        error_details: `Replay exception: ${String(err)}`,
      })
      .eq('event_id', id);

    return NextResponse.json(
      { success: false, error: 'Replay failed' },
      { status: 500 },
    );
  }
}
