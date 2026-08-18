/**
 * Music Queue — Valkey-backed persistent queue for the music player.
 *
 * Architecture doc §29.3
 *
 * Stores full queue state as JSON in Valkey so the queue survives
 * bot restarts. Each guild has exactly one queue.
 */
import { randomInt } from 'node:crypto';
import type Valkey from 'iovalkey';

// ── Types ─────────────────────────────────────────────────

export interface QueueEntry {
  /** Lavalink base64-encoded track string */
  track: string;
  title: string;
  author: string;
  /** Duration in milliseconds (0 for live streams) */
  duration: number;
  uri: string;
  artworkUrl: string | null;
  /** Discord user ID who requested this track */
  requestedBy: string;
  /** Timestamp when added */
  addedAt: number;
  /** Whether this is a live stream (no seek, no progress bar) */
  isStream?: boolean;
}

export type LoopMode = 'off' | 'track' | 'queue';
export type MusicRuntimeState = 'ready' | 'degraded' | 'recovering' | 'manual-reconcile';

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
  runtimeState: MusicRuntimeState;
  runtimeRevision: number;
  recoveryEpisodeId: string | null;
  runtimeError: string | null;
}

export type RuntimeRecoveryClaim = {
  readonly queue: GuildQueue;
  readonly token: string;
  readonly revision: number;
};

/**
 * V5 Audit [12.1]: Maximum number of entries allowed in a single guild's queue.
 * Prevents unbounded memory growth in Valkey (queue is serialized as JSON in
 * a single key). 5,000 tracks ≈ ~2.5 MB serialized — well within limits.
 */
const DEFAULT_MAX_QUEUE_SIZE = 5_000;

/**
 * V9 Audit §12.P2: Per-user queue limit — prevents a single user from
 * monopolizing the entire queue. Each user may have at most this many
 * entries queued (not counting the currently playing track).
 */
const DEFAULT_MAX_PER_USER_QUEUE = 50;

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

function runtimeRevisionKey(guildId: string): string {
  return `music:runtime:${guildId}:revision`;
}

function recoveryLockKey(guildId: string): string {
  return `music:runtime:${guildId}:recovery-lock`;
}

function outageEpisodeKey(guildId: string): string {
  return `music:runtime:${guildId}:outage-episode`;
}

// ── Queue Manager ─────────────────────────────────────────

export class MusicQueueManager {
  private maxQueueSize = DEFAULT_MAX_QUEUE_SIZE;
  private maxPerUserQueue = DEFAULT_MAX_PER_USER_QUEUE;

  constructor(private readonly valkey: Valkey) {}

  private async nextRuntimeRevision(guildId: string, persistedRevision: number): Promise<number> {
    await this.valkey.set(
      runtimeRevisionKey(guildId),
      String(persistedRevision),
      'NX',
    );
    return this.valkey.incr(runtimeRevisionKey(guildId));
  }

  /** Apply guild-configured limits loaded by MusicPlayerManager. */
  setLimits(limits: { maxQueueSize?: number; maxPerUserQueue?: number }): void {
    if (limits.maxQueueSize !== undefined) this.maxQueueSize = Math.max(1, Math.min(5_000, limits.maxQueueSize));
    if (limits.maxPerUserQueue !== undefined) this.maxPerUserQueue = Math.max(1, Math.min(500, limits.maxPerUserQueue));
  }

  /** Get the queue for a guild, or null if none exists. */
  async getQueue(guildId: string): Promise<GuildQueue | null> {
    const raw = await this.valkey.get(queueKey(guildId));
    if (!raw) return null;
    try {
      const queue = JSON.parse(raw) as GuildQueue;
      queue.runtimeState ??= 'ready';
      queue.runtimeRevision ??= 0;
      queue.recoveryEpisodeId ??= null;
      queue.runtimeError ??= null;
      return queue;
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
      runtimeState: 'ready',
      runtimeRevision: 0,
      recoveryEpisodeId: null,
      runtimeError: null,
    };
  }

  async beginRuntimeOutage(
    guildId: string,
    episodeId: string,
    reason: string,
  ): Promise<{ queue: GuildQueue | null; newEpisode: boolean }> {
    const created = await this.valkey.set(outageEpisodeKey(guildId), episodeId, 'EX', 86_400, 'NX');
    const queue = await this.getQueue(guildId);
    if (!queue) {
      if (created === 'OK') await this.valkey.del(outageEpisodeKey(guildId));
      return { queue: null, newEpisode: false };
    }
    if (created !== 'OK') {
      const existingEpisodeId = await this.valkey.get(outageEpisodeKey(guildId));
      if (existingEpisodeId) {
        queue.recoveryEpisodeId = existingEpisodeId;
        if (queue.runtimeState === 'ready') {
          const revision = await this.nextRuntimeRevision(guildId, queue.runtimeRevision);
          queue.runtimeState = 'degraded';
          queue.runtimeRevision = revision;
          queue.runtimeError = reason;
          await this.saveQueue(queue);
        }
      }
      return { queue, newEpisode: false };
    }

    const revision = await this.nextRuntimeRevision(guildId, queue.runtimeRevision ?? 0);
    queue.runtimeState = 'degraded';
    queue.runtimeRevision = revision;
    queue.recoveryEpisodeId = episodeId;
    queue.runtimeError = reason;
    await this.saveQueue(queue);
    return { queue, newEpisode: true };
  }

  async claimRuntimeRecovery(guildId: string, token: string): Promise<RuntimeRecoveryClaim | null> {
    const claimed = await this.valkey.set(recoveryLockKey(guildId), token, 'EX', 120, 'NX');
    if (claimed !== 'OK') return null;

    const queue = await this.getQueue(guildId);
    if (!queue) {
      await this.valkey.del(recoveryLockKey(guildId));
      return null;
    }
    const revision = await this.nextRuntimeRevision(guildId, queue.runtimeRevision ?? 0);
    queue.runtimeState = 'recovering';
    queue.runtimeRevision = revision;
    await this.saveQueue(queue);
    return { queue, token, revision };
  }

  async finishRuntimeRecovery(
    guildId: string,
    claim: RuntimeRecoveryClaim,
    state: 'ready' | 'manual-reconcile',
    error: string | null,
  ): Promise<GuildQueue | null> {
    const [activeToken, activeRevision] = await Promise.all([
      this.valkey.get(recoveryLockKey(guildId)),
      this.valkey.get(runtimeRevisionKey(guildId)),
    ]);
    if (activeToken !== claim.token || Number(activeRevision) !== claim.revision) return null;

    const queue = await this.getQueue(guildId);
    if (!queue || queue.runtimeRevision !== claim.revision) return null;
    const nextRevision = await this.nextRuntimeRevision(guildId, claim.revision);
    queue.runtimeState = state;
    queue.runtimeRevision = nextRevision;
    queue.runtimeError = error;
    if (state === 'ready') queue.recoveryEpisodeId = null;
    await this.saveQueue(queue);
    await this.valkey.del(recoveryLockKey(guildId));
    if (state === 'ready') await this.valkey.del(outageEpisodeKey(guildId));
    return queue;
  }

  /** Destroy the queue (bot leaving voice). */
  async destroyQueue(guildId: string): Promise<void> {
    await this.valkey.del(queueKey(guildId));
    await this.valkey.del(nowPlayingKey(guildId));
    await this.clearVoteSkip(guildId);
    await this.valkey.del(runtimeRevisionKey(guildId));
    await this.valkey.del(recoveryLockKey(guildId));
    await this.valkey.del(outageEpisodeKey(guildId));
  }

  // ── Queue Operations ──────────────────────────────────

  /** Add entries to the end of the queue. Returns updated queue.
   *  V5 Audit [12.1]: Enforces MAX_QUEUE_SIZE — excess entries are silently trimmed.
   *  V9 Audit §12.P2: Also enforces per-user limit (MAX_PER_USER_QUEUE). */
  async addEntries(guildId: string, entries: QueueEntry[]): Promise<{ queue: GuildQueue | null; userLimitHit?: boolean }> {
    const queue = await this.getQueue(guildId);
    if (!queue) return { queue: null };

    // Global queue cap
    const available = this.maxQueueSize - queue.entries.length;
    if (available <= 0) return { queue };

    // Per-user cap — count how many the requesting user already has queued
    let userLimitHit = false;
    if (entries.length > 0) {
      const userId = entries[0]!.requestedBy;
      const userCount = queue.entries.filter((e) => e.requestedBy === userId).length;
      const userAvailable = this.maxPerUserQueue - userCount;
      if (userAvailable <= 0) return { queue, userLimitHit: true };
      const cap = Math.min(available, userAvailable);
      const toAdd = cap >= entries.length ? entries : entries.slice(0, cap);
      userLimitHit = toAdd.length < entries.length;
      queue.entries.push(...toAdd);
    }

    await this.saveQueue(queue);
    return { queue, userLimitHit };
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
    // Fisher-Yates shuffle — V8 Audit §12.P3a: crypto.randomInt for consistency
    for (let i = upcoming.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
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
