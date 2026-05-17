/**
 * Bot Role Position Guard
 *
 * Checks and enforces that the bot's role is at position #1 (highest non-owner).
 * All management features are locked when the bot role is not at the top.
 */

import type { Guild } from 'discord.js';

export interface BotPositionStatus {
  isTopPosition: boolean;
  botRolePosition: number;
  totalRoles: number;
  rolesAboveBot: { id: string; name: string; position: number }[];
  canManageAllRoles: boolean;
}

/**
 * Check the bot's role position in the guild hierarchy.
 */
export async function checkBotRolePosition(guild: Guild): Promise<BotPositionStatus> {
  const botMember = guild.members.me;
  if (!botMember) {
    return {
      isTopPosition: false,
      botRolePosition: -1,
      totalRoles: 0,
      rolesAboveBot: [],
      canManageAllRoles: false,
    };
  }

  const botRole = botMember.roles.highest;
  const allRoles = guild.roles.cache.sort((a, b) => b.position - a.position);

  const rolesAboveBot = allRoles.filter(
    (r) => r.position > botRole.position && !r.managed && r.id !== guild.id,
  );

  return {
    isTopPosition: rolesAboveBot.size === 0,
    botRolePosition: botRole.position,
    totalRoles: allRoles.size,
    rolesAboveBot: rolesAboveBot.map((r) => ({
      id: r.id,
      name: r.name,
      position: r.position,
    })),
    canManageAllRoles: rolesAboveBot.size === 0,
  };
}

/**
 * Check if the bot has the required permissions for deployment.
 */
export function checkBotPermissions(guild: Guild): {
  hasRequired: boolean;
  missing: string[];
} {
  const botMember = guild.members.me;
  if (!botMember) {
    return { hasRequired: false, missing: ['BOT_NOT_IN_GUILD'] };
  }

  const required = [
    'ManageRoles',
    'ManageChannels',
    'ManageGuild',
    'ViewAuditLog',
    'KickMembers',
    'BanMembers',
    'ManageWebhooks',
    'SendMessages',
    'EmbedLinks',
    'ManageMessages',
    'ViewChannel',
  ] as const;

  const permissions = botMember.permissions;
  const missing: string[] = [];

  // Administrator bypasses everything
  if (permissions.has('Administrator')) {
    return { hasRequired: true, missing: [] };
  }

  for (const perm of required) {
    if (!permissions.has(perm)) {
      missing.push(perm);
    }
  }

  return {
    hasRequired: missing.length === 0,
    missing,
  };
}
