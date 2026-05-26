/**
 * Deep coverage for economy-manager.ts methods:
 * buyItem, sellItem, rob, claimTimedReward, processChatIncome,
 * getInventory, getLeaderboard, togglePassive, getShopItems
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean): Collection<K, V> {
      const c = new Collection<K, V>();
      for (const [k, v] of this) if (fn(v)) c.set(k, v);
      return c;
    }
    find(fn: (v: V) => boolean): V | undefined {
      for (const v of this.values()) if (fn(v)) return v;
      return undefined;
    }
  }
  class EmbedBuilder {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setThumbnail(t: any) { return this; }
    setTimestamp() { return this; }
    setFooter(f: any) { return this; }
    setAuthor(a: any) { return this; }
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields || []), ...f]; return this; }
    toJSON() { return this.data; }
  }
  class PermissionsBitField {
    bitfield: bigint;
    constructor(bits?: any) { this.bitfield = BigInt(bits ?? 0); }
    has() { return true; }
  }
  return { Collection, EmbedBuilder, PermissionsBitField, ChannelType: { GuildText: 0 } };
});

vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => ({ trackProgress: vi.fn(async () => {}) }),
  registerQuestsManager: vi.fn(),
  invalidateQuestsCache: vi.fn(),
}));

const { Collection } = await import('discord.js');

// ── Helpers ──
const DEFAULT_CFG = {
  economy_enabled: true, economy_chat_income_enabled: true,
  economy_daily_amount: 500, economy_weekly_amount: 2500, economy_monthly_amount: 10000,
  economy_streak_bonus_pct: 10,
  economy_work_min: 100, economy_work_max: 500, economy_work_cooldown_seconds: 3600,
  economy_crime_min: 200, economy_crime_max: 1000, economy_crime_success_pct: 40,
  economy_crime_fine_pct: 30, economy_crime_cooldown_seconds: 7200,
  economy_beg_min: 10, economy_beg_max: 100, economy_beg_success_pct: 60,
  economy_search_min: 50, economy_search_max: 300, economy_search_success_pct: 50,
  economy_rob_enabled: true, economy_rob_success_pct: 50, economy_rob_fine_pct: 20,
  economy_chat_income_min: 5, economy_chat_income_max: 15,
  economy_chat_income_cooldown_seconds: 60,
  economy_market_enabled: true, economy_market_tax_pct: 5,
  currency_name: 'coins', currency_emoji: '🪙',
};
const DEFAULT_WALLET = { wallet: 5000, bank: 10000, passive: false };

function buildChain(data: any = null) {
  const chain: any = {};
  const methods = ['select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'not',
    'order', 'limit', 'range', 'match', 'ilike', 'like', 'filter',
    'contains', 'overlaps', 'textSearch'];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
  chain.single = vi.fn(async () => ({ data, error: null }));
  chain.then = undefined;
  return chain;
}

function makeTableSupa(routing: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => {
      if (table in routing) {
        const val = routing[table];
        return typeof val === 'function' ? val() : buildChain(val);
      }
      return buildChain(null);
    }),
    rpc: vi.fn(async (_fn: string, _args?: any) => ({ data: true, error: null })),
  };
}

function makeGuild(id = 'g1') {
  const members = new Collection<string, any>();
  members.set('u1', {
    id: 'u1', roles: { cache: new Collection(), add: vi.fn(async () => {}) },
  });
  return {
    id,
    name: 'Test Guild',
    memberCount: 100,
    roles: { cache: new Collection() },
    channels: { cache: new Collection() },
    members: {
      cache: members,
      me: { roles: { highest: { position: 10 } } },
      fetch: vi.fn(async (uid: string) => ({
        id: uid, roles: { cache: new Collection(), add: vi.fn(async () => {}) },
      })),
    },
  } as any;
}

function makeValkey() {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => -2),
    pttl: vi.fn(async () => -2),
    hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    keys: vi.fn(async () => []),
  } as any;
}

describe('EconomyManager deep', () => {
  // ── buyItem ──────────────────────────────────────────
  describe('buyItem', () => {
    it('item not found', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: null,
        economy_wallets: DEFAULT_WALLET,
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.buyItem('u1', 'missing', 1);
      expect(r.success).toBe(false);
      expect(r.message).toContain('not found');
    });

    it('out of stock', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: { id: 'item1', name: 'Sword', emoji: '⚔️', price: 100, stock: 0, max_per_user: null, require_role_id: null, grant_role_id: null, sell_price: 50, durability: null, active: true },
        economy_wallets: DEFAULT_WALLET,
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.buyItem('u1', 'item1', 1);
      expect(r.success).toBe(false);
      expect(r.message).toContain('stock');
    });

    it('max per user exceeded', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: { id: 'item1', name: 'Sword', emoji: '⚔️', price: 100, stock: null, max_per_user: 1, require_role_id: null, grant_role_id: null, sell_price: 50, durability: null, active: true },
        economy_wallets: DEFAULT_WALLET,
        economy_inventory: { quantity: 1 },
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.buyItem('u1', 'item1', 1);
      expect(r.success).toBe(false);
      expect(r.message).toContain('only own');
    });

    it('successful purchase with role grant', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: { id: 'item1', name: 'VIP Pass', emoji: '🌟', price: 100, stock: null, max_per_user: null, require_role_id: null, grant_role_id: 'role-vip', sell_price: 50, durability: null, active: true },
        economy_wallets: DEFAULT_WALLET,
        economy_transactions: null,
        audit_logs: null,
      });
      supa.rpc = vi.fn(async () => ({ data: true, error: null }));
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.buyItem('u1', 'item1', 1);
      expect(r.success).toBe(true);
      expect(r.message).toContain('Bought');
    });

    it('insufficient funds', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: { id: 'item1', name: 'Sword', emoji: '⚔️', price: 99999, stock: null, max_per_user: null, require_role_id: null, grant_role_id: null, sell_price: 50, durability: null, active: true },
        economy_wallets: DEFAULT_WALLET,
      });
      // debitWallet calls rpc('economy_subtract_balance') which returns error on insufficient funds:
      supa.rpc = vi.fn(async () => ({ data: null, error: { message: 'insufficient funds' } }));
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.buyItem('u1', 'item1', 1);
      expect(r.success).toBe(false);
      expect(r.message).toContain('need');
    });

    it('stock decrement fails after payment — refund', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: { id: 'item1', name: 'Sword', emoji: '⚔️', price: 100, stock: 5, max_per_user: null, require_role_id: null, grant_role_id: null, sell_price: 50, durability: null, active: true },
        economy_wallets: DEFAULT_WALLET,
      });
      let rpcCount = 0;
      supa.rpc = vi.fn(async (fn: string) => {
        rpcCount++;
        if (fn === 'economy_debit_wallet') return { data: { wallet: 4900, bank: 10000 }, error: null };
        if (fn === 'economy_decrement_stock') return { data: false, error: null };
        if (fn === 'economy_credit_wallet') return { data: { wallet: 5000, bank: 10000 }, error: null };
        return { data: true, error: null };
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.buyItem('u1', 'item1', 1);
      expect(r.success).toBe(false);
      expect(r.message).toContain('out of stock');
    });

    it('inventory upsert fails — refund + restore stock', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: { id: 'item1', name: 'Sword', emoji: '⚔️', price: 100, stock: 5, max_per_user: null, require_role_id: null, grant_role_id: null, sell_price: 50, durability: null, active: true },
        economy_wallets: DEFAULT_WALLET,
      });
      let rpcCount = 0;
      supa.rpc = vi.fn(async (fn: string) => {
        rpcCount++;
        if (fn === 'economy_debit_wallet') return { data: { wallet: 4900, bank: 10000 }, error: null };
        if (fn === 'economy_decrement_stock') return { data: true, error: null };
        if (fn === 'economy_upsert_inventory') return { data: null, error: { message: 'DB error' } };
        if (fn === 'economy_credit_wallet') return { data: { wallet: 5000, bank: 10000 }, error: null };
        if (fn === 'economy_increment_stock') return { data: true, error: null };
        return { data: true, error: null };
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.buyItem('u1', 'item1', 1);
      expect(r.success).toBe(false);
      expect(r.message).toContain('refunded');
    });
  });

  // ── sellItem ─────────────────────────────────────────
  describe('sellItem', () => {
    it('item not found', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: null,
        economy_wallets: DEFAULT_WALLET,
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.sellItem('u1', 'missing', 1);
      expect(r.success).toBe(false);
      expect(r.message).toContain('not found');
    });

    it('item not sellable (sell_price 0)', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: { id: 'item1', name: 'Key', emoji: '🔑', price: 100, sell_price: 0 },
        economy_wallets: DEFAULT_WALLET,
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.sellItem('u1', 'item1', 1);
      expect(r.success).toBe(false);
      expect(r.message).toContain('cannot be sold');
    });

    it('insufficient inventory', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: { id: 'item1', name: 'Sword', emoji: '⚔️', price: 100, sell_price: 50 },
        economy_wallets: DEFAULT_WALLET,
        economy_inventory: { id: 'inv1', quantity: 0 },
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.sellItem('u1', 'item1', 5);
      expect(r.success).toBe(false);
      expect(r.message).toContain('only have');
    });

    it('successful sell', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: { id: 'item1', name: 'Sword', emoji: '⚔️', price: 100, sell_price: 50 },
        economy_wallets: DEFAULT_WALLET,
        economy_inventory: { id: 'inv1', quantity: 5 },
        economy_transactions: null,
      });
      supa.rpc = vi.fn(async (fn: string) => {
        if (fn === 'economy_decrement_inventory') return { data: true, error: null };
        if (fn === 'economy_credit_wallet') return { data: { wallet: 5050, bank: 10000 }, error: null };
        return { data: true, error: null };
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.sellItem('u1', 'item1', 1);
      expect(r.success).toBe(true);
      expect(r.message).toContain('Sold');
    });

    it('credit fails — restore items', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: { id: 'item1', name: 'Sword', emoji: '⚔️', price: 100, sell_price: 50 },
        economy_wallets: DEFAULT_WALLET,
        economy_inventory: { id: 'inv1', quantity: 5 },
      });
      supa.rpc = vi.fn(async (fn: string) => {
        if (fn === 'economy_decrement_inventory') return { data: true, error: null };
        // economy_add_balance = creditWallet: return error to make it return null
        if (fn === 'economy_add_balance') return { data: null, error: { message: 'DB error' } };
        if (fn === 'economy_upsert_inventory') return { data: true, error: null };
        return { data: true, error: null };
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.sellItem('u1', 'item1', 1);
      expect(r.success).toBe(false);
      expect(r.message).toContain('returned');
    });
  });

  // ── rob ──────────────────────────────────────────────
  describe('rob', () => {
    it('robbing disabled', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: { ...DEFAULT_CFG, economy_rob_enabled: false },
        economy_wallets: DEFAULT_WALLET,
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.rob('u1', 'u2');
      expect(r.success).toBe(false);
      expect(r.message).toContain('disabled');
    });

    it('rob self', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_wallets: DEFAULT_WALLET,
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.rob('u1', 'u1');
      expect(r.success).toBe(false);
      expect(r.message).toContain("yourself");
    });

    it('on cooldown', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_wallets: DEFAULT_WALLET,
      });
      const valkey = makeValkey();
      valkey.set = vi.fn(async () => null); // NX fails
      valkey.get = vi.fn(async () => String(Date.now() + 300000));
      const mgr = new EconomyManager(makeGuild(), supa as any, valkey);
      const r = await mgr.rob('u1', 'u2');
      expect(r.success).toBe(false);
      expect(r.message).toContain('wait');
    });

    it('robber passive mode', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const callCount: Record<string, number> = {};
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
      });
      // Different wallets for robber vs victim:
      supa.from = vi.fn((table: string) => {
        callCount[table] = (callCount[table] ?? 0) + 1;
        if (table === 'guild_config') return buildChain(DEFAULT_CFG);
        if (table === 'economy_wallets') {
          // First call = robber, second = victim:
          if (callCount[table] <= 1) return buildChain({ wallet: 5000, bank: 10000, passive: true });
          return buildChain({ wallet: 5000, bank: 10000, passive: false });
        }
        return buildChain(null);
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.rob('u1', 'u2');
      expect(r.success).toBe(false);
      expect(r.message).toContain('passive');
    });

    it('victim too poor', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const callCount: Record<string, number> = {};
      const supa = makeTableSupa({ guild_config: DEFAULT_CFG });
      supa.from = vi.fn((table: string) => {
        callCount[table] = (callCount[table] ?? 0) + 1;
        if (table === 'guild_config') return buildChain(DEFAULT_CFG);
        if (table === 'economy_wallets') {
          if (callCount[table] <= 1) return buildChain({ wallet: 5000, bank: 10000, passive: false });
          return buildChain({ wallet: 10, bank: 0, passive: false }); // victim too poor
        }
        return buildChain(null);
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.rob('u1', 'u2');
      expect(r.success).toBe(false);
      expect(r.message).toContain("enough to rob");
    });
  });

  // ── claimTimedReward ─────────────────────────────────
  describe('claimTimedReward', () => {
    it('daily on cooldown', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_wallets: DEFAULT_WALLET,
      });
      const valkey = makeValkey();
      valkey.set = vi.fn(async () => null); // NX fails
      valkey.get = vi.fn(async () => String(Date.now() + 60000));
      const mgr = new EconomyManager(makeGuild(), supa as any, valkey);
      const r = await mgr.claimTimedReward('u1', 'daily');
      expect(r.success).toBe(false);
      expect(r.message).toContain('already claimed');
    });

    it('daily success with streak continuation', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_wallets: DEFAULT_WALLET,
        economy_streaks: {
          guild_id: 'g1', user_id: 'u1', streak_type: 'daily',
          current_streak: 3, longest_streak: 5,
          last_claimed_at: new Date(Date.now() - 23 * 3600000).toISOString(),
        },
        economy_transactions: null,
        audit_logs: null,
      });
      supa.rpc = vi.fn(async (fn: string) => {
        if (fn === 'economy_credit_wallet') return { data: { wallet: 5500, bank: 10000 }, error: null };
        return { data: true, error: null };
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.claimTimedReward('u1', 'daily');
      expect(r.success).toBe(true);
      expect(r.message).toContain('daily');
    });

    it('weekly success fresh streak', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_wallets: DEFAULT_WALLET,
        economy_streaks: null,
        economy_transactions: null,
        audit_logs: null,
      });
      supa.rpc = vi.fn(async () => ({ data: { wallet: 7500, bank: 10000 }, error: null }));
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.claimTimedReward('u1', 'weekly');
      expect(r.success).toBe(true);
      expect(r.message).toContain('weekly');
      expect(r.message).toContain('Streak started');
    });

    it('credit fails', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_wallets: DEFAULT_WALLET,
        economy_streaks: null,
      });
      // economy_add_balance = creditWallet: return error to trigger null return
      supa.rpc = vi.fn(async () => ({ data: null, error: { message: 'DB error' } }));
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.claimTimedReward('u1', 'monthly');
      expect(r.success).toBe(false);
      expect(r.message).toContain('Failed');
    });
  });

  // ── processChatIncome ────────────────────────────────
  describe('processChatIncome', () => {
    it('disabled economy skips', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: { ...DEFAULT_CFG, economy_enabled: false },
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      await mgr.processChatIncome('u1', 'ch1');
      // Should return without error
    });

    it('chat income on cooldown skips', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({ guild_config: DEFAULT_CFG });
      const valkey = makeValkey();
      valkey.set = vi.fn(async () => null); // NX fails = on cooldown
      const mgr = new EconomyManager(makeGuild(), supa as any, valkey);
      await mgr.processChatIncome('u1', 'ch1');
      // Should return without error
    });

    it('chat income success', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_wallets: DEFAULT_WALLET,
      });
      supa.rpc = vi.fn(async () => ({ data: { wallet: 5015, bank: 10000 }, error: null }));
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      await mgr.processChatIncome('u1', 'ch1');
      // No error = success
    });
  });

  // ── getInventory ─────────────────────────────────────
  describe('getInventory', () => {
    it('returns mapped items', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_inventory: () => {
          const c = buildChain(null);
          c.then = (resolve: Function) => resolve({
            data: [
              { item_id: 'i1', quantity: 3, durability_remaining: null, economy_items: { name: 'Sword', emoji: '⚔️' } },
              { item_id: 'i2', quantity: 1, durability_remaining: 5, economy_items: null },
            ],
            error: null,
          });
          return c;
        },
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const inv = await mgr.getInventory('u1');
      expect(inv).toHaveLength(2);
      expect(inv[0].item_name).toBe('Sword');
      expect(inv[1].item_name).toBe('Unknown');
    });
  });

  // ── getShopItems ─────────────────────────────────────
  describe('getShopItems', () => {
    it('returns items from supabase', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_items: () => {
          const c = buildChain(null);
          c.then = (resolve: Function) => resolve({
            data: [
              { id: 'i1', name: 'Sword', description: 'Sharp', emoji: '⚔️', category: 'weapons', price: 100, stock: null },
            ],
            error: null,
          });
          return c;
        },
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const items = await mgr.getShopItems();
      expect(items).toHaveLength(1);
    });
  });

  // ── togglePassive ────────────────────────────────────
  describe('togglePassive', () => {
    it('enables passive', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_wallets: { ...DEFAULT_WALLET, passive: false },
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const r = await mgr.togglePassive('u1');
      expect(typeof r.enabled).toBe('boolean');
      expect(r.message).toBeDefined();
    });
  });

  // ── getLeaderboard ───────────────────────────────────
  describe('getLeaderboard', () => {
    it('returns sorted list via RPC', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({ guild_config: DEFAULT_CFG });
      // getLeaderboard calls rpc('economy_leaderboard') — return array
      supa.rpc = vi.fn(async (fn: string) => {
        if (fn === 'economy_leaderboard') {
          return {
            data: [
              { user_id: 'u1', net_worth: 15000, wallet: 5000, bank: 10000 },
              { user_id: 'u2', net_worth: 23000, wallet: 3000, bank: 20000 },
            ],
            error: null,
          };
        }
        return { data: null, error: null };
      });
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const lb = await mgr.getLeaderboard(10);
      expect(lb).toHaveLength(2);
      expect(lb[0].user_id).toBe('u1');
    });

    it('falls back to client-side sort when RPC fails', async () => {
      const { EconomyManager } = await import('../features/economy/economy-manager.js');
      const supa = makeTableSupa({
        guild_config: DEFAULT_CFG,
        economy_wallets: () => {
          const c = buildChain(null);
          c.then = (resolve: Function) => resolve({
            data: [
              { user_id: 'u1', wallet: 5000, bank: 10000 },
              { user_id: 'u2', wallet: 3000, bank: 20000 },
            ],
            error: null,
          });
          return c;
        },
      });
      // RPC fails — triggers fallback:
      supa.rpc = vi.fn(async () => ({ data: null, error: { message: 'function not found' } }));
      const mgr = new EconomyManager(makeGuild(), supa as any, makeValkey());
      const lb = await mgr.getLeaderboard(10);
      expect(lb).toHaveLength(2);
      // u2 has higher net worth (23000 vs 15000)
      expect(lb[0].user_id).toBe('u2');
    });
  });
});
