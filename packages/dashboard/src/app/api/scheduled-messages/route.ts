/**
 * /api/scheduled-messages — CRUD for scheduled message configurations.
 *
 * GET: List all scheduled messages for the guild
 * POST: Create a new scheduled message
 * PUT: Update an existing scheduled message
 * DELETE: Delete a scheduled message by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { parseBody, schemas } from '@/lib/api/validation';
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('scheduled_messages')
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
  const parsed = await parseBody(req, schemas.scheduledMessage.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    name,
    channel_id,
    message,
    embed_config_id,
    cron_expression,
    timezone,
    start_date,
    end_date,
    max_sends,
  } = body;

  if (!name || !channel_id || !cron_expression) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: name, channel_id, cron_expression' },
      { status: 400 },
    );
  }

  // Max 50 scheduled messages per guild
  const { count } = await supabase
    .from('scheduled_messages')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId);

  if ((count ?? 0) >= 50) {
    return NextResponse.json(
      { success: false, error: 'Maximum scheduled message limit reached (50)' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('scheduled_messages')
    .insert({
      guild_id: guildId,
      name,
      channel_id,
      message: message ?? null,
      embed_config_id: embed_config_id ?? null,
      cron_expression,
      timezone: timezone ?? 'UTC',
      start_date: start_date ?? null,
      end_date: end_date ?? null,
      max_sends: max_sends ?? null,
      current_sends: 0,
      active: true,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('scheduled-messages');

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.scheduledMessage.update);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing scheduled message id' }, { status: 400 });
  }

  const allowedFields = [
    'name',
    'channel_id',
    'message',
    'embed_config_id',
    'cron_expression',
    'timezone',
    'start_date',
    'end_date',
    'max_sends',
    'active',
  ];

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('scheduled_messages')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('scheduled-messages');

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
    return NextResponse.json({ success: false, error: 'Missing scheduled message id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('scheduled_messages')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('scheduled-messages');

  return NextResponse.json({ success: true });
}
