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
});
