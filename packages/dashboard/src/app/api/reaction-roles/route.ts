/**
 * /api/reaction-roles — CRUD for reaction role configurations.
 *
 * GET: List all reaction roles for the guild
 * POST: Create a new reaction role mapping
 * PUT: Update an existing reaction role
 * DELETE: Delete a reaction role by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('reaction_roles')
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
    channel_id,
    message_id,
    emoji,
    role_id,
    exclusive_group,
    require_role,
    require_level,
    max_per_group,
    remove_on_unreact,
    log_actions,
  } = body;

  if (!channel_id || !message_id || !emoji || !role_id) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: channel_id, message_id, emoji, role_id' },
      { status: 400 },
    );
  }

  // Check limit (max 50 per guild)
  const { count } = await supabase
    .from('reaction_roles')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', GUILD_ID);

  if ((count ?? 0) >= 50) {
    return NextResponse.json(
      { success: false, error: 'Maximum reaction role limit reached (50)' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('reaction_roles')
    .insert({
      guild_id: GUILD_ID,
      channel_id,
      message_id,
      emoji,
      role_id,
      exclusive_group: exclusive_group ?? null,
      require_role: require_role ?? null,
      require_level: require_level ?? null,
      max_per_group: max_per_group ?? null,
      remove_on_unreact: remove_on_unreact ?? true,
      log_actions: log_actions ?? false,
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
    return NextResponse.json(
      { success: false, error: 'Missing reaction role id' },
      { status: 400 },
    );
  }

  const allowedFields = [
    'channel_id',
    'message_id',
    'emoji',
    'role_id',
    'exclusive_group',
    'require_role',
    'require_level',
    'max_per_group',
    'remove_on_unreact',
    'log_actions',
    'active',
  ];

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  const { data, error } = await supabase
    .from('reaction_roles')
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
    return NextResponse.json(
      { success: false, error: 'Missing reaction role id' },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from('reaction_roles')
    .delete()
    .eq('id', id)
    .eq('guild_id', GUILD_ID);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
