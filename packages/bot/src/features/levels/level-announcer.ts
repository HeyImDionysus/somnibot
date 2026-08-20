/**
 * Level-Up Announcer — posts level-up messages and grants role rewards.
 *
 * Architecture doc §24.5–24.6
 */
import type { Guild, TextChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { loadLevelConfig, loadRewards } from './xp-tracker.js';
import { DEFAULT_LEVEL_CURVE, createLogger } from '@somnibot/shared';

const log = createLogger('LevelAnnouncer');

type RewardDeliveryResult = {
  outcome: 'applied' | 'replayed';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function applyRewardDelivery(
  supabase: SupabaseClient,
  guildId: string,
  memberId: string,
  rewardId: string,
  deliveryKind: 'award' | 'expiry',
  reachedLevel: number,
): Promise<RewardDeliveryResult | null> {
  const { data, error } = await supabase.rpc('apply_level_reward_delivery', {
    p_guild_id: guildId,
    p_member_id: memberId,
    p_reward_id: rewardId,
    p_delivery_kind: deliveryKind,
    p_reached_level: reachedLevel,
  });
  if (error) {
    log.error('Failed to apply level reward delivery', {
      guildId,
      memberId,
      rewardId,
      deliveryKind,
      detail: error.message,
    });
    return null;
  }
  if (!isRecord(data) || (data.outcome !== 'applied' && data.outcome !== 'replayed')) {
    log.error('Level reward delivery returned malformed readback', {
      guildId,
      memberId,
      rewardId,
      deliveryKind,
    });
    return null;
  }
  return { outcome: data.outcome };
}

/**
 * Handle a level-up event: announcements + role rewards.
 */
export async function handleLevelUp(
  guild: Guild,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
  userId: string,
  oldLevel: number,
  newLevel: number,
  totalXp: number,
): Promise<void> {
  const config = await loadLevelConfig(supabase, guild.id);
  const rewards = await loadRewards(supabase, guild.id);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const unlocked: string[] = [];

  for (let lvl = oldLevel + 1; lvl <= newLevel; lvl++) {
    const matchingRewards = rewards.filter((r) => r.level === lvl);
    for (const reward of matchingRewards) {
      if (
        reward.reward_type === 'role'
        && reward.remove_at_level !== null
        && reward.remove_at_level > oldLevel
        && reward.remove_at_level <= newLevel
      ) continue;
      const delivery = await applyRewardDelivery(
        supabase,
        guild.id,
        userId,
        reward.id,
        'award',
        newLevel,
      );
      if (delivery && reward.announce) {
        if (reward.reward_type === 'role' && reward.role_id) {
          const roleName = guild.roles.cache.get(reward.role_id)?.name ?? reward.role_id;
          unlocked.push(`🏆 Unlocked the **${roleName}** role`);
        } else if (reward.reward_type === 'currency' && reward.currency_amount) {
          unlocked.push(
            `${config.currency_emoji} Received **${reward.currency_amount.toLocaleString()} ${config.currency_name}**`,
          );
        } else if (reward.reward_type === 'item' && reward.item_quantity) {
          const itemName = reward.economy_items?.name ?? 'inventory item';
          const itemEmoji = reward.economy_items?.emoji ?? '📦';
          unlocked.push(`${itemEmoji} Received **${reward.item_quantity}× ${itemName}**`);
        }
      }
    }

    const expiringRewards = rewards.filter(
      (reward) => reward.reward_type === 'role' && reward.remove_at_level === lvl,
    );
    for (const reward of expiringRewards) {
      await applyRewardDelivery(supabase, guild.id, userId, reward.id, 'expiry', newLevel);
    }
  }

  // Emit level.up event
  eventBus.emit('level.up', guild.id, {
    discordId: userId,
    previousLevel: oldLevel,
    newLevel,
    totalXp,
  });

  // Send level-up announcement
  if (config.level_up_channel_id) {
    try {
      const channel = guild.channels.cache.get(config.level_up_channel_id);
      if (channel && channel.type === ChannelType.GuildText) {
        const textChannel = channel as TextChannel;
        const message = (config.level_up_message ?? '🎉 {user} just reached **Level {level}**!')
          .replace(/\{user\}/g, `<@${userId}>`)
          .replace(/\{level\}/g, String(newLevel))
          .replace(/\{totalXp\}/g, String(totalXp))
          .replace(/\{nextLevelXp\}/g, String(Math.round((config.level_curve ?? DEFAULT_LEVEL_CURVE).base * Math.pow(newLevel + 1, (config.level_curve ?? DEFAULT_LEVEL_CURVE).exponent))));

        let content = message;
        if (unlocked.length > 0) {
          content += `\n${unlocked.join('\n')}`;
        }

        await textChannel.send(content);
      }
    } catch (err) {
      log.error('Failed to send level-up announcement:', { error: String(err) });
    }
  }
}
