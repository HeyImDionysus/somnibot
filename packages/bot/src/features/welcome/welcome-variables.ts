/**
 * Welcome Message Variable Interpolation
 *
 * Replaces template variables in welcome/goodbye messages with actual values.
 * See architecture doc §17.2 for the full variable list.
 */

import type { GuildMember, Guild } from 'discord.js';

export interface WelcomeVariables {
  /** User mention: @Username */
  user: string;
  /** Username without mention */
  'user.name': string;
  /** Full tag: Username#0 */
  'user.tag': string;
  /** Avatar URL */
  'user.avatar': string;
  /** Server name */
  server: string;
  /** Server icon URL */
  'server.icon': string;
  /** Total member count (formatted) */
  memberCount: string;
  /** This member's join number (formatted) */
  memberNumber: string;
  /** Member's level (for returning members) */
  level: string;
  /** How long the member was in the server (for goodbye) */
  duration: string;
}

/**
 * Build the variable map for a member.
 */
export function buildWelcomeVariables(
  member: GuildMember,
  guild: Guild,
  memberNumber: number,
  level: number = 0,
): WelcomeVariables {
  return {
    user: `<@${member.id}>`,
    'user.name': member.user.displayName,
    'user.tag': member.user.tag,
    'user.avatar': member.user.displayAvatarURL({ size: 256 }),
    server: guild.name,
    'server.icon': guild.iconURL({ size: 256 }) ?? '',
    memberCount: guild.memberCount.toLocaleString(),
    memberNumber: `#${memberNumber.toLocaleString()}`,
    level: level.toString(),
    duration: '', // Set separately for goodbye messages
  };
}

/**
 * Calculate a human-readable duration string.
 */
export function formatDuration(joinedAt: Date): string {
  const now = Date.now();
  const diff = now - joinedAt.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (years > 0) return `${years} year${years !== 1 ? 's' : ''}`;
  if (months > 0) return `${months} month${months !== 1 ? 's' : ''}`;
  if (days > 0) return `${days} day${days !== 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  return 'less than a minute';
}

/**
 * Interpolate variables into a message template.
 * Replaces `{variable}` with the corresponding value.
 */
export function interpolateMessage(
  template: string,
  variables: WelcomeVariables,
): string {
  const interpolated = template.replace(/\{([^}]+)\}/g, (match, key: string) => {
    const value = variables[key.trim() as keyof WelcomeVariables];
    return value !== undefined ? value : match; // Leave unknown vars as-is
  });
  // Discord message content is capped at 2,000 characters. Templates are
  // validated before substitution, but variables such as server/user names
  // can expand the final result beyond that limit.
  return interpolated.length <= 2_000
    ? interpolated
    : `${interpolated.slice(0, 1_999)}…`;
}
