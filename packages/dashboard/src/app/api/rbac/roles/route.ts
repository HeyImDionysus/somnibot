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

const rbacRoleCreate = z.object({
  name: z.string().min(1).max(100).trim(),
  description: z.string().max(500).optional().nullable(),
  permissions: z.array(z.string().max(128)).max(100).default([]),
  priority: z.number().int().min(0).max(999).default(10),
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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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

    const { data, error } = await admin
      .from('dashboard_roles')
      .insert({
        guild_id: ctx.guildId,
        name: body.name,
        description: body.description || null,
        permissions: body.permissions || [],
        is_system: false,
        priority: body.priority || 10,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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

    // V5 Audit §1.6: Block modification of ALL system roles, not just owner.
    // System roles (owner, admin, moderator) define the baseline permission
    // model. Allowing edits to non-owner system roles would let a user with
    // manage_team escalate by adding permissions to e.g. the admin role.
    if (body.id) {
      const { data: existing } = await admin
        .from('dashboard_roles')
        .select('is_system, name')
        .eq('id', body.id)
        .single();

      if (existing?.is_system) {
        return NextResponse.json(
          { error: `Cannot modify system role "${existing.name}"` },
          { status: 403 },
        );
      }
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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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

    // Can't delete system roles
    const { data: existing } = await admin
      .from('dashboard_roles')
      .select('is_system')
      .eq('id', roleId)
      .single();

    if (existing?.is_system) {
      return NextResponse.json({ error: 'Cannot delete system roles' }, { status: 403 });
    }

    const { error } = await admin
      .from('dashboard_roles')
      .delete()
      .eq('id', roleId)
      .eq('guild_id', ctx.guildId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
