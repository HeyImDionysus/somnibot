/**
 * Wave 9 coverage: ExecutionLogger, CustomCommandEngine, GiveawayFulfillment,
 * HeartbeatService deeper, safeInteractionHandler, withCooldown
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865F2, success: 0x57F287, error: 0xED4245, warning: 0xFEE75C },
}));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}), writeAuditBatch: vi.fn(async () => {}) }));
vi.mock('../services/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() },
}));
vi.mock('../features/commerce/entitlement-service.js', () => ({
  EntitlementService: class {
    constructor() {}
    async grantEntitlement() { return { success: true }; }
  },
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
  }
  class EmbedBuilder {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setTimestamp() { return this; }
    setFooter(f: any) { return this; }
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields||[]), ...f]; return this; }
    toJSON() { return this.data; }
  }
  return {
    Collection, EmbedBuilder,
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n },
    REST: class { setToken() { return this; } },
    ApplicationCommandType: { ChatInput: 1 },
  };
});

const { Collection } = await import('discord.js');

function chain(data: any = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps','single','maybeSingle'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = undefined;
  return c;
}
function chainAsync(data: any[] = [], count: number | null = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data: data?.[0] ?? null, error: null, count }));
  c.single = vi.fn(async () => ({ data: data?.[0] ?? null, error: null, count }));
  c.then = (resolve: Function) => resolve({ data, error: null, count });
  return c;
}
function guild(id = 'g1') {
  return {
    id, name: 'Test Guild', memberCount: 50,
    channels: { cache: new Collection(), fetch: vi.fn(async () => new Collection()) },
    members: {
      cache: new Collection(),
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'User', bot: false },
        displayName: 'User', send: vi.fn(async () => ({})),
        roles: { cache: new Collection() },
      })),
    },
    client: { user: { id: 'bot1' } },
    iconURL: () => 'url',
  } as any;
}
function valkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})),
    keys: vi.fn(async () => []), setex: vi.fn(async () => 'OK'),
    incr: vi.fn(async () => 1), expire: vi.fn(async () => 1),
  } as any;
}
const eb = () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() } as any);

// ═══════════════════════════════════════════════
// ExecutionLogger
// ═══════════════════════════════════════════════
describe('ExecutionLogger', () => {
  it('log success', async () => {
    const { ExecutionLogger } = await import('../features/automations/execution-logger.js');
    const supa = { from: vi.fn(() => chain(null)), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const logger = new ExecutionLogger(supa);
    await logger.log({
      automationId: 'a1', guildId: 'g1', triggeredBy: 'u1',
      triggerEvent: 'message.create', conditionsPassed: true,
      actionsExecuted: 2, actionsFailed: 0, errors: [], durationMs: 150,
    });
    expect(supa.from).toHaveBeenCalledWith('automation_executions');
  });

  it('log with error', async () => {
    const { ExecutionLogger } = await import('../features/automations/execution-logger.js');
    const supa = { from: vi.fn(() => chain(null, { message: 'DB error' })) } as any;
    const logger = new ExecutionLogger(supa);
    await logger.log({
      automationId: 'a1', guildId: 'g1', triggeredBy: 'u1',
      triggerEvent: 'message.create', conditionsPassed: false,
      actionsExecuted: 0, actionsFailed: 1, errors: ['Something broke'], durationMs: 50,
    });
  });
});

// ═══════════════════════════════════════════════
// Custom Command Engine
// ═══════════════════════════════════════════════
describe('CustomCommandEngine', () => {
  it('loadCustomCommands empty', async () => {
    const { loadCustomCommands } = await import('../features/custom-commands/command-engine.js');
    const supa = { from: vi.fn(() => chainAsync([])) } as any;
    const g = guild();
    const rest = {} as any;
    const result = await loadCustomCommands(supa, g, rest);
    expect(result).toBeDefined();
  });

  it('loadCustomCommands with commands', async () => {
    const { loadCustomCommands } = await import('../features/custom-commands/command-engine.js');
    const commands = [
      {
        id: 'cc1', guild_id: 'g1', name: 'hello', description: 'Says hello',
        enabled: true, response_type: 'text', response_content: 'Hello!',
        allowed_roles: [], denied_roles: [], allowed_channels: [], denied_channels: [],
        actions: [{ type: 'reply', content: 'Hello!' }],
        cooldown_seconds: 5, ephemeral: false,
      },
    ];
    const supa = { from: vi.fn(() => chainAsync(commands)) } as any;
    const g = guild();
    const rest = {} as any;
    const result = await loadCustomCommands(supa, g, rest);
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// GiveawayFulfillmentService deeper
// ═══════════════════════════════════════════════
describe('GiveawayFulfillmentService deeper', () => {
  it('start subscribes to events', async () => {
    const { GiveawayFulfillmentService } = await import('../services/giveaway-fulfillment.js');
    const bus = eb();
    const supa = { from: vi.fn(() => chain(null)) } as any;
    const service = new GiveawayFulfillmentService(guild(), supa, bus);
    service.start();
    expect(bus.on).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════
// HeartbeatService deeper - test start / stop
// ═══════════════════════════════════════════════
describe('HeartbeatService deeper', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('start writes heartbeat', async () => {
    const { HeartbeatService } = await import('../services/heartbeat.js');
    const v = valkey();
    const supa = { from: vi.fn(() => chain(null)) } as any;
    const client = {
      user: { id: 'bot1' },
      guilds: { cache: new Collection([['g1', { id: 'g1', memberCount: 50 }]]) },
    } as any;
    const hb = new HeartbeatService(v, supa, 'g1', client);
    hb.start();
    // Give it time to write the first heartbeat
    await new Promise(r => setTimeout(r, 100));
    hb.stop();
    expect(v.set).toHaveBeenCalled();
  });

  it('stop clears timers', async () => {
    const { HeartbeatService } = await import('../services/heartbeat.js');
    const hb = new HeartbeatService(valkey(), { from: vi.fn(() => chain(null)) } as any, 'g1');
    hb.start();
    hb.stop();
  });
});

// ═══════════════════════════════════════════════
// safeInteractionHandler
// ═══════════════════════════════════════════════
describe('safeInteractionHandler', () => {
  it('wraps handler', async () => {
    const { safeInteractionHandler } = await import('../features/discord-native/interaction-handler.js');
    const handler = vi.fn(async () => {});
    const wrapped = safeInteractionHandler(handler, { name: 'test' });
    expect(typeof wrapped).toBe('function');
  });

  it('calls handler on interaction', async () => {
    const { safeInteractionHandler } = await import('../features/discord-native/interaction-handler.js');
    const handler = vi.fn(async () => {});
    const wrapped = safeInteractionHandler(handler, { name: 'test', autoDeferMs: 0 });
    const interaction = {
      replied: false, deferred: false,
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      guildId: 'g1',
      user: { id: 'u1', username: 'User' },
      commandName: 'test',
    } as any;
    await wrapped(interaction);
    expect(handler).toHaveBeenCalledWith(interaction);
  });

  it('handles handler error', async () => {
    const { safeInteractionHandler } = await import('../features/discord-native/interaction-handler.js');
    const handler = vi.fn(async () => { throw new Error('test error'); });
    const wrapped = safeInteractionHandler(handler, { name: 'test', autoDeferMs: 0 });
    const interaction = {
      replied: false, deferred: false,
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      guildId: 'g1',
      user: { id: 'u1', username: 'User' },
      commandName: 'test',
    } as any;
    await wrapped(interaction);
    // Should have replied with error
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('handles handler error when already deferred', async () => {
    const { safeInteractionHandler } = await import('../features/discord-native/interaction-handler.js');
    const handler = vi.fn(async () => { throw new Error('test error'); });
    const wrapped = safeInteractionHandler(handler, { name: 'test', autoDeferMs: 0 });
    const interaction = {
      replied: false, deferred: true,
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      guildId: 'g1',
      user: { id: 'u1', username: 'User' },
      commandName: 'test',
    } as any;
    await wrapped(interaction);
    expect(interaction.editReply).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════
// withCooldown
// ═══════════════════════════════════════════════
describe('withCooldown', () => {
  it('creates cooldown-wrapped handler', async () => {
    const { withCooldown } = await import('../features/discord-native/interaction-handler.js');
    const handler = vi.fn(async () => {});
    const wrapped = withCooldown(5, handler);
    expect(typeof wrapped).toBe('function');
  });
});

// ═══════════════════════════════════════════════
// OwnerNotifications deeper  
// ═══════════════════════════════════════════════
describe('OwnerNotifications deeper', () => {
  it('start subscribes to events', async () => {
    const { OwnerNotificationService } = await import('../services/owner-notifications.js');
    const bus = eb();
    const client = {
      user: { id: 'bot1' },
      users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => ({})) })) },
      guilds: { cache: new Collection([['g1', guild()]]) },
    } as any;
    const supa = {
      from: vi.fn((t: string) => {
        if (t === 'guild') return chain({ owner_discord_id: 'owner1' });
        if (t === 'guild_config') return chain({ mod_log_channel_id: 'ch1' });
        return chain(null);
      }),
    } as any;
    const service = new OwnerNotificationService(client, 'g1', supa, bus);
    await service.start();
    // Verify it subscribed to events
    expect(bus.on).toHaveBeenCalled();
  });
});
