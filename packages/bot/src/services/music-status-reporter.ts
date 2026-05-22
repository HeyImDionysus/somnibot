/**
 * Music Status Reporter
 *
 * Periodically writes the current music player state to bot_diagnostics
 * so the dashboard can display live now-playing info without direct Valkey access.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MusicPlayerManager } from '../features/music/music-player.js';

export class MusicStatusReporter {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private musicPlayer: MusicPlayerManager,
    private supabase: SupabaseClient,
    private guildId: string,
  ) {}

  start(intervalMs: number = 15_000): void {
    this.report().catch((e: unknown) => { console.warn('[Music] Operation failed:', (e as Error)?.message ?? e); });
    this.timer = setInterval(() => {
      this.report().catch((err) => {
        console.error('[MusicStatusReporter] Error:', err);
      });
    }, intervalMs);
    console.log('[MusicStatusReporter] Started (15s interval)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async report(): Promise<void> {
    const status = await this.musicPlayer.getStatus();

    await this.supabase
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
      )
      .then(({ error }) => {
        if (error) console.warn('[MusicStatusReporter] Upsert error:', error.message);
      });
  }
}
