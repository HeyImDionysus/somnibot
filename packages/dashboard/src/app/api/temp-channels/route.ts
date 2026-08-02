/**
 * /api/temp-channels — CRUD for temp channel hub configurations.
 *
 * GET: List all hubs for the guild
 * POST: Create a new hub
 * PUT: Update an existing hub
 * DELETE: Delete a hub by ID
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
// Branded member-surface templates: blank/null ⇒ bot's built-in default.
const templateField = z.string().max(500).nullable().optional();
const tempChannelUpdate = z.object({
  id: z.string().uuid(),
  hub_channel_id: snowflake.optional(),
  category_id: snowflake.optional(),
  naming_format: z.string().max(100).optional(),
  default_user_limit: z.number().int().min(0).max(99).optional(),
  default_bitrate: z.number().int().min(8000).max(384000).optional(),
  keep_alive_minutes: z.number().int().min(0).max(1440).optional(),
  empty_grace_seconds: z.number().int().min(0).max(3600).optional(),
  allow_text_channel: z.boolean().optional(),
  allow_claim: z.boolean().optional(),
  moderator_roles: z.array(snowflake).max(100).optional(),
  room_created_template: templateField,
  control_applied_template: templateField,
  control_denied_template: templateField,
  active: z.boolean().optional(),
});
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('temp_channel_hubs')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) {
    return dbError(error, 'temp-channels');
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
  const parsed = await parseBody(req, schemas.tempChannel.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    hub_channel_id,
    category_id,
    naming_format,
    default_user_limit,
    default_bitrate,
    keep_alive_minutes,
    empty_grace_seconds,
    allow_text_channel,
    allow_claim,
    moderator_roles,
    room_created_template,
    control_applied_template,
    control_denied_template,
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
    .eq('guild_id', guildId);

  if ((count ?? 0) >= 10) {
    return NextResponse.json(
      { success: false, error: 'Maximum hub limit reached (10)' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('temp_channel_hubs')
    .insert({
      guild_id: guildId,
      hub_channel_id,
      category_id,
      naming_format: naming_format ?? "{owner-name}'s room",
      default_user_limit: default_user_limit ?? 0,
      default_bitrate: default_bitrate ?? 64000,
      keep_alive_minutes: keep_alive_minutes ?? 1,
      empty_grace_seconds: empty_grace_seconds ?? 15,
      allow_text_channel: allow_text_channel ?? false,
      allow_claim: allow_claim ?? true,
      moderator_roles: moderator_roles ?? [],
      // Normalize blank overrides to NULL so the bot falls back to its default.
      room_created_template: room_created_template?.trim() ? room_created_template : null,
      control_applied_template: control_applied_template?.trim() ? control_applied_template : null,
      control_denied_template: control_denied_template?.trim() ? control_denied_template : null,
      active: true,
    })
    .select()
    .single();

  if (error) {
    return dbError(error, 'temp-channels');
  }

  await notifyBot(guildId, 'temp-channels');

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'created',
    action: 'temp_channels.hub_created',
    table: 'temp_channel_hubs',
    targetType: 'temp channel hub',
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
  const parsed = await parseBody(req, tempChannelUpdate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const updates = typedPick(body, ['hub_channel_id', 'category_id', 'naming_format', 'default_user_limit', 'default_bitrate', 'keep_alive_minutes', 'empty_grace_seconds', 'allow_text_channel', 'allow_claim', 'moderator_roles', 'room_created_template', 'control_applied_template', 'control_denied_template', 'active']);
  // Normalize blank template overrides to NULL so the bot uses its default.
  for (const key of ['room_created_template', 'control_applied_template', 'control_denied_template'] as const) {
    if (typeof updates[key] === 'string' && !(updates[key] as string).trim()) {
      updates[key] = null;
    }
  }
  updates.updated_at = new Date().toISOString();

  const before = await readRowBefore(supabase, 'temp_channel_hubs', { id: body.id, guild_id: auth.ctx.guildId });

  const { data, error } = await supabase
    .from('temp_channel_hubs')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'temp-channels');
  }

  await notifyBot(guildId, 'temp-channels');

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'updated',
    action: 'temp_channels.hub_updated',
    table: 'temp_channel_hubs',
    targetType: 'temp channel hub',
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
    return NextResponse.json({ success: false, error: 'Missing hub id' }, { status: 400 });
  }

  const before = await readRowBefore(supabase, 'temp_channel_hubs', { id: id, guild_id: auth.ctx.guildId });

  const { error } = await supabase
    .from('temp_channel_hubs')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return dbError(error, 'temp-channels');
  }

  await notifyBot(guildId, 'temp-channels');

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'deleted',
    action: 'temp_channels.hub_deleted',
    table: 'temp_channel_hubs',
    targetType: 'temp channel hub',
    targetId: id,
    label: before?.name as string | undefined,

    before,
  }, supabase);

  return NextResponse.json({ success: true });
}
