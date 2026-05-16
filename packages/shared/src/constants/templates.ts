import { computePermissions, type DiscordPermission } from './permissions.js';

// ============================================================
// Role Templates
// ============================================================

/** Permissions granted to the Member role template. */
const MEMBER_PERMISSIONS: DiscordPermission[] = [
  // General
  'VIEW_CHANNEL', 'CREATE_INSTANT_INVITE', 'CHANGE_NICKNAME',
  'CREATE_EVENTS', 'USE_EXTERNAL_APPS',
  // Text
  'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS',
  'EMBED_LINKS', 'ATTACH_FILES', 'ADD_REACTIONS', 'USE_EXTERNAL_EMOJIS',
  'USE_EXTERNAL_STICKERS', 'READ_MESSAGE_HISTORY', 'USE_APPLICATION_COMMANDS',
  'SEND_VOICE_MESSAGES', 'SEND_POLLS',
  // Voice
  'CONNECT', 'SPEAK', 'STREAM', 'USE_SOUNDBOARD', 'USE_VAD',
  'USE_EMBEDDED_ACTIVITIES', 'REQUEST_TO_SPEAK',
];

/** Moderator = Member + moderation tools. */
const MODERATOR_PERMISSIONS: DiscordPermission[] = [
  ...MEMBER_PERMISSIONS,
  // Additional general
  'VIEW_AUDIT_LOG', 'MANAGE_NICKNAMES', 'MANAGE_EVENTS',
  'CREATE_GUILD_EXPRESSIONS', 'USE_EXTERNAL_SOUNDS',
  // Additional text
  'MANAGE_MESSAGES', 'MANAGE_THREADS', 'MENTION_EVERYONE',
  'CREATE_PRIVATE_THREADS',
  // Additional voice
  'PRIORITY_SPEAKER', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS',
  // Moderation
  'KICK_MEMBERS', 'MODERATE_MEMBERS',
];

/** Admin = Moderator + full management. */
const ADMIN_PERMISSIONS: DiscordPermission[] = [
  ...MODERATOR_PERMISSIONS,
  'MANAGE_GUILD', 'MANAGE_ROLES', 'MANAGE_CHANNELS',
  'MANAGE_WEBHOOKS', 'MANAGE_GUILD_EXPRESSIONS',
  'VIEW_GUILD_INSIGHTS', 'VIEW_CREATOR_MONETIZATION_ANALYTICS',
  'BAN_MEMBERS',
];

export type RoleTemplateTier = 'everyone' | 'cosmetic' | 'member' | 'moderator' | 'admin' | 'custom';

export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  permissions: bigint;
  permissionList: readonly DiscordPermission[];
  tier: RoleTemplateTier;
  editable: boolean;
}

export const ROLE_TEMPLATES: Record<string, RoleTemplate> = {
  EVERYONE: {
    id: 'everyone',
    name: '@everyone',
    description: 'Base role — ZERO permissions. The locked door.',
    permissions: 0n,
    permissionList: [],
    tier: 'everyone',
    editable: false,
  },
  COSMETIC: {
    id: 'cosmetic',
    name: 'Cosmetic',
    description: 'Display-only. Zero functional permissions.',
    permissions: 0n,
    permissionList: [],
    tier: 'cosmetic',
    editable: false,
  },
  MEMBER: {
    id: 'member',
    name: 'Member',
    description: 'Standard community member. Can participate in text and voice.',
    permissions: computePermissions(MEMBER_PERMISSIONS),
    permissionList: MEMBER_PERMISSIONS,
    tier: 'member',
    editable: false,
  },
  MODERATOR: {
    id: 'moderator',
    name: 'Moderator',
    description: 'Community moderator. Member permissions + moderation tools.',
    permissions: computePermissions(MODERATOR_PERMISSIONS),
    permissionList: MODERATOR_PERMISSIONS,
    tier: 'moderator',
    editable: false,
  },
  ADMIN: {
    id: 'admin',
    name: 'Admin',
    description: 'Server administrator. Moderator permissions + full management.',
    permissions: computePermissions(ADMIN_PERMISSIONS),
    permissionList: ADMIN_PERMISSIONS,
    tier: 'admin',
    editable: false,
  },
} as const;

// ============================================================
// Channel Templates
// ============================================================

export type ChannelTemplateType = 'text' | 'voice' | 'stage' | 'forum' | 'announcement';

export interface ChannelTemplateOverride {
  role_tier: RoleTemplateTier;
  allow: readonly DiscordPermission[];
  deny: readonly DiscordPermission[];
}

export interface ChannelTemplate {
  id: string;
  name: string;
  description: string;
  targetChannelType: ChannelTemplateType;
  overrides: readonly ChannelTemplateOverride[];
  isBuiltin: boolean;
}

export const CHANNEL_TEMPLATES: Record<string, ChannelTemplate> = {
  MEMBER_VIEW_ONLY: {
    id: 'member_view_only',
    name: 'Member View Only',
    description: 'Members can read and react, but not send messages.',
    targetChannelType: 'text',
    overrides: [
      {
        role_tier: 'everyone',
        allow: [],
        deny: ['VIEW_CHANNEL'],
      },
      {
        role_tier: 'member',
        allow: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'ADD_REACTIONS'],
        deny: ['SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS'],
      },
    ],
    isBuiltin: true,
  },
  MEMBER_VIEW_AND_USE: {
    id: 'member_view_and_use',
    name: 'Member View & Use',
    description: 'Members can read, send, and interact normally.',
    targetChannelType: 'text',
    overrides: [
      {
        role_tier: 'everyone',
        allow: [],
        deny: ['VIEW_CHANNEL'],
      },
      {
        role_tier: 'member',
        allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'ADD_REACTIONS',
                'EMBED_LINKS', 'ATTACH_FILES', 'USE_EXTERNAL_EMOJIS', 'USE_EXTERNAL_STICKERS'],
        deny: [],
      },
    ],
    isBuiltin: true,
  },
  STAFF_ONLY: {
    id: 'staff_only',
    name: 'Staff Only',
    description: 'Invisible to members. Only moderators and admins can access.',
    targetChannelType: 'text',
    overrides: [
      {
        role_tier: 'everyone',
        allow: [],
        deny: ['VIEW_CHANNEL'],
      },
      {
        role_tier: 'member',
        allow: [],
        deny: ['VIEW_CHANNEL'],
      },
      {
        role_tier: 'moderator',
        allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'MANAGE_MESSAGES',
                'ADD_REACTIONS', 'EMBED_LINKS', 'ATTACH_FILES'],
        deny: [],
      },
    ],
    isBuiltin: true,
  },
  PREMIUM_ONLY: {
    id: 'premium_only',
    name: 'Premium Only',
    description: 'Only accessible to members with a premium entitlement role.',
    targetChannelType: 'text',
    overrides: [
      {
        role_tier: 'everyone',
        allow: [],
        deny: ['VIEW_CHANNEL'],
      },
      {
        role_tier: 'member',
        allow: [],
        deny: ['VIEW_CHANNEL'],
      },
      // Premium role override is applied dynamically based on product config
    ],
    isBuiltin: true,
  },
} as const;
