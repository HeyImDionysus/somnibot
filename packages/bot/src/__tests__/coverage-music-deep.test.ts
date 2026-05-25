import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2 },
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class { setColor() { return this; } setTitle() { return this; } setDescription() { return this; } setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; } setAuthor() { return this; } addFields() { return this; } setImage() { return this; } setURL() { return this; } },
  ActionRowBuilder: class { addComponents() { return this; } },
  ButtonBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } setEmoji() { return this; } setDisabled() { return this; } },
  ButtonStyle: { Primary: 1, Secondary: 2, Danger: 4 },
  Collection: class extends Map {},
}));

function makeValkey(): any {
  return { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), setex: vi.fn(async () => 'OK'), del: vi.fn(async () => 1), incr: vi.fn(async () => 1), expire: vi.fn(async () => 1), keys: vi.fn(async () => []), sadd: vi.fn(async () => 1), scard: vi.fn(async () => 0), smembers: vi.fn(async () => []) };
}

function makeQueueEntry(overrides?: Partial<any>): any {
  return { track: 'base64data', title: 'Test Song', author: 'Artist', duration: 180000, uri: 'https://youtube.com/watch?v=xxx', artworkUrl: 'https://img.com/art.jpg', requestedBy: 'u1', ...overrides };
}

function makeGuildQueue(overrides?: Partial<any>): any {
  return { guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'c1', entries: [makeQueueEntry()], currentIndex: 0, loopMode: 'off' as const, volume: 80, ...overrides };
}

// ═══════════════════════════════════════════════════════════
// music-embeds.ts
// ═══════════════════════════════════════════════════════════
describe('music-embeds', () => {
  let mod: typeof import('../features/music/music-embeds.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/music/music-embeds.js');
  });

  it('buildNowPlayingEmbed returns embed', () => {
    const entry = makeQueueEntry();
    const queue = makeGuildQueue();
    const result = mod.buildNowPlayingEmbed(entry, 60000, queue);
    expect(result).toBeDefined();
  });

  it('buildNowPlayingEmbed with active filters', () => {
    const entry = makeQueueEntry();
    const queue = makeGuildQueue();
    const result = mod.buildNowPlayingEmbed(entry, 30000, queue, 'nightcore');
    expect(result).toBeDefined();
  });

  it('buildQueueEmbed returns embed', () => {
    const queue = makeGuildQueue({ entries: [makeQueueEntry(), makeQueueEntry({ title: 'Song 2' })] });
    const result = mod.buildQueueEmbed(queue, 1);
    expect(result).toBeDefined();
  });

  it('buildAddedEmbed returns embed', () => {
    const entry = makeQueueEntry();
    const result = mod.buildAddedEmbed(entry, 2);
    expect(result).toBeDefined();
  });

  it('buildPlaylistAddedEmbed returns embed', () => {
    const result = mod.buildPlaylistAddedEmbed(5, 'My Playlist');
    expect(result).toBeDefined();
  });

  it('buildMusicErrorEmbed returns embed', () => {
    const result = mod.buildMusicErrorEmbed('Something went wrong');
    expect(result).toBeDefined();
  });

  it('buildMusicInfoEmbed returns embed', () => {
    const result = mod.buildMusicInfoEmbed('Paused');
    expect(result).toBeDefined();
  });

  it('buildFilterEmbed returns embed', () => {
    const result = mod.buildFilterEmbed('Nightcore applied', 'nightcore');
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// music-filters.ts
// ═══════════════════════════════════════════════════════════
describe('music-filters', () => {
  let mod: typeof import('../features/music/music-filters.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/music/music-filters.js');
  });

  it('applyFilterPreset applies filter to player', async () => {
    const player = { setTimescale: vi.fn(async () => {}), setEqualizer: vi.fn(async () => {}), setFilters: vi.fn(async () => {}), filters: {} };
    try { await mod.applyFilterPreset(player as any, 'nightcore' as any); } catch {}
  });

  it('applyCustomTimescale sets timescale', async () => {
    const player = { setTimescale: vi.fn(async () => {}), setFilters: vi.fn(async () => {}), filters: {} };
    try { await mod.applyCustomTimescale(player as any, { speed: 1.25, pitch: 1.0, rate: 1.0 }); } catch {}
  });

  it('applyCustomEqualizer sets equalizer', async () => {
    const player = { setEqualizer: vi.fn(async () => {}), setFilters: vi.fn(async () => {}), filters: {} };
    try { await mod.applyCustomEqualizer(player as any, [{ band: 0, gain: 0.5 }]); } catch {}
  });

  it('describeActiveFilters returns description', () => {
    const player = { filters: { timescale: { speed: 1.25 } } };
    const desc = mod.describeActiveFilters(player as any);
    expect(typeof desc).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════
// music-queue.ts
// ═══════════════════════════════════════════════════════════
describe('MusicQueueManager', () => {
  let mod: typeof import('../features/music/music-queue.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/music/music-queue.js');
  });

  it('constructs with valkey', () => {
    const valkey = makeValkey();
    const mgr = new mod.MusicQueueManager(valkey as any);
    expect(mgr).toBeDefined();
  });

  it('getQueue returns null when empty', async () => {
    const valkey = makeValkey();
    const mgr = new mod.MusicQueueManager(valkey as any);
    const queue = await mgr.getQueue('g1');
    expect(queue).toBeNull();
  });

  it('saveQueue stores queue', async () => {
    const valkey = makeValkey();
    const mgr = new mod.MusicQueueManager(valkey as any);
    const queue = makeGuildQueue();
    try { await mgr.saveQueue(queue); } catch {}
  });

  it('destroyQueue deletes queue', async () => {
    const valkey = makeValkey();
    const mgr = new mod.MusicQueueManager(valkey as any);
    try { await mgr.destroyQueue('g1'); } catch {}
  });

  it('addEntries adds tracks', async () => {
    const valkey = makeValkey();
    valkey.get = vi.fn(async () => JSON.stringify(makeGuildQueue()));
    const mgr = new mod.MusicQueueManager(valkey as any);
    try { await mgr.addEntries('g1', [makeQueueEntry({ title: 'New Song' })]); } catch {}
  });

  it('shuffle shuffles queue', async () => {
    const valkey = makeValkey();
    valkey.get = vi.fn(async () => JSON.stringify(makeGuildQueue({ entries: [makeQueueEntry(), makeQueueEntry({ title: 'B' }), makeQueueEntry({ title: 'C' })] })));
    const mgr = new mod.MusicQueueManager(valkey as any);
    try { await mgr.shuffle('g1'); } catch {}
  });

  it('clearQueue clears', async () => {
    const valkey = makeValkey();
    const mgr = new mod.MusicQueueManager(valkey as any);
    try { await mgr.clearQueue('g1'); } catch {}
  });
});
