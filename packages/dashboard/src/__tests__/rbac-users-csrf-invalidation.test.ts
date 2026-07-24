/**
 * Regression test — RBAC privilege changes must invalidate BOTH CSRF cookies.
 *
 * V9 Audit §1.P2 documented that assigning/removing a dashboard role clears the
 * CSRF token so a stale tab cannot keep mutating with a pre-change token. The
 * handlers used to delete only `somnibot-csrf-token`, but the middleware's
 * rotation grace mechanism keeps a `somnibot-csrf-prev` cookie that `checkCsrf`
 * still accepts for up to 60s. If a rotation happened just before the role
 * change, a stale tab could keep passing its pre-change token via `prev`,
 * defeating the invalidation window. Both cookies must be expired.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';

import { NextRequest } from 'next/server';
import { CSRF_COOKIE_NAME, CSRF_PREV_COOKIE_NAME } from '@/lib/api/csrf';

// ── Mocks ───────────────────────────────────────────────────
// NOTE: @/lib/api/csrf is intentionally NOT mocked so invalidateCsrfCookies
// runs against a real NextResponse.

const mockRequirePermission = vi.fn();
vi.mock('@/lib/rbac', () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
  authErrorResponse: vi.fn(),
}));

const mockRateLimit = vi.fn();
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

const mockParseBody = vi.fn();
vi.mock('@/lib/api/validation', () => ({
  parseBody: (...args: unknown[]) => mockParseBody(...args),
  schemas: {},
}));

const mockLoadTeamConfig = vi.fn();
const mockWriteTeamAudit = vi.fn();
vi.mock('@/lib/team-invitations', () => ({
  loadTeamConfig: (...args: unknown[]) => mockLoadTeamConfig(...args),
  writeTeamAudit: (...args: unknown[]) => mockWriteTeamAudit(...args),
}));

const mockSupabase = { from: vi.fn() };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => mockSupabase,
}));

import { POST, DELETE } from '../app/api/rbac/users/route';

// ── Helpers ─────────────────────────────────────────────────

/**
 * A `NextResponse.cookies.delete({ name, path })` sets an expired cookie: the
 * value becomes '' and `expires` is set to the Unix epoch (a past date). Assert
 * both markers so a plain `.set(...)` can't masquerade as a delete.
 *
 * [security] The deletion MUST also carry `Path=/` — the cookies are issued with
 * `path: '/'`, and a browser only removes a stored cookie when the deletion's
 * Path matches. A `Path`-less expiry leaves the root-path cookie intact, so
 * `checkCsrf` could keep honouring the pre-change token during the grace window.
 */
function assertCookieCleared(res: import('next/server').NextResponse, name: string): void {
  const cookie = res.cookies.get(name);
  expect(cookie, `expected ${name} to be present as an expiry cookie`).toBeTruthy();
  expect(cookie!.value).toBe('');
  expect(cookie!.expires, `expected ${name} to be expired`).toBeDefined();
  expect(new Date(cookie!.expires!).getTime()).toBeLessThan(Date.now());
  expect(cookie!.path, `expected ${name} deletion to target the root path`).toBe('/');
}

function buildRequest(path: string, method: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue(null); // not rate limited
  mockWriteTeamAudit.mockResolvedValue(undefined);
});

/**
 * A table-dispatch supabase mock: each table serves a queue of results in call
 * order. Robust to the extra reads the consent path performs (existing-role
 * check, pending count) vs. a brittle global call counter.
 */
function tableMock(config: Record<string, Array<Record<string, unknown>>>) {
  const queues: Record<string, Array<Record<string, unknown>>> = {};
  for (const [t, arr] of Object.entries(config)) queues[t] = [...arr];
  mockSupabase.from.mockImplementation((table: string) => {
    const result = queues[table]?.length ? queues[table].shift()! : { data: null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    for (const m of ['select', 'eq', 'lt', 'order', 'limit', 'in']) chain[m] = vi.fn(() => chain);
    chain.insert = vi.fn(() => chain);
    chain.update = vi.fn(() => chain);
    chain.delete = vi.fn(() => chain);
    chain.single = vi.fn(() => Promise.resolve(result));
    chain.maybeSingle = vi.fn(() => Promise.resolve(result));
    chain.then = (resolve: (v: Record<string, unknown>) => unknown) => resolve(result);
    return chain;
  });
}

describe('POST /api/rbac/users — CSRF invalidation on role assignment', () => {
  it('clears BOTH the current and prev CSRF cookies after creating an invitation (consent default)', async () => {
    mockRequirePermission.mockResolvedValue({
      guildId: 'guild-1',
      discordId: '111111111111111111',
      isOwner: true,
    });
    mockParseBody.mockResolvedValue({
      ok: true,
      data: { discord_id: '222222222222222222', role_id: '00000000-0000-0000-0000-000000000001' },
    });
    mockLoadTeamConfig.mockResolvedValue({
      directAssignmentEnabled: false,
      inviteDmEnabled: true,
      maxPendingInvitations: 25,
      invitationExpiryMs: 259_200_000,
    });

    tableMock({
      dashboard_roles: [{ data: { priority: 1, is_system: false }, error: null }],
      dashboard_user_roles: [{ data: null, error: null }],
      team_invitations: [{ count: 0 }, { data: { id: 'inv-1', dashboard_roles: { name: 'member' } }, error: null }],
    });

    const res = await POST(buildRequest('/api/rbac/users', 'POST'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.mode).toBe('invitation');

    assertCookieCleared(res, CSRF_COOKIE_NAME);
    assertCookieCleared(res, CSRF_PREV_COOKIE_NAME);
  });

  it('clears BOTH CSRF cookies after a direct assignment when direct-assignment is enabled', async () => {
    mockRequirePermission.mockResolvedValue({
      guildId: 'guild-1',
      discordId: '111111111111111111',
      isOwner: true,
    });
    mockParseBody.mockResolvedValue({
      ok: true,
      data: { discord_id: '222222222222222222', role_id: '00000000-0000-0000-0000-000000000001' },
    });
    mockLoadTeamConfig.mockResolvedValue({
      directAssignmentEnabled: true,
      inviteDmEnabled: true,
      maxPendingInvitations: 25,
      invitationExpiryMs: 259_200_000,
    });

    tableMock({
      dashboard_roles: [{ data: { priority: 1, is_system: false }, error: null }],
      dashboard_user_roles: [{ data: { id: 'assignment-1', dashboard_roles: { name: 'member' } }, error: null }],
    });

    const res = await POST(buildRequest('/api/rbac/users', 'POST'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.mode).toBe('direct');

    assertCookieCleared(res, CSRF_COOKIE_NAME);
    assertCookieCleared(res, CSRF_PREV_COOKIE_NAME);
  });
});

describe('DELETE /api/rbac/users — CSRF invalidation on role removal', () => {
  it('clears BOTH the current and prev CSRF cookies after a successful removal', async () => {
    mockRequirePermission.mockResolvedValue({
      guildId: 'guild-1',
      discordId: '111111111111111111',
      isOwner: true,
    });
    // Route calls: admin.from(...).delete().eq('id', ...).eq('guild_id', ...)
    // The SECOND .eq() is terminal and must resolve { error: null }.
    let eqCall = 0;
    const deleteChain: Record<string, ReturnType<typeof vi.fn>> = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockImplementation(() => {
        eqCall++;
        return eqCall >= 2 ? Promise.resolve({ error: null }) : deleteChain;
      }),
    };
    mockSupabase.from.mockReturnValue(deleteChain);

    const res = await DELETE(buildRequest('/api/rbac/users?id=assignment-1', 'DELETE'));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    assertCookieCleared(res, CSRF_COOKIE_NAME);
    assertCookieCleared(res, CSRF_PREV_COOKIE_NAME);
  });
});
