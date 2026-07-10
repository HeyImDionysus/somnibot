import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { SupabaseRuntimeConfigError } from '@/lib/supabase/runtime-config';
import { GET } from '@/app/api/csrf/route';
import {
  deriveRotatedCsrf,
  signExistingCsrf,
  csrfRotationSeed,
  verifyCsrfToken,
  CSRF_COOKIE_NAME,
  CSRF_PREV_COOKIE_NAME,
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

/** Extract the somnibot-csrf-prev cookie value from a Set-Cookie header. */
function prevCookieFromResponse(setCookie: string): string {
  const match = setCookie.match(new RegExp(`${CSRF_PREV_COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}

/** Parse the nonce out of a `nonce:sessionId!timestamp` cookie value. */
function nonceOf(cookieValue: string): string {
  return cookieValue.slice(0, cookieValue.indexOf(':'));
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

  it('reuses the existing nonce (byte-stable, no prev) for a same-session cookie that is NOT due for rotation', async () => {
    // [security] Regression for the residual gap: when a same-session cookie is
    // still fresh, /api/csrf must re-sign the EXISTING nonce and keep the cookie
    // byte-identical. Previously it derived a NEW nonce on every fetch without a
    // prev cookie, so a tab still holding the pre-fetch token was rejected once
    // another tab refreshed. Re-signing the existing nonce keeps every holder of
    // that nonce valid and never rotates on a mere refresh.
    const freshIssuedAt = Date.now() - 60_000; // 1 min old → NOT rotation-due
    const existingNonce = 'a'.repeat(32);
    const existing = `${existingNonce}:${SESSION_ID}!${freshIssuedAt}`;

    const [resA, resB] = await Promise.all([
      GET(requestWithCookie(existing)),
      GET(requestWithCookie(existing)),
    ]);

    const bodyA = await resA.json();
    const bodyB = await resB.json();
    // Same token issued to both tabs.
    expect(bodyA.token).toBe(bodyB.token);

    // Cookie value is byte-identical to the incoming cookie — nonce and
    // timestamp preserved, so no rotation clock reset and no cookie soup.
    const cookieA = csrfCookieFromResponse(resA.headers.get('set-cookie') ?? '');
    const cookieB = csrfCookieFromResponse(resB.headers.get('set-cookie') ?? '');
    expect(cookieA).toBe(cookieB);
    expect(cookieA).toBe(existing);
    expect(nonceOf(cookieA)).toBe(existingNonce);

    // Token is exactly HMAC(existingNonce, session) — a holder of that nonce stays valid.
    const expected = await signExistingCsrf(existingNonce, SESSION_ID);
    expect(bodyA.token).toBe(expected.token);

    // No prev cookie is issued when nothing rotated.
    expect(prevCookieFromResponse(resA.headers.get('set-cookie') ?? '')).toBe('');
  });

  it('rotates deterministically AND sets prev for a same-session cookie that IS due for rotation', async () => {
    // [security] When the same-session cookie is stale, /api/csrf rotates it
    // deterministically (converging with the middleware) and MUST also set the
    // prev cookie so an in-flight tab still holding the pre-rotation token is
    // accepted during the grace window.
    const staleIssuedAt = 1_700_000_000_000; // 2023 → rotation-due
    const oldNonce = 'a'.repeat(32);
    const existing = `${oldNonce}:${SESSION_ID}!${staleIssuedAt}`;

    const [resA, resB] = await Promise.all([
      GET(requestWithCookie(existing)),
      GET(requestWithCookie(existing)),
    ]);

    const bodyA = await resA.json();
    const bodyB = await resB.json();
    // Deterministic: both tabs get the same rotated token.
    expect(bodyA.token).toBe(bodyB.token);

    // The rotated nonce/token match exactly what the middleware derives from the
    // same seed — the security-relevant convergence property. (The `!timestamp`
    // is advanced to rotation time; it is not part of the token and checkCsrf
    // strips it before verifying, so a 1ms skew between responses is harmless.)
    const expected = await deriveRotatedCsrf(SESSION_ID, csrfRotationSeed(existing));
    expect(bodyA.token).toBe(expected.token);
    const cookieA = csrfCookieFromResponse(resA.headers.get('set-cookie') ?? '');
    expect(nonceOf(cookieA)).toBe(expected.nonce);
    expect(cookieA).toContain(`:${SESSION_ID}!`);

    // Prev cookie preserves the OLD nonce so the pre-rotation token has grace.
    const prevA = prevCookieFromResponse(resA.headers.get('set-cookie') ?? '');
    expect(prevA).toContain(oldNonce);
    expect(prevA).toContain(`:${SESSION_ID}!`);
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
