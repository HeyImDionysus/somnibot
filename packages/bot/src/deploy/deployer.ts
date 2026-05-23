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
  type OverwriteResolvable,
  type Role,
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
            const messages = await (channel as DbRow).messages.fetch({ limit: 100 });
            const botMessages = messages.filter((m: DbRow) => m.author.id === botId);
            for (const [, msg] of botMessages) {
              try {
                await (msg as DbRow).delete();
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
        (c) => c.id !== guild.rulesChannelId && c.id !== guild.publicUpdatesChannelId,
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
      report(`Creating role: ${desired.name}`);
      try {
        const newRole = await createRole(guild, desired);
        roleKeyToDiscordId.set(desired.key, newRole.id);
        idMappings.push({ entityType: 'role', key: desired.key, discordId: newRole.id });
        actions.push({
          step, action: 'create', entityType: 'role',
          entityName: desired.name, discordId: newRole.id, success: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ step, entityType: 'role', entityName: desired.name, error: msg });
        actions.push({
          step, action: 'create', entityType: 'role',
          entityName: desired.name, success: false, error: msg,
        });
      }
      await sleep(300);
    }

    // === Step 4: Set role positions (hierarchy) ===
    step++;
    report('Setting role hierarchy positions');
    try {
      const botHighest = guild.members.me?.roles.highest.position ?? 1;
      // Roles positioned below the bot's role
      // Highest desired position = botHighest - 1
      const positionUpdates = sortedRoles
        .map((desired, index) => {
          const discordId = roleKeyToDiscordId.get(desired.key);
          if (!discordId) return null;
          return {
            role: discordId,
            position: Math.max(1, botHighest - sortedRoles.length + index),
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      if (positionUpdates.length > 0) {
        await guild.roles.setPositions(positionUpdates);
      }
      actions.push({
        step, action: 'set', entityType: 'role',
        entityName: 'Role hierarchy', success: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
      report(`Creating category: ${desired.name}`);
      try {
        const channel = await guild.channels.create({
          name: desired.name,
          type: ChannelType.GuildCategory,
          position: desired.position,
          reason: 'SomniBot deployment',
        });
        categoryKeyToDiscordId.set(desired.key, channel.id);
        idMappings.push({ entityType: 'category', key: desired.key, discordId: channel.id });
        actions.push({
          step, action: 'create', entityType: 'category',
          entityName: desired.name, discordId: channel.id, success: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ step, entityType: 'category', entityName: desired.name, error: msg });
        actions.push({
          step, action: 'create', entityType: 'category',
          entityName: desired.name, success: false, error: msg,
        });
      }
      await sleep(300);
    }

    // === Step 6: Create channels with permission overrides ===
    // Handle Discord Community-required channels (rules, moderator-only).
    // These can't be deleted, so we reuse them instead of creating duplicates.
    const communityChannelIds = new Set<string>(
      [guild.rulesChannelId, guild.publicUpdatesChannelId].filter(Boolean) as string[],
    );
    // Also detect the moderator-only channel Discord creates for Community servers
    const modOnlyChannel = guild.channels.cache.find(
      (c) => c.name === 'moderator-only' && !c.parentId,
    );

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
        report(`Creating channel: ${desired.name}`);
        try {
          const channelId = await createChannel(
            guild, desired, roleKeyToDiscordId, categoryKeyToDiscordId,
          );
          idMappings.push({ entityType: 'channel', key: desired.key, discordId: channelId });
          actions.push({
            step, action: 'create', entityType: 'channel',
            entityName: desired.name, discordId: channelId, success: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ step, entityType: 'channel', entityName: desired.name, error: msg });
          actions.push({
            step, action: 'create', entityType: 'channel',
            entityName: desired.name, success: false, error: msg,
          });
        }
      }
      await sleep(300);
    }

    // Move moderator-only channel to Staff category if it exists
    if (modOnlyChannel && 'setParent' in modOnlyChannel) {
      step++;
      report('Organizing community moderator-only channel');
      try {
        const staffCatId = categoryKeyToDiscordId.get('cat-staff');
        if (staffCatId) {
          await (modOnlyChannel as DbRow).setParent(staffCatId, {
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

    // === Step 7: Store ID mappings in Supabase ===
    step++;
    report('Storing ID mappings');
    try {
      // Clear existing mappings
      await supabase
        .from('discord_id_map')
        .delete()
        .eq('guild_id', guild.id);

      // Insert new mappings
      if (idMappings.length > 0) {
        const rows = idMappings.map((m) => ({
          guild_id: guild.id,
          entity_type: m.entityType,
          template_key: `${m.entityType}:${m.key}`,
          discord_id: m.discordId,
        }));

        await supabase.from('discord_id_map').insert(rows);
      }

      // Update desired state
      await supabase
        .from('guild_desired_state')
        .upsert({
          guild_id: guild.id,
          roles: JSON.parse(JSON.stringify(desiredState.roles)),
          channels: JSON.parse(JSON.stringify(desiredState.channels)),
          permission_map: {},
          applied_at: new Date().toISOString(),
          last_sync_at: new Date().toISOString(),
          drift_detected: false,
          drift_details: null,
        });

      // Update guild record — setup_completed stays false until owner confirms (Step 7 of wizard)
      await supabase
        .from('guild')
        .update({
          setup_completed: false,
          bot_role_id: guild.members.me?.roles.highest.id ?? null,
          bot_role_position: guild.members.me?.roles.highest.position ?? null,
          total_roles: guild.roles.cache.size,
        })
        .eq('id', guild.id);

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
    // discord.js v14.24 deprecated 'color' in favor of 'colors', but the
    // type signature still accepts 'color'. Use 'color' until v15 migration.
    color: desired.color,
    hoist: desired.hoist,
    mentionable: desired.mentionable,
    reason: `SomniBot deployment — ${desired.tier} tier role`,
  });
}

async function createChannel(
  guild: Guild,
  desired: DesiredChannel,
  roleKeyToDiscordId: Map<string, string>,
  categoryKeyToDiscordId: Map<string, string>,
): Promise<string> {
  // Build permission overwrites
  const permissionOverwrites: OverwriteResolvable[] = [];

  for (const override of desired.overrides) {
    let targetId: string | undefined;

    if (override.roleKey === 'everyone') {
      targetId = guild.id; // @everyone role ID = guild ID
    } else {
      targetId = roleKeyToDiscordId.get(override.roleKey);
    }

    if (targetId) {
      permissionOverwrites.push({
        id: targetId,
        type: 0, // Role
        allow: new PermissionsBitField(BigInt(override.allow)),
        deny: new PermissionsBitField(BigInt(override.deny)),
      });
    }
  }

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
