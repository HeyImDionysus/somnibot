/**
 * Alert Service — Track automation failures and surface alerts to the owner.
 *
 * V53 Phase 2 (Finding 2.2 — M-5)
 *
 * Tracks consecutive failures per automation in Valkey.
 * After N failures (configurable, default 3):
 *   - Posts alert to owner's configured alert channel
 *   - Writes alert to the `alerts` table for dashboard badge
 *
 * Also provides generic alert posting for DLQ, heartbeat, etc.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { Guild, TextChannel } from 'discord.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('AlertService');

const FAILURE_COUNT_PREFIX = 'somnibot:auto_fail:';
const FAILURE_COUNT_TTL = 3600; // Reset after 1h of no failures
const DEFAULT_FAILURE_THRESHOLD = 3;

export interface AlertServiceConfig {
  /** Number of consecutive failures before alerting (default: 3) */
  failureThreshold?: number;
}

export class AlertService {
  private valkey: Valkey;
  private supabase: SupabaseClient;
  private guild: Guild;
  private failureThreshold: number;
  private alertChannelId: string | null = null;

  constructor(
    valkey: Valkey,
    supabase: SupabaseClient,
    guild: Guild,
    config?: AlertServiceConfig,
  ) {
    this.valkey = valkey;
    this.supabase = supabase;
    this.guild = guild;
    this.failureThreshold = config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  }

  /**
   * Initialize — load alert channel from guild config.
   */
  async init(): Promise<void> {
    try {
      const { data } = await this.supabase
        .from('guild_config')
        .select('alert_channel_id')
        .eq('guild_id', this.guild.id)
        .maybeSingle();
      this.alertChannelId = data?.alert_channel_id ?? null;
    } catch {
      // Non-fatal
    }
    log.info(
      `[AlertService] ✅ Initialized — threshold: ${this.failureThreshold}, ` +
        `alert channel: ${this.alertChannelId ?? 'not configured'}`,
    );
  }

  /**
   * Record a successful automation execution — resets the failure counter.
   */
  async recordSuccess(automationId: string): Promise<void> {
    try {
      const key = `${FAILURE_COUNT_PREFIX}${this.guild.id}:${automationId}`;
      await this.valkey.del(key);
    } catch {
      // Non-critical
    }
  }

  /**
   * Record a failed automation execution — increments counter and fires alert if threshold hit.
   */
  async recordFailure(
    automationId: string,
    automationName: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      const key = `${FAILURE_COUNT_PREFIX}${this.guild.id}:${automationId}`;
      const count = await this.valkey.incr(key);
      await this.valkey.expire(key, FAILURE_COUNT_TTL);

      if (count === this.failureThreshold) {
        await this.fireAutomationAlert(automationId, automationName, errorMessage, count);
      }
    } catch (err) {
      log.error('Failed to record failure:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Get the current failure count for an automation.
   */
  async getFailureCount(automationId: string): Promise<number> {
    try {
      const key = `${FAILURE_COUNT_PREFIX}${this.guild.id}:${automationId}`;
      const val = await this.valkey.get(key);
      return val ? parseInt(val, 10) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get all automation IDs with failures at or above threshold.
   * Used by the dashboard to show badge count.
   */
  async getFailingAutomationCount(): Promise<number> {
    try {
      const pattern = `${FAILURE_COUNT_PREFIX}${this.guild.id}:*`;
      let cursor = '0';
      let count = 0;

      do {
        const [nextCursor, keys] = await this.valkey.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;

        if (keys.length > 0) {
          const values = await this.valkey.mget(...keys);
          for (const val of values) {
            if (val && parseInt(val, 10) >= this.failureThreshold) {
              count++;
            }
          }
        }
      } while (cursor !== '0');

      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Post a generic alert to the owner's alert channel + alerts table.
   */
  async postAlert(
    alertType: string,
    severity: 'info' | 'warning' | 'critical',
    title: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    // Write to alerts table
    try {
      await this.supabase.from('alerts').insert({
        guild_id: this.guild.id,
        alert_type: alertType,
        severity,
        title,
        message,
        metadata: metadata ?? {},
      });
    } catch (err) {
      log.error('Failed to write alert to DB:', err instanceof Error ? err.message : err);
    }

    // Post to alert channel
    await this.postToAlertChannel(severity, title, message);
  }

  // ── Private ───────────────────────────────────────────────

  private async fireAutomationAlert(
    automationId: string,
    automationName: string,
    errorMessage: string,
    failureCount: number,
  ): Promise<void> {
    const title = `Automation "${automationName}" failing`;
    const message =
      `Automation \`${automationName}\` (${automationId}) has failed ` +
      `${failureCount} time(s) in a row.\n\nLatest error: ${errorMessage}`;

    // Write to alerts table
    try {
      await this.supabase.from('alerts').insert({
        guild_id: this.guild.id,
        alert_type: 'automation_failure',
        severity: 'warning' as const,
        title,
        message,
        metadata: { automationId, automationName, failureCount, lastError: errorMessage },
      });
    } catch (err) {
      log.error('Failed to write automation alert:', err instanceof Error ? err.message : err);
    }

    // Post to alert channel
    await this.postToAlertChannel('warning', title, message);
  }

  private async postToAlertChannel(
    severity: 'info' | 'warning' | 'critical',
    title: string,
    message: string,
  ): Promise<void> {
    if (!this.alertChannelId) return;

    try {
      const channel = this.guild.channels.cache.get(this.alertChannelId);
      if (!channel || !('send' in channel)) return;

      const emoji = severity === 'critical' ? '🛑' : severity === 'warning' ? '⚠️' : 'ℹ️';
      await (channel as TextChannel).send({
        embeds: [
          {
            title: `${emoji} ${title}`,
            description: message,
            color:
              severity === 'critical'
                ? 0xff0000
                : severity === 'warning'
                  ? 0xffcc00
                  : 0x3498db,
            timestamp: new Date().toISOString(),
            footer: { text: 'SomniBot Alert Service' },
          },
        ],
      });
    } catch (err) {
      log.error('Failed to post to alert channel:', err instanceof Error ? err.message : err);
    }
  }
}
