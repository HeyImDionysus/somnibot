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
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('automations')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const body = await req.json();

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
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('automations');

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const body = await req.json();

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing automation id' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  const allowedFields = [
    'name',
    'description',
    'trigger_type',
    'trigger_config',
    'conditions',
    'actions',
    'enabled',
    'target_user_ids',
    'target_channel_ids',
    'exclude_user_ids',
    'exclude_channel_ids',
  ];

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('automations')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('automations');

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing automation id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('automations');

  return NextResponse.json({ success: true });
}
