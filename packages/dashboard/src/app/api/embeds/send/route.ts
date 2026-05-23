/**
 * /api/embeds/send — Queue a saved embed for immediate delivery to a channel.
 *
 * POST: Inserts a `send_embed` action into bot_action_queue.
 * The bot picks it up, resolves the embed config, and sends it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

const embedSendSchema = z.object({
  embed_id: z.string().uuid(),
  channel_id: z.string().regex(/^\d{17,20}$/, 'Must be a Discord snowflake ID'),
});

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const parsed = await parseBody(req, embedSendSchema);
  if (!parsed.ok) return parsed.response;
  const { embed_id, channel_id } = parsed.data;

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
