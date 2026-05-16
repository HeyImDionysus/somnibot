/**
 * Discord API constants and limits.
 */

/** Discord API rate limit–safe values */
export const DISCORD_LIMITS = {
  MAX_ROLES_PER_GUILD: 250,
  MAX_CHANNELS_PER_GUILD: 500,
  MAX_CATEGORIES_PER_GUILD: 50,
  MAX_OVERWRITES_PER_CHANNEL: 100,
  MAX_EMBED_FIELDS: 25,
  MAX_EMBED_TITLE: 256,
  MAX_EMBED_DESCRIPTION: 4096,
  MAX_EMBED_TOTAL: 6000,
  MAX_MESSAGE_LENGTH: 2000,
  MAX_COMPONENTS_PER_MESSAGE: 40,
  MAX_COMPONENTS_V2_TEXT: 4000,
  MAX_SLASH_COMMANDS: 100,
  MAX_SELECT_OPTIONS: 25,
  MAX_BUTTONS_PER_ROW: 5,
  MAX_ACTION_ROWS: 5,
  STATS_CHANNEL_RENAME_LIMIT: 2,
  STATS_CHANNEL_RENAME_WINDOW_MINUTES: 10,
} as const;

/** Discord channel type enum values */
export const DISCORD_CHANNEL_TYPES = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  GUILD_STAGE_VOICE: 13,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
} as const;

/** Components v2 flag for message creation */
export const COMPONENTS_V2_FLAG = 1 << 15;

/** Discord gateway intents the bot needs */
export const REQUIRED_INTENTS = [
  'Guilds',
  'GuildMembers',
  'GuildModeration',
  'GuildEmojisAndStickers',
  'GuildIntegrations',
  'GuildWebhooks',
  'GuildInvites',
  'GuildVoiceStates',
  'GuildPresences',
  'GuildMessages',
  'GuildMessageReactions',
  'GuildMessageTyping',
  'MessageContent',
  'GuildScheduledEvents',
  'AutoModerationConfiguration',
  'AutoModerationExecution',
] as const;
