/**
 * member-service — coverage tests
 *
 * Tests lookupMember, recordMemberJoin, recordMemberLeave, markOnboardingCompleted,
 * getMemberNumber with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  lookupMember,
  recordMemberJoin,
  recordMemberLeave,
  markOnboardingCompleted,
  getMemberNumber,
} from '../features/welcome/member-service.js';

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'in', 'limit', 'order', 'maybeSingle', 'single', 'insert', 'update', 'upsert']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(responses: Record<string, any> = {}) {
  const defaultResponse = { data: null, error: null };
  return {
    from: vi.fn().mockImplementation((table: string) => {
      return chainBuilder(responses[table] ?? defaultResponse);
    }),
    rpc: vi.fn().mockImplementation((name: string) => {
      if (responses[`rpc:${name}`]) {
        return Promise.resolve(responses[`rpc:${name}`]);
      }
      return Promise.resolve({ data: null, error: null });
    }),
  };
}

class MockCollection extends Map<any, any> {
  filter(fn: (v: any) => boolean): MockCollection {
    const result = new MockCollection();
    for (const [key, value] of this.entries()) {
      if (fn(value)) result.set(key, value);
    }
    return result;
  }
  map(fn: (v: any) => any): any[] {
    const result: any[] = [];
    for (const value of this.values()) {
      result.push(fn(value));
    }
    return result;
  }
}

function makeMember(overrides: any = {}) {
  const roles = new MockCollection([
    ['role1', { id: 'role1', managed: false }],
    ['role2', { id: 'role2', managed: false }],
    ['managed1', { id: 'managed1', managed: true }],
    ['guild1', { id: 'guild1', managed: false }], // @everyone
  ]);

  return {
    id: 'user1',
    guild: { id: 'guild1' },
    user: {
      tag: 'TestUser#0001',
      displayAvatarURL: vi.fn().mockReturnValue('https://cdn.discord.com/avatar.png'),
    },
    joinedAt: new Date('2026-01-01'),
    roles: { cache: roles },
    ...overrides,
  };
}

describe('lookupMember', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns not-found for new member', async () => {
    const supabase = makeSupabase({ members: { data: null, error: null } });
    const result = await lookupMember(supabase as any, 'g1', 'user1');
    expect(result.isReturning).toBe(false);
    expect(result.member).toBeNull();
    expect(result.previousRoles).toEqual([]);
  });

  it('returns existing member as returning', async () => {
    const supabase = makeSupabase({
      members: {
        data: { discord_id: 'user1', roles: ['r1', 'r2'], member_number: 5 },
        error: null,
      },
    });
    const result = await lookupMember(supabase as any, 'g1', 'user1');
    expect(result.isReturning).toBe(true);
    expect(result.previousRoles).toEqual(['r1', 'r2']);
  });

  it('handles DB error gracefully', async () => {
    const supabase = makeSupabase({
      members: { data: null, error: { message: 'db error' } },
    });
    const result = await lookupMember(supabase as any, 'g1', 'user1');
    expect(result.isReturning).toBe(false);
    expect(result.member).toBeNull();
  });

  it('handles null roles', async () => {
    const supabase = makeSupabase({
      members: {
        data: { discord_id: 'user1', roles: null },
        error: null,
      },
    });
    const result = await lookupMember(supabase as any, 'g1', 'user1');
    expect(result.previousRoles).toEqual([]);
  });
});

describe('recordMemberJoin', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('records a new member join', async () => {
    const supabase = makeSupabase({
      'rpc:get_next_member_number': { data: 42, error: null },
      members: { data: { member_number: 42, discord_id: 'user1' }, error: null },
    });
    const member = makeMember();
    const result = await recordMemberJoin(supabase as any, member as any, false);
    expect(result).toBeDefined();
    expect(supabase.rpc).toHaveBeenCalledWith('get_next_member_number', expect.anything());
  });

  it('records a returning member join', async () => {
    const supabase = makeSupabase({
      members: {
        data: {
          discord_id: 'user1',
          total_time_seconds: 3600,
          joined_at: '2026-01-01T00:00:00Z',
          left_at: '2026-01-02T00:00:00Z',
        },
        error: null,
      },
    });
    const member = makeMember();
    const result = await recordMemberJoin(supabase as any, member as any, true);
    expect(result).toBeDefined();
  });

  it('handles RPC fallback for member number', async () => {
    const supabase = makeSupabase({
      'rpc:get_next_member_number': { data: null, error: { message: 'rpc failed' } },
      members: { data: { member_number: 10 }, error: null },
    });
    const member = makeMember();
    const result = await recordMemberJoin(supabase as any, member as any, false);
    expect(result).toBeDefined();
  });

  it('handles upsert error', async () => {
    // First call for existing member lookup succeeds, upsert fails
    const callCount = { n: 0 };
    const supabase = {
      from: vi.fn().mockImplementation(() => {
        callCount.n++;
        if (callCount.n <= 1) {
          // returning member lookup
          return chainBuilder({ data: null, error: null });
        }
        // upsert call
        return chainBuilder({ data: null, error: { message: 'upsert failed' } });
      }),
      rpc: vi.fn().mockResolvedValue({ data: 1, error: null }),
    };
    const member = makeMember();
    const result = await recordMemberJoin(supabase as any, member as any, false);
    expect(result).toBeNull();
  });
});

describe('recordMemberLeave', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('records member leave with roles', async () => {
    const supabase = makeSupabase({ members: { error: null } });
    const member = makeMember();
    await recordMemberLeave(supabase as any, member as any);
    expect(supabase.from).toHaveBeenCalledWith('members');
  });

  it('handles DB error gracefully', async () => {
    const supabase = makeSupabase({ members: { error: { message: 'failed' } } });
    const member = makeMember();
    await recordMemberLeave(supabase as any, member as any);
    // Should not throw
  });
});

describe('markOnboardingCompleted', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('updates onboarding status', async () => {
    const supabase = makeSupabase({ members: { error: null } });
    await markOnboardingCompleted(supabase as any, 'g1', 'user1');
    expect(supabase.from).toHaveBeenCalledWith('members');
  });

  it('handles DB error', async () => {
    const supabase = makeSupabase({ members: { error: { message: 'failed' } } });
    await markOnboardingCompleted(supabase as any, 'g1', 'user1');
    // Should not throw
  });
});

describe('getMemberNumber', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns member number', async () => {
    const supabase = makeSupabase({
      members: { data: { member_number: 42 }, error: null },
    });
    const result = await getMemberNumber(supabase as any, 'g1', 'user1');
    expect(result).toBe(42);
  });

  it('returns 0 when member not found', async () => {
    const supabase = makeSupabase({ members: { data: null, error: null } });
    const result = await getMemberNumber(supabase as any, 'g1', 'user1');
    expect(result).toBe(0);
  });

  it('returns 0 on error', async () => {
    const supabase = makeSupabase({ members: { data: null, error: { message: 'err' } } });
    const result = await getMemberNumber(supabase as any, 'g1', 'user1');
    expect(result).toBe(0);
  });
});
