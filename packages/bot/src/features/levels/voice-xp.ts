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
import { createLogger } from '@somnibot/shared';

const log = createLogger('VoiceXP');

/**
 * Guild-scoped map of active voice users.
 * Outer key: guildId, inner key: userId.
 *
 * V10 Audit C-1: Previously keyed by userId only, which leaked state
 * across guilds in a multi-guild deployment (guild B's ticker would
 * grant XP to users tracked from guild A).
 */
const activeVoiceUsers = new Map<string, Map<string, { channelId: string; roles: string[] }>>();

/**
 * Track voice state changes to know who is active.
 */
export function onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  const guildId = newState.guild.id;
  const userId = member.id;

  // Left voice entirely or is now muted/deafened or in AFK channel
  if (
    !newState.channelId ||
    newState.selfDeaf ||
    newState.serverDeaf ||
    (newState.guild.afkChannelId && newState.channelId === newState.guild.afkChannelId)
  ) {
    activeVoiceUsers.get(guildId)?.delete(userId);
    return;
  }

  // In a valid voice channel, not deafened
  let guildMap = activeVoiceUsers.get(guildId);
  if (!guildMap) {
    guildMap = new Map();
    activeVoiceUsers.set(guildId, guildMap);
  }
  guildMap.set(userId, {
    channelId: newState.channelId,
    roles: member.roles.cache.map((r) => r.id),
  });
}

/**
 * Start the voice XP ticker. Reads the configured interval from DB
 * at startup and ticks accordingly. Uses the config's
 * `voice_xp_interval_minutes` instead of a hardcoded 5-minute default.
 */
export async function startVoiceXpTicker(
  guild: Guild,
  supabase: SupabaseClient,
  valkey: Valkey,
  eventBus: PlatformEventBus,
): Promise<NodeJS.Timeout> {
  // Read configured interval (falls back to 5 minutes)
  let intervalMs = 5 * 60 * 1000;
  try {
    const config = await loadLevelConfig(supabase, guild.id);
    if (config.voice_xp_interval_minutes && config.voice_xp_interval_minutes > 0) {
      // FIX #14: Clamp to 1440 minutes (24h) to prevent 32-bit integer
      // overflow in setTimeout/setInterval. Values > 35792 minutes overflow
      // Node's 2^31-1 ms limit, causing immediate/negative-delay execution.
      const clampedMinutes = Math.min(config.voice_xp_interval_minutes, 1440);
      intervalMs = clampedMinutes * 60 * 1000;
    }
  } catch { /* use default */ }

  log.info(`Starting ticker (${intervalMs / 60_000}m interval)`);

  const tickInterval = setInterval(async () => {
    try {
      const config = await loadLevelConfig(supabase, guild.id);
      if (!config.levels_enabled || !config.voice_xp_enabled) return;
      const guildUsers = activeVoiceUsers.get(guild.id);
      if (!guildUsers || guildUsers.size === 0) return;

      const xpAmount = config.voice_xp_per_interval;

      for (const [userId, info] of guildUsers) {
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
          log.error(`Error granting XP to ${userId}:`, err);
        }
      }
    } catch (err) {
      log.error('Tick error:', { error: String(err) });
    }
  }, intervalMs);

  return tickInterval;
}

/**
 * Initialize voice state tracking — populate activeVoiceUsers from current state.
 */
export async function initVoiceTracking(guild: Guild): Promise<void> {
  const guildMap = new Map<string, { channelId: string; roles: string[] }>();

  for (const [, state] of guild.voiceStates.cache) {
    if (!state.member || state.member.user.bot) continue;
    if (!state.channelId) continue;
    if (state.selfDeaf || state.serverDeaf) continue;
    if (guild.afkChannelId && state.channelId === guild.afkChannelId) continue;

    guildMap.set(state.member.id, {
      channelId: state.channelId,
      roles: state.member.roles.cache.map((r) => r.id),
    });
  }

  activeVoiceUsers.set(guild.id, guildMap);
  log.info(`Initialized with ${guildMap.size} active voice users`);
}
