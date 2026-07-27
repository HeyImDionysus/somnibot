/**
 * /api/automations — CRUD for automation rules.
 *
 * GET: List all automations for the guild
 * POST: Create a new automation
 * PUT: Update an existing automation
 * DELETE: Delete an automation by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { typedPick } from '@/lib/api/typed-pick';
import { dbError } from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('automations')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) {
    return dbError(error, 'automations');
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.automation.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    name,
    description,
    trigger_type,
    trigger_config,
    conditions,
    actions,
    target_user_ids,
    target_channel_ids,
    exclude_user_ids,
    exclude_channel_ids,
  } = body;

  if (!name || !trigger_type) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: name, trigger_type' },
      { status: 400 },
    );
  }

  // Check automation limit
  const { count } = await supabase
    .from('automations')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId);

  if ((count ?? 0) >= 100) {
    return NextResponse.json(
      { success: false, error: 'Maximum automations limit reached (100)' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('automations')
    .insert({
      guild_id: guildId,
      name,
      description: description ?? null,
      trigger_type,
      trigger_config: trigger_config ?? {},
      conditions: conditions ?? [],
      actions: actions ?? [],
      enabled: true,
      target_user_ids: target_user_ids ?? [],
      target_channel_ids: target_channel_ids ?? [],
      exclude_user_ids: exclude_user_ids ?? [],
      exclude_channel_ids: exclude_channel_ids ?? [],
    })
    .select()
    .single();

  if (error) {
    return dbError(error, 'automations');
  }

  await notifyBot('automations', undefined, 'dashboard', {
    type: 'automation.created',
    data: {
      automationId: data.id,
      automationName: data.name,
      trigger: data.trigger_type,
      createdBy: auth.ctx.discordId,
      enabled: data.enabled,
      actionCount: (data.actions as unknown[])?.length ?? 0,
    },
  });

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'created',
    action: 'automations.automation_created',
    table: 'automations',
    targetType: 'automation',
    targetId: (data as { id?: string } | null)?.id ?? null,
    label: undefined,
    after: data as Record<string, unknown> | null,
    blastRadius: 'medium',
  }, supabase);

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.automation.update);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing automation id' }, { status: 400 });
  }

  const updates = typedPick(body, ['name', 'description', 'trigger_type', 'trigger_config', 'conditions', 'actions', 'enabled', 'target_user_ids', 'target_channel_ids', 'exclude_user_ids', 'exclude_channel_ids']);

  updates.updated_at = new Date().toISOString();

  const before = await readRowBefore(supabase, 'automations', { id: body.id, guild_id: auth.ctx.guildId });

  const { data, error } = await supabase
    .from('automations')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'automations');
  }

  await notifyBot('automations', undefined, 'dashboard', {
    type: 'automation.updated',
    data: {
      automationId: data.id,
      automationName: data.name,
      updatedBy: auth.ctx.discordId,
      after: updates,
    },
  });

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'updated',
    action: 'automations.automation_updated',
    table: 'automations',
    targetType: 'automation',
    targetId: body.id,
    label: before?.name as string | undefined,

    before,
    after: updates as Record<string, unknown>,
    match: { id: body.id, guild_id: auth.ctx.guildId },
    blastRadius: 'medium',
  }, supabase);

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing automation id' }, { status: 400 });
  }

  // Fetch name before deleting so the audit event has context
  const before = await readRowBefore(supabase, 'automations', { id: id, guild_id: auth.ctx.guildId });

  const { data: existing } = await supabase
    .from('automations')
    .select('name')
    .eq('id', id)
    .eq('guild_id', guildId)
    .maybeSingle();

  const { error } = await supabase
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return dbError(error, 'automations');
  }

  await notifyBot('automations', undefined, 'dashboard', {
    type: 'automation.deleted',
    data: {
      automationId: id,
      automationName: existing?.name ?? 'unknown',
      deletedBy: auth.ctx.discordId,
    },
  });

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'deleted',
    action: 'automations.automation_deleted',
    table: 'automations',
    targetType: 'automation',
    targetId: id,
    label: before?.name as string | undefined,

    before,
    blastRadius: 'medium',
  }, supabase);

  return NextResponse.json({ success: true });
}
