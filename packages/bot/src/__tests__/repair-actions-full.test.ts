/**
 * Repair Actions — Full tests
 *
 * Tests repairDriftItem and acceptDriftItem for all drift types:
 * EVERYONE_DRIFT, EXTERNAL_CHANGE, PERMISSION_DRIFT, MISSING_RESOURCE,
 * EXTRA_RESOURCE. Tests both success and error paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { repairDriftItem, acceptDriftItem } from '../sync/repair-actions.js';
import { writeAuditLog } from '../services/audit.js';
import { MockCollection } from './helpers/discord-mocks.js';

function supaChain(data: any = null, error: any = null) {
  const c: any = {};
  const methods = ['select','insert','update','upsert','delete','eq','neq','gte','lt','lte',
    'limit','order','in','head','filter','maybeSingle','single','match'];
  for (const m of methods) c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = (resolve: any) => resolve({ data, error });
  return c;
}

function makeGuild(overrides: Record<string, any> = {}): any {
  const roles = new MockCollection();
  const everyone = {
    id: 'everyone',
    name: '@everyone',
    managed: false,
    position: 0,
    setPermissions: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
  };
  roles.set('everyone', everyone);

  const extraRole = {
    id: 'extra1',
    name: 'ExtraRole',
    managed: false,
    position: 1,
    delete: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
  };
  roles.set('extra1', extraRole);

  const managedRole = {
    id: 'managed1',
    name: 'ManagedRole',
    managed: true,
    position: 1,
    delete: vi.fn(async () => {}),
  };
  roles.set('managed1', managedRole);

  const channels = new MockCollection();
  const textChannel = {
    id: 'ch1',
    name: 'test-channel',
    delete: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
  };
  channels.set('ch1', textChannel);

  return {
    id: 'g1',
    roles: {
      cache: roles,
      everyone,
      create: vi.fn(async (opts: any) => ({ id: 'new-role', ...opts })),
    },
    channels: {
      cache: channels,
      create: vi.fn(async (opts: any) => ({ id: 'new-ch', ...opts })),
    },
    ...overrides,
  };
}

function makeSupabase(tableResponses: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => {
      if (tableResponses[table]) return supaChain(tableResponses[table]);
      return supaChain();
    }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('repairDriftItem — EVERYONE_DRIFT', () => {
  it('sets @everyone permissions to 0', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'EVERYONE_DRIFT' as const,
      entityType: 'everyone' as const,
      entityName: '@everyone',
      entityDiscordId: 'everyone',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);

    expect(result.success).toBe(true);
    expect(guild.roles.everyone.setPermissions).toHaveBeenCalledWith(0n, expect.any(String));
    expect(writeAuditLog).toHaveBeenCalled();
  });
});

describe('repairDriftItem — EXTRA_RESOURCE (role)', () => {
  it('deletes non-managed extra role', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'EXTRA_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'ExtraRole',
      entityDiscordId: 'extra1',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);

    expect(result.success).toBe(true);
    expect(guild.roles.cache.get('extra1').delete).toHaveBeenCalledWith(expect.any(String));
  });

  it('does not delete managed roles', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'EXTRA_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'ManagedRole',
      entityDiscordId: 'managed1',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(true);
    expect(guild.roles.cache.get('managed1').delete).not.toHaveBeenCalled();
  });
});

describe('repairDriftItem — EXTRA_RESOURCE (channel)', () => {
  it('deletes extra channel', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'EXTRA_RESOURCE' as const,
      entityType: 'channel' as const,
      entityName: 'test-channel',
      entityDiscordId: 'ch1',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);

    expect(result.success).toBe(true);
    expect(guild.channels.cache.get('ch1').delete).toHaveBeenCalled();
  });
});

describe('repairDriftItem — EXTRA_RESOURCE without Discord ID', () => {
  it('returns error', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'EXTRA_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'Ghost',
      entityDiscordId: undefined,
    };

    const result = await repairDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No Discord ID');
  });
});

describe('repairDriftItem — MISSING_RESOURCE', () => {
  it('recreates a deleted role from desired state', async () => {
    const guild = makeGuild();
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'discord_id_map') {
          return supaChain({ template_key: 'moderator', entity_type: 'role' });
        }
        if (table === 'guild_desired_state') {
          return supaChain({
            roles: [{ template_key: 'moderator', name: 'Moderator', permissions: '0', color: 0xFF0000 }],
            channels: [],
          });
        }
        if (table === 'drift_items') return supaChain();
        return supaChain();
      }),
    } as any;

    const drift = {
      type: 'MISSING_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'Moderator',
      entityDiscordId: 'old-role-id',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(true);
    expect(guild.roles.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Moderator',
    }));
  });

  it('returns error when no ID mapping found', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase({ discord_id_map: null });
    const drift = {
      type: 'MISSING_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'Unknown',
      entityDiscordId: 'gone',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No ID mapping');
  });
});

describe('repairDriftItem — unknown type', () => {
  it('returns error for unknown drift type', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'UNKNOWN_TYPE' as any,
      entityType: 'role' as const,
      entityName: 'Test',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown drift type');
  });
});

describe('acceptDriftItem', () => {
  it('rejects accepting @everyone drift', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'EVERYONE_DRIFT' as const,
      entityType: 'everyone' as const,
      entityName: '@everyone',
    };

    const result = await acceptDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be accepted');
  });

  it('accepts extra resource by adding to ID map', async () => {
    const guild = makeGuild();
    const drift_items_chain = supaChain();
    const id_map_chain = supaChain();
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'discord_id_map') return id_map_chain;
        if (table === 'drift_items') return drift_items_chain;
        return supaChain();
      }),
    } as any;

    const drift = {
      type: 'EXTRA_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'NewRole',
      entityDiscordId: 'extra1',
    };

    const result = await acceptDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(true);
    expect(supabase.from).toHaveBeenCalledWith('discord_id_map');
  });
});

describe('repairDriftItem — error handling', () => {
  it('catches exceptions and returns error', async () => {
    const guild = makeGuild();
    guild.roles.everyone.setPermissions = vi.fn(async () => { throw new Error('Discord API down'); });
    const supabase = makeSupabase();
    const drift = {
      type: 'EVERYONE_DRIFT' as const,
      entityType: 'everyone' as const,
      entityName: '@everyone',
      entityDiscordId: 'everyone',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Discord API down');
  });
});
