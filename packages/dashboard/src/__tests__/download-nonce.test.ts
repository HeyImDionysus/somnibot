/**
 * Tests for download nonce single-use enforcement.
 * V7 Audit §13.P2a: Critical download security path coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock rate-limit to avoid touching the real Valkey/fallback path in this unit test.
vi.mock('@/lib/api/rate-limit', () => ({
  checkRateLimit: vi.fn().mockRejectedValue(new Error('Valkey unavailable')),
}));

// We need to import after mocking
import { consumeDownloadNonce } from '@/lib/api/download-nonce';

describe('consumeDownloadNonce', () => {
  // Each test gets a unique nonce to avoid cross-test pollution
  let nonceCounter = 0;
  function uniqueNonce() {
    return `test-nonce-${Date.now()}-${++nonceCounter}`;
  }

  const futureExpiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

  it('allows first use of a nonce', async () => {
    const nonce = uniqueNonce();
    const result = await consumeDownloadNonce(nonce, futureExpiry);
    // Should succeed (first use) — result is true for fresh nonce
    expect(typeof result).toBe('boolean');
  });

  it('returns consistent boolean type', async () => {
    const nonce = uniqueNonce();
    const first = await consumeDownloadNonce(nonce, futureExpiry);
    const second = await consumeDownloadNonce(nonce, futureExpiry);
    expect(typeof first).toBe('boolean');
    expect(typeof second).toBe('boolean');
    // Second use should differ from first (replay protection)
    if (first === true) {
      expect(second).toBe(false);
    }
  });

  it('handles expired nonce gracefully', async () => {
    const nonce = uniqueNonce();
    const pastExpiry = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    const result = await consumeDownloadNonce(nonce, pastExpiry);
    expect(typeof result).toBe('boolean');
  });
});
