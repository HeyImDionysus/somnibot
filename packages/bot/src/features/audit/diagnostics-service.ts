/**
 * DiagnosticsService — Writes periodic health snapshots for the dashboard.
 *
 * Architecture doc §33.4.
 * Phase C: Now integrates AlertManager for threshold-based alerting.
 *
 * Snapshots include: uptime, memory usage, Lavalink status, Valkey stats,
 * guild count, active voice connections, and automation stats.
 *
 * Writes to the `bot_diagnostics` table every 60 seconds.
 * After each snapshot, evaluates alert thresholds via AlertManager.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { BOOT_ID } from '../../services/boot-identity.js';
import { randomInt } from 'node:crypto';
import type { SomniClient } from '../../client.js';
import { AlertManager, type AlertThresholds } from './alert-manager.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Diagnostics');

export class DiagnosticsService {
  private client: SomniClient;
  private supabase: SupabaseClient;
  private guildId: string;
  private alertManager: AlertManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number;

  constructor(
    client: SomniClient,
    supabase: SupabaseClient,
    guildIdOrAlertThresholds?: string | Partial<AlertThresholds>,
    alertThresholds?: Partial<AlertThresholds>,
    private readonly snapshotIntervalMs = 60_000,
  ) {
    this.client = client;
    this.supabase = supabase;
    this.guildId = typeof guildIdOrAlertThresholds === 'string'
      ? guildIdOrAlertThresholds
      : client.guildId;
    this.alertManager = new AlertManager(
      supabase,
      typeof guildIdOrAlertThresholds === 'string' ? alertThresholds : guildIdOrAlertThresholds,
      client.eventBus,
    );
    this.startedAt = Date.now();
  }

  /**
   * Start writing periodic health snapshots.
   */
  start(): void {
    // Write an initial snapshot immediately
    void this.writeSnapshot();

    // Then on the owner-configured cadence (bounded by the DB/API contract).
    const intervalMs = Math.max(10_000, Math.min(3_600_000, this.snapshotIntervalMs));
    this.timer = setInterval(() => {
      void this.writeSnapshot();
    }, intervalMs);

    log.info(`Started — writing health snapshots every ${intervalMs}ms (with alerts)`);
  }

  /**
   * Stop the diagnostics service.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('Stopped');
  }

  /**
   * Collect and write a health snapshot, then evaluate alert thresholds.
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
      const guild = this.client.guilds.cache.get(this.guildId);
      const guildMemberCount = guild?.memberCount ?? 0;
      const activeVoiceConnections = guild?.voiceStates.cache.filter(
        (vs) => vs.channelId !== null
      ).size ?? 0;

      // Scheduled message stats
      let scheduledMessageCount = 0;
      try {
        const { count } = await this.supabase
          .from('scheduled_messages')
          .select('id', { count: 'exact', head: true })
          .eq('guild_id', this.guildId)
          .eq('active', true);
        scheduledMessageCount = count ?? 0;
      } catch {
        // ignore
      }

      // Automation stats
      let automationCount = 0;
      try {
        const { count } = await this.supabase
          .from('automations')
          .select('id', { count: 'exact', head: true })
          .eq('guild_id', this.guildId)
          .eq('enabled', true);
        automationCount = count ?? 0;
      } catch {
        // ignore
      }

      const memoryRssMb = Math.round(memUsage.rss / 1024 / 1024 * 100) / 100;
      const memoryHeapMb = Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100;

      const snapshot = {
        guild_id: this.guildId,
        type: 'health',
        uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
        memory_rss_mb: memoryRssMb,
        memory_heap_mb: memoryHeapMb,
        lavalink_nodes: lavalinkNodes,
        valkey_connected: valkeyConnected,
        valkey_memory_mb: valkeyMemoryMb,
        guild_member_count: guildMemberCount,
        active_voice_connections: activeVoiceConnections,
        scheduled_message_count: scheduledMessageCount,
        automation_count: automationCount,
        discord_ws_ping: this.client.ws.ping,
        snapshot_at: new Date().toISOString(),
        // Pairs with guild_runtime_features.boot_id: health rows are written
        // per guild (heartbeats only for the primary), so THIS writer must
        // also identify its boot or every non-primary guild fails open.
        boot_id: BOOT_ID,
      };

      // Upsert by (guild_id, type) — composite PK supports multiple diagnostic types
      const { error } = await this.supabase
        .from('bot_diagnostics')
        .upsert(snapshot, { onConflict: 'guild_id,type' });

      if (error) {
        log.error('Failed to write snapshot:', error.message);
        // Snapshot write failure is a diagnostics-observability gap the owner
        // must be able to see after the fact — mirror it to the audit trail.
        this.client.eventBus.emit('diagnostics.snapshot_failed', this.guildId, {
          stage: 'write',
          error: error.message,
        });
      }

      // Evaluate alert thresholds
      await this.alertManager.evaluate({
        guild_id: this.guildId,
        memory_rss_mb: memoryRssMb,
        discord_ws_ping: this.client.ws.ping,
        valkey_connected: valkeyConnected,
        lavalink_nodes: lavalinkNodes,
      });

      // V53 Phase 2: Write latency metrics for sparkline trends
      await this.writeHealthMetrics(valkeyConnected);
    } catch (err) {
      log.error('Snapshot error:', { error: String(err) });
      // A thrown snapshot cycle (collection/threshold error) is also an
      // observability gap — surface it to the audit trail.
      this.client.eventBus.emit('diagnostics.snapshot_failed', this.guildId, {
        stage: 'collect',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Measure and write latency metrics to health_metrics table.
   * Metrics: db_latency, valkey_latency, ws_ping
   */
  private async writeHealthMetrics(valkeyConnected: boolean): Promise<void> {
    const guildId = this.guildId;
    const metrics: Array<{ guild_id: string; metric_type: string; value_ms: number }> = [];

    // 1. DB round-trip latency
    try {
      const dbStart = performance.now();
      await this.supabase.from('guild').select('id').eq('id', guildId).limit(1).maybeSingle();
      const dbLatency = Math.round((performance.now() - dbStart) * 100) / 100;
      metrics.push({ guild_id: guildId, metric_type: 'db_latency', value_ms: dbLatency });
    } catch {
      // skip
    }

    // 2. Valkey ping latency
    if (valkeyConnected) {
      try {
        const vkStart = performance.now();
        await this.client.valkey.ping();
        const vkLatency = Math.round((performance.now() - vkStart) * 100) / 100;
        metrics.push({ guild_id: guildId, metric_type: 'valkey_latency', value_ms: vkLatency });
      } catch {
        // skip
      }
    }

    // 3. Discord WebSocket ping
    const wsPing = this.client.ws.ping;
    if (wsPing >= 0) {
      metrics.push({ guild_id: guildId, metric_type: 'ws_ping', value_ms: wsPing });
    }

    if (metrics.length > 0) {
      try {
        await this.supabase.from('health_metrics').insert(metrics);
      } catch (err) {
        log.warn('Failed to write health metrics:', err instanceof Error ? err.message : err);
      }
    }

    // Cleanup old metrics periodically (every ~10 snapshots ≈ 10 min)
    // V8 Audit §14.P3a: crypto.randomInt for consistency with CSPRNG policy
    if (randomInt(100) < 10) {
      try {
        await this.supabase.rpc('cleanup_old_health_metrics');
      } catch {
        // Non-critical
      }
    }
  }
}
