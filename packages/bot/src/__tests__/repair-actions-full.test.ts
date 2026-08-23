/**
 * Repair Actions — Full tests
 *
 * Tests repairDriftItem and acceptDriftItem for all drift types:
 * EVERYONE_DRIFT, EXTERNAL_CHANGE, PERMISSION_DRIFT, MISSING_RESOURCE,
 * EXTRA_RESOURCE. Tests both success and error paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DriftItem } from '@somnibot/shared';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { repairDriftItem, acceptDriftItem, ignoreDriftItem } from '../sync/repair-actions.js';
import { canonicalTemplateKey } from '../deploy/deployer.js';
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
    permissions: { bitfield: 8n },
    color: 0x123456,
    hoist: true,
    mentionable: true,
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
    type: 0,
    position: 2,
    parentId: null,
    topic: 'user topic',
    nsfw: false,
    rateLimitPerUser: 5,
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

function makeIdentitySupabase(
  desiredChain: any,
  mappings: Array<Record<string, unknown>>,
  fallbackError: any = null,
) {
  function mappingChain() {
    const filters: Record<string, unknown> = {};
    const c: any = {};
    for (const m of ['select','insert','update','upsert','delete','neq','gte','lt','lte',
      'limit','order','in','head','filter','single','match']) {
      c[m] = vi.fn((..._: any[]) => c);
    }
    c.eq = vi.fn((key: string, value: unknown) => {
      filters[key] = value;
      return c;
    });
    c.maybeSingle = vi.fn(async () => ({
      data: mappings.find((mapping) =>
        Object.entries(filters).every(([key, value]) => mapping[key] === value),
      ) ?? null,
      error: null,
    }));
    c.then = (resolve: any) => resolve({ data: null, error: null });
    return c;
  }

  return {
    from: vi.fn((table: string) => {
      if (table === 'discord_id_map') return mappingChain();
      if (table === 'guild_desired_state') return desiredChain;
      return supaChain(null, fallbackError);
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
  it('leaves an untracked user role untouched and requires manual review', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'EXTRA_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'ExtraRole',
      entityDiscordId: 'extra1',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);

    expect(result).toEqual({
      success: false,
      error: 'Extra resources must be accepted or removed manually',
    });
    expect(guild.roles.cache.get('extra1').delete).not.toHaveBeenCalled();
  });

  it('leaves managed roles untouched and requires manual review', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'EXTRA_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'ManagedRole',
      entityDiscordId: 'managed1',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(false);
    expect(guild.roles.cache.get('managed1').delete).not.toHaveBeenCalled();
  });
});

describe('repairDriftItem — EXTRA_RESOURCE (channel)', () => {
  it('leaves an untracked user channel untouched and requires manual review', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'EXTRA_RESOURCE' as const,
      entityType: 'channel' as const,
      entityName: 'test-channel',
      entityDiscordId: 'ch1',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);

    expect(result.success).toBe(false);
    expect(guild.channels.cache.get('ch1').delete).not.toHaveBeenCalled();
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
    expect(result.error).toContain('accepted or removed manually');
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
      colors: { primaryColor: 0xFF0000 },
    }));
    expect(guild.roles.create.mock.calls[0][0]).not.toHaveProperty('color');
  });

  it('recreates a deleted role from a queued template key when the old Discord ID is absent', async () => {
    const guild = makeGuild();
    const idMapChain = supaChain({ template_key: 'role:moderator', entity_type: 'role' });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'discord_id_map') {
          return idMapChain;
        }
        if (table === 'guild_desired_state') {
          return supaChain({
            roles: [{ key: 'moderator', name: 'Moderator', permissions: '0', color: 0xFF0000 }],
            channels: [],
          });
        }
        return supaChain();
      }),
    } as any;

    const drift = {
      type: 'MISSING_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'Moderator',
      templateKey: 'moderator',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(true);
    expect(guild.roles.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Moderator',
      colors: { primaryColor: 0xFF0000 },
    }));
    expect(guild.roles.create.mock.calls[0][0]).not.toHaveProperty('color');
    expect(idMapChain.eq).toHaveBeenCalledWith('entity_type', 'role');
  });

  it('normalizes recreated role mappings to the prefixed template key format', async () => {
    const guild = makeGuild();
    const idMapChain = supaChain(null);
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'discord_id_map') return idMapChain;
        if (table === 'guild_desired_state') {
          return supaChain({
            roles: [{ key: 'moderator', name: 'Moderator', permissions: '0', color: 0xFF0000 }],
            channels: [],
          });
        }
        return supaChain();
      }),
    } as any;

    const drift = {
      type: 'MISSING_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'Moderator',
      templateKey: 'moderator',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(true);
    expect(idMapChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'role',
        template_key: 'role:moderator',
        discord_id: 'new-role',
      }),
      { onConflict: 'guild_id,entity_type,template_key' },
    );
  });

  it('fails channel permission repair instead of removing drift without fixing overwrites', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'PERMISSION_DRIFT' as const,
      entityType: 'channel' as const,
      entityName: 'general → mod',
      entityDiscordId: 'ch1',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain('permission drift repair requires manual review');
    expect(guild.channels.cache.get('ch1').edit).not.toHaveBeenCalled();
  });

  it('returns error when neither ID mapping nor desired config can identify the missing resource', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase({ discord_id_map: null });
    const drift = {
      type: 'MISSING_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'Unknown',
      entityDiscordId: 'gone',
      templateKey: 'unknown',
    };

    const result = await repairDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No desired config');
  });

  it('requires an ID mapping or template key before recreating a same-named missing role', async () => {
    const guild = makeGuild();
    const supabase = makeIdentitySupabase(
      supaChain({
        roles: [{ template_key: 'role:moderator', name: 'Moderator', permissions: '0' }],
        channels: [],
      }),
      [],
    );

    const drift = {
      type: 'MISSING_RESOURCE',
      severity: 'warning',
      entityType: 'role',
      entityName: 'Moderator',
      entityDiscordId: 'deleted-user-resource',
      description: 'A mapped role is missing from Discord.',
      suggestedAction: 'repair',
    } satisfies DriftItem;

    const result = await repairDriftItem(guild, supabase, drift);

    expect(result).toEqual({
      success: false,
      error: 'Missing resource has no ownership mapping or template key — manual review required',
    });
    expect(guild.roles.create).not.toHaveBeenCalled();
  });
});

// ── HIERARCHY_DRIFT (manual dashboard repair) ────────────────
// Codex round-2: the manual repair switch had no HIERARCHY_DRIFT case, so
// clicking "Repair" on a hierarchy drift item fell through to "Unknown drift
// type". These prove the dashboard path now performs the reorder the item
// advertises, and reports honest failures when the reorder is impossible.
describe('repairDriftItem — HIERARCHY_DRIFT', () => {
  // Guild whose roles cache carries positions + a bot highest role position.
  function makeHierarchyGuild(
    roles: Array<{ id: string; name: string; position: number; managed?: boolean }>,
    botHighestPosition: number,
    setPositions: ReturnType<typeof vi.fn>,
  ): any {
    const cache = new MockCollection();
    cache.set('everyone', { id: 'everyone', name: '@everyone', position: 0 });
    for (const r of roles) {
      const role = {
        managed: false,
        editable: r.managed !== true,
        ...r,
        setPosition: vi.fn(),
      };
      role.setPosition.mockImplementation(async (nextPosition: number) => {
        const previousPosition = role.position;
        for (const other of cache.values()) {
          if (other.id === role.id || typeof other.position !== 'number') continue;
          if (previousPosition < nextPosition
            && other.position > previousPosition
            && other.position <= nextPosition) {
            other.position -= 1;
          } else if (previousPosition > nextPosition
            && other.position >= nextPosition
            && other.position < previousPosition) {
            other.position += 1;
          }
        }
        role.position = nextPosition;
        return role;
      });
      cache.set(r.id, role);
    }
    return {
      id: 'g1',
      roles: {
        cache,
        everyone: cache.get('everyone'),
        setPositions,
        fetch: vi.fn(async () => cache),
      },
      channels: { cache: new MockCollection() },
      members: {
        me: {
          roles: {
            highest: { id: 'bot-role', position: botHighestPosition },
            cache: new Map([['bot-role', { id: 'bot-role' }]]),
          },
          permissions: { has: vi.fn(() => true) },
        },
      },
    };
  }

  // Supabase returning desired roles (guild_desired_state.roles) and role
  // mappings (discord_id_map list query).
  function makeHierarchySupabase(desiredRoles: any[], mappings: any[]): any {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain({ roles: desiredRoles });
        if (table === 'discord_id_map') return supaChain(mappings);
        return supaChain();
      }),
    };
  }

  it('reorders roles to desired relative positions with verified single-role moves', async () => {
    const desiredRoles = [
      { template_key: 'role:admin', name: 'Admin', position: 2 },
      { template_key: 'role:mod', name: 'Mod', position: 1 },
      { template_key: 'role:member', name: 'Member', position: 0 },
    ];
    const mappings = [
      { template_key: 'role:admin', discord_id: 'r-admin' },
      { template_key: 'role:mod', discord_id: 'r-mod' },
      { template_key: 'role:member', discord_id: 'r-member' },
    ];
    const setPositions = vi.fn(async (_updates: Array<{ role: string; position: number }>) => {});
    const guild = makeHierarchyGuild(
      [
        { id: 'r-admin', name: 'Admin', position: 3 },
        { id: 'r-mod', name: 'Mod', position: 10 }, // drifted above admin
        { id: 'r-member', name: 'Member', position: 5 },
      ],
      50,
      setPositions,
    );
    const supabase = makeHierarchySupabase(desiredRoles, mappings);

    const result = await repairDriftItem(guild, supabase, {
      type: 'HIERARCHY_DRIFT',
      entityType: 'role',
      entityName: 'Role hierarchy',
      entityDiscordId: 'r-mod',
      templateKey: 'mod',
    } as any);

    expect(result.success).toBe(true);
    expect(setPositions).not.toHaveBeenCalled();
    expect(guild.roles.cache.get('r-member').setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('r-mod').setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('r-admin').setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('r-member').position)
      .toBeLessThan(guild.roles.cache.get('r-mod').position);
    expect(guild.roles.cache.get('r-mod').position)
      .toBeLessThan(guild.roles.cache.get('r-admin').position);
    expect(writeAuditLog).toHaveBeenCalled();
  });

  it('is idempotent — no setPositions call when already ordered', async () => {
    const desiredRoles = [
      { template_key: 'role:admin', name: 'Admin', position: 1 },
      { template_key: 'role:member', name: 'Member', position: 0 },
    ];
    const mappings = [
      { template_key: 'role:admin', discord_id: 'r-admin' },
      { template_key: 'role:member', discord_id: 'r-member' },
    ];
    const setPositions = vi.fn(async () => {});
    const guild = makeHierarchyGuild(
      [
        { id: 'r-admin', name: 'Admin', position: 12 },
        { id: 'r-member', name: 'Member', position: 10 },
      ],
      50,
      setPositions,
    );
    const supabase = makeHierarchySupabase(desiredRoles, mappings);

    const result = await repairDriftItem(guild, supabase, {
      type: 'HIERARCHY_DRIFT',
      entityType: 'role',
      entityName: 'Role hierarchy',
      entityDiscordId: 'r-admin',
      templateKey: 'admin',
    } as any);

    expect(result.success).toBe(true);
    expect(setPositions).not.toHaveBeenCalled();
  });

  it('fails when a participating desired role sits at/above the bot (no false success)', async () => {
    // Desired member < admin. member is above the bot, admin below. The
    // representative target is admin (movable), but member cannot be moved, so a
    // correct full reorder is impossible — must report failure, not reorder only
    // admin and claim success.
    const desiredRoles = [
      { template_key: 'role:admin', name: 'Admin', position: 1 },
      { template_key: 'role:member', name: 'Member', position: 0 },
    ];
    const mappings = [
      { template_key: 'role:admin', discord_id: 'r-admin' },
      { template_key: 'role:member', discord_id: 'r-member' },
    ];
    const setPositions = vi.fn(async () => {});
    const guild = makeHierarchyGuild(
      [
        { id: 'r-admin', name: 'Admin', position: 5 },   // below bot (10)
        { id: 'r-member', name: 'Member', position: 20 }, // above bot → blocker
      ],
      10,
      setPositions,
    );
    const supabase = makeHierarchySupabase(desiredRoles, mappings);

    const result = await repairDriftItem(guild, supabase, {
      type: 'HIERARCHY_DRIFT',
      entityType: 'role',
      entityName: 'Role hierarchy',
      entityDiscordId: 'r-admin', // movable target
      templateKey: 'admin',
    } as any);

    expect(result.success).toBe(false);
    expect(setPositions).not.toHaveBeenCalled();
    expect(result.error).toContain('at or above the bot');
  });

  it('rejects hierarchy repair for non-role entities', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const result = await repairDriftItem(guild, supabase, {
      type: 'HIERARCHY_DRIFT',
      entityType: 'channel',
      entityName: 'nope',
    } as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Hierarchy repair not supported');
  });
});

// ── EXTERNAL_CHANGE on a category (no persisted desired state) ────────
describe('repairDriftItem — EXTERNAL_CHANGE (category)', () => {
  it('reports manual review instead of misrouting to the channel helper', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const result = await repairDriftItem(guild, supabase, {
      type: 'EXTERNAL_CHANGE',
      entityType: 'category',
      entityName: 'My Category',
      entityDiscordId: 'cat1',
    } as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('manual review');
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

describe('ignoreDriftItem', () => {
  it('removes only the selected same-named resource when its Discord ID is present', async () => {
    const selected = {
      type: 'EXTRA_RESOURCE',
      severity: 'info',
      entityType: 'channel',
      entityName: 'support',
      entityDiscordId: 'channel-one',
      description: 'An untracked channel exists in Discord.',
      suggestedAction: 'accept',
    } satisfies DriftItem;
    const remaining = {
      type: 'EXTRA_RESOURCE',
      severity: 'info',
      entityType: 'channel',
      entityName: 'support',
      entityDiscordId: 'channel-two',
      description: 'Another untracked channel exists in Discord.',
      suggestedAction: 'accept',
    } satisfies DriftItem;
    const desiredStateChain = supaChain({ drift_details: [selected, remaining] });
    const supabase = {
      from: vi.fn((table: string) => table === 'guild_desired_state' ? desiredStateChain : supaChain()),
    } as unknown as Parameters<typeof ignoreDriftItem>[0];

    const result = await ignoreDriftItem(supabase, 'g1', selected);

    expect(result.success).toBe(true);
    expect(desiredStateChain.update).toHaveBeenCalledWith({
      drift_detected: true,
      drift_details: [remaining],
    });
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

  it('accepts an extra role into desired state with a mapping the safe deploy path recognizes', async () => {
    const guild = makeGuild();
    const desiredStateChain = supaChain({ roles: [], channels: [], categories: [], drift_details: [] });
    const id_map_chain = supaChain();
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'discord_id_map') return id_map_chain;
        if (table === 'guild_desired_state') return desiredStateChain;
        return supaChain();
      }),
    } as unknown as Parameters<typeof acceptDriftItem>[1];

    const drift = {
      type: 'EXTRA_RESOURCE' as const,
      entityType: 'role' as const,
      entityName: 'NewRole',
      entityDiscordId: 'extra1',
    };

    const result = await acceptDriftItem(guild, supabase, drift as any);
    expect(result.success).toBe(true);
    const acceptedKey = 'accepted-extra1';
    expect(desiredStateChain.update).toHaveBeenCalledWith(expect.objectContaining({
      roles: [expect.objectContaining({
        key: acceptedKey,
        name: 'ExtraRole',
        permissions: '8',
        color: 0x123456,
      })],
    }));
    expect(id_map_chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'role',
        template_key: canonicalTemplateKey('role', acceptedKey),
        discord_id: 'extra1',
      }),
      { onConflict: 'guild_id,entity_type,template_key' },
    );
  });

  it('accepts an extra channel into desired state with a mapping the safe deploy path recognizes', async () => {
    const guild = makeGuild();
    const overwrites = new MockCollection();
    overwrites.set('g1', {
      id: 'g1',
      allow: { bitfield: 1024n },
      deny: { bitfield: 8n },
    });
    overwrites.set('role-member', {
      id: 'role-member',
      allow: { bitfield: 2048n },
      deny: { bitfield: 16n },
    });
    guild.channels.cache.get('ch1').permissionOverwrites = { cache: overwrites };
    const desiredStateChain = supaChain({ roles: [], channels: [], categories: [], drift_details: [] });
    const idMapChain = supaChain([
      { entity_type: 'role', template_key: 'role:member', discord_id: 'role-member' },
    ]);
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'discord_id_map') return idMapChain;
        if (table === 'guild_desired_state') return desiredStateChain;
        return supaChain();
      }),
    } as unknown as Parameters<typeof acceptDriftItem>[1];

    const drift = {
      type: 'EXTRA_RESOURCE',
      severity: 'info',
      entityType: 'channel',
      entityName: 'test-channel',
      entityDiscordId: 'ch1',
      description: 'An untracked channel exists in Discord.',
      suggestedAction: 'accept',
    } satisfies DriftItem;

    const result = await acceptDriftItem(guild, supabase, drift);

    expect(result.success).toBe(true);
    const acceptedKey = 'accepted-ch1';
    expect(desiredStateChain.update).toHaveBeenCalledWith(expect.objectContaining({
      channels: [expect.objectContaining({
        key: acceptedKey,
        name: 'test-channel',
        categoryKey: null,
        type: 0,
        topic: 'user topic',
        slowmode: 5,
        overrides: [
          { roleKey: 'everyone', allow: '1024', deny: '8' },
          { roleKey: 'member', allow: '2048', deny: '16' },
        ],
      })],
    }));
    expect(idMapChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'channel',
        template_key: canonicalTemplateKey('channel', acceptedKey),
        discord_id: 'ch1',
      }),
      { onConflict: 'guild_id,entity_type,template_key' },
    );
  });

  it('refuses channel adoption when managed overwrite ownership cannot be read', async () => {
    const guild = makeGuild();
    const desiredStateChain = supaChain({ roles: [], channels: [], categories: [], drift_details: [] });
    const idMapChain = supaChain(null, { message: 'mapping unavailable' });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'discord_id_map') return idMapChain;
        if (table === 'guild_desired_state') return desiredStateChain;
        return supaChain();
      }),
    } as unknown as Parameters<typeof acceptDriftItem>[1];
    const drift = {
      type: 'EXTRA_RESOURCE',
      severity: 'info',
      entityType: 'channel',
      entityName: 'test-channel',
      entityDiscordId: 'ch1',
      description: 'An untracked channel exists in Discord.',
      suggestedAction: 'accept',
    } satisfies DriftItem;

    const result = await acceptDriftItem(guild, supabase, drift);

    expect(result).toEqual({
      success: false,
      error: 'Could not verify managed permission overwrites for the extra channel',
    });
    expect(desiredStateChain.update).not.toHaveBeenCalled();
    expect(idMapChain.upsert).not.toHaveBeenCalled();
  });

  it('restores desired state when recording adopted ownership fails', async () => {
    const guild = makeGuild();
    const originalState = { roles: [], channels: [], categories: [], drift_details: [] };
    const desiredStateChain = supaChain(originalState);
    const idMapChain = supaChain(null, { message: 'mapping write failed' });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'discord_id_map') return idMapChain;
        if (table === 'guild_desired_state') return desiredStateChain;
        return supaChain();
      }),
    } as unknown as Parameters<typeof acceptDriftItem>[1];
    const drift = {
      type: 'EXTRA_RESOURCE',
      severity: 'info',
      entityType: 'role',
      entityName: 'ExtraRole',
      entityDiscordId: 'extra1',
      description: 'An untracked role exists in Discord.',
      suggestedAction: 'accept',
    } satisfies DriftItem;

    const result = await acceptDriftItem(guild, supabase, drift);

    expect(result.success).toBe(false);
    expect(desiredStateChain.update).toHaveBeenCalledTimes(2);
    expect(desiredStateChain.update).toHaveBeenLastCalledWith({
      roles: originalState.roles,
      channels: originalState.channels,
      categories: originalState.categories,
    });
  });

  it('rejects unstructured channel permission drift accept instead of removing drift without updating overwrites', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase();
    const drift = {
      type: 'PERMISSION_DRIFT' as const,
      entityType: 'channel' as const,
      entityName: 'general -> Moderator',
      entityDiscordId: 'ch1',
    };

    const result = await acceptDriftItem(guild, supabase, drift as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain('structured permission overwrite details');
    expect(writeAuditLog).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'drift.accepted' }),
    );
    expect(supabase.from).not.toHaveBeenCalledWith('guild_desired_state');
  });

  it('accepts structured channel permission drift by updating desired overwrites to Discord reality', async () => {
    const guild = makeGuild();
    const overwriteCache = new MockCollection();
    overwriteCache.set('role-1', {
      id: 'role-1',
      allow: { bitfield: 1024n },
      deny: { bitfield: 8n },
    });
    guild.channels.cache.get('ch1').permissionOverwrites = { cache: overwriteCache };

    const desiredChain = supaChain({
      channels: [{
        key: 'general',
        name: 'general',
        overrides: [{ roleKey: 'moderator', allow: '2048', deny: '0' }],
      }],
      drift_details: [{
        type: 'PERMISSION_DRIFT',
        entityType: 'channel',
        entityName: 'general → moderator',
      }],
    });
    const supabase = makeIdentitySupabase(desiredChain, [
      { guild_id: 'g1', entity_type: 'channel', template_key: 'general', discord_id: 'ch1' },
      { guild_id: 'g1', entity_type: 'role', template_key: 'moderator', discord_id: 'role-1' },
    ]);
    const drift = {
      type: 'PERMISSION_DRIFT' as const,
      entityType: 'channel' as const,
      entityName: 'general → moderator',
      entityDiscordId: 'ch1',
      templateKey: 'general',
      details: {
        overrideChannelKey: { expected: 'general', actual: 'general' },
        overrideRoleKey: { expected: 'moderator', actual: 'moderator' },
        overrideRoleId: { expected: 'role-1', actual: 'role-1' },
        overrideAction: { expected: 'update', actual: 'update' },
        allow: { expected: '2048', actual: '1024' },
        deny: { expected: '0', actual: '8' },
      },
    };

    const result = await acceptDriftItem(guild, supabase, drift as any);

    expect(result.success).toBe(true);
    expect(desiredChain.update).toHaveBeenCalledWith(expect.objectContaining({
      channels: [expect.objectContaining({
        key: 'general',
        overrides: [expect.objectContaining({
          roleKey: 'moderator',
          allow: '1024',
          deny: '8',
        })],
      })],
    }));
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'drift.accepted',
        targetType: 'channel',
        targetId: 'ch1',
      }),
    );
  });

  it('accepts a missing Discord overwrite by removing the desired override', async () => {
    const guild = makeGuild();
    guild.channels.cache.get('ch1').permissionOverwrites = { cache: new MockCollection() };

    const desiredChain = supaChain({
      channels: [{
        key: 'general',
        name: 'general',
        overrides: [{ roleKey: 'moderator', allow: '2048', deny: '0' }],
      }],
      drift_details: [{
        type: 'PERMISSION_DRIFT',
        entityType: 'channel',
        entityName: 'general → moderator',
      }],
    });
    const supabase = makeIdentitySupabase(desiredChain, [
      { guild_id: 'g1', entity_type: 'channel', template_key: 'general', discord_id: 'ch1' },
      { guild_id: 'g1', entity_type: 'role', template_key: 'moderator', discord_id: 'role-1' },
    ]);
    const drift = {
      type: 'PERMISSION_DRIFT' as const,
      entityType: 'channel' as const,
      entityName: 'general → moderator',
      entityDiscordId: 'ch1',
      templateKey: 'general',
      details: {
        overrideChannelKey: { expected: 'general', actual: 'general' },
        overrideRoleKey: { expected: 'moderator', actual: 'moderator' },
        overrideRoleId: { expected: 'role-1', actual: 'role-1' },
        overrideAction: { expected: 'create', actual: 'create' },
        allow: { expected: '2048', actual: '0' },
        deny: { expected: '0', actual: '0' },
      },
    };

    const result = await acceptDriftItem(guild, supabase, drift as any);

    expect(result.success).toBe(true);
    expect(desiredChain.update).toHaveBeenCalledWith(expect.objectContaining({
      channels: [expect.objectContaining({
        key: 'general',
        overrides: [],
      })],
    }));
  });

  it('rejects structured channel permission drift when channel key and Discord ID do not match', async () => {
    const guild = makeGuild();
    const overwriteCache = new MockCollection();
    overwriteCache.set('role-1', {
      id: 'role-1',
      allow: { bitfield: 1024n },
      deny: { bitfield: 0n },
    });
    guild.channels.cache.get('ch1').permissionOverwrites = { cache: overwriteCache };

    const desiredChain = supaChain({
      channels: [{ key: 'general', name: 'general', overrides: [{ roleKey: 'moderator', allow: '2048', deny: '0' }] }],
      drift_details: [],
    });
    const supabase = makeIdentitySupabase(desiredChain, [
      { guild_id: 'g1', entity_type: 'channel', template_key: 'general', discord_id: 'different-channel' },
      { guild_id: 'g1', entity_type: 'role', template_key: 'moderator', discord_id: 'role-1' },
    ]);
    const drift = {
      type: 'PERMISSION_DRIFT' as const,
      entityType: 'channel' as const,
      entityName: 'general → moderator',
      entityDiscordId: 'ch1',
      templateKey: 'general',
      details: {
        overrideRoleKey: { expected: 'moderator', actual: 'moderator' },
        overrideRoleId: { expected: 'role-1', actual: 'role-1' },
      },
    };

    const result = await acceptDriftItem(guild, supabase, drift as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain('channel key does not match');
    expect(desiredChain.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'drift.accepted' }),
    );
  });

  it('rejects structured channel permission drift when role key and Discord ID do not match', async () => {
    const guild = makeGuild();
    const overwriteCache = new MockCollection();
    overwriteCache.set('role-2', {
      id: 'role-2',
      allow: { bitfield: 1024n },
      deny: { bitfield: 0n },
    });
    guild.channels.cache.get('ch1').permissionOverwrites = { cache: overwriteCache };

    const desiredChain = supaChain({
      channels: [{ key: 'general', name: 'general', overrides: [{ roleKey: 'moderator', allow: '2048', deny: '0' }] }],
      drift_details: [],
    });
    const supabase = makeIdentitySupabase(desiredChain, [
      { guild_id: 'g1', entity_type: 'channel', template_key: 'general', discord_id: 'ch1' },
      { guild_id: 'g1', entity_type: 'role', template_key: 'moderator', discord_id: 'role-1' },
    ]);
    const drift = {
      type: 'PERMISSION_DRIFT' as const,
      entityType: 'channel' as const,
      entityName: 'general → moderator',
      entityDiscordId: 'ch1',
      templateKey: 'general',
      details: {
        overrideRoleKey: { expected: 'moderator', actual: 'moderator' },
        overrideRoleId: { expected: 'role-2', actual: 'role-2' },
      },
    };

    const result = await acceptDriftItem(guild, supabase, drift as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain('role key does not match');
    expect(desiredChain.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'drift.accepted' }),
    );
  });

  it('does not clear drift or audit success when desired-state overwrite update fails', async () => {
    const guild = makeGuild();
    const overwriteCache = new MockCollection();
    overwriteCache.set('role-1', {
      id: 'role-1',
      allow: { bitfield: 1024n },
      deny: { bitfield: 0n },
    });
    guild.channels.cache.get('ch1').permissionOverwrites = { cache: overwriteCache };

    const desiredChain = supaChain({
      channels: [{ key: 'general', name: 'general', overrides: [{ roleKey: 'moderator', allow: '2048', deny: '0' }] }],
      drift_details: [{ type: 'PERMISSION_DRIFT', entityType: 'channel', entityName: 'general → moderator' }],
    }, { message: 'update failed' });
    const supabase = makeIdentitySupabase(desiredChain, [
      { guild_id: 'g1', entity_type: 'channel', template_key: 'general', discord_id: 'ch1' },
      { guild_id: 'g1', entity_type: 'role', template_key: 'moderator', discord_id: 'role-1' },
    ]);
    const drift = {
      type: 'PERMISSION_DRIFT' as const,
      entityType: 'channel' as const,
      entityName: 'general → moderator',
      entityDiscordId: 'ch1',
      templateKey: 'general',
      details: {
        overrideRoleKey: { expected: 'moderator', actual: 'moderator' },
        overrideRoleId: { expected: 'role-1', actual: 'role-1' },
      },
    };

    const result = await acceptDriftItem(guild, supabase, drift as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to update desired channel overwrites');
    expect(desiredChain.update).toHaveBeenCalledWith(expect.objectContaining({ channels: expect.any(Array) }));
    expect(writeAuditLog).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'drift.accepted' }),
    );
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
