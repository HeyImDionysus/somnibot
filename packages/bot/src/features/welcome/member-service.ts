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
import { GuildMemberFlags } from 'discord.js';
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

  // A voluntary rejoin is fresh consent: clear any /forgetme erasure marker
  // FIRST, so nothing later in the join path — or a concurrently running
  // roster backfill — keeps suppressing a member who chose to come back.
  // Marker cleanup must never block join handling, hence the defensive catch.
  try {
    const { error: markerError } = await supabase
      .from('member_erasures')
      .delete()
      .eq('guild_id', guildId)
      .eq('discord_id', discordId);
    if (markerError) {
      log.warn('Failed to clear erasure marker on rejoin:', markerError.message);
    }
  } catch (err) {
    log.warn('Failed to clear erasure marker on rejoin:', String(err));
  }

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
 * A member has proven they are past Discord's onboarding/membership screening
 * when Discord either set the CompletedOnboarding flag or reports them as not
 * pending. Pre-install members never went through the bot's flag-transition
 * path, so this is the only truthful signal available at backfill time.
 */
function hasCompletedOnboarding(m: GuildMember): boolean {
  return (m.flags?.has(GuildMemberFlags.CompletedOnboarding) ?? false) || !m.pending;
}

/**
 * PostgREST hard-caps a single response at max_rows (1000), so any read that
 * can exceed that must page with .range() and accumulate.
 */
const READ_PAGE = 1000;

/**
 * Backfill and reconcile the roster with everyone ALREADY in the guild.
 *
 * Member rows were only ever written by the guildMemberAdd handler — people
 * who joined after the bot was installed. Install SomniBot into an
 * established server and the members table stays empty forever: the
 * dashboard's Members page shows nobody, and every feature that reads the
 * roster (automation conditions, profiles) sees a ghost town. Verified live:
 * zero rows for a guild the bot had been serving for days.
 *
 * Runs once per guild init and makes three kinds of writes:
 * 1. INSERT missing members, oldest joiners first so member_number ordering
 *    roughly matches server seniority. Real join dates come from Discord.
 * 2. RECONCILE rows with a stale left_at — members who rejoined while the bot
 *    was offline are present in the fetch but "gone" in the DB. Their left_at
 *    is cleared, identity refreshed, and joined_at reset to Discord's current
 *    join date; time spent away is deliberately not accumulated (there is no
 *    reliable leave/rejoin timeline to derive it from).
 * 3. REPAIR onboarding_completed=false rows whose member the current fetch
 *    proves is past screening — otherwise pre-install members stay locked out
 *    of onboarding-gated features forever.
 *
 * member_number and total_time_seconds are history this sweep never rewrites.
 * Members with a /forgetme erasure marker are excluded from every write:
 * re-creating (or touching) their data would break the erasure promise. Only
 * a voluntary rejoin (guildMemberAdd) clears the marker.
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

  // Read ALL existing rows, paged (a .limit() read is silently truncated at
  // PostgREST's max_rows — 1000 — which made big rosters re-insert forever).
  const existing = new Map<string, { left_at: string | null; onboarding_completed: boolean }>();
  for (let from = 0; ; from += READ_PAGE) {
    // Stable order: unordered .range() pages can skip/duplicate rows when
    // concurrent writes shift page boundaries mid-scan.
    const { data, error } = await supabase
      .from('members')
      .select('discord_id, left_at, onboarding_completed')
      .eq('guild_id', guild.id)
      .order('discord_id', { ascending: true })
      .range(from, from + READ_PAGE - 1);

    if (error) {
      log.warn('Member backfill skipped — could not read existing rows', { error: error.message });
      return 0;
    }
    for (const r of data ?? []) {
      existing.set(r.discord_id as string, {
        left_at: (r.left_at as string | null) ?? null,
        onboarding_completed: Boolean(r.onboarding_completed),
      });
    }
    if ((data ?? []).length < READ_PAGE) break;
  }

  // Erasure suppression list. If it cannot be read the backfill must not run:
  // proceeding could resurrect data a member explicitly asked to erase.
  const erased = new Set<string>();
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await supabase
      .from('member_erasures')
      .select('discord_id')
      .eq('guild_id', guild.id)
      .order('discord_id', { ascending: true })
      .range(from, from + READ_PAGE - 1);

    if (error) {
      log.warn('Member backfill skipped — could not read erasure markers', { error: error.message });
      return 0;
    }
    for (const r of data ?? []) erased.add(r.discord_id as string);
    if ((data ?? []).length < READ_PAGE) break;
  }

  const fetched = [...discordMembers.values()].filter((m) => !m.user.bot && !erased.has(m.id));

  // Partition 1 — present on Discord, no row at all: insert.
  const missing = fetched
    .filter((m) => !existing.has(m.id))
    .sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0));

  // Partition 2 — present on Discord but the row says they left (rejoined
  // while the bot was offline): clear left_at and refresh identity. Values
  // differ per member, so these are per-row updates; the set is naturally
  // small (only offline-window rejoins land here).
  const staleLeft = fetched.filter((m) => {
    const row = existing.get(m.id);
    return row !== undefined && row.left_at !== null;
  });
  const staleLeftIds = new Set(staleLeft.map((m) => m.id));

  // Partition 3 — row says onboarding incomplete but the current fetch proves
  // the member is past screening. Rows also in partition 2 get the repair
  // folded into their per-row update instead.
  const onboardingRepair = fetched.filter((m) => {
    const row = existing.get(m.id);
    return (
      row !== undefined &&
      !row.onboarding_completed &&
      !staleLeftIds.has(m.id) &&
      hasCompletedOnboarding(m)
    );
  });

  let reconciled = 0;
  for (const m of staleLeft) {
    const row = existing.get(m.id);
    if (row === undefined || row.left_at === null) continue;
    const repairOnboarding = !row.onboarding_completed && hasCompletedOnboarding(m);
    // Compare-and-set on the snapshotted left_at: if the live gateway handler
    // touched the row after our snapshot (a fresh leave sets a NEW left_at, a
    // live rejoin clears it), this matches 0 rows and we must not overwrite —
    // blindly clearing left_at here would resurrect a member who left
    // mid-backfill, permanently.
    const { data: updated, error } = await supabase
      .from('members')
      .update({
        left_at: null,
        is_returning: true,
        username: m.user.tag,
        avatar_url: m.user.displayAvatarURL({ size: 256 }),
        joined_at: m.joinedAt?.toISOString() ?? new Date().toISOString(),
        ...(repairOnboarding ? { onboarding_completed: true } : {}),
      })
      .eq('guild_id', guild.id)
      .eq('discord_id', m.id)
      .eq('left_at', row.left_at)
      .select('discord_id');

    if (error) {
      log.warn('Member backfill left_at reconcile failed', { discordId: m.id, error: error.message });
      continue;
    }
    if ((updated ?? []).length === 0) {
      log.debug?.('Member backfill left_at reconcile skipped — row changed since snapshot', { discordId: m.id });
      continue;
    }
    reconciled += 1;
  }

  // Chunked repair: identical payload for every row, so .in() batches apply.
  const CHUNK = 200;
  let repaired = 0;
  for (let i = 0; i < onboardingRepair.length; i += CHUNK) {
    const chunkIds = onboardingRepair.slice(i, i + CHUNK).map((m) => m.id);
    const { error } = await supabase
      .from('members')
      .update({ onboarding_completed: true })
      .eq('guild_id', guild.id)
      .in('discord_id', chunkIds);

    if (error) {
      log.warn('Member backfill onboarding repair chunk failed', { error: error.message });
      continue;
    }
    repaired += chunkIds.length;
  }

  let inserted = 0;

  // Chunked inserts. The member number is drawn fresh per attempt because
  // get_next_member_number cannot reserve numbers: a live join racing the
  // backfill can take one of ours, and the uniq (guild_id, member_number)
  // index then rejects the whole chunk with 23505 — redraw and retry, bounded,
  // mirroring the recordMemberJoin retry. A failed chunk never aborts the
  // rest of the sweep, and only rows PostgREST actually inserted are counted
  // (ignoreDuplicates makes rows.length a lie whenever a duplicate slips in).
  const MAX_CHUNK_ATTEMPTS = 5;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunkMembers = missing.slice(i, i + CHUNK);

    for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
      const base = await getNextMemberNumber(supabase, guild.id);
      const rows = chunkMembers.map((m, j) => ({
        guild_id: guild.id,
        discord_id: m.id,
        username: m.user.tag,
        avatar_url: m.user.displayAvatarURL({ size: 256 }),
        joined_at: m.joinedAt?.toISOString() ?? new Date().toISOString(),
        left_at: null,
        onboarding_completed: hasCompletedOnboarding(m),
        is_returning: false,
        total_time_seconds: 0,
        member_number: base + j,
      }));

      const { data, error } = await supabase
        .from('members')
        .upsert(rows, { onConflict: 'guild_id,discord_id', ignoreDuplicates: true })
        .select('discord_id');

      if (!error) {
        inserted += (data ?? []).length;
        break;
      }

      // Only a member_number collision is retryable; redraw and try again.
      if (error.code === '23505' && attempt < MAX_CHUNK_ATTEMPTS) continue;

      // A dropped chunk means these members stay missing until the next guild
      // init — loud, with the blast radius, never a quiet warn.
      log.error('Member backfill chunk dropped — members remain missing until next init', {
        count: chunkMembers.length,
        attempts: attempt,
        error: error.message,
      });
      break;
    }
  }

  // Late-erasure sweep: a /forgetme filed AFTER the marker read above but
  // BEFORE a chunk insert can re-create a pre-install member's identity row
  // (their purge had no members row to delete yet). Re-read the markers and
  // remove any row this run inserted for a now-marked member. Markers filed
  // after THIS read are safe without us: by then the row exists, so their own
  // purge deletes it.
  if (missing.length > 0) {
    const lateErased = new Set<string>();
    for (let from = 0; ; from += READ_PAGE) {
      const { data, error } = await supabase
        .from('member_erasures')
        .select('discord_id')
        .eq('guild_id', guild.id)
        .order('discord_id', { ascending: true })
        .range(from, from + READ_PAGE - 1);
      if (error) {
        log.error('Member backfill late-erasure sweep failed — run /forgetme again if a purged member reappeared', {
          error: error.message,
        });
        break;
      }
      for (const r of data ?? []) lateErased.add(r.discord_id as string);
      if ((data ?? []).length < READ_PAGE) break;
    }

    const resurrected = missing.filter((m) => lateErased.has(m.id) && !erased.has(m.id)).map((m) => m.id);
    if (resurrected.length > 0) {
      const { error } = await supabase
        .from('members')
        .delete()
        .eq('guild_id', guild.id)
        .in('discord_id', resurrected);
      if (error) {
        log.error('Member backfill late-erasure delete failed', { count: resurrected.length, error: error.message });
      } else {
        inserted = Math.max(0, inserted - resurrected.length);
        log.info(`Roster backfill removed ${resurrected.length} row(s) re-created past an in-flight erasure`);
      }
    }
  }

  if (inserted > 0 || reconciled > 0 || repaired > 0) {
    log.info(
      `Roster backfill: ${inserted} inserted, ${reconciled} left_at reconciled, ${repaired} onboarding repaired`,
    );
  }
  return inserted;
}
