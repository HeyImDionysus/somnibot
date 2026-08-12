import type { SupabaseClient } from '@supabase/supabase-js';

const MAX_SNAPSHOT_AGE_MS = 10 * 60 * 1_000;
const VIEW_CHANNEL = BigInt(1) << BigInt(10);
const SEND_MESSAGES = BigInt(1) << BigInt(11);
const RELAY_CHANNEL_TYPES = new Set([0, 5]);

interface LiveRoleFact {
  id: string;
  name: string;
  managed: boolean;
  editableByBot: boolean;
}

interface LiveChannelFact {
  id: string;
  name: string;
  type: number | null;
  manageableByBot: boolean;
  botPermissions: string | null;
}

type LiveFactsFailure = {
  ok: false;
  kind: 'unavailable' | 'conflict';
  issues: string[];
};

export type DiscordTargetValidation =
  | { ok: true; snapshotAt: string | null }
  | LiveFactsFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRoles(value: unknown): LiveRoleFact[] | null {
  if (!Array.isArray(value)) return null;
  const roles: LiveRoleFact[] = [];
  for (const item of value) {
    if (
      !isRecord(item)
      || typeof item.id !== 'string'
      || typeof item.name !== 'string'
      || typeof item.managed !== 'boolean'
      || typeof item.editableByBot !== 'boolean'
    ) return null;
    roles.push({
      id: item.id,
      name: item.name,
      managed: item.managed,
      editableByBot: item.editableByBot,
    });
  }
  return roles;
}

function parseChannels(value: unknown): LiveChannelFact[] | null {
  if (!Array.isArray(value)) return null;
  const channels: LiveChannelFact[] = [];
  for (const item of value) {
    if (
      !isRecord(item)
      || typeof item.id !== 'string'
      || typeof item.name !== 'string'
      || typeof item.manageableByBot !== 'boolean'
      || (item.botPermissions !== null && typeof item.botPermissions !== 'string')
    ) return null;
    channels.push({
      id: item.id,
      name: item.name,
      type: typeof item.type === 'number' && Number.isInteger(item.type) ? item.type : null,
      manageableByBot: item.manageableByBot,
      botPermissions: item.botPermissions,
    });
  }
  return channels;
}

export async function validateExternalWebhookChannel(
  supabase: SupabaseClient,
  guildId: string,
  channelId: string,
  nowMs = Date.now(),
): Promise<DiscordTargetValidation> {
  const { data, error } = await supabase
    .from('guild_live_state')
    .select('channels, snapshot_at, snapshot_version')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error || !isRecord(data)) {
    return { ok: false, kind: 'unavailable', issues: ['SomniBot has not published live Discord facts for this server.'] };
  }

  const snapshotAt = typeof data.snapshot_at === 'string' ? data.snapshot_at : null;
  const snapshotMs = snapshotAt ? Date.parse(snapshotAt) : Number.NaN;
  if (
    data.snapshot_version !== 2
    || !Number.isFinite(snapshotMs)
    || nowMs - snapshotMs > MAX_SNAPSHOT_AGE_MS
    || snapshotMs - nowMs > 60_000
  ) {
    return {
      ok: false,
      kind: 'unavailable',
      issues: ['SomniBot live Discord facts are missing, legacy, or stale. Wait for a fresh bot snapshot and retry.'],
    };
  }

  const channels = parseChannels(data.channels);
  if (!channels) {
    return { ok: false, kind: 'unavailable', issues: ['SomniBot live Discord facts are malformed. Wait for the bot to refresh them and retry.'] };
  }
  const channel = channels.find((candidate) => candidate.id === channelId);
  if (!channel) {
    return { ok: false, kind: 'conflict', issues: [`Discord channel ${channelId} was deleted or is not in this server.`] };
  }
  if (channel.type === null || !RELAY_CHANNEL_TYPES.has(channel.type)) {
    return { ok: false, kind: 'conflict', issues: [`Choose a text or announcement channel instead of "#${channel.name}".`] };
  }

  let permissions: bigint | null = null;
  try {
    permissions = channel.botPermissions === null ? null : BigInt(channel.botPermissions);
  } catch {
    permissions = null;
  }
  if (permissions === null || (permissions & VIEW_CHANNEL) !== VIEW_CHANNEL) {
    return { ok: false, kind: 'conflict', issues: [`Grant SomniBot View Channel in "#${channel.name}" before using this relay.`] };
  }
  if ((permissions & SEND_MESSAGES) !== SEND_MESSAGES) {
    return { ok: false, kind: 'conflict', issues: [`Grant SomniBot Send Messages in "#${channel.name}" before using this relay.`] };
  }
  return { ok: true, snapshotAt };
}

/**
 * Validate benefit targets against the bot's complete, versioned Discord
 * snapshot. Absence from a fresh v2 snapshot is authoritative deletion.
 * Legacy, malformed, missing, or stale state is unavailable rather than safe.
 */
export async function validateAssignableDiscordTargets(
  supabase: SupabaseClient,
  guildId: string,
  roleIds: string[],
  channelIds: string[],
  nowMs = Date.now(),
): Promise<DiscordTargetValidation> {
  if (roleIds.length === 0 && channelIds.length === 0) {
    return { ok: true, snapshotAt: null };
  }

  const { data, error } = await supabase
    .from('guild_live_state')
    .select('roles, channels, snapshot_at, snapshot_version')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error || !isRecord(data)) {
    return {
      ok: false,
      kind: 'unavailable',
      issues: ['SomniBot has not published live Discord facts for this server.'],
    };
  }

  const snapshotAt = typeof data.snapshot_at === 'string' ? data.snapshot_at : null;
  const snapshotMs = snapshotAt ? Date.parse(snapshotAt) : Number.NaN;
  if (
    data.snapshot_version !== 2
    || !Number.isFinite(snapshotMs)
    || nowMs - snapshotMs > MAX_SNAPSHOT_AGE_MS
    || snapshotMs - nowMs > 60_000
  ) {
    return {
      ok: false,
      kind: 'unavailable',
      issues: ['SomniBot live Discord facts are missing, legacy, or stale. Wait for a fresh bot snapshot and retry.'],
    };
  }

  const roles = parseRoles(data.roles);
  const channels = parseChannels(data.channels);
  if (!roles || !channels) {
    return {
      ok: false,
      kind: 'unavailable',
      issues: ['SomniBot live Discord facts are malformed. Wait for the bot to refresh them and retry.'],
    };
  }

  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
  const issues: string[] = [];

  for (const roleId of new Set(roleIds)) {
    const role = rolesById.get(roleId);
    if (!role) {
      issues.push(`Discord role ${roleId} was deleted or is not in this server.`);
    } else if (role.managed) {
      issues.push(`Discord role "${role.name}" is managed by Discord and cannot be granted by SomniBot.`);
    } else if (!role.editableByBot) {
      issues.push(`Move SomniBot above the "${role.name}" role and grant Manage Roles before selling this benefit.`);
    }
  }

  for (const channelId of new Set(channelIds)) {
    const channel = channelsById.get(channelId);
    if (!channel) {
      issues.push(`Discord channel ${channelId} was deleted or is not in this server.`);
    } else {
      let permissions: bigint | null = null;
      try {
        permissions = channel.botPermissions === null ? null : BigInt(channel.botPermissions);
      } catch {
        permissions = null;
      }
      if (permissions === null || (permissions & VIEW_CHANNEL) !== VIEW_CHANNEL) {
        issues.push(`Grant SomniBot View Channel in "#${channel.name}" before selling this benefit.`);
      } else if (!channel.manageableByBot) {
        issues.push(`Grant SomniBot Manage Channels in "#${channel.name}" before selling this benefit.`);
      }
    }
  }

  return issues.length > 0
    ? { ok: false, kind: 'conflict', issues }
    : { ok: true, snapshotAt };
}
