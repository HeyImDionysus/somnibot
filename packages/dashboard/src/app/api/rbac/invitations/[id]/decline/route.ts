/**
 * POST /api/rbac/invitations/[id]/decline — Decline a dashboard-team invitation.
 *
 * The consent model's other half: the invited member may refuse the role.
 * Mirrors the accept endpoint's binding + atomicity contracts:
 *   - the signed-in session's Discord identity must equal the invited
 *     discord_id exactly; a mismatched or unknown id yields 404 with no
 *     information leak,
 *   - the transition is claimed atomically (pending → declined) so a concurrent
 *     accept/revoke settles in exactly one terminal state,
 *   - declining NEVER touches dashboard_user_roles (nothing was granted), and
 *   - a replayed decline is idempotent (already-declined → success).
 * An accepted invitation cannot be declined (role removal is the managers'
 * remove flow, not a decline).
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { writeTeamAudit } from '@/lib/team-invitations';
import { requireAuth } from '@/lib/api/require-owner';

interface InvitationRow {
  id: string;
  guild_id: string;
  discord_id: string;
  role_id: string;
  status: string;
  invited_by: string | null;
  expires_at: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const auth = await requireAuth();
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const admin = createAdminSupabase();

    const { data: rawInv } = await admin
      .from('team_invitations')
      .select('id, guild_id, discord_id, role_id, status, invited_by, expires_at')
      .eq('id', id)
      .maybeSingle();
    const inv = (rawInv ?? null) as InvitationRow | null;

    // Not found OR foreign → 404, no information leak.
    if (!inv || inv.discord_id !== auth.discordId) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    // Replayed decline → idempotent success.
    if (inv.status === 'declined') {
      return NextResponse.json({ success: true, alreadyDeclined: true });
    }
    if (inv.status === 'accepted') {
      return NextResponse.json(
        { error: 'This invitation was already accepted — ask a manager to remove the role instead' },
        { status: 409 },
      );
    }
    if (inv.status === 'revoked') {
      return NextResponse.json({ error: 'This invitation was revoked' }, { status: 409 });
    }
    if (inv.status !== 'pending' || new Date(inv.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: 'This invitation has expired' }, { status: 409 });
    }

    // Claim the transition atomically (pending → declined).
    const now = new Date().toISOString();
    const { data: claimed, error: claimError } = await admin
      .from('team_invitations')
      .update({ status: 'declined', responded_at: now })
      .eq('id', inv.id)
      .eq('discord_id', auth.discordId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (claimError) return dbError(claimError, 'rbac/invitations:decline');

    if (!claimed) {
      // Lost a race — report the terminal state honestly.
      const { data: fresh } = await admin
        .from('team_invitations')
        .select('status')
        .eq('id', inv.id)
        .maybeSingle();
      const status = (fresh as { status?: string } | null)?.status;
      if (status === 'declined') return NextResponse.json({ success: true, alreadyDeclined: true });
      if (status === 'accepted') {
        return NextResponse.json(
          { error: 'This invitation was already accepted — ask a manager to remove the role instead' },
          { status: 409 },
        );
      }
      if (status === 'revoked') return NextResponse.json({ error: 'This invitation was revoked' }, { status: 409 });
      return NextResponse.json({ error: 'This invitation has expired' }, { status: 409 });
    }

    await writeTeamAudit(admin, {
      guildId: inv.guild_id,
      actorId: auth.discordId ?? 'unknown',
      action: 'team.invite_declined',
      targetId: inv.discord_id,
      details: { invitation_id: inv.id, role_id: inv.role_id, invited_by: inv.invited_by },
    });

    return NextResponse.json({
      success: true,
      data: { invitation_id: inv.id, role_id: inv.role_id, guild_id: inv.guild_id },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
