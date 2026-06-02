/**
 * MusicQueueManager — Full tests
 *
 * Tests queue CRUD, addEntries with limits, removeEntry, moveEntry,
 * shuffle, clearQueue, nextTrack with loop modes, vote skip,
 * now playing message persistence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { MusicQueueManager, type QueueEntry, type GuildQueue } from '../features/music/music-queue.js';

function makeValkey() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: any[]) => { store.set(key, value); return 'OK'; }),
    del: vi.fn(async (...keys: string[]) => { for (const k of keys) { store.delete(k); sets.delete(k); } return keys.length; }),
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      if (!sets.has(key)) sets.set(key, new Set());
      for (const m of members) sets.get(key)!.add(m);
      return members.length;
    }),
    scard: vi.fn(async (key: string) => sets.get(key)?.size ?? 0),
    sismember: vi.fn(async (key: string, member: string) => (sets.get(key)?.has(member) ? 1 : 0)),
    _store: store,
    _sets: sets,
  } as any;
}

function makeEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    track: 'base64track',
    title: 'Test Song',
    author: 'Artist',
    duration: 180000,
    uri: 'https://youtube.com/watch?v=test',
    artworkUrl: null,
    requestedBy: 'u1',
    addedAt: Date.now(),
    ...overrides,
  };
}

let valkey: ReturnType<typeof makeValkey>;
let mgr: MusicQueueManager;

beforeEach(() => {
  vi.clearAllMocks();
  valkey = makeValkey();
  mgr = new MusicQueueManager(valkey);
});

describe('createQueue + getQueue + saveQueue', () => {
  it('creates a fresh queue with defaults', () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    expect(q).toEqual({
      guildId: 'g1',
      voiceChannelId: 'vc1',
      textChannelId: 'tc1',
      entries: [],
      currentIndex: 0,
      loopMode: 'off',
      volume: 50,
      shuffled: false,
      paused: false,
    });
  });

  it('saves and retrieves queue', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 75);
    q.entries.push(makeEntry());
    await mgr.saveQueue(q);

    const loaded = await mgr.getQueue('g1');
    expect(loaded).not.toBeNull();
    expect(loaded!.guildId).toBe('g1');
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.volume).toBe(75);
  });

  it('returns null for non-existent queue', async () => {
    const q = await mgr.getQueue('non-existent');
    expect(q).toBeNull();
  });

  it('returns null for corrupted JSON', async () => {
    valkey._store.set('queue:g1', '{invalid json');
    const q = await mgr.getQueue('g1');
    expect(q).toBeNull();
  });
});

describe('destroyQueue', () => {
  it('removes queue, now-playing, and vote skip keys', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    await mgr.saveQueue(q);
    await mgr.setNowPlayingMessage('g1', 'msg1');

    await mgr.destroyQueue('g1');

    expect(await mgr.getQueue('g1')).toBeNull();
    expect(await mgr.getNowPlayingMessage('g1')).toBeNull();
  });
});

describe('addEntries', () => {
  it('adds entries to the queue', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    await mgr.saveQueue(q);

    const entries = [makeEntry({ title: 'Song 1' }), makeEntry({ title: 'Song 2' })];
    const result = await mgr.addEntries('g1', entries);

    expect(result.queue).not.toBeNull();
    expect(result.queue!.entries).toHaveLength(2);
    expect(result.userLimitHit).toBeFalsy();
  });

  it('returns null queue when no queue exists', async () => {
    const result = await mgr.addEntries('g1', [makeEntry()]);
    expect(result.queue).toBeNull();
  });

  it('enforces per-user limit (50)', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    // Pre-fill with 49 entries from user u1
    for (let i = 0; i < 49; i++) {
      q.entries.push(makeEntry({ title: `Song ${i}`, requestedBy: 'u1' }));
    }
    await mgr.saveQueue(q);

    // Try to add 5 more for u1 — only 1 should fit
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ title: `New ${i}`, requestedBy: 'u1' }),
    );
    const result = await mgr.addEntries('g1', entries);

    expect(result.queue!.entries).toHaveLength(50);
    expect(result.userLimitHit).toBe(true);
  });

  it('different users have separate limits', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    // Fill 50 entries from u1
    for (let i = 0; i < 50; i++) {
      q.entries.push(makeEntry({ title: `Song ${i}`, requestedBy: 'u1' }));
    }
    await mgr.saveQueue(q);

    // u2 can still add
    const entries = [makeEntry({ title: 'u2 song', requestedBy: 'u2' })];
    const result = await mgr.addEntries('g1', entries);

    expect(result.queue!.entries).toHaveLength(51);
    expect(result.userLimitHit).toBeFalsy();
  });
});

describe('removeEntry', () => {
  it('removes entry by index', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry({ title: 'A' }), makeEntry({ title: 'B' }), makeEntry({ title: 'C' }));
    await mgr.saveQueue(q);

    const removed = await mgr.removeEntry('g1', 1);
    expect(removed?.title).toBe('B');

    const updated = await mgr.getQueue('g1');
    expect(updated!.entries).toHaveLength(2);
    expect(updated!.entries[0]!.title).toBe('A');
    expect(updated!.entries[1]!.title).toBe('C');
  });

  it('adjusts currentIndex when removing before it', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry({ title: 'A' }), makeEntry({ title: 'B' }), makeEntry({ title: 'C' }));
    q.currentIndex = 2;
    await mgr.saveQueue(q);

    await mgr.removeEntry('g1', 0);

    const updated = await mgr.getQueue('g1');
    expect(updated!.currentIndex).toBe(1); // shifted down
  });

  it('returns null for out-of-range index', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry());
    await mgr.saveQueue(q);

    expect(await mgr.removeEntry('g1', -1)).toBeNull();
    expect(await mgr.removeEntry('g1', 5)).toBeNull();
  });

  it('returns null when no queue exists', async () => {
    expect(await mgr.removeEntry('g1', 0)).toBeNull();
  });
});

describe('moveEntry', () => {
  it('moves entry from one position to another', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry({ title: 'A' }), makeEntry({ title: 'B' }), makeEntry({ title: 'C' }));
    await mgr.saveQueue(q);

    const result = await mgr.moveEntry('g1', 0, 2);
    expect(result).toBe(true);

    const updated = await mgr.getQueue('g1');
    expect(updated!.entries.map(e => e.title)).toEqual(['B', 'C', 'A']);
  });

  it('adjusts currentIndex when moving the current track', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry({ title: 'A' }), makeEntry({ title: 'B' }), makeEntry({ title: 'C' }));
    q.currentIndex = 0;
    await mgr.saveQueue(q);

    await mgr.moveEntry('g1', 0, 2);

    const updated = await mgr.getQueue('g1');
    expect(updated!.currentIndex).toBe(2);
  });

  it('returns false for invalid indices', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry());
    await mgr.saveQueue(q);

    expect(await mgr.moveEntry('g1', -1, 0)).toBe(false);
    expect(await mgr.moveEntry('g1', 0, 5)).toBe(false);
  });

  it('returns false when no queue', async () => {
    expect(await mgr.moveEntry('g1', 0, 1)).toBe(false);
  });
});

describe('shuffle', () => {
  it('shuffles entries after currentIndex', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    for (let i = 0; i < 10; i++) q.entries.push(makeEntry({ title: `Song ${i}` }));
    q.currentIndex = 0;
    await mgr.saveQueue(q);

    const result = await mgr.shuffle('g1');
    expect(result).toBe(true);

    const updated = await mgr.getQueue('g1');
    expect(updated!.shuffled).toBe(true);
    expect(updated!.entries[0]!.title).toBe('Song 0'); // current track unchanged
    expect(updated!.entries).toHaveLength(10);
  });

  it('returns false when no queue', async () => {
    expect(await mgr.shuffle('g1')).toBe(false);
  });
});

describe('clearQueue', () => {
  it('clears all entries and resets currentIndex', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry(), makeEntry());
    q.currentIndex = 1;
    await mgr.saveQueue(q);

    const result = await mgr.clearQueue('g1');
    expect(result).toBe(true);

    const updated = await mgr.getQueue('g1');
    expect(updated!.entries).toHaveLength(0);
    expect(updated!.currentIndex).toBe(0);
  });

  it('returns false when no queue', async () => {
    expect(await mgr.clearQueue('g1')).toBe(false);
  });
});

describe('getCurrentTrack', () => {
  it('returns current track', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry({ title: 'Current' }), makeEntry({ title: 'Next' }));
    q.currentIndex = 0;
    await mgr.saveQueue(q);

    const track = await mgr.getCurrentTrack('g1');
    expect(track?.title).toBe('Current');
  });

  it('returns null when currentIndex is out of range', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.currentIndex = 5;
    await mgr.saveQueue(q);

    expect(await mgr.getCurrentTrack('g1')).toBeNull();
  });

  it('returns null when no queue', async () => {
    expect(await mgr.getCurrentTrack('g1')).toBeNull();
  });
});

describe('nextTrack', () => {
  it('advances to next track', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry({ title: 'A' }), makeEntry({ title: 'B' }));
    q.currentIndex = 0;
    await mgr.saveQueue(q);

    const result = await mgr.nextTrack('g1');
    expect(result.track?.title).toBe('B');
    expect(result.queueEnded).toBe(false);
  });

  it('returns queueEnded when at last track with loopMode off', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry({ title: 'Only' }));
    q.currentIndex = 0;
    await mgr.saveQueue(q);

    const result = await mgr.nextTrack('g1');
    expect(result.track).toBeNull();
    expect(result.queueEnded).toBe(true);
  });

  it('repeats same track with loopMode track', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry({ title: 'Repeat Me' }));
    q.currentIndex = 0;
    q.loopMode = 'track';
    await mgr.saveQueue(q);

    const result = await mgr.nextTrack('g1');
    expect(result.track?.title).toBe('Repeat Me');
    expect(result.queueEnded).toBe(false);
  });

  it('loops back to start with loopMode queue', async () => {
    const q = mgr.createQueue('g1', 'vc1', 'tc1', 50);
    q.entries.push(makeEntry({ title: 'A' }), makeEntry({ title: 'B' }));
    q.currentIndex = 1; // at last track
    q.loopMode = 'queue';
    await mgr.saveQueue(q);

    const result = await mgr.nextTrack('g1');
    expect(result.track?.title).toBe('A');
    expect(result.queueEnded).toBe(false);

    const updated = await mgr.getQueue('g1');
    expect(updated!.currentIndex).toBe(0);
  });

  it('returns queueEnded when no queue', async () => {
    const result = await mgr.nextTrack('g1');
    expect(result.queueEnded).toBe(true);
    expect(result.track).toBeNull();
  });
});

describe('now playing message', () => {
  it('sets and gets now playing message ID', async () => {
    await mgr.setNowPlayingMessage('g1', 'msg123');
    const id = await mgr.getNowPlayingMessage('g1');
    expect(id).toBe('msg123');
  });

  it('clears now playing message', async () => {
    await mgr.setNowPlayingMessage('g1', 'msg123');
    await mgr.clearNowPlayingMessage('g1');
    expect(await mgr.getNowPlayingMessage('g1')).toBeNull();
  });
});

describe('vote skip', () => {
  it('adds vote and returns count', async () => {
    const count = await mgr.addVoteSkip('g1', 'u1');
    expect(count).toBe(1);
  });

  it('tracks multiple voters', async () => {
    await mgr.addVoteSkip('g1', 'u1');
    await mgr.addVoteSkip('g1', 'u2');
    const count = await mgr.getVoteSkipCount('g1');
    expect(count).toBe(2);
  });

  it('checks if user has voted', async () => {
    await mgr.addVoteSkip('g1', 'u1');
    expect(await mgr.hasVotedSkip('g1', 'u1')).toBe(true);
    expect(await mgr.hasVotedSkip('g1', 'u2')).toBe(false);
  });

  it('clears vote skip', async () => {
    await mgr.addVoteSkip('g1', 'u1');
    await mgr.clearVoteSkip('g1');
    expect(await mgr.getVoteSkipCount('g1')).toBe(0);
  });
});
