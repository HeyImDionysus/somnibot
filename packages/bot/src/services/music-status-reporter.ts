/**
 * Music Status Reporter
 *
 * Periodically writes the current music player state to bot_diagnostics
 * so the dashboard can display live now-playing info without direct Valkey access.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MusicPlayerManager } from '../features/music/music-player.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('MusicStatus');

export class MusicStatusReporter {
  private timer: NodeJS.Timeout | null = null;
  // V5 Audit §12.P3a: Track consecutive failures to avoid silent error streams.
  private consecutiveFailures = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;
  private disabled = false;

  constructor(
    private musicPlayer: MusicPlayerManager,
    private supabase: SupabaseClient,
    private guildId: string,
  ) {}

  start(intervalMs: number = 15_000): void {
    this.consecutiveFailures = 0;
    this.disabled = false;
    this.report().catch((e: unknown) => { log.warn('Operation failed:', (e as Error)?.message ?? e); });
    this.timer = setInterval(() => {
      if (this.disabled) return;
      this.report().catch((err) => {
        log.error('Error:', { error: String(err) });
      });
    }, intervalMs);
    log.info('Started (15s interval)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.disabled = false;
    this.consecutiveFailures = 0;
  }

  private async report(): Promise<void> {
    const status = await this.musicPlayer.getStatus();

    const { error } = await this.supabase
      .from('bot_diagnostics')
      .upsert(
        {
          guild_id: this.guildId,
          type: 'music_status',
          data: {
            now_playing: status.nowPlaying,
            queue: status.queue,
            listeners: status.listeners,
            updated_at: new Date().toISOString(),
          },
          snapshot_at: new Date().toISOString(),
        },
        { onConflict: 'guild_id,type' },
      );

    if (error) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= MusicStatusReporter.MAX_CONSECUTIVE_FAILURES) {
        log.error(
          `Music status reporter disabled after ${this.consecutiveFailures} consecutive failures. Last error: ${error.message}`,
        );
        this.disabled = true;
      } else {
        log.warn(`Upsert error (${this.consecutiveFailures}/${MusicStatusReporter.MAX_CONSECUTIVE_FAILURES}):`, error.message);
      }
    } else {
      // Reset on success
      this.consecutiveFailures = 0;
    }
  }
}
