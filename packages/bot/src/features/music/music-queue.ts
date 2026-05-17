/**
 * Music Queue — Valkey-backed persistent queue for the music player.
 *
 * Architecture doc §29.3
 *
 * Stores full queue state as JSON in Valkey so the queue survives
 * bot restarts. Each guild has exactly one queue.
 */
import type Valkey from 'iovalkey';

// ── Types ─────────────────────────────────────────────────

export interface QueueEntry {
  /** Lavalink base64-encoded track string */
  track: string;
  title: string;
  author: string;
  /** Duration in milliseconds */
  duration: number;
  uri: string;
  artworkUrl: string | null;
  /** Discord user ID who requested this track */
  requestedBy: string;
  /** Timestamp when added */
  addedAt: number;
}

export type LoopMode = 'off' | 'track' | 'queue';

export interface GuildQueue {
  guildId: string;
  /** Voice channel the bot is connected to */
  voiceChannelId: string;
  /** Text channel where commands are issued */
  textChannelId: string;
  entries: QueueEntry[];
  currentIndex: number;
  loopMode: LoopMode;
  /** 0–100 */
  volume: number;
  shuffled: boolean;
  paused: boolean;
}

// ── Valkey Key Helpers ────────────────────────────────────

function queueKey(guildId: string): string {
  return `queue:${guildId}`;
}

function nowPlayingKey(guildId: string): string {
  return `nowplaying:${guildId}`;
}

function voteSkipKey(guildId: string): string {
  return `music:votes:${guildId}:skip`;
}

// ── Queue Manager ─────────────────────────────────────────

export class MusicQueueManager {
  constructor(private readonly valkey: Valkey) {}

  /** Get the queue for a guild, or null if none exists. */
  async getQueue(guildId: string): Promise<GuildQueue | null> {
    const raw = await this.valkey.get(queueKey(guildId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as GuildQueue;
    } catch {
      return null;
    }
  }

  /** Save the full queue state. */
  async saveQueue(queue: GuildQueue): Promise<void> {
    await this.valkey.set(queueKey(queue.guildId), JSON.stringify(queue));
  }

  /** Create a fresh queue. */
  createQueue(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string,
    defaultVolume: number,
  ): GuildQueue {
    return {
      guildId,
      voiceChannelId,
      textChannelId,
      entries: [],
      currentIndex: 0,
      loopMode: 'off',
      volume: defaultVolume,
      shuffled: false,
      paused: false,
    };
  }

  /** Destroy the queue (bot leaving voice). */
  async destroyQueue(guildId: string): Promise<void> {
    await this.valkey.del(queueKey(guildId));
    await this.valkey.del(nowPlayingKey(guildId));
    await this.clearVoteSkip(guildId);
  }

  // ── Queue Operations ──────────────────────────────────

  /** Add entries to the end of the queue. Returns updated queue. */
  async addEntries(guildId: string, entries: QueueEntry[]): Promise<GuildQueue | null> {
    const queue = await this.getQueue(guildId);
    if (!queue) return null;
    queue.entries.push(...entries);
    await this.saveQueue(queue);
    return queue;
  }

  /** Remove an entry by index. Returns the removed entry or null. */
  async removeEntry(guildId: string, index: number): Promise<QueueEntry | null> {
    const queue = await this.getQueue(guildId);
    if (!queue || index < 0 || index >= queue.entries.length) return null;
    const [removed] = queue.entries.splice(index, 1);
    // Adjust currentIndex if needed
    if (index < queue.currentIndex) {
      queue.currentIndex = Math.max(0, queue.currentIndex - 1);
    } else if (index === queue.currentIndex && queue.currentIndex >= queue.entries.length) {
      queue.currentIndex = Math.max(0, queue.entries.length - 1);
    }
    await this.saveQueue(queue);
    return removed ?? null;
  }

  /** Move an entry from one position to another. */
  async moveEntry(guildId: string, from: number, to: number): Promise<boolean> {
    const queue = await this.getQueue(guildId);
    if (!queue) return false;
    if (from < 0 || from >= queue.entries.length) return false;
    if (to < 0 || to >= queue.entries.length) return false;
    const [entry] = queue.entries.splice(from, 1);
    if (!entry) return false;
    queue.entries.splice(to, 0, entry);
    // Adjust currentIndex
    if (from === queue.currentIndex) {
      queue.currentIndex = to;
    } else {
      if (from < queue.currentIndex && to >= queue.currentIndex) {
        queue.currentIndex--;
      } else if (from > queue.currentIndex && to <= queue.currentIndex) {
        queue.currentIndex++;
      }
    }
    await this.saveQueue(queue);
    return true;
  }

  /** Shuffle the queue (entries after currentIndex). */
  async shuffle(guildId: string): Promise<boolean> {
    const queue = await this.getQueue(guildId);
    if (!queue) return false;
    const upcoming = queue.entries.splice(queue.currentIndex + 1);
    // Fisher-Yates shuffle
    for (let i = upcoming.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [upcoming[i], upcoming[j]] = [upcoming[j]!, upcoming[i]!];
    }
    queue.entries.push(...upcoming);
    queue.shuffled = true;
    await this.saveQueue(queue);
    return true;
  }

  /** Clear all entries from the queue (keeps the queue alive). */
  async clearQueue(guildId: string): Promise<boolean> {
    const queue = await this.getQueue(guildId);
    if (!queue) return false;
    queue.entries = [];
    queue.currentIndex = 0;
    await this.saveQueue(queue);
    return true;
  }

  /** Get the current track, or null. */
  async getCurrentTrack(guildId: string): Promise<QueueEntry | null> {
    const queue = await this.getQueue(guildId);
    if (!queue || queue.currentIndex >= queue.entries.length) return null;
    return queue.entries[queue.currentIndex] ?? null;
  }

  /** Advance to the next track. Returns the next track or null if queue ended. */
  async nextTrack(guildId: string): Promise<{ track: QueueEntry | null; queueEnded: boolean }> {
    const queue = await this.getQueue(guildId);
    if (!queue) return { track: null, queueEnded: true };

    if (queue.loopMode === 'track') {
      // Replay the same track
      const current = queue.entries[queue.currentIndex] ?? null;
      return { track: current, queueEnded: !current };
    }

    const nextIndex = queue.currentIndex + 1;

    if (nextIndex >= queue.entries.length) {
      if (queue.loopMode === 'queue' && queue.entries.length > 0) {
        // Loop back to start
        queue.currentIndex = 0;
        await this.saveQueue(queue);
        return { track: queue.entries[0] ?? null, queueEnded: false };
      }
      // Queue ended
      return { track: null, queueEnded: true };
    }

    queue.currentIndex = nextIndex;
    await this.saveQueue(queue);
    return { track: queue.entries[nextIndex] ?? null, queueEnded: false };
  }

  // ── Now Playing Message ID ────────────────────────────

  async setNowPlayingMessage(guildId: string, messageId: string): Promise<void> {
    await this.valkey.set(nowPlayingKey(guildId), messageId, 'EX', 7200); // 2h TTL
  }

  async getNowPlayingMessage(guildId: string): Promise<string | null> {
    return this.valkey.get(nowPlayingKey(guildId));
  }

  async clearNowPlayingMessage(guildId: string): Promise<void> {
    await this.valkey.del(nowPlayingKey(guildId));
  }

  // ── Vote Skip ─────────────────────────────────────────

  async addVoteSkip(guildId: string, userId: string): Promise<number> {
    await this.valkey.sadd(voteSkipKey(guildId), userId);
    return this.valkey.scard(voteSkipKey(guildId));
  }

  async getVoteSkipCount(guildId: string): Promise<number> {
    return this.valkey.scard(voteSkipKey(guildId));
  }

  async hasVotedSkip(guildId: string, userId: string): Promise<boolean> {
    return (await this.valkey.sismember(voteSkipKey(guildId), userId)) === 1;
  }

  async clearVoteSkip(guildId: string): Promise<void> {
    await this.valkey.del(voteSkipKey(guildId));
  }
}
