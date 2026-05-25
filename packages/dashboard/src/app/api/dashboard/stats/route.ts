/**
 * GET /api/dashboard/stats — Live dashboard metrics.
 *
 * Returns counts and aggregates for the dashboard home page:
 * - Members (from bot_diagnostics snapshot)
 * - Active tickets, open infractions
 * - Revenue this month (from orders)
 * - Active giveaways
 * - Uptime (from bot_diagnostics)
 * - Recent activity feed (from audit_logs)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission(null);
    const admin = createAdminSupabase();
    const guildId = ctx.guildId;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Run all queries in parallel
    const [
      diagnosticsResult,
      memberCountResult,
      ticketResult,
      infractionResult,
      revenueResult,
      giveawayResult,
      recentEventsResult,
      todayMessagesResult,
    ] = await Promise.all([
      // Latest bot_diagnostics snapshot for uptime + member count
      admin
        .from('bot_diagnostics')
        .select('guild_member_count, uptime_seconds, discord_ws_ping, active_voice_connections, valkey_connected, memory_rss_mb, snapshot_at')
        .eq('guild_id', guildId)
        .eq('type', 'health')
        .order('snapshot_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      // Total tracked members
      admin
        .from('members')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', guildId),

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
        .is('pardoned', false),

      // Revenue this month
      admin
        .from('orders')
        .select('amount_cents')
        .eq('guild_id', guildId)
        .eq('status', 'completed')
        .gte('created_at', monthStart)
        .limit(1000),

      // Active giveaways
      admin
        .from('giveaways')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', guildId)
        .eq('status', 'active'),

      // Recent audit log events for activity feed
      admin
        .from('audit_logs')
        .select('action, details, timestamp, actor_id, target_id, target_type, success')
        .eq('guild_id', guildId)
        .order('timestamp', { ascending: false })
        .limit(15),

      // Messages today — count audit log entries that represent messages
      // (bot_diagnostics doesn't track message counts, so we approximate from members)
      admin
        .from('audit_logs')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', guildId)
        .gte('timestamp', new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()),
    ]);

    // Calculate revenue
    const revenueThisMonth = revenueResult.data
      ? revenueResult.data.reduce(
          (sum: number, o: { amount_cents?: number }) => sum + (o.amount_cents ?? 0),
          0,
        )
      : 0;

    // Format recent events
    const recentEvents = (recentEventsResult.data ?? [])
      .map((log: Record<string, unknown>) => ({
        type: formatEventType(log.action as string),
        description: formatEventDescription(
          log.action as string,
          log.details as Record<string, unknown>,
        ),
        timestamp: log.timestamp as string,
        success: log.success as boolean,
      }))
      .filter((e: { description: string }) => e.description !== '');

    // Uptime formatting
    const uptimeSeconds = diagnosticsResult.data?.uptime_seconds ?? 0;
    const uptimeHours = Math.floor(uptimeSeconds / 3600);
    const uptimeDays = Math.floor(uptimeHours / 24);
    const uptimeDisplay =
      uptimeDays > 0
        ? `${uptimeDays}d ${uptimeHours % 24}h`
        : uptimeHours > 0
          ? `${uptimeHours}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`
          : `${Math.floor(uptimeSeconds / 60)}m`;

    // Bot is online only if the last diagnostics snapshot is recent (within 2 minutes)
    const lastSnapshot = diagnosticsResult.data?.snapshot_at ?? null;
    const botOnline = lastSnapshot
      ? (now.getTime() - new Date(lastSnapshot).getTime()) < 120_000
      : false;

    return NextResponse.json({
      botOnline,
      memberCount: diagnosticsResult.data?.guild_member_count ?? memberCountResult.count ?? 0,
      trackedMembers: memberCountResult.count ?? 0,
      activeTickets: ticketResult.count ?? 0,
      openInfractions: infractionResult.count ?? 0,
      revenueThisMonth,
      activeGiveaways: giveawayResult.count ?? 0,
      recentEvents,
      eventsToday: todayMessagesResult.count ?? 0,
      uptime: botOnline ? uptimeDisplay : null,
      uptimeSeconds: botOnline ? uptimeSeconds : 0,
      wsPing: botOnline ? (diagnosticsResult.data?.discord_ws_ping ?? null) : null,
      activeVoice: botOnline ? (diagnosticsResult.data?.active_voice_connections ?? 0) : 0,
      valkeyConnected: botOnline ? (diagnosticsResult.data?.valkey_connected ?? false) : false,
      memoryMb: botOnline ? (diagnosticsResult.data?.memory_rss_mb ?? null) : null,
      lastSnapshot,
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
  if (
    action.startsWith('moderation.') ||
    action.includes('warn') ||
    action.includes('ban') ||
    action.includes('kick')
  )
    return `moderation.${action.split('.').pop()}`;
  if (action.includes('purchase') || action.includes('fulfillment')) return 'purchase.completed';
  if (action.includes('member') && action.includes('join')) return 'member.joined';
  if (action.includes('giveaway')) return 'giveaway.ended';
  return action;
}

function formatEventDescription(
  action: string,
  details: Record<string, unknown> | null,
): string {
  if (!details) {
    // Some actions make sense without details
    switch (action) {
      case 'bot.started':
        return 'Bot started';
      default:
        return '';
    }
  }

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
    case 'moderation.mute':
    case 'bot.mute':
      return `Member muted${details.reason ? `: ${String(details.reason).slice(0, 60)}` : ''}`;
    case 'fulfillment.one_time_purchase':
    case 'purchase_fulfilled':
      return `Purchase fulfilled: ${details.product_name ?? details.productName ?? 'product'}`;
    case 'fulfillment.subscription_activated':
      return `Subscription activated: ${details.product_name ?? 'plan'}`;
    case 'bot.started':
      return 'Bot started';
    case 'bot.create_role':
      return `Role created: ${details.result && typeof details.result === 'object' ? (details.result as Record<string, unknown>).name : 'role'}`;
    case 'bot.create_channel':
      return `Channel created: ${details.result && typeof details.result === 'object' ? (details.result as Record<string, unknown>).name : 'channel'}`;
    case 'giveaway.ended':
      return `Giveaway ended: ${details.prize ?? 'giveaway'}`;
    case 'giveaway.started':
      return `Giveaway started: ${details.prize ?? 'giveaway'}`;
    default:
      return '';
  }
}
