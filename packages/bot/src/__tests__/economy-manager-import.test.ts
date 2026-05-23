/**
 * Economy Manager (Import) — Unit Tests
 *
 * Tests EconomyManager with mocked Supabase, Valkey, and Discord.
 * Focuses on wallet operations, deposit/withdraw, and work/beg commands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock discord.js EmbedBuilder
vi.mock('discord.js', () => ({
  EmbedBuilder: class MockEmbedBuilder {
    data: any = {};
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setFooter(f: any) { this.data.footer = f; return this; }
    setTimestamp() { return this; }
    addFields(...args: any[]) { this.data.fields = args; return this; }
    toJSON() { return this.data; }
  },
}));

// Mock quests manager
vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => null,
}));

import { EconomyManager } from '../features/economy/economy-manager.js';

// ── Helpers ────────────────────────────────────────────────

function makeGuild(id = 'guild1') {
  return {
    id,
    channels: { cache: { get: () => null } },
  } as any;
}

function makeSupabase(overrides: Record<string, any> = {}) {
  const walletData = overrides.wallet ?? {
    guild_id: 'guild1',
    user_id: 'user1',
    wallet: 1000,
    bank: 500,
    bank_max: 10000,
    passive: false,
    total_earned: 5000,
    total_spent: 1000,
  };

  const configData = overrides.config ?? {
    economy_enabled: true,
    currency_name: 'Coins',
    currency_emoji: '🪙',
    economy_starting_balance: 100,
    economy_daily_amount: 500,
    economy_weekly_amount: 2500,
    economy_monthly_amount: 10000,
    economy_streak_bonus_pct: 5,
    economy_work_cooldown_seconds: 30,
    economy_work_min: 50,
    economy_work_max: 250,
    economy_crime_success_pct: 40,
    economy_crime_fine_pct: 30,
    economy_crime_min: 100,
    economy_crime_max: 500,
    economy_chat_income_enabled: false,
    economy_chat_income_min: 1,
    economy_chat_income_max: 5,
    economy_chat_income_cooldown_seconds: 60,
    economy_rob_enabled: true,
    economy_rob_success_pct: 30,
    economy_rob_fine_pct: 25,
    economy_heist_enabled: true,
    economy_passive_mode_allowed: true,
    economy_pay_tax_pct: 0,
    economy_max_wallet: 0,
    economy_max_bank: 10000,
    economy_log_channel_id: null,
  };

  // Build a chain that returns different data based on table
  let currentTable = '';
  const chainable: any = {};
  chainable.from = (table: string) => { currentTable = table; return chainable; };
  chainable.select = () => chainable;
  chainable.eq = () => chainable;
  chainable.gte = () => chainable;
  chainable.lte = () => chainable;
  chainable.lt = () => chainable;
  chainable.gt = () => chainable;
  chainable.limit = () => chainable;
  chainable.order = () => chainable;
  chainable.insert = () => chainable;
  chainable.update = () => chainable;
  chainable.upsert = () => chainable;
  chainable.match = () => chainable;
  chainable.in = () => chainable;
  chainable.is = () => chainable;
  chainable.rpc = vi.fn(async (_fn: string, params: any) => {
    // Return the requested amount for wallet operations
    const amount = params?.p_amount ?? params?.p_credits ?? 100;
    return { data: amount, error: null };
  });
  chainable.maybeSingle = async () => {
    if (currentTable === 'guild_config') return { data: configData, error: null };
    if (currentTable === 'economy_wallets') return { data: walletData, error: null };
    if (currentTable === 'economy_streaks') return { data: null, error: null };
    if (currentTable === 'economy_items') return { data: null, error: null };
    if (currentTable === 'economy_inventory') return { data: null, error: null };
    return { data: null, error: null };
  };
  chainable.single = chainable.maybeSingle;
  chainable.then = undefined; // prevent auto-unwrap

  return chainable;
}

function makeValkey() {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    setex: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    exists: vi.fn(async () => 0),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => -1),
  } as any;
}

// ════════════════════════════════════════════════════════════

describe('EconomyManager', () => {
  let manager: EconomyManager;
  let supabase: any;
  let valkey: any;

  beforeEach(() => {
    supabase = makeSupabase();
    valkey = makeValkey();
    manager = new EconomyManager(makeGuild(), supabase, valkey);
  });

  describe('loadConfig', () => {
    it('returns economy config object', async () => {
      const config = await manager.loadConfig();
      expect(config.economy_enabled).toBe(true);
      expect(config.currency_name).toBe('Coins');
      expect(config.currency_emoji).toBe('🪙');
    });

    it('uses cache on subsequent calls', async () => {
      const config1 = await manager.loadConfig();
      const config2 = await manager.loadConfig();
      expect(config1).toBe(config2); // Same object reference
    });
  });

  describe('getOrCreateWallet', () => {
    it('returns wallet data', async () => {
      const wallet = await manager.getOrCreateWallet('user1');
      expect(wallet.wallet).toBe(1000);
      expect(wallet.bank).toBe(500);
    });
  });

  describe('deposit', () => {
    it('deposits to bank', async () => {
      const result = await manager.deposit('user1', 200);
      expect(result.success).toBe(true);
      expect(result.amount).toBe(200);
    });

    it('rejects zero amount', async () => {
      const result = await manager.deposit('user1', 0);
      expect(result.success).toBe(false);
    });

    it('rejects negative amount', async () => {
      const result = await manager.deposit('user1', -100);
      expect(result.success).toBe(false);
    });

    it('rejects amount exceeding wallet', async () => {
      const result = await manager.deposit('user1', 5000);
      expect(result.success).toBe(false);
    });
  });

  describe('withdraw', () => {
    it('withdraws from bank', async () => {
      const result = await manager.withdraw('user1', 200);
      expect(result.success).toBe(true);
      expect(result.amount).toBe(200);
    });

    it('rejects zero amount', async () => {
      const result = await manager.withdraw('user1', 0);
      expect(result.success).toBe(false);
    });

    it('rejects amount exceeding bank', async () => {
      const result = await manager.withdraw('user1', 5000);
      expect(result.success).toBe(false);
    });
  });

  describe('work', () => {
    it('returns a transaction result', async () => {
      const result = await manager.work('user1');
      // Either on cooldown or success
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.message).toBe('string');
    });
  });

  describe('beg', () => {
    it('returns a transaction result', async () => {
      const result = await manager.beg('user1');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.message).toBe('string');
    });
  });

  describe('togglePassive', () => {
    it('returns toggle result', async () => {
      const result = await manager.togglePassive('user1');
      expect(typeof result.enabled).toBe('boolean');
      expect(typeof result.message).toBe('string');
    });
  });
});
