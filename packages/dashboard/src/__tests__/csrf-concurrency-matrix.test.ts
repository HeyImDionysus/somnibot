/**
 * CSRF concurrency matrix — exhaustive interleaving test suite (WAVE 2B [security]).
 *
 * Three actors touch the CSRF cookies:
 *   A = GET /api/csrf                      (token issuance / refresh / rotation)
 *   M = middleware rotation                (rotates on any request when due)
 *   R = RBAC invalidateCsrfCookies         (clears cookies on role assign/remove)
 *
 * Across concurrent responses, cookie writes are LAST-WRITE-WINS in the browser
 * jar. Every previously-reported race reduced to a "reuse the existing cookie"
 * response re-emitting a cookie that a concurrent "advance the world" response
 * (rotation or invalidation) was replacing — rolling a rotation back or
 * resurrecting an invalidated cookie.
 *
 * This suite models the browser jar explicitly (`CookieJar`) and drives the
 * concurrent interleavings with awaited promise ordering so each response's
 * Set-Cookie is applied in a chosen order. For every matrix row it asserts the
 * invariant that row must uphold.
 *
 * Matrix rows (see also the PR description):
 *   R1  two A fetches, both NOT due                → converge, no cookie write
 *   R2  two A fetches, both DUE (rotation)         → converge on one nonce
 *   R3  two A fetches STRADDLING the due boundary  → not-due never rolls back rotation
 *   R4  A (not-due) ‖ M rotation                   → refresh never rolls back M
 *   R5  A (due) ‖ M rotation                       → both derive the SAME nonce
 *   R6  R invalidation ‖ A (not-due)               → invalidated cookie not resurrected
 *   R7  R invalidation ‖ A (due) / M               → fresh mint after; session bound
 *   R8  session switch A→B with leftover cookies   → B never validated by A's token/grace
 *   R9  invalidateCsrfCookies path correctness     → deletes root-path cookies
 *   R10 prev grace bound to active session         → cross-session prev rejected
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createServerSupabase } from '@/lib/supabase/server';
import { GET } from '@/app/api/csrf/route';
import {
  deriveRotatedCsrf,
  generateCsrfToken,
  csrfRotationSeed,
  checkCsrf,
  invalidateCsrfCookies,
  CSRF_COOKIE_NAME,
  CSRF_PREV_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from '@/lib/api/csrf';

vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: vi.fn() }));

const mockCreateServerClient = vi.mocked(createServerClient);
const mockCreateServerSupabase = vi.mocked(createServerSupabase);

const USER_A = 'user-A-1234567890abcdef';
const USER_B = 'user-B-fedcba0987654321';
const SESSION_A = USER_A.slice(-16);
const SESSION_B = USER_B.slice(-16);

const ROTATE_MS = 30 * 60 * 1000;
const staleIssuedAt = (): number => Date.now() - (ROTATE_MS + 60_000); // >30min → due
const freshIssuedAt = (): number => Date.now() - 60_000; // 1min → not due

/* ------------------------------------------------------------------ */
/*  Browser cookie jar with last-write-wins + expiry semantics.        */
/* ------------------------------------------------------------------ */

interface JarEntry { value: string; expired: boolean }

class CookieJar {
  private store = new Map<string, JarEntry>();

  /** Apply a NextResponse's Set-Cookie writes in emission order (last wins). */
  apply(res: NextResponse): void {
    for (const c of res.cookies.getAll()) {
      const expired =
        c.value === '' ||
        (c.expires !== undefined && new Date(c.expires).getTime() < Date.now()) ||
        (typeof c.maxAge === 'number' && c.maxAge <= 0);
      if (expired) {
        this.store.delete(c.name);
      } else {
        this.store.set(c.name, { value: c.value, expired: false });
      }
    }
  }

  get(name: string): string | undefined {
    return this.store.get(name)?.value;
  }

  /** Load the jar's current cookies onto a request. */
  onto(req: NextRequest): NextRequest {
    for (const [name, entry] of this.store) req.cookies.set(name, entry.value);
    return req;
  }
}

/* ------------------------------------------------------------------ */
/*  Request builders + validation helper.                              */
/* ------------------------------------------------------------------ */

function csrfGetRequest(cookies?: Record<string, string>): NextRequest {
  const req = new NextRequest('http://localhost:3000/api/csrf', {
    headers: { host: 'localhost:3000' },
  });
  if (cookies) for (const [k, v] of Object.entries(cookies)) req.cookies.set(k, v);
  return req;
}

function dashboardRequest(cookies?: Record<string, string>): NextRequest {
  const req = new NextRequest('http://localhost:3000/dashboard', {
    headers: { host: 'localhost:3000' },
  });
  if (cookies) for (const [k, v] of Object.entries(cookies)) req.cookies.set(k, v);
  return req;
}

/** Simulate a stale tab submitting a mutating request with a held token. */
async function submit(jar: CookieJar, headerToken: string): Promise<boolean> {
  const req = new NextRequest('http://localhost:3000/api/economy/config', {
    method: 'POST',
    headers: { host: 'localhost:3000', [CSRF_HEADER_NAME]: headerToken },
  });
  jar.onto(req);
  const err = await checkCsrf(req);
  return err === null; // true = accepted
}

/** Read the current token issued for the jar's cookie by fetching /api/csrf. */
async function fetchToken(jar: CookieJar): Promise<string> {
  const req = jar.onto(csrfGetRequest());
  const res = await GET(req);
  jar.apply(res);
  const { token } = await res.json();
  return token;
}

function mockUser(id: string | null): void {
  mockCreateServerClient.mockReturnValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: id ? { id } : null } }) },
  } as unknown as ReturnType<typeof createServerClient>);
  mockCreateServerSupabase.mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: id ? { id } : null } }) },
  } as unknown as Awaited<ReturnType<typeof createServerSupabase>>);
}

function parseNonce(cookieValue: string): string {
  return cookieValue.slice(0, cookieValue.indexOf(':'));
}

let middleware: typeof import('../middleware').middleware;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env.SESSION_TOKEN;
  delete process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE;
  delete process.env.SOMNIBOT_CSP_INLINE_COMPAT;
  process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-key';
  mockUser(USER_A);
  ({ middleware } = await import('../middleware'));
});

/* ================================================================== */
/*  R1 — two A fetches, both NOT due for rotation.                     */
/* ================================================================== */

describe('R1 — two concurrent /api/csrf fetches, NOT due', () => {
  it('converge on one token and write NO cookie, in either apply order', async () => {
    const nonce = 'a'.repeat(32);
    const cookie = `${nonce}:${SESSION_A}!${freshIssuedAt()}`;

    const [resA, resB] = await Promise.all([
      GET(csrfGetRequest({ [CSRF_COOKIE_NAME]: cookie })),
      GET(csrfGetRequest({ [CSRF_COOKIE_NAME]: cookie })),
    ]);

    const tokenA = (await resA.json()).token;
    const tokenB = (await resB.json()).token;
    expect(tokenA).toBe(tokenB); // converge

    // Neither response writes the CSRF cookie — a refresh cannot lose a race.
    expect(resA.cookies.get(CSRF_COOKIE_NAME)).toBeUndefined();
    expect(resB.cookies.get(CSRF_COOKIE_NAME)).toBeUndefined();

    // Apply BOTH orders — the surviving cookie is the untouched original, and the
    // issued token still validates against it.
    for (const [first, second] of [[resA, resB], [resB, resA]] as const) {
      const jar = new CookieJar();
      jar.apply(new NextResponse(null, { headers: { 'set-cookie': `${CSRF_COOKIE_NAME}=${cookie}` } }));
      jar.apply(first);
      jar.apply(second);
      expect(jar.get(CSRF_COOKIE_NAME)).toBe(cookie);
      expect(await submit(jar, tokenA)).toBe(true);
    }
  });
});

/* ================================================================== */
/*  R2 — two A fetches, both DUE for rotation.                         */
/* ================================================================== */

describe('R2 — two concurrent /api/csrf fetches, DUE (rotation)', () => {
  it('converge on one rotated nonce/token/cookie + prev', async () => {
    const oldNonce = 'b'.repeat(32);
    const cookie = `${oldNonce}:${SESSION_A}!${staleIssuedAt()}`;

    const [resA, resB] = await Promise.all([
      GET(csrfGetRequest({ [CSRF_COOKIE_NAME]: cookie })),
      GET(csrfGetRequest({ [CSRF_COOKIE_NAME]: cookie })),
    ]);

    const tokenA = (await resA.json()).token;
    const tokenB = (await resB.json()).token;
    expect(tokenA).toBe(tokenB);

    const nonceA = parseNonce(resA.cookies.get(CSRF_COOKIE_NAME)!.value);
    const nonceB = parseNonce(resB.cookies.get(CSRF_COOKIE_NAME)!.value);
    expect(nonceA).toBe(nonceB); // one rotated nonce

    // Matches the deterministic derivation from the shared stale-cookie seed.
    const expected = await deriveRotatedCsrf(SESSION_A, csrfRotationSeed(cookie));
    expect(nonceA).toBe(expected.nonce);
    expect(tokenA).toBe(expected.token);

    // Both set a prev cookie carrying the OLD nonce (grace for in-flight tokens).
    expect(resA.cookies.get(CSRF_PREV_COOKIE_NAME)!.value).toContain(oldNonce);
    expect(resB.cookies.get(CSRF_PREV_COOKIE_NAME)!.value).toContain(oldNonce);
  });
});

/* ================================================================== */
/*  R3 — two A fetches straddling the rotation due boundary.          */
/*  (route.ts:136 finding)                                            */
/* ================================================================== */

describe('R3 — /api/csrf straddling the rotation boundary', () => {
  it('the NOT-due response never rolls back the concurrent rotation (either apply order)', async () => {
    const oldNonce = 'c'.repeat(32);
    const dueCookie = `${oldNonce}:${SESSION_A}!${staleIssuedAt()}`;
    const notDueCookie = `${oldNonce}:${SESSION_A}!${freshIssuedAt()}`;

    // Two requests read the "same" logical cookie but one observes it as due and
    // the other as not-due (the boundary crossing). Model that directly.
    const resDue = await GET(csrfGetRequest({ [CSRF_COOKIE_NAME]: dueCookie }));
    const resNotDue = await GET(csrfGetRequest({ [CSRF_COOKIE_NAME]: notDueCookie }));

    const rotatedToken = (await resDue.json()).token;
    const rotatedCookie = resDue.cookies.get(CSRF_COOKIE_NAME)!.value;
    const prevCookie = resDue.cookies.get(CSRF_PREV_COOKIE_NAME)!.value;

    // The not-due response writes NO cookie, so whichever lands last, the rotated
    // cookie + prev survive.
    expect(resNotDue.cookies.get(CSRF_COOKIE_NAME)).toBeUndefined();

    for (const applyOrder of [[resDue, resNotDue], [resNotDue, resDue]] as const) {
      const jar = new CookieJar();
      jar.apply(new NextResponse(null, { headers: { 'set-cookie': `${CSRF_COOKIE_NAME}=${dueCookie}` } }));
      for (const r of applyOrder) jar.apply(r);
      // The rotation stands regardless of order.
      expect(jar.get(CSRF_COOKIE_NAME)).toBe(rotatedCookie);
      expect(jar.get(CSRF_PREV_COOKIE_NAME)).toBe(prevCookie);
      // The tab that received the rotated token validates.
      expect(await submit(jar, rotatedToken)).toBe(true);
    }
  });
});

/* ================================================================== */
/*  R4 — A (not-due) concurrent with M rotation on another request.  */
/* ================================================================== */

describe('R4 — /api/csrf (not-due) ‖ middleware rotation', () => {
  it('the refresh never rolls back the middleware rotation', async () => {
    const oldNonce = 'd'.repeat(32);
    const dueCookie = `${oldNonce}:${SESSION_A}!${staleIssuedAt()}`;
    const notDueCookie = `${oldNonce}:${SESSION_A}!${freshIssuedAt()}`;

    const mRes = await middleware(dashboardRequest({ [CSRF_COOKIE_NAME]: dueCookie }));
    const aRes = await GET(csrfGetRequest({ [CSRF_COOKIE_NAME]: notDueCookie }));

    const rotatedCookie = mRes.cookies.get(CSRF_COOKIE_NAME)!.value;
    const rotatedNonce = parseNonce(rotatedCookie);
    const rotatedToken = (await deriveRotatedCsrf(SESSION_A, csrfRotationSeed(dueCookie))).token;

    expect(aRes.cookies.get(CSRF_COOKIE_NAME)).toBeUndefined(); // refresh writes nothing

    for (const applyOrder of [[mRes, aRes], [aRes, mRes]] as const) {
      const jar = new CookieJar();
      jar.apply(new NextResponse(null, { headers: { 'set-cookie': `${CSRF_COOKIE_NAME}=${dueCookie}` } }));
      for (const r of applyOrder) jar.apply(r);
      expect(parseNonce(jar.get(CSRF_COOKIE_NAME)!)).toBe(rotatedNonce);
      expect(await submit(jar, rotatedToken)).toBe(true);
    }
  });
});

/* ================================================================== */
/*  R5 — A (due) concurrent with M rotation: same nonce.             */
/* ================================================================== */

describe('R5 — /api/csrf (due) ‖ middleware rotation', () => {
  it('both derive the SAME rotated nonce from the same stale-cookie seed', async () => {
    const oldNonce = 'e'.repeat(32);
    const dueCookie = `${oldNonce}:${SESSION_A}!${staleIssuedAt()}`;

    const [mRes, aRes] = await Promise.all([
      middleware(dashboardRequest({ [CSRF_COOKIE_NAME]: dueCookie })),
      GET(csrfGetRequest({ [CSRF_COOKIE_NAME]: dueCookie })),
    ]);

    const mNonce = parseNonce(mRes.cookies.get(CSRF_COOKIE_NAME)!.value);
    const aNonce = parseNonce(aRes.cookies.get(CSRF_COOKIE_NAME)!.value);
    expect(mNonce).toBe(aNonce);

    // And the token the route returned validates against the middleware cookie.
    const aToken = (await aRes.json()).token;
    const jar = new CookieJar();
    jar.apply(mRes); // middleware cookie survives
    expect(await submit(jar, aToken)).toBe(true);
  });
});

/* ================================================================== */
/*  R6 — R invalidation concurrent with A (not-due).                 */
/*  (route.ts:95 finding)                                            */
/* ================================================================== */

describe('R6 — RBAC invalidation ‖ /api/csrf (not-due)', () => {
  it('the refresh does NOT resurrect the invalidated cookie (either apply order)', async () => {
    const nonce = 'f'.repeat(32);
    const cookie = `${nonce}:${SESSION_A}!${freshIssuedAt()}`;
    // The stale tab holds the token for THIS cookie's nonce — exactly what would
    // start passing again if the refresh resurrected the cookie.
    const heldToken = (await GET(csrfGetRequest({ [CSRF_COOKIE_NAME]: cookie })).then((r) => r.json())).token;

    // R invalidation response.
    const rRes = NextResponse.json({ success: true });
    invalidateCsrfCookies(rRes);

    // A refresh response for the still-present cookie.
    const aRes = await GET(csrfGetRequest({ [CSRF_COOKIE_NAME]: cookie }));
    expect(aRes.cookies.get(CSRF_COOKIE_NAME)).toBeUndefined(); // writes nothing

    for (const applyOrder of [[rRes, aRes], [aRes, rRes]] as const) {
      const jar = new CookieJar();
      jar.apply(new NextResponse(null, { headers: { 'set-cookie': `${CSRF_COOKIE_NAME}=${cookie}` } }));
      for (const r of applyOrder) jar.apply(r);
      // The invalidation's deletion is never resurrected by the refresh.
      expect(jar.get(CSRF_COOKIE_NAME)).toBeUndefined();
      // A stale tab's held token is rejected (no cookie present).
      expect(await submit(jar, heldToken)).toBe(false);
    }
  });
});

/* ================================================================== */
/*  R7 — R invalidation then fresh re-fetch mints a session-bound     */
/*  fresh token; a cross/old cookie can never seed it.                */
/* ================================================================== */

describe('R7 — after RBAC invalidation, the next fetch mints a fresh session-bound token', () => {
  it('re-fetch with no cookie mints a fresh random token bound to the active session', async () => {
    const jar = new CookieJar();
    // Post-invalidation: jar has no CSRF cookie.
    const token = await fetchToken(jar);
    const cookie = jar.get(CSRF_COOKIE_NAME)!;
    expect(cookie).toContain(`:${SESSION_A}!`);
    // Token validates against its own fresh cookie.
    expect(await submit(jar, token)).toBe(true);
  });

  it('a leftover cross-session cookie can never seed the new session token', async () => {
    const foreign = `${'0'.repeat(32)}:${SESSION_B}!${staleIssuedAt()}`;
    const res = await GET(csrfGetRequest({ [CSRF_COOKIE_NAME]: foreign }));
    const cookie = res.cookies.get(CSRF_COOKIE_NAME)!.value;
    expect(cookie).toContain(`:${SESSION_A}!`);
    expect(cookie).not.toContain(SESSION_B);
    // Not the deterministic derivation from the foreign seed.
    const foreignDerived = await deriveRotatedCsrf(SESSION_A, csrfRotationSeed(foreign));
    expect((await res.json()).token).not.toBe(foreignDerived.token);
  });
});

/* ================================================================== */
/*  R8 — session switch A→B with a leftover prev/current cookie.     */
/* ================================================================== */

describe('R8 — account switch A → B with leftover cookies', () => {
  it("B is never validated by A's current token", async () => {
    // A's rotation leaves current+prev bound to SESSION_A.
    const aOld = `${'1'.repeat(32)}:${SESSION_A}!${staleIssuedAt()}`;
    const aTokenPre = (await generateCsrfToken(SESSION_A)).token;
    const aRotate = await middleware(dashboardRequest({ [CSRF_COOKIE_NAME]: aOld }));
    const jar = new CookieJar();
    jar.apply(aRotate);

    // Now the user signs into B; the switch request rotates to B.
    mockUser(USER_B);
    ({ middleware } = await import('../middleware'));
    const bRotate = await middleware(jar.onto(dashboardRequest()));
    jar.apply(bRotate);

    // Current cookie is now bound to B.
    expect(jar.get(CSRF_COOKIE_NAME)).toContain(`:${SESSION_B}!`);

    // A's old token must NOT validate under B.
    expect(await submit(jar, aTokenPre)).toBe(false);
  });

  it("B is never validated by A's prev-grace token", async () => {
    // A same-session rotation stamps a fresh prev bound to A.
    const aOld = `${'2'.repeat(32)}:${SESSION_A}!${staleIssuedAt()}`;
    const aPre = await generateCsrfToken(SESSION_A);
    const aRotate = await middleware(
      dashboardRequest({ [CSRF_COOKIE_NAME]: `${aPre.nonce}:${SESSION_A}!${staleIssuedAt()}` }),
    );
    const jar = new CookieJar();
    jar.apply(aRotate);
    // A's prev grace works under A.
    expect(await submit(jar, aPre.token)).toBe(true);

    // Switch to B: rotation binds current to B and clears/replaces prev.
    mockUser(USER_B);
    ({ middleware } = await import('../middleware'));
    // Make B's current cookie DUE so the switch request rotates (exercising the
    // session-mismatch prev handling).
    const bRes = await middleware(jar.onto(dashboardRequest()));
    jar.apply(bRes);

    // A's prev-grace token must NOT validate under B.
    expect(jar.get(CSRF_COOKIE_NAME)).toContain(`:${SESSION_B}!`);
    expect(await submit(jar, aPre.token)).toBe(false);
  });

  it("rebinds a foreign cookie that is NOT rotation-due (the switch does not depend on age)", async () => {
    // The switch request carries A's FRESH (not-due) cookie. Without the
    // session-binding invariant the middleware would leave it bound to A because
    // no time-based rotation fires, and A's token would keep passing under B.
    const aFresh = `${'6'.repeat(32)}:${SESSION_A}!${freshIssuedAt()}`;
    const aToken = (await generateCsrfToken(SESSION_A)).token;

    mockUser(USER_B);
    ({ middleware } = await import('../middleware'));
    const jar = new CookieJar();
    jar.apply(new NextResponse(null, { headers: { 'set-cookie': `${CSRF_COOKIE_NAME}=${aFresh}` } }));
    jar.apply(await middleware(jar.onto(dashboardRequest())));

    expect(jar.get(CSRF_COOKIE_NAME)).toContain(`:${SESSION_B}!`);
    expect(await submit(jar, aToken)).toBe(false);
  });

  it("concurrent switch requests converge on ONE rebound nonce (no cookie soup on switch)", async () => {
    // Several tabs hit the middleware with the SAME foreign cookie during one
    // account switch. The rebind nonce is derived deterministically, so all
    // responses must agree — otherwise the switch reintroduces the cookie-soup race.
    const aFresh = `${'7'.repeat(32)}:${SESSION_A}!${freshIssuedAt()}`;
    mockUser(USER_B);
    ({ middleware } = await import('../middleware'));

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        middleware(dashboardRequest({ [CSRF_COOKIE_NAME]: aFresh })),
      ),
    );
    const nonces = new Set(
      responses.map((r) => parseNonce(r.cookies.get(CSRF_COOKIE_NAME)!.value)),
    );
    expect(nonces.size).toBe(1);
    // All are bound to B, and none is A's original nonce.
    for (const r of responses) {
      const v = r.cookies.get(CSRF_COOKIE_NAME)!.value;
      expect(v).toContain(`:${SESSION_B}!`);
      expect(parseNonce(v)).not.toBe('7'.repeat(32));
    }
  });
});

/* ================================================================== */
/*  R9 — invalidateCsrfCookies deletes root-path cookies.            */
/* ================================================================== */

describe('R9 — invalidateCsrfCookies path correctness', () => {
  it('emits root-path expiry for BOTH cookies so a browser actually removes them', () => {
    const res = NextResponse.json({ ok: true });
    invalidateCsrfCookies(res);
    for (const name of [CSRF_COOKIE_NAME, CSRF_PREV_COOKIE_NAME]) {
      const c = res.cookies.get(name)!;
      expect(c.value).toBe('');
      expect(c.path).toBe('/');
      expect(new Date(c.expires!).getTime()).toBeLessThan(Date.now());
    }
  });

  it('the jar removes both cookies when the invalidation is applied', () => {
    const jar = new CookieJar();
    jar.apply(new NextResponse(null, {
      headers: { 'set-cookie': `${CSRF_COOKIE_NAME}=${'3'.repeat(32)}:${SESSION_A}!${Date.now()}` },
    }));
    const res = NextResponse.json({ ok: true });
    invalidateCsrfCookies(res);
    jar.apply(res);
    expect(jar.get(CSRF_COOKIE_NAME)).toBeUndefined();
    expect(jar.get(CSRF_PREV_COOKIE_NAME)).toBeUndefined();
  });
});

/* ================================================================== */
/*  R10 — prev grace bound to the active session.                    */
/* ================================================================== */

describe('R10 — prev grace bound to active session', () => {
  it('rejects a prev cookie whose embedded session differs from the current cookie session', async () => {
    // Current cookie is B; prev cookie carries A's nonce/session (leftover).
    const bNonce = '4'.repeat(32);
    const aPrev = await generateCsrfToken(SESSION_A);

    const jar = new CookieJar();
    jar.apply(new NextResponse(null, {
      headers: {
        'set-cookie': [
          `${CSRF_COOKIE_NAME}=${bNonce}:${SESSION_B}!${Date.now()}`,
        ].join(', '),
      },
    }));
    // Inject a fresh-stamped prev bound to A (as if leftover from A's rotation).
    jar.apply(new NextResponse(null, {
      headers: { 'set-cookie': `${CSRF_PREV_COOKIE_NAME}=${aPrev.nonce}:${SESSION_A}!${Date.now()}` },
    }));

    // A's prev token must NOT validate: prev session (A) != current cookie session (B).
    expect(await submit(jar, aPrev.token)).toBe(false);
  });

  it('accepts a prev cookie whose embedded session matches the current cookie session', async () => {
    const nonce = '5'.repeat(32);
    const prev = await generateCsrfToken(SESSION_A);
    const jar = new CookieJar();
    jar.apply(new NextResponse(null, {
      headers: { 'set-cookie': `${CSRF_COOKIE_NAME}=${nonce}:${SESSION_A}!${Date.now()}` },
    }));
    jar.apply(new NextResponse(null, {
      headers: { 'set-cookie': `${CSRF_PREV_COOKIE_NAME}=${prev.nonce}:${SESSION_A}!${Date.now()}` },
    }));
    // Same-session prev within the grace window is accepted.
    expect(await submit(jar, prev.token)).toBe(true);
  });
});
