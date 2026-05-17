/**
 * Voice XP Tracker — grants XP for time spent in voice channels.
 *
 * Architecture doc §24.2 (Voice XP)
 *
 * Uses a Map to track who is in voice. A cron ticks every N minutes
 * and awards XP to active voice users.
 */
import type { Guild, VoiceState } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { loadLevelConfig, grantVoiceXp } from './xp-tracker.js';
import { handleLevelUp } from './level-announcer.js';

/** Set of user IDs currently in non-AFK voice channels and not deafened/muted */
const activeVoiceUsers = new Map<string, { channelId: string; roles: string[] }>();

/**
 * Track voice state changes to know who is active.
 */
export function onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  const userId = member.id;

  // Left voice entirely or is now muted/deafened or in AFK channel
  if (
    !newState.channelId ||
    newState.selfDeaf ||
    newState.serverDeaf ||
    (newState.guild.afkChannelId && newState.channelId === newState.guild.afkChannelId)
  ) {
    activeVoiceUsers.delete(userId);
    return;
  }

  // In a valid voice channel, not deafened
  activeVoiceUsers.set(userId, {
    channelId: newState.channelId,
    roles: member.roles.cache.map((r) => r.id),
  });
}

/**
 * Start the voice XP ticker. Runs every `interval` minutes.
 */
export function startVoiceXpTicker(
  guild: Guild,
  supabase: SupabaseClient,
  valkey: Valkey,
  eventBus: PlatformEventBus,
): NodeJS.Timeout {
  // Default 5 minutes, but we check config each tick
  const tickInterval = setInterval(async () => {
    try {
      const config = await loadLevelConfig(supabase, guild.id);
      if (!config.levels_enabled || !config.voice_xp_enabled) return;
      if (activeVoiceUsers.size === 0) return;

      const xpAmount = config.voice_xp_per_interval;

      for (const [userId, info] of activeVoiceUsers) {
        try {
          const result = await grantVoiceXp(
            supabase,
            valkey,
            guild.id,
            userId,
            info.roles,
            xpAmount,
          );

          if (result.leveledUp && result.newLevel != null && result.oldLevel != null && result.newXp != null) {
            await handleLevelUp(
              guild,
              supabase,
              eventBus,
              userId,
              result.oldLevel,
              result.newLevel,
              result.newXp,
            );
          }
        } catch (err) {
          console.error(`[VoiceXP] Error granting XP to ${userId}:`, err);
        }
      }
    } catch (err) {
      console.error('[VoiceXP] Tick error:', err);
    }
  }, 5 * 60 * 1000); // Check every 5 minutes

  return tickInterval;
}

/**
 * Initialize voice state tracking — populate activeVoiceUsers from current state.
 */
export async function initVoiceTracking(guild: Guild): Promise<void> {
  for (const [, state] of guild.voiceStates.cache) {
    if (!state.member || state.member.user.bot) continue;
    if (!state.channelId) continue;
    if (state.selfDeaf || state.serverDeaf) continue;
    if (guild.afkChannelId && state.channelId === guild.afkChannelId) continue;

    activeVoiceUsers.set(state.member.id, {
      channelId: state.channelId,
      roles: state.member.roles.cache.map((r) => r.id),
    });
  }

  console.log(`[VoiceXP] Initialized with ${activeVoiceUsers.size} active voice users`);
}
