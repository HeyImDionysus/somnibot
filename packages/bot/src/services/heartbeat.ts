/**
 * Heartbeat Service — Lets the dashboard know the bot is alive.
 *
 * V53 Phase 2 (Finding 2.1 — M-4)
 *
 * Writes `config_sync_heartbeat` to Valkey every 30s.
 * Also writes `last_heartbeat` to Supabase guild row every 60s as fallback.
 *
 * Dashboard layout reads the Valkey key via the diagnostics API and shows:
 *   - Stale >90s: yellow banner "⚠️ Bot appears offline"
 *   - Stale >5min: red banner "🛑 Bot is offline"
 *   - On reconnect: banner auto-clears
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';

const VALKEY_HEARTBEAT_KEY_PREFIX = 'somnibot:heartbeat:';
const VALKEY_HEARTBEAT_TTL = 120; // 2 minutes — auto-expires if bot dies
const VALKEY_INTERVAL_MS = 30_000; // 30 seconds
const SUPABASE_INTERVAL_MS = 60_000; // 60 seconds

export class HeartbeatService {
  private valkey: Valkey;
  private supabase: SupabaseClient;
  private guildId: string;
  private valkeyTimer: ReturnType<typeof setInterval> | null = null;
  private supabaseTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number;

  constructor(valkey: Valkey, supabase: SupabaseClient, guildId: string) {
    this.valkey = valkey;
    this.supabase = supabase;
    this.guildId = guildId;
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

    console.log('[Heartbeat] ✅ Started — Valkey every 30s, Supabase every 60s');
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
    console.log('[Heartbeat] Stopped');
  }

  /**
   * Write heartbeat to Valkey with TTL.
   * Stores timestamp + uptime so the dashboard can determine freshness.
   */
  private async writeValkeyHeartbeat(): Promise<void> {
    try {
      const key = `${VALKEY_HEARTBEAT_KEY_PREFIX}${this.guildId}`;
      const payload = JSON.stringify({
        timestamp: Date.now(),
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      });
      await this.valkey.set(key, payload, 'EX', VALKEY_HEARTBEAT_TTL);
    } catch (err) {
      console.warn('[Heartbeat] Valkey write failed:', err instanceof Error ? err.message : err);
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
            guild_id: this.guildId,
            type: 'heartbeat',
            snapshot_at: new Date().toISOString(),
            uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
          },
          { onConflict: 'guild_id,type' },
        );

      if (error) {
        console.warn('[Heartbeat] Supabase write failed:', error.message);
      }
    } catch (err) {
      console.warn('[Heartbeat] Supabase write error:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Read heartbeat data (used by dashboard API).
 * Returns null if no heartbeat exists.
 */
export async function readHeartbeat(
  valkey: Valkey,
  guildId: string,
): Promise<{ timestamp: number; uptimeSeconds: number } | null> {
  try {
    const key = `${VALKEY_HEARTBEAT_KEY_PREFIX}${guildId}`;
    const raw = await valkey.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as { timestamp: number; uptimeSeconds: number };
  } catch {
    return null;
  }
}
