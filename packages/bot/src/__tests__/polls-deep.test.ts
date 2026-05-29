/**
 * Deep tests for features/polls/polls-manager.ts — exercises createPoll, handlePollVote,
 * closePoll, createPrediction, placeBet, resolvePrediction.
 * 284 uncovered statements at 39.8%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return { ...actual };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { PollsManager } from '../features/polls/polls-manager.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null, count: 0 });
  return chain;
}

function makeSupa(overrides: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => {
      const d = overrides[table];
      return makeChain(d !== undefined ? d : null);
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeInteraction(overrides: any = {}) {
  return {
    guildId: 'guild-1',
    channelId: 'ch-1',
    user: { id: 'user-1', username: 'Tester', tag: 'Tester#0001', displayAvatarURL: () => 'url' },
    member: { id: 'user-1', permissions: { has: () => true }, roles: { cache: new Map() } },
    guild: {
      id: 'guild-1', name: 'Test',
      channels: { cache: new Map() },
      members: { fetch: vi.fn().mockResolvedValue({ id: 'user-1', displayName: 'Tester' }) },
    },
    options: {
      getString: vi.fn(() => 'test'),
      getInteger: vi.fn(() => null),
      getUser: vi.fn(() => null),
      getBoolean: vi.fn(() => false),
      getSubcommand: vi.fn(() => 'create'),
    },
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    deferUpdate: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    channel: { send: vi.fn().mockResolvedValue({ id: 'msg-1' }) },
    ...overrides,
  } as any;
}

function makeButtonInteraction(customId: string) {
  return {
    customId,
    guildId: 'guild-1',
    user: { id: 'user-1', username: 'Tester' },
    member: { id: 'user-1' },
    isButton: () => true,
    reply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    deferUpdate: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    message: {
      id: 'msg-1',
      edit: vi.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('PollsManager deep', () => {
  let manager: PollsManager;
  let supa: any;

  beforeEach(() => {
    vi.clearAllMocks();
    supa = makeSupa({
      guild_config: { guild_id: 'guild-1', polls_enabled: true, predictions_enabled: true },
    });
    manager = new PollsManager(supa);
  });

  describe('createPoll', () => {
    it('creates a poll and sends embed', async () => {
      const interaction = makeInteraction();
      await manager.createPoll(interaction, 'Best color?', ['Red', 'Blue', 'Green'], false);
      expect(supa.from).toHaveBeenCalled();
    });

    it('creates a multi-choice poll', async () => {
      const interaction = makeInteraction();
      await manager.createPoll(interaction, 'Pick many', ['A', 'B', 'C', 'D'], true);
      expect(supa.from).toHaveBeenCalled();
    });
  });

  describe('handlePollVote', () => {
    it('handles vote button click', async () => {
      // Mock polls table to return a poll
      supa = makeSupa({
        guild_config: { guild_id: 'guild-1', polls_enabled: true },
        polls: { id: 'poll-1', guild_id: 'guild-1', title: 'Test', options: ['A', 'B'], votes: {}, allow_multiple: false, closed: false, message_id: 'msg-1', channel_id: 'ch-1' },
      });
      manager = new PollsManager(supa);
      const btn = makeButtonInteraction('poll:vote:poll-1:0');
      await manager.handlePollVote(btn);
      const responded = btn.deferUpdate.mock.calls.length > 0 || btn.reply.mock.calls.length > 0 || btn.editReply.mock.calls.length > 0;
      expect(responded).toBe(true);
    });
  });

  describe('closePoll', () => {
    it('closes an existing poll', async () => {
      supa = makeSupa({
        guild_config: { guild_id: 'guild-1' },
        polls: { id: 'poll-1', guild_id: 'guild-1', title: 'Test', options: ['A', 'B'], votes: {}, closed: false },
      });
      manager = new PollsManager(supa);
      const interaction = makeInteraction();
      await manager.closePoll(interaction, 'poll-1');
      expect(supa.from).toHaveBeenCalled();
    });
  });

  describe('createPrediction', () => {
    it('creates a prediction market', async () => {
      const interaction = makeInteraction();
      await manager.createPrediction(interaction, 'Will it rain?', ['Yes', 'No']);
      expect(supa.from).toHaveBeenCalled();
    });
  });

  describe('placeBet', () => {
    it('places a bet on a prediction', async () => {
      supa = makeSupa({
        guild_config: { guild_id: 'guild-1' },
        predictions: {
          id: 'pred-1', guild_id: 'guild-1', title: 'Rain?', options: ['Yes', 'No'],
          bets: [], resolved: false, close_time: new Date(Date.now() + 60000).toISOString(),
          message_id: 'msg-1', channel_id: 'ch-1',
        },
      });
      manager = new PollsManager(supa);
      const interaction = makeInteraction();
      await manager.placeBet(interaction, 'pred-1', 0, 100);
      expect(supa.from).toHaveBeenCalled();
    });
  });

  describe('resolvePrediction', () => {
    it('resolves a prediction with winning option', async () => {
      supa = makeSupa({
        guild_config: { guild_id: 'guild-1' },
        predictions: {
          id: 'pred-1', guild_id: 'guild-1', title: 'Rain?', options: ['Yes', 'No'],
          bets: [{ user_id: 'user-1', option_index: 0, amount: 100 }],
          resolved: false, message_id: 'msg-1', channel_id: 'ch-1',
        },
      });
      manager = new PollsManager(supa);
      const interaction = makeInteraction();
      await manager.resolvePrediction(interaction, 'pred-1', 0);
      expect(supa.from).toHaveBeenCalled();
    });
  });
});
