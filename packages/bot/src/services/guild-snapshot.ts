/**
 * Guild Snapshot Writer
 *
 * Writes a full snapshot of the Discord guild's live state to Supabase.
 * The dashboard reads from `guild_live_state` to show actual Discord state.
 *
 * Captures:
 * - All roles (with managed/bot/booster tags, position, color, permissions)
 * - All channels (with type, parent category, position, topic, overrides)
 * - All categories
 * - Member count + member list (for dashboard MemberPicker / useDiscordNames)
 * - Bot role position
 * - Native onboarding status
 */

import { ChannelType, type Guild, type Role } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('GuildSnapshot');

// ============================================================
// Types — Live role/channel as stored in Supabase JSONB
// ============================================================

export interface LiveRole {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  hoist: boolean;
  mentionable: boolean;
  managed: boolean;
  tags: {
    botId: string | null;
    integrationId: string | null;
    premiumSubscriberRole: boolean;
    availableForPurchase: boolean;
    guildConnections: boolean;
  };
  /** Template key from discord_id_map, if this role was deployed by SomniBot */
  templateKey: string | null;
  /** Permission tier if deployed by SomniBot */
  tier: string | null;
  /** How this role is assigned: 'manual' | 'onboarding' | 'level' | 'purchase' | 'reaction' | 'automation' | 'managed' */
  source: string;
  memberCount: number;
}

export interface LiveChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
  topic: string | null;
  slowmode: number;
  nsfw: boolean;
  /** Template key from discord_id_map, if deployed by SomniBot */
  templateKey: string | null;
}

export interface LiveCategory {
  id: string;
  name: string;
  position: number;
  templateKey: string | null;
}

/** Lightweight member snapshot stored in guild_live_state.members JSONB. */
export interface MemberSnapshot {
  id: string;
  username: string;
  display_name: string | null;
  avatar: string | null;
  bot: boolean;
  joined_at: string | null;
  roles: string[];
}

// ============================================================
// Snapshot Writer
// ============================================================

/**
 * Take a full snapshot of the guild and write it to `guild_live_state`.
 */
export async function writeGuildSnapshot(
  guild: Guild,
  supabase: SupabaseClient,
): Promise<void> {
  // Ensure cache is fresh
  await guild.roles.fetch();
  await guild.channels.fetch();

  // Load ID mappings for enriching roles/channels with template data
  const { data: mappings } = await supabase
    .from('discord_id_map')
    .select('entity_type, template_key, discord_id')
    .eq('guild_id', guild.id)
    .limit(1000);

  const roleIdToKey = new Map<string, string>();
  const channelIdToKey = new Map<string, string>();
  const categoryIdToKey = new Map<string, string>();
  for (const m of mappings ?? []) {
    if (m.entity_type === 'role') roleIdToKey.set(m.discord_id, m.template_key);
    else if (m.entity_type === 'channel') channelIdToKey.set(m.discord_id, m.template_key);
    else if (m.entity_type === 'category') categoryIdToKey.set(m.discord_id, m.template_key);
  }

  // Load desired state for tier info
  const { data: desiredState } = await supabase
    .from('guild_desired_state')
    .select('roles')
    .eq('guild_id', guild.id)
    .single();

  const desiredRoles = (desiredState?.roles ?? []) as Array<{ key: string; tier: string }>;
  const keyToTier = new Map<string, string>();
  for (const r of desiredRoles) {
    keyToTier.set(r.key, r.tier);
  }

  // Bot role
  const botMember = guild.members.me;
  const botRole = botMember?.roles.highest;

  // ── Roles ──
  const roles: LiveRole[] = [];
  for (const [, role] of guild.roles.cache) {
    // Skip @everyone — it's handled separately
    if (role.id === guild.id) continue;

    const templateKey = roleIdToKey.get(role.id) ?? null;
    const tier = templateKey ? (keyToTier.get(templateKey) ?? null) : null;

    roles.push({
      id: role.id,
      name: role.name,
      color: role.color,
      position: role.position,
      permissions: role.permissions.bitfield.toString(),
      hoist: role.hoist,
      mentionable: role.mentionable,
      managed: role.managed,
      tags: {
        botId: role.tags?.botId ?? null,
        integrationId: role.tags?.integrationId ?? null,
        premiumSubscriberRole: role.tags?.premiumSubscriberRole ?? false,
        availableForPurchase: role.tags?.availableForPurchase ?? false,
        guildConnections: role.tags?.guildConnections ?? false,
      },
      templateKey,
      tier,
      source: classifyRoleSource(role, templateKey),
      memberCount: role.members.size,
    });
  }

  // Sort by position descending (highest first, like Discord shows)
  roles.sort((a, b) => b.position - a.position);

  // ── Channels & Categories ──
  const channels: LiveChannel[] = [];
  const categories: LiveCategory[] = [];

  for (const [, channel] of guild.channels.cache) {
    if (channel.type === ChannelType.GuildCategory) {
      categories.push({
        id: channel.id,
        name: channel.name,
        position: channel.position,
        templateKey: categoryIdToKey.get(channel.id) ?? null,
      });
    } else if (
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildVoice ||
      channel.type === ChannelType.GuildAnnouncement ||
      channel.type === ChannelType.GuildForum ||
      channel.type === ChannelType.GuildStageVoice
    ) {
      channels.push({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: 'parentId' in channel ? (channel.parentId ?? null) : null,
        position: 'position' in channel ? channel.position : 0,
        topic: 'topic' in channel ? ((channel.topic as string | null) ?? null) : null,
        slowmode: 'rateLimitPerUser' in channel ? (channel.rateLimitPerUser as number) : 0,
        nsfw: 'nsfw' in channel ? (channel.nsfw as boolean) : false,
        templateKey: channelIdToKey.get(channel.id) ?? null,
      });
    }
  }

  categories.sort((a, b) => a.position - b.position);
  channels.sort((a, b) => a.position - b.position);

  // ── Onboarding status ──
  let onboardingEnabled = false;
  let onboardingPrompts: unknown[] = [];
  try {
    // Discord.js v14.16+ has guild.fetchOnboarding()
    if (typeof guild.fetchOnboarding === 'function') {
      const onboarding = await guild.fetchOnboarding();
      onboardingEnabled = onboarding.enabled;
      onboardingPrompts = onboarding.prompts.map((p) => ({
        id: p.id,
        title: p.title,
        type: p.type,
        required: p.required,
        singleSelect: p.singleSelect,
        options: p.options.map((o) => ({
          id: o.id,
          title: o.title,
          description: o.description,
          roles: o.roles.map((r) => r.id),
          channels: o.channels.map((c) => c.id),
        })),
      }));
    }
  } catch (err) {
    // Guild may not have onboarding configured — that's expected and fine
    log.debug('Onboarding fetch skipped (not configured or no access)', { error: String(err) });
  }

  // ── Members (for MemberPicker and useDiscordNames in dashboard) ──
  // V11 Audit C-3: Use the *already-cached* member list instead of calling
  // guild.members.fetch() every snapshot cycle. The full fetch hammered the
  // Discord API every 60 seconds, risking rate-limit exhaustion and creating
  // 3–5 MB JSONB writes. The cache is populated by Discord.js from gateway
  // events (GUILD_MEMBERS_CHUNK on ready, GUILD_MEMBER_ADD/REMOVE/UPDATE
  // ongoing). For dashboard name resolution this is sufficient — the cache
  // reflects the live member list within seconds.
  let memberSnapshots: MemberSnapshot[] | null = null;
  try {
    const allMembers = guild.members.cache;
    const snapshots: MemberSnapshot[] = [];
    for (const [, member] of allMembers) {
      snapshots.push({
        id: member.id,
        username: member.user.username,
        display_name: member.displayName !== member.user.username ? member.displayName : null,
        avatar: member.user.avatar,
        bot: member.user.bot,
        joined_at: member.joinedAt?.toISOString() ?? null,
        roles: member.roles.cache
          .filter((r) => r.id !== guild.id) // exclude @everyone
          .map((r) => r.id),
      });
      if (snapshots.length >= 10_000) break;
    }
    memberSnapshots = snapshots;
  } catch (err) {
    log.warn('Failed to build member snapshot from cache:', { error: String(err) });
  }

  // ── Write to Supabase ──
  // V11 Audit L-1: roles/channels/categories/memberSnapshots are already
  // plain data objects built from scratch above — no BigInt, no circular refs.
  // The previous JSON.parse(JSON.stringify()) round-trip was unnecessary and
  // doubled memory allocation on large payloads.
  const { error } = await supabase.from('guild_live_state').upsert(
    {
      guild_id: guild.id,
      roles,
      channels,
      categories,
      member_count: guild.memberCount,
      members: memberSnapshots,
      bot_role_id: botRole?.id ?? null,
      bot_role_position: botRole?.position ?? 0,
      onboarding_enabled: onboardingEnabled,
      onboarding_prompts: onboardingPrompts,
      snapshot_at: new Date().toISOString(),
    },
    { onConflict: 'guild_id' },
  );

  if (error) {
    log.error('Failed to write guild snapshot:', error.message);
  } else {
    log.info(
      `[Snapshot] Written: ${roles.length} roles, ${channels.length} channels, ${categories.length} categories`,
    );
  }
}

// ============================================================
// Helpers
// ============================================================

function classifyRoleSource(role: Role, templateKey: string | null): string {
  if (role.managed) return 'managed';
  if (role.tags?.premiumSubscriberRole) return 'managed';
  if (role.tags?.botId) return 'managed';
  if (role.tags?.integrationId) return 'managed';
  if (role.tags?.availableForPurchase) return 'managed';
  if (templateKey) return 'deployed';
  return 'manual';
}

/**
 * Start periodic snapshot writes.
 * Writes immediately on start, then every `intervalMs`.
 *
 * V11 Audit C-3: Default increased from 60 s to 5 min. The snapshot no
 * longer calls guild.members.fetch() (uses cache), so the interval is
 * only about how fresh the dashboard's role/channel data needs to be.
 */
export function startPeriodicSnapshots(
  guild: Guild,
  supabase: SupabaseClient,
  intervalMs = 300_000,
): NodeJS.Timeout {
  // Immediate first write
  writeGuildSnapshot(guild, supabase).catch((err) =>
    log.error('Initial snapshot failed:', { error: String(err) }),
  );

  return setInterval(() => {
    writeGuildSnapshot(guild, supabase).catch((err) =>
      log.error('Periodic snapshot failed:', { error: String(err) }),
    );
  }, intervalMs);
}
