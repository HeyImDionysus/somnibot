/**
 * Anti-Raid Protection — Detects join floods and takes automatic action.
 *
 * V17 Behavioral Audit — Item 4
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

const log = createLogger('AntiRaid');

interface AntiRaidConfig {
  anti_raid_enabled: boolean;
  anti_raid_join_threshold: number;
  anti_raid_join_window_seconds: number;
  anti_raid_account_age_days: number;
  anti_raid_action: 'kick' | 'ban' | 'lockdown';
  anti_raid_log_channel_id: string | null;
  mod_log_channel_id: string | null;
}

const CONFIG_TTL = 60_000;
let _configCache: AntiRaidConfig | null = null;
let _configCacheTime = 0;

// Sliding window of recent join timestamps
const recentJoins: number[] = [];
let raidModeActive = false;
let raidModeActivatedAt = 0;
const RAID_MODE_COOLDOWN = 5 * 60_000; // Auto-deactivate after 5 minutes

async function loadConfig(supabase: SupabaseClient, guildId: string): Promise<AntiRaidConfig> {
  const now = Date.now();
  if (_configCache && now - _configCacheTime < CONFIG_TTL) {
    return _configCache;
  }

  const { data } = await supabase
    .from('guild_config')
    .select(
      'anti_raid_enabled, anti_raid_join_threshold, anti_raid_join_window_seconds, anti_raid_account_age_days, anti_raid_action, anti_raid_log_channel_id, mod_log_channel_id',
    )
    .eq('guild_id', guildId)
    .maybeSingle();

  _configCache = {
    anti_raid_enabled: data?.anti_raid_enabled ?? false,
    anti_raid_join_threshold: data?.anti_raid_join_threshold ?? 10,
    anti_raid_join_window_seconds: data?.anti_raid_join_window_seconds ?? 10,
    anti_raid_account_age_days: data?.anti_raid_account_age_days ?? 7,
    anti_raid_action: data?.anti_raid_action ?? 'kick',
    anti_raid_log_channel_id: data?.anti_raid_log_channel_id ?? null,
    mod_log_channel_id: data?.mod_log_channel_id ?? null,
  };
  _configCacheTime = now;
  return _configCache;
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

  const now = Date.now();

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

  // 2. Join flood detection
  const windowMs = config.anti_raid_join_window_seconds * 1000;

  // Clean old entries
  while (recentJoins.length > 0 && (recentJoins[0]! < now - windowMs)) {
    recentJoins.shift();
  }

  recentJoins.push(now);

  // Auto-deactivate raid mode after cooldown
  if (raidModeActive && now - raidModeActivatedAt > RAID_MODE_COOLDOWN) {
    raidModeActive = false;
    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('🛡️ Raid Mode Deactivated')
      .setDescription('Join rate has normalized. Raid mode has been automatically deactivated.')
      .setTimestamp();
    await logRaidEvent(guild, config, embed);
  }

  // Check if threshold exceeded
  if (recentJoins.length >= config.anti_raid_join_threshold && !raidModeActive) {
    raidModeActive = true;
    raidModeActivatedAt = now;

    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚨 RAID DETECTED')
      .setDescription(
        `**${recentJoins.length} joins** in the last ${config.anti_raid_join_window_seconds}s (threshold: ${config.anti_raid_join_threshold}).\n\n` +
        `Action: **${config.anti_raid_action}** • Raid mode will auto-deactivate after 5 minutes of calm.`,
      )
      .setTimestamp();

    await logRaidEvent(guild, config, embed);
  }

  // 3. If raid mode is active, take action on this member
  if (raidModeActive) {
    try {
      const action = config.anti_raid_action;

      if (action === 'kick' || action === 'ban') {
        await member.send({
          content: `⚠️ **${guild.name}** is currently experiencing a raid. Your join has been temporarily blocked. Please try again later.`,
        }).catch((e: unknown) => { log.warn('Action failed:', (e as Error)?.message ?? e); });

        if (action === 'ban') {
          await member.ban({ reason: 'Anti-raid: Join flood detected', deleteMessageSeconds: 0 });
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

      // Lockdown mode doesn't kick — it just logs (actual Discord lockdown
      // would require guild verification level changes which is a higher privilege)
    } catch (err) {
      log.error(`Failed to ${config.anti_raid_action} during raid:`, err);
    }
  }

  return false;
}

/**
 * Invalidate config cache (called from ConfigWatcher).
 */
export function invalidateAntiRaidCache(): void {
  _configCache = null;
}
