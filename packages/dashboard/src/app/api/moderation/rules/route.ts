/**
 * /api/moderation/rules — CRUD for auto-mod rules.
 *
 * GET: List all rules for the guild
 * POST: Create a new rule
 * PUT: Update an existing rule
 * DELETE: Delete a rule by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { typedPick } from '@/lib/api/typed-pick';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('automod_rules')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) {
    return dbError(error, 'moderation/rules');
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
  const parsed = await parseBody(req, schemas.moderation.rule);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { name, type, config, action, mute_duration_minutes, exempt_roles, exempt_channels, log_to_mod_channel } = body;

  if (!name || !type || !action) {
    return NextResponse.json({ success: false, error: 'Missing required fields: name, type, action' }, { status: 400 });
  }

  const validTypes = ['word_filter', 'link_filter', 'invite_filter', 'spam_filter', 'duplicate_filter', 'caps_filter', 'mention_spam', 'newline_spam'];
  if (!validTypes.includes(type)) {
    return NextResponse.json({ success: false, error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, { status: 400 });
  }

  const validActions = ['delete', 'warn', 'mute', 'kick', 'ban'];
  if (!validActions.includes(action)) {
    return NextResponse.json({ success: false, error: `Invalid action. Must be one of: ${validActions.join(', ')}` }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('automod_rules')
    .insert({
      guild_id: guildId,
      name,
      type,
      enabled: true,
      config: config ?? {},
      action,
      mute_duration_minutes: action === 'mute' ? (mute_duration_minutes ?? 5) : null,
      exempt_roles: exempt_roles ?? [],
      exempt_channels: exempt_channels ?? [],
      log_to_mod_channel: log_to_mod_channel ?? true,
    })
    .select()
    .single();

  if (error) {
    return dbError(error, 'moderation/rules');
  }

  await notifyBot(guildId, 'moderation');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'created',
    action: 'moderation.rule_created',
    table: 'automod_rules',
    targetType: 'auto-mod rule',
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
  const parsed = await parseBody(req, schemas.moderation.ruleUpdate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing rule id' }, { status: 400 });
  }

  // Only allow updating specific fields
  const updates = typedPick(body, ['name', 'type', 'enabled', 'config', 'action', 'mute_duration_minutes', 'exempt_roles', 'exempt_channels', 'log_to_mod_channel']);

  updates.updated_at = new Date().toISOString();

  const before = await readRowBefore(supabase, 'automod_rules', { id: body.id, guild_id: guildId });

  const { data, error } = await supabase
    .from('automod_rules')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'moderation/rules');
  }

  await notifyBot(guildId, 'moderation');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'updated',
    action: 'moderation.rule_updated',
    table: 'automod_rules',
    targetType: 'auto-mod rule',
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
    return NextResponse.json({ success: false, error: 'Missing rule id' }, { status: 400 });
  }

  // Capture the rule before it goes — this record is the only copy afterwards.
  const before = await readRowBefore(supabase, 'automod_rules', { id, guild_id: guildId });

  const { error } = await supabase
    .from('automod_rules')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return dbError(error, 'moderation/rules');
  }

  await notifyBot(guildId, 'moderation');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'deleted',
    action: 'moderation.rule_deleted',
    table: 'automod_rules',
    targetType: 'auto-mod rule',
    targetId: id,
    label: before?.name as string | undefined,
    before,
    blastRadius: 'medium',
  }, supabase);

  return NextResponse.json({ success: true });
}
