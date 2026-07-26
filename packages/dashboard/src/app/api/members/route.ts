/**
 * Members API — List guild members with search/pagination.
 *
 * V53 Phase 4 (Finding 4.4 — S-3)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { sanitizeSearch } from '@/lib/utils/sanitize-search';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { enrichMembers } from '@/lib/api/member-enrichment';

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
  const offset = (page - 1) * limit;

  const admin = createAdminSupabase();

  // The members table stores identity only. XP and level live in
  // member_levels, wallet balances in economy_wallets, and mute/ban state is
  // an ACTIVE infraction — this route used to select all of them as columns of
  // `members`, which the schema has never had, so every request failed with
  // "column does not exist" and the page has never rendered a single member.
  let query = admin
    .from('members')
    .select('discord_id, username, avatar_url, roles, joined_at', { count: 'exact' })
    .eq('guild_id', guildId)
    .is('left_at', null)
    .order('joined_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    const s = sanitizeSearch(search);
    if (s) {
      query = query.or(`username.ilike.%${s}%,discord_id.eq.${s}`);
    }
  }

  const { data: rows, count, error } = await query;

  if (error) {
    return dbError(error, 'members');
  }

  const enriched = await enrichMembers(admin, guildId, rows ?? []);

  return NextResponse.json({
    success: true,
    members: enriched,
    total: count ?? 0,
    page,
    limit,
  });
}
