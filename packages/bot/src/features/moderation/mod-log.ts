/**
 * Mod Log — Posts formatted moderation entries to the mod-log channel.
 *
 * Uses Discord Components v2 format with SomniBot palette.
 * Architecture doc §18.5
 */

import { type GuildMember, EmbedBuilder, type TextChannel } from 'discord.js';
import type { SomniClient } from '../../client.js';
import type { InfractionType } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('ModLog');

// SomniBot palette
const COLORS = {
  warn: 0xFF6B00,    // ORANGE
  mute: 0xFEE75C,    // YELLOW
  kick: 0xFF6B00,    // ORANGE
  ban: 0xED4245,     // RED
  pardon: 0x57F287,  // GREEN
  delete: 0x5865F2,  // BLURPLE
} as const;

const ICONS = {
  warn: '⚠️',
  mute: '🔇',
  kick: '👢',
  ban: '🔨',
  pardon: '✅',
  delete: '🗑️',
} as const;

const ACTION_LABELS = {
  warn: 'Warning Issued',
  mute: 'Member Muted',
  kick: 'Member Kicked',
  ban: 'Member Banned',
  pardon: 'Infraction Pardoned',
  delete: 'Message Deleted',
} as const;

export interface ModLogEntry {
  action: InfractionType | 'pardon' | 'delete';
  member: GuildMember | { id: string; user: { tag: string; displayAvatarURL: () => string } };
  moderator: string;           // Display name or 'System (Auto-Mod)'
  reason: string;
  duration?: number;           // Minutes, for mutes
  activeWarnings?: number;
  nextEscalation?: string | null;
  channelId: string | null;
  ruleType?: string;           // Auto-mod rule type
}

/**
 * Post a formatted moderation log entry to the mod-log channel.
 */
export async function postModLogEntry(
  client: SomniClient,
  entry: ModLogEntry,
): Promise<void> {
  if (!entry.channelId) return;

  try {
    const channel = client.channels.cache.get(entry.channelId) as TextChannel | undefined;
    if (!channel || !('send' in channel)) return;

    const color = COLORS[entry.action] ?? COLORS.warn;
    const icon = ICONS[entry.action] ?? '⚠️';
    const label = ACTION_LABELS[entry.action] ?? entry.action;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${icon} ${label}`)
      .addFields(
        { name: 'Member', value: `<@${getMemberId(entry.member)}> (${getMemberTag(entry.member)})`, inline: true },
        { name: 'Moderator', value: entry.moderator, inline: true },
      )
      .setTimestamp();

    // Reason
    embed.addFields({ name: 'Reason', value: entry.reason || 'No reason provided' });

    // Duration (for mutes)
    if (entry.action === 'mute' && entry.duration) {
      const hours = Math.floor(entry.duration / 60);
      const mins = entry.duration % 60;
      const durationStr = hours > 0
        ? `${hours}h${mins > 0 ? ` ${mins}m` : ''}`
        : `${mins}m`;
      embed.addFields({ name: 'Duration', value: durationStr, inline: true });
    }

    // Active warnings / escalation info
    if (typeof entry.activeWarnings === 'number') {
      embed.addFields({
        name: 'Active Warnings',
        value: String(entry.activeWarnings),
        inline: true,
      });
    }

    if (entry.nextEscalation) {
      embed.addFields({
        name: 'Next Escalation',
        value: entry.nextEscalation,
        inline: true,
      });
    }

    // Auto-mod rule type
    if (entry.ruleType) {
      embed.addFields({
        name: 'Auto-Mod Rule',
        value: entry.ruleType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        inline: true,
      });
    }

    // Member avatar as thumbnail
    const avatarUrl = getMemberAvatar(entry.member);
    if (avatarUrl) {
      embed.setThumbnail(avatarUrl);
    }

    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.error('Failed to post mod log entry:', { error: String(err) });
  }
}

function getMemberId(member: ModLogEntry['member']): string {
  return 'id' in member ? member.id : '';
}

function getMemberTag(member: ModLogEntry['member']): string {
  return member.user.tag;
}

function getMemberAvatar(member: ModLogEntry['member']): string | null {
  try {
    return member.user.displayAvatarURL();
  } catch {
    return null;
  }
}
