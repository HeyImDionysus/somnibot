/**
 * Anti-Raid Protection — Detects join floods and takes automatic action.
 *
 * V17 Behavioral Audit — Item 4
 * V5 Audit Remediation — Moved state from module-level arrays to Valkey.
 *   Per-guild state via sorted sets + keys. Shard-safe.
 *
 * Tracks join rate in a sliding window. When the threshold is exceeded:
 *  - "kick" mode: auto-kicks new members below account-age threshold
 *  - "ban" mode: auto-bans new members (auto-unban on cooldown is toggleable)
 *  - "lockdown" mode: pauses invites (stored for restore) and raises verification
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
import { randomUUID } from 'node:crypto';
import { getValkey } from '../../services/valkey.js';

const log = createLogger('AntiRaid');

interface AntiRaidConfig {
  anti_raid_enabled: boolean;
  anti_raid_join_threshold: number;
  anti_raid_join_window_seconds: number;
  anti_raid_account_age_days: number;
  anti_raid_action: 'kick' | 'ban' | 'lockdown';
  anti_raid_auto_unban: boolean;
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



/**
 * V7 Audit §8.P3a — Maximum guilds tracked in memory fallback Maps.
 * In a sharded bot, each shard handles ~2500 guilds max. 10,000 provides
 * ample headroom without unbounded growth risk.
 */
const MAX_MEMORY_GUILDS = 10_000;

/** Evict oldest entry from a Map if it exceeds the cap. */
function capMap<V>(map: Map<string, V>, max: number): void {
  /* v8 ignore next 4 -- defensive cap; only fires at 10k+ guilds in memory */
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
}

// Valkey key helpers
function joinWindowKey(guildId: string): string {
  return `antiraid:joins:${guildId}`;
}
function raidModeKey(guildId: string): string {
  return `antiraid:raidmode:${guildId}`;
}
/** V5 Audit §8.2: Track raid-banned user IDs for auto-unban on cooldown. */
function raidBannedKey(guildId: string): string {
  return `antiraid:banned:${guildId}`;
}
/** Store invite metadata during lockdown so invites can be recreated on restore. */
function storedInvitesKey(guildId: string): string {
  return `antiraid:invites:${guildId}`;
}

interface StoredInvite {
  channelId: string;
  maxAge: number;
  maxUses: number;
  temporary: boolean;
}

// In-memory fallback for raid-banned tracking
const _memoryRaidBanned = new Map<string, Set<string>>();

/**
 * Periodically purge stale guilds from memory fallback Maps.
 * Without this, guilds that joined once and never again hold entries forever.
 * Runs every 5 minutes. Removes guilds whose join window data is entirely expired
 * and whose raid mode has cooled down.
 *
 * V10 Audit §1: Lifecycle-managed via start/stop so the interval can be
 * cleaned up during guild context destruction and in tests.
 */
const MEMORY_PRUNE_INTERVAL = 5 * 60_000;
let _pruneInterval: ReturnType<typeof setInterval> | null = null;

function pruneStaleMemoryEntries(): void {
  const now = Date.now();
  // Prune join windows: remove guilds with no timestamps in the last 10 minutes
  // (any reasonable window is < 60s, so 10min is extremely conservative)
  const staleThreshold = now - 10 * 60_000;
  for (const [guildId, timestamps] of _memoryJoinWindows) {
    const newest = timestamps.length > 0 ? timestamps[timestamps.length - 1] : 0;
    if (newest < staleThreshold) _memoryJoinWindows.delete(guildId);
  }
  // Prune raid mode: remove guilds past cooldown
  for (const [guildId, activated] of _memoryRaidMode) {
    if (now - activated >= RAID_MODE_COOLDOWN) _memoryRaidMode.delete(guildId);
  }
  // Prune raid banned: remove guilds past cooldown + 60s (matches Valkey TTL)
  for (const [guildId] of _memoryRaidBanned) {
    const raidActivated = _memoryRaidMode.get(guildId);
    if (!raidActivated || now - raidActivated >= RAID_MODE_COOLDOWN + 60_000) {
      _memoryRaidBanned.delete(guildId);
    }
  }
}

/** Start the periodic memory pruner. Idempotent — safe to call multiple times. */
export function startAntiRaidPruner(): void {
  if (_pruneInterval) return;
  _pruneInterval = setInterval(pruneStaleMemoryEntries, MEMORY_PRUNE_INTERVAL);
  _pruneInterval.unref();
}

/** Stop the periodic memory pruner. Idempotent. */
export function stopAntiRaidPruner(): void {
  if (_pruneInterval) {
    clearInterval(_pruneInterval);
    _pruneInterval = null;
  }
}

/**
 * V11 Audit M-3: Clear all in-memory state for a specific guild.
 * Called from destroyGuildServices() when a guild context is evicted
 * to prevent unbounded growth of memory Maps over the bot's lifetime.
 */
export function clearAntiRaidGuildState(guildId: string): void {
  _configCache.delete(guildId);
  _memoryJoinWindows.delete(guildId);
  _memoryRaidMode.delete(guildId);
  _memoryRaidBanned.delete(guildId);
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
      'anti_raid_enabled, anti_raid_join_threshold, anti_raid_join_window_seconds, anti_raid_account_age_days, anti_raid_action, anti_raid_auto_unban, anti_raid_ban_delete_seconds, anti_raid_log_channel_id, mod_log_channel_id',
    )
    .eq('guild_id', guildId)
    .maybeSingle();

  const config: AntiRaidConfig = {
    anti_raid_enabled: data?.anti_raid_enabled ?? false,
    anti_raid_join_threshold: data?.anti_raid_join_threshold ?? 10,
    anti_raid_join_window_seconds: data?.anti_raid_join_window_seconds ?? 10,
    anti_raid_account_age_days: data?.anti_raid_account_age_days ?? 7,
    anti_raid_action: data?.anti_raid_action ?? 'kick',
    anti_raid_auto_unban: data?.anti_raid_auto_unban ?? true,
    anti_raid_ban_delete_seconds: data?.anti_raid_ban_delete_seconds ?? 86400,
    anti_raid_log_channel_id: data?.anti_raid_log_channel_id ?? null,
    mod_log_channel_id: data?.mod_log_channel_id ?? null,
  };
  _configCache.set(guildId, { config, time: now });
  // V5 Audit P2-4: Cap the config cache the same way memory fallback Maps are capped
  capMap(_configCache, MAX_MEMORY_GUILDS);
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
    // V8 Audit §8.P3a: Use crypto.randomUUID() for collision-proof member uniqueness
    pipeline.zadd(key, String(now), `${now}:${randomUUID().slice(0, 8)}`);
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
    // Filter stale timestamps on every read to mirror the Valkey sorted-set
    // TTL behavior. Without this, the per-guild array grows unbounded
    // during prolonged Valkey downtime.
    const filtered = joins.filter((t) => t > windowStart);
    filtered.push(now);
    _memoryJoinWindows.set(guildId, filtered);
    capMap(_memoryJoinWindows, MAX_MEMORY_GUILDS); // V7 Audit §8.P3a
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
    capMap(_memoryRaidMode, MAX_MEMORY_GUILDS); // V7 Audit §8.P3a
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

  // V5 Audit §8.1: Auto-unban raid-banned users when raid mode expires (ban mode).
  // Gated behind anti_raid_auto_unban toggle (defaults to true).
  // Runs in background via setImmediate so it doesn't block the join handler.
  if (!raidActive && config.anti_raid_action === 'ban' && config.anti_raid_auto_unban) {
    setImmediate(() => {
      processRaidUnbans(guild, config).catch((err) => {
        log.error('Background raid unban failed', { error: (err as Error)?.message ?? err });
      });
    });
  }

  // V6 Audit §8.6: Restore verification level + invites when raid mode expires
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
        await valkey.del(prevLevelKey).catch((err) => {
          log.debug('Failed to delete anti-raid prev level key', { key: prevLevelKey, error: String(err) });
        });

        // Restore invites that were paused (stored before deletion) during lockdown
        await restoreLockdownInvites(guild, config).catch((err) => {
          log.error('Failed to restore lockdown invites:', { error: String(err) });
        });
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
          // V5 Audit §8.2: Track banned user for auto-unban when raid cools down
          await trackRaidBan(guild.id, member.id);
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
        // V5 Audit §8.P2a: Check bot permissions before attempting lockdown.
        // ManageGuild is required for setVerificationLevel + invite revocation.
        const botMember = guild.members.me;
        if (!botMember?.permissions.has('ManageGuild')) {
          log.warn(
            `Lockdown skipped: bot lacks ManageGuild permission in guild ${guild.id}. ` +
            'Grant the bot "Manage Server" permission for anti-raid lockdown to work.',
          );
          const embed = new EmbedBuilder()
            .setColor(0xFFAA00)
            .setTitle('⚠️ Anti-Raid: Lockdown Failed — Missing Permission')
            .setDescription(
              'The bot needs **Manage Server** permission to activate lockdown mode. ' +
              'Please grant this permission or switch anti-raid action to `kick` or `ban`.',
            )
            .setTimestamp();
          await logRaidEvent(guild, config, embed);
          return true;
        }

        try {
          const valkey = getValkey();
          const prevLevelKey = `antiraid:prevlevel:${guild.id}`;

          // Store the current verification level so we can restore it later
          const alreadyStored = await valkey.get(prevLevelKey).catch(() => null);
          if (!alreadyStored) {
            // V5 Audit P3-7: Use a longer TTL (1 hour) so the pre-lockdown level
            // survives bot restarts. Previous TTL was RAID_MODE_COOLDOWN + 60s which
            // expired before the bot could restore if it restarted late.
            await valkey.set(prevLevelKey, String(guild.verificationLevel), 'PX', 60 * 60_000);
          }

          // Raise to VERY_HIGH (requires phone verification)
          if (guild.verificationLevel < 4) {
            await guild.setVerificationLevel(4, 'Anti-raid lockdown: join flood detected');
            log.info(`Lockdown: raised verification to VERY_HIGH for guild ${guild.id}`);
          }

          // Pause invites: store metadata in Valkey, then delete. Invites are
          // recreated with the same settings (new codes) when lockdown expires.
          let pausedCount = 0;
          try {
            const invites = await guild.invites.fetch();
            if (invites.size > 0) {
              // Snapshot invite metadata so we can recreate them later
              const stored: StoredInvite[] = [];
              for (const inv of invites.values()) {
                stored.push({
                  channelId: inv.channelId ?? '',
                  maxAge: inv.maxAge ?? 0,
                  maxUses: inv.maxUses ?? 0,
                  temporary: inv.temporary ?? false,
                });
              }
              // Persist in Valkey (1-hour TTL — same as the prevLevel key)
              try {
                await valkey.set(
                  storedInvitesKey(guild.id),
                  JSON.stringify(stored),
                  'PX',
                  60 * 60_000,
                );
              } catch {
                log.warn('Failed to store invite metadata — invites will be deleted without restore');
              }

              const deletePromises = invites.map((inv) =>
                inv.delete('Anti-raid lockdown: pausing active invites').catch(() => null),
              );
              const results = await Promise.allSettled(deletePromises);
              pausedCount = results.filter((r) => r.status === 'fulfilled').length;
              if (pausedCount > 0) {
                log.info(`Lockdown: paused ${pausedCount} invite(s) for guild ${guild.id}`);
              }
            }
          } catch (invErr) {
            log.warn('Failed to pause invites during lockdown:', { error: String(invErr) });
          }

          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🔒 Anti-Raid: Lockdown Activated')
            .setDescription(
              `Server verification level raised to **Very High** (phone verification required).\n` +
              (pausedCount > 0 ? `${pausedCount} invite(s) paused — they will be restored when lockdown ends.\n` : '') +
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
 * Restore invites that were paused (stored then deleted) during lockdown.
 * Recreates invites in the same channels with the same settings. Codes will
 * be new — Discord doesn't allow specifying invite codes.
 */
async function restoreLockdownInvites(guild: Guild, config: AntiRaidConfig): Promise<void> {
  let storedRaw: string | null = null;
  try {
    const valkey = getValkey();
    const key = storedInvitesKey(guild.id);
    storedRaw = await valkey.get(key);
    if (storedRaw) {
      await valkey.del(key);
    }
  } catch {
    // Valkey down — can't restore
    return;
  }

  if (!storedRaw) return;

  let stored: StoredInvite[];
  try {
    stored = JSON.parse(storedRaw) as StoredInvite[];
  } catch {
    log.warn(`Failed to parse stored invite metadata for guild ${guild.id}`);
    return;
  }

  let restored = 0;
  for (const inv of stored) {
    if (!inv.channelId) continue;
    const channel = guild.channels.cache.get(inv.channelId);
    if (!channel || !('createInvite' in channel)) continue;

    try {
      await (channel as TextChannel).createInvite({
        maxAge: inv.maxAge,
        maxUses: inv.maxUses,
        temporary: inv.temporary,
        reason: 'Anti-raid lockdown ended: restoring paused invite',
      });
      restored++;
    } catch {
      // Channel may have been deleted during lockdown
    }
  }

  if (restored > 0) {
    log.info(`Lockdown ended: restored ${restored}/${stored.length} invite(s) for guild ${guild.id}`);

    const embed = new EmbedBuilder()
      .setColor(0x4caf50)
      .setTitle('🔓 Anti-Raid: Invites Restored')
      .setDescription(
        `Lockdown has ended. **${restored}** invite(s) have been recreated with their original settings.\n` +
        `Note: invite *codes* have changed — previous invite links are no longer valid.`,
      )
      .setTimestamp();

    await logRaidEvent(guild, config, embed);
  }
}

/**
 * V5 Audit §8.2: Track a user banned during raid mode for later auto-unban.
 */
async function trackRaidBan(guildId: string, userId: string): Promise<void> {
  try {
    const valkey = getValkey();
    const key = raidBannedKey(guildId);
    await valkey.sadd(key, userId);
    // Set TTL slightly longer than raid cooldown so the set survives until cleanup
    await valkey.pexpire(key, RAID_MODE_COOLDOWN + 60_000);
  } catch {
    // Fallback to in-memory
    let set = _memoryRaidBanned.get(guildId);
    if (!set) {
      set = new Set();
      _memoryRaidBanned.set(guildId, set);
    }
    set.add(userId);
  }
}

/**
 * V5 Audit §8.2: Unban users who were auto-banned during a raid.
 * Called when raid mode expires. Best-effort — logs failures but doesn't throw.
 */
async function processRaidUnbans(guild: Guild, config: AntiRaidConfig): Promise<void> {
  let userIds: string[] = [];
  try {
    const valkey = getValkey();
    const key = raidBannedKey(guild.id);
    userIds = await valkey.smembers(key);
    if (userIds.length > 0) {
      await valkey.del(key);
    }
  } catch {
    // Fallback to in-memory
    const set = _memoryRaidBanned.get(guild.id);
    if (set) {
      userIds = [...set];
      _memoryRaidBanned.delete(guild.id);
    }
  }

  if (userIds.length === 0) return;

  let unbanned = 0;
  for (const userId of userIds) {
    try {
      await guild.members.unban(userId, 'Anti-raid: Raid cooldown expired — auto-unbanning');
      unbanned++;
    } catch {
      // User may have been manually unbanned or left
    }
  }

  if (unbanned > 0) {
    log.info(`Raid cooldown: auto-unbanned ${unbanned}/${userIds.length} user(s) for guild ${guild.id}`);

    const embed = new EmbedBuilder()
      .setColor(0x4caf50)
      .setTitle('🔓 Anti-Raid: Auto-Unban Complete')
      .setDescription(
        `Raid mode has expired. **${unbanned}** user(s) who were banned during the raid have been automatically unbanned.`,
      )
      .setTimestamp();

    await logRaidEvent(guild, config, embed);
  }
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
