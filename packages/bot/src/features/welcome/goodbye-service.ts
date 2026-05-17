/**
 * Goodbye Service — Posts goodbye messages when members leave.
 *
 * Triggered by guildMemberRemove. The member's roles and data
 * are preserved in the members table by member-service.ts (not deleted),
 * so returning member detection works.
 */

import type { GuildMember, PartialGuildMember, TextChannel } from 'discord.js';
import type { DbGuildConfig } from '@somnibot/shared';
import {
  buildWelcomeVariables,
  formatDuration,
  interpolateMessage,
} from './welcome-variables.js';

const DEFAULT_GOODBYE_MESSAGE =
  '{user.name} left. They were with us for {duration}. 👋';

/**
 * Execute the goodbye flow for a departing member.
 */
export async function executeGoodbyeFlow(
  member: GuildMember | PartialGuildMember,
  config: DbGuildConfig,
): Promise<void> {
  if (!config.goodbye_enabled || !config.goodbye_channel_id) return;

  try {
    const channel = member.guild.channels.cache.get(config.goodbye_channel_id) as TextChannel | undefined;
    if (!channel?.isTextBased()) {
      console.warn('[Goodbye] Goodbye channel not found or not text-based:', config.goodbye_channel_id);
      return;
    }

    // Build variables (use partial data — member may not be fully cached)
    const variables = buildWelcomeVariables(
      member as GuildMember,
      member.guild,
      0, // member number not relevant for goodbye
    );

    // Calculate duration
    if (member.joinedAt) {
      variables.duration = formatDuration(member.joinedAt);
    } else {
      variables.duration = 'an unknown amount of time';
    }

    const messageText = interpolateMessage(
      config.goodbye_message ?? DEFAULT_GOODBYE_MESSAGE,
      variables,
    );

    await channel.send(messageText);
    console.log(`[Goodbye] Message sent for ${member.user?.tag ?? member.id}`);
  } catch (err) {
    console.error('[Goodbye] Failed to send goodbye message:', err);
  }
}
