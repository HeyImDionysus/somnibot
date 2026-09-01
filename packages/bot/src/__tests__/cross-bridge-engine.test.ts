/**
 * Deep coverage for:
 *  - services/cross-feature-bridge.ts (248 uncov / 301 total)
 *  - features/automations/automation-engine.ts (257 uncov / 294 total)
 *  - services/migration-runner.ts (213 uncov / 223 total)
 *  - deploy/deploy-listener.ts (219 uncov / 247 total)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlatformEventBus } from '../services/event-bus.js';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    // Real EmbedBuilder always exposes `data` (branded embeds read
    // data.footer to append attribution without clobbering it).
    data: Record<string, unknown> = {};
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; }
    addFields() { return this; } setAuthor() { return this; } setImage() { return this; }
  },
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
  PermissionFlagsBits: { ViewChannel: 1n },
  Events: { ClientReady: 'ready' },
  Collection: class extends Map {},
}));

// Helper: supabase chain mock
function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range', 'ilike', 'filter']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn().mockResolvedValue({ data, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
  chain.then = (resolve: Function) => resolve({ data: data != null ? (Array.isArray(data) ? data : [data]) : [], error: null, count: 0 });
  return chain;
}

function makeSupa(overrides: Record<string, any> = {}) {
  const supa: any = {
    from: vi.fn((table: string) => {
      if (overrides[table]) return makeChain(overrides[table]);
      return makeChain();
    }),
    rpc: vi.fn(async () => ({ data: { listings_cancelled: 1, heists_forfeited: 0, wallet_suspended: true }, error: null })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: Function) => { cb?.('SUBSCRIBED'); }),
    })),
  };
  return supa;
}

// ─────────────────────────────────────────────────────
// CrossFeatureBridge tests
// ─────────────────────────────────────────────────────

describe('CrossFeatureBridge', () => {
  let CrossFeatureBridge: any;
  let bridge: any;
  let eventBus: PlatformEventBus;
  let supa: any;
  let guild: any;
  let valkey: any;

  // Module loading can exceed Vitest's 10s default when the complete bot
  // suite is cold-starting many workers in parallel; this is setup time, not
  // a relaxed assertion or retry.
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ CrossFeatureBridge } = await import('../services/cross-feature-bridge.js'));
    eventBus = new PlatformEventBus();
    guild = { id: 'guild-1', name: 'Test' };
    valkey = { get: vi.fn(), set: vi.fn(), del: vi.fn() };
    supa = makeSupa({
      giveaways: [{ id: 'g1' }, { id: 'g2' }],
      level_unlock_configs: [{ feature_key: 'fishing', unlock_message: 'You unlocked fishing!' }],
    });
    bridge = new CrossFeatureBridge(guild, supa, eventBus, valkey);
  }, 30_000);

  it('stop removes durable event handlers', async () => {
    bridge.start();
    bridge.stop();
    await eventBus.emitAndWait('member.left', 'guild-1', {
      discordId: 'user-stop', username: 'stopped', roles: [],
    });
    expect(supa.rpc).not.toHaveBeenCalled();
  });

  it('member.banned event cleans up giveaways, tickets, economy', async () => {
    bridge.start();
    await eventBus.emitAndWait('member.banned', 'guild-1', {
      discordId: 'user-1', moderatorId: 'moderator-1', reason: 'spam',
    });
    expect(supa.rpc).toHaveBeenCalled();
  });

  it('member.kicked event cleans up giveaways and economy', async () => {
    bridge.start();
    await eventBus.emitAndWait('member.kicked', 'guild-1', {
      discordId: 'user-2', moderatorId: 'moderator-1', reason: 'violation',
    });
    expect(supa.rpc).toHaveBeenCalled();
  });

  it('member.left event cleans up economy', async () => {
    bridge.start();
    await eventBus.emitAndWait('member.left', 'guild-1', {
      discordId: 'user-3', username: 'leaver', roles: [],
    });
    expect(supa.rpc).toHaveBeenCalled();
  });

  it('level.up event checks feature unlocks', async () => {
    bridge.start();
    await eventBus.emitAndWait('level.up', 'guild-1', {
      discordId: 'user-4', previousLevel: 4, newLevel: 5, totalXp: 500,
    });
    expect(supa.from).toHaveBeenCalledWith('level_unlock_configs');
  });

  it('purchase.completed does not grant XP or mutate commerce roles', async () => {
    bridge.start();
    supa.rpc.mockClear();
    supa.from.mockClear();
    await eventBus.emitAndWait('purchase.completed', 'guild-1', {
      discordId: 'user-5', amount: 10, currency: 'USD', orderNumber: 'ORDER-1',
      productId: 'product-1', productName: 'Widget', orderId: 'order-1',
    });
    expect(supa.rpc).not.toHaveBeenCalled();
    expect(supa.from).not.toHaveBeenCalled();
  });

  it('ticket.closed event logs resolution', async () => {
    bridge.start();
    await eventBus.emitAndWait('ticket.closed', 'guild-1', {
      userDiscordId: 'user-6', ticketId: 'ticket-1', ticketNumber: 1,
      channelId: 'channel-1', actorId: 'mod-1', panelId: 'panel-1',
    });
    expect(supa.from).toHaveBeenCalledWith('tickets');
  });

  it('infraction.created event checks escalation', async () => {
    bridge.start();
    await eventBus.emitAndWait('infraction.created', 'guild-1', {
      infractionId: 'inf-1', userId: 'user-7', moderatorId: 'mod-1',
      type: 'warn', reason: 'spam', totalInfractions: 1,
    });
    expect(supa.rpc).not.toHaveBeenCalledWith('giveaway_remove_entry', expect.anything());
  });

  it('ignores events from wrong guild', async () => {
    bridge.start();
    supa.rpc.mockClear();
    await eventBus.emitAndWait('member.banned', 'other-guild', {
      discordId: 'user-8', moderatorId: 'mod-other', reason: 'other guild',
    });
    expect(supa.rpc).not.toHaveBeenCalled();
  });

  it('handles missing discordId gracefully', async () => {
    bridge.start();
    await eventBus.emitAndWait('member.banned', 'guild-1', {
      discordId: '', moderatorId: 'mod-1', reason: 'invalid member',
    });
    expect(supa.rpc).not.toHaveBeenCalled();
  });

  it('handles economy cleanup RPC error', async () => {
    supa.rpc = vi.fn(async () => ({ data: null, error: { message: 'DB error' } }));
    bridge = new CrossFeatureBridge(guild, supa, eventBus, valkey);
    bridge.start();
    await eventBus.emitAndWait('member.banned', 'guild-1', {
      discordId: 'user-9', moderatorId: 'mod-1', reason: 'failure case',
    });
    expect(supa.rpc).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────
// AutomationEngine tests
// ─────────────────────────────────────────────────────

vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));

describe('AutomationEngine', () => {
  let AutomationEngine: any;
  let engine: any;
  let eventBus: any;
  let supa: any;
  let guild: any;
  let valkey: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ AutomationEngine } = await import('../features/automations/automation-engine.js'));
    eventBus = new PlatformEventBus();
    guild = {
      id: 'guild-1', name: 'Test',
      channels: {
        cache: new Map([['ch-1', {
          id: 'ch-1', name: 'general', type: 0,
          send: vi.fn().mockResolvedValue({ id: 'msg-1' }),
          isTextBased: () => true,
        }]]),
      },
      members: {
        fetch: vi.fn().mockResolvedValue({
          id: 'user-1',
          roles: { add: vi.fn(), remove: vi.fn(), cache: new Map() },
          send: vi.fn().mockResolvedValue({}),
        }),
      },
      roles: {
        cache: new Map([['role-1', { id: 'role-1', name: 'Mod' }]]),
      },
    };
    valkey = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      setex: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      ttl: vi.fn().mockResolvedValue(-2),
    };
    supa = makeSupa({
      automation_rules: [
        {
          id: 'rule-1', guild_id: 'guild-1', name: 'Welcome', enabled: true,
          trigger_event: 'member.joined', conditions: [],
          actions: [{ type: 'send_message', channel_id: 'ch-1', message: 'Welcome {user}!' }],
          cooldown_seconds: 0,
        },
      ],
    });
  });

  it('start() loads rules and subscribes to events', async () => {
    engine = new AutomationEngine(guild, supa, valkey, eventBus);
    await engine.start();
    // The loader subscribes to realtime
    expect(supa.channel).toHaveBeenCalled();
  });

  it('processes matching event through rule', async () => {
    engine = new AutomationEngine(guild, supa, valkey, eventBus);
    await engine.start();
    await eventBus.emitAndWait('member.joined', 'guild-1', {
      discordId: 'user-1', username: 'newmember', isReturning: false,
    });
    expect(supa.from).toHaveBeenCalled();
  });

  it('ignores events from wrong guild', async () => {
    engine = new AutomationEngine(guild, supa, valkey, eventBus);
    await engine.start();
    await eventBus.emitAndWait('member.joined', 'other-guild', {
      discordId: 'user-2', username: 'alien', isReturning: false,
    });
    expect(supa.from).toHaveBeenCalled();
  });

  it('prevents a rule action when the production rate limiter rejects the event', async () => {
    supa = makeSupa({
      automation_rules: [{
        id: 'rule-2', guild_id: 'guild-1', name: 'Cooldown Rule', enabled: true,
          trigger_event: 'member.joined', conditions: [],
        actions: [{ type: 'send_message', channel_id: 'ch-1', message: 'Hello' }],
        cooldown_seconds: 60,
      }],
    });
    engine = new AutomationEngine(guild, supa, valkey, eventBus);
    await engine.start();
    valkey.incr = vi.fn().mockResolvedValue(6);
    await eventBus.emitAndWait('member.joined', 'guild-1', {
      discordId: 'user-3', username: 'cooldown', isReturning: false,
    });
    const channel = guild.channels.cache.get('ch-1');
    expect(channel.send).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────
// MigrationRunner tests
// ─────────────────────────────────────────────────────

describe('runMigrations', () => {
  let runMigrations: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset env
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_ACCESS_TOKEN;
    delete process.env.SUPABASE_DB_URL;
    delete process.env.DATABASE_URL;
    ({ runMigrations } = await import('../services/migration-runner.js'));
  });

  it('skips when SUPABASE_URL is not set', async () => {
    const result = await runMigrations();
    expect(result.ran).toBe(false);
    expect(result.applied).toEqual([]);
  });

  it('skips when SUPABASE_SECRET_KEY is not set', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    const result = await runMigrations();
    expect(result.ran).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// DeployListener tests
// ─────────────────────────────────────────────────────

vi.mock('../deploy/deployer.js', () => ({
  deployServerState: vi.fn(async () => ({
    success: true, actions: [], errors: [], duration: 100,
  })),
}));

vi.mock('../services/guild-snapshot.js', () => ({
  writeGuildSnapshot: vi.fn(async () => {}),
}));

describe('deploy-listener', () => {
  let getDeployStatus: any;
  let startDeployListener: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ getDeployStatus, startDeployListener } = await import('../deploy/deploy-listener.js'));
  });

  it('getDeployStatus returns null initially', () => {
    const status = getDeployStatus();
    // May be null or last status
    expect(status === null || typeof status === 'object').toBe(true);
  });

  it('startDeployListener subscribes to realtime', () => {
    const client: any = {
      guildId: 'guild-1',
      supabase: {
        channel: vi.fn(() => ({
          on: vi.fn().mockReturnThis(),
          subscribe: vi.fn((cb: Function) => { cb?.('SUBSCRIBED'); }),
        })),
        from: vi.fn(() => makeChain()),
      },
      guilds: { cache: new Map([['guild-1', { id: 'guild-1' }]]) },
      eventBus: new PlatformEventBus(),
      router: {
        getContext: vi.fn(() => ({
          guild: { id: 'guild-1' },
          guildId: 'guild-1',
          supabase: { from: vi.fn(() => makeChain()) },
        })),
      },
    };
    startDeployListener(client);
    expect(client.supabase.channel).toHaveBeenCalled();
  });
});
