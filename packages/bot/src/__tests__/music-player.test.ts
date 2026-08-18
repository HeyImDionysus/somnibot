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
    setLimits = vi.fn();
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

function makeSupa(rows: unknown[] = []) {
  const pendingRows = [...rows];
  return {
    from: vi.fn(() => makeChain(pendingRows.shift() ?? null)),
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

  it('reloadConfig applies changed music policy without recreating the manager', async () => {
    const rows = [
      { music_default_volume: 25, dj_role_id: null },
      { music_default_volume: 80, dj_role_id: 'dj-role' },
    ];
    const localManager = new MusicPlayerManager(
      makeGuild(),
      makeShoukaku(),
      makeSupa(rows),
      makeValkey(),
      makeEventBus(),
    );
    await localManager.init();

    await localManager.reloadConfig();

    expect(localManager.getConfig()).toEqual(expect.objectContaining({
      defaultVolume: 80,
      djRoleId: 'dj-role',
    }));
  });

  it('resolves configured guild branding for music surfaces', async () => {
    const guild = makeGuild();
    guild.id = 'brand-guild';
    guild.name = 'Fallback Guild';
    const localManager = new MusicPlayerManager(
      guild,
      makeShoukaku(),
      makeSupa([{
        store_brand_name: 'Night Radio',
        store_brand_source: 'custom',
        brand_primary_color: 0x123456,
        brand_accent_color: 0x654321,
        brand_voice_preset: 'friendly',
        store_show_powered_by: false,
        currency_name: 'notes',
        currency_emoji: '🎵',
      }]),
      makeValkey(),
      makeEventBus(),
    );

    await expect(localManager.getBrandKit()).resolves.toEqual(expect.objectContaining({
      brandName: 'Night Radio',
      primaryColor: 0x123456,
      accentColor: 0x654321,
      voicePreset: 'friendly',
      poweredByAttribution: null,
    }));
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

  it('suspends voice while preserving the durable queue for later recovery', async () => {
    const shoukaku = makeShoukaku();
    const localManager = new MusicPlayerManager(
      makeGuild(),
      shoukaku,
      makeSupa(),
      makeValkey(),
      makeEventBus(),
    );

    await localManager.suspend();

    expect(shoukaku.leaveVoiceChannel).toHaveBeenCalledWith('guild-1');
    expect(localManager.queueManager.clearQueue).not.toHaveBeenCalled();
  });

  it('keeps Shoukaku listener counts stable across repeated runtime enable and disable', async () => {
    const shoukaku = makeShoukaku();
    const firstManager = new MusicPlayerManager(
      makeGuild(),
      shoukaku,
      makeSupa(),
      makeValkey(),
      makeEventBus(),
    );

    await firstManager.init();
    await firstManager.init();
    expect(shoukaku.on).toHaveBeenCalledTimes(3);

    await firstManager.suspend();
    expect(shoukaku.off).toHaveBeenCalledTimes(3);
    for (const [eventName, listener] of shoukaku.on.mock.calls) {
      expect(shoukaku.off).toHaveBeenCalledWith(eventName, listener);
    }

    const secondManager = new MusicPlayerManager(
      makeGuild(),
      shoukaku,
      makeSupa(),
      makeValkey(),
      makeEventBus(),
    );
    await secondManager.init();
    expect(shoukaku.on).toHaveBeenCalledTimes(6);
    expect(shoukaku.off).toHaveBeenCalledTimes(3);

    await secondManager.suspend();
    expect(shoukaku.off).toHaveBeenCalledTimes(6);
  });

  it('denies DJ privileges by default when multiple listeners share voice', async () => {
    const member = {
      id: 'member-1',
      roles: { cache: { has: vi.fn().mockReturnValue(false) } },
      permissions: { has: vi.fn().mockReturnValue(false) },
    };
    const guild = makeGuild();
    guild.ownerId = 'owner-1';
    guild.members.fetch = vi.fn().mockResolvedValue(member);
    guild.channels.cache.set('voice-1', {
      isVoiceBased: () => true,
      members: { filter: () => ({ size: 2 }) },
    });
    const localManager = new MusicPlayerManager(guild, makeShoukaku(), makeSupa(), makeValkey(), makeEventBus());
    localManager.queueManager.getQueue = vi.fn().mockResolvedValue({ voiceChannelId: 'voice-1' });

    await expect(localManager.isDJ('member-1')).resolves.toBe(false);
  });

  it.each([
    ['server owner', 'owner-1', false, 2],
    ['administrator', 'member-1', true, 2],
    ['only human listener', 'member-1', false, 1],
  ])('grants DJ privileges to the %s without a configured role', async (_label, memberId, isAdmin, listenerCount) => {
    const member = {
      id: memberId,
      roles: { cache: { has: vi.fn().mockReturnValue(false) } },
      permissions: { has: vi.fn().mockReturnValue(isAdmin) },
    };
    const guild = makeGuild();
    guild.ownerId = 'owner-1';
    guild.members.fetch = vi.fn().mockResolvedValue(member);
    guild.channels.cache.set('voice-1', {
      isVoiceBased: () => true,
      members: { filter: () => ({ size: listenerCount }) },
    });
    const localManager = new MusicPlayerManager(guild, makeShoukaku(), makeSupa(), makeValkey(), makeEventBus());
    localManager.queueManager.getQueue = vi.fn().mockResolvedValue({ voiceChannelId: 'voice-1' });

    await expect(localManager.isDJ(memberId)).resolves.toBe(true);
  });
});
