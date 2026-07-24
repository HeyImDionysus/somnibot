/**
 * DELETE /api/rbac/invitations/[id] — Revoke a pending dashboard-team invitation.
 *
 * Only a dashboard.manage_team holder may revoke, and only while the invitation
 * is still pending. Revocation transitions pending → revoked atomically (a
 * conditional update scoped to the guild), so a concurrent acceptance can win
 * exactly one terminal state. A later acceptance attempt on a revoked
 * invitation then fails cleanly (see the accept route).
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { writeTeamAudit } from '@/lib/team-invitations';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_team');
    const { id } = await params;
    const admin = createAdminSupabase();

    // Atomic pending → revoked, scoped to this guild. RETURNING tells us whether
    // we actually transitioned a live pending row (vs. it being already
    // accepted/expired/revoked, or belonging to another guild).
    const { data, error } = await admin
      .from('team_invitations')
      .update({ status: 'revoked', responded_at: new Date().toISOString() })
      .eq('id', id)
      .eq('guild_id', ctx.guildId)
      .eq('status', 'pending')
      .select('id, discord_id, role_id')
      .maybeSingle();

    if (error) return dbError(error, 'rbac/invitations:revoke');
    if (!data) {
      // Either it does not exist for this guild, or it is no longer pending.
      return NextResponse.json(
        { error: 'No pending invitation found to revoke' },
        { status: 404 },
      );
    }

    await writeTeamAudit(admin, {
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'team.invite_revoked',
      targetId: (data as { discord_id: string }).discord_id,
      details: { invitation_id: id, role_id: (data as { role_id: string }).role_id },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
