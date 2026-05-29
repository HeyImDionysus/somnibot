/**
 * /api/welcome — GET/PUT welcome + goodbye configuration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { typedPick } from '@/lib/api/typed-pick';
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('guild_config')
    .select(
      'welcome_enabled, welcome_channel_id, welcome_message, welcome_card_enabled, ' +
      'welcome_card_background, welcome_dm_enabled, welcome_dm_message, welcome_auto_roles, ' +
      'goodbye_enabled, goodbye_channel_id, goodbye_message',
    )
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.welcome.config);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const allowed = typedPick(body, ['welcome_enabled', 'welcome_channel_id', 'welcome_message', 'welcome_card_enabled', 'welcome_card_background', 'welcome_dm_enabled', 'welcome_dm_message', 'welcome_auto_roles', 'goodbye_enabled', 'goodbye_channel_id', 'goodbye_message']);

  const { error } = await supabase
    .from('guild_config')
    .update(allowed)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('welcome', allowed);

  return NextResponse.json({ success: true });
}
