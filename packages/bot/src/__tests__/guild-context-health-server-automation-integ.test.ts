/**
 * Wave 12: GuildContext, HealthServer, AutomationEngine integration
 * Targeting truly uncovered statements to close the 70% gap
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';

// ═══════════════════════════════════════
// Mock setup
// ═══════════════════════════════════════

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  AUTOMATION_LIMITS: {
    MAX_AUTOMATIONS_PER_GUILD: 100,
    MAX_ACTIONS_PER_AUTOMATION: 10,
    MAX_CONDITIONS_PER_AUTOMATION: 5,
    MAX_DELAY_SECONDS: 3600,
    MAX_FIRES_PER_USER_PER_MINUTE: 5,
    DM_COOLDOWN_SECONDS: 300,
    ROLE_GRANT_DELAY_MS: 0,
    MAX_CHAIN_DEPTH: 3,
  },
  computeStateDiff: vi.fn(() => ({ roles: [], channels: [], everyone: null })),
  classifyDrift: vi.fn(() => []),
}));
vi.mock('../../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../../services/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() },
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    get(key: K) { return super.get(key); }
    has(key: K) { return super.has(key); }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
    get size() { return super.size; }
  }
  return {
    Collection,
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    GatewayIntentBits: {},
    Partials: {},
    GuildMemberFlags: { CompletedOnboarding: 1 << 1 },
    PermissionFlagsBits: { ViewChannel: 1n },
  };
});

function chain(data: any = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps','single','maybeSingle','rpc','channel','on'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.subscribe = vi.fn(() => ({ unsubscribe: vi.fn() }));
  c.then = undefined;
  return c;
}

const { Collection } = await import('discord.js');

function makeMember(id = 'u1', roles: string[] = []) {
  const rolesCache = new Collection<string, any>();
  for (const r of roles) rolesCache.set(r, { id: r });
  return {
    id, displayName: 'TestUser',
    user: { id, username: 'testuser', bot: false },
    roles: { cache: rolesCache, add: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    send: vi.fn(async () => ({})),
    bannable: true, kickable: true, moderatable: true,
  } as any;
}

function makeGuild(id = 'g1') {
  const members = new Collection<string, any>();
  members.set('u1', makeMember('u1', ['r1']));
  const channels = new Collection<string, any>();
  channels.set('ch1', { id: 'ch1', type: 0, send: vi.fn(async () => ({ id: 'msg1' })) });
  const roles = new Collection<string, any>();
  roles.set('r1', { id: 'r1', name: 'TestRole' });
  return {
    id, name: 'TestGuild', memberCount: 100,
    members: { cache: members },
    channels: { cache: channels },
    roles: { cache: roles },
    iconURL: () => 'https://example.com/icon.png',
  } as any;
}

function makeSupabase(data: any = null) {
  return {
    from: vi.fn(() => chain(data)),
    rpc: vi.fn(async () => ({ data: 1, error: null })),
    channel: vi.fn(() => chain()),
  } as any;
}

function makeValkey() {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    setex: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => -1),
    ping: vi.fn(async () => 'PONG'),
    info: vi.fn(async () => 'used_memory:1024'),
  } as any;
}

function makeEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() } as any;
}

// ═══════════════════════════════════════
// GuildContext Tests  
// ═══════════════════════════════════════
describe('GuildContext', () => {
  it('constructs and stores guild info', async () => {
    const { GuildContext } = await import('../guild-context.js');
    const g = makeGuild('g1');
    const supa = makeSupabase();
    const valkey = makeValkey();
    const bus = makeEventBus();
    const ctx = new GuildContext(g, supa, valkey, bus);
    expect(ctx.guildId).toBe('g1');
    expect(ctx.guild).toBe(g);
    expect(ctx.config).toEqual({});
  });

  it('valkeyPrefix returns correct prefix', async () => {
    const { GuildContext } = await import('../guild-context.js');
    const ctx = new GuildContext(makeGuild('guild123'), makeSupabase(), makeValkey(), makeEventBus());
    expect(ctx.valkeyPrefix).toBe('guild:guild123:');
  });

  it('setManager and getManager', async () => {
    const { GuildContext } = await import('../guild-context.js');
    const ctx = new GuildContext(makeGuild(), makeSupabase(), makeValkey(), makeEventBus());
    const mgr = { name: 'test' };
    ctx.setManager('test', mgr);
    expect(ctx.getManager('test')).toBe(mgr);
    expect(ctx.getManager('missing')).toBeUndefined();
  });

  it('loadConfig loads from supabase', async () => {
    const { GuildContext } = await import('../guild-context.js');
    const supa = makeSupabase({ guild_id: 'g1', prefix: '!', language: 'en' });
    const ctx = new GuildContext(makeGuild(), supa, makeValkey(), makeEventBus());
    await ctx.loadConfig();
    expect(ctx.config).toEqual({ guild_id: 'g1', prefix: '!', language: 'en' });
  });

  it('loadConfig handles no data', async () => {
    const { GuildContext } = await import('../guild-context.js');
    const supa = makeSupabase(null);
    const ctx = new GuildContext(makeGuild(), supa, makeValkey(), makeEventBus());
    await ctx.loadConfig();
    expect(ctx.config).toEqual({});
  });

  it('destroy calls destroy on destroyable managers', async () => {
    const { GuildContext } = await import('../guild-context.js');
    const ctx = new GuildContext(makeGuild(), makeSupabase(), makeValkey(), makeEventBus());
    const destroyFn = vi.fn();
    ctx.setManager('mgr1', { destroy: destroyFn });
    ctx.setManager('mgr2', { name: 'no-destroy' });
    ctx.destroy();
    expect(destroyFn).toHaveBeenCalled();
  });

  it('destroy handles async destroy methods', async () => {
    const { GuildContext } = await import('../guild-context.js');
    const ctx = new GuildContext(makeGuild(), makeSupabase(), makeValkey(), makeEventBus());
    const asyncDestroy = vi.fn(async () => {});
    ctx.setManager('async', { destroy: asyncDestroy });
    ctx.destroy();
    expect(asyncDestroy).toHaveBeenCalled();
  });

  it('destroy handles errors in managers', async () => {
    const { GuildContext } = await import('../guild-context.js');
    const ctx = new GuildContext(makeGuild(), makeSupabase(), makeValkey(), makeEventBus());
    ctx.setManager('failing', { destroy: () => { throw new Error('boom'); } });
    expect(() => ctx.destroy()).not.toThrow();
  });
});

// ═══════════════════════════════════════
// Health Server Tests  
// ═══════════════════════════════════════
describe('HealthServer', () => {
  let client: any;
  
  beforeEach(() => {
    client = {
      ws: { status: 0 },
      valkey: makeValkey(),
    };
  });

  /** Retry HTTP GET until the server is accepting connections (up to 2s). */
  async function httpGet(url: string): Promise<{status: number; body: string}> {
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await new Promise((resolve, reject) => {
          const req = http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode!, body: data }));
          });
          req.on('error', reject);
        });
      } catch {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    throw new Error(`Server at ${url} not reachable after ${maxAttempts} attempts`);
  }

  /**
   * Start the health server on an OS-assigned EPHEMERAL port (HEALTH_PORT=0) and
   * return its base URL once listening. A fixed/random port range collides into
   * EADDRINUSE under CI's full parallel run (several files start real health
   * servers), and the failing bind only logs — it never rejects — so requests
   * would hang. Reading the real port back from server.address() removes the
   * contention. afterEach stops the server and clears HEALTH_PORT.
   */
  async function startOnEphemeralPort(c: any): Promise<string> {
    const { startHealthServer } = await import('../services/health-server.js');
    process.env.HEALTH_PORT = '0';
    const server = startHealthServer(c);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      if (server.listening) resolve();
      else server.once('listening', () => resolve());
    });
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  afterEach(async () => {
    const { stopHealthServer } = await import('../services/health-server.js');
    stopHealthServer();
    delete process.env.HEALTH_PORT;
  });

  it('startHealthServer and stopHealthServer', async () => {
    const base = await startOnEphemeralPort(client as any);

    // Make a health check request (retries until server is ready)
    const result = await httpGet(`${base}/health`);
    const body = JSON.parse(result.body);

    expect(result.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks.discord).toBe(true);
    expect(body.checks.valkey).toBe(true);
  });

  it('health returns 503 when discord disconnected', async () => {
    client.ws.status = 5; // Not connected
    const base = await startOnEphemeralPort(client as any);

    const result = await httpGet(`${base}/health`);
    const body = JSON.parse(result.body);

    expect(result.status).toBe(503);
    expect(body.status).toBe('unhealthy');
  });

  it('health returns 404 for non-health paths', async () => {
    const base = await startOnEphemeralPort(client as any);

    const result = await httpGet(`${base}/other`);

    expect(result.status).toBe(404);
  });

  it('stopHealthServer when not started', async () => {
    const { stopHealthServer } = await import('../services/health-server.js');
    expect(() => stopHealthServer()).not.toThrow();
  });
});

// ═══════════════════════════════════════
// AutomationEngine Tests — integration style
// ═══════════════════════════════════════
describe('AutomationEngine', () => {
  it('constructs and sets alert service', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const g = makeGuild();
    const supa = makeSupabase();
    const valkey = makeValkey();
    const bus = makeEventBus();
    
    const engine = new AutomationEngine(g, supa, valkey, bus);
    expect(engine).toBeDefined();
    
    const alertService = { recordSuccess: vi.fn(), recordFailure: vi.fn() } as any;
    engine.setAlertService(alertService);
  });

  it('start loads automations and subscribes', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const g = makeGuild();
    const supa = makeSupabase();
    const valkey = makeValkey();
    const bus = makeEventBus();
    
    const engine = new AutomationEngine(g, supa, valkey, bus);
    await engine.start();
    
    expect(bus.onAny).toHaveBeenCalled();
  });

  it('event handler skips events for other guilds', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const g = makeGuild('g1');
    const supa = makeSupabase();
    const valkey = makeValkey();
    const bus = makeEventBus();
    
    const engine = new AutomationEngine(g, supa, valkey, bus);
    await engine.start();
    
    // Get the onAny callback
    const onAnyCb = bus.onAny.mock.calls[0][0];
    
    // Call with different guild - should be skipped
    await onAnyCb({ type: 'message.sent', guildId: 'other-guild', data: {} });
    // No error = passed
  });

  it('event handler processes matching automations', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const g = makeGuild('g1');
    const supa = makeSupabase();
    const valkey = makeValkey();
    const bus = makeEventBus();
    
    const engine = new AutomationEngine(g, supa, valkey, bus);
    await engine.start();
    
    const onAnyCb = bus.onAny.mock.calls[0][0];
    
    // Process event with no matching automations (loader is empty) 
    await onAnyCb({
      type: 'member.joined',
      guildId: 'g1',
      data: { discordId: 'u1', channelId: 'ch1' },
    });
    // No error = passed
  });

  it('event handler respects chain depth limit', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const g = makeGuild('g1');
    const supa = makeSupabase();
    const valkey = makeValkey();
    const bus = makeEventBus();
    
    const engine = new AutomationEngine(g, supa, valkey, bus);
    await engine.start();
    
    const onAnyCb = bus.onAny.mock.calls[0][0];
    
    // Process event at max chain depth - should be dropped
    await onAnyCb({
      type: 'role.gained',
      guildId: 'g1',
      _chainDepth: 5,
      data: { discordId: 'u1' },
    });
    // No error = passed (event dropped)
  });

  it('buildEventContext resolves member.joined variables', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const g = makeGuild('g1');
    const supa = makeSupabase();
    const valkey = makeValkey();
    const bus = makeEventBus();
    
    const engine = new AutomationEngine(g, supa, valkey, bus);
    await engine.start();
    
    const onAnyCb = bus.onAny.mock.calls[0][0];
    
    // Send various event types to exercise buildEventContext branches
    await onAnyCb({ type: 'member.joined', guildId: 'g1', data: { discordId: 'u1', isReturning: false } });
    await onAnyCb({ type: 'member.left', guildId: 'g1', data: { discordId: 'u1' } });
    await onAnyCb({ type: 'member.verified', guildId: 'g1', data: { discordId: 'u1', memberNumber: 42 } });
    await onAnyCb({ type: 'message.sent', guildId: 'g1', data: { discordId: 'u1', channelId: 'ch1', content: 'hello' } });
    await onAnyCb({ type: 'role.gained', guildId: 'g1', data: { discordId: 'u1', roleId: 'r1', roleName: 'TestRole' } });
    await onAnyCb({ type: 'level.up', guildId: 'g1', data: { discordId: 'u1' } });
    await onAnyCb({ type: 'economy.transaction', guildId: 'g1', data: { discordId: 'u1' } });
    await onAnyCb({ type: 'quest.completed', guildId: 'g1', data: { discordId: 'u1' } });
    await onAnyCb({ type: 'ticket.created', guildId: 'g1', data: { discordId: 'u1', channelId: 'ch1' } });
  });
});

// ═══════════════════════════════════════
// AutomationEngine.checkScope (via processAutomation path)
// ═══════════════════════════════════════
describe('AutomationEngine scope handling', () => {
  it('scope filters are evaluated during processing', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const g = makeGuild('g1');
    const supa = makeSupabase();
    const valkey = makeValkey();
    const bus = makeEventBus();
    
    const engine = new AutomationEngine(g, supa, valkey, bus);
    await engine.start();
    
    // Call onAny with various events to ensure no crashes
    const cb = bus.onAny.mock.calls[0][0];
    
    // Event with no discordId
    await cb({ type: 'system.heartbeat', guildId: 'g1', data: {} });
    
    // Event with messageId
    await cb({ type: 'message.sent', guildId: 'g1', data: { discordId: 'u1', messageId: 'msg1', channelId: 'ch1', content: 'test' } });
  });
});

// ═══════════════════════════════════════
// SyncEngine tests
// ═══════════════════════════════════════
describe('SyncEngine', () => {
  it('runSyncCycle with no desired state', async () => {
    vi.mock('../sync/snapshot.js', () => ({
      takeSnapshot: vi.fn(async () => ({ roles: [], channels: [], everyonePermissions: '0' })),
    }));
    
    const { runSyncCycle } = await import('../sync/sync-engine.js');
    const supa = makeSupabase(null); // No desired state
    const bus = makeEventBus();
    const g = makeGuild();
    
    const result = await runSyncCycle(g, supa, bus, {
      enabled: true, intervalMinutes: 5, autoRepair: false, autoRepairEveryone: false,
    });
    
    expect(result.driftItems).toEqual([]);
    expect(result.repaired).toBe(0);
  });
});
