/**
 * /api/welcome/test — Send a test welcome or goodbye message to a channel.
 *
 * POST: Inserts a `test_welcome` action into bot_action_queue.
 * The bot picks it up, renders the template with mock data, and sends it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();

  let body: { channel_id?: string; type?: 'welcome' | 'goodbye' };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid request body' },
      { status: 400 },
    );
  }

  const { channel_id, type = 'welcome' } = body;

  if (!channel_id) {
    return NextResponse.json(
      { success: false, error: 'channel_id is required' },
      { status: 400 },
    );
  }

  if (type !== 'welcome' && type !== 'goodbye') {
    return NextResponse.json(
      { success: false, error: 'type must be "welcome" or "goodbye"' },
      { status: 400 },
    );
  }

  // Queue the action for the bot
  const { error: queueError } = await supabase
    .from('bot_action_queue')
    .insert({
      guild_id: GUILD_ID,
      action: 'test_welcome',
      payload: {
        channel_id,
        type,
        sent_from: 'dashboard',
      },
      status: 'pending',
      created_at: new Date().toISOString(),
    });

  if (queueError) {
    return NextResponse.json(
      { success: false, error: queueError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
