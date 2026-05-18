/**
 * Bot Action Queue Listener
 *
 * Subscribes to the `bot_action_queue` table via Supabase Realtime.
 * When the dashboard inserts a new action, the bot picks it up and executes it.
 *
 * Supported actions:
 * - create_role: Create a new Discord role
 * - update_role: Update an existing Discord role
 * - delete_role: Delete a Discord role
 * - create_channel: Create a new Discord channel
 * - update_channel: Update an existing Discord channel
 * - delete_channel: Delete a Discord channel
 * - create_category: Create a new Discord category
 * - delete_category: Delete a Discord category
 * - refresh_snapshot: Force a guild snapshot refresh
 */

import { ChannelType, PermissionsBitField, type Guild, type GuildChannel, type TextChannel } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeGuildSnapshot } from './guild-snapshot.js';
import { writeAuditLog } from './audit.js';

// ============================================================
// Types
// ============================================================

interface ActionRow {
  id: string;
  guild_id: string;
  action: string;
  payload: Record<string, unknown>;
  status: string;
}

interface ActionResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

// ============================================================
// Action Handlers
// ============================================================

async function handleCreateRole(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const name = payload.name as string;
  const tier = payload.tier as string;
  const color = (payload.color as number) ?? 0;
  const hoist = (payload.hoist as boolean) ?? false;
  const mentionable = (payload.mentionable as boolean) ?? false;
  const permissions = payload.permissions as string | undefined;
  const position = payload.position as number | undefined;

  if (!name || !tier) {
    return { success: false, error: 'Missing required fields: name, tier' };
  }

  const role = await guild.roles.create({
    name,
    color,
    hoist,
    mentionable,
    permissions: permissions
      ? new PermissionsBitField(BigInt(permissions))
      : undefined,
    reason: `SomniBot dashboard — created ${tier} role`,
  });

  // Set position if specified
  if (position !== undefined) {
    try {
      await role.setPosition(position, { reason: 'SomniBot dashboard — set role position' });
    } catch {
      // Position conflicts aren't fatal
    }
  }

  // Update discord_id_map
  const templateKey = (payload.templateKey as string) ?? `custom-${role.id}`;
  await supabase.from('discord_id_map').upsert(
    {
      guild_id: guild.id,
      entity_type: 'role',
      template_key: templateKey,
      discord_id: role.id,
    },
    { onConflict: 'guild_id,entity_type,template_key' },
  );

  // Update guild_desired_state with the new role
  await addRoleToDesiredState(supabase, guild.id, {
    key: templateKey,
    name,
    tier,
    permissions: permissions ?? '0',
    color,
    hoist,
    mentionable,
    position: position ?? role.position,
  });

  return {
    success: true,
    data: { roleId: role.id, name: role.name, templateKey },
  };
}

async function handleUpdateRole(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const roleId = payload.roleId as string;
  if (!roleId) return { success: false, error: 'Missing roleId' };

  const role = guild.roles.cache.get(roleId);
  if (!role) return { success: false, error: `Role ${roleId} not found` };
  if (role.managed) return { success: false, error: 'Cannot edit managed roles' };

  const updates: Record<string, unknown> = {};
  if (payload.name !== undefined) updates.name = payload.name;
  if (payload.color !== undefined) updates.color = payload.color;
  if (payload.hoist !== undefined) updates.hoist = payload.hoist;
  if (payload.mentionable !== undefined) updates.mentionable = payload.mentionable;
  if (payload.permissions !== undefined) {
    updates.permissions = new PermissionsBitField(BigInt(payload.permissions as string));
  }

  await role.edit({ ...updates, reason: 'SomniBot dashboard — role updated' } as Parameters<typeof role.edit>[0]);

  if (payload.position !== undefined) {
    try {
      await role.setPosition(payload.position as number, {
        reason: 'SomniBot dashboard — position updated',
      });
    } catch {
      // Position conflicts aren't fatal
    }
  }

  // Update desired state
  const templateKey = payload.templateKey as string | undefined;
  if (templateKey) {
    await updateRoleInDesiredState(supabase, guild.id, templateKey, payload);
  }

  return { success: true, data: { roleId: role.id, name: role.name } };
}

async function handleDeleteRole(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const roleId = payload.roleId as string;
  if (!roleId) return { success: false, error: 'Missing roleId' };

  const role = guild.roles.cache.get(roleId);
  if (!role) return { success: false, error: `Role ${roleId} not found` };
  if (role.managed) return { success: false, error: 'Cannot delete managed roles' };

  const roleName = role.name;
  await role.delete('SomniBot dashboard — role deleted');

  // Remove from discord_id_map
  await supabase
    .from('discord_id_map')
    .delete()
    .eq('guild_id', guild.id)
    .eq('entity_type', 'role')
    .eq('discord_id', roleId);

  // Remove from desired state
  const templateKey = payload.templateKey as string | undefined;
  if (templateKey) {
    await removeRoleFromDesiredState(supabase, guild.id, templateKey);
  }

  return { success: true, data: { roleId, name: roleName } };
}

async function handleCreateChannel(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const name = payload.name as string;
  const type = payload.type as number ?? ChannelType.GuildText;
  const parentId = payload.parentId as string | null ?? null;
  const topic = payload.topic as string | null ?? null;
  const nsfw = payload.nsfw as boolean ?? false;
  const rateLimitPerUser = payload.slowmode as number ?? 0;

  if (!name) return { success: false, error: 'Missing channel name' };

  const created = await guild.channels.create({
    name,
    type: type as ChannelType.GuildText,
    parent: parentId ?? undefined,
    topic: topic ?? undefined,
    nsfw,
    rateLimitPerUser,
    reason: 'SomniBot dashboard — channel created',
  });

  const templateKey = (payload.templateKey as string) ?? `ch-${created.id}`;
  await supabase.from('discord_id_map').upsert(
    {
      guild_id: guild.id,
      entity_type: 'channel',
      template_key: templateKey,
      discord_id: created.id,
    },
    { onConflict: 'guild_id,entity_type,template_key' },
  );

  return {
    success: true,
    data: { channelId: created.id, name: created.name, templateKey },
  };
}

async function handleUpdateChannel(
  guild: Guild,
  _supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const channelId = payload.channelId as string;
  if (!channelId) return { success: false, error: 'Missing channelId' };

  const channel = guild.channels.cache.get(channelId) as GuildChannel | undefined;
  if (!channel) return { success: false, error: `Channel ${channelId} not found` };

  const editOptions: Record<string, unknown> = { reason: 'SomniBot dashboard — channel updated' };
  if (payload.name !== undefined) editOptions.name = payload.name;
  if (payload.topic !== undefined) editOptions.topic = payload.topic;
  if (payload.nsfw !== undefined) editOptions.nsfw = payload.nsfw;
  if (payload.slowmode !== undefined) editOptions.rateLimitPerUser = payload.slowmode;
  if (payload.parentId !== undefined) editOptions.parent = payload.parentId || null;

  await channel.edit(editOptions as Parameters<typeof channel.edit>[0]);

  return { success: true, data: { channelId, name: channel.name } };
}

async function handleDeleteChannel(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const channelId = payload.channelId as string;
  if (!channelId) return { success: false, error: 'Missing channelId' };

  const channel = guild.channels.cache.get(channelId);
  if (!channel) return { success: false, error: `Channel ${channelId} not found` };

  const channelName = channel.name;
  await channel.delete('SomniBot dashboard — channel deleted');

  await supabase
    .from('discord_id_map')
    .delete()
    .eq('guild_id', guild.id)
    .eq('entity_type', 'channel')
    .eq('discord_id', channelId);

  return { success: true, data: { channelId, name: channelName } };
}

async function handleCreateCategory(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const name = payload.name as string;
  if (!name) return { success: false, error: 'Missing category name' };

  const category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: 'SomniBot dashboard — category created',
  });

  const templateKey = (payload.templateKey as string) ?? `cat-${category.id}`;
  await supabase.from('discord_id_map').upsert(
    {
      guild_id: guild.id,
      entity_type: 'category',
      template_key: templateKey,
      discord_id: category.id,
    },
    { onConflict: 'guild_id,entity_type,template_key' },
  );

  return {
    success: true,
    data: { categoryId: category.id, name: category.name, templateKey },
  };
}

async function handleDeleteCategory(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const categoryId = payload.categoryId as string;
  if (!categoryId) return { success: false, error: 'Missing categoryId' };

  const channel = guild.channels.cache.get(categoryId);
  if (!channel) return { success: false, error: `Category ${categoryId} not found` };
  if (channel.type !== ChannelType.GuildCategory)
    return { success: false, error: 'Not a category' };

  const categoryName = channel.name;
  await channel.delete('SomniBot dashboard — category deleted');

  await supabase
    .from('discord_id_map')
    .delete()
    .eq('guild_id', guild.id)
    .eq('entity_type', 'category')
    .eq('discord_id', categoryId);

  return { success: true, data: { categoryId, name: categoryName } };
}

// ============================================================
// Desired State Helpers
// ============================================================

async function addRoleToDesiredState(
  supabase: SupabaseClient,
  guildId: string,
  role: {
    key: string;
    name: string;
    tier: string;
    permissions: string;
    color: number;
    hoist: boolean;
    mentionable: boolean;
    position: number;
  },
): Promise<void> {
  const { data } = await supabase
    .from('guild_desired_state')
    .select('roles')
    .eq('guild_id', guildId)
    .single();

  const roles = (data?.roles ?? []) as Array<Record<string, unknown>>;
  roles.push(role);

  await supabase
    .from('guild_desired_state')
    .update({ roles, updated_at: new Date().toISOString() })
    .eq('guild_id', guildId);
}

async function updateRoleInDesiredState(
  supabase: SupabaseClient,
  guildId: string,
  templateKey: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { data } = await supabase
    .from('guild_desired_state')
    .select('roles')
    .eq('guild_id', guildId)
    .single();

  const roles = (data?.roles ?? []) as Array<Record<string, unknown>>;
  const idx = roles.findIndex((r) => r.key === templateKey);
  if (idx >= 0) {
    if (updates.name !== undefined) roles[idx].name = updates.name;
    if (updates.tier !== undefined) roles[idx].tier = updates.tier;
    if (updates.color !== undefined) roles[idx].color = updates.color;
    if (updates.hoist !== undefined) roles[idx].hoist = updates.hoist;
    if (updates.mentionable !== undefined) roles[idx].mentionable = updates.mentionable;
    if (updates.permissions !== undefined) roles[idx].permissions = updates.permissions;
    if (updates.position !== undefined) roles[idx].position = updates.position;

    await supabase
      .from('guild_desired_state')
      .update({ roles, updated_at: new Date().toISOString() })
      .eq('guild_id', guildId);
  }
}

async function removeRoleFromDesiredState(
  supabase: SupabaseClient,
  guildId: string,
  templateKey: string,
): Promise<void> {
  const { data } = await supabase
    .from('guild_desired_state')
    .select('roles')
    .eq('guild_id', guildId)
    .single();

  const roles = (data?.roles ?? []) as Array<Record<string, unknown>>;
  const filtered = roles.filter((r) => r.key !== templateKey);

  await supabase
    .from('guild_desired_state')
    .update({ roles: filtered, updated_at: new Date().toISOString() })
    .eq('guild_id', guildId);
}

// ============================================================
// Action Router
// ============================================================

const ACTION_HANDLERS: Record<
  string,
  (guild: Guild, supabase: SupabaseClient, payload: Record<string, unknown>) => Promise<ActionResult>
> = {
  create_role: handleCreateRole,
  update_role: handleUpdateRole,
  delete_role: handleDeleteRole,
  create_channel: handleCreateChannel,
  update_channel: handleUpdateChannel,
  delete_channel: handleDeleteChannel,
  create_category: handleCreateCategory,
  delete_category: handleDeleteCategory,
};

async function processAction(
  guild: Guild,
  supabase: SupabaseClient,
  action: ActionRow,
): Promise<void> {
  console.log(`[ActionQueue] Processing: ${action.action} (${action.id})`);

  // Mark as processing
  await supabase
    .from('bot_action_queue')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', action.id);

  const handler = ACTION_HANDLERS[action.action];
  let result: ActionResult;

  if (!handler) {
    if (action.action === 'refresh_snapshot') {
      await writeGuildSnapshot(guild, supabase);
      result = { success: true };
    } else {
      result = { success: false, error: `Unknown action: ${action.action}` };
    }
  } else {
    try {
      result = await handler(guild, supabase, action.payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ActionQueue] Error processing ${action.action}:`, msg);
      result = { success: false, error: msg };
    }
  }

  // Mark completed/failed
  await supabase
    .from('bot_action_queue')
    .update({
      status: result.success ? 'completed' : 'failed',
      result: result.data ?? null,
      error_message: result.error ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', action.id);

  // Audit log
  await writeAuditLog(supabase, {
    guildId: guild.id,
    actorType: 'dashboard',
    actorId: 'action-queue',
    action: `bot.${action.action}`,
    details: {
      actionId: action.id,
      payload: action.payload,
      result: result.data,
    },
    success: result.success,
    errorMessage: result.error,
  });

  // Always refresh snapshot after any mutation
  if (action.action !== 'refresh_snapshot') {
    await writeGuildSnapshot(guild, supabase);
  }

  console.log(
    `[ActionQueue] ${result.success ? '✅' : '❌'} ${action.action}: ` +
      (result.success ? JSON.stringify(result.data) : result.error),
  );
}

// ============================================================
// Listener Setup
// ============================================================

/**
 * Start listening for bot action queue items.
 *
 * 1. Process any existing pending actions (in case we missed them while offline)
 * 2. Subscribe to Realtime INSERT events on bot_action_queue
 */
export async function startActionQueueListener(
  guild: Guild,
  supabase: SupabaseClient,
): Promise<void> {
  console.log('[ActionQueue] Starting action queue listener');

  // Process any pending actions from while the bot was offline
  const { data: pending } = await supabase
    .from('bot_action_queue')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (pending && pending.length > 0) {
    console.log(`[ActionQueue] Processing ${pending.length} pending action(s)`);
    for (const action of pending) {
      await processAction(guild, supabase, action as ActionRow);
    }
  }

  // Subscribe to new inserts
  supabase
    .channel('bot-action-queue')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'bot_action_queue',
        filter: `guild_id=eq.${guild.id}`,
      },
      async (payload) => {
        const action = payload.new as ActionRow;
        if (action.status === 'pending') {
          await processAction(guild, supabase, action);
        }
      },
    )
    .subscribe((status) => {
      console.log(`[ActionQueue] Realtime subscription: ${status}`);
    });

  console.log('[ActionQueue] Action queue listener active');
}
