/**
 * Starboard — Highlights popular messages that receive enough star reactions.
 *
 * V17 Behavioral Audit — Item 7
 *
 * When a message receives N reactions of the configured emoji (default ⭐),
 * it gets cross-posted to the starboard channel with an embed.
 * Subsequent reactions update the count on the starboard message.
 */

import {
  EmbedBuilder,
  type Guild,
  type MessageReaction,
  type TextChannel,
  type User,
  type PartialMessageReaction,
  type PartialUser,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Starboard');

interface StarboardConfig {
  starboard_enabled: boolean;
  starboard_channel_id: string | null;
  starboard_threshold: number;
  starboard_emoji: string;
  starboard_self_star: boolean;
}

const CONFIG_TTL = 60_000;
// Per-guild cache: a single-process bot serves many guilds, so the cache MUST be
// keyed by guildId. A module-global entry let the first guild's starboard config
// (channel, threshold, emoji, enabled, self-star) serve every other guild for the
// whole TTL — cross-guild config bleed.
const _configCache = new Map<string, { config: StarboardConfig; time: number }>();

export async function loadConfig(supabase: SupabaseClient, guildId: string): Promise<StarboardConfig> {
  const now = Date.now();
  const cached = _configCache.get(guildId);
  if (cached && now - cached.time < CONFIG_TTL) {
    return cached.config;
  }

  const { data } = await supabase
    .from('guild_config')
    .select('starboard_enabled, starboard_channel_id, starboard_threshold, starboard_emoji, starboard_self_star')
    .eq('guild_id', guildId)
    .maybeSingle();

  const config: StarboardConfig = {
    starboard_enabled: data?.starboard_enabled ?? false,
    starboard_channel_id: data?.starboard_channel_id ?? null,
    starboard_threshold: data?.starboard_threshold ?? 3,
    starboard_emoji: data?.starboard_emoji ?? '⭐',
    starboard_self_star: data?.starboard_self_star ?? false,
  };
  _configCache.set(guildId, { config, time: now });
  return config;
}

/**
 * Handle a reaction add event for starboard tracking.
 */
export async function handleStarboardReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  // Ensure full reaction and message data
  if (reaction.partial) {
    try {
      reaction = await reaction.fetch();
    } catch {
      return;
    }
  }

  const message = reaction.message;
  if (message.partial) {
    try {
      await message.fetch();
    } catch {
      return;
    }
  }

  if (!message.guild || message.guild.id !== guildId) return;

  const config = await loadConfig(supabase, guildId);
  if (!config.starboard_enabled || !config.starboard_channel_id) return;

  // Check if this is the starboard emoji
  const emojiMatch =
    reaction.emoji.name === config.starboard_emoji ||
    reaction.emoji.toString() === config.starboard_emoji;
  if (!emojiMatch) return;

  // Don't star messages in the starboard channel itself
  if (message.channel.id === config.starboard_channel_id) return;

  // Count reactions (excluding self-stars if disabled)
  let starCount = reaction.count ?? 0;
  if (!config.starboard_self_star && message.author) {
    // Check if the author reacted
    const users = await reaction.users.fetch().catch(() => null);
    if (users?.has(message.author.id)) {
      starCount--;
    }
  }

  if (starCount < config.starboard_threshold) return;

  const guild = message.guild as Guild;
  const starboardChannel = guild.channels.cache.get(config.starboard_channel_id) as TextChannel | undefined;
  if (!starboardChannel) return;

  // Check if we already have a starboard entry
  const { data: existing } = await supabase
    .from('starboard_entries')
    .select('id, starboard_message_id, star_count')
    .eq('guild_id', guildId)
    .eq('source_message_id', message.id)
    .maybeSingle();

  const embed = new EmbedBuilder()
    .setColor(0xFFAC33)
    .setAuthor({
      name: message.author?.tag ?? 'Unknown',
      iconURL: message.author?.displayAvatarURL() ?? undefined,
    })
    .setDescription(message.content || '*[No text content]*')
    .addFields(
      { name: 'Source', value: `[Jump to message](${message.url})`, inline: true },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
    )
    .setTimestamp(message.createdAt);

  // Add first image attachment if present
  const imageAttachment = message.attachments.find((a) =>
    a.contentType?.startsWith('image/'),
  );
  if (imageAttachment) {
    embed.setImage(imageAttachment.url);
  }

  const headerText = `${config.starboard_emoji} **${starCount}** | <#${message.channel.id}>`;

  if (existing?.starboard_message_id) {
    // Update existing starboard message
    try {
      const sbMsg = await starboardChannel.messages.fetch(existing.starboard_message_id);
      await sbMsg.edit({ content: headerText, embeds: [embed] });
    } catch {
      // Message may have been deleted — create a new one below
    }

    await supabase
      .from('starboard_entries')
      .update({ star_count: starCount, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
  } else {
    // Create new starboard message
    try {
      const sbMsg = await starboardChannel.send({ content: headerText, embeds: [embed] });

      if (existing) {
        await supabase
          .from('starboard_entries')
          .update({
            starboard_message_id: sbMsg.id,
            star_count: starCount,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        await supabase.from('starboard_entries').insert({
          guild_id: guildId,
          source_channel_id: message.channel.id,
          source_message_id: message.id,
          starboard_message_id: sbMsg.id,
          star_count: starCount,
          author_id: message.author?.id ?? 'unknown',
        });
      }
    } catch (err) {
      log.error('Failed to post to starboard channel:', { error: String(err) });
    }
  }
}

/**
 * Invalidate config cache (called from ConfigWatcher).
 */
export function invalidateStarboardCache(guildId?: string): void {
  if (guildId) _configCache.delete(guildId);
  else _configCache.clear();
}
