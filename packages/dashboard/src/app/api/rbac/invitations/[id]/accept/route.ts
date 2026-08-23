/**
 * POST /api/rbac/invitations/[id]/accept — Accept a dashboard-team invitation.
 *
 * Acceptance binds to the invitation's discord_id: the signed-in session's
 * Discord OAuth identity must equal the invited discord_id exactly (catalog
 * permission `accept-own-invitation`; `accept-foreign-invitation` is deny). A
 * mismatched or unknown id yields 404 with no information leak.
 *
 * A database function locks the invitation and writes the role assignment plus
 * pending → accepted transition in one transaction. A concurrent revoke can
 * therefore win exactly one terminal state, and a transient grant failure rolls
 * the entire acceptance back to pending for a safe retry.
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { invalidateCsrfCookies } from '@/lib/api/csrf';
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

interface AtomicAcceptRow {
  outcome: 'accepted' | 'already_accepted' | 'declined' | 'expired' | 'revoked' | 'not_found';
  invitation_id: string | null;
  guild_id: string | null;
  role_id: string | null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    // requireAuth validates the signed-in Supabase/Discord session; CSRF is enforced
    // by middleware for this (non-exempt) mutating route. Acceptance still binds to the
    // invitation's discord_id below, so a member can only accept their OWN invitation.
    const auth = await requireAuth();
    if (!auth.ok) return auth.response;
    if (!auth.discordId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (auth.localGuildIds?.length) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }
    const session = { discordId: auth.discordId };

    const { id } = await params;
    const admin = createAdminSupabase();

    const { data: rawInv } = await admin
      .from('team_invitations')
      .select('id, guild_id, discord_id, role_id, status, invited_by, expires_at')
      .eq('id', id)
      .maybeSingle();
    const inv = (rawInv ?? null) as InvitationRow | null;

    // Not found OR foreign → 404, no information leak (token guessing yields
    // nothing distinguishable from a nonexistent invitation).
    if (!inv || inv.discord_id !== session.discordId) {
      if (inv) {
        await writeTeamAudit(admin, {
          guildId: inv.guild_id,
          actorId: session.discordId,
          action: 'team.invite_accept_denied',
          targetId: inv.discord_id,
          details: { invitation_id: inv.id, reason: 'foreign_invitation' },
          correlationId: `team-invitation:${inv.id}`,
          success: false,
        });
      }
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    const { data: rawOutcome, error: acceptError } = await admin.rpc(
      'accept_team_invitation_atomic',
      { p_invitation_id: inv.id, p_discord_id: session.discordId },
    );
    if (acceptError) return dbError(acceptError, 'rbac/invitations:accept');

    const outcome = (Array.isArray(rawOutcome) ? rawOutcome[0] : rawOutcome) as AtomicAcceptRow | null;
    if (!outcome || outcome.outcome === 'not_found') {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }
    if (outcome.outcome === 'already_accepted') {
      return NextResponse.json({
        success: true,
        alreadyAccepted: true,
        message: 'You already accepted this invitation — your dashboard access is unchanged.',
      });
    }
    if (outcome.outcome === 'revoked') {
      return NextResponse.json({ error: 'This invitation was revoked' }, { status: 409 });
    }
    if (outcome.outcome === 'expired') {
      return NextResponse.json({ error: 'This invitation has expired' }, { status: 409 });
    }
    if (outcome.outcome !== 'accepted') {
      return NextResponse.json({ error: 'This invitation is no longer acceptable' }, { status: 409 });
    }

    // The accepting user's own permissions changed — clear their CSRF cookies so
    // a stale tab cannot keep passing a pre-change token via the rotation grace.
    const resp = NextResponse.json({
      success: true,
      data: {
        invitation_id: outcome.invitation_id,
        role_id: outcome.role_id,
        guild_id: outcome.guild_id,
      },
    });
    invalidateCsrfCookies(resp);
    return resp;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
