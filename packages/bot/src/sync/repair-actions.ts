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
import { recordAdminChange, undoByDeleting } from '../services/admin-changes.js';

const log = createLogger('RepairActions');

type IdMapping = {
  template_key: string;
  entity_type: DriftItem['entityType'];
  discord_id?: string;
};

type PermissionOverwriteIdentity = {
  channelKey: string;
  channelDiscordId: string;
  roleKey: string;
  roleDiscordId?: string;
};

type PermissionOverwriteLike = {
  id?: string;
  allow?: unknown;
  deny?: unknown;
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

function unprefixedTemplateKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.includes(':') ? trimmed.slice(trimmed.indexOf(':') + 1) : trimmed;
}

function detailString(driftItem: DriftItem, key: string): string | undefined {
  const detail = driftItem.details?.[key];
  const actual = detail?.actual;
  const expected = detail?.expected;
  if (typeof actual === 'string' && actual.trim()) return actual.trim();
  if (typeof expected === 'string' && expected.trim()) return expected.trim();
  return undefined;
}

function getPermissionOverwriteIdentity(driftItem: DriftItem): PermissionOverwriteIdentity | null {
  if (!isPermissionOverwriteDrift(driftItem) || driftItem.entityType !== 'channel') return null;

  const channelKey = getDriftTemplateKey(driftItem) ?? detailString(driftItem, 'overrideChannelKey');
  const channelDiscordId = driftItem.entityDiscordId ?? detailString(driftItem, 'overrideChannelId');
  const roleKey = detailString(driftItem, 'overrideRoleKey');
  const roleDiscordId = detailString(driftItem, 'overrideRoleId');

  if (!channelKey || !channelDiscordId || !roleKey) return null;

  return {
    channelKey,
    channelDiscordId,
    roleKey,
    roleDiscordId,
  };
}

function bitfieldString(value: unknown): string | null {
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string') {
    return value.toString();
  }
  if (value && typeof value === 'object' && 'bitfield' in value) {
    const bitfield = (value as { bitfield?: unknown }).bitfield;
    if (typeof bitfield === 'bigint' || typeof bitfield === 'number' || typeof bitfield === 'string') {
      return bitfield.toString();
    }
  }
  return null;
}

function getCurrentOverwrite(
  channel: unknown,
  roleDiscordId: string,
): PermissionOverwriteLike | null {
  const permissionOverwrites = (channel as {
    permissionOverwrites?: {
      cache?: {
        get?: (id: string) => unknown;
        find?: (fn: (value: PermissionOverwriteLike) => boolean) => unknown;
        values?: () => IterableIterator<unknown>;
      };
    };
  }).permissionOverwrites;

  const cache = permissionOverwrites?.cache;
  const direct = cache?.get?.(roleDiscordId);
  if (direct) return direct as PermissionOverwriteLike;

  const found = cache?.find?.((overwrite) => overwrite.id === roleDiscordId);
  if (found) return found as PermissionOverwriteLike;

  if (cache?.values) {
    for (const value of cache.values()) {
      const overwrite = value as PermissionOverwriteLike;
      if (overwrite.id === roleDiscordId) return overwrite;
    }
  }

  return null;
}

function desiredOverrideMatchesRole(override: Record<string, unknown>, roleKey: string): boolean {
  const raw = override.roleKey ?? override.role_key ?? override.templateKey ?? override.template_key;
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const roleVariants = new Set(templateKeyVariants(roleKey, 'role'));
  return templateKeyVariants(raw, 'role').some((variant) => roleVariants.has(variant));
}

async function findMappingByTemplateKey(
  guild: Guild,
  supabase: SupabaseClient,
  entityType: DriftItem['entityType'],
  templateKey: string | undefined,
): Promise<IdMapping | null> {
  for (const candidate of templateKeyVariants(templateKey, entityType)) {
    const { data } = await supabase
      .from('discord_id_map')
      .select('template_key, entity_type, discord_id')
      .eq('guild_id', guild.id)
      .eq('entity_type', entityType)
      .eq('template_key', candidate)
      .maybeSingle();
    if (data) return data as IdMapping;
  }

  return null;
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
        if (driftItem.type === 'EXTERNAL_CHANGE' && driftItem.entityType === 'category') {
          // Categories are not persisted in guild_desired_state (only roles/channels
          // are stored), so there is no desired category name to restore. Routing
          // this into repairChannel only yields a misleading "not in desired state"
          // error — surface it honestly for manual review instead.
          return { success: false, error: 'Category external changes have no persisted desired state to restore — manual review required' };
        }
        if (driftItem.entityType === 'channel' && driftItem.entityDiscordId) {
          return await repairChannel(guild, supabase, driftItem);
        }
        return { success: false, error: 'Unknown entity type for repair' };
      }

      case 'HIERARCHY_DRIFT': {
        // Role positions drifted from the desired ordering — reorder back to
        // desired. Mirrors the sync engine's auto-repair (reorderRolesToDesired)
        // so the dashboard "Repair" button actually performs the reorder the
        // drift item advertises instead of falling through to "Unknown drift type".
        if (driftItem.entityType !== 'role') {
          return { success: false, error: `Hierarchy repair not supported for ${driftItem.entityType}` };
        }
        return await repairHierarchy(guild, supabase, driftItem);
      }

      case 'MISSING_RESOURCE': {
        // Resource was deleted — need to recreate
        return await recreateResource(guild, supabase, driftItem);
      }

      case 'EXTRA_RESOURCE': {
        // Extra resource — "repair" means delete it
        if (driftItem.entityDiscordId) {
          // Capture what it was before it stops existing: this is the one
          // repair that destroys something the owner may have made by hand,
          // and afterwards there is nothing left to describe it with.
          let deletedName: string | null = null;
          if (driftItem.entityType === 'role') {
            const role = guild.roles.cache.get(driftItem.entityDiscordId);
            if (role && !role.managed) {
              deletedName = role.name;
              await role.delete('SomniBot repair — removing extra resource');
            }
          } else {
            const channel = guild.channels.cache.get(driftItem.entityDiscordId);
            if (channel) {
              deletedName = channel.name;
              await channel.delete('SomniBot repair — removing extra resource');
            }
          }

          if (deletedName !== null) {
            await recordAdminChange(supabase, {
              guildId: guild.id,
              actorId: 'sync-engine',
              action: `drift_repair.${driftItem.entityType}_deleted`,
              targetType: driftItem.entityType,
              targetId: driftItem.entityDiscordId,
              description:
                `Drift repair deleted the ${driftItem.entityType} "${deletedName}" `
                + 'because it was not part of the server template.',
              before: { name: deletedName, discord_id: driftItem.entityDiscordId },
              after: null,
              blastRadius: 'critical',
              // Deliberately no undo. Recreating it would produce a different
              // Discord id, and for a channel every message in it is already
              // gone — an "undo" button here would be a lie.
              undoReason:
                driftItem.entityType === 'role'
                  ? 'recreating the role would assign a new ID and no member would regain it'
                  : 'the channel and its message history no longer exist',
            });
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
      return await acceptPermissionOverwriteDrift(guild, supabase, driftItem);
    }

    if (driftItem.entityType === 'everyone') {
      // Don't allow accepting @everyone drift — it's always supposed to be 0
      return { success: false, error: '@everyone drift cannot be accepted — it must always be 0' };
    }

    if (driftItem.type === 'HIERARCHY_DRIFT') {
      // Accepting hierarchy drift means "the current Discord ordering is now the
      // desired ordering". Unlike EXTERNAL_CHANGE we cannot just copy one
      // entity's attributes — role hierarchy is a relative ordering across the
      // whole mapped set, so we must rewrite every mapped role's desired
      // `position` from its live Discord position. Without this the row is
      // merely removed and the next diff recomputes the same inversion, re-adding
      // the drift forever.
      return await acceptHierarchyDrift(guild, supabase, driftItem);
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
 * Accept role hierarchy drift — persist the observed Discord ordering as the
 * new desired ordering.
 *
 * Reads every mapped role's live Discord position, sorts the mapped roles by
 * that position, and rewrites their desired `position` fields to a contiguous
 * 0..N-1 sequence in that observed order. This makes the accepted ordering
 * stick: the next diff computes zero inversions instead of re-adding the same
 * drift. Roles present in desired state but with no live Discord mapping are
 * left untouched.
 */
async function acceptHierarchyDrift(
  guild: Guild,
  supabase: SupabaseClient,
  driftItem: DriftItem,
): Promise<{ success: boolean; error?: string }> {
  const { data: state } = await supabase
    .from('guild_desired_state')
    .select('roles')
    .eq('guild_id', guild.id)
    .maybeSingle();

  const desiredRoles = (state?.roles as Record<string, unknown>[]) ?? [];
  if (desiredRoles.length === 0) {
    return { success: false, error: 'No desired roles configured' };
  }

  // Load role ID mappings so desired keys resolve to live Discord roles.
  const { data: mappings } = await supabase
    .from('discord_id_map')
    .select('template_key, discord_id')
    .eq('guild_id', guild.id)
    .eq('entity_type', 'role')
    .limit(1000);

  const idMap = new Map<string, string>();
  for (const m of (mappings ?? []) as Array<{ template_key: string; discord_id: string }>) {
    idMap.set(m.template_key, m.discord_id);
  }

  const resolveRoleId = (rawKey: string): string | undefined => {
    const bare = unprefixedTemplateKey(rawKey);
    return (
      idMap.get(`role:${bare}`) ??
      idMap.get(bare) ??
      idMap.get(rawKey) ??
      idMap.get(`role:${rawKey}`)
    );
  };

  // Resolve each desired role to its live Discord position, if any.
  const withLivePosition: Array<{ idx: number; actualPosition: number }> = [];
  desiredRoles.forEach((def, idx) => {
    const rawKey = (def.template_key ?? def.templateKey ?? def.key) as string | undefined;
    if (!rawKey) return;
    const discordId = resolveRoleId(rawKey);
    if (!discordId) return;
    const role = guild.roles.cache.get(discordId);
    if (!role || role.managed) return;
    withLivePosition.push({ idx, actualPosition: role.position });
  });

  if (withLivePosition.length < 2) {
    return { success: false, error: 'Fewer than two mapped roles resolved — no ordering to accept' };
  }

  // Order the resolved roles by their live Discord position (ascending), then
  // assign contiguous desired positions reflecting that observed order.
  const ordered = [...withLivePosition].sort((a, b) => a.actualPosition - b.actualPosition);
  const nextRoles = desiredRoles.map((def) => ({ ...def }));
  ordered.forEach((entry, order) => {
    nextRoles[entry.idx].position = order;
  });

  await supabase
    .from('guild_desired_state')
    .update({ roles: nextRoles })
    .eq('guild_id', guild.id);

  await removeDriftFromDb(supabase, guild.id, driftItem);

  await writeAuditLog(supabase, {
    guildId: guild.id,
    actorType: 'bot',
    actorId: 'sync-engine',
    action: 'drift.accepted',
    targetType: 'role',
    targetId: driftItem.entityDiscordId ?? '',
    details: {
      entityName: driftItem.entityName,
      driftType: 'HIERARCHY_DRIFT',
      reordered: ordered.length,
    },
  });

  return { success: true };
}

async function acceptPermissionOverwriteDrift(
  guild: Guild,
  supabase: SupabaseClient,
  driftItem: DriftItem,
): Promise<{ success: boolean; error?: string }> {
  const identity = getPermissionOverwriteIdentity(driftItem);
  if (!identity) {
    return {
      success: false,
      error: `${driftItem.entityType} permission drift accept requires structured permission overwrite details`,
    };
  }

  const channel = guild.channels.cache.get(identity.channelDiscordId);
  if (!channel) return { success: false, error: 'Channel not found in cache' };

  const roleKey = unprefixedTemplateKey(identity.roleKey);
  const roleDiscordId = identity.roleDiscordId ?? (roleKey === 'everyone' ? guild.id : undefined);
  if (!roleDiscordId) {
    return { success: false, error: 'Permission overwrite accept requires role Discord ID' };
  }

  const channelMapping = await findMappingByTemplateKey(guild, supabase, 'channel', identity.channelKey);
  if (!channelMapping?.discord_id) {
    return { success: false, error: 'No ID mapping found for this channel permission overwrite' };
  }
  if (channelMapping.discord_id !== identity.channelDiscordId) {
    return { success: false, error: 'Permission overwrite channel key does not match channel Discord ID' };
  }

  if (roleKey === 'everyone') {
    if (roleDiscordId !== guild.id) {
      return { success: false, error: 'Permission overwrite role key does not match @everyone Discord ID' };
    }
  } else {
    const roleMapping = await findMappingByTemplateKey(guild, supabase, 'role', roleKey);
    if (!roleMapping?.discord_id) {
      return { success: false, error: 'No ID mapping found for this role permission overwrite' };
    }
    if (roleMapping.discord_id !== roleDiscordId) {
      return { success: false, error: 'Permission overwrite role key does not match role Discord ID' };
    }
  }

  const { data: state } = await supabase
    .from('guild_desired_state')
    .select('channels')
    .eq('guild_id', guild.id)
    .maybeSingle();

  const channelsArr = (state?.channels as Record<string, unknown>[]) ?? [];
  const channelIdx = channelsArr.findIndex((config) =>
    configMatchesTemplateKey(config, identity.channelKey, 'channel')
  );

  if (channelIdx < 0) {
    return { success: false, error: 'No desired config found for this channel permission overwrite' };
  }

  const nextChannels = channelsArr.map((config, idx) =>
    idx === channelIdx ? { ...config } : config,
  );
  const channelConfig = nextChannels[channelIdx];
  const currentOverrides = Array.isArray(channelConfig.overrides)
    ? [...(channelConfig.overrides as Record<string, unknown>[])]
    : [];
  const overwriteIdx = currentOverrides.findIndex((override) =>
    desiredOverrideMatchesRole(override, identity.roleKey)
  );

  const currentOverwrite = getCurrentOverwrite(channel, roleDiscordId);
  let nextOverrides: Record<string, unknown>[];

  if (currentOverwrite) {
    const allow = bitfieldString(currentOverwrite.allow);
    const deny = bitfieldString(currentOverwrite.deny);
    if (allow === null || deny === null) {
      return { success: false, error: 'Current permission overwrite has unreadable allow/deny bitfields' };
    }

    const acceptedOverride = {
      ...(overwriteIdx >= 0 ? currentOverrides[overwriteIdx] : {}),
      roleKey,
      allow,
      deny,
    };

    nextOverrides = [...currentOverrides];
    if (overwriteIdx >= 0) nextOverrides[overwriteIdx] = acceptedOverride;
    else nextOverrides.push(acceptedOverride);
  } else {
    nextOverrides = currentOverrides.filter((override) =>
      !desiredOverrideMatchesRole(override, identity.roleKey)
    );
  }

  channelConfig.overrides = nextOverrides;

  const { error: updateError } = await supabase
    .from('guild_desired_state')
    .update({ channels: nextChannels })
    .eq('guild_id', guild.id);

  if (updateError) {
    const message = updateError instanceof Error
      ? updateError.message
      : typeof updateError === 'object' && updateError && 'message' in updateError
        ? String((updateError as { message?: unknown }).message)
        : String(updateError);
    return { success: false, error: `Failed to update desired channel overwrites: ${message}` };
  }

  await removeDriftFromDb(supabase, guild.id, driftItem);

  await writeAuditLog(supabase, {
    guildId: guild.id,
    actorType: 'bot',
    actorId: 'sync-engine',
    action: 'drift.accepted',
    targetType: 'channel',
    targetId: identity.channelDiscordId,
    details: {
      entityName: driftItem.entityName,
      driftType: driftItem.type,
      channelKey: identity.channelKey,
      roleKey,
      roleDiscordId,
    },
  });

  return { success: true };
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

/**
 * Reorder mapped roles back to their desired relative hierarchy.
 *
 * Mirrors the sync engine's auto-repair: assign a contiguous band of absolute
 * positions immediately below the bot's highest role, preserving desired
 * relative order. Discord only lets the bot move roles strictly below its own
 * highest role, so a desired role that resolves to a live, non-managed role
 * sitting at/above the bot is a blocker — we surface it for manual attention
 * rather than silently reordering the remainder and claiming success.
 */
async function repairHierarchy(
  guild: Guild,
  supabase: SupabaseClient,
  driftItem: DriftItem,
): Promise<{ success: boolean; error?: string }> {
  const botHighest = guild.members.me?.roles.highest.position;
  if (typeof botHighest !== 'number') {
    return { success: false, error: "Bot's highest role position is unknown" };
  }

  // The representative drift target must itself be below the bot to be movable.
  if (driftItem.entityDiscordId) {
    const targetRole = guild.roles.cache.get(driftItem.entityDiscordId);
    if (targetRole && targetRole.position >= botHighest) {
      return { success: false, error: `Role "${targetRole.name}" is at or above the bot's highest role — the bot cannot move it` };
    }
  }

  const { data: state } = await supabase
    .from('guild_desired_state')
    .select('roles')
    .eq('guild_id', guild.id)
    .maybeSingle();

  const desiredRoles = (state?.roles as Record<string, unknown>[]) ?? [];
  if (desiredRoles.length === 0) {
    return { success: false, error: 'No desired roles configured' };
  }

  // Load role ID mappings so desired keys resolve to live Discord roles.
  const { data: mappings } = await supabase
    .from('discord_id_map')
    .select('template_key, discord_id')
    .eq('guild_id', guild.id)
    .eq('entity_type', 'role')
    .limit(1000);

  const idMap = new Map<string, string>();
  for (const m of (mappings ?? []) as Array<{ template_key: string; discord_id: string }>) {
    idMap.set(m.template_key, m.discord_id);
  }

  const resolveRoleId = (rawKey: string): string | undefined => {
    const bare = unprefixedTemplateKey(rawKey);
    return (
      idMap.get(`role:${bare}`) ??
      idMap.get(bare) ??
      idMap.get(rawKey) ??
      idMap.get(`role:${rawKey}`)
    );
  };

  // Resolve each desired role to a live Discord role, in desired order.
  const sorted = [...desiredRoles].sort(
    (a, b) => ((a.position as number) ?? 0) - ((b.position as number) ?? 0),
  );
  const movable: Array<{ id: string; currentPosition: number }> = [];
  for (const def of sorted) {
    const rawKey = (def.template_key ?? def.templateKey ?? def.key) as string | undefined;
    if (!rawKey) continue;
    const discordId = resolveRoleId(rawKey);
    if (!discordId) continue;
    const role = guild.roles.cache.get(discordId);
    if (!role) continue;
    if (role.managed) continue;
    if (role.position >= botHighest) {
      // Blocker: this desired role cannot be moved, so a correct full reorder is
      // impossible — do not silently exclude it and report a false success.
      return { success: false, error: `Role "${role.name}" is at or above the bot's highest role — the bot cannot reorder the hierarchy while it stays there` };
    }
    movable.push({ id: discordId, currentPosition: role.position });
  }

  if (movable.length === 0) {
    return { success: false, error: 'No movable roles resolved from desired state' };
  }

  const positionUpdates = movable.map((entry, index) => ({
    role: entry.id,
    position: Math.max(1, botHighest - movable.length + index),
  }));

  // Idempotent: equal actual positions count as ordered (Discord positions are
  // not guaranteed unique); only a strict decrease is a genuine inversion.
  const alreadyOrdered = movable.every((entry, index) => {
    if (index === 0) return true;
    return entry.currentPosition >= movable[index - 1].currentPosition;
  });
  if (alreadyOrdered) {
    await removeDriftFromDb(supabase, guild.id, driftItem);
    return { success: true };
  }

  await guild.roles.setPositions(positionUpdates);

  await removeDriftFromDb(supabase, guild.id, driftItem);

  await writeAuditLog(supabase, {
    guildId: guild.id,
    actorType: 'bot',
    actorId: 'sync-engine',
    action: 'drift.repaired',
    targetType: 'role',
    targetId: driftItem.entityDiscordId ?? '',
    details: { type: 'HIERARCHY_DRIFT', reordered: positionUpdates.length },
  });

  return { success: true };
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

    await recordAdminChange(supabase, {
      guildId: guild.id,
      actorId: 'sync-engine',
      action: 'drift_repair.role_recreated',
      targetType: 'role',
      targetId: newRole.id,
      description: `Drift repair recreated the missing role "${newRole.name}".`,
      before: null,
      after: { name: newRole.name, discord_id: newRole.id },
      blastRadius: 'medium',
      // Safe to reverse: the role did not exist a moment ago, so deleting it
      // destroys nothing that was not already gone.
      undo: undoByDeleting('role', newRole.id),
    });

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

    await recordAdminChange(supabase, {
      guildId: guild.id,
      actorId: 'sync-engine',
      action: `drift_repair.${entityType}_recreated`,
      targetType: entityType,
      targetId: newChannel.id,
      description: `Drift repair recreated the missing ${entityType} "${newChannel.name}".`,
      before: null,
      after: { name: newChannel.name, discord_id: newChannel.id },
      blastRadius: 'high',
      undo: undoByDeleting(entityType === 'category' ? 'category' : 'channel', newChannel.id),
    });

    await removeDriftFromDb(supabase, guild.id, driftItem);
    return { success: true };
  }

  return { success: false, error: `Unknown entity type: ${entityType}` };
}
