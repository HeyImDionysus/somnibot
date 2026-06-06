/**
 * Dashboard RBAC & Auth — Integration Tests (V5 audit remediation — Finding 13.2)
 *
 * Tests the permission system, route-level authorization, and
 * auth guard behavior (401 vs 403).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies before imports ────────────────────────

const { mockCookieGet, mockHeaderGet } = vi.hoisted(() => ({
  mockCookieGet: vi.fn(),
  mockHeaderGet: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: mockCookieGet,
  }),
  headers: vi.fn().mockResolvedValue({
    get: mockHeaderGet,
  }),
}));

import { createAdminSupabase } from '@/lib/supabase/admin';
import { createServerSupabase } from '@/lib/supabase/server';

// ── Permission helpers (pure logic, no mocking needed) ──────

import { hasPermission, hasRouteAccess, SYSTEM_ROLES, ROUTE_PERMISSIONS } from '@somnibot/shared/constants';
import type { DashboardPermission } from '@somnibot/shared';

describe('hasPermission()', () => {
  it('returns true when required is null (public route)', () => {
    expect(hasPermission([], null)).toBe(true);
  });

  it('returns true when user has full_access', () => {
    expect(hasPermission(['dashboard.full_access'], 'dashboard.manage_store')).toBe(true);
  });

  it('returns true when user has the exact permission', () => {
    expect(hasPermission(['dashboard.manage_store', 'dashboard.view_analytics'], 'dashboard.manage_store')).toBe(true);
  });

  it('returns false when user lacks the permission', () => {
    expect(hasPermission(['dashboard.manage_tickets'], 'dashboard.manage_store')).toBe(false);
  });

  it('returns false for empty permissions against a required permission', () => {
    expect(hasPermission([], 'dashboard.manage_store')).toBe(false);
  });
});

describe('hasRouteAccess()', () => {
  it('grants access to /dashboard for any authenticated user', () => {
    expect(hasRouteAccess([], '/dashboard')).toBe(true);
  });

  it('grants access to /settings for any authenticated user', () => {
    expect(hasRouteAccess([], '/settings')).toBe(true);
  });

  it('blocks /store without manage_store permission', () => {
    expect(hasRouteAccess(['dashboard.manage_tickets'], '/store')).toBe(false);
  });

  it('allows /store with manage_store permission', () => {
    expect(hasRouteAccess(['dashboard.manage_store'], '/store')).toBe(true);
  });

  it('allows /store with full_access', () => {
    expect(hasRouteAccess(['dashboard.full_access'], '/store')).toBe(true);
  });

  it('grants access to unknown routes by default', () => {
    expect(hasRouteAccess([], '/some-unknown-route')).toBe(true);
  });

  it('blocks /settings/team without manage_team', () => {
    expect(hasRouteAccess(['dashboard.manage_store'], '/settings/team')).toBe(false);
  });

  it('allows /settings/team with manage_team', () => {
    expect(hasRouteAccess(['dashboard.manage_team'], '/settings/team')).toBe(true);
  });
});

describe('SYSTEM_ROLES', () => {
  it('owner has full_access', () => {
    expect(SYSTEM_ROLES.owner.permissions).toContain('dashboard.full_access');
  });

  it('admin cannot manage team', () => {
    expect(SYSTEM_ROLES.admin.permissions).not.toContain('dashboard.manage_team');
    expect(SYSTEM_ROLES.admin.permissions).not.toContain('dashboard.full_access');
  });

  it('moderator can only manage moderation + tickets + view', () => {
    const modPerms = SYSTEM_ROLES.moderator.permissions;
    expect(modPerms).toContain('dashboard.manage_moderation');
    expect(modPerms).toContain('dashboard.manage_tickets');
    expect(modPerms).not.toContain('dashboard.manage_store');
    expect(modPerms).not.toContain('dashboard.manage_economy');
  });

  it('finance has no admin-level abilities', () => {
    const finPerms = SYSTEM_ROLES.finance.permissions;
    expect(finPerms).not.toContain('dashboard.full_access');
    expect(finPerms).not.toContain('dashboard.manage_team');
    expect(finPerms).not.toContain('dashboard.manage_server');
    expect(finPerms).not.toContain('dashboard.manage_moderation');
    expect(finPerms).not.toContain('dashboard.manage_roles');
    expect(finPerms).not.toContain('dashboard.manage_channels');
    expect(finPerms).not.toContain('dashboard.manage_economy');
    // Finance CAN do these:
    expect(finPerms).toContain('dashboard.view_analytics');
    expect(finPerms).toContain('dashboard.manage_store');
    expect(finPerms).toContain('dashboard.manage_orders');
    expect(finPerms).toContain('dashboard.manage_customers');
  });

  it('support can manage tickets but not store', () => {
    const supPerms = SYSTEM_ROLES.support.permissions;
    expect(supPerms).toContain('dashboard.manage_tickets');
    expect(supPerms).toContain('dashboard.manage_customers');
    expect(supPerms).not.toContain('dashboard.manage_store');
    expect(supPerms).not.toContain('dashboard.manage_server');
  });

  it('role priority ordering is correct', () => {
    expect(SYSTEM_ROLES.owner.priority).toBeGreaterThan(SYSTEM_ROLES.admin.priority);
    expect(SYSTEM_ROLES.admin.priority).toBeGreaterThan(SYSTEM_ROLES.moderator.priority);
    expect(SYSTEM_ROLES.moderator.priority).toBeGreaterThanOrEqual(SYSTEM_ROLES.support.priority);
  });
});

describe('ROUTE_PERMISSIONS coverage', () => {
  it('all route permissions reference valid DashboardPermission values', () => {
    const validPerms = new Set<string>([
      'dashboard.full_access', 'dashboard.view_analytics', 'dashboard.manage_store',
      'dashboard.manage_products', 'dashboard.manage_orders', 'dashboard.manage_customers',
      'dashboard.manage_licenses', 'dashboard.manage_moderation', 'dashboard.manage_tickets',
      'dashboard.manage_automations', 'dashboard.manage_server', 'dashboard.manage_roles',
      'dashboard.manage_channels', 'dashboard.manage_team', 'dashboard.view_audit',
      'dashboard.view_diagnostics', 'dashboard.manage_incidents', 'dashboard.view_fraud',
      'dashboard.manage_fraud', 'dashboard.view_workflows', 'dashboard.manage_workflows',
      'dashboard.manage_economy', 'dashboard.undo_changes',
    ]);

    for (const [route, perm] of Object.entries(ROUTE_PERMISSIONS)) {
      if (perm !== null) {
        expect(validPerms.has(perm), `Route ${route} references unknown permission: ${perm}`).toBe(true);
      }
    }
  });
});

describe('requireGuildOwner — 401/403 responses', () => {
  const mockQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    single: vi.fn().mockResolvedValue({ data: null }),
  };
  const mockAdminSupabase = { from: vi.fn(() => mockQuery) };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieGet.mockReturnValue(undefined);
    mockHeaderGet.mockReturnValue(null);
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockAdminSupabase);
  });

  it('returns 401 when no session exists', async () => {
    const mockServerSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'No session' } }) },
    };
    (createServerSupabase as ReturnType<typeof vi.fn>).mockResolvedValue(mockServerSupabase);

    const { requireGuildOwner } = await import('@/lib/api/require-owner');
    const result = await requireGuildOwner();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it('returns 401 when user has no Discord ID', async () => {
    const mockServerSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1', user_metadata: {} } } }) },
    };
    (createServerSupabase as ReturnType<typeof vi.fn>).mockResolvedValue(mockServerSupabase);

    const { requireGuildOwner } = await import('@/lib/api/require-owner');
    const result = await requireGuildOwner();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it('returns 403 when Discord user is not a guild owner', async () => {
    const mockServerSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'u1', user_metadata: { provider_id: 'discord-123' } } },
        }),
      },
    };
    (createServerSupabase as ReturnType<typeof vi.fn>).mockResolvedValue(mockServerSupabase);

    // No guilds owned
    mockQuery.eq.mockReturnThis();
    mockQuery.select.mockReturnThis();
    mockQuery.limit.mockReturnThis();
    (mockAdminSupabase.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: [] }),
        }),
      }),
    });

    const { requireGuildOwner } = await import('@/lib/api/require-owner');
    const result = await requireGuildOwner();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it('returns 403 when requested guild is not owned', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockServerSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'u1', user_metadata: { provider_id: 'discord-123' } } },
        }),
      },
    };
    (createServerSupabase as ReturnType<typeof vi.fn>).mockResolvedValue(mockServerSupabase);
    mockHeaderGet.mockImplementation((name: string) =>
      name === 'x-guild-id' ? 'guild-2' : null,
    );

    (mockAdminSupabase.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({
            data: [{ id: 'guild-1', owner_discord_id: 'discord-123' }],
          }),
        }),
      }),
    });

    const { requireGuildOwner } = await import('@/lib/api/require-owner');
    const result = await requireGuildOwner();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('requested guild guild-2'),
    );
    warnSpy.mockRestore();
  });
});
