/**
 * POST /api/webhooks/[id]/replay — Replay a failed webhook event.
 *
 * Re-processes the stored webhook payload through the PayPal webhook handler logic.
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = createAdminSupabase();

  // Fetch the webhook event
  const { data: event, error: fetchError } = await supabase
    .from('webhook_events')
    .select('*')
    .eq('event_id', id)
    .single();

  if (fetchError || !event) {
    return NextResponse.json(
      { success: false, error: 'Webhook event not found' },
      { status: 404 },
    );
  }

  // Re-send to our own webhook handler
  const webhookUrl = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/api/paypal/webhook`
    : null;

  if (!webhookUrl) {
    // If no external URL, process inline
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

      // Re-post to internal endpoint
      const baseUrl = process.env.NEXTAUTH_URL ?? process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000';

      const replayRes = await fetch(`${baseUrl}/api/paypal/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Replay': 'true',
        },
        body: JSON.stringify(event.payload),
      });

      const success = replayRes.ok;

      await supabase
        .from('webhook_events')
        .update({
          result: success ? 'success' : 'error',
          error_details: success ? null : `Replay failed: ${replayRes.status}`,
        })
        .eq('event_id', id);

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

  // External URL available — POST to it
  try {
    await supabase
      .from('webhook_events')
      .update({
        result: null,
        error_details: null,
        replayed_at: new Date().toISOString(),
        replay_count: (event.replay_count ?? 0) + 1,
      })
      .eq('event_id', id);

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Replay': 'true',
      },
      body: JSON.stringify(event.payload),
    });

    const success = res.ok;

    return NextResponse.json({ success, replayed: true });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: `Replay request failed: ${String(err)}` },
      { status: 500 },
    );
  }
}
