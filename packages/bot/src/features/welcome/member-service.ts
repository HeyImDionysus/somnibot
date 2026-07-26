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
import type { Guild, GuildMember } from 'discord.js';
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

  const baseRecord = {
    guild_id: guildId,
    discord_id: discordId,
    username: member.user.tag,
    avatar_url: member.user.displayAvatarURL({ size: 256 }),
    joined_at: new Date().toISOString(),
    left_at: null,
    onboarding_completed: false,
    is_returning: isReturning,
    total_time_seconds: totalTimeSeconds,
  };

  // Returning members keep their existing number — no member_number, single upsert.
  if (isReturning) {
    const { data, error } = await supabase
      .from('members')
      .upsert(baseRecord, { onConflict: 'guild_id,discord_id' })
      .select()
      .single();
    if (error) {
      log.error('Failed to record join:', error.message);
      return null;
    }
    return data as DbMember;
  }

  // New members get a sequential member_number. get_next_member_number draws
  // MAX+1 but cannot reserve it, so two simultaneous joins can draw the same N;
  // the uniq_member_number_per_guild index then rejects the loser (23505). Retry
  // with a freshly-drawn number so a race never DROPS a join (previously the loser
  // got no member row, number, or welcome at all).
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const memberNumber = await getNextMemberNumber(supabase, guildId);
    const { data, error } = await supabase
      .from('members')
      .upsert({ ...baseRecord, member_number: memberNumber }, { onConflict: 'guild_id,discord_id' })
      .select()
      .single();

    if (!error) return data as DbMember;

    // Only a member_number collision is retryable; redraw and try again.
    if (error.code === '23505' && attempt < MAX_ATTEMPTS) continue;

    log.error('Failed to record join:', error.message);
    return null;
  }

  return null;
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

/**
 * Backfill the roster with everyone ALREADY in the guild.
 *
 * Member rows were only ever written by the guildMemberAdd handler — people
 * who joined after the bot was installed. Install SomniBot into an
 * established server and the members table stays empty forever: the
 * dashboard's Members page shows nobody, and every feature that reads the
 * roster (automation conditions, profiles) sees a ghost town. Verified live:
 * zero rows for a guild the bot had been serving for days.
 *
 * Runs once per guild init. Existing rows are left untouched (their
 * member_number, onboarding and time tracking are history this sweep must not
 * rewrite); only missing members are inserted, oldest joiners first so
 * member_number ordering roughly matches server seniority. Real join dates
 * come from Discord itself.
 */
export async function backfillMembers(
  supabase: SupabaseClient,
  guild: Guild,
): Promise<number> {
  let discordMembers;
  try {
    discordMembers = await guild.members.fetch();
  } catch (err) {
    log.warn('Member backfill skipped — could not fetch member list', { error: String(err) });
    return 0;
  }

  const { data: existingRows, error: readError } = await supabase
    .from('members')
    .select('discord_id')
    .eq('guild_id', guild.id)
    .limit(10000);

  if (readError) {
    log.warn('Member backfill skipped — could not read existing rows', { error: readError.message });
    return 0;
  }

  const known = new Set((existingRows ?? []).map((r) => r.discord_id as string));
  const missing = [...discordMembers.values()]
    .filter((m) => !m.user.bot && !known.has(m.id))
    .sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0));

  if (missing.length === 0) return 0;

  let nextNumber = await getNextMemberNumber(supabase, guild.id);
  let inserted = 0;

  // Chunked inserts; sequential numbering is safe here because this runs once
  // per init and concurrent live joins retry on the unique index anyway.
  const CHUNK = 200;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const rows = missing.slice(i, i + CHUNK).map((m, j) => ({
      guild_id: guild.id,
      discord_id: m.id,
      username: m.user.tag,
      avatar_url: m.user.displayAvatarURL({ size: 256 }),
      joined_at: m.joinedAt?.toISOString() ?? new Date().toISOString(),
      left_at: null,
      onboarding_completed: false,
      is_returning: false,
      total_time_seconds: 0,
      member_number: nextNumber + i + j,
    }));

    const { error } = await supabase
      .from('members')
      .upsert(rows, { onConflict: 'guild_id,discord_id', ignoreDuplicates: true });

    if (error) {
      log.warn('Member backfill chunk failed', { error: error.message });
      break;
    }
    inserted += rows.length;
  }

  if (inserted > 0) log.info(`Backfilled ${inserted} existing member(s) into the roster`);
  return inserted;
}
