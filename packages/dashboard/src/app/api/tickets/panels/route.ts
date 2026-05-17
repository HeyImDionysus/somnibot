/**
 * /api/tickets/panels — CRUD for ticket panels.
 *
 * GET: List all panels for the guild
 * POST: Create a new panel
 * PUT: Update a panel
 * DELETE: Delete a panel
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('ticket_panels')
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
    name,
    channel_id,
    panel_message,
    input_mode,
    ticket_types,
    manager_roles,
    open_category_id,
    closed_category_id,
    transcript_channel_id,
    dm_transcript_to_creator,
    max_open_per_user,
    introduction_message,
  } = body;

  if (!name || !channel_id || !open_category_id) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: name, channel_id, open_category_id' },
      { status: 400 },
    );
  }

  if (!ticket_types || !Array.isArray(ticket_types) || ticket_types.length === 0) {
    return NextResponse.json(
      { success: false, error: 'At least one ticket type is required' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('ticket_panels')
    .insert({
      guild_id: GUILD_ID,
      name,
      channel_id,
      panel_message: panel_message ?? {
        title: `🎫 ${name}`,
        description: 'Click a button below to open a ticket.',
      },
      input_mode: input_mode ?? 'buttons',
      ticket_types,
      manager_roles: manager_roles ?? [],
      open_category_id,
      closed_category_id: closed_category_id ?? null,
      transcript_channel_id: transcript_channel_id ?? null,
      dm_transcript_to_creator: dm_transcript_to_creator ?? false,
      max_open_per_user: max_open_per_user ?? 3,
      introduction_message: introduction_message ?? null,
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
    return NextResponse.json({ success: false, error: 'Missing panel id' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  const allowedFields = [
    'name',
    'channel_id',
    'panel_message',
    'input_mode',
    'ticket_types',
    'manager_roles',
    'open_category_id',
    'closed_category_id',
    'transcript_channel_id',
    'dm_transcript_to_creator',
    'max_open_per_user',
    'introduction_message',
    'active',
  ];

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('ticket_panels')
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
    return NextResponse.json({ success: false, error: 'Missing panel id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('ticket_panels')
    .delete()
    .eq('id', id)
    .eq('guild_id', GUILD_ID);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
