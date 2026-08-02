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
import { typedPick } from '@/lib/api/typed-pick';
import { dbError } from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';


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
  inactivity_warn_hours: z.number().int().min(1).max(720).optional(),
  inactivity_close_hours: z.number().int().min(1).max(720).optional(),
  feedback_prompt_enabled: z.boolean().optional(),
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
    return dbError(error, 'tickets/panels');
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
    return dbError(error, 'tickets/panels');
  }

  await notifyBot(guildId, 'tickets');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'created',
    action: 'tickets.panel_created',
    table: 'ticket_panels',
    targetType: 'ticket panel',
    targetId: (data as { id?: string } | null)?.id ?? null,
    label: name,
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
  const parsed = await parseBody(req, ticketPanelUpdate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const updates = typedPick(body, ['name', 'channel_id', 'panel_message', 'input_mode', 'ticket_types', 'manager_roles', 'open_category_id', 'closed_category_id', 'transcript_channel_id', 'dm_transcript_to_creator', 'max_open_per_user', 'introduction_message', 'inactivity_warn_hours', 'inactivity_close_hours', 'feedback_prompt_enabled', 'active']);

  updates.updated_at = new Date().toISOString();

  const before = await readRowBefore(supabase, 'ticket_panels', { id: body.id, guild_id: guildId });

  const { data, error } = await supabase
    .from('ticket_panels')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'tickets/panels');
  }

  await notifyBot(guildId, 'tickets');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'updated',
    action: 'tickets.panel_updated',
    table: 'ticket_panels',
    targetType: 'ticket panel',
    targetId: body.id,
    label: (before?.name as string | undefined) ?? (updates.name as string | undefined),
    before,
    after: updates,
    match: { id: body.id, guild_id: guildId },
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
    return NextResponse.json({ success: false, error: 'Missing panel id' }, { status: 400 });
  }

  const before = await readRowBefore(supabase, 'ticket_panels', { id, guild_id: guildId });

  const { error } = await supabase
    .from('ticket_panels')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return dbError(error, 'tickets/panels');
  }

  await notifyBot(guildId, 'tickets');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'deleted',
    action: 'tickets.panel_deleted',
    table: 'ticket_panels',
    targetType: 'ticket panel',
    targetId: id,
    label: before?.name as string | undefined,
    before,
    blastRadius: 'medium',
  }, supabase);

  return NextResponse.json({ success: true });
}
