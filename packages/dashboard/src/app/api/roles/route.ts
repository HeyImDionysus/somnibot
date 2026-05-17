/**
 * Role Templates CRUD API
 *
 * GET    /api/roles — List all role templates for the guild
 * POST   /api/roles — Create a new role template
 * PATCH  /api/roles — Update a role template (body.id required)
 * DELETE /api/roles — Delete a role template (body.id required)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createServerSupabase } from '@/lib/supabase/server';

async function getGuildId(): Promise<string | null> {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createAdminSupabase();
  const { data: dbUser } = await admin
    .from('users')
    .select('discord_id')
    .eq('id', user.id)
    .single();
  if (!dbUser) return null;

  const { data: guild } = await admin
    .from('guild')
    .select('id')
    .eq('owner_discord_id', dbUser.discord_id)
    .single();

  return guild?.id ?? null;
}

export async function GET() {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from('role_templates')
    .select('*')
    .eq('guild_id', guildId)
    .order('position', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const admin = createAdminSupabase();

  const { data, error } = await admin
    .from('role_templates')
    .insert({
      guild_id: guildId,
      name: body.name,
      tier: body.tier,
      description: body.description ?? null,
      permissions: body.permissions ?? 0,
      permission_details: body.permissionDetails ?? {},
      is_builtin: body.isBuiltin ?? false,
      base_template_id: body.baseTemplateId ?? null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit log
  await admin.from('audit_logs').insert({
    guild_id: guildId,
    actor_type: 'user',
    action: 'role_template.created',
    entity_type: 'role_template',
    entity_id: data.id,
    details: { name: body.name, tier: body.tier },
  });

  return NextResponse.json(data, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const admin = createAdminSupabase();

  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) updateData.name = body.name;
  if (body.tier !== undefined) updateData.tier = body.tier;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.permissions !== undefined) updateData.permissions = body.permissions;
  if (body.permissionDetails !== undefined) updateData.permission_details = body.permissionDetails;

  const { data, error } = await admin
    .from('role_templates')
    .update(updateData)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from('audit_logs').insert({
    guild_id: guildId,
    actor_type: 'user',
    action: 'role_template.updated',
    entity_type: 'role_template',
    entity_id: body.id,
    details: updateData,
  });

  return NextResponse.json(data);
}

export async function DELETE(request: NextRequest) {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const admin = createAdminSupabase();

  // Don't allow deleting built-in templates
  const { data: existing } = await admin
    .from('role_templates')
    .select('is_builtin, name')
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .single();

  if (existing?.is_builtin) {
    return NextResponse.json({ error: 'Cannot delete built-in templates' }, { status: 400 });
  }

  const { error } = await admin
    .from('role_templates')
    .delete()
    .eq('id', body.id)
    .eq('guild_id', guildId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from('audit_logs').insert({
    guild_id: guildId,
    actor_type: 'user',
    action: 'role_template.deleted',
    entity_type: 'role_template',
    entity_id: body.id,
    details: { name: existing?.name },
  });

  return NextResponse.json({ success: true });
}
