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
import { CSRF_COOKIE_NAME } from '@/lib/api/csrf';
import { dbError } from '@/lib/api/response';

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
    const { data: targetRole } = await admin
      .from('dashboard_roles')
      .select('priority, is_system')
      .eq('id', body.role_id)
      .eq('guild_id', ctx.guildId)
      .single();

    if (!targetRole) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }
    if (targetRole.is_system) {
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
        return NextResponse.json(
          { error: 'Cannot assign a role with higher priority than your own' },
          { status: 403 },
        );
      }
    }
    // ── End priority escalation check ────────────────────────────

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

    // V9 Audit §1.P2: Invalidate CSRF tokens after privilege change.
    // Clearing the cookie forces a re-fetch of /api/csrf, which re-derives
    // the token from the (now changed) session state.
    const resp = NextResponse.json({ success: true, data });
    resp.cookies.delete(CSRF_COOKIE_NAME);
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

    const { error } = await admin
      .from('dashboard_user_roles')
      .delete()
      .eq('id', assignmentId)
      .eq('guild_id', ctx.guildId);

    if (error) return dbError(error, 'rbac/users');

    // V9 Audit §1.P2: Invalidate CSRF tokens after privilege change.
    const resp = NextResponse.json({ success: true });
    resp.cookies.delete(CSRF_COOKIE_NAME);
    return resp;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
