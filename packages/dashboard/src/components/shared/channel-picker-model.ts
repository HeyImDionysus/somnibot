export const CHANNEL_TYPE = {
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

export type ChannelType = (typeof CHANNEL_TYPE)[keyof typeof CHANNEL_TYPE];

const CHANNEL_TYPE_ALIAS: Readonly<Record<string, ChannelType>> = {
  text: CHANNEL_TYPE.GUILD_TEXT,
  voice: CHANNEL_TYPE.GUILD_VOICE,
  category: CHANNEL_TYPE.GUILD_CATEGORY,
  announcement: CHANNEL_TYPE.GUILD_ANNOUNCEMENT,
  stage: CHANNEL_TYPE.GUILD_STAGE_VOICE,
  forum: CHANNEL_TYPE.GUILD_FORUM,
};

export type ChannelTypeInput = ChannelType | keyof typeof CHANNEL_TYPE_ALIAS;

export interface DiscordChannel {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly position: number;
  readonly parent_id?: string | null;
  readonly parent_name?: string;
  readonly botPermissions?: string | null;
  readonly manageableByBot?: boolean;
  readonly missing?: boolean;
}

interface DiscordCategory {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly parent_id?: string | null;
  readonly parent_name?: string;
  readonly botPermissions?: string | null;
  readonly manageableByBot?: boolean;
}

export type RequiredChannelPermission =
  | 'ViewChannel'
  | 'SendMessages'
  | 'EmbedLinks'
  | 'AttachFiles'
  | 'ReadMessageHistory'
  | 'Connect'
  | 'Speak'
  | 'ManageChannels';

const PERMISSION_BITS: Readonly<Record<RequiredChannelPermission, bigint>> = {
  ManageChannels: BigInt(1) << BigInt(4),
  ViewChannel: BigInt(1) << BigInt(10),
  SendMessages: BigInt(1) << BigInt(11),
  EmbedLinks: BigInt(1) << BigInt(14),
  AttachFiles: BigInt(1) << BigInt(15),
  ReadMessageHistory: BigInt(1) << BigInt(16),
  Connect: BigInt(1) << BigInt(20),
  Speak: BigInt(1) << BigInt(21),
};

export interface ChannelSnapshot {
  readonly channels: readonly DiscordChannel[];
  readonly authoritative: boolean;
  readonly snapshotAtMs: number;
}

class ChannelSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelSnapshotError';
  }
}

const CACHE_TTL = 30_000;
const MAX_SNAPSHOT_AGE_MS = 10 * 60 * 1_000;
const MAX_SNAPSHOT_FUTURE_SKEW_MS = 60_000;

let channelCache: { readonly data: ChannelSnapshot; readonly ts: number } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNormalizableChannel(value: unknown): value is DiscordChannel {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.type === 'number'
    && Number.isFinite(value.type)
    && typeof value.position === 'number'
    && Number.isFinite(value.position)
    && (value.parent_id === undefined || value.parent_id === null || typeof value.parent_id === 'string')
    && (value.parent_name === undefined || typeof value.parent_name === 'string')
    && (value.manageableByBot === undefined || typeof value.manageableByBot === 'boolean')
    && (value.botPermissions === undefined || value.botPermissions === null || typeof value.botPermissions === 'string')
    && (value.missing === undefined || typeof value.missing === 'boolean');
}

function isNormalizableCategory(value: unknown): value is DiscordCategory {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.position === 'number'
    && Number.isFinite(value.position)
    && (value.parent_id === undefined || value.parent_id === null || typeof value.parent_id === 'string')
    && (value.parent_name === undefined || typeof value.parent_name === 'string')
    && (value.manageableByBot === undefined || typeof value.manageableByBot === 'boolean')
    && (value.botPermissions === undefined || value.botPermissions === null || typeof value.botPermissions === 'string');
}

function isAuthoritativeChannel(value: unknown): value is DiscordChannel {
  return isNormalizableChannel(value)
    && typeof value.manageableByBot === 'boolean'
    && (value.botPermissions === null || typeof value.botPermissions === 'string');
}

function isAuthoritativeCategory(value: unknown): value is DiscordCategory {
  return isNormalizableCategory(value)
    && typeof value.manageableByBot === 'boolean'
    && (value.botPermissions === null || typeof value.botPermissions === 'string');
}

export function resolveChannelTypes(channelTypes: readonly ChannelTypeInput[]): readonly ChannelType[] {
  return channelTypes.map((type) => (
    typeof type === 'string' ? (CHANNEL_TYPE_ALIAS[type] ?? type) : type
  ));
}

export function channelPermissionIssue(
  channel: Pick<DiscordChannel, 'missing' | 'botPermissions' | 'name'>,
  requiredBotPermissions: readonly RequiredChannelPermission[],
  snapshotAuthoritative: boolean,
): string | null {
  if (channel.missing) return 'This channel was deleted or is no longer in this server.';
  if (requiredBotPermissions.length === 0) return null;
  if (!snapshotAuthoritative) {
    return 'Live bot permissions cannot be verified right now — retry after the bot refreshes its snapshot.';
  }
  if (channel.botPermissions == null) return 'Live bot permissions are unavailable for this channel.';
  try {
    const available = BigInt(channel.botPermissions);
    const missing = requiredBotPermissions.filter(
      (permission) => (available & PERMISSION_BITS[permission]) !== PERMISSION_BITS[permission],
    );
    return missing.length > 0
      ? `SomniBot is missing ${missing.join(', ')} in #${channel.name}.`
      : null;
  } catch {
    return 'Live bot permissions are malformed for this channel.';
  }
}

export function snapshotTimestampMs(payload: unknown): number | null {
  if (!isRecord(payload) || typeof payload.snapshotAt !== 'string') return null;
  const parsed = Date.parse(payload.snapshotAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isAuthoritativeChannelSnapshot(payload: unknown, nowMs = Date.now()): boolean {
  if (!isRecord(payload) || payload.awaitingSnapshot === true) return false;
  const snapshotMs = snapshotTimestampMs(payload) ?? Number.NaN;
  return payload.snapshotVersion === 2
    && Number.isFinite(snapshotMs)
    && nowMs - snapshotMs <= MAX_SNAPSHOT_AGE_MS
    && snapshotMs - nowMs <= MAX_SNAPSHOT_FUTURE_SKEW_MS
    && Array.isArray(payload.channels)
    && payload.channels.every(isAuthoritativeChannel)
    && Array.isArray(payload.categories)
    && payload.categories.every(isAuthoritativeCategory);
}

export function normalizeSnapshotChannels(payload: unknown): readonly DiscordChannel[] {
  if (!isRecord(payload)) throw new ChannelSnapshotError('Live Discord channel snapshot is malformed');
  const channels = payload.channels ?? payload.data ?? [];
  const categories = payload.categories ?? [];
  if (!Array.isArray(channels) || !Array.isArray(categories)) {
    throw new ChannelSnapshotError('Live Discord channel snapshot is malformed');
  }
  const normalizedChannels = channels.map((channel) => {
    if (!isNormalizableChannel(channel)) {
      throw new ChannelSnapshotError('Live Discord channel snapshot is malformed');
    }
    return channel;
  });
  const normalizedCategories = categories.map((category): DiscordChannel => {
    if (!isNormalizableCategory(category)) {
      throw new ChannelSnapshotError('Live Discord channel snapshot is malformed');
    }
    return { ...category, type: CHANNEL_TYPE.GUILD_CATEGORY };
  });
  return [...normalizedChannels, ...normalizedCategories];
}

export function snapshotAuthorityAsOf(
  snapshotAuthoritative: boolean,
  snapshotAtMs: number,
  nowMs: number,
): boolean {
  return snapshotAuthoritative
    && snapshotAtMs > 0
    && nowMs - snapshotAtMs <= MAX_SNAPSHOT_AGE_MS;
}

export async function fetchChannels(): Promise<ChannelSnapshot> {
  if (channelCache && Date.now() - channelCache.ts < CACHE_TTL) return channelCache.data;
  const response = await fetch('/api/channels');
  const payload: unknown = await response.json();
  if (!response.ok || !isRecord(payload) || payload.success !== true) {
    const message = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : 'Failed to load live Discord channels';
    throw new ChannelSnapshotError(message);
  }
  const snapshot: ChannelSnapshot = {
    channels: normalizeSnapshotChannels(payload),
    authoritative: isAuthoritativeChannelSnapshot(payload),
    snapshotAtMs: snapshotTimestampMs(payload) ?? Date.now(),
  };
  channelCache = { data: snapshot, ts: Date.now() };
  return snapshot;
}

export function invalidateChannelCache(): void {
  channelCache = null;
}

export function resolveSelectedChannels(
  selected: readonly string[],
  channels: readonly DiscordChannel[],
  snapshotAuthoritative: boolean,
): readonly DiscordChannel[] {
  return selected.map((id) => channels.find((channel) => channel.id === id) ?? {
    id,
    name: snapshotAuthoritative
      ? `Deleted channel (${id})`
      : `Configured channel (${id}) — awaiting live snapshot`,
    type: CHANNEL_TYPE.GUILD_TEXT,
    position: Number.MAX_SAFE_INTEGER,
    missing: snapshotAuthoritative,
  });
}
