/**
 * /api/onboarding — GET/PUT onboarding configuration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('guild_config')
    .select(
      'member_role_id, onboarding_enabled, interest_role_mapping, ' +
      'returning_member_skip_welcome_dm, returning_member_restore_entitlements, returning_member_restore_levels, ' +
      'onboarding_config',
    )
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const body = await req.json();

  // Whitelist allowed fields
  const allowed: Record<string, unknown> = {};
  const fields = [
    'member_role_id', 'onboarding_enabled', 'interest_role_mapping',
    'returning_member_skip_welcome_dm', 'returning_member_restore_entitlements',
    'returning_member_restore_levels', 'onboarding_config',
  ];

  for (const key of fields) {
    if (key in body) allowed[key] = body[key];
  }

  const { error } = await supabase
    .from('guild_config')
    .upsert({ guild_id: guildId, ...allowed }, { onConflict: 'guild_id' });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('onboarding', allowed);

  return NextResponse.json({ success: true });
}
