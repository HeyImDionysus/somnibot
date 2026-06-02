/**
 * music/commands — coverage tests (605 lines)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  SlashCommandBuilder: vi.fn().mockImplementation(() => {
    const self: any = {};
    for (const m of ['setName', 'setDescription', 'addStringOption', 'addIntegerOption', 'addNumberOption']) {
      self[m] = vi.fn().mockImplementation(function (this: any, cbOrVal: any) {
        if (typeof cbOrVal === 'function') {
          const opt: any = {};
          for (const o of ['setName', 'setDescription', 'setRequired', 'setAutocomplete', 'addChoices', 'setMinValue', 'setMaxValue']) {
            opt[o] = vi.fn().mockReturnValue(opt);
          }
          cbOrVal(opt);
        }
        return self;
      });
    }
    return self;
  }),
  ChannelType: { GuildText: 0, GuildVoice: 2 },
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../features/music/music-embeds.js', () => {
  const e = () => ({ mock: true });
  return {
    buildNowPlayingEmbed: vi.fn().mockReturnValue({ embeds: [e()], components: [] }),
    buildQueueEmbed: vi.fn().mockReturnValue({ embeds: [e()], components: [] }),
    buildAddedEmbed: vi.fn().mockReturnValue(e()),
    buildPlaylistAddedEmbed: vi.fn().mockReturnValue(e()),
    buildMusicErrorEmbed: vi.fn().mockReturnValue(e()),
    buildMusicInfoEmbed: vi.fn().mockReturnValue(e()),
    buildFilterEmbed: vi.fn().mockReturnValue(e()),
    formatDuration: vi.fn().mockReturnValue('3:00'),
  };
});

import { buildMusicCommands, handleMusicCommand } from '../features/music/commands.js';

function mp(overrides: any = {}) {
  return {
    play: vi.fn().mockResolvedValue({ success: true, entry: { title: 'S', author: 'A', duration: 180000 }, count: 1 }),
    skip: vi.fn().mockResolvedValue({ success: true, message: 'Skipped' }),
    voteSkip: vi.fn().mockResolvedValue({ success: true, message: 'Vote skip' }),
    stop: vi.fn().mockResolvedValue({ message: 'Stopped' }),
    setVolume: vi.fn().mockResolvedValue({ success: true, message: 'Volume set' }),
    setLoopMode: vi.fn().mockResolvedValue({ message: 'Loop set' }),
    shuffle: vi.fn().mockResolvedValue({ success: true, message: 'Shuffled' }),
    seek: vi.fn().mockResolvedValue({ success: true, message: 'Seeked' }),
    remove: vi.fn().mockResolvedValue({ success: true, message: 'Removed' }),
    togglePause: vi.fn().mockResolvedValue({ success: true, message: 'Toggled' }),
    applyFilter: vi.fn().mockResolvedValue({ success: true, message: 'Filter applied' }),
    applyCustomSpeed: vi.fn().mockResolvedValue({ success: true, message: 'Speed set' }),
    isDJ: vi.fn().mockResolvedValue(true),
    getPlayerPosition: vi.fn().mockReturnValue(45000),
    getCurrentTrack: vi.fn().mockReturnValue({ title: 'S' }),
    getActiveFilters: vi.fn().mockReturnValue([]),
    queueManager: {
      getQueue: vi.fn().mockResolvedValue({
        entries: [{ title: 'S', author: 'A', duration: 180000, requester: 'u1' }],
        currentIndex: 0,
        loop: 'off',
      }),
    },
    ...overrides,
  };
}

function mi(name: string, opts: any = {}) {
  return {
    commandName: name,
    options: {
      getString: vi.fn().mockImplementation((_n: string, _req?: boolean) => opts.str ?? null),
      getInteger: vi.fn().mockImplementation((_n: string, _req?: boolean) => opts.int ?? null),
      getNumber: vi.fn().mockReturnValue(opts.num ?? null),
    },
    user: { id: 'u1' },
    member: { id: 'u1', voice: { channel: opts.inVoice !== false ? { id: 'vc1', type: 2 } : null } },
    channel: opts.noChannel ? null : { id: 'ch1', type: 0 },
    guild: { id: 'g1' },
    guildId: 'g1',
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('buildMusicCommands', () => {
  it('returns array of commands', () => {
    const cmds = buildMusicCommands();
    expect(Array.isArray(cmds)).toBe(true);
  });
});

describe('handleMusicCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  // play
  it('play — success with single entry', async () => {
    const p = mp();
    const i = mi('play', { str: 'song' });
    await handleMusicCommand(i as any, p as any);
    expect(p.play).toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalled();
  });

  it('play — not in voice channel', async () => {
    const i = mi('play', { str: 'song', inVoice: false });
    await handleMusicCommand(i as any, mp() as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('play — no text channel', async () => {
    const i = mi('play', { str: 'song', noChannel: true });
    await handleMusicCommand(i as any, mp() as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('play — playlist result', async () => {
    const p = mp({ play: vi.fn().mockResolvedValue({ success: true, count: 5, playlistName: 'Vibes' }) });
    const i = mi('play', { str: 'playlist' });
    await handleMusicCommand(i as any, p as any);
    expect(i.editReply).toHaveBeenCalled();
  });

  it('play — failure', async () => {
    const p = mp({ play: vi.fn().mockResolvedValue({ success: false, message: 'Not found' }) });
    const i = mi('play', { str: 'x' });
    await handleMusicCommand(i as any, p as any);
    expect(i.editReply).toHaveBeenCalled();
  });

  // skip
  it('skip — DJ', async () => {
    const p = mp();
    const i = mi('skip');
    await handleMusicCommand(i as any, p as any);
    expect(p.skip).toHaveBeenCalledWith('g1');
  });

  it('skip — non-DJ vote skip', async () => {
    const p = mp({ isDJ: vi.fn().mockResolvedValue(false) });
    const i = mi('skip');
    await handleMusicCommand(i as any, p as any);
    expect(p.voteSkip).toHaveBeenCalledWith('g1', 'u1');
  });

  // stop
  it('stop — DJ', async () => {
    const p = mp();
    const i = mi('stop');
    await handleMusicCommand(i as any, p as any);
    expect(p.stop).toHaveBeenCalledWith('g1');
  });

  it('stop — non-DJ denied', async () => {
    const p = mp({ isDJ: vi.fn().mockResolvedValue(false) });
    const i = mi('stop');
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  // queue
  it('queue — has queue', async () => {
    const p = mp();
    const i = mi('queue');
    await handleMusicCommand(i as any, p as any);
    expect(p.queueManager.getQueue).toHaveBeenCalledWith('g1');
    expect(i.reply).toHaveBeenCalled();
  });

  it('queue — empty', async () => {
    const p = mp({ queueManager: { getQueue: vi.fn().mockResolvedValue(null) } });
    const i = mi('queue');
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  // np
  it('np — currently playing', async () => {
    const p = mp();
    const i = mi('np');
    await handleMusicCommand(i as any, p as any);
    expect(p.getPlayerPosition).toHaveBeenCalledWith('g1');
    expect(i.reply).toHaveBeenCalled();
  });

  it('np — no queue', async () => {
    const p = mp({ queueManager: { getQueue: vi.fn().mockResolvedValue(null) } });
    const i = mi('np');
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('np — no current track', async () => {
    const p = mp({
      queueManager: { getQueue: vi.fn().mockResolvedValue({ entries: [], currentIndex: 0 }) },
    });
    const i = mi('np');
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  // volume
  it('volume — DJ sets volume', async () => {
    const p = mp();
    const i = mi('volume', { int: 75 });
    await handleMusicCommand(i as any, p as any);
    expect(p.setVolume).toHaveBeenCalledWith('g1', 75);
  });

  it('volume — non-DJ denied', async () => {
    const p = mp({ isDJ: vi.fn().mockResolvedValue(false) });
    const i = mi('volume', { int: 75 });
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  // loop
  it('loop — DJ sets loop', async () => {
    const p = mp();
    const i = mi('loop', { str: 'track' });
    await handleMusicCommand(i as any, p as any);
    expect(p.setLoopMode).toHaveBeenCalledWith('g1', 'track');
  });

  it('loop — non-DJ denied', async () => {
    const p = mp({ isDJ: vi.fn().mockResolvedValue(false) });
    const i = mi('loop', { str: 'track' });
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  // shuffle
  it('shuffle', async () => {
    const p = mp();
    const i = mi('shuffle');
    await handleMusicCommand(i as any, p as any);
    expect(p.shuffle).toHaveBeenCalledWith('g1');
  });

  it('shuffle — non-DJ denied', async () => {
    const p = mp({ isDJ: vi.fn().mockResolvedValue(false) });
    const i = mi('shuffle');
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  // seek
  it('seek — valid position mm:ss', async () => {
    const p = mp();
    const i = mi('seek', { str: '1:30' });
    await handleMusicCommand(i as any, p as any);
    expect(p.seek).toHaveBeenCalledWith('g1', 90000);
  });

  it('seek — invalid format', async () => {
    const p = mp();
    const i = mi('seek', { str: 'abc' });
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('seek — non-DJ denied', async () => {
    const p = mp({ isDJ: vi.fn().mockResolvedValue(false) });
    const i = mi('seek', { str: '1:30' });
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  // remove
  it('remove', async () => {
    const p = mp();
    const i = mi('remove', { int: 2 });
    await handleMusicCommand(i as any, p as any);
    expect(p.remove).toHaveBeenCalledWith('g1', 2);
  });

  it('remove — non-DJ denied', async () => {
    const p = mp({ isDJ: vi.fn().mockResolvedValue(false) });
    const i = mi('remove', { int: 2 });
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  // pause
  it('pause — toggles', async () => {
    const p = mp();
    const i = mi('pause');
    await handleMusicCommand(i as any, p as any);
    expect(p.togglePause).toHaveBeenCalledWith('g1');
  });

  it('pause — non-DJ denied', async () => {
    const p = mp({ isDJ: vi.fn().mockResolvedValue(false) });
    const i = mi('pause');
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  // filter
  it('filter — show current filters (no args)', async () => {
    const p = mp();
    const i = mi('filter');
    await handleMusicCommand(i as any, p as any);
    expect(p.getActiveFilters).toHaveBeenCalledWith('g1');
  });

  it('filter — apply preset', async () => {
    const p = mp();
    const i = mi('filter', { str: 'bass' });
    await handleMusicCommand(i as any, p as any);
    expect(p.applyFilter).toHaveBeenCalledWith('g1', 'bass');
  });

  it('filter — apply custom speed', async () => {
    const p = mp();
    const i = mi('filter', { num: 1.5 });
    await handleMusicCommand(i as any, p as any);
    expect(p.applyCustomSpeed).toHaveBeenCalled();
  });

  it('filter — non-DJ denied', async () => {
    const p = mp({ isDJ: vi.fn().mockResolvedValue(false) });
    const i = mi('filter', { str: 'bass' });
    await handleMusicCommand(i as any, p as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  // unknown
  it('unknown command', async () => {
    const i = mi('nope');
    await handleMusicCommand(i as any, mp() as any);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});
