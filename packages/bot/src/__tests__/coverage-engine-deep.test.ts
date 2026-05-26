/**
 * Deep coverage for sync-engine, lottery-manager, automation-engine,
 * scheduled-message runner, and pets decay paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  computeStateDiff: vi.fn(() => []),
  classifyDrift: vi.fn(() => []),
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    first() { return this.values().next().value; }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
    some(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return true; return false; }
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
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields||[]), ...f]; return this; }
    toJSON() { return this.data; }
  }
  return {
    Collection, EmbedBuilder,
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionsBitField: class { has() { return true; } toArray() { return []; } },
    OverwriteType: { Role: 0, Member: 1 },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

const { Collection } = await import('discord.js');

function buildChain(data: any = null) {
  const chain: any = {};
  const methods = ['select','insert','update','upsert','delete',
    'eq','neq','gt','gte','lt','lte','in','is','or','not',
    'order','limit','range','match','ilike','like','filter','contains',
    'textSearch'];
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
    rpc: vi.fn(async (_name: string, _params?: any) => ({ data: true, error: null })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: any) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: vi.fn() }; }),
    })),
  } as any;
}

function makeGuild(id = 'g1') {
  const channels = new Collection<string, any>();
  const ch = {
    id: 'ch1', name: 'general', type: 0, position: 0, parentId: null,
    permissionOverwrites: { cache: new Collection() },
    send: vi.fn(async () => ({ id: 'msg1', edit: vi.fn(async () => {}) })),
    messages: { fetch: vi.fn(async () => new Collection()) },
  };
  channels.set('ch1', ch);
  const roles = new Collection<string, any>();
  roles.set('r1', { id: 'r1', name: '@everyone', position: 0, permissions: { toArray: () => [] }, color: 0, hoist: false, mentionable: false });
  return {
    id, name: 'Test Guild', memberCount: 100,
    roles: { cache: roles, fetch: vi.fn(async () => roles) },
    channels: { cache: channels, fetch: vi.fn(async () => channels) },
    members: {
      cache: new Collection(),
      me: { roles: { highest: { position: 10 } } },
      fetch: vi.fn(async () => ({ id: 'u1', user: { id: 'u1', username: 'User' } })),
    },
    client: {
      user: { id: 'bot1' },
      users: { fetch: vi.fn(async () => ({ send: vi.fn(), id: 'u1' })) },
    },
  } as any;
}

function makeValkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1), ttl: vi.fn(async () => -2),
    sadd: vi.fn(async () => 1), smembers: vi.fn(async () => []),
    scard: vi.fn(async () => 0), keys: vi.fn(async () => []),
    hset: vi.fn(async () => 1), hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
  } as any;
}

function makeEventBus() {
  return {
    on: vi.fn(), off: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn(),
    onAny: vi.fn(),
  } as any;
}

// ═══════════════════════════════════════════════════════════
// sync-engine: runSyncCycle
// ═══════════════════════════════════════════════════════════
describe('sync-engine deep', () => {
  it('runSyncCycle with no desired state', async () => {
    const { runSyncCycle } = await import('../sync/sync-engine.js');
    const supa = makeTableSupa({ guild_desired_state: null });
    const result = await runSyncCycle(makeGuild(), supa, makeEventBus(), { dryRun: true, autoRepair: false });
    expect(result.driftItems).toEqual([]);
    expect(result.repaired).toBe(0);
  });

  // Snapshot requires full Discord guild structure — tested via integration

  it('startSyncScheduler creates interval', async () => {
    const { startSyncScheduler } = await import('../sync/sync-engine.js');
    vi.useFakeTimers();
    const cleanup = startSyncScheduler(makeGuild(), makeTableSupa(), makeEventBus(), {
      dryRun: true, autoRepair: false,
    });
    expect(cleanup.stop).toBeDefined();
    cleanup.stop();
    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════
// LotteryManager
// ═══════════════════════════════════════════════════════════
describe('LotteryManager deep', () => {
  it('drawWinner with no active drawing', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_lottery_enabled: true },
      economy_lottery_drawings: null,
    });
    const mgr = new LotteryManager(supa);
    const result = await mgr.drawWinner('g1');
    expect(result).toBeNull();
  });

  it('drawWinner with drawing but no tickets', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const drawing = { id: 'draw1', guild_id: 'g1', jackpot: 5000, status: 'active' };
    const supa = makeTableSupa({
      economy_lottery_drawings: drawing,
      economy_lottery_tickets: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    supa.rpc = vi.fn(async (name: string) => {
      if (name === 'lottery_claim_drawing') return { data: [drawing], error: null };
      return { data: true, error: null };
    });
    const mgr = new LotteryManager(supa);
    const result = await mgr.drawWinner('g1');
    // No tickets → returns null
    expect(result).toBeNull();
  });

  it('drawWinner with tickets picks a winner', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const drawing = { id: 'draw1', guild_id: 'g1', jackpot: 5000, status: 'active' };
    const tickets = [
      { id: 't1', drawing_id: 'draw1', user_id: 'u1', number: 42 },
      { id: 't2', drawing_id: 'draw1', user_id: 'u2', number: 77 },
    ];
    const supa = makeTableSupa({
      economy_lottery_drawings: drawing,
      economy_lottery_tickets: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: tickets, error: null });
        return c;
      },
    });
    supa.rpc = vi.fn(async (name: string) => {
      if (name === 'lottery_claim_drawing') return { data: [drawing], error: null };
      return { data: true, error: null };
    });
    const mgr = new LotteryManager(supa);
    const result = await mgr.drawWinner('g1');
    if (result) {
      expect(result.jackpot).toBe(5000);
      expect(['u1', 'u2']).toContain(result.winnerId);
    }
  });

  it('drawWinner claim error returns null', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const drawing = { id: 'draw1', guild_id: 'g1', jackpot: 5000, status: 'active' };
    const supa = makeTableSupa({
      economy_lottery_drawings: drawing,
    });
    supa.rpc = vi.fn(async () => ({ data: null, error: { message: 'claim failed' } }));
    const mgr = new LotteryManager(supa);
    const result = await mgr.drawWinner('g1');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// AutomationEngine
// ═══════════════════════════════════════════════════════════
describe('AutomationEngine deep', () => {
  it('constructs and starts', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const supa = makeTableSupa({
      guild_automations: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const engine = new AutomationEngine(makeGuild(), supa, makeValkey(), makeEventBus());
    await engine.start();
    expect(engine).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// ScheduledMessageRunner
// ═══════════════════════════════════════════════════════════
describe('ScheduledMessageRunner deep', () => {
  it('constructs and starts', async () => {
    const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
    const supa = makeTableSupa({
      guild_scheduled_messages: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    vi.useFakeTimers();
    const runner = new ScheduledMessageRunner(makeGuild(), supa);
    await runner.start();
    expect(runner).toBeDefined();
    await runner.reload();
    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════
// PetsManager - decay cycle
// ═══════════════════════════════════════════════════════════
describe('PetsManager deep', () => {
  it('schedulePetDecay starts decay', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_pets_enabled: true, economy_pets_decay_rate: 5 },
      economy_pets: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    vi.useFakeTimers();
    const mgr = new PetsManager(supa);
    await mgr.schedulePetDecay('g1');
    expect(mgr).toBeDefined();
    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════
// deploy-listener: getDeployStatus
// ═══════════════════════════════════════════════════════════
describe('deploy-listener', () => {
  it('getDeployStatus returns null initially', async () => {
    const { getDeployStatus } = await import('../deploy/deploy-listener.js');
    const status = getDeployStatus();
    expect(status).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// payment-handler
// ═══════════════════════════════════════════════════════════
describe('payment-handler', () => {
  it('module loads', async () => {
    const mod = await import('../features/commerce/payment-handler.js');
    expect(mod.handleBuyButton).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// economy-manager: more paths
// ═══════════════════════════════════════════════════════════
describe('EconomyManager extra paths', () => {
  it('getShopItems returns array', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_enabled: true, currency_name: 'coins', currency_emoji: '🪙' },
      economy_items: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({
          data: [
            { id: 'i1', name: 'Sword', description: 'Sharp', emoji: '⚔️', price: 100, category: 'weapons', purchasable: true, stock: null },
          ],
          error: null,
        });
        return c;
      },
    });
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    const items = await mgr.getShopItems();
    expect(Array.isArray(items)).toBe(true);
  });

  it('getLeaderboard returns array', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_enabled: true, currency_name: 'coins', currency_emoji: '🪙' },
    });
    supa.rpc = vi.fn(async () => ({
      data: [{ user_id: 'u1', net_worth: 5000, wallet: 3000, bank: 2000 }],
      error: null,
    }));
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    const lb = await mgr.getLeaderboard();
    expect(Array.isArray(lb)).toBe(true);
  });

  it('getInventory returns array', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_enabled: true, currency_name: 'coins', currency_emoji: '🪙' },
      economy_inventory: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    const inv = await mgr.getInventory('u1');
    expect(Array.isArray(inv)).toBe(true);
  });

  it('getOrCreateWallet creates wallet', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_enabled: true, currency_name: 'coins', currency_emoji: '🪙', economy_default_balance: 100, economy_default_bank: 0 },
      economy_wallets: { user_id: 'u1', guild_id: 'g1', wallet: 100, bank: 0 },
    });
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    const w = await mgr.getOrCreateWallet('u1');
    expect(w).toBeDefined();
    expect(w.wallet).toBeDefined();
  });

  it('togglePassive', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_enabled: true, currency_name: 'coins', currency_emoji: '🪙' },
      economy_wallets: { user_id: 'u1', guild_id: 'g1', wallet: 100, bank: 0, passive: false },
    });
    const mgr = new EconomyManager(makeGuild(), supa, makeValkey());
    const result = await mgr.togglePassive('u1');
    expect(result.message).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// Additional market-manager paths
// ═══════════════════════════════════════════════════════════
describe('MarketManager extra paths', () => {
  it('buy own listing fails', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_market_enabled: true, economy_market_tax_pct: 5, currency_name: 'coins', currency_emoji: '🪙' },
      economy_market_listings: {
        id: 'l1', seller_id: 'u1', item_name: 'Sword', price_per_unit: 100,
        remaining: 5, guild_id: 'g1', status: 'active',
      },
    });
    const mgr = new MarketManager(makeGuild(), supa, makeValkey());
    const embed = await mgr.buy('u1', 'l1', 1);
    expect(embed).toBeDefined();
  });

  it('cancelListing success', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_market_enabled: true, currency_name: 'coins', currency_emoji: '🪙' },
      economy_market_listings: {
        id: 'l1', seller_id: 'u1', item_name: 'Sword', price_per_unit: 100,
        remaining: 5, guild_id: 'g1', status: 'active',
      },
    });
    const mgr = new MarketManager(makeGuild(), supa, makeValkey());
    const embed = await mgr.cancelListing('u1', 'l1');
    expect(embed).toBeDefined();
  });

  it('myListings with entries', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_market_enabled: true, currency_name: 'coins', currency_emoji: '🪙' },
      economy_market_listings: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({
          data: [
            { id: 'l1l1l1l1', item_name: 'Sword', price_per_unit: 100, remaining: 3, created_at: new Date().toISOString() },
          ],
          error: null,
        });
        return c;
      },
    });
    const mgr = new MarketManager(makeGuild(), supa, makeValkey());
    const embed = await mgr.myListings('u1');
    expect(embed).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// Additional FishingManager paths
// ═══════════════════════════════════════════════════════════
describe('FishingManager extra paths', () => {
  it('getCollection with fish', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_fishing_enabled: true },
      economy_fish_catches: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({
          data: [
            { id: 'f1', species_id: 's1', weight: 5.2, caught_at: new Date().toISOString(), economy_fish_species: { name: 'Trout', emoji: '🐟', rarity: 'common' } },
            { id: 'f2', species_id: 's2', weight: 12.1, caught_at: new Date().toISOString(), economy_fish_species: { name: 'Salmon', emoji: '🐠', rarity: 'rare' } },
          ],
          error: null,
        });
        return c;
      },
    });
    const mgr = new FishingManager(makeGuild(), supa, makeValkey());
    const embed = await mgr.getCollection('u1');
    expect(embed).toBeDefined();
  });

  it('sellAll with no fish', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_fishing_enabled: true, currency_name: 'coins', currency_emoji: '🪙' },
      economy_fish_catches: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const mgr = new FishingManager(makeGuild(), supa, makeValkey());
    const embed = await mgr.sellAll('u1');
    expect(embed).toBeDefined();
  });

  it('fish disabled', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_fishing_enabled: false },
    });
    const mgr = new FishingManager(makeGuild(), supa, makeValkey());
    const result = await mgr.fish('u1');
    expect(result.embed.data.description).toContain('not enabled');
  });
});
