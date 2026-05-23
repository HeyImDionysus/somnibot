/**
 * Level-Up Announcer — posts level-up messages and grants role rewards.
 *
 * Architecture doc §24.5–24.6
 */
import type { Guild, GuildMember, TextChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { loadLevelConfig, loadRewards } from './xp-tracker.js';
import { totalXpForLevel, LEVEL_CONFIG , createLogger } from '@somnibot/shared';

const log = createLogger('LevelAnnouncer');

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

  // Grant role rewards for all levels between oldLevel+1 and newLevel
  for (let lvl = oldLevel + 1; lvl <= newLevel; lvl++) {
    const matchingRewards = rewards.filter((r) => r.level === lvl);
    for (const reward of matchingRewards) {
      try {
        // Grant the new role
        if (!member.roles.cache.has(reward.role_id)) {
          await member.roles.add(reward.role_id, `Level ${lvl} reward`);
          eventBus.emit('role.gained', guild.id, {
            discordId: userId,
            roleId: reward.role_id,
            roleName: guild.roles.cache.get(reward.role_id)?.name ?? reward.role_id,
            source: 'levels',
          });
        }

        // Remove old reward if configured
        if (reward.remove_at_level != null) {
          // Find the reward that this replaces
          const oldReward = rewards.find((r) => r.level < lvl && r.remove_at_level === lvl);
          if (oldReward && member.roles.cache.has(oldReward.role_id)) {
            await member.roles.remove(oldReward.role_id, `Replaced by level ${lvl} reward`);
            eventBus.emit('role.lost', guild.id, {
              discordId: userId,
              roleId: oldReward.role_id,
              roleName: guild.roles.cache.get(oldReward.role_id)?.name ?? oldReward.role_id,
              source: 'levels',
            });
          }
        }
      } catch (err) {
        log.error(`Failed to manage reward role for level ${lvl}:`, err);
      }
    }

    // Also check if any previous reward should be removed at this level
    const toRemove = rewards.filter((r) => r.remove_at_level === lvl);
    for (const r of toRemove) {
      try {
        if (member.roles.cache.has(r.role_id)) {
          await member.roles.remove(r.role_id, `Replaced at level ${lvl}`);
        }
      } catch (err) {
        log.error(`Failed to remove old reward role:`, err);
      }
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
          .replace(/\{nextLevelXp\}/g, String(LEVEL_CONFIG.XP_FORMULA(newLevel)));

        // Check for role reward to add extra flair
        const levelReward = rewards.find((r) => r.level === newLevel);
        let content = message;
        if (levelReward?.announce) {
          const roleName = guild.roles.cache.get(levelReward.role_id)?.name ?? 'Unknown Role';
          content += `\n🏆 Unlocked the **${roleName}** role!`;
        }

        await textChannel.send(content);
      }
    } catch (err) {
      log.error('Failed to send level-up announcement:', { error: String(err) });
    }
  }
}
