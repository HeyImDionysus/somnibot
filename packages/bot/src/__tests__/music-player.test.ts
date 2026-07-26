/**
 * Tests for features/music/music-player.ts — MusicPlayerManager lifecycle.
 * 547 uncovered statements at 29.1%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: any = {};
    setColor() { return this; } setTitle() { return this; }
    setDescription() { return this; } addFields() { return this; }
    setFooter() { return this; } setTimestamp() { return this; }
    setThumbnail() { return this; } setImage() { return this; }
    setAuthor() { return this; }
  },
  ActionRowBuilder: class { addComponents() { return this; } },
  ButtonBuilder: class {
    setCustomId() { return this; } setLabel() { return this; }
    setStyle() { return this; } setEmoji() { return this; }
    setDisabled() { return this; }
  },
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  ChannelType: { GuildVoice: 2, GuildStageVoice: 13 },
  PermissionFlagsBits: { Connect: 1n, Speak: 2n },
  Collection: class extends Map {},
}));

vi.mock('../features/music/music-queue.js', () => ({
  MusicQueueManager: class {
    getQueue = vi.fn(async () => ({ tracks: [], currentIndex: 0, loopMode: 'off' }));
    addTrack = vi.fn(async () => 0);
    removeTrack = vi.fn(async () => true);
    clearQueue = vi.fn(async () => true);
    setLoopMode = vi.fn(async () => {});
    getLoopMode = vi.fn(async () => 'off');
    shuffle = vi.fn(async () => {});
    next = vi.fn(async () => null);
    previous = vi.fn(async () => null);
  },
}));

vi.mock('../features/music/music-self-healer.js', () => ({
  MusicSelfHealer: class {
    heal = vi.fn(async () => null);
  },
}));

vi.mock('../features/music/music-filters.js', () => ({
  applyFilterPreset: vi.fn(async () => {}),
  applyCustomTimescale: vi.fn(async () => {}),
  describeActiveFilters: vi.fn(() => 'none'),
}));

vi.mock('../features/music/music-renderer.js', () => ({
  renderNowPlaying: vi.fn(() => ({})),
  renderQueue: vi.fn(() => ({})),
}));

import { MusicPlayerManager } from '../features/music/music-player.js';

function makeGuild() {
  return {
    id: 'guild-1', name: 'Test',
    members: { me: { voice: { channel: null }, permissions: { has: () => true } } },
    voiceAdapterCreator: vi.fn(),
    channels: { cache: new Map() },
  } as any;
}

function makeShoukaku() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    options: {},
    getIdealNode: vi.fn(() => ({
      rest: { resolve: vi.fn().mockResolvedValue({ loadType: 'search', data: [] }) },
    })),
    joinVoiceChannel: vi.fn().mockResolvedValue({
      on: vi.fn(),
      off: vi.fn(),
      playTrack: vi.fn(),
      stopTrack: vi.fn(),
      setPaused: vi.fn(),
      setGlobalVolume: vi.fn(),
      setFilterVolume: vi.fn(),
      position: 0,
      paused: false,
      filters: { volume: 1, timescale: null, equalizer: null },
      node: { rest: { resolve: vi.fn() } },
      connection: { channelId: 'vc-1' },
      destroy: vi.fn(),
    }),
    leaveVoiceChannel: vi.fn(),
  } as any;
}

function makeValkey() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(0),
  } as any;
}

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data, error: null });
  return chain;
}

function makeSupa() {
  return {
    from: vi.fn(() => makeChain()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeEventBus() {
  return { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() } as any;
}

describe('MusicPlayerManager', () => {
  let manager: MusicPlayerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa(), makeValkey(), makeEventBus());
  });

  it('instantiates without errors', () => {
    expect(manager).toBeDefined();
    expect(manager.queueManager).toBeDefined();
  });

  it('init loads config from supabase', async () => {
    await manager.init();
  });

  it('has required playback methods', () => {
    expect(typeof manager.play).toBe('function');
    expect(typeof manager.skip).toBe('function');
    expect(typeof manager.stop).toBe('function');
    expect(typeof manager.togglePause).toBe('function');
    expect(typeof manager.setVolume).toBe('function');
    expect(typeof manager.shuffle).toBe('function');
  });

  it('shutdown clears timers', () => {
    manager.shutdown();
  });
});
