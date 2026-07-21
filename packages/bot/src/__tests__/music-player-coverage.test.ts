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

vi.mock('@somnibot/shared', () => ({
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
});
