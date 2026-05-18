/**
 * /api/embeds — CRUD for saved embed configurations / templates.
 *
 * GET: List all embed configs for the guild
 * POST: Create a new embed config
 * PUT: Update an existing embed config
 * DELETE: Delete an embed config by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('embed_configs')
    .select('*')
    .eq('guild_id', GUILD_ID)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();
  const body = await req.json();

  const { name } = body;
  if (!name) {
    return NextResponse.json(
      { success: false, error: 'Missing required field: name' },
      { status: 400 },
    );
  }

  // Check limit (max 50 embeds)
  const { count } = await supabase
    .from('embed_configs')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', GUILD_ID);

  if ((count ?? 0) >= 50) {
    return NextResponse.json(
      { success: false, error: 'Maximum embed configs limit reached (50)' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('embed_configs')
    .insert({
      guild_id: GUILD_ID,
      name,
      title: body.title ?? null,
      description: body.description ?? null,
      color: body.color ?? null,
      fields: body.fields ?? [],
      image_url: body.image_url ?? null,
      thumbnail_url: body.thumbnail_url ?? null,
      footer_text: body.footer_text ?? null,
      footer_icon_url: body.footer_icon_url ?? null,
      author_name: body.author_name ?? null,
      author_url: body.author_url ?? null,
      author_icon_url: body.author_icon_url ?? null,
      include_timestamp: body.include_timestamp ?? false,
      use_components_v2: body.use_components_v2 ?? false,
      components_v2_data: body.components_v2_data ?? null,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('embeds');

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const supabase = createAdminSupabase();
  const body = await req.json();

  if (!body.id) {
    return NextResponse.json(
      { success: false, error: 'Missing embed config id' },
      { status: 400 },
    );
  }

  const allowedFields = [
    'name',
    'title',
    'description',
    'color',
    'fields',
    'image_url',
    'thumbnail_url',
    'footer_text',
    'footer_icon_url',
    'author_name',
    'author_url',
    'author_icon_url',
    'include_timestamp',
    'use_components_v2',
    'components_v2_data',
  ];

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('embed_configs')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', GUILD_ID)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('embeds');

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Missing embed config id' },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from('embed_configs')
    .delete()
    .eq('id', id)
    .eq('guild_id', GUILD_ID);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('embeds');

  return NextResponse.json({ success: true });
}
