/**
 * CSRF Token Logic Tests — V53 Phase 5 (Finding 5.3)
 *
 * Tests CSRF token generation, validation, and rejection patterns.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes, createHmac } from 'crypto';

// Replicate the CSRF token generation logic used in the dashboard
function generateCsrfToken(sessionId: string, secret: string): string {
  const timestamp = Date.now().toString(36);
  const payload = `${sessionId}:${timestamp}`;
  const hmac = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}:${hmac}`;
}

function validateCsrfToken(
  token: string,
  sessionId: string,
  secret: string,
  maxAgeMins: number = 60,
): boolean {
  const parts = token.split(':');
  if (parts.length !== 3) return false;

  const [tokenSessionId, timestamp, hmac] = parts;
  if (tokenSessionId !== sessionId) return false;

  // Verify HMAC
  const payload = `${tokenSessionId}:${timestamp}`;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  if (hmac !== expected) return false;

  // Check expiry
  const tokenTime = parseInt(timestamp!, 36);
  const age = Date.now() - tokenTime;
  if (age > maxAgeMins * 60 * 1000) return false;

  return true;
}

const TEST_SECRET = 'test-csrf-secret-key-32-chars!!!';

describe('CSRF Token Generation', () => {
  it('generates a token with three colon-separated parts', () => {
    const token = generateCsrfToken('session-123', TEST_SECRET);
    expect(token.split(':')).toHaveLength(3);
  });

  it('embeds session ID in token', () => {
    const token = generateCsrfToken('my-session', TEST_SECRET);
    expect(token.startsWith('my-session:')).toBe(true);
  });

  it('generates different tokens for different sessions', () => {
    const t1 = generateCsrfToken('session-a', TEST_SECRET);
    const t2 = generateCsrfToken('session-b', TEST_SECRET);
    expect(t1).not.toBe(t2);
  });
});

describe('CSRF Token Validation', () => {
  it('accepts a valid fresh token', () => {
    const token = generateCsrfToken('sess-1', TEST_SECRET);
    expect(validateCsrfToken(token, 'sess-1', TEST_SECRET)).toBe(true);
  });

  it('rejects token from wrong session', () => {
    const token = generateCsrfToken('sess-1', TEST_SECRET);
    expect(validateCsrfToken(token, 'sess-2', TEST_SECRET)).toBe(false);
  });

  it('rejects tampered HMAC', () => {
    const token = generateCsrfToken('sess-1', TEST_SECRET);
    const tampered = token.slice(0, -4) + 'dead';
    expect(validateCsrfToken(tampered, 'sess-1', TEST_SECRET)).toBe(false);
  });

  it('rejects token signed with wrong secret', () => {
    const token = generateCsrfToken('sess-1', 'wrong-secret-key-1234567890!!!');
    expect(validateCsrfToken(token, 'sess-1', TEST_SECRET)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateCsrfToken('', 'sess-1', TEST_SECRET)).toBe(false);
  });

  it('rejects malformed token (no colons)', () => {
    expect(validateCsrfToken('not-a-token', 'sess-1', TEST_SECRET)).toBe(false);
  });
});
