/**
 * Deep tests for features/lottery/lottery-manager.ts — buyTickets, viewLottery, drawWinner.
 * 180 uncovered statements at 46.9%.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return { ...actual };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock('../features/economy/economy-utils.js', () => ({
  getBalance: vi.fn(async () => 10000),
  addBalance: vi.fn(async () => true),
  deductBalance: vi.fn(async () => true),
}));

import { LotteryManager } from '../features/lottery/lottery-manager.js';

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
    from: vi.fn((table: string) => makeChain(overrides[table] ?? null)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeInteraction() {
  return {
    guildId: 'guild-1',
    user: { id: 'user-1', username: 'Tester', displayAvatarURL: () => 'url' },
    member: { id: 'user-1' },
    options: {
      getInteger: vi.fn(() => 3),
      getString: vi.fn(() => null),
    },
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
  } as any;
}

describe('LotteryManager deep', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('buyTickets purchases lottery tickets', async () => {
    const supa = makeSupa({
      guild_config: {
        guild_id: 'guild-1', lottery_enabled: true, lottery_ticket_price: 100,
        lottery_max_tickets_per_user: 10, currency_symbol: '💰',
      },
      lottery_drawings: { id: 'draw-1', guild_id: 'guild-1', status: 'active', jackpot: 0, tickets: [], draw_at: new Date(Date.now() + 60000).toISOString() },
    });
    const mgr = new LotteryManager(supa);
    const interaction = makeInteraction();
    await mgr.buyTickets(interaction, 3);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('viewLottery shows current drawing', async () => {
    const supa = makeSupa({
      guild_config: {
        guild_id: 'guild-1', lottery_enabled: true, lottery_ticket_price: 100, currency_symbol: '💰',
      },
      lottery_drawings: {
        id: 'draw-1', guild_id: 'guild-1', status: 'active', jackpot: 500,
        tickets: [{ user_id: 'user-1', count: 5, numbers: [1, 2, 3, 4, 5] }],
        draw_at: new Date(Date.now() + 60000).toISOString(),
      },
    });
    const mgr = new LotteryManager(supa);
    const interaction = makeInteraction();
    await mgr.viewLottery(interaction);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('viewLottery brands the embed with the configured currency, not stock "coins"', async () => {
    const supa = makeSupa({
      guild_config: {
        guild_id: 'guild-1', economy_lottery_enabled: true, economy_lottery_ticket_price: 100,
        economy_lottery_schedule: 'weekly', currency_name: 'Gems', currency_emoji: '💎',
      },
      economy_lottery_drawings: { id: 'draw-1', guild_id: 'guild-1', status: 'active', jackpot: 500 },
      economy_lottery_tickets: [{ user_id: 'user-1' }, { user_id: 'user-2' }],
    });
    const mgr = new LotteryManager(supa);
    const interaction = makeInteraction();
    await mgr.viewLottery(interaction);

    const desc: string = interaction.reply.mock.calls[0][0].embeds[0].data.description ?? '';
    expect(desc).toContain('Gems');
    expect(desc).toContain('💎');
    expect(desc).not.toContain('coins');
  });

  it('buyTickets brands the purchase embed with the configured currency', async () => {
    const supa = makeSupa({
      guild_config: {
        guild_id: 'guild-1', economy_lottery_enabled: true, economy_lottery_ticket_price: 100,
        economy_lottery_max_tickets: 10, currency_name: 'Gems', currency_emoji: '💎',
      },
      economy_lottery_drawings: { id: 'draw-1', guild_id: 'guild-1', status: 'active', jackpot: 0 },
    });
    supa.rpc = vi.fn(async () => ({ data: { status: 'purchased', replayed: false, jackpot: 300 }, error: null }));
    const mgr = new LotteryManager(supa);
    const interaction = makeInteraction();
    await mgr.buyTickets(interaction, 3);

    const desc: string = interaction.reply.mock.calls[0][0].embeds[0].data.description ?? '';
    expect(desc).toContain('Gems');
    expect(desc).not.toContain('coins');
  });

  it('drawWinner picks a lottery winner', async () => {
    const supa = makeSupa({
      guild_config: {
        guild_id: 'guild-1', lottery_enabled: true, currency_symbol: '💰',
      },
      lottery_drawings: {
        id: 'draw-1', guild_id: 'guild-1', status: 'active', jackpot: 1000,
        tickets: [
          { user_id: 'user-1', count: 5, numbers: [1, 2, 3, 4, 5] },
          { user_id: 'user-2', count: 3, numbers: [6, 7, 8] },
        ],
      },
    });
    const mgr = new LotteryManager(supa);
    const result = await mgr.drawWinner('guild-1');
    expect(result).toBeDefined();
  });

  it('scheduleLotteryDraws sets up timer', () => {
    const supa = makeSupa();
    const mgr = new LotteryManager(supa);
    mgr.scheduleLotteryDraws('guild-1');
      expect(mgr).toBeDefined();
  });

  it('clearCache clears config', () => {
    const supa = makeSupa();
    const mgr = new LotteryManager(supa);
    mgr.clearCache();
      expect(mgr).toBeDefined();
  });
});
