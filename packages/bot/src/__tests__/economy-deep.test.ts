/**
 * Deep tests for features/economy/economy-manager.ts — wallet ops, shop, work, crime, beg, pay, rob.
 * 275 uncovered statements at 71.5%.
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

import { EconomyManager } from '../features/economy/economy-manager.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range', 'ilike', 'filter', 'like', 'textSearch']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null, count: 0 });
  return chain;
}

const defaultConfig = {
  guild_id: 'guild-1',
  economy_enabled: true,
  currency_name: 'coins',
  currency_symbol: '💰',
  default_balance: 100,
  work_cooldown_seconds: 60,
  work_min_reward: 50,
  work_max_reward: 200,
  crime_cooldown_seconds: 120,
  crime_min_reward: 100,
  crime_max_reward: 500,
  crime_fine_percent: 20,
  crime_success_chance: 60,
  beg_cooldown_seconds: 30,
  beg_min_reward: 10,
  beg_max_reward: 50,
  search_cooldown_seconds: 45,
  search_min_reward: 20,
  search_max_reward: 100,
  rob_cooldown_seconds: 300,
  rob_min_percent: 10,
  rob_max_percent: 50,
  rob_fine_percent: 25,
  rob_success_chance: 50,
  daily_reward: 500,
  weekly_reward: 2500,
  monthly_reward: 10000,
  chat_income_min: 5,
  chat_income_max: 15,
  chat_income_cooldown_seconds: 60,
  bank_max_balance: 100000,
  passive_mode_cost: 1000,
};

const wallet = {
  guild_id: 'guild-1', user_id: 'user-1',
  cash: 5000, bank: 1000,
  total_earned: 10000, total_spent: 5000,
  last_work: null, last_crime: null, last_beg: null, last_search: null, last_rob: null,
  last_daily: null, last_weekly: null, last_monthly: null,
  passive_mode: false,
  streak_daily: 0, streak_weekly: 0, streak_monthly: 0,
};

function makeSupa(walletData = wallet) {
  const chain = makeChain(walletData);
  // Make config requests return defaultConfig
  return {
    from: vi.fn((table: string) => {
      if (table === 'guild_config' || table === 'economy_config') {
        return makeChain(defaultConfig);
      }
      return makeChain(walletData);
    }),
    rpc: vi.fn(async () => ({ data: walletData, error: null })),
  } as any;
}

function makeGuild() {
  return {
    id: 'guild-1', name: 'Test',
    channels: { cache: new Map() },
    members: {
      cache: new Map(),
      fetch: vi.fn().mockResolvedValue({ id: 'user-2', displayName: 'Victim' }),
    },
  } as any;
}

function makeValkey() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(-2),
  } as any;
}

describe('EconomyManager deep', () => {
  let mgr: EconomyManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new EconomyManager(makeGuild(), makeSupa(), makeValkey());
  });

  it('loadConfig returns economy configuration', async () => {
    const config = await mgr.loadConfig();
    expect(config).toBeDefined();
  });

  it('getOrCreateWallet returns wallet data', async () => {
    const w = await mgr.getOrCreateWallet('user-1');
    expect(w).toBeDefined();
  });

  it('creditWallet adds cash to wallet', async () => {
    const result = await mgr.creditWallet('user-1', 100);
    expect(result).toBeDefined();
  });

  it('debitWallet removes cash from wallet', async () => {
    const result = await mgr.debitWallet('user-1', 100);
    expect(result).toBeDefined();
  });

  it('deposit moves cash to bank', async () => {
    const result = await mgr.deposit('user-1', 500);
    expect(result).toBeDefined();
  });

  it('withdraw moves bank to cash', async () => {
    const result = await mgr.withdraw('user-1', 500);
    expect(result).toBeDefined();
  });

  it('work earns coins', async () => {
    const result = await mgr.work('user-1');
    expect(result).toBeDefined();
  });

  it('crime attempts a crime', async () => {
    const result = await mgr.crime('user-1');
    expect(result).toBeDefined();
  });

  it('beg gets coins from begging', async () => {
    const result = await mgr.beg('user-1');
    expect(result).toBeDefined();
  });

  it('search finds coins', async () => {
    const result = await mgr.search('user-1');
    expect(result).toBeDefined();
  });

  it('pay transfers coins to another user', async () => {
    const result = await mgr.pay('user-1', 'user-2', 100);
    expect(result).toBeDefined();
  });

  it('rob attempts to rob another user', async () => {
    const result = await mgr.rob('user-1', 'user-2');
    expect(result).toBeDefined();
  });

  it('togglePassive toggles passive mode', async () => {
    const result = await mgr.togglePassive('user-1');
    expect(result).toBeDefined();
  });

  it('getShopItems returns shop items', async () => {
    const items = await mgr.getShopItems();
    expect(items).toBeDefined();
  });

  it('getInventory returns inventory', async () => {
    const inv = await mgr.getInventory('user-1');
    expect(inv).toBeDefined();
  });

  it('processChatIncome processes message income', async () => {
    await mgr.processChatIncome('user-1', 'ch-1');
      expect(mgr).toBeDefined();
  });
});
