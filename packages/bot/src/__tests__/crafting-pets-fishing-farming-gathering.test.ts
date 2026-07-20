/**
 * Wave 2 deep coverage tests: CraftingManager, PetsManager, FishingManager,
 * FarmingManager deeper, GatheringManager, StatsChannelManager, TicketService
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865F2, success: 0x57F287, error: 0xED4245, warning: 0xFEE75C },
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
  class StringSelectMenuBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setPlaceholder(p: string) { return this; }
    addOptions(...o: any[]) { return this; }
  }
  return {
    Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ChannelType: { GuildText: 0, GuildCategory: 4, PrivateThread: 12 },
    ComponentType: { Button: 2, StringSelect: 3 },
    Colors: { Red: 0xff0000, Green: 0x00ff00 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n, ManageRoles: 8n, ReadMessageHistory: 16n },
    OverwriteType: { Role: 0, Member: 1 },
  };
});

const { Collection } = await import('discord.js');

// ═══════════ Shared mock utilities ═══════════
function chain(data: any = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps'])
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
    send: vi.fn(async () => ({ id: 'msg1' })),
    messages: { fetch: vi.fn(async () => new Collection()) },
    permissionOverwrites: { cache: new Collection(), edit: vi.fn(async () => {}) },
    setName: vi.fn(async () => {}), setTopic: vi.fn(async () => {}),
  };
  channels.set('ch1', textCh);
  return {
    id, name: 'Test Guild', memberCount: 50,
    roles: { cache: new Collection(), everyone: { id: 'everyone' } },
    channels: {
      cache: channels,
      fetch: vi.fn(async () => textCh),
      create: vi.fn(async (opts: any) => ({ ...textCh, id: 'new-ch', name: opts.name })),
    },
    members: {
      cache: new Collection(),
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'User', displayAvatarURL: () => 'url', send: vi.fn(async () => {}) },
        roles: { cache: new Collection(), add: vi.fn(async () => {}) }, displayName: 'User',
        permissions: { has: () => true },
      })),
    },
    client: { user: { id: 'bot1' }, channels: { cache: channels } },
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
  } as any;
}
function cmdIx(overrides: any = {}) {
  const replyMsg = { id: 'r1', edit: vi.fn(async () => replyMsg), delete: vi.fn(async () => {}) };
  return {
    guildId: 'g1', channelId: 'ch1',
    user: { id: 'u1', username: 'TestUser', displayAvatarURL: () => 'url' },
    member: { id: 'u1', roles: { cache: new Collection() }, permissions: { has: () => true }, displayName: 'TestUser' },
    reply: vi.fn(async () => replyMsg), editReply: vi.fn(async () => replyMsg),
    deferReply: vi.fn(async () => {}), followUp: vi.fn(async () => replyMsg),
    fetchReply: vi.fn(async () => replyMsg),
    replied: false, deferred: false,
    options: {
      getString: vi.fn(() => null), getInteger: vi.fn(() => null),
      getNumber: vi.fn(() => null), getBoolean: vi.fn(() => null),
      getUser: vi.fn(() => null), getChannel: vi.fn(() => null),
      getRole: vi.fn(() => null), getSubcommand: vi.fn(() => null),
      getMember: vi.fn(() => null),
    },
    ...overrides,
  } as any;
}

// ═══════════════════════════════════════════════
// CraftingManager
// ═══════════════════════════════════════════════
describe('CraftingManager deep', () => {
  const cfg = { economy_crafting_enabled: true, economy_crafting_cooldown_seconds: 60 };
  const recipes = [
    { id: 'r1', guild_id: 'g1', name: 'Iron Sword', description: 'A sword', inputs: [{ item_name: 'Iron', qty: 3 }], output_item_name: 'Iron Sword', output_qty: 1, output_rarity: 'common', emoji: '⚔️', required_level: 0, is_default: true },
    { id: 'r2', guild_id: 'g1', name: 'Gold Ring', description: 'Shiny', inputs: [{ item_name: 'Gold', qty: 2 }], output_item_name: 'Gold Ring', output_qty: 1, output_rarity: 'rare', emoji: '💍', required_level: 5, is_default: true },
  ];

  function craftSupa(inv: any[] = []) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(cfg);
        if (table === 'economy_recipes') return chainAsync(recipes);
        if (table === 'economy_inventory') {
          if (inv.length) return chainAsync(inv);
          const c = chain(null);
          c.insert = vi.fn(() => c);
          return c;
        }
        if (table === 'economy_items') return chainAsync([{ id: 'item1', name: 'Iron Sword' }]);
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
  }

  it('listRecipes', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const mgr = new CraftingManager(guild(), craftSupa(), valkey());
    const result = await mgr.listRecipes();
    expect(result.embed.data.title).toContain('Recipe');
  });

  it('craft success', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const inv = [{ item_name: 'Iron', quantity: 5, item_id: 'iron1' }];
    const s = craftSupa(inv);
    s.rpc = vi.fn(async (_name: string) => {
      if (_name === 'economy_decrement_inventory') return { data: true, error: null };
      return { data: null, error: null };
    });
    const mgr = new CraftingManager(guild(), s, valkey());
    const result = await mgr.craft('u1', 'Iron Sword');
    expect(result.embed).toBeDefined();
  });

  it('craft disabled', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const s = craftSupa();
    s.from = vi.fn((t: string) => {
      if (t === 'guild_config') return chain({ economy_crafting_enabled: false });
      return chain(null);
    });
    const mgr = new CraftingManager(guild(), s, valkey());
    const result = await mgr.craft('u1', 'Iron Sword');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('craft recipe not found', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const mgr = new CraftingManager(guild(), craftSupa(), valkey());
    const result = await mgr.craft('u1', 'Nonexistent Recipe');
    expect(result.embed.data.description).toContain('found');
  });

  it('craft insufficient materials', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const inv = [{ item_name: 'Iron', quantity: 1, item_id: 'iron1' }]; // only 1, need 3
    const mgr = new CraftingManager(guild(), craftSupa(inv), valkey());
    const result = await mgr.craft('u1', 'Iron Sword');
    expect(result.embed.data.description).toContain('material');
  });

  it('craft on cooldown', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const vk = valkey();
    vk.set = vi.fn(async () => null); // NX fails
    vk.get = vi.fn(async () => String(Date.now() + 30000));
    const mgr = new CraftingManager(guild(), craftSupa(), vk);
    const result = await mgr.craft('u1', 'Iron Sword');
    expect(result.embed.data.description).toContain('wait');
  });
});

// ═══════════════════════════════════════════════
// GatheringManager
// ═══════════════════════════════════════════════
describe('GatheringManager deep', () => {
  const cfg = {
    economy_gathering_enabled: true,
    economy_gathering_cooldown_seconds: 60,
    economy_gathering_base_xp: 10,
    currency_name: 'coins', currency_emoji: '🪙',
  };
  const loot = [
    { id: 'l1', source_type: 'mine', item_name: 'Iron Ore', min_qty: 1, max_qty: 3, weight: 100, rarity: 'common', emoji: '⛏️', currency_reward: 10, xp_reward: 5 },
    { id: 'l2', source_type: 'mine', item_name: 'Gold Ore', min_qty: 1, max_qty: 1, weight: 20, rarity: 'rare', emoji: '✨', currency_reward: 50, xp_reward: 20 },
  ];

  function gatherSupa() {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(cfg);
        if (table === 'economy_gathering_loot') return chainAsync(loot);
        if (table === 'economy_inventory') {
          // checkTool: looking for pickaxe
          return chainAsync([{ id: 'inv1', item_id: 'pick1', quantity: 1, economy_items: { effect: 'pickaxe', tier: 1 }, durability_remaining: 10 }]);
        }
        if (table === 'economy_items') return chainAsync([{ id: 'item1' }]);
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
  }

  it('gather mine success', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK');
    const mgr = new GatheringManager(guild(), gatherSupa(), vk);
    const result = await mgr.gather('u1', 'mine');
    expect(result.embed).toBeDefined();
    vi.restoreAllMocks();
  });

  it('gather disabled', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const s = gatherSupa();
    s.from = vi.fn((t: string) => {
      if (t === 'guild_config') return chain({ economy_gathering_enabled: false });
      return chain(null);
    });
    const mgr = new GatheringManager(guild(), s, valkey());
    const result = await mgr.gather('u1', 'mine');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('gather cooldown', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const vk = valkey();
    vk.set = vi.fn(async () => null);
    vk.get = vi.fn(async () => String(Date.now() + 30000));
    const mgr = new GatheringManager(guild(), gatherSupa(), vk);
    const result = await mgr.gather('u1', 'mine');
    expect(result.embed.data.description).toContain('wait');
  });

  it('gather no tool', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const s = gatherSupa();
    s.from = vi.fn((table: string) => {
      if (table === 'guild_config') return chain(cfg);
      if (table === 'economy_gathering_loot') return chainAsync(loot);
      if (table === 'economy_inventory') return chainAsync([]);
      return chain(null);
    });
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK');
    const mgr = new GatheringManager(guild(), s, vk);
    const result = await mgr.gather('u1', 'mine');
    expect(result.embed).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// FishingManager deeper paths
// ═══════════════════════════════════════════════
describe('FishingManager deep', () => {
  const fishCfg = {
    economy_fishing_enabled: true,
    economy_fishing_cooldown_seconds: 30,
    economy_fishing_base_catch_chance: 70,
    currency_name: 'coins', currency_emoji: '🪙',
  };
  const species = [
    { id: 'sp1', name: 'Bass', emoji: '🐟', rarity: 'common', base_value: 10, weight: 80, min_size: 10, max_size: 30 },
    { id: 'sp2', name: 'Shark', emoji: '🦈', rarity: 'legendary', base_value: 500, weight: 5, min_size: 100, max_size: 300 },
  ];

  function fishSupa(catches: any[] = []) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(fishCfg);
        if (table === 'economy_fish_species') return chainAsync(species);
        if (table === 'economy_fish_catches') {
          if (catches.length) return chainAsync(catches);
          const c = chain(null);
          c.insert = vi.fn(() => c);
          return c;
        }
        if (table === 'economy_inventory') {
          // checkRod
          return chainAsync([{ id: 'inv1', economy_items: { name: 'Basic Rod', effect: 'fishing_rod' } }]);
        }
        if (table === 'economy_items') return chainAsync([{ id: 'item1' }]);
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
  }

  it('fish success', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK');
    const mgr = new FishingManager(guild(), fishSupa(), vk);
    const result = await mgr.fish('u1');
    expect(result.embed).toBeDefined();
    expect(result.cooldownKey).toBeDefined();
    vi.restoreAllMocks();
  });

  it('fish disabled', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const s = fishSupa();
    s.from = vi.fn((t: string) => {
      if (t === 'guild_config') return chain({ economy_fishing_enabled: false });
      return chain(null);
    });
    const mgr = new FishingManager(guild(), s, valkey());
    const result = await mgr.fish('u1');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('fish no rod', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const s = fishSupa();
    s.from = vi.fn((t: string) => {
      if (t === 'guild_config') return chain(fishCfg);
      if (t === 'economy_fish_species') return chainAsync(species);
      if (t === 'economy_inventory') return chainAsync([]);
      return chain(null);
    });
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK');
    const mgr = new FishingManager(guild(), s, vk);
    const result = await mgr.fish('u1');
    expect(result.embed.data.description).toContain('Rod');
  });

  it('sellAll', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const catches = [
      { id: 'c1', user_id: 'u1', species_id: 'sp1', size: 20, sold: false, economy_fish_species: { base_value: 10, name: 'Bass', emoji: '🐟' } },
      { id: 'c2', user_id: 'u1', species_id: 'sp1', size: 25, sold: false, economy_fish_species: { base_value: 10, name: 'Bass', emoji: '🐟' } },
    ];
    const mgr = new FishingManager(guild(), fishSupa(catches), valkey());
    const result = await mgr.sellAll('u1');
    expect(result).toBeDefined();
  });

  it('getCollection', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const catches = [
      { id: 'c1', species_id: 'sp1', size: 20, economy_fish_species: { name: 'Bass', emoji: '🐟', rarity: 'common' } },
    ];
    const mgr = new FishingManager(guild(), fishSupa(catches), valkey());
    const result = await mgr.getCollection('u1');
    expect(result).toBeDefined();
  });



  it('checkRod', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const mgr = new FishingManager(guild(), fishSupa(), valkey());
    const result = await mgr.checkRod('u1');
    expect(result.hasRod).toBe(true);
    expect(result.rodName).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// FarmingManager deeper paths
// ═══════════════════════════════════════════════
describe('FarmingManager deep', () => {
  const farmCfg = {
    economy_farming_enabled: true,
    economy_farming_max_plots: 6,
    economy_farming_base_growth_hours: 4,
    currency_name: 'coins', currency_emoji: '🪙',
  };
  const crops = [
    { id: 'cr1', name: 'Wheat', emoji: '🌾', growth_hours: 2, sell_value: 20, seed_item_name: 'Wheat Seeds', xp: 10, is_default: true },
    { id: 'cr2', name: 'Corn', emoji: '🌽', growth_hours: 4, sell_value: 50, seed_item_name: 'Corn Seeds', xp: 25, is_default: true },
  ];
  const emptyPlot = { id: 'pl1', user_id: 'u1', plot_number: 1, crop_id: null, planted_at: null, watered: false, fertilized: false, status: 'empty' };
  const growingPlot = { id: 'pl2', user_id: 'u1', plot_number: 2, crop_id: 'cr1', planted_at: new Date(Date.now() - 1000*60*60).toISOString(), watered: true, fertilized: false, status: 'growing' };
  const readyPlot = { id: 'pl3', user_id: 'u1', plot_number: 3, crop_id: 'cr1', planted_at: new Date(Date.now() - 1000*60*60*10).toISOString(), watered: true, fertilized: false, status: 'ready' };

  function farmSupa(plots: any[] = [emptyPlot]) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(farmCfg);
        if (table === 'economy_farm_plots') {
          const c = chainAsync(plots);
          c.insert = vi.fn(() => c);
          return c;
        }
        if (table === 'economy_farm_crops') return chainAsync(crops);
        if (table === 'economy_inventory') {
          return chainAsync([{ id: 'seed1', item_id: 'seed-item1', quantity: 5, economy_items: { name: 'Wheat Seeds', effect: 'seed' } }]);
        }
        if (table === 'economy_items') return chainAsync([{ id: 'seed-item1', name: 'Wheat Seeds' }, { id: 'wheat-item', name: 'Wheat' }]);
        return chain(null);
      }),
      rpc: vi.fn(async (_name: string) => {
        if (_name === 'economy_decrement_inventory') return { data: true, error: null };
        return { data: null, error: null };
      }),
    } as any;
  }

  it('viewFarm with plots', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa([emptyPlot, growingPlot, readyPlot]), valkey());
    const result = await mgr.viewFarm('u1');
    expect(result.embed).toBeDefined();
  });

  it('viewFarm empty', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa([]), valkey());
    const result = await mgr.viewFarm('u1');
    expect(result.embed).toBeDefined();
  });

  it('plant success', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa([emptyPlot]), valkey());
    const result = await mgr.plant('u1', 'Wheat');
    expect(result.embed).toBeDefined();
  });

  it('plant disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const s = farmSupa();
    s.from = vi.fn((t: string) => {
      if (t === 'guild_config') return chain({ economy_farming_enabled: false });
      return chain(null);
    });
    const mgr = new FarmingManager(guild(), s, valkey());
    const result = await mgr.plant('u1', 'Wheat');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('plant no empty plots', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa([growingPlot]), valkey());
    const result = await mgr.plant('u1', 'Wheat');
    expect(result.embed.data.description).toBeDefined(); // no empty plot or unknown crop
  });

  it('water', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa([growingPlot]), valkey());
    const result = await mgr.water('u1');
    expect(result.embed).toBeDefined();
  });

  it('harvest ready', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa([readyPlot]), valkey());
    const result = await mgr.harvest('u1');
    expect(result.embed).toBeDefined();
  });

  it('harvest nothing ready', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa([growingPlot]), valkey());
    const result = await mgr.harvest('u1');
    expect(result.embed.data.description).toContain('ready');
  });

  it('fertilize', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const mgr = new FarmingManager(guild(), farmSupa([growingPlot]), valkey());
    const result = await mgr.fertilize('u1', 2);
    expect(result.embed).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// PetsManager — interaction-based tests
// ═══════════════════════════════════════════════
describe('PetsManager deep', () => {
  const petCfg = {
    economy_pets_enabled: true,
    economy_pet_buy_cost: 500,
    economy_pet_feed_cost: 50,
    economy_pet_play_cooldown: 3600,
    economy_pet_train_cooldown: 7200,
    currency_name: 'coins', currency_emoji: '🪙',
  };
  const pet = {
    id: 'pet1', guild_id: 'g1', user_id: 'u1',
    name: 'Buddy', species: 'dog', emoji: '🐕',
    level: 5, xp: 100, happiness: 80, hunger: 50,
    attack: 10, defense: 8, speed: 12, prestige: 0,
    created_at: new Date().toISOString(),
  };

  function petSupa(petData: any = null) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(petCfg);
        if (table === 'economy_pets') {
          const c = chain(petData);
          c.insert = vi.fn(() => c);
          return c;
        }
        if (table === 'economy_wallets') return chain({ wallet: 5000, bank: 0 });
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
  }

  it('viewPet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const mgr = new PetsManager(petSupa(pet));
    await mgr.viewPet(cmdIx());
  });

  it('viewPet no pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const mgr = new PetsManager(petSupa(null));
    await mgr.viewPet(cmdIx());
  });

  it('buyPet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = petSupa(null); // no existing pet
    const mgr = new PetsManager(s);
    const ix = cmdIx({ options: { getString: vi.fn((key: string) => key === 'species' ? 'cat' : key === 'name' ? 'Fluffy' : null) }});
    await mgr.buyPet(ix);
  });

  it('buyPet already has pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const mgr = new PetsManager(petSupa(pet));
    await mgr.buyPet(cmdIx());
  });

  it('feedPet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const mgr = new PetsManager(petSupa(pet));
    await mgr.feedPet(cmdIx());
  });

  it('feedPet no pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const mgr = new PetsManager(petSupa(null));
    await mgr.feedPet(cmdIx());
  });

  it('playWithPet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK');
    const mgr = new PetsManager(petSupa(pet), undefined, vk);
    await mgr.playWithPet(cmdIx());
  });

  it('trainPet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK');
    const mgr = new PetsManager(petSupa(pet), undefined, vk);
    await mgr.trainPet(cmdIx());
  });

  it('renamePet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const mgr = new PetsManager(petSupa(pet));
    const ix = cmdIx({ options: { getString: vi.fn(() => 'NewName') }});
    await mgr.renamePet(ix);
  });

  it('prestigePet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const maxPet = { ...pet, level: 100 };
    const mgr = new PetsManager(petSupa(maxPet));
    await mgr.prestigePet(cmdIx());
  });
});

// ═══════════════════════════════════════════════
// EconomyManager — getShopItems, getLeaderboard, getInventory, deposit, withdraw
// ═══════════════════════════════════════════════
describe('EconomyManager shop/inventory/bank', () => {
  const ecoCfg = {
    economy_enabled: true, economy_deposit_fee_pct: 5,
    currency_name: 'coins', currency_emoji: '🪙',
    economy_bank_max: 50000,
  };

  function ecoSupa() {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(ecoCfg);
        if (table === 'economy_items') return chainAsync([
          { id: 'i1', name: 'Sword', description: 'Sharp', price: 100, emoji: '⚔️', category: 'weapons', buyable: true },
          { id: 'i2', name: 'Shield', description: 'Sturdy', price: 200, emoji: '🛡️', category: 'armor', buyable: true },
        ]);
        if (table === 'economy_wallets') {
          return chain({ wallet: 5000, bank: 1000, passive: false, daily_streak: 3, last_daily: null });
        }
        if (table === 'economy_inventory') {
          return chainAsync([
            { id: 'inv1', item_id: 'i1', quantity: 2, economy_items: { name: 'Sword', emoji: '⚔️', description: 'Sharp' } },
          ]);
        }
        if (table === 'economy_transactions') { const c = chain(null); c.insert = vi.fn(() => c); return c; }
        return chain(null);
      }),
      rpc: vi.fn(async (_name: string) => {
        if (_name === 'economy_leaderboard') return { data: [{ user_id: 'u1', wallet: 5000, bank: 1000 }], error: null };
        return { data: null, error: null };
      }),
    } as any;
  }

  it('getShopItems', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), ecoSupa(), valkey());
    const items = await mgr.getShopItems();
    expect(items).toBeDefined();
  });

  it('getLeaderboard', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), ecoSupa(), valkey());
    const result = await mgr.getLeaderboard();
    expect(result).toBeDefined();
  });

  it('getInventory', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), ecoSupa(), valkey());
    const result = await mgr.getInventory('u1');
    expect(result).toBeDefined();
  });

  it('deposit', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), ecoSupa(), valkey());
    const result = await mgr.deposit('u1', 1000);
    expect(result).toBeDefined();
  });

  it('withdraw', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), ecoSupa(), valkey());
    const result = await mgr.withdraw('u1', 500);
    expect(result).toBeDefined();
  });

  it('buyItem', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), ecoSupa(), valkey());
    const result = await mgr.buyItem('u1', 'Sword');
    expect(result).toBeDefined();
  });

it('pay', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), ecoSupa(), valkey());
    const result = await mgr.pay('u1', 'u2', 100, 'req-pay-1');
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// GiveawayManager deeper paths
// ═══════════════════════════════════════════════
describe('GiveawayManager deep', () => {
  const giveawayCfg = {
    economy_giveaways_enabled: true,
  };
  const giveaway = {
    id: 'gw1', guild_id: 'g1', channel_id: 'ch1', message_id: 'msg1',
    prize: 'Free Discord Nitro', winner_count: 1,
    entries: ['u1', 'u2', 'u3'], winners: [],
    created_by: 'u1', ends_at: new Date(Date.now() + 86400000).toISOString(),
    status: 'active', paused_at: null, paused_remaining_ms: null,
  };

  function giveawaySupa(gw: any = giveaway) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(giveawayCfg);
        if (table === 'giveaways') {
          const c = chain(gw);
          return c;
        }
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
  }

  it('endGiveaway picks winners', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const g = guild();
    const eb = { emit: vi.fn() } as any;
    const mgr = new GiveawayManager(g, giveawaySupa(), valkey(), eb);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    await (mgr as any).endGiveaway(giveaway);
    vi.restoreAllMocks();
  });

  it('endGiveaway no entries', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const g = guild();
    const eb = { emit: vi.fn() } as any;
    const noEntries = { ...giveaway, entries: [] };
    const mgr = new GiveawayManager(g, giveawaySupa(noEntries), valkey(), eb);
    await (mgr as any).endGiveaway(noEntries);
  });

  it('pauseGiveaway', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const g = guild();
    const eb = { emit: vi.fn() } as any;
    const mgr = new GiveawayManager(g, giveawaySupa(), valkey(), eb);
    const result = await mgr.pauseGiveaway('gw1');
    expect(result).toBeDefined();
  });

  it('resumeGiveaway', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const g = guild();
    const eb = { emit: vi.fn() } as any;
    const paused = { ...giveaway, status: 'paused', paused_at: new Date().toISOString(), paused_remaining_ms: 60000 };
    const mgr = new GiveawayManager(g, giveawaySupa(paused), valkey(), eb);
    const result = await mgr.resumeGiveaway('gw1');
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// GamesManager deeper: blackjack, slots, trivia
// ═══════════════════════════════════════════════
describe('GamesManager deeper games', () => {
  const gamesCfg = {
    economy_games_enabled: true,
    economy_blackjack_enabled: true,
    economy_slots_enabled: true,
    economy_trivia_enabled: true,
    economy_rps_enabled: true,
    economy_coinflip_enabled: true,
    economy_scratch_enabled: true,
    economy_guess_enabled: true,
    economy_highlow_enabled: true,
    economy_min_bet: 10,
    economy_max_bet: 10000,
    economy_coinflip_max_bet: 10000,
    economy_slots_max_bet: 10000,
    currency_name: 'coins', currency_emoji: '🪙',
  };

  function gamesSupa() {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(gamesCfg);
        if (table === 'economy_wallets') return chain({ wallet: 5000, bank: 0 });
        if (table === 'economy_transactions') { const c = chain(null); c.insert = vi.fn(() => c); return c; }
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
  }

  it('slots', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.001);
    const ix = cmdIx({ options: { getInteger: vi.fn(() => 100) }});
    await mgr.slots(ix, 100);
    expect(ix.reply).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('coinflip', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    const ix = cmdIx({ options: { getString: vi.fn(() => 'heads'), getInteger: vi.fn(() => 100) }});
    await mgr.coinflip(ix, 100);
    expect(ix.reply).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('rps', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.8);
    const ix = cmdIx({ options: { getString: vi.fn(() => 'rock'), getInteger: vi.fn(() => 100) }});
    await mgr.rps(ix, 100, 'rock');
    expect(ix.reply).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('scratch', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const ix = cmdIx({ options: { getInteger: vi.fn(() => 100) }});
    await mgr.scratch(ix, 100);
    expect(ix.reply).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('guess', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.49);
    const ix = cmdIx({ options: { getInteger: vi.fn((key: string) => key === 'guess' ? 5 : 100) }});
    await mgr.guess(ix, 100);
    expect(ix.reply).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
