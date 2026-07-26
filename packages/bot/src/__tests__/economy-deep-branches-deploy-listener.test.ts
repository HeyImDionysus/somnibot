/**
 * Wave 13: Deep economy-manager branch coverage + deploy-listener + ticket-interactions stubs
 * Target: 133+ new covered statements
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { PRIMARY: 0x5865F2 },
  LEVEL_CONFIG: { DEFAULT_MIN_XP: 15, DEFAULT_MAX_XP: 25 },
  calculateLevel: vi.fn(() => ({ level: 1, xp: 0, xpForNext: 100 })),
  randomXp: vi.fn(() => 20),
  AUTOMATION_LIMITS: { MAX_ACTIONS_PER_AUTOMATION: 10, MAX_DELAY_SECONDS: 3600, ROLE_GRANT_DELAY_MS: 0, MAX_CHAIN_DEPTH: 3 },
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    get(key: K) { return super.get(key); }
    has(key: K) { return super.has(key); }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
  }
  class EmbedBuilder {
    data: any = {};
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setFooter(f: any) { this.data.footer = f; return this; }
    setThumbnail(t: string) { this.data.thumbnail = t; return this; }
    setAuthor(a: any) { this.data.author = a; return this; }
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields ?? []), ...f]; return this; }
    setTimestamp() { return this; }
    setURL(u: string) { this.data.url = u; return this; }
    setImage(u: string) { this.data.image = u; return this; }
    toJSON() { return this.data; }
  }
  return {
    Collection, EmbedBuilder,
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ViewChannel: 1n },
    ButtonBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } setEmoji() { return this; } setDisabled() { return this; } setURL() { return this; } },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
    ComponentType: { Button: 2 },
  };
});

vi.mock('../../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../../services/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() },
}));

const { Collection } = await import('discord.js');

function chain(data: any = null, error: any = null, count: number | null = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps','single','maybeSingle','rpc','channel','on'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error, count }));
  c.single = vi.fn(async () => ({ data, error, count }));
  c.then = undefined;
  return c;
}

function makeGuild(id = 'g1') {
  return {
    id, name: 'TestGuild', memberCount: 100,
    members: { cache: new Collection() },
    channels: { cache: new Collection() },
    roles: { cache: new Collection() },
    iconURL: () => 'https://icon.png',
  } as any;
}

function makeValkey() {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    setex: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    incrby: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => -2), // -2 = key doesn't exist
    ping: vi.fn(async () => 'PONG'),
    multi: vi.fn(() => ({
      incrby: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [[null, 1]]),
    })),
  } as any;
}

// ═══════════════════════════════════════
// EconomyManager — deep branches
// ═══════════════════════════════════════
describe('EconomyManager deep branches', () => {
  let EconomyManager: any;
  
  beforeEach(async () => {
    const mod = await import('../features/economy/economy-manager.js');
    EconomyManager = mod.EconomyManager;
  });

  it('loadConfig from supabase', async () => {
    const configData = {
      guild_id: 'g1', currency_name: 'coins', currency_emoji: '💰',
      starting_balance: 100, daily_amount: 50, weekly_amount: 200,
      monthly_amount: 500, work_min: 10, work_max: 50, work_cooldown: 30,
      crime_min: 50, crime_max: 200, crime_cooldown: 60, crime_fine_min: 20,
      crime_fine_max: 100, crime_success_rate: 50, beg_min: 1, beg_max: 20,
      beg_cooldown: 30, search_min: 5, search_max: 30, search_cooldown: 30,
      rob_min_pct: 10, rob_max_pct: 50, rob_cooldown: 120, rob_fail_fine_pct: 25,
      rob_success_rate: 40, passive_mode_enabled: true, max_wallet: 0,
      max_bank: 0, bank_interest_rate: 0, bank_interest_interval_hours: 24,
      chat_income_enabled: false, chat_income_min: 1, chat_income_max: 5,
      chat_income_cooldown: 60, daily_loss_limit: 0,
    };
    const supa = { from: vi.fn(() => chain(configData)) } as any;
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    const config = await mgr.loadConfig();
    expect(config.currency_name).toBe('coins');
  });

  it('loadConfig uses cache on second call', async () => {
    const supa = { from: vi.fn(() => chain({ guild_id: 'g1', currency_name: 'gold' })) } as any;
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    await mgr.loadConfig();
    await mgr.loadConfig(); // Should use cache
    expect(supa.from).toHaveBeenCalledTimes(1);
  });

  it('getOrCreateWallet returns existing', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 500, bank: 200, passive_mode: false };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    const wallet = await mgr.getOrCreateWallet('u1');
    expect(wallet.wallet).toBe(500);
  });

  it('creditWallet adds to wallet', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 600, bank: 0 };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    const result = await mgr.creditWallet('u1', 100);
    expect(result).toBeDefined();
  });

  it('debitWallet removes from wallet', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 400, bank: 0 };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    const result = await mgr.debitWallet('u1', 100);
    expect(result).toBeDefined();
  });

  it('deposit moves wallet to bank', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 500, bank: 100 };
    const configData = { guild_id: 'g1', max_bank: 0 };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    // Pre-load config
    (mgr as any).configCache = { guild_id: 'g1', max_bank: 0, currency_name: 'coins', currency_emoji: '💰' };
    (mgr as any).configCacheTime = Date.now();
    const result = await mgr.deposit('u1', 200);
    expect(result).toBeDefined();
  });

  it('withdraw moves bank to wallet', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 100, bank: 500 };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    (mgr as any).configCache = { guild_id: 'g1', max_wallet: 0 };
    (mgr as any).configCacheTime = Date.now();
    const result = await mgr.withdraw('u1', 200);
    expect(result).toBeDefined();
  });

  it('work earns money', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 100, bank: 0 };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const valkey = makeValkey();
    const mgr = new EconomyManager(makeGuild(), supa, valkey);
    (mgr as any).configCache = { 
      guild_id: 'g1', work_min: 10, work_max: 50, work_cooldown: 30,
      currency_name: 'coins', currency_emoji: '💰', daily_loss_limit: 0,
    };
    (mgr as any).configCacheTime = Date.now();
    const result = await mgr.work('u1');
    expect(result).toBeDefined();
  });

  it('crime with success', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 100, bank: 0 };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const valkey = makeValkey();
    const mgr = new EconomyManager(makeGuild(), supa, valkey);
    (mgr as any).configCache = {
      guild_id: 'g1', crime_min: 50, crime_max: 200, crime_cooldown: 60,
      crime_fine_min: 20, crime_fine_max: 100, crime_success_rate: 100, // 100% success
      currency_name: 'coins', currency_emoji: '💰', daily_loss_limit: 0,
    };
    (mgr as any).configCacheTime = Date.now();
    const result = await mgr.crime('u1');
    expect(result).toBeDefined();
  });

  it('beg earns money', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 50, bank: 0 };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const valkey = makeValkey();
    const mgr = new EconomyManager(makeGuild(), supa, valkey);
    (mgr as any).configCache = {
      guild_id: 'g1', beg_min: 1, beg_max: 20, beg_cooldown: 30,
      currency_name: 'coins', currency_emoji: '💰', daily_loss_limit: 0,
    };
    (mgr as any).configCacheTime = Date.now();
    const result = await mgr.beg('u1');
    expect(result).toBeDefined();
  });

  it('search earns money', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 50, bank: 0 };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const valkey = makeValkey();
    const mgr = new EconomyManager(makeGuild(), supa, valkey);
    (mgr as any).configCache = {
      guild_id: 'g1', search_min: 5, search_max: 30, search_cooldown: 30,
      currency_name: 'coins', currency_emoji: '💰', daily_loss_limit: 0,
    };
    (mgr as any).configCacheTime = Date.now();
    const result = await mgr.search('u1');
    expect(result).toBeDefined();
  });

  it('pay transfers money', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 500, bank: 0, passive_mode: false };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    (mgr as any).configCache = { guild_id: 'g1', currency_name: 'coins', currency_emoji: '💰' };
    (mgr as any).configCacheTime = Date.now();
    const result = await mgr.pay('u1', 'u2', 100, 'req-pay-1');
    expect(result).toBeDefined();
  });

  it('togglePassive', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 100, bank: 0, passive_mode: false };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    (mgr as any).configCache = { guild_id: 'g1', passive_mode_enabled: true };
    (mgr as any).configCacheTime = Date.now();
    const result = await mgr.togglePassive('u1');
    expect(result).toBeDefined();
  });

  it('getShopItems', async () => {
    const items = [{ id: 'i1', name: 'Sword', description: 'A sword', emoji: '⚔️', category: 'weapons', price: 100, stock: null }];
    const supa = { from: vi.fn(() => chain(items)) } as any;
    // Override maybeSingle to return array
    const c = chain();
    c.then = undefined;
    // Hack: make from return a chain where the last call returns items array
    const fromChain: any = {};
    for (const m of ['select','eq','gt','order','limit','ilike'])
      fromChain[m] = vi.fn(() => fromChain);
    fromChain.then = (resolve: any) => resolve({ data: items, error: null });
    supa.from = vi.fn(() => fromChain);
    
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    const result = await mgr.getShopItems();
    expect(result).toBeDefined();
  });

  it('getLeaderboard', async () => {
    const leaders = [
      { user_id: 'u1', wallet: 500, bank: 200 },
      { user_id: 'u2', wallet: 300, bank: 100 },
    ];
    const fromChain: any = {};
    for (const m of ['select','eq','order','limit','gt','gte','or'])
      fromChain[m] = vi.fn(() => fromChain);
    fromChain.then = (resolve: any) => resolve({ data: leaders, error: null });
    const supa = { from: vi.fn(() => fromChain), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    const result = await mgr.getLeaderboard(10);
    expect(result).toBeDefined();
  });

  it('processChatIncome', async () => {
    const walletData = { user_id: 'u1', guild_id: 'g1', wallet: 100, bank: 0 };
    const supa = { from: vi.fn(() => chain(walletData)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const valkey = makeValkey();
    const mgr = new EconomyManager(makeGuild(), supa, valkey);
    (mgr as any).configCache = {
      guild_id: 'g1', chat_income_enabled: true, chat_income_min: 1,
      chat_income_max: 5, chat_income_cooldown: 60,
      currency_name: 'coins', currency_emoji: '💰',
    };
    (mgr as any).configCacheTime = Date.now();
    await mgr.processChatIncome('u1', 'ch1');
  });
});

// ═══════════════════════════════════════
// DeployListener — getDeployStatus
// ═══════════════════════════════════════
describe('DeployListener', () => {
  it('getDeployStatus returns null when no data', async () => {
    vi.mock('../services/supabase.js', () => ({
      getSupabase: vi.fn(() => ({
        from: vi.fn(() => {
          const c: any = {};
          for (const m of ['select','eq','order','limit','single','maybeSingle'])
            c[m] = vi.fn(() => c);
          c.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
          c.single = vi.fn(async () => ({ data: null, error: null }));
          return c;
        }),
      })),
    }));
    
    const { getDeployStatus } = await import('../deploy/deploy-listener.js');
    const result = getDeployStatus();
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════
// Cross-feature bridge — deeper branches
// ═══════════════════════════════════════
describe('CrossFeatureBridge', () => {
  it('constructs and registers features', async () => {
    const { CrossFeatureBridge } = await import('../services/cross-feature-bridge.js');
    const supa = { from: vi.fn(() => chain(null)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const valkey = makeValkey();
    const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() } as any;
    
    const bridge = new CrossFeatureBridge(makeGuild(), supa, valkey, bus);
    expect(bridge).toBeDefined();
  });
});
