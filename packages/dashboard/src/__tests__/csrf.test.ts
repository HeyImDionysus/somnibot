/**
 * Tests for CSRF protection module.
 * V7 Audit §13.P2a: Critical security path — verify token gen/verify and exemptions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub env before importing
process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';

import { generateCsrfToken, verifyCsrfToken, checkCsrf, shouldRotateCsrf, CSRF_PREV_COOKIE_NAME } from '@/lib/api/csrf';
import { NextRequest } from 'next/server';

function makeMutatingRequest(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; cookies?: Record<string, string> } = {},
): NextRequest {
  const url = `http://localhost${path}`;
  const req = new NextRequest(url, {
    method: opts.method ?? 'POST',
    headers: opts.headers ?? {},
  });

  // Set cookies via internal API
  if (opts.cookies) {
    for (const [name, value] of Object.entries(opts.cookies)) {
      req.cookies.set(name, value);
    }
  }

  return req;
}

describe('CSRF Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SESSION_TOKEN;
    delete process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE;
  });

  describe('generateCsrfToken', () => {
    it('returns a token and nonce', async () => {
      const result = await generateCsrfToken('session-123');
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.nonce).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates unique tokens for different sessions', async () => {
      const a = await generateCsrfToken('session-a');
      const b = await generateCsrfToken('session-b');
      expect(a.token).not.toBe(b.token);
    });

    it('generates unique nonces on each call', async () => {
      const a = await generateCsrfToken('session-123');
      const b = await generateCsrfToken('session-123');
      expect(a.nonce).not.toBe(b.nonce);
    });
  });

  describe('verifyCsrfToken', () => {
    it('accepts valid token', async () => {
      const { token, nonce } = await generateCsrfToken('session-123');
      expect(await verifyCsrfToken(token, nonce, 'session-123')).toBe(true);
    });

    it('rejects wrong session', async () => {
      const { token, nonce } = await generateCsrfToken('session-123');
      expect(await verifyCsrfToken(token, nonce, 'session-wrong')).toBe(false);
    });

    it('rejects tampered token', async () => {
      const { nonce } = await generateCsrfToken('session-123');
      expect(await verifyCsrfToken('0'.repeat(64), nonce, 'session-123')).toBe(false);
    });

    it('rejects wrong nonce', async () => {
      const { token } = await generateCsrfToken('session-123');
      expect(await verifyCsrfToken(token, '0'.repeat(32), 'session-123')).toBe(false);
    });
  });

  describe('checkCsrf — exemptions', () => {
    it('skips GET requests', async () => {
      const req = makeMutatingRequest('/api/config', { method: 'GET' });
      expect(await checkCsrf(req)).toBeNull();
    });

    it('skips HEAD requests', async () => {
      const req = makeMutatingRequest('/api/config', { method: 'HEAD' });
      expect(await checkCsrf(req)).toBeNull();
    });

    it('skips OPTIONS requests', async () => {
      const req = makeMutatingRequest('/api/config', { method: 'OPTIONS' });
      expect(await checkCsrf(req)).toBeNull();
    });

    it('skips PayPal webhook path', async () => {
      const req = makeMutatingRequest('/api/paypal/webhook');
      expect(await checkCsrf(req)).toBeNull();
    });

    it('skips license paths', async () => {
      const req = makeMutatingRequest('/api/license/validate');
      expect(await checkCsrf(req)).toBeNull();
    });

    it('skips portal paths', async () => {
      const req = makeMutatingRequest('/api/portal/auth');
      expect(await checkCsrf(req)).toBeNull();
    });

    it('skips auth paths', async () => {
      const req = makeMutatingRequest('/api/auth/callback');
      expect(await checkCsrf(req)).toBeNull();
    });

    it('skips download paths', async () => {
      const req = makeMutatingRequest('/api/downloads/abc');
      expect(await checkCsrf(req)).toBeNull();
    });

    it('does NOT skip /api/setup', async () => {
      const req = makeMutatingRequest('/api/setup');
      const result = await checkCsrf(req);
      // Should fail with 403 (missing token), not be skipped
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('does not skip CSRF when SESSION_TOKEN is set without launcher marker', async () => {
      process.env.SESSION_TOKEN = 'accidental-cloud-token';

      const req = makeMutatingRequest('/api/config', {
        headers: { host: 'localhost' },
      });
      const result = await checkCsrf(req);

      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('skips CSRF in explicit launcher local mode on localhost', async () => {
      process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE = '1';
      process.env.SESSION_TOKEN = 'launcher-token';

      const req = makeMutatingRequest('/api/config', {
        headers: { host: 'localhost' },
      });

      expect(await checkCsrf(req)).toBeNull();
    });
  });

  describe('checkCsrf — enforcement', () => {
    it('rejects POST without CSRF header', async () => {
      const req = makeMutatingRequest('/api/config');
      const result = await checkCsrf(req);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('rejects POST with header but missing cookie', async () => {
      const req = makeMutatingRequest('/api/config', {
        headers: { 'x-csrf-token': 'abc' },
      });
      const result = await checkCsrf(req);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('rejects POST with invalid token', async () => {
      const { nonce } = await generateCsrfToken('session-123');
      const req = makeMutatingRequest('/api/config', {
        headers: { 'x-csrf-token': 'invalid-token' },
        cookies: { 'somnibot-csrf-token': `${nonce}:session-123` },
      });
      const result = await checkCsrf(req);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('accepts POST with valid CSRF token', async () => {
      const { token, nonce } = await generateCsrfToken('session-123');
      const req = makeMutatingRequest('/api/config', {
        headers: { 'x-csrf-token': token },
        cookies: { 'somnibot-csrf-token': `${nonce}:session-123` },
      });
      const result = await checkCsrf(req);
      expect(result).toBeNull();
    });
  });

  describe('checkCsrf — grace-period on rotation (V10 §5)', () => {
    // When the CSRF cookie rotates, the client's in-memory X-CSRF-Token header
    // still holds the old token. The prev cookie keeps the old nonce valid for
    // 60s so in-flight requests don't 403.

    it('accepts old token via prev cookie within 60s grace window', async () => {
      const sessionId = 'grace-session';
      const old = await generateCsrfToken(sessionId);
      const fresh = await generateCsrfToken(sessionId);

      // Simulate: current cookie has new nonce, prev cookie has old nonce + recent timestamp
      const now = String(Date.now());
      const req = makeMutatingRequest('/api/config', {
        method: 'PUT',
        headers: { 'x-csrf-token': old.token },
        cookies: {
          'somnibot-csrf-token': `${fresh.nonce}:${sessionId}!${now}`,
          [CSRF_PREV_COOKIE_NAME]: `${old.nonce}:${sessionId}!${now}`,
        },
      });

      expect(await checkCsrf(req)).toBeNull();
    });

    it('rejects old token after grace window expires', async () => {
      const sessionId = 'grace-session';
      const old = await generateCsrfToken(sessionId);
      const fresh = await generateCsrfToken(sessionId);

      // 120s ago — beyond the 60s grace window
      const expired = String(Date.now() - 120_000);
      const req = makeMutatingRequest('/api/config', {
        method: 'PUT',
        headers: { 'x-csrf-token': old.token },
        cookies: {
          'somnibot-csrf-token': `${fresh.nonce}:${sessionId}!${Date.now()}`,
          [CSRF_PREV_COOKIE_NAME]: `${old.nonce}:${sessionId}!${expired}`,
        },
      });

      const result = await checkCsrf(req);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('rejects when prev cookie has no colon separator', async () => {
      const fresh = await generateCsrfToken('session-123');
      const req = makeMutatingRequest('/api/config', {
        method: 'POST',
        headers: { 'x-csrf-token': 'wrong-token' },
        cookies: {
          'somnibot-csrf-token': `${fresh.nonce}:session-123!${Date.now()}`,
          [CSRF_PREV_COOKIE_NAME]: 'malformed-no-colon',
        },
      });

      expect(await checkCsrf(req)).not.toBeNull();
    });

    it('rejects when prev cookie has non-numeric timestamp', async () => {
      const sessionId = 'session-123';
      const old = await generateCsrfToken(sessionId);
      const fresh = await generateCsrfToken(sessionId);

      const req = makeMutatingRequest('/api/config', {
        method: 'POST',
        headers: { 'x-csrf-token': old.token },
        cookies: {
          'somnibot-csrf-token': `${fresh.nonce}:${sessionId}!${Date.now()}`,
          [CSRF_PREV_COOKIE_NAME]: `${old.nonce}:${sessionId}!NaN`,
        },
      });

      expect(await checkCsrf(req)).not.toBeNull();
    });

    it('does not fall back to prev cookie when current token is valid', async () => {
      const sessionId = 'session-123';
      const current = await generateCsrfToken(sessionId);

      // Current token is valid — prev cookie should be irrelevant
      const req = makeMutatingRequest('/api/config', {
        method: 'DELETE',
        headers: { 'x-csrf-token': current.token },
        cookies: {
          'somnibot-csrf-token': `${current.nonce}:${sessionId}!${Date.now()}`,
          [CSRF_PREV_COOKIE_NAME]: 'stale:garbage!0',
        },
      });

      expect(await checkCsrf(req)).toBeNull();
    });

    it('rejects a prev token whose session differs from the active (current-cookie) session', async () => {
      // [security] Prev grace is bound to the ACTIVE session. Scenario: a
      // legitimate same-session rotation under account A stamped a fresh prev
      // cookie (A's nonce/session), then the user signed into account B; the
      // current cookie is now B's while the browser still carries A's prev with
      // a within-grace timestamp. A stale tab replaying A's token must NOT pass
      // CSRF for a request executed as B, even though the timestamp is fresh and
      // the token verifies against A's own nonce/session.
      const sessionA = 'account-a-16chars';
      const sessionB = 'account-b-16chars';
      const oldA = await generateCsrfToken(sessionA);
      const freshB = await generateCsrfToken(sessionB);

      const now = String(Date.now()); // within the 60s grace window
      const req = makeMutatingRequest('/api/config', {
        method: 'PUT',
        headers: { 'x-csrf-token': oldA.token },
        cookies: {
          // Active session per the current cookie is B …
          'somnibot-csrf-token': `${freshB.nonce}:${sessionB}!${now}`,
          // … but the surviving prev cookie is A's, freshly stamped.
          [CSRF_PREV_COOKIE_NAME]: `${oldA.nonce}:${sessionA}!${now}`,
        },
      });

      const result = await checkCsrf(req);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('still accepts a same-session prev token within the grace window (guard against over-tightening)', async () => {
      // Regression guard: binding prev to the active session must NOT break the
      // legitimate same-session grace path (current + prev share the session).
      const sessionId = 'same-session-16c';
      const old = await generateCsrfToken(sessionId);
      const fresh = await generateCsrfToken(sessionId);

      const now = String(Date.now());
      const req = makeMutatingRequest('/api/config', {
        method: 'PUT',
        headers: { 'x-csrf-token': old.token },
        cookies: {
          'somnibot-csrf-token': `${fresh.nonce}:${sessionId}!${now}`,
          [CSRF_PREV_COOKIE_NAME]: `${old.nonce}:${sessionId}!${now}`,
        },
      });

      expect(await checkCsrf(req)).toBeNull();
    });
  });

  describe('shouldRotateCsrf', () => {
    it('returns false when no CSRF cookie exists', async () => {
      const req = new NextRequest('http://localhost/api/config');
      expect(shouldRotateCsrf(req)).toBe(false);
    });

    it('returns true for legacy cookie without timestamp', async () => {
      const req = new NextRequest('http://localhost/api/config');
      req.cookies.set('somnibot-csrf-token', 'abc123:session-id');
      expect(shouldRotateCsrf(req)).toBe(true);
    });

    it('returns false for recently-issued cookie', async () => {
      const req = new NextRequest('http://localhost/api/config');
      req.cookies.set('somnibot-csrf-token', `abc123:session-id!${Date.now()}`);
      expect(shouldRotateCsrf(req)).toBe(false);
    });

    it('returns true when cookie is older than 30 minutes', async () => {
      const req = new NextRequest('http://localhost/api/config');
      const thirtyOneMinAgo = Date.now() - 31 * 60 * 1000;
      req.cookies.set('somnibot-csrf-token', `abc123:session-id!${thirtyOneMinAgo}`);
      expect(shouldRotateCsrf(req)).toBe(true);
    });

    it('returns true when timestamp is unparseable', async () => {
      const req = new NextRequest('http://localhost/api/config');
      req.cookies.set('somnibot-csrf-token', 'abc123:session-id!garbage');
      expect(shouldRotateCsrf(req)).toBe(true);
    });
  });
});
