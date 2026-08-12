/**
 * GET /api/rbac/roles — List all dashboard roles for this guild.
 * POST /api/rbac/roles — Create a new custom role.
 * PATCH /api/rbac/roles — Update a role's permissions.
 * DELETE /api/rbac/roles — Delete a custom role.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { writeRbacAudit, raiseEscalationBlockedAlert } from '@/lib/rbac-audit';
import { recordAdminChange, humanizeColumn } from '@/lib/admin-changes';

/**
 * Columns copied into an admin-changes before/after payload for a role.
 *
 * [security] Deliberately explicit rather than `*`. `admin_changes` rows are
 * rendered verbatim by the Admin Changes page to every manage_team holder, so
 * anything selected here becomes visible there. `permissions` IS the change an
 * owner needs to see, and `dashboard_roles` carries no token/secret column —
 * but naming the columns means a future migration cannot silently add one to
 * this payload. `guild_id` is omitted: it is tenancy, not a setting.
 */
const ROLE_RECORD_COLUMNS = 'id, is_system, name, description, permissions, priority';

/** The recorded shape of a dashboard role — no tenancy, no system flag. */
function roleState(row: Record<string, unknown> | null | undefined) {
  if (!row) return undefined;
  return {
    name: row.name ?? null,
    description: row.description ?? null,
    permissions: row.permissions ?? [],
    priority: row.priority ?? null,
  };
}

/**
 * Name the permissions in a sentence an owner can read.
 *
 * "dashboard.manage_team" is jargon; "manage team" is the thing they granted.
 * Long lists are truncated so the description stays one readable sentence.
 */
function describePermissions(permissions: string[]): string {
  if (permissions.length === 0) return 'no dashboard permissions';
  const labels = permissions.map((p) => p.replace(/^dashboard\./, '').replace(/_/g, ' '));
  if (labels.length === 1) return `permission to ${labels[0]}`;
  if (labels.length <= 3) {
    return `permission to ${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  }
  return `${labels.length} permissions including ${labels.slice(0, 3).join(', ')}`;
}

const rbacRoleCreate = z.object({
  name: z.string().min(1).max(100).trim(),
  description: z.string().max(500).optional().nullable(),
  permissions: z.array(z.string().max(128)).max(100).default([]),
  priority: z.number().int().min(0).max(999).optional(),
});

const rbacRoleUpdate = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).optional().nullable(),
  permissions: z.array(z.string().max(128)).max(100).optional(),
  priority: z.number().int().min(0).max(999).optional(),
});

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_team');
    const admin = createAdminSupabase();

    const { data: roles, error } = await admin
      .from('dashboard_roles')
      .select('*, dashboard_user_roles(count)')
      .eq('guild_id', ctx.guildId)
      .order('priority', { ascending: false })
      .limit(500);

    if (error) return dbError(error, 'rbac/roles');

    return NextResponse.json({ success: true, data: roles });
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
    const parsed = await parseBody(request, rbacRoleCreate);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();
    const { data: config } = await admin
      .from('guild_config')
      .select('rbac_custom_role_priority_default, rbac_max_permissions_per_role, rbac_priority_escalation_guard')
      .eq('guild_id', ctx.guildId)
      .maybeSingle();
    const configuredMax = Number(config?.rbac_max_permissions_per_role);
    const maxPermissions = Number.isInteger(configuredMax) ? Math.min(500, Math.max(1, configuredMax)) : 100;
    const configuredDefault = Number(config?.rbac_custom_role_priority_default);
    const defaultPriority = Number.isInteger(configuredDefault) ? Math.min(999, Math.max(0, configuredDefault)) : 10;
    if (body.permissions && body.permissions.length > maxPermissions) {
      return NextResponse.json({ error: `A role may contain at most ${maxPermissions} permissions` }, { status: 400 });
    }
    if (config?.rbac_priority_escalation_guard !== false && !ctx.isOwner && body.priority !== undefined && body.priority > defaultPriority) {
      return NextResponse.json({ error: 'Role priority escalation is restricted to the owner' }, { status: 403 });
    }

    const { data, error } = await admin
      .from('dashboard_roles')
      .insert({
        guild_id: ctx.guildId,
        name: body.name,
        description: body.description || null,
        permissions: body.permissions || [],
        is_system: false,
        priority: body.priority ?? defaultPriority,
      })
      .select()
      .single();

    if (error) return dbError(error, 'rbac/roles');

    await writeRbacAudit(admin, {
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'rbac.role_created',
      targetId: (data as { id?: string })?.id ?? null,
      details: { name: body.name, permissions: body.permissions || [], priority: body.priority ?? defaultPriority },
    });

    // A new role is a permission-model change, so the owner sees it on the
    // Admin Changes page and not only in the (staff-facing) audit log.
    await recordAdminChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'rbac.role_created',
      targetType: 'dashboard role',
      targetId: (data as { id?: string } | null)?.id ?? null,
      description:
        `Created the dashboard role "${body.name}", which grants `
        + `${describePermissions(body.permissions ?? [])}`,
      after: roleState({
        name: body.name,
        description: body.description || null,
        permissions: body.permissions || [],
        priority: body.priority ?? defaultPriority,
      }),
      blastRadius: 'high',
      undoReason:
        'a newly created dashboard role cannot be removed by an undo — delete it from the Team page instead',
    }, admin);

    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function PATCH(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_team');
    const parsed = await parseBody(request, rbacRoleUpdate);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();
    const { data: config } = await admin
      .from('guild_config')
      .select('rbac_max_permissions_per_role, rbac_custom_role_priority_default, rbac_priority_escalation_guard')
      .eq('guild_id', ctx.guildId)
      .maybeSingle();
    const configuredMax = Number(config?.rbac_max_permissions_per_role);
    const maxPermissions = Number.isInteger(configuredMax) ? Math.min(500, Math.max(1, configuredMax)) : 100;
    if (body.permissions && body.permissions.length > maxPermissions) {
      return NextResponse.json({ error: `A role may contain at most ${maxPermissions} permissions` }, { status: 400 });
    }
    const configuredDefault = Number(config?.rbac_custom_role_priority_default);
    const defaultPriority = Number.isInteger(configuredDefault) ? Math.min(999, Math.max(0, configuredDefault)) : 10;
    if (config?.rbac_priority_escalation_guard !== false && !ctx.isOwner && body.priority !== undefined && body.priority > defaultPriority) {
      return NextResponse.json({ error: 'Role priority escalation is restricted to the owner' }, { status: 403 });
    }

    // V5 Audit §1.6: Block modification of ALL system roles, not just owner.
    // System roles (owner, admin, moderator) define the baseline permission
    // model. Allowing edits to non-owner system roles would let a user with
    // manage_team escalate by adding permissions to e.g. the admin role.
    //
    // This one read serves two purposes and MUST stay before the update: it
    // enforces the guard AND supplies the recorded change's "before" state.
    // Capturing prior values after the write would record the new values twice.
    // It is scoped to the caller's guild — without that, naming a foreign role
    // id would copy another guild's role name and permission list into this
    // guild's Admin Changes page.
    const { data: existingRow } = await admin
      .from('dashboard_roles')
      .select(ROLE_RECORD_COLUMNS)
      .eq('id', body.id)
      .eq('guild_id', ctx.guildId)
      .single();
    const existing = (existingRow ?? null) as Record<string, unknown> | null;

    if (existing?.is_system) {
      // Editing a system role would let a manage_team holder widen the
      // baseline permission model — a privilege-escalation attempt. Audit it
      // and page the owner.
      await writeRbacAudit(admin, {
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        action: 'rbac.role_update_denied',
        targetId: body.id,
        details: { reason: 'system_role_immutable', roleName: existing.name },
        success: false,
      });
      await raiseEscalationBlockedAlert(admin, {
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        attemptedAction: 'modify system role',
        targetRoleId: body.id,
        reason: `system role "${String(existing.name)}" is immutable`,
      });
      return NextResponse.json(
        { error: `Cannot modify system role "${String(existing.name)}"` },
        { status: 403 },
      );
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.permissions !== undefined) updates.permissions = body.permissions;
    if (body.priority !== undefined) updates.priority = body.priority;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await admin
      .from('dashboard_roles')
      .update(updates)
      .eq('id', body.id)
      .eq('guild_id', ctx.guildId)
      .select()
      .single();

    if (error) return dbError(error, 'rbac/roles');

    await writeRbacAudit(admin, {
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'rbac.role_updated',
      targetId: body.id,
      details: { changes: updates },
    });

    const changedKeys = Object.keys(updates).filter((k) => k !== 'updated_at');
    const permissionsChanged = body.permissions !== undefined;
    const roleLabel = (existing?.name as string | undefined) ?? 'dashboard role';
    await recordAdminChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'rbac.role_updated',
      targetType: 'dashboard role',
      targetId: body.id,
      description: permissionsChanged
        ? `Changed what the "${roleLabel}" dashboard role can do — it now grants `
          + `${describePermissions(body.permissions ?? [])}`
        : `Updated the "${roleLabel}" dashboard role `
          + `(${changedKeys.map(humanizeColumn).join(', ')})`,
      before: roleState(existing),
      after: Object.fromEntries(changedKeys.map((k) => [k, updates[k]])),
      // Widening what a role can do is the escalation path this route guards;
      // the owner should be prompted before anything replays it.
      blastRadius: permissionsChanged ? 'critical' : 'high',
      // `dashboard_roles` is deliberately absent from UNDO_TABLE_COLUMNS, so a
      // db undo would be rejected at click time. Say so honestly instead of
      // rendering a button that fails — and a one-click permission restore is
      // not something this system should offer anyway.
      undoReason:
        'dashboard permissions are never restored automatically — set them back from the Team page so the change is deliberate',
    }, admin);

    return NextResponse.json({ success: true, data });
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
    const roleId = searchParams.get('id');
    if (!roleId) return NextResponse.json({ error: 'Missing role ID' }, { status: 400 });

    const admin = createAdminSupabase();

    // Can't delete system roles. Read BEFORE the delete: this is the only
    // remaining description of what the role was once the row is gone, so it
    // doubles as the recorded change's before-state. Guild-scoped so a foreign
    // role's permissions can never be copied into this guild's change log.
    const { data: existingRow } = await admin
      .from('dashboard_roles')
      .select(ROLE_RECORD_COLUMNS)
      .eq('id', roleId)
      .eq('guild_id', ctx.guildId)
      .single();
    const existing = (existingRow ?? null) as Record<string, unknown> | null;

    if (existing?.is_system) {
      await writeRbacAudit(admin, {
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        action: 'rbac.role_delete_denied',
        targetId: roleId,
        details: { reason: 'system_role_immutable' },
        success: false,
      });
      await raiseEscalationBlockedAlert(admin, {
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        attemptedAction: 'delete system role',
        targetRoleId: roleId,
        reason: 'system roles cannot be deleted',
      });
      return NextResponse.json({ error: 'Cannot delete system roles' }, { status: 403 });
    }

    const { error } = await admin
      .from('dashboard_roles')
      .delete()
      .eq('id', roleId)
      .eq('guild_id', ctx.guildId);

    if (error) return dbError(error, 'rbac/roles');

    await writeRbacAudit(admin, {
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'rbac.role_deleted',
      targetId: roleId,
      details: {},
    });

    await recordAdminChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'rbac.role_deleted',
      targetType: 'dashboard role',
      targetId: roleId,
      description:
        `Deleted the dashboard role "${(existing?.name as string | undefined) ?? roleId}", `
        + 'which removed it from everyone who held it',
      before: roleState(existing),
      blastRadius: 'critical',
      undoReason:
        'the role and every assignment to it were permanently deleted, so there is nothing to restore into — recreate the role and re-assign it from the Team page',
    }, admin);

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
