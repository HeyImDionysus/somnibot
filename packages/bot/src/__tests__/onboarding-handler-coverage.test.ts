/**
 * onboarding-handler — coverage tests
 *
 * Tests: handleMemberJoin, handleMemberUpdate, handleMemberLeave,
 * invalidateGuildConfigCache, restorePreviousRoles, restoreLevelRoles
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  GuildMemberFlags: { CompletedOnboarding: 1 << 0 },
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const mockLookupMember = vi.fn().mockResolvedValue({
  isReturning: false,
  previousRoles: [],
});
const mockRecordMemberJoin = vi.fn().mockResolvedValue(undefined);
const mockRecordMemberLeave = vi.fn().mockResolvedValue(undefined);
const mockMarkOnboardingCompleted = vi.fn().mockResolvedValue(undefined);
vi.mock('../features/welcome/member-service.js', () => ({
  lookupMember: (...args: unknown[]) => mockLookupMember(...args),
  recordMemberJoin: (...args: unknown[]) => mockRecordMemberJoin(...args),
  recordMemberLeave: (...args: unknown[]) => mockRecordMemberLeave(...args),
  markOnboardingCompleted: (...args: unknown[]) => mockMarkOnboardingCompleted(...args),
}));

const mockExecuteWelcomeFlow = vi.fn().mockResolvedValue(undefined);
vi.mock('../features/welcome/welcome-service.js', () => ({
  executeWelcomeFlow: (...args: unknown[]) => mockExecuteWelcomeFlow(...args),
}));

const mockExecuteGoodbyeFlow = vi.fn().mockResolvedValue(undefined);
vi.mock('../features/welcome/goodbye-service.js', () => ({
  executeGoodbyeFlow: (...args: unknown[]) => mockExecuteGoodbyeFlow(...args),
}));

const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/audit.js', () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

import {
  handleMemberJoin,
  handleMemberUpdate,
  handleMemberLeave,
  invalidateGuildConfigCache,
} from '../features/welcome/onboarding-handler.js';

// ── Helpers ───────────────────────────────────────────────

/** Map with Discord Collection-like .filter()/.map()/.has() */
class MockCollection<V> extends Map<string, V> {
  filter(fn: (v: V, k: string) => boolean): MockCollection<V> {
    const result = new MockCollection<V>();
    for (const [k, v] of this) { if (fn(v, k)) result.set(k, v); }
    return result;
  }
  map<T>(fn: (v: V, k: string) => T): T[] {
    const result: T[] = [];
    for (const [k, v] of this) result.push(fn(v, k));
    return result;
  }
}

function chainBuilder(resolveValue: Record<string, unknown> = { data: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'gt', 'lt', 'lte', 'order', 'limit', 'insert', 'update']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  chain.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
    Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

const defaultConfig = {
  member_role_id: 'role1',
  returning_member_restore_entitlements: true,
  returning_member_restore_levels: false,
  returning_member_skip_welcome_dm: false,
  welcome_dm_enabled: true,
  interest_role_mapping: null as Record<string, string> | null,
};

function makeClient(configOverrides: Record<string, unknown> = {}) {
  const cfg = { ...defaultConfig, ...configOverrides };
  return {
    supabase: {
      from: vi.fn().mockReturnValue(chainBuilder({ data: cfg })),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    valkey: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    },
    eventBus: { emit: vi.fn() },
  };
}

function makeMember(overrides: Record<string, unknown> = {}) {
  const cache = new MockCollection<unknown>();
  return {
    id: 'u1',
    partial: false,
    user: { tag: 'TestUser#1234' },
    guild: {
      id: 'g1',
      roles: { cache: new MockCollection<unknown>() },
      members: { me: { roles: { highest: { position: 100 } } } },
    },
    roles: {
      cache,
      add: vi.fn().mockResolvedValue(undefined),
    },
    flags: {
      has: vi.fn().mockReturnValue(false),
    },
    ...overrides,
  };
}

describe('handleMemberJoin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records join and emits event for new member', async () => {
    const client = makeClient();
    const member = makeMember();
    await handleMemberJoin(client as any, member as any);
    expect(mockRecordMemberJoin).toHaveBeenCalled();
    expect(client.eventBus.emit).toHaveBeenCalledWith(
      'member.joined', 'g1', expect.objectContaining({ isReturning: false }),
    );
  });

  it('returns early when no config', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: { message: 'err' } }));
    const member = makeMember();
    await handleMemberJoin(client as any, member as any);
    expect(mockRecordMemberJoin).not.toHaveBeenCalled();
  });

  it('uses cached config from valkey', async () => {
    const client = makeClient();
    client.valkey.get.mockResolvedValue(JSON.stringify(defaultConfig));
    const member = makeMember();
    await handleMemberJoin(client as any, member as any);
    expect(mockRecordMemberJoin).toHaveBeenCalled();
  });

  describe('returning member', () => {
    beforeEach(() => {
      mockLookupMember.mockResolvedValue({
        isReturning: true,
        previousRoles: ['r1', 'r2'],
      });
    });

    it('grants member role and restores roles', async () => {
      const rolesCache = new MockCollection<unknown>();
      const guildRolesCache = new MockCollection<unknown>([
        ['r1', { id: 'r1', managed: false, position: 5 }],
        ['r2', { id: 'r2', managed: false, position: 10 }],
      ]);
      const member = makeMember({
        guild: {
          id: 'g1',
          roles: { cache: guildRolesCache },
          members: { me: { roles: { highest: { position: 100 } } } },
        },
        roles: { cache: rolesCache, add: vi.fn().mockResolvedValue(undefined) },
      });
      const client = makeClient();
      await handleMemberJoin(client as any, member as any);
      // Should add member role + restore 2 previous roles
      expect(member.roles.add).toHaveBeenCalledTimes(3);
    });

    it('unsuspends economy', async () => {
      const client = makeClient();
      const member = makeMember();
      await handleMemberJoin(client as any, member as any);
      expect(client.supabase.rpc).toHaveBeenCalledWith('unsuspend_member_economy', expect.any(Object));
    });

    it('handles unsuspend economy failure', async () => {
      const client = makeClient();
      client.supabase.rpc.mockRejectedValue(new Error('rpc fail'));
      const member = makeMember();
      await handleMemberJoin(client as any, member as any);
      // Should not throw
      expect(mockRecordMemberJoin).toHaveBeenCalled();
    });

    it('skips role restoration when not configured', async () => {
      const client = makeClient({ returning_member_restore_entitlements: false });
      const member = makeMember();
      await handleMemberJoin(client as any, member as any);
      // Only the member role add, not previous roles
      expect(member.roles.add).toHaveBeenCalledTimes(1);
    });

    it('skips DM for returning member when configured', async () => {
      const client = makeClient({ returning_member_skip_welcome_dm: true });
      const member = makeMember();
      await handleMemberJoin(client as any, member as any);
      expect(mockExecuteWelcomeFlow).toHaveBeenCalledWith(
        member,
        expect.objectContaining({ config: expect.objectContaining({ welcome_dm_enabled: false }) }),
      );
    });

    it('executes welcome flow for returning member', async () => {
      const client = makeClient();
      const member = makeMember();
      await handleMemberJoin(client as any, member as any);
      expect(mockExecuteWelcomeFlow).toHaveBeenCalled();
    });

    it('handles member role grant failure', async () => {
      const client = makeClient();
      const member = makeMember({
        roles: { cache: new MockCollection(), add: vi.fn().mockRejectedValue(new Error('no perms')) },
      });
      await handleMemberJoin(client as any, member as any);
      // Should not throw — continues to welcome flow
      expect(mockExecuteWelcomeFlow).toHaveBeenCalled();
    });

    it('restores level roles when configured', async () => {
      const client = makeClient({ returning_member_restore_levels: true });
      // Need supabase.from to return level data
      let callNum = 0;
      client.supabase.from.mockImplementation((table: string) => {
        if (table === 'member_levels') {
          return chainBuilder({ data: { level: 10 } });
        }
        if (table === 'level_rewards') {
          return chainBuilder({
            data: [
              { role_id: 'lr1', level: 5, remove_at_level: null },
            ],
          });
        }
        return chainBuilder({ data: defaultConfig });
      });
      const guildRolesCache = new MockCollection([
        ['lr1', { id: 'lr1', managed: false, position: 5 }],
      ]);
      const member = makeMember({
        guild: {
          id: 'g1',
          roles: { cache: guildRolesCache },
          members: { me: { roles: { highest: { position: 100 } } } },
        },
        roles: { cache: new MockCollection(), add: vi.fn().mockResolvedValue(undefined) },
      });
      await handleMemberJoin(client as any, member as any);
      // Should restore level role lr1
      expect(member.roles.add).toHaveBeenCalled();
    });

    it('writes audit log', async () => {
      const client = makeClient();
      const member = makeMember();
      await handleMemberJoin(client as any, member as any);
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'member.returning_welcome' }),
      );
    });
  });
});

describe('handleMemberUpdate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects onboarding completion', async () => {
    const client = makeClient();
    const oldMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(false) },
    });
    const newMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(true) },
    });
    await handleMemberUpdate(client as any, oldMember as any, newMember as any);
    expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
    expect(newMember.roles.add).toHaveBeenCalled();
    expect(client.eventBus.emit).toHaveBeenCalledWith(
      'member.verified', 'g1', expect.any(Object),
    );
  });

  it('skips when not an onboarding completion', async () => {
    const client = makeClient();
    const oldMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(true) },
      roles: { cache: new MockCollection() },
    });
    const newMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(true) },
      roles: { cache: new MockCollection() },
    });
    await handleMemberUpdate(client as any, oldMember as any, newMember as any);
    expect(mockMarkOnboardingCompleted).not.toHaveBeenCalled();
  });

  it('applies interest roles when mapping exists', async () => {
    const client = makeClient({
      interest_role_mapping: { opt1: 'role1' },
    });
    const oldMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(false) },
      roles: { cache: new MockCollection() },
    });
    const newMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(true) },
      roles: { cache: new MockCollection() },
    });
    await handleMemberUpdate(client as any, oldMember as any, newMember as any);
    // applyInterestRoles just logs for now — no assertion on it
    expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
  });

  it('detects role changes and emits events', async () => {
    const client = makeClient();
    const oldRoles = new MockCollection<unknown>([['r1', { id: 'r1', name: 'OldRole' }]]);
    const newRoles = new MockCollection<unknown>([['r2', { id: 'r2', name: 'NewRole' }]]);

    const oldMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(true) },
      roles: { cache: oldRoles },
    });
    const newMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(true) },
      roles: { cache: newRoles },
    });
    await handleMemberUpdate(client as any, oldMember as any, newMember as any);
    expect(client.eventBus.emit).toHaveBeenCalledWith('role.gained', 'g1', expect.objectContaining({ roleId: 'r2' }));
    expect(client.eventBus.emit).toHaveBeenCalledWith('role.lost', 'g1', expect.objectContaining({ roleId: 'r1' }));
  });

  it('handles role add failure during onboarding', async () => {
    const client = makeClient();
    const oldMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(false) },
      roles: { cache: new MockCollection() },
    });
    const newMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(true) },
      roles: {
        cache: new MockCollection(),
        add: vi.fn().mockRejectedValue(new Error('no perms')),
      },
    });
    await handleMemberUpdate(client as any, oldMember as any, newMember as any);
    // Should not throw
  });

  it('returns early when no config during onboarding', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: { message: 'fail' } }));
    const oldMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(false) },
      roles: { cache: new MockCollection() },
    });
    const newMember = makeMember({
      flags: { has: vi.fn().mockReturnValue(true) },
      roles: { cache: new MockCollection() },
    });
    await handleMemberUpdate(client as any, oldMember as any, newMember as any);
    expect(mockMarkOnboardingCompleted).not.toHaveBeenCalled();
  });
});

describe('handleMemberLeave', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records leave and emits event', async () => {
    const client = makeClient();
    const rolesCache = new MockCollection<unknown>([['r1', { id: 'r1' }]]);
    const member = makeMember({ roles: { cache: rolesCache } });
    await handleMemberLeave(client as any, member as any);
    expect(mockRecordMemberLeave).toHaveBeenCalled();
    expect(client.eventBus.emit).toHaveBeenCalledWith(
      'member.left', 'g1', expect.objectContaining({ discordId: 'u1' }),
    );
  });

  it('handles partial member', async () => {
    const client = makeClient();
    const member = makeMember({ partial: true, user: { tag: 'partial' } });
    await handleMemberLeave(client as any, member as any);
    expect(mockRecordMemberLeave).not.toHaveBeenCalled();
  });

  it('executes goodbye flow', async () => {
    const client = makeClient();
    const member = makeMember();
    await handleMemberLeave(client as any, member as any);
    expect(mockExecuteGoodbyeFlow).toHaveBeenCalled();
  });

  it('writes audit log', async () => {
    const client = makeClient();
    const member = makeMember();
    await handleMemberLeave(client as any, member as any);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'member.left' }),
    );
  });
});

describe('invalidateGuildConfigCache', () => {
  it('deletes the cache key', async () => {
    const client = makeClient();
    await invalidateGuildConfigCache(client as any, 'g1');
    expect(client.valkey.del).toHaveBeenCalledWith('guild_config:g1');
  });

  it('handles del failure gracefully', async () => {
    const client = makeClient();
    client.valkey.del.mockRejectedValue(new Error('fail'));
    await invalidateGuildConfigCache(client as any, 'g1');
    // No error thrown
  });
});
