/**
 * XP Tracker — handles message and voice XP with anti-spam cooldowns.
 *
 * Architecture doc §24.2–24.4
 */
import type { Message, Guild, GuildMember } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import { calculateLevel, randomXp, LEVEL_CONFIG , createLogger } from '@somnibot/shared';

const log = createLogger('XPTracker');

export interface LevelConfig {
  levels_enabled: boolean;
  xp_min: number;
  xp_max: number;
  xp_cooldown_seconds: number;
  voice_xp_enabled: boolean;
  voice_xp_per_interval: number;
  voice_xp_interval_minutes: number;
  xp_multiplier_mode: 'highest' | 'additive';
  xp_channel_mode: 'blacklist' | 'whitelist';
  xp_channel_list: string[];
  level_up_channel_id: string | null;
  level_up_message: string | null;
  no_xp_role_id: string | null;
}

interface XpMultiplier {
  role_id: string;
  multiplier: number;
}

interface LevelReward {
  id: string;
  level: number;
  role_id: string;
  remove_at_level: number | null;
  announce: boolean;
}

export interface XpResult {
  granted: boolean;
  newXp?: number;
  oldLevel?: number;
  newLevel?: number;
  leveledUp?: boolean;
  /** Member's post-increment total_messages (for the 'messages_sent' achievement). */
  totalMessages?: number;
}

// Per-guild caches — keyed by guildId to support multi-guild
interface CacheEntry<T> { data: T; time: number; }
const CONFIG_TTL = 60_000;
// V11 Audit L-8: Max entries per cache map to prevent unbounded growth
// if the bot joins/leaves many guilds over its lifetime.
const MAX_CACHE_ENTRIES = 200;

const _levelConfigCache = new Map<string, CacheEntry<LevelConfig>>();

/**
 * What we serve when the config read fails and we have nothing cached: awarding
 * no XP is recoverable, awarding it to a guild that opted out is not.
 *
 * Built on call rather than at module scope so importing this file does not
 * require LEVEL_CONFIG to be resolvable yet.
 */
function disabledLevelConfig(): LevelConfig {
  return {
    levels_enabled: false,
    xp_min: LEVEL_CONFIG.DEFAULT_MIN_XP,
    xp_max: LEVEL_CONFIG.DEFAULT_MAX_XP,
    xp_cooldown_seconds: LEVEL_CONFIG.DEFAULT_COOLDOWN_SECONDS,
    voice_xp_enabled: false,
    voice_xp_per_interval: LEVEL_CONFIG.DEFAULT_VOICE_XP_PER_INTERVAL,
    voice_xp_interval_minutes: LEVEL_CONFIG.DEFAULT_VOICE_INTERVAL_MINUTES,
    xp_multiplier_mode: 'highest',
    xp_channel_mode: 'blacklist',
    xp_channel_list: [],
    level_up_channel_id: null,
    level_up_message: null,
    no_xp_role_id: null,
  };
}
const _multiplierCache = new Map<string, CacheEntry<XpMultiplier[]>>();
const _rewardCache = new Map<string, CacheEntry<LevelReward[]>>();

/**
 * V11 Audit L-8: Evict the oldest entry when the cache exceeds MAX_CACHE_ENTRIES.
 * Maps iterate in insertion order, so the first key is the oldest.
 */
function evictOldest<T>(map: Map<string, CacheEntry<T>>): void {
  if (map.size > MAX_CACHE_ENTRIES) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
}

export async function loadLevelConfig(
  supabase: SupabaseClient,
  guildId: string,
): Promise<LevelConfig> {
  const now = Date.now();
  const cached = _levelConfigCache.get(guildId);
  if (cached && now - cached.time < CONFIG_TTL) {
    return cached.data;
  }

  const { data, error } = await supabase
    .from('guild_config')
    .select(
      'levels_enabled, xp_min, xp_max, xp_cooldown_seconds, voice_xp_enabled, voice_xp_per_interval, voice_xp_interval_minutes, xp_multiplier_mode, xp_channel_mode, xp_channel_list, level_up_channel_id, level_up_message, no_xp_role_id',
    )
    .eq('guild_id', guildId)
    .maybeSingle();

  // A failed read also yields `data === null`, which is indistinguishable from
  // "no row" at the `??` site — so a timeout would silently apply the enabled-
  // by-default values and award XP in a guild that deliberately turned levels
  // off. Defaults are for a confirmed absent row only; on a read error keep
  // serving the last known config, or stay off until we can actually ask.
  // Neither branch is cached, so XP resumes the moment a read succeeds rather
  // than staying wrong for the rest of the TTL.
  if (error) {
    if (cached) return cached.data; // stale, but it is the guild's real config
    return disabledLevelConfig();
  }

  const config: LevelConfig = {
    // Ship enabled by default (matches the column defaults and the catalog).
    // guild-init creates the config row on join, so this only applies before
    // that lands; it must agree with the schema either way.
    levels_enabled: data?.levels_enabled ?? true,
    xp_min: data?.xp_min ?? LEVEL_CONFIG.DEFAULT_MIN_XP,
    xp_max: data?.xp_max ?? LEVEL_CONFIG.DEFAULT_MAX_XP,
    xp_cooldown_seconds: data?.xp_cooldown_seconds ?? LEVEL_CONFIG.DEFAULT_COOLDOWN_SECONDS,
    voice_xp_enabled: data?.voice_xp_enabled ?? true,
    voice_xp_per_interval: data?.voice_xp_per_interval ?? LEVEL_CONFIG.DEFAULT_VOICE_XP_PER_INTERVAL,
    voice_xp_interval_minutes: data?.voice_xp_interval_minutes ?? LEVEL_CONFIG.DEFAULT_VOICE_INTERVAL_MINUTES,
    xp_multiplier_mode: data?.xp_multiplier_mode ?? 'highest',
    xp_channel_mode: data?.xp_channel_mode ?? 'blacklist',
    xp_channel_list: data?.xp_channel_list ?? [],
    level_up_channel_id: data?.level_up_channel_id ?? null,
    level_up_message: data?.level_up_message ?? null,
    no_xp_role_id: data?.no_xp_role_id ?? null,
  };
  _levelConfigCache.set(guildId, { data: config, time: now });
  evictOldest(_levelConfigCache);
  return config;
}

async function loadMultipliers(
  supabase: SupabaseClient,
  guildId: string,
): Promise<XpMultiplier[]> {
  const now = Date.now();
  const cached = _multiplierCache.get(guildId);
  if (cached && now - cached.time < CONFIG_TTL) {
    return cached.data;
  }

  const { data } = await supabase
    .from('xp_multipliers')
    .select('role_id, multiplier')
    .eq('guild_id', guildId)
    .limit(1000);

  const multipliers = (data ?? []) as XpMultiplier[];
  _multiplierCache.set(guildId, { data: multipliers, time: now });
  evictOldest(_multiplierCache);
  return multipliers;
}

export async function loadRewards(
  supabase: SupabaseClient,
  guildId: string,
): Promise<LevelReward[]> {
  const now = Date.now();
  const cached = _rewardCache.get(guildId);
  if (cached && now - cached.time < CONFIG_TTL) {
    return cached.data;
  }

  const { data } = await supabase
    .from('level_rewards')
    .select('*')
    .eq('guild_id', guildId)
    .order('level', { ascending: true })
    .limit(1000);

  const rewards = (data ?? []) as LevelReward[];
  _rewardCache.set(guildId, { data: rewards, time: now });
  evictOldest(_rewardCache);
  return rewards;
}

/**
 * Check if a channel is eligible for XP.
 */
function isChannelEligible(channelId: string, config: LevelConfig): boolean {
  if (config.xp_channel_list.length === 0) return true;

  if (config.xp_channel_mode === 'whitelist') {
    return config.xp_channel_list.includes(channelId);
  }
  // Blacklist mode
  return !config.xp_channel_list.includes(channelId);
}

/**
 * Compute the effective XP multiplier for a member.
 */
function computeMultiplier(
  memberRoles: string[],
  multipliers: XpMultiplier[],
  mode: 'highest' | 'additive',
): number {
  const matching = multipliers.filter((m) => memberRoles.includes(m.role_id));
  if (matching.length === 0) return 1.0;

  if (mode === 'highest') {
    return Math.max(...matching.map((m) => m.multiplier));
  }
  // Additive: base 1.0 + sum of (multiplier - 1.0) for each
  return 1.0 + matching.reduce((sum, m) => sum + (m.multiplier - 1.0), 0);
}

/**
 * Process message XP for a user.
 */
export async function processMessageXp(
  message: Message,
  supabase: SupabaseClient,
  valkey: Valkey,
  guildId: string,
): Promise<XpResult> {
  const config = await loadLevelConfig(supabase, guildId);
  if (!config.levels_enabled) return { granted: false };

  const channelId = message.channel.id;
  const userId = message.author.id;

  // Check channel eligibility
  if (!isChannelEligible(channelId, config)) return { granted: false };

  // Check No-XP role
  if (config.no_xp_role_id && message.member?.roles.cache.has(config.no_xp_role_id)) {
    return { granted: false };
  }

  // V50-L1: claim cooldown atomically with SET EX NX. The previous
  // GET→check→SET pattern let two messages in rapid succession both
  // pass the cooldown check and each get an XP award.
  const cooldownKey = `xp:cooldown:${guildId}:${userId}`;
  const claimed = await valkey.set(cooldownKey, '1', 'EX', config.xp_cooldown_seconds, 'NX');
  if (!claimed) return { granted: false };

  // Calculate XP
  let xpAmount = randomXp(config.xp_min, config.xp_max);

  // Apply multiplier
  const member = message.member;
  if (member) {
    const multipliers = await loadMultipliers(supabase, guildId);
    const memberRoles = member.roles.cache.map((r) => r.id);
    const mult = computeMultiplier(memberRoles, multipliers, config.xp_multiplier_mode);
    xpAmount = Math.round(xpAmount * mult);
  }

  // Atomically increment XP in the database to avoid race conditions
  // between concurrent message XP and voice XP grants.
  // V51: check error to avoid silent fallback to unsafe read-then-write.
  const { data: result, error: rpcError } = await supabase.rpc('increment_member_xp', {
    p_guild_id: guildId,
    p_member_id: userId,
    p_xp_amount: xpAmount,
    p_increment_messages: true,
    p_voice_minutes: 0,
  });

  if (rpcError) {
    log.error('increment_member_xp RPC failed:', rpcError.message);
    return { granted: false, newXp: 0, oldLevel: 0, newLevel: 0, leveledUp: false };
  }

  // V10 Audit §3: Fail-fast if RPC returns null. The previous non-atomic
  // fallback (read → compute → upsert) could race message XP vs voice XP
  // and silently lose XP. If the RPC is missing, migrations must be applied.
  if (!result) {
    log.error(
      'increment_member_xp RPC returned null — migration not applied. ' +
      'Run migrations to add the increment_member_xp function. ' +
      'Refusing non-atomic fallback to prevent XP race conditions.',
    );
    return { granted: false, newXp: 0, oldLevel: 0, newLevel: 0, leveledUp: false };
  }

  const newXp = result.new_xp;
  const oldLevel = result.old_level;
  const newLevel = result.new_level;

  return {
    granted: true,
    newXp,
    oldLevel,
    newLevel,
    leveledUp: newLevel > oldLevel,
    totalMessages: result.total_messages,
  };
}

/**
 * Grant voice XP to a user.
 */
export async function grantVoiceXp(
  supabase: SupabaseClient,
  valkey: Valkey,
  guildId: string,
  userId: string,
  memberRoles: string[],
  amount: number,
): Promise<XpResult> {
  const config = await loadLevelConfig(supabase, guildId);
  if (!config.levels_enabled || !config.voice_xp_enabled) return { granted: false };

  // Check No-XP role
  if (config.no_xp_role_id && memberRoles.includes(config.no_xp_role_id)) {
    return { granted: false };
  }

  // Apply multiplier
  const multipliers = await loadMultipliers(supabase, guildId);
  const mult = computeMultiplier(memberRoles, multipliers, config.xp_multiplier_mode);
  const xpAmount = Math.round(amount * mult);

  // Atomically increment XP in the database to avoid race conditions
  // V51: check error to avoid silent fallback to unsafe read-then-write.
  const { data: result, error: rpcError } = await supabase.rpc('increment_member_xp', {
    p_guild_id: guildId,
    p_member_id: userId,
    p_xp_amount: xpAmount,
    p_increment_messages: false,
    p_voice_minutes: config.voice_xp_interval_minutes,
  });

  if (rpcError) {
    log.error('increment_member_xp RPC failed (voice):', rpcError.message);
    return { granted: false };
  }

  // V10 Audit §3: Same fail-fast guard as message XP above.
  if (!result) {
    log.error(
      'increment_member_xp RPC returned null (voice) — migration not applied. ' +
      'Run migrations to add the increment_member_xp function.',
    );
    return { granted: false };
  }

  const newXp = result.new_xp;
  const oldLevel = result.old_level;
  const newLevel = result.new_level;

  return {
    granted: true,
    newXp,
    oldLevel,
    newLevel,
    leveledUp: newLevel > oldLevel,
    totalMessages: result.total_messages,
  };
}

/**
 * Reset caches when config changes.
 */
export function invalidateLevelCaches(guildId?: string): void {
  if (guildId) {
    _levelConfigCache.delete(guildId);
    _multiplierCache.delete(guildId);
    _rewardCache.delete(guildId);
  } else {
    _levelConfigCache.clear();
    _multiplierCache.clear();
    _rewardCache.clear();
  }
}
