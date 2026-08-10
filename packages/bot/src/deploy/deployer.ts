/**
 * Server Deployer — Orchestrates full server deployment.
 *
 * Reads desired state from Supabase, computes diff against current Discord state,
 * then creates/updates/deletes roles, channels, categories, and permission overrides.
 *
 * This is the bot's "hands" — the dashboard configures, the deployer executes.
 */

import {
  ChannelType,
  PermissionsBitField,
  type Guild,
  type GuildBasedChannel,
  type GuildChannelEditOptions,
  type OverwriteResolvable,
  type Role,
  type TextChannel,
  type Message,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  DesiredState,
  DesiredRole,
  DesiredChannel,
  DesiredCategory,
} from '@somnibot/shared';
import { checkBotRolePosition, checkBotPermissions } from '../guards/bot-role-guard.js';

// ============================================================
// Types
// ============================================================

export interface DeployResult {
  success: boolean;
  deployId: string;
  duration: number;
  actions: DeployAction[];
  errors: DeployError[];
  idMappings: { entityType: string; key: string; discordId: string }[];
}

export interface DeployAction {
  step: number;
  action: 'create' | 'update' | 'delete' | 'set' | 'reuse' | 'move';
  entityType: 'role' | 'channel' | 'category' | 'override' | 'everyone';
  entityName: string;
  discordId?: string;
  success: boolean;
  error?: string;
}

export interface DeployError {
  step: number;
  entityType: string;
  entityName: string;
  error: string;
}

export interface DeployOptions {
  /** Delete existing roles/channels not in the desired state */
  cleanExisting: boolean;
  /** Only preview — don't actually deploy */
  dryRun: boolean;
  /** Progress callback */
  onProgress?: (step: number, total: number, action: string) => void;
}

type DiscordIdMappingRow = {
  readonly entity_type?: unknown;
  readonly template_key?: unknown;
  readonly discord_id?: unknown;
};

/** Canonical key written by the deploy path. Legacy bare keys are accepted when reading. */
export function canonicalTemplateKey(entityType: string, key: string): string {
  const rawKey = key.trim();
  const prefix = `${entityType}:`;
  const bareKey = rawKey.startsWith(prefix)
    ? rawKey.slice(prefix.length)
    : rawKey.includes(':')
      ? rawKey.slice(rawKey.indexOf(':') + 1)
      : rawKey;
  return `${entityType}:${bareKey}`;
}

async function loadDiscordIdMappings(
  supabase: SupabaseClient,
  guildId: string,
): Promise<DiscordIdMappingRow[]> {
  const { data, error } = await supabase
    .from('discord_id_map')
    .select('entity_type, template_key, discord_id')
    .eq('guild_id', guildId)
    .limit(1000);
  if (error) throw new Error(`Failed to load Discord ID mappings: ${error.message}`);
  return Array.isArray(data) ? data as DiscordIdMappingRow[] : [];
}

function buildMappingIndex(rows: readonly DiscordIdMappingRow[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.entity_type !== 'string'
      || typeof row.template_key !== 'string'
      || typeof row.discord_id !== 'string') continue;
    index.set(canonicalTemplateKey(row.entity_type, row.template_key), row.discord_id);
  }
  return index;
}

// ============================================================
// Deployer
// ============================================================

/**
 * Deploy the desired server state to Discord.
 *
 * Execution order (important for Discord's hierarchy):
 * 1. Set @everyone to zero
 * 2. Delete old channels (if cleanExisting)
 * 3. Delete old roles (if cleanExisting)
 * 4. Create roles (bottom-up for hierarchy)
 * 5. Create categories
 * 6. Create channels with permission overrides
 * 7. Reorder roles (set hierarchy positions)
 * 8. Store ID mappings
 */
export async function deployServerState(
  guild: Guild,
  supabase: SupabaseClient,
  desiredState: DesiredState,
  options: DeployOptions,
): Promise<DeployResult> {
  const start = Date.now();
  const deployId = `deploy_${Date.now()}`;
  const actions: DeployAction[] = [];
  const errors: DeployError[] = [];
  const idMappings: { entityType: string; key: string; discordId: string }[] = [];
  let persistedMappings: DiscordIdMappingRow[] = [];
  let step = 0;

  const totalSteps = estimateTotalSteps(desiredState, options);
  const report = (action: string) => {
    options.onProgress?.(step, totalSteps, action);
  };

  try {
    // === Pre-flight checks ===
    const positionCheck = await checkBotRolePosition(guild);
    if (!positionCheck.isTopPosition) {
      return {
        success: false,
        deployId,
        duration: Date.now() - start,
        actions: [],
        errors: [{
          step: 0,
          entityType: 'bot',
          entityName: 'Bot Role Position',
          error: `Bot role is not at position #1. ${positionCheck.rolesAboveBot.length} role(s) above: ${positionCheck.rolesAboveBot.map(r => r.name).join(', ')}`,
        }],
        idMappings: [],
      };
    }

    const permCheck = checkBotPermissions(guild);
    if (!permCheck.hasRequired) {
      return {
        success: false,
        deployId,
        duration: Date.now() - start,
        actions: [],
        errors: [{
          step: 0,
          entityType: 'bot',
          entityName: 'Bot Permissions',
          error: `Missing permissions: ${permCheck.missing.join(', ')}`,
        }],
        idMappings: [],
      };
    }

    if (desiredState.roles.length > 0) {
      // Managed integration roles are NOT positional barriers: they cannot
      // be edited directly, but raising an editable role displaces them
      // implicitly, so the placement step can always slot the desired
      // hierarchy directly beneath the bot — and it verifies that OUTCOME
      // after moving. Rejecting up front on the mere presence of another
      // bot's role (a common guild shape) aborted deployments that would
      // have succeeded. The preflight only confirms the bot member itself is
      // resolvable before any destructive step.
      await guild.roles.fetch();
      const botHighest = guild.members.me?.roles.highest.position;
      if (botHighest === undefined) {
        const error = 'Bot member is unavailable while validating the role hierarchy';
        return {
          success: false,
          deployId,
          duration: Date.now() - start,
          actions: [],
          errors: [{
            step: 0,
            entityType: 'bot',
            entityName: 'Role Hierarchy Preflight',
            error,
          }],
          idMappings: [],
        };
      }
    }

    if (options.dryRun) {
      return {
        success: true,
        deployId,
        duration: Date.now() - start,
        actions: [],
        errors: [],
        idMappings: [],
      };
    }

    persistedMappings = await loadDiscordIdMappings(supabase, guild.id);
    const persistedMappingIndex = buildMappingIndex(persistedMappings);
    const mappingIndex = options.cleanExisting ? new Map<string, string>() : persistedMappingIndex;
    const communityChannelIds = communityChannelIdsForGuild(guild);
    const moderatorOnlyChannelId = persistedMappingIndex.get(
      canonicalTemplateKey('channel', 'moderator-only'),
    ) ?? guild.safetyAlertsChannelId;
    if (moderatorOnlyChannelId) communityChannelIds.add(moderatorOnlyChannelId);

    // === Step 1: Zero @everyone ===
    step++;
    report('Setting @everyone to zero permissions');
    try {
      const everyoneRole = guild.roles.everyone;
      await everyoneRole.setPermissions(0n, 'SomniBot deployment — @everyone = 0');
      actions.push({
        step, action: 'set', entityType: 'everyone',
        entityName: '@everyone', discordId: everyoneRole.id, success: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ step, entityType: 'everyone', entityName: '@everyone', error: msg });
      actions.push({
        step, action: 'set', entityType: 'everyone',
        entityName: '@everyone', success: false, error: msg,
      });
    }

    // === Step 2: Purge bot messages + delete old channels/roles (if cleanExisting) ===
    if (options.cleanExisting) {
      // First, purge all bot messages from every text channel
      step++;
      report('Purging bot messages from all channels');
      try {
        const botId = guild.client.user?.id;
        const textChannels = guild.channels.cache.filter(
          (c) => c.type === ChannelType.GuildText,
        );
        let purgedCount = 0;
        for (const [, channel] of textChannels) {
          try {
            const messages = await (channel as TextChannel).messages.fetch({ limit: 100 });
            const botMessages = messages.filter((m: Message) => m.author.id === botId);
            for (const [, msg] of botMessages) {
              try {
                await msg.delete();
                purgedCount++;
                await sleep(300);
              } catch { /* skip undeletable messages */ }
            }
          } catch { /* skip channels we can't read */ }
        }
        actions.push({
          step, action: 'delete', entityType: 'channel',
          entityName: `Bot messages purged (${purgedCount})`, success: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ step, entityType: 'channel', entityName: 'Bot message purge', error: msg });
      }

      // Then delete channels (skip Discord-required channels)
      const existingChannels = guild.channels.cache.filter(
        (c) => !communityChannelIds.has(c.id),
      );

      for (const [, channel] of existingChannels) {
        step++;
        report(`Deleting channel: ${channel.name}`);
        try {
          await channel.delete('SomniBot deployment — cleaning old channels');
          actions.push({
            step, action: 'delete', entityType: 'channel',
            entityName: channel.name, discordId: channel.id, success: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ step, entityType: 'channel', entityName: channel.name, error: msg });
          actions.push({
            step, action: 'delete', entityType: 'channel',
            entityName: channel.name, discordId: channel.id, success: false, error: msg,
          });
        }
        await sleep(250); // Rate limit respect
      }

      // Delete old roles (skip @everyone, managed roles, and bot's own role)
      const existingRoles = guild.roles.cache.filter(
        (r) => !r.managed && r.id !== guild.id && r.position < (guild.members.me?.roles.highest.position ?? 0),
      );

      for (const [, role] of existingRoles) {
        step++;
        report(`Deleting role: ${role.name}`);
        try {
          await role.delete('SomniBot deployment — cleaning old roles');
          actions.push({
            step, action: 'delete', entityType: 'role',
            entityName: role.name, discordId: role.id, success: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ step, entityType: 'role', entityName: role.name, error: msg });
          actions.push({
            step, action: 'delete', entityType: 'role',
            entityName: role.name, discordId: role.id, success: false, error: msg,
          });
        }
        await sleep(250);
      }
    }

    // === Step 3: Create roles (lowest position first for proper hierarchy) ===
    const sortedRoles = [...desiredState.roles].sort((a, b) => a.position - b.position);
    const roleKeyToDiscordId = new Map<string, string>();

    for (const desired of sortedRoles) {
      step++;
      const mappedId = mappingIndex.get(canonicalTemplateKey('role', desired.key));
      const existingRole = mappedId ? guild.roles.cache.get(mappedId) : undefined;
      report(`${existingRole ? 'Updating' : 'Creating'} role: ${desired.name}`);
      try {
        if (existingRole?.managed || existingRole?.editable === false) {
          throw new Error(`Mapped role cannot be edited by the bot: ${existingRole.name}`);
        }
        const role = existingRole
          ? await updateRole(existingRole, desired)
          : await createRole(guild, desired);
        roleKeyToDiscordId.set(desired.key, role.id);
        idMappings.push({ entityType: 'role', key: desired.key, discordId: role.id });
        actions.push({
          step, action: existingRole ? 'update' : 'create', entityType: 'role',
          entityName: desired.name, discordId: role.id, success: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ step, entityType: 'role', entityName: desired.name, error: msg });
        actions.push({
          step, action: existingRole ? 'update' : 'create', entityType: 'role',
          entityName: desired.name, success: false, error: msg,
        });
      }
      await sleep(300);
    }

    // === Step 4: Set role positions (hierarchy) ===
    step++;
    report('Setting role hierarchy positions');
    let hierarchyContext = 'hierarchy context unavailable';
    try {
      const targetRoles = sortedRoles
        .map((desired) => {
          const discordId = roleKeyToDiscordId.get(desired.key);
          return discordId ? { desired, discordId } : null;
        })
        .filter((role): role is NonNullable<typeof role> => role !== null);

      if (targetRoles.length > 0) {
        // Role creation changes every role above the insertion point. Fetch the
        // authoritative hierarchy before calculating positions; using the
        // pre-create cache can target the bot's own position and Discord rejects
        // that batch with Missing Permissions.
        await guild.roles.fetch();

        const botHighest = guild.members.me?.roles.highest.position;
        if (botHighest === undefined) {
          throw new Error('Bot member is unavailable after refreshing the role hierarchy');
        }

        const targetRoleObjects = targetRoles.map(({ discordId }) => {
          const role = guild.roles.cache.get(discordId);
          if (!role) {
            throw new Error(`Created role is missing after refreshing the hierarchy`);
          }
          return role;
        });
        // The desired list is ordered low-to-high. Put it directly beneath the
        // bot so newly deployed moderators remain above surviving member
        // roles. Managed integration roles are not treated as barriers here:
        // raising the created (editable) roles displaces them downward
        // implicitly, so the batch below lands even in guilds full of other
        // bots' roles. Whether it actually landed is verified AFTER the move.
        const lowestTargetPosition = botHighest - targetRoles.length;
        const availablePositions = targetRoles.map(
          (_, index) => lowestTargetPosition + index,
        );
        const positionUpdates = targetRoles.map(({ discordId }, index) => ({
          role: discordId,
          position: availablePositions[index],
        }));
        const targetRoleStates = targetRoleObjects.map((role) => {
          return `${role?.position ?? 'missing'}:${role?.editable ?? 'unknown'}:${role?.managed ?? 'unknown'}`;
        });
        hierarchyContext = [
          `botPosition=${botHighest}`,
          `botManageRoles=${guild.members.me?.permissions.has('ManageRoles') ?? false}`,
          `botAdministrator=${guild.members.me?.permissions.has('Administrator') ?? false}`,
          `targetPositions=${positionUpdates.map(({ position }) => position).join(',')}`,
          `targetStates=${targetRoleStates.join(',')}`,
        ].join('; ');

        if (positionUpdates.some(({ position }) => position < 1 || position >= botHighest)) {
          throw new Error(
            `Cannot place ${positionUpdates.length} created roles below bot role position ${botHighest}`,
          );
        }

        const uneditableRole = targetRoleObjects.find((role) => role.editable === false);
        if (uneditableRole) {
          throw new Error(`Created role is not editable by the bot: ${uneditableRole.name}`);
        }

        await guild.roles.setPositions(positionUpdates);

        // Outcome verification: the created roles must now be the top block
        // directly beneath the bot. A role Discord did NOT displace is
        // reported honestly instead of claiming success with an ineffective
        // hierarchy.
        await guild.roles.fetch();
        const verifiedBotHighest = guild.members.me?.roles.highest.position;
        if (verifiedBotHighest === undefined) {
          throw new Error('Bot member is unavailable after setting the role hierarchy');
        }
        const targetIds = new Set(targetRoles.map(({ discordId }) => discordId));
        const meRoleCache = guild.members.me?.roles.cache;
        const botOwnRoleIds = new Set<string>(meRoleCache ? [...meRoleCache.keys()] : []);
        const interloper = [...guild.roles.cache.values()]
          .filter((role) =>
            role.id !== guild.id
            && !botOwnRoleIds.has(role.id)
            && role.position < verifiedBotHighest)
          .sort((a, b) => b.position - a.position)
          .slice(0, targetRoles.length)
          .find((role) => !targetIds.has(role.id));
        if (interloper) {
          throw new Error(
            `Cannot preserve the requested hierarchy because role ${interloper.name} `
            + `at position ${interloper.position} remains between the bot and the deployed roles`,
          );
        }
      }
      actions.push({
        step, action: 'set', entityType: 'role',
        entityName: 'Role hierarchy', success: true,
      });
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const msg = `${rawMessage} (${hierarchyContext})`;
      errors.push({ step, entityType: 'role', entityName: 'Role hierarchy', error: msg });
      actions.push({
        step, action: 'set', entityType: 'role',
        entityName: 'Role hierarchy', success: false, error: msg,
      });
    }

    // === Step 5: Create categories ===
    const categoryKeyToDiscordId = new Map<string, string>();
    const sortedCategories = [...desiredState.categories].sort((a, b) => a.position - b.position);

    for (const desired of sortedCategories) {
      step++;
      const mappedId = mappingIndex.get(canonicalTemplateKey('category', desired.key));
      const mappedCategory = mappedId
        ? guild.channels.cache.get(mappedId)
        : undefined;
      const existingCategory = mappedCategory?.type === ChannelType.GuildCategory
        ? mappedCategory
        : undefined;
      report(`${existingCategory ? 'Updating' : 'Creating'} category: ${desired.name}`);
      try {
        if (mappedCategory && !existingCategory) {
          if (communityChannelIdsForGuild(guild).has(mappedCategory.id)) {
            throw new Error(`Mapped category points to a protected Discord channel: ${mappedCategory.name}`);
          }
          await mappedCategory.delete('SomniBot deployment — replace changed category type');
          actions.push({
            step, action: 'delete', entityType: 'channel',
            entityName: mappedCategory.name, discordId: mappedCategory.id, success: true,
          });
        }
        const channel = existingCategory && existingCategory.type === ChannelType.GuildCategory
          ? await existingCategory.edit({
            name: desired.name,
            position: desired.position,
            reason: 'SomniBot deployment — update category',
          })
          : await guild.channels.create({
            name: desired.name,
            type: ChannelType.GuildCategory,
            position: desired.position,
            reason: 'SomniBot deployment',
          });
        categoryKeyToDiscordId.set(desired.key, channel.id);
        idMappings.push({ entityType: 'category', key: desired.key, discordId: channel.id });
        actions.push({
          step, action: existingCategory ? 'update' : 'create', entityType: 'category',
          entityName: desired.name, discordId: channel.id, success: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ step, entityType: 'category', entityName: desired.name, error: msg });
        actions.push({
          step, action: existingCategory ? 'update' : 'create', entityType: 'category',
          entityName: desired.name, success: false, error: msg,
        });
      }
      await sleep(300);
    }

    // === Step 6: Create channels with permission overrides ===
    // Handle Discord Community-required channels (rules, moderator-only).
    // These can't be deleted, so we reuse them instead of creating duplicates.
    const modOnlyChannel = moderatorOnlyChannelId
      ? guild.channels.cache.get(moderatorOnlyChannelId)
      : null;

    const sortedChannels = [...desiredState.channels].sort((a, b) => a.position - b.position);

    for (const desired of sortedChannels) {
      step++;

      // Check if this desired channel matches a community-required channel
      const existingCommunity =
        desired.key === 'rules' && guild.rulesChannelId
          ? guild.channels.cache.get(guild.rulesChannelId)
          : null;

      if (existingCommunity) {
        report(`Reusing community channel: ${desired.name}`);
        try {
          // Move into correct category and set properties
          const parentId = desired.categoryKey
            ? categoryKeyToDiscordId.get(desired.categoryKey)
            : undefined;
          await existingCommunity.edit({
            topic: desired.topic ?? undefined,
            rateLimitPerUser: desired.slowmode,
            nsfw: desired.nsfw,
            parent: parentId ?? null,
            position: desired.position,
            reason: 'SomniBot deployment — reusing community channel',
          });
          idMappings.push({ entityType: 'channel', key: desired.key, discordId: existingCommunity.id });
          actions.push({
            step, action: 'reuse', entityType: 'channel',
            entityName: desired.name, discordId: existingCommunity.id, success: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ step, entityType: 'channel', entityName: desired.name, error: msg });
          actions.push({
            step, action: 'reuse', entityType: 'channel',
            entityName: desired.name, success: false, error: msg,
          });
        }
      } else {
        const mappedId = mappingIndex.get(canonicalTemplateKey('channel', desired.key));
        const mappedChannel = mappedId ? guild.channels.cache.get(mappedId) : undefined;
        const existingChannel = mappedChannel?.type === desired.type
          ? mappedChannel
          : undefined;
        report(`${existingChannel ? 'Updating' : 'Creating'} channel: ${desired.name}`);
        try {
          if (mappedChannel && !existingChannel) {
            if (communityChannelIds.has(mappedChannel.id)) {
              throw new Error(`Mapped channel is protected by Discord: ${mappedChannel.name}`);
            }
            await mappedChannel.delete('SomniBot deployment — replace changed channel type');
            actions.push({
              step, action: 'delete', entityType: 'channel',
              entityName: mappedChannel.name, discordId: mappedChannel.id, success: true,
            });
          }
          const channelId = existingChannel
            ? await updateChannel(
              guild, existingChannel, desired, roleKeyToDiscordId, categoryKeyToDiscordId,
            )
            : await createChannel(
              guild, desired, roleKeyToDiscordId, categoryKeyToDiscordId,
            );
          idMappings.push({ entityType: 'channel', key: desired.key, discordId: channelId });
          actions.push({
            step, action: existingChannel ? 'update' : 'create', entityType: 'channel',
            entityName: desired.name, discordId: channelId, success: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ step, entityType: 'channel', entityName: desired.name, error: msg });
          actions.push({
            step, action: existingChannel ? 'update' : 'create', entityType: 'channel',
            entityName: desired.name, success: false, error: msg,
          });
        }
      }
      await sleep(300);
    }

    if (modOnlyChannel) {
      step++;
      report('Organizing community moderator-only channel');
      try {
        const staffCatId = categoryKeyToDiscordId.get('cat-staff');
        const staffChannel = desiredState.channels.find(
          (channel) => channel.categoryKey === 'cat-staff' && channel.templateId === 'staff',
        );
        if (staffCatId && staffChannel) {
          await guild.channels.edit(modOnlyChannel.id, {
            parent: staffCatId,
            permissionOverwrites: buildPermissionOverwrites(guild, staffChannel, roleKeyToDiscordId),
            reason: 'SomniBot deployment — organize community channel',
          });
          actions.push({
            step, action: 'move', entityType: 'channel',
            entityName: 'moderator-only', discordId: modOnlyChannel.id, success: true,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ step, entityType: 'channel', entityName: 'moderator-only', error: msg });
      }
    }

    if (!options.cleanExisting && persistedMappings.length > 0) {
      const desiredMappingKeys = new Set<string>([
        ...desiredState.roles.map((role) => canonicalTemplateKey('role', role.key)),
        ...desiredState.categories.map((category) => canonicalTemplateKey('category', category.key)),
        ...desiredState.channels.map((channel) => canonicalTemplateKey('channel', channel.key)),
      ]);
      const deletedDiscordIds = new Set<string>();
      const entityOrder = ['channel', 'category', 'role'] as const;

      for (const entityType of entityOrder) {
        for (const row of persistedMappings) {
          if (row.entity_type !== entityType
            || typeof row.template_key !== 'string'
            || typeof row.discord_id !== 'string') continue;
          if (desiredMappingKeys.has(canonicalTemplateKey(entityType, row.template_key))) continue;
          if (deletedDiscordIds.has(row.discord_id)) continue;

          const entity = entityType === 'role'
            ? guild.roles.cache.get(row.discord_id)
            : guild.channels.cache.get(row.discord_id);
          if (!entity) continue;
          if (entityType !== 'role' && communityChannelIds.has(entity.id)) continue;

          step++;
          report(`Deleting removed ${entityType}: ${entity.name}`);
          try {
            if (entityType === 'role') {
              const role = entity as Role;
              if (role.managed || role.editable === false) {
                throw new Error(`Mapped role cannot be deleted by the bot: ${role.name}`);
              }
              await role.delete('SomniBot deployment — removed from reviewed plan');
            } else {
              await (entity as GuildBasedChannel).delete(
                'SomniBot deployment — removed from reviewed plan',
              );
            }
            deletedDiscordIds.add(entity.id);
            actions.push({
              step, action: 'delete', entityType,
              entityName: entity.name, discordId: entity.id, success: true,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push({ step, entityType, entityName: entity.name, error: msg });
            actions.push({
              step, action: 'delete', entityType,
              entityName: entity.name, discordId: entity.id, success: false, error: msg,
            });
          }
        }
      }
    }

    // === Step 7: Store ID mappings in Supabase ===
    step++;
    report('Storing ID mappings');
    try {
      const canReplaceMappingSet = errors.length === 0 || options.cleanExisting;
      if (canReplaceMappingSet) {
        const { error: deleteMappingsError } = await supabase
          .from('discord_id_map')
          .delete()
          .eq('guild_id', guild.id);
        if (deleteMappingsError) {
          throw new Error(`Failed to clear Discord ID mappings: ${deleteMappingsError.message}`);
        }
      }

      // Insert new mappings
      if (idMappings.length > 0) {
        const rows = idMappings.map((m) => ({
          guild_id: guild.id,
          entity_type: m.entityType,
          template_key: canonicalTemplateKey(m.entityType, m.key),
          discord_id: m.discordId,
        }));

        const { error: insertMappingsError } = await supabase
          .from('discord_id_map')
          .upsert(rows, { onConflict: 'guild_id,entity_type,template_key' });
        if (insertMappingsError) {
          throw new Error(`Failed to store Discord ID mappings: ${insertMappingsError.message}`);
        }
      }

      // Update desired state
      const { error: desiredStateError } = await supabase
        .from('guild_desired_state')
        .upsert({
          guild_id: guild.id,
          roles: JSON.parse(JSON.stringify(desiredState.roles)),
          channels: JSON.parse(JSON.stringify(desiredState.channels)),
          categories: JSON.parse(JSON.stringify(desiredState.categories)),
          permission_map: {},
          deploy_mode: options.cleanExisting ? 'destructive' : 'safe',
          last_sync_at: new Date().toISOString(),
          drift_detected: false,
          drift_details: null,
        });
      if (desiredStateError) {
        throw new Error(`Failed to store desired state: ${desiredStateError.message}`);
      }

      // Update guild record — setup_completed stays false until owner confirms (Step 7 of wizard)
      const { error: guildUpdateError } = await supabase
        .from('guild')
        .update({
          setup_completed: false,
          bot_role_id: guild.members.me?.roles.highest.id ?? null,
          bot_role_position: guild.members.me?.roles.highest.position ?? null,
          total_roles: guild.roles.cache.size,
        })
        .eq('id', guild.id);
      if (guildUpdateError) {
        throw new Error(`Failed to update guild deployment state: ${guildUpdateError.message}`);
      }

      actions.push({
        step, action: 'set', entityType: 'role',
        entityName: 'ID mappings stored', success: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ step, entityType: 'system', entityName: 'ID mappings', error: msg });
    }

    // === Step 8: Write audit log ===
    try {
      await supabase.from('audit_logs').insert({
        guild_id: guild.id,
        actor_type: 'bot',
        actor_id: 'deployer',
        action: 'server.deployed',
        target_type: 'guild',
        target_id: guild.id,
        details: {
          deployId,
          rolesCreated: actions.filter(a => a.entityType === 'role' && a.action === 'create' && a.success).length,
          channelsCreated: actions.filter(a => a.entityType === 'channel' && a.action === 'create' && a.success).length,
          categoriesCreated: actions.filter(a => a.entityType === 'category' && a.action === 'create' && a.success).length,
          errors: errors.length,
          duration: Date.now() - start,
        },
      });
    } catch {
      // Non-critical — don't fail deployment for audit log
    }

    return {
      success: errors.length === 0,
      deployId,
      duration: Date.now() - start,
      actions,
      errors,
      idMappings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      deployId,
      duration: Date.now() - start,
      actions,
      errors: [...errors, { step, entityType: 'system', entityName: 'Deployment', error: msg }],
      idMappings,
    };
  }
}

// ============================================================
// Helpers
// ============================================================

async function createRole(guild: Guild, desired: DesiredRole): Promise<Role> {
  return guild.roles.create({
    name: desired.name,
    permissions: new PermissionsBitField(BigInt(desired.permissions)),
    colors: { primaryColor: desired.color },
    hoist: desired.hoist,
    mentionable: desired.mentionable,
    reason: `SomniBot deployment — ${desired.tier} tier role`,
  });
}

async function updateRole(role: Role, desired: DesiredRole): Promise<Role> {
  return role.edit({
    name: desired.name,
    color: desired.color,
    permissions: new PermissionsBitField(BigInt(desired.permissions)),
    hoist: desired.hoist,
    mentionable: desired.mentionable,
    reason: `SomniBot deployment — ${desired.tier} tier role`,
  });
}

function communityChannelIdsForGuild(guild: Guild): Set<string> {
  return new Set(
    [guild.rulesChannelId, guild.publicUpdatesChannelId, guild.safetyAlertsChannelId]
      .filter(Boolean) as string[],
  );
}

function buildPermissionOverwrites(
  guild: Guild,
  desired: DesiredChannel,
  roleKeyToDiscordId: Map<string, string>,
): OverwriteResolvable[] {
  const permissionOverwrites: OverwriteResolvable[] = [];

  for (const override of desired.overrides) {
    const targetId = override.roleKey === 'everyone'
      ? guild.id
      : roleKeyToDiscordId.get(override.roleKey);
    if (!targetId) continue;

    permissionOverwrites.push({
      id: targetId,
      type: 0,
      allow: new PermissionsBitField(BigInt(override.allow)),
      deny: new PermissionsBitField(BigInt(override.deny)),
    });
  }

  return permissionOverwrites;
}

async function updateChannel(
  guild: Guild,
  channel: GuildBasedChannel,
  desired: DesiredChannel,
  roleKeyToDiscordId: Map<string, string>,
  categoryKeyToDiscordId: Map<string, string>,
): Promise<string> {
  const parentId = desired.categoryKey
    ? categoryKeyToDiscordId.get(desired.categoryKey) ?? null
    : null;
  const options: GuildChannelEditOptions = {
    name: desired.name,
    parent: parentId,
    position: desired.position,
    permissionOverwrites: buildPermissionOverwrites(guild, desired, roleKeyToDiscordId),
    reason: 'SomniBot deployment — update channel',
  };

  if (channel.isTextBased() && !channel.isThread()) {
    options.topic = desired.topic;
    options.rateLimitPerUser = desired.slowmode;
    options.nsfw = desired.nsfw;
  }

  const updated = await guild.channels.edit(channel.id, options);
  return updated.id;
}

async function createChannel(
  guild: Guild,
  desired: DesiredChannel,
  roleKeyToDiscordId: Map<string, string>,
  categoryKeyToDiscordId: Map<string, string>,
): Promise<string> {
  const permissionOverwrites = buildPermissionOverwrites(guild, desired, roleKeyToDiscordId);

  const channelType = desired.type as Exclude<ChannelType, ChannelType.DM | ChannelType.GroupDM | ChannelType.GuildDirectory | ChannelType.PublicThread | ChannelType.PrivateThread | ChannelType.AnnouncementThread>;
  const parentId = desired.categoryKey
    ? categoryKeyToDiscordId.get(desired.categoryKey) ?? undefined
    : undefined;

  const channel = await guild.channels.create({
    name: desired.name,
    type: channelType,
    parent: parentId,
    position: desired.position,
    topic: desired.topic ?? undefined,
    rateLimitPerUser: desired.slowmode,
    nsfw: desired.nsfw,
    permissionOverwrites,
    reason: 'SomniBot deployment',
  });

  return channel.id;
}

function estimateTotalSteps(state: DesiredState, options: DeployOptions): number {
  let steps = 1; // @everyone
  steps += state.roles.length; // Create roles
  steps += 1; // Set positions
  steps += state.categories.length; // Create categories
  steps += state.channels.length; // Create channels
  steps += 1; // Store mappings
  if (options.cleanExisting) {
    steps += 20; // Rough estimate for deletion
  }
  return steps;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
