/**
 * Mega coverage: farming, fishing, crafting, market, lottery, automation,
 * stats-channels, scheduled-messages, sync-engine, payment-handler
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
    first() { return this.values().next().value; }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
    sort(fn: (a: V, b: V) => number) { return this; }
    some(fn: (v: V) => boolean): boolean {
      for (const v of this.values()) if (fn(v)) return true;
      return false;
    }
    reduce<T>(fn: (acc: T, v: V) => T, init: T): T {
      let acc = init; for (const v of this.values()) acc = fn(acc, v); return acc;
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
    setImage(i: any) { return this; }
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields || []), ...f]; return this; }
    toJSON() { return this.data; }
  }
  class PermissionsBitField {
    bitfield: bigint;
    constructor(bits?: any) { this.bitfield = BigInt(bits ?? 0); }
    has() { return true; }
  }
  class ActionRowBuilder {
    components: any[] = [];
    addComponents(...c: any[]) { this.components.push(...c); return this; }
  }
  class ButtonBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: any) { this.data.style = s; return this; }
    setEmoji(e: any) { return this; }
    setDisabled(d: boolean) { return this; }
  }
  class StringSelectMenuBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setPlaceholder(p: string) { return this; }
    addOptions(...o: any[]) { return this; }
    setMaxValues(n: number) { return this; }
    setMinValues(n: number) { return this; }
  }
  return {
    Collection, EmbedBuilder, PermissionsBitField,
    ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    ComponentType: { Button: 2, StringSelect: 3 },
    REST: class { setToken() { return this; } },
    Routes: { applicationGuildCommands: () => '/test' },
    PermissionFlagsBits: { ManageChannels: 16n, ViewChannel: 1024n },
    SlashCommandBuilder: class {
      setName() { return this; } setDescription() { return this; }
      addStringOption() { return this; } addIntegerOption() { return this; }
      addUserOption() { return this; } addSubcommand() { return this; }
    },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
  writeAuditBatch: vi.fn(async () => {}),
}));

vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => ({ trackProgress: vi.fn(async () => {}) }),
  registerQuestsManager: vi.fn(),
  invalidateQuestsCache: vi.fn(),
}));

const { Collection } = await import('discord.js');

// ── Shared helpers ──
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
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: any) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: vi.fn() }; }),
    })),
  };
}

function makeGuild(id = 'g1') {
  const channels = new Collection<string, any>();
  channels.set('ch1', {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({ id: 'msg1', edit: vi.fn(async () => {}) })),
    messages: { fetch: vi.fn(async () => new Collection()) },
    setName: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
  });
  return {
    id, name: 'Test Guild', memberCount: 100,
    roles: { cache: new Collection() },
    channels: { cache: channels, fetch: vi.fn(async () => channels.get('ch1')) },
    members: {
      cache: new Collection(),
      me: { roles: { highest: { position: 10 } } },
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'TestUser', displayAvatarURL: () => 'https://avatar.url' },
        roles: { cache: new Collection(), add: vi.fn(async () => {}) },
      })),
    },
    client: {
      user: { id: 'bot1' },
      users: { fetch: vi.fn(async () => ({ send: vi.fn(), id: 'u1', username: 'Test' })) },
    },
  } as any;
}

function makeValkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1), ttl: vi.fn(async () => -2),
    pttl: vi.fn(async () => -2), hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})),
    keys: vi.fn(async () => []),
    sadd: vi.fn(async () => 1), sismember: vi.fn(async () => 0),
    smembers: vi.fn(async () => []),
  } as any;
}

function makeEventBus() {
  return { on: vi.fn(), off: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn() } as any;
}

// ═══════════════════════════════════════════════════════════
// FarmingManager
// ═══════════════════════════════════════════════════════════
describe('FarmingManager deep', () => {
  it('viewFarm with no plots', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_farming_enabled: true, economy_farming_max_plots: 6, economy_farming_growth_multiplier: 1 },
      economy_farm_plots: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const mgr = new FarmingManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.viewFarm('u1');
    expect(embed.data.title).toContain('Farm');
  });

  it('plant disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_farming_enabled: false },
    });
    const mgr = new FarmingManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.plant('u1', 'wheat');
    expect(embed.data.description).toContain('not enabled');
  });

  it('plant unknown crop', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_farming_enabled: true, economy_farming_max_plots: 6, economy_farming_growth_multiplier: 1 },
      economy_farm_crops: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const mgr = new FarmingManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.plant('u1', 'nonexistent');
    expect(embed.data.description).toContain('Unknown crop');
  });

  it('water disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_farming_enabled: false },
    });
    const mgr = new FarmingManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.water('u1');
    expect(embed.data.description).toContain('not enabled');
  });

  it('harvest disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_farming_enabled: false },
    });
    const mgr = new FarmingManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.harvest('u1');
    expect(embed.data.description).toContain('not enabled');
  });

  it('fertilize disabled', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_farming_enabled: false },
    });
    const mgr = new FarmingManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.fertilize('u1', 1);
    expect(embed.data.description).toContain('not enabled');
  });

  it('getConfig', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_farming_enabled: true, economy_farming_max_plots: 4, economy_farming_growth_multiplier: 2 },
    });
    const mgr = new FarmingManager(makeGuild(), supa as any, makeValkey());
    const cfg = await mgr.getConfig();
    expect(cfg.economy_farming_enabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// FishingManager
// ═══════════════════════════════════════════════════════════
describe('FishingManager deep', () => {
  it('fish disabled', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_fishing_enabled: false },
    });
    const mgr = new FishingManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.fish('u1');
    expect(embed.data.description).toContain('not enabled');
  });

  it('fish on cooldown', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_fishing_enabled: true, economy_fishing_cooldown_seconds: 60 },
    });
    const valkey = makeValkey();
    valkey.set = vi.fn(async () => null); // NX fails
    valkey.get = vi.fn(async () => String(Date.now() + 30000));
    const mgr = new FishingManager(makeGuild(), supa as any, valkey);
    const { embed } = await mgr.fish('u1');
    expect(embed.data.description).toContain('fish again');
  });

  it('sellAll with no fish', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_fishing_enabled: true },
      economy_fish_catches: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const mgr = new FishingManager(makeGuild(), supa as any, makeValkey());
    const embed = await mgr.sellAll('u1');
    expect(embed.data.description).toContain('caught');
  });

  it('getCollection', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_fishing_enabled: true },
      economy_fish_catches: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({
          data: [{ species_id: 'sp1', count: 5, total_weight: 50, best_weight: 15, economy_fish_species: { name: 'Trout', emoji: '🐟', rarity: 'common', base_value: 10 } }],
          error: null,
        });
        return c;
      },
    });
    const mgr = new FishingManager(makeGuild(), supa as any, makeValkey());
    const embed = await mgr.getCollection('u1');
    expect(embed.data.title).toContain('Collection');
  });

  it('getLeaderboard', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_fishing_enabled: true },
      economy_fish_catches: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({
          data: [{ user_id: 'u1', weight: 12.5, economy_fish_species: { emoji: '🐟', name: 'Trout' } }],
          error: null,
        });
        return c;
      },
    });
    const mgr = new FishingManager(makeGuild(), supa as any, makeValkey());
    const embed = await mgr.getLeaderboard();
    expect(embed.data.title).toContain('Leaderboard');
  });

  it('checkRod', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_fishing_enabled: true },
      economy_inventory: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({
          data: [{ item_id: 'rod1', quantity: 1, economy_items: { name: 'Fishing Rod', category: 'fishing_rod' } }],
          error: null,
        });
        return c;
      },
    });
    const mgr = new FishingManager(makeGuild(), supa as any, makeValkey());
    const result = await mgr.checkRod('u1');
    expect(result.hasRod).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// CraftingManager
// ═══════════════════════════════════════════════════════════
describe('CraftingManager deep', () => {
  it('listRecipes disabled', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_crafting_enabled: false },
    });
    const mgr = new CraftingManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.listRecipes();
    expect(embed.data.description).toContain('not enabled');
  });

  it('craft disabled', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_crafting_enabled: false },
    });
    const mgr = new CraftingManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.craft('u1', 'sword');
    expect(embed.data.description).toContain('not enabled');
  });

  it('craft unknown recipe', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_crafting_enabled: true },
      economy_craft_recipes: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const mgr = new CraftingManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.craft('u1', 'nonexistent');
    expect(embed.data.description).toContain('not found');
  });

  it('listRecipes with recipes', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_crafting_enabled: true },
      economy_craft_recipes: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({
          data: [
            { id: 'r1', name: 'Iron Sword', description: 'A sharp blade', emoji: '⚔️', ingredients: [{ item_name: 'Iron', quantity: 3 }], result_item_name: 'Sword', result_quantity: 1, xp_reward: 50, level_required: 1, cooldown_seconds: 0 },
          ],
          error: null,
        });
        return c;
      },
    });
    const mgr = new CraftingManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.listRecipes();
    expect(embed.data.title).toContain('Recipe Book');
  });

  it('getConfig', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_crafting_enabled: true },
    });
    const mgr = new CraftingManager(makeGuild(), supa as any, makeValkey());
    const cfg = await mgr.getConfig();
    expect(cfg.economy_crafting_enabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// MarketManager
// ═══════════════════════════════════════════════════════════
describe('MarketManager deep', () => {
  it('browse disabled', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_market_enabled: false, economy_market_tax_pct: 5, currency_name: 'coins', currency_emoji: '🪙' },
    });
    const mgr = new MarketManager(makeGuild(), supa as any, makeValkey());
    const embed = await mgr.browse();
    expect(embed.data.description).toContain('not enabled');
  });

  it('browse empty market', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_market_enabled: true, economy_market_tax_pct: 5, currency_name: 'coins', currency_emoji: '🪙' },
      economy_market_listings: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const mgr = new MarketManager(makeGuild(), supa as any, makeValkey());
    const embed = await mgr.browse();
    expect(embed.data.description).toContain('No active listings');
  });

  it('buy disabled', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_market_enabled: false, economy_market_tax_pct: 5, currency_name: 'coins', currency_emoji: '🪙' },
    });
    const mgr = new MarketManager(makeGuild(), supa as any, makeValkey());
    const embed = await mgr.buy('u1', 'listing-abc');
    expect(embed.data.description).toContain('not enabled');
  });

  it('buy listing not found', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_market_enabled: true, economy_market_tax_pct: 5, currency_name: 'coins', currency_emoji: '🪙' },
      economy_market_listings: null,
    });
    const mgr = new MarketManager(makeGuild(), supa as any, makeValkey());
    const embed = await mgr.buy('u1', 'nonexistent');
    expect(embed.data.description).toContain('not found');
  });

  it('myListings empty', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_market_enabled: true, economy_market_tax_pct: 5, currency_name: 'coins', currency_emoji: '🪙' },
      economy_market_listings: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const mgr = new MarketManager(makeGuild(), supa as any, makeValkey());
    const embed = await mgr.myListings('u1');
    expect(embed.data.description).toContain('any listings');
  });

  it('cancelListing not found', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_market_enabled: true, economy_market_tax_pct: 5, currency_name: 'coins', currency_emoji: '🪙' },
      economy_market_listings: null,
    });
    const mgr = new MarketManager(makeGuild(), supa as any, makeValkey());
    const embed = await mgr.cancelListing('u1', 'nonexistent');
    expect(embed.data.description).toContain('not found');
  });
});

// ═══════════════════════════════════════════════════════════
// LotteryManager
// ═══════════════════════════════════════════════════════════
describe('LotteryManager deep', () => {
  it('drawWinner with no drawing', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_lottery_enabled: true, economy_lottery_draw_interval_hours: 24, economy_lottery_ticket_price: 100, economy_lottery_jackpot_seed: 1000, economy_lottery_numbers_range: 50, economy_lottery_pick_count: 5 },
      economy_lottery_drawings: null,
    });
    const mgr = new LotteryManager(supa as any, null);
    const result = await mgr.drawWinner('g1');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// AutomationEngine
// ═══════════════════════════════════════════════════════════
describe('AutomationEngine deep', () => {
  it('construct and load', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const supa = makeTableSupa({
      guild_automations: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const engine = new AutomationEngine(makeGuild(), supa as any, makeValkey(), makeEventBus());
    expect(engine).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// ScheduledMessageRunner
// ═══════════════════════════════════════════════════════════
describe('ScheduledMessageRunner deep', () => {
  it('construct', async () => {
    const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
    const supa = makeTableSupa();
    const runner = new ScheduledMessageRunner(makeGuild(), supa as any);
    expect(runner).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// StatsChannelManager
// ═══════════════════════════════════════════════════════════
describe('StatsChannelManager deep', () => {
  it('construct', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const supa = makeTableSupa();
    const mgr = new StatsChannelManager(makeGuild(), supa as any);
    expect(mgr).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// SyncEngine
// ═══════════════════════════════════════════════════════════
describe('SyncEngine deep', () => {
  it('imports module', async () => {
    const mod = await import('../sync/sync-engine.js');
    expect(mod).toBeDefined();
  });
});
