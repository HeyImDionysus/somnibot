/**
 * DELETE /api/license/sessions/[id] — Remotely revoke a device session (admin).
 *
 * V7 Audit §7.P2a — Added Zod validation for path parameter.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

const sessionIdSchema = z.string().uuid('Session ID must be a valid UUID');

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { id: rawId } = await params;
  const parsed = sessionIdSchema.safeParse(rawId);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid session ID format' },
      { status: 400 },
    );
  }
  const sessionId = parsed.data;
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
    return dbError(error, 'license/sessions');
  }

  return NextResponse.json({ success: true });
}
