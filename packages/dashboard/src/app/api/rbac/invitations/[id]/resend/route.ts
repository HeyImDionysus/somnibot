/**
 * POST /api/rbac/invitations/[id]/resend — re-queue one pending invitation.
 *
 * Resending is an operator retry of delivery, not a new invitation. The
 * partial unique index therefore remains untouched and the invitation's
 * original expiry clock is preserved. A disabled DM setting is honored at the
 * point of retry and records a dashboard-only delivery instead of queueing a
 * message that the bot must suppress later.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { loadTeamConfig, writeTeamAudit } from '@/lib/team-invitations';

interface InvitationRow {
  id: string;
  guild_id: string;
  discord_id: string;
  role_id: string;
  status: string;
  expires_at: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_team');
    const { id } = await params;
    const admin = createAdminSupabase();
    const now = new Date().toISOString();
    const config = await loadTeamConfig(admin, ctx.guildId);

    // This compare-and-set is the resend fence: accepted/revoked/expired rows
    // cannot be reopened and the persisted expires_at value never moves.
    const { data, error } = await admin
      .from('team_invitations')
      .update({
        dm_status: config.inviteDmEnabled ? 'queued' : 'skipped',
        delivery_mode: config.inviteDmEnabled ? null : 'dashboard',
      })
      .eq('id', id)
      .eq('guild_id', ctx.guildId)
      .eq('status', 'pending')
      .gt('expires_at', now)
      .select('id, guild_id, discord_id, role_id, status, expires_at')
      .maybeSingle();

    if (error) return dbError(error, 'rbac/invitations:resend');
    const invitation = (data ?? null) as InvitationRow | null;
    if (!invitation) {
      return NextResponse.json(
        {
          error: 'That invitation is no longer pending, so it cannot be resent.',
          message: 'Send a fresh invitation if the previous one has expired or been closed.',
        },
        { status: 409 },
      );
    }

    const mode = config.inviteDmEnabled ? 'dm' : 'dashboard';
    await writeTeamAudit(admin, {
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'team.invite_resent',
      targetId: invitation.discord_id,
      details: {
        invitation_id: invitation.id,
        role_id: invitation.role_id,
        delivery_mode: mode,
        expires_at: invitation.expires_at,
      },
      // Resends are separate append-only events, but remain grouped with the
      // invitation's lifecycle in the audit rail.
      correlationId: `team-invitation:${invitation.id}`,
      occurrenceKey: `team.invite_resent:${invitation.id}:${now}`,
    });

    return NextResponse.json({
      success: true,
      mode,
      message: mode === 'dm'
        ? 'The invitation is queued for one more DM attempt.'
        : 'The invitation remains available on dashboard sign-in; DMs are disabled.',
      data: invitation,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
