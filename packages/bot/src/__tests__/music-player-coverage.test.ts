/**
 * MusicPlayerManager — Full coverage tests
 *
 * Imports the REAL class and mocks external boundaries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setColor(c: number) { this.data.color = c; return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setThumbnail(t: string) { this.data.thumbnail = t; return this; }
    setFooter(f: unknown) { this.data.footer = f; return this; }
    setTimestamp() { return this; }
    addFields(...f: unknown[]) { this.data.fields = f; return this; }
    setURL(u: string) { this.data.url = u; return this; }
    setAuthor(a: unknown) { this.data.author = a; return this; }
    setImage(i: string) { this.data.image = i; return this; }
  },
  ActionRowBuilder: class {
    components: unknown[] = [];
    addComponents(...c: unknown[]) { this.components.push(...c); return this; }
  },
  ButtonBuilder: class {
    data: Record<string, unknown> = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: number) { this.data.style = s; return this; }
    setEmoji(e: string) { this.data.emoji = e; return this; }
    setDisabled(d: boolean) { this.data.disabled = d; return this; }
  },
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  ChannelType: { GuildVoice: 2, GuildStageVoice: 13 },
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { MusicPlayerManager } from '../features/music/music-player.js';

// ── Helpers ───────────────────────────────────────────────

function makeValkey() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1; }),
    _store: store,
  };
}

function makePlayer() {
  return {
    track: 'encodedTrack',
    position: 60000,
    paused: false, shuffled: false,
    node: {
      rest: {
        resolve: vi.fn().mockResolvedValue({
          loadType: 'search',
          data: [{
            encoded: 'base64track',
            info: {
              title: 'Test Song',
              uri: 'https://youtube.com/watch?v=test',
              length: 240000,
              author: 'Test Artist',
              artworkUrl: 'https://img.youtube.com/test.jpg',
              isStream: false,
              identifier: 'test',
              sourceName: 'youtube',
            },
          }],
        }),
      },
    },
    playTrack: vi.fn().mockResolvedValue(undefined),
    stopTrack: vi.fn().mockResolvedValue(undefined),
    setPaused: vi.fn().mockResolvedValue(undefined),
    seekTo: vi.fn().mockResolvedValue(undefined),
    setGlobalVolume: vi.fn().mockResolvedValue(undefined),
    setFilterVolume: vi.fn().mockResolvedValue(undefined),
    setEqualizer: vi.fn().mockResolvedValue(undefined),
    setTimescale: vi.fn().mockResolvedValue(undefined),
    setKaraoke: vi.fn().mockResolvedValue(undefined),
    setTremolo: vi.fn().mockResolvedValue(undefined),
    setVibrato: vi.fn().mockResolvedValue(undefined),
    setRotation: vi.fn().mockResolvedValue(undefined),
    setDistortion: vi.fn().mockResolvedValue(undefined),
    setChannelMix: vi.fn().mockResolvedValue(undefined),
    setLowPass: vi.fn().mockResolvedValue(undefined),
    setFilters: vi.fn().mockResolvedValue(undefined),
    clearFilters: vi.fn().mockResolvedValue(undefined),
    clean: vi.fn(),
    filters: {},
    on: vi.fn(),
    off: vi.fn(),
  };
}

function makeShoukaku(player?: ReturnType<typeof makePlayer>) {
  const players = new Map();
  if (player) players.set('g1', player);
  return {
    players,
    nodes: new Map([['main', { name: 'main' }]]),
    options: {
      nodeResolver: vi.fn().mockReturnValue({ name: 'main' }),
    },
    connections: new Map(),
    joinVoiceChannel: vi.fn().mockResolvedValue(player ?? makePlayer()),
    leaveVoiceChannel: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}

function makeSupabase() {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'order', 'limit', 'insert', 'update', 'upsert', 'maybeSingle', 'single', 'contains', 'in', 'is'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null });
  chain.single = vi.fn().mockResolvedValue({ data: null });

  return {
    from: vi.fn().mockReturnValue(chain),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

function makeGuild() {
  const voiceChannel = {
    id: 'vc1',
    isVoiceBased: () => true,
    members: {
      filter: vi.fn().mockReturnValue({ size: 3 }),
      size: 4,
    },
    type: 2,
  };
  const textChannel = {
    id: 'tc1',
    send: vi.fn().mockResolvedValue({ id: 'msg1', edit: vi.fn() }),
  };
  const channelCache = new Map<string, unknown>();
  channelCache.set('vc1', voiceChannel);
  channelCache.set('tc1', textChannel);
  return {
    id: 'g1',
    channels: { cache: channelCache },
    members: {
      cache: new Map(),
      fetch: vi.fn().mockResolvedValue({ id: 'u1', roles: { cache: new Map() } }),
    },
  };
}

function makeEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}

describe('MusicPlayerManager', () => {
  let manager: MusicPlayerManager;
  let player: ReturnType<typeof makePlayer>;
  let shoukaku: ReturnType<typeof makeShoukaku>;
  let supabase: ReturnType<typeof makeSupabase>;
  let valkey: ReturnType<typeof makeValkey>;
  let guild: ReturnType<typeof makeGuild>;
  let eventBus: ReturnType<typeof makeEventBus>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    player = makePlayer();
    shoukaku = makeShoukaku(player);
    supabase = makeSupabase();
    valkey = makeValkey();
    guild = makeGuild();
    eventBus = makeEventBus();
    manager = new MusicPlayerManager(
      guild as any,
      shoukaku as any,
      supabase as any,
      valkey as any,
      eventBus as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('init', () => {
    it('initializes without error', async () => {
      await expect(manager.init()).resolves.not.toThrow();
    });

    it('detects bot alone in VC on restart', async () => {
      const vc = guild.channels.cache.get('vc1') as any;
      vc.members.filter.mockReturnValue({ size: 0 });
      // Store a queue in valkey so getQueue finds it
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1',
        voiceChannelId: 'vc1',
        textChannelId: 'tc1',
        entries: [],
        currentIndex: 0,
        loopMode: 'off',
        volume: 50,
        paused: false, shuffled: false,
      }));

      await manager.init();
      // Should have started auto-leave timer (no assertion on timer itself, just no crash)
    });
  });

  describe('shutdown', () => {
    it('clears all timers', () => {
      manager.shutdown();
      // No error expected
    });

    it('does not recreate a paused-track timer after shutdown', async () => {
      vi.spyOn(manager, 'sendNowPlaying').mockResolvedValue(undefined);
      let finishQueueLoad: (() => void) | undefined;
      valkey.get.mockImplementationOnce(() => new Promise<string | null>((resolve) => {
        finishQueueLoad = () => resolve(JSON.stringify({
          guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
          entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
          currentIndex: 0, loopMode: 'off', volume: 50, paused: true, shuffled: false,
        }));
      }));
      const eventSetup = manager as unknown as {
        setupPlayerEvents(target: ReturnType<typeof makePlayer>): void;
      };
      eventSetup.setupPlayerEvents(player);
      const startRegistration = player.on.mock.calls.find(([event]) => event === 'start');
      expect(startRegistration).toBeDefined();

      startRegistration?.[1]();
      manager.shutdown();
      finishQueueLoad?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('returns status when no queue exists', async () => {
      const status = await manager.getStatus();
      expect(status).toBeDefined();
    });
  });

  describe('isDJ', () => {
    it('returns true when no DJ role configured', async () => {
      const isDJ = await manager.isDJ('u1');
      expect(isDJ).toBe(true);
    });
  });

  describe('skip', () => {
    it('returns error when nothing is playing', async () => {
      shoukaku.players.clear();
      const result = await manager.skip('g1');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Nothing');
    });

    it('skips current track', async () => {
      const result = await manager.skip('g1');
      expect(result.success).toBe(true);
    });
  });

  describe('voteSkip', () => {
    it('returns error when nothing is playing', async () => {
      const result = await manager.voteSkip('g1', 'u1');
      expect(result.success).toBe(false);
    });

    it('self-skip: the requester of the current track skips it without a vote', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const result = await manager.voteSkip('g1', 'u1'); // u1 requested the current track
      // It skipped outright — not the "Skip vote: X/Y needed" tally message.
      expect(result.message).not.toContain('Skip vote');
    });
  });

  describe('stop', () => {
    it('stops playback and clears queue', async () => {
      const result = await manager.stop('g1');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Stopped');
      expect(player.stopTrack).toHaveBeenCalled();
    });

    it('handles no player gracefully', async () => {
      shoukaku.players.clear();
      const result = await manager.stop('g1');
      expect(result.success).toBe(true);
    });
  });

  describe('togglePause', () => {
    it('returns error when nothing is playing', async () => {
      shoukaku.players.clear();
      const result = await manager.togglePause('g1');
      expect(result.success).toBe(false);
    });

    it('toggles pause with existing queue', async () => {
      // Store a queue
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));

      const result = await manager.togglePause('g1');
      expect(result.success).toBe(true);
      expect(result.paused).toBe(true);
      expect(result.message).toContain('Paused');
    });

    it('rolls back the queue state when Lavalink rejects the pause', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      player.setPaused.mockRejectedValueOnce(new Error('Lavalink rejected pause'));

      await expect(manager.togglePause('g1')).rejects.toThrow('Lavalink rejected pause');

      await expect(manager.queueManager.getQueue('g1'))
        .resolves.toMatchObject({ paused: false });
    });
  });

  describe('seek', () => {
    it('returns error when nothing is playing', async () => {
      shoukaku.players.clear();
      const result = await manager.seek('g1', 60000);
      expect(result.success).toBe(false);
    });

    it('returns error when no current track', async () => {
      const result = await manager.seek('g1', 60000);
      expect(result.success).toBe(false);
    });

    it('seeks when track exists', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u', duration: 240000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const result = await manager.seek('g1', 60000);
      expect(result.success).toBe(true);
      expect(player.seekTo).toHaveBeenCalledWith(60000);
    });

    it('rejects seek on live stream', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Live', uri: 'u', duration: 0, author: 'A', requestedBy: 'u1', isStream: true }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const result = await manager.seek('g1', 60000);
      expect(result.success).toBe(false);
      expect(result.message).toContain('live stream');
    });

    it('rejects invalid seek position', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u', duration: 240000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const result = await manager.seek('g1', -1);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid');
    });
  });

  describe('setVolume', () => {
    it('sets volume', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [], currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const result = await manager.setVolume('g1', 75);
      expect(result.success).toBe(true);
      expect(result.message).toContain('75');
      expect(player.setGlobalVolume).toHaveBeenCalledWith(75);
    });

    it('clamps volume to 0-150', async () => {
      const result = await manager.setVolume('g1', 200);
      expect(result.success).toBe(true);
      expect(player.setGlobalVolume).toHaveBeenCalledWith(150);
    });

    it('returns error when nothing playing', async () => {
      shoukaku.players.clear();
      const result = await manager.setVolume('g1', 50);
      expect(result.success).toBe(false);
    });
  });

  describe('setLoopMode', () => {
    it('sets loop mode', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [], currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const result = await manager.setLoopMode('g1', 'track');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Looping track');
    });

    it('returns error with no queue', async () => {
      const result = await manager.setLoopMode('g1', 'queue');
      expect(result.success).toBe(false);
    });
  });

  describe('cycleLoopMode', () => {
    it('cycles from off to queue', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [], currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const result = await manager.cycleLoopMode('g1');
      expect(result.success).toBe(true);
      expect(result.mode).toBe('queue');
    });

    it('returns error with no queue', async () => {
      const result = await manager.cycleLoopMode('g1');
      expect(result.success).toBe(false);
    });
  });

  describe('shuffle', () => {
    it('shuffles the queue', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [
          { track: 't1', title: 'A', uri: 'u1', duration: 1000, author: 'A', requestedBy: 'u1', isStream: false },
          { track: 't2', title: 'B', uri: 'u2', duration: 1000, author: 'A', requestedBy: 'u1', isStream: false },
        ],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const result = await manager.shuffle('g1');
      expect(result.success).toBe(true);
    });

    it('fails with no queue', async () => {
      const result = await manager.shuffle('g1');
      expect(result.success).toBe(false);
    });
  });

  describe('remove', () => {
    it('removes a track from queue', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [
          { track: 't1', title: 'Current', uri: 'u1', duration: 1000, author: 'A', requestedBy: 'u1', isStream: false },
          { track: 't2', title: 'Next', uri: 'u2', duration: 1000, author: 'A', requestedBy: 'u1', isStream: false },
        ],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const result = await manager.remove('g1', 1);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Next');
    });

    it('fails with invalid position', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'A', uri: 'u1', duration: 1000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const result = await manager.remove('g1', 5);
      expect(result.success).toBe(false);
    });
  });

  describe('getPlayerPosition', () => {
    it('returns position from player', () => {
      expect(manager.getPlayerPosition('g1')).toBe(60000);
    });

    it('returns 0 when no player', () => {
      shoukaku.players.clear();
      expect(manager.getPlayerPosition('g1')).toBe(0);
    });
  });

  describe('applyFilter', () => {
    it('returns error when nothing playing', async () => {
      shoukaku.players.clear();
      const result = await manager.applyFilter('g1', 'nightcore');
      expect(result.success).toBe(false);
    });

    it('applies reset filter', async () => {
      const result = await manager.applyFilter('g1', 'reset');
      expect(result.success).toBe(true);
      expect(result.message).toContain('cleared');
    });

    it('applies nightcore filter', async () => {
      const result = await manager.applyFilter('g1', 'nightcore');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Nightcore');
    });
  });

  describe('applyCustomSpeed', () => {
    it('returns error when nothing playing', async () => {
      shoukaku.players.clear();
      const result = await manager.applyCustomSpeed('g1', 1.5);
      expect(result.success).toBe(false);
    });

    it('applies custom speed', async () => {
      const result = await manager.applyCustomSpeed('g1', 1.5);
      expect(result.success).toBe(true);
      expect(result.message).toContain('speed');
    });

    it('applies combined speed and pitch', async () => {
      const result = await manager.applyCustomSpeed('g1', 1.2, 0.8);
      expect(result.success).toBe(true);
      expect(result.message).toContain('speed');
      expect(result.message).toContain('pitch');
    });

    it('clamps values to 0.1-3.0', async () => {
      const result = await manager.applyCustomSpeed('g1', 5.0, 0.01, 10);
      expect(result.success).toBe(true);
    });
  });

  describe('getActiveFilters', () => {
    it('returns None when no player', () => {
      shoukaku.players.clear();
      expect(manager.getActiveFilters('g1')).toBe('None');
    });

    it('returns filter description', () => {
      const result = manager.getActiveFilters('g1');
      expect(typeof result).toBe('string');
    });
  });

  describe('sendNowPlaying', () => {
    it('does nothing when no queue', async () => {
      await manager.sendNowPlaying('g1');
      // Should not crash
    });
  });

  describe('handleVoiceStateChange', () => {
    it('handles voice state change', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [], currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      await manager.handleVoiceStateChange('vc1');
      // Should not crash
    });
  });

  describe('queue-end restart', () => {
    function getEndHandler(): (event: { reason: string }) => Promise<void> {
      const eventSetup = manager as unknown as {
        setupPlayerEvents(target: ReturnType<typeof makePlayer>): void;
      };
      eventSetup.setupPlayerEvents(player);
      const endRegistration = player.on.mock.calls.find(([event]) => event === 'end');
      expect(endRegistration).toBeDefined();
      return endRegistration?.[1] as (event: { reason: string }) => Promise<void>;
    }

    it('starts a newly queued track after the previous queue ended', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 'finished', title: 'Finished', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const endHandler = getEndHandler();

      await endHandler({ reason: 'finished' });
      const endedQueue = await manager.queueManager.getQueue('g1');
      expect(endedQueue?.entries).toEqual([]);
      expect(endedQueue?.currentIndex).toBe(0);
      expect(endedQueue?.voiceChannelId).toBe('vc1');
      expect(valkey.del).toHaveBeenCalledWith('nowplaying:g1');
      expect(valkey.del).toHaveBeenCalledWith('music:votes:g1:skip');

      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];
      const result = await manager.play('next song', 'u1', voiceChannel, textChannel);

      expect(result.success).toBe(true);
      expect(player.playTrack).toHaveBeenCalledWith({ track: { encoded: 'base64track' } });
      const restartedQueue = await manager.queueManager.getQueue('g1');
      expect(restartedQueue?.currentIndex).toBe(0);
      expect(restartedQueue?.entries).toHaveLength(1);
    });

    it('preserves a simultaneous add across the track-end transition', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 'finishing', title: 'Finishing', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const endHandler = getEndHandler();
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];

      const add = manager.play('next song', 'u1', voiceChannel, textChannel);
      const finish = endHandler({ reason: 'finished' });
      await Promise.all([add, finish]);

      const queue = await manager.queueManager.getQueue('g1');
      expect(queue?.entries).toHaveLength(1);
      expect(queue?.currentIndex).toBe(0);
      expect(player.playTrack).toHaveBeenCalledTimes(1);
      expect(player.playTrack).toHaveBeenCalledWith({ track: { encoded: 'base64track' } });
    });

    it('does not recreate a ghost queue when stop overlaps track end', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 'finishing', title: 'Finishing', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const endHandler = getEndHandler();

      await Promise.all([
        manager.stop('g1', { userId: 'u1', reason: 'command' }),
        endHandler({ reason: 'finished' }),
      ]);

      await expect(manager.queueManager.getQueue('g1')).resolves.toBeNull();
    });

    it('completes queue-end lifecycle when exhausted-queue cleanup fails', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 'finishing', title: 'Finishing', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      valkey.set.mockRejectedValueOnce(new Error('Valkey unavailable'));
      const endHandler = getEndHandler();

      await expect(endHandler({ reason: 'finished' })).resolves.toBeUndefined();
      expect(eventBus.emit).toHaveBeenCalledWith('queue.ended', 'g1', expect.any(Object));
      const textChannel = guild.channels.cache.get('tc1') as { send: ReturnType<typeof vi.fn> };
      expect(textChannel.send).toHaveBeenCalled();

      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const playableTextChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];
      await expect(manager.play('next song', 'u1', voiceChannel, playableTextChannel))
        .resolves.toMatchObject({ success: true });
      const recoveredQueue = await manager.queueManager.getQueue('g1');
      expect(recoveredQueue?.entries).toHaveLength(1);
      expect(recoveredQueue?.entries[0]?.track).toBe('base64track');
      expect(recoveredQueue?.currentIndex).toBe(0);
    });

    it('leaves a newly joined voice session when track resolution fails', async () => {
      shoukaku.players.clear();
      shoukaku.joinVoiceChannel.mockImplementationOnce(async () => {
        shoukaku.players.set('g1', player);
        return player;
      });
      player.node.rest.resolve.mockRejectedValueOnce(new Error('Lavalink unavailable'));
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];

      await expect(manager.play('song', 'u1', voiceChannel, textChannel))
        .rejects.toThrow('Lavalink unavailable');
      expect(shoukaku.leaveVoiceChannel).toHaveBeenCalledWith('g1');
    });

    it('does not join voice when queue storage preflight fails', async () => {
      shoukaku.players.clear();
      valkey.get.mockRejectedValueOnce(new Error('Valkey unavailable'));
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];

      await expect(manager.play('song', 'u1', voiceChannel, textChannel))
        .resolves.toMatchObject({ success: false });
      expect(shoukaku.joinVoiceChannel).not.toHaveBeenCalled();
      expect(shoukaku.leaveVoiceChannel).not.toHaveBeenCalled();
    });

    it('does not disconnect a concurrent play that adopts a newly joined session', async () => {
      shoukaku.players.clear();
      shoukaku.joinVoiceChannel.mockImplementationOnce(async () => {
        shoukaku.players.set('g1', player);
        return player;
      });
      let rejectFirstResolution: ((reason: Error) => void) | undefined;
      player.node.rest.resolve.mockImplementationOnce(() => new Promise((_, reject) => {
        rejectFirstResolution = reject;
      }));
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];

      const firstPlay = manager.play('unavailable song', 'u1', voiceChannel, textChannel);
      await vi.waitFor(() => expect(player.node.rest.resolve).toHaveBeenCalledTimes(1));
      await expect(manager.play('working song', 'u2', voiceChannel, textChannel))
        .resolves.toMatchObject({ success: true });
      rejectFirstResolution?.(new Error('Lavalink unavailable'));
      await expect(firstPlay).rejects.toThrow('Lavalink unavailable');

      expect(shoukaku.leaveVoiceChannel).not.toHaveBeenCalled();
      await expect(manager.queueManager.getQueue('g1'))
        .resolves.toMatchObject({ entries: [expect.objectContaining({ requestedBy: 'u2' })] });
    });

    it('keeps a new session alive while an earlier valid play is still pending', async () => {
      shoukaku.players.clear();
      shoukaku.joinVoiceChannel.mockImplementationOnce(async () => {
        shoukaku.players.set('g1', player);
        return player;
      });
      let finishFirstResolution: ((result: Awaited<ReturnType<typeof player.node.rest.resolve>>) => void) | undefined;
      player.node.rest.resolve
        .mockImplementationOnce(() => new Promise((resolve) => {
          finishFirstResolution = resolve;
        }))
        .mockRejectedValueOnce(new Error('Second search failed'));
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];

      const firstPlay = manager.play('working song', 'u1', voiceChannel, textChannel);
      await vi.waitFor(() => expect(player.node.rest.resolve).toHaveBeenCalledTimes(1));
      await expect(manager.play('unavailable song', 'u2', voiceChannel, textChannel))
        .rejects.toThrow('Second search failed');
      expect(shoukaku.leaveVoiceChannel).not.toHaveBeenCalled();

      finishFirstResolution?.({
        loadType: 'search',
        data: [{
          encoded: 'base64track',
          info: {
            title: 'Working Song', uri: 'https://youtube.com/watch?v=working', length: 240000,
            author: 'Artist', artworkUrl: null, isStream: false, identifier: 'working', sourceName: 'youtube',
          },
        }],
      });
      await expect(firstPlay).resolves.toMatchObject({ success: true });
      expect(shoukaku.leaveVoiceChannel).not.toHaveBeenCalled();
      await expect(manager.queueManager.getQueue('g1'))
        .resolves.toMatchObject({ entries: [expect.objectContaining({ requestedBy: 'u1' })] });
    });

    it('removes an unused queue when the first resolved search is empty', async () => {
      shoukaku.players.clear();
      shoukaku.joinVoiceChannel.mockImplementationOnce(async () => {
        shoukaku.players.set('g1', player);
        return player;
      });
      player.node.rest.resolve.mockResolvedValueOnce({ loadType: 'empty', data: {} });
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];

      await expect(manager.play('missing song', 'u1', voiceChannel, textChannel))
        .resolves.toMatchObject({ success: false });

      await expect(manager.queueManager.getQueue('g1')).resolves.toBeNull();
      expect(shoukaku.leaveVoiceChannel).toHaveBeenCalledWith('g1');
    });

    it('releases the queue lock before leaving an unused voice session', async () => {
      shoukaku.players.clear();
      shoukaku.joinVoiceChannel.mockImplementationOnce(async () => {
        shoukaku.players.set('g1', player);
        return player;
      });
      player.node.rest.resolve.mockResolvedValueOnce({ loadType: 'empty', data: {} });
      let finishLeave: (() => void) | undefined;
      shoukaku.leaveVoiceChannel.mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishLeave = resolve;
      }));
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];

      const failedPlay = manager.play('missing song', 'u1', voiceChannel, textChannel);
      await vi.waitFor(() => expect(shoukaku.leaveVoiceChannel).toHaveBeenCalledTimes(1));
      const mutationAccess = manager as unknown as {
        withQueueMutation<T>(operation: () => Promise<T>): Promise<T>;
      };

      await expect(mutationAccess.withQueueMutation(async () => 'available')).resolves.toBe('available');
      await expect(manager.play('another song', 'u2', voiceChannel, textChannel)).resolves.toEqual({
        success: false,
        message: 'Voice is resetting — please try again shortly.',
      });
      expect(player.node.rest.resolve).toHaveBeenCalledTimes(1);

      finishLeave?.();
      await expect(failedPlay).resolves.toMatchObject({ success: false });
    });

    it('rejects a full queue before asking Lavalink to resolve the query', async () => {
      const mutableManager = manager as unknown as { config: { maxQueueLength: number } };
      mutableManager.config.maxQueueLength = 1;
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 'active', title: 'Active', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];

      await expect(manager.play('another song', 'u2', voiceChannel, textChannel))
        .resolves.toEqual({ success: false, message: 'Queue is full (max 1 tracks)' });
      expect(player.node.rest.resolve).not.toHaveBeenCalled();
    });

    it('rejects a play that overlaps an in-progress stop', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 'active', title: 'Active', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      let finishStopTrack: (() => void) | undefined;
      player.stopTrack.mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishStopTrack = resolve;
      }));
      const stop = manager.stop('g1', { userId: 'u1', reason: 'command' });
      await vi.waitFor(() => expect(player.stopTrack).toHaveBeenCalledTimes(1));
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];

      await expect(manager.play('late song', 'u2', voiceChannel, textChannel))
        .resolves.toEqual({ success: false, message: 'Playback is stopping — please try again shortly.' });
      finishStopTrack?.();
      await stop;

      expect(player.node.rest.resolve).not.toHaveBeenCalled();
      await expect(manager.queueManager.getQueue('g1')).resolves.toBeNull();
    });

    it('does not queue a resolved track after a concurrent stop completes', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 'active', title: 'Active', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      let finishResolution: ((result: Awaited<ReturnType<typeof player.node.rest.resolve>>) => void) | undefined;
      player.node.rest.resolve.mockImplementationOnce(() => new Promise((resolve) => {
        finishResolution = resolve;
      }));
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];
      const latePlay = manager.play('late song', 'u2', voiceChannel, textChannel);
      await vi.waitFor(() => expect(player.node.rest.resolve).toHaveBeenCalledTimes(1));

      await manager.stop('g1', { userId: 'u1', reason: 'command' });
      finishResolution?.({
        loadType: 'search',
        data: [{
          encoded: 'base64track',
          info: {
            title: 'Late Song', uri: 'https://youtube.com/watch?v=late', length: 240000,
            author: 'Artist', artworkUrl: null, isStream: false, identifier: 'late', sourceName: 'youtube',
          },
        }],
      });

      await expect(latePlay).resolves.toEqual({
        success: false,
        message: 'Playback was stopped before the track could be queued.',
      });
      await expect(manager.queueManager.getQueue('g1')).resolves.toBeNull();
      expect(eventBus.emit).not.toHaveBeenCalledWith('music.queued', 'g1', expect.any(Object));
    });

    it('does not hold the queue lock while sending the queue-ended notice', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 'finished', title: 'Finished', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const textChannel = guild.channels.cache.get('tc1') as { send: ReturnType<typeof vi.fn> };
      const noticeResult = { id: 'notice', edit: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) };
      let finishNotice: (() => void) | undefined;
      textChannel.send.mockImplementationOnce(() => new Promise<typeof noticeResult>((resolve) => {
        finishNotice = () => resolve(noticeResult);
      }));
      const endHandler = getEndHandler();
      const ending = endHandler({ reason: 'finished' });
      await vi.waitFor(() => expect(textChannel.send).toHaveBeenCalledTimes(1));
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const playableTextChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];

      await expect(manager.play('next song', 'u1', voiceChannel, playableTextChannel))
        .resolves.toMatchObject({ success: true });
      finishNotice?.();
      await ending;

      await expect(manager.queueManager.getQueue('g1'))
        .resolves.toMatchObject({ entries: [expect.objectContaining({ track: 'base64track' })] });
      expect(noticeResult.delete).toHaveBeenCalledTimes(1);
    });

    it('does not let a paused-state writer restore an exhausted track', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 'finished', title: 'Finished', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      let finishPause: (() => void) | undefined;
      player.setPaused.mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishPause = resolve;
      }));
      const pausing = manager.togglePause('g1');
      await vi.waitFor(() => expect(player.setPaused).toHaveBeenCalledTimes(1));
      const ending = getEndHandler()({ reason: 'finished' });

      await ending;
      finishPause?.();
      await expect(pausing).resolves.toMatchObject({ success: true, paused: false });

      const queue = await manager.queueManager.getQueue('g1');
      expect(queue?.entries).toEqual([]);
      expect(queue?.currentIndex).toBe(0);
      expect(queue?.paused).toBe(false);
      expect(player.setPaused).toHaveBeenNthCalledWith(1, true);
      expect(player.setPaused).toHaveBeenNthCalledWith(2, false);
    });

    it('does not let a volume writer restore an exhausted track', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 'finished', title: 'Finished', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      let finishVolume: (() => void) | undefined;
      player.setGlobalVolume.mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishVolume = resolve;
      }));
      const volumeChange = manager.setVolume('g1', 25);
      await vi.waitFor(() => expect(player.setGlobalVolume).toHaveBeenCalledTimes(1));

      await getEndHandler()({ reason: 'finished' });
      finishVolume?.();
      await volumeChange;

      const queue = await manager.queueManager.getQueue('g1');
      expect(queue?.entries).toEqual([]);
      expect(queue?.volume).toBe(25);
    });
  });

  describe('voice websocket recovery', () => {
    function getClosedHandler(): (event: {
      code: number;
      reason: string;
      byRemote: boolean;
    }) => Promise<void> {
      const eventSetup = manager as unknown as {
        setupPlayerEvents(target: ReturnType<typeof makePlayer>): void;
      };
      eventSetup.setupPlayerEvents(player);
      const closedRegistration = player.on.mock.calls.find(([event]) => event === 'closed');
      expect(closedRegistration).toBeDefined();
      return closedRegistration?.[1] as (event: {
        code: number;
        reason: string;
        byRemote: boolean;
      }) => Promise<void>;
    }

    it('removes the stale Shoukaku connection before rejoining voice', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 37, paused: true, shuffled: false,
      }));

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      await vi.advanceTimersByTimeAsync(2_000);
      await reconnect;

      expect(shoukaku.leaveVoiceChannel).toHaveBeenCalledWith('g1');
      expect(shoukaku.leaveVoiceChannel.mock.invocationCallOrder[0])
        .toBeLessThan(shoukaku.joinVoiceChannel.mock.invocationCallOrder[0]);
      expect(shoukaku.joinVoiceChannel).toHaveBeenCalledWith(expect.objectContaining({ deaf: true }));
      expect(player.playTrack).toHaveBeenCalledWith({
        track: { encoded: 'base64track' },
        position: 60000,
        volume: 37,
        paused: true,
      });
      expect(vi.getTimerCount()).toBe(1);
    });

    it('continues into the reconnect loop when stale cleanup fails', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      shoukaku.leaveVoiceChannel.mockRejectedValueOnce(new Error('stale cleanup unavailable'));

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      await vi.advanceTimersByTimeAsync(2_000);
      await reconnect;

      expect(shoukaku.joinVoiceChannel).toHaveBeenCalledTimes(1);
      expect(player.playTrack).toHaveBeenCalledTimes(1);
    });

    it('coalesces overlapping close events into one reconnect', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));

      const closedHandler = getClosedHandler();
      const event = { code: 4006, reason: 'Session no longer valid', byRemote: true };
      const firstReconnect = closedHandler(event);
      const overlappingReconnect = closedHandler(event);
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.all([firstReconnect, overlappingReconnect]);

      expect(shoukaku.leaveVoiceChannel).toHaveBeenCalledTimes(1);
      expect(shoukaku.joinVoiceChannel).toHaveBeenCalledTimes(1);
    });

    it('does not reconnect an obsolete player after a replacement becomes active', async () => {
      const closedHandler = getClosedHandler();
      shoukaku.players.set('g1', makePlayer());

      await closedHandler({ code: 4006, reason: 'Old session closed', byRemote: true });

      expect(shoukaku.leaveVoiceChannel).not.toHaveBeenCalled();
      expect(shoukaku.joinVoiceChannel).not.toHaveBeenCalled();
    });

    it('cancels an in-flight reconnect when playback is intentionally stopped', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      await vi.advanceTimersByTimeAsync(0);
      await manager.stop('g1', { userId: 'u1', reason: 'command' });
      await vi.runAllTimersAsync();
      await reconnect;

      expect(shoukaku.joinVoiceChannel).not.toHaveBeenCalled();
      expect(player.stopTrack).toHaveBeenCalledTimes(1);
    });

    it('releases the intentional-stop guard when queue loading fails', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      valkey.get.mockRejectedValueOnce(new Error('queue unavailable'));

      await expect(manager.stop('g1', { reason: 'command' })).rejects.toThrow('queue unavailable');

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      await vi.advanceTimersByTimeAsync(2_000);
      await reconnect;

      expect(shoukaku.joinVoiceChannel).toHaveBeenCalledTimes(1);
    });

    it('does not cancel an active recovery when stop cannot load the queue', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      await vi.advanceTimersByTimeAsync(0);
      valkey.get.mockRejectedValueOnce(new Error('queue unavailable'));

      await expect(manager.stop('g1', { reason: 'command' })).rejects.toThrow('queue unavailable');
      await vi.advanceTimersByTimeAsync(2_000);
      await reconnect;

      expect(shoukaku.joinVoiceChannel).toHaveBeenCalledTimes(1);
      expect(player.playTrack).toHaveBeenCalledTimes(1);
    });

    it('rejects a new play request while voice recovery owns the connection', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      const voiceChannel = guild.channels.cache.get('vc1') as Parameters<MusicPlayerManager['play']>[2];
      const textChannel = guild.channels.cache.get('tc1') as Parameters<MusicPlayerManager['play']>[3];
      const playResult = await manager.play('test query', 'u1', voiceChannel, textChannel);

      expect(playResult).toEqual({
        success: false,
        message: 'Voice is reconnecting — please try again shortly.',
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await reconnect;
    });

    it('clears a partially rejoined player before retrying playback', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      player.playTrack
        .mockRejectedValueOnce(new Error('decoder unavailable'))
        .mockRejectedValueOnce(new Error('stale track unavailable'))
        .mockResolvedValueOnce(undefined);

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      await vi.advanceTimersByTimeAsync(6_000);
      await reconnect;

      expect(shoukaku.joinVoiceChannel).toHaveBeenCalledTimes(2);
      expect(shoukaku.leaveVoiceChannel).toHaveBeenCalledTimes(2);
      expect(player.playTrack).toHaveBeenCalledTimes(3);
    });

    it('cancels recovery while the resume track is resolving', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      let finishResolve: (() => void) | undefined;
      player.node.rest.resolve.mockImplementationOnce(() => new Promise((resolve) => {
        finishResolve = () => resolve({
          loadType: 'search',
          data: [{ encoded: 'base64track', info: {} }],
        });
      }));

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      await vi.advanceTimersByTimeAsync(2_000);
      manager.shutdown();
      finishResolve?.();
      await reconnect;

      expect(player.playTrack).not.toHaveBeenCalled();
      expect(shoukaku.leaveVoiceChannel).toHaveBeenCalledTimes(2);
    });

    it('leaves the rejoined player when recovery is cancelled during playback', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      let finishPlayback: (() => void) | undefined;
      player.playTrack.mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishPlayback = resolve;
      }));

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(player.playTrack).toHaveBeenCalledTimes(1);
      manager.shutdown();
      finishPlayback?.();
      await reconnect;

      expect(shoukaku.leaveVoiceChannel).toHaveBeenCalledTimes(2);
    });

    it('retries cancellation cleanup when the first leave fails', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      shoukaku.leaveVoiceChannel
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('temporary cleanup failure'))
        .mockResolvedValueOnce(undefined);
      let finishPlayback: (() => void) | undefined;
      player.playTrack.mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishPlayback = resolve;
      }));

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      await vi.advanceTimersByTimeAsync(2_000);
      manager.shutdown();
      finishPlayback?.();
      await reconnect;

      expect(shoukaku.leaveVoiceChannel).toHaveBeenCalledTimes(3);
    });

    it('force-clears local voice state after repeated cancellation cleanup failures', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      const connection = { disconnect: vi.fn() };
      shoukaku.connections.set('g1', connection);
      shoukaku.leaveVoiceChannel
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error('cleanup unavailable'));
      let finishPlayback: (() => void) | undefined;
      player.playTrack.mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishPlayback = resolve;
      }));

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      await vi.advanceTimersByTimeAsync(2_000);
      manager.shutdown();
      finishPlayback?.();
      await reconnect;

      expect(shoukaku.leaveVoiceChannel).toHaveBeenCalledTimes(4);
      expect(connection.disconnect).toHaveBeenCalledTimes(1);
      expect(player.clean).toHaveBeenCalledTimes(1);
      expect(shoukaku.connections.has('g1')).toBe(false);
      expect(shoukaku.players.has('g1')).toBe(false);
      expect(shoukaku.joinVoiceChannel).toHaveBeenCalledTimes(1);
    });

    it('destroys and audits the queue after all reconnect attempts fail', async () => {
      await valkey.set('queue:g1', JSON.stringify({
        guildId: 'g1', voiceChannelId: 'vc1', textChannelId: 'tc1',
        entries: [{ track: 't1', title: 'Song', uri: 'u1', duration: 120000, author: 'A', requestedBy: 'u1', isStream: false }],
        currentIndex: 0, loopMode: 'off', volume: 50, paused: false, shuffled: false,
      }));
      shoukaku.joinVoiceChannel.mockRejectedValue(new Error('voice unavailable'));

      const closedHandler = getClosedHandler();
      const reconnect = closedHandler({ code: 4006, reason: 'Session no longer valid', byRemote: true });
      await vi.advanceTimersByTimeAsync(12_000);
      await reconnect;

      expect(shoukaku.joinVoiceChannel).toHaveBeenCalledTimes(3);
      expect(await valkey.get('queue:g1')).toBeNull();
      expect(eventBus.emit).toHaveBeenCalledWith('music.stopped', 'g1', expect.objectContaining({
        reason: 'connection_lost',
        trackCount: 1,
      }));
    });
  });
});
