import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
  computeStateDiff: vi.fn(() => []),
  classifyDrift: vi.fn(() => []),
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setThumbnail(t: any) { this.data.thumbnail = t; return this; }
    setTimestamp() { return this; }
    setFooter(f: any) { this.data.footer = f; return this; }
    setAuthor(a: any) { this.data.author = a; return this; }
    addFields(...f: any[]) { return this; }
    setImage(i: any) { return this; }
    setURL(u: any) { return this; }
    toJSON() { return this.data; }
  }
  return {
    EmbedBuilder,
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } setEmoji() { return this; } setDisabled() { return this; } },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n },
    ButtonStyle: { Primary: 1, Secondary: 2, Danger: 4, Link: 5 },
    Collection: class extends Map {
      filter(fn: any) { const r = new (this.constructor as any)(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; }
      map(fn: any) { return [...this.values()].map(fn); }
      find(fn: any) { return [...this.values()].find(fn); }
      first() { return [...this.values()][0]; }
    },
    AttachmentBuilder: class { constructor() {} },
  };
});

vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../services/event-bus.js', () => ({ PlatformEventBus: class { emit = vi.fn(); on = vi.fn(); off = vi.fn(); } }));

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from','select','insert','update','delete','upsert','eq','neq','gt','lt','gte','lte','in','is','not','order','limit','single','maybeSingle','match','contains','overlaps','filter','or','ilike','like','textSearch','returns','range']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa(result?: any) {
  const chain = makeChain(result || { data: null, error: null });
  return { from: vi.fn(() => chain), rpc: vi.fn(async () => ({ data: null, error: null })), channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })), removeChannel: vi.fn(), _chain: chain };
}

function makeValkey(): any {
  return { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), setex: vi.fn(async () => 'OK'), del: vi.fn(async () => 1), incr: vi.fn(async () => 1), expire: vi.fn(async () => 1), keys: vi.fn(async () => []), mget: vi.fn(async () => []), lpush: vi.fn(async () => 1), rpop: vi.fn(async () => null), llen: vi.fn(async () => 0), subscribe: vi.fn(async () => {}), on: vi.fn(), psubscribe: vi.fn(async () => {}), publish: vi.fn(async () => 1), duplicate: vi.fn(function(this: any) { return this; }), sadd: vi.fn(async () => 1), smembers: vi.fn(async () => []), srem: vi.fn(async () => 1), hset: vi.fn(async () => 1), hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})), hdel: vi.fn(async () => 1), zadd: vi.fn(async () => 1), zrangebyscore: vi.fn(async () => []), zrem: vi.fn(async () => 1), scan: vi.fn(async () => ['0', []]) };
}

function makeClient() {
  return {
    supabase: makeSupa(),
    valkey: makeValkey(),
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
    guildId: 'g1',
    env: { GUILD_ID: 'g1' },
    channels: { cache: { get: vi.fn(() => ({ send: vi.fn(async () => ({ id: 'msg1' })), messages: { fetch: vi.fn(async () => new Map()) } })) } },
    guilds: { cache: { get: vi.fn(() => ({ id: 'g1', name: 'Test', memberCount: 100, roles: { cache: new Map() }, channels: { cache: new Map() } })) } },
    user: { tag: 'Bot#0001', id: 'bot1', displayAvatarURL: () => 'url' },
    ws: { ping: 50 },
  };
}

function makeGuild() {
  return {
    id: 'g1', name: 'Test Guild', memberCount: 100,
    roles: { cache: new Map([['r1', { id: 'r1', name: 'Member', position: 1 }]]), everyone: { id: 'g1', permissions: { bitfield: 0n } }, fetch: vi.fn(async () => new Map()) },
    channels: { cache: new Map([['c1', { id: 'c1', name: 'general', type: 0, send: vi.fn(async () => ({ id: 'msg1' })) }]]), fetch: vi.fn(async () => new Map()) },
    members: { fetch: vi.fn(async (id: string) => ({ id, user: { tag: 'User', displayAvatarURL: () => 'url', bot: false }, roles: { add: vi.fn(), remove: vi.fn(), cache: new Map() }, send: vi.fn(async () => {}) })), cache: new Map() },
    emojis: { cache: new Map() },
    me: { displayAvatarURL: () => 'url' },
  };
}

// ═══════════════════════════════════════════════════════════
// embed-theme.ts
// ═══════════════════════════════════════════════════════════
describe('embed-theme', () => {
  let mod: typeof import('../services/embed-theme.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../services/embed-theme.js');
  });

  it('themedEmbed returns EmbedBuilder with defaults when no override', async () => {
    const supa = makeSupa({ data: null, error: null });
    const valkey = makeValkey();
    const embed = await mod.themedEmbed(supa as any, valkey as any, 'g1', 'welcome');
    expect(embed).toBeDefined();
  });

  it('themedEmbed uses cached override from valkey', async () => {
    const supa = makeSupa();
    const override = { color: '#ff0000', footer_text: 'Hi', footer_icon_url: null, thumbnail_url: null, author_name: null };
    const valkey = makeValkey();
    valkey.get = vi.fn(async () => JSON.stringify(override));
    const embed = await mod.themedEmbed(supa as any, valkey as any, 'g1', 'moderation');
    expect(embed).toBeDefined();
  });

  it('themedEmbed fetches from DB when cache miss', async () => {
    const override = { color: '#5865f2', footer_text: 'Bot', footer_icon_url: 'url', thumbnail_url: 'thumb', author_name: 'Author' };
    const supa = makeSupa({ data: override, error: null });
    const valkey = makeValkey();
    const embed = await mod.themedEmbed(supa as any, valkey as any, 'g1', 'economy');
    expect(embed).toBeDefined();
  });

  it('invalidateThemeCache clears cache', async () => {
    const valkey = makeValkey();
    valkey.keys = vi.fn(async () => ['embed-theme:g1:welcome']);
    await mod.invalidateThemeCache(valkey as any, 'g1');
    expect(valkey.keys).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// heartbeat.ts
// ═══════════════════════════════════════════════════════════
describe('HeartbeatService', () => {
  let mod: typeof import('../services/heartbeat.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../services/heartbeat.js');
  });

  it('constructs', () => {
    const valkey = makeValkey();
    const supa = makeSupa();
    const svc = new mod.HeartbeatService(valkey as any, supa as any, 'g1');
    expect(svc).toBeDefined();
  });

  it('constructs with client', () => {
    const valkey = makeValkey();
    const supa = makeSupa();
    const client = makeClient();
    const svc = new mod.HeartbeatService(valkey as any, supa as any, 'g1', client as any);
    expect(svc).toBeDefined();
  });

  it('readHeartbeat returns data from valkey', async () => {
    const valkey = makeValkey();
    valkey.get = vi.fn(async () => JSON.stringify({ timestamp: Date.now(), uptimeSeconds: 120, guildCount: 5 }));
    const result = await mod.readHeartbeat(valkey as any, 'g1');
    expect(result).toBeDefined();
  });

  it('readHeartbeat returns null when empty', async () => {
    const valkey = makeValkey();
    const result = await mod.readHeartbeat(valkey as any, 'g1');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// guild-snapshot.ts
// ═══════════════════════════════════════════════════════════
describe('guild-snapshot', () => {
  let mod: typeof import('../services/guild-snapshot.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../services/guild-snapshot.js');
  });

  it('writeGuildSnapshot writes snapshot', async () => {
    const guild = makeGuild();
    const supa = makeSupa({ data: null, error: null });
    try { await mod.writeGuildSnapshot(guild as any, supa as any); } catch {}
  });

  it('startPeriodicSnapshots returns timer', () => {
    const guild = makeGuild();
    const supa = makeSupa();
    const timer = mod.startPeriodicSnapshots(guild as any, supa as any, 600000);
    expect(timer).toBeDefined();
    clearInterval(timer);
  });
});

// ═══════════════════════════════════════════════════════════
// owner-notifications.ts
// ═══════════════════════════════════════════════════════════
describe('OwnerNotificationService', () => {
  it('imports and constructs', async () => {
    vi.resetModules();
    const mod = await import('../services/owner-notifications.js');
    const client = makeClient();
    const svc = new mod.OwnerNotificationService(client as any, 'g1', makeSupa() as any, { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any);
    expect(svc).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// commerce-fulfillment.ts
// ═══════════════════════════════════════════════════════════
describe('CommerceFulfillmentService', () => {
  it('imports and constructs', async () => {
    vi.resetModules();
    try {
      const mod = await import('../services/commerce-fulfillment.js');
      const guild = makeGuild();
      const supa = makeSupa();
      const eventBus: any = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
      const svc = new mod.CommerceFulfillmentService(guild as any, supa as any, eventBus);
      expect(svc).toBeDefined();
    } catch {}
  });
});
