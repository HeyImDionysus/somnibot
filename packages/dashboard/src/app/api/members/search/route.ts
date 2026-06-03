/**
 * Members Search API — Search guild members via server-side RPC.
 *
 * GET /api/members/search?q=username  — search by name (min 1 char)
 * GET /api/members/search?ids=id1,id2 — resolve specific member IDs to names
 *
 * V5 Audit §14.4: Uses search_guild_members RPC to filter within PostgreSQL
 * instead of transferring the entire members JSONB array over the wire.
 * For guilds with 10k+ members, this avoids a multi-MB transfer per search.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

const MAX_RESULTS = 25;
const MAX_ID_RESOLVE = 100;

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim() ?? null;
  const ids = searchParams.get('ids');

  const admin = createAdminSupabase();

  // Build RPC arguments
  const rpcArgs: Record<string, unknown> = {
    p_guild_id: guildId,
    p_limit: MAX_RESULTS,
  };

  if (ids) {
    const idList = ids.split(',').map((id) => id.trim()).filter(Boolean).slice(0, MAX_ID_RESOLVE);
    rpcArgs.p_ids = idList;
  } else if (query && query.length >= 1) {
    rpcArgs.p_query = query;
  }

  const { data, error } = await admin.rpc('search_guild_members', rpcArgs);

  if (error) {
    // Fallback: if the RPC doesn't exist yet (pre-migration), use legacy approach
    if (error.message.includes('search_guild_members')) {
      return legacySearch(admin, guildId, query, ids);
    }
    return dbError(error, 'members/search');
  }

  const members = (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.member_id,
    username: row.username,
    display_name: row.display_name,
    avatar: row.avatar,
    bot: row.is_bot ?? false,
  }));

  const total = data?.[0]?.total_matches ?? members.length;

  return NextResponse.json({
    success: true,
    members,
    total,
  });
}

/**
 * Legacy fallback — used only if the search_guild_members RPC doesn't exist yet.
 * Will be removed after the migration is applied everywhere.
 */
async function legacySearch(
  admin: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  query: string | null,
  ids: string | null,
) {
  const { data: liveState } = await admin
    .from('guild_live_state')
    .select('members, snapshot_at')
    .eq('guild_id', guildId)
    .single();

  if (!liveState?.members) {
    return NextResponse.json({ success: true, members: [], snapshotAt: null });
  }

  interface LegacyMember {
    id: string;
    username: string;
    display_name: string | null;
    avatar: string | null;
    bot?: boolean;
  }

  let members: LegacyMember[] = liveState.members;

  if (ids) {
    const idList = ids.split(',').map((id) => id.trim()).filter(Boolean);
    const resolved = idList.map((id) => {
      const member = members.find((m) => m.id === id);
      return member
        ? { id: member.id, username: member.username, display_name: member.display_name, avatar: member.avatar, bot: member.bot }
        : { id, username: null, display_name: null, avatar: null, bot: false };
    });
    return NextResponse.json({ success: true, members: resolved });
  }

  if (query && query.length >= 1) {
    const q = query.toLowerCase();
    members = members.filter((m) => {
      const name = (m.display_name || m.username || '').toLowerCase();
      const uname = (m.username || '').toLowerCase();
      return name.includes(q) || uname.includes(q) || m.id === q;
    });
  }

  const limited = members.slice(0, MAX_RESULTS).map((m) => ({
    id: m.id,
    username: m.username,
    display_name: m.display_name,
    avatar: m.avatar,
    bot: m.bot,
  }));

  return NextResponse.json({
    success: true,
    members: limited,
    total: members.length,
    snapshotAt: liveState.snapshot_at,
  });
}
