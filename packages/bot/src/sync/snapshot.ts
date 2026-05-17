/**
 * Server State Snapshot
 *
 * Reads the current Discord server state via the API.
 * Used by the sync engine to compare against desired state.
 */

import { ChannelType, type Guild } from 'discord.js';
import type { ActualState, ActualRole, ActualChannel, ActualChannelOverride } from '@somnibot/shared';

/**
 * Take a complete snapshot of the guild's current state.
 */
export async function takeSnapshot(guild: Guild): Promise<ActualState> {
  // Ensure cache is fresh
  await guild.roles.fetch();
  await guild.channels.fetch();

  // Roles
  const roles: ActualRole[] = guild.roles.cache.map((role) => ({
    id: role.id,
    name: role.id === guild.id ? '@everyone' : role.name,
    permissions: role.permissions.bitfield.toString(),
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    position: role.position,
    managed: role.managed,
  }));

  // Channels (including categories)
  const channels: ActualChannel[] = [];

  for (const [, channel] of guild.channels.cache) {
    // Skip DM channels and threads
    if (!('permissionOverwrites' in channel)) continue;

    const overwrites: ActualChannelOverride[] = [];

    if ('permissionOverwrites' in channel && channel.permissionOverwrites) {
      for (const [, overwrite] of channel.permissionOverwrites.cache) {
        overwrites.push({
          id: overwrite.id,
          type: overwrite.type === 0 ? 'role' : 'member',
          allow: overwrite.allow.bitfield.toString(),
          deny: overwrite.deny.bitfield.toString(),
        });
      }
    }

    channels.push({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: 'parentId' in channel ? (channel.parentId ?? null) : null,
      position: 'position' in channel ? channel.position : 0,
      topic: 'topic' in channel ? ((channel.topic as string | null) ?? null) : null,
      rateLimitPerUser: 'rateLimitPerUser' in channel ? (channel.rateLimitPerUser as number) : 0,
      nsfw: 'nsfw' in channel ? (channel.nsfw as boolean) : false,
      overwrites,
    });
  }

  // @everyone permissions
  const everyoneRole = guild.roles.everyone;

  return {
    everyonePermissions: everyoneRole.permissions.bitfield.toString(),
    roles,
    channels,
  };
}
