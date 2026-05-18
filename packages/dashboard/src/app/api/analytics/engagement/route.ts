/**
 * GET /api/analytics/engagement — Moderation, levels, engagement analytics.
 *
 * Complements the commerce-only /api/analytics with:
 *   - Moderation trends (infractions by type/day)
 *   - Level distribution
 *   - Member activity (joins/leaves, message volume, voice hours)
 *   - Ticket metrics
 *   - Giveaway stats
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';

export async function GET(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.view_analytics');
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || '30d';

    const admin = createAdminSupabase();

    const now = new Date();
    let startDate: Date;
    switch (period) {
      case '7d': startDate = new Date(now.getTime() - 7 * 86400000); break;
      case '30d': startDate = new Date(now.getTime() - 30 * 86400000); break;
      case '90d': startDate = new Date(now.getTime() - 90 * 86400000); break;
      default: startDate = new Date(now.getTime() - 30 * 86400000);
    }
    const startIso = startDate.toISOString();

    // ── Moderation ─────────────────────────────────────
    const { data: infractions } = await admin
      .from('infractions')
      .select('type, created_at, active, pardoned')
      .eq('guild_id', ctx.guildId)
      .gte('created_at', startIso);

    const infractionsByType: Record<string, number> = {};
    const infractionsByDay: Record<string, number> = {};
    for (const inf of infractions ?? []) {
      infractionsByType[inf.type] = (infractionsByType[inf.type] ?? 0) + 1;
      const day = inf.created_at.slice(0, 10);
      infractionsByDay[day] = (infractionsByDay[day] ?? 0) + 1;
    }

    const totalInfractions = infractions?.length ?? 0;
    const activeInfractions = infractions?.filter(i => i.active && !i.pardoned).length ?? 0;
    const pardonedInfractions = infractions?.filter(i => i.pardoned).length ?? 0;

    // ── Tickets ───────────────────────────────────────
    const { data: tickets } = await admin
      .from('tickets')
      .select('status, created_at, closed_at, message_count')
      .eq('guild_id', ctx.guildId)
      .gte('created_at', startIso);

    const totalTickets = tickets?.length ?? 0;
    const openTickets = tickets?.filter(t => t.status === 'open' || t.status === 'claimed').length ?? 0;
    const closedTickets = tickets?.filter(t => t.status === 'closed').length ?? 0;

    // Average resolution time (for tickets that have been closed)
    const resolvedTickets = tickets?.filter(t => t.closed_at && t.created_at) ?? [];
    let avgResolutionHours = 0;
    if (resolvedTickets.length > 0) {
      const totalMs = resolvedTickets.reduce((sum, t) => {
        return sum + (new Date(t.closed_at!).getTime() - new Date(t.created_at).getTime());
      }, 0);
      avgResolutionHours = Math.round(totalMs / resolvedTickets.length / 3600000 * 10) / 10;
    }

    // ── Levels ────────────────────────────────────────
    const { data: levels } = await admin
      .from('member_levels')
      .select('level, xp, total_messages, voice_minutes')
      .eq('guild_id', ctx.guildId);

    const totalTrackedMembers = levels?.length ?? 0;
    const levelDistribution: Record<number, number> = {};
    let totalMessages = 0;
    let totalVoiceMinutes = 0;
    let maxLevel = 0;

    for (const l of levels ?? []) {
      const bucket = Math.floor(l.level / 5) * 5; // 0-4, 5-9, 10-14, etc.
      levelDistribution[bucket] = (levelDistribution[bucket] ?? 0) + 1;
      totalMessages += l.total_messages ?? 0;
      totalVoiceMinutes += l.voice_minutes ?? 0;
      if (l.level > maxLevel) maxLevel = l.level;
    }

    const avgLevel = totalTrackedMembers > 0
      ? Math.round((levels?.reduce((s, l) => s + l.level, 0) ?? 0) / totalTrackedMembers * 10) / 10
      : 0;

    // ── Members ───────────────────────────────────────
    const { data: members } = await admin
      .from('members')
      .select('joined_at, left_at, is_returning')
      .eq('guild_id', ctx.guildId)
      .gte('joined_at', startIso);

    const joins = members?.length ?? 0;
    const returningJoins = members?.filter(m => m.is_returning).length ?? 0;

    const { count: leaves } = await admin
      .from('members')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId)
      .not('left_at', 'is', null)
      .gte('left_at', startIso);

    // ── Giveaways ─────────────────────────────────────
    const { data: giveaways } = await admin
      .from('giveaways')
      .select('status, entries, winners, created_at')
      .eq('guild_id', ctx.guildId)
      .gte('created_at', startIso);

    const totalGiveaways = giveaways?.length ?? 0;
    const totalEntries = giveaways?.reduce((s, g) => s + (g.entries?.length ?? 0), 0) ?? 0;
    const totalWinners = giveaways?.reduce((s, g) => s + (g.winners?.length ?? 0), 0) ?? 0;

    return NextResponse.json({
      success: true,
      data: {
        period,
        moderation: {
          totalInfractions,
          activeInfractions,
          pardonedInfractions,
          byType: infractionsByType,
          byDay: infractionsByDay,
        },
        tickets: {
          total: totalTickets,
          open: openTickets,
          closed: closedTickets,
          avgResolutionHours,
        },
        levels: {
          totalTrackedMembers,
          avgLevel,
          maxLevel,
          totalMessages,
          totalVoiceMinutes,
          distribution: levelDistribution,
        },
        members: {
          joins,
          returningJoins,
          leaves: leaves ?? 0,
          netGrowth: joins - (leaves ?? 0),
        },
        giveaways: {
          total: totalGiveaways,
          totalEntries,
          totalWinners,
        },
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
