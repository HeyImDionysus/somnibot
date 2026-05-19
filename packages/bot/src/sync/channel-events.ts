/**
 * Channel Event Drift Detection
 *
 * Detects drift in real-time when channels are created, updated, or deleted
 * outside of the dashboard/deployer.
 *
 * Architecture doc §15: "Event-based drift detection (role/channel update events)"
 */

import { ChannelType, type GuildChannel, type DMChannel, type NonThreadGuildBasedChannel } from 'discord.js';
import type { SomniClient } from '../client.js';
import type { DriftItem, DriftSeverity } from '@somnibot/shared';
import { writeAuditLog } from '../services/audit.js';

type GuildBasedChannel = Exclude<GuildChannel, DMChannel>;

/**
 * Channels the bot or Discord creates that should never be flagged as drift.
 * - Community-required channels (rules, moderator-only) are created by Discord itself
 * - Ticket channels are dynamically created/closed by the bot
 */
function isKnownDynamicChannel(channel: GuildBasedChannel): boolean {
  const guild = 'guild' in channel ? channel.guild : null;
  if (!guild) return false;

  // Discord Community-required channels — created by Discord, not the user
  if (guild.rulesChannelId === channel.id) return true;
  if (guild.publicUpdatesChannelId === channel.id) return true;
  if (channel.name === 'moderator-only') return true;

  // Ticket channels created by the bot (pattern: ticket-NNN-username or ticket-NNN)
  if (/^ticket-\d+/.test(channel.name)) return true;

  return false;
}

/**
 * Handle channelCreate — a new channel was created outside the dashboard.
 */
export async function handleChannelCreate(
  client: SomniClient,
  channel: GuildBasedChannel,
): Promise<void> {
  if (!('guild' in channel) || channel.guild.id !== client.guildId) return;

  // Skip channels we know aren't drift
  if (isKnownDynamicChannel(channel)) return;

  // Check if this channel is tracked in our ID map
  const { data: mapping } = await client.supabase
    .from('discord_id_map')
    .select('internal_id')
    .eq('guild_id', client.guildId)
    .eq('discord_id', channel.id)
    .maybeSingle();

  if (mapping) return; // Created by us — not drift

  const entityType = channel.type === ChannelType.GuildCategory ? 'category' : 'channel';

  console.log(`[Sync:Drift] New ${entityType} created externally: "${channel.name}" (${channel.id})`);

  const driftItem: DriftItem = {
    type: 'EXTRA_RESOURCE',
    severity: 'info',
    entityType: entityType as 'channel' | 'category',
    entityName: channel.name,
    entityDiscordId: channel.id,
    description: `${entityType === 'category' ? 'Category' : 'Channel'} "${channel.name}" was created outside the dashboard`,
    suggestedAction: 'accept',
  };

  await recordChannelDrift(client, [driftItem]);

  client.eventBus.emit('drift.detected', client.guildId, {
    driftCount: 1,
    criticalCount: 0,
    autoRepaired: false,
    items: [{ type: driftItem.type, entityName: driftItem.entityName, severity: driftItem.severity }],
  });
}

/**
 * Handle channelUpdate — a tracked channel was modified outside the dashboard.
 */
export async function handleChannelUpdate(
  client: SomniClient,
  oldChannel: GuildBasedChannel,
  newChannel: GuildBasedChannel,
): Promise<void> {
  if (!('guild' in newChannel) || newChannel.guild.id !== client.guildId) return;

  // Check if this channel is tracked
  const { data: mapping } = await client.supabase
    .from('discord_id_map')
    .select('internal_id')
    .eq('guild_id', client.guildId)
    .eq('discord_id', newChannel.id)
    .maybeSingle();

  if (!mapping) return; // Untracked — not drift

  // Compare changes
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (oldChannel.name !== newChannel.name) {
    changes['name'] = { from: oldChannel.name, to: newChannel.name };
  }
  if (oldChannel.position !== newChannel.position) {
    changes['position'] = { from: oldChannel.position, to: newChannel.position };
  }

  // Type-specific checks
  if ('topic' in oldChannel && 'topic' in newChannel) {
    const oldTopic = (oldChannel as { topic: string | null }).topic;
    const newTopic = (newChannel as { topic: string | null }).topic;
    if (oldTopic !== newTopic) {
      changes['topic'] = { from: oldTopic, to: newTopic };
    }
  }

  if ('nsfw' in oldChannel && 'nsfw' in newChannel) {
    const oldNsfw = (oldChannel as { nsfw: boolean }).nsfw;
    const newNsfw = (newChannel as { nsfw: boolean }).nsfw;
    if (oldNsfw !== newNsfw) {
      changes['nsfw'] = { from: oldNsfw, to: newNsfw };
    }
  }

  if ('rateLimitPerUser' in oldChannel && 'rateLimitPerUser' in newChannel) {
    const oldSlow = (oldChannel as { rateLimitPerUser: number }).rateLimitPerUser;
    const newSlow = (newChannel as { rateLimitPerUser: number }).rateLimitPerUser;
    if (oldSlow !== newSlow) {
      changes['slowmode'] = { from: oldSlow, to: newSlow };
    }
  }

  if ('parentId' in oldChannel && 'parentId' in newChannel) {
    const oldParent = (oldChannel as { parentId: string | null }).parentId;
    const newParent = (newChannel as { parentId: string | null }).parentId;
    if (oldParent !== newParent) {
      changes['parent'] = { from: oldParent, to: newParent };
    }
  }

  // Check permission overwrite changes
  if ('permissionOverwrites' in oldChannel && 'permissionOverwrites' in newChannel) {
    const oldOverwrites = oldChannel.permissionOverwrites.cache;
    const newOverwrites = newChannel.permissionOverwrites.cache;

    // Simple count check — detailed override diffing is in the periodic sync
    if (oldOverwrites.size !== newOverwrites.size) {
      changes['overwrite_count'] = { from: oldOverwrites.size, to: newOverwrites.size };
    } else {
      // Check if any overwrite values changed
      for (const [id, newOw] of newOverwrites) {
        const oldOw = oldOverwrites.get(id);
        if (!oldOw || oldOw.allow.bitfield !== newOw.allow.bitfield || oldOw.deny.bitfield !== newOw.deny.bitfield) {
          changes['permission_overwrites'] = { from: 'changed', to: 'modified' };
          break;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return;

  const hasPermissionChange = 'permission_overwrites' in changes || 'overwrite_count' in changes;
  const entityType = newChannel.type === ChannelType.GuildCategory ? 'category' : 'channel';

  console.log(
    `[Sync:Drift] ${entityType} "${newChannel.name}" modified externally:`,
    Object.keys(changes).join(', '),
  );

  const driftItem: DriftItem = {
    type: hasPermissionChange ? 'PERMISSION_DRIFT' : 'EXTERNAL_CHANGE',
    severity: hasPermissionChange ? 'warning' : 'info',
    entityType: entityType as 'channel' | 'category',
    entityName: newChannel.name,
    entityDiscordId: newChannel.id,
    description: `${entityType === 'category' ? 'Category' : 'Channel'} "${newChannel.name}" was modified outside the dashboard`,
    details: Object.fromEntries(
      Object.entries(changes).map(([k, v]) => [k, { expected: v.from, actual: v.to }]),
    ),
    suggestedAction: 'repair',
  };

  await recordChannelDrift(client, [driftItem]);

  // Auto-repair if configured
  const config = await getSyncConfig(client);
  if (config.autoRepair) {
    await autoRepairChannel(client, newChannel as NonThreadGuildBasedChannel, mapping.internal_id);
  }

  client.eventBus.emit('drift.detected', client.guildId, {
    driftCount: 1,
    criticalCount: 0,
    autoRepaired: config.autoRepair,
    items: [{ type: driftItem.type, entityName: driftItem.entityName, severity: driftItem.severity }],
  });
}

/**
 * Handle channelDelete — a tracked channel was deleted outside the dashboard.
 */
export async function handleChannelDelete(
  client: SomniClient,
  channel: GuildBasedChannel,
): Promise<void> {
  if (!('guild' in channel) || channel.guild.id !== client.guildId) return;

  // Check if tracked
  const { data: mapping } = await client.supabase
    .from('discord_id_map')
    .select('internal_id')
    .eq('guild_id', client.guildId)
    .eq('discord_id', channel.id)
    .maybeSingle();

  if (!mapping) return; // Untracked — not drift

  const entityType = channel.type === ChannelType.GuildCategory ? 'category' : 'channel';

  console.log(`[Sync:Drift] Tracked ${entityType} deleted: "${channel.name}" (${channel.id})`);

  const driftItem: DriftItem = {
    type: 'MISSING_RESOURCE',
    severity: 'warning',
    entityType: entityType as 'channel' | 'category',
    entityName: channel.name,
    entityDiscordId: channel.id,
    description: `${entityType === 'category' ? 'Category' : 'Channel'} "${channel.name}" was deleted from Discord. It exists in the desired state.`,
    suggestedAction: 'repair',
  };

  await recordChannelDrift(client, [driftItem]);

  client.eventBus.emit('drift.detected', client.guildId, {
    driftCount: 1,
    criticalCount: 0,
    autoRepaired: false,
    items: [{ type: driftItem.type, entityName: driftItem.entityName, severity: driftItem.severity }],
  });

  await writeAuditLog(client.supabase, {
    guildId: client.guildId,
    actorType: 'system',
    actorId: 'sync-engine',
    action: `drift.${entityType}_deleted`,
    targetType: entityType,
    targetId: channel.id,
    details: { channelName: channel.name, templateKey: mapping.internal_id },
  });
}

// ============================================================
// Helpers
// ============================================================

interface SyncConfigLocal {
  autoRepair: boolean;
}

async function getSyncConfig(client: SomniClient): Promise<SyncConfigLocal> {
  const cacheKey = `sync_config:${client.guildId}`;

  try {
    const cached = await client.valkey.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return { autoRepair: parsed.autoRepair ?? false };
    }
  } catch { /* miss */ }

  const { data } = await client.supabase
    .from('guild_config')
    .select('sync_auto_repair')
    .eq('guild_id', client.guildId)
    .maybeSingle();

  const config: SyncConfigLocal = {
    autoRepair: data?.sync_auto_repair ?? false,
  };

  try {
    await client.valkey.set(cacheKey, JSON.stringify(config), 'EX', 60);
  } catch { /* non-critical */ }

  return config;
}

/**
 * Record channel drift items to guild_desired_state.
 */
async function recordChannelDrift(
  client: SomniClient,
  newItems: DriftItem[],
): Promise<void> {
  const { data: current } = await client.supabase
    .from('guild_desired_state')
    .select('drift_details')
    .eq('guild_id', client.guildId)
    .maybeSingle();

  const existingItems: DriftItem[] = Array.isArray(current?.drift_details)
    ? current.drift_details
    : [];

  const merged = [...existingItems];
  for (const item of newItems) {
    const idx = merged.findIndex(
      (e) => e.entityType === item.entityType && e.entityName === item.entityName,
    );
    if (idx >= 0) {
      merged[idx] = item;
    } else {
      merged.push(item);
    }
  }

  await client.supabase
    .from('guild_desired_state')
    .update({
      drift_detected: merged.length > 0,
      drift_details: merged,
      last_sync_at: new Date().toISOString(),
    })
    .eq('guild_id', client.guildId);
}

/**
 * Auto-repair a channel to match desired state.
 */
async function autoRepairChannel(
  client: SomniClient,
  channel: NonThreadGuildBasedChannel,
  templateKey: string,
): Promise<void> {
  try {
    const { data: desired } = await client.supabase
      .from('guild_desired_state')
      .select('desired_config')
      .eq('guild_id', client.guildId)
      .eq('entity_type', 'channel')
      .eq('entity_id', templateKey)
      .maybeSingle();

    if (!desired?.desired_config) return;

    const config = desired.desired_config as Record<string, unknown>;

    const editOptions: Record<string, unknown> = {};
    if (config.name) editOptions.name = config.name;
    if (config.topic !== undefined) editOptions.topic = config.topic;
    if (config.nsfw !== undefined) editOptions.nsfw = config.nsfw;
    if (config.slowmode !== undefined) editOptions.rateLimitPerUser = config.slowmode;

    if (Object.keys(editOptions).length > 0) {
      await channel.edit({
        ...editOptions,
        reason: 'SomniBot auto-repair — restoring desired state',
      } as Record<string, unknown>);

      console.log(`[Sync:Drift] Auto-repaired channel "${channel.name}"`);

      await writeAuditLog(client.supabase, {
        guildId: client.guildId,
        actorType: 'bot',
        actorId: 'sync-engine',
        action: 'drift.auto_repair',
        targetType: 'channel',
        targetId: channel.id,
        details: { channelName: channel.name, templateKey },
      });
    }
  } catch (err) {
    console.error(`[Sync:Drift] Failed to auto-repair channel "${channel.name}":`, err);
  }
}
