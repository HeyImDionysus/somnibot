/**
 * EconomyManager — Full coverage tests
 *
 * Imports the REAL EconomyManager class and mocks only external
 * boundaries (Discord.js, Supabase client, Valkey, quests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock externals BEFORE importing the real module ───────

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setColor(c: number) { this.data.color = c; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setTimestamp() { return this; }
  },
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../quests/quests-manager.js', () => ({
  getQuestsManager: () => ({
    trackProgress: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('node:crypto', () => ({
  randomInt: vi.fn((min: number, max: number) => min), // deterministic
}));

import { EconomyManager } from '../features/economy/economy-manager.js';
import { randomInt } from 'node:crypto';

// ── Helpers ───────────────────────────────────────────────

function makeWallet(overrides: Partial<{
  guild_id: string; user_id: string; wallet: number; bank: number;
  bank_max: number; passive: boolean; total_earned: number; total_spent: number;
}> = {}) {
  return {
    guild_id: 'g1',
    user_id: overrides.user_id ?? 'u1',
    wallet: overrides.wallet ?? 1000,
    bank: overrides.bank ?? 0,
    bank_max: overrides.bank_max ?? 10000,
    passive: overrides.passive ?? false,
    total_earned: overrides.total_earned ?? 1000,
    total_spent: overrides.total_spent ?? 0,
    ...overrides,
  };
}

/** Builds a chainable Supabase query mock */
function chainBuilder(resolveValue: { data?: unknown; error?: unknown } = { data: null }) {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte',
    'order', 'limit', 'contains', 'in', 'is',
    'insert', 'update', 'upsert', 'delete',
  ];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(resolveValue);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  // For queries that don't end with single/maybeSingle, resolve directly
  chain.then = (res: (v: unknown) => void) => Promise.resolve(resolveValue).then(res);
  return chain;
}

function makeSupabase(overrides: Record<string, unknown> = {}) {
  const configData = {
    economy_enabled: true,
    currency_name: 'Coins',
    currency_emoji: '🪙',
    economy_starting_balance: 100,
    economy_daily_amount: 500,
    economy_weekly_amount: 3500,
    economy_monthly_amount: 15000,
    economy_streak_bonus_pct: 5,
    economy_work_cooldown_seconds: 1800,
    economy_work_min: 100,
    economy_work_max: 500,
    economy_crime_success_pct: 40,
    economy_crime_fine_pct: 50,
    economy_crime_min: 200,
    economy_crime_max: 1000,
    economy_chat_income_enabled: false,
    economy_chat_income_min: 5,
    economy_chat_income_max: 15,
    economy_chat_income_cooldown_seconds: 60,
    economy_rob_enabled: true,
    economy_rob_success_pct: 35,
    economy_rob_fine_pct: 50,
    economy_heist_enabled: true,
    economy_passive_mode_allowed: true,
    economy_pay_tax_pct: 0,
    economy_max_wallet: 0,
    economy_max_bank: 0,
    economy_log_channel_id: null,
  };

  const rpcResults: Record<string, unknown> = {
    economy_get_or_create_wallet: {
      data: makeWallet({ wallet: 100, total_earned: 100 }),
      error: null,
    },
    economy_add_balance: { data: null, error: null },
    economy_subtract_balance: { data: null, error: null },
    economy_bank_deposit: { data: 500, error: null },
    economy_bank_withdraw: { data: 500, error: null },
    economy_decrement_stock: { data: true, error: null },
    economy_upsert_inventory: { data: null, error: null },
    economy_increment_stock: { data: null, error: null },
    economy_decrement_inventory: { data: true, error: null },
    ...overrides,
  };

  const fromHandlers: Record<string, () => ReturnType<typeof chainBuilder>> = {
    guild_config: () => chainBuilder({ data: configData }),
    economy_wallets: () => chainBuilder({ data: makeWallet() }),
    economy_streaks: () => chainBuilder({ data: null }),
    economy_transactions: () => chainBuilder({ data: null, error: null }),
    economy_items: () => chainBuilder({ data: null }),
    economy_inventory: () => chainBuilder({ data: null }),
  };

  return {
    from: vi.fn((table: string) => {
      const handler = fromHandlers[table];
      return handler ? handler() : chainBuilder();
    }),
    rpc: vi.fn((name: string, params: unknown) => {
      const result = rpcResults[name];
      return Promise.resolve(result ?? { data: null, error: null });
    }),
    _fromHandlers: fromHandlers,
    _configData: configData,
  };
}

function makeValkey() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      // Check for NX flag
      const hasNX = args.includes('NX');
      if (hasNX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1; }),
    _store: store,
  };
}

function makeGuild() {
  const channelCache = new Map();
  const memberCache = new Map();
  const roleCache = new Map();
  return {
    id: 'g1',
    channels: { cache: channelCache },
    members: {
      cache: memberCache,
      fetch: vi.fn(async (id: string) => {
        const m = memberCache.get(id);
        if (m) return m;
        return {
          id,
          roles: { cache: new Map(), add: vi.fn(), remove: vi.fn() },
        };
      }),
    },
    roles: { cache: roleCache },
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('EconomyManager', () => {
  let em: EconomyManager;
  let supabase: ReturnType<typeof makeSupabase>;
  let valkey: ReturnType<typeof makeValkey>;
  let guild: ReturnType<typeof makeGuild>;

  beforeEach(() => {
    vi.clearAllMocks();
    guild = makeGuild();
    supabase = makeSupabase();
    valkey = makeValkey();
    em = new EconomyManager(guild as any, supabase as any, valkey as any);
    // Make randomInt deterministic
    (randomInt as ReturnType<typeof vi.fn>).mockImplementation((min: number, max: number) => min);
  });

  // ── Config ──────────────────────────────────────────────

  describe('loadConfig', () => {
    it('fetches config from supabase and caches it', async () => {
      const cfg = await em.loadConfig();
      expect(cfg.economy_enabled).toBe(true);
      expect(cfg.currency_name).toBe('Coins');
      expect(supabase.from).toHaveBeenCalledWith('guild_config');

      // Second call should use cache (no additional supabase call)
      const callCount = supabase.from.mock.calls.length;
      const cfg2 = await em.loadConfig();
      expect(cfg2).toEqual(cfg);
      expect(supabase.from.mock.calls.length).toBe(callCount);
    });

    it('uses defaults when no config data returned', async () => {
      supabase.from.mockImplementation(() => chainBuilder({ data: null }));
      const cfg = await em.loadConfig();
      expect(cfg.economy_enabled).toBe(false);
      expect(cfg.currency_name).toBe('Coins');
      expect(cfg.economy_starting_balance).toBe(0);
    });
  });

  describe('invalidateConfig', () => {
    it('forces re-fetch on next loadConfig call', async () => {
      await em.loadConfig();
      const c1 = supabase.from.mock.calls.length;
      em.invalidateConfig();
      await em.loadConfig();
      expect(supabase.from.mock.calls.length).toBeGreaterThan(c1);
    });
  });

  // ── Wallet operations ───────────────────────────────────

  describe('getOrCreateWallet', () => {
    it('returns existing wallet', async () => {
      const w = await em.getOrCreateWallet('u1');
      expect(w.user_id).toBe('u1');
      expect(w.wallet).toBe(1000);
      expect(supabase.rpc).not.toHaveBeenCalledWith(
        'economy_get_or_create_wallet',
        expect.anything(),
      );
    });

    it('creates wallet with starting balance when none exists', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') {
          return chainBuilder({ data: null, error: null });
        }
        return chainBuilder({ data: supabase._configData });
      });

      const w = await em.getOrCreateWallet('u1');
      expect(w.wallet).toBe(100);
      expect(w.total_earned).toBe(100);
      expect(supabase.rpc).toHaveBeenCalledWith('economy_get_or_create_wallet', {
        p_guild_id: 'g1',
        p_user_id: 'u1',
      });
      expect(supabase.from).not.toHaveBeenCalledWith('economy_transactions');
    });

    it('preserves the configured fallback when wallet initialization fails', async () => {
      supabase = makeSupabase({
        economy_get_or_create_wallet: {
          data: null,
          error: { message: 'initializer unavailable' },
        },
      });
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') return chainBuilder({ data: null, error: null });
        return chainBuilder({ data: supabase._configData });
      });
      em = new EconomyManager(guild as any, supabase as any, valkey as any);

      const w = await em.getOrCreateWallet('u1');
      expect(w).toMatchObject({
        guild_id: 'g1',
        user_id: 'u1',
        wallet: 100,
        total_earned: 100,
      });
    });
  });

  describe('creditWallet', () => {
    it('calls economy_add_balance RPC and returns updated wallet', async () => {
      const result = await em.creditWallet('u1', 500);
      expect(supabase.rpc).toHaveBeenCalledWith('economy_add_balance', expect.objectContaining({
        p_guild_id: 'g1',
        p_user_id: 'u1',
        p_amount: '500',
      }));
      expect(result).toBeTruthy();
    });

    it('rejects non-positive amount', async () => {
      const result = await em.creditWallet('u1', 0);
      expect(result).toBeNull();
    });

    it('rejects NaN amount', async () => {
      const result = await em.creditWallet('u1', NaN);
      expect(result).toBeNull();
    });

    it('rejects negative amount', async () => {
      const result = await em.creditWallet('u1', -100);
      expect(result).toBeNull();
    });

    it('returns null on RPC error', async () => {
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'db error' } });
      // Need getOrCreateWallet to succeed first
      const result = await em.creditWallet('u1', 500);
      expect(result).toBeNull();
    });
  });

  describe('debitWallet', () => {
    it('calls economy_subtract_balance RPC', async () => {
      const result = await em.debitWallet('u1', 200);
      expect(supabase.rpc).toHaveBeenCalledWith('economy_subtract_balance', expect.objectContaining({
        p_guild_id: 'g1',
        p_user_id: 'u1',
        p_amount: '200',
      }));
      expect(result).toBeTruthy();
    });

    it('rejects non-positive amount', async () => {
      expect(await em.debitWallet('u1', 0)).toBeNull();
      expect(await em.debitWallet('u1', -10)).toBeNull();
    });

    it('returns null on RPC error (insufficient funds)', async () => {
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'insufficient funds' } });
      const result = await em.debitWallet('u1', 999999);
      expect(result).toBeNull();
    });
  });

  // ── Deposit / Withdraw ──────────────────────────────────

  describe('deposit', () => {
    it('deposits wallet to bank', async () => {
      const result = await em.deposit('u1', 500);
      expect(result.success).toBe(true);
      expect(supabase.rpc).toHaveBeenCalledWith('economy_bank_deposit', expect.objectContaining({
        p_guild_id: 'g1',
        p_user_id: 'u1',
      }));
    });

    it('fails when wallet balance insufficient', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet({ wallet: 10 }) });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.deposit('u1', 500);
      expect(result.success).toBe(false);
      expect(result.message).toContain("don't have that much");
    });

    it('fails when bank is full', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet({ bank: 10000, bank_max: 10000 }) });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.deposit('u1', 500);
      expect(result.success).toBe(false);
      expect(result.message).toContain('bank is full');
    });

    it('fails when RPC returns error', async () => {
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'fail' } });
      const result = await em.deposit('u1', 500);
      expect(result.success).toBe(false);
    });
  });

  describe('withdraw', () => {
    it('withdraws from bank to wallet', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet({ bank: 5000 }) });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.withdraw('u1', 500);
      expect(result.success).toBe(true);
      expect(supabase.rpc).toHaveBeenCalledWith('economy_bank_withdraw', expect.objectContaining({
        p_guild_id: 'g1',
        p_user_id: 'u1',
      }));
    });

    it('fails when bank balance insufficient', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet({ bank: 10 }) });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.withdraw('u1', 500);
      expect(result.success).toBe(false);
      expect(result.message).toContain("don't have that much in your bank");
    });

    it('fails when RPC returns error', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet({ bank: 5000 }) });
        return chainBuilder({ data: supabase._configData });
      });
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'fail' } });
      const result = await em.withdraw('u1', 500);
      expect(result.success).toBe(false);
    });
  });

  // ── Timed rewards ───────────────────────────────────────

  describe('claimTimedReward', () => {
    it('claims daily reward successfully', async () => {
      const result = await em.claimTimedReward('u1', 'daily');
      expect(result.success).toBe(true);
      expect(result.amount).toBe(500); // economy_daily_amount
      expect(result.message).toContain('daily');
    });

    it('claims weekly reward', async () => {
      const result = await em.claimTimedReward('u1', 'weekly');
      expect(result.success).toBe(true);
      expect(result.amount).toBe(3500);
    });

    it('claims monthly reward', async () => {
      const result = await em.claimTimedReward('u1', 'monthly');
      expect(result.success).toBe(true);
      expect(result.amount).toBe(15000);
    });

    it('prevents double-claim via Valkey NX', async () => {
      // First claim succeeds
      await em.claimTimedReward('u1', 'daily');

      // Second claim should fail (NX prevents set)
      const result = await em.claimTimedReward('u1', 'daily');
      expect(result.success).toBe(false);
      expect(result.message).toContain('already claimed');
    });

    it('calculates streak bonus', async () => {
      // Set up existing streak
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_streaks') {
          return chainBuilder({
            data: {
              current_streak: 5,
              longest_streak: 10,
              last_claimed_at: new Date(Date.now() - 12 * 3600000).toISOString(), // 12h ago
            },
          });
        }
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet() });
        return chainBuilder({ data: supabase._configData });
      });

      const result = await em.claimTimedReward('u1', 'daily');
      expect(result.success).toBe(true);
      // streak 6, bonus = 500 * (5 * 5 / 100) = 125
      expect(result.amount).toBe(500 + 125);
      expect(result.message).toContain('streak');
    });

    it('handles creditWallet failure during claim', async () => {
      // Make creditWallet return null (non-positive guard won't trigger, RPC error will)
      supabase.rpc.mockImplementation(async (name: string) => {
        if (name === 'economy_add_balance') return { data: null, error: { message: 'fail' } };
        return { data: null, error: null };
      });

      const result = await em.claimTimedReward('u1', 'daily');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to credit');
    });
  });

  // ── Work ────────────────────────────────────────────────

  describe('work', () => {
    it('earns money on successful work', async () => {
      (randomInt as ReturnType<typeof vi.fn>).mockImplementation((min: number, max: number) => min);
      const result = await em.work('u1');
      expect(result.success).toBe(true);
      expect(result.amount).toBe(100); // economy_work_min
      expect(result.message).toContain('earned');
    });

    it('enforces cooldown', async () => {
      await em.work('u1');
      const result = await em.work('u1');
      expect(result.success).toBe(false);
      expect(result.message).toContain('need to rest');
    });

    it('handles creditWallet failure', async () => {
      supabase.rpc.mockImplementation(async (name: string) => {
        if (name === 'economy_add_balance') return { data: null, error: { message: 'fail' } };
        return { data: null, error: null };
      });
      const result = await em.work('u1');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to credit');
    });
  });

  // ── Crime ───────────────────────────────────────────────

  describe('crime', () => {
    it('succeeds when chance passes', async () => {
      // randomInt returns min (0) which is < 40*100=4000, so chance(40) = true
      (randomInt as ReturnType<typeof vi.fn>).mockImplementation((min: number, max: number) => min);
      const result = await em.crime('u1');
      expect(result.success).toBe(true);
      expect(result.amount).toBe(200); // economy_crime_min
    });

    it('fails and pays fine when chance fails', async () => {
      // Make chance(40) return false: randomInt needs to return >= 4000
      (randomInt as ReturnType<typeof vi.fn>).mockImplementation((min: number, max: number) => {
        if (min === 0 && max === 10000) return 9999; // chance → false
        return min;
      });
      const result = await em.crime('u1');
      expect(result.success).toBe(false);
      // Fine = wallet * crime_fine_pct / 100 = 1000 * 50 / 100 = 500
      expect(result.amount).toBe(-500);
      expect(result.message).toContain('fine');
    });

    it('enforces cooldown', async () => {
      await em.crime('u1');
      const result = await em.crime('u1');
      expect(result.success).toBe(false);
      expect(result.message).toContain('lay low');
    });

    it('crime fail with empty wallet pays no fine', async () => {
      (randomInt as ReturnType<typeof vi.fn>).mockImplementation((min: number, max: number) => {
        if (min === 0 && max === 10000) return 9999; // chance → false
        return min;
      });
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet({ wallet: 0 }) });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.crime('u1');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Lucky you had no money');
    });
  });

  // ── Beg ─────────────────────────────────────────────────

  describe('beg', () => {
    it('succeeds when chance passes', async () => {
      (randomInt as ReturnType<typeof vi.fn>).mockImplementation((min: number, max: number) => min);
      const result = await em.beg('u1');
      expect(result.success).toBe(true);
      expect(result.amount).toBe(1); // randInt(1, 50) with min
    });

    it('fails when chance fails', async () => {
      (randomInt as ReturnType<typeof vi.fn>).mockImplementation((min: number, max: number) => {
        if (min === 0 && max === 10000) return 9999; // chance → false
        return min;
      });
      const result = await em.beg('u1');
      expect(result.success).toBe(false);
    });

    it('enforces cooldown', async () => {
      await em.beg('u1');
      const result = await em.beg('u1');
      expect(result.success).toBe(false);
      expect(result.message).toContain('beg again in');
    });
  });

  // ── Search ──────────────────────────────────────────────

  describe('search', () => {
    it('succeeds when chance passes', async () => {
      (randomInt as ReturnType<typeof vi.fn>).mockImplementation((min: number, max: number) => min);
      const result = await em.search('u1');
      expect(result.success).toBe(true);
      expect(result.message).toContain('found');
    });

    it('fails when chance fails', async () => {
      (randomInt as ReturnType<typeof vi.fn>).mockImplementation((min: number, max: number) => {
        if (min === 0 && max === 10000) return 9999;
        return min;
      });
      const result = await em.search('u1');
      expect(result.success).toBe(false);
    });

    it('enforces cooldown', async () => {
      await em.search('u1');
      const result = await em.search('u1');
      expect(result.success).toBe(false);
      expect(result.message).toContain('search again in');
    });
  });

  // ── Pay ─────────────────────────────────────────────────

  describe('pay', () => {
    it('transfers money between users', async () => {
      const result = await em.pay('u1', 'u2', 200);
      expect(result.success).toBe(true);
      expect(result.amount).toBe(200);
      expect(result.message).toContain('Sent');
    });

    it('prevents self-pay', async () => {
      const result = await em.pay('u1', 'u1', 200);
      expect(result.success).toBe(false);
      expect(result.message).toContain("can't pay yourself");
    });

    it('rejects non-positive amount', async () => {
      const result = await em.pay('u1', 'u2', 0);
      expect(result.success).toBe(false);
      expect(result.message).toContain('positive');
    });

    it('fails on insufficient funds', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet({ wallet: 10 }) });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.pay('u1', 'u2', 500);
      expect(result.success).toBe(false);
      expect(result.message).toContain("don't have enough");
    });

    it('applies tax when configured', async () => {
      supabase._configData.economy_pay_tax_pct = 10;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') return chainBuilder({ data: supabase._configData });
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet({ wallet: 1000 }) });
        return chainBuilder({ data: null });
      });
      // Clear config cache
      em.invalidateConfig();
      const result = await em.pay('u1', 'u2', 100);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Tax');
    });

    it('refunds sender when receiver credit fails', async () => {
      // creditWallet is called multiple times. We need the one for receiver to fail.
      // debitWallet calls getOrCreateWallet (which may call creditWallet internally
      // only if wallet doesn't exist). Pay flow:
      //   1. loadConfig
      //   2. getOrCreateWallet(sender) — exists, returns directly
      //   3. debitWallet(sender) → getOrCreateWallet → rpc(subtract)
      //   4. creditWallet(receiver) → getOrCreateWallet → rpc(add) — FAIL here
      //   5. creditWallet(sender) for refund → rpc(add)
      let addBalanceCalls = 0;
      supabase.rpc.mockImplementation(async (name: string) => {
        if (name === 'economy_subtract_balance') return { data: null, error: null };
        if (name === 'economy_add_balance') {
          addBalanceCalls++;
          // The 1st economy_add_balance call is receiver credit — fail it
          if (addBalanceCalls === 1) {
            return { data: null, error: { message: 'db down' } };
          }
          return { data: null, error: null };
        }
        return { data: null, error: null };
      });
      const result = await em.pay('u1', 'u2', 200);
      expect(result.success).toBe(false);
      expect(result.message).toContain('refunded');
    });
  });

  // ── Rob ─────────────────────────────────────────────────

  describe('rob', () => {
    it('prevents self-rob', async () => {
      const result = await em.rob('u1', 'u1');
      expect(result.success).toBe(false);
      expect(result.message).toContain("can't rob yourself");
    });

    it('fails when robbing is disabled', async () => {
      supabase._configData.economy_rob_enabled = false;
      em.invalidateConfig();
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') return chainBuilder({ data: supabase._configData });
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet() });
        return chainBuilder({ data: null });
      });
      const result = await em.rob('u1', 'u2');
      expect(result.success).toBe(false);
      expect(result.message).toContain('disabled');
    });

    it('enforces cooldown', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') {
          return chainBuilder({
            data: makeWallet({ wallet: 5000, passive: false }),
          });
        }
        if (table === 'economy_inventory') return chainBuilder({ data: null });
        return chainBuilder({ data: supabase._configData });
      });
      await em.rob('u1', 'u2');
      const result = await em.rob('u1', 'u2');
      expect(result.success).toBe(false);
      expect(result.message).toContain('wait');
    });

    it('fails when robber has passive mode', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') {
          return chainBuilder({ data: makeWallet({ passive: true }) });
        }
        if (table === 'economy_inventory') return chainBuilder({ data: null });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.rob('u1', 'u2');
      expect(result.success).toBe(false);
      expect(result.message).toContain('passive mode');
    });

    it('fails when victim has passive mode', async () => {
      let walletCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') {
          walletCallCount++;
          if (walletCallCount <= 1) {
            return chainBuilder({ data: makeWallet({ user_id: 'u1', passive: false }) });
          }
          return chainBuilder({ data: makeWallet({ user_id: 'u2', passive: true }) });
        }
        if (table === 'economy_inventory') return chainBuilder({ data: null });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.rob('u1', 'u2');
      expect(result.success).toBe(false);
      expect(result.message).toContain('passive mode');
    });

    it('fails when victim wallet is under 50', async () => {
      let walletCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') {
          walletCallCount++;
          if (walletCallCount <= 1) {
            return chainBuilder({ data: makeWallet({ user_id: 'u1' }) });
          }
          return chainBuilder({ data: makeWallet({ user_id: 'u2', wallet: 10 }) });
        }
        if (table === 'economy_inventory') return chainBuilder({ data: null });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.rob('u1', 'u2');
      expect(result.success).toBe(false);
      expect(result.message).toContain('minimum 50');
    });
  });

  // ── Passive mode ────────────────────────────────────────

  describe('togglePassive', () => {
    it('enables passive mode', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') {
          const c = chainBuilder({ data: makeWallet({ passive: false }) });
          (c.update as ReturnType<typeof vi.fn>).mockReturnValue(
            { eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) }
          );
          return c;
        }
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.togglePassive('u1');
      expect(result.enabled).toBe(true);
      expect(result.message).toContain('enabled');
    });

    it('disables passive mode', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') {
          const c = chainBuilder({ data: makeWallet({ passive: true }) });
          (c.update as ReturnType<typeof vi.fn>).mockReturnValue(
            { eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) }
          );
          return c;
        }
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.togglePassive('u1');
      expect(result.enabled).toBe(false);
      expect(result.message).toContain('disabled');
    });

    it('fails when passive mode not allowed', async () => {
      supabase._configData.economy_passive_mode_allowed = false;
      em.invalidateConfig();
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') return chainBuilder({ data: supabase._configData });
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet() });
        return chainBuilder({ data: null });
      });
      const result = await em.togglePassive('u1');
      expect(result.message).toContain('disabled on this server');
    });

    it('handles DB update failure', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') {
          const c = chainBuilder({ data: makeWallet({ passive: false }) });
          (c.update as ReturnType<typeof vi.fn>).mockReturnValue(
            { eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: { message: 'fail' } }) }) }
          );
          return c;
        }
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.togglePassive('u1');
      expect(result.message).toContain('Failed to toggle');
    });
  });

  // ── Shop ────────────────────────────────────────────────

  describe('getShopItems', () => {
    it('returns shop items list', async () => {
      const items = [{ id: 'i1', name: 'Sword', description: null, emoji: '⚔️', category: 'weapons', price: 100, stock: null }];
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_items') {
          const c = chainBuilder();
          // Override the chain's then to resolve with items
          c.then = (res: (v: unknown) => void) => Promise.resolve({ data: items }).then(res);
          // Also make limit resolve
          (c.limit as ReturnType<typeof vi.fn>).mockResolvedValue({ data: items });
          return c;
        }
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.getShopItems();
      expect(Array.isArray(result)).toBe(true);
    });

    it('returns filtered items by category', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_items') {
          // getShopItems stores intermediate query then calls .eq on it, so
          // limit must return a chainable object too
          const c = chainBuilder();
          const innerChain = chainBuilder();
          (innerChain.then as any) = (res: (v: unknown) => void) => Promise.resolve({ data: [] }).then(res);
          (c.limit as ReturnType<typeof vi.fn>).mockReturnValue(innerChain);
          return c;
        }
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.getShopItems('weapons');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('buyItem', () => {
    it('fails when item not found', async () => {
      const result = await em.buyItem('u1', 'nonexistent', 1);
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('buys item successfully', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_items') {
          return chainBuilder({
            data: { id: 'i1', name: 'Sword', emoji: '⚔️', price: 100, stock: null, max_per_user: null, require_role_id: null, grant_role_id: null, durability: null },
          });
        }
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet() });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.buyItem('u1', 'i1', 1);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Bought');
    });

    it('fails when out of stock', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_items') {
          return chainBuilder({
            data: { id: 'i1', name: 'Sword', price: 100, stock: 0, max_per_user: null },
          });
        }
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet() });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.buyItem('u1', 'i1', 5);
      expect(result.success).toBe(false);
      expect(result.message).toContain('stock');
    });
  });

  describe('sellItem', () => {
    it('fails when item not found', async () => {
      const result = await em.sellItem('u1', 'nonexistent', 1);
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('fails when sell_price is 0', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_items') {
          return chainBuilder({
            data: { id: 'i1', name: 'Sword', sell_price: 0 },
          });
        }
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet() });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.sellItem('u1', 'i1', 1);
      expect(result.success).toBe(false);
      expect(result.message).toContain('cannot be sold');
    });

    it('fails when user does not have enough items', async () => {
      let fromCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_items') {
          return chainBuilder({
            data: { id: 'i1', name: 'Sword', sell_price: 50 },
          });
        }
        if (table === 'economy_inventory') {
          return chainBuilder({ data: { id: 'inv1', quantity: 1 } });
        }
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet() });
        return chainBuilder({ data: supabase._configData });
      });
      const result = await em.sellItem('u1', 'i1', 5);
      expect(result.success).toBe(false);
      expect(result.message).toContain('only have');
    });
  });

  // ── Inventory ───────────────────────────────────────────

  describe('getInventory', () => {
    it('returns mapped inventory', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_inventory') {
          const c = chainBuilder();
          (c.limit as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [
              { quantity: 3, durability_remaining: null, item_id: 'i1', economy_items: { name: 'Sword', emoji: '⚔️' } },
            ],
          });
          return c;
        }
        return chainBuilder({ data: supabase._configData });
      });
      const inv = await em.getInventory('u1');
      expect(inv).toHaveLength(1);
      expect(inv[0].item_name).toBe('Sword');
      expect(inv[0].item_emoji).toBe('⚔️');
      expect(inv[0].quantity).toBe(3);
    });

    it('handles null economy_items gracefully', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_inventory') {
          const c = chainBuilder();
          (c.limit as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [{ quantity: 1, durability_remaining: null, item_id: 'i2', economy_items: null }],
          });
          return c;
        }
        return chainBuilder({ data: supabase._configData });
      });
      const inv = await em.getInventory('u1');
      expect(inv[0].item_name).toBe('Unknown');
      expect(inv[0].item_emoji).toBe('📦');
    });
  });

  // ── Chat income & leaderboard ───────────────────────────

  describe('processChatIncome', () => {
    it('skips when chat income disabled', async () => {
      const result = await em.processChatIncome('u1', 'ch1');
      // Should complete without error (config has chat_income_enabled: false)
      expect(result).toBeUndefined();
    });

    it('credits chat income when enabled', async () => {
      supabase._configData.economy_chat_income_enabled = true;
      em.invalidateConfig();
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') return chainBuilder({ data: supabase._configData });
        if (table === 'economy_wallets') return chainBuilder({ data: makeWallet() });
        return chainBuilder({ data: null });
      });
      await em.processChatIncome('u1', 'ch1');
      // Should have tried to set cooldown in valkey
      expect(valkey.set).toHaveBeenCalled();
    });
  });

  describe('getLeaderboard', () => {
    it('returns leaderboard data', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_wallets') {
          const c = chainBuilder();
          (c.limit as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [
              { user_id: 'u1', wallet: 1000, bank: 5000 },
              { user_id: 'u2', wallet: 500, bank: 2000 },
            ],
          });
          return c;
        }
        return chainBuilder({ data: supabase._configData });
      });
      const lb = await em.getLeaderboard(10);
      expect(Array.isArray(lb)).toBe(true);
    });
  });
});
