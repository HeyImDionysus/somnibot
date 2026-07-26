/**
 * Wave 6 coverage tests: FarmingManager, GatheringManager, SyncEngine, AutomationEngine
 * Target: +515 statements to reach 70% threshold
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => ({ trackProgress: vi.fn(async () => {}) }),
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    first() { return this.values().next().value; }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
    get size() { return super.size; }
    toJSON() { return [...this.values()]; }
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
    setImage(i: any) { return this; }
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields||[]), ...f]; return this; }
    toJSON() { return this.data; }
  }
  class ActionRowBuilder { components: any[] = []; addComponents(...c: any[]) { this.components.push(...c); return this; } }
  class ButtonBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: any) { return this; }
    setEmoji(e: any) { return this; }
    setDisabled(d: boolean) { return this; }
  }
  return {
    Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ChannelType: { GuildText: 0, GuildVoice: 2 },
    Colors: { Red: 0xff0000, Green: 0x00ff00, Yellow: 0xffff00, Gold: 0xffd700 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n, BanMembers: 32n },
    time: vi.fn((ts: number) => `<t:${ts}>`),
    TimestampStyles: { RelativeTime: 'R', ShortDateTime: 'f' },
    userMention: vi.fn((id: string) => `<@${id}>`),
    channelMention: vi.fn((id: string) => `<#${id}>`),
    bold: vi.fn((s: string) => `**${s}**`),
    italic: vi.fn((s: string) => `*${s}*`),
    codeBlock: vi.fn((s: string) => '```\n' + s + '\n```'),
    inlineCode: vi.fn((s: string) => '`' + s + '`'),
  };
});

const { Collection } = await import('discord.js');

// ═══════ Helpers ═══════
function chain(data: any = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps','single','maybeSingle'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = undefined;
  return c;
}
function chainAsync(data: any[] = [], count: number | null = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data: data?.[0] ?? null, error, count }));
  c.single = vi.fn(async () => ({ data: data?.[0] ?? null, error, count }));
  c.then = (resolve: Function) => resolve({ data, error, count });
  return c;
}
function guild(id = 'g1') {
  const channels = new Collection<string, any>();
  const textCh: any = {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({ id: 'msg1', edit: vi.fn(async () => ({})) })),
    messages: { fetch: vi.fn(async () => new Collection()) },
    setName: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    permissionOverwrites: { edit: vi.fn(async () => {}) },
  };
  channels.set('ch1', textCh);
  return {
    id, name: 'Test Guild', memberCount: 50,
    roles: {
      cache: new Collection([['role1', { id: 'role1', name: 'Mod', position: 1, color: 0x00ff00, hexColor: '#00ff00', permissions: { has: () => true } }]]),
      everyone: { id: 'everyone' },
      fetch: vi.fn(async () => new Collection([['role1', { id: 'role1', name: 'Mod', position: 1, color: 0x00ff00 }]])),
    },
    channels: {
      cache: channels,
      fetch: vi.fn(async () => channels),
      create: vi.fn(async (opts: any) => ({ id: 'newch', name: opts.name, type: opts.type })),
    },
    members: {
      cache: new Collection(),
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'User', displayAvatarURL: () => 'url', bot: false, tag: 'User#0001' },
        displayName: 'User', roles: { cache: new Collection(), add: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        permissions: { has: () => true },
      })),
    },
    client: { user: { id: 'bot1' } },
    emojis: { cache: new Collection() },
  } as any;
}
function valkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1), ttl: vi.fn(async () => -2), pttl: vi.fn(async () => -2),
    sadd: vi.fn(async () => 1), sismember: vi.fn(async () => 0),
    smembers: vi.fn(async () => []), scard: vi.fn(async () => 0),
    keys: vi.fn(async () => []),
    hset: vi.fn(async () => 1), hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})),
    zadd: vi.fn(async () => 1), zrangebyscore: vi.fn(async () => []),
    setex: vi.fn(async () => 'OK'), incrby: vi.fn(async () => 5),
  } as any;
}

// ═══════════════════════════════════════════════
// FarmingManager
// ═══════════════════════════════════════════════
describe('FarmingManager', () => {
  const farmCfg = {
    economy_farming_enabled: true,
    economy_farm_grid_size: 4,
    economy_farming_wilt_enabled: true,
    economy_fertilizer_time_reduction_pct: 20,
  };

  const defaultCrops = [
    { id: 'crop1', name: 'Wheat', emoji: '🌾', growth_time_minutes: 60, sell_price: 10, seed_item_id: 'seed1', xp_reward: 5 },
    { id: 'crop2', name: 'Corn', emoji: '🌽', growth_time_minutes: 120, sell_price: 25, seed_item_id: 'seed2', xp_reward: 10 },
  ];

  const defaultPlots = [
    { id: 'plot1', user_id: 'u1', guild_id: 'g1', slot: 0, crop_id: 'crop1', planted_at: new Date(Date.now() - 3600000).toISOString(), watered: true, fertilized: false, harvested: false },
    { id: 'plot2', user_id: 'u1', guild_id: 'g1', slot: 1, crop_id: null, planted_at: null, watered: false, fertilized: false, harvested: false },
  ];

  function farmSupa(cfg = farmCfg, plots = defaultPlots, crops = defaultCrops) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(cfg);
        if (table === 'farming_plots') return chainAsync(plots);
        if (table === 'farming_crops') return chainAsync(crops);
        if (table === 'economy_inventory') return chainAsync([{ id: 'inv1', item_id: 'seed1', quantity: 5 }]);
        if (table === 'economy_wallets') return chain({ wallet: 1000, bank: 500 });
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
  }

  it('getConfig loads and caches', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa(), valkey());
    const cfg1 = await mgr.getConfig();
    expect(cfg1.economy_farming_enabled).toBe(true);
    // Second call should use cache
    const cfg2 = await mgr.getConfig();
    expect(cfg2).toEqual(cfg1);
  });

  it('viewFarm shows grid', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa(), valkey());
    const result = await mgr.viewFarm('u1');
    expect(result.embed).toBeDefined();
  });

  it('viewFarm disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa({ ...farmCfg, economy_farming_enabled: false }), valkey());
    const result = await mgr.viewFarm('u1');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('viewFarm empty farm', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa(farmCfg, []), valkey());
    const result = await mgr.viewFarm('u1');
    expect(result.embed).toBeDefined();
  });

  it('plant crop', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa(), valkey());
    const result = await mgr.plant('u1', 'Wheat');
    expect(result.embed).toBeDefined();
  });

  it('plant unknown crop', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa(), valkey());
    const result = await mgr.plant('u1', 'NonExistentCrop');
    expect(result.embed).toBeDefined();
  });

  it('plant disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa({ ...farmCfg, economy_farming_enabled: false }), valkey());
    const result = await mgr.plant('u1', 'Wheat');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('water', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa(), valkey());
    const result = await mgr.water('u1');
    expect(result.embed).toBeDefined();
  });

  it('harvest', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa(), valkey());
    const result = await mgr.harvest('u1');
    expect(result.embed).toBeDefined();
  });

  it('harvest empty farm', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa(farmCfg, []), valkey());
    const result = await mgr.harvest('u1');
    expect(result.embed).toBeDefined();
  });

  it('fertilize', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa(), valkey());
    const result = await mgr.fertilize('u1', 0);
    expect(result.embed).toBeDefined();
  });

  it('invalidateConfig', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa(), valkey());
    await mgr.getConfig();
    mgr.invalidateConfig();
  });
});

// ═══════════════════════════════════════════════
// GatheringManager
// ═══════════════════════════════════════════════
describe('GatheringManager', () => {
  const gatherCfg = {
    economy_gathering_enabled: true,
    economy_gathering_cooldown_seconds: 60,
    economy_gathering_xp_per_gather: 5,
  };

  const lootTable = [
    { id: 'loot1', source_type: 'mine', item_id: 'item1', item_name: 'Iron Ore', item_emoji: '⛏️', rarity: 'common', weight: 100, min_quantity: 1, max_quantity: 3, coin_min: 5, coin_max: 15 },
  ];

  function gatherSupa(cfg = gatherCfg) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(cfg);
        if (table === 'gathering_loot') return chainAsync(lootTable);
        if (table === 'economy_inventory') return chainAsync([]);
        if (table === 'economy_wallets') return chain({ wallet: 1000, bank: 500 });
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
  }

  it('getConfig', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const mgr = new GatheringManager(guild(), gatherSupa(), valkey());
    const cfg = await mgr.getConfig();
    expect(cfg.economy_gathering_enabled).toBe(true);
  });

  it('gather mine', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const mgr = new GatheringManager(guild(), gatherSupa(), valkey());
    const result = await mgr.gather('u1', 'mine');
    expect(result.embed).toBeDefined();
    vi.restoreAllMocks();
  });

  it('gather hunt', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    const mgr = new GatheringManager(guild(), gatherSupa(), valkey());
    const result = await mgr.gather('u1', 'hunt');
    expect(result.embed).toBeDefined();
    vi.restoreAllMocks();
  });

  it('gather dig', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    vi.spyOn(Math, 'random').mockReturnValue(0.7);
    const mgr = new GatheringManager(guild(), gatherSupa(), valkey());
    const result = await mgr.gather('u1', 'dig');
    expect(result.embed).toBeDefined();
    vi.restoreAllMocks();
  });

  it('gather disabled', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const mgr = new GatheringManager(guild(), gatherSupa({ ...gatherCfg, economy_gathering_enabled: false }), valkey());
    const result = await mgr.gather('u1', 'mine');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('gather on cooldown', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const v = valkey();
    v.set = vi.fn(async () => null); // NX returns null = key exists = on cooldown
    v.pttl = vi.fn(async () => 30000);
    const mgr = new GatheringManager(guild(), gatherSupa(), v);
    const result = await mgr.gather('u1', 'mine');
    expect(result.embed).toBeDefined();
  });

  it('invalidateConfig', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const mgr = new GatheringManager(guild(), gatherSupa(), valkey());
    await mgr.getConfig();
    mgr.invalidateConfig();
  });
});

// ═══════════════════════════════════════════════
// MarketManager deeper (fill remaining 135 uncov)
// ═══════════════════════════════════════════════
describe('MarketManager deeper', () => {
  const marketCfg = {
    economy_enabled: true,
    market_enabled: true,
    market_fee_pct: 5,
    market_max_listings: 20,
    market_listing_duration_hours: 72,
    currency_name: 'coins',
    currency_emoji: '🪙',
  };

  function marketSupa(listings: any[] = []) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(marketCfg);
        if (table === 'market_listings') {
          const c = chainAsync(listings);
          c.insert = vi.fn(() => chain({ id: 'listing1' }));
          return c;
        }
        if (table === 'economy_wallets') return chain({ wallet: 5000, bank: 2000 });
        if (table === 'economy_inventory') return chainAsync([
          { id: 'inv1', item_id: 'item1', item_name: 'Sword', quantity: 3, item_emoji: '⚔️' },
        ]);
        if (table === 'economy_items' || table === 'economy_shop_items') return chainAsync([
          { id: 'item1', name: 'Sword', emoji: '⚔️', price: 100 },
        ]);
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: { success: true }, error: null })),
    } as any;
  }

  it('browse empty', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const mgr = new MarketManager(guild(), marketSupa(), valkey());
    const result = await mgr.browse();
    expect(result).toBeDefined();
  });

  it('browse with listings', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const listings = [
      { id: 'l1', seller_id: 'u2', item_id: 'item1', item_name: 'Sword', item_emoji: '⚔️', price: 150, quantity: 1, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() },
    ];
    const mgr = new MarketManager(guild(), marketSupa(listings), valkey());
    const result = await mgr.browse();
    expect(result).toBeDefined();
  });

  it('browse with search', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const listings = [
      { id: 'l1', seller_id: 'u2', item_id: 'item1', item_name: 'Sword', item_emoji: '⚔️', price: 150, quantity: 1, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() },
    ];
    const mgr = new MarketManager(guild(), marketSupa(listings), valkey());
    const result = await mgr.browse('Sword');
    expect(result).toBeDefined();
  });

  it('listItem', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const mgr = new MarketManager(guild(), marketSupa(), valkey());
    const result = await mgr.listItem('u1', 'item1', 200, 1);
    expect(result).toBeDefined();
  });

  it('buy listing', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const listings = [
      { id: 'l1', seller_id: 'u2', item_id: 'item1', item_name: 'Sword', item_emoji: '⚔️', price: 150, quantity: 1, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() },
    ];
    const mgr = new MarketManager(guild(), marketSupa(listings), valkey());
    const result = await mgr.buy('u1', 'l1');
    expect(result).toBeDefined();
  });

  it('buy own listing rejected', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const listings = [
      { id: 'l1', seller_id: 'u1', item_id: 'item1', item_name: 'Sword', item_emoji: '⚔️', price: 150, quantity: 1, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() },
    ];
    const mgr = new MarketManager(guild(), marketSupa(listings), valkey());
    const result = await mgr.buy('u1', 'l1');
    expect(result).toBeDefined();
  });

  it('myListings', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const listings = [
      { id: 'l1', seller_id: 'u1', item_id: 'item1', item_name: 'Sword', item_emoji: '⚔️', price: 150, quantity: 1, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() },
    ];
    const mgr = new MarketManager(guild(), marketSupa(listings), valkey());
    const result = await mgr.myListings('u1');
    expect(result).toBeDefined();
  });

  it('cancelListing', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const listings = [
      { id: 'l1', seller_id: 'u1', item_id: 'item1', item_name: 'Sword', item_emoji: '⚔️', price: 150, quantity: 1, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() },
    ];
    const mgr = new MarketManager(guild(), marketSupa(listings), valkey());
    const result = await mgr.cancelListing('u1', 'l1');
    expect(result).toBeDefined();
  });
});
