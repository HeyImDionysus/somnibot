/**
 * /api/tickets/panels — CRUD for ticket panels.
 *
 * GET: List all panels for the guild
 * POST: Create a new panel
 * PUT: Update a panel
 * DELETE: Delete a panel
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { parseBody, schemas } from '@/lib/api/validation';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

const snowflake = z.string().regex(/^\d{17,20}$/);
const ticketPanelUpdate = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).trim().optional(),
  channel_id: snowflake.optional(),
  panel_message: z.string().max(2000).optional(),
  input_mode: z.string().max(32).optional(),
  ticket_types: z.array(z.record(z.unknown())).max(25).optional(),
  manager_roles: z.array(snowflake).max(100).optional(),
  open_category_id: snowflake.optional().nullable(),
  closed_category_id: snowflake.optional().nullable(),
  transcript_channel_id: snowflake.optional().nullable(),
  dm_transcript_to_creator: z.boolean().optional(),
  max_open_per_user: z.number().int().min(1).max(10).optional(),
  introduction_message: z.string().max(2000).optional(),
  active: z.boolean().optional(),
});
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('ticket_panels')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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
  const parsed = await parseBody(req, schemas.ticketPanel.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

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
      guild_id: guildId,
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

  await notifyBot('tickets');

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, ticketPanelUpdate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

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
    if ((body as Record<string, unknown>)[field] !== undefined) {
      updates[field] = (body as Record<string, unknown>)[field];
    }
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('ticket_panels')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('tickets');

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
    return NextResponse.json({ success: false, error: 'Missing panel id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('ticket_panels')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('tickets');

  return NextResponse.json({ success: true });
}
