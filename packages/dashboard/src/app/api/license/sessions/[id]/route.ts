/**
 * DELETE /api/license/sessions/[id] — Remotely revoke a device session (admin).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { id: sessionId } = await params;
  const supabase = createAdminSupabase();

  // V47-C2: license_sessions has no guild_id column — verify ownership via
  // its parent license_keys row before deactivating. Otherwise any guild
  // owner could remotely kill another guild's user sessions by UUID guess.
  const { data: session } = await supabase
    .from('license_sessions')
    .select('id, license_keys!inner(guild_id)')
    .eq('id', sessionId)
    .eq('license_keys.guild_id', guildId)
    .maybeSingle();

  if (!session) {
    return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
  }

  const { error } = await supabase
    .from('license_sessions')
    .update({
      active: false,
      deactivated_at: new Date().toISOString(),
      deactivation_reason: 'admin_revoked',
    })
    .eq('id', sessionId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
