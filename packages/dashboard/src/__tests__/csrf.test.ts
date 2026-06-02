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
  });

  describe('generateCsrfToken', () => {
    it('returns a token and nonce', () => {
      const result = generateCsrfToken('session-123');
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.nonce).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates unique tokens for different sessions', () => {
      const a = generateCsrfToken('session-a');
      const b = generateCsrfToken('session-b');
      expect(a.token).not.toBe(b.token);
    });

    it('generates unique nonces on each call', () => {
      const a = generateCsrfToken('session-123');
      const b = generateCsrfToken('session-123');
      expect(a.nonce).not.toBe(b.nonce);
    });
  });

  describe('verifyCsrfToken', () => {
    it('accepts valid token', () => {
      const { token, nonce } = generateCsrfToken('session-123');
      expect(verifyCsrfToken(token, nonce, 'session-123')).toBe(true);
    });

    it('rejects wrong session', () => {
      const { token, nonce } = generateCsrfToken('session-123');
      expect(verifyCsrfToken(token, nonce, 'session-wrong')).toBe(false);
    });

    it('rejects tampered token', () => {
      const { nonce } = generateCsrfToken('session-123');
      expect(verifyCsrfToken('0'.repeat(64), nonce, 'session-123')).toBe(false);
    });

    it('rejects wrong nonce', () => {
      const { token } = generateCsrfToken('session-123');
      expect(verifyCsrfToken(token, '0'.repeat(32), 'session-123')).toBe(false);
    });
  });

  describe('checkCsrf — exemptions', () => {
    it('skips GET requests', () => {
      const req = makeMutatingRequest('/api/config', { method: 'GET' });
      expect(checkCsrf(req)).toBeNull();
    });

    it('skips HEAD requests', () => {
      const req = makeMutatingRequest('/api/config', { method: 'HEAD' });
      expect(checkCsrf(req)).toBeNull();
    });

    it('skips OPTIONS requests', () => {
      const req = makeMutatingRequest('/api/config', { method: 'OPTIONS' });
      expect(checkCsrf(req)).toBeNull();
    });

    it('skips PayPal webhook path', () => {
      const req = makeMutatingRequest('/api/paypal/webhook');
      expect(checkCsrf(req)).toBeNull();
    });

    it('skips license paths', () => {
      const req = makeMutatingRequest('/api/license/validate');
      expect(checkCsrf(req)).toBeNull();
    });

    it('skips portal paths', () => {
      const req = makeMutatingRequest('/api/portal/auth');
      expect(checkCsrf(req)).toBeNull();
    });

    it('skips auth paths', () => {
      const req = makeMutatingRequest('/api/auth/callback');
      expect(checkCsrf(req)).toBeNull();
    });

    it('skips download paths', () => {
      const req = makeMutatingRequest('/api/downloads/abc');
      expect(checkCsrf(req)).toBeNull();
    });

    it('does NOT skip /api/setup', () => {
      const req = makeMutatingRequest('/api/setup');
      const result = checkCsrf(req);
      // Should fail with 403 (missing token), not be skipped
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });
  });

  describe('checkCsrf — enforcement', () => {
    it('rejects POST without CSRF header', () => {
      const req = makeMutatingRequest('/api/config');
      const result = checkCsrf(req);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('rejects POST with header but missing cookie', () => {
      const req = makeMutatingRequest('/api/config', {
        headers: { 'x-csrf-token': 'abc' },
      });
      const result = checkCsrf(req);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('rejects POST with invalid token', () => {
      const { nonce } = generateCsrfToken('session-123');
      const req = makeMutatingRequest('/api/config', {
        headers: { 'x-csrf-token': 'invalid-token' },
        cookies: { 'somnibot-csrf-token': `${nonce}:session-123` },
      });
      const result = checkCsrf(req);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('accepts POST with valid CSRF token', () => {
      const { token, nonce } = generateCsrfToken('session-123');
      const req = makeMutatingRequest('/api/config', {
        headers: { 'x-csrf-token': token },
        cookies: { 'somnibot-csrf-token': `${nonce}:session-123` },
      });
      const result = checkCsrf(req);
      expect(result).toBeNull();
    });
  });

  describe('checkCsrf — grace-period on rotation (V10 §5)', () => {
    // When the CSRF cookie rotates, the client's in-memory X-CSRF-Token header
    // still holds the old token. The prev cookie keeps the old nonce valid for
    // 60s so in-flight requests don't 403.

    it('accepts old token via prev cookie within 60s grace window', () => {
      const sessionId = 'grace-session';
      const old = generateCsrfToken(sessionId);
      const fresh = generateCsrfToken(sessionId);

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

      expect(checkCsrf(req)).toBeNull();
    });

    it('rejects old token after grace window expires', () => {
      const sessionId = 'grace-session';
      const old = generateCsrfToken(sessionId);
      const fresh = generateCsrfToken(sessionId);

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

      const result = checkCsrf(req);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it('rejects when prev cookie has no colon separator', () => {
      const fresh = generateCsrfToken('session-123');
      const req = makeMutatingRequest('/api/config', {
        method: 'POST',
        headers: { 'x-csrf-token': 'wrong-token' },
        cookies: {
          'somnibot-csrf-token': `${fresh.nonce}:session-123!${Date.now()}`,
          [CSRF_PREV_COOKIE_NAME]: 'malformed-no-colon',
        },
      });

      expect(checkCsrf(req)).not.toBeNull();
    });

    it('rejects when prev cookie has non-numeric timestamp', () => {
      const sessionId = 'session-123';
      const old = generateCsrfToken(sessionId);
      const fresh = generateCsrfToken(sessionId);

      const req = makeMutatingRequest('/api/config', {
        method: 'POST',
        headers: { 'x-csrf-token': old.token },
        cookies: {
          'somnibot-csrf-token': `${fresh.nonce}:${sessionId}!${Date.now()}`,
          [CSRF_PREV_COOKIE_NAME]: `${old.nonce}:${sessionId}!NaN`,
        },
      });

      expect(checkCsrf(req)).not.toBeNull();
    });

    it('does not fall back to prev cookie when current token is valid', () => {
      const sessionId = 'session-123';
      const current = generateCsrfToken(sessionId);

      // Current token is valid — prev cookie should be irrelevant
      const req = makeMutatingRequest('/api/config', {
        method: 'DELETE',
        headers: { 'x-csrf-token': current.token },
        cookies: {
          'somnibot-csrf-token': `${current.nonce}:${sessionId}!${Date.now()}`,
          [CSRF_PREV_COOKIE_NAME]: 'stale:garbage!0',
        },
      });

      expect(checkCsrf(req)).toBeNull();
    });
  });

  describe('shouldRotateCsrf', () => {
    it('returns false when no CSRF cookie exists', () => {
      const req = new NextRequest('http://localhost/api/config');
      expect(shouldRotateCsrf(req)).toBe(false);
    });

    it('returns true for legacy cookie without timestamp', () => {
      const req = new NextRequest('http://localhost/api/config');
      req.cookies.set('somnibot-csrf-token', 'abc123:session-id');
      expect(shouldRotateCsrf(req)).toBe(true);
    });

    it('returns false for recently-issued cookie', () => {
      const req = new NextRequest('http://localhost/api/config');
      req.cookies.set('somnibot-csrf-token', `abc123:session-id!${Date.now()}`);
      expect(shouldRotateCsrf(req)).toBe(false);
    });

    it('returns true when cookie is older than 30 minutes', () => {
      const req = new NextRequest('http://localhost/api/config');
      const thirtyOneMinAgo = Date.now() - 31 * 60 * 1000;
      req.cookies.set('somnibot-csrf-token', `abc123:session-id!${thirtyOneMinAgo}`);
      expect(shouldRotateCsrf(req)).toBe(true);
    });

    it('returns true when timestamp is unparseable', () => {
      const req = new NextRequest('http://localhost/api/config');
      req.cookies.set('somnibot-csrf-token', 'abc123:session-id!garbage');
      expect(shouldRotateCsrf(req)).toBe(true);
    });
  });
});
