/**
 * /api/onboarding — GET/PUT onboarding configuration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('guild_config')
    .select(
      'member_role_id, onboarding_enabled, interest_role_mapping, ' +
      'returning_member_skip_welcome_dm, returning_member_restore_entitlements, returning_member_restore_levels',
    )
    .eq('guild_id', GUILD_ID)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const supabase = createAdminSupabase();
  const body = await req.json();

  // Whitelist allowed fields
  const allowed: Record<string, unknown> = {};
  const fields = [
    'member_role_id', 'onboarding_enabled', 'interest_role_mapping',
    'returning_member_skip_welcome_dm', 'returning_member_restore_entitlements',
    'returning_member_restore_levels',
  ];

  for (const key of fields) {
    if (key in body) allowed[key] = body[key];
  }

  const { error } = await supabase
    .from('guild_config')
    .update(allowed)
    .eq('guild_id', GUILD_ID);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
