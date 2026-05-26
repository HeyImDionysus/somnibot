/**
 * Anti-Raid Protection — Detects join floods and takes automatic action.
 *
 * V17 Behavioral Audit — Item 4
 * V5 Audit Remediation — Moved state from module-level arrays to Valkey.
 *   Per-guild state via sorted sets + keys. Shard-safe.
 *
 * Tracks join rate in a sliding window. When the threshold is exceeded:
 *  - "kick" mode: auto-kicks new members below account-age threshold
 *  - "ban" mode: auto-bans new members below account-age threshold
 *  - "lockdown" mode: pauses invites and enables verification level
 *
 * Also filters joins by minimum account age regardless of raid status.
 */

import {
  type Guild,
  type GuildMember,
  EmbedBuilder,
  type TextChannel,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import { getValkey } from '../../services/valkey.js';

const log = createLogger('AntiRaid');

interface AntiRaidConfig {
  anti_raid_enabled: boolean;
  anti_raid_join_threshold: number;
  anti_raid_join_window_seconds: number;
  anti_raid_account_age_days: number;
  anti_raid_action: 'kick' | 'ban' | 'lockdown';
  anti_raid_ban_delete_seconds: number;
  anti_raid_log_channel_id: string | null;
  mod_log_channel_id: string | null;
}

const CONFIG_TTL = 60_000;
// V5 Audit §6.4 — Per-guild config cache instead of global singleton
const _configCache = new Map<string, { config: AntiRaidConfig; time: number }>();

const RAID_MODE_COOLDOWN = 5 * 60_000; // Auto-deactivate after 5 minutes

// ── V5 Audit §14.6 — In-memory fallback when Valkey is unavailable ──
// Prevents anti-raid from silently failing if Valkey goes down.
const _memoryJoinWindows = new Map<string, number[]>();
const _memoryRaidMode = new Map<string, number>();

// Valkey key helpers
function joinWindowKey(guildId: string): string {
  return `antiraid:joins:${guildId}`;
}
function raidModeKey(guildId: string): string {
  return `antiraid:raidmode:${guildId}`;
}

async function loadConfig(supabase: SupabaseClient, guildId: string): Promise<AntiRaidConfig> {
  const now = Date.now();
  const cached = _configCache.get(guildId);
  if (cached && now - cached.time < CONFIG_TTL) {
    return cached.config;
  }

  const { data } = await supabase
    .from('guild_config')
    .select(
      'anti_raid_enabled, anti_raid_join_threshold, anti_raid_join_window_seconds, anti_raid_account_age_days, anti_raid_action, anti_raid_ban_delete_seconds, anti_raid_log_channel_id, mod_log_channel_id',
    )
    .eq('guild_id', guildId)
    .maybeSingle();

  const config: AntiRaidConfig = {
    anti_raid_enabled: data?.anti_raid_enabled ?? false,
    anti_raid_join_threshold: data?.anti_raid_join_threshold ?? 10,
    anti_raid_join_window_seconds: data?.anti_raid_join_window_seconds ?? 10,
    anti_raid_account_age_days: data?.anti_raid_account_age_days ?? 7,
    anti_raid_action: data?.anti_raid_action ?? 'kick',
    anti_raid_ban_delete_seconds: data?.anti_raid_ban_delete_seconds ?? 86400,
    anti_raid_log_channel_id: data?.anti_raid_log_channel_id ?? null,
    mod_log_channel_id: data?.mod_log_channel_id ?? null,
  };
  _configCache.set(guildId, { config, time: now });
  return config;
}

function getAccountAgeDays(member: GuildMember): number {
  const createdAt = member.user.createdTimestamp;
  return (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
}

async function logRaidEvent(
  guild: Guild,
  config: AntiRaidConfig,
  embed: EmbedBuilder,
): Promise<void> {
  const channelId = config.anti_raid_log_channel_id || config.mod_log_channel_id;
  if (!channelId) return;

  const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) return;

  try {
    await channel.send({ embeds: [embed] });
  } catch {
    // Channel may be inaccessible
  }
}

/**
 * Record a join in the Valkey sliding window and return the count.
 * V5 Audit §14.6 — Falls back to in-memory tracking if Valkey is unavailable.
 */
async function recordJoinAndCount(guildId: string, windowMs: number): Promise<number> {
  try {
    const valkey = getValkey();
    const key = joinWindowKey(guildId);
    const now = Date.now();
    const windowStart = now - windowMs;

    // Atomic pipeline: remove expired entries, add current, count, set expiry
    const pipeline = valkey.pipeline();
    pipeline.zremrangebyscore(key, '-inf', String(windowStart));
    pipeline.zadd(key, String(now), `${now}:${Math.random().toString(36).slice(2, 8)}`);
    pipeline.zcard(key);
    pipeline.pexpire(key, windowMs + 10_000); // TTL slightly longer than window
    const results = await pipeline.exec();

    // zcard result is at index 2
    const count = (results?.[2]?.[1] as number) ?? 0;
    return count;
  } catch (err) {
    // Valkey unavailable — fall back to in-memory tracking
    log.warn(`Valkey unavailable for anti-raid, using in-memory fallback: ${err}`);
    const now = Date.now();
    const windowStart = now - windowMs;
    const joins = _memoryJoinWindows.get(guildId) ?? [];
    const filtered = joins.filter((t) => t > windowStart);
    filtered.push(now);
    // Cap in-memory array to prevent unbounded growth
    if (filtered.length > 500) filtered.splice(0, filtered.length - 500);
    _memoryJoinWindows.set(guildId, filtered);
    return filtered.length;
  }
}

/**
 * Check if raid mode is active for a guild.
 * V5 Audit §14.6 — Falls back to in-memory state if Valkey is unavailable.
 */
async function isRaidModeActive(guildId: string): Promise<boolean> {
  try {
    const valkey = getValkey();
    const val = await valkey.get(raidModeKey(guildId));
    return val !== null;
  } catch {
    // Valkey unavailable — check in-memory state
    const activated = _memoryRaidMode.get(guildId);
    if (!activated) return false;
    return Date.now() - activated < RAID_MODE_COOLDOWN;
  }
}

/**
 * Activate raid mode for a guild (with auto-expiry).
 * V5 Audit §14.6 — Falls back to in-memory state if Valkey is unavailable.
 */
async function activateRaidMode(guildId: string): Promise<void> {
  try {
    const valkey = getValkey();
    await valkey.set(raidModeKey(guildId), String(Date.now()), 'PX', RAID_MODE_COOLDOWN);
  } catch {
    // Valkey unavailable — store in memory
    _memoryRaidMode.set(guildId, Date.now());
    log.warn(`Valkey unavailable — raid mode for ${guildId} stored in-memory only`);
  }
}

/**
 * Process a member join through anti-raid checks.
 * Returns true if the member was auto-actioned (kicked/banned).
 */
export async function processAntiRaid(
  guild: Guild,
  member: GuildMember,
  supabase: SupabaseClient,
): Promise<boolean> {
  const config = await loadConfig(supabase, guild.id);
  if (!config.anti_raid_enabled) return false;

  // 1. Account age check — always active when anti-raid is enabled
  const accountAgeDays = getAccountAgeDays(member);
  if (accountAgeDays < config.anti_raid_account_age_days) {
    try {
      await member.send({
        content: `⚠️ Your account is too new to join **${guild.name}**. Accounts must be at least ${config.anti_raid_account_age_days} day(s) old. Please try again later.`,
      }).catch((e: unknown) => { log.warn('Action failed:', (e as Error)?.message ?? e); });

      await member.kick(`Anti-raid: Account age ${Math.floor(accountAgeDays)}d < ${config.anti_raid_account_age_days}d minimum`);

      const embed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('🛡️ Anti-Raid: Young Account Blocked')
        .setDescription(`<@${member.id}> (${member.user.tag}) was kicked — account is ${Math.floor(accountAgeDays)} day(s) old (minimum: ${config.anti_raid_account_age_days}).`)
        .setTimestamp();

      await logRaidEvent(guild, config, embed);
      return true;
    } catch (err) {
      log.error('Failed to kick young account:', { error: String(err) });
    }
  }

  // 2. Join flood detection (Valkey-backed sliding window)
  const windowMs = config.anti_raid_join_window_seconds * 1000;
  const joinCount = await recordJoinAndCount(guild.id, windowMs);

  // Check raid mode state
  const raidActive = await isRaidModeActive(guild.id);

  // V6 Audit §8.6: Restore verification level when raid mode expires
  if (!raidActive && config.anti_raid_action === 'lockdown') {
    try {
      const valkey = getValkey();
      const prevLevelKey = `antiraid:prevlevel:${guild.id}`;
      const prevLevel = await valkey.get(prevLevelKey).catch(() => null);
      if (prevLevel !== null) {
        const level = parseInt(prevLevel, 10);
        if (!isNaN(level) && guild.verificationLevel !== level) {
          await guild.setVerificationLevel(level, 'Anti-raid lockdown ended: restoring verification level');
          log.info(`Lockdown ended: restored verification to ${level} for guild ${guild.id}`);
        }
        await valkey.del(prevLevelKey).catch(() => {});
      }
    } catch {
      // Best-effort restore
    }
  }

  // Check if threshold exceeded — activate raid mode
  if (joinCount >= config.anti_raid_join_threshold && !raidActive) {
    await activateRaidMode(guild.id);

    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚨 RAID DETECTED')
      .setDescription(
        `**${joinCount} joins** in the last ${config.anti_raid_join_window_seconds}s (threshold: ${config.anti_raid_join_threshold}).\n\n` +
        `Action: **${config.anti_raid_action}** • Raid mode will auto-deactivate after 5 minutes of calm.`,
      )
      .setTimestamp();

    await logRaidEvent(guild, config, embed);
  }

  // 3. If raid mode is active, take action on this member
  const shouldAct = raidActive || joinCount >= config.anti_raid_join_threshold;
  if (shouldAct) {
    try {
      const action = config.anti_raid_action;

      if (action === 'kick' || action === 'ban') {
        await member.send({
          content: `⚠️ **${guild.name}** is currently experiencing a raid. Your join has been temporarily blocked. Please try again later.`,
        }).catch((e: unknown) => { log.warn('Action failed:', (e as Error)?.message ?? e); });

        if (action === 'ban') {
          await member.ban({ reason: 'Anti-raid: Join flood detected', deleteMessageSeconds: config.anti_raid_ban_delete_seconds });
        } else {
          await member.kick('Anti-raid: Join flood detected');
        }

        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle(`🛡️ Anti-Raid: Member ${action === 'ban' ? 'Banned' : 'Kicked'}`)
          .setDescription(`<@${member.id}> (${member.user.tag}) was ${action}ed during active raid mode.`)
          .setTimestamp();

        await logRaidEvent(guild, config, embed);
        return true;
      }

      if (action === 'lockdown') {
        // V6 Audit §8.6: Implement real lockdown — raise verification level
        try {
          const valkey = getValkey();
          const prevLevelKey = `antiraid:prevlevel:${guild.id}`;

          // Store the current verification level so we can restore it later
          const alreadyStored = await valkey.get(prevLevelKey).catch(() => null);
          if (!alreadyStored) {
            await valkey.set(prevLevelKey, String(guild.verificationLevel), 'PX', RAID_MODE_COOLDOWN + 60_000);
          }

          // Raise to VERY_HIGH (requires phone verification)
          if (guild.verificationLevel < 4) {
            await guild.setVerificationLevel(4, 'Anti-raid lockdown: join flood detected');
            log.info(`Lockdown: raised verification to VERY_HIGH for guild ${guild.id}`);
          }

          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🔒 Anti-Raid: Lockdown Activated')
            .setDescription(
              `Server verification level raised to **Very High** (phone verification required).\n` +
              `Will auto-restore when raid mode expires.`,
            )
            .setTimestamp();

          await logRaidEvent(guild, config, embed);
        } catch (err) {
          log.error('Failed to activate lockdown:', { error: String(err) });
        }
      }
    } catch (err) {
      log.error(`Failed to ${config.anti_raid_action} during raid:`, err);
    }
  }

  return false;
}

/**
 * Invalidate config cache (called from ConfigWatcher).
 */
export function invalidateAntiRaidCache(guildId?: string): void {
  if (guildId) {
    _configCache.delete(guildId);
  } else {
    _configCache.clear();
  }
}
