/**
 * Regression tests for the CSRF rotation race (WAVE 2B [security]).
 *
 * The middleware rotates the CSRF cookie once it is older than 30 minutes.
 * Under concurrency (many dashboard tabs), multiple requests all observe the
 * same stale cookie and each independently rotate it. When rotation picks a
 * fresh *random* nonce per request, every response sets a different cookie and
 * embeds a different token — "cookie soup". A form rendered from one rotation
 * response carries a token that matches neither the surviving cookie nor the
 * single `prev` cookie, so a later submit is spuriously rejected with a 403.
 *
 * The fix makes rotation deterministic per (session, prior issuance): every
 * concurrent request that reads the same stale cookie derives the *same* new
 * nonce, so all responses agree on the cookie and the embedded token. No
 * request is spuriously rejected, and protection against a missing/wrong token
 * still holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';

import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import {
  deriveRotatedCsrf,
  csrfRotationSeed,
  verifyCsrfToken,
  generateCsrfToken,
  checkCsrf,
  CSRF_COOKIE_NAME,
  CSRF_PREV_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from '@/lib/api/csrf';

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(),
}));

const mockCreateServerClient = vi.mocked(createServerClient);

const USER_ID = 'zzz-abcdefabcdef012345'; // >16 chars; middleware uses last 16
const SESSION_ID = USER_ID.slice(-16);

/** Parse a `nonce:sessionId!timestamp` cookie value into its parts. */
function parseCsrfCookie(value: string): { nonce: string; sessionId: string; issuedAt: number } {
  const colonIdx = value.indexOf(':');
  const rest = value.slice(colonIdx + 1);
  const bangIdx = rest.lastIndexOf('!');
  return {
    nonce: value.slice(0, colonIdx),
    sessionId: bangIdx === -1 ? rest : rest.slice(0, bangIdx),
    issuedAt: bangIdx === -1 ? NaN : parseInt(rest.slice(bangIdx + 1), 10),
  };
}

describe('deriveRotatedCsrf — deterministic rotation', () => {
  it('derives the same nonce and token for the same (session, issuedAt)', async () => {
    const issuedAt = 1_700_000_000_000;
    const a = await deriveRotatedCsrf(SESSION_ID, issuedAt);
    const b = await deriveRotatedCsrf(SESSION_ID, issuedAt);
    expect(a.nonce).toBe(b.nonce);
    expect(a.token).toBe(b.token);
  });

  it('produces a token that verifies against its own nonce', async () => {
    const { token, nonce } = await deriveRotatedCsrf(SESSION_ID, 1_700_000_000_000);
    expect(await verifyCsrfToken(token, nonce, SESSION_ID)).toBe(true);
  });

  it('derives different nonces for different prior issuance timestamps', async () => {
    const a = await deriveRotatedCsrf(SESSION_ID, 1_700_000_000_000);
    const b = await deriveRotatedCsrf(SESSION_ID, 1_700_000_999_999);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('derives different nonces for different sessions', async () => {
    const a = await deriveRotatedCsrf('session-aaaaaaaa', 1_700_000_000_000);
    const b = await deriveRotatedCsrf('session-bbbbbbbb', 1_700_000_000_000);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('produces a 32-hex nonce and 64-hex token', async () => {
    const { token, nonce } = await deriveRotatedCsrf(SESSION_ID, 1_700_000_000_000);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a numeric seed and its stringified form derive the same nonce', async () => {
    // csrfRotationSeed returns a string; the HMAC input must be byte-identical
    // whether the middleware passes the number or the string form.
    const a = await deriveRotatedCsrf(SESSION_ID, 1_700_000_000_000);
    const b = await deriveRotatedCsrf(SESSION_ID, '1700000000000');
    expect(a.nonce).toBe(b.nonce);
    expect(a.token).toBe(b.token);
  });
});

describe('csrfRotationSeed — stable, clock-free rotation seed', () => {
  it('uses the issuance timestamp for a timestamped cookie', () => {
    expect(csrfRotationSeed(`${'a'.repeat(32)}:${SESSION_ID}!1700000000000`)).toBe('1700000000000');
  });

  it('uses the cookie prefix (not the clock) for a legacy timestamp-less cookie', () => {
    const legacy = `${'b'.repeat(32)}:${SESSION_ID}`;
    expect(csrfRotationSeed(legacy)).toBe(`legacy:${legacy}`);
  });

  it('is identical across repeated reads of the same legacy cookie', () => {
    // This is the property that makes concurrent legacy rotations converge:
    // the seed depends only on the cookie, never on Date.now().
    const legacy = `${'c'.repeat(32)}:${SESSION_ID}`;
    expect(csrfRotationSeed(legacy)).toBe(csrfRotationSeed(legacy));
  });

  it('legacy and timestamped seeds never collide', () => {
    // A legacy cookie whose prefix looks like a number must not derive the same
    // nonce as a timestamped cookie with that timestamp.
    const numericLike = '1700000000000';
    const legacy = `${'d'.repeat(32)}:${SESSION_ID}`;
    expect(csrfRotationSeed(legacy)).not.toBe(numericLike);
  });
});

describe('middleware CSRF rotation under concurrency', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.SESSION_TOKEN;
    delete process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE;
    delete process.env.SOMNIBOT_CSP_INLINE_COMPAT;
    process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-key';

    mockCreateServerClient.mockReturnValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } } }),
      },
    } as unknown as ReturnType<typeof createServerClient>);
  });

  const STALE_NONCE = 'deadbeefdeadbeefdeadbeefdeadbeef';

  /** Build a GET request carrying a stale (rotation-due) CSRF cookie. */
  function staleRequest(staleIssuedAt: number): NextRequest {
    const req = new NextRequest('http://localhost:3000/dashboard', {
      headers: { host: 'localhost:3000' },
    });
    req.cookies.set(CSRF_COOKIE_NAME, `${STALE_NONCE}:${SESSION_ID}!${staleIssuedAt}`);
    return req;
  }

  it('concurrent requests reading the same stale cookie all rotate to the same nonce', async () => {
    const { middleware } = await import('../middleware');
    const staleIssuedAt = Date.now() - 31 * 60 * 1000; // 31 min old → rotation due

    // Simulate N tabs firing at the rotation boundary. Each reads the SAME
    // stale cookie (identical issuedAt) — exactly the race condition.
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => middleware(staleRequest(staleIssuedAt))),
    );

    const newCookieValues = responses.map(
      (res) => res.cookies.get(CSRF_COOKIE_NAME)?.value ?? '',
    );

    for (const value of newCookieValues) {
      expect(value).not.toBe('');
    }

    // No cookie soup: all concurrent responses agree on the new nonce.
    const nonces = new Set(newCookieValues.map((v) => parseCsrfCookie(v).nonce));
    expect(nonces.size).toBe(1);
  });

  it("a form token from one rotation response validates against another response's surviving cookie", async () => {
    const { middleware } = await import('../middleware');
    const staleIssuedAt = Date.now() - 31 * 60 * 1000;

    const [resA, resB] = await Promise.all([
      middleware(staleRequest(staleIssuedAt)),
      middleware(staleRequest(staleIssuedAt)),
    ]);

    // A page rendered off response A embeds HMAC(nonceA). The client obtains
    // it from /api/csrf; here it corresponds to A's rotated nonce.
    const nonceA = parseCsrfCookie(resA.cookies.get(CSRF_COOKIE_NAME)!.value).nonce;
    const derived = await deriveRotatedCsrf(SESSION_ID, staleIssuedAt);
    expect(derived.nonce).toBe(nonceA); // rotation is deterministic
    const embeddedTokenA = derived.token;

    // The browser's cookie jar kept response B's cookie (last write wins).
    const cookieB = resB.cookies.get(CSRF_COOKIE_NAME)!.value;

    // A later mutating request carries A's embedded token but B's surviving cookie.
    const submit = new NextRequest('http://localhost:3000/api/config', {
      method: 'POST',
      headers: { host: 'localhost:3000', [CSRF_HEADER_NAME]: embeddedTokenA },
    });
    submit.cookies.set(CSRF_COOKIE_NAME, cookieB);

    expect(await checkCsrf(submit)).toBeNull();
  });

  it('still rejects a mutating request with a missing token after rotation', async () => {
    const { middleware } = await import('../middleware');
    const res = await middleware(
      new NextRequest('http://localhost:3000/api/config', {
        method: 'POST',
        headers: { host: 'localhost:3000' },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Missing CSRF token' });
  });

  it('still rejects a mutating request with a wrong token', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost:3000/api/config', {
      method: 'POST',
      headers: { host: 'localhost:3000', [CSRF_HEADER_NAME]: '0'.repeat(64) },
    });
    req.cookies.set(CSRF_COOKIE_NAME, `${STALE_NONCE}:${SESSION_ID}!${Date.now()}`);
    const res = await middleware(req);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Invalid CSRF token' });
  });

  it('stamps the prev cookie with the ROTATION time, not the stale issuance time', async () => {
    const { middleware } = await import('../middleware');
    // The stale cookie is 31 min old — that is what triggers rotation.
    const staleIssuedAt = Date.now() - 31 * 60 * 1000;
    const pre = await generateCsrfToken(SESSION_ID);
    const req = new NextRequest('http://localhost:3000/dashboard', {
      headers: { host: 'localhost:3000' },
    });
    req.cookies.set(CSRF_COOKIE_NAME, `${pre.nonce}:${SESSION_ID}!${staleIssuedAt}`);

    const before = Date.now();
    const res = await middleware(req);
    const after = Date.now();

    const prevValue = res.cookies.get(CSRF_PREV_COOKIE_NAME)!.value;
    const { nonce: prevNonce, issuedAt: prevIssuedAt } = parseCsrfCookie(prevValue);

    // Prev preserves the OLD nonce (so the old token still validates) …
    expect(prevNonce).toBe(pre.nonce);
    // … but is timestamped at rotation time, not 31 minutes ago. Without this,
    // the 60s grace-window check in checkCsrf rejects every in-flight old token.
    expect(prevIssuedAt).toBeGreaterThanOrEqual(before);
    expect(prevIssuedAt).toBeLessThanOrEqual(after);
    expect(prevIssuedAt).not.toBe(staleIssuedAt);
  });

  it('rotates a legacy cookie (no timestamp) without crashing', async () => {
    const { middleware } = await import('../middleware');
    const pre = await generateCsrfToken(SESSION_ID);
    const req = new NextRequest('http://localhost:3000/dashboard', {
      headers: { host: 'localhost:3000' },
    });
    // Legacy cookie: nonce:sessionId, no !timestamp → shouldRotateCsrf === true.
    req.cookies.set(CSRF_COOKIE_NAME, `${pre.nonce}:${SESSION_ID}`);

    const res = await middleware(req);
    const newCookie = res.cookies.get(CSRF_COOKIE_NAME)?.value;
    const prevCookie = res.cookies.get(CSRF_PREV_COOKIE_NAME)?.value;
    expect(newCookie).toBeTruthy();
    expect(parseCsrfCookie(newCookie!).nonce).toMatch(/^[0-9a-f]{32}$/);
    // Prev keeps the legacy nonce and gains a rotation timestamp.
    expect(prevCookie).toBeTruthy();
    expect(parseCsrfCookie(prevCookie!).nonce).toBe(pre.nonce);
    expect(Number.isNaN(parseCsrfCookie(prevCookie!).issuedAt)).toBe(false);
  });

  it('concurrent requests on the SAME legacy (timestamp-less) cookie all rotate to one nonce', async () => {
    // Regression for the residual gap: legacy cookies used to fall back to
    // Date.now() as the rotation seed, so concurrent tabs derived different
    // nonces and the cookie-soup race reappeared for legacy-cookie users. The
    // seed now comes from the cookie prefix, so all responses must converge.
    const { middleware } = await import('../middleware');
    const legacyPrefix = `${STALE_NONCE}:${SESSION_ID}`;

    const legacyRequest = (): NextRequest => {
      const req = new NextRequest('http://localhost:3000/dashboard', {
        headers: { host: 'localhost:3000' },
      });
      req.cookies.set(CSRF_COOKIE_NAME, legacyPrefix); // no !timestamp
      return req;
    };

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => middleware(legacyRequest())),
    );

    const nonces = new Set(
      responses.map((res) => parseCsrfCookie(res.cookies.get(CSRF_COOKIE_NAME)!.value).nonce),
    );
    expect(nonces.size).toBe(1);

    // And the converged nonce matches the deterministic derivation from the
    // legacy seed — proving it is clock-independent.
    const expected = await deriveRotatedCsrf(SESSION_ID, csrfRotationSeed(legacyPrefix));
    expect([...nonces][0]).toBe(expected.nonce);
  });

  it('does NOT grant a usable prev cookie when the stale cookie is from another session', async () => {
    // [security] After a logout/login or account switch, the browser can still
    // carry the PREVIOUS user's CSRF cookie (it is not cleared on sign-in).
    // Rotating for the newly authenticated session must not re-stamp that
    // foreign nonce:session as a fresh `prev` — otherwise checkCsrf's prev
    // branch (which verifies against the session embedded IN prev) would grant
    // the old user's token a 60s grace window under the NEW session.
    const { middleware } = await import('../middleware');
    const otherSession = 'oldsessionabcdef0'.slice(-16); // != SESSION_ID
    expect(otherSession).not.toBe(SESSION_ID);
    const staleIssuedAt = Date.now() - 31 * 60 * 1000;
    const pre = await generateCsrfToken(otherSession);

    const req = new NextRequest('http://localhost:3000/dashboard', {
      headers: { host: 'localhost:3000' },
    });
    // Cookie's embedded session is the PREVIOUS user; getUser() resolves to
    // USER_ID (see beforeEach), so the authenticated sessionId = SESSION_ID.
    req.cookies.set(CSRF_COOKIE_NAME, `${pre.nonce}:${otherSession}!${staleIssuedAt}`);

    const res = await middleware(req);

    // Current cookie is still rotated to the newly authenticated session …
    const newCookie = res.cookies.get(CSRF_COOKIE_NAME)!.value;
    expect(parseCsrfCookie(newCookie).sessionId).toBe(SESSION_ID);

    // … but the prev cookie is NOT set to the foreign token. It is either
    // absent or emitted as an expiring deletion (Max-Age=0). Either way, a real
    // browser ends up with no usable prev cookie carrying the old user's nonce.
    const prevValue = res.cookies.get(CSRF_PREV_COOKIE_NAME)?.value ?? '';
    expect(prevValue).not.toContain(pre.nonce);
  });

  it('still grants prev grace on a same-session rotation (regression guard for the mismatch check)', async () => {
    const { middleware } = await import('../middleware');
    const staleIssuedAt = Date.now() - 31 * 60 * 1000;
    const pre = await generateCsrfToken(SESSION_ID); // SAME session as the user
    const req = new NextRequest('http://localhost:3000/dashboard', {
      headers: { host: 'localhost:3000' },
    });
    req.cookies.set(CSRF_COOKIE_NAME, `${pre.nonce}:${SESSION_ID}!${staleIssuedAt}`);

    const res = await middleware(req);
    const prevValue = res.cookies.get(CSRF_PREV_COOKIE_NAME)?.value ?? '';
    // Same session → the old nonce IS preserved for the grace window.
    expect(prevValue).toContain(pre.nonce);
  });

  it('preserves the pre-rotation token via the prev cookie during the grace window', async () => {
    const { middleware } = await import('../middleware');
    const staleIssuedAt = Date.now() - 31 * 60 * 1000;

    // Use a real generated token so we know the pre-rotation token value.
    const pre = await generateCsrfToken(SESSION_ID);
    const req = new NextRequest('http://localhost:3000/dashboard', {
      headers: { host: 'localhost:3000' },
    });
    req.cookies.set(CSRF_COOKIE_NAME, `${pre.nonce}:${SESSION_ID}!${staleIssuedAt}`);

    const res = await middleware(req);
    const prevCookie = res.cookies.get(CSRF_PREV_COOKIE_NAME)?.value;
    const newCookie = res.cookies.get(CSRF_COOKIE_NAME)?.value;
    expect(prevCookie).toBeTruthy();
    expect(newCookie).toBeTruthy();

    // An in-flight request that still holds the OLD token must be accepted via
    // the prev cookie within the grace window.
    const inflight = new NextRequest('http://localhost:3000/api/config', {
      method: 'POST',
      headers: { host: 'localhost:3000', [CSRF_HEADER_NAME]: pre.token },
    });
    inflight.cookies.set(CSRF_COOKIE_NAME, newCookie!);
    inflight.cookies.set(CSRF_PREV_COOKIE_NAME, prevCookie!);

    expect(await checkCsrf(inflight)).toBeNull();
  });

  it('rebinds a FOREIGN-session cookie even when it is NOT rotation-due (R8 session-binding)', async () => {
    // [security] R8 root fix. Before this, the middleware only rebound the CSRF
    // cookie on a *time-based* rotation. After an account switch the previous
    // user's cookie is still in the browser; if it is not yet 30min old, no
    // rotation fired, so the current (and prev) cookie stayed bound to the OLD
    // session and the old user's token kept passing under the NEW session. The
    // session-binding invariant now forces a rebind on ANY session mismatch.
    const { middleware } = await import('../middleware');
    const otherSession = 'oldsessionabcdef0'.slice(-16);
    expect(otherSession).not.toBe(SESSION_ID);

    // FRESH foreign cookie (1 min old → NOT rotation-due) plus a fresh foreign
    // prev, as if the previous user rotated moments before switching accounts.
    const freshIssuedAt = Date.now() - 60_000;
    const foreign = await generateCsrfToken(otherSession);
    const foreignPrev = await generateCsrfToken(otherSession);
    const req = new NextRequest('http://localhost:3000/dashboard', {
      headers: { host: 'localhost:3000' },
    });
    req.cookies.set(CSRF_COOKIE_NAME, `${foreign.nonce}:${otherSession}!${freshIssuedAt}`);
    req.cookies.set(CSRF_PREV_COOKIE_NAME, `${foreignPrev.nonce}:${otherSession}!${freshIssuedAt}`);

    const res = await middleware(req);

    // Current cookie is rebound to the AUTHENTICATED session with a fresh random
    // nonce — never derived from the foreign cookie's seed.
    const newCookie = res.cookies.get(CSRF_COOKIE_NAME)!.value;
    expect(parseCsrfCookie(newCookie).sessionId).toBe(SESSION_ID);
    expect(parseCsrfCookie(newCookie).nonce).not.toBe(foreign.nonce);
    const foreignDerived = await deriveRotatedCsrf(SESSION_ID, csrfRotationSeed(`${foreign.nonce}:${otherSession}!${freshIssuedAt}`));
    expect(parseCsrfCookie(newCookie).nonce).not.toBe(foreignDerived.nonce);

    // The stale prev cookie is actively expired (Max-Age=0 / epoch expiry).
    const prevCookie = res.cookies.get(CSRF_PREV_COOKIE_NAME);
    expect(prevCookie?.value ?? '').not.toContain(foreignPrev.nonce);

    // Neither the old current token nor the old prev token validates under the
    // new session against the rebound cookies.
    for (const staleToken of [foreign.token, foreignPrev.token]) {
      const submit = new NextRequest('http://localhost:3000/api/config', {
        method: 'POST',
        headers: { host: 'localhost:3000', [CSRF_HEADER_NAME]: staleToken },
      });
      submit.cookies.set(CSRF_COOKIE_NAME, newCookie);
      if (prevCookie?.value) submit.cookies.set(CSRF_PREV_COOKIE_NAME, prevCookie.value);
      const err = await checkCsrf(submit);
      expect(err).not.toBeNull();
      expect(err!.status).toBe(403);
    }
  });
});
