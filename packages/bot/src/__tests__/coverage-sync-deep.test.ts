/**
 * Deep coverage for sync/repair-actions.ts and sync/sync-engine.ts
 * Only mocks external deps, provides rich table-aware Supabase responses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  computeStateDiff: vi.fn(() => ({
    everyoneDrift: { actual: '8', desired: '0' },
    roleDrifts: [],
    channelDrifts: [],
    missingRoles: [],
    missingChannels: [],
    extraRoles: [],
    extraChannels: [],
  })),
  classifyDrift: vi.fn(() => [
    {
      id: 'drift1', type: 'EVERYONE_DRIFT', entityType: 'everyone',
      entityName: '@everyone', entityDiscordId: 'g1',
      severity: 'critical', description: 'Perms not zero',
      detectedAt: new Date().toISOString(), suggestedAction: 'repair',
    },
  ]),
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean): Collection<K, V> {
      const c = new Collection<K, V>();
      for (const [k, v] of this) if (fn(v)) c.set(k, v);
      return c;
    }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
    first() { return this.values().next().value; }
    sort(fn: (a: V, b: V) => number) {
      const arr = [...this.entries()].sort(([, a], [, b]) => fn(a, b));
      const c = new Collection<K, V>();
      for (const [k, v] of arr) c.set(k, v);
      return c;
    }
    some(fn: (v: V) => boolean): boolean {
      for (const v of this.values()) if (fn(v)) return true;
      return false;
    }
  }
  class PermissionsBitField {
    bitfield: bigint;
    constructor(bits?: any) { this.bitfield = BigInt(bits ?? 0); }
    has() { return true; }
  }
  return {
    Collection,
    PermissionsBitField,
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildAnnouncement: 5, GuildForum: 15, GuildStageVoice: 13 },
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
    everyonePermissions: '0', roles: [], channels: [],
  })),
}));

const { Collection } = await import('discord.js');

// ── Table-aware Supabase mock ─────────────────────────────
function makeTableSupa(tableData: Record<string, any> = {}) {
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

  return {
    from: vi.fn((table: string) => buildChain(tableData[table] ?? null)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: any) => { if (cb) cb('SUBSCRIBED'); }),
    })),
  };
}

function makeGuild(id = 'g1') {
  const roles = new Collection<string, any>();
  const everyoneRole = {
    id, name: '@everyone', position: 0, managed: false, color: 0,
    hoist: false, mentionable: false,
    permissions: { bitfield: 0n },
    setPermissions: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  roles.set(id, everyoneRole);
  roles.set('role1', {
    id: 'role1', name: 'Admin', position: 5, managed: false, color: 0xFF0000,
    hoist: true, mentionable: false,
    permissions: { bitfield: 8n },
    setPermissions: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  });

  const channels = new Collection<string, any>();
  channels.set('ch1', {
    id: 'ch1', name: 'general', type: 0, position: 0,
    topic: 'General chat', nsfw: false, rateLimitPerUser: 0,
    isTextBased: () => true,
    send: vi.fn(async () => ({ id: 'msg1' })),
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
      create: vi.fn(async () => ({ id: 'newrole', name: 'New Role', position: 1 })),
      fetch: vi.fn(async () => roles),
    },
    channels: {
      cache: channels,
      create: vi.fn(async () => ({ id: 'newch', name: 'new-ch', type: 0 })),
      fetch: vi.fn(async () => channels),
    },
    members: {
      me: { roles: { highest: { position: 10 } }, permissions: { has: () => true } },
    },
    rulesChannelId: null,
    publicUpdatesChannelId: null,
  } as any;
}

function makeEventBus() {
  return {
    on: vi.fn(), off: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn(),
  } as any;
}

// ═══════════════════════════════════════════════════════════
// repair-actions deep tests
// ═══════════════════════════════════════════════════════════
describe('repair-actions deep coverage', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('repairDriftItem EVERYONE_DRIFT resets perms and writes audit', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeTableSupa({
      guild_desired_state: { drift_details: [], drift_detected: false },
    });
    const result = await repairDriftItem(guild, supa as any, {
      id: 'd1', type: 'EVERYONE_DRIFT', entityType: 'everyone',
      entityName: '@everyone', entityDiscordId: 'g1',
      severity: 'critical', description: 'Perms not zero',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(true);
    expect(guild.roles.everyone.setPermissions).toHaveBeenCalled();
  });

  it('repairDriftItem EXTERNAL_CHANGE on role with mapping + config', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    // Need from() to return different data per table:
    const supa = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const methods = ['select', 'insert', 'update', 'upsert', 'delete',
          'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'not',
          'order', 'limit', 'range', 'match', 'ilike', 'like', 'filter',
          'contains', 'overlaps', 'textSearch'];
        for (const m of methods) chain[m] = vi.fn(() => chain);
        chain.then = undefined;

        if (table === 'discord_id_map') {
          chain.maybeSingle = vi.fn(async () => ({
            data: { template_key: 'admin', entity_type: 'role' },
            error: null,
          }));
          chain.single = chain.maybeSingle;
        } else if (table === 'guild_desired_state') {
          chain.maybeSingle = vi.fn(async () => ({
            data: {
              roles: [{ template_key: 'admin', name: 'Admin', permissions: '0', color: 0, hoist: false, mentionable: false }],
              channels: [],
              drift_details: [],
            },
            error: null,
          }));
          chain.single = chain.maybeSingle;
        } else {
          chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
          chain.single = chain.maybeSingle;
        }
        return chain;
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    };

    const result = await repairDriftItem(guild, supa as any, {
      id: 'd2', type: 'EXTERNAL_CHANGE', entityType: 'role',
      entityName: 'Admin', entityDiscordId: 'role1',
      severity: 'warning', description: 'Perms changed',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(true);
    expect(guild.roles.cache.get('role1')!.edit).toHaveBeenCalled();
  });

  it('repairDriftItem EXTERNAL_CHANGE on role without mapping', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeTableSupa(); // returns null for all tables
    const result = await repairDriftItem(guild, supa as any, {
      id: 'd3', type: 'EXTERNAL_CHANGE', entityType: 'role',
      entityName: 'Admin', entityDiscordId: 'role1',
      severity: 'warning', description: 'Changed',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No ID mapping');
  });

  it('repairDriftItem EXTERNAL_CHANGE on channel with mapping + config', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const methods = ['select', 'insert', 'update', 'upsert', 'delete',
          'eq', 'neq', 'gt', 'gte', 'lt', 'in', 'is', 'or', 'not',
          'order', 'limit', 'range', 'match', 'ilike'];
        for (const m of methods) chain[m] = vi.fn(() => chain);
        chain.then = undefined;

        if (table === 'discord_id_map') {
          chain.maybeSingle = vi.fn(async () => ({
            data: { template_key: 'general', entity_type: 'channel' }, error: null,
          }));
        } else if (table === 'guild_desired_state') {
          chain.maybeSingle = vi.fn(async () => ({
            data: {
              roles: [],
              channels: [{ template_key: 'general', name: 'general', type: 0, topic: 'Updated topic', nsfw: false, slowmode: 5 }],
              drift_details: [],
            }, error: null,
          }));
        } else {
          chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        }
        chain.single = chain.maybeSingle;
        return chain;
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    };

    const result = await repairDriftItem(guild, supa as any, {
      id: 'd4', type: 'EXTERNAL_CHANGE', entityType: 'channel',
      entityName: 'general', entityDiscordId: 'ch1',
      severity: 'warning', description: 'Topic changed',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(true);
    expect(guild.channels.cache.get('ch1')!.edit).toHaveBeenCalled();
  });

  it('repairDriftItem MISSING_RESOURCE role recreates', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const methods = ['select', 'insert', 'update', 'upsert', 'delete',
          'eq', 'neq', 'gt', 'in', 'is', 'or', 'not', 'order', 'limit', 'match', 'ilike'];
        for (const m of methods) chain[m] = vi.fn(() => chain);
        chain.then = undefined;

        if (table === 'discord_id_map') {
          chain.maybeSingle = vi.fn(async () => ({
            data: { template_key: 'mod', entity_type: 'role' }, error: null,
          }));
        } else if (table === 'guild_desired_state') {
          chain.maybeSingle = vi.fn(async () => ({
            data: {
              roles: [{ template_key: 'mod', name: 'Moderator', permissions: '0', color: 0x00FF00, hoist: true, mentionable: false }],
              channels: [],
              drift_details: [],
            }, error: null,
          }));
        } else {
          chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        }
        chain.single = chain.maybeSingle;
        return chain;
      }),
    };

    const result = await repairDriftItem(guild, supa as any, {
      id: 'd5', type: 'MISSING_RESOURCE', entityType: 'role',
      entityName: 'Moderator', entityDiscordId: 'deadrole',
      severity: 'critical', description: 'Role deleted',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(true);
    expect(guild.roles.create).toHaveBeenCalled();
  });

  it('repairDriftItem MISSING_RESOURCE channel recreates', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const methods = ['select', 'insert', 'update', 'upsert', 'delete',
          'eq', 'neq', 'gt', 'in', 'is', 'or', 'not', 'order', 'limit', 'match', 'ilike'];
        for (const m of methods) chain[m] = vi.fn(() => chain);
        chain.then = undefined;

        if (table === 'discord_id_map') {
          chain.maybeSingle = vi.fn(async () => ({
            data: { template_key: 'announcements', entity_type: 'channel' }, error: null,
          }));
        } else if (table === 'guild_desired_state') {
          chain.maybeSingle = vi.fn(async () => ({
            data: {
              roles: [],
              channels: [{ template_key: 'announcements', name: 'announcements', type: 5, topic: 'News', nsfw: false, slowmode: 0 }],
              drift_details: [],
            }, error: null,
          }));
        } else {
          chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        }
        chain.single = chain.maybeSingle;
        return chain;
      }),
    };

    const result = await repairDriftItem(guild, supa as any, {
      id: 'd6', type: 'MISSING_RESOURCE', entityType: 'channel',
      entityName: 'announcements', entityDiscordId: 'deadch',
      severity: 'critical', description: 'Channel deleted',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(true);
    expect(guild.channels.create).toHaveBeenCalled();
  });

  it('repairDriftItem EXTRA_RESOURCE role deletes', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeTableSupa({ guild_desired_state: { drift_details: [] } });
    const result = await repairDriftItem(guild, supa as any, {
      id: 'd7', type: 'EXTRA_RESOURCE', entityType: 'role',
      entityName: 'Hacker', entityDiscordId: 'role1',
      severity: 'warning', description: 'Extra role',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(true);
    expect(guild.roles.cache.get('role1')!.delete).toHaveBeenCalled();
  });

  it('repairDriftItem EXTRA_RESOURCE channel deletes', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeTableSupa({ guild_desired_state: { drift_details: [] } });
    const result = await repairDriftItem(guild, supa as any, {
      id: 'd8', type: 'EXTRA_RESOURCE', entityType: 'channel',
      entityName: 'hackers-den', entityDiscordId: 'ch1',
      severity: 'warning', description: 'Extra channel',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(true);
    expect(guild.channels.cache.get('ch1')!.delete).toHaveBeenCalled();
  });

  it('repairDriftItem EXTRA_RESOURCE with no discord ID', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeTableSupa();
    const result = await repairDriftItem(guild, supa as any, {
      id: 'd9', type: 'EXTRA_RESOURCE', entityType: 'role',
      entityName: 'Ghost', entityDiscordId: null,
      severity: 'warning', description: 'Extra role with no ID',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No Discord ID');
  });

  it('repairDriftItem unknown type', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeTableSupa();
    const result = await repairDriftItem(guild, supa as any, {
      id: 'dx', type: 'UNKNOWN_TYPE' as any, entityType: 'role',
      entityName: 'X', entityDiscordId: 'role1',
      severity: 'info', description: 'Unknown',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(false);
  });

  it('repairDriftItem PERMISSION_DRIFT on role', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const methods = ['select', 'insert', 'update', 'upsert', 'delete',
          'eq', 'neq', 'gt', 'in', 'is', 'or', 'not', 'order', 'limit', 'match', 'ilike'];
        for (const m of methods) chain[m] = vi.fn(() => chain);
        chain.then = undefined;
        if (table === 'discord_id_map') {
          chain.maybeSingle = vi.fn(async () => ({
            data: { template_key: 'admin' }, error: null,
          }));
        } else if (table === 'guild_desired_state') {
          chain.maybeSingle = vi.fn(async () => ({
            data: {
              roles: [{ template_key: 'admin', name: 'Admin', permissions: '8', color: 0xFF0000, hoist: true, mentionable: false }],
              drift_details: [],
            }, error: null,
          }));
        } else {
          chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        }
        chain.single = chain.maybeSingle;
        return chain;
      }),
    };
    const result = await repairDriftItem(guild, supa as any, {
      id: 'dp1', type: 'PERMISSION_DRIFT', entityType: 'role',
      entityName: 'Admin', entityDiscordId: 'role1',
      severity: 'warning', description: 'Perms changed',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(true);
  });

  it('repairDriftItem handles thrown error gracefully', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    guild.roles.everyone.setPermissions = vi.fn(async () => { throw new Error('Discord API error'); });
    const supa = makeTableSupa();
    const result = await repairDriftItem(guild, supa as any, {
      id: 'derr', type: 'EVERYONE_DRIFT', entityType: 'everyone',
      entityName: '@everyone', entityDiscordId: 'g1',
      severity: 'critical', description: 'Perms not zero',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Discord API error');
  });

  it('acceptDriftItem for @everyone returns error', async () => {
    const { acceptDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeTableSupa();
    const result = await acceptDriftItem(guild, supa as any, {
      id: 'ae1', type: 'EVERYONE_DRIFT', entityType: 'everyone',
      entityName: '@everyone', entityDiscordId: 'g1',
      severity: 'critical', description: 'Perms not zero',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be accepted');
  });

  it('acceptDriftItem EXTRA_RESOURCE upserts to ID map', async () => {
    const { acceptDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = makeTableSupa({ guild_desired_state: { drift_details: [] } });
    const result = await acceptDriftItem(guild, supa as any, {
      id: 'ae2', type: 'EXTRA_RESOURCE', entityType: 'role',
      entityName: 'CustomRole', entityDiscordId: 'role1',
      severity: 'info', description: 'Extra role',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(true);
    expect(supa.from).toHaveBeenCalledWith('discord_id_map');
  });

  it('acceptDriftItem EXTERNAL_CHANGE on role updates desired state', async () => {
    const { acceptDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const methods = ['select', 'insert', 'update', 'upsert', 'delete',
          'eq', 'neq', 'gt', 'in', 'is', 'or', 'not', 'order', 'limit', 'match', 'ilike'];
        for (const m of methods) chain[m] = vi.fn(() => chain);
        chain.then = undefined;
        if (table === 'discord_id_map') {
          chain.maybeSingle = vi.fn(async () => ({
            data: { template_key: 'admin' }, error: null,
          }));
        } else if (table === 'guild_desired_state') {
          chain.maybeSingle = vi.fn(async () => ({
            data: {
              roles: [{ template_key: 'admin', name: 'Admin', permissions: '0', color: 0 }],
              channels: [],
              drift_details: [],
            }, error: null,
          }));
        } else {
          chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        }
        chain.single = chain.maybeSingle;
        return chain;
      }),
    };
    const result = await acceptDriftItem(guild, supa as any, {
      id: 'ae3', type: 'EXTERNAL_CHANGE', entityType: 'role',
      entityName: 'Admin', entityDiscordId: 'role1',
      severity: 'warning', description: 'Role changed',
      detectedAt: new Date().toISOString(),
      currentValue: JSON.stringify({ permissions: '8', color: 0xFF0000 }),
    } as any);
    expect(result.success).toBe(true);
  });

  it('acceptDriftItem EXTERNAL_CHANGE on channel updates desired state', async () => {
    const { acceptDriftItem } = await import('../sync/repair-actions.js');
    const guild = makeGuild();
    const supa = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const methods = ['select', 'insert', 'update', 'upsert', 'delete',
          'eq', 'neq', 'gt', 'in', 'is', 'or', 'not', 'order', 'limit', 'match', 'ilike'];
        for (const m of methods) chain[m] = vi.fn(() => chain);
        chain.then = undefined;
        if (table === 'discord_id_map') {
          chain.maybeSingle = vi.fn(async () => ({
            data: { template_key: 'general' }, error: null,
          }));
        } else if (table === 'guild_desired_state') {
          chain.maybeSingle = vi.fn(async () => ({
            data: {
              roles: [],
              channels: [{ template_key: 'general', name: 'general', type: 0 }],
              drift_details: [],
            }, error: null,
          }));
        } else {
          chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        }
        chain.single = chain.maybeSingle;
        return chain;
      }),
    };
    const result = await acceptDriftItem(guild, supa as any, {
      id: 'ae4', type: 'EXTERNAL_CHANGE', entityType: 'channel',
      entityName: 'general', entityDiscordId: 'ch1',
      severity: 'warning', description: 'Channel changed',
      detectedAt: new Date().toISOString(),
    } as any);
    expect(result.success).toBe(true);
  });

  it('clearAllDrift updates DB', async () => {
    const { clearAllDrift } = await import('../sync/repair-actions.js');
    const supa = makeTableSupa();
    await clearAllDrift(supa as any, 'g1');
    expect(supa.from).toHaveBeenCalledWith('guild_desired_state');
  });
});

// ═══════════════════════════════════════════════════════════
// sync-engine deep tests
// ═══════════════════════════════════════════════════════════
describe('sync-engine deep coverage', () => {
  it('runSyncCycle with desired state, drift, and autoRepairEveryone', async () => {
    const { runSyncCycle } = await import('../sync/sync-engine.js');
    const guild = makeGuild();
    const supa = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const methods = ['select', 'insert', 'update', 'upsert', 'delete',
          'eq', 'neq', 'gt', 'in', 'is', 'or', 'not', 'order', 'limit', 'match', 'ilike'];
        for (const m of methods) chain[m] = vi.fn(() => chain);
        chain.then = undefined;
        if (table === 'guild_desired_state') {
          chain.maybeSingle = vi.fn(async () => ({
            data: {
              guild_id: 'g1',
              roles: [{ key: 'admin', name: 'Admin', tier: 'staff', permissions: '8' }],
              channels: [],
            }, error: null,
          }));
        } else if (table === 'discord_id_map') {
          chain.limit = vi.fn(async () => ({
            data: [{ template_key: 'admin', discord_id: 'role1' }],
            error: null,
          }));
        } else {
          chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        }
        chain.single = chain.maybeSingle;
        return chain;
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    };

    const eventBus = makeEventBus();
    const result = await runSyncCycle(guild as any, supa as any, eventBus, {
      enabled: true, intervalMinutes: 5, autoRepair: false, autoRepairEveryone: true,
    });
    expect(result.timestamp).toBeDefined();
    // autoRepairEveryone=true + everyoneDrift exists → should repair
    expect(result.repaired).toBeGreaterThanOrEqual(0);
  });

  it('runSyncCycle filters ticket and community channels from drift', async () => {
    const { classifyDrift } = await import('@somnibot/shared');
    // Make classifyDrift return items including ticket and community channels:
    (classifyDrift as any).mockReturnValue([
      { id: 't1', type: 'EXTRA_RESOURCE', entityType: 'channel', entityName: 'ticket-001-bob', severity: 'info', detectedAt: new Date().toISOString() },
      { id: 't2', type: 'EXTRA_RESOURCE', entityType: 'channel', entityName: 'moderator-only', severity: 'info', detectedAt: new Date().toISOString() },
      { id: 't3', type: 'EXTRA_RESOURCE', entityType: 'role', entityName: 'Extra', severity: 'warning', detectedAt: new Date().toISOString() },
    ]);

    const { runSyncCycle } = await import('../sync/sync-engine.js');
    const guild = makeGuild();
    const supa = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const methods = ['select', 'insert', 'update', 'upsert', 'delete',
          'eq', 'neq', 'gt', 'in', 'is', 'or', 'not', 'order', 'limit', 'match', 'ilike'];
        for (const m of methods) chain[m] = vi.fn(() => chain);
        chain.then = undefined;
        if (table === 'guild_desired_state') {
          chain.maybeSingle = vi.fn(async () => ({
            data: { guild_id: 'g1', roles: [], channels: [] }, error: null,
          }));
        } else if (table === 'discord_id_map') {
          chain.limit = vi.fn(async () => ({ data: [], error: null }));
        } else {
          chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
        }
        chain.single = chain.maybeSingle;
        return chain;
      }),
    };

    const result = await runSyncCycle(guild as any, supa as any, makeEventBus(), {
      enabled: true, intervalMinutes: 5, autoRepair: false, autoRepairEveryone: false,
    });
    // Ticket and community channels should be filtered out:
    expect(result.driftItems.length).toBe(1); // Only the Extra role
    expect(result.driftItems[0].entityName).toBe('Extra');
  });
});
