/**
 * GET /api/dashboard/stats — Live dashboard metrics.
 *
 * Returns counts and aggregates for the dashboard home page:
 * - Members (from last guild snapshot)
 * - Messages today (from daily_stats or audit count)
 * - Active tickets, open infractions
 * - Revenue this month
 * - Music plays today
 * - Active giveaways
 * - Recent activity feed
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';

export async function GET() {
  try {
    const ctx = await requirePermission(null);
    const admin = createAdminSupabase();
    const guildId = ctx.guildId;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Run all queries in parallel
    const [
      snapshotResult,
      ticketResult,
      infractionResult,
      revenueResult,
      giveawayResult,
      recentEventsResult,
    ] = await Promise.all([
      // Latest guild snapshot for member counts
      admin
        .from('guild_snapshots')
        .select('member_count, online_count, message_count_today')
        .eq('guild_id', guildId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      // Active tickets
      admin
        .from('tickets')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', guildId)
        .in('status', ['open', 'claimed']),

      // Active infractions
      admin
        .from('infractions')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', guildId)
        .eq('active', true)
        .eq('pardoned', false),

      // Revenue this month
      admin
        .from('orders')
        .select('total_cents')
        .eq('guild_id', guildId)
        .eq('status', 'completed')
        .gte('created_at', monthStart),

      // Active giveaways
      admin
        .from('giveaways')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', guildId)
        .eq('status', 'active'),

      // Recent audit log events for activity feed
      admin
        .from('audit_logs')
        .select('action, details, created_at')
        .eq('guild_id', guildId)
        .order('created_at', { ascending: false })
        .limit(15),
    ]);

    // Calculate revenue
    const revenueThisMonth = revenueResult.data
      ? revenueResult.data.reduce((sum: number, o: { total_cents?: number }) => sum + (o.total_cents ?? 0), 0)
      : 0;

    // Format recent events
    const recentEvents = (recentEventsResult.data ?? []).map((log: Record<string, unknown>) => ({
      type: formatEventType(log.action as string),
      description: formatEventDescription(log.action as string, log.details as Record<string, unknown>),
      timestamp: log.created_at as string,
    })).filter((e: { description: string }) => e.description !== '');

    // Music plays (from Valkey stats, stored in daily_stats table if available)
    let musicPlaysToday = 0;
    try {
      const { data: musicStats } = await admin
        .from('daily_stats')
        .select('value')
        .eq('guild_id', guildId)
        .eq('stat_key', 'music_plays')
        .eq('date', todayStart.slice(0, 10))
        .maybeSingle();
      musicPlaysToday = musicStats?.value ?? 0;
    } catch {
      // daily_stats table may not exist yet — non-fatal
    }

    return NextResponse.json({
      memberCount: snapshotResult.data?.member_count ?? 0,
      onlineCount: snapshotResult.data?.online_count ?? 0,
      messagesToday: snapshotResult.data?.message_count_today ?? 0,
      activeTickets: ticketResult.count ?? 0,
      openInfractions: infractionResult.count ?? 0,
      revenueThisMonth,
      musicPlaysToday,
      activeGiveaways: giveawayResult.count ?? 0,
      recentEvents,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[API] Dashboard stats error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

function formatEventType(action: string): string {
  if (action.startsWith('ticket.')) return `ticket.${action.split('.')[1]}`;
  if (action.startsWith('moderation.') || action.includes('warn') || action.includes('ban') || action.includes('kick'))
    return `moderation.${action.split('.').pop()}`;
  if (action.includes('purchase') || action.includes('fulfillment'))
    return 'purchase.completed';
  if (action.includes('member') && action.includes('join'))
    return 'member.joined';
  if (action.includes('giveaway'))
    return 'giveaway.ended';
  return action;
}

function formatEventDescription(action: string, details: Record<string, unknown> | null): string {
  if (!details) return '';

  switch (action) {
    case 'ticket.opened':
      return `New ticket opened${details.ticketNumber ? ` #${details.ticketNumber}` : ''}`;
    case 'ticket.closed':
      return `Ticket closed${details.ticketNumber ? ` #${details.ticketNumber}` : ''}`;
    case 'moderation.warn':
    case 'bot.warn':
      return `Warning issued${details.reason ? `: ${String(details.reason).slice(0, 60)}` : ''}`;
    case 'moderation.ban':
    case 'bot.ban':
      return `Member banned${details.reason ? `: ${String(details.reason).slice(0, 60)}` : ''}`;
    case 'moderation.kick':
    case 'bot.kick':
      return `Member kicked${details.reason ? `: ${String(details.reason).slice(0, 60)}` : ''}`;
    case 'fulfillment.one_time_purchase':
    case 'purchase_fulfilled':
      return `Purchase fulfilled: ${details.product_name ?? details.productName ?? 'product'}`;
    case 'bot.started':
      return 'Bot started';
    case 'bot.create_role':
      return `Role created: ${details.result && typeof details.result === 'object' ? (details.result as Record<string, unknown>).name : 'role'}`;
    case 'bot.create_channel':
      return `Channel created: ${details.result && typeof details.result === 'object' ? (details.result as Record<string, unknown>).name : 'channel'}`;
    default:
      return '';
  }
}
