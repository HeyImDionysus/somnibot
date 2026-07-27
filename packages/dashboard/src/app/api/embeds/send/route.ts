/**
 * /api/embeds/send — Queue a saved embed for immediate delivery to a channel.
 *
 * POST: Inserts a `send_embed` action into bot_action_queue.
 * The bot picks it up, resolves the embed config, and sends it.
 *
 * This is not a preview: the bot posts a real message into a real channel that
 * real members read. That is a change to the server, so it gets an
 * `admin_changes` row — and it is emphatically NOT undoable, because nothing
 * unsends a message people have already seen.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { recordAdminChange } from '@/lib/admin-changes';

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

  // Verify the embed exists and belongs to this guild.
  // `name` is selected too so the recorded change can say WHICH embed was sent
  // instead of quoting a UUID at the server owner.
  const { data: embed, error: embedError } = await supabase
    .from('embed_configs')
    .select('id, name')
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
    return dbError(queueError, 'embeds/send');
  }

  const embedName = (embed as { name?: unknown }).name;
  const embedLabel = typeof embedName === 'string' && embedName.length > 0
    ? `"${embedName}"`
    : 'saved';

  await recordAdminChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'embeds.sent',
    targetType: 'embed',
    targetId: embed_id,
    description: `Sent the ${embedLabel} embed to channel ${channel_id}`,
    after: { embed_config_id: embed_id, channel_id },
    blastRadius: 'medium',
    undoReason:
      'the message is posted in Discord for everyone in that channel to see, and it cannot be unsent from here — delete it in Discord instead',
  }, supabase);

  return NextResponse.json({ success: true });
}
