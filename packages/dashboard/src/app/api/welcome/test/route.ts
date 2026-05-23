/**
 * /api/welcome/test — Send a test welcome or goodbye message to a channel.
 *
 * POST: Inserts a `test_welcome` action into bot_action_queue.
 * The bot picks it up, renders the template with mock data, and sends it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

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

  return NextResponse.json({ success: true });
}
