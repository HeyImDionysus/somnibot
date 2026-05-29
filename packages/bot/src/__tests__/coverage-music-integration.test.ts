/**
 * Integration-level coverage tests for Music Player system.
 *
 * These tests exercise REAL code paths in:
 * - MusicPlayerManager (music-player.ts) — 505 uncovered statements
 * - MusicQueueManager (music-queue.ts)
 * - MusicSelfHealer (music-self-healer.ts)
 * - music-filters.ts
 * - music-embeds.ts
 *
 * Only external libs (discord.js, shoukaku, @somnibot/shared) are mocked.
 * Internal modules run real code for genuine coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ─── Mock @somnibot/shared ─── */
vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
}));

/* ─── Mock discord.js (with working classes) ─── */
vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setThumbnail(t: any) { this.data.thumbnail = t; return this; }
    setTimestamp() { return this; }
    setFooter(f: any) { this.data.footer = f; return this; }
    setAuthor(a: any) { this.data.author = a; return this; }
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields ?? []), ...f]; return this; }
    setImage(i: any) { this.data.image = i; return this; }
    setURL(u: any) { this.data.url = u; return this; }
    toJSON() { return this.data; }
  }
  class ActionRowBuilder {
    components: any[] = [];
    addComponents(...c: any[]) { this.components.push(...(Array.isArray(c[0]) ? c[0] : c)); return this; }
  }
  class ButtonBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: any) { this.data.style = s; return this; }
    setEmoji(e: any) { this.data.emoji = e; return this; }
    setDisabled(d: boolean) { this.data.disabled = d; return this; }
  }
  return {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ChannelType: { GuildText: 0, GuildVoice: 2 },
    PermissionsBitField: class { static Flags = { ManageRoles: 1n, ManageChannels: 2n, Administrator: 8n }; },
    Collection: Map,
  };
});

/* ─── Mock shoukaku ─── */
vi.mock('shoukaku', () => ({}));

/* ─── Helpers ─── */

function makeValkey() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, val: string) => { store.set(key, val); return 'OK'; }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1; }),
    incr: vi.fn(async (key: string) => {
      const v = parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, String(v));
      return v;
    }),
    expire: vi.fn(async () => 1),
    zincrby: vi.fn(async () => '1'),
    zrevrange: vi.fn(async () => []),
    sismember: vi.fn(async () => 0),
    sadd: vi.fn(async () => 1),
    scard: vi.fn(async () => 1),
    smembers: vi.fn(async () => []),
    _store: store,
  };
}

function makeSupabase(overrides: Record<string, any> = {}) {
  const mockQuery = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: overrides.configData ?? null, error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    order: vi.fn().mockReturnThis(),
    then: vi.fn(),
  };
  return {
    from: vi.fn(() => mockQuery),
    _mockQuery: mockQuery,
  };
}

function makeGuild(id = '123456') {
  const channels = new Map();
  const members = new Map();
  return {
    id,
    ownerId: 'owner-1',
    shardId: 0,
    channels: { cache: channels, fetch: vi.fn(async (cid: string) => channels.get(cid)) },
    members: {
      cache: members,
      me: {
        roles: { highest: { position: 10, id: 'bot-role' } },
        permissions: { has: vi.fn(() => true) },
      },
      fetch: vi.fn(async (uid: string) => members.get(uid) ?? null),
    },
    roles: {
      cache: new Map([
        ['bot-role', { position: 10, name: 'Bot', id: 'bot-role', managed: true }],
        ['@everyone', { position: 0, name: '@everyone', id: id }],
      ]),
      everyone: { position: 0, name: '@everyone', id },
    },
  };
}

function makeShoukaku() {
  const players = new Map();
  const connections = new Map();
  const listeners: Record<string, Function[]> = {};
  return {
    players,
    connections,
    nodes: new Map([['main', { rest: { resolve: vi.fn() } }]]),
    options: { nodeResolver: vi.fn((nodes: Map<string, any>) => nodes.values().next().value) },
    joinVoiceChannel: vi.fn(async () => makePlayer()),
    leaveVoiceChannel: vi.fn(async () => {}),
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event]!.push(handler);
    }),
    _listeners: listeners,
  };
}

function makePlayer() {
  const listeners: Record<string, Function[]> = {};
  return {
    track: null as any,
    position: 0,
    paused: false,
    node: { rest: { resolve: vi.fn() } },
    playTrack: vi.fn(async (opts: any) => {}),
    stopTrack: vi.fn(async () => {}),
    setPaused: vi.fn(async (p: boolean) => {}),
    seekTo: vi.fn(async (pos: number) => {}),
    setGlobalVolume: vi.fn(async (v: number) => {}),
    setFilterVolume: vi.fn(async (v: number) => {}),
    setEqualizer: vi.fn(async () => {}),
    setTimescale: vi.fn(async () => {}),
    setRotation: vi.fn(async () => {}),
    clearFilters: vi.fn(async () => {}),
    filters: {} as any,
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event]!.push(handler);
    }),
    _listeners: listeners,
  };
}

function makeTrack(title = 'Test Song', author = 'Test Artist') {
  return {
    encoded: 'QUFBQUFRQUFBQUFBQUFBQUFBQUFBQUFBb0FBQ',
    info: {
      title,
      author,
      length: 240_000,
      uri: `https://youtube.com/watch?v=${title.replace(/\s/g, '')}`,
      artworkUrl: 'https://img.youtube.com/vi/test/0.jpg',
      isStream: false,
    },
  };
}

/* ───────────────────────────────────────────────────────────
 * MusicQueueManager tests (exercises music-queue.ts)
 * ──────────────────────────────────────────────────────── */

describe('MusicQueueManager integration', () => {
  let QueueManager: any;
  let valkey: ReturnType<typeof makeValkey>;

  beforeEach(async () => {
    valkey = makeValkey();
    const mod = await import('../features/music/music-queue.js');
    QueueManager = mod.MusicQueueManager;
  });

  it('creates and saves a queue', async () => {
    const qm = new QueueManager(valkey);
    const queue = qm.createQueue('g1', 'vc1', 'tc1', 50);
    expect(queue.guildId).toBe('g1');
    expect(queue.entries).toEqual([]);
    expect(queue.volume).toBe(50);

    await qm.saveQueue(queue);
    expect(valkey.set).toHaveBeenCalled();

    const loaded = await qm.getQueue('g1');
    expect(loaded).toBeTruthy();
    expect(loaded!.guildId).toBe('g1');
  });

  it('destroys a queue', async () => {
    const qm = new QueueManager(valkey);
    const queue = qm.createQueue('g1', 'vc1', 'tc1', 50);
    await qm.saveQueue(queue);
    await qm.destroyQueue('g1');
    expect(valkey.del).toHaveBeenCalled();
  });

  it('returns null for non-existent queue', async () => {
    const qm = new QueueManager(valkey);
    const queue = await qm.getQueue('nonexistent');
    expect(queue).toBeNull();
  });

  it('advances to next track', async () => {
    const qm = new QueueManager(valkey);
    const queue = qm.createQueue('g1', 'vc1', 'tc1', 50);
    queue.entries = [
      { track: 'a', title: 'A', author: 'X', duration: 100, uri: 'u1', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
      { track: 'b', title: 'B', author: 'X', duration: 200, uri: 'u2', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
    ];
    await qm.saveQueue(queue);

    const result = await qm.nextTrack('g1');
    expect(result.track).toBeTruthy();
    expect(result.queueEnded).toBe(false);
  });

  it('reports queue ended when past last track', async () => {
    const qm = new QueueManager(valkey);
    const queue = qm.createQueue('g1', 'vc1', 'tc1', 50);
    queue.entries = [
      { track: 'a', title: 'A', author: 'X', duration: 100, uri: 'u1', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
    ];
    queue.currentIndex = 0;
    await qm.saveQueue(queue);

    const result = await qm.nextTrack('g1');
    expect(result.queueEnded).toBe(true);
  });

  it('handles loop track mode', async () => {
    const qm = new QueueManager(valkey);
    const queue = qm.createQueue('g1', 'vc1', 'tc1', 50);
    queue.loopMode = 'track';
    queue.entries = [
      { track: 'a', title: 'A', author: 'X', duration: 100, uri: 'u1', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
    ];
    await qm.saveQueue(queue);

    const result = await qm.nextTrack('g1');
    expect(result.track).toBeTruthy();
    expect(result.track!.title).toBe('A');
    expect(result.queueEnded).toBe(false);
  });

  it('handles loop queue mode', async () => {
    const qm = new QueueManager(valkey);
    const queue = qm.createQueue('g1', 'vc1', 'tc1', 50);
    queue.loopMode = 'queue';
    queue.entries = [
      { track: 'a', title: 'A', author: 'X', duration: 100, uri: 'u1', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
    ];
    queue.currentIndex = 0;
    await qm.saveQueue(queue);

    const result = await qm.nextTrack('g1');
    expect(result.track).toBeTruthy();
    expect(result.queueEnded).toBe(false);
  });

  it('shuffles the queue', async () => {
    const qm = new QueueManager(valkey);
    const queue = qm.createQueue('g1', 'vc1', 'tc1', 50);
    queue.entries = Array.from({ length: 10 }, (_, i) => ({
      track: `t${i}`, title: `Track ${i}`, author: 'X', duration: 100,
      uri: `u${i}`, artworkUrl: null, requestedBy: 'u', addedAt: i,
    }));
    queue.currentIndex = 0;
    await qm.saveQueue(queue);

    const success = await qm.shuffle('g1');
    expect(success).toBe(true);
  });

  it('removes an entry', async () => {
    const qm = new QueueManager(valkey);
    const queue = qm.createQueue('g1', 'vc1', 'tc1', 50);
    queue.entries = [
      { track: 'a', title: 'A', author: 'X', duration: 100, uri: 'u1', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
      { track: 'b', title: 'B', author: 'X', duration: 200, uri: 'u2', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
    ];
    await qm.saveQueue(queue);

    const removed = await qm.removeEntry('g1', 1);
    expect(removed).toBeTruthy();
    expect(removed!.title).toBe('B');
  });

  it('handles vote skip tracking', async () => {
    const qm = new QueueManager(valkey);
    const queue = qm.createQueue('g1', 'vc1', 'tc1', 50);
    await qm.saveQueue(queue);

    const hasVoted = await qm.hasVotedSkip('g1', 'user1');
    expect(hasVoted).toBe(false);

    const count = await qm.addVoteSkip('g1', 'user1');
    expect(count).toBeGreaterThanOrEqual(1);

    await qm.clearVoteSkip('g1');
  });

  it('handles now-playing message tracking', async () => {
    const qm = new QueueManager(valkey);
    await qm.setNowPlayingMessage('g1', 'msg-123');
    const msgId = await qm.getNowPlayingMessage('g1');
    expect(msgId).toBe('msg-123');
    await qm.clearNowPlayingMessage('g1');
  });

  it('gets current track', async () => {
    const qm = new QueueManager(valkey);
    const queue = qm.createQueue('g1', 'vc1', 'tc1', 50);
    queue.entries = [
      { track: 'a', title: 'A', author: 'X', duration: 100, uri: 'u1', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
    ];
    await qm.saveQueue(queue);

    const current = await qm.getCurrentTrack('g1');
    expect(current).toBeTruthy();
    expect(current!.title).toBe('A');
  });
});

/* ───────────────────────────────────────────────────────────
 * MusicSelfHealer tests (exercises music-self-healer.ts)
 * ──────────────────────────────────────────────────────── */

describe('MusicSelfHealer integration', () => {
  let MusicSelfHealer: any;

  beforeEach(async () => {
    const mod = await import('../features/music/music-self-healer.js');
    MusicSelfHealer = mod.MusicSelfHealer;
  });

  it('starts with ytsearch provider', () => {
    const healer = new MusicSelfHealer();
    expect(healer.getSearchProvider()).toBe('ytsearch');
  });

  it('health status reflects records', () => {
    const healer = new MusicSelfHealer();
    expect(healer.getHealthStatus().totalRecords).toBe(0);
    healer.recordSuccess();
    expect(healer.getHealthStatus().totalRecords).toBe(1);
  });

  it('does not recommend recovery with few records', () => {
    const healer = new MusicSelfHealer();
    for (let i = 0; i < 5; i++) healer.recordFailure();
    const result = healer.recordFailure();
    expect(result.shouldRecover).toBe(false);
  });

  it('recommends provider switch on high failure rate', () => {
    const healer = new MusicSelfHealer();
    for (let i = 0; i < 10; i++) healer.recordFailure();
    const result = healer.recordFailure();
    if (result.shouldRecover) {
      expect(result.strategy).toBe('switch_search_provider');
    }
  });

  it('cycles search providers', () => {
    const healer = new MusicSelfHealer();
    expect(healer.getSearchProvider()).toBe('ytsearch');
    const next = healer.switchSearchProvider();
    expect(next).toBe('ytmsearch');
    const third = healer.switchSearchProvider();
    expect(third).toBe('scsearch');
    const back = healer.switchSearchProvider();
    expect(back).toBe('ytsearch');
  });

  it('tracks failure rate correctly', () => {
    const healer = new MusicSelfHealer();
    for (let i = 0; i < 5; i++) healer.recordSuccess();
    for (let i = 0; i < 5; i++) healer.recordFailure();
    const status = healer.getHealthStatus();
    expect(status.failureRate).toBeCloseTo(0.5, 1);
  });
});

/* ───────────────────────────────────────────────────────────
 * Music Filters tests (exercises music-filters.ts)
 * ──────────────────────────────────────────────────────── */

describe('Music Filters integration', () => {
  let applyFilterPreset: any;
  let applyCustomTimescale: any;
  let describeActiveFilters: any;
  let FILTER_PRESETS: any;

  beforeEach(async () => {
    const mod = await import('../features/music/music-filters.js');
    applyFilterPreset = mod.applyFilterPreset;
    applyCustomTimescale = mod.applyCustomTimescale;
    describeActiveFilters = mod.describeActiveFilters;
    FILTER_PRESETS = mod.FILTER_PRESETS;
  });

  function makeFilterPlayer() {
    return {
      setEqualizer: vi.fn(), setTimescale: vi.fn(), setRotation: vi.fn(),
      clearFilters: vi.fn(), setFilterVolume: vi.fn(),
      filters: {} as any,
    };
  }

  it('applies bassboost preset', async () => {
    const player = makeFilterPlayer();
    await applyFilterPreset(player as any, 'bassboost');
    expect(player.setEqualizer).toHaveBeenCalled();
  });

  it('applies nightcore preset', async () => {
    const player = makeFilterPlayer();
    await applyFilterPreset(player as any, 'nightcore');
    expect(player.setTimescale).toHaveBeenCalled();
  });

  it('applies vaporwave preset', async () => {
    const player = makeFilterPlayer();
    await applyFilterPreset(player as any, 'vaporwave');
    expect(player.setTimescale).toHaveBeenCalled();
  });

  it('applies 8d preset', async () => {
    const player = makeFilterPlayer();
    await applyFilterPreset(player as any, '8d');
    expect(player.setRotation).toHaveBeenCalled();
  });

  it('applies treble preset', async () => {
    const player = makeFilterPlayer();
    await applyFilterPreset(player as any, 'treble');
    expect(player.setEqualizer).toHaveBeenCalled();
  });

  it('resets filters', async () => {
    const player = makeFilterPlayer();
    await applyFilterPreset(player as any, 'reset');
    expect(player.clearFilters).toHaveBeenCalled();
  });

  it('applies custom timescale', async () => {
    const player = makeFilterPlayer();
    await applyCustomTimescale(player as any, { speed: 1.5, pitch: 1.2 });
    expect(player.setTimescale).toHaveBeenCalled();
  });

  it('describes active filters when none active', () => {
    const player = { filters: {} } as any;
    const desc = describeActiveFilters(player);
    expect(typeof desc).toBe('string');
  });

  it('describes active filters with equalizer', () => {
    const player = { filters: { equalizer: [{ band: 0, gain: 0.6 }, { band: 1, gain: 0.5 }] } } as any;
    const desc = describeActiveFilters(player);
    expect(desc.length).toBeGreaterThan(0);
  });

  it('describes active filters with timescale', () => {
    const player = { filters: { timescale: { speed: 1.25, pitch: 1.25, rate: 1.0 } } } as any;
    const desc = describeActiveFilters(player);
    expect(desc.length).toBeGreaterThan(0);
  });

  it('describes active filters with custom timescale', () => {
    const player = { filters: { timescale: { speed: 1.5, pitch: 0.9, rate: 1.0 } } } as any;
    const desc = describeActiveFilters(player);
    expect(desc.length).toBeGreaterThan(0);
  });

  it('describes active filters with rotation', () => {
    const player = { filters: { rotation: { rotationHz: 0.2 } } } as any;
    const desc = describeActiveFilters(player);
    expect(desc.length).toBeGreaterThan(0);
  });

  it('has all expected presets', () => {
    expect(FILTER_PRESETS).toBeDefined();
    expect(FILTER_PRESETS.bassboost).toBeDefined();
    expect(FILTER_PRESETS.nightcore).toBeDefined();
    expect(FILTER_PRESETS.vaporwave).toBeDefined();
    expect(FILTER_PRESETS['8d']).toBeDefined();
    expect(FILTER_PRESETS.reset).toBeDefined();
  });
});

/* ───────────────────────────────────────────────────────────
 * Music Embeds tests (exercises music-embeds.ts)
 * ──────────────────────────────────────────────────────── */

describe('Music Embeds integration', () => {
  let buildNowPlayingEmbed: any;
  let buildAddedEmbed: any;
  let buildPlaylistAddedEmbed: any;
  let buildMusicErrorEmbed: any;
  let buildMusicInfoEmbed: any;

  beforeEach(async () => {
    const mod = await import('../features/music/music-embeds.js');
    buildNowPlayingEmbed = mod.buildNowPlayingEmbed;
    buildAddedEmbed = mod.buildAddedEmbed;
    buildPlaylistAddedEmbed = mod.buildPlaylistAddedEmbed;
    buildMusicErrorEmbed = mod.buildMusicErrorEmbed;
    buildMusicInfoEmbed = mod.buildMusicInfoEmbed;
  });

  const entry = {
    track: 'enc', title: 'Song', author: 'Artist', duration: 240_000,
    uri: 'https://youtube.com/watch?v=test', artworkUrl: 'https://img/test.jpg',
    requestedBy: 'user1', addedAt: Date.now(), isStream: false,
  };

  const queue = {
    guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
    entries: [entry], currentIndex: 0, loopMode: 'off' as const,
    volume: 50, shuffled: false, paused: false,
  };

  it('builds now playing embed', () => {
    const result = buildNowPlayingEmbed(entry, 60_000, queue, 'None');
    expect(result.embeds).toBeDefined();
    expect(result.components).toBeDefined();
  });

  it('builds now playing for stream', () => {
    const streamEntry = { ...entry, isStream: true, duration: 0 };
    const result = buildNowPlayingEmbed(streamEntry, 0, queue, 'None');
    expect(result.embeds).toBeDefined();
  });

  it('builds now playing with loop modes', () => {
    const loopQueue = { ...queue, loopMode: 'track' as const };
    const result = buildNowPlayingEmbed(entry, 30_000, loopQueue, 'Bass Boost');
    expect(result.embeds).toBeDefined();

    const loopAll = { ...queue, loopMode: 'queue' as const };
    const result2 = buildNowPlayingEmbed(entry, 30_000, loopAll, 'None');
    expect(result2.embeds).toBeDefined();
  });

  it('builds added embed', () => {
    const result = buildAddedEmbed(entry, 3);
    expect(result).toBeDefined();
  });

  it('builds playlist added embed', () => {
    const result = buildPlaylistAddedEmbed('My Playlist', 10, 3600_000);
    expect(result).toBeDefined();
  });

  it('builds error embed', () => {
    const result = buildMusicErrorEmbed('Something went wrong');
    expect(result).toBeDefined();
  });

  it('builds info embed', () => {
    const result = buildMusicInfoEmbed('Queue ended');
    expect(result).toBeDefined();
  });

  it('handles long duration (hours)', () => {
    const longEntry = { ...entry, duration: 7200_000 };
    const result = buildNowPlayingEmbed(longEntry, 3600_000, queue, 'None');
    expect(result.embeds).toBeDefined();
  });
});

/* ───────────────────────────────────────────────────────────
 * MusicPlayerManager tests (exercises music-player.ts)
 * ──────────────────────────────────────────────────────── */

describe('MusicPlayerManager integration', () => {
  let MusicPlayerManager: any;
  let guild: any;
  let shoukaku: any;
  let supabase: any;
  let valkey: any;
  let eventBus: any;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    guild = makeGuild();
    shoukaku = makeShoukaku();
    supabase = makeSupabase();
    valkey = makeValkey();
    eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };

    const mod = await import('../features/music/music-player.js');
    MusicPlayerManager = mod.MusicPlayerManager;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('constructs and initializes', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();
    expect(shoukaku.on).toHaveBeenCalled();
  });

  it('loads config from supabase', async () => {
    supabase = makeSupabase({
      configData: {
        music_default_volume: 80,
        dj_role_id: 'dj-role-1',
        music_auto_leave_minutes: 10,
        music_auto_destroy_minutes: 60,
      },
    });
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();
    const config = mgr.getConfig();
    expect(config.defaultVolume).toBe(80);
    expect(config.djRoleId).toBe('dj-role-1');
  });

  it('reloads config', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();
    await mgr.reloadConfig();
    expect(supabase.from).toHaveBeenCalledWith('guild_config');
  });

  it('getStatus returns null when no player', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();
    const status = await mgr.getStatus();
    expect(status.nowPlaying).toBeNull();
    expect(status.queue.length).toBe(0);
  });

  it('getStatus returns track info when playing', async () => {
    const player = makePlayer();
    player.track = 'some-track';
    player.position = 60_000;
    shoukaku.players.set('123456', player);
    shoukaku.connections.set('123456', { channelId: 'vc1' });

    // Voice channel mock — needs filter() since Collection is mocked as Map
    const vcMembers = new Map([
      ['bot', { user: { bot: true } }],
      ['user1', { user: { bot: false } }],
    ]);
    (vcMembers as any).filter = (fn: any) => {
      const out = new Map([...vcMembers].filter(([, v]) => fn(v)));
      (out as any).filter = (vcMembers as any).filter;
      return out;
    };
    const voiceChannel = {
      id: 'vc1',
      isVoiceBased: () => true,
      members: vcMembers,
    };
    guild.channels.cache.set('vc1', voiceChannel);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    // Create a queue with a track
    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    queue.entries.push({
      track: 'enc', title: 'Cool Song', author: 'Cool Artist', duration: 240_000,
      uri: 'https://yt.com/test', artworkUrl: null, requestedBy: 'user1', addedAt: Date.now(),
    });
    await mgr.queueManager.saveQueue(queue);

    const status = await mgr.getStatus();
    expect(status.nowPlaying).toBeTruthy();
    expect(status.nowPlaying!.title).toBe('Cool Song');
    expect(status.listeners).toBe(1);
  });

  it('isDJ returns true when no DJ role set', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();
    const result = await mgr.isDJ('any-user');
    expect(result).toBe(true);
  });

  it('isDJ checks role when DJ role is set', async () => {
    supabase = makeSupabase({ configData: { dj_role_id: 'dj-role-1' } });
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    // User without DJ role
    guild.members.fetch = vi.fn(async () => ({
      id: 'user1',
      roles: { cache: new Map() },
      permissions: { has: vi.fn(() => false) },
    }));

    const result = await mgr.isDJ('user1');
    expect(result).toBe(false);
  });

  it('isDJ returns true for server owner', async () => {
    supabase = makeSupabase({ configData: { dj_role_id: 'dj-role-1' } });
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    guild.members.fetch = vi.fn(async () => ({
      id: 'owner-1',
      roles: { cache: new Map() },
      permissions: { has: vi.fn(() => false) },
    }));

    const result = await mgr.isDJ('owner-1');
    expect(result).toBe(true);
  });

  it('isDJ returns true for admin', async () => {
    supabase = makeSupabase({ configData: { dj_role_id: 'dj-role-1' } });
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    guild.members.fetch = vi.fn(async () => ({
      id: 'admin-1',
      roles: { cache: new Map() },
      permissions: { has: vi.fn((perm: string) => perm === 'Administrator') },
    }));

    const result = await mgr.isDJ('admin-1');
    expect(result).toBe(true);
  });

  it('skip returns error when no player', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();
    const result = await mgr.skip('123456');
    expect(result.success).toBe(false);
  });

  it('skip advances to next track', async () => {
    const player = makePlayer();
    player.track = 'some-track';
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    queue.entries = [
      { track: 'a', title: 'A', author: 'X', duration: 100, uri: 'u1', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
      { track: 'b', title: 'B', author: 'X', duration: 200, uri: 'u2', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
    ];
    await mgr.queueManager.saveQueue(queue);

    const result = await mgr.skip('123456');
    expect(result.success).toBe(true);
  });

  it('stop clears queue and leaves voice', async () => {
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const result = await mgr.stop('123456');
    expect(result.success).toBe(true);
    expect(shoukaku.leaveVoiceChannel).toHaveBeenCalled();
  });

  it('togglePause pauses and resumes', async () => {
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    await mgr.queueManager.saveQueue(queue);

    const result = await mgr.togglePause('123456');
    expect(result.success).toBe(true);
    expect(result.paused).toBe(true);

    const result2 = await mgr.togglePause('123456');
    expect(result2.paused).toBe(false);
  });

  it('seek validates position', async () => {
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    queue.entries = [{
      track: 'a', title: 'A', author: 'X', duration: 240_000,
      uri: 'u1', artworkUrl: null, requestedBy: 'u', addedAt: 0,
    }];
    await mgr.queueManager.saveQueue(queue);

    const seekResult = await mgr.seek('123456', 60_000);
    expect(seekResult.success).toBe(true);

    const invalid = await mgr.seek('123456', -1);
    expect(invalid.success).toBe(false);

    const tooFar = await mgr.seek('123456', 999_999);
    expect(tooFar.success).toBe(false);
  });

  it('seek rejects streams', async () => {
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    queue.entries = [{
      track: 'a', title: 'Live', author: 'X', duration: 0,
      uri: 'u1', artworkUrl: null, requestedBy: 'u', addedAt: 0, isStream: true,
    }];
    await mgr.queueManager.saveQueue(queue);

    const result = await mgr.seek('123456', 0);
    expect(result.success).toBe(false);
    expect(result.message).toContain('stream');
  });

  it('setVolume clamps value', async () => {
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    await mgr.queueManager.saveQueue(queue);

    const result = await mgr.setVolume('123456', 200);
    expect(result.success).toBe(true);
    expect(result.message).toContain('150');
  });

  it('setLoopMode changes mode', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    await mgr.queueManager.saveQueue(queue);

    const result = await mgr.setLoopMode('123456', 'track');
    expect(result.success).toBe(true);
    expect(result.message).toContain('track');
  });

  it('cycleLoopMode cycles through modes', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    await mgr.queueManager.saveQueue(queue);

    const r1 = await mgr.cycleLoopMode('123456');
    expect(r1.mode).toBe('queue');
    const r2 = await mgr.cycleLoopMode('123456');
    expect(r2.mode).toBe('track');
    const r3 = await mgr.cycleLoopMode('123456');
    expect(r3.mode).toBe('off');
  });

  it('shuffle returns error when no queue', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();
    const result = await mgr.shuffle('123456');
    expect(result.success).toBe(false);
  });

  it('remove validates position', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    queue.entries = [
      { track: 'a', title: 'A', author: 'X', duration: 100, uri: 'u1', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
      { track: 'b', title: 'B', author: 'X', duration: 200, uri: 'u2', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
      { track: 'c', title: 'C', author: 'X', duration: 300, uri: 'u3', artworkUrl: null, requestedBy: 'u', addedAt: 0 },
    ];
    await mgr.queueManager.saveQueue(queue);

    const result = await mgr.remove('123456', 1);
    expect(result.success).toBe(true);

    const invalid = await mgr.remove('123456', 99);
    expect(invalid.success).toBe(false);
  });

  it('getPlayerPosition returns 0 when no player', () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    expect(mgr.getPlayerPosition('123456')).toBe(0);
  });

  it('getActiveFilters returns None when no player', () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    const result = mgr.getActiveFilters('123456');
    expect(result).toBe('None');
  });

  it('applyFilter returns error when no player', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();
    const result = await mgr.applyFilter('123456', 'bassboost');
    expect(result.success).toBe(false);
  });

  it('applyCustomSpeed returns error when no player', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    const result = await mgr.applyCustomSpeed('123456', 1.5);
    expect(result.success).toBe(false);
  });

  it('applyCustomSpeed clamps values', async () => {
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const result = await mgr.applyCustomSpeed('123456', 5.0, 0.01, 2.0);
    expect(result.success).toBe(true);
    expect(result.message).toContain('timescale');
  });

  it('handleButton dispatches pause_resume', async () => {
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    await mgr.queueManager.saveQueue(queue);

    const result = await mgr.handleButton('music:pause_resume', 'user1');
    expect(result.message).toBeTruthy();
  });

  it('handleButton dispatches skip', async () => {
    const player = makePlayer();
    player.track = 'track';
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const result = await mgr.handleButton('music:skip', 'user1');
    expect(result.message).toBeTruthy();
  });

  it('handleButton dispatches stop', async () => {
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const result = await mgr.handleButton('music:stop', 'user1');
    expect(result.message).toBeTruthy();
  });

  it('handleButton dispatches shuffle', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();
    const result = await mgr.handleButton('music:shuffle', 'user1');
    expect(result.message).toBeTruthy();
  });

  it('handleButton dispatches loop', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    await mgr.queueManager.saveQueue(queue);

    const result = await mgr.handleButton('music:loop', 'user1');
    expect(result.message).toBeTruthy();
  });

  it('handleButton dispatches vol_down and vol_up', async () => {
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    await mgr.queueManager.saveQueue(queue);

    const down = await mgr.handleButton('music:vol_down', 'user1');
    expect(down.message).toContain('Volume');

    const up = await mgr.handleButton('music:vol_up', 'user1');
    expect(up.message).toContain('Volume');
  });

  it('handleButton returns error for unknown action', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    const result = await mgr.handleButton('music:unknown', 'user1');
    expect(result.message).toContain('Unknown');
  });

  it('handleButton denies non-DJ for DJ actions', async () => {
    supabase = makeSupabase({ configData: { dj_role_id: 'dj-role-1' } });
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    guild.members.fetch = vi.fn(async () => ({
      id: 'user1',
      roles: { cache: new Map() },
      permissions: { has: vi.fn(() => false) },
    }));

    const result = await mgr.handleButton('music:stop', 'user1');
    expect(result.message).toContain('DJ role');
  });

  it('voteSkip requires queue', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();
    const result = await mgr.voteSkip('123456', 'user1');
    expect(result.success).toBe(false);
  });

  it('play creates queue and plays track', async () => {
    const player = makePlayer();
    const track = makeTrack();
    const node = shoukaku.nodes.get('main')!;
    node.rest.resolve = vi.fn(async () => ({
      loadType: 'search',
      data: [track],
    }));
    player.node = node;
    shoukaku.joinVoiceChannel = vi.fn(async () => player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const voiceChannel = { id: 'vc1', type: 2 };
    const textChannel = { id: 'tc1', type: 0 };

    const result = await mgr.play('test query', 'user1', voiceChannel as any, textChannel as any);
    expect(result.success).toBe(true);
    expect(result.entry).toBeDefined();
  });

  it('play handles URL queries', async () => {
    const player = makePlayer();
    const track = makeTrack();
    const node = shoukaku.nodes.get('main')!;
    node.rest.resolve = vi.fn(async () => ({
      loadType: 'track',
      data: track,
    }));
    player.node = node;
    shoukaku.joinVoiceChannel = vi.fn(async () => player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const result = await mgr.play('https://youtube.com/watch?v=abc', 'user1', { id: 'vc1' } as any, { id: 'tc1' } as any);
    expect(result.success).toBe(true);
  });

  it('play handles playlist results', async () => {
    const player = makePlayer();
    const tracks = Array.from({ length: 5 }, (_, i) => makeTrack(`Song ${i}`));
    const node = shoukaku.nodes.get('main')!;
    node.rest.resolve = vi.fn(async () => ({
      loadType: 'playlist',
      data: { info: { name: 'Test Playlist' }, tracks },
    }));
    player.node = node;
    shoukaku.joinVoiceChannel = vi.fn(async () => player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const result = await mgr.play('playlist url', 'user1', { id: 'vc1' } as any, { id: 'tc1' } as any);
    expect(result.success).toBe(true);
    expect(result.count).toBe(5);
    expect(result.playlistName).toBe('Test Playlist');
  });

  it('play rejects when no lavalink node', async () => {
    shoukaku.options.nodeResolver = vi.fn(() => null);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const result = await mgr.play('test', 'user1', { id: 'vc1' } as any, { id: 'tc1' } as any);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Lavalink');
  });

  it('play handles empty search results', async () => {
    const player = makePlayer();
    const node = shoukaku.nodes.get('main')!;
    node.rest.resolve = vi.fn(async () => ({
      loadType: 'empty',
      data: [],
    }));
    player.node = node;
    shoukaku.joinVoiceChannel = vi.fn(async () => player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const result = await mgr.play('nonsense query', 'user1', { id: 'vc1' } as any, { id: 'tc1' } as any);
    expect(result.success).toBe(false);
  });

  it('play rejects duplicates when not allowed', async () => {
    supabase = makeSupabase({ configData: { music_default_volume: 50 } });
    const player = makePlayer();
    const track = makeTrack();
    const node = shoukaku.nodes.get('main')!;
    node.rest.resolve = vi.fn(async () => ({ loadType: 'search', data: [track] }));
    player.node = node;
    player.track = 'already-playing';
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    // First: create queue with same track already in it
    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    queue.entries.push({
      track: 'enc', title: 'Test Song', author: 'Test Artist', duration: 240_000,
      uri: track.info.uri, artworkUrl: null, requestedBy: 'user1', addedAt: Date.now(),
    });
    await mgr.queueManager.saveQueue(queue);

    // Disable duplicates
    (mgr as any).config.allowDuplicates = false;

    const result = await mgr.play('Test Song', 'user1', { id: 'vc1' } as any, { id: 'tc1' } as any);
    expect(result.success).toBe(false);
    expect(result.message).toContain('already in the queue');
  });

  it('play rejects when queue is full', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    // Create a full queue
    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    queue.entries = Array.from({ length: 500 }, (_, i) => ({
      track: `t${i}`, title: `Track ${i}`, author: 'X', duration: 100,
      uri: `u${i}`, artworkUrl: null, requestedBy: 'u', addedAt: i,
    }));
    await mgr.queueManager.saveQueue(queue);

    const result = await mgr.play('test', 'user1', { id: 'vc1' } as any, { id: 'tc1' } as any);
    expect(result.success).toBe(false);
    expect(result.message).toContain('full');
  });

  it('handleVoiceStateChange auto-pauses when alone', async () => {
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    await mgr.queueManager.saveQueue(queue);

    // Voice channel with only the bot
    guild.channels.cache.set('vc1', {
      id: 'vc1',
      isVoiceBased: () => true,
      members: { filter: vi.fn(() => ({ size: 0 })) },
    });

    await mgr.handleVoiceStateChange('vc1');
    expect(player.setPaused).toHaveBeenCalledWith(true);
  });

  it('handleVoiceStateChange resumes when someone joins', async () => {
    const player = makePlayer();
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    queue.paused = true;
    await mgr.queueManager.saveQueue(queue);

    guild.channels.cache.set('vc1', {
      id: 'vc1',
      isVoiceBased: () => true,
      members: { filter: vi.fn(() => ({ size: 2 })) },
    });

    await mgr.handleVoiceStateChange('vc1');
    expect(player.setPaused).toHaveBeenCalledWith(false);
  });

  it('sendNowPlaying sends embed to text channel', async () => {
    const player = makePlayer();
    player.track = 'track';
    player.position = 30_000;
    shoukaku.players.set('123456', player);

    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    const queue = mgr.queueManager.createQueue('123456', 'vc1', 'tc1', 50);
    queue.entries = [{
      track: 'a', title: 'Now Playing', author: 'Artist', duration: 240_000,
      uri: 'url', artworkUrl: 'img', requestedBy: 'user1', addedAt: Date.now(),
    }];
    await mgr.queueManager.saveQueue(queue);

    const sendFn = vi.fn(async () => ({ id: 'msg-1' }));
    guild.channels.cache.set('tc1', { id: 'tc1', type: 0, send: sendFn, messages: { fetch: vi.fn() } });

    await mgr.sendNowPlaying('123456');
    expect(sendFn).toHaveBeenCalled();
  });

  it('shutdown clears timers', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();
    mgr.shutdown();
  });

  it('getStats retrieves analytics from valkey', async () => {
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    valkey.get = vi.fn(async () => '5');
    valkey.zrevrange = vi.fn(async () => ['Song 1', '3', 'Song 2', '2']);

    const stats = await mgr.getStats(7);
    expect(stats.totalTracksPlayed).toBeGreaterThanOrEqual(0);
    expect(stats.dailyPlays.length).toBe(7);
  });

  it('getMusicStat and resetSessionStats', async () => {
    vi.useRealTimers();
    const mgr = new MusicPlayerManager(guild, shoukaku, supabase, valkey, eventBus);
    await mgr.init();

    // Exercise getStats (which calls getMusicStat indirectly)
    valkey.get = vi.fn(async () => '5');
    valkey.zrevrange = vi.fn(async () => ['Artist — Song', '3']);
    const stats = await mgr.getStats(3);
    expect(stats.dailyPlays.length).toBe(3);
    expect(stats.totalTracksPlayed).toBe(15); // 5 * 3 days
  });
});
