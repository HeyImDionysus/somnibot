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
import { recordAdminChange } from '@/lib/admin-changes';

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
    //
    // [security] The returning list is an explicit column allowlist, never `*`.
    // It feeds an `admin_changes` row that the Admin Changes page renders to
    // every manage_team holder. team_invitations has no accept code today
    // (acceptance binds to the invitee's signed-in Discord identity — see the
    // accept route), and naming columns keeps it that way: a future
    // code/token column cannot be swept into the change log by accident.
    // The embedded role name is what makes the recorded sentence readable.
    const { data, error } = await admin
      .from('team_invitations')
      .update({ status: 'revoked', responded_at: new Date().toISOString() })
      .eq('id', id)
      .eq('guild_id', ctx.guildId)
      .eq('status', 'pending')
      .select('id, discord_id, role_id, dashboard_roles(name)')
      .maybeSingle();

    if (error) return dbError(error, 'rbac/invitations:revoke');
    if (!data) {
      // Either it does not exist for this guild, or it is no longer pending.
      return NextResponse.json(
        {
          error: 'That invitation is no longer pending, so there is nothing to revoke.',
          message: 'The invitation may already have been accepted, expired, or revoked.',
        },
        { status: 404 },
      );
    }

    await writeTeamAudit(admin, {
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'team.invite_revoked',
      targetId: (data as { discord_id: string }).discord_id,
      details: { invitation_id: id, role_id: (data as { role_id: string }).role_id },
      correlationId: `team-invitation:${id}`,
      occurrenceKey: `team.invite_revoked:${id}`,
    });

    const revoked = data as {
      discord_id: string;
      role_id: string;
      dashboard_roles?: { name?: string } | null;
    };
    const roleLabel = revoked.dashboard_roles?.name ?? revoked.role_id;
    await recordAdminChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'team.invite_revoked',
      targetType: 'dashboard team invitation',
      targetId: id,
      description:
        `Cancelled the pending invitation for ${revoked.discord_id} to the "${roleLabel}" dashboard role`,
      // The prior status is known exactly: the update only matched a row that
      // was still 'pending'.
      before: { discord_id: revoked.discord_id, role: roleLabel, status: 'pending' },
      after: { status: 'revoked' },
      // A pending invitation conferred no access, so cancelling it removes
      // nothing the member had.
      blastRadius: 'medium',
      undoReason:
        'a revoked invitation can never be reinstated — send a fresh invitation from the Team page',
    }, admin);

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
