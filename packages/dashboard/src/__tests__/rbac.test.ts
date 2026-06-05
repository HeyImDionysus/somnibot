/**
 * Tests for the RBAC authorization module.
 *
 * Covers AuthError construction, authErrorResponse mapping,
 * getAuthContext resolution logic, and requirePermission guards.
 *
 * Uses vi.hoisted() for mock variables so they're available when
 * vi.mock() factories run (vitest hoists vi.mock to top of file).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────

const { mockGetUser, mockAdminFrom, mockCookieGet, mockHeaderGet } = vi.hoisted(() => {
  const mockGetUser = vi.fn();
  const mockAdminFrom = vi.fn();
  const mockCookieGet = vi.fn();
  const mockHeaderGet = vi.fn();
  return { mockGetUser, mockAdminFrom, mockCookieGet, mockHeaderGet };
});

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: vi.fn().mockImplementation(async () => ({
    auth: { getUser: mockGetUser },
  })),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn().mockReturnValue({
    from: mockAdminFrom,
  }),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: mockCookieGet,
  }),
  headers: vi.fn().mockResolvedValue({
    get: mockHeaderGet,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockCookieGet.mockReturnValue(undefined);
  mockHeaderGet.mockReturnValue(null);
});

// ── Helper to build chainable Supabase query mock ──────────

function chainMock(resolvedData: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(resolvedData);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolvedData);
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(resolvedData).then(resolve, reject);
  return chain;
}

function supabaseListMock(listData: unknown[], singleData: unknown = listData[0] ?? null) {
  const chain: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data: singleData });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: singleData });
  chain.then = (resolve: (value: { data: unknown[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: listData, error: null }).then(resolve, reject);
  return chain;
}

// ── AuthError ──────────────────────────────────────────────

describe('AuthError', () => {
  it('creates error with status and message', async () => {
    const { AuthError } = await import('@/lib/rbac');
    const err = new AuthError('Forbidden', 403);
    expect(err.message).toBe('Forbidden');
    expect(err.status).toBe(403);
    expect(err.name).toBe('AuthError');
    expect(err).toBeInstanceOf(Error);
  });
});

// ── authErrorResponse ──────────────────────────────────────

describe('authErrorResponse', () => {
  it('returns proper status for AuthError', async () => {
    const { AuthError, authErrorResponse } = await import('@/lib/rbac');
    const err = new AuthError('Forbidden', 403);
    const res = authErrorResponse(err);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('returns 500 for non-AuthError', async () => {
    const { authErrorResponse } = await import('@/lib/rbac');
    const res = authErrorResponse(new Error('something'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal Server Error');
  });

  it('returns 401 for unauthorized AuthError', async () => {
    const { AuthError, authErrorResponse } = await import('@/lib/rbac');
    const res = authErrorResponse(new AuthError('Unauthorized', 401));
    expect(res.status).toBe(401);
  });
});

// ── getAuthContext ──────────────────────────────────────────

describe('getAuthContext', () => {
  it('returns null when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const { getAuthContext } = await import('@/lib/rbac');
    const ctx = await getAuthContext();
    expect(ctx).toBeNull();
  });

  it('returns null when user has no Discord ID', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', user_metadata: {} } },
      error: null,
    });

    const { getAuthContext } = await import('@/lib/rbac');
    const ctx = await getAuthContext();
    expect(ctx).toBeNull();
  });

  it('returns null when no guild is found', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', user_metadata: { provider_id: 'discord_123' } } },
      error: null,
    });

    // Guild query returns null for both owner and role-assignment lookups
    mockAdminFrom.mockReturnValue(chainMock({ data: null }));

    const { getAuthContext } = await import('@/lib/rbac');
    const ctx = await getAuthContext();
    expect(ctx).toBeNull();
  });

  it('returns full access for guild owner', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', user_metadata: { provider_id: 'discord_owner' } } },
      error: null,
    });

    mockAdminFrom.mockReturnValue(
      chainMock({ data: { id: 'guild_1', owner_discord_id: 'discord_owner' } }),
    );

    const { getAuthContext } = await import('@/lib/rbac');
    const ctx = await getAuthContext();

    expect(ctx).not.toBeNull();
    expect(ctx!.isOwner).toBe(true);
    expect(ctx!.permissions).toContain('dashboard.full_access');
    expect(ctx!.discordId).toBe('discord_owner');
    expect(ctx!.guildId).toBe('guild_1');
  });

  it('uses active_guild_id cookie when owner has multiple guilds', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', user_metadata: { provider_id: 'discord_owner' } } },
      error: null,
    });
    mockCookieGet.mockImplementation((name: string) =>
      name === 'active_guild_id' ? { value: 'guild_2' } : undefined,
    );

    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'guild') {
        return supabaseListMock([
          { id: 'guild_1', owner_discord_id: 'discord_owner' },
          { id: 'guild_2', owner_discord_id: 'discord_owner' },
        ]);
      }
      return supabaseListMock([]);
    });

    const { getAuthContext } = await import('@/lib/rbac');
    const ctx = await getAuthContext();

    expect(ctx).not.toBeNull();
    expect(ctx!.isOwner).toBe(true);
    expect(ctx!.guildId).toBe('guild_2');
  });

  it('denies an inaccessible requested guild instead of falling back', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', user_metadata: { provider_id: 'discord_owner' } } },
      error: null,
    });
    mockHeaderGet.mockImplementation((name: string) =>
      name === 'x-guild-id' ? 'guild_other' : null,
    );

    mockAdminFrom.mockImplementation((table: string) => {
      if (table === 'guild') {
        return supabaseListMock([
          { id: 'guild_1', owner_discord_id: 'discord_owner' },
        ]);
      }
      return supabaseListMock([]);
    });

    const { requirePermission, AuthError } = await import('@/lib/rbac');

    await expect(requirePermission(null)).rejects.toMatchObject({
      name: 'AuthError',
      status: 403,
    } satisfies Partial<InstanceType<typeof AuthError>>);
  });

  it('extracts discordId from sub when provider_id is missing', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u2', user_metadata: { sub: 'discord_sub_id' } } },
      error: null,
    });

    mockAdminFrom.mockReturnValue(
      chainMock({ data: { id: 'guild_2', owner_discord_id: 'discord_sub_id' } }),
    );

    const { getAuthContext } = await import('@/lib/rbac');
    const ctx = await getAuthContext();

    expect(ctx).not.toBeNull();
    expect(ctx!.discordId).toBe('discord_sub_id');
  });
});

// ── requirePermission ──────────────────────────────────────

describe('requirePermission', () => {
  it('throws 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const { requirePermission, AuthError } = await import('@/lib/rbac');

    try {
      await requirePermission('dashboard.full_access' as never);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as InstanceType<typeof AuthError>).status).toBe(401);
    }
  });

  it('returns context for owner with null permission check', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', user_metadata: { provider_id: 'discord_owner' } } },
      error: null,
    });

    mockAdminFrom.mockReturnValue(
      chainMock({ data: { id: 'guild_1', owner_discord_id: 'discord_owner' } }),
    );

    const { requirePermission } = await import('@/lib/rbac');
    const ctx = await requirePermission(null);
    expect(ctx.isOwner).toBe(true);
  });
});
