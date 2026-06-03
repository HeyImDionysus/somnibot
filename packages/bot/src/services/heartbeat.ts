/**
 * Heartbeat Service — Lets the dashboard know the bot is alive.
 *
 * V5 Audit Fix #9 — Consolidated from per-guild to bot-level.
 * One Valkey key, one Supabase row. Removes 2 timers per guild,
 * replaces with 2 timers total.
 *
 * Writes to Valkey every 30s (key: somnibot:heartbeat:bot).
 * Writes to Supabase every 60s as fallback (guild_id = primary guild).
 *
 * Payload includes guildCount, uptime, memoryUsageMB so the dashboard
 * can assess bot health from a single read.
 *
 * Dashboard reads:
 *   - Stale >90s: yellow banner "⚠️ Bot appears offline"
 *   - Stale >5min: red banner "🛑 Bot is offline"
 *   - On reconnect: banner auto-clears
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { Client } from 'discord.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Heartbeat');

const VALKEY_HEARTBEAT_KEY = 'somnibot:heartbeat:bot';
// V11 Audit L-2: Legacy per-guild prefix kept ONLY for backwards-compatible reads.
// Writes to the per-guild key are removed (see writeValkeyHeartbeat).
const VALKEY_HEARTBEAT_KEY_PREFIX = 'somnibot:heartbeat:';
const VALKEY_HEARTBEAT_TTL = 120; // 2 minutes — auto-expires if bot dies
const VALKEY_INTERVAL_MS = 30_000; // 30 seconds
const SUPABASE_INTERVAL_MS = 60_000; // 60 seconds

export class HeartbeatService {
  private valkey: Valkey;
  private supabase: SupabaseClient;
  private primaryGuildId: string;
  private client: Client | null;
  private valkeyTimer: ReturnType<typeof setInterval> | null = null;
  private supabaseTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number;

  constructor(valkey: Valkey, supabase: SupabaseClient, primaryGuildId: string, client?: Client) {
    this.valkey = valkey;
    this.supabase = supabase;
    this.primaryGuildId = primaryGuildId;
    this.client = client ?? null;
    this.startedAt = Date.now();
  }

  /**
   * Start sending heartbeats.
   */
  start(): void {
    // Immediate first heartbeat
    void this.writeValkeyHeartbeat();
    void this.writeSupabaseHeartbeat();

    this.valkeyTimer = setInterval(() => {
      void this.writeValkeyHeartbeat();
    }, VALKEY_INTERVAL_MS);

    this.supabaseTimer = setInterval(() => {
      void this.writeSupabaseHeartbeat();
    }, SUPABASE_INTERVAL_MS);

    log.info('Started — bot-level heartbeat (Valkey 30s, Supabase 60s)');
  }

  /**
   * Stop sending heartbeats.
   */
  stop(): void {
    if (this.valkeyTimer) {
      clearInterval(this.valkeyTimer);
      this.valkeyTimer = null;
    }
    if (this.supabaseTimer) {
      clearInterval(this.supabaseTimer);
      this.supabaseTimer = null;
    }
    log.info('Stopped');
  }

  /**
   * Write heartbeat to Valkey with TTL.
   * Stores timestamp + uptime + guildCount + memory so the dashboard
   * can determine freshness and overall health from a single key.
   *
   * V11 Audit H-2 + L-2: Only write the bot-level key. The per-guild key
   * was a backwards-compat measure that added an unnecessary Valkey write
   * every tick and only covered the primary guild — non-primary guilds
   * never got a heartbeat key, so the dashboard showed them as offline.
   * readHeartbeat() already falls back to the per-guild key for old data.
   */
  private async writeValkeyHeartbeat(): Promise<void> {
    try {
      const memUsage = process.memoryUsage();
      const payload = JSON.stringify({
        timestamp: Date.now(),
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        guildCount: this.client?.guilds.cache.size ?? 0,
        memoryUsageMB: Math.round(memUsage.rss / 1024 / 1024),
      });

      // Write bot-level key only
      await this.valkey.set(VALKEY_HEARTBEAT_KEY, payload, 'EX', VALKEY_HEARTBEAT_TTL);
    } catch (err) {
      log.warn('Valkey write failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Write heartbeat to Supabase as fallback (survives Valkey outages).
   */
  private async writeSupabaseHeartbeat(): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('bot_diagnostics')
        .upsert(
          {
            guild_id: this.primaryGuildId,
            type: 'heartbeat',
            snapshot_at: new Date().toISOString(),
            uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
          },
          { onConflict: 'guild_id,type' },
        );

      if (error) {
        log.warn('Supabase write failed:', error.message);
      }
    } catch (err) {
      log.warn('Supabase write error:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Read heartbeat data (used by dashboard API).
 * Tries bot-level key first, falls back to per-guild key.
 * Returns null if no heartbeat exists.
 */
export async function readHeartbeat(
  valkey: Valkey,
  guildId: string,
): Promise<{ timestamp: number; uptimeSeconds: number; guildCount?: number; memoryUsageMB?: number } | null> {
  try {
    // Try bot-level key first
    let raw = await valkey.get(VALKEY_HEARTBEAT_KEY);
    if (!raw) {
      // Fallback to per-guild key (backwards compat)
      const key = `${VALKEY_HEARTBEAT_KEY_PREFIX}${guildId}`;
      raw = await valkey.get(key);
    }
    if (!raw) return null;
    return JSON.parse(raw) as { timestamp: number; uptimeSeconds: number; guildCount?: number; memoryUsageMB?: number };
  } catch {
    return null;
  }
}
