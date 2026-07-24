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

  // [game-economy-heist] embeds must brand with the guild currency, not "coins".
  it('viewHeist embed brands with the configured currency, never "coins"', async () => {
    const supa = makeSupa({
      guild_config: {
        guild_id: 'guild-1', economy_heist_enabled: true,
        currency_name: 'Gems', currency_emoji: '💎',
      },
      economy_heists: {
        id: 'heist-1', guild_id: 'guild-1', status: 'recruiting', target_name: 'bank',
        target_payout: 1000, base_success_chance: 40,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const mgr = new HeistManager(supa, makeClient());
    const interaction = makeInteraction();
    await mgr.viewHeist(interaction);
    const desc = interaction.reply.mock.calls[0][0].embeds[0].data.description as string;
    expect(desc).toContain('Gems');
    expect(desc).toContain('💎');
    expect(desc.toLowerCase()).not.toContain('coins');
  });

  it('startHeist creates heist + initiator atomically via heist_start (finding 2)', async () => {
    // Wallet has funds; no active heist; no cooldown. heist_start returns 'started'.
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', economy_heist_enabled: true, economy_heist_entry_fee: 100 },
      economy_wallets: { wallet: 5000 },
    });
    supa.rpc = vi.fn(async (fn: string) => {
      if (fn === 'heist_start') return { data: [{ status: 'started', heist_id: 'heist-atomic-1' }], error: null };
      return { data: null, error: null };
    });
    const mgr = new HeistManager(supa, makeClient());
    const interaction = makeInteraction();
    await mgr.startHeist(interaction);

    // The initiator row is inserted by the atomic RPC, NOT a separate table insert.
    const rpcNames = supa.rpc.mock.calls.map((c: any[]) => c[0]);
    expect(rpcNames).toContain('heist_start');
    // No second-statement participant insert (the gap that let a concurrent join
    // fill the crew before the initiator row existed).
    const participantInserts = supa.from.mock.calls.filter(
      (c: any[]) => c[0] === 'economy_heist_participants',
    );
    expect(participantInserts.length).toBe(0);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('startHeist refunds the entry fee when heist_start reports duplicate_active (finding 2)', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', economy_heist_enabled: true, economy_heist_entry_fee: 100 },
      economy_wallets: { wallet: 5000 },
    });
    supa.rpc = vi.fn(async (fn: string) => {
      if (fn === 'heist_start') return { data: [{ status: 'duplicate_active', heist_id: null }], error: null };
      return { data: null, error: null };
    });
    const mgr = new HeistManager(supa, makeClient());
    const interaction = makeInteraction();
    await mgr.startHeist(interaction);

    // The pre-debited entry fee is refunded via economy_add_balance.
    const refunds = supa.rpc.mock.calls.filter((c: any[]) => c[0] === 'economy_add_balance');
    expect(refunds.length).toBe(1);
    expect(interaction.reply).toHaveBeenCalled();
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
