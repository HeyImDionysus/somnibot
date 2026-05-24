/**
 * Members Search API — Search guild members from guild_live_state.
 *
 * GET /api/members/search?q=username  — search by name (min 1 char)
 * GET /api/members/search?ids=id1,id2 — resolve specific member IDs to names
 *
 * Phase 1: Foundation — powers MemberPicker and useDiscordNames.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

interface GuildMember {
  id: string;
  username: string;
  display_name: string | null;
  avatar: string | null;
  discriminator?: string;
  joined_at?: string;
  roles?: string[];
  bot?: boolean;
}

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.toLowerCase();
  const ids = searchParams.get('ids');

  const admin = createAdminSupabase();

  // Get members from guild_live_state (members stored as JSONB array)
  const { data: liveState } = await admin
    .from('guild_live_state')
    .select('members, member_count, snapshot_at')
    .eq('guild_id', guildId)
    .single();

  if (!liveState || !liveState.members) {
    return NextResponse.json({
      success: true,
      members: [],
      snapshotAt: null,
    });
  }

  let members: GuildMember[] = liveState.members;

  // Mode 1: resolve specific IDs
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

  // Mode 2: search by name
  if (query && query.length >= 1) {
    members = members.filter((m) => {
      const name = (m.display_name || m.username || '').toLowerCase();
      const uname = (m.username || '').toLowerCase();
      return name.includes(query) || uname.includes(query) || m.id === query;
    });
  }

  // Limit results
  const limited = members.slice(0, 25).map((m) => ({
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
