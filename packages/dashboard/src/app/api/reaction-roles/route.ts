/**
 * /api/reaction-roles — CRUD for reaction role configurations.
 *
 * GET: List all reaction roles for the guild
 * POST: Create a new reaction role mapping
 * PUT: Update an existing reaction role
 * DELETE: Delete a reaction role by ID
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
import { discordTargetFailureStatus, validateDiscordRoleTargets } from '@/lib/api/live-discord-facts';

const snowflake = z.string().regex(/^\d{17,20}$/);
const reactionRoleStyles = ['reaction', 'buttons', 'select-menu'] as const;
type ReactionRoleStyle = typeof reactionRoleStyles[number];

async function readDefaultStyle(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
): Promise<ReactionRoleStyle> {
  try {
    const { data } = await supabase
      .from('guild_config')
      .select('default_style')
      .eq('guild_id', guildId)
      .maybeSingle();
    const configuredStyle = data?.default_style;
    return reactionRoleStyles.includes(configuredStyle as ReactionRoleStyle)
      ? configuredStyle as ReactionRoleStyle
      : 'buttons';
  } catch {
    return 'buttons';
  }
}

const reactionRoleUpdate = z.object({
  id: z.string().uuid(),
  channel_id: snowflake.optional(),
  message_id: snowflake.optional(),
  emoji: z.string().min(1).max(64).optional(),
  role_id: snowflake.optional(),
  exclusive_group: z.string().max(64).optional().nullable(),
  require_role: snowflake.optional().nullable(),
  require_level: z.number().int().min(0).optional().nullable(),
  max_per_group: z.number().int().min(0).max(100).optional().nullable(),
  remove_on_unreact: z.boolean().optional(),
  log_actions: z.boolean().optional(),
  active: z.boolean().optional(),
});
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('reaction_roles')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) {
    return dbError(error, 'reaction-roles');
  }

  // Return the resolved guild surface alongside legacy rows. The table keeps
  // explicit reaction mappings, while clients can route newly-created panels
  // through the configured reaction/button/select-menu surface.
  const default_style = await readDefaultStyle(supabase, guildId);
  return NextResponse.json({ success: true, data: data ?? [], default_style });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const default_style = await readDefaultStyle(supabase, guildId);
  const parsed = await parseBody(req, schemas.reactionRole.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

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
    .eq('guild_id', guildId);

  if ((count ?? 0) >= 50) {
    return NextResponse.json(
      { success: false, error: 'Maximum reaction role limit reached (50)' },
      { status: 400 },
    );
  }

  const roleValidation = await validateDiscordRoleTargets(supabase, guildId, {
    assignableRoleIds: [role_id],
    existingRoleIds: require_role ? [require_role] : [],
  });
  if (!roleValidation.ok) {
    return NextResponse.json(
      { success: false, error: roleValidation.issues.join(' '), issues: roleValidation.issues },
      { status: discordTargetFailureStatus(roleValidation) },
    );
  }

  const { data, error } = await supabase
    .from('reaction_roles')
    .insert({
      guild_id: guildId,
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
    return dbError(error, 'reaction-roles');
  }

  // The guild default controls the newly-created Discord surface. Keep the
  // legacy reaction row for compatibility, and mirror it into the existing
  // button_roles panel table when buttons/select menus are selected.
  if (default_style !== 'reaction') {
    const { error: surfaceError } = await supabase.from('button_roles').insert({
      guild_id: guildId,
      panel_id: message_id,
      channel_id,
      // Keep the legacy source message untouched; the bot deploys a dedicated
      // role panel in the same channel and records its message id.
      message_id: null,
      label: emoji,
      emoji,
      role_id,
      style: 'primary',
      sort_order: 0,
      exclusive_group: exclusive_group ?? null,
      require_role: require_role ?? null,
      require_level: require_level ?? null,
      active: true,
    });
    if (surfaceError) {
      await supabase.from('reaction_roles').delete().eq('id', data?.id ?? '').eq('guild_id', guildId);
      return dbError(surfaceError, 'button-role surface');
    }
  }

  await notifyBot(guildId, 'reaction-roles');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'created',
    action: 'reaction_roles.entry_created',
    table: 'reaction_roles',
    targetType: 'reaction role',
    targetId: (data as { id?: string } | null)?.id ?? null,
    label: `${emoji} → role`,
    after: data as Record<string, unknown> | null,
  }, supabase);

  return NextResponse.json({ success: true, data, default_style });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, reactionRoleUpdate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const updates = typedPick(body, ['channel_id', 'message_id', 'emoji', 'role_id', 'exclusive_group', 'require_role', 'require_level', 'max_per_group', 'remove_on_unreact', 'log_actions', 'active']);

  const before = await readRowBefore(supabase, 'reaction_roles', { id: body.id, guild_id: guildId });

  if (!before) {
    return NextResponse.json({ success: false, error: 'Reaction role mapping not found.' }, { status: 404 });
  }
  const effectiveRoleId = typeof updates.role_id === 'string'
    ? updates.role_id
    : typeof before.role_id === 'string' ? before.role_id : null;
  const effectiveRequiredRoleId = typeof updates.require_role === 'string'
    ? updates.require_role
    : updates.require_role === null
      ? null
      : typeof before.require_role === 'string' ? before.require_role : null;
  if (!effectiveRoleId) {
    return NextResponse.json({ success: false, error: 'Reaction role mapping has no valid target role. Select a current role.' }, { status: 409 });
  }
  const roleValidation = await validateDiscordRoleTargets(supabase, guildId, {
    assignableRoleIds: [effectiveRoleId],
    existingRoleIds: effectiveRequiredRoleId ? [effectiveRequiredRoleId] : [],
  });
  if (!roleValidation.ok) {
    return NextResponse.json(
      { success: false, error: roleValidation.issues.join(' '), issues: roleValidation.issues },
      { status: discordTargetFailureStatus(roleValidation) },
    );
  }

  const { data, error } = await supabase
    .from('reaction_roles')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'reaction-roles');
  }

  if (before?.message_id && before?.role_id) {
    await supabase.from('button_roles').update({
      panel_id: updates.message_id ?? before.message_id,
      channel_id: updates.channel_id ?? before.channel_id,
      label: updates.emoji ?? before.emoji,
      emoji: updates.emoji ?? before.emoji,
      role_id: updates.role_id ?? before.role_id,
      exclusive_group: updates.exclusive_group ?? before.exclusive_group,
      require_role: updates.require_role ?? before.require_role,
      require_level: updates.require_level ?? before.require_level,
      active: updates.active ?? before.active,
    }).eq('guild_id', guildId).eq('panel_id', before.message_id).eq('role_id', before.role_id);
  }

  await notifyBot(guildId, 'reaction-roles');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'updated',
    action: 'reaction_roles.entry_updated',
    table: 'reaction_roles',
    targetType: 'reaction role',
    targetId: body.id,
    label: before?.emoji ? `${String(before.emoji)} → role` : undefined,
    before,
    after: updates,
    match: { id: body.id, guild_id: guildId },
  }, supabase);

  const default_style = await readDefaultStyle(supabase, guildId);
  return NextResponse.json({ success: true, data, default_style });
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
    return NextResponse.json(
      { success: false, error: 'Missing reaction role id' },
      { status: 400 },
    );
  }

  const before = await readRowBefore(supabase, 'reaction_roles', { id, guild_id: guildId });

  const { error } = await supabase
    .from('reaction_roles')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return dbError(error, 'reaction-roles');
  }

  if (before?.message_id && before?.role_id) {
    await supabase.from('button_roles').delete()
      .eq('guild_id', guildId).eq('panel_id', before.message_id).eq('role_id', before.role_id);
  }

  await notifyBot(guildId, 'reaction-roles');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'deleted',
    action: 'reaction_roles.entry_deleted',
    table: 'reaction_roles',
    targetType: 'reaction role',
    targetId: id,
    label: before?.emoji ? `${String(before.emoji)} → role` : undefined,
    before,
  }, supabase);

  return NextResponse.json({ success: true });
}
