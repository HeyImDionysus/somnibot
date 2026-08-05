/**
 * GET /api/rbac/users — List all users with dashboard roles.
 * POST /api/rbac/users — Assign a role to a user.
 * DELETE /api/rbac/users — Remove a role from a user.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { invalidateCsrfCookies } from '@/lib/api/csrf';
import { dbError } from '@/lib/api/response';
import { loadTeamConfig, writeTeamAudit } from '@/lib/team-invitations';
import { writeRbacAudit, raiseEscalationBlockedAlert } from '@/lib/rbac-audit';
import { recordAdminChange } from '@/lib/admin-changes';

const rbacUserAssign = z.object({
  discord_id: z.string().regex(/^\d{17,20}$/, 'Must be a Discord snowflake ID'),
  role_id: z.string().uuid(),
});

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_team');
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('dashboard_user_roles')
      .select('*, dashboard_roles(name, description, permissions, priority)')
      .eq('guild_id', ctx.guildId)
      .order('assigned_at', { ascending: false })
      .limit(500);

    if (error) return dbError(error, 'rbac/users');

    // Group by discord_id
    const usersMap = new Map<string, { discord_id: string; roles: unknown[] }>();
    for (const entry of data || []) {
      const existing = usersMap.get(entry.discord_id);
      if (existing) {
        existing.roles.push({
          assignment_id: entry.id,
          role: (entry as Record<string, unknown>).dashboard_roles,
          assigned_at: entry.assigned_at,
          assigned_by: entry.assigned_by,
        });
      } else {
        usersMap.set(entry.discord_id, {
          discord_id: entry.discord_id,
          roles: [{
            assignment_id: entry.id,
            role: (entry as Record<string, unknown>).dashboard_roles,
            assigned_at: entry.assigned_at,
            assigned_by: entry.assigned_by,
          }],
        });
      }
    }

    return NextResponse.json({ success: true, data: Array.from(usersMap.values()) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_team');
    const parsed = await parseBody(request, rbacUserAssign);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

    // ── V5 Audit §1.2: Prevent priority escalation ──────────────
    // Fetch the target role's priority and is_system flag.
    // A user must not assign a role with higher priority than their own.
    //
    // `name` is fetched by the same query (no extra round trip) so the recorded
    // admin change can name the role in plain English instead of printing a
    // UUID at the owner. Nothing else is read: `permissions` is the role's own
    // configuration, already recorded by /api/rbac/roles, and copying it onto
    // every grant would multiply the permission list across the change log.
    const { data: targetRole } = await admin
      .from('dashboard_roles')
      .select('name, priority, is_system')
      .eq('id', body.role_id)
      .eq('guild_id', ctx.guildId)
      .single();

    if (!targetRole) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }
    if (targetRole.is_system) {
      await writeRbacAudit(admin, {
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        action: 'rbac.role_assign_denied',
        targetType: 'member',
        targetId: body.discord_id,
        details: { reason: 'system_role', roleId: body.role_id },
        success: false,
      });
      await raiseEscalationBlockedAlert(admin, {
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        attemptedAction: 'assign system role',
        targetRoleId: body.role_id,
        reason: 'system roles cannot be assigned via the dashboard',
      });
      return NextResponse.json({ error: 'Cannot assign system roles' }, { status: 403 });
    }

    // Owner bypasses priority check
    if (!ctx.isOwner) {
      const { data: assignerRoles } = await admin
        .from('dashboard_user_roles')
        .select('dashboard_roles(priority)')
        .eq('guild_id', ctx.guildId)
        .eq('discord_id', ctx.discordId);

      const assignerMaxPriority = Math.max(
        0,
        ...(assignerRoles || []).map((r) => {
          const role = r.dashboard_roles as unknown as { priority: number } | null;
          return role?.priority ?? 0;
        }),
      );

      if (targetRole.priority > assignerMaxPriority) {
        await writeRbacAudit(admin, {
          guildId: ctx.guildId,
          actorId: ctx.discordId,
          action: 'rbac.role_assign_denied',
          targetType: 'member',
          targetId: body.discord_id,
          details: {
            reason: 'priority_escalation',
            roleId: body.role_id,
            targetPriority: targetRole.priority,
            assignerMaxPriority,
          },
          success: false,
        });
        await raiseEscalationBlockedAlert(admin, {
          guildId: ctx.guildId,
          actorId: ctx.discordId,
          attemptedAction: 'assign higher-priority role',
          targetRoleId: body.role_id,
          reason: `target priority ${targetRole.priority} exceeds assigner max ${assignerMaxPriority}`,
        });
        return NextResponse.json(
          { error: 'Cannot assign a role with higher priority than your own' },
          { status: 403 },
        );
      }
    }
    // ── End priority escalation check ────────────────────────────

    // Plain-English name for the role in every recorded change below.
    const roleLabel = ((targetRole as { name?: unknown }).name as string | undefined)
      ?? body.role_id;

    // ── Consent-based invitation model ───────────────────────────
    // The catalog contracts consent-based invitations with
    // direct-assignment-enabled defaulting to false: a manage_team user invites
    // a member to a role and the member gains permissions only upon acceptance.
    // Only when the owner explicitly enables direct-assignment do we write a
    // LIVE role assignment here without the invitee's consent.
    const teamConfig = await loadTeamConfig(admin, ctx.guildId);

    if (!teamConfig.directAssignmentEnabled) {
      // Idempotency guard: if the member already holds this role live, there is
      // nothing to invite them to.
      const { data: existingAssignment } = await admin
        .from('dashboard_user_roles')
        .select('id')
        .eq('guild_id', ctx.guildId)
        .eq('discord_id', body.discord_id)
        .eq('role_id', body.role_id)
        .maybeSingle();
      if (existingAssignment) {
        return NextResponse.json(
          { error: 'That member already holds this role' },
          { status: 409 },
        );
      }

      // Honor max-pending-invitations (per guild).
      const { count: pendingCount } = await admin
        .from('team_invitations')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', ctx.guildId)
        .eq('status', 'pending');
      if ((pendingCount ?? 0) >= teamConfig.maxPendingInvitations) {
        return NextResponse.json(
          {
            error: `The pending-invitation limit (${teamConfig.maxPendingInvitations}) has been reached. Revoke or wait for existing invitations to resolve.`,
          },
          { status: 409 },
        );
      }

      const expiresAt = new Date(Date.now() + teamConfig.invitationExpiryMs).toISOString();
      const { data: invitation, error: inviteError } = await admin
        .from('team_invitations')
        .insert({
          guild_id: ctx.guildId,
          discord_id: body.discord_id,
          role_id: body.role_id,
          status: 'pending',
          // invite-dm-enabled drives whether the bot sweeper attempts a DM; when
          // off, the invitation is dashboard-only from the start.
          dm_status: teamConfig.inviteDmEnabled ? 'queued' : 'skipped',
          delivery_mode: teamConfig.inviteDmEnabled ? null : 'dashboard',
          invited_by: ctx.discordId,
          expires_at: expiresAt,
        })
        .select('*, dashboard_roles(name)')
        .single();

      if (inviteError) {
        // 23505 → a pending invitation for this (guild, member, role) already
        // exists (the partial unique index). Surface it as a clean conflict.
        if ((inviteError as { code?: string }).code === '23505') {
          return NextResponse.json(
            { error: 'A pending invitation for this member and role already exists' },
            { status: 409 },
          );
        }
        return dbError(inviteError, 'rbac/users:invite');
      }

      await writeTeamAudit(admin, {
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        action: 'team.invite_sent',
        targetId: body.discord_id,
        details: {
          invitation_id: (invitation as { id?: string })?.id,
          role_id: body.role_id,
          dm_enabled: teamConfig.inviteDmEnabled,
          expires_at: expiresAt,
        },
        correlationId: `team-invitation:${(invitation as { id?: string })?.id ?? body.discord_id}`,
        occurrenceKey: `team.invite_sent:${(invitation as { id?: string })?.id ?? body.discord_id}`,
      });

      // [security] Only the invitation's own lifecycle fields are recorded.
      // team_invitations carries no accept code — acceptance binds to the
      // invitee's signed-in Discord identity (see the accept route) — and the
      // whole row is never copied here, so a future code/token column cannot
      // leak into a page every manage_team holder can read.
      await recordAdminChange({
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        action: 'team.invite_sent',
        targetType: 'dashboard team invitation',
        targetId: (invitation as { id?: string } | null)?.id ?? null,
        description:
          `Invited ${body.discord_id} to the "${roleLabel}" dashboard role — `
          + 'they get access only once they accept',
        after: {
          discord_id: body.discord_id,
          role: roleLabel,
          status: 'pending',
          expires_at: expiresAt,
        },
        blastRadius: 'high',
        undoReason:
          'the invitation has already been sent — revoke it from the Team page instead, which the member is not notified about',
      }, admin);

      const inviteResp = NextResponse.json({
        success: true,
        mode: 'invitation',
        data: invitation,
      });
      invalidateCsrfCookies(inviteResp);
      return inviteResp;
    }

    // ── Direct assignment (owner opt-in) ─────────────────────────
    const { data, error } = await admin
      .from('dashboard_user_roles')
      .insert({
        guild_id: ctx.guildId,
        discord_id: body.discord_id,
        role_id: body.role_id,
        assigned_by: ctx.discordId,
      })
      .select('*, dashboard_roles(name)')
      .single();

    if (error) return dbError(error, 'rbac/users');

    await writeTeamAudit(admin, {
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'team.role_assigned',
      targetId: body.discord_id,
      details: { role_id: body.role_id, direct: true },
      correlationId: `team-role:${ctx.guildId}:${body.discord_id}:${body.role_id}`,
      occurrenceKey: `team.role_assigned:${ctx.guildId}:${body.discord_id}:${body.role_id}`,
    });
    // Owner alert: a live dashboard-role grant is a security-relevant privilege
    // change the owner should see (grant/revoke parity).
    try {
      await admin.from('alerts').insert({
        guild_id: ctx.guildId,
        alert_type: 'team_role_granted',
        severity: 'warning',
        title: 'Dashboard team access granted',
        message: `${ctx.discordId} directly assigned a dashboard role to ${body.discord_id}.`,
        metadata: { actor_id: ctx.discordId, target_id: body.discord_id, role_id: body.role_id },
      });
    } catch {
      // owner-alert mirror is best-effort
    }

    await recordAdminChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'team.role_assigned',
      targetType: 'dashboard team member',
      targetId: body.discord_id,
      description:
        `Gave ${body.discord_id} the "${roleLabel}" dashboard role, which takes effect immediately`,
      after: {
        discord_id: body.discord_id,
        role: roleLabel,
        assigned_by: ctx.discordId,
      },
      // Live dashboard access granted without the member's consent.
      blastRadius: 'critical',
      undoReason:
        'a granted dashboard role cannot be taken back by an undo — revoke it from the Team page instead',
    }, admin);

    // V9 Audit §1.P2: Invalidate CSRF tokens after privilege change.
    // Clearing the cookies forces a re-fetch of /api/csrf, which re-derives
    // the token from the (now changed) session state. Both the current and the
    // rotation `prev` cookie are cleared — otherwise a tab that rotated within
    // the last grace window could keep passing its pre-change token via `prev`.
    const resp = NextResponse.json({ success: true, mode: 'direct', data });
    invalidateCsrfCookies(resp);
    return resp;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_team');
    const { searchParams } = new URL(request.url);
    const assignmentId = searchParams.get('id');
    if (!assignmentId) return NextResponse.json({ error: 'Missing assignment ID' }, { status: 400 });

    const admin = createAdminSupabase();

    // RETURNING carries the removed row out of the delete, so the "before"
    // state is captured by the mutation itself rather than by a second read
    // that could race it. The role name is embedded (same call, no extra round
    // trip) so the recorded change reads as a sentence and not a UUID.
    const { data: removed, error } = await admin
      .from('dashboard_user_roles')
      .delete()
      .eq('id', assignmentId)
      .eq('guild_id', ctx.guildId)
      .select('discord_id, role_id, assigned_by, dashboard_roles(name)')
      .maybeSingle();

    if (error) return dbError(error, 'rbac/users');

    // Audit the revoke (previously the DELETE path wrote no audit_logs row) and
    // page the owner — a team member losing dashboard access is a
    // security-relevant privilege change.
    const revoked = (removed ?? null) as {
      discord_id?: string;
      role_id?: string;
      assigned_by?: string | null;
      dashboard_roles?: { name?: string } | null;
    } | null;
    await writeTeamAudit(admin, {
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'team.role_revoked',
      targetId: revoked?.discord_id ?? null,
      details: { assignment_id: assignmentId, role_id: revoked?.role_id ?? null },
      correlationId: `team-role:${ctx.guildId}:${assignmentId}`,
      occurrenceKey: `team.role_revoked:${ctx.guildId}:${assignmentId}`,
    });
    if (revoked?.discord_id) {
      try {
        await admin.from('alerts').insert({
          guild_id: ctx.guildId,
          alert_type: 'team_role_revoked',
          severity: 'warning',
          title: 'Dashboard team access revoked',
          message: `${ctx.discordId} revoked a dashboard role from ${revoked.discord_id}.`,
          metadata: { actor_id: ctx.discordId, target_id: revoked.discord_id, role_id: revoked.role_id },
        });
      } catch {
        // owner-alert mirror is best-effort
      }
    }

    if (revoked) {
      const revokedRole = revoked.dashboard_roles?.name ?? revoked.role_id ?? 'dashboard';
      await recordAdminChange({
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        action: 'team.role_revoked',
        targetType: 'dashboard team member',
        targetId: revoked.discord_id ?? assignmentId,
        description:
          `Removed the "${revokedRole}" dashboard role from ${revoked.discord_id ?? 'a team member'}, `
          + 'ending their dashboard access through it',
        before: {
          discord_id: revoked.discord_id ?? null,
          role: revokedRole,
          assigned_by: revoked.assigned_by ?? null,
        },
        blastRadius: 'high',
        undoReason:
          'the assignment row was deleted, so there is nothing to restore into — grant the role again from the Team page',
      }, admin);
    }

    // V9 Audit §1.P2: Invalidate CSRF tokens after privilege change. Clears both
    // the current and rotation `prev` cookie so a stale tab cannot keep passing
    // its pre-change token via the grace window.
    const resp = NextResponse.json({ success: true });
    invalidateCsrfCookies(resp);
    return resp;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
