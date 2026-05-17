/**
 * /api/diagnostics — Bot health and system diagnostics.
 *
 * GET: Returns the latest health snapshot from bot_diagnostics,
 *      plus Supabase health check and webhook processing stats.
 *
 * Architecture doc §33.4.
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  const supabase = createAdminSupabase();

  // Get latest bot diagnostics snapshot
  const { data: botHealth, error: botError } = await supabase
    .from('bot_diagnostics')
    .select('*')
    .eq('guild_id', GUILD_ID)
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
    .eq('guild_id', GUILD_ID)
    .in('action', ['sync.completed', 'setup.deployed'])
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Get last drift
  const { data: lastDrift } = await supabase
    .from('audit_logs')
    .select('timestamp, details')
    .eq('guild_id', GUILD_ID)
    .eq('action', 'drift.detected')
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Determine bot online status
  const snapshotAt = botHealth?.snapshot_at ? new Date(botHealth.snapshot_at).getTime() : 0;
  const isOnline = Date.now() - snapshotAt < 120_000; // Within 2 minutes

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
    },
  });
}
