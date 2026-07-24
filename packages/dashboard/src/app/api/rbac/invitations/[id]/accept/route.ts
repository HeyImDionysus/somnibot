/**
 * POST /api/rbac/invitations/[id]/accept — Accept a dashboard-team invitation.
 *
 * Acceptance binds to the invitation's discord_id: the signed-in session's
 * Discord OAuth identity must equal the invited discord_id exactly (catalog
 * permission `accept-own-invitation`; `accept-foreign-invitation` is deny). A
 * mismatched or unknown id yields 404 with no information leak.
 *
 * The transition is claimed atomically (pending → accepted) BEFORE the role
 * assignment is written, so a concurrent revoke settles in exactly one terminal
 * state and no assignment is ever created for a revoked/expired invitation. The
 * assignment insert is idempotent on UNIQUE(guild_id, discord_id, role_id), so
 * a replayed/retried acceptance converges to exactly one grant.
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { invalidateCsrfCookies } from '@/lib/api/csrf';
import { dbError } from '@/lib/api/response';
import { writeTeamAudit } from '@/lib/team-invitations';
import { requireAuth } from '@/lib/api/require-owner';
import type { SupabaseClient } from '@supabase/supabase-js';

interface InvitationRow {
  id: string;
  guild_id: string;
  discord_id: string;
  role_id: string;
  status: string;
  invited_by: string | null;
  expires_at: string;
}

/**
 * Ensure the dashboard_user_roles assignment exists (discord-keyed insert). A
 * UNIQUE(guild_id, discord_id, role_id) violation (23505) means the grant
 * already exists — idempotent success, not an error.
 */
async function ensureAssignment(
  admin: SupabaseClient,
  inv: InvitationRow,
): Promise<{ ok: true; error?: undefined } | { ok: false; error: { message: string } }> {
  const { error } = await admin.from('dashboard_user_roles').insert({
    guild_id: inv.guild_id,
    discord_id: inv.discord_id,
    role_id: inv.role_id,
    assigned_by: inv.invited_by ?? inv.discord_id,
  });
  if (error && (error as { code?: string }).code !== '23505') {
    return { ok: false, error };
  }
  return { ok: true };
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
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    // Already accepted → idempotent: re-ensure the assignment and report success.
    if (inv.status === 'accepted') {
      const ensured = await ensureAssignment(admin, inv);
      if (!ensured.ok) return dbError(ensured.error, 'rbac/invitations:accept');
      return NextResponse.json({ success: true, alreadyAccepted: true });
    }

    if (inv.status === 'revoked') {
      return NextResponse.json({ error: 'This invitation was revoked' }, { status: 409 });
    }
    if (inv.status === 'expired' || new Date(inv.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: 'This invitation has expired' }, { status: 409 });
    }
    if (inv.status !== 'pending') {
      return NextResponse.json({ error: 'This invitation is no longer acceptable' }, { status: 409 });
    }

    const now = new Date().toISOString();

    // Claim the invitation atomically. accept_notified=false lets the bot
    // sweeper mirror the acceptance to the owner exactly once.
    const { data: claimed, error: claimError } = await admin
      .from('team_invitations')
      .update({ status: 'accepted', accepted_at: now, responded_at: now, accept_notified: false })
      .eq('id', inv.id)
      .eq('discord_id', session.discordId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (claimError) return dbError(claimError, 'rbac/invitations:accept');

    if (!claimed) {
      // Lost a race (revoked/expired concurrently, or another tab accepted).
      const { data: fresh } = await admin
        .from('team_invitations')
        .select('status')
        .eq('id', inv.id)
        .maybeSingle();
      const status = (fresh as { status?: string } | null)?.status;
      if (status === 'accepted') {
        const ensured = await ensureAssignment(admin, inv);
        if (!ensured.ok) return dbError(ensured.error, 'rbac/invitations:accept');
        return NextResponse.json({ success: true, alreadyAccepted: true });
      }
      if (status === 'revoked') {
        return NextResponse.json({ error: 'This invitation was revoked' }, { status: 409 });
      }
      return NextResponse.json({ error: 'This invitation has expired' }, { status: 409 });
    }

    // Grant the role (idempotent). If this transiently fails the invitation is
    // already 'accepted', so a retried accept re-enters via the already-accepted
    // branch and re-ensures the assignment — converging to exactly one grant.
    const ensured = await ensureAssignment(admin, inv);
    if (!ensured.ok) return dbError(ensured.error, 'rbac/invitations:accept');

    await writeTeamAudit(admin, {
      guildId: inv.guild_id,
      actorId: session.discordId,
      action: 'team.invite_accepted',
      targetId: session.discordId,
      details: { invitation_id: inv.id, role_id: inv.role_id, invited_by: inv.invited_by },
    });

    // The accepting user's own permissions changed — clear their CSRF cookies so
    // a stale tab cannot keep passing a pre-change token via the rotation grace.
    const resp = NextResponse.json({
      success: true,
      data: { invitation_id: inv.id, role_id: inv.role_id, guild_id: inv.guild_id },
    });
    invalidateCsrfCookies(resp);
    return resp;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
