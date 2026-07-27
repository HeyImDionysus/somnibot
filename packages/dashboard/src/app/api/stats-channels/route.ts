/**
 * /api/stats-channels — CRUD for statistics channel configurations.
 *
 * GET: List all stats channels for the guild
 * POST: Create a new stats channel
 * PUT: Update an existing stats channel
 * DELETE: Delete a stats channel by ID
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

const statsChannelUpdate = z.object({
  id: z.string().uuid(),
  stat_type: z.string().min(1).max(64).optional(),
  name_format: z
    .string()
    .max(128)
    .refine((s) => s.includes('{value}') || s.includes('{count}'), {
      message: 'name_format must contain the {value} placeholder',
    })
    .optional(),
  stat_config: z.record(z.unknown()).optional(),
  active: z.boolean().optional(),
});
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('stats_channels')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) {
    return dbError(error, 'stats-channels');
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
    return dbError(error, 'stats-channels');
  }

  await notifyBot('stats-channels');

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'created',
    action: 'stats_channels.channel_created',
    table: 'stats_channels',
    targetType: 'stats channel',
    targetId: (data as { id?: string } | null)?.id ?? null,
    label: undefined,
    after: data as Record<string, unknown> | null,
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
  const parsed = await parseBody(req, statsChannelUpdate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const updates = typedPick(body, ['stat_type', 'name_format', 'stat_config', 'active']);
  updates.updated_at = new Date().toISOString();

  const before = await readRowBefore(supabase, 'stats_channels', { id: body.id, guild_id: auth.ctx.guildId });

  const { data, error } = await supabase
    .from('stats_channels')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'stats-channels');
  }

  await notifyBot('stats-channels');

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'updated',
    action: 'stats_channels.channel_updated',
    table: 'stats_channels',
    targetType: 'stats channel',
    targetId: body.id,
    label: before?.name as string | undefined,

    before,
    after: updates as Record<string, unknown>,
    match: { id: body.id, guild_id: auth.ctx.guildId },
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
    return NextResponse.json({ success: false, error: 'Missing stats channel id' }, { status: 400 });
  }

  const before = await readRowBefore(supabase, 'stats_channels', { id: id, guild_id: auth.ctx.guildId });

  const { error } = await supabase
    .from('stats_channels')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return dbError(error, 'stats-channels');
  }

  await notifyBot('stats-channels');

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'deleted',
    action: 'stats_channels.channel_deleted',
    table: 'stats_channels',
    targetType: 'stats channel',
    targetId: id,
    label: before?.name as string | undefined,

    before,
  }, supabase);

  return NextResponse.json({ success: true });
}
