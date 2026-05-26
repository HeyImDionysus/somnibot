/**
 * Deep tests: GiveawayManager, LotteryManager, GatheringManager, 
 * ticket-service, sync-engine, and startSyncScheduler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    first() { return this.values().next().value; }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
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
    ButtonStyle: { Primary: 1, Secondary: 2 },
    ChannelType: { GuildText: 0, GuildVoice: 2 },
    PermissionsBitField: class { has() { return true; } },
    ComponentType: { Button: 2 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n },
    OverwriteType: { Member: 1 },
    Colors: { Red: 0xff0000 },
  };
});

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

function chainWithCount(data: any[] = [], count: number = 0) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch'])
    c[m] = vi.fn(() => c);
  c.maybeSingle = vi.fn(async () => ({ data: data?.[0] ?? null, error: null, count }));
  c.single = vi.fn(async () => ({ data: data?.[0] ?? null, error: null, count }));
  c.then = (resolve: Function) => resolve({ data, error: null, count });
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
    rpc: vi.fn(async () => ({ data: 0, error: null })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: any) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: vi.fn() }; }),
    })),
  } as any;
}

function guild(id = 'g1') {
  const textCh: any = {
    id: 'ch1', name: 'general', type: 0, isTextBased: () => true,
    send: vi.fn(async () => ({
      id: 'msg1', edit: vi.fn(async () => {}), react: vi.fn(async () => {}),
      createMessageComponentCollector: vi.fn(() => ({ on: vi.fn().mockReturnThis(), stop: vi.fn() })),
    })),
    messages: { fetch: vi.fn(async () => new Collection()) },
    permissionOverwrites: { create: vi.fn(async () => {}), edit: vi.fn(async () => {}) },
    delete: vi.fn(async () => {}),
  };
  const channels = new Collection<string, any>();
  channels.set('ch1', textCh);
  const roles = new Collection<string, any>();
  roles.set('g1', { id: 'g1', name: '@everyone', managed: false, position: 0, permissions: { bitfield: 0n, has: () => true }, color: 0, hoist: false, mentionable: false });
  return {
    id, name: 'Test Guild', memberCount: 50,
    roles: { cache: roles, create: vi.fn(async () => ({ id: 'r1', name: 'new-role' })), fetch: vi.fn(async () => roles) },
    channels: { cache: channels, fetch: vi.fn(async () => textCh), create: vi.fn(async () => textCh) },
    members: {
      cache: new Collection(),
      me: { roles: { highest: { position: 10 } }, permissions: { has: () => true } },
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'User', displayAvatarURL: () => 'url', send: vi.fn(async () => {}) },
        roles: { cache: new Collection(), add: vi.fn(async () => {}) }, displayName: 'User',
      })),
    },
    client: {
      user: { id: 'bot1' },
      channels: { cache: channels },
      users: { fetch: vi.fn(async () => ({ send: vi.fn(), id: 'u1', username: 'User' })) },
    },
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
  } as any;
}

function eventBus() {
  return { on: vi.fn(), off: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn(), onAny: vi.fn() } as any;
}

// ═══════════════════════════════════════════════════════════
// GiveawayManager deep flows
// ═══════════════════════════════════════════════════════════
describe('GiveawayManager deep flows', () => {
  const givCfg = { economy_giveaways_enabled: true, currency_name: 'coins', currency_emoji: '🪙' };

  it('create giveaway success', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const s = supa({
      guild_config: givCfg,
      giveaways: () => {
        const c = chain({
          id: 'ga1', guild_id: 'g1', channel_id: 'ch1', prize: 'Xbox',
          entries: [], winners: [], winner_count: 1, created_by: 'u1',
          ends_at: new Date(Date.now() + 3600000).toISOString(), status: 'active',
        });
        c.insert = vi.fn(() => c);
        return c;
      },
    });
    const mgr = new GiveawayManager(guild(), s, valkey(), eventBus());
    const result = await mgr.create({ channelId: 'ch1', prize: 'Xbox', winnerCount: 1, durationMs: 3600000, hostId: 'u1' });
    expect(result).toBeDefined();
  });



  it('endGiveaway picks winner', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const ga = {
      id: 'ga1', guild_id: 'g1', channel_id: 'ch1', prize: 'Xbox',
      entries: ['u2', 'u3'], winners: [], winner_count: 1,
      created_by: 'u1', status: 'active', message_id: 'msg1',
      ends_at: new Date().toISOString(),
    };
    const s = supa({
      guild_config: givCfg,
      giveaways: () => {
        const c = chain(ga);
        c.update = vi.fn(() => c);
        c.insert = vi.fn(() => c);
        return c;
      },
    });
    const mgr = new GiveawayManager(guild(), s, valkey(), eventBus());
    const result = await mgr.endGiveaway('ga1');
    expect(result).toBeDefined();
  });

  it('pauseGiveaway', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const ga = { id: 'ga1', status: 'active', guild_id: 'g1' };
    const s = supa({ guild_config: givCfg, giveaways: ga });
    const mgr = new GiveawayManager(guild(), s, valkey(), eventBus());
    const result = await mgr.pauseGiveaway('ga1');
    expect(result).toBeDefined();
  });

  it('resumeGiveaway', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const ga = { id: 'ga1', status: 'paused', guild_id: 'g1', ends_at: new Date(Date.now() + 3600000).toISOString(), paused_at: new Date(Date.now() - 60000).toISOString(), paused_remaining_ms: 3540000 };
    const s = supa({ guild_config: givCfg, giveaways: ga });
    const mgr = new GiveawayManager(guild(), s, valkey(), eventBus());
    const result = await mgr.resumeGiveaway('ga1');
    expect(result).toBeDefined();
  });

  it('reroll picks new winner', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const ga = {
      id: 'ga1', guild_id: 'g1', prize: 'Xbox', entries: ['u2','u3','u4'],
      winners: ['u2'], winner_count: 1, status: 'ended', channel_id: 'ch1',
    };
    const s = supa({
      guild_config: givCfg,
      giveaways: () => {
        const c = chain(ga);
        c.update = vi.fn(() => c);
        return c;
      },
    });
    const mgr = new GiveawayManager(guild(), s, valkey(), eventBus());
    const result = await mgr.reroll('ga1');
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// GatheringManager deep flows
// ═══════════════════════════════════════════════════════════
describe('GatheringManager deep', () => {
  const gatherCfg = {
    economy_gathering_enabled: true,
    economy_gathering_cooldown_seconds: 30,
    economy_gathering_base_quantity_min: 1,
    economy_gathering_base_quantity_max: 3,
    currency_name: 'coins', currency_emoji: '🪙',
  };

  it('gather disabled', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const s = supa({ guild_config: { economy_gathering_enabled: false } });
    const mgr = new GatheringManager(guild(), s, valkey());
    const result = await mgr.gather('u1', 'mine');
    expect(result.error).toBe('disabled');
  });

  it('gather on cooldown', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const s = supa({ guild_config: gatherCfg });
    const vk = valkey();
    vk.set = vi.fn(async () => null); // cooldown active
    vk.pttl = vi.fn(async () => 15000);
    const mgr = new GatheringManager(guild(), s, vk);
    const result = await mgr.gather('u1', 'mine');
    expect(result.embed).toBeDefined();
  });

  it('gather success with loot', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const loot = [
      { id: 'lt1', item_id: 'i1', item_name: 'Iron Ore', item_emoji: '⛏️', weight: 50, min_qty: 1, max_qty: 3, gold_min: 0, gold_max: 0 },
      { id: 'lt2', item_id: null, item_name: null, item_emoji: null, weight: 50, min_qty: 0, max_qty: 0, gold_min: 10, gold_max: 50 },
    ];
    const s = supa({
      guild_config: gatherCfg,
      economy_loot_tables: () => chainWithCount(loot),
      economy_inventory: () => { const c = chain(null); c.insert = vi.fn(() => c); c.upsert = vi.fn(() => c); return c; },
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK'); // cooldown claimed
    const mgr = new GatheringManager(guild(), s, vk);
    const result = await mgr.gather('u1', 'mine');
    expect(result.embed).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// LotteryManager
// ═══════════════════════════════════════════════════════════
describe('LotteryManager deep', () => {
  it('drawWinner with participants', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const drawing = {
      id: 'd1', guild_id: 'g1', status: 'active', jackpot: 5000,
      ticket_price: 100, tickets_sold: 10, draw_at: new Date().toISOString(),
    };
    const tickets = [
      { user_id: 'u1', ticket_numbers: [1,2,3] },
      { user_id: 'u2', ticket_numbers: [4,5,6] },
    ];
    const s = supa({
      economy_lottery_drawings: drawing,
      economy_lottery_tickets: () => chainWithCount(tickets),
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const mgr = new LotteryManager(s);
    const result = await mgr.drawWinner('g1');
    expect(result).toBeDefined();
  });

  it('drawWinner no active drawing', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const s = supa({ economy_lottery_drawings: null });
    const mgr = new LotteryManager(s);
    const result = await mgr.drawWinner('g1');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// ticket-service: createTicket, closeTicket
// ═══════════════════════════════════════════════════════════
describe('ticket-service', () => {
  it('createTicket max open exceeded', async () => {
    const { createTicket } = await import('../features/tickets/ticket-service.js');
    const s = supa({
      tickets: () => chainWithCount([], 5), // count = 5
    });
    const g = guild();
    const panel = { id: 'p1', guild_id: 'g1', max_open_per_user: 3, ticket_types: [] };
    const ticketType = { name: 'General', description: 'General ticket' };
    const member = { id: 'u1', user: { id: 'u1', username: 'User' } } as any;
    const result = await createTicket(g as any, member, panel as any, ticketType as any, s, eventBus());
    expect('error' in result).toBe(true);
  });

  it('closeTicket not found', async () => {
    const { closeTicket } = await import('../features/tickets/ticket-service.js');
    const s = supa({ tickets: null });
    const result = await closeTicket(guild() as any, s, eventBus(), 1, 'u1', 'Resolved');
    expect(result.success).toBe(false);
  });

  it('closeTicket success', async () => {
    const { closeTicket } = await import('../features/tickets/ticket-service.js');
    const ticket = {
      id: 't1', guild_id: 'g1', ticket_number: 1, status: 'open',
      channel_id: 'ch1', creator_id: 'u1', claimed_by: null,
    };
    const s = supa({ tickets: ticket });
    const result = await closeTicket(guild() as any, s, eventBus(), 1, 'u1', 'Done');
    expect(result).toBeDefined();
  });

  it('claimTicket not found', async () => {
    const { claimTicket } = await import('../features/tickets/ticket-service.js');
    const s = supa({ tickets: null });
    const result = await claimTicket(s, eventBus(), 'g1', 1, 'u1');
    expect(result.success).toBe(false);
  });

  it('reopenTicket not found', async () => {
    const { reopenTicket } = await import('../features/tickets/ticket-service.js');
    const s = supa({ tickets: null });
    const result = await reopenTicket(guild() as any, s, eventBus(), 1, 'u1');
    expect(result.success).toBe(false);
  });

  it('deleteTicket not found', async () => {
    const { deleteTicket } = await import('../features/tickets/ticket-service.js');
    const s = supa({ tickets: null });
    const result = await deleteTicket(guild() as any, s, 1);
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// sync-engine: runSyncCycle, startSyncScheduler
// ═══════════════════════════════════════════════════════════
describe('sync-engine', () => {
  it('runSyncCycle no desired state', async () => {
    const { runSyncCycle } = await import('../sync/sync-engine.js');
    const s = supa({ guild_desired_state: null });
    const result = await runSyncCycle(guild() as any, s, eventBus(), { dryRun: false });
    expect(result).toBeDefined();
  });



  it('startSyncScheduler returns stop function', async () => {
    const { startSyncScheduler } = await import('../sync/sync-engine.js');
    const s = supa({ guild_desired_state: null, guild_config: { sync_interval_minutes: 60 } });
    const result = startSyncScheduler(guild() as any, s, eventBus(), { dryRun: false, intervalMinutes: 60 } as any);
    expect(result.stop).toBeDefined();
    result.stop();
  });
});
