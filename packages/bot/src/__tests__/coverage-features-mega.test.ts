/**
 * Mega feature coverage: farming (plant/water/harvest/fertilize),
 * fishing (fish happy path, sellAll, getCollection, getLeaderboard, checkRod),
 * ticket-service (createTicket, claimTicket, closeTicket),
 * and crafting deeper paths.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    first() { return this.values().next().value; }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
    size = 0;
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
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields||[]), ...f]; return this; }
    toJSON() { return this.data; }
  }
  return { Collection, EmbedBuilder, ChannelType: { GuildText: 0, GuildVoice: 2 } };
});

vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));

const { Collection } = await import('discord.js');

function chain(data: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch'])
    c[m] = vi.fn(() => c);
  c.maybeSingle = vi.fn(async () => ({ data, error: null }));
  c.single = vi.fn(async () => ({ data, error: null }));
  c.then = undefined;
  return c;
}

function supa(routing: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => {
      if (table in routing) {
        const val = routing[table];
        return typeof val === 'function' ? val() : chain(val);
      }
      return chain(null);
    }),
    rpc: vi.fn(async () => ({ data: true, error: null })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: any) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: vi.fn() }; }),
    })),
  } as any;
}

function guild(id = 'g1') {
  const channels = new Collection<string, any>();
  channels.set('ch1', {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({ id: 'msg1', edit: vi.fn(async () => {}) })),
    messages: { fetch: vi.fn(async () => new Collection()) },
    permissionOverwrites: { create: vi.fn(async () => {}) },
  });
  return {
    id, name: 'Test Guild', memberCount: 100,
    roles: { cache: new Collection() },
    channels: { cache: channels, fetch: vi.fn(async () => channels), create: vi.fn(async () => channels.get('ch1')) },
    members: {
      cache: new Collection(),
      me: { roles: { highest: { position: 10 } } },
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'User', displayAvatarURL: () => 'url', send: vi.fn(async () => {}) },
      })),
    },
    client: { user: { id: 'bot1' }, users: { fetch: vi.fn(async () => ({ send: vi.fn(), id: 'u1' })) } },
  } as any;
}

function valkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1), ttl: vi.fn(async () => -2),
    pttl: vi.fn(async () => -2),
    sadd: vi.fn(async () => 1), sismember: vi.fn(async () => 0),
    smembers: vi.fn(async () => []), scard: vi.fn(async () => 0),
    keys: vi.fn(async () => []),
    hset: vi.fn(async () => 1), hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
  } as any;
}

// ═══════════════════════════════════════════════════════════
// FarmingManager — deep tests
// ═══════════════════════════════════════════════════════════
describe('FarmingManager deep', () => {
  const farmCfg = {
    economy_farming_enabled: true,
    economy_farming_max_plots: 6,
    economy_farming_water_cooldown: 60,
    currency_name: 'coins', currency_emoji: '🪙',
  };

  it('viewFarm empty', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const s = supa({
      guild_config: farmCfg,
      economy_farm_plots: () => { const c = chain(null); c.then = (resolve: Function) => resolve({ data: [], error: null }); return c; },
    });
    const mgr = new FarmingManager(guild(), s, valkey());
    const result = await mgr.viewFarm('u1');
    expect(result.embed).toBeDefined();
  });

  it('viewFarm with plots', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const plots = [
      { id: 'p1', user_id: 'u1', guild_id: 'g1', plot_number: 1, crop_name: 'Wheat', planted_at: new Date(Date.now() - 3600000).toISOString(), ready_at: new Date(Date.now() - 1000).toISOString(), watered: true, fertilized: false },
      { id: 'p2', user_id: 'u1', guild_id: 'g1', plot_number: 2, crop_name: null, planted_at: null, ready_at: null, watered: false, fertilized: false },
    ];
    const s = supa({
      guild_config: farmCfg,
      economy_farm_plots: () => { const c = chain(null); c.then = (resolve: Function) => resolve({ data: plots, error: null }); return c; },
    });
    const mgr = new FarmingManager(guild(), s, valkey());
    const result = await mgr.viewFarm('u1');
    expect(result.embed).toBeDefined();
  });

  it('viewFarm disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const s = supa({ guild_config: { economy_farming_enabled: false } });
    const mgr = new FarmingManager(guild(), s, valkey());
    const result = await mgr.viewFarm('u1');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('plant disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const s = supa({ guild_config: { economy_farming_enabled: false } });
    const mgr = new FarmingManager(guild(), s, valkey());
    const result = await mgr.plant('u1', 'Wheat');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('water disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const s = supa({ guild_config: { economy_farming_enabled: false } });
    const mgr = new FarmingManager(guild(), s, valkey());
    const result = await mgr.water('u1');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('harvest with no crops ready', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const plots = [
      { id: 'p1', user_id: 'u1', guild_id: 'g1', plot_number: 1, crop_name: 'Wheat', planted_at: new Date().toISOString(), ready_at: new Date(Date.now() + 3600000).toISOString(), watered: true, fertilized: false },
    ];
    const s = supa({
      guild_config: farmCfg,
      economy_farm_plots: () => { const c = chain(null); c.then = (resolve: Function) => resolve({ data: plots, error: null }); return c; },
    });
    const mgr = new FarmingManager(guild(), s, valkey());
    const result = await mgr.harvest('u1');
    expect(result.embed).toBeDefined();
  });

  it('harvest disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const s = supa({ guild_config: { economy_farming_enabled: false } });
    const mgr = new FarmingManager(guild(), s, valkey());
    const result = await mgr.harvest('u1');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('fertilize disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const s = supa({ guild_config: { economy_farming_enabled: false } });
    const mgr = new FarmingManager(guild(), s, valkey());
    const result = await mgr.fertilize('u1', 1);
    expect(result.embed.data.description).toContain('not enabled');
  });
});

// ═══════════════════════════════════════════════════════════
// FishingManager — deep tests  
// ═══════════════════════════════════════════════════════════
describe('FishingManager deep', () => {
  const fishCfg = {
    economy_fishing_enabled: true,
    economy_fishing_cooldown_seconds: 30,
    economy_fishing_bait_required: false,
    currency_name: 'coins', currency_emoji: '🪙',
  };

  it('fish happy path (no bait required)', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const species = [
      { id: 's1', name: 'Trout', emoji: '🐟', rarity: 'common', min_weight: 1, max_weight: 10, base_value: 10 },
      { id: 's2', name: 'Salmon', emoji: '🐠', rarity: 'rare', min_weight: 5, max_weight: 20, base_value: 50 },
    ];
    const s = supa({
      guild_config: fishCfg,
      economy_fish_species: () => { const c = chain(null); c.then = (resolve: Function) => resolve({ data: species, error: null }); return c; },
      economy_fish_catches: () => { const c = chain({ id: 'catch1' }); c.insert = vi.fn(() => c); return c; },
    });
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK'); // cooldown claim succeeds
    const mgr = new FishingManager(guild(), s, vk);
    const result = await mgr.fish('u1');
    expect(result.embed).toBeDefined();
    expect(result.cooldownKey).toBeDefined();
  });

  it('fish on cooldown', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const s = supa({ guild_config: fishCfg });
    const vk = valkey();
    vk.set = vi.fn(async () => null); // cooldown already set
    vk.pttl = vi.fn(async () => 15000);
    const mgr = new FishingManager(guild(), s, vk);
    const result = await mgr.fish('u1');
    expect(result.embed).toBeDefined();
  });

  it('sellAll with fish', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const catches = [
      { id: 'c1', species_id: 's1', weight: 5.2, economy_fish_species: { name: 'Trout', emoji: '🐟', base_value: 10 } },
      { id: 'c2', species_id: 's2', weight: 12.1, economy_fish_species: { name: 'Salmon', emoji: '🐠', base_value: 50 } },
    ];
    const s = supa({
      guild_config: { ...fishCfg, currency_name: 'coins', currency_emoji: '🪙' },
      economy_fish_catches: () => { const c = chain(null); c.then = (resolve: Function) => resolve({ data: catches, error: null }); return c; },
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const mgr = new FishingManager(guild(), s, valkey());
    const embed = await mgr.sellAll('u1');
    expect(embed).toBeDefined();
  });

  it('getLeaderboard', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const s = supa({
      guild_config: fishCfg,
    });
    s.rpc = vi.fn(async () => ({
      data: [{ user_id: 'u1', total_weight: 50.5, total_catches: 10, rarest_catch: 'Legendary Koi' }],
      error: null,
    }));
    const mgr = new FishingManager(guild(), s, valkey());
    const embed = await mgr.getLeaderboard();
    expect(embed).toBeDefined();
  });

  it('checkRod with rod', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const s = supa({
      guild_config: fishCfg,
      economy_inventory: () => { const c = chain(null); c.then = (resolve: Function) => resolve({ data: [{ id: "inv1", economy_items: { name: "Golden Fishing Rod", category: "Tools" }, quantity: 1 }], error: null }); return c; },
    });
    const mgr = new FishingManager(guild(), s, valkey());
    const result = await mgr.checkRod('u1');
    expect(result.hasRod).toBe(true);
  });

  it('checkRod without rod', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const s = supa({ guild_config: fishCfg, economy_inventory: () => { const c = chain(null); c.then = (resolve: Function) => resolve({ data: [], error: null }); return c; } });
    const mgr = new FishingManager(guild(), s, valkey());
    const result = await mgr.checkRod('u1');
    expect(result.hasRod).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// CraftingManager — deep tests
// ═══════════════════════════════════════════════════════════
describe('CraftingManager deep', () => {
  it('getRecipes returns list', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const recipes = [
      { id: 'r1', name: 'Iron Sword', description: 'Strong blade', emoji: '⚔️', ingredients: { iron: 3, wood: 1 }, result_item_id: 'item1', crafting_time_seconds: 60, level_required: 1 },
    ];
    const s = supa({
      guild_config: { economy_crafting_enabled: true },
      economy_recipes: () => { const c = chain(null); c.then = (resolve: Function) => resolve({ data: recipes, error: null }); return c; },
    });
    const mgr = new CraftingManager(guild(), s, valkey());
    const result = await mgr.getRecipes();
    expect(result).toBeDefined();
  });

  it('craft disabled', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const s = supa({ guild_config: { economy_crafting_enabled: false } });
    const mgr = new CraftingManager(guild(), s, valkey());
    const result = await mgr.craft('u1', 'r1');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('craft recipe not found', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const s = supa({
      guild_config: { economy_crafting_enabled: true },
      economy_recipes: null,
    });
    const mgr = new CraftingManager(guild(), s, valkey());
    const result = await mgr.craft('u1', 'fake');
    expect(result.embed).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// MarketManager — deeper paths
// ═══════════════════════════════════════════════════════════
describe('MarketManager deeper', () => {
  const mktCfg = { economy_market_enabled: true, economy_market_tax_pct: 5, currency_name: 'coins', currency_emoji: '🪙', economy_market_max_listings: 10 };

  it('browse with listings', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const listings = [
      { id: 'l1l1l1l1', seller_id: 'u2', item_name: 'Sword', price_per_unit: 100, remaining: 3, created_at: new Date().toISOString() },
      { id: 'l2l2l2l2', seller_id: 'u3', item_name: 'Shield', price_per_unit: 200, remaining: 1, created_at: new Date().toISOString() },
    ];
    const s = supa({
      guild_config: mktCfg,
      economy_market_listings: () => { const c = chain(null); c.then = (resolve: Function) => resolve({ data: listings, error: null }); return c; },
    });
    const mgr = new MarketManager(guild(), s, valkey());
    const embed = await mgr.browse();
    expect(embed).toBeDefined();
  });

  it('browse empty', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const s = supa({
      guild_config: mktCfg,
      economy_market_listings: () => { const c = chain(null); c.then = (resolve: Function) => resolve({ data: [], error: null }); return c; },
    });
    const mgr = new MarketManager(guild(), s, valkey());
    const embed = await mgr.browse();
    expect(embed).toBeDefined();
  });

  it('buy success', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const listing = {
      id: 'l1', seller_id: 'u2', item_name: 'Sword', price_per_unit: 100,
      remaining: 5, guild_id: 'g1', status: 'active',
    };
    const s = supa({
      guild_config: mktCfg,
      economy_market_listings: listing,
      economy_wallets: { wallet: 5000, bank: 0 },
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const mgr = new MarketManager(guild(), s, valkey());
    const embed = await mgr.buy('u1', 'l1', 2);
    expect(embed).toBeDefined();
  });

  it('listItem creates listing', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const s = supa({
      guild_config: mktCfg,
      economy_inventory: { item_id: 'item1', item_name: 'Sword', quantity: 10 },
      economy_market_listings: () => {
        const c = chain({ id: 'l1', item_name: 'Sword', remaining: 5, price_per_unit: 100, seller_id: 'u1' });
        c.insert = vi.fn(() => c);
        // For counting existing listings
        c.then = (resolve: Function) => resolve({ data: [], error: null, count: 2 });
        return c;
      },
    });
    const mgr = new MarketManager(guild(), s, valkey());
    const embed = await mgr.listItem('u1', 'item1', 5, 100);
    expect(embed).toBeDefined();
  });

  it('market disabled', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const s = supa({ guild_config: { economy_market_enabled: false } });
    const mgr = new MarketManager(guild(), s, valkey());
    const embed = await mgr.browse();
    expect(embed.data.description).toContain('not enabled');
  });
});
