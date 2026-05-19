/**
 * /api/embeds/send — Queue a saved embed for immediate delivery to a channel.
 *
 * POST: Inserts a `send_embed` action into bot_action_queue.
 * The bot picks it up, resolves the embed config, and sends it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
export async function POST(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  let body: { embed_id?: string; channel_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid request body' },
      { status: 400 },
    );
  }

  const { embed_id, channel_id } = body;

  if (!embed_id || !channel_id) {
    return NextResponse.json(
      { success: false, error: 'Both embed_id and channel_id are required' },
      { status: 400 },
    );
  }

  // Verify the embed exists and belongs to this guild
  const { data: embed, error: embedError } = await supabase
    .from('embed_configs')
    .select('id')
    .eq('id', embed_id)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (embedError || !embed) {
    return NextResponse.json(
      { success: false, error: 'Embed not found' },
      { status: 404 },
    );
  }

  // Queue the action for the bot
  const { error: queueError } = await supabase
    .from('bot_action_queue')
    .insert({
      guild_id: guildId,
      action: 'send_embed',
      payload: {
        embed_config_id: embed_id,
        channel_id,
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
