/**
 * levels/commands — coverage tests (344 lines)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  SlashCommandBuilder: vi.fn().mockImplementation(function () {
    const self: any = {};
    for (const m of ['setName', 'setDescription', 'addSubcommand', 'addUserOption', 'addStringOption', 'addNumberOption', 'addBooleanOption']) {
      self[m] = vi.fn().mockImplementation(function (this: any, cbOrVal: any) {
        if (typeof cbOrVal === 'function') {
          const opt: any = {};
          for (const o of ['setName', 'setDescription', 'setRequired', 'setMinValue', 'setMaxValue', 'addUserOption', 'addStringOption', 'addNumberOption', 'addBooleanOption']) {
            opt[o] = vi.fn().mockImplementation(function (this: any, cb2: any) {
              if (typeof cb2 === 'function') {
                const o2: any = {};
                for (const k of ['setName', 'setDescription', 'setRequired', 'setMinValue', 'setMaxValue']) o2[k] = vi.fn().mockReturnValue(o2);
                cb2(o2);
              }
              return opt;
            });
          }
          cbOrVal(opt);
        }
        return self;
      });
    }
    return self;
  }),
  AttachmentBuilder: vi.fn().mockImplementation(function (_buf: any, opts: any) {
    return { name: opts?.name };
  }),
  ActionRowBuilder: vi.fn().mockImplementation(function () {
    return { addComponents: vi.fn().mockReturnThis() };
  }),
  ButtonBuilder: vi.fn().mockImplementation(function () {
    const b: any = {};
    for (const m of ['setCustomId', 'setLabel', 'setStyle', 'setDisabled']) b[m] = vi.fn().mockReturnValue(b);
    return b;
  }),
  ButtonStyle: { Primary: 1, Secondary: 2 },
  ComponentType: { Button: 2 },
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  levelProgress: vi.fn().mockReturnValue({ currentLevelXp: 100, xpForNextLevel: 500, progress: 0.2 }),
}));

vi.mock('../features/levels/rank-card.js', () => ({
  generateRankCard: vi.fn().mockResolvedValue(Buffer.from('PNG')),
  loadRankCardSettings: vi.fn().mockResolvedValue({
    accentColor: '#FF1493',
    progressBarColor: '#00FF00',
    overlayOpacity: 0.5,
    backgroundUrl: null,
  }),
}));

import { buildLevelCommands, handleRankCommand, handleLeaderboardCommand } from '../features/levels/commands.js';

function chain(val: any = { data: null, error: null, count: 0 }) {
  const c: any = {};
  for (const m of ['select', 'eq', 'gt', 'order', 'range', 'limit', 'maybeSingle', 'single', 'upsert', 'delete']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (res: any) => Promise.resolve(val).then(res);
  return c;
}

function client(data: any = null) {
  return {
    supabase: {
      from: vi.fn().mockReturnValue(chain({
        data: data ?? { level: 5, xp: 1200, total_messages: 100, member_id: 'u1' },
        error: null,
        count: 10,
      })),
    },
  };
}

function interaction(opts: any = {}) {
  return {
    options: {
      getSubcommand: vi.fn().mockReturnValue(opts.sub ?? 'view'),
      getUser: vi.fn().mockReturnValue(opts.user ?? null),
      getString: vi.fn().mockReturnValue(opts.str ?? null),
      getNumber: vi.fn().mockReturnValue(opts.num ?? null),
      getBoolean: vi.fn().mockReturnValue(opts.bool ?? null),
    },
    user: {
      id: 'u1',
      username: 'TestUser',
      displayAvatarURL: vi.fn().mockReturnValue('https://cdn.example.com/avatar.png'),
    },
    guild: {
      members: { cache: { get: vi.fn().mockReturnValue({ displayName: 'TestUser' }) } },
    },
    guildId: 'g1',
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({
      createMessageComponentCollector: vi.fn().mockReturnValue({
        on: vi.fn(),
      }),
    }),
    deferReply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('buildLevelCommands', () => {
  it('builds rank and leaderboard commands', () => {
    const cmds = buildLevelCommands();
    expect(cmds.rankCmd).toBeDefined();
    expect(cmds.leaderboardCmd).toBeDefined();
  });
});

describe('handleRankCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes to view subcommand', async () => {
    const c = client();
    const i = interaction();
    await handleRankCommand(i as any, c as any);
    expect(i.deferReply).toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalled();
  });

  it('routes to customize subcommand', async () => {
    const c = client();
    const i = interaction({ sub: 'customize' });
    await handleRankCommand(i as any, c as any);
    expect(i.deferReply).toHaveBeenCalledWith({ ephemeral: true });
  });

  it('handles no XP data', async () => {
    const c = client();
    c.supabase.from = vi.fn().mockReturnValue(chain({ data: null, error: null, count: 0 }));
    const i = interaction();
    await handleRankCommand(i as any, c as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('XP'),
    }));
  });

  it('handles customize with reset', async () => {
    const c = client();
    const i = interaction({ sub: 'customize', bool: true });
    await handleRankCommand(i as any, c as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('reset'),
    }));
  });
});

describe('handleLeaderboardCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows leaderboard', async () => {
    const c = client([
      { member_id: 'u1', xp: 1200, level: 5 },
      { member_id: 'u2', xp: 800, level: 3 },
    ]);
    const i = interaction();
    await handleLeaderboardCommand(i as any, c as any);
    expect(i.deferReply).toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalled();
  });

  it('handles empty leaderboard', async () => {
    const c = client();
    c.supabase.from = vi.fn().mockReturnValue(chain({ data: [], error: null, count: 0 }));
    const i = interaction();
    await handleLeaderboardCommand(i as any, c as any);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('No one'),
    }));
  });
});
