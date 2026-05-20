/**
 * XP Tracker — handles message and voice XP with anti-spam cooldowns.
 *
 * Architecture doc §24.2–24.4
 */
import type { Message, Guild, GuildMember } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import { calculateLevel, randomXp, LEVEL_CONFIG } from '@somnibot/shared';

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
}

// TODO: scope caches by guildId for multi-guild support
let _levelConfigCache: LevelConfig | null = null;
let _levelConfigCacheTime = 0;
const CONFIG_TTL = 60_000;

let _multiplierCache: XpMultiplier[] | null = null;
let _multiplierCacheTime = 0;

let _rewardCache: LevelReward[] | null = null;
let _rewardCacheTime = 0;

export async function loadLevelConfig(
  supabase: SupabaseClient,
  guildId: string,
): Promise<LevelConfig> {
  const now = Date.now();
  if (_levelConfigCache && now - _levelConfigCacheTime < CONFIG_TTL) {
    return _levelConfigCache;
  }

  const { data } = await supabase
    .from('guild_config')
    .select(
      'levels_enabled, xp_min, xp_max, xp_cooldown_seconds, voice_xp_enabled, voice_xp_per_interval, voice_xp_interval_minutes, xp_multiplier_mode, xp_channel_mode, xp_channel_list, level_up_channel_id, level_up_message, no_xp_role_id',
    )
    .eq('guild_id', guildId)
    .maybeSingle();

  _levelConfigCache = {
    levels_enabled: data?.levels_enabled ?? false,
    xp_min: data?.xp_min ?? LEVEL_CONFIG.DEFAULT_MIN_XP,
    xp_max: data?.xp_max ?? LEVEL_CONFIG.DEFAULT_MAX_XP,
    xp_cooldown_seconds: data?.xp_cooldown_seconds ?? LEVEL_CONFIG.DEFAULT_COOLDOWN_SECONDS,
    voice_xp_enabled: data?.voice_xp_enabled ?? false,
    voice_xp_per_interval: data?.voice_xp_per_interval ?? LEVEL_CONFIG.DEFAULT_VOICE_XP_PER_INTERVAL,
    voice_xp_interval_minutes: data?.voice_xp_interval_minutes ?? LEVEL_CONFIG.DEFAULT_VOICE_INTERVAL_MINUTES,
    xp_multiplier_mode: data?.xp_multiplier_mode ?? 'highest',
    xp_channel_mode: data?.xp_channel_mode ?? 'blacklist',
    xp_channel_list: data?.xp_channel_list ?? [],
    level_up_channel_id: data?.level_up_channel_id ?? null,
    level_up_message: data?.level_up_message ?? null,
    no_xp_role_id: data?.no_xp_role_id ?? null,
  };
  _levelConfigCacheTime = now;
  return _levelConfigCache;
}

async function loadMultipliers(
  supabase: SupabaseClient,
  guildId: string,
): Promise<XpMultiplier[]> {
  const now = Date.now();
  if (_multiplierCache && now - _multiplierCacheTime < CONFIG_TTL) {
    return _multiplierCache;
  }

  const { data } = await supabase
    .from('xp_multipliers')
    .select('role_id, multiplier')
    .eq('guild_id', guildId);

  _multiplierCache = (data ?? []) as XpMultiplier[];
  _multiplierCacheTime = now;
  return _multiplierCache;
}

export async function loadRewards(
  supabase: SupabaseClient,
  guildId: string,
): Promise<LevelReward[]> {
  const now = Date.now();
  if (_rewardCache && now - _rewardCacheTime < CONFIG_TTL) {
    return _rewardCache;
  }

  const { data } = await supabase
    .from('level_rewards')
    .select('*')
    .eq('guild_id', guildId)
    .order('level', { ascending: true });

  _rewardCache = (data ?? []) as LevelReward[];
  _rewardCacheTime = now;
  return _rewardCache;
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

  // Check cooldown via Valkey
  const cooldownKey = `xp:cooldown:${guildId}:${userId}`;
  const onCooldown = await valkey.get(cooldownKey);
  if (onCooldown) return { granted: false };

  // Set cooldown
  await valkey.set(cooldownKey, '1', 'EX', config.xp_cooldown_seconds);

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
  const { data: result } = await supabase.rpc('increment_member_xp', {
    p_guild_id: guildId,
    p_member_id: userId,
    p_xp_amount: xpAmount,
    p_increment_messages: true,
    p_voice_minutes: 0,
  });

  // Fallback: if RPC doesn't exist, use the read-then-write approach
  if (!result) {
    const { data: existing } = await supabase
      .from('member_levels')
      .select('xp, level, total_messages')
      .eq('guild_id', guildId)
      .eq('member_id', userId)
      .maybeSingle();

    const oldXp = existing?.xp ?? 0;
    const oldLevel = existing?.level ?? 0;
    const oldMessages = existing?.total_messages ?? 0;
    const newXp = oldXp + xpAmount;
    const newLevel = calculateLevel(newXp);

    await supabase.from('member_levels').upsert(
      {
        guild_id: guildId,
        member_id: userId,
        xp: newXp,
        level: newLevel,
        total_messages: oldMessages + 1,
        last_xp_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'guild_id,member_id' },
    );

    return {
      granted: true,
      newXp,
      oldLevel,
      newLevel,
      leveledUp: newLevel > oldLevel,
    };
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
  const { data: result } = await supabase.rpc('increment_member_xp', {
    p_guild_id: guildId,
    p_member_id: userId,
    p_xp_amount: xpAmount,
    p_increment_messages: false,
    p_voice_minutes: config.voice_xp_interval_minutes,
  });

  // Fallback: if RPC doesn't exist, use read-then-write
  if (!result) {
    const { data: existing } = await supabase
      .from('member_levels')
      .select('xp, level, voice_minutes')
      .eq('guild_id', guildId)
      .eq('member_id', userId)
      .maybeSingle();

    const oldXp = existing?.xp ?? 0;
    const oldLevel = existing?.level ?? 0;
    const oldVoiceMinutes = existing?.voice_minutes ?? 0;
    const newXp = oldXp + xpAmount;
    const newLevel = calculateLevel(newXp);

    await supabase.from('member_levels').upsert(
      {
        guild_id: guildId,
        member_id: userId,
        xp: newXp,
        level: newLevel,
        voice_minutes: oldVoiceMinutes + config.voice_xp_interval_minutes,
        last_xp_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'guild_id,member_id' },
    );

    return {
      granted: true,
      newXp,
      oldLevel,
      newLevel,
      leveledUp: newLevel > oldLevel,
    };
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
  };
}

/**
 * Reset caches when config changes.
 */
export function invalidateLevelCaches(): void {
  _levelConfigCache = null;
  _multiplierCache = null;
  _rewardCache = null;
}
