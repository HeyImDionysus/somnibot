/**
 * Member Service — Tracks members for returning-member detection and onboarding.
 *
 * Responsibilities:
 * - Upsert member records on join/leave
 * - Detect returning members
 * - Store roles at time of leave for later restoration
 * - Track member numbers (sequential join count)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GuildMember } from 'discord.js';
import type { DbMember } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('MemberService');

export interface MemberLookupResult {
  member: DbMember | null;
  isReturning: boolean;
  previousRoles: string[];
}

/**
 * Look up a member record — returns null if first-time join.
 */
export async function lookupMember(
  supabase: SupabaseClient,
  guildId: string,
  discordId: string,
): Promise<MemberLookupResult> {
  const { data, error } = await supabase
    .from('members')
    .select('*')
    .eq('guild_id', guildId)
    .eq('discord_id', discordId)
    .maybeSingle();

  if (error) {
    log.error('Lookup failed:', error.message);
    return { member: null, isReturning: false, previousRoles: [] };
  }

  if (!data) {
    return { member: null, isReturning: false, previousRoles: [] };
  }

  return {
    member: data as DbMember,
    isReturning: true,
    previousRoles: (data.roles as string[]) ?? [],
  };
}

/**
 * Get the next sequential member number for a guild.
 */
/**
 * V51: use RPC for atomic next-member-number to avoid duplicate numbers
 * when two members join simultaneously.
 */
async function getNextMemberNumber(
  supabase: SupabaseClient,
  guildId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc('get_next_member_number', {
    p_guild_id: guildId,
  });

  if (error || data == null) {
    log.warn('get_next_member_number RPC failed, using fallback:', error?.message);
    const { data: row } = await supabase
      .from('members')
      .select('member_number')
      .eq('guild_id', guildId)
      .order('member_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    return (row?.member_number as number ?? 0) + 1;
  }

  return data as number;
}

/**
 * Record a member joining. Creates or updates the member record.
 */
export async function recordMemberJoin(
  supabase: SupabaseClient,
  member: GuildMember,
  isReturning: boolean,
): Promise<DbMember | null> {
  const guildId = member.guild.id;
  const discordId = member.id;

  // Calculate cumulative time if returning
  let totalTimeSeconds = 0;
  if (isReturning) {
    const { data: existing } = await supabase
      .from('members')
      .select('total_time_seconds, left_at, joined_at')
      .eq('guild_id', guildId)
      .eq('discord_id', discordId)
      .maybeSingle();

    if (existing) {
      totalTimeSeconds = (existing.total_time_seconds as number) ?? 0;
      // Add time from last session if they left properly
      if (existing.left_at && existing.joined_at) {
        const lastJoin = new Date(existing.joined_at as string).getTime();
        const lastLeave = new Date(existing.left_at as string).getTime();
        if (lastLeave > lastJoin) {
          totalTimeSeconds += Math.floor((lastLeave - lastJoin) / 1000);
        }
      }
    }
  }

  const memberNumber = isReturning
    ? undefined // Keep existing number
    : await getNextMemberNumber(supabase, guildId);

  const record = {
    guild_id: guildId,
    discord_id: discordId,
    username: member.user.tag,
    avatar_url: member.user.displayAvatarURL({ size: 256 }),
    joined_at: new Date().toISOString(),
    left_at: null,
    onboarding_completed: false,
    is_returning: isReturning,
    total_time_seconds: totalTimeSeconds,
    ...(memberNumber !== undefined ? { member_number: memberNumber } : {}),
  };

  const { data, error } = await supabase
    .from('members')
    .upsert(record, { onConflict: 'guild_id,discord_id' })
    .select()
    .single();

  if (error) {
    log.error('Failed to record join:', error.message);
    return null;
  }

  return data as DbMember;
}

/**
 * Record a member leaving — stores their current roles for later restoration.
 */
export async function recordMemberLeave(
  supabase: SupabaseClient,
  member: GuildMember,
): Promise<void> {
  const roleIds = member.roles.cache
    .filter((r) => !r.managed && r.id !== member.guild.id) // Skip @everyone and managed roles
    .map((r) => r.id);

  const { error } = await supabase
    .from('members')
    .update({
      left_at: new Date().toISOString(),
      roles: roleIds,
    })
    .eq('guild_id', member.guild.id)
    .eq('discord_id', member.id);

  if (error) {
    log.error('Failed to record leave:', error.message);
  }
}

/**
 * Mark a member as having completed onboarding.
 */
export async function markOnboardingCompleted(
  supabase: SupabaseClient,
  guildId: string,
  discordId: string,
): Promise<void> {
  const { error } = await supabase
    .from('members')
    .update({ onboarding_completed: true })
    .eq('guild_id', guildId)
    .eq('discord_id', discordId);

  if (error) {
    log.error('Failed to mark onboarding completed:', error.message);
  }
}

/**
 * Get a member's display number (e.g., "Member #1,234").
 */
export async function getMemberNumber(
  supabase: SupabaseClient,
  guildId: string,
  discordId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('members')
    .select('member_number')
    .eq('guild_id', guildId)
    .eq('discord_id', discordId)
    .maybeSingle();

  if (error || !data) return 0;
  return data.member_number as number;
}
