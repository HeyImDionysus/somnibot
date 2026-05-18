/**
 * /api/onboarding — GET/PUT onboarding configuration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';


export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('guild_config')
    .select(
      'member_role_id, onboarding_enabled, interest_role_mapping, ' +
      'returning_member_skip_welcome_dm, returning_member_restore_entitlements, returning_member_restore_levels',
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
  const parsed = await parseBody(req, schemas.onboarding.config);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as Record<string, unknown>;

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
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
