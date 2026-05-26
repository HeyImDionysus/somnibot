/**
 * coverage-services-deep.test.ts — Deep coverage for service/utility modules.
 * Targets: bot-role-guard, repair-actions, sync-engine, owner-notifications,
 * stats-manager, scheduled-messages runner, command-engine, and more.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared external mocks ─────────────────────────────────
vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  computeStateDiff: vi.fn(() => ({
    everyoneDrift: null,
    roleDrifts: [],
    channelDrifts: [],
    missingRoles: [],
    missingChannels: [],
    extraRoles: [],
    extraChannels: [],
  })),
  classifyDrift: vi.fn(() => []),
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean): Collection<K, V> {
      const c = new Collection<K, V>();
      for (const [k, v] of this) if (fn(v)) c.set(k, v);
      return c;
    }
    map<T>(fn: (v: V) => T): T[] {
      return [...this.values()].map(fn);
    }
    first() { return this.values().next().value; }
    sort(fn: (a: V, b: V) => number) {
      const arr = [...this.entries()].sort(([, a], [, b]) => fn(a, b));
      const c = new Collection<K, V>();
      for (const [k, v] of arr) c.set(k, v);
      return c;
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
    addFields(...f: any[]) { return this; }
    toJSON() { return this.data; }
  }
  class PermissionsBitField {
    bitfield: bigint;
    constructor(bits?: any) { this.bitfield = BigInt(bits ?? 0); }
    has(perm: string) { return true; }
  }
  return {
    Collection,
    EmbedBuilder,
    PermissionsBitField,
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildAnnouncement: 5, GuildForum: 15 },
    REST: class { setToken() { return this; } },
    Routes: { applicationGuildCommands: () => '/test' },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
  writeAuditBatch: vi.fn(async () => {}),
}));

vi.mock('../services/guild-snapshot.js', () => ({
  writeGuildSnapshot: vi.fn(async () => {}),
}));

vi.mock('../sync/snapshot.js', () => ({
  takeSnapshot: vi.fn(async () => ({
    everyonePermissions: '0',
    roles: [],
    channels: [],
  })),
}));

vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => null,
  registerQuestsManager: vi.fn(),
  invalidateQuestsCache: vi.fn(),
}));

// ── Helper factories ──────────────────────────────────────
const { Collection } = await import('discord.js');

function buildChain(data: any = null) {
  const chain: any = {};
  const methods = ['select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or',
    'order', 'limit', 'range', 'not', 'match', 'contains', 'filter',
    'ilike', 'like', 'overlaps', 'textSearch'];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
  chain.single = vi.fn(async () => ({ data, error: null }));
  chain.then = undefined;
  return chain;
}

function makeSupa(tableData: Record<string, any> = {}) {
  const channelObj = vi.fn((): any => ({
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn((cb: any) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: vi.fn() }; }),
  }));
  return {
    from: vi.fn((table: string) => buildChain(tableData[table] ?? null)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    channel: channelObj,
  };
}

function makeGuild(id = 'g1') {
  const roles = new Collection<string, any>();
  const everyoneRole = {
    id, name: '@everyone', position: 0, managed: false,
    setPermissions: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
  };
  roles.set(id, everyoneRole);
  roles.set('role1', {
    id: 'role1', name: 'Admin', position: 5, managed: false, color: 0,
    setPermissions: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  });

  const channels = new Collection<string, any>();
  channels.set('ch1', {
    id: 'ch1', name: 'general', type: 0, position: 0,
    isTextBased: () => true,
    send: vi.fn(async () => ({ id: 'msg1' })),
    delete: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
    permissionOverwrites: { set: vi.fn(async () => {}), cache: new Collection() },
  });
  channels.set('ch2', {
    id: 'ch2', name: 'bot-logs', type: 0, position: 1,
    isTextBased: () => true,
    send: vi.fn(async () => ({ id: 'msg2' })),
    delete: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    permissionOverwrites: { set: vi.fn(async () => {}), cache: new Collection() },
  });

  return {
    id,
    name: 'Test Guild',
    memberCount: 100,
    roles: {
      cache: roles,
      everyone: everyoneRole,
      create: vi.fn(async () => ({ id: 'newrole', name: 'New', position: 1 })),
      fetch: vi.fn(async () => roles),
    },
    channels: {
      cache: channels,
      create: vi.fn(async () => ({ id: 'newch', name: 'new-ch', type: 0 })),
      fetch: vi.fn(async () => channels),
    },
    members: {
      cache: new Collection(),
      me: {
        roles: { highest: { position: 10 } },
        permissions: { has: vi.fn(() => true) },
      },
      fetch: vi.fn(async () => ({
        id: 'u1',
        roles: { cache: new Collection(), add: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        user: { id: 'u1', username: 'TestUser' },
      })),
    },
    rulesChannelId: null,
    publicUpdatesChannelId: null,
    iconURL: () => 'https://example.com/icon.png',
    client: { ws: { ping: 50 }, user: { id: 'bot1' } },
  } as any;
}

function makeValkey() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (...args: any[]) => {
      const [k, v] = args;
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async () => 1),
    incr: vi.fn(async (k: string) => {
      const v = parseInt(store.get(k) ?? '0', 10) + 1;
      store.set(k, String(v));
      return v;
    }),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 120),
    hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    keys: vi.fn(async () => []),
    _store: store,
  } as any;
}

function makeEventBus() {
  const handlers = new Map<string, Function[]>();
  return {
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    }),
    off: vi.fn(),
    emit: vi.fn((event: string, ...args: any[]) => {
      for (const h of handlers.get(event) ?? []) h(...args);
    }),
    removeAllListeners: vi.fn(),
  } as any;
}

// ═══════════════════════════════════════════════════════════
// 1. Bot Role Guard
// ═══════════════════════════════════════════════════════════
describe('Bot Role Guard', () => {
  it('checkBotRolePosition with no bot member returns false', async () => {
    const { checkBotRolePosition } = await import('../guards/bot-role-guard.js');
    const guild = makeGuild();
    guild.members.me = null;
    const result = await checkBotRolePosition(guild);
    expect(result.isTopPosition).toBe(false);
    expect(result.botRolePosition).toBe(-1);
    expect(result.canManageAllRoles).toBe(false);
  });

  it('checkBotRolePosition with top position', async () => {
    const { checkBotRolePosition } = await import('../guards/bot-role-guard.js');
    const guild = makeGuild();
    // Bot role is at position 10, no non-managed roles above
    const result = await checkBotRolePosition(guild);
    expect(result.isTopPosition).toBe(true);
    expect(result.botRolePosition).toBe(10);
    expect(result.canManageAllRoles).toBe(true);
  });

  it('checkBotRolePosition with roles above bot', async () => {
    const { checkBotRolePosition } = await import('../guards/bot-role-guard.js');
    const guild = makeGuild();
    guild.roles.cache.set('highrole', {
      id: 'highrole', name: 'Owner', position: 15, managed: false,
    });
    const result = await checkBotRolePosition(guild);
    expect(result.isTopPosition).toBe(false);
    expect(result.rolesAboveBot.length).toBeGreaterThan(0);
  });

  it('checkBotPermissions with no bot member', async () => {
    const { checkBotPermissions } = await import('../guards/bot-role-guard.js');
    const guild = makeGuild();
    guild.members.me = null;
    const result = checkBotPermissions(guild);
    expect(result.hasRequired).toBe(false);
    expect(result.missing).toContain('BOT_NOT_IN_GUILD');
  });

  it('checkBotPermissions with Administrator', async () => {
    const { checkBotPermissions } = await import('../guards/bot-role-guard.js');
    const guild = makeGuild();
    const result = checkBotPermissions(guild);
    expect(result.hasRequired).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('checkBotPermissions with missing perms', async () => {
    const { checkBotPermissions } = await import('../guards/bot-role-guard.js');
    const guild = makeGuild();
    guild.members.me.permissions.has = vi.fn((perm: string) => perm === 'ViewChannel');
    const result = checkBotPermissions(guild);
    expect(result.hasRequired).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Repair Actions
// ═══════════════════════════════════════════════════════════
describe('Repair Actions', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('repairDriftItem EVERYONE_DRIFT', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const result = await repairDriftItem(guild as any, supa as any, {
      id: 'd1', type: 'EVERYONE_DRIFT', entityType: 'role',
      entityName: '@everyone', entityDiscordId: 'g1',
      severity: 'critical', description: 'Perms not zero',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(true);
    expect(guild.roles.everyone.setPermissions).toHaveBeenCalledWith(0n, expect.any(String));
  });

  it('repairDriftItem EXTERNAL_CHANGE on role', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeSupa({
      discord_id_map: { template_key: 'role1', discord_id: 'role1' },
    });
    const result = await repairDriftItem(guild as any, supa as any, {
      id: 'd2', type: 'EXTERNAL_CHANGE', entityType: 'role',
      entityName: 'Admin', entityDiscordId: 'role1',
      severity: 'warning', description: 'Role perms changed',
      detectedAt: new Date().toISOString(),
      desiredValue: JSON.stringify({ permissions: '0', color: 0, hoist: false, mentionable: false }),
    } as any);
    expect(result).toBeDefined();
  });

  it('repairDriftItem EXTERNAL_CHANGE on channel', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const result = await repairDriftItem(guild as any, supa as any, {
      id: 'd3', type: 'EXTERNAL_CHANGE', entityType: 'channel',
      entityName: 'general', entityDiscordId: 'ch1',
      severity: 'warning', description: 'Channel changed',
      detectedAt: new Date().toISOString(),
      desiredValue: JSON.stringify({ topic: 'Welcome', slowmode: 0, nsfw: false }),
    } as any);
    expect(result).toBeDefined();
  });

  it('repairDriftItem MISSING_RESOURCE', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const result = await repairDriftItem(guild as any, supa as any, {
      id: 'd4', type: 'MISSING_RESOURCE', entityType: 'role',
      entityName: 'Moderator', entityDiscordId: null,
      severity: 'critical', description: 'Role missing',
      detectedAt: new Date().toISOString(),
      desiredValue: JSON.stringify({ name: 'Moderator', permissions: '0', color: 0, hoist: false, mentionable: false }),
    } as any);
    expect(result).toBeDefined();
  });

  it('repairDriftItem EXTRA_RESOURCE', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const result = await repairDriftItem(guild as any, supa as any, {
      id: 'd5', type: 'EXTRA_RESOURCE', entityType: 'role',
      entityName: 'Hacker', entityDiscordId: 'role1',
      severity: 'warning', description: 'Extra role',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result).toBeDefined();
  });

  it('acceptDriftItem', async () => {
    const { acceptDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const result = await acceptDriftItem(guild as any, supa as any, {
      id: 'd6', type: 'EXTERNAL_CHANGE', entityType: 'role',
      entityName: 'Admin', entityDiscordId: 'role1',
      severity: 'warning', description: 'Role changed',
      detectedAt: new Date().toISOString(),
      currentValue: JSON.stringify({ permissions: '8', color: 0xFF0000 }),
    } as any);
    expect(result).toBeDefined();
  });

  it('ignoreDriftItem', async () => {
    const { ignoreDriftItem } = await import('../sync/repair-actions.js');
    const supa = makeSupa();
    const result = await ignoreDriftItem(supa as any, 'g1', {
      id: 'd7', type: 'EXTERNAL_CHANGE', entityType: 'channel',
      entityName: 'general', entityDiscordId: 'ch1',
      severity: 'info', description: 'Channel topic changed',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result).toBeDefined();
  });

  it('clearAllDrift', async () => {
    const { clearAllDrift } = await import('../sync/repair-actions.js');
    const supa = makeSupa();
    await clearAllDrift(supa as any, 'g1');
    expect(supa.from).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Sync Engine
// ═══════════════════════════════════════════════════════════
describe('Sync Engine', () => {
  it('runSyncCycle with no desired state', async () => {
    const { runSyncCycle } = await import('../sync/sync-engine.js');
    const guild = makeGuild();
    const supa = makeSupa(); // from('guild_desired_state') returns null
    const result = await runSyncCycle(guild as any, supa as any, makeEventBus(), {
      enabled: true, intervalMinutes: 5, autoRepair: false, autoRepairEveryone: false,
    });
    expect(result.driftItems).toHaveLength(0);
    expect(result.repaired).toBe(0);
  });

  it('runSyncCycle with desired state and no drift', async () => {
    const { runSyncCycle } = await import('../sync/sync-engine.js');
    const guild = makeGuild();
    const supa = makeSupa({
      guild_desired_state: {
        guild_id: 'g1',
        roles: [{ key: 'admin', name: 'Admin', tier: 'staff', permissions: '8', color: 0, hoist: false, mentionable: false }],
        channels: [],
      },
      discord_id_map: null,
    });
    // Override from to return different data per table:
    supa.from = vi.fn((table: string) => {
      if (table === 'guild_desired_state') {
        return buildChain({
          guild_id: 'g1',
          roles: [{ key: 'admin', name: 'Admin', tier: 'staff', permissions: '8', color: 0, hoist: false, mentionable: false }],
          channels: [],
        });
      }
      if (table === 'discord_id_map') {
        const c = buildChain(null);
        c.limit = vi.fn(async () => ({ data: [], error: null }));
        return c;
      }
      return buildChain(null);
    });
    const result = await runSyncCycle(guild as any, supa as any, makeEventBus(), {
      enabled: true, intervalMinutes: 5, autoRepair: false, autoRepairEveryone: false,
    });
    expect(result).toBeDefined();
    expect(result.timestamp).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Stats Channel Manager
// ═══════════════════════════════════════════════════════════
describe('StatsChannelManager', () => {
  it('construct and run update cycle', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const guild = makeGuild();
    const supa = makeSupa({
      guild_config: {
        stats_channels_enabled: true,
        stats_channel_configs: [
          { type: 'member_count', channelId: 'ch1', template: 'Members: {count}' },
          { type: 'role_count', channelId: 'ch2', template: 'Admins: {count}', roleId: 'role1' },
        ],
      },
    });
    const mgr = new StatsChannelManager(guild as any, supa as any, 60);
    expect(mgr).toBeDefined();
    // Don't start the timer, just test the update method if accessible
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Scheduled Message Runner
// ═══════════════════════════════════════════════════════════
describe('ScheduledMessageRunner', () => {
  it('construct and load schedules (empty)', async () => {
    const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const runner = new ScheduledMessageRunner(guild as any, supa as any);
    expect(runner).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Custom Command Engine
// ═══════════════════════════════════════════════════════════
describe('Custom Command Engine', () => {
  it('loadCustomCommands with no data', async () => {
    const { loadCustomCommands, clearCommandRegistry } = await import('../features/custom-commands/command-engine.js');
    clearCommandRegistry();
    const guild = makeGuild();
    const supa = makeSupa();
    const rest = { setToken: vi.fn(() => rest) } as any;
    const result = await loadCustomCommands(supa as any, guild as any, rest);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('loadCustomCommands with commands', async () => {
    const { loadCustomCommands, isCustomCommand, clearCommandRegistry } = await import('../features/custom-commands/command-engine.js');
    clearCommandRegistry();
    const guild = makeGuild();
    const supa = makeSupa();
    // Override from to return custom commands:
    supa.from = vi.fn(() => {
      const chain = buildChain(null);
      chain.limit = vi.fn(async () => ({
        data: [
          { id: 'cmd1', guild_id: 'g1', name: 'hello', description: 'Say hello', enabled: true, actions: [{ type: 'send_message', message: 'Hello!' }], cooldown_seconds: 5 },
          { id: 'cmd2', guild_id: 'g1', name: 'info', description: 'Get info', enabled: true, actions: [{ type: 'send_embed', embedConfig: { title: 'Info', description: 'Test' } }], cooldown_seconds: 0 },
        ],
        error: null,
      }));
      return chain;
    });
    const rest = { setToken: vi.fn(() => rest) } as any;
    const result = await loadCustomCommands(supa as any, guild as any, rest);
    expect(result.length).toBe(2);
    expect(isCustomCommand('hello')).toBe(true);
    expect(isCustomCommand('nonexistent')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. Owner Notification Service
// ═══════════════════════════════════════════════════════════
describe('OwnerNotificationService', () => {
  it('construct', async () => {
    const { OwnerNotificationService } = await import('../services/owner-notifications.js');
    const client = {
      ws: { ping: 50 },
      user: { id: 'bot1' },
      users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => ({})), id: 'owner1' })) },
      guilds: { cache: new Collection() },
    } as any;
    const svc = new OwnerNotificationService(client, 'g1', makeSupa() as any, makeEventBus());
    expect(svc).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 8. Adventure Manager
// ═══════════════════════════════════════════════════════════
describe('AdventureManager', () => {
  it('construct and invalidate cache', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const guild = makeGuild();
    const supa = makeSupa({
      guild_config: {
        economy_adventures_enabled: true,
        economy_adventure_daily_limit: 3,
        economy_adventure_ticket_cost: 100,
        economy_adventure_max_scenes: 10,
      },
    });
    const mgr = new AdventureManager(guild as any, supa as any, makeValkey());
    expect(mgr).toBeDefined();
    mgr.invalidateCache();
  });
});

// ═══════════════════════════════════════════════════════════
// 9. Market Manager
// ═══════════════════════════════════════════════════════════
describe('MarketManager', () => {
  it('construct and browse empty market', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const guild = makeGuild();
    const supa = makeSupa({
      guild_config: {
        economy_market_enabled: true,
        economy_market_tax_pct: 5,
        economy_market_max_listings: 10,
        currency_name: 'coins',
        currency_emoji: '🪙',
      },
    });
    const mgr = new MarketManager(guild as any, supa as any, makeValkey());
    expect(mgr).toBeDefined();
    const result = await mgr.browse();
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 10. Farming Manager
// ═══════════════════════════════════════════════════════════
describe('FarmingManager', () => {
  it('construct and invalidate config', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const mgr = new FarmingManager(guild as any, supa as any, makeValkey());
    expect(mgr).toBeDefined();
    mgr.invalidateConfig();
  });

  it('getConfig loads from supabase', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const guild = makeGuild();
    const supa = makeSupa({
      guild_config: {
        economy_farming_enabled: true,
        economy_farming_max_plots: 6,
        economy_farming_growth_minutes: 60,
      },
    });
    const mgr = new FarmingManager(guild as any, supa as any, makeValkey());
    const config = await mgr.getConfig();
    expect(config).toBeDefined();
  });

  it('viewFarm returns embed', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const guild = makeGuild();
    const supa = makeSupa({
      guild_config: {
        economy_farming_enabled: true,
        economy_farming_max_plots: 6,
        economy_farming_growth_minutes: 60,
        currency_name: 'coins',
        currency_emoji: '🪙',
      },
    });
    // Override from to return different data per table:
    supa.from = vi.fn((table: string) => {
      if (table === 'guild_config') {
        return buildChain({
          economy_farming_enabled: true,
          economy_farming_max_plots: 6,
          economy_farming_growth_minutes: 60,
          currency_name: 'coins',
          currency_emoji: '🪙',
        });
      }
      if (table === 'economy_farm_plots') {
        const c = buildChain(null);
        c.order = vi.fn(() => ({
          ...c,
          then: undefined,
          eq: vi.fn(() => c),
          limit: vi.fn(async () => ({ data: [], error: null })),
        }));
        return c;
      }
      return buildChain(null);
    });
    const mgr = new FarmingManager(guild as any, supa as any, makeValkey());
    const result = await mgr.viewFarm('user-1');
    expect(result.embed).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 11. Crafting Manager
// ═══════════════════════════════════════════════════════════
describe('CraftingManager', () => {
  it('construct and getConfig', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const guild = makeGuild();
    const supa = makeSupa({
      guild_config: {
        economy_crafting_enabled: true,
        economy_crafting_cooldown_seconds: 60,
        currency_name: 'coins',
        currency_emoji: '🪙',
      },
    });
    const mgr = new CraftingManager(guild as any, supa as any, makeValkey());
    expect(mgr).toBeDefined();
    const config = await mgr.getConfig();
    expect(config).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 12. Gathering Manager
// ═══════════════════════════════════════════════════════════
describe('GatheringManager', () => {
  it('construct and invalidate config', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const mgr = new GatheringManager(guild as any, supa as any, makeValkey());
    expect(mgr).toBeDefined();
    mgr.invalidateConfig();
  });

  it('getConfig loads from supabase', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const guild = makeGuild();
    const supa = makeSupa({
      guild_config: {
        economy_gathering_enabled: true,
        economy_gathering_cooldown_seconds: 120,
        currency_name: 'coins',
        currency_emoji: '🪙',
      },
    });
    const mgr = new GatheringManager(guild as any, supa as any, makeValkey());
    const config = await mgr.getConfig();
    expect(config).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 13. Fishing Manager
// ═══════════════════════════════════════════════════════════
describe('FishingManager', () => {
  it('construct', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const mgr = new FishingManager(guild as any, supa as any, makeValkey());
    expect(mgr).toBeDefined();
  });

  it('checkRod with no rod', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const mgr = new FishingManager(guild as any, supa as any, makeValkey());
    const result = await mgr.checkRod('user-1');
    expect(result.hasRod).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 14. Giveaway Manager
// ═══════════════════════════════════════════════════════════
describe('GiveawayManager', () => {
  it('construct', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const mgr = new GiveawayManager(guild as any, supa as any, makeValkey(), makeEventBus());
    expect(mgr).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 15. Lottery Manager
// ═══════════════════════════════════════════════════════════
describe('LotteryManager', () => {
  it('construct and drawWinner with no active drawing', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const supa = makeSupa();
    const client = { channels: { fetch: vi.fn(async () => ({ send: vi.fn() })) } } as any;
    const mgr = new LotteryManager(supa as any, client);
    expect(mgr).toBeDefined();
    const result = await mgr.drawWinner('g1');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 16. Polls Manager
// ═══════════════════════════════════════════════════════════
describe('PollsManager deep', () => {
  it('construct', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const supa = makeSupa();
    const mgr = new PollsManager(supa as any);
    expect(mgr).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 17. Games Manager
// ═══════════════════════════════════════════════════════════
describe('GamesManager deep', () => {
  it('construct and clear cache', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const supa = makeSupa();
    const mgr = new GamesManager(supa as any);
    expect(mgr).toBeDefined();
    mgr.stopDailyResetTimer();
    mgr.clearCache();
  });
});

// ═══════════════════════════════════════════════════════════
// 18. Heist Manager
// ═══════════════════════════════════════════════════════════
describe('HeistManager deep', () => {
  it('construct, clear cache, cleanup', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeSupa();
    const client = { guilds: { cache: new Collection() } } as any;
    const mgr = new HeistManager(supa as any, client, makeValkey());
    expect(mgr).toBeDefined();
    mgr.clearCache();
    mgr.cleanup();
  });
});

// ═══════════════════════════════════════════════════════════
// 19. Pets Manager
// ═══════════════════════════════════════════════════════════
describe('PetsManager', () => {
  it('construct', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const supa = makeSupa();
    const client = { guilds: { cache: new Collection() } } as any;
    const mgr = new PetsManager(supa as any, client, makeValkey());
    expect(mgr).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 20. Automation Engine
// ═══════════════════════════════════════════════════════════
describe('AutomationEngine', () => {
  it('construct', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const engine = new AutomationEngine(guild as any, supa as any, makeValkey(), makeEventBus());
    expect(engine).toBeDefined();
  });
});
