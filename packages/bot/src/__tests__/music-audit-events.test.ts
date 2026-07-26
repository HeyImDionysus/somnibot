/**
 * [music-player-fairness] + [music-collaborative-queue] observability wiring.
 *
 * Asserts MusicPlayerManager emits the append-only audit events on each
 * state change / denied attempt / failure branch (spying the event bus), so
 * the music.* audit lane is no longer inert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; }
    setDescription() { return this; } addFields() { return this; }
    setFooter() { return this; } setTimestamp() { return this; }
    setThumbnail() { return this; } setImage() { return this; }
    setAuthor() { return this; } setURL() { return this; }
  },
  ActionRowBuilder: class { addComponents() { return this; } },
  ButtonBuilder: class {
    setCustomId() { return this; } setLabel() { return this; }
    setStyle() { return this; } setEmoji() { return this; } setDisabled() { return this; }
  },
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildStageVoice: 13 },
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { MusicPlayerManager } from '../features/music/music-player.js';

function makePlayer() {
  return {
    track: 'encodedTrack',
    position: 0,
    playTrack: vi.fn().mockResolvedValue(undefined),
    stopTrack: vi.fn().mockResolvedValue(undefined),
    setPaused: vi.fn().mockResolvedValue(undefined),
    setGlobalVolume: vi.fn().mockResolvedValue(undefined),
    node: { rest: { resolve: vi.fn() } },
  };
}

function makeShoukaku(player?: ReturnType<typeof makePlayer>) {
  const players = new Map<string, unknown>();
  if (player) players.set('g1', player);
  return {
    players,
    nodes: new Map([['main', { name: 'main' }]]),
    options: { nodeResolver: vi.fn().mockReturnValue({ name: 'main' }) },
    connections: new Map(),
    joinVoiceChannel: vi.fn().mockResolvedValue(player ?? makePlayer()),
    leaveVoiceChannel: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}

function makeSupabase(insert = vi.fn().mockResolvedValue({ error: null })) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'update', 'upsert', 'maybeSingle', 'single']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null });
  chain.single = vi.fn().mockResolvedValue({ data: null });
  chain.insert = insert;
  return { from: vi.fn().mockReturnValue(chain), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

function makeGuild() {
  return { id: 'g1', channels: { cache: new Map() }, members: { cache: new Map(), fetch: vi.fn() } };
}

function makeEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
}

function makeValkey() {
  return { get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() };
}

const TRACK = { track: 'enc', title: 'Song', author: 'Artist', duration: 1000, uri: 'u', artworkUrl: null, requestedBy: 'u9', addedAt: 0 };

describe('music audit events', () => {
  let manager: MusicPlayerManager;
  let eventBus: ReturnType<typeof makeEventBus>;
  let player: ReturnType<typeof makePlayer>;
  let queueSpies: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = makeEventBus();
    player = makePlayer();
    manager = new MusicPlayerManager(
      makeGuild() as never,
      makeShoukaku(player) as never,
      makeSupabase() as never,
      makeValkey() as never,
      eventBus as never,
    );

    // Control queue state directly on the instance so we exercise the real
    // player logic without a live Valkey store.
    queueSpies = {
      clearVoteSkip: vi.fn().mockResolvedValue(undefined),
      getCurrentTrack: vi.fn().mockResolvedValue({ ...TRACK }),
      nextTrack: vi.fn().mockResolvedValue({ track: null, queueEnded: true }),
      getQueue: vi.fn().mockResolvedValue({ guildId: 'g1', entries: [{ ...TRACK }], currentIndex: 0 }),
      destroyQueue: vi.fn().mockResolvedValue(undefined),
      createQueue: vi.fn(),
      saveQueue: vi.fn().mockResolvedValue(undefined),
    };
    Object.assign(manager.queueManager, queueSpies);
  });

  it('emits music.skipped with the fairness method when a skip resolves', async () => {
    await manager.skip('g1', { userId: 'u1', method: 'vote' });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'music.skipped',
      'g1',
      expect.objectContaining({ userId: 'u1', method: 'vote', title: 'Song', requestedBy: 'u9', queueEnded: true }),
    );
  });

  it('emits music.stopped with the teardown reason when playback stops', async () => {
    await manager.stop('g1', { userId: 'u1', reason: 'command' });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'music.stopped',
      'g1',
      expect.objectContaining({ userId: 'u1', reason: 'command', trackCount: 1 }),
    );
  });

  it('emits music.denied when a fairness-gated control is refused', () => {
    manager.auditPermissionDenied('u1', 'volume');

    expect(eventBus.emit).toHaveBeenCalledWith('music.denied', 'g1', { userId: 'u1', action: 'volume' });
  });

  it('emits music.capacity_rejected when the queue is full', async () => {
    queueSpies.getQueue.mockResolvedValue({
      guildId: 'g1',
      entries: new Array(500).fill({ ...TRACK }),
      currentIndex: 0,
    });

    const result = await manager.play('song', 'u1', { id: 'vc1' } as never, { id: 'tc1' } as never);

    expect(result.success).toBe(false);
    expect(eventBus.emit).toHaveBeenCalledWith(
      'music.capacity_rejected',
      'g1',
      expect.objectContaining({ userId: 'u1', reason: 'queue_full', limit: 500 }),
    );
  });

  it('emits music.store_outage and raises an owner alert when the queue store is unreachable', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = makeSupabase(insert);
    manager = new MusicPlayerManager(
      makeGuild() as never,
      makeShoukaku(player) as never,
      supabase as never,
      makeValkey() as never,
      eventBus as never,
    );
    (manager.queueManager as unknown as { getQueue: ReturnType<typeof vi.fn> }).getQueue =
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await manager.play('song', 'u1', { id: 'vc1' } as never, { id: 'tc1' } as never);

    expect(result.success).toBe(false);
    expect(eventBus.emit).toHaveBeenCalledWith(
      'music.store_outage',
      'g1',
      expect.objectContaining({ userId: 'u1', operation: 'load_queue', error: 'ECONNREFUSED' }),
    );
    expect(supabase.from).toHaveBeenCalledWith('alerts');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ alert_type: 'music_store_outage' }));
  });
});
