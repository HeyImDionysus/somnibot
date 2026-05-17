/**
 * DiagnosticsService — Writes periodic health snapshots for the dashboard.
 *
 * Architecture doc §33.4.
 *
 * Snapshots include: uptime, memory usage, Lavalink status, Valkey stats,
 * guild count, active voice connections, and automation stats.
 *
 * Writes to the `bot_diagnostics` table every 60 seconds.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SomniClient } from '../../client.js';

export class DiagnosticsService {
  private client: SomniClient;
  private supabase: SupabaseClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number;

  constructor(client: SomniClient, supabase: SupabaseClient) {
    this.client = client;
    this.supabase = supabase;
    this.startedAt = Date.now();
  }

  /**
   * Start writing periodic health snapshots.
   */
  start(): void {
    // Write an initial snapshot immediately
    void this.writeSnapshot();

    // Then every 60 seconds
    this.timer = setInterval(() => {
      void this.writeSnapshot();
    }, 60_000);

    console.log('[DiagnosticsService] ✅ Started — writing health snapshots every 60s');
  }

  /**
   * Stop the diagnostics service.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[DiagnosticsService] Stopped');
  }

  /**
   * Collect and write a health snapshot.
   */
  private async writeSnapshot(): Promise<void> {
    try {
      const memUsage = process.memoryUsage();

      // Lavalink status
      const lavalinkNodes: Array<{
        name: string;
        connected: boolean;
        players: number;
      }> = [];

      for (const [name, node] of this.client.shoukaku.nodes) {
        lavalinkNodes.push({
          name,
          connected: node.state === 1, // CONNECTED
          players: node.stats?.players ?? 0,
        });
      }

      // Valkey stats
      let valkeyConnected = false;
      let valkeyMemoryMb = 0;
      try {
        const info = await this.client.valkey.info('memory');
        valkeyConnected = true;
        const memMatch = info.match(/used_memory:(\d+)/);
        if (memMatch) {
          valkeyMemoryMb = Math.round(parseInt(memMatch[1]!, 10) / 1024 / 1024 * 100) / 100;
        }
      } catch {
        valkeyConnected = false;
      }

      // Guild stats
      const guild = this.client.guilds.cache.get(this.client.guildId);
      const guildMemberCount = guild?.memberCount ?? 0;
      const activeVoiceConnections = guild?.voiceStates.cache.filter(
        (vs) => vs.channelId !== null
      ).size ?? 0;

      // Scheduled message stats (from Valkey or just a count)
      let scheduledMessageCount = 0;
      try {
        const { data } = await this.supabase
          .from('scheduled_messages')
          .select('id', { count: 'exact', head: true })
          .eq('guild_id', this.client.guildId)
          .eq('enabled', true);
        scheduledMessageCount = (data as unknown as number) ?? 0;
      } catch {
        // ignore
      }

      // Automation stats
      let automationCount = 0;
      try {
        const { count } = await this.supabase
          .from('automations')
          .select('id', { count: 'exact', head: true })
          .eq('guild_id', this.client.guildId)
          .eq('enabled', true);
        automationCount = count ?? 0;
      } catch {
        // ignore
      }

      const snapshot = {
        guild_id: this.client.guildId,
        uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
        memory_rss_mb: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100,
        memory_heap_mb: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100,
        lavalink_nodes: lavalinkNodes,
        valkey_connected: valkeyConnected,
        valkey_memory_mb: valkeyMemoryMb,
        guild_member_count: guildMemberCount,
        active_voice_connections: activeVoiceConnections,
        scheduled_message_count: scheduledMessageCount,
        automation_count: automationCount,
        discord_ws_ping: this.client.ws.ping,
        snapshot_at: new Date().toISOString(),
      };

      // Upsert by guild_id (one row per guild)
      const { error } = await this.supabase
        .from('bot_diagnostics')
        .upsert(snapshot, { onConflict: 'guild_id' });

      if (error) {
        console.error('[DiagnosticsService] Failed to write snapshot:', error.message);
      }
    } catch (err) {
      console.error('[DiagnosticsService] Snapshot error:', err);
    }
  }
}
