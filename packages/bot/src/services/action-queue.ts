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
 * - send_embed: Send an embed template to a Discord channel
 * - test_welcome: Send a test welcome/goodbye message to a Discord channel
 */

import { ChannelType, EmbedBuilder, PermissionsBitField, type Guild, type GuildChannel, type TextChannel } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeGuildSnapshot } from './guild-snapshot.js';
import { writeAuditLog } from './audit.js';
import { CommerceFulfillmentService, type FulfillmentPayload } from './commerce-fulfillment.js';
import { eventBus } from './event-bus.js';
import { runReconciliation } from './reconciliation.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('ActionQueue');

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
  // Atomic: appends to the JSONB array in a single UPDATE (no read-modify-write race)
  const { error } = await supabase.rpc('desired_state_add_role', {
    p_guild_id: guildId,
    p_role: role,
  });
  if (error) {
    log.error('desired_state_add_role RPC failed:', error.message);
  }
}

async function updateRoleInDesiredState(
  supabase: SupabaseClient,
  guildId: string,
  templateKey: string,
  updates: Record<string, unknown>,
): Promise<void> {
  // Atomic: locks row FOR UPDATE, finds role by key, merges updates in SQL
  const roleUpdates: Record<string, unknown> = {};
  if (updates.name !== undefined) roleUpdates.name = updates.name;
  if (updates.tier !== undefined) roleUpdates.tier = updates.tier;
  if (updates.color !== undefined) roleUpdates.color = updates.color;
  if (updates.hoist !== undefined) roleUpdates.hoist = updates.hoist;
  if (updates.mentionable !== undefined) roleUpdates.mentionable = updates.mentionable;
  if (updates.permissions !== undefined) roleUpdates.permissions = updates.permissions;
  if (updates.position !== undefined) roleUpdates.position = updates.position;

  const { error } = await supabase.rpc('desired_state_update_role', {
    p_guild_id: guildId,
    p_template_key: templateKey,
    p_updates: roleUpdates,
  });
  if (error) {
    log.error('desired_state_update_role RPC failed:', error.message);
  }
}

async function removeRoleFromDesiredState(
  supabase: SupabaseClient,
  guildId: string,
  templateKey: string,
): Promise<void> {
  // Atomic: locks row FOR UPDATE, filters out the role by key in SQL
  const { error } = await supabase.rpc('desired_state_remove_role', {
    p_guild_id: guildId,
    p_template_key: templateKey,
  });
  if (error) {
    log.error('desired_state_remove_role RPC failed:', error.message);
  }
}

// ============================================================
// Action Router
// ============================================================

// ── Commerce Fulfillment Handler ──────────────────────

async function handleFulfillment(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const fulfillmentService = new CommerceFulfillmentService(guild, supabase, eventBus);
  const fulfillmentPayload = payload as unknown as FulfillmentPayload;

  const result = await fulfillmentService.fulfill(fulfillmentPayload);

  if (result.success) {
    return {
      success: true,
      data: {
        entitlementId: result.entitlementId,
        receiptSent: result.receiptSent,
        eventEmitted: result.eventEmitted,
      },
    };
  } else {
    return {
      success: false,
      error: result.errors.join('; '),
    };
  }
}

// ── Config Reload Handler ─────────────────────────────

async function handleConfigReload(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const section = payload.section as string;
  const changes = payload.changes as Record<string, unknown> | undefined;
  const changedBy = payload.changed_by as string | undefined;

  // Emit config.changed so the bot reloads
  eventBus.emit('config.changed', guild.id, {
    section: section ?? 'unknown',
    changes: changes ?? {},
    changedBy: changedBy ?? 'dashboard',
  });

  return { success: true, data: { section, reloaded: true } };
}

// ── Send Embed Handler ────────────────────────────────

interface EmbedConfig {
  title: string | null;
  description: string | null;
  color: number | null;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  image_url: string | null;
  thumbnail_url: string | null;
  footer_text: string | null;
  footer_icon_url: string | null;
  author_name: string | null;
  author_url: string | null;
  author_icon_url: string | null;
  include_timestamp: boolean;
}

function replaceEmbedVariables(text: string, guild: Guild): string {
  return text
    .replace(/\{server\}/g, guild.name)
    .replace(/\{server\.name\}/g, guild.name)
    .replace(/\{members\}/g, String(guild.memberCount))
    .replace(/\{memberCount\}/g, String(guild.memberCount))
    .replace(/\{date\}/g, new Date().toLocaleDateString())
    .replace(/\{time\}/g, new Date().toLocaleTimeString())
    .replace(/\{timestamp\}/g, String(Math.floor(Date.now() / 1000)));
}

function buildEmbedFromConfig(cfg: EmbedConfig, guild: Guild): EmbedBuilder {
  const embed = new EmbedBuilder();
  if (cfg.title) embed.setTitle(replaceEmbedVariables(cfg.title, guild));
  if (cfg.description) embed.setDescription(replaceEmbedVariables(cfg.description, guild));
  if (cfg.color != null) embed.setColor(cfg.color);
  if (cfg.image_url) embed.setImage(cfg.image_url);
  if (cfg.thumbnail_url) embed.setThumbnail(cfg.thumbnail_url);
  if (cfg.footer_text) embed.setFooter({
    text: replaceEmbedVariables(cfg.footer_text, guild),
    iconURL: cfg.footer_icon_url ?? undefined,
  });
  if (cfg.author_name) embed.setAuthor({
    name: replaceEmbedVariables(cfg.author_name, guild),
    url: cfg.author_url ?? undefined,
    iconURL: cfg.author_icon_url ?? undefined,
  });
  if (cfg.include_timestamp) embed.setTimestamp();
  if (cfg.fields?.length) {
    for (const field of cfg.fields) {
      embed.addFields({
        name: replaceEmbedVariables(field.name, guild),
        value: replaceEmbedVariables(field.value, guild),
        inline: field.inline ?? false,
      });
    }
  }
  return embed;
}

async function handleSendEmbed(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  // V52-L5: the dashboard embeds/send route puts `embed_config_id` in the
  // payload, but this handler was reading `embed_id` — accept both for
  // backward-compat with any older queued rows.
  const embedId = (payload.embed_config_id ?? payload.embed_id) as string;
  const channelId = payload.channel_id as string;
  if (!embedId) return { success: false, error: 'Missing embed_config_id / embed_id' };
  if (!channelId) return { success: false, error: 'Missing channel_id' };

  // Look up embed config (guild_id scoped for multi-guild safety)
  const { data, error: dbError } = await supabase
    .from('embed_configs')
    .select('*')
    .eq('id', embedId)
    .eq('guild_id', guild.id)
    .maybeSingle();

  if (dbError || !data) {
    return { success: false, error: `Embed config "${embedId}" not found` };
  }

  const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel?.isTextBased()) {
    return { success: false, error: `Channel ${channelId} not found or not text-based` };
  }

  const embed = buildEmbedFromConfig(data as EmbedConfig, guild);
  const sent = await channel.send({ embeds: [embed] });

  log.info(`Embed "${data.name ?? embedId}" sent to #${channel.name}`);
  return { success: true, data: { messageId: sent.id, channelId, embedName: data.name } };
}

// ── Test Welcome Handler ──────────────────────────────

async function handleTestWelcome(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const channelId = payload.channel_id as string;
  const type = (payload.type as string) ?? 'welcome';
  if (!channelId) return { success: false, error: 'Missing channel_id' };

  const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel?.isTextBased()) {
    return { success: false, error: `Channel ${channelId} not found or not text-based` };
  }

  // Load current welcome config
  const { data: configData } = await supabase
    .from('guild_config')
    .select('*')
    .eq('guild_id', guild.id)
    .maybeSingle();

  // Build mock variables for the test message
  const botMember = guild.members.me;
  const mockVars: Record<string, string> = {
    user: `<@${botMember?.id ?? guild.client.user?.id ?? '0'}>`,
    'user.name': botMember?.displayName ?? 'TestUser',
    'user.tag': botMember?.user.tag ?? 'TestUser#0',
    'user.avatar': botMember?.user.displayAvatarURL({ size: 256 }) ?? '',
    server: guild.name,
    'server.icon': guild.iconURL({ size: 256 }) ?? '',
    memberCount: guild.memberCount.toLocaleString(),
    memberNumber: `#${guild.memberCount.toLocaleString()}`,
    level: '0',
    duration: '42 days',
  };

  function interpolate(template: string): string {
    return template.replace(/\{([^}]+)\}/g, (match, key: string) => {
      return mockVars[key.trim()] ?? match;
    });
  }

  const defaultWelcome = 'Welcome to {server}, {user}! 🎉 You\'re member {memberNumber}.';
  const defaultGoodbye = '{user.name} left. They were with us for {duration}. 👋';

  let messageText: string;
  if (type === 'goodbye') {
    messageText = interpolate(configData?.goodbye_message ?? defaultGoodbye);
  } else {
    messageText = interpolate(configData?.welcome_message ?? defaultWelcome);
  }

  const label = type === 'goodbye' ? '👋 Goodbye' : '🎉 Welcome';
  const sent = await channel.send(`**[TEST ${label} Preview]**\n${messageText}`);

  log.info(`Test ${type} message sent to #${channel.name}`);
  return { success: true, data: { messageId: sent.id, channelId, type } };
}

/**
 * Revoke Discord roles from a member (e.g., after a refund).
 */
async function handleRevokeRoles(
  guild: Guild,
  _supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const discordId = payload.discord_id as string;
  const roleIds = payload.role_ids as string[];
  const reason = (payload.reason as string) || 'Role revocation';

  if (!discordId) return { success: false, error: 'Missing discord_id' };
  if (!roleIds || !Array.isArray(roleIds) || roleIds.length === 0) {
    return { success: false, error: 'Missing or empty role_ids' };
  }

  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) {
    return { success: false, error: `Member ${discordId} not found in guild` };
  }

  const removed: string[] = [];
  const failed: string[] = [];

  for (const roleId of roleIds) {
    if (member.roles.cache.has(roleId)) {
      try {
        await member.roles.remove(roleId, `SomniBot — ${reason}`);
        removed.push(roleId);
      } catch {
        failed.push(roleId);
      }
    }
  }

  log.info(`Revoked ${removed.length} roles from ${discordId} (${reason})`);
  if (failed.length > 0) {
    log.warn(`Failed to revoke ${failed.length} roles from ${discordId}:`, failed);
  }

  return {
    success: true,
    data: { discordId, removed, failed, reason },
  };
}

/**
 * Handle manual reconciliation trigger from the dashboard.
 */
async function handleRunReconciliation(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const trigger = (payload.trigger as string) || 'manual';
  try {
    await runReconciliation(guild, supabase, trigger as 'manual' | 'scheduled' | 'startup');
    return { success: true, data: { trigger } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Reconciliation failed: ${msg}` };
  }
}

// V53-M4: Retry failed inventory returns from market cancel/buy failures.
// Queued automatically when economy_upsert_inventory fails during market operations.
async function handleMarketItemReconcile(
  _guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const guildId = payload.guild_id as string;
  const userId = payload.user_id as string;
  const itemId = payload.item_id as string;
  const quantity = payload.quantity as number;

  if (!guildId || !userId || !itemId || !quantity) {
    return { success: false, error: 'Missing required fields for market item reconcile' };
  }

  const { error } = await supabase.rpc('economy_upsert_inventory', {
    p_guild_id: guildId,
    p_user_id: userId,
    p_item_id: itemId,
    p_quantity: quantity,
  });

  if (error) {
    return { success: false, error: `Inventory return still failing: ${error.message}` };
  }

  log.info(`market_item_reconcile: returned ${quantity}x ${payload.item_name ?? itemId} to ${userId}`);
  return { success: true, data: { userId, itemId, quantity } };
}

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
  fulfill_purchase: handleFulfillment,
  fulfill_subscription: handleFulfillment,
  fulfill_cancellation: handleFulfillment,
  fulfill_suspension: handleFulfillment,
  config_reload: handleConfigReload,
  send_embed: handleSendEmbed,
  test_welcome: handleTestWelcome,
  fulfill_giveaway_prize: handleFulfillment,
  run_reconciliation: handleRunReconciliation,
  revoke_roles: handleRevokeRoles,
  market_item_reconcile: handleMarketItemReconcile,
};

async function processAction(
  guild: Guild,
  supabase: SupabaseClient,
  action: ActionRow,
): Promise<void> {
  // V48-C3: atomic claim. Two paths feed processAction (the startup
  // `pending` sweep and the Realtime INSERT subscription), and a third
  // path (`bot_action_queue_recover_stale`) re-queues rows that crashed
  // mid-process. Without an atomic claim, two of those paths can both
  // pick up the same row, double-creating Discord entities, double-
  // fulfilling orders, or duplicating role revokes. The RPC returns
  // the row iff status was still 'pending' when this caller flipped it.
  const { data: claimed, error: claimErr } = await (supabase as DbRow).rpc(
    'bot_action_queue_claim',
    { p_action_id: action.id },
  );
  if (claimErr) {
    log.error(`Claim RPC failed for ${action.id}:`, claimErr.message);
    return;
  }
  const claimedRow = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!claimedRow) {
    log.info(`Skipping ${action.id} — already claimed by another worker`);
    return;
  }

  log.info(`Processing: ${action.action} (${action.id})`);

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
      log.error(`Error processing ${action.action}:`, msg);
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

  log.info(
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
// V48-C3: how long an action can be stuck in 'processing' before we
// assume the worker crashed and re-queue it (or fail it if the retry
// budget is exhausted).
const STALE_PROCESSING_TIMEOUT_SECS = 300; // 5 minutes
const STALE_RECOVERY_INTERVAL_MS = 60_000; // sweep every minute
const ACTION_QUEUE_MAX_RETRIES = 5;

async function recoverStaleActions(
  guild: Guild,
  supabase: SupabaseClient,
): Promise<void> {
  const { data: recovered, error } = await (supabase as DbRow).rpc(
    'bot_action_queue_recover_stale',
    {
      p_guild_id: guild.id,
      p_timeout_seconds: STALE_PROCESSING_TIMEOUT_SECS,
      p_max_retries: ACTION_QUEUE_MAX_RETRIES,
    },
  );
  if (error) {
    log.error('Stale recovery failed:', error.message);
    return;
  }
  const rows: Array<{ id: string; action: string; was_failed: boolean }> = recovered ?? [];
  if (rows.length === 0) return;

  const failedRows = rows.filter((r) => r.was_failed);
  const failedCount = failedRows.length;
  const requeuedCount = rows.length - failedCount;
  if (failedCount > 0) {
    log.warn(`DLQ: ${failedCount} action(s) failed after exhausting retries`);
    // V53 Phase 2: Write failed actions to DLQ table for dashboard visibility
    for (const row of failedRows) {
      try {
        // Fetch full action row for payload + error
        const { data: fullRow } = await supabase
          .from('bot_action_queue')
          .select('action, payload, error_message, retry_count')
          .eq('id', row.id)
          .maybeSingle();
        if (fullRow) {
          await supabase.from('action_queue_dlq').insert({
            guild_id: guild.id,
            action: fullRow.action,
            payload: fullRow.payload ?? {},
            error_message: fullRow.error_message ?? 'Unknown error after max retries',
            retry_count: fullRow.retry_count ?? 0,
            max_retries: ACTION_QUEUE_MAX_RETRIES,
            original_id: row.id,
          });
        }
      } catch (dlqErr) {
        log.error(`Failed to write DLQ entry for ${row.id}:`, dlqErr);
      }
    }
  }
  if (requeuedCount > 0) {
    log.info(`Re-queued ${requeuedCount} stale action(s) for processing`);
    // The recovery RPC flipped them back to 'pending', but Realtime only
    // fires on INSERT — re-fetch and feed them through processAction so
    // they get picked up immediately on this worker instead of waiting
    // for the next restart.
    const requeuedIds = rows.filter((r) => !r.was_failed).map((r) => r.id);
    const { data: rows2 } = await supabase
      .from('bot_action_queue')
      .select('*')
      .in('id', requeuedIds);
    for (const r of (rows2 ?? []) as ActionRow[]) {
      if (r.status === 'pending') {
        await processAction(guild, supabase, r);
      }
    }
  }
}

export async function startActionQueueListener(
  guild: Guild,
  supabase: SupabaseClient,
): Promise<void> {
  log.info('Starting action queue listener');

  // V48-C3: before processing pending rows, recover anything stuck in
  // 'processing' from a previous bot crash. This is the DLQ-equivalent —
  // exhausted retries become 'failed', everything else flips back to
  // 'pending' and is picked up by the loop below.
  await recoverStaleActions(guild, supabase);

  // Process any pending actions from while the bot was offline
  const { data: pending } = await supabase
    .from('bot_action_queue')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (pending && pending.length > 0) {
    log.info(`Processing ${pending.length} pending action(s)`);
    for (const action of pending) {
      await processAction(guild, supabase, action as ActionRow);
    }
  }

  // Periodic stale-row sweep (runs in addition to the startup pass so
  // long-running deployments don't accumulate stuck rows).
  setInterval(() => {
    recoverStaleActions(guild, supabase).catch((err) => {
      log.error('Stale recovery sweep error:', { error: String(err) });
    });
  }, STALE_RECOVERY_INTERVAL_MS).unref?.();

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
      log.info(`Realtime subscription: ${status}`);
    });

  log.info('Action queue listener active');
}
