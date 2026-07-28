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
    // Real EmbedBuilder always exposes `data` (branded embeds read
    // data.footer to append attribution without clobbering it).
    data: Record<string, unknown> = {};
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
    seekTo: vi.fn().mockResolvedValue(undefined),
    setFilters: vi.fn().mockResolvedValue(undefined),
    clearFilters: vi.fn().mockResolvedValue(undefined),
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

  it('uses the same canonical control vocabulary for denied music buttons', async () => {
    vi.spyOn(manager, 'isDJ').mockResolvedValue(false);

    for (const buttonId of [
      'music:pause_resume',
      'music:stop',
      'music:shuffle',
      'music:loop',
      'music:vol_down',
      'music:vol_up',
    ]) {
      await manager.handleButton(buttonId, 'u1');
    }

    const actions = eventBus.emit.mock.calls
      .filter((call) => call[0] === 'music.denied')
      .map((call) => (call[2] as { action: string }).action);
    expect(actions).toEqual(['pause', 'stop', 'shuffle', 'loop', 'volume', 'volume']);
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

  // ── Symmetry: the ADD side of the queue ─────────────────────────────────

  it('emits music.queued when a track is added — the counterpart of music.skipped', async () => {
    queueSpies.getQueue.mockResolvedValue(null); // no queue yet → session start
    queueSpies.createQueue.mockReturnValue({
      guildId: 'g1', entries: [], currentIndex: 0, volume: 50, voiceChannelId: 'vc1',
    });
    player.node.rest.resolve.mockResolvedValue({
      loadType: 'search',
      data: [{ encoded: 'enc', info: { title: 'Song', author: 'Artist', length: 1000, uri: 'https://x/y', isStream: false } }],
    });

    const result = await manager.play('song', 'u1', { id: 'vc1' } as never, { id: 'tc1' } as never);

    expect(result.success).toBe(true);
    expect(eventBus.emit).toHaveBeenCalledWith(
      'music.queued',
      'g1',
      expect.objectContaining({
        userId: 'u1',
        title: 'Song',
        author: 'Artist',
        uri: 'https://x/y',
        trackCount: 1,
        playlistName: null,
        sessionStarted: true,
      }),
    );
  });

  it('records the queue add ONCE and never as a control row (the restore volume is internal)', async () => {
    queueSpies.getQueue.mockResolvedValue(null);
    queueSpies.createQueue.mockReturnValue({
      guildId: 'g1', entries: [], currentIndex: 0, volume: 50, voiceChannelId: 'vc1',
    });
    player.node.rest.resolve.mockResolvedValue({
      loadType: 'search',
      data: [{ encoded: 'enc', info: { title: 'Song', author: 'Artist', length: 1000, uri: 'u', isStream: false } }],
    });

    await manager.play('song', 'u1', { id: 'vc1' } as never, { id: 'tc1' } as never);

    const emitted = eventBus.emit.mock.calls.map((c) => c[0]);
    expect(emitted.filter((t) => t === 'music.queued')).toHaveLength(1);
    // play() re-applies the queue's stored volume; that restore is not a
    // member control change and must leave no audit row.
    expect(emitted).not.toContain('music.control_applied');
  });

  it('audits a persisted queue add even when initial playback setup fails', async () => {
    queueSpies.getQueue.mockResolvedValue(null);
    queueSpies.createQueue.mockReturnValue({
      guildId: 'g1', entries: [], currentIndex: 0, volume: 50, voiceChannelId: 'vc1',
    });
    player.node.rest.resolve.mockResolvedValue({
      loadType: 'search',
      data: [{ encoded: 'enc', info: { title: 'Song', author: 'Artist', length: 1000, uri: 'u', isStream: false } }],
    });
    player.playTrack.mockRejectedValue(new Error('playback failed'));

    await expect(
      manager.play('song', 'u1', { id: 'vc1' } as never, { id: 'tc1' } as never),
    ).rejects.toThrow('playback failed');

    expect(queueSpies.saveQueue).toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      'music.queued',
      'g1',
      expect.objectContaining({ userId: 'u1', title: 'Song', trackCount: 1 }),
    );
  });

  it('emits ONE music.queued for a whole playlist add, naming the playlist', async () => {
    queueSpies.getQueue.mockResolvedValue({ guildId: 'g1', entries: [], currentIndex: 0, volume: 50 });
    player.node.rest.resolve.mockResolvedValue({
      loadType: 'playlist',
      data: {
        info: { name: 'Road Trip' },
        tracks: [
          { encoded: 'e1', info: { title: 'One', author: 'A', length: 1, uri: 'u1', isStream: false } },
          { encoded: 'e2', info: { title: 'Two', author: 'B', length: 1, uri: 'u2', isStream: false } },
        ],
      },
    });

    await manager.play('list', 'u1', { id: 'vc1' } as never, { id: 'tc1' } as never);

    const queued = eventBus.emit.mock.calls.filter((c) => c[0] === 'music.queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]![2]).toMatchObject({ trackCount: 2, playlistName: 'Road Trip', title: 'Road Trip' });
  });

  // ── Symmetry: applied controls mirror the denials ───────────────────────

  it('emits music.control_applied for every fairness-gated control that audits its denial', async () => {
    Object.assign(manager.queueManager, {
      shuffle: vi.fn().mockResolvedValue(true),
      removeEntry: vi.fn().mockResolvedValue({ ...TRACK, title: 'Gone' }),
      moveEntry: vi.fn().mockResolvedValue(true),
    });
    queueSpies.getQueue.mockResolvedValue({
      guildId: 'g1',
      entries: [{ ...TRACK }, { ...TRACK, title: 'Next' }, { ...TRACK, title: 'Third' }],
      currentIndex: 0,
      volume: 50,
      paused: false,
      loopMode: 'off',
    });
    queueSpies.getCurrentTrack.mockResolvedValue({ ...TRACK, isStream: false, duration: 5000 });

    await manager.togglePause('g1', { userId: 'u1' });
    await manager.setVolume('g1', 80, { userId: 'u1' });
    await manager.setLoopMode('g1', 'track', { userId: 'u1' });
    await manager.seek('g1', 1000, { userId: 'u1' });
    await manager.shuffle('g1', { userId: 'u1' });
    await manager.remove('g1', 1, { userId: 'u1' });
    await manager.applyFilter('g1', 'reset', { userId: 'u1' });
    await manager.move('g1', 'u9', 1, 2);

    const applied = eventBus.emit.mock.calls
      .filter((c) => c[0] === 'music.control_applied')
      .map((c) => (c[2] as { action: string }).action);

    // The exact vocabulary auditPermissionDenied uses for these controls.
    expect(new Set(applied)).toEqual(
      new Set(['pause', 'volume', 'loop', 'seek', 'shuffle', 'remove', 'filter', 'move']),
    );
    expect(applied).toHaveLength(8);
  });

  it('carries the applied value and the actor on the control row', async () => {
    queueSpies.getQueue.mockResolvedValue({ guildId: 'g1', entries: [], currentIndex: 0, volume: 50, loopMode: 'off' });

    await manager.setVolume('g1', 80, { userId: 'u1' });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'music.control_applied',
      'g1',
      { userId: 'u1', action: 'volume', value: 80 },
    );
  });

  it('does not invent a member control audit for an internal caller without userId', async () => {
    queueSpies.getQueue.mockResolvedValue({ guildId: 'g1', entries: [], currentIndex: 0, volume: 50, loopMode: 'off' });

    await manager.setVolume('g1', 80);

    expect(eventBus.emit.mock.calls.filter((call) => call[0] === 'music.control_applied'))
      .toHaveLength(0);
  });

  it('emits exactly one combined filter control result', () => {
    manager.auditFilterActionApplied('u1', 'bassboost', 1.2, 0.8, 1.1);

    const applied = eventBus.emit.mock.calls.filter((call) => call[0] === 'music.control_applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]![2]).toEqual({
      userId: 'u1',
      action: 'filter',
      value: 'preset: bassboost, speed: 1.2x, pitch: 0.8x, rate: 1.1x',
    });
  });

  it('records ONE control row when cycleLoopMode delegates to setLoopMode', async () => {
    queueSpies.getQueue.mockResolvedValue({ guildId: 'g1', entries: [], currentIndex: 0, loopMode: 'off' });

    await manager.cycleLoopMode('g1', { userId: 'u1' });

    const applied = eventBus.emit.mock.calls.filter((c) => c[0] === 'music.control_applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]![2]).toMatchObject({ action: 'loop', value: 'queue' });
  });

  it('writes NO control row when a control does not apply (no active queue)', async () => {
    queueSpies.getQueue.mockResolvedValue(null);

    const loop = await manager.setLoopMode('g1', 'track', { userId: 'u1' });
    const shuffled = await manager.shuffle('g1', { userId: 'u1' });

    expect(loop.success).toBe(false);
    expect(shuffled.success).toBe(false);
    expect(eventBus.emit.mock.calls.filter((c) => c[0] === 'music.control_applied')).toHaveLength(0);
  });

  it('audits BOTH outcomes of a denied-then-allowed move', async () => {
    Object.assign(manager.queueManager, { moveEntry: vi.fn().mockResolvedValue(true) });
    queueSpies.getQueue.mockResolvedValue({
      guildId: 'g1',
      entries: [{ ...TRACK }, { ...TRACK, requestedBy: 'someone-else' }, { ...TRACK }],
      currentIndex: 0,
    });
    // A DJ role is configured and neither actor holds it → not a DJ, so the
    // requester-move fairness rule decides both outcomes.
    (manager as unknown as { config: Record<string, unknown> }).config = {
      ...manager.getConfig(), djRoleId: 'dj', requesterMoveEnabled: true,
    };
    const guild = (manager as unknown as { guild: ReturnType<typeof makeGuild> }).guild;
    guild.members.fetch = vi.fn().mockImplementation((id: string) =>
      Promise.resolve({ id, guild: { ownerId: 'owner' }, roles: { cache: new Map() }, permissions: { has: () => false } }),
    );

    const denied = await manager.move('g1', 'u1', 1, 2);
    expect(denied.success).toBe(false);
    expect(eventBus.emit).toHaveBeenCalledWith('music.denied', 'g1', { userId: 'u1', action: 'move' });

    const allowed = await manager.move('g1', 'someone-else', 1, 2);
    expect(allowed.success).toBe(true);
    expect(eventBus.emit).toHaveBeenCalledWith(
      'music.control_applied',
      'g1',
      { userId: 'someone-else', action: 'move', value: '1→2' },
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
