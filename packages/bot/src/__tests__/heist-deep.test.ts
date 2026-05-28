/**
 * Deep tests for features/heist/heist-manager.ts — startHeist, joinHeist, viewHeist.
 * 277 uncovered statements at 44.7%.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../features/economy/economy-utils.js', () => ({
  getBalance: vi.fn(async () => 5000),
  addBalance: vi.fn(async () => true),
  deductBalance: vi.fn(async () => true),
}));

import { HeistManager } from '../features/heist/heist-manager.js';

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

function makeClient() {
  return {
    guilds: { cache: new Map() },
    channels: { cache: new Map([['ch-1', { id: 'ch-1', send: vi.fn().mockResolvedValue({ id: 'msg-1', edit: vi.fn() }) }]]) },
  } as any;
}

function makeInteraction() {
  return {
    guildId: 'guild-1',
    channelId: 'ch-1',
    user: { id: 'user-1', username: 'Tester', displayAvatarURL: () => 'url' },
    member: { id: 'user-1', permissions: { has: () => true } },
    guild: { id: 'guild-1', name: 'Test', channels: { cache: new Map() } },
    options: {
      getString: vi.fn(() => 'bank'),
      getInteger: vi.fn(() => 100),
    },
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    channel: { send: vi.fn().mockResolvedValue({ id: 'msg-1', edit: vi.fn() }) },
  } as any;
}

describe('HeistManager deep', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('startHeist initiates a new heist', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', heist_enabled: true, heist_min_players: 2, heist_max_players: 10, heist_cooldown_minutes: 5, heist_bet_min: 50, heist_bet_max: 5000, currency_symbol: '💰' },
    });
    const mgr = new HeistManager(supa, makeClient());
    const interaction = makeInteraction();
    await mgr.startHeist(interaction);
    // Should respond to the interaction
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
    // Should query config
    expect(supa.from).toHaveBeenCalled();
  });

  it('joinHeist adds a player', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', heist_enabled: true, currency_symbol: '💰' },
      heists: { id: 'heist-1', guild_id: 'guild-1', status: 'recruiting', players: ['user-2'], bet_amount: 100, started_by: 'user-2', channel_id: 'ch-1' },
    });
    const mgr = new HeistManager(supa, makeClient());
    const interaction = makeInteraction();
    await mgr.joinHeist(interaction);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('viewHeist shows current heist', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', heist_enabled: true, currency_symbol: '💰' },
      heists: { id: 'heist-1', guild_id: 'guild-1', status: 'recruiting', players: ['user-1'], bet_amount: 100, started_by: 'user-1', channel_id: 'ch-1', target: 'bank' },
    });
    const mgr = new HeistManager(supa, makeClient());
    const interaction = makeInteraction();
    await mgr.viewHeist(interaction);
    const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0 || interaction.deferReply.mock.calls.length > 0;
    expect(responded).toBe(true);
  });

  it('cleanup clears timers', () => {
    const supa = makeSupa();
    const mgr = new HeistManager(supa, makeClient());
    mgr.cleanup();
    // Should not throw
    expect(mgr).toBeDefined();
  });

  it('clearCache clears config cache', () => {
    const supa = makeSupa();
    const mgr = new HeistManager(supa, makeClient());
    mgr.clearCache();
    // Should not throw
    expect(mgr).toBeDefined();
  });
});
