/**
 * Repair Actions — Handles repair/accept/ignore for individual drift items.
 *
 * Architecture doc §15.2 step 5:
 *   - "Repair" — Bot reapplies desired state
 *   - "Accept" — Update desired state to match current reality
 *   - "Ignore" — Dismiss this drift item
 */

import { ChannelType, type Guild, type GuildChannelTypes } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DriftItem } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';
import { writeAuditLog } from '../services/audit.js';

const log = createLogger('RepairActions');

type IdMapping = {
  template_key: string;
  entity_type: DriftItem['entityType'];
};

function isPermissionOverwriteDrift(driftItem: DriftItem): boolean {
  return driftItem.type === 'PERMISSION_DRIFT' &&
    (driftItem.entityType === 'channel' || driftItem.entityType === 'category');
}

function getDriftTemplateKey(driftItem: DriftItem): string | undefined {
  const raw = (driftItem as DriftItem & { templateKey?: unknown; template_key?: unknown }).templateKey
    ?? (driftItem as DriftItem & { templateKey?: unknown; template_key?: unknown }).template_key;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function templateKeyVariants(key: string | undefined, entityType: DriftItem['entityType']): string[] {
  if (!key) return [];
  const trimmed = key.trim();
  if (!trimmed) return [];
  const withoutPrefix = trimmed.includes(':') ? trimmed.slice(trimmed.indexOf(':') + 1) : trimmed;
  const withPrefix = trimmed.includes(':') ? trimmed : `${entityType}:${trimmed}`;
  return [...new Set([trimmed, withoutPrefix, withPrefix])];
}

function getConfigTemplateKey(config: Record<string, unknown>, entityType: DriftItem['entityType']): string | null {
  const raw = config.template_key ?? config.templateKey ?? config.key;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const variants = templateKeyVariants(raw, entityType);
  return variants[0] ?? raw.trim();
}

function getCanonicalTemplateKey(key: string | undefined, entityType: DriftItem['entityType']): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.includes(':') ? trimmed.slice(trimmed.indexOf(':') + 1) : trimmed;
  return `${entityType}:${withoutPrefix}`;
}

function configMatchesTemplateKey(
  config: Record<string, unknown>,
  mappingKey: string | undefined,
  entityType: DriftItem['entityType'],
): boolean {
  if (!mappingKey) return false;
  const configKey = getConfigTemplateKey(config, entityType);
  if (!configKey) return false;
  const mappingVariants = new Set(templateKeyVariants(mappingKey, entityType));
  return templateKeyVariants(configKey, entityType).some((variant) => mappingVariants.has(variant));
}

async function findMissingResourceMapping(
  guild: Guild,
  supabase: SupabaseClient,
  driftItem: DriftItem,
): Promise<IdMapping | null> {
  if (driftItem.entityDiscordId) {
    const { data } = await supabase
      .from('discord_id_map')
      .select('template_key, entity_type')
      .eq('guild_id', guild.id)
      .eq('discord_id', driftItem.entityDiscordId)
      .maybeSingle();
    if (data) return data as IdMapping;
  }

  for (const candidate of templateKeyVariants(getDriftTemplateKey(driftItem), driftItem.entityType)) {
    const { data } = await supabase
      .from('discord_id_map')
      .select('template_key, entity_type')
      .eq('guild_id', guild.id)
      .eq('entity_type', driftItem.entityType)
      .eq('template_key', candidate)
      .maybeSingle();
    if (data) return data as IdMapping;
  }

  return null;
}

/**
 * Repair a single drift item — revert Discord to desired state.
 */
export async function repairDriftItem(
  guild: Guild,
  supabase: SupabaseClient,
  driftItem: DriftItem,
): Promise<{ success: boolean; error?: string }> {
  try {
    switch (driftItem.type) {
      case 'EVERYONE_DRIFT': {
        const everyoneRole = guild.roles.everyone;
        await everyoneRole.setPermissions(0n, 'SomniBot repair — @everyone must be 0');
        await removeDriftFromDb(supabase, guild.id, driftItem);
        await writeAuditLog(supabase, {
          guildId: guild.id,
          actorType: 'bot',
          actorId: 'sync-engine',
          action: 'drift.repaired',
          targetType: 'role',
          targetId: everyoneRole.id,
          details: { type: 'EVERYONE_DRIFT' },
        });
        return { success: true };
      }

      case 'EXTERNAL_CHANGE':
      case 'PERMISSION_DRIFT': {
        if (driftItem.entityType === 'role' && driftItem.entityDiscordId) {
          return await repairRole(guild, supabase, driftItem);
        }
        if (
          driftItem.type === 'PERMISSION_DRIFT' &&
          (driftItem.entityType === 'channel' || driftItem.entityType === 'category')
        ) {
          return { success: false, error: `${driftItem.entityType} permission drift repair requires manual review` };
        }
        if ((driftItem.entityType === 'channel' || driftItem.entityType === 'category') && driftItem.entityDiscordId) {
          return await repairChannel(guild, supabase, driftItem);
        }
        return { success: false, error: 'Unknown entity type for repair' };
      }

      case 'MISSING_RESOURCE': {
        // Resource was deleted — need to recreate
        return await recreateResource(guild, supabase, driftItem);
      }

      case 'EXTRA_RESOURCE': {
        // Extra resource — "repair" means delete it
        if (driftItem.entityDiscordId) {
          if (driftItem.entityType === 'role') {
            const role = guild.roles.cache.get(driftItem.entityDiscordId);
            if (role && !role.managed) {
              await role.delete('SomniBot repair — removing extra resource');
            }
          } else {
            const channel = guild.channels.cache.get(driftItem.entityDiscordId);
            if (channel) {
              await channel.delete('SomniBot repair — removing extra resource');
            }
          }
          await removeDriftFromDb(supabase, guild.id, driftItem);
          return { success: true };
        }
        return { success: false, error: 'No Discord ID for extra resource' };
      }

      default:
        return { success: false, error: `Unknown drift type: ${driftItem.type}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[Sync:Repair] Failed to repair "${driftItem.entityName}":`, message);
    return { success: false, error: message };
  }
}

/**
 * Accept a drift item — update desired state to match current Discord reality.
 */
export async function acceptDriftItem(
  guild: Guild,
  supabase: SupabaseClient,
  driftItem: DriftItem,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (isPermissionOverwriteDrift(driftItem)) {
      return { success: false, error: `${driftItem.entityType} permission drift accept requires manual review` };
    }

    if (driftItem.entityType === 'everyone') {
      // Don't allow accepting @everyone drift — it's always supposed to be 0
      return { success: false, error: '@everyone drift cannot be accepted — it must always be 0' };
    }

    if (driftItem.type === 'EXTRA_RESOURCE' && driftItem.entityDiscordId) {
      // Accept an extra resource — add it to the ID map so it's tracked going forward
      const entityType = driftItem.entityType === 'category' ? 'category' : driftItem.entityType;
      const templateKey = `accepted:${driftItem.entityDiscordId}`;
      await supabase.from('discord_id_map').upsert({
        guild_id: guild.id,
        entity_type: entityType,
        template_key: templateKey,
        discord_id: driftItem.entityDiscordId,
      }, { onConflict: 'guild_id,entity_type,template_key' });
    }

    if ((driftItem.type === 'EXTERNAL_CHANGE' || driftItem.type === 'PERMISSION_DRIFT') && driftItem.entityDiscordId) {
      // Update the desired state JSONB array to match current reality.
      // guild_desired_state stores roles[] and channels[] as JSONB arrays per guild.
      const { data: state } = await supabase
        .from('guild_desired_state')
        .select('roles, channels')
        .eq('guild_id', guild.id)
        .maybeSingle();

      if (state) {
        if (driftItem.entityType === 'role') {
          const role = guild.roles.cache.get(driftItem.entityDiscordId);
          if (role) {
            // Find the template_key for this discord_id
            const { data: mapping } = await supabase
              .from('discord_id_map')
              .select('template_key')
              .eq('guild_id', guild.id)
              .eq('discord_id', role.id)
              .maybeSingle();

            if (mapping) {
              const rolesArr = (state.roles as Record<string, unknown>[]) ?? [];
              const idx = rolesArr.findIndex(
                (r) => (r.template_key ?? r.templateKey) === mapping.template_key,
              );
              const updated = {
                ...(idx >= 0 ? rolesArr[idx] : {}),
                template_key: mapping.template_key,
                name: role.name,
                permissions: role.permissions.bitfield.toString(),
                color: role.color,
                hoist: role.hoist,
                mentionable: role.mentionable,
              };
              if (idx >= 0) rolesArr[idx] = updated;
              else rolesArr.push(updated);

              await supabase
                .from('guild_desired_state')
                .update({ roles: rolesArr })
                .eq('guild_id', guild.id);
            }
          }
        } else if (driftItem.entityType === 'channel' || driftItem.entityType === 'category') {
          const channel = guild.channels.cache.get(driftItem.entityDiscordId);
          if (channel) {
            const { data: mapping } = await supabase
              .from('discord_id_map')
              .select('template_key')
              .eq('guild_id', guild.id)
              .eq('discord_id', channel.id)
              .maybeSingle();

            if (mapping) {
              const channelsArr = (state.channels as Record<string, unknown>[]) ?? [];
              const idx = channelsArr.findIndex(
                (c) => (c.template_key ?? c.templateKey) === mapping.template_key,
              );
              const config: Record<string, unknown> = {
                ...(idx >= 0 ? channelsArr[idx] : {}),
                template_key: mapping.template_key,
                name: channel.name,
                type: channel.type,
              };
              if ('topic' in channel) config.topic = channel.topic;
              if ('nsfw' in channel) config.nsfw = channel.nsfw;
              if ('rateLimitPerUser' in channel) config.slowmode = channel.rateLimitPerUser;

              if (idx >= 0) channelsArr[idx] = config;
              else channelsArr.push(config);

              await supabase
                .from('guild_desired_state')
                .update({ channels: channelsArr })
                .eq('guild_id', guild.id);
            }
          }
        }
      }
    }

    // Remove from drift list
    await removeDriftFromDb(supabase, guild.id, driftItem);

    await writeAuditLog(supabase, {
      guildId: guild.id,
      actorType: 'bot',
      actorId: 'sync-engine',
      action: 'drift.accepted',
      targetType: driftItem.entityType,
      targetId: driftItem.entityDiscordId ?? '',
      details: {
        entityName: driftItem.entityName,
        driftType: driftItem.type,
      },
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Ignore a drift item — remove it from the list without taking action.
 */
export async function ignoreDriftItem(
  supabase: SupabaseClient,
  guildId: string,
  driftItem: DriftItem,
): Promise<{ success: boolean; error?: string }> {
  try {
    await removeDriftFromDb(supabase, guildId, driftItem);

    await writeAuditLog(supabase, {
      guildId,
      actorType: 'bot',
      actorId: 'sync-engine',
      action: 'drift.ignored',
      targetType: driftItem.entityType,
      targetId: driftItem.entityDiscordId ?? '',
      details: { entityName: driftItem.entityName, driftType: driftItem.type },
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Clear all drift items.
 */
export async function clearAllDrift(
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  await supabase
    .from('guild_desired_state')
    .update({
      drift_detected: false,
      drift_details: [],
      last_sync_at: new Date().toISOString(),
    })
    .eq('guild_id', guildId);
}

// ============================================================
// Internal helpers
// ============================================================

async function removeDriftFromDb(
  supabase: SupabaseClient,
  guildId: string,
  itemToRemove: DriftItem,
): Promise<void> {
  const { data } = await supabase
    .from('guild_desired_state')
    .select('drift_details')
    .eq('guild_id', guildId)
    .maybeSingle();

  const items: DriftItem[] = Array.isArray(data?.drift_details) ? data.drift_details : [];
  const filtered = items.filter(
    (i) =>
      !(i.entityType === itemToRemove.entityType && i.entityName === itemToRemove.entityName),
  );

  await supabase
    .from('guild_desired_state')
    .update({
      drift_detected: filtered.length > 0,
      drift_details: filtered,
    })
    .eq('guild_id', guildId);
}

async function repairRole(
  guild: Guild,
  supabase: SupabaseClient,
  driftItem: DriftItem,
): Promise<{ success: boolean; error?: string }> {
  const role = guild.roles.cache.get(driftItem.entityDiscordId!);
  if (!role) return { success: false, error: 'Role not found in cache' };

  // Look up template_key for this role's discord_id
  const { data: mapping } = await supabase
    .from('discord_id_map')
    .select('template_key')
    .eq('guild_id', guild.id)
    .eq('discord_id', role.id)
    .maybeSingle();

  if (!mapping) {
    return { success: false, error: 'No ID mapping found for this role' };
  }

  // Look up desired config from the JSONB roles array
  const { data: state } = await supabase
    .from('guild_desired_state')
    .select('roles')
    .eq('guild_id', guild.id)
    .maybeSingle();

  const rolesArr = (state?.roles as Record<string, unknown>[]) ?? [];
  const config = rolesArr.find(
    (r) => (r.template_key ?? r.templateKey) === mapping.template_key,
  );

  if (!config) {
    return { success: false, error: 'No desired config found for this role' };
  }

  await role.edit({
    name: (config.name as string) ?? role.name,
    permissions: BigInt((config.permissions as string) ?? role.permissions.bitfield.toString()),
    color: (config.color as number) ?? role.color,
    hoist: (config.hoist as boolean) ?? role.hoist,
    mentionable: (config.mentionable as boolean) ?? role.mentionable,
    reason: 'SomniBot repair — restoring desired state',
  });

  await removeDriftFromDb(supabase, guild.id, driftItem);

  await writeAuditLog(supabase, {
    guildId: guild.id,
    actorType: 'bot',
    actorId: 'sync-engine',
    action: 'drift.repaired',
    targetType: 'role',
    targetId: role.id,
    details: { roleName: role.name },
  });

  return { success: true };
}

async function repairChannel(
  guild: Guild,
  supabase: SupabaseClient,
  driftItem: DriftItem,
): Promise<{ success: boolean; error?: string }> {
  const channel = guild.channels.cache.get(driftItem.entityDiscordId!);
  if (!channel) return { success: false, error: 'Channel not found in cache' };

  // Look up template_key for this channel's discord_id
  const { data: mapping } = await supabase
    .from('discord_id_map')
    .select('template_key')
    .eq('guild_id', guild.id)
    .eq('discord_id', channel.id)
    .maybeSingle();

  if (!mapping) {
    return { success: false, error: 'No ID mapping found for this channel' };
  }

  // Look up desired config from the JSONB channels array
  const { data: state } = await supabase
    .from('guild_desired_state')
    .select('channels')
    .eq('guild_id', guild.id)
    .maybeSingle();

  const channelsArr = (state?.channels as Record<string, unknown>[]) ?? [];
  const config = channelsArr.find(
    (c) => (c.template_key ?? c.templateKey) === mapping.template_key,
  );

  if (!config) {
    return { success: false, error: 'No desired config found for this channel' };
  }
  const editOptions: Record<string, unknown> = {};

  if (config.name && channel.name !== config.name) editOptions.name = config.name;
  if ('topic' in channel && config.topic !== undefined) editOptions.topic = config.topic;
  if ('nsfw' in channel && config.nsfw !== undefined) editOptions.nsfw = config.nsfw;
  if (config.slowmode !== undefined) editOptions.rateLimitPerUser = config.slowmode;

  if (Object.keys(editOptions).length > 0) {
    await channel.edit({
      ...editOptions,
      reason: 'SomniBot repair — restoring desired state',
    } as Record<string, unknown>);
  }

  await removeDriftFromDb(supabase, guild.id, driftItem);

  await writeAuditLog(supabase, {
    guildId: guild.id,
    actorType: 'bot',
    actorId: 'sync-engine',
    action: 'drift.repaired',
    targetType: 'channel',
    targetId: channel.id,
    details: { channelName: channel.name },
  });

  return { success: true };
}

async function recreateResource(
  guild: Guild,
  supabase: SupabaseClient,
  driftItem: DriftItem,
): Promise<{ success: boolean; error?: string }> {
  const mapping = await findMissingResourceMapping(guild, supabase, driftItem);
  const entityType = mapping?.entity_type ?? driftItem.entityType;

  // Look up desired config from the JSONB array
  const arrayKey = entityType === 'role' ? 'roles' : 'channels';
  const { data: state } = await supabase
    .from('guild_desired_state')
    .select('roles, channels')
    .eq('guild_id', guild.id)
    .maybeSingle();

  const stateRecord = state as Record<string, unknown> | null;
  const arr = (stateRecord?.[arrayKey] as Record<string, unknown>[]) ?? [];
  const driftTemplateKey = getDriftTemplateKey(driftItem);
  const config = arr.find((item) =>
    configMatchesTemplateKey(item, mapping?.template_key ?? driftTemplateKey, driftItem.entityType),
  ) ?? arr.find((item) => item.name === driftItem.entityName);

  if (!config) {
    return { success: false, error: 'No desired config found for recreating resource' };
  }

  const templateKey = getCanonicalTemplateKey(
    mapping?.template_key ?? getConfigTemplateKey(config, driftItem.entityType) ?? driftTemplateKey,
    entityType,
  );
  if (!templateKey) {
    return { success: false, error: 'No template key found for recreating resource' };
  }

  if (entityType === 'role') {
    const newRole = await guild.roles.create({
      name: (config.name as string) ?? driftItem.entityName,
      permissions: BigInt((config.permissions as string) ?? '0'),
      color: (config.color as number) ?? 0,
      hoist: (config.hoist as boolean) ?? false,
      mentionable: (config.mentionable as boolean) ?? false,
      reason: 'SomniBot repair — recreating deleted role',
    });

    // Update ID map with new Discord ID
    await supabase
      .from('discord_id_map')
      .upsert({
        guild_id: guild.id,
        entity_type: 'role',
        template_key: templateKey,
        discord_id: newRole.id,
      }, { onConflict: 'guild_id,entity_type,template_key' });

    await removeDriftFromDb(supabase, guild.id, driftItem);
    return { success: true };
  }

  if (entityType === 'channel' || entityType === 'category') {
    const channelType = (config.type as number) ?? 0;
    const parentId = config.parentId as string | undefined;

    // Map to a valid guild channel type
    const VALID_TYPES: GuildChannelTypes[] = [
      ChannelType.GuildText,
      ChannelType.GuildVoice,
      ChannelType.GuildCategory,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildStageVoice,
      ChannelType.GuildForum,
    ];
    const guildChannelType: GuildChannelTypes =
      VALID_TYPES.find((t) => t === channelType) ?? ChannelType.GuildText;

    const newChannel = await guild.channels.create({
      name: (config.name as string) ?? driftItem.entityName,
      type: guildChannelType,
      topic: (config.topic as string) ?? undefined,
      nsfw: (config.nsfw as boolean) ?? false,
      rateLimitPerUser: (config.slowmode as number) ?? 0,
      parent: parentId ?? undefined,
      reason: 'SomniBot repair — recreating deleted channel',
    });

    await supabase
      .from('discord_id_map')
      .upsert({
        guild_id: guild.id,
        entity_type: entityType,
        template_key: templateKey,
        discord_id: newChannel.id,
      }, { onConflict: 'guild_id,entity_type,template_key' });

    await removeDriftFromDb(supabase, guild.id, driftItem);
    return { success: true };
  }

  return { success: false, error: `Unknown entity type: ${entityType}` };
}
