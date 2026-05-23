/**
 * Bot Presence Manager — Rotating status messages.
 *
 * Cycles through presence statuses every 30 seconds:
 * - Member count
 * - Music status (if playing)
 * - Uptime
 * - Store product count
 * - Custom status from config
 */
import { ActivityType, type Client } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('BotPresence');

interface PresenceEntry {
  type: ActivityType;
  name: string;
}

export class BotPresenceManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentIndex = 0;
  private startedAt = Date.now();
  private customStatuses: string[] = [];

  constructor(
    private client: Client,
    private guildId: string,
    private supabase: SupabaseClient,
  ) {}

  start(intervalMs: number = 30_000): void {
    // Set initial presence
    this.updatePresence();

    this.timer = setInterval(() => {
      this.updatePresence();
    }, intervalMs);

    // Load custom statuses from config
    this.loadCustomStatuses();

    log.info('Bot presence rotation started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async loadCustomStatuses(): Promise<void> {
    try {
      const { data } = await this.supabase
        .from('guild_config')
        .select('custom_bot_statuses')
        .eq('guild_id', this.guildId)
        .maybeSingle();

      if (data?.custom_bot_statuses && Array.isArray(data.custom_bot_statuses)) {
        this.customStatuses = data.custom_bot_statuses;
      }
    } catch {
      // Non-fatal
    }
  }

  private async updatePresence(): Promise<void> {
    try {
      const entries = await this.buildPresenceEntries();
      if (entries.length === 0) return;

      const entry = entries[this.currentIndex % entries.length]!;
      this.currentIndex++;

      this.client.user?.setPresence({
        status: 'online',
        activities: [
          {
            type: entry.type,
            name: entry.name,
          },
        ],
      });
    } catch {
      // Non-fatal — presence is cosmetic
    }
  }

  private async buildPresenceEntries(): Promise<PresenceEntry[]> {
    const entries: PresenceEntry[] = [];
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) return entries;

    // Member count
    entries.push({
      type: ActivityType.Watching,
      name: `${guild.memberCount.toLocaleString()} members`,
    });

    // Music status — check if a player is active
    const musicPlayer = (this.client as unknown as Record<string, unknown>)._musicPlayer as {
      queueManager?: { getQueue?: (guildId: string) => Promise<{ nowPlaying?: unknown } | null> };
    } | undefined;
    if (musicPlayer?.queueManager?.getQueue) {
      try {
        const queue = await musicPlayer.queueManager.getQueue(this.guildId);
        if (queue?.nowPlaying) {
          const np = queue.nowPlaying as { info?: { title?: string } };
          entries.push({
            type: ActivityType.Listening,
            name: np.info?.title?.slice(0, 128) ?? 'music',
          });
        }
      } catch {
        // Non-fatal
      }
    }

    // Uptime
    const uptimeMs = Date.now() - this.startedAt;
    const hours = Math.floor(uptimeMs / 3_600_000);
    const minutes = Math.floor((uptimeMs % 3_600_000) / 60_000);
    if (hours > 0) {
      entries.push({
        type: ActivityType.Playing,
        name: `Uptime: ${hours}h ${minutes}m`,
      });
    }

    // Product count
    try {
      const { count } = await this.supabase
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('guild_id', this.guildId)
        .eq('active', true);

      if (count && count > 0) {
        entries.push({
          type: ActivityType.Watching,
          name: `${count} product${count > 1 ? 's' : ''} in the store`,
        });
      }
    } catch {
      // Non-fatal
    }

    // Custom statuses from config
    for (const status of this.customStatuses) {
      entries.push({
        type: ActivityType.Custom,
        name: status.slice(0, 128),
      });
    }

    return entries;
  }
}
