/**
 * Deployer — Full tests
 *
 * Tests deployServerState: pre-flight checks (bot position, permissions),
 * dry run, @everyone zeroing, clean existing (channels/roles/bot messages),
 * role creation, category creation, channel creation, error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheckBotRolePosition = vi.fn(async (): Promise<any> => ({
  isTopPosition: true,
  botRolePosition: 10,
  totalRoles: 5,
  rolesAboveBot: [],
  canManageAllRoles: true,
}));

const mockCheckBotPermissions = vi.fn((): any => ({
  hasRequired: true,
  missing: [],
}));

vi.mock('discord.js', () => ({
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
  PermissionsBitField: class {
    static Flags = { ViewChannel: 1n, SendMessages: 2n };
    constructor(public bitfield: bigint = 0n) {}
  },
}));

vi.mock('../guards/bot-role-guard.js', () => ({
  checkBotRolePosition: (...args: unknown[]) => mockCheckBotRolePosition(...(args as Parameters<typeof mockCheckBotRolePosition>)),
  checkBotPermissions: (...args: unknown[]) => mockCheckBotPermissions(...(args as Parameters<typeof mockCheckBotPermissions>)),
}));

import { deployServerState, type DeployOptions } from '../deploy/deployer.js';

// ── Helpers ──────────────────────────────────────────────
class MockCollection extends Map {
  filter(fn: (v: any, k: string) => boolean): MockCollection {
    const result = new MockCollection();
    for (const [k, v] of this) if (fn(v, k)) result.set(k, v);
    return result;
  }
  sort(fn: (a: any, b: any) => number): MockCollection {
    const arr = [...this.values()].sort(fn);
    const result = new MockCollection();
    for (const v of arr) result.set(v.id, v);
    return result;
  }
  find(fn: (v: any, k: string) => boolean): any {
    for (const [k, v] of this) if (fn(v, k)) return v;
    return undefined;
  }
}

function makeGuild(overrides: Record<string, any> = {}) {
  const roles = new MockCollection();
  const everyone = {
    id: 'g1', name: '@everyone', managed: false, position: 0,
    setPermissions: vi.fn(async () => {}),
  };
  roles.set('g1', everyone);

  const channels = new MockCollection();
  const createRole = vi.fn(async (opts: any) => {
    for (const role of roles.values()) {
      if (role.id !== 'g1' && typeof role.position === 'number') {
        role.position += 1;
      }
    }
    const role = {
      id: `new-role-${opts.name}`,
      name: opts.name,
      position: 1,
      editable: true,
      managed: false,
      ...opts,
    };
    role.setPosition = vi.fn(async (nextPosition: number) => {
      const previousPosition = role.position;
      for (const other of roles.values()) {
        if (other.id === role.id || other.id === 'g1' || typeof other.position !== 'number') continue;
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
    roles.set(role.id, role);
    return role;
  });

  return {
    id: 'g1',
    roles: {
      cache: roles,
      everyone,
      create: createRole,
      fetch: vi.fn(async () => roles),
      setPositions: vi.fn(async (updates: Array<{ role: string; position: number }>) => {
        // Simulate Discord: apply the requested positions; unlisted roles
        // (managed ones included) are displaced implicitly by the reorder.
        for (const { role: id, position } of updates) {
          const role = roles.get(id);
          if (role) role.position = position;
        }
        return undefined;
      }),
    },
    channels: {
      cache: channels,
      create: vi.fn(async (opts: any) => ({ id: `new-ch-${opts.name}`, name: opts.name, ...opts })),
    },
    rulesChannelId: null,
    publicUpdatesChannelId: null,
    members: {
      me: {
        roles: {
          highest: { position: 10 },
          cache: new Map([['bot-role', { id: 'bot-role' }]]),
        },
        permissions: { has: vi.fn(() => true) },
      },
    },
    client: { user: { id: 'bot1' } },
    ...overrides,
  };
}

function supaChain(data: any = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','limit',
    'order','in','filter','maybeSingle','single','match','then']) {
    c[m] = vi.fn((..._: any[]) => c);
  }
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = (resolve: any) => resolve({ data, error });
  return c;
}

const defaultDesiredState = {
  everyonePermissions: '0',
  roles: [],
  categories: [],
  channels: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckBotRolePosition.mockResolvedValue({
    isTopPosition: true, botRolePosition: 10, totalRoles: 5,
    rolesAboveBot: [], canManageAllRoles: true,
  });
  mockCheckBotPermissions.mockReturnValue({ hasRequired: true, missing: [] });
});

describe('deployServerState — pre-flight', () => {
  it('fails when bot role is not top position', async () => {
    mockCheckBotRolePosition.mockResolvedValueOnce({
      isTopPosition: false, botRolePosition: 3, totalRoles: 5,
      rolesAboveBot: [{ id: 'r1', name: 'Admin', position: 5 }],
      canManageAllRoles: false,
    } as any);

    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const options: DeployOptions = { cleanExisting: false, dryRun: false };

    const result = await deployServerState(guild as any, supabase, defaultDesiredState as any, options);

    expect(result.success).toBe(false);
    expect(result.errors[0].error).toContain('Bot role is not at position #1');
  });

  it('fails when missing required permissions', async () => {
    mockCheckBotPermissions.mockReturnValueOnce({
      hasRequired: false,
      missing: ['ManageRoles', 'ManageChannels'],
    } as any);

    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const options: DeployOptions = { cleanExisting: false, dryRun: false };

    const result = await deployServerState(guild as any, supabase, defaultDesiredState as any, options);

    expect(result.success).toBe(false);
    expect(result.errors[0].error).toContain('Missing permissions');
  });
});

describe('deployServerState — dry run', () => {
  it('returns success without making any changes', async () => {
    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const options: DeployOptions = { cleanExisting: false, dryRun: true };

    const result = await deployServerState(guild as any, supabase, defaultDesiredState as any, options);

    expect(result.success).toBe(true);
    expect(result.actions).toEqual([]);
    expect(guild.roles.everyone.setPermissions).not.toHaveBeenCalled();
  });
});

describe('deployServerState — @everyone', () => {
  it('preserves @everyone permissions during a safe deploy', async () => {
    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const options: DeployOptions = { cleanExisting: false, dryRun: false };

    const desiredState = { ...defaultDesiredState };
    const result = await deployServerState(guild as any, supabase, desiredState as any, options);

    expect(guild.roles.everyone.setPermissions).not.toHaveBeenCalled();
    const evAction = result.actions.find(a => a.entityType === 'everyone');
    expect(evAction).toBeUndefined();
  });

  it('sets @everyone permissions to 0 during a destructive deploy', async () => {
    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) };
    const options: DeployOptions = { cleanExisting: true, dryRun: false };

    const desiredState = { ...defaultDesiredState };
    const result = await deployServerState(
      guild as unknown as Parameters<typeof deployServerState>[0],
      supabase as unknown as Parameters<typeof deployServerState>[1],
      desiredState as unknown as Parameters<typeof deployServerState>[2],
      options,
    );

    expect(guild.roles.everyone.setPermissions).toHaveBeenCalledWith(0n, expect.any(String));
    const evAction = result.actions.find(a => a.entityType === 'everyone');
    expect(evAction?.success).toBe(true);
  });

  it('records error when @everyone setPermissions fails', async () => {
    const guild = makeGuild();
    guild.roles.everyone.setPermissions = vi.fn(async () => { throw new Error('Forbidden'); });

    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const options: DeployOptions = { cleanExisting: true, dryRun: false };

    const result = await deployServerState(guild as any, supabase, defaultDesiredState as any, options);

    const evAction = result.actions.find(a => a.entityType === 'everyone');
    expect(evAction?.success).toBe(false);
    expect(evAction?.error).toContain('Forbidden');
  });
});

describe('deployServerState — role creation', () => {
  it('creates roles from desired state', async () => {
    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const options: DeployOptions = { cleanExisting: false, dryRun: false };

    const desiredState = {
      ...defaultDesiredState,
      roles: [
        { key: 'mod', name: 'Moderator', color: 0x00FF00, permissions: '0', hoist: true, mentionable: false, position: 2 },
        { key: 'member', name: 'Member', color: 0x0000FF, permissions: '0', hoist: false, mentionable: true, position: 1 },
      ],
    };

    const result = await deployServerState(guild as any, supabase, desiredState as any, options);

    expect(guild.roles.create).toHaveBeenCalledTimes(2);
    expect(guild.roles.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Moderator',
      colors: { primaryColor: 0x00FF00 },
      hoist: true,
    }));
  });

  it('refreshes role positions and keeps every created role below the bot', async () => {
    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const options: DeployOptions = { cleanExisting: false, dryRun: false };

    guild.roles.fetch.mockImplementationOnce(async () => {
      guild.members.me.roles.highest.position = 3;
      return guild.roles.cache;
    });

    const desiredState = {
      ...defaultDesiredState,
      roles: [
        { key: 'member', name: 'Member', color: 0, permissions: '0', hoist: false, mentionable: false, position: 0 },
        { key: 'admin', name: 'Admin', color: 0, permissions: '8', hoist: true, mentionable: false, position: 1 },
      ],
    };

    const result = await deployServerState(guild as any, supabase, desiredState as any, options);

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(guild.roles.fetch).toHaveBeenCalledTimes(5);
    expect(guild.roles.cache.get('new-role-Member')?.setPosition)
      .toHaveBeenCalledWith(2, expect.objectContaining({ reason: expect.any(String) }));
    expect(guild.roles.cache.get('new-role-Admin')?.setPosition)
      .toHaveBeenCalledWith(2, expect.objectContaining({ reason: expect.any(String) }));
    expect(guild.roles.fetch.mock.invocationCallOrder[0])
      .toBeLessThan(
        guild.roles.cache.get('new-role-Member')?.setPosition.mock.invocationCallOrder[0],
      );
  });

  it('places newly deployed staff above surviving ordinary member roles', async () => {
    const guild = makeGuild();
    guild.roles.cache.set('surviving-member', {
      id: 'surviving-member',
      name: 'Existing Member',
      position: 5,
      managed: false,
      editable: true,
    });
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const desiredState = {
      ...defaultDesiredState,
      roles: [
        { key: 'member', name: 'Member', color: 0, permissions: '0', hoist: false, mentionable: false, position: 0 },
        { key: 'admin', name: 'Admin', color: 0, permissions: '8', hoist: true, mentionable: false, position: 1 },
      ],
    };

    const result = await deployServerState(
      guild as any,
      supabase,
      desiredState as any,
      { cleanExisting: false, dryRun: false },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(guild.roles.cache.get('new-role-Member')?.setPosition)
      .toHaveBeenCalledWith(9, expect.objectContaining({ reason: expect.any(String) }));
    expect(guild.roles.cache.get('new-role-Admin')?.setPosition)
      .toHaveBeenCalledWith(9, expect.objectContaining({ reason: expect.any(String) }));
  });

  it('ignores a managed role far below the target band even after creation (round 13 P1)', async () => {
    // Preflight scopes the barrier scan to the target band [botHighest - N,
    // botHighest). The post-create check compared against the roles' initial
    // bottom-of-list creation positions instead, so a low integration role
    // that PASSED preflight failed the deployment after roles were already
    // created (and, with cleanExisting, after deletions).
    const guild = makeGuild();
    guild.roles.cache.set('managed-low', {
      id: 'managed-low',
      name: 'Integration Low',
      position: 2,
      managed: true,
      editable: false,
    });
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const desiredState = {
      ...defaultDesiredState,
      roles: [
        { key: 'member', name: 'Member', color: 0, permissions: '0', hoist: false, mentionable: false, position: 0 },
        { key: 'admin', name: 'Admin', color: 0, permissions: '8', hoist: true, mentionable: false, position: 1 },
      ],
    };

    const result = await deployServerState(
      guild as any,
      supabase,
      desiredState as any,
      { cleanExisting: false, dryRun: false },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(guild.roles.cache.get('new-role-Member')?.setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('new-role-Admin')?.setPosition).toHaveBeenCalled();
  });

  it('clean-existing deploy proceeds past a managed survivor and raises the created role above it (round 26 P1)', async () => {
    // Managed integration role at 2, deletable padding at 3..8, bot at 10,
    // one desired role. Round 15 projected the post-clean collapse and
    // REJECTED this deploy up front — but managed roles are not immovable:
    // raising the created role displaces the survivor implicitly, so the
    // hierarchy lands and the preflight rejection only broke deployments in
    // guilds that contain any other bot's role.
    const guild = makeGuild();
    guild.roles.cache.set('managed-low', {
      id: 'managed-low',
      name: 'Integration Low',
      position: 2,
      managed: true,
      editable: false,
    });
    for (let position = 3; position <= 8; position++) {
      const id = `old-role-${position}`;
      guild.roles.cache.set(id, {
        id,
        name: `Old ${position}`,
        position,
        managed: false,
        editable: true,
        delete: vi.fn(async () => {
          guild.roles.cache.delete(id);
        }),
      });
    }
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const desiredState = {
      ...defaultDesiredState,
      roles: [
        { key: 'admin', name: 'Admin', color: 0, permissions: '8', hoist: true, mentionable: false, position: 0 },
      ],
    };

    const result = await deployServerState(
      guild as any,
      supabase,
      desiredState as any,
      { cleanExisting: true, dryRun: false },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(guild.roles.create).toHaveBeenCalledTimes(1);
    expect(guild.roles.cache.get('new-role-Admin')?.setPosition)
      .toHaveBeenCalledWith(9, expect.objectContaining({ reason: expect.any(String) }));
    // The managed survivor was displaced beneath the deployed role, not
    // treated as a barrier.
    expect(
      (guild.roles.cache.get('new-role-Admin') as { position: number }).position,
    ).toBe(9);
  });

  it('raises created roles above an in-band managed role instead of aborting (round 26 P1)', async () => {
    const guild = makeGuild();
    guild.roles.cache.set('managed-member', {
      id: 'managed-member',
      name: 'Integration Member',
      position: 9,
      managed: true,
      editable: false,
    });
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const desiredState = {
      ...defaultDesiredState,
      roles: [
        { key: 'member', name: 'Member', color: 0, permissions: '0', hoist: false, mentionable: false, position: 0 },
        { key: 'admin', name: 'Admin', color: 0, permissions: '8', hoist: true, mentionable: false, position: 1 },
      ],
    };

    const result = await deployServerState(
      guild as any,
      supabase,
      desiredState as any,
      { cleanExisting: false, dryRun: false },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(guild.roles.cache.get('new-role-Member')?.setPosition)
      .toHaveBeenCalledWith(9, expect.objectContaining({ reason: expect.any(String) }));
    expect(guild.roles.cache.get('new-role-Admin')?.setPosition)
      .toHaveBeenCalledWith(9, expect.objectContaining({ reason: expect.any(String) }));
  });

  it('moves each role below the bot without an absolute hierarchy batch', async () => {
    const guild = makeGuild();
    guild.roles.cache.set('managed-member', {
      id: 'managed-member',
      name: 'Integration Member',
      position: 9,
      managed: true,
      editable: false,
    });
    const supabase = { from: vi.fn(() => supaChain()) };
    const desiredState = {
      ...defaultDesiredState,
      roles: [
        { key: 'member', name: 'Member', color: 0, permissions: '0', hoist: false, mentionable: false, position: 0 },
        { key: 'admin', name: 'Admin', color: 0, permissions: '8', hoist: true, mentionable: false, position: 1 },
      ],
    };

    const result = await deployServerState(
      guild as unknown as Parameters<typeof deployServerState>[0],
      supabase as unknown as Parameters<typeof deployServerState>[1],
      desiredState as unknown as Parameters<typeof deployServerState>[2],
      { cleanExisting: false, dryRun: false },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(guild.roles.setPositions).not.toHaveBeenCalled();
    expect(guild.roles.cache.get('new-role-Member')?.setPosition).toHaveBeenCalled();
    expect(guild.roles.cache.get('new-role-Admin')?.setPosition).toHaveBeenCalled();
  });

  it('stops role moves immediately when the deployment lease is lost mid-hierarchy', async () => {
    const abortController = new AbortController();
    const guild = makeGuild();
    const originalCreate = guild.roles.create;
    let created = 0;
    guild.roles.create = vi.fn(async (options) => {
      const role = await originalCreate(options);
      created++;
      if (created === 1) {
        const moveRole = role.setPosition;
        role.setPosition = vi.fn(async (...args: Parameters<typeof moveRole>) => {
          const moved = await moveRole(...args);
          abortController.abort(new Error('deployment lease lost'));
          return moved;
        });
      }
      return role;
    });
    const supabase = { from: vi.fn(() => supaChain()) };
    const desiredState = {
      ...defaultDesiredState,
      roles: [
        { key: 'member', name: 'Member', color: 0, permissions: '0', hoist: false, mentionable: false, position: 0 },
        { key: 'admin', name: 'Admin', color: 0, permissions: '8', hoist: true, mentionable: false, position: 1 },
      ],
    };

    const result = await deployServerState(
      guild as unknown as Parameters<typeof deployServerState>[0],
      supabase as unknown as Parameters<typeof deployServerState>[1],
      desiredState as unknown as Parameters<typeof deployServerState>[2],
      { cleanExisting: false, dryRun: false, abortSignal: abortController.signal },
    );

    expect(result.success).toBe(false);
    expect(result.errors.at(-1)?.error).toContain('deployment lease lost');
    expect(guild.roles.cache.get('new-role-Member')?.setPosition).toHaveBeenCalledTimes(1);
    expect(guild.roles.cache.get('new-role-Admin')?.setPosition).not.toHaveBeenCalled();
    expect(guild.channels.create).not.toHaveBeenCalled();
  });

  it('reports honestly when a role Discord did not displace remains inside the band', async () => {
    // Outcome verification: if the reorder does NOT actually raise the
    // created roles above an interloper, step 4 must fail loudly instead of
    // claiming success with an ineffective hierarchy.
    const guild = makeGuild();
    guild.roles.cache.set('managed-member', {
      id: 'managed-member',
      name: 'Integration Member',
      position: 8,
      managed: true,
      editable: false,
    });
    guild.roles.fetch.mockImplementation(async () => {
      const role = guild.roles.cache.get('new-role-Admin');
      if (role) role.setPosition = vi.fn(async () => role);
      return guild.roles.cache;
    });
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const desiredState = {
      ...defaultDesiredState,
      roles: [
        { key: 'admin', name: 'Admin', color: 0, permissions: '8', hoist: true, mentionable: false, position: 0 },
      ],
    };

    const result = await deployServerState(
      guild as any,
      supabase,
      desiredState as any,
      { cleanExisting: false, dryRun: false },
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((error) =>
      error.error.includes('did not preserve the reviewed role hierarchy'),
    )).toBe(true);
  });

  it('dry run succeeds with an in-band managed role and mutates nothing (round 26 P1)', async () => {
    // Managed roles are displaced by the reorder, not barriers — a dry run
    // must not reject the very deployments the live path can complete.
    const guild = makeGuild();
    guild.roles.cache.set('managed-member', {
      id: 'managed-member',
      name: 'Integration Member',
      position: 9,
      managed: true,
      editable: false,
    });
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const desiredState = {
      ...defaultDesiredState,
      roles: [
        { key: 'admin', name: 'Admin', color: 0, permissions: '8', hoist: true, mentionable: false, position: 1 },
      ],
    };

    const result = await deployServerState(
      guild as any,
      supabase,
      desiredState as any,
      { cleanExisting: true, dryRun: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(guild.roles.everyone.setPermissions).not.toHaveBeenCalled();
    expect(guild.roles.create).not.toHaveBeenCalled();
    expect(guild.roles.setPositions).not.toHaveBeenCalled();
  });
});

describe('deployServerState — clean existing', () => {
  it('stops message deletions immediately when the deployment lease is lost mid-purge', async () => {
    const abortController = new AbortController();
    const messages = new MockCollection();
    const firstDelete = vi.fn(async () => {
      abortController.abort(new Error('deployment lease lost'));
    });
    const secondDelete = vi.fn(async () => {});
    messages.set('m1', { id: 'm1', author: { id: 'bot1' }, delete: firstDelete });
    messages.set('m2', { id: 'm2', author: { id: 'bot1' }, delete: secondDelete });
    const channels = new MockCollection();
    const channelDelete = vi.fn(async () => {});
    channels.set('ch1', {
      id: 'ch1',
      name: 'old-channel',
      type: 0,
      delete: channelDelete,
      messages: { fetch: vi.fn(async () => messages) },
    });
    const guild = makeGuild({
      channels: { cache: channels, create: vi.fn() },
    });
    const supabase = { from: vi.fn(() => supaChain()) };

    const result = await deployServerState(
      guild as unknown as Parameters<typeof deployServerState>[0],
      supabase as unknown as Parameters<typeof deployServerState>[1],
      defaultDesiredState as unknown as Parameters<typeof deployServerState>[2],
      { cleanExisting: true, dryRun: false, abortSignal: abortController.signal },
    );

    expect(result.success).toBe(false);
    expect(result.errors.at(-1)?.error).toContain('deployment lease lost');
    expect(firstDelete).toHaveBeenCalledTimes(1);
    expect(secondDelete).not.toHaveBeenCalled();
    expect(channelDelete).not.toHaveBeenCalled();
  });

  it('deletes non-protected channels when cleanExisting is true', async () => {
    const channels = new MockCollection();
    const ch1 = { id: 'ch1', name: 'old-channel', type: 0, delete: vi.fn(async () => {}), messages: { fetch: vi.fn(async () => new MockCollection()) } };
    channels.set('ch1', ch1);

    const guild = makeGuild({ channels: { cache: channels, create: vi.fn(async (opts: any) => ({ id: 'new', ...opts })) } });
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const options: DeployOptions = { cleanExisting: true, dryRun: false };

    await deployServerState(guild as any, supabase, defaultDesiredState as any, options);

    expect(ch1.delete).toHaveBeenCalled();
  });

  it('skips community-required channels during clean', async () => {
    const channels = new MockCollection();
    const rulesChannel = { id: 'rules1', name: 'rules', type: 0, delete: vi.fn(async () => {}), messages: { fetch: vi.fn(async () => new MockCollection()) } };
    const otherChannel = { id: 'ch1', name: 'general', type: 0, delete: vi.fn(async () => {}), messages: { fetch: vi.fn(async () => new MockCollection()) } };
    channels.set('rules1', rulesChannel);
    channels.set('ch1', otherChannel);

    const guild = makeGuild({
      rulesChannelId: 'rules1',
      channels: { cache: channels, create: vi.fn(async (opts: any) => ({ id: 'new', ...opts })) },
    });
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const options: DeployOptions = { cleanExisting: true, dryRun: false };

    await deployServerState(guild as any, supabase, defaultDesiredState as any, options);

    expect(rulesChannel.delete).not.toHaveBeenCalled();
    expect(otherChannel.delete).toHaveBeenCalled();
  });
});

describe('deployServerState — progress callback', () => {
  it('calls onProgress during deployment', async () => {
    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const onProgress = vi.fn();
    const options: DeployOptions = { cleanExisting: false, dryRun: false, onProgress };

    const desiredState = {
      ...defaultDesiredState,
      roles: [{ key: 'test', name: 'Test', color: 0, permissions: '0' }],
    };

    await deployServerState(guild as any, supabase, desiredState as any, options);

    expect(onProgress).toHaveBeenCalled();
  });

  it('never reports a step beyond the exact total when Discord has a moderator-only channel', async () => {
    const channels = new MockCollection();
    channels.set('moderator-only', {
      id: 'moderator-only',
      name: 'moderator-only',
      type: 0,
    });
    const guild = makeGuild({
      safetyAlertsChannelId: 'moderator-only',
      channels: {
        cache: channels,
        create: vi.fn(),
      },
    });
    const supabase = { from: vi.fn(() => supaChain()) };
    const onProgress = vi.fn();

    await deployServerState(
      guild as unknown as Parameters<typeof deployServerState>[0],
      supabase as unknown as Parameters<typeof deployServerState>[1],
      defaultDesiredState as unknown as Parameters<typeof deployServerState>[2],
      { cleanExisting: false, dryRun: false, onProgress },
    );

    const reported = onProgress.mock.calls.map(([step, total]) => ({
      step: step as number,
      total: total as number,
    }));
    expect(reported.every(({ step, total }) => step <= total)).toBe(true);
    expect(reported.at(-1)).toEqual({ step: 3, total: 3 });
  });
});

describe('deployServerState — result structure', () => {
  it('returns deployId, duration, and timestamp', async () => {
    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const options: DeployOptions = { cleanExisting: false, dryRun: false };

    const result = await deployServerState(guild as any, supabase, defaultDesiredState as any, options);

    expect(result.deployId).toMatch(/^deploy_/);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(typeof result.success).toBe('boolean');
    expect(Array.isArray(result.actions)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.idMappings)).toBe(true);
  });
});

describe('deployServerState — managed roles OUTSIDE the target band are not barriers', () => {
  it('deploys despite a managed role parked far below the target positions', async () => {
    // Review 3689700442 (P1): bot at 10 deploying 2 roles targets [8,10). A
    // managed integration role at position 2 cannot interfere with that
    // placement, but the preflight treated ANY managed role below the bot as
    // a barrier and aborted the whole deployment — dry-run included.
    const guild = makeGuild();
    guild.roles.cache.set('managed-low', {
      id: 'managed-low',
      name: 'Music Bot',
      position: 2,
      managed: true,
      editable: false,
    });
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const desiredState = {
      ...defaultDesiredState,
      roles: [
        { key: 'member', name: 'Member', color: 0, permissions: '0', hoist: false, mentionable: false, position: 0 },
        { key: 'admin', name: 'Admin', color: 0, permissions: '8', hoist: true, mentionable: false, position: 1 },
      ],
    };

    const result = await deployServerState(
      guild as any,
      supabase,
      desiredState as any,
      { cleanExisting: false, dryRun: true },
    );

    expect(result.errors.some((error) => error.error.includes('managed role'))).toBe(false);
    expect(result.success).toBe(true);
  });
});
