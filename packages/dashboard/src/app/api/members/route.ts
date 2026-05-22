/**
 * Members API — List guild members with search/pagination.
 *
 * V53 Phase 4 (Finding 4.4 — S-3)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const { guildId } = auth.ctx;
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') ?? '1', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100);
  const search = url.searchParams.get('search') ?? '';
  const offset = (page - 1) * limit;

  const admin = createAdminSupabase();

  let query = admin
    .from('members')
    .select('id, discord_id, username, display_name, avatar_url, roles, joined_at, xp, level, wallet, bank, is_muted, is_banned, suspended', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('joined_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(`username.ilike.%${search}%,display_name.ilike.%${search}%,discord_id.eq.${search}`);
  }

  const { data: members, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    members: members ?? [],
    total: count ?? 0,
    page,
    limit,
  });
}
