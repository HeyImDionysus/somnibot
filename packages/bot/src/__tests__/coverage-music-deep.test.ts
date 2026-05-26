/**
 * Deep coverage for MusicPlayerManager methods:
 * skip, voteSkip, stop, togglePause, seek, setVolume, setLoopMode,
 * cycleLoopMode, shuffle, remove, applyFilter, getStatus, isDJ, init, shutdown
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean): Collection<K, V> {
      const c = new Collection<K, V>();
      for (const [k, v] of this) if (fn(v)) c.set(k, v);
      return c;
    }
    find(fn: (v: V) => boolean): V | undefined {
      for (const v of this.values()) if (fn(v)) return v;
      return undefined;
    }
    first() { return this.values().next().value; }
  }
  class EmbedBuilder {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setThumbnail(t: any) { return this; }
    setTimestamp() { return this; }
    setFooter(f: any) { return this; }
    addFields(...f: any[]) { return this; }
    toJSON() { return this.data; }
  }
  class PermissionsBitField {
    bitfield: bigint;
    constructor(bits?: any) { this.bitfield = BigInt(bits ?? 0); }
    has() { return true; }
  }
  return { Collection, EmbedBuilder, PermissionsBitField, ChannelType: { GuildText: 0, GuildVoice: 2 } };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

const { Collection } = await import('discord.js');

function buildChain(data: any = null) {
  const chain: any = {};
  const methods = ['select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'not',
    'order', 'limit', 'range', 'match', 'ilike', 'like'];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
  chain.single = vi.fn(async () => ({ data, error: null }));
  chain.then = undefined;
  return chain;
}

function makeSupa() {
  return {
    from: vi.fn(() => buildChain({
      music_default_volume: 50, dj_role_id: null,
      music_auto_leave_minutes: 5, music_auto_destroy_minutes: 30,
    })),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

const QUEUE_DATA = {
  guildId: 'g1',
  voiceChannelId: 'vc1',
  textChannelId: 'ch1',
  entries: [
    { title: 'Song A', author: 'Artist A', uri: 'https://yt/a', track: 'base64a', duration: 200000, requestedBy: 'u1', artworkUrl: null, isStream: false, addedAt: Date.now() },
    { title: 'Song B', author: 'Artist B', uri: 'https://yt/b', track: 'base64b', duration: 180000, requestedBy: 'u2', artworkUrl: null, isStream: false, addedAt: Date.now() },
    { title: 'Song C', author: 'Artist C', uri: 'https://yt/c', track: 'base64c', duration: 240000, requestedBy: 'u1', artworkUrl: null, isStream: false, addedAt: Date.now() },
  ],
  currentIndex: 0,
  loopMode: 'off',
  paused: false,
  volume: 50,
  shuffled: false,
};

function makeValkey() {
  const store: Record<string, string> = {
    'queue:g1': JSON.stringify(QUEUE_DATA),
  };
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    set: vi.fn(async (key: string, val: string) => { store[key] = val; return 'OK'; }),
    del: vi.fn(async (key: string) => { delete store[key]; return 1; }),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => -2),
    sadd: vi.fn(async () => 1),
    sismember: vi.fn(async () => 0),
    scard: vi.fn(async () => 1),
    smembers: vi.fn(async () => []),
  } as any;
}

function makePlayer() {
  return {
    track: 'base64a',
    position: 30000,
    paused: false,
    guildId: 'g1',
    playTrack: vi.fn(async () => {}),
    stopTrack: vi.fn(async () => {}),
    setPaused: vi.fn(async () => {}),
    seekTo: vi.fn(async () => {}),
    setGlobalVolume: vi.fn(async () => {}),
    setFilterVolume: vi.fn(async () => {}),
    setTimescale: vi.fn(async () => {}),
    setEqualizer: vi.fn(async () => {}),
    setTremolo: vi.fn(async () => {}),
    setVibrato: vi.fn(async () => {}),
    setRotation: vi.fn(async () => {}),
    setKaraoke: vi.fn(async () => {}),
    setFilters: vi.fn(async () => {}),
    clearFilters: vi.fn(async () => {}),
    node: { rest: { resolve: vi.fn(async () => ({ loadType: 'empty', data: [] })) } },
  };
}

function makeGuild(id = 'g1') {
  const voiceMembers = new Collection<string, any>();
  voiceMembers.set('bot1', { user: { bot: true } });
  voiceMembers.set('u1', { user: { bot: false } });

  const channels = new Collection<string, any>();
  channels.set('vc1', {
    id: 'vc1', name: 'Voice', type: 2,
    isVoiceBased: () => true,
    members: voiceMembers,
  });
  channels.set('ch1', {
    id: 'ch1', name: 'general', type: 0,
    isVoiceBased: () => false,
    send: vi.fn(async () => ({ id: 'msg1' })),
  });

  return {
    id, name: 'Test', ownerId: 'owner1', memberCount: 100,
    roles: { cache: new Collection() },
    channels: { cache: channels },
    members: {
      cache: new Collection(),
      me: { roles: { highest: { position: 10 } } },
      fetch: vi.fn(async (uid: string) => ({
        id: uid,
        permissions: { has: () => uid === 'admin1' },
        roles: { cache: new Collection() },
        user: { bot: false },
      })),
    },
    client: { user: { id: 'bot1' } },
  } as any;
}

function makeShoukaku(withPlayer = true) {
  const player = makePlayer();
  const players = new Map();
  if (withPlayer) players.set('g1', player);

  const connections = new Map();
  connections.set('g1', { channelId: 'vc1' });

  return {
    players, connections,
    on: vi.fn(), off: vi.fn(),
    joinVoiceChannel: vi.fn(async () => player),
    leaveVoiceChannel: vi.fn(async () => {}),
    _player: player,
  } as any;
}

function makeEventBus() {
  return { on: vi.fn(), off: vi.fn(), emit: vi.fn() } as any;
}

describe('MusicPlayerManager deep', () => {
  it('init and shutdown', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    mgr.shutdown();
    expect(mgr).toBeDefined();
  });

  it('getStatus with no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(false), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const status = await mgr.getStatus();
    expect(status.nowPlaying).toBeNull();
  });

  it('getStatus with active player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const status = await mgr.getStatus();
    expect(status.nowPlaying).not.toBeNull();
    expect(status.nowPlaying!.title).toBe('Song A');
    expect(status.listeners).toBe(1);
  });

  it('isDJ returns true when no DJ role', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    expect(await mgr.isDJ('u1')).toBe(true);
  });

  it('skip advances to next track', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.skip('g1');
    expect(result.success).toBe(true);
    expect(result.message).toContain('Song B');
  });

  it('skip with no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(false), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.skip('g1');
    expect(result.success).toBe(false);
  });

  it('voteSkip registers vote', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.voteSkip('g1', 'u1');
    expect(result.success).toBe(true);
  });

  it('stop clears queue', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.stop('g1');
    expect(result.success).toBe(true);
    expect(result.message).toContain('Stopped');
  });

  it('togglePause pauses playback', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.togglePause('g1');
    expect(result.success).toBe(true);
    expect(result.paused).toBe(true);
  });

  it('togglePause with no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(false), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.togglePause('g1');
    expect(result.success).toBe(false);
  });

  it('seek to position', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.seek('g1', 60000);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Seeked');
  });

  it('seek with no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(false), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.seek('g1', 60000);
    expect(result.success).toBe(false);
  });

  it('seek out of range', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.seek('g1', 999999999);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid');
  });

  it('setVolume clamps and saves', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.setVolume('g1', 80);
    expect(result.success).toBe(true);
    expect(result.message).toContain('80%');
  });

  it('setLoopMode changes mode', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.setLoopMode('g1', 'track');
    expect(result.success).toBe(true);
    expect(result.message).toContain('Looping track');
  });

  it('cycleLoopMode cycles through modes', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.cycleLoopMode('g1');
    expect(result.success).toBe(true);
  });

  it('shuffle shuffles queue', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.shuffle('g1');
    expect(result.success).toBe(true);
    expect(result.message).toContain('shuffled');
  });

  it('remove removes track from queue', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    // position=1 means remove entry at currentIndex+1=1 (Song B)
    const result = await mgr.remove('g1', 1);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Song B');
  });

  it('remove with invalid position', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.remove('g1', 99);
    expect(result.success).toBe(false);
  });

  it('applyFilter with nightcore preset', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.applyFilter('g1', 'nightcore');
    expect(result.success).toBe(true);
  });

  it('applyFilter with no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(false), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.applyFilter('g1', 'nightcore');
    expect(result.success).toBe(false);
  });

  it('applyCustomSpeed', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.applyCustomSpeed('g1', 1.5, 1.2, 1.0);
    expect(result.success).toBe(true);
  });

  it('reloadConfig', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    await mgr.reloadConfig();
    const config = mgr.getConfig();
    expect(config.defaultVolume).toBe(50);
  });

  it('getPlayerPosition returns position', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    expect(mgr.getPlayerPosition('g1')).toBe(30000);
  });

  it('getPlayerPosition with no player returns 0', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(false), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    expect(mgr.getPlayerPosition('g1')).toBe(0);
  });

  it('setLoopMode with no queue', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const valkey = makeValkey();
    (valkey.get as any).mockResolvedValue(null);
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, valkey, makeEventBus());
    await mgr.init();
    // Need to re-mock get to return null for queue calls (after init loaded config ok):
    (valkey.get as any).mockImplementation(async (key: string) => null);
    const result = await mgr.setLoopMode('g1', 'queue');
    expect(result.success).toBe(false);
  });

  it('applyFilter with bassboost preset', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.applyFilter('g1', 'bassboost');
    expect(result.success).toBe(true);
  });

  it('applyFilter with vaporwave preset', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.applyFilter('g1', 'vaporwave');
    expect(result.success).toBe(true);
  });

  it('applyFilter with reset', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    await mgr.init();
    const result = await mgr.applyFilter('g1', 'reset');
    expect(result.success).toBe(true);
  });
});
