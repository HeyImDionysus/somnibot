/**
 * Full Discord permission registry with bitfield values.
 * Reference: https://discord.com/developers/docs/topics/permissions
 */
export const DISCORD_PERMISSIONS = {
  // General Server
  ADMINISTRATOR: 1n << 3n,
  VIEW_AUDIT_LOG: 1n << 7n,
  VIEW_GUILD_INSIGHTS: 1n << 19n,
  MANAGE_GUILD: 1n << 5n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  CREATE_GUILD_EXPRESSIONS: 1n << 43n,
  VIEW_CREATOR_MONETIZATION_ANALYTICS: 1n << 41n,
  CREATE_INSTANT_INVITE: 1n << 0n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_EVENTS: 1n << 33n,
  CREATE_EVENTS: 1n << 44n,
  USE_EXTERNAL_APPS: 1n << 50n,

  // Text Channel
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  ADD_REACTIONS: 1n << 6n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  USE_EXTERNAL_STICKERS: 1n << 37n,
  MENTION_EVERYONE: 1n << 17n,
  MANAGE_MESSAGES: 1n << 13n,
  MANAGE_THREADS: 1n << 34n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  SEND_TTS_MESSAGES: 1n << 12n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  SEND_VOICE_MESSAGES: 1n << 46n,
  SEND_POLLS: 1n << 49n,

  // Voice Channel
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  STREAM: 1n << 9n,
  USE_SOUNDBOARD: 1n << 42n,
  USE_EXTERNAL_SOUNDS: 1n << 45n,
  USE_VAD: 1n << 25n,
  PRIORITY_SPEAKER: 1n << 8n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_EMBEDDED_ACTIVITIES: 1n << 39n,
  REQUEST_TO_SPEAK: 1n << 32n,

  // Moderation
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  MODERATE_MEMBERS: 1n << 40n,
} as const;

export type DiscordPermission = keyof typeof DISCORD_PERMISSIONS;

/**
 * Human-readable categories for the dashboard permission matrix.
 */
export const PERMISSION_CATEGORIES = {
  'General Server': [
    'ADMINISTRATOR', 'VIEW_AUDIT_LOG', 'VIEW_GUILD_INSIGHTS', 'MANAGE_GUILD',
    'MANAGE_ROLES', 'MANAGE_CHANNELS', 'MANAGE_WEBHOOKS', 'MANAGE_GUILD_EXPRESSIONS',
    'CREATE_GUILD_EXPRESSIONS', 'VIEW_CREATOR_MONETIZATION_ANALYTICS',
    'CREATE_INSTANT_INVITE', 'CHANGE_NICKNAME', 'MANAGE_NICKNAMES',
    'MANAGE_EVENTS', 'CREATE_EVENTS', 'USE_EXTERNAL_APPS',
  ],
  'Text Channel': [
    'VIEW_CHANNEL', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS',
    'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS', 'EMBED_LINKS',
    'ATTACH_FILES', 'ADD_REACTIONS', 'USE_EXTERNAL_EMOJIS', 'USE_EXTERNAL_STICKERS',
    'MENTION_EVERYONE', 'MANAGE_MESSAGES', 'MANAGE_THREADS',
    'READ_MESSAGE_HISTORY', 'SEND_TTS_MESSAGES', 'USE_APPLICATION_COMMANDS',
    'SEND_VOICE_MESSAGES', 'SEND_POLLS',
  ],
  'Voice Channel': [
    'CONNECT', 'SPEAK', 'STREAM', 'USE_SOUNDBOARD', 'USE_EXTERNAL_SOUNDS',
    'USE_VAD', 'PRIORITY_SPEAKER', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS',
    'MOVE_MEMBERS', 'USE_EMBEDDED_ACTIVITIES', 'REQUEST_TO_SPEAK',
  ],
  'Moderation': [
    'KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS',
  ],
} as const satisfies Record<string, readonly DiscordPermission[]>;

export type PermissionCategory = keyof typeof PERMISSION_CATEGORIES;

/**
 * Compute a combined permission bitfield from an array of permission names.
 */
export function computePermissions(perms: readonly DiscordPermission[]): bigint {
  return perms.reduce((acc, perm) => acc | DISCORD_PERMISSIONS[perm], 0n);
}
