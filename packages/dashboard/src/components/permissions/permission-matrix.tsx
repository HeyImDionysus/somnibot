'use client';

import { cn } from '@/lib/utils/cn';
import { Check, X, Minus } from 'lucide-react';

// ============================================================
// Types
// ============================================================

interface PermissionCategory {
  name: string;
  permissions: {
    key: string;
    label: string;
    description: string;
  }[];
}

interface MatrixRole {
  id: string;
  name: string;
  color: string;
  tier: string;
}

type PermValue = 'allow' | 'deny' | 'inherit';

interface PermissionMatrixProps {
  categories: PermissionCategory[];
  roles: MatrixRole[];
  values: Record<string, Record<string, PermValue>>; // roleId → permKey → value
  onChange: (roleId: string, permKey: string, value: PermValue) => void;
  readOnly?: boolean;
}

// ============================================================
// Predefined permission categories
// ============================================================

export const PERMISSION_CATEGORIES: PermissionCategory[] = [
  {
    name: 'General',
    permissions: [
      { key: 'VIEW_CHANNEL', label: 'View Channels', description: 'View text channels and see voice channels' },
      { key: 'MANAGE_CHANNELS', label: 'Manage Channels', description: 'Create, edit, or delete channels' },
      { key: 'MANAGE_ROLES', label: 'Manage Roles', description: 'Create, edit, or delete roles below the bot' },
      { key: 'MANAGE_GUILD_EXPRESSIONS', label: 'Manage Expressions', description: 'Manage emoji, stickers, and soundboard' },
      { key: 'VIEW_AUDIT_LOG', label: 'View Audit Log', description: 'View the server audit log' },
      { key: 'VIEW_GUILD_INSIGHTS', label: 'View Insights', description: 'View server insights and analytics' },
      { key: 'MANAGE_WEBHOOKS', label: 'Manage Webhooks', description: 'Create, edit, or delete webhooks' },
      { key: 'MANAGE_GUILD', label: 'Manage Server', description: 'Change server name, icon, and settings' },
    ],
  },
  {
    name: 'Membership',
    permissions: [
      { key: 'CREATE_INSTANT_INVITE', label: 'Create Invite', description: 'Create invites to the server' },
      { key: 'CHANGE_NICKNAME', label: 'Change Nickname', description: 'Change their own nickname' },
      { key: 'MANAGE_NICKNAMES', label: 'Manage Nicknames', description: 'Change other members\' nicknames' },
      { key: 'KICK_MEMBERS', label: 'Kick Members', description: 'Remove members from the server' },
      { key: 'BAN_MEMBERS', label: 'Ban Members', description: 'Permanently ban members' },
      { key: 'MODERATE_MEMBERS', label: 'Timeout Members', description: 'Timeout members, preventing interactions' },
    ],
  },
  {
    name: 'Text Channels',
    permissions: [
      { key: 'SEND_MESSAGES', label: 'Send Messages', description: 'Send messages in text channels' },
      { key: 'SEND_MESSAGES_IN_THREADS', label: 'Send Messages in Threads', description: 'Send messages in threads' },
      { key: 'CREATE_PUBLIC_THREADS', label: 'Create Public Threads', description: 'Create publicly visible threads' },
      { key: 'CREATE_PRIVATE_THREADS', label: 'Create Private Threads', description: 'Create invite-only threads' },
      { key: 'EMBED_LINKS', label: 'Embed Links', description: 'Links automatically embed previews' },
      { key: 'ATTACH_FILES', label: 'Attach Files', description: 'Upload files and images' },
      { key: 'ADD_REACTIONS', label: 'Add Reactions', description: 'Add emoji reactions to messages' },
      { key: 'USE_EXTERNAL_EMOJIS', label: 'External Emoji', description: 'Use emoji from other servers' },
      { key: 'USE_EXTERNAL_STICKERS', label: 'External Stickers', description: 'Use stickers from other servers' },
      { key: 'MENTION_EVERYONE', label: '@everyone/@here', description: 'Use @everyone and @here mentions' },
      { key: 'MANAGE_MESSAGES', label: 'Manage Messages', description: 'Delete or pin other members\' messages' },
      { key: 'MANAGE_THREADS', label: 'Manage Threads', description: 'Rename, delete, archive, and manage threads' },
      { key: 'READ_MESSAGE_HISTORY', label: 'Read History', description: 'Read previous messages in channels' },
      { key: 'SEND_TTS_MESSAGES', label: 'TTS Messages', description: 'Send text-to-speech messages' },
      { key: 'SEND_VOICE_MESSAGES', label: 'Voice Messages', description: 'Send voice messages' },
    ],
  },
  {
    name: 'Voice Channels',
    permissions: [
      { key: 'CONNECT', label: 'Connect', description: 'Join voice channels' },
      { key: 'SPEAK', label: 'Speak', description: 'Talk in voice channels' },
      { key: 'STREAM', label: 'Video/Screen Share', description: 'Share video or screen in voice channels' },
      { key: 'USE_SOUNDBOARD', label: 'Soundboard', description: 'Use the soundboard in voice channels' },
      { key: 'USE_EXTERNAL_SOUNDS', label: 'External Sounds', description: 'Use soundboard sounds from other servers' },
      { key: 'USE_VAD', label: 'Voice Activity', description: 'Use voice activity detection (vs push-to-talk)' },
      { key: 'PRIORITY_SPEAKER', label: 'Priority Speaker', description: 'Be heard above other members' },
      { key: 'MUTE_MEMBERS', label: 'Mute Members', description: 'Mute other members in voice' },
      { key: 'DEAFEN_MEMBERS', label: 'Deafen Members', description: 'Deafen other members in voice' },
      { key: 'MOVE_MEMBERS', label: 'Move Members', description: 'Move members between voice channels' },
      { key: 'REQUEST_TO_SPEAK', label: 'Request to Speak', description: 'Request to speak in stage channels' },
    ],
  },
  {
    name: 'Apps',
    permissions: [
      { key: 'USE_APPLICATION_COMMANDS', label: 'Use Slash Commands', description: 'Use bot slash commands' },
      { key: 'USE_EMBEDDED_ACTIVITIES', label: 'Activities', description: 'Use Activities in voice channels' },
    ],
  },
  {
    name: 'Events',
    permissions: [
      { key: 'CREATE_EVENTS', label: 'Create Events', description: 'Create scheduled events' },
      { key: 'MANAGE_EVENTS', label: 'Manage Events', description: 'Edit or cancel scheduled events' },
    ],
  },
];

// ============================================================
// Component
// ============================================================

export function PermissionMatrix({
  categories,
  roles,
  values,
  onChange,
  readOnly = false,
}: PermissionMatrixProps) {
  const cycleValue = (current: PermValue): PermValue => {
    if (current === 'inherit') return 'allow';
    if (current === 'allow') return 'deny';
    return 'inherit';
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {/* Header: role names */}
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-discord-bg-secondary px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
              Permission
            </th>
            {roles.map((role) => (
              <th key={role.id} className="min-w-[80px] px-2 py-2 text-center">
                <div className="flex flex-col items-center gap-1">
                  <div
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: role.color || '#99AAB5' }}
                  />
                  <span className="text-[10px] font-medium text-discord-text-secondary">
                    {role.name}
                  </span>
                </div>
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {categories.map((category) => (
            <>
              {/* Category header */}
              <tr key={`cat-${category.name}`}>
                <td
                  colSpan={roles.length + 1}
                  className="bg-discord-bg-tertiary/50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-discord-text-muted"
                >
                  {category.name}
                </td>
              </tr>

              {/* Permission rows */}
              {category.permissions.map((perm) => (
                <tr
                  key={perm.key}
                  className="border-b border-discord-border-subtle/30 hover:bg-discord-bg-primary/20"
                >
                  <td className="sticky left-0 z-10 bg-discord-bg-secondary px-3 py-1.5">
                    <div>
                      <p className="text-xs font-medium text-discord-text-primary">{perm.label}</p>
                      <p className="text-[10px] text-discord-text-muted">{perm.description}</p>
                    </div>
                  </td>

                  {roles.map((role) => {
                    const val = values[role.id]?.[perm.key] ?? 'inherit';

                    return (
                      <td key={role.id} className="px-2 py-1.5 text-center">
                        <button
                          type="button"
                          disabled={readOnly}
                          onClick={() => onChange(role.id, perm.key, cycleValue(val))}
                          className={cn(
                            'inline-flex h-6 w-6 items-center justify-center rounded transition-standard',
                            val === 'allow' && 'bg-discord-success/20 text-discord-success',
                            val === 'deny' && 'bg-discord-danger/20 text-discord-danger',
                            val === 'inherit' && 'bg-discord-bg-tertiary text-discord-text-muted/40',
                            !readOnly && 'hover:ring-1 hover:ring-discord-accent/50',
                          )}
                          title={`${perm.label}: ${val}`}
                        >
                          {val === 'allow' && <Check size={12} />}
                          {val === 'deny' && <X size={12} />}
                          {val === 'inherit' && <Minus size={12} />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}
