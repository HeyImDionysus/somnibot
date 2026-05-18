/**
 * /api/stats-channels — CRUD for statistics channel configurations.
 *
 * GET: List all stats channels for the guild
 * POST: Create a new stats channel
 * PUT: Update an existing stats channel
 * DELETE: Delete a stats channel by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';


export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('stats_channels')
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
  const parsed = await parseBody(req, schemas.statsChannel.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { stat_type, name_format, stat_config } = body;

  if (!stat_type || !name_format) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: stat_type, name_format' },
      { status: 400 },
    );
  }

  // Max 20 stats channels per guild
  const { count } = await supabase
    .from('stats_channels')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId);

  if ((count ?? 0) >= 20) {
    return NextResponse.json(
      { success: false, error: 'Maximum stats channel limit reached (20)' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('stats_channels')
    .insert({
      guild_id: guildId,
      stat_type,
      name_format,
      stat_config: stat_config ?? {},
      active: true,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const body = await req.json();

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing stats channel id' }, { status: 400 });
  }

  const allowedFields = ['stat_type', 'name_format', 'stat_config', 'active'];
  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('stats_channels')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

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
    return NextResponse.json({ success: false, error: 'Missing stats channel id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('stats_channels')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
