/**
 * Members API — List guild members with search/pagination and a status filter.
 *
 * V53 Phase 4 (Finding 4.4 — S-3)
 *
 * ?status=active|banned|left (default active):
 * - active: left_at IS NULL (the historical behavior).
 * - banned: rows with an ACTIVE ban infraction, regardless of left_at — a bot
 *   ban fires guildMemberRemove, which sets left_at, so banned members were
 *   unreachable behind the active-only filter.
 * - left:   left_at NOT NULL and not banned.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { sanitizeSearch } from '@/lib/utils/sanitize-search';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { apiError, dbError } from '@/lib/api/response';
import { enrichMembers, MemberEnrichmentError, type MemberIdentity } from '@/lib/api/member-enrichment';
import type { SupabaseClient } from '@supabase/supabase-js';

const MEMBER_COLUMNS = 'discord_id, username, avatar_url, roles, joined_at';

/** PostgREST hard-caps a single response at max_rows (1000). */
const READ_PAGE = 1000;

/**
 * All member ids with an ACTIVE ban infraction, paged so guilds with more
 * than max_rows active bans still resolve the full set. Mirrors the
 * enrichment query shape (infractions keyed by guild_id/member_id/type).
 */
async function fetchBannedIds(
  admin: SupabaseClient,
  guildId: string,
): Promise<{ ids: string[]; error: null } | { ids: null; error: { message: string } }> {
  const ids = new Set<string>();
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await admin
      .from('infractions')
      .select('member_id')
      .eq('guild_id', guildId)
      .eq('active', true)
      .eq('type', 'ban')
      .order('id', { ascending: true })
      .range(from, from + READ_PAGE - 1);

    if (error) return { ids: null, error };
    for (const row of data ?? []) ids.add(row.member_id as string);
    if ((data ?? []).length < READ_PAGE) break;
  }
  return { ids: [...ids], error: null };
}

function sortByJoinedDesc(rows: MemberIdentity[]): MemberIdentity[] {
  return rows.sort((a, b) => (b.joined_at ?? '').localeCompare(a.joined_at ?? ''));
}

export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const { guildId } = auth.ctx;
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') ?? '1', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100);
  const search = url.searchParams.get('search') ?? '';
  const status = url.searchParams.get('status') ?? 'active';
  const offset = (page - 1) * limit;

  if (status !== 'active' && status !== 'banned' && status !== 'left') {
    return apiError('Invalid status — expected active, banned, or left', 400);
  }

  const admin = createAdminSupabase();

  const s = search ? sanitizeSearch(search) : '';
  const searchFilter = s ? `username.ilike.%${s}%,discord_id.eq.${s}` : null;

  let rows: MemberIdentity[];
  let total: number;

  if (status === 'active') {
    // The members table stores identity only. XP and level live in
    // member_levels, wallet balances in economy_wallets, and mute/ban state is
    // an ACTIVE infraction — this route used to select all of them as columns
    // of `members`, which the schema has never had, so every request failed
    // with "column does not exist" and the page never rendered a member.
    let query = admin
      .from('members')
      .select(MEMBER_COLUMNS, { count: 'exact' })
      .eq('guild_id', guildId)
      .is('left_at', null)
      .order('joined_at', { ascending: false })
      .order('discord_id', { ascending: true })
      .range(offset, offset + limit - 1);

    if (searchFilter) query = query.or(searchFilter);

    const { data, count, error } = await query;
    if (error) return dbError(error, 'members');
    rows = (data ?? []) as MemberIdentity[];
    total = count ?? 0;
  } else {
    const bannedRes = await fetchBannedIds(admin, guildId);
    if (bannedRes.error) return dbError(bannedRes.error, 'members/banned-ids');
    const bannedIds = bannedRes.ids;

    if (status === 'banned') {
      // Chunked .in() fetch + in-memory pagination: banned sets are small
      // relative to the roster, and inlining an arbitrary-size id list into a
      // single PostgREST filter breaks down on URL length.
      const collected: MemberIdentity[] = [];
      const CHUNK = 200;
      for (let i = 0; i < bannedIds.length; i += CHUNK) {
        let query = admin
          .from('members')
          .select(MEMBER_COLUMNS)
          .eq('guild_id', guildId)
          .in('discord_id', bannedIds.slice(i, i + CHUNK));
        if (searchFilter) query = query.or(searchFilter);

        const { data, error } = await query;
        if (error) return dbError(error, 'members');
        collected.push(...((data ?? []) as MemberIdentity[]));
      }
      sortByJoinedDesc(collected);
      total = collected.length;
      rows = collected.slice(offset, offset + limit);
    } else {
      // left: paged read of every departed row, minus banned ids in memory —
      // count and pagination stay exact without a giant NOT IN filter.
      const bannedSet = new Set(bannedIds);
      const collected: MemberIdentity[] = [];
      for (let from = 0; ; from += READ_PAGE) {
        let query = admin
          .from('members')
          .select(MEMBER_COLUMNS)
          .eq('guild_id', guildId)
          .not('left_at', 'is', null)
          .order('joined_at', { ascending: false })
          .order('discord_id', { ascending: true })
          .range(from, from + READ_PAGE - 1);
        if (searchFilter) query = query.or(searchFilter);

        const { data, error } = await query;
        if (error) return dbError(error, 'members');
        collected.push(
          ...((data ?? []) as MemberIdentity[]).filter((r) => !bannedSet.has(r.discord_id)),
        );
        if ((data ?? []).length < READ_PAGE) break;
      }
      total = collected.length;
      rows = collected.slice(offset, offset + limit);
    }
  }

  // Enrichment failures must surface as failures — fabricated zero stats are
  // indistinguishable from real data (B4).
  let enriched;
  try {
    enriched = await enrichMembers(admin, guildId, rows);
  } catch (err) {
    if (err instanceof MemberEnrichmentError) return dbError(err, 'members/enrichment');
    throw err;
  }

  return NextResponse.json({
    success: true,
    members: enriched,
    total,
    page,
    limit,
    status,
  });
}
