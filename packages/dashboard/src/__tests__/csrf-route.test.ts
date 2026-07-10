import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { SupabaseRuntimeConfigError } from '@/lib/supabase/runtime-config';
import { GET } from '@/app/api/csrf/route';
import {
  deriveRotatedCsrf,
  csrfRotationSeed,
  verifyCsrfToken,
  CSRF_COOKIE_NAME,
} from '@/lib/api/csrf';

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: vi.fn(),
}));

const mockCreateServerSupabase = vi.mocked(createServerSupabase);

/** Extract the somnibot-csrf-token cookie value from a Set-Cookie header. */
function csrfCookieFromResponse(setCookie: string): string {
  const match = setCookie.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}

/** Build a request whose cookie jar carries an existing CSRF cookie. */
function requestWithCookie(cookieValue: string): NextRequest {
  const req = new NextRequest('http://localhost:3000/api/csrf', {
    headers: { host: 'localhost:3000' },
  });
  req.cookies.set(CSRF_COOKIE_NAME, cookieValue);
  return req;
}

/** Build a request with no CSRF cookie (fresh-token path). */
function bareRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/csrf', {
    headers: { host: 'localhost:3000' },
  });
}

describe('GET /api/csrf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SESSION_TOKEN;
    delete process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE;
    process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';

    mockCreateServerSupabase.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-id-1234567890abcdef' } },
        }),
      },
    } as unknown as Awaited<ReturnType<typeof createServerSupabase>>);
  });

  it('does not use local fixed session when SESSION_TOKEN lacks launcher marker', async () => {
    process.env.SESSION_TOKEN = 'accidental-cloud-token';

    const response = await GET(bareRequest());

    expect(mockCreateServerSupabase).toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('1234567890abcdef');
  });

  it('uses local fixed session only with explicit launcher marker', async () => {
    process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE = '1';
    process.env.SESSION_TOKEN = 'launcher-token';

    const response = await GET(bareRequest());

    expect(mockCreateServerSupabase).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('local-session');
  });

  const SESSION_ID = '1234567890abcdef'; // user-id-1234567890abcdef.slice(-16)

  it('converges token issuance with an existing same-session cookie (no cookie-soup race)', async () => {
    // [security] The middleware rotates the cookie deterministically. /api/csrf
    // must also be deterministic for the same existing cookie, otherwise
    // concurrent tabs re-fetching after rotation overwrite the cookie with
    // different random tokens and lose the last-Set-Cookie race.
    const staleIssuedAt = 1_700_000_000_000;
    const existing = `${'a'.repeat(32)}:${SESSION_ID}!${staleIssuedAt}`;

    // Two concurrent /api/csrf calls reading the same existing cookie.
    const [resA, resB] = await Promise.all([
      GET(requestWithCookie(existing)),
      GET(requestWithCookie(existing)),
    ]);

    const bodyA = await resA.json();
    const bodyB = await resB.json();
    // Same token issued to both tabs.
    expect(bodyA.token).toBe(bodyB.token);

    // Same cookie value set by both responses — byte-identical, no soup.
    const cookieA = csrfCookieFromResponse(resA.headers.get('set-cookie') ?? '');
    const cookieB = csrfCookieFromResponse(resB.headers.get('set-cookie') ?? '');
    expect(cookieA).toBe(cookieB);

    // And it matches exactly what the middleware would derive from the same seed.
    const expected = await deriveRotatedCsrf(SESSION_ID, csrfRotationSeed(existing));
    expect(bodyA.token).toBe(expected.token);
    expect(cookieA).toBe(`${expected.nonce}:${SESSION_ID}!${staleIssuedAt}`);
  });

  it('the issued token validates against its own cookie nonce', async () => {
    const existing = `${'b'.repeat(32)}:${SESSION_ID}!1700000000000`;
    const res = await GET(requestWithCookie(existing));
    const { token } = await res.json();
    const cookie = csrfCookieFromResponse(res.headers.get('set-cookie') ?? '');
    const nonce = cookie.slice(0, cookie.indexOf(':'));
    expect(await verifyCsrfToken(token, nonce, SESSION_ID)).toBe(true);
  });

  it('does NOT reuse a cookie from a different session (mints a fresh random token)', async () => {
    // A stale cross-session cookie (post logout/login) must never seed the new
    // session's token. Falls through to a fresh random token bound to the
    // authenticated session.
    const foreign = `${'c'.repeat(32)}:oldsessionabcdef!1700000000000`;
    const res = await GET(requestWithCookie(foreign));
    const { token } = await res.json();
    const cookie = csrfCookieFromResponse(res.headers.get('set-cookie') ?? '');

    // Cookie is rebound to the authenticated session, not the foreign one.
    expect(cookie).toContain(`:${SESSION_ID}!`);
    expect(cookie).not.toContain('oldsessionabcdef');

    // And it is NOT the deterministic derivation from the foreign seed.
    const foreignDerived = await deriveRotatedCsrf(SESSION_ID, csrfRotationSeed(foreign));
    expect(token).not.toBe(foreignDerived.token);

    // The token still validates against its own freshly-set cookie nonce.
    const nonce = cookie.slice(0, cookie.indexOf(':'));
    expect(await verifyCsrfToken(token, nonce, SESSION_ID)).toBe(true);
  });

  it('still works when called with no request (mints a fresh random token)', async () => {
    const res = await GET(bareRequest());
    const { token } = await res.json();
    const cookie = csrfCookieFromResponse(res.headers.get('set-cookie') ?? '');
    const nonce = cookie.slice(0, cookie.indexOf(':'));
    expect(cookie).toContain(`:${SESSION_ID}!`);
    expect(await verifyCsrfToken(token, nonce, SESSION_ID)).toBe(true);
  });

  it('issues a setup token without Supabase public runtime config', async () => {
    mockCreateServerSupabase.mockRejectedValueOnce(
      new SupabaseRuntimeConfigError(
        'MISSING_PUBLIC_SUPABASE_CONFIG',
        'public config missing during first-run setup',
      ),
    );

    const response = await GET(bareRequest());
    const body = await response.json();

    expect(body.token).toEqual(expect.any(String));
    expect(mockCreateServerSupabase).toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('somnibot-csrf-token=');
  });
});
