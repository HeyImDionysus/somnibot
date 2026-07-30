/**
 * Guilds API — List guilds owned by the authenticated user.
 *
 * V53 Phase 4 (Finding 4.3.2 — S-2)
 * V5 Audit §7.P3a: Refactored to use requireAuth for consistency
 *   with all other routes (was duplicating auth logic inline).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { cookies } from 'next/headers';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getClientIp } from '@/lib/api/client-ip';

export async function GET(req: NextRequest) {
  // V5 Audit §1.3: Rate-limit guild list endpoint (30 req/min per IP).
  // Was reading index 0 of X-Forwarded-For — the client's own value — and
  // falling back to x-real-ip, which a client can also supply when the proxy
  // does not set it. Both bypasses are closed by the shared helper.
  const clientIp = getClientIp(req);
  const rl = await checkRateLimit(`guilds:list:${clientIp}`, 30, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const discordId = auth.discordId;
  if (!discordId) {
    return NextResponse.json({ error: 'No Discord identity' }, { status: 401 });
  }

  const admin = createAdminSupabase();
  const { data: guilds, error } = await admin
    .from('guild')
    .select('id, name')
    .eq('owner_discord_id', discordId)
    .limit(1000);

  if (error || !guilds) {
    return NextResponse.json({ error: 'Failed to load guilds' }, { status: 500 });
  }

  const cookieStore = await cookies();
  const cookieGuildId = cookieStore.get('active_guild_id')?.value;
  const activeGuildId = guilds.some((g) => g.id === cookieGuildId)
    ? cookieGuildId
    : guilds[0]?.id;

  const response = NextResponse.json({
    success: true,
    guilds,
    active_guild_id: activeGuildId,
  });

  if (activeGuildId && cookieGuildId !== activeGuildId) {
    response.cookies.set('active_guild_id', activeGuildId, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
    });
  } else if (!activeGuildId && cookieGuildId) {
    response.cookies.delete('active_guild_id');
  }

  return response;
}
