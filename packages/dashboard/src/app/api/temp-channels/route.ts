/**
 * /api/temp-channels — CRUD for temp channel hub configurations.
 *
 * GET: List all hubs for the guild
 * POST: Create a new hub
 * PUT: Update an existing hub
 * DELETE: Delete a hub by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('temp_channel_hubs')
    .select('*')
    .eq('guild_id', GUILD_ID)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();
  const body = await req.json();

  const {
    hub_channel_id,
    category_id,
    naming_format,
    default_user_limit,
    default_bitrate,
    keep_alive_minutes,
    allow_text_channel,
    moderator_roles,
  } = body;

  if (!hub_channel_id || !category_id) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: hub_channel_id, category_id' },
      { status: 400 },
    );
  }

  // Max 10 hubs per guild
  const { count } = await supabase
    .from('temp_channel_hubs')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', GUILD_ID);

  if ((count ?? 0) >= 10) {
    return NextResponse.json(
      { success: false, error: 'Maximum hub limit reached (10)' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('temp_channel_hubs')
    .insert({
      guild_id: GUILD_ID,
      hub_channel_id,
      category_id,
      naming_format: naming_format ?? "{username}'s Channel",
      default_user_limit: default_user_limit ?? 0,
      default_bitrate: default_bitrate ?? 64000,
      keep_alive_minutes: keep_alive_minutes ?? 1,
      allow_text_channel: allow_text_channel ?? false,
      moderator_roles: moderator_roles ?? [],
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
  const supabase = createAdminSupabase();
  const body = await req.json();

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing hub id' }, { status: 400 });
  }

  const allowedFields = [
    'hub_channel_id',
    'category_id',
    'naming_format',
    'default_user_limit',
    'default_bitrate',
    'keep_alive_minutes',
    'allow_text_channel',
    'moderator_roles',
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
    .from('temp_channel_hubs')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', GUILD_ID)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing hub id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('temp_channel_hubs')
    .delete()
    .eq('id', id)
    .eq('guild_id', GUILD_ID);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
