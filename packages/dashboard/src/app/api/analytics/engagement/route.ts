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
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

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
    // V5 audit 7.1 — safety LIMIT caps on period-bounded queries
    const { data: infractions } = await admin
      .from('infractions')
      .select('type, created_at, active, pardoned')
      .eq('guild_id', ctx.guildId)
      .gte('created_at', startIso)
      .limit(1000);

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
      .gte('created_at', startIso)
      .limit(1000);

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

    // ── Levels (V31 perf fix: use Postgres aggregates instead of unbounded SELECT) ──
    const { data: levelAgg } = await admin
      .rpc('aggregate_member_levels', { p_guild_id: ctx.guildId })
      .maybeSingle();

    // Fallback: if the RPC doesn't exist yet, use a bounded count + minimal query
    let totalTrackedMembers: number;
    let totalMessages: number;
    let totalVoiceMinutes: number;
    let maxLevel: number;
    let avgLevel: number;
    let levelDistribution: Record<number, number>;

    // V10 Audit §7.P3a — Typed interface for the RPC aggregate result
    interface LevelAggResult {
      total_members?: number;
      total_messages?: number;
      total_voice_minutes?: number;
      max_level?: number;
      avg_level?: number;
      level_distribution?: Record<number, number>;
    }
    const agg = levelAgg as LevelAggResult | null;
    if (agg) {
      totalTrackedMembers = agg.total_members ?? 0;
      totalMessages = agg.total_messages ?? 0;
      totalVoiceMinutes = agg.total_voice_minutes ?? 0;
      maxLevel = agg.max_level ?? 0;
      avgLevel = agg.avg_level ?? 0;
      levelDistribution = (agg.level_distribution as Record<number, number>) ?? {};
    } else {
      // Graceful fallback: aggregate via count query + capped level fetch
      const { count } = await admin
        .from('member_levels')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', ctx.guildId);

      totalTrackedMembers = count ?? 0;

      const { data: aggRow } = await admin
        .from('member_levels')
        .select('level, total_messages, voice_minutes')
        .eq('guild_id', ctx.guildId)
        .limit(1000);

      levelDistribution = {};
      totalMessages = 0;
      totalVoiceMinutes = 0;
      maxLevel = 0;
      let levelSum = 0;

      for (const l of aggRow ?? []) {
        const bucket = Math.floor(l.level / 5) * 5;
        levelDistribution[bucket] = (levelDistribution[bucket] ?? 0) + 1;
        totalMessages += l.total_messages ?? 0;
        totalVoiceMinutes += l.voice_minutes ?? 0;
        if (l.level > maxLevel) maxLevel = l.level;
        levelSum += l.level;
      }
      avgLevel = totalTrackedMembers > 0
        ? Math.round(levelSum / (aggRow?.length || 1) * 10) / 10
        : 0;
    }

    // ── Members ───────────────────────────────────────
    const { data: members } = await admin
      .from('members')
      .select('joined_at, left_at, is_returning')
      .eq('guild_id', ctx.guildId)
      .gte('joined_at', startIso)
      .limit(1000);

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
      .gte('created_at', startIso)
      .limit(1000);

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
