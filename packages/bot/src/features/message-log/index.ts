/**
 * Message Log — Logs message edits and deletes to a designated channel.
 *
 * V17 Behavioral Audit — Item 10
 *
 * Tracks messageUpdate and messageDelete events and posts embeds
 * to the configured message log channel.
 */

import {
  EmbedBuilder,
  type Message,
  type PartialMessage,
  type TextChannel,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('MessageLog');

interface MessageLogConfig {
  message_log_enabled: boolean;
  message_log_channel_id: string | null;
  message_log_edits_enabled: boolean;
  message_log_deletes_enabled: boolean;
  message_log_ignored_channel_ids: string[];
}

const CONFIG_TTL = 60_000;
// Per-guild cache: a single-process bot serves many guilds. A module-global entry
// let the first guild's message-log config ({enabled, channel_id}) serve every
// other guild for the whole TTL — so a second guild's edits/deletes resolved the
// wrong (globally-unique) channel id and were silently dropped (missed forensic
// capture), and a disabled guild could transiently inherit an enabled config.
const _configCache = new Map<string, { config: MessageLogConfig; time: number }>();

// Last config we emitted an audit event for, per guild. Kept SEPARATE from the
// TTL cache (which invalidateMessageLogCache clears) so we can diff a freshly
// re-read config against the previously-audited one and emit exactly one
// 'message_log.config_updated' audit row per real change (observability-gap:
// message-log config changes wrote no audit_logs row).
const _lastAuditedConfig = new Map<string, MessageLogConfig>();

// Throttle for the DEPFAIL degradation alert/audit so a persistently-down DB
// doesn't emit an alert on every message event.
const DEGRADED_NOTIFY_TTL = 5 * 60_000;
const _degradedNotified = new Map<string, number>();

/** Shallow value-equality for the audited config fields. */
function configsEqual(a: MessageLogConfig, b: MessageLogConfig): boolean {
  return (
    a.message_log_enabled === b.message_log_enabled &&
    a.message_log_channel_id === b.message_log_channel_id &&
    a.message_log_edits_enabled === b.message_log_edits_enabled &&
    a.message_log_deletes_enabled === b.message_log_deletes_enabled &&
    a.message_log_ignored_channel_ids.join(',') === b.message_log_ignored_channel_ids.join(',')
  );
}

/**
 * Append-only audit: emit 'message_log.config_updated' the first time a
 * freshly-read config differs from the previously-audited one. The first load
 * for a guild only seeds the baseline (no emit). AuditService maps the event to
 * a moderation audit_logs row carrying guild + before/after diff.
 */
function maybeAuditConfigChange(client: SomniClient, guildId: string, config: MessageLogConfig): void {
  const prev = _lastAuditedConfig.get(guildId);
  _lastAuditedConfig.set(guildId, config);
  if (!prev || configsEqual(prev, config)) return;

  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(config) as (keyof MessageLogConfig)[]) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(config[key])) {
      changed[key] = config[key];
    }
  }

  client.eventBus.emit('message_log.config_updated', guildId, {
    changedBy: 'dashboard',
    before: { ...prev },
    after: { ...config },
    changes: changed,
  });
}

/**
 * DEPFAIL degradation: the guild_config read failed, so message logging silently
 * falls back to disabled. Raise a throttled owner alert (alerts table) and emit
 * a 'message_log.degraded' audit event so the outage is DB-observable instead of
 * invisible.
 */
async function notifyMessageLogDegraded(client: SomniClient, guildId: string, errorMessage: string): Promise<void> {
  const now = Date.now();
  const last = _degradedNotified.get(guildId);
  if (last && now - last < DEGRADED_NOTIFY_TTL) return;
  _degradedNotified.set(guildId, now);

  client.eventBus.emit('message_log.degraded', guildId, {
    error: errorMessage,
    reason: 'config_fetch_failed',
  });

  try {
    await client.supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: 'message_log_degraded',
      severity: 'warning',
      title: 'Message logging degraded',
      message:
        `The message-log config could not be read from the database (${errorMessage}). ` +
        `Edit/delete logging is disabled until the database recovers.`,
      metadata: { error: errorMessage, reason: 'config_fetch_failed' },
    });
  } catch (alertErr) {
    log.error('Failed to write message-log degraded alert:', { error: String(alertErr) });
  }
}

export async function loadConfig(client: SomniClient, guildId: string): Promise<MessageLogConfig> {
  const now = Date.now();
  const cached = _configCache.get(guildId);
  if (cached && now - cached.time < CONFIG_TTL) {
    return cached.config;
  }

  const { data, error } = await client.supabase
    .from('guild_config')
    .select('message_log_enabled, message_log_channel_id, message_log_edits_enabled, message_log_deletes_enabled, message_log_ignored_channel_ids')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    // DEPFAIL: config unknown — surface the degradation, then return safe
    // defaults WITHOUT caching or drift-auditing (we must not treat an unknown
    // config as a real 'changed to disabled' transition).
    await notifyMessageLogDegraded(client, guildId, error.message);
    return {
      message_log_enabled: false,
      message_log_channel_id: null,
      message_log_edits_enabled: true,
      message_log_deletes_enabled: true,
      message_log_ignored_channel_ids: [],
    };
  }

  // Successful read — clear any prior degradation throttle for this guild.
  _degradedNotified.delete(guildId);

  const config: MessageLogConfig = {
    message_log_enabled: data?.message_log_enabled ?? false,
    message_log_channel_id: data?.message_log_channel_id ?? null,
    // Catalog defaults: edits/deletes logged unless the owner opts out; no
    // ignored channels by default.
    message_log_edits_enabled: data?.message_log_edits_enabled ?? true,
    message_log_deletes_enabled: data?.message_log_deletes_enabled ?? true,
    message_log_ignored_channel_ids: Array.isArray(data?.message_log_ignored_channel_ids)
      ? (data.message_log_ignored_channel_ids as string[])
      : [],
  };
  // Emit an audit event when the persisted config actually changed.
  maybeAuditConfigChange(client, guildId, config);
  _configCache.set(guildId, { config, time: now });
  return config;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

// ── Per-event dedupe (in-memory, short TTL) ──────────────────────────────────
// A Discord gateway RESUME can re-deliver a buffered messageUpdate/messageDelete.
// Without a fence the handler posts the embed twice. Track recently-posted event
// keys for a small window so a re-delivery within it is a no-op.
const DEDUPE_TTL_MS = 30_000;
const _sentDedupe = new Map<string, number>();

function alreadyPosted(key: string): boolean {
  const now = Date.now();
  // Lazily prune expired keys (the map only ever holds a ~30s working set).
  for (const [k, expiresAt] of _sentDedupe) {
    if (expiresAt <= now) _sentDedupe.delete(k);
  }
  if (_sentDedupe.has(key)) return true;
  _sentDedupe.set(key, now + DEDUPE_TTL_MS);
  return false;
}

// ── Resilient send (retry + backoff) ─────────────────────────────────────────
// A transient Discord REST fault (429/5xx/network) on a single send would
// otherwise permanently drop the forensic record. Retry a few times with
// exponential backoff; give up immediately on a permanent 4xx (e.g. missing
// permissions) since retrying cannot succeed.
const SEND_RETRY_DELAYS_MS = [250, 500, 1000];

async function sendLogEmbed(logChannel: TextChannel, embed: EmbedBuilder): Promise<boolean> {
  for (let attempt = 0; attempt <= SEND_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await logChannel.send({ embeds: [embed] });
      return true;
    } catch (err) {
      const status = (err as { status?: number } | undefined)?.status;
      // Transient: network error (no status), rate limit (429), or server error (5xx).
      const transient = status === undefined || status === 429 || status >= 500;
      if (!transient || attempt === SEND_RETRY_DELAYS_MS.length) {
        log.error('Failed to post message-log embed:', { error: String(err), status, attempt });
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_DELAYS_MS[attempt]));
    }
  }
  return false;
}

/**
 * Log a message edit to the message log channel.
 */
export async function logMessageEdit(
  client: SomniClient,
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
): Promise<void> {
  // Ignore bot messages, embeds-only changes, and non-guild messages
  if (newMessage.author?.bot) return;
  if (!newMessage.guild) return;
  if (oldMessage.content === newMessage.content) return; // Embed update, not a content edit

  const config = await loadConfig(client, newMessage.guild.id);
  if (!config.message_log_enabled || !config.message_log_channel_id) return;
  // SET-B controls: honor the per-guild edit toggle and ignored-channel list.
  if (!config.message_log_edits_enabled) return;
  if (config.message_log_ignored_channel_ids.includes(newMessage.channel.id)) return;

  const logChannel = newMessage.guild.channels.cache.get(config.message_log_channel_id) as TextChannel | undefined;
  if (!logChannel) return;

  const oldContent = oldMessage.content || '*[Empty or uncached]*';
  const newContent = newMessage.content || '*[Empty]*';

  const embed = new EmbedBuilder()
    .setColor(0xFFA500)
    .setAuthor({
      name: newMessage.author?.tag ?? 'Unknown',
      iconURL: newMessage.author?.displayAvatarURL() ?? undefined,
    })
    .setTitle('✏️ Message Edited')
    .addFields(
      { name: 'Before', value: truncate(oldContent, 1024) },
      { name: 'After', value: truncate(newContent, 1024) },
      { name: 'Channel', value: `<#${newMessage.channel.id}>`, inline: true },
      { name: 'Author', value: `<@${newMessage.author?.id ?? 'unknown'}>`, inline: true },
    )
    .setFooter({ text: `Message ID: ${newMessage.id}` })
    .setTimestamp();

  // Add jump link
  if (newMessage.url) {
    embed.addFields({ name: 'Link', value: `[Jump to message](${newMessage.url})`, inline: true });
  }

  // Skip re-delivered edits (keyed by message id + the edit timestamp).
  if (alreadyPosted(`${newMessage.guild.id}:edit:${newMessage.id}:${newMessage.editedTimestamp ?? ''}`)) return;

  await sendLogEmbed(logChannel, embed);
}

/**
 * Log a message delete to the message log channel.
 */
export async function logMessageDelete(
  client: SomniClient,
  message: Message | PartialMessage,
): Promise<void> {
  // Ignore bot messages and non-guild messages
  if (message.author?.bot) return;
  if (!message.guild) return;

  const config = await loadConfig(client, message.guild.id);
  if (!config.message_log_enabled || !config.message_log_channel_id) return;
  // SET-B controls: honor the per-guild delete toggle and ignored-channel list.
  if (!config.message_log_deletes_enabled) return;
  if (config.message_log_ignored_channel_ids.includes(message.channel.id)) return;

  // Don't log deletions in the log channel itself
  if (message.channel.id === config.message_log_channel_id) return;

  const logChannel = message.guild.channels.cache.get(config.message_log_channel_id) as TextChannel | undefined;
  if (!logChannel) return;

  const content = message.content || '*[Uncached or empty message]*';

  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('🗑️ Message Deleted')
    .addFields(
      { name: 'Content', value: truncate(content, 1024) },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Author', value: message.author ? `<@${message.author.id}>` : 'Unknown (uncached)', inline: true },
    )
    .setFooter({ text: `Message ID: ${message.id}` })
    .setTimestamp();

  // Show attachments if any
  if (message.attachments.size > 0) {
    const attachmentList = message.attachments.map((a) => `[${a.name}](${a.url})`).join('\n');
    embed.addFields({ name: 'Attachments', value: truncate(attachmentList, 1024) });
  }

  // Skip re-delivered deletes (keyed by message id).
  if (alreadyPosted(`${message.guild.id}:delete:${message.id}`)) return;

  await sendLogEmbed(logChannel, embed);
}

/**
 * Invalidate config cache (called from ConfigWatcher).
 */
export function invalidateMessageLogCache(guildId?: string): void {
  if (guildId) {
    // Only clear the TTL cache — keep _lastAuditedConfig so the next reload can
    // diff against the previously-audited config and emit the config-change row.
    _configCache.delete(guildId);
  } else {
    // Full reset (e.g. tests) clears the per-event dedupe set + audit baselines.
    _configCache.clear();
    _sentDedupe.clear();
    _lastAuditedConfig.clear();
    _degradedNotified.clear();
  }
}
