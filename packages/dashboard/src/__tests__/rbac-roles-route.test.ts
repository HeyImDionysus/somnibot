/**
 * Dashboard RBAC Roles Route Tests — V5 Audit §13.4
 *
 * Tests the /api/rbac/roles endpoint including the V5 fix
 * that blocks modification of ALL system roles, not just owner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ── Mock dependencies ───────────────────────────────────────

const mockRequirePermission = vi.fn();
vi.mock('@/lib/rbac', () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
  authErrorResponse: vi.fn(),
}));

const mockRateLimit = vi.fn();
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

const mockSupabase = {
  from: vi.fn(),
};
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => mockSupabase,
}));

const mockParseBody = vi.fn();
vi.mock('@/lib/api/validation', () => ({
  parseBody: (...args: unknown[]) => mockParseBody(...args),
  schemas: {},
}));

import { GET, POST, PATCH, DELETE } from '../app/api/rbac/roles/route';

// ── Helpers ─────────────────────────────────────────────────

function buildRequest(path: string, opts: { method?: string; body?: unknown } = {}) {
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  }) as unknown as import('next/server').NextRequest;
}

function mockPermissionSuccess(guildId = 'guild-1') {
  mockRequirePermission.mockResolvedValue({ guildId });
}

function mockQueryChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  };
  mockSupabase.from.mockReturnValue(chain);
  return chain;
}

// ── Tests ───────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockRateLimit.mockResolvedValue(null); // not rate limited
});

describe('GET /api/rbac/roles', () => {
  it('returns roles when authorized', async () => {
    mockPermissionSuccess();
    const roles = [{ id: '1', name: 'admin', is_system: true }];
    const chain = mockQueryChain();
    // The final call in the chain resolves the query
    chain.limit.mockResolvedValue({ data: roles, error: null });

    const res = await GET(buildRequest('/api/rbac/roles'));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data).toEqual(roles);
    expect(mockRequirePermission).toHaveBeenCalledWith('dashboard.manage_team');
  });

  it('returns 401 when not authorized', async () => {
    mockRequirePermission.mockRejectedValue(new Error('Unauthorized'));

    const res = await GET(buildRequest('/api/rbac/roles'));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });
});

describe('POST /api/rbac/roles', () => {
  it('creates a custom role with is_system: false', async () => {
    mockPermissionSuccess();
    mockParseBody.mockResolvedValue({
      ok: true,
      data: { name: 'Test Role', permissions: ['dashboard.view_analytics'], priority: 5 },
    });
    const chain = mockQueryChain();
    chain.single.mockResolvedValue({
      data: { id: 'new-role-id', name: 'Test Role', is_system: false },
      error: null,
    });

    const res = await POST(buildRequest('/api/rbac/roles', { method: 'POST' }));
    const body = await res.json();

    expect(body.success).toBe(true);
    // Verify insert was called with is_system: false
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ is_system: false, name: 'Test Role' }),
    );
  });
});

describe('PATCH /api/rbac/roles — V5 §1.6 system role protection', () => {
  it('blocks modification of the owner system role', async () => {
    mockPermissionSuccess();
    mockParseBody.mockResolvedValue({
      ok: true,
      data: { id: 'owner-role-id', permissions: ['dashboard.full_access', 'extra'] },
    });
    const chain = mockQueryChain();
    chain.single.mockResolvedValue({
      data: { is_system: true, name: 'owner' },
      error: null,
    });

    const res = await PATCH(buildRequest('/api/rbac/roles', { method: 'PATCH' }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain('Cannot modify system role');
  });

  it('blocks modification of the admin system role (V5 fix)', async () => {
    mockPermissionSuccess();
    mockParseBody.mockResolvedValue({
      ok: true,
      data: { id: 'admin-role-id', permissions: ['dashboard.full_access'] },
    });
    const chain = mockQueryChain();
    chain.single.mockResolvedValue({
      data: { is_system: true, name: 'admin' },
      error: null,
    });

    const res = await PATCH(buildRequest('/api/rbac/roles', { method: 'PATCH' }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain('Cannot modify system role');
    expect(body.error).toContain('admin');
  });

  it('blocks modification of the moderator system role (V5 fix)', async () => {
    mockPermissionSuccess();
    mockParseBody.mockResolvedValue({
      ok: true,
      data: { id: 'mod-role-id', name: 'SuperMod' },
    });
    const chain = mockQueryChain();
    chain.single.mockResolvedValue({
      data: { is_system: true, name: 'moderator' },
      error: null,
    });

    const res = await PATCH(buildRequest('/api/rbac/roles', { method: 'PATCH' }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain('Cannot modify system role');
  });

  it('allows modification of custom (non-system) roles', async () => {
    mockPermissionSuccess();
    mockParseBody.mockResolvedValue({
      ok: true,
      data: { id: 'custom-role-id', name: 'Updated Name' },
    });
    const chain = mockQueryChain();
    // First call: check is_system
    chain.single.mockResolvedValueOnce({
      data: { is_system: false, name: 'Old Name' },
      error: null,
    });
    // Second call: update result
    chain.single.mockResolvedValueOnce({
      data: { id: 'custom-role-id', name: 'Updated Name', is_system: false },
      error: null,
    });

    const res = await PATCH(buildRequest('/api/rbac/roles', { method: 'PATCH' }));
    const body = await res.json();

    expect(body.success).toBe(true);
  });
});

describe('DELETE /api/rbac/roles', () => {
  it('blocks deletion of system roles', async () => {
    mockPermissionSuccess();
    const chain = mockQueryChain();
    chain.single.mockResolvedValue({
      data: { is_system: true },
      error: null,
    });

    const res = await DELETE(
      buildRequest('/api/rbac/roles?id=system-role-id', { method: 'DELETE' }),
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain('Cannot delete system roles');
  });

  it('allows deletion of custom roles', async () => {
    mockPermissionSuccess();

    // The DELETE handler calls .from('dashboard_roles') twice:
    // 1) SELECT to check is_system → .single()
    // 2) DELETE .delete().eq().eq() → resolves with { error: null }
    let callCount = 0;
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { is_system: false }, error: null }),
    };
    const deleteChain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockImplementation(function (this: typeof deleteChain) {
        // The second .eq() is terminal — return a thenable
        callCount++;
        if (callCount >= 2) {
          return Promise.resolve({ error: null });
        }
        return deleteChain;
      }),
    };

    let fromCallCount = 0;
    mockSupabase.from.mockImplementation(() => {
      fromCallCount++;
      if (fromCallCount === 1) return selectChain;
      return deleteChain;
    });

    const res = await DELETE(
      buildRequest('/api/rbac/roles?id=custom-role-id', { method: 'DELETE' }),
    );
    const body = await res.json();

    expect(body.success).toBe(true);
  });

  it('returns 400 when role ID is missing', async () => {
    mockPermissionSuccess();

    const res = await DELETE(buildRequest('/api/rbac/roles', { method: 'DELETE' }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('Missing role ID');
  });
});
