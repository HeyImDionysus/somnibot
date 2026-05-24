/**
 * Reaction Roles Engine — Valkey-cached, handles react/unreact events.
 *
 * Architecture doc §23
 */
import type { Guild, MessageReaction, User, PartialMessageReaction, PartialUser } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { PlatformEventBus } from '../../services/event-bus.js';
import type { DbReactionRole } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('ReactionEngine');

const CACHE_PREFIX = 'reactionRoles';
const CACHE_TTL = 600; // 10 minutes

interface CachedReactionRole {
  id: string;
  role_id: string;
  exclusive_group: string | null;
  require_role: string | null;
  require_level: number | null;
  max_per_group: number | null;
  remove_on_unreact: boolean;
  log_actions: boolean;
}

/**
 * Load all reaction role configs from Supabase and populate Valkey cache.
 */
export async function loadReactionRoles(
  supabase: SupabaseClient,
  valkey: Valkey,
  guildId: string,
): Promise<void> {
  const { data } = await supabase
    .from('reaction_roles')
    .select('*')
    .eq('guild_id', guildId)
    .eq('active', true)
    .limit(1000);

  if (!data || data.length === 0) {
    log.info('No active reaction role configs found');
    return;
  }

  // Clear old cache entries for this guild (SCAN instead of KEYS — V5 audit 6.1)
  let cursor = '0';
  do {
    const [next, batch] = await valkey.scan(cursor, 'MATCH', `${CACHE_PREFIX}:${guildId}:*`, 'COUNT', '100');
    cursor = next;
    if (batch.length > 0) await valkey.del(...batch);
  } while (cursor !== '0');

  // Cache each reaction role config by messageId:emoji
  for (const rr of data as DbReactionRole[]) {
    const cacheKey = `${CACHE_PREFIX}:${guildId}:${rr.message_id}:${rr.emoji}`;
    const cached: CachedReactionRole = {
      id: rr.id,
      role_id: rr.role_id,
      exclusive_group: rr.exclusive_group,
      require_role: rr.require_role,
      require_level: rr.require_level,
      max_per_group: rr.max_per_group,
      remove_on_unreact: rr.remove_on_unreact,
      log_actions: rr.log_actions,
    };
    await valkey.set(cacheKey, JSON.stringify(cached), 'EX', CACHE_TTL);
  }

  log.info(`Cached ${data.length} reaction role configs`);
}

/**
 * Get a cached reaction role config.
 */
async function getCachedConfig(
  valkey: Valkey,
  guildId: string,
  messageId: string,
  emoji: string,
): Promise<CachedReactionRole | null> {
  const cacheKey = `${CACHE_PREFIX}:${guildId}:${messageId}:${emoji}`;
  const cached = await valkey.get(cacheKey);
  if (cached) return JSON.parse(cached) as CachedReactionRole;
  return null;
}

/**
 * Handle a reaction being added — potentially grant a role.
 */
export async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  guild: Guild,
  supabase: SupabaseClient,
  valkey: Valkey,
  eventBus: PlatformEventBus,
): Promise<boolean> {
  if (user.bot) return false;

  const messageId = reaction.message.id;
  const emoji = reaction.emoji.id
    ? `<:${reaction.emoji.name}:${reaction.emoji.id}>`
    : reaction.emoji.name ?? '';

  // Try both custom emoji format and plain name
  let config = await getCachedConfig(valkey, guild.id, messageId, emoji);
  if (!config && reaction.emoji.name) {
    config = await getCachedConfig(valkey, guild.id, messageId, reaction.emoji.name);
  }
  if (!config) return false;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return false;

  // Check prerequisites
  if (config.require_role && !member.roles.cache.has(config.require_role)) {
    // Silently deny — user doesn't meet prerequisite
    try {
      await reaction.users.remove(user.id);
    } catch { /* may not have perms */ }
    return true;
  }

  if (config.require_level != null) {
    const { data: levelData } = await supabase
      .from('member_levels')
      .select('level')
      .eq('guild_id', guild.id)
      .eq('member_id', user.id)
      .maybeSingle();

    if ((levelData?.level ?? 0) < config.require_level) {
      try {
        await reaction.users.remove(user.id);
      } catch { /* may not have perms */ }
      return true;
    }
  }

  // Check exclusive group — remove other roles in the group first
  if (config.exclusive_group) {
    // Fetch all configs in this group from DB
    const { data: groupConfigs } = await supabase
      .from('reaction_roles')
      .select('role_id')
      .eq('guild_id', guild.id)
      .eq('exclusive_group', config.exclusive_group)
      .eq('active', true)
      .neq('id', config.id)
      .limit(1000);

    if (groupConfigs) {
      for (const gc of groupConfigs) {
        if (member.roles.cache.has(gc.role_id)) {
          try {
            await member.roles.remove(gc.role_id, 'Exclusive reaction role group');
          } catch (err) {
            log.error('Failed to remove exclusive group role:', { error: String(err) });
          }
        }
      }
    }
  }

  // Check max per group
  if (config.exclusive_group && config.max_per_group != null) {
    const { data: groupConfigs } = await supabase
      .from('reaction_roles')
      .select('role_id')
      .eq('guild_id', guild.id)
      .eq('exclusive_group', config.exclusive_group)
      .eq('active', true)
      .limit(1000);

    if (groupConfigs) {
      const currentCount = groupConfigs.filter((gc) =>
        member.roles.cache.has(gc.role_id),
      ).length;

      if (currentCount >= config.max_per_group) {
        try {
          await reaction.users.remove(user.id);
        } catch { /* may not have perms */ }
        return true;
      }
    }
  }

  // Grant role
  try {
    await member.roles.add(config.role_id, 'Reaction role');
    eventBus.emit('role.gained', guild.id, {
      discordId: user.id,
      roleId: config.role_id,
      roleName: guild.roles.cache.get(config.role_id)?.name ?? config.role_id,
      source: 'bot',
    });
    log.info(`Granted role ${config.role_id} to ${user.id}`);
  } catch (err) {
    log.error(`Failed to grant role ${config.role_id}:`, err);
  }

  return true;
}

/**
 * Handle a reaction being removed — potentially revoke a role.
 */
export async function handleReactionRemove(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  guild: Guild,
  supabase: SupabaseClient,
  valkey: Valkey,
  eventBus: PlatformEventBus,
): Promise<boolean> {
  if (user.bot) return false;

  const messageId = reaction.message.id;
  const emoji = reaction.emoji.id
    ? `<:${reaction.emoji.name}:${reaction.emoji.id}>`
    : reaction.emoji.name ?? '';

  let config = await getCachedConfig(valkey, guild.id, messageId, emoji);
  if (!config && reaction.emoji.name) {
    config = await getCachedConfig(valkey, guild.id, messageId, reaction.emoji.name);
  }
  if (!config) return false;

  if (!config.remove_on_unreact) return true;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return false;

  try {
    if (member.roles.cache.has(config.role_id)) {
      await member.roles.remove(config.role_id, 'Reaction role removed');
      eventBus.emit('role.lost', guild.id, {
        discordId: user.id,
        roleId: config.role_id,
        roleName: guild.roles.cache.get(config.role_id)?.name ?? config.role_id,
        source: 'bot',
      });
      log.info(`Removed role ${config.role_id} from ${user.id}`);
    }
  } catch (err) {
    log.error(`Failed to remove role ${config.role_id}:`, err);
  }

  return true;
}
