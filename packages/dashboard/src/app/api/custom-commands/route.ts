/**
 * /api/custom-commands — CRUD for custom slash commands.
 *
 * GET: List all custom commands for the guild
 * POST: Create a new custom command
 * PUT: Update an existing custom command
 * DELETE: Delete a custom command by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { typedPick } from '@/lib/api/typed-pick';
import { dbError } from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';
import { discordTargetFailureStatus, validateDiscordRoleTargets } from '@/lib/api/live-discord-facts';

function commandEffectRoleIds(actions: readonly unknown[]): string[] | null {
  const roleIds: string[] = [];
  for (const candidate of actions) {
    const parsed = schemas.customCommand.action.safeParse(candidate);
    if (!parsed.success) return null;
    if (parsed.data.type === 'give_role' || parsed.data.type === 'remove_role') {
      roleIds.push(parsed.data.roleId);
    }
  }
  return roleIds;
}

function configuredRoleIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const roleIds: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') return null;
    roleIds.push(candidate);
  }
  return roleIds;
}
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('custom_commands')
    .select('*')
    .eq('guild_id', guildId)
    .order('name', { ascending: true })
    .limit(500);

  if (error) {
    return dbError(error, 'custom-commands');
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
  const parsed = await parseBody(req, schemas.customCommand.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    name,
    description,
    actions,
    allowed_roles,
    allowed_channels,
    denied_roles,
    denied_channels,
    cooldown_seconds,
    ephemeral,
  } = body;

  if (!name) {
    return NextResponse.json(
      { success: false, error: 'Missing required field: name' },
      { status: 400 },
    );
  }

  // Validate command name (Discord requirements: lowercase, no spaces, 1-32 chars)
  const cleanName = name.toLowerCase().replace(/\s+/g, '-');
  if (!/^[\w-]{1,32}$/.test(cleanName)) {
    return NextResponse.json(
      { success: false, error: 'Invalid command name. Use lowercase letters, numbers, and hyphens (1-32 chars).' },
      { status: 400 },
    );
  }

  // Check limit (max 25 custom commands)
  const { count } = await supabase
    .from('custom_commands')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId);

  if ((count ?? 0) >= 25) {
    return NextResponse.json(
      { success: false, error: 'Maximum custom commands limit reached (25)' },
      { status: 400 },
    );
  }

  // Check for duplicate name
  const { data: existing } = await supabase
    .from('custom_commands')
    .select('id')
    .eq('guild_id', guildId)
    .eq('name', cleanName)
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      { success: false, error: `A command named "/${cleanName}" already exists.` },
      { status: 400 },
    );
  }

  const effectRoleIds = commandEffectRoleIds(actions ?? []);
  if (!effectRoleIds) {
    return NextResponse.json({ success: false, error: 'A custom-command role action is malformed.' }, { status: 400 });
  }
  const roleValidation = await validateDiscordRoleTargets(supabase, guildId, {
    assignableRoleIds: effectRoleIds,
    existingRoleIds: [...(allowed_roles ?? []), ...(denied_roles ?? [])],
  });
  if (!roleValidation.ok) {
    return NextResponse.json(
      { success: false, error: roleValidation.issues.join(' '), issues: roleValidation.issues },
      { status: discordTargetFailureStatus(roleValidation) },
    );
  }

  const { data, error } = await supabase
    .from('custom_commands')
    .insert({
      guild_id: guildId,
      name: cleanName,
      description: description ?? `Custom command: ${cleanName}`,
      actions: actions ?? [],
      allowed_roles: allowed_roles ?? [],
      allowed_channels: allowed_channels ?? [],
      denied_roles: denied_roles ?? [],
      denied_channels: denied_channels ?? [],
      cooldown_seconds: cooldown_seconds ?? 0,
      ephemeral: ephemeral ?? false,
      enabled: true,
    })
    .select()
    .single();

  if (error) {
    return dbError(error, 'custom-commands');
  }

  await notifyBot(guildId, 'custom-commands');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'created',
    action: 'custom_command.created',
    table: 'custom_commands',
    targetType: 'custom command',
    targetId: (data as { id?: string } | null)?.id ?? null,
    label: cleanName,
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
  const parsed = await parseBody(req, schemas.customCommand.update);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.id) {
    return NextResponse.json(
      { success: false, error: 'Missing command id' },
      { status: 400 },
    );
  }

  const updates = typedPick(body, ['name', 'description', 'actions', 'allowed_roles', 'allowed_channels', 'denied_roles', 'denied_channels', 'cooldown_seconds', 'ephemeral', 'enabled']);

  updates.updated_at = new Date().toISOString();

  const before = await readRowBefore(supabase, 'custom_commands', { id: body.id, guild_id: guildId });

  if (!before) {
    return NextResponse.json({ success: false, error: 'Custom command not found.' }, { status: 404 });
  }

  const validateEffectiveRoles = body.enabled === true
    || body.actions !== undefined
    || body.allowed_roles !== undefined
    || body.denied_roles !== undefined;
  const effectiveActions = body.actions
    ?? (validateEffectiveRoles ? (Array.isArray(before.actions) ? before.actions : null) : []);
  const effectiveAllowedRoles = body.allowed_roles
    ?? (validateEffectiveRoles ? configuredRoleIds(before.allowed_roles) : []);
  const effectiveDeniedRoles = body.denied_roles
    ?? (validateEffectiveRoles ? configuredRoleIds(before.denied_roles) : []);
  const effectRoleIds = effectiveActions === null ? null : commandEffectRoleIds(effectiveActions);
  if (!effectRoleIds || effectiveAllowedRoles === null || effectiveDeniedRoles === null) {
    return NextResponse.json({ success: false, error: 'A custom-command role action is malformed.' }, { status: 400 });
  }
  const roleValidation = await validateDiscordRoleTargets(supabase, guildId, {
    assignableRoleIds: effectRoleIds,
    existingRoleIds: [...effectiveAllowedRoles, ...effectiveDeniedRoles],
  });
  if (!roleValidation.ok) {
    return NextResponse.json(
      { success: false, error: roleValidation.issues.join(' '), issues: roleValidation.issues },
      { status: discordTargetFailureStatus(roleValidation) },
    );
  }

  const { data, error } = await supabase
    .from('custom_commands')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'custom-commands');
  }

  await notifyBot(guildId, 'custom-commands');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'updated',
    action: 'custom_command.updated',
    table: 'custom_commands',
    targetType: 'custom command',
    targetId: body.id,
    label: (before?.name as string | undefined) ?? (updates.name as string | undefined),
    before,
    after: updates,
    match: { id: body.id, guild_id: guildId },
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
    return NextResponse.json(
      { success: false, error: 'Missing command id' },
      { status: 400 },
    );
  }

  const before = await readRowBefore(supabase, 'custom_commands', { id, guild_id: guildId });

  const { error } = await supabase
    .from('custom_commands')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return dbError(error, 'custom-commands');
  }

  await notifyBot(guildId, 'custom-commands');

  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'deleted',
    action: 'custom_command.deleted',
    table: 'custom_commands',
    targetType: 'custom command',
    targetId: id,
    label: before?.name as string | undefined,
    before,
  }, supabase);

  return NextResponse.json({ success: true });
}
