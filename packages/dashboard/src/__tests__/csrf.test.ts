/**
 * Tests for CSRF protection module.
 * V7 Audit §13.P2a: Critical security path — verify token gen/verify and exemptions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub env before importing
process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';

import { generateCsrfToken, verifyCsrfToken, checkCsrf } from '@/lib/api/csrf';
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
});
