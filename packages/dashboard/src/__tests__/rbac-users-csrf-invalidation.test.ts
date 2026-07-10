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

const mockSupabase = { from: vi.fn() };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => mockSupabase,
}));

import { POST, DELETE } from '../app/api/rbac/users/route';

// ── Helpers ─────────────────────────────────────────────────

/**
 * A `NextResponse.cookies.delete(name)` sets an expired cookie: the value
 * becomes '' and `expires` is set to the Unix epoch (a past date). Assert both
 * markers so a plain `.set(...)` can't masquerade as a delete.
 */
function assertCookieCleared(res: import('next/server').NextResponse, name: string): void {
  const cookie = res.cookies.get(name);
  expect(cookie, `expected ${name} to be present as an expiry cookie`).toBeTruthy();
  expect(cookie!.value).toBe('');
  expect(cookie!.expires, `expected ${name} to be expired`).toBeDefined();
  expect(new Date(cookie!.expires!).getTime()).toBeLessThan(Date.now());
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
});

describe('POST /api/rbac/users — CSRF invalidation on role assignment', () => {
  it('clears BOTH the current and prev CSRF cookies after a successful assignment', async () => {
    mockRequirePermission.mockResolvedValue({
      guildId: 'guild-1',
      discordId: '111111111111111111',
      isOwner: true,
    });
    mockParseBody.mockResolvedValue({
      ok: true,
      data: { discord_id: '222222222222222222', role_id: '00000000-0000-0000-0000-000000000001' },
    });

    // from('dashboard_roles') → target role lookup; from('dashboard_user_roles') → insert.
    let fromCall = 0;
    mockSupabase.from.mockImplementation(() => {
      fromCall++;
      if (fromCall === 1) {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { priority: 1, is_system: false },
            error: null,
          }),
        };
      }
      return {
        insert: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'assignment-1', dashboard_roles: { name: 'member' } },
          error: null,
        }),
      };
    });

    const res = await POST(buildRequest('/api/rbac/users', 'POST'));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

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
