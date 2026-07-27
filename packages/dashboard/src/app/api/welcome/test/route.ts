/**
 * /api/welcome/test — Send a test welcome or goodbye message to a channel.
 *
 * POST: Inserts a `test_welcome` action into bot_action_queue.
 * The bot picks it up, renders the template with mock data, and sends it.
 *
 * "Test" describes the CONTENT (mock variables), not the delivery. The bot's
 * `test_welcome` handler ends in `channel.send(...)` — a genuine message in a
 * genuine channel that every member there can read. It changes nothing in the
 * database and nothing in the guild's configuration, but a message now exists
 * in the server that did not before, so it is recorded, and it is not undoable.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { recordAdminChange } from '@/lib/admin-changes';

const welcomeTestSchema = z.object({
  channel_id: z.string().regex(/^\d{17,20}$/, 'Must be a Discord snowflake ID'),
  type: z.enum(['welcome', 'goodbye']).default('welcome'),
});

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const parsed = await parseBody(req, welcomeTestSchema);
  if (!parsed.ok) return parsed.response;
  const { channel_id, type } = parsed.data;

  // Queue the action for the bot
  const { error: queueError } = await supabase
    .from('bot_action_queue')
    .insert({
      guild_id: guildId,
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

  await recordAdminChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'welcome.test_message_sent',
    targetType: 'channel',
    targetId: channel_id,
    description: `Sent a test ${type} message to channel ${channel_id}`,
    after: { channel_id, type },
    blastRadius: 'low',
    undoReason:
      'the test message is posted in the channel for members to see, and it cannot be unsent from here — delete it in Discord instead',
  }, supabase);

  return NextResponse.json({ success: true });
}
