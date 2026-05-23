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
}

const CONFIG_TTL = 60_000;
let _configCache: MessageLogConfig | null = null;
let _configCacheTime = 0;

async function loadConfig(client: SomniClient, guildId: string): Promise<MessageLogConfig> {
  const now = Date.now();
  if (_configCache && now - _configCacheTime < CONFIG_TTL) {
    return _configCache;
  }

  const { data } = await client.supabase
    .from('guild_config')
    .select('message_log_enabled, message_log_channel_id')
    .eq('guild_id', guildId)
    .maybeSingle();

  _configCache = {
    message_log_enabled: data?.message_log_enabled ?? false,
    message_log_channel_id: data?.message_log_channel_id ?? null,
  };
  _configCacheTime = now;
  return _configCache;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
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

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    log.error('Failed to log edit:', { error: String(err) });
  }
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

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    log.error('Failed to log delete:', { error: String(err) });
  }
}

/**
 * Invalidate config cache (called from ConfigWatcher).
 */
export function invalidateMessageLogCache(): void {
  _configCache = null;
}
