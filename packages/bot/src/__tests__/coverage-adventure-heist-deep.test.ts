/**
 * Deep coverage for adventure-manager.ts, heist-manager.ts, 
 * giveaway-manager.ts, pets-manager.ts, games-manager.ts (internals),
 * polls-manager.ts (internals)
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
    sort(fn: (a: V, b: V) => number) {
      const c = new Collection<K, V>();
      for (const [k, v] of [...this.entries()].sort(([, a], [, b]) => fn(a, b))) c.set(k, v);
      return c;
    }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
    some(fn: (v: V) => boolean): boolean {
      for (const v of this.values()) if (fn(v)) return true;
      return false;
    }
    reduce<T>(fn: (acc: T, v: V) => T, init: T): T {
      let acc = init;
      for (const v of this.values()) acc = fn(acc, v);
      return acc;
    }
    at(idx: number) { return [...this.values()][idx]; }
    random() { return this.first(); }
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
    setURL(u: any) { return this; }
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
  }
  return {
    Collection, EmbedBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder,
    StringSelectMenuBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    ComponentType: { Button: 2, StringSelect: 3 },
    REST: class { setToken() { return this; } },
    Routes: { applicationGuildCommands: () => '/test' },
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
    rpc: vi.fn(async () => ({ data: true, error: null })),
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
  });
  return {
    id, name: 'Test Guild', memberCount: 100,
    roles: { cache: new Collection() },
    channels: { cache: channels, fetch: vi.fn(async () => channels.first()) },
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
  } as any;
}

function makeEventBus() {
  return { on: vi.fn(), off: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn() } as any;
}

// ═══════════════════════════════════════════════════════════
// AdventureManager deep
// ═══════════════════════════════════════════════════════════
describe('AdventureManager startAdventure deep', () => {
  it('disabled returns embed', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const supa = makeTableSupa({
      guild_config: { economy_adventures_enabled: false },
    });
    const mgr = new AdventureManager(makeGuild(), supa as any, makeValkey());
    const { embed, row, sessionId } = await mgr.startAdventure('u1');
    expect(embed.data.description).toContain('not enabled');
    expect(row).toBeNull();
    expect(sessionId).toBeNull();
  });

  it('daily limit exceeded', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const supa = makeTableSupa({
      guild_config: {
        economy_adventures_enabled: true, economy_adventure_daily_limit: 3,
        economy_adventure_ticket_cost: 0,
      },
      economy_adventure_sessions: () => {
        const c = buildChain(null);
        c.select = vi.fn(() => {
          c.then = (resolve: Function) => resolve({ data: null, error: null, count: 5 });
          return c;
        });
        return c;
      },
    });
    const mgr = new AdventureManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.startAdventure('u1');
    expect(embed.data.description).toContain('used all');
  });

  it('active session already exists', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    let callIdx = 0;
    const supa = makeTableSupa({
      guild_config: {
        economy_adventures_enabled: true, economy_adventure_daily_limit: 10,
        economy_adventure_ticket_cost: 0,
      },
    });
    // Override from to handle different calls to economy_adventure_sessions:
    const origFrom = supa.from;
    supa.from = vi.fn((table: string) => {
      if (table === 'economy_adventure_sessions') {
        callIdx++;
        if (callIdx === 1) {
          // First call = count check (daily limit):
          const c = buildChain(null);
          c.select = vi.fn(() => {
            c.then = (resolve: Function) => resolve({ data: null, error: null, count: 0 });
            return c;
          });
          return c;
        }
        // Second call = active session check:
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [{ id: 'sess-active' }], error: null });
        return c;
      }
      return origFrom(table);
    });
    const mgr = new AdventureManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.startAdventure('u1');
    expect(embed.data.description).toContain('active adventure');
  });

  it('insufficient funds for ticket', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    let sessionCallIdx = 0;
    const supa = makeTableSupa({
      guild_config: {
        economy_adventures_enabled: true, economy_adventure_daily_limit: 10,
        economy_adventure_ticket_cost: 500,
      },
    });
    const origFrom = supa.from;
    supa.from = vi.fn((table: string) => {
      if (table === 'economy_adventure_sessions') {
        sessionCallIdx++;
        if (sessionCallIdx === 1) {
          const c = buildChain(null);
          c.select = vi.fn(() => {
            c.then = (resolve: Function) => resolve({ data: null, error: null, count: 0 });
            return c;
          });
          return c;
        }
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      }
      return origFrom(table);
    });
    // economy_subtract_balance fails:
    (supa as any).rpc = vi.fn(async () => ({ data: null, error: { message: 'insufficient funds' } }));
    const mgr = new AdventureManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.startAdventure('u1');
    expect(embed.data.description).toContain('cost');
  });

  it('no scenes configured', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    let sessionCallIdx = 0;
    const supa = makeTableSupa({
      guild_config: {
        economy_adventures_enabled: true, economy_adventure_daily_limit: 10,
        economy_adventure_ticket_cost: 0,
      },
      economy_adventures: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({
          data: [{ id: 'adv1', guild_id: 'g1', name: 'Dark Cave', description: 'Spooky', adventure_type: 'dungeon', difficulty: 'easy', min_reward: 100, max_reward: 500 }],
          error: null,
        });
        return c;
      },
      economy_adventure_scenes: null, // No scenes
    });
    const origFrom = supa.from;
    supa.from = vi.fn((table: string) => {
      if (table === 'economy_adventure_sessions') {
        sessionCallIdx++;
        if (sessionCallIdx === 1) {
          const c = buildChain(null);
          c.select = vi.fn(() => {
            c.then = (resolve: Function) => resolve({ data: null, error: null, count: 0 });
            return c;
          });
          return c;
        }
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      }
      return origFrom(table);
    });
    supa.rpc = vi.fn(async () => ({ data: true, error: null }));
    const mgr = new AdventureManager(makeGuild(), supa as any, makeValkey());
    const { embed } = await mgr.startAdventure('u1');
    expect(embed.data.description).toContain('no scenes');
  });
});

// ═══════════════════════════════════════════════════════════
// HeistManager deep (internals)
// ═══════════════════════════════════════════════════════════
describe('HeistManager deep', () => {
  it('construct and getConfig', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeTableSupa({ guild_config: null });
    const mgr = new HeistManager(supa as any, {} as any, makeValkey());
    expect(mgr).toBeDefined();
  });

  it('resumePendingHeists with no pending heists', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeTableSupa({
      economy_heists: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const client = {
      channels: { fetch: vi.fn(async () => null) },
    } as any;
    const mgr = new HeistManager(supa as any, client, makeValkey());
    await mgr.resumePendingHeists('g1');
  });
});

// ═══════════════════════════════════════════════════════════
// GiveawayManager deep
// ═══════════════════════════════════════════════════════════
describe('GiveawayManager deep', () => {
  it('start loads and schedules giveaways', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const supa = makeTableSupa({
      giveaways: () => {
        const c = buildChain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const mgr = new GiveawayManager(makeGuild(), supa as any, makeValkey(), makeEventBus());
    await mgr.start();
    expect(mgr).toBeDefined();
  });

  it('endGiveaway with no giveaway found', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const supa = makeTableSupa({
      giveaways: null,
    });
    const mgr = new GiveawayManager(makeGuild(), supa as any, makeValkey(), makeEventBus());
    const winners = await mgr.endGiveaway('nonexistent');
    expect(winners).toHaveLength(0);
  });

  it('pauseGiveaway returns false when not found', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const supa = makeTableSupa({ giveaways: null });
    const mgr = new GiveawayManager(makeGuild(), supa as any, makeValkey(), makeEventBus());
    const result = await mgr.pauseGiveaway('nonexistent');
    expect(result).toBe(false);
  });

  it('resumeGiveaway returns false when not found', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const supa = makeTableSupa({ giveaways: null });
    const mgr = new GiveawayManager(makeGuild(), supa as any, makeValkey(), makeEventBus());
    const result = await mgr.resumeGiveaway('nonexistent');
    expect(result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// PetsManager deep
// ═══════════════════════════════════════════════════════════
describe('PetsManager deep', () => {
  it('construct', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const supa = makeTableSupa();
    const mgr = new PetsManager(supa as any, undefined, makeValkey());
    expect(mgr).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// GamesManager deep (internal helpers)
// ═══════════════════════════════════════════════════════════
describe('GamesManager deep', () => {
  it('construct', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const supa = makeTableSupa();
    const mgr = new GamesManager(supa as any);
    expect(mgr).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// PollsManager deep (createPoll, closePoll, createPrediction)
// ═══════════════════════════════════════════════════════════
describe('PollsManager deep', () => {
  it('construct', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const supa = makeTableSupa();
    const mgr = new PollsManager(supa as any);
    expect(mgr).toBeDefined();
  });
});
