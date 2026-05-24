/**
 * /api/diagnostics — Bot health and system diagnostics.
 *
 * GET: Returns the latest health snapshot from bot_diagnostics,
 *      plus Supabase health check and webhook processing stats.
 *
 * Architecture doc §33.4.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';


export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  // Get latest bot diagnostics snapshot
  const { data: botHealth, error: botError } = await supabase
    .from('bot_diagnostics')
    .select('*')
    .eq('guild_id', guildId)
    .eq('type', 'health')
    .maybeSingle();

  // Check Supabase health (if we got this far, it's working)
  const supabaseHealthy = !botError;

  // Get webhook stats
  const { data: webhookStats } = await supabase
    .from('webhook_events')
    .select('result')
    .order('processed_at', { ascending: false })
    .limit(100);

  const webhookCounts = {
    total: webhookStats?.length ?? 0,
    success: webhookStats?.filter((w) => w.result === 'success').length ?? 0,
    error: webhookStats?.filter((w) => w.result === 'error').length ?? 0,
    duplicate: webhookStats?.filter((w) => w.result === 'duplicate').length ?? 0,
    pending: webhookStats?.filter((w) => !w.result).length ?? 0,
  };

  // Get last sync info
  const { data: lastSync } = await supabase
    .from('audit_logs')
    .select('timestamp, details')
    .eq('guild_id', guildId)
    .in('action', ['sync.completed', 'setup.deployed'])
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Get last drift
  const { data: lastDrift } = await supabase
    .from('audit_logs')
    .select('timestamp, details')
    .eq('guild_id', guildId)
    .eq('action', 'drift.detected')
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();

  // V53 Phase 2: Get heartbeat row (fallback for when Valkey is unreachable from dashboard)
  const { data: heartbeatRow } = await supabase
    .from('bot_diagnostics')
    .select('snapshot_at, uptime_seconds')
    .eq('guild_id', guildId)
    .eq('type', 'heartbeat')
    .maybeSingle();

  // Determine bot online status — use heartbeat if available, else health snapshot
  const heartbeatAt = heartbeatRow?.snapshot_at ? new Date(heartbeatRow.snapshot_at).getTime() : 0;
  const snapshotAt = botHealth?.snapshot_at ? new Date(botHealth.snapshot_at).getTime() : 0;
  const latestPing = Math.max(heartbeatAt, snapshotAt);
  const staleSecs = latestPing > 0 ? (Date.now() - latestPing) / 1000 : Infinity;
  const isOnline = staleSecs < 120; // Within 2 minutes

  // V53 Phase 2: DLQ count
  const { count: dlqCount } = await supabase
    .from('action_queue_dlq')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId)
    .eq('acknowledged', false);

  // V53 Phase 2: Health metrics for sparklines (last 24h)
  const { data: healthMetrics } = await supabase
    .from('health_metrics')
    .select('metric_type, value_ms, recorded_at')
    .eq('guild_id', guildId)
    .gte('recorded_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order('recorded_at', { ascending: true })
    .limit(2000);

  // Group metrics by type
  const metricsByType: Record<string, Array<{ value: number; time: string }>> = {};
  for (const m of healthMetrics ?? []) {
    if (!metricsByType[m.metric_type]) {
      metricsByType[m.metric_type] = [];
    }
    metricsByType[m.metric_type]!.push({ value: Number(m.value_ms), time: m.recorded_at });
  }

  return NextResponse.json({
    success: true,
    data: {
      bot: {
        online: isOnline,
        uptimeSeconds: botHealth?.uptime_seconds ?? 0,
        memoryRssMb: botHealth?.memory_rss_mb ?? 0,
        memoryHeapMb: botHealth?.memory_heap_mb ?? 0,
        wsPing: botHealth?.discord_ws_ping ?? -1,
        guildMemberCount: botHealth?.guild_member_count ?? 0,
        activeVoiceConnections: botHealth?.active_voice_connections ?? 0,
        snapshotAt: botHealth?.snapshot_at ?? null,
        staleSecs: staleSecs === Infinity ? null : Math.round(staleSecs),
      },
      lavalink: {
        nodes: botHealth?.lavalink_nodes ?? [],
      },
      valkey: {
        connected: botHealth?.valkey_connected ?? false,
        memoryMb: botHealth?.valkey_memory_mb ?? 0,
      },
      supabase: {
        healthy: supabaseHealthy,
      },
      webhooks: webhookCounts,
      sync: {
        lastSync: lastSync?.timestamp ?? null,
        lastSyncDetails: lastSync?.details ?? null,
        lastDrift: lastDrift?.timestamp ?? null,
        lastDriftDetails: lastDrift?.details ?? null,
      },
      automations: {
        activeCount: botHealth?.automation_count ?? 0,
      },
      scheduledMessages: {
        activeCount: botHealth?.scheduled_message_count ?? 0,
      },
      dlq: {
        pendingCount: dlqCount ?? 0,
      },
      healthMetrics: metricsByType,
    },
  });
}
